import type { WaterArea, WaterClass, Waterway } from './environment';
import type { Vec2 } from './geometry';
import { polygonArea } from './polygon';
import { heightAt, type TerrainDataset } from './terrain';

// Water levels for terrain grading (docs/adr/0040). Open water is mapped as
// polygons (lakes, ponds, river areas, the sea) and lines (rivers, canals,
// streams), but the elevation data under it is rarely a water surface: at
// 10 m it mixes the banks into the water and holds the noise of whatever
// surveyed it. Here every water body that can be levelled gets its level
// from the data around it:
//
// - Standing water (sea, lakes, reservoirs, ponds, basins) one exactly
//   horizontal level: the sea at 0 m (the elevation data's datum is mean sea
//   level), others the median of the ground along their shoreline, checked
//   against the ground inside them.
// - Flowing water (rivers and canals) a level across each section and a
//   smooth profile downstream: the ground along the centreline with its
//   spikes filtered out, then fitted so it never rises downstream (in the
//   direction OSM draws waterways, when the ground agrees), then smoothed.
//   Profiles meet the lakes they run into or out of, and tributaries meet
//   the river they join, at the same level.
//
// The terrain field (terrain-field/) then cuts a shallow bed under the water and makes the
// shores meet the level, and the levels are kept with the graded terrain, so
// the 3D water, the shore materials and everything else use the same ones.
// Pure and deterministic: the levels depend on the source ground and the
// features alone, never on the order the features were listed in.

/** Bump when the rules for water levels or water grading change. */
export const WATER_GRADING_VERSION = 1;

export type WaterFlow = 'standing' | 'flowing';

export interface WaterClassRule {
  readonly flow: WaterFlow;
  /** Smaller bodies are not levelled (they keep the ground as it is), m². */
  readonly minAreaM2: number;
  /** Depth of the bed away from the shore, metres. */
  readonly depthM: number;
}

/**
 * Which water is levelled, and how (configurable). The sea is always
 * levelled; lakes and reservoirs nearly always; ponds and basins once they
 * are a few cells of the elevation grid across (smaller ones are left as
 * the data has them: they are not resolved by it anyway).
 */
export const WATER_RULES: Readonly<Record<WaterClass, WaterClassRule>> = {
  sea: { flow: 'standing', minAreaM2: 0, depthM: 2.5 },
  lake: { flow: 'standing', minAreaM2: 100, depthM: 1.8 },
  reservoir: { flow: 'standing', minAreaM2: 100, depthM: 1.8 },
  pond: { flow: 'standing', minAreaM2: 250, depthM: 1 },
  basin: { flow: 'standing', minAreaM2: 250, depthM: 0.8 },
  other: { flow: 'standing', minAreaM2: 250, depthM: 1 },
  river: { flow: 'flowing', minAreaM2: 0, depthM: 1.5 },
  canal: { flow: 'flowing', minAreaM2: 0, depthM: 1.5 },
};

/**
 * Rivers and canals mapped only as lines are levelled when at least this
 * wide (metres): wide enough to show as a channel on the 2.5 m lattice.
 * Narrower watercourses (streams, drains, ditches) keep the ground as it is.
 */
export const RIVER_MIN_WIDTH_M = 8;
/**
 * The width a river or canal line with no `width` tag is levelled at: the
 * narrowest that qualifies, rather than the importer's display default
 * (12 m for rivers), so an unmeasured river is never cut wider than it is.
 */
export const UNTAGGED_CHANNEL_WIDTH_M = 8;
/** The bed deepens by this much per metre from the shore, to the class's depth. */
export const BED_SLOPE = 0.25;
/**
 * Ground within this of the shore, inside the water, is held at the level
 * (a lattice diagonal: every lattice triangle the shoreline crosses has
 * its corners at or above the level, so no land outside the water is ever
 * lower than the water beside it), metres.
 */
export const SHORE_INSET_M = 2.5 * Math.SQRT2;
/** The ground at the waterline stands this far above the level, metres. */
export const SHORE_FREEBOARD_M = 0.05;
/** Banks are shaped this far from the shore, the last few metres fading out, metres. */
export const BANK_REACH_M = 8;
export const BANK_FADE_M = 3;
/** Banks rise at least this much per metre from the shore (no land below the water beside it). */
export const BANK_MIN_RISE = 0.04;
/** And at most this much per metre: a steep bank comes down to the water, a cliff stays steep. */
export const BANK_MAX_RISE = 1.5;
/** Standing water is not levelled when the ground inside it stands this far above the level, metres. */
export const MAX_INTERIOR_CUT_M = 3;
/** …or its shore lies this far below it (banks would have to be raised over a long stretch), metres. */
export const MAX_BANK_FILL_M = 2.5;
/** The sea is at 0 m unless the data's sea stands higher than this, metres. */
export const SEA_DATUM_TOLERANCE_M = 3;
/** River profiles: sample spacing, spike filter, smoothing and how far a pinned level blends, metres. */
export const PROFILE_STEP_M = 5;
const MEDIAN_HALF = 4;
const SMOOTH_HALF = 6;
const PIN_BLEND_M = 40;
/** A river drawn uphill by more than this (metres, and per metre of its length) is not trusted for direction. */
const UPHILL_TOLERANCE_M = 1.5;
const UPHILL_TOLERANCE = 0.002;
/** A river area with no centreline in it takes the levels of a river this close, metres. */
const SIDE_CHANNEL_M = 150;
/** A waterway end this close to another's centreline joins it, metres. */
const JOIN_M = 1;

