import type { Road, RoadClass } from '../environment';
import type { BaseSurface } from './base';
import type { CoverMap } from './landcover';

// Roads as continuous constraints (research §5.3, §5.6): each road gets a
// longitudinal profile (the smoothed ground along it, pinned at junctions) and a
// cross-section evaluated at any point from its distance to the centreline:
// carriageway with camber, shoulder, ditch, then cut or fill slopes back to
// the ground. Nothing depends on a lattice.

/** Road surface material codes (stored in the material tiles). */
export const RoadSurface = {
  None: 0,
  Asphalt: 1,
  Paving: 2,
  Gravel: 3,
  Track: 4,
  Dirt: 5,
} as const;
export type RoadSurface = (typeof RoadSurface)[keyof typeof RoadSurface];

interface ClassRule {
  /** Half-window of the profile's smoothing, metres (applied twice). */
  readonly smooth: number;
  /** Most the centreline may leave the ground, metres. */
  readonly maxDepth: number;
  /** Cross fall of the carriageway (per metre from the centre). */
  readonly camber: number;
  /** Shoulder width (rural), metres. */
  readonly shoulder: number;
  /** Rural roads of this class get a ditch. */
  readonly ditch: boolean;
  /** Side slopes (rise per metre) and their reach beyond the shoulder or ditch, metres. */
  readonly fill: number;
  readonly cut: number;
  readonly reach: number;
  /** Pinning blend length at junctions, metres. */
  readonly pin: number;
  readonly rank: number;
}

const RULES: Readonly<Record<RoadClass, ClassRule>> = {
  major: {
    smooth: 24,
    maxDepth: 4,
    camber: 0.025,
    shoulder: 1.2,
    ditch: true,
    fill: 0.5,
    cut: 2 / 3,
    reach: 9,
    pin: 40,
    rank: 5,
  },
  paved: {
    smooth: 16,
    maxDepth: 3,
    camber: 0.025,
    shoulder: 0.8,
    ditch: true,
    fill: 0.5,
    cut: 2 / 3,
    reach: 8,
    pin: 30,
    rank: 4,
  },
  unpaved: {
    smooth: 10,
    maxDepth: 1.5,
    camber: 0.03,
    shoulder: 0.5,
    ditch: true,
    fill: 0.6,
    cut: 0.8,
    reach: 5,
    pin: 20,
    rank: 3,
  },
  track: {
    smooth: 5,
    maxDepth: 0.6,
    camber: 0.0,
    shoulder: 0.3,
    ditch: false,
    fill: 1,
    cut: 1,
    reach: 2.5,
    pin: 12,
    rank: 2,
  },
  path: {
    smooth: 2.5,
    maxDepth: 0.3,
    camber: 0.0,
    shoulder: 0.15,
    ditch: false,
    fill: 1.2,
    cut: 1.2,
    reach: 1.5,
    pin: 6,
    rank: 1,
  },
};

/** Ditch: width and full depth, metres. */
export const DITCH_WIDTH_M = 1.8;
export const DITCH_DEPTH_M = 0.45;
/** Wheel ruts on tracks: offset from the centre, half width and depth, metres. */
const RUT_OFFSET_M = 0.8;
const RUT_HALF_M = 0.22;
const RUT_DEPTH_M = 0.06;
/** Fade of a road's effect after its reach, metres. */
const FADE_M = 3;
/** Profile sample spacing along a road, metres. */
export const PROFILE_STEP_M = 2;
/** Endpoints this close are one junction; an end this close to another road joins it there, metres. */
const JOIN_M = 1.5;

