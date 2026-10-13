import type { Road, RoadClass } from '../environment';
import type { BaseSurface } from './base';
import type { CoverMap } from './landcover';

// Roads as continuous constraints (research §5.3, §5.6): each road gets a
// longitudinal profile (the smoothed ground along it, pinned at junctions) and a
// cross-section evaluated at any point from its distance to the centreline:
// a level carriageway, shoulder, ditch, then cut or fill slopes back to
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
  /**
   * Where this road joins a higher-ranked one, its surface follows that road's
   * grade near the junction (`roadLevel`): per junction, eight numbers: arc
   * length here, junction x and y, level, the other road's direction (x, y)
   * and grade there, and how far along this road the warp reaches.
   */
  readonly warps: number[];
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

/**
 * The road's surface level at (x, y), whose nearest point on the road is at
 * arc length s: its profile, except near a junction with a higher-ranked road,
 * where it eases onto that road's grade (a plane through the junction along
 * it), so the two surfaces meet without a step, as a graded junction does.
 */
export function roadLevel(road: RoadStamp, s: number, x: number, y: number): number {
  let level = levelAt(road, s);
  const w = road.warps;
  for (let k = 0; k + 7 < w.length; k += 8) {
    const from = s - (w[k] ?? 0);
    const d = from < 0 ? -from : from;
    const reach = w[k + 7] ?? 0;
    if (d >= reach) continue;
    const u = d / reach;
    const f = 1 - u * u * (3 - 2 * u);
    const plane =
      (w[k + 3] ?? 0) +
      (w[k + 6] ?? 0) *
        ((x - (w[k + 1] ?? 0)) * (w[k + 4] ?? 0) + (y - (w[k + 2] ?? 0)) * (w[k + 5] ?? 0));
    level += f * (plane - level);
  }
  return level;
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
 * Builds every road's stamp: profiles from the base, then made to meet level
 * at junctions and crossings (`pinJunctions`), bridges laid straight between their
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
      warps: [],
    });
  }
  pinJunctions(stamps);
  return stamps;
}

/** Adds `delta` at arc length `at`, fading smoothly to 0 over `length` either side. */
function bend(road: RoadStamp, at: number, delta: number, length: number): void {
  const p = road.profile;
  const total = road.cum[road.cum.length - 1] ?? 0;
  const n = p.length;
  for (let i = 0; i < n; i += 1) {
    const s = Math.min(total, i * PROFILE_STEP_M);
    const from = s > at ? s - at : at - s;
    if (from >= length) continue;
    const f = 1 - from / length;
    p[i] = (p[i] ?? 0) + delta * f * f * (3 - 2 * f);
  }
}

/** Junction passes at most; they stop once every junction agrees within the tolerance, metres. */
const PIN_PASSES = 12;
const PIN_TOLERANCE_M = 0.002;
/** How far past the higher road's surface a joining road eases onto its grade, metres. */
const WARP_M = 8;
/** Furthest a joining road is followed while its surface touches the higher road's, metres. */
const WARP_MAX_M = 80;

/**
 * Makes roads meet level at every junction: where roads end together, where a
 * road ends on another, and where roads cross. Each junction takes the level
 * of its highest-ranked road (ties by id); every other road there is bent to
 * it around the junction (from an end, or either side of a crossing). Bending
 * a road moves the junctions near it, so the passes repeat until all agree.
 * Bridges take the level at their ends and are laid straight between them.
 */
