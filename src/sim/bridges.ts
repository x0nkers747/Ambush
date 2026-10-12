import type { Road } from './environment';
import type { Vec2 } from './geometry';
import { heightAt, isOnTerrain, type TerrainDataset } from './terrain';
import { polygonTest, terrainWaterQuery } from './water-grading';

// Bridges (docs/adr/0041, docs/adr/0043): where a road crosses water wider
// than a creek, or is mapped as a bridge. Planned here, in the simulation
// layer, so that the 3D view draws and soldiers walk the same bridges
// (`bridge-navigation.ts`). The graded ground, the road network and the water
// are never changed: a bridge is its centreline, its deck's height along it
// and its width.
//
// - Crossings: each road (vehicle roads; paths only where mapped as bridges)
//   is followed every metre. It is over water inside an open-water area, or
//   within half the width of a watercourse at least 5 m wide. A run over an
//   area counts from 3 m. Runs closer than 25 m merge (islands, split
//   polygons), and the deck reaches a few metres onto dry land at each end.
//   A way mapped `bridge=*` is a bridge over its whole length; one mapped as
//   a tunnel or a ford never is.
// - Deck: the road's own height at its ends, so it continues the road
//   exactly; over water at least `CLEARANCE_M` above it, rising and falling no
//   steeper than `MAX_GRADE`. Where the ends are too low for that, the deck is
//   as high as the grade allows (a low bridge), and the crossing is reported.
// - Pure and deterministic: roads and water in order of id, no randomness.

/** Bump when the bridge rules change: it changes how bridges look and where soldiers cross. */
export const BRIDGE_VERSION = 1;
/** Watercourses at least this wide (metres) get a bridge where a road crosses them. */
export const BRIDGE_MIN_WATERWAY_M = 5;
/** A road over an open-water area for at least this long (metres) crosses it on a bridge. */
export const MIN_CROSSING_M = 3;
/** Crossings closer than this along a road are one bridge, metres. */
export const MERGE_GAP_M = 25;
/** The deck reaches this far onto dry land beyond the water, metres. */
export const APPROACH_M = 4;
/** The deck's top stands at least this far above the water (a footbridge: `FOOT_CLEARANCE_M`), metres. */
export const CLEARANCE_M = 0.9;
export const FOOT_CLEARANCE_M = 0.5;
/** Where the banks are too low for that, the approach ramps reach at most this much farther onto land, metres. */
export const MAX_RAMP_M = 14;
/** The deck rises and falls no steeper than this. */
export const MAX_GRADE = 0.08;
/** Roads are followed, and decks sampled, every this many metres. */
const SAMPLE_M = 1;
/** The road's surface blends onto the deck over this length at each end, metres. */
export const END_BLEND_M = 2;

/** Road classes that carry traffic; paths get a bridge only where mapped as one. */
const VEHICLE = new Set<Road['roadClass']>(['major', 'paved', 'unpaved', 'track']);

export type BridgeStyle = 'rural' | 'urban' | 'major' | 'foot';

export interface BridgeStyleSpec {
  /** Deck slab depth below the road surface, metres. */
  readonly thickness: number;
  /** Deck beyond the carriageway each side (verge, kerb and barrier), metres. */
  readonly margin: number;
  readonly barrier: 'guardrail' | 'parapet' | 'railing';
  /** Longest span without a pier, metres. */
  readonly maxSpan: number;
}

export const BRIDGE_STYLES: Readonly<Record<BridgeStyle, BridgeStyleSpec>> = {
  rural: { thickness: 0.7, margin: 0.9, barrier: 'guardrail', maxSpan: 22 },
  urban: { thickness: 0.8, margin: 1.4, barrier: 'parapet', maxSpan: 25 },
  major: { thickness: 1.2, margin: 1.2, barrier: 'parapet', maxSpan: 32 },
  foot: { thickness: 0.4, margin: 0.3, barrier: 'railing', maxSpan: 18 },
};