function surfaceOf(road: Road, urban: boolean): RoadSurface {
  const s = road.traffic?.surface ?? '';
  if (/asphalt|concrete$|^paved|chipseal/.test(s)) return RoadSurface.Asphalt;
  if (/paving|sett|cobble|concrete:|brick|unhewn/.test(s)) return RoadSurface.Paving;
  if (/gravel|compacted|pebble|rock/.test(s)) return RoadSurface.Gravel;
  if (s.includes('grass')) return RoadSurface.Track;
  if (/dirt|earth|ground|mud|sand|unpaved/.test(s)) return RoadSurface.Dirt;
  switch (road.roadClass) {
    case 'major':
    case 'paved':
      return RoadSurface.Asphalt;
    case 'unpaved':
      return RoadSurface.Gravel;
    case 'track':
      return RoadSurface.Track;
    case 'path':
      return urban ? RoadSurface.Paving : RoadSurface.Dirt;
  }
}

export interface RoadStamp {
  readonly index: number;
  readonly id: string;
  readonly rule: ClassRule;
  readonly surface: RoadSurface;
  readonly urban: boolean;
  readonly bridge: boolean;
  /** Half the carriageway, metres. */
  readonly half: number;
  readonly shoulder: number;
  readonly ditch: boolean;
  /** Polyline x, y pairs and cumulative length at each vertex. */
  readonly xy: Float64Array;
  readonly cum: Float64Array;
  /** Centre level every `PROFILE_STEP_M` along the road (last sample at the end). */
  readonly profile: Float64Array;
  /** Furthest distance from the centreline the road changes the ground, metres. */
  readonly extent: number;
}

/** A road's centre level at arc length s. */
export function levelAt(road: RoadStamp, s: number): number {
  const p = road.profile;
  const n = p.length;
  const total = road.cum[road.cum.length - 1] ?? 0;
  const u = (s < 0 ? 0 : s > total ? total : s) / PROFILE_STEP_M;
  let i = Math.floor(u);
  if (i >= n - 1) i = n - 2;
  if (i < 0) return p[0] ?? 0;
  const t = u - i;
  return (p[i] ?? 0) + t * ((p[i + 1] ?? 0) - (p[i] ?? 0));
}

/** Point at arc length s along a polyline. */
function pointAt(xy: Float64Array, cum: Float64Array, s: number): [number, number] {
  const n = cum.length;
  let i = 0;
  while (i < n - 2 && (cum[i + 1] ?? 0) < s) i += 1;
  const l = (cum[i + 1] ?? 0) - (cum[i] ?? 0);
  const t = l > 0 ? (s - (cum[i] ?? 0)) / l : 0;
  const ax = xy[2 * i] ?? 0;
  const ay = xy[2 * i + 1] ?? 0;
  return [ax + t * ((xy[2 * i + 2] ?? 0) - ax), ay + t * ((xy[2 * i + 3] ?? 0) - ay)];
}

function boxSmooth(v: Float64Array, half: number): Float64Array {
  const n = v.length;
  if (half < 1 || n < 3) return v;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const a = Math.max(0, i - half);
    const b = Math.min(n - 1, i + half);
    let sum = 0;
    for (let k = a; k <= b; k += 1) sum += v[k] ?? 0;
    out[i] = sum / (b - a + 1);
  }
  return out;
}

/** Nearest point on a road: distance, arc length. */
export function nearestOnRoad(road: RoadStamp, x: number, y: number): { d: number; s: number } {
  const xy = road.xy;
  let best = Infinity;
  let bestS = 0;
  for (let i = 0; i + 3 < xy.length; i += 2) {
    const ax = xy[i] ?? 0;
    const ay = xy[i + 1] ?? 0;
    const dx = (xy[i + 2] ?? 0) - ax;
    const dy = (xy[i + 3] ?? 0) - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + t * dx - x;
    const py = ay + t * dy - y;
    const d2 = px * px + py * py;
    if (d2 < best) {
      best = d2;
      const c = road.cum[i / 2] ?? 0;
      bestS = c + t * ((road.cum[i / 2 + 1] ?? 0) - c);
    }
  }
  return { d: Math.sqrt(best), s: bestS };
}

