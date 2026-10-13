import type { DecorPoint, Road, TerrainDataset, Vec2 } from '#sim';
import type { Region } from './building-style';
import { finishMesh, meshBuffers, type Draper, type MeshData, type Rgb } from './drape';
import { hashInts, hashString, unit } from './hash';
import { srgbToLinear } from './srgb';

/** Height of the road surface the markings are laid on above the ground, metres. */
export const ROAD_OFFSET_M = 0.06;

/** The level a road is on: bridge or tunnel, and its mapped `layer`. */
export function roadLevel(road: Road): string {
  const c = road.crossing ?? (road.bridge ? { kind: 'bridge' as const } : undefined);
  const kind = c?.kind === 'bridge' || c?.kind === 'tunnel' ? c.kind : '';
  return `${kind}:${String(c?.layer ?? 0)}`;
}

/** Whether a road is on the surface: everything but tunnels (a culvert is a pipe under the road). */
export function onSurface(road: Road): boolean {
  return !(road.crossing?.kind === 'tunnel' && road.crossing.value !== 'culvert');
}

// Painted road markings (docs/adr/0037): centrelines, lane separators and
// edge lines, stop lines at mapped stop signs and mapped pedestrian
// crossings. Visual only: the roads, their widths and the ground are never
// changed, and the simulation never sees any of it.
//
// What a road gets is decided by `markingSpec`, from (in this order) the
// source's explicit marking tags, the road's class, its lanes and direction,
// its width, its surface, and the region's conventions, falling back on
// leaving a road unpainted: residential streets, service roads, driveways,
// tracks and paths stay bare unless the source says otherwise.
//
// Geometry follows the very centrelines the road ribbons are drawn from
// (line-network.ts), offset sideways with mitred corners, and is draped on
// the authoritative ground just above its road layer, so it can neither
// drift from the road nor float or sink. Ways that continue one another with
// the same markings are joined into chains, and dashes are laid by distance
// along the chain, so their rhythm never restarts where OSM splits a road.
// Markings stop short of any other road's surface, so they never run
// through a junction or across a side road, and resume beyond it in phase.
// All markings form one vertex-coloured mesh: one draw call. Pure.

/** Bump when the generated markings change (independent of the terrain and simulation). */
export const MARKING_VERSION = 2;

export type PaintColor = 'white' | 'yellow';

/** One painted line along a road: `offset` metres to the left of the centreline (in the way's direction). */
export interface PaintLine {
  readonly role: 'centre' | 'separator' | 'edge';
  readonly offset: number;
  readonly width: number;
  readonly color: PaintColor;
  /** Solid lines have no gap. */
  readonly dash: number;
  readonly gap: number;
}

export interface MarkingSpec {
  readonly lines: readonly PaintLine[];
  /** Why (for statistics and tests): e.g. "arterial", "explicit". */
  readonly reason: string;
}

/** A region's paint conventions: colours, widths and dash rhythm (metres). */
export interface MarkingStyle {
  /** Line between opposing traffic. */
  readonly centreColor: PaintColor;
  /** Left edge of a one-way carriageway of a divided road. */
  readonly leftEdgeColor: PaintColor;
  readonly lineWidth: number;
  readonly edgeWidth: number;
  readonly highwayEdgeWidth: number;
  /** Gap between the two lines of a double line (between their centres). */
  readonly doubleSpacing: number;
  readonly dash: {
    readonly urban: readonly [number, number];
    readonly rural: readonly [number, number];
    readonly highway: readonly [number, number];
  };
  /** Opposing traffic in built-up places: a double solid line (North America) or a dashed one. */
  readonly urbanCentre: 'double' | 'dashed';
  /** Minor roads ("unclassified") are painted only when this wide, or not at all. */
  readonly minorRoadWidth: number | null;
  /** Edge lines from the road's edge inwards. */
  readonly edgeInset: number;
  readonly stopLineWidth: number;
  readonly zebraBar: number;
}

/**
 * Regional conventions. North America (MUTCD): yellow lines between
 * opposing traffic, white for the rest, 10 ft dashes with 30 ft gaps, 4 in
 * lines. Central Europe (German RMS): all white, "Leitlinie" dashes of 3 m
 * with 6 m gaps in towns and 6 m with 12 m gaps outside, 12 cm lines, 25 cm
 * edges on motorways. Elsewhere a white, conservative fallback.
 */