export interface Bridge {
  readonly id: string;
  /** The roads (ways) it carries, in order. */
  readonly roadIds: readonly string[];
  readonly style: BridgeStyle;
  /** Mapped in OSM (`bridge=*`) rather than inferred from water. */
  readonly mapped: boolean;
  /** Deck centreline points every metre or so, as x, y pairs. */
  readonly xy: readonly number[];
  /** The deck's top (the road surface) at each point, metres. */
  readonly deck: readonly number[];
  /** How far the road's draped surface is raised at each point (0 at the ends), metres. */
  readonly lift: readonly number[];
  /** Whether each point is over water. */
  readonly wet: readonly boolean[];
  /** The water level under each point (or the ground where dry), metres. */
  readonly under: readonly number[];
  /** Half the deck's width (carriageway, verge and margin), metres. */
  readonly halfWidth: number;
  /** Half the carriageway's width, metres. */
  readonly roadHalfWidth: number;
  /** Over water less than `CLEARANCE_M` below somewhere (the road's ends are too low). */
  readonly lowClearance: boolean;
}

export interface BridgePlan {
  readonly bridges: readonly Bridge[];
  /** Crossings not bridged, and why. */
  readonly skipped: readonly { readonly roadId: string; readonly reason: string }[];
}

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const key = (p: Vec2) => `${String(Math.round(p.x * 1000))},${String(Math.round(p.y * 1000))}`;

/** A road's crossing tags (importer `Road.crossing`), tolerant of terrain imported before them. */
function crossingOf(road: Road): Road['crossing'] {
  return road.crossing ?? (road.bridge ? { kind: 'bridge' } : undefined);
}

interface Chain {
  readonly roads: Road[];
  readonly pts: Vec2[];
  readonly cum: number[];
  /** Distance ranges along the chain mapped as bridges. */
  readonly mapped: [number, number][];
  /** Distance ranges mapped as tunnels or fords (never bridged). */
  readonly barred: [number, number][];
}

/** Roads of one class joined end to start where exactly two ways meet (OSM splits roads at bridges). */
function chainsOf(roads: readonly Road[]): Chain[] {
  const ends = new Map<string, { i: number; start: boolean }[]>();
  const interior = new Set<string>();
  roads.forEach((r, i) => {
    r.centerline.forEach((p, j) => {
      if (j === 0 || j === r.centerline.length - 1) {
        ends.set(key(p), [...(ends.get(key(p)) ?? []), { i, start: j === 0 }]);
      } else interior.add(key(p));
    });
  });
  const partner = (p: Vec2, self: number) => {
    const list = ends.get(key(p)) ?? [];
    if (list.length !== 2 || interior.has(key(p))) return null;
    const other = list.find((e) => e.i !== self);
    if (!other || roads[other.i]?.roadClass !== roads[self]?.roadClass) return null;
    return other;
  };
  const used = new Uint8Array(roads.length);
  const chains: Chain[] = [];
  roads.forEach((_, first) => {
    if (used[first]) return;
    // Back to the head.
    let i = first;
    let forward = true;
    const seen = new Set([first]);
    for (;;) {
      const r = roads[i];
      if (!r) break;
      const head: Vec2 | undefined = forward
        ? r.centerline[0]
        : r.centerline[r.centerline.length - 1];
      const o: { i: number; start: boolean } | null = head ? partner(head, i) : null;
      if (!o || seen.has(o.i)) break;
      seen.add(o.i);
      i = o.i;
      forward = !o.start;
    }
    const chainRoads: Road[] = [];
    const pts: Vec2[] = [];
    const mapped: [number, number][] = [];
    const barred: [number, number][] = [];
    const cum: number[] = [];
    for (;;) {
      const r = roads[i];
      if (!r || used[i]) break;
      used[i] = 1;
      chainRoads.push(r);
      const way = forward ? r.centerline : [...r.centerline].reverse();
      const s0 = cum[cum.length - 1] ?? 0;
      way.forEach((p, j) => {
        if (j === 0 && pts.length > 0) return;
        const prev = pts[pts.length - 1];
        cum.push(prev ? (cum[cum.length - 1] ?? 0) + Math.hypot(p.x - prev.x, p.y - prev.y) : 0);
        pts.push(p);
      });
      const s1 = cum[cum.length - 1] ?? 0;
      const c = crossingOf(r);
      if (c?.kind === 'bridge') mapped.push([s0, s1]);
      if (c?.kind === 'tunnel' || c?.kind === 'ford') barred.push([s0, s1]);
      const tail = way[way.length - 1];
      const o = tail ? partner(tail, i) : null;
      if (!o || used[o.i]) break;
      i = o.i;
      forward = o.start;
    }
    if (pts.length >= 2) chains.push({ roads: chainRoads, pts, cum, mapped, barred });
  });
  return chains;
}