/** One water area's grading: its class, and its level when it was levelled. */
export interface WaterBodyLevel {
  /** The `WaterArea` id. */
  readonly id: string;
  readonly waterClass: WaterClass;
  /** `flowing`: the level comes from the river profiles (`WaterSurfaces.rivers`). */
  readonly flow: WaterFlow;
  /** Standing water's level, metres; `null` for flowing water or water not levelled. */
  readonly level: number | null;
  readonly graded: boolean;
  /** Why it was not levelled, or a note on its level (the sea's datum). */
  readonly note?: string;
}

/** A river's or canal's levelled profile. */
export interface RiverProfile {
  /** The id of its first waterway. */
  readonly id: string;
  readonly waterwayIds: readonly string[];
  /** Centreline points every `PROFILE_STEP_M` or so, as x, y pairs, downstream. */
  readonly xy: readonly number[];
  /** The water level at each point, metres. */
  readonly levels: readonly number[];
  /**
   * Half the width levelled where it is mapped only as a line, metres; 0
   * where it runs in a mapped water area (which gives its banks) or is too
   * narrow to level.
   */
  readonly halfWidths: readonly number[];
  /** Whether the profile never rises downstream (false: the mapped direction was not trusted). */
  readonly directed: boolean;
}

/** The levels of a graded terrain's water (docs/adr/0040). */
export interface WaterSurfaces {
  readonly version: number;
  readonly bodies: readonly WaterBodyLevel[];
  readonly rivers: readonly RiverProfile[];
}

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The class of a water area: as imported, else inferred (terrain imported
 * before classes were kept): the sea from its coastline source, a river
 * where a river or canal runs through it, else unspecified standing water.
 * Never from its size.
 */
export function classifyWater(area: WaterArea, waterways: readonly Waterway[]): WaterClass {
  if (area.waterClass) return area.waterClass;
  if (area.source?.ref === 'osm:natural=coastline') return 'sea';
  const contains = polygonTest([area.boundary, ...(area.holes ?? [])]);
  for (const w of waterways) {
    if (w.kind !== 'river' && w.kind !== 'canal') continue;
    let inside = 0;
    for (const p of w.centerline) if (contains(p.x, p.y)) inside += 1;
    if (inside >= 2) return w.kind === 'canal' ? 'canal' : 'river';
  }
  return 'other';
}

/** Even–odd containment in rings (outer then holes), edges bucketed in 8 m bands. */
export function polygonTest(
  rings: readonly (readonly Vec2[])[],
): (x: number, y: number) => boolean {
  let minY = Infinity;
  let maxY = -Infinity;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const p of rings[0] ?? []) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const BAND = 8;
  const bands: number[][] = Array.from(
    { length: Math.max(1, Math.ceil((maxY - minY) / BAND) + 1) },
    () => [],
  );
  for (const ring of rings) {
    ring.forEach((a, i) => {
      const b = ring[(i + 1) % ring.length] ?? a;
      if (a.y === b.y) return;
      const lo = Math.max(0, Math.floor((Math.min(a.y, b.y) - minY) / BAND));
      const hi = Math.min(bands.length - 1, Math.floor((Math.max(a.y, b.y) - minY) / BAND));
      for (let k = lo; k <= hi; k += 1) bands[k]?.push(a.x, a.y, b.x, b.y);
    });
  }
  return (x: number, y: number): boolean => {
    if (x < minX || x > maxX || y < minY || y > maxY) return false;
    const band = bands[Math.floor((y - minY) / BAND)] ?? [];
    let inside = false;
    for (let i = 0; i < band.length; i += 4) {
      const ax = band[i] ?? 0;
      const ay = band[i + 1] ?? 0;
      const bx = band[i + 2] ?? 0;
      const by = band[i + 3] ?? 0;
      if (ay > y !== by > y && ax + ((y - ay) * (bx - ax)) / (by - ay) > x) inside = !inside;
    }
    return inside;
  };
}

/** Parameter of the nearest point found by the last `segmentDistance` call. */
let nearestT = 0;