export const MARKING_STYLES: Readonly<Record<Region, MarkingStyle>> = {
  'north-american': {
    centreColor: 'yellow',
    leftEdgeColor: 'yellow',
    lineWidth: 0.11,
    edgeWidth: 0.11,
    highwayEdgeWidth: 0.15,
    doubleSpacing: 0.22,
    dash: { urban: [3.05, 9.15], rural: [3.05, 9.15], highway: [3.05, 9.15] },
    urbanCentre: 'double',
    minorRoadWidth: 5.5,
    edgeInset: 0.25,
    stopLineWidth: 0.45,
    zebraBar: 0.6,
  },
  'central-european': {
    centreColor: 'white',
    leftEdgeColor: 'white',
    lineWidth: 0.12,
    edgeWidth: 0.15,
    highwayEdgeWidth: 0.25,
    doubleSpacing: 0.24,
    dash: { urban: [3, 6], rural: [6, 12], highway: [6, 12] },
    urbanCentre: 'dashed',
    minorRoadWidth: null,
    edgeInset: 0.25,
    stopLineWidth: 0.5,
    zebraBar: 0.5,
  },
  generic: {
    centreColor: 'white',
    leftEdgeColor: 'white',
    lineWidth: 0.12,
    edgeWidth: 0.12,
    highwayEdgeWidth: 0.2,
    doubleSpacing: 0.24,
    dash: { urban: [3, 6], rural: [3, 9], highway: [6, 12] },
    urbanCentre: 'dashed',
    minorRoadWidth: 6,
    edgeInset: 0.25,
    stopLineWidth: 0.45,
    zebraBar: 0.5,
  },
};

/** Paint colours, sRGB: a slightly warm white and a muted traffic yellow, never glowing. */
export const PAINT: Readonly<Record<PaintColor, number>> = { white: 0xdedbd1, yellow: 0xc79b3a };

const PAVED = new Set([
  'paved',
  'asphalt',
  'concrete',
  'concrete:plates',
  'concrete:lanes',
  'chipseal',
  'paving_stones',
  'sett',
]);

type RoadKind = 'highway' | 'arterial' | 'collector' | 'minor' | 'local';

function kindOf(r: Road): RoadKind | null {
  const h = (r.highway ?? '').replace(/_link$/, '');
  if (h === 'motorway' || h === 'trunk') return 'highway';
  if (h === 'primary' || h === 'secondary') return 'arterial';
  if (h === 'tertiary') return 'collector';
  if (h === 'unclassified') return 'minor';
  if (h === 'residential' || h === 'living_street' || h === 'road') return 'local';
  // Older battlefields keep no highway type: only main roads are known.
  if (r.highway === undefined && r.roadClass === 'major') return 'arterial';
  return null;
}

/**
 * The markings a road should carry, in the way's own direction, or null for
 * none. `builtUp` says whether it runs through a built-up place.
 */