/** The point and unit direction at distance `s` along a chain. */
function along(chain: Chain, s: number): { x: number; y: number; dx: number; dy: number } {
  const { pts, cum } = chain;
  let i = 1;
  while (i < pts.length - 1 && (cum[i] ?? 0) < s) i += 1;
  const a = pts[i - 1] ?? { x: 0, y: 0 };
  const b = pts[i] ?? a;
  const l = (cum[i] ?? 0) - (cum[i - 1] ?? 0);
  const t = l > 0 ? Math.min(1, Math.max(0, (s - (cum[i - 1] ?? 0)) / l)) : 0;
  return {
    x: a.x + t * (b.x - a.x),
    y: a.y + t * (b.y - a.y),
    dx: l > 0 ? (b.x - a.x) / l : 1,
    dy: l > 0 ? (b.y - a.y) / l : 0,
  };
}

/** Where a road is over water: open-water areas and watercourses wide enough to bridge. */
function waterTest(terrain: TerrainDataset) {
  const areas = (terrain.features.water ?? [])
    .filter((w) => w.kind === 'water')
    .sort(byId)
    .map((w) => {
      const xs = w.boundary.map((p) => p.x);
      const ys = w.boundary.map((p) => p.y);
      return {
        test: polygonTest([w.boundary, ...(w.holes ?? [])]),
        minX: Math.min(...xs),
        maxX: Math.max(...xs),
        minY: Math.min(...ys),
        maxY: Math.max(...ys),
      };
    });
  const BUCKET = 50;
  const segs: number[] = [];
  const buckets = new Map<number, number[]>();
  for (const w of [...(terrain.features.waterways ?? [])].sort(byId)) {
    if (w.widthMeters < BRIDGE_MIN_WATERWAY_M) continue;
    const h = w.widthMeters / 2;
    for (let i = 0; i + 1 < w.centerline.length; i += 1) {
      const a = w.centerline[i];
      const b = w.centerline[i + 1];
      if (!a || !b) continue;
      const s = segs.length / 5;
      segs.push(a.x, a.y, b.x, b.y, h);
      for (
        let gx = Math.floor((Math.min(a.x, b.x) - h) / BUCKET);
        gx <= Math.floor((Math.max(a.x, b.x) + h) / BUCKET);
        gx += 1
      ) {
        for (
          let gy = Math.floor((Math.min(a.y, b.y) - h) / BUCKET);
          gy <= Math.floor((Math.max(a.y, b.y) + h) / BUCKET);
          gy += 1
        ) {
          const k = gx * 100_003 + gy;
          buckets.set(k, [...(buckets.get(k) ?? []), s]);
        }
      }
    }
  }
  return {
    /** 0: dry; 1: over a watercourse; 2: over an open-water area. */
    at(x: number, y: number): 0 | 1 | 2 {
      for (const a of areas) {
        if (x >= a.minX && x <= a.maxX && y >= a.minY && y <= a.maxY && a.test(x, y)) return 2;
      }
      for (const s of buckets.get(Math.floor(x / BUCKET) * 100_003 + Math.floor(y / BUCKET)) ??
        []) {
        const o = s * 5;
        const ax = segs[o] ?? 0;
        const ay = segs[o + 1] ?? 0;
        const dx = (segs[o + 2] ?? 0) - ax;
        const dy = (segs[o + 3] ?? 0) - ay;
        const l2 = dx * dx + dy * dy;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
        if (Math.hypot(x - ax - t * dx, y - ay - t * dy) <= (segs[o + 4] ?? 0)) return 1;
      }
      return 0;
    },
  };
}

/** Built-up places: at least `BUILT_UP` buildings within about 75 m. */
function builtUpTest(terrain: TerrainDataset) {
  const D = 50;
  const density = new Map<number, number>();
  for (const b of terrain.features.buildings) {
    const cx = b.footprint.reduce((s, p) => s + p.x, 0) / b.footprint.length;
    const cy = b.footprint.reduce((s, p) => s + p.y, 0) / b.footprint.length;
    const k = Math.floor(cx / D) * 100_003 + Math.floor(cy / D);
    density.set(k, (density.get(k) ?? 0) + 1);
  }
  return (x: number, y: number) => {
    let n = 0;
    for (let a = -1; a <= 1; a += 1) {
      for (let b = -1; b <= 1; b += 1) {
        n += density.get((Math.floor(x / D) + a) * 100_003 + Math.floor(y / D) + b) ?? 0;
      }
    }
    return n >= 8;
  };
}