/** Distance from (x, y) to segment a–b; the nearest point's parameter goes to `nearestT`. */
export function segmentDistance(
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
  nearestT = t;
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

/** The median of some values (sorted copy); NaN for none. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? (s[m] ?? NaN) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const f = q * (sorted.length - 1);
  const i = Math.floor(f);
  const a = sorted[i] ?? 0;
  return a + (f - i) * ((sorted[Math.min(i + 1, sorted.length - 1)] ?? a) - a);
}

/** A bucketed set of segments, for nearest-segment queries. */
class SegmentGrid {
  private readonly buckets = new Map<number, number[]>();
  /** x0, y0, x1, y1, then `extra` values per segment. */
  readonly data: number[] = [];

  private readonly size: number;
  readonly stride: number;

  constructor(size: number, stride: number) {
    this.size = size;
    this.stride = stride;
  }

  add(ax: number, ay: number, bx: number, by: number, extra: readonly number[], reach: number) {
    const s = this.data.length / this.stride;
    this.data.push(ax, ay, bx, by, ...extra);
    const B = this.size;
    for (
      let gx = Math.floor((Math.min(ax, bx) - reach) / B);
      gx <= Math.floor((Math.max(ax, bx) + reach) / B);
      gx += 1
    ) {
      for (
        let gy = Math.floor((Math.min(ay, by) - reach) / B);
        gy <= Math.floor((Math.max(ay, by) + reach) / B);
        gy += 1
      ) {
        const key = gx * 100_003 + gy;
        const list = this.buckets.get(key);
        if (list) list.push(s);
        else this.buckets.set(key, [s]);
      }
    }
  }

  /** Segments listed near (x, y) (within the reach they were added with). */
  near(x: number, y: number): readonly number[] {
    return (
      this.buckets.get(Math.floor(x / this.size) * 100_003 + Math.floor(y / this.size)) ?? EMPTY
    );
  }
}
const EMPTY: readonly number[] = [];

/** A chain of waterways drawn end to start, downstream. */
interface Chain {
  readonly ids: string[];
  readonly kind: Waterway['kind'];
  readonly pts: Vec2[];
  /** Levelled channel width of each point's following segment (0: not a channel). */
  readonly widths: number[];
  readonly width: number;
}

const key = (p: Vec2) => `${String(Math.round(p.x * 1000))},${String(Math.round(p.y * 1000))}`;

/** The levelled width of a waterway mapped as a line, or 0 when it is not levelled as a channel. */
export function channelWidth(w: Waterway): number {
  const untagged = w.source?.estimated?.includes('widthMeters') ?? false;
  const width = untagged
    ? w.kind === 'river' || w.kind === 'canal'
      ? UNTAGGED_CHANNEL_WIDTH_M
      : 0
    : w.widthMeters;
  return width >= RIVER_MIN_WIDTH_M ? width : 0;
}

/** The waterways that carry a river profile: rivers and canals, and anything wide enough to level. */
function profiled(w: Waterway): boolean {
  return w.kind === 'river' || w.kind === 'canal' || channelWidth(w) > 0;
}

/** Waterways joined end to start where exactly one ends and one starts (the way they flow). */
function waterwayChains(waterways: readonly Waterway[]): Chain[] {
  const ways = waterways.filter(profiled).sort(byId);
  const starts = new Map<string, number[]>();
  const ends = new Map<string, number[]>();
  ways.forEach((w, i) => {
    const a = w.centerline[0];
    const b = w.centerline[w.centerline.length - 1];
    if (!a || !b) return;
    starts.set(key(a), [...(starts.get(key(a)) ?? []), i]);
    ends.set(key(b), [...(ends.get(key(b)) ?? []), i]);
  });
  const next = (i: number): number | null => {
    const w = ways[i];
    const b = w?.centerline[w.centerline.length - 1];
    if (!w || !b) return null;
    const s = starts.get(key(b)) ?? [];
    const e = ends.get(key(b)) ?? [];
    const j = s[0];
    return s.length === 1 && e.length === 1 && j !== undefined && j !== i ? j : null;
  };
  const prev = new Map<number, number>();
  ways.forEach((_, i) => {
    const j = next(i);
    if (j !== null) prev.set(j, i);
  });
  const used = new Uint8Array(ways.length);
  const chains: Chain[] = [];
  const build = (head: number) => {
    const ids: string[] = [];
    const pts: Vec2[] = [];
    const widths: number[] = [];
    let width = 0;
    let i: number | null = head;
    while (i !== null && !used[i]) {
      used[i] = 1;
      const w: Waterway | undefined = ways[i];
      if (!w) break;
      ids.push(w.id);
      const cw = channelWidth(w);
      width = Math.max(width, cw > 0 ? cw : w.widthMeters);
      w.centerline.forEach((p, k) => {
        if (k === 0 && pts.length > 0) return;
        if (pts.length > 0) widths.push(cw);
        pts.push(p);
      });
      i = next(i);
    }
    if (pts.length >= 2) {
      chains.push({ ids, kind: ways[head]?.kind ?? 'river', pts, widths, width });
    }
  };
  // Heads first (nothing flows into them), then whatever is left (loops).
  ways.forEach((_, i) => {
    if (!prev.has(i)) build(i);
  });
  ways.forEach((_, i) => {
    if (!used[i]) build(i);
  });
  return chains;
}

/** Points along a chain every `PROFILE_STEP_M` or so, each with its segment's channel width. */
function densify(chain: Chain): { pts: Vec2[]; widths: number[] } {
  const pts: Vec2[] = [];
  const widths: number[] = [];
  for (let i = 0; i + 1 < chain.pts.length; i += 1) {
    const a = chain.pts[i];
    const b = chain.pts[i + 1];
    if (!a || !b) continue;
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / PROFILE_STEP_M));
    for (let k = 0; k < n; k += 1) {
      pts.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
      widths.push(chain.widths[i] ?? 0);
    }
  }
  const last = chain.pts[chain.pts.length - 1];
  if (last) {
    pts.push(last);
    widths.push(chain.widths[chain.widths.length - 1] ?? 0);
  }
  return { pts, widths };
}

/** Weighted isotonic regression, never increasing (pool adjacent violators). */
export function nonIncreasingFit(values: readonly number[], weights: readonly number[]): number[] {
  const level: number[] = [];
  const weight: number[] = [];
  const count: number[] = [];
  values.forEach((v, i) => {
    level.push(v);
    weight.push(weights[i] ?? 1);
    count.push(1);
    while (level.length > 1 && (level[level.length - 2] ?? 0) < (level[level.length - 1] ?? 0)) {
      const w2 = weight.pop() ?? 0;
      const l2 = level.pop() ?? 0;
      const c2 = count.pop() ?? 0;
      const w1 = weight[weight.length - 1] ?? 0;
      const l1 = level[level.length - 1] ?? 0;
      level[level.length - 1] = (l1 * w1 + l2 * w2) / (w1 + w2);
      weight[weight.length - 1] = w1 + w2;
      count[count.length - 1] = (count[count.length - 1] ?? 0) + c2;
    }
  });
  const out: number[] = [];
  level.forEach((l, b) => {
    for (let k = 0; k < (count[b] ?? 0); k += 1) out.push(l);
  });
  return out;
}

/**
 * A river's levels from the ground along it (`raw`, downstream) and the
 * levels it must meet (`pins`, by sample): spikes filtered (moving median),
 * fitted never to rise downstream when `directed`, smoothed, brought to the
 * pins, and (directed) never rising again.
 */