export function markingSpec(r: Road, region: Region, builtUp: boolean): MarkingSpec | null {
  const t = r.traffic ?? {};
  const style = MARKING_STYLES[region];
  if (t.laneMarkings === false) return null;
  if (r.roadClass !== 'paved' && r.roadClass !== 'major') return null;
  if (t.surface !== undefined && !PAVED.has(t.surface)) return null;
  // Roundabout rings are left bare (their approaches end at them).
  if (t.junction !== undefined) return null;
  const explicit = t.laneMarkings === true;
  const kind = kindOf(r);
  const W = r.widthMeters;
  if (!kind && !explicit) return null;
  const oneway = t.oneway === 'yes' || t.oneway === 'reverse';

  // Whether the road is painted at all.
  let reason: string;
  if (explicit) reason = 'explicit';
  else if (kind === 'highway' || kind === 'arterial') reason = kind;
  else if (kind === 'collector') reason = W >= 5.5 ? 'collector' : '';
  else if (kind === 'minor') {
    const tagged = (t.lanes ?? 0) >= 2;
    reason =
      style.minorRoadWidth !== null && W >= style.minorRoadWidth
        ? 'minor'
        : tagged && W >= 5.5
          ? 'minor'
          : '';
  } else reason = (t.lanes ?? 0) >= 3 && W >= 9 ? 'wide local' : '';
  if (!reason || W < 4) return null;

  const highway = kind === 'highway';
  const [dash, gap] = highway ? style.dash.highway : builtUp ? style.dash.urban : style.dash.rural;
  const lw = style.lineWidth;
  const lines: PaintLine[] = [];
  const solid = (
    role: PaintLine['role'],
    offset: number,
    color: PaintColor,
    width = lw,
  ): PaintLine => ({
    role,
    offset,
    width,
    color,
    dash: 0,
    gap: 0,
  });
  const dashed = (
    role: PaintLine['role'],
    offset: number,
    color: PaintColor,
    width = lw,
  ): PaintLine => ({
    role,
    offset,
    width,
    color,
    dash,
    gap,
  });

  // Edges.
  const edges =
    highway ||
    (kind === 'arterial' && W >= 6.5) ||
    (kind === 'collector' && W >= 6.5 && !builtUp) ||
    (explicit && W >= 6.5);
  const ew = highway ? style.highwayEdgeWidth : style.edgeWidth;
  const edge = W / 2 - style.edgeInset;

  if (oneway) {
    const n = t.lanes ?? (W >= 7 ? 2 : 1);
    const laneW = W / n;
    for (let k = 1; k < n; k += 1) lines.push(dashed('separator', W / 2 - k * laneW, 'white'));
    if (edges || (n >= 2 && kind === 'arterial')) {
      // A divided road's carriageway: its left edge (against the median) in the
      // regional colour, its right edge white. Left of travel is left of the
      // way unless the way runs against it.
      const left = t.oneway === 'reverse' ? -1 : 1;
      lines.push(solid('edge', left * edge, style.leftEdgeColor, ew));
      lines.push(solid('edge', -left * edge, 'white', ew));
    }
    return lines.length > 0 ? { lines, reason } : null;
  }

  const total = t.lanes ?? 2;
  if (total < 2)
    return edges
      ? { lines: [solid('edge', edge, 'white', ew), solid('edge', -edge, 'white', ew)], reason }
      : null;
  const fwd =
    t.lanesForward ??
    (t.lanesBackward !== undefined ? Math.max(1, total - t.lanesBackward) : Math.ceil(total / 2));
  const back = t.lanesBackward ?? Math.max(1, total - fwd);
  const laneW = W / (fwd + back);
  // Opposing traffic is divided between the backward lanes (left) and the forward ones (right).
  const divide = W / 2 - back * laneW;
  const centre = style.centreColor;
  const physical =
    t.divider === 'barrier' || t.divider === 'grass_verge' || t.divider === 'rumble_strip';
  if (!physical) {
    const pair = (leftDashed: boolean, rightDashed: boolean) => {
      const h = style.doubleSpacing / 2;
      lines.push(
        leftDashed ? dashed('centre', divide + h, centre) : solid('centre', divide + h, centre),
      );
      lines.push(
        rightDashed ? dashed('centre', divide - h, centre) : solid('centre', divide - h, centre),
      );
    };
    const doubleLine = region === 'north-american';
    if (t.divider === 'double_solid_line') pair(false, false);
    else if (t.divider === 'solid_line') lines.push(solid('centre', divide, centre));
    else if (t.divider === 'dashed_line') lines.push(dashed('centre', divide, centre));
    else if (t.overtaking === 'no') {
      if (doubleLine) pair(false, false);
      else lines.push(solid('centre', divide, centre));
    } else if (t.overtaking === 'forward')
      pair(false, true); // dashed on the forward side
    else if (t.overtaking === 'backward') pair(true, false);
    else if (t.overtaking === 'yes') lines.push(dashed('centre', divide, centre));
    else if (fwd + back >= 4) {
      if (doubleLine) pair(false, false);
      else lines.push(solid('centre', divide, centre));
    } else if (builtUp && style.urbanCentre === 'double' && !highway) pair(false, false);
    else lines.push(dashed('centre', divide, centre));
  }
  for (let k = 1; k < fwd; k += 1) lines.push(dashed('separator', divide - k * laneW, 'white'));
  for (let k = 1; k < back; k += 1) lines.push(dashed('separator', divide + k * laneW, 'white'));
  if (edges || physical) {
    lines.push(solid('edge', edge, 'white', ew));
    lines.push(solid('edge', -edge, 'white', ew));
  }
  return { lines, reason };
}

/** A spec's lines seen from the other end of the way: offsets mirrored. */
const reversed = (lines: readonly PaintLine[]): PaintLine[] =>
  lines.map((l) => ({ ...l, offset: -l.offset }));
const signature = (lines: readonly PaintLine[]) =>
  JSON.stringify([...lines].sort((a, b) => a.offset - b.offset || a.role.localeCompare(b.role)));

export interface MarkingStats {
  readonly markedRoads: number;
  readonly chains: number;
  readonly byReason: Readonly<Record<string, number>>;
  /** Painted length by role, metres. */
  readonly length: Readonly<Record<string, number>>;
  readonly stopLines: number;
  readonly crossings: number;
  readonly triangles: number;
  readonly ms: number;
}

/** Built-up places: at least this many buildings within about 75 m. */
const BUILT_UP = 6;
/** Markings stop this far short of another road's surface. */
const CLEAR_M = 1;
/** Sample spacing for clipping, metres. */
const STEP_M = 0.25;
/** Turns sharper than this break offset lines (they would fold), radians. */
const SHARP_TURN = (65 * Math.PI) / 180;

interface Chain {
  readonly roads: readonly number[];
  readonly points: readonly Vec2[];
  readonly lines: readonly PaintLine[];
  readonly layerOffset: number;
}