/**
 * Builds every road's stamp: profiles from the base, then pinned at junctions
 * (highest-ranked road first; ties by id), bridges laid straight between their
 * ends. Tunnels are left out: the ground over them is untouched.
 */
export function roadStamps(
  roads: readonly Road[],
  base: BaseSurface,
  cover: CoverMap,
): RoadStamp[] {
  const sorted = [...roads]
    .filter((r) => r.crossing?.kind !== 'tunnel' && r.centerline.length >= 2)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const stamps: RoadStamp[] = [];
  for (const road of sorted) {
    const n = road.centerline.length;
    const xy = new Float64Array(2 * n);
    const cum = new Float64Array(n);
    road.centerline.forEach((p, i) => {
      xy[2 * i] = p.x;
      xy[2 * i + 1] = p.y;
      if (i > 0) {
        const dx = p.x - (xy[2 * i - 2] ?? 0);
        const dy = p.y - (xy[2 * i - 1] ?? 0);
        cum[i] = (cum[i - 1] ?? 0) + Math.sqrt(dx * dx + dy * dy);
      }
    });
    const total = cum[n - 1] ?? 0;
    if (total <= 0) continue;
    const rule = RULES[road.roadClass];
    const m = Math.max(2, Math.ceil(total / PROFILE_STEP_M) + 1);
    const raw = new Float64Array(m);
    for (let i = 0; i < m; i += 1) {
      const [px, py] = pointAt(xy, cum, Math.min(total, i * PROFILE_STEP_M));
      raw[i] = base.at(px, py);
    }
    const half = Math.max(1, Math.round(rule.smooth / PROFILE_STEP_M));
    const smooth = boxSmooth(boxSmooth(raw, half), half);
    for (let i = 0; i < m; i += 1) {
      const r = raw[i] ?? 0;
      const v = smooth[i] ?? 0;
      smooth[i] =
        v > r + rule.maxDepth ? r + rule.maxDepth : v < r - rule.maxDepth ? r - rule.maxDepth : v;
    }
    const mid = road.centerline[Math.floor(n / 2)] ?? { x: 0, y: 0 };
    const urban = cover.builtUp(mid.x, mid.y);
    const bridge = road.bridge === true || road.crossing?.kind === 'bridge';
    const shoulder = urban && rule.rank >= 3 ? 1.2 : rule.shoulder;
    const ditch = rule.ditch && !urban && !bridge;
    const halfWidth = Math.max(0.6, road.widthMeters / 2);
    stamps.push({
      index: stamps.length,
      id: road.id,
      rule,
      surface: surfaceOf(road, urban),
      urban,
      bridge,
      half: halfWidth,
      shoulder,
      ditch,
      xy,
      cum,
      profile: smooth,
      extent: halfWidth + shoulder + (ditch ? DITCH_WIDTH_M : 0) + rule.reach + FADE_M,
    });
  }
  pinJunctions(stamps);
  return stamps;
}

/** Adds `delta` at arc length 0 (or the end), fading linearly to 0 over `length`. */
function bend(road: RoadStamp, atStart: boolean, delta: number, length: number): void {
  const p = road.profile;
  const total = road.cum[road.cum.length - 1] ?? 0;
  const n = p.length;
  for (let i = 0; i < n; i += 1) {
    const s = Math.min(total, i * PROFILE_STEP_M);
    const from = atStart ? s : total - s;
    if (from >= length) continue;
    p[i] = (p[i] ?? 0) + delta * (1 - from / length);
  }
}