function pinJunctions(stamps: RoadStamp[]): void {
  interface Member {
    road: RoadStamp;
    /** Arc length of the junction along the road. */
    s: number;
  }
  interface Junction {
    x: number;
    y: number;
    members: Member[];
  }
  const B = 32;
  /** A road's surface (carriageway and shoulder) either side of its centreline, at least JOIN_M. */
  const reachOf = (road: RoadStamp) => Math.max(JOIN_M, road.half + road.shoulder);
  const cell = (v: number) => Math.floor(v / B);
  const key = (cx: number, cy: number) => `${String(cx)},${String(cy)}`;
  // Road segments by bucket as (road index, segment offset), reaching as far as ends join them.
  const segBuckets = new Map<string, number[]>();
  stamps.forEach((road, ri) => {
    const r = reachOf(road);
    for (let i = 0; i + 3 < road.xy.length; i += 2) {
      const x0 = Math.min(road.xy[i] ?? 0, road.xy[i + 2] ?? 0) - r;
      const x1 = Math.max(road.xy[i] ?? 0, road.xy[i + 2] ?? 0) + r;
      const y0 = Math.min(road.xy[i + 1] ?? 0, road.xy[i + 3] ?? 0) - r;
      const y1 = Math.max(road.xy[i + 1] ?? 0, road.xy[i + 3] ?? 0) + r;
      for (let bx = cell(x0); bx <= cell(x1); bx += 1)
        for (let by = cell(y0); by <= cell(y1); by += 1) {
          const k = key(bx, by);
          const list = segBuckets.get(k);
          if (list) list.push(ri, i);
          else segBuckets.set(k, [ri, i]);
        }
    }
  });
  const junctions: Junction[] = [];
  const byCell = new Map<string, Junction[]>();
  /** Whether `j` holds `road` (at about arc length `s`, when given). */
  const holds = (j: Junction, road: RoadStamp, s?: number) =>
    j.members.some((m) => m.road === road && (s === undefined || Math.abs(m.s - s) <= 2 * JOIN_M));
  /** The junction within JOIN_M of (x, y) that holds `road` (at about `s`), if any. */
  const nearJunction = (x: number, y: number, road: RoadStamp, s?: number): Junction | null => {
    for (let bx = -1; bx <= 1; bx += 1)
      for (let by = -1; by <= 1; by += 1)
        for (const j of byCell.get(key(cell(x) + bx, cell(y) + by)) ?? []) {
          const dx = j.x - x;
          const dy = j.y - y;
          if (dx * dx + dy * dy <= JOIN_M * JOIN_M && holds(j, road, s)) return j;
        }
    return null;
  };
  const addJunction = (j: Junction) => {
    junctions.push(j);
    const k = key(cell(j.x), cell(j.y));
    const list = byCell.get(k);
    if (list) list.push(j);
    else byCell.set(k, [j]);
  };
  /**
   * Adds `road` to `j` at its nearest point, when it passes within `extra`
   * plus its own surface of `j` (an end on it, or whose surface touches it),
   * and it is not there yet.
   */
  const join = (j: Junction, road: RoadStamp, extra: number) => {
    if (holds(j, road)) return;
    const n = nearestOnRoad(road, j.x, j.y);
    if (n.d <= reachOf(road) + extra) j.members.push({ road, s: n.s });
  };
  /** Roads with a segment in the buckets around (x, y). */
  const roadsNear = (x: number, y: number): RoadStamp[] => {
    const out: RoadStamp[] = [];
    for (let bx = -1; bx <= 1; bx += 1)
      for (let by = -1; by <= 1; by += 1) {
        const list = segBuckets.get(key(cell(x) + bx, cell(y) + by)) ?? [];
        for (let k = 0; k < list.length; k += 2) {
          const r = stamps[list[k] ?? 0];
          if (r && !out.includes(r)) out.push(r);
        }
      }
    return out;
  };

  // Road ends: each end with the other roads that end at it or pass through it.
  for (const road of stamps) {
    const n = road.xy.length;
    const total = road.cum[road.cum.length - 1] ?? 0;
    const ends: readonly [[number, number, number], [number, number, number]] = [
      [road.xy[0] ?? 0, road.xy[1] ?? 0, 0],
      [road.xy[n - 2] ?? 0, road.xy[n - 1] ?? 0, total],
    ];
    for (const [x, y, s] of ends) {
      if (nearJunction(x, y, road, s)) continue;
      const j: Junction = { x, y, members: [{ road, s }] };
      // A road that ends where it began (a loop) meets itself.
      const [ox, oy, os] = s === 0 ? ends[1] : ends[0];
      if (os !== s && (ox - x) * (ox - x) + (oy - y) * (oy - y) <= JOIN_M * JOIN_M)
        j.members.push({ road, s: os });
      for (const other of roadsNear(x, y)) if (other !== road) join(j, other, reachOf(road));
      if (j.members.length > 1) addJunction(j);
    }
  }
  // Crossings: segments of two roads (neither a bridge) that meet away from any junction of both.
  for (const [k, list] of segBuckets) {
    for (let a = 0; a < list.length; a += 2)
      for (let b = a + 2; b < list.length; b += 2) {
        const ra = stamps[list[a] ?? 0];
        const rb = stamps[list[b] ?? 0];
        if (!ra || !rb || ra === rb || ra.bridge || rb.bridge) continue;
        const i = list[a + 1] ?? 0;
        const m = list[b + 1] ?? 0;
        const ax = ra.xy[i] ?? 0;
        const ay = ra.xy[i + 1] ?? 0;
        const adx = (ra.xy[i + 2] ?? 0) - ax;
        const ady = (ra.xy[i + 3] ?? 0) - ay;
        const bx = rb.xy[m] ?? 0;
        const by = rb.xy[m + 1] ?? 0;
        const bdx = (rb.xy[m + 2] ?? 0) - bx;
        const bdy = (rb.xy[m + 3] ?? 0) - by;
        const den = adx * bdy - ady * bdx;
        if (den === 0) continue;
        const t = ((bx - ax) * bdy - (by - ay) * bdx) / den;
        const u = ((bx - ax) * ady - (by - ay) * adx) / den;
        if (t < 0 || t > 1 || u < 0 || u > 1) continue;
        const x = ax + t * adx;
        const y = ay + t * ady;
        // Each crossing once: in the bucket it lies in.
        if (key(cell(x), cell(y)) !== k) continue;
        const ja = nearJunction(x, y, ra);
        if (ja) {
          join(ja, rb, 0);
          continue;
        }
        const jb = nearJunction(x, y, rb);
        if (jb) {
          join(jb, ra, 0);
          continue;
        }
        const ca = ra.cum[i / 2] ?? 0;
        const cb = rb.cum[m / 2] ?? 0;
        addJunction({
          x,
          y,
          members: [
            { road: ra, s: ca + t * ((ra.cum[i / 2 + 1] ?? 0) - ca) },
            { road: rb, s: cb + u * ((rb.cum[m / 2 + 1] ?? 0) - cb) },
          ],
        });
      }
  }

  // Each junction's anchor: its highest-ranked road that is not a bridge; of equals, one
  // passing through (not ending there), then by id and arc length.
  const rankOf = (m: Member) => (m.road.bridge ? 0 : m.road.rule.rank);
  const passes = (m: Member) => m.s > 0 && m.s < (m.road.cum[m.road.cum.length - 1] ?? 0);
  const byId = (a: Member, b: Member) =>
    a.road.id < b.road.id ? -1 : a.road.id > b.road.id ? 1 : a.s - b.s;
  const solved: { j: Junction; anchor: Member; rank: number }[] = [];
  for (const j of junctions) {
    const anchor = [...j.members].sort(
      (a, b) => rankOf(b) - rankOf(a) || Number(passes(b)) - Number(passes(a)) || byId(a, b),
    )[0];
    if (anchor && rankOf(anchor) > 0) solved.push({ j, anchor, rank: rankOf(anchor) });
  }
  solved.sort((a, b) => b.rank - a.rank || byId(a.anchor, b.anchor));
  for (let pass = 0; pass < PIN_PASSES; pass += 1) {
    let worst = 0;
    for (const { j, anchor } of solved) {
      const level = levelAt(anchor.road, anchor.s);
      for (const m of j.members) {
        if (m === anchor || m.road.bridge) continue;
        const delta = level - levelAt(m.road, m.s);
        if (delta === 0) continue;
        bend(m.road, m.s, delta, m.road.rule.pin);
        const e = delta < 0 ? -delta : delta;
        if (e > worst) worst = e;
      }
    }
    if (worst < PIN_TOLERANCE_M) break;
  }
  // Every other road at a junction eases onto the anchor's grade there.
  for (const { j, anchor } of solved) {
    if (anchor.road.bridge) continue;
    const a = anchor.road;
    const total = a.cum[a.cum.length - 1] ?? 0;
    const s0 = Math.max(0, anchor.s - 1);
    const s1 = Math.min(total, anchor.s + 1);
    if (s1 <= s0) continue;
    const [x0, y0] = pointAt(a.xy, a.cum, s0);
    const [x1, y1] = pointAt(a.xy, a.cum, s1);
    const len = Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
    if (len === 0) continue;
    const grade = (levelAt(a, s1) - levelAt(a, s0)) / (s1 - s0);
    const level = levelAt(a, anchor.s);
    for (const m of j.members) {
      if (m === anchor || m.road === a || m.road.bridge) continue;
      // As far along this road as its surface still touches the anchor's
      // (roads leaving at a shallow angle), then WARP_M more.
      const r = m.road;
      const rTotal = r.cum[r.cum.length - 1] ?? 0;
      const touch = a.half + a.shoulder + r.half + r.shoulder;
      let along = 0;
      for (const dir of [-1, 1]) {
        for (let k = PROFILE_STEP_M; k <= WARP_MAX_M; k += PROFILE_STEP_M) {
          const s = m.s + dir * k;
          if (s < 0 || s > rTotal) break;
          const [px, py] = pointAt(r.xy, r.cum, s);
          if (nearestOnRoad(a, px, py).d > touch) break;
          if (k > along) along = k;
        }
      }
      const reach = Math.max(along, a.half + a.shoulder) + WARP_M;
      r.warps.push(m.s, j.x, j.y, level, (x1 - x0) / len, (y1 - y0) / len, grade, reach);
    }
  }
  // Bridges: their ends take the junction's level, and they are straight between them.
  for (const { j, anchor } of solved) {
    const level = levelAt(anchor.road, anchor.s);
    for (const m of j.members) {
      if (!m.road.bridge) continue;
      const p = m.road.profile;
      if (m.s <= 0) p[0] = level;
      else if (m.s >= (m.road.cum[m.road.cum.length - 1] ?? 0)) p[p.length - 1] = level;
    }
  }
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
    let z = level;
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
  const edgeZ = level;
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