/** Roads whose surfaces stop markings: every vehicle road; footways and paths do not. */
const isVehicle = (r: Road) =>
  r.roadClass !== 'path' &&
  !['footway', 'path', 'cycleway', 'bridleway', 'steps', 'pedestrian', 'corridor'].includes(
    r.highway ?? '',
  );
/** Service roads (driveways, car park entrances) break edge lines but not the lines between lanes. */
const isMinorAccess = (r: Road) =>
  r.highway === 'service' || r.highway === 'track' || r.roadClass === 'track';

/** A painted piece of a line: between two distances along its chain. */
export interface PaintPiece {
  readonly chain: number;
  readonly role: PaintLine['role'];
  readonly color: PaintColor;
  readonly offset: number;
  readonly s0: number;
  readonly s1: number;
}

/** A painted rectangle from a to b, `halfWidth` either side, `z` above the ground. */
export interface PaintQuad {
  readonly a: Vec2;
  readonly b: Vec2;
  readonly halfWidth: number;
  readonly z: number;
  readonly color: Rgb;
}

export interface MarkingPlan {
  readonly chains: readonly {
    readonly roads: readonly string[];
    readonly points: readonly Vec2[];
    readonly lines: readonly PaintLine[];
  }[];
  readonly pieces: readonly PaintPiece[];
  readonly quads: readonly PaintQuad[];
  readonly stats: Omit<MarkingStats, 'triangles' | 'ms'>;
}

/** The painted markings of a battlefield's roads, as one draped, vertex-coloured mesh. */
export function roadMarkings(
  terrain: TerrainDataset,
  draper: Draper,
  region: Region,
): { mesh: MeshData; stats: MarkingStats } {
  const started = performance.now();
  const plan = planMarkings(terrain, region);
  const out = meshBuffers(true);
  for (const q of plan.quads) {
    const len = Math.hypot(q.b.x - q.a.x, q.b.y - q.a.y);
    if (len < 1e-3) continue;
    const nx = (-(q.b.y - q.a.y) / len) * q.halfWidth;
    const ny = ((q.b.x - q.a.x) / len) * q.halfWidth;
    draper.convex(
      [
        q.a.x - nx,
        q.a.y - ny,
        q.b.x - nx,
        q.b.y - ny,
        q.b.x + nx,
        q.b.y + ny,
        q.a.x + nx,
        q.a.y + ny,
      ],
      q.z,
      out,
      q.color,
    );
  }
  const mesh = finishMesh(out);
  return {
    mesh,
    stats: { ...plan.stats, triangles: mesh.triangleCount, ms: performance.now() - started },
  };
}

