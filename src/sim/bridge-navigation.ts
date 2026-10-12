import { planBridges, type Bridge } from './bridges';
import { boundsOf, impassableWater } from './environment';
import type { Vec2 } from './geometry';
import { pointInPolygon } from './polygon';
import { heightAt, type TerrainDataset } from './terrain';

// Bridges for soldiers (docs/adr/0043): the bridges the 3D view draws
// (`planBridges`, one plan per terrain), as the simulation walks them. Each
// bridge over water is a deck: a centreline with the deck's height along it,
// and a width. Navigation (`navigation.ts`) joins the land at its two ends
// through it; movement keeps a soldier on its surface (`surfaceHeightAt`).
// Pure and deterministic; built once per terrain (terrain is immutable).

/** A point of a route; `z`, where given, is the surface walked there (a bridge deck), metres. */
export interface PathPoint extends Vec2 {
  readonly z?: number;
}

/** A bridge soldiers may walk on: one over water (a dry overpass is not one). */
export interface NavBridge {
  readonly id: string;
  /** The roads it carries. */
  readonly roadIds: readonly string[];
  /**
   * The walked centreline, from one end to the other, with the deck's height
   * at each point: the bridge's samples, keeping only the points needed to
   * follow its bends and its profile (within 0.1 m and 0.05 m).
   */
  readonly points: readonly (Vec2 & { readonly z: number })[];
  /** Its length along the centreline, metres. */
  readonly length: number;
  /** Half the deck's width (to its barriers), metres. */
  readonly halfWidth: number;
  /** The plan it comes from (every metre: positions, deck, water under it). */
  readonly bridge: Bridge;
  /**
   * Whether each of the plan's points is over impassable water (an open-water
   * area): where a soldier can only be on the deck.
   */
  readonly overWater: readonly boolean[];
}

export interface BridgeSurfaces {
  /** The bridges over water, in order of id. */
  readonly bridges: readonly NavBridge[];
  /**
   * Where a point is on a bridge's deck over impassable water: the bridge,
   * the distance along its centreline and the deck's height there; `null`
   * when it is not (beside the deck, past its ends, or where the deck is over
   * land or a watercourse soldiers may wade).
   */
  deckAt(x: number, y: number): DeckPoint | null;
}

export interface DeckPoint {
  /** Index into `bridges`. */
  readonly bridge: number;
  /** Distance along the bridge's centreline, metres. */
  readonly s: number;
  readonly z: number;
}

const cache = new WeakMap<TerrainDataset, BridgeSurfaces>();

/** The bridges of a terrain as soldiers walk them; computed once per terrain. */
export function bridgeSurfaces(terrain: TerrainDataset): BridgeSurfaces {
  const cached = cache.get(terrain);
  if (cached) return cached;
  const water = impassableWater(terrain.features).map((w) => ({
    boundary: w.boundary,
    box: boundsOf(w.boundary),
  }));
  const inWater = (x: number, y: number) =>
    water.some(
      ({ boundary, box }) =>
        x >= box.minX &&
        x <= box.maxX &&
        y >= box.minY &&
        y <= box.maxY &&
        pointInPolygon({ x, y }, boundary),
    );
  const bridges = planBridges(terrain)
    .bridges.filter((b) => b.wet.some(Boolean))
    .map((b) => navBridge(b, inWater));
  const surfaces = surfacesOf(bridges);
  cache.set(terrain, surfaces);
  return surfaces;
}

/**
 * The height of the surface a soldier stands on at (x, y): a bridge's deck
 * over impassable water, else the ground (`heightAt`). The one authoritative height for
 * soldiers (movement, line of sight); the 3D view draws them there.
 */
export function surfaceHeightAt(terrain: TerrainDataset, x: number, y: number): number {
  return bridgeSurfaces(terrain).deckAt(x, y)?.z ?? heightAt(terrain, x, y);
}

/** Tolerances for keeping centreline points: across the bridge, and of the deck's height, metres. */
const KEEP_XY_M = 0.1;
const KEEP_Z_M = 0.05;