export function riverLevels(
  raw: readonly number[],
  pins: ReadonlyMap<number, number>,
  directed: boolean,
): number[] {
  const n = raw.length;
  const base = raw.map((v, i) => pins.get(i) ?? v);
  const med = base.map((_, i) => {
    if (pins.has(i)) return base[i] ?? 0;
    const w: number[] = [];
    for (let k = Math.max(0, i - MEDIAN_HALF); k <= Math.min(n - 1, i + MEDIAN_HALF); k += 1) {
      w.push(base[k] ?? 0);
    }
    return median(w);
  });
  const fitted = directed
    ? nonIncreasingFit(
        med,
        med.map((_, i) => (pins.has(i) ? 1e6 : 1)),
      )
    : med;
  const prefix = [0];
  for (const v of fitted) prefix.push((prefix[prefix.length - 1] ?? 0) + v);
  const smooth = fitted.map((_, i) => {
    // A window symmetric about the sample, shrinking at the ends, so the ends are not pulled.
    const h = Math.min(SMOOTH_HALF, i, n - 1 - i);
    return ((prefix[i + h + 1] ?? 0) - (prefix[i - h] ?? 0)) / (2 * h + 1);
  });
  // Pins exact: corrections linear between pinned samples, fading beyond the outermost.
  const pinned = [...pins.keys()].sort((a, b) => a - b);
  const fadeSamples = PIN_BLEND_M / PROFILE_STEP_M;
  const delta = (i: number) => (pins.get(i) ?? 0) - (smooth[i] ?? 0);
  const out = smooth.map((v, i) => {
    const first = pinned[0];
    const last = pinned[pinned.length - 1];
    if (first === undefined || last === undefined) return v;
    if (i <= first) return v + delta(first) * Math.max(0, 1 - (first - i) / fadeSamples);
    if (i >= last) return v + delta(last) * Math.max(0, 1 - (i - last) / fadeSamples);
    let k = 1;
    while ((pinned[k] ?? Infinity) < i) k += 1;
    const p = pinned[k - 1] ?? first;
    const q = pinned[k] ?? last;
    const t = q > p ? (i - p) / (q - p) : 0;
    return v + delta(p) + t * (delta(q) - delta(p));
  });
  if (directed) for (let i = 1; i < n; i += 1) out[i] = Math.min(out[i] ?? 0, out[i - 1] ?? 0);
  return out;
}

/** The ground along the shores of a polygon, and inside it, for its level. */
interface Shore {
  /** Shore edges as x0, y0, x1, y1 (map-edge and shared edges left out). */
  readonly edges: number[];
}

/**
 * The water levels of a cleaned source terrain (before grading): which water
 * is levelled, at what level, and the river profiles. Pure and deterministic.
 */