/** Plans the markings: which lines, where they are painted, and the rectangles to drape. Pure. */
export function planMarkings(terrain: TerrainDataset, region: Region): MarkingPlan {
  const style = MARKING_STYLES[region];
  const byId = (a: Road, b: Road) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  // Roads on the surface: tunnels have no markings to see (docs/adr/0044).
  const roads = [...terrain.features.roads].filter(onSurface).sort(byId);
  const levels = roads.map(roadLevel);

  // Built-up places, from building density.
  const D = 50;
  const density = new Map<number, number>();
  for (const b of terrain.features.buildings) {
    let cx = 0;
    let cy = 0;
    for (const p of b.footprint) {
      cx += p.x;
      cy += p.y;
    }
    const k =
      Math.floor(cx / b.footprint.length / D) * 100_003 + Math.floor(cy / b.footprint.length / D);
    density.set(k, (density.get(k) ?? 0) + 1);
  }
  const builtUpAt = (p: Vec2) => {
    let n = 0;
    for (let a = -1; a <= 1; a += 1) {
      for (let b = -1; b <= 1; b += 1)
        n += density.get((Math.floor(p.x / D) + a) * 100_003 + Math.floor(p.y / D) + b) ?? 0;
    }
    return n >= BUILT_UP;
  };
  const midpoint = (r: Road) => r.centerline[Math.floor(r.centerline.length / 2)] ?? { x: 0, y: 0 };

  const specs = roads.map((r) => markingSpec(r, region, builtUpAt(midpoint(r))));
  const byReason: Record<string, number> = {};
  specs.forEach((s) => {
    if (s) byReason[s.reason] = (byReason[s.reason] ?? 0) + 1;
  });

  // --- Chains: ways that continue one another with the same markings -------------------
  const key = (p: Vec2) => `${String(Math.round(p.x * 1000))},${String(Math.round(p.y * 1000))}`;
  /** Vehicle-road ends and points meeting at each node. */
  const degree = new Map<string, number>();
  const endsAt = new Map<string, { road: number; atStart: boolean }[]>();
  roads.forEach((r, ri) => {
    if (!isVehicle(r)) return;
    r.centerline.forEach((p, i) => {
      const k = key(p);
      const inner = i > 0 && i < r.centerline.length - 1;
      degree.set(k, (degree.get(k) ?? 0) + (inner ? 2 : 1));
      if (!inner) {
        const list = endsAt.get(k) ?? [];
        list.push({ road: ri, atStart: i === 0 });
        endsAt.set(k, list);
      }
    });
  });
  const used = new Set<number>();
  const chains: Chain[] = [];
  roads.forEach((r, ri) => {
    const spec = specs[ri];
    if (!spec || used.has(ri)) return;
    used.add(ri);
    const members = [ri];
    let points: Vec2[] = [...r.centerline];
    const lines = spec.lines;
    const sig = signature(lines);
    // Extend forward from the end, then backward from the start.
    const extend = (forward: boolean) => {
      for (;;) {
        const end = forward ? points[points.length - 1] : points[0];
        if (!end) return;
        const k = key(end);
        if (degree.get(k) !== 2) return; // a junction or a dead end
        const next = (endsAt.get(k) ?? []).find(
          (e) => e.road !== ri && !used.has(e.road) && !members.includes(e.road),
        );
        if (!next) return;
        const nr = roads[next.road];
        const ns = specs[next.road];
        if (!nr || !ns) return;
        // In the chain's direction the next way runs on if it starts here (going forward).
        const along = forward ? next.atStart : !next.atStart;
        const theirs = along ? ns.lines : reversed(ns.lines);
        if (signature(theirs) !== sig) return;
        if (Math.abs(ROAD_OFFSET_M - ROAD_OFFSET_M) > 1e-9) return;
        used.add(next.road);
        members.push(next.road);
        const pts = along ? [...nr.centerline] : [...nr.centerline].reverse();
        points = forward ? [...points, ...pts.slice(1)] : [...pts.slice(0, -1), ...points];
        if (key(points[0] ?? end) === key(points[points.length - 1] ?? end)) return; // a loop
      }
    };
    extend(true);
    extend(false);
    // Drop repeated points.
    const clean: Vec2[] = [];
    for (const p of points)
      if (!clean.length || key(clean[clean.length - 1] ?? p) !== key(p)) clean.push(p);
    if (clean.length >= 2) {
      chains.push({
        roads: members,
        points: clean,
        lines,
        layerOffset: ROAD_OFFSET_M,
      });
    }
  });

  // --- Other roads' surfaces, for clipping -------------------------------------------
  const CELL = 20;
  const cells = new Map<number, number[]>();
  /** road, ax, ay, bx, by, whether a and b are free ends of the road (1) or not (0). */
  const segs: number[] = [];
  const SEG = 7;
  roads.forEach((r, ri) => {
    if (!isVehicle(r)) return;
    const h = r.widthMeters / 2 + CLEAR_M + 1;
    for (let i = 0; i + 1 < r.centerline.length; i += 1) {
      const a = r.centerline[i];
      const b = r.centerline[i + 1];
      if (!a || !b) continue;
      const s = segs.length / SEG;
      const last = r.centerline.length - 2;
      segs.push(ri, a.x, a.y, b.x, b.y, i === 0 ? 1 : 0, i === last ? 1 : 0);
      for (
        let ci = Math.floor((Math.min(a.x, b.x) - h) / CELL);
        ci <= Math.floor((Math.max(a.x, b.x) + h) / CELL);
        ci++
      ) {
        for (
          let cj = Math.floor((Math.min(a.y, b.y) - h) / CELL);
          cj <= Math.floor((Math.max(a.y, b.y) + h) / CELL);
          cj++
        ) {
          const k = ci * 100_003 + cj;
          const list = cells.get(k) ?? [];
          list.push(s);
          cells.set(k, list);
        }
      }
    }
  });
  // Roads sharing each node, to tell a junction from a road passing over or under (docs/adr/0044).
  const atNode = new Map<string, number[]>();
  roads.forEach((r, ri) => {
    for (const p of r.centerline) {
      const k = key(p);
      const list = atNode.get(k);
      if (list) list.push(ri);
      else atNode.set(k, [ri]);
    }
  });
  /**
   * Whether (x, y) is on (or within `CLEAR_M` of) a road not in `own`;
   * service roads count only for edges. Only roads on the chain's level, or
   * joined to it at a node, count: a road passing over or under does not.
   */
  const blocked = (
    x: number,
    y: number,
    own: ReadonlySet<number>,
    edgeLine: boolean,
    level: string,
    joined: ReadonlySet<number>,
  ) => {
    for (const s of cells.get(Math.floor(x / CELL) * 100_003 + Math.floor(y / CELL)) ?? []) {
      const ri = segs[s * SEG] ?? 0;
      if (own.has(ri)) continue;
      if (levels[ri] !== level && !joined.has(ri)) continue;
      const r = roads[ri];
      if (!r || (!edgeLine && isMinorAccess(r))) continue;
      const ax = segs[s * SEG + 1] ?? 0;
      const ay = segs[s * SEG + 2] ?? 0;
      const dx = (segs[s * SEG + 3] ?? 0) - ax;
      const dy = (segs[s * SEG + 4] ?? 0) - ay;
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) continue;
      const raw = ((x - ax) * dx + (y - ay) * dy) / len2;
      const reach = r.widthMeters / 2 + CLEAR_M;
      // Beyond a road's free end (a side road ending on this one) only the side it comes from is blocked.
      const freeStart = raw < 0 && segs[s * SEG + 5] === 1;
      const freeEnd = raw > 1 && segs[s * SEG + 6] === 1;
      if (freeStart || freeEnd) {
        const len = Math.sqrt(len2);
        const ex = freeStart ? ax : ax + dx;
        const ey = freeStart ? ay : ay + dy;
        // Unit direction from the end into the road.
        const ux = (freeStart ? dx : -dx) / len;
        const uy = (freeStart ? dy : -dy) / len;
        const ahead = (x - ex) * ux + (y - ey) * uy;
        const side = Math.abs((x - ex) * uy - (y - ey) * ux);
        if (ahead >= -0.5 && side < reach) return true;
        continue;
      }
      const t = Math.max(0, Math.min(1, raw));
      if (Math.hypot(x - ax - t * dx, y - ay - t * dy) < reach) return true;
    }
    return false;
  };

  // Mapped stop signs and crossings on the roads.
  const points = [...(terrain.decor?.points ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1));
  const crossings = points.filter((p) => p.kind === 'crossing');
  const stops = points.filter(
    (p) => p.kind === 'trafficSign' && /(^|[;:])(stop|206|r1-1)\b/.test(p.sign ?? ''),
  );

  const quads: PaintQuad[] = [];
  const painted: PaintPiece[] = [];
  const colors: Readonly<Record<PaintColor, number>> = PAINT;
  const tint = (c: PaintColor, seed: number): Rgb => {
    // A little weathering: each dash a shade lighter or darker.
    const hex = colors[c];
    const k = 0.92 + 0.08 * unit(seed);
    return [
      srgbToLinear(((hex >> 16) & 255) * k),
      srgbToLinear(((hex >> 8) & 255) * k),
      srgbToLinear((hex & 255) * k),
    ];
  };
  const quad = (a: Vec2, b: Vec2, halfWidth: number, z: number, color: Rgb) => {
    if (Math.hypot(b.x - a.x, b.y - a.y) >= 1e-3) quads.push({ a, b, halfWidth, z, color });
  };
  const length: Record<string, number> = { centre: 0, separator: 0, edge: 0 };

  chains.forEach((chain, ci) => {
    const pts = chain.points;
    const own = new Set(chain.roads);
    const level = levels[chain.roads[0] ?? 0] ?? '';
    const joined = new Set(
      chain.roads.flatMap((ri) =>
        (roads[ri]?.centerline ?? []).flatMap((p) => atNode.get(key(p)) ?? []),
      ),
    );
    // Distance along the centreline at each point, and the turn there.
    const along = [0];
    for (let i = 1; i < pts.length; i += 1) {
      const a = pts[i - 1];
      const b = pts[i];
      along.push((along[i - 1] ?? 0) + (a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0));
    }
    const total = along[along.length - 1] ?? 0;
    const turn = pts.map((p, i) => {
      const a = pts[i - 1];
      const b = pts[i + 1];
      if (!a || !b) return 0;
      const ux = p.x - a.x;
      const uy = p.y - a.y;
      const vx = b.x - p.x;
      const vy = b.y - p.y;
      return Math.abs(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy));
    });
    // Unit left normals of each segment.
    const normals = pts.slice(1).map((b, i) => {
      const a = pts[i] ?? b;
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
    });
    const sharpAt = turn.flatMap((a, i) => (a > SHARP_TURN ? [along[i] ?? 0] : []));
    const ownCrossings = crossings.filter((c) => onRoad(c, chain, roads));
    const z = chain.layerOffset + 0.012;
    for (const line of chain.lines) {
      // The offset line: each point moved along the mitred normal.
      const off = pts.map((p, i) => {
        const n0 = normals[i - 1] ?? normals[i] ?? { x: 0, y: 0 };
        const n1 = normals[i] ?? n0;
        let mx = n0.x + n1.x;
        let my = n0.y + n1.y;
        const ml = Math.hypot(mx, my) || 1;
        mx /= ml;
        my /= ml;
        const scale = Math.min(2, 1 / Math.max(0.5, mx * n1.x + my * n1.y));
        return { x: p.x + mx * line.offset * scale, y: p.y + my * line.offset * scale };
      });
      // Positions along the line; queries mostly move forward, so a cursor keeps this linear.
      let cursor = 0;
      const at = (s: number): Vec2 => {
        if ((along[cursor] ?? 0) > s) cursor = 0;
        while (cursor + 2 < along.length && (along[cursor + 1] ?? 0) < s) cursor += 1;
        const i = cursor;
        const s0 = along[i] ?? 0;
        const s1 = along[i + 1] ?? s0;
        const t = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
        const a = off[i] ?? { x: 0, y: 0 };
        const b = off[i + 1] ?? a;
        return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
      };
      // Where the line may be painted: off other roads, and (offset lines) away from sharp bends.
      const allowed: [number, number][] = [];
      let open: number | null = null;
      for (let s = 0; s <= total + 1e-9; s += STEP_M) {
        const p = at(Math.min(s, total));
        let ok = !blocked(p.x, p.y, own, line.role === 'edge', level, joined);
        if (ok && Math.abs(line.offset) > 0.3) {
          for (const sharp of sharpAt) {
            if (Math.abs(s - sharp) < 2 + Math.abs(line.offset)) ok = false;
          }
        }
        for (const c of ownCrossings) {
          if (Math.hypot(p.x - c.position.x, p.y - c.position.y) < 3 + Math.abs(line.offset))
            ok = false;
        }
        if (ok && open === null) open = s;
        if (!ok && open !== null) {
          allowed.push([open, s - STEP_M]);
          open = null;
        }
      }
      if (open !== null) allowed.push([open, total]);

      // Painted pieces: dashes by distance along the chain (one rhythm for the whole chain).
      const pieces: [number, number][] = [];
      for (const [a, b] of allowed) {
        if (line.dash <= 0) {
          if (b - a >= 2) pieces.push([a, b]);
          continue;
        }
        const period = line.dash + line.gap;
        for (let k = Math.floor(a / period); k * period <= b; k += 1) {
          const d0 = Math.max(a, k * period);
          const d1 = Math.min(b, k * period + line.dash);
          // Fragments of dashes cut by a junction are left out.
          if (d1 - d0 >= 0.5 * line.dash) pieces.push([d0, d1]);
        }
      }
      const half = line.width / 2;
      pieces.forEach(([a, b], k) => {
        const color = tint(
          line.color,
          hashInts(hashString(chain.roads.map(String).join(',')), k, Math.round(line.offset * 100)),
        );
        // Split at the chain's points so the paint follows every bend.
        let s = a;
        let i = 0;
        while (s < b - 1e-6) {
          while (i + 2 < along.length && (along[i + 1] ?? 0) <= s + 1e-9) i += 1;
          const e = Math.min(b, along[i + 1] ?? b);
          quad(at(s), at(e), half, z, color);
          s = e > s ? e : b;
        }
        length[line.role] = (length[line.role] ?? 0) + (b - a);
        painted.push({
          chain: ci,
          role: line.role,
          color: line.color,
          offset: line.offset,
          s0: a,
          s1: b,
        });
      });
    }
  });

  // --- Stop lines and crossings ------------------------------------------------------
  let stopLines = 0;
  let crossingCount = 0;
  const nearestRoad = (p: Vec2) => {
    let best: { road: Road; x: number; y: number; dx: number; dy: number; d: number } | null = null;
    for (const s of cells.get(Math.floor(p.x / CELL) * 100_003 + Math.floor(p.y / CELL)) ?? []) {
      const r = roads[segs[s * SEG] ?? 0];
      if (!r) continue;
      const ax = segs[s * SEG + 1] ?? 0;
      const ay = segs[s * SEG + 2] ?? 0;
      const dx = (segs[s * SEG + 3] ?? 0) - ax;
      const dy = (segs[s * SEG + 4] ?? 0) - ay;
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) continue;
      const t = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / len2));
      const x = ax + t * dx;
      const y = ay + t * dy;
      const d = Math.hypot(p.x - x, p.y - y);
      if (!best || d < best.d) {
        const len = Math.sqrt(len2);
        best = { road: r, x, y, dx: dx / len, dy: dy / len, d };
      }
    }
    return best;
  };
  const white = tint('white', 7);
  for (const c of crossings) {
    const r = nearestRoad(c.position);
    if (!r || r.d > r.road.widthMeters / 2 + 1 || r.road.roadClass === 'path') continue;
    if (r.road.roadClass !== 'paved' && r.road.roadClass !== 'major') continue;
    const across = r.road.widthMeters / 2 - 0.2;
    const nx = -r.dy;
    const ny = r.dx;
    const z = ROAD_OFFSET_M + 0.014;
    if (c.crossing === 'zebra') {
      // Bars along the road, side by side across it, 3 m long.
      const bar = style.zebraBar;
      const n = Math.floor((2 * across + bar) / (2 * bar));
      const start = -((n - 1) * 2 * bar) / 2;
      for (let k = 0; k < n; k += 1) {
        const o = start + k * 2 * bar;
        const cx = r.x + nx * o;
        const cy = r.y + ny * o;
        quad(
          { x: cx - r.dx * 1.5, y: cy - r.dy * 1.5 },
          { x: cx + r.dx * 1.5, y: cy + r.dy * 1.5 },
          bar / 2,
          z,
          white,
        );
      }
    } else {
      // Two transverse lines 3 m apart.
      for (const o of [-1.5, 1.5]) {
        const cx = r.x + r.dx * o;
        const cy = r.y + r.dy * o;
        quad(
          { x: cx - nx * across, y: cy - ny * across },
          { x: cx + nx * across, y: cy + ny * across },
          0.15,
          z,
          white,
        );
      }
    }
    crossingCount += 1;
  }
  // Stop lines: across the approach (the right half, for traffic heading to the nearest junction).
  const junctionNodes: Vec2[] = [];
  for (const [k, n] of degree) {
    if (n < 3) continue;
    const [x, y] = k.split(',').map((v) => Number(v) / 1000);
    junctionNodes.push({ x: x ?? 0, y: y ?? 0 });
  }
  // Road ends on another road's side (no shared point) are junctions too.
  roads.forEach((r, ri) => {
    if (!isVehicle(r)) return;
    for (const p of [r.centerline[0], r.centerline[r.centerline.length - 1]]) {
      if (!p || (degree.get(key(p)) ?? 0) >= 3) continue;
      for (const sg of cells.get(Math.floor(p.x / CELL) * 100_003 + Math.floor(p.y / CELL)) ?? []) {
        if (segs[sg * SEG] === ri) continue;
        const ax = segs[sg * SEG + 1] ?? 0;
        const ay = segs[sg * SEG + 2] ?? 0;
        const dx = (segs[sg * SEG + 3] ?? 0) - ax;
        const dy = (segs[sg * SEG + 4] ?? 0) - ay;
        const len2 = dx * dx + dy * dy;
        const t =
          len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / len2));
        if (Math.hypot(p.x - ax - t * dx, p.y - ay - t * dy) < 1) {
          junctionNodes.push(p);
          break;
        }
      }
    }
  });
  junctionNodes.sort((a, b) => a.x - b.x || a.y - b.y);
  for (const st of stops) {
    const r = nearestRoad(st.position);
    if (!r || r.d > r.road.widthMeters / 2 + 1) continue;
    if (r.road.roadClass !== 'paved' && r.road.roadClass !== 'major') continue;
    let best: Vec2 | null = null;
    let bestD = 40;
    for (const j of junctionNodes) {
      const d = Math.hypot(j.x - st.position.x, j.y - st.position.y);
      if (d < bestD && d > 1) {
        bestD = d;
        best = j;
      }
    }
    if (!best) continue;
    // Travel along the road towards the junction.
    const sgn = (best.x - r.x) * r.dx + (best.y - r.y) * r.dy >= 0 ? 1 : -1;
    const tx = r.dx * sgn;
    const ty = r.dy * sgn;
    const half = r.road.widthMeters / 2 - 0.2;
    // The right of travel is (ty, −tx).
    const z = ROAD_OFFSET_M + 0.014;
    quad(
      { x: r.x, y: r.y },
      { x: r.x + ty * half, y: r.y - tx * half },
      style.stopLineWidth / 2,
      z,
      white,
    );
    stopLines += 1;
  }

  return {
    chains: chains.map((c) => ({
      roads: c.roads.map((ri) => roads[ri]?.id ?? ''),
      points: c.points,
      lines: c.lines,
    })),
    pieces: painted,
    quads,
    stats: {
      markedRoads: specs.filter((s) => s !== null).length,
      chains: chains.length,
      byReason,
      length,
      stopLines,
      crossings: crossingCount,
    },
  };
}

/** Whether a crossing lies on one of a chain's roads. */
function onRoad(c: DecorPoint, chain: Chain, roads: readonly Road[]): boolean {
  for (const ri of chain.roads) {
    const r = roads[ri];
    if (!r) continue;
    for (let i = 0; i + 1 < r.centerline.length; i += 1) {
      const a = r.centerline[i];
      const b = r.centerline[i + 1];
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      const t =
        len2 === 0
          ? 0
          : Math.max(
              0,
              Math.min(1, ((c.position.x - a.x) * dx + (c.position.y - a.y) * dy) / len2),
            );
      if (
        Math.hypot(c.position.x - a.x - t * dx, c.position.y - a.y - t * dy) <
        r.widthMeters / 2 + 1
      )
        return true;
    }
  }
  return false;
}