function navBridge(bridge: Bridge, inWater: (x: number, y: number) => boolean): NavBridge {
  const n = bridge.deck.length;
  const all = Array.from({ length: n }, (_, k) => ({
    x: bridge.xy[2 * k] ?? 0,
    y: bridge.xy[2 * k + 1] ?? 0,
    z: bridge.deck[k] ?? 0,
  }));
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  // Douglas–Peucker on position and height: a point is kept when dropping it
  // would move the line more than KEEP_XY_M or the deck more than KEEP_Z_M.
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length > 0) {
    const [i, j] = stack.pop() ?? [0, 0];
    const a = all[i];
    const b = all[j];
    if (!a || !b || j - i < 2) continue;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    let worst = -1;
    let worstScore = 1;
    for (let k = i + 1; k < j; k += 1) {
      const p = all[k];
      if (!p) continue;
      const t = (k - i) / (j - i);
      const off =
        length > 0
          ? Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / length
          : Math.hypot(p.x - a.x, p.y - a.y);
      const score = Math.max(off / KEEP_XY_M, Math.abs(p.z - (a.z + t * (b.z - a.z))) / KEEP_Z_M);
      if (score > worstScore) {
        worstScore = score;
        worst = k;
      }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push([i, worst], [worst, j]);
  }
  const points = all.filter((_, k) => keep[k]);
  let length = 0;
  for (let k = 1; k < n; k += 1) {
    const a = all[k - 1];
    const b = all[k];
    if (a && b) length += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return {
    id: bridge.id,
    roadIds: bridge.roadIds,
    points,
    length,
    halfWidth: bridge.halfWidth,
    bridge,
    overWater: all.map((p) => inWater(p.x, p.y)),
  };
}

/** Bucket size of the deck lookup, metres. */
const BUCKET_M = 20;

function surfacesOf(bridges: readonly NavBridge[]): BridgeSurfaces {
  // Each sample segment of each bridge, in the buckets its deck reaches.
  const buckets = new Map<number, [number, number][]>();
  const bucketKey = (gx: number, gy: number) => gx * 100_003 + gy;
  bridges.forEach(({ bridge: b, overWater }, bi) => {
    if (!overWater.some(Boolean)) return;
    const h = b.halfWidth;
    for (let i = 0; i + 3 < b.xy.length; i += 2) {
      const ax = b.xy[i] ?? 0;
      const ay = b.xy[i + 1] ?? 0;
      const bx = b.xy[i + 2] ?? 0;
      const by = b.xy[i + 3] ?? 0;
      for (
        let gx = Math.floor((Math.min(ax, bx) - h) / BUCKET_M);
        gx <= Math.floor((Math.max(ax, bx) + h) / BUCKET_M);
        gx += 1
      ) {
        for (
          let gy = Math.floor((Math.min(ay, by) - h) / BUCKET_M);
          gy <= Math.floor((Math.max(ay, by) + h) / BUCKET_M);
          gy += 1
        ) {
          const k = bucketKey(gx, gy);
          const list = buckets.get(k);
          if (list) list.push([bi, i / 2]);
          else buckets.set(k, [[bi, i / 2]]);
        }
      }
    }
  });
  return {
    bridges,
    deckAt(x, y) {
      let best: { d: number; point: DeckPoint } | null = null;
      for (const [bi, i] of buckets.get(
        bucketKey(Math.floor(x / BUCKET_M), Math.floor(y / BUCKET_M)),
      ) ?? []) {
        const nav = bridges[bi];
        if (!nav) continue;
        const b = nav.bridge;
        const ax = b.xy[2 * i] ?? 0;
        const ay = b.xy[2 * i + 1] ?? 0;
        const dx = (b.xy[2 * i + 2] ?? 0) - ax;
        const dy = (b.xy[2 * i + 3] ?? 0) - ay;
        const l2 = dx * dx + dy * dy;
        if (l2 === 0) continue;
        const tRaw = ((x - ax) * dx + (y - ay) * dy) / l2;
        // Past the deck's ends: not on it.
        if ((i === 0 && tRaw < 0) || (i === b.deck.length - 2 && tRaw > 1)) continue;
        const t = Math.max(0, Math.min(1, tRaw));
        const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
        if (d > b.halfWidth || (best && best.d <= d)) continue;
        // Over impassable water: the nearer sample is.
        if (!(t < 0.5 ? nav.overWater[i] : nav.overWater[i + 1])) continue;
        const z = (b.deck[i] ?? 0) + t * ((b.deck[i + 1] ?? 0) - (b.deck[i] ?? 0));
        const step = nav.length / Math.max(1, b.deck.length - 1);
        best = { d, point: { bridge: bi, s: (i + t) * step, z } };
      }
      return best?.point ?? null;
    },
  };
}

/**
 * The walked centreline of a bridge from distance `s0` along it to `s1`
 * (either way), with the deck's height at each point: the point at `s0`, the
 * kept centreline points between, and the point at `s1`.
 */
export function deckBetween(bridge: NavBridge, s0: number, s1: number): (Vec2 & { z: number })[] {
  const { bridge: b } = bridge;
  const last = b.deck.length - 1;
  const step = bridge.length / Math.max(1, last);
  const at = (dist: number): Vec2 & { z: number } => {
    const f = Math.max(0, Math.min(last, dist / (step || 1)));
    const i = Math.min(last - 1, Math.floor(f));
    const t = f - i;
    const lerp = (u: number, v: number) => u + t * (v - u);
    return {
      x: lerp(b.xy[2 * i] ?? 0, b.xy[2 * i + 2] ?? 0),
      y: lerp(b.xy[2 * i + 1] ?? 0, b.xy[2 * i + 3] ?? 0),
      z: lerp(b.deck[i] ?? 0, b.deck[i + 1] ?? 0),
    };
  };
  // The kept points, at their distances along the bridge (samples are evenly spaced).
  const kept: { p: Vec2 & { z: number }; s: number }[] = [];
  let k = 0;
  for (let i = 0; i <= last; i += 1) {
    const p = bridge.points[k];
    if (p && p.x === b.xy[2 * i] && p.y === b.xy[2 * i + 1]) {
      kept.push({ p, s: i * step });
      k += 1;
    }
  }
  const lo = Math.min(s0, s1);
  const hi = Math.max(s0, s1);
  const between = kept.filter((q) => q.s > lo + 1e-6 && q.s < hi - 1e-6).map((q) => q.p);
  if (s1 < s0) between.reverse();
  // The ends themselves are the kept end points, exactly.
  const end = (s: number) =>
    s <= 1e-6
      ? (bridge.points[0] ?? at(0))
      : s >= bridge.length - 1e-6
        ? (bridge.points.at(-1) ?? at(s))
        : at(s);
  return [end(s0), ...between, end(s1)];
}