export function waterLevels(source: TerrainDataset): WaterSurfaces {
  const { originX, originY, cellSize, columns, rows } = source.heightfield;
  const maxX = originX + (columns - 1) * cellSize;
  const maxY = originY + (rows - 1) * cellSize;
  const onMap = (x: number, y: number) => x >= originX && x <= maxX && y >= originY && y <= maxY;
  const ground = (x: number, y: number) =>
    heightAt(source, Math.min(Math.max(x, originX), maxX), Math.min(Math.max(y, originY), maxY));
  const { water = [], waterways = [] } = source.features;
  const areas = water.filter((w) => w.kind === 'water').sort(byId);
  const classes = areas.map((a) => classifyWater(a, waterways));
  const tests = areas.map((a) => polygonTest([a.boundary, ...(a.holes ?? [])]));
  const boxes = areas.map((a) => {
    const xs = a.boundary.map((p) => p.x);
    const ys = a.boundary.map((p) => p.y);
    return {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    };
  });
  const inArea = (x: number, y: number, except: number) =>
    areas.some(
      (_, j) =>
        j !== except &&
        x >= (boxes[j]?.minX ?? 0) &&
        x <= (boxes[j]?.maxX ?? 0) &&
        y >= (boxes[j]?.minY ?? 0) &&
        y <= (boxes[j]?.maxY ?? 0) &&
        (tests[j]?.(x, y) ?? false),
    );

  // --- Standing water ------------------------------------------------------------------------
  const shores: Shore[] = areas.map((a, i) => shoreEdges(a, i, tests[i], inArea, onMap));
  const levels: (number | null)[] = [];
  const notes: (string | undefined)[] = [];
  const flows: WaterFlow[] = [];
  areas.forEach((a, i) => {
    const cls = classes[i] ?? 'other';
    const rule = WATER_RULES[cls];
    flows.push(rule.flow);
    levels.push(null);
    notes.push(undefined);
    if (rule.flow === 'flowing') return;
    const area = polygonArea(a.boundary) - (a.holes ?? []).reduce((s, h) => s + polygonArea(h), 0);
    if (area < rule.minAreaM2) {
      notes[i] = `smaller than ${String(rule.minAreaM2)} m²`;
      return;
    }
    const edges = shores[i]?.edges ?? [];
    const shore: number[] = [];
    for (let k = 0; k < edges.length; k += 4) {
      const ax = edges[k] ?? 0;
      const ay = edges[k + 1] ?? 0;
      const bx = edges[k + 2] ?? 0;
      const by = edges[k + 3] ?? 0;
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 2.5));
      for (let m = 0; m < n; m += 1) {
        shore.push(ground(ax + ((bx - ax) * m) / n, ay + ((by - ay) * m) / n));
      }
    }
    if (cls === 'sea') {
      // The elevation data's datum is mean sea level, so the sea is at 0 m.
      // Checked against the data's own sea (its shore mixes in beaches and
      // cliffs, so it is not the test): offshore, the data is the sea floor
      // or a flat 0 m. Only if it stands well above 0 m is the datum
      // something else, and the sea is levelled where the data has it.
      const offshore = interiorSamples(tests[i], boxes[i], onMap, ground);
      const m = median(offshore);
      if (Number.isFinite(m) && m > SEA_DATUM_TOLERANCE_M) {
        levels[i] = Math.round(m * 100) / 100;
        notes[i] =
          `the sea in the elevation data stands at ${m.toFixed(1)} m, not 0 m or below: it is levelled there`;
      } else {
        levels[i] = 0;
      }
      return;
    }
    if (shore.length < 3) {
      notes[i] = 'no shoreline on the battlefield';
      return;
    }
    const level = median(shore);
    const inside = interiorSamples(tests[i], boxes[i], onMap, ground);
    const sortedIn = [...inside].sort((p, q) => p - q);
    const sortedShore = [...shore].sort((p, q) => p - q);
    const cut = quantile(sortedIn, 0.9) - level;
    const fill = level - quantile(sortedShore, 0.2);
    if (cut > MAX_INTERIOR_CUT_M) {
      notes[i] = `the ground inside stands up to ${cut.toFixed(1)} m above the shoreline level`;
      return;
    }
    if (fill > MAX_BANK_FILL_M) {
      notes[i] = `a fifth of the shore lies ${fill.toFixed(1)} m or more below the shoreline level`;
      return;
    }
    levels[i] = level;
  });

  // --- Rivers --------------------------------------------------------------------------------
  const chains = waterwayChains(waterways);
  // Main rivers first: wider, then longer, then by id.
  const length = (c: Chain) =>
    c.pts.reduce(
      (s, p, k) =>
        k === 0
          ? 0
          : s + Math.hypot(p.x - (c.pts[k - 1]?.x ?? p.x), p.y - (c.pts[k - 1]?.y ?? p.y)),
      0,
    );
  const order = chains
    .map((c, i) => ({ c, i, len: length(c) }))
    .sort(
      (p, q) =>
        q.c.width - p.c.width ||
        q.len - p.len ||
        ((p.c.ids[0] ?? '') < (q.c.ids[0] ?? '') ? -1 : 1),
    );
  const standingAt = (x: number, y: number): number | null => {
    for (let j = 0; j < areas.length; j += 1) {
      const lv = levels[j];
      if (lv === null || lv === undefined) continue;
      const b = boxes[j];
      if (!b || x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) continue;
      if (tests[j]?.(x, y)) return lv;
    }
    return null;
  };
  const done: { xy: number[]; levels: number[] }[] = [];
  const rivers: RiverProfile[] = [];
  for (const { c } of order) {
    const { pts, widths } = densify(c);
    const raw = pts.map((p) => ground(p.x, p.y));
    const pins = new Map<number, number>();
    pts.forEach((p, k) => {
      const lv = standingAt(p.x, p.y);
      if (lv !== null) pins.set(k, lv);
    });
    // Its ends meet a river already levelled: a tributary meets the river it joins.
    for (const k of [0, pts.length - 1]) {
      const p = pts[k];
      if (!p || pins.has(k)) continue;
      const lv = levelOnProfiles(done, p.x, p.y, JOIN_M);
      if (lv !== null) pins.set(k, lv);
    }
    const len = length(c);
    const first = median(raw.slice(0, Math.min(raw.length, 2 * MEDIAN_HALF + 1)));
    const last = median(raw.slice(Math.max(0, raw.length - 2 * MEDIAN_HALF - 1)));
    const directed = last - first <= Math.max(UPHILL_TOLERANCE_M, UPHILL_TOLERANCE * len);
    const lv = riverLevels(raw, pins, directed);
    const xy: number[] = [];
    pts.forEach((p) => xy.push(p.x, p.y));
    // A channel is levelled where the river is mapped only as a line.
    const halfWidths = pts.map((p, k) =>
      (widths[k] ?? 0) > 0 && !inArea(p.x, p.y, -1) ? (widths[k] ?? 0) / 2 : 0,
    );
    const profile = {
      id: c.ids[0] ?? '',
      waterwayIds: c.ids,
      xy,
      levels: lv,
      halfWidths,
      directed,
    };
    rivers.push(profile);
    done.push(profile);
  }
  rivers.sort(byId);

  // Flowing water areas take their levels from the rivers in them; one with
  // none is levelled as standing water.
  const bodies: WaterBodyLevel[] = areas.map((a, i) => {
    const cls = classes[i] ?? 'other';
    if (flows[i] === 'flowing') {
      // A river runs in it, or close by (a side channel, a piece of a river
      // mapped in parts): its levels are that river's.
      const test = tests[i];
      const b = boxes[i];
      const has = rivers.some((r) => {
        for (let k = 0; k < r.xy.length; k += 2) {
          const x = r.xy[k] ?? 0;
          const y = r.xy[k + 1] ?? 0;
          if (test?.(x, y)) return true;
          if (
            b &&
            x > b.minX - SIDE_CHANNEL_M &&
            x < b.maxX + SIDE_CHANNEL_M &&
            y > b.minY - SIDE_CHANNEL_M &&
            y < b.maxY + SIDE_CHANNEL_M &&
            a.boundary.some((p) => Math.hypot(p.x - x, p.y - y) < SIDE_CHANNEL_M)
          ) {
            return true;
          }
        }
        return false;
      });
      if (has) return { id: a.id, waterClass: cls, flow: 'flowing', level: null, graded: true };
    }
    const level = levels[i] ?? null;
    const note = notes[i];
    return {
      id: a.id,
      waterClass: cls,
      flow: 'standing',
      level,
      graded: level !== null,
      ...(note ? { note } : {}),
    };
  });
  // A flowing area with no river in it: its shoreline median, as for standing water.
  const fixed = bodies.map((b, i) => {
    if (b.flow === 'flowing' || b.graded || flows[i] !== 'flowing') return b;
    const a = areas[i];
    if (!a) return b;
    const edges = shores[i]?.edges ?? [];
    const shore: number[] = [];
    for (let k = 0; k < edges.length; k += 4) shore.push(ground(edges[k] ?? 0, edges[k + 1] ?? 0));
    const level = median(shore);
    return Number.isFinite(level)
      ? { ...b, level, graded: true, note: 'no river near it: levelled as standing water' }
      : b;
  });
  return { version: WATER_GRADING_VERSION, bodies: fixed, rivers };
}