function pinJunctions(stamps: RoadStamp[]): void {
  interface End {
    road: RoadStamp;
    atStart: boolean;
    x: number;
    y: number;
  }
  const ends: End[] = [];
  for (const road of stamps) {
    const n = road.xy.length;
    ends.push({ road, atStart: true, x: road.xy[0] ?? 0, y: road.xy[1] ?? 0 });
    ends.push({ road, atStart: false, x: road.xy[n - 2] ?? 0, y: road.xy[n - 1] ?? 0 });
  }
  // Bucket ends and road segments for neighbour search.
  const B = 32;
  const key = (x: number, y: number) => `${String(Math.floor(x / B))},${String(Math.floor(y / B))}`;
  const endBuckets = new Map<string, End[]>();
  for (const e of ends) {
    const k = key(e.x, e.y);
    const list = endBuckets.get(k);
    if (list) list.push(e);
    else endBuckets.set(k, [e]);
  }
  const segBuckets = new Map<string, RoadStamp[]>();
  for (const road of stamps) {
    const seen = new Set<string>();
    for (let i = 0; i + 3 < road.xy.length; i += 2) {
      const x0 = Math.min(road.xy[i] ?? 0, road.xy[i + 2] ?? 0) - JOIN_M;
      const x1 = Math.max(road.xy[i] ?? 0, road.xy[i + 2] ?? 0) + JOIN_M;
      const y0 = Math.min(road.xy[i + 1] ?? 0, road.xy[i + 3] ?? 0) - JOIN_M;
      const y1 = Math.max(road.xy[i + 1] ?? 0, road.xy[i + 3] ?? 0) + JOIN_M;
      for (let bx = Math.floor(x0 / B); bx <= Math.floor(x1 / B); bx += 1)
        for (let by = Math.floor(y0 / B); by <= Math.floor(y1 / B); by += 1) {
          const k = `${String(bx)},${String(by)}`;
          if (seen.has(k)) continue;
          seen.add(k);
          const list = segBuckets.get(k);
          if (list) list.push(road);
          else segBuckets.set(k, [road]);
        }
    }
  }
  // Junctions: clusters of ends, processed from the highest-ranked road down.
  const done = new Set<End>();
  const clusters: { ends: End[]; x: number; y: number; rank: number; id: string }[] = [];
  for (const e of ends) {
    if (done.has(e)) continue;
    const members: End[] = [];
    for (let bx = -1; bx <= 1; bx += 1)
      for (let by = -1; by <= 1; by += 1) {
        const list = endBuckets.get(
          `${String(Math.floor(e.x / B) + bx)},${String(Math.floor(e.y / B) + by)}`,
        );
        for (const o of list ?? []) {
          if (done.has(o)) continue;
          const dx = o.x - e.x;
          const dy = o.y - e.y;
          if (dx * dx + dy * dy <= JOIN_M * JOIN_M) members.push(o);
        }
      }
    for (const m of members) done.add(m);
    const rank = Math.max(...members.map((m) => (m.road.bridge ? 0 : m.road.rule.rank)));
    clusters.push({ ends: members, x: e.x, y: e.y, rank, id: e.road.id });
  }
  clusters.sort((a, b) => b.rank - a.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const value = (e: End) => {
    const p = e.road.profile;
    return e.atStart ? (p[0] ?? 0) : (p[p.length - 1] ?? 0);
  };
  for (const c of clusters) {
    // A road passing through the junction (not ending there) holds it.
    let through: { road: RoadStamp; level: number } | null = null;
    const members = new Set(c.ends.map((e) => e.road));
    for (const road of segBuckets.get(key(c.x, c.y)) ?? []) {
      if (members.has(road) || road.bridge) continue;
      const near = nearestOnRoad(road, c.x, c.y);
      if (near.d > JOIN_M) continue;
      if (!through || road.rule.rank > through.road.rule.rank)
        through = { road, level: levelAt(road, near.s) };
    }
    const anchors = c.ends.filter((e) => !e.road.bridge);
    anchors.sort(
      (a, b) =>
        b.road.rule.rank - a.road.rule.rank ||
        (a.road.id < b.road.id ? -1 : a.road.id > b.road.id ? 1 : 0),
    );
    const top = anchors[0];
    let level: number | null = null;
    if (through && (!top || through.road.rule.rank >= top.road.rule.rank)) level = through.level;
    else if (top) level = value(top);
    if (level === null) continue;
    for (const e of c.ends) {
      if (e.road.bridge) continue;
      const delta = level - value(e);
      if (delta !== 0) bend(e.road, e.atStart, delta, e.road.rule.pin);
    }
    // Bridges: their ends take the junction's level (laid straight below).
    for (const e of c.ends) {
      if (!e.road.bridge) continue;
      const p = e.road.profile;
      if (e.atStart) p[0] = level;
      else p[p.length - 1] = level;
    }
  }
  // Bridges are straight between their ends: they span what lies below.
  for (const road of stamps) {
    if (!road.bridge) continue;
    const p = road.profile;
    const n = p.length;
    const a = p[0] ?? 0;
    const b = p[n - 1] ?? 0;
    for (let i = 1; i < n - 1; i += 1) p[i] = a + ((b - a) * i) / (n - 1);
  }
}

/** One road's effect at a point: bounds on the ground and what surface is there. */
export interface RoadEffect {
  lo: number;
  hi: number;
  /** 0–1: how strongly the bounds apply (fades out beyond the road's reach). */
  w: number;
  /** In the carriageway or shoulder: the bounds are one exact level. */
  core: boolean;
  /** Signed distance to the carriageway's edge (negative on the carriageway), metres. */
  edge: number;
  /** How much of a ditch is here (0–1), for wetness. */
  ditch: number;
}

/**
 * The cross-section of `road` at distance `d` from its centreline, where the
 * centre level is `level` and the natural ground (with relief) is `ground`.
 */
export function roadEffect(
  road: RoadStamp,
  d: number,
  level: number,
  ground: number,
  out: RoadEffect,
): void {
  const rule = road.rule;
  const half = road.half;
  const e = d - half;
  out.edge = e;
  out.ditch = 0;
  if (e <= 0) {
    let z = level - rule.camber * d;
    if (road.surface === RoadSurface.Track) {
      const r = Math.abs(d - RUT_OFFSET_M) / RUT_HALF_M;
      if (r < 1) z -= RUT_DEPTH_M * (1 - r * r);
    }
    out.lo = z;
    out.hi = z;
    out.w = 1;
    out.core = true;
    return;
  }
  const edgeZ = level - rule.camber * half;
  const sh = road.shoulder;
  if (e <= sh) {
    const z = edgeZ - (road.urban ? 0.02 : 0.04) * e;
    out.lo = z;
    out.hi = z;
    out.w = 1;
    out.core = true;
    return;
  }
  const top = edgeZ - (road.urban ? 0.02 : 0.04) * sh;
  const q = e - sh;
  let dip = 0;
  let qd = 0;
  if (road.ditch) {
    qd = DITCH_WIDTH_M;
    if (q < DITCH_WIDTH_M) {
      // Only where the ground is not below the road: no ditch on an embankment.
      const g = ground - top;
      const f = g <= -0.6 ? 0 : g >= 0.1 ? 1 : (g + 0.6) / 0.7;
      const u = (q - DITCH_WIDTH_M / 2) / (DITCH_WIDTH_M / 2);
      dip = DITCH_DEPTH_M * f * f * (3 - 2 * f) * (1 - u * u);
      out.ditch = (1 - u * u) * f;
    }
  }
  const fill = road.urban ? 1 : rule.fill;
  const cut = road.urban ? 1 : rule.cut;
  const reach = road.urban ? Math.min(rule.reach, 4) : rule.reach;
  out.hi = top - dip + cut * (q > qd ? q - qd : 0);
  out.lo = top - dip - fill * q;
  const r = q - qd;
  const t = r <= reach ? 0 : r >= reach + FADE_M ? 1 : (r - reach) / FADE_M;
  out.w = 1 - t * t * (3 - 2 * t);
  out.core = false;
}