/** The style for a road: by its class, and whether it is in a built-up place. */
export function bridgeStyleOf(road: Road, builtUp: boolean): BridgeStyle {
  if (road.roadClass === 'path') return 'foot';
  if (road.roadClass === 'major') return 'major';
  return builtUp && road.roadClass === 'paved' ? 'urban' : 'rural';
}

/** The bridges of a terrain (its graded ground, roads and water). Pure and deterministic. */
export function planBridges(terrain: TerrainDataset): BridgePlan {
  const water = waterTest(terrain);
  const levels = terrainWaterQuery(terrain);
  const builtUp = builtUpTest(terrain);
  const ground = (x: number, y: number) =>
    isOnTerrain(terrain, x, y) ? heightAt(terrain, x, y) : null;
  const roads = terrain.features.roads
    .filter((r) => VEHICLE.has(r.roadClass) || crossingOf(r)?.kind === 'bridge')
    .sort(byId);
  // Each class is its own network (a path on a road bridge is not that bridge).
  const chains = [...new Set(roads.map((r) => r.roadClass))]
    .sort()
    .flatMap((cls) => chainsOf(roads.filter((r) => r.roadClass === cls)));
  const bridges: Bridge[] = [];
  const skipped: { roadId: string; reason: string }[] = [];

  for (const chain of chains) {
    const total = chain.cum[chain.cum.length - 1] ?? 0;
    const n = Math.max(1, Math.ceil(total / SAMPLE_M));
    const step = total / n;
    const wet: (0 | 1 | 2)[] = [];
    for (let k = 0; k <= n; k += 1) {
      const p = along(chain, k * step);
      wet.push(isOnTerrain(terrain, p.x, p.y) ? water.at(p.x, p.y) : 0);
    }
    const barred = (s: number) => chain.barred.some(([a, b]) => s >= a - 1e-6 && s <= b + 1e-6);
    // Runs over water, by sample.
    const runs: [number, number, boolean][] = [];
    let k = 0;
    while (k <= n) {
      if (!wet[k]) {
        k += 1;
        continue;
      }
      const a = k;
      let area = false;
      while (k <= n && wet[k]) {
        if (wet[k] === 2) area = true;
        k += 1;
      }
      runs.push([a, k - 1, area]);
    }
    const intervals: [number, number, boolean][] = [];
    for (const [a, b, area] of runs) {
      const len = (b - a) * step;
      // A watercourse wide enough counts whatever the run; an area from MIN_CROSSING_M.
      if (area && len < MIN_CROSSING_M) continue;
      if (barred(a * step) || barred(b * step)) {
        skipped.push({ roadId: chain.roads[0]?.id ?? '', reason: 'mapped as a tunnel or ford' });
        continue;
      }
      // To dry land: a few metres beyond the water.
      intervals.push([
        Math.max(0, (a - 0.5) * step - APPROACH_M),
        Math.min(total, (b + 0.5) * step + APPROACH_M),
        false,
      ]);
    }
    for (const [a, b] of chain.mapped) intervals.push([a, b, true]);
    intervals.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const merged: [number, number, boolean][] = [];
    for (const iv of intervals) {
      const last = merged[merged.length - 1];
      if (last && iv[0] <= last[1] + MERGE_GAP_M) {
        last[1] = Math.max(last[1], iv[1]);
        last[2] = last[2] || iv[2];
      } else merged.push([...iv]);
    }
    const onEdge = (s: number) => {
      const p = along(chain, s);
      const { originX, originY, cellSize, columns, rows } = terrain.heightfield;
      return (
        p.x - originX < 1 ||
        p.y - originY < 1 ||
        originX + (columns - 1) * cellSize - p.x < 1 ||
        originY + (rows - 1) * cellSize - p.y < 1
      );
    };
    for (const [s0, s1, mapped] of merged) {
      let built = deck(chain, s0, s1, mapped, water, levels, ground, builtUp, onEdge);
      // Banks too low for the clearance: longer approach ramps, onto the land.
      if (typeof built !== 'string' && built.lowClearance) {
        const longer = deck(
          chain,
          Math.max(0, s0 - MAX_RAMP_M),
          Math.min(total, s1 + MAX_RAMP_M),
          mapped,
          water,
          levels,
          ground,
          builtUp,
          onEdge,
        );
        if (typeof longer !== 'string') built = longer;
      }
      if (typeof built === 'string')
        skipped.push({ roadId: chain.roads[0]?.id ?? '', reason: built });
      else bridges.push(built);
    }
  }
  bridges.sort(byId);
  return { bridges, skipped };
}