/** The level on already levelled profiles within `reach` of (x, y), or `null`. */
function levelOnProfiles(
  profiles: readonly { xy: readonly number[]; levels: readonly number[] }[],
  x: number,
  y: number,
  reach: number,
): number | null {
  let best = reach;
  let level: number | null = null;
  for (const p of profiles) {
    for (let k = 0; k + 3 < p.xy.length; k += 2) {
      const d = segmentDistance(
        x,
        y,
        p.xy[k] ?? 0,
        p.xy[k + 1] ?? 0,
        p.xy[k + 2] ?? 0,
        p.xy[k + 3] ?? 0,
      );
      if (d <= best) {
        best = d;
        const a = p.levels[k / 2] ?? 0;
        level = a + nearestT * ((p.levels[k / 2 + 1] ?? a) - a);
      }
    }
  }
  return level;
}

/**
 * A water area's shore: its edges (outline and islands), less those on the
 * battlefield's edge (the water goes on beyond it) and those shared with
 * other water (two river areas meeting across a river, a river entering a
 * lake), where there is water on both sides.
 */
function shoreEdges(
  area: WaterArea,
  self: number,
  test: ((x: number, y: number) => boolean) | undefined,
  inArea: (x: number, y: number, except: number) => boolean,
  onMap: (x: number, y: number) => boolean,
): Shore {
  const edges: number[] = [];
  for (const ring of [area.boundary, ...(area.holes ?? [])]) {
    ring.forEach((a, i) => {
      const b = ring[(i + 1) % ring.length] ?? a;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len === 0) return;
      const nx = -(b.y - a.y) / len;
      const ny = (b.x - a.x) / len;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      // The land side: whichever side of the edge is not in this water.
      const p = { x: mx + 0.5 * nx, y: my + 0.5 * ny };
      const q = { x: mx - 0.5 * nx, y: my - 0.5 * ny };
      const pIn = test?.(p.x, p.y) ?? false;
      const land = pIn ? q : p;
      if (!onMap(land.x, land.y)) return;
      if (inArea(land.x, land.y, self)) return;
      edges.push(a.x, a.y, b.x, b.y);
    });
  }
  return { edges };
}

/** The ground at points inside a water area (at most about 20,000, evenly spread). */
function interiorSamples(
  test: ((x: number, y: number) => boolean) | undefined,
  box: { minX: number; maxX: number; minY: number; maxY: number } | undefined,
  onMap: (x: number, y: number) => boolean,
  ground: (x: number, y: number) => number,
): number[] {
  if (!box || !test) return [];
  const step = Math.max(5, Math.sqrt(((box.maxX - box.minX) * (box.maxY - box.minY)) / 20_000));
  const out: number[] = [];
  for (let y = box.minY + step / 2; y < box.maxY; y += step) {
    for (let x = box.minX + step / 2; x < box.maxX; x += step) {
      if (onMap(x, y) && test(x, y)) out.push(ground(x, y));
    }
  }
  return out;
}

// --- Queries ---------------------------------------------------------------------------------

/** What the water does at a point: the water or bank it is in, the level and the distance to the shore. */
export interface WaterAt {
  /** In levelled water (an area or a river channel). */
  readonly inWater: boolean;
  /** Distance to the nearest shore, metres (capped at the query's reach). */
  readonly shoreDistance: number;
  /** The level of that water, metres. */
  readonly level: number;
  /** Its bed's depth away from the shore, metres. */
  readonly depth: number;
  readonly waterClass: WaterClass;
}

export interface WaterQuery {
  /**
   * The levelled water at or near (x, y): in it, or on its bank within
   * `reach` of its shore; `null` elsewhere.
   */
  at(x: number, y: number): WaterAt | null;
  /** The level of the levelled water at (x, y), or `null` where there is none. */
  levelAt(x: number, y: number): number | null;
  /**
   * The level of water area `id` at (x, y), wherever the point is (its edge
   * included), or `null` when that area is not levelled.
   */
  bodyLevel(id: string, x: number, y: number): number | null;
  /** The class a levelled water area was graded as, or `null`. */
  bodyClass(id: string): WaterClass | null;
  /** The furthest `at` looks for a shore, metres. */
  readonly reach: number;
  /** Whether any water is levelled. */
  readonly any: boolean;
}

/** Shores within this of a point are found by `at`, metres. */
export const WATER_QUERY_REACH_M = 24;

const BUCKET_M = 25;
/** River levels away from a channel use every this many profile points (about 20 m). */
const LEVEL_STRIDE = 4;

/**
 * Queries on a terrain's levelled water (its features and `WaterSurfaces`).
 * Built once per terrain and surfaces; deterministic.
 */