function deck(
  chain: Chain,
  s0: number,
  s1: number,
  mapped: boolean,
  water: ReturnType<typeof waterTest>,
  levels: ReturnType<typeof terrainWaterQuery>,
  ground: (x: number, y: number) => number | null,
  builtUp: (x: number, y: number) => boolean,
  onEdge: (s: number) => boolean,
): Bridge | string {
  const len = s1 - s0;
  if (len < 2) return 'too short';
  const n = Math.max(2, Math.ceil(len / SAMPLE_M));
  const xy: number[] = [];
  const g: number[] = [];
  const wetAt: boolean[] = [];
  const under: number[] = [];
  const roadsAt = new Set<string>();
  for (let k = 0; k <= n; k += 1) {
    const s = s0 + (len * k) / n;
    const p = along(chain, s);
    const z = ground(p.x, p.y);
    if (z === null) return 'leaves the battlefield';
    xy.push(p.x, p.y);
    g.push(z);
    const w = water.at(p.x, p.y) !== 0;
    wetAt.push(w);
    // The water's surface: its level where levelled, else the draped water on the ground.
    const level = levels?.levelAt(p.x, p.y) ?? null;
    under.push(w ? Math.max(z + 0.03, level ?? -Infinity) : z);
    // Which ways it carries.
    let acc = 0;
    for (const r of chain.roads) {
      let l = 0;
      for (let j = 1; j < r.centerline.length; j += 1) {
        const a = r.centerline[j - 1];
        const b = r.centerline[j];
        if (a && b) l += Math.hypot(b.x - a.x, b.y - a.y);
      }
      if (s >= acc - 1e-6 && s <= acc + l + 1e-6) roadsAt.add(r.id);
      acc += l;
    }
  }
  // A bridge may run off the battlefield; otherwise its ends are on land.
  if ((wetAt[0] && !onEdge(s0)) || (wetAt[n] && !onEdge(s1))) {
    if (!mapped) return 'ends over water (the road ends there)';
  }
  const first = chain.roads[0];
  const clearance = first?.roadClass === 'path' ? FOOT_CLEARANCE_M : CLEARANCE_M;
  // Required: over water, the clearance; everywhere, at least the road.
  const need = g.map((z, k) => (wetAt[k] ? Math.max(z, (under[k] ?? z) + clearance) : z));
  if (mapped) {
    // A mapped bridge spans its ends: never below the straight line between them (a viaduct over a dip).
    const a = g[0] ?? 0;
    const b = g[n] ?? 0;
    need.forEach((z, k) => (need[k] = Math.max(z, a + ((b - a) * k) / n)));
  }
  // Grade-limited envelope, pinned to the road at both ends.
  const stepLen = len / n;
  const env = need.map((_, k) => {
    let m = -Infinity;
    need.forEach((z, j) => {
      m = Math.max(m, z - MAX_GRADE * Math.abs(k - j) * stepLen);
    });
    const fromStart = (g[0] ?? 0) + MAX_GRADE * k * stepLen;
    const fromEnd = (g[n] ?? 0) + MAX_GRADE * (n - k) * stepLen;
    return Math.max(g[k] ?? 0, Math.min(m, fromStart, fromEnd));
  });
  // Smoothed lightly (ends kept).
  const top = env.map((z, k) =>
    k === 0 || k === n ? z : ((env[k - 1] ?? z) + 2 * z + (env[k + 1] ?? z)) / 4,
  );
  let low = false;
  top.forEach((z, k) => {
    // (Within a few metres of its ends a deck meets the road, whatever the water there.)
    const fromEnd = Math.min(k, n - k) * stepLen;
    if (wetAt[k] && fromEnd > 3 && z < (under[k] ?? 0) + clearance - 0.05) low = true;
  });
  const mid = along(chain, (s0 + s1) / 2);
  const firstRoad = chain.roads.find((r) => roadsAt.has(r.id)) ?? chain.roads[0];
  if (!firstRoad) return 'no road';
  const style = bridgeStyleOf(firstRoad, builtUp(mid.x, mid.y));
  const roadHalf = firstRoad.widthMeters / 2;
  const verge = firstRoad.roadClass === 'paved' || firstRoad.roadClass === 'major' ? 0.6 : 0;
  return {
    id: `bridge:${firstRoad.id}:${String(Math.round(s0))}`,
    roadIds: chain.roads.filter((r) => roadsAt.has(r.id)).map((r) => r.id),
    style,
    mapped,
    xy,
    deck: top,
    lift: top.map((z, k) => Math.max(0, z - (g[k] ?? z))),
    wet: wetAt,
    under,
    halfWidth: roadHalf + Math.max(verge, BRIDGE_STYLES[style].margin),
    roadHalfWidth: roadHalf,
    lowClearance: low,
  };
}

// --- Where a point is on a bridge -------------------------------------------------------------

/** Where a map point is on a bridge: the deck's top there and how far into the deck it is (0–1). */
export interface BridgeIndex {
  /** The deck's top, the ground's height on the centreline, and the blend (0 at the deck's ends). */
  at(
    x: number,
    y: number,
  ): { readonly deck: number; readonly blend: number; readonly centreGround: number } | null;
  /** Whether a box may touch a bridge (false: it certainly does not). */
  touches(minX: number, minY: number, maxX: number, maxY: number): boolean;
  readonly count: number;
}

export function bridgeIndex(bridges: readonly Bridge[]): BridgeIndex {
  const BUCKET = 20;
  const buckets = new Map<number, [number, number][]>();
  bridges.forEach((b, bi) => {
    for (let i = 0; i + 3 < b.xy.length; i += 2) {
      const ax = b.xy[i] ?? 0;
      const ay = b.xy[i + 1] ?? 0;
      const bx = b.xy[i + 2] ?? 0;
      const by = b.xy[i + 3] ?? 0;
      const h = b.halfWidth + 0.5;
      for (
        let gx = Math.floor((Math.min(ax, bx) - h) / BUCKET);
        gx <= Math.floor((Math.max(ax, bx) + h) / BUCKET);
        gx += 1
      ) {
        for (
          let gy = Math.floor((Math.min(ay, by) - h) / BUCKET);
          gy <= Math.floor((Math.max(ay, by) + h) / BUCKET);
          gy += 1
        ) {
          const k = gx * 100_003 + gy;
          const list = buckets.get(k);
          if (list) list.push([bi, i / 2]);
          else buckets.set(k, [[bi, i / 2]]);
        }
      }
    }
  });
  return {
    count: bridges.length,
    touches(minX, minY, maxX, maxY) {
      for (let gx = Math.floor(minX / BUCKET); gx <= Math.floor(maxX / BUCKET); gx += 1) {
        for (let gy = Math.floor(minY / BUCKET); gy <= Math.floor(maxY / BUCKET); gy += 1) {
          if (buckets.has(gx * 100_003 + gy)) return true;
        }
      }
      return false;
    },
    at(x, y) {
      let best: { d: number; deck: number; blend: number; centreGround: number } | null = null;
      for (const [bi, i] of buckets.get(
        Math.floor(x / BUCKET) * 100_003 + Math.floor(y / BUCKET),
      ) ?? []) {
        const b = bridges[bi];
        if (!b) continue;
        const ax = b.xy[2 * i] ?? 0;
        const ay = b.xy[2 * i + 1] ?? 0;
        const dx = (b.xy[2 * i + 2] ?? 0) - ax;
        const dy = (b.xy[2 * i + 3] ?? 0) - ay;
        const l2 = dx * dx + dy * dy;
        if (l2 === 0) continue;
        const tRaw = ((x - ax) * dx + (y - ay) * dy) / l2;
        const last = b.deck.length - 2;
        // Beyond the deck's ends: not on it.
        if ((i === 0 && tRaw < 0) || (i === last && tRaw > 1)) continue;
        const t = Math.max(0, Math.min(1, tRaw));
        const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
        if (d > b.halfWidth + 0.3 || (best && best.d <= d)) continue;
        const z = (b.deck[i] ?? 0) + t * ((b.deck[i + 1] ?? 0) - (b.deck[i] ?? 0));
        const lift = (b.lift[i] ?? 0) + t * ((b.lift[i + 1] ?? 0) - (b.lift[i] ?? 0));
        const s = (i + t) * Math.sqrt(l2);
        const length = (b.deck.length - 1) * Math.sqrt(l2);
        const e = Math.min(s, length - s);
        const blend = Math.min(1, Math.max(0, e / END_BLEND_M));
        best = { d, deck: z, blend: blend * blend * (3 - 2 * blend), centreGround: z - lift };
      }
      return best ? { deck: best.deck, blend: best.blend, centreGround: best.centreGround } : null;
    },
  };
}