export function waterQuery(
  features: TerrainDataset['features'],
  surfaces: WaterSurfaces,
  bounds: { originX: number; originY: number; maxX: number; maxY: number },
  reach = WATER_QUERY_REACH_M,
): WaterQuery {
  const onMap = (x: number, y: number) =>
    x >= bounds.originX && x <= bounds.maxX && y >= bounds.originY && y <= bounds.maxY;
  const graded = new Map(surfaces.bodies.filter((b) => b.graded).map((b) => [b.id, b]));
  const areas = (features.water ?? [])
    .filter((w) => w.kind === 'water' && graded.has(w.id))
    .sort(byId);
  const bodies = areas.map((a) => {
    const b = graded.get(a.id);
    const xs = a.boundary.map((p) => p.x);
    const ys = a.boundary.map((p) => p.y);
    return {
      area: a,
      level: b?.flow === 'standing' ? (b.level ?? 0) : null,
      cls: b?.waterClass ?? 'other',
      test: polygonTest([a.boundary, ...(a.holes ?? [])]),
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    };
  });
  // Bodies by bucket (of their boxes), so containment tests only the few near a point.
  const BODY_BUCKET = 200;
  const bodyBuckets = new Map<number, number[]>();
  bodies.forEach((b, i) => {
    for (
      let gx = Math.floor(b.minX / BODY_BUCKET);
      gx <= Math.floor(b.maxX / BODY_BUCKET);
      gx += 1
    ) {
      for (
        let gy = Math.floor(b.minY / BODY_BUCKET);
        gy <= Math.floor(b.maxY / BODY_BUCKET);
        gy += 1
      ) {
        const k = gx * 100_003 + gy;
        bodyBuckets.set(k, [...(bodyBuckets.get(k) ?? []), i]);
      }
    }
  });
  const bodyAt = (x: number, y: number): number => {
    for (const i of bodyBuckets.get(
      Math.floor(x / BODY_BUCKET) * 100_003 + Math.floor(y / BODY_BUCKET),
    ) ?? []) {
      const b = bodies[i];
      if (b && x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && b.test(x, y)) return i;
    }
    return -1;
  };
  const inAnyArea = (x: number, y: number, except: number) => {
    for (const i of bodyBuckets.get(
      Math.floor(x / BODY_BUCKET) * 100_003 + Math.floor(y / BODY_BUCKET),
    ) ?? []) {
      const b = bodies[i];
      if (i !== except && b?.test(x, y)) return true;
    }
    return false;
  };

  // River centrelines: every segment, with its levels and channel half-width.
  const rivers = [...surfaces.rivers].sort(byId);
  // x0 y0 x1 y1, level0, level1, halfWidth.
  const centre = new SegmentGrid(BUCKET_M, 7);
  const allCentre: number[] = [];
  for (const r of rivers) {
    for (let k = 0; k + 3 < r.xy.length; k += 2) {
      const i = k / 2;
      const seg = [
        r.xy[k] ?? 0,
        r.xy[k + 1] ?? 0,
        r.xy[k + 2] ?? 0,
        r.xy[k + 3] ?? 0,
        r.levels[i] ?? 0,
        r.levels[i + 1] ?? 0,
        r.halfWidths[i] ?? 0,
      ];
      const hw = seg[6] ?? 0;
      if (hw > 0) {
        centre.add(seg[0] ?? 0, seg[1] ?? 0, seg[2] ?? 0, seg[3] ?? 0, seg.slice(4), hw + reach);
      }
    }
  }
  // Levels away from a channel come from the profiles every `LEVEL_STRIDE`
  // points (levels change slowly along a river): fewer, longer segments.
  for (const r of rivers) {
    const n = r.levels.length;
    for (let i = 0; i + 1 < n; i += LEVEL_STRIDE) {
      const j = Math.min(i + LEVEL_STRIDE, n - 1);
      allCentre.push(
        r.xy[2 * i] ?? 0,
        r.xy[2 * i + 1] ?? 0,
        r.xy[2 * j] ?? 0,
        r.xy[2 * j + 1] ?? 0,
        r.levels[i] ?? 0,
        r.levels[j] ?? 0,
        0,
      );
    }
  }
  // Nearest centreline for the level of any point: candidates cached per 40 m bucket.
  const LEVEL_BUCKET = 40;
  const levelCandidates = new Map<number, number[]>();
  const candidatesFor = (gx: number, gy: number): number[] => {
    const k = gx * 100_003 + gy;
    let list = levelCandidates.get(k);
    if (list) return list;
    const cx = (gx + 0.5) * LEVEL_BUCKET;
    const cy = (gy + 0.5) * LEVEL_BUCKET;
    const n = allCentre.length / 7;
    const dist = new Float64Array(n);
    let best = Infinity;
    for (let s = 0; s < n; s += 1) {
      const o = s * 7;
      const d = segmentDistance(
        cx,
        cy,
        allCentre[o] ?? 0,
        allCentre[o + 1] ?? 0,
        allCentre[o + 2] ?? 0,
        allCentre[o + 3] ?? 0,
      );
      dist[s] = d;
      best = Math.min(best, d);
    }
    // Any point of the bucket is within a half-diagonal of its centre.
    const limit = best + LEVEL_BUCKET * Math.SQRT2;
    list = [];
    for (let s = 0; s < n; s += 1) if ((dist[s] ?? Infinity) <= limit) list.push(s);
    levelCandidates.set(k, list);
    return list;
  };
  const riverLevelAt = (x: number, y: number): number | null => {
    if (allCentre.length === 0) return null;
    let best = Infinity;
    let level = 0;
    for (const s of candidatesFor(Math.floor(x / LEVEL_BUCKET), Math.floor(y / LEVEL_BUCKET))) {
      const o = s * 7;
      const d = segmentDistance(
        x,
        y,
        allCentre[o] ?? 0,
        allCentre[o + 1] ?? 0,
        allCentre[o + 2] ?? 0,
        allCentre[o + 3] ?? 0,
      );
      if (d < best) {
        best = d;
        const a = allCentre[o + 4] ?? 0;
        level = a + nearestT * ((allCentre[o + 5] ?? a) - a);
      }
    }
    return level;
  };

  // Shore segments of levelled areas, and their area.
  const shore = new SegmentGrid(BUCKET_M, 5);
  bodies.forEach((b, i) => {
    const edges = shoreEdges(b.area, i, b.test, inAnyArea, onMap).edges;
    for (let k = 0; k < edges.length; k += 4) {
      shore.add(edges[k] ?? 0, edges[k + 1] ?? 0, edges[k + 2] ?? 0, edges[k + 3] ?? 0, [i], reach);
    }
  });

  const levelOf = (i: number, x: number, y: number): number => {
    const b = bodies[i];
    if (!b) return 0;
    return b.level ?? riverLevelAt(x, y) ?? 0;
  };
  const depthOf = (cls: WaterClass) => WATER_RULES[cls].depthM;

  const at = (x: number, y: number): WaterAt | null => {
    const inBody = bodyAt(x, y);
    // The nearest channel (a river mapped as a line), its distance from the centreline.
    let channelD = Infinity;
    let channelHalf = 0;
    let channelLevel = 0;
    const cdata = centre.data;
    for (const s of centre.near(x, y)) {
      const o = s * 7;
      const half = cdata[o + 6] ?? 0;
      const d = segmentDistance(
        x,
        y,
        cdata[o] ?? 0,
        cdata[o + 1] ?? 0,
        cdata[o + 2] ?? 0,
        cdata[o + 3] ?? 0,
      );
      // The channel whose bank is nearest (or that holds the point most deeply).
      if (d - half < channelD - channelHalf) {
        channelD = d;
        channelHalf = half;
        const a = cdata[o + 4] ?? 0;
        channelLevel = a + nearestT * ((cdata[o + 5] ?? a) - a);
      }
    }
    const inChannel = inBody < 0 && channelD < channelHalf;
    // The nearest shore of an area.
    let shoreD = Infinity;
    let shoreBody = -1;
    const sdata = shore.data;
    for (const s of shore.near(x, y)) {
      const o = s * 5;
      const d = segmentDistance(
        x,
        y,
        sdata[o] ?? 0,
        sdata[o + 1] ?? 0,
        sdata[o + 2] ?? 0,
        sdata[o + 3] ?? 0,
      );
      if (d < shoreD) {
        shoreD = d;
        shoreBody = sdata[o + 4] ?? -1;
      }
    }
    if (inBody >= 0) {
      const b = bodies[inBody];
      return {
        inWater: true,
        shoreDistance: Math.min(shoreD, reach),
        level: levelOf(inBody, x, y),
        depth: depthOf(b?.cls ?? 'other'),
        waterClass: b?.cls ?? 'other',
      };
    }
    if (inChannel) {
      return {
        inWater: true,
        shoreDistance: Math.min(channelHalf - channelD, shoreD, reach),
        level: channelLevel,
        depth: Math.min(WATER_RULES.river.depthM, 0.15 * 2 * channelHalf),
        waterClass: 'river',
      };
    }
    // On land: the nearest water's bank.
    const bankChannel = channelHalf > 0 ? channelD - channelHalf : Infinity;
    if (shoreD >= reach && bankChannel >= reach) return null;
    if (shoreD <= bankChannel) {
      const b = bodies[shoreBody];
      return {
        inWater: false,
        shoreDistance: shoreD,
        level: levelOf(shoreBody, x, y),
        depth: depthOf(b?.cls ?? 'other'),
        waterClass: b?.cls ?? 'other',
      };
    }
    return {
      inWater: false,
      shoreDistance: bankChannel,
      level: channelLevel,
      depth: Math.min(WATER_RULES.river.depthM, 0.3 * channelHalf),
      waterClass: 'river',
    };
  };

  const index = new Map(bodies.map((b, i) => [b.area.id, i]));
  return {
    at,
    bodyLevel(id, x, y) {
      const i = index.get(id);
      return i === undefined ? null : levelOf(i, x, y);
    },
    bodyClass(id) {
      const i = index.get(id);
      return i === undefined ? null : (bodies[i]?.cls ?? null);
    },
    levelAt(x, y) {
      const i = bodyAt(x, y);
      if (i >= 0) return levelOf(i, x, y);
      const w = at(x, y);
      return w?.inWater ? w.level : null;
    },
    reach,
    any: bodies.length > 0 || centre.data.length > 0,
  };
}

const queries = new WeakMap<TerrainDataset, WaterQuery | null>();

/** The query on a graded terrain's levelled water, or `null` when it has none (cached per terrain). */
export function terrainWaterQuery(terrain: TerrainDataset): WaterQuery | null {
  if (queries.has(terrain)) return queries.get(terrain) ?? null;
  const surfaces = terrain.grading?.water;
  const { originX, originY, cellSize, columns, rows } = terrain.heightfield;
  const q = surfaces
    ? waterQuery(terrain.features, surfaces, {
        originX,
        originY,
        maxX: originX + (columns - 1) * cellSize,
        maxY: originY + (rows - 1) * cellSize,
      })
    : null;
  queries.set(terrain, q?.any ? q : null);
  return q?.any ? q : null;
}

/**
 * The water level at (x, y) on a graded terrain (docs/adr/0040): the level of
 * the levelled water there, or `null` where there is none (dry land, water
 * too small to level, or a terrain graded before water was levelled).
 */
export function waterLevelAt(terrain: TerrainDataset, x: number, y: number): number | null {
  return terrainWaterQuery(terrain)?.levelAt(x, y) ?? null;
}
