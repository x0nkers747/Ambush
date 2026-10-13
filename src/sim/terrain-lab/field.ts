import type { EnvironmentFeatures, WaterClass } from '../environment';
import type { Heightfield } from '../terrain';
import { waterQuery, type WaterQuery, type WaterSurfaces } from '../water-grading';
import { baseSurface, type BaseSurface } from './base';
import { padDistance, padEffect, padStamps, type PadStamp } from './buildings';
import { channelEffect, channelLevelAt, channelStamps, type ChannelStamp } from './channels';
import { coverLookAt, coverMap, RELIEF_WAVELENGTHS, type CoverMap } from './landcover';
import { gradientNoise, smax, smin } from './noise';
import {
  levelAt,
  roadEffect,
  RoadSurface,
  roadStamps,
  type RoadEffect,
  type RoadStamp,
} from './roads';

// The terrain field (research §5.3): a pure function from the battlefield's
// cleaned DEM, its features, the water levels and a spec to a height and a
// material description at any (x, y). Composition:
//
//   ground = base (smooth DEM) + relief (seeded, by land cover)
//   then each constraint (road, pad, water, channel) clamps it into its band
//   [lo, hi] with a smooth clamp, weighted by its fade, lowest priority first,
//   so the highest wins where bands conflict and the result stays continuous.
//   Cores (carriageway, pad, water bed) are exact bands.
//
// Arithmetic is + − × ÷, sqrt, floor and integer hashing only, in a fixed
// order, so the result is the same in every engine (§5.2 rule 5).

/** Bump when anything here changes what the field gives. */
export const TERRAIN_FIELD_VERSION = 4;

export interface FieldSpec {
  readonly seed: number;
  /** Multiplies every relief amplitude (0 turns relief off). */
  readonly relief: number;
}

export const DEFAULT_FIELD_SPEC: FieldSpec = { seed: 1, relief: 1 };

export interface FieldInput {
  /** The cleaned DEM (docs/adr/0033): not graded. */
  readonly heightfield: Heightfield;
  readonly features: EnvironmentFeatures;
  /** The water levels (docs/adr/0040), from `waterLevels` of the cleaned terrain. */
  readonly water: WaterSurfaces | null;
}

/** Everything the ground's materials need at a point. */
export interface FieldSample {
  h: number;
  /** Signed distance to the nearest carriageway edge (negative on it), metres; 99 when none near. */
  roadEdge: number;
  roadSurface: RoadSurface;
  /** Signed distance to the nearest shore (negative in water), metres; 99 when none near. */
  shore: number;
  /** 0 none, 1 sand or shingle (lakes, the sea), 2 mud (rivers, ponds, streams). */
  shoreKind: number;
  /** Distance to the nearest building's wall, metres (99 when none near; 0 inside). */
  building: number;
  grass: number;
  soil: number;
  litter: number;
  /** 0–1: damp ground (ditches, banks). */
  wet: number;
  /** 0–1: built-up land. */
  urban: number;
}

export function emptySample(): FieldSample {
  return {
    h: 0,
    roadEdge: 99,
    roadSurface: RoadSurface.None,
    shore: 99,
    shoreKind: 0,
    building: 99,
    grass: 1,
    soil: 0,
    litter: 0,
    wet: 0,
    urban: 0,
  };
}

export interface FieldStats {
  readonly roads: number;
  readonly bridges: number;
  readonly pads: number;
  readonly channels: number;
  readonly buckets: number;
  readonly bucketEntries: number;
  readonly compileMs: Readonly<Record<string, number>>;
}

export interface TerrainField {
  readonly spec: FieldSpec;
  readonly bounds: {
    readonly minX: number;
    readonly minY: number;
    readonly maxX: number;
    readonly maxY: number;
  };
  /** Height at (x, y); outside the battlefield, at its nearest edge. */
  height(x: number, y: number): number;
  /** Height and material at (x, y), into `out`. */
  sample(x: number, y: number, out: FieldSample): void;
  readonly roads: readonly RoadStamp[];
  readonly pads: readonly PadStamp[];
  readonly channels: readonly ChannelStamp[];
  readonly water: WaterQuery | null;
  readonly cover: CoverMap;
  readonly base: BaseSurface;
  readonly stats: FieldStats;
}

const BUCKET_M = 32;
/** Most constraints applied at one point (more are ignored: never reached in practice). */
const MAX_CONSTRAINTS = 64;
/** Width of the smooth clamp's rounding, metres. */
const ROUND_M = 0.3;
/**
 * Constraint priorities, applied lowest first: a band applied later wins
 * where bands conflict. A road's or pad's side slopes hold against a bank's
 * cut (a stream beside a track leaves the track its slope, not a cliff);
 * cores are exact and last.
 */
const PRI = {
  waterBank: 1,
  channelBank: 1,
  padSlope: 2,
  roadSlope: 3,
  padCore: 12,
  waterBed: 13,
  channelBed: 13,
  roadCore: 14,
} as const;

/** Sand or shingle shores for these; mud for the rest. */
const SANDY: ReadonlySet<WaterClass> = new Set<WaterClass>(['lake', 'sea', 'reservoir']);
const SEEDS = [0x51ed, 0xa3b1, 0x7c4f, 0x1d29, 0x9e01];

/** A clock for the compile timings in `stats` (the caller's; the field never reads one itself). */
export type Clock = () => number;

export function compileField(
  input: FieldInput,
  spec: FieldSpec = DEFAULT_FIELD_SPEC,
  now: Clock = () => 0,
): TerrainField {
  const ms: Record<string, number> = {};
  let t0 = now();
  const lap = (name: string) => {
    const t = now();
    ms[name] = t - t0;
    t0 = t;
  };
  const hf = input.heightfield;
  const base = baseSurface(hf);
  const bounds = { minX: base.minX, minY: base.minY, maxX: base.maxX, maxY: base.maxY };
  const cover = coverMap(input.features, bounds);
  lap('cover');
  const water = input.water
    ? waterQuery(input.features, input.water, {
        originX: bounds.minX,
        originY: bounds.minY,
        maxX: bounds.maxX,
        maxY: bounds.maxY,
      })
    : null;
  lap('water');
  const roads = roadStamps(input.features.roads, base, cover);
  lap('roads');
  const pads = padStamps(input.features.buildings, base);
  lap('pads');
  const channels = channelStamps(input.features.waterways ?? [], base, water);
  lap('channels');

  // Buckets: (kind, index, segment) triples of everything reaching each 32 m cell.
  const bc = Math.ceil((bounds.maxX - bounds.minX) / BUCKET_M) + 1;
  const br = Math.ceil((bounds.maxY - bounds.minY) / BUCKET_M) + 1;
  const lists: number[][] = Array.from({ length: bc * br }, () => []);
  const add = (
    kind: number,
    index: number,
    seg: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ) => {
    const c0 = Math.max(0, Math.floor((x0 - bounds.minX) / BUCKET_M));
    const c1 = Math.min(bc - 1, Math.floor((x1 - bounds.minX) / BUCKET_M));
    const r0 = Math.max(0, Math.floor((y0 - bounds.minY) / BUCKET_M));
    const r1 = Math.min(br - 1, Math.floor((y1 - bounds.minY) / BUCKET_M));
    for (let r = r0; r <= r1; r += 1)
      for (let c = c0; c <= c1; c += 1) lists[r * bc + c]?.push(kind, index, seg);
  };
  const addLine = (kind: number, index: number, xy: Float64Array, reach: number) => {
    for (let i = 0; i + 3 < xy.length; i += 2) {
      const ax = xy[i] ?? 0;
      const ay = xy[i + 1] ?? 0;
      const bx = xy[i + 2] ?? 0;
      const by = xy[i + 3] ?? 0;
      add(
        kind,
        index,
        i,
        Math.min(ax, bx) - reach,
        Math.min(ay, by) - reach,
        Math.max(ax, bx) + reach,
        Math.max(ay, by) + reach,
      );
    }
  };
  for (const r of roads) if (!r.bridge) addLine(0, r.index, r.xy, r.extent);
  pads.forEach((p, i) => {
    add(1, i, 0, p.minX - p.extent, p.minY - p.extent, p.maxX + p.extent, p.maxY + p.extent);
  });
  channels.forEach((c, i) => {
    addLine(2, i, c.xy, c.extent);
  });
  const buckets = lists.map((l) => Int32Array.from(l));
  let entries = 0;
  for (const b of buckets) entries += b.length / 3;
  lap('index');

  const look = new Float64Array(8);
  const cLo = new Float64Array(MAX_CONSTRAINTS);
  const cHi = new Float64Array(MAX_CONSTRAINTS);
  const cW = new Float64Array(MAX_CONSTRAINTS);
  const cPri = new Float64Array(MAX_CONSTRAINTS);
  const order = new Int32Array(MAX_CONSTRAINTS);
  const eff: RoadEffect = { lo: 0, hi: 0, w: 0, core: false, edge: 0, ditch: 0 };
  const bnd = { lo: 0, hi: 0, w: 0, core: false };
  // Per-sample state for "nearest segment of each road".
  let curKind = -1;
  let curIndex = -1;
  let curD2 = Infinity;
  let curS = 0;

  const sample = (xIn: number, yIn: number, out: FieldSample): void => {
    const x = xIn < bounds.minX ? bounds.minX : xIn > bounds.maxX ? bounds.maxX : xIn;
    const y = yIn < bounds.minY ? bounds.minY : yIn > bounds.maxY ? bounds.maxY : yIn;
    coverLookAt(cover, x, y, look);
    let relief = 0;
    if (spec.relief > 0) {
      for (let o = 0; o < 4; o += 1) {
        const a = look[o] ?? 0;
        if (a === 0) continue;
        const l = RELIEF_WAVELENGTHS[o] ?? 1;
        relief += a * gradientNoise(x / l, y / l, (SEEDS[o] ?? 0) ^ spec.seed);
      }
      relief *= spec.relief;
    }
    const b0 = base.at(x, y);
    out.roadEdge = 99;
    out.roadSurface = RoadSurface.None;
    out.shore = 99;
    out.shoreKind = 0;
    out.building = 99;
    out.grass = look[4] ?? 0;
    out.soil = look[5] ?? 0;
    out.litter = look[6] ?? 0;
    out.urban = look[7] ?? 0;
    let wet = 0;

    // Water areas and levelled rivers (the water grading's own query).
    const ground = b0 + relief;
    // Constraints are gathered, then applied in priority order (ties in the
    // order gathered, which is fixed): each clamps the height so far into its
    // band, weighted by its fade. Every step is continuous, so the ground is.
    let n = 0;
    const apply = (lo: number, hi: number, w: number, pri: number) => {
      if (n >= MAX_CONSTRAINTS || w <= 0) return;
      cLo[n] = lo;
      cHi[n] = hi;
      cW[n] = w;
      cPri[n] = pri;
      n += 1;
    };
    const wq = water?.at(x, y) ?? null;
    if (wq) {
      out.shoreKind = SANDY.has(wq.waterClass) ? 1 : 2;
      if (wq.inWater) {
        const d = wq.shoreDistance;
        out.shore = -d;
        const r = Math.max(3, wq.depth / 0.2);
        const u = d >= r ? 1 : d / r;
        let z = wq.level - wq.depth * u * (2 - u);
        // A ragged natural shore: low spits and stones in the first metres.
        if (d < 2.5 && SANDY.has(wq.waterClass)) {
          const n = gradientNoise(x / 3, y / 3, 0x5a5a ^ spec.seed);
          if (n > 0) z += n * 0.3 * (1 - d / 2.5);
        }
        apply(z, z, 1, PRI.waterBed);
      } else {
        const e = wq.shoreDistance;
        out.shore = e;
        const t = e <= 6 ? 0 : e >= 9 ? 1 : (e - 6) / 3;
        apply(
          wq.level + 0.03 * e,
          wq.level + 0.7 * e + 0.05,
          1 - t * t * (3 - 2 * t),
          PRI.waterBank,
        );
      }
      wet = Math.max(wet, 1 - Math.min(1, Math.max(0, out.shore) / 1.5));
    }

    const bi =
      Math.floor((y - bounds.minY) / BUCKET_M) * bc + Math.floor((x - bounds.minX) / BUCKET_M);
    const list = buckets[bi];
    if (list) {
      curKind = -1;
      curIndex = -1;
      const finish = () => {
        if (curKind === 0) {
          const road = roads[curIndex];
          if (road) {
            const d = Math.sqrt(curD2);
            if (d < road.extent) {
              roadEffect(road, d, levelAt(road, curS), ground, eff);
              apply(eff.lo, eff.hi, eff.w, eff.core ? PRI.roadCore : PRI.roadSlope);
              if (eff.edge < out.roadEdge) {
                out.roadEdge = eff.edge;
                out.roadSurface = road.surface;
              }
              if (eff.ditch > wet) wet = eff.ditch;
            }
          }
        } else if (curKind === 2) {
          const c = channels[curIndex];
          if (c) {
            const d = Math.sqrt(curD2);
            if (d < c.extent) {
              channelEffect(c, d, channelLevelAt(c, curS), bnd);
              apply(bnd.lo, bnd.hi, bnd.w, bnd.core ? PRI.channelBed : PRI.channelBank);
              const sd = d - c.half;
              if (sd < out.shore) {
                out.shore = sd;
                out.shoreKind = 2;
              }
              wet = Math.max(wet, 1 - Math.min(1, Math.max(0, sd) / 0.8));
            }
          }
        }
        curKind = -1;
      };
      for (let k = 0; k < list.length; k += 3) {
        const kind = list[k] ?? 0;
        const index = list[k + 1] ?? 0;
        if (kind === 1) {
          if (curKind !== -1) finish();
          const pad = pads[index];
          if (!pad) continue;
          if (
            x < pad.minX - pad.extent ||
            x > pad.maxX + pad.extent ||
            y < pad.minY - pad.extent ||
            y > pad.maxY + pad.extent
          )
            continue;
          const d = padDistance(pad, x, y);
          if (d < pad.extent) {
            padEffect(pad, d, bnd);
            apply(bnd.lo, bnd.hi, bnd.w, bnd.core ? PRI.padCore : PRI.padSlope);
            const wall = d < 0 ? 0 : d;
            if (wall < out.building) out.building = wall;
          }
          continue;
        }
        if (kind !== curKind || index !== curIndex) {
          if (curKind !== -1) finish();
          curKind = kind;
          curIndex = index;
          curD2 = Infinity;
        }
        const seg = list[k + 2] ?? 0;
        const xy = kind === 0 ? roads[index]?.xy : channels[index]?.xy;
        const cum = kind === 0 ? roads[index]?.cum : channels[index]?.cum;
        if (!xy || !cum) continue;
        const ax = xy[seg] ?? 0;
        const ay = xy[seg + 1] ?? 0;
        const dx = (xy[seg + 2] ?? 0) - ax;
        const dy = (xy[seg + 3] ?? 0) - ay;
        const l2 = dx * dx + dy * dy;
        let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = ax + t * dx - x;
        const py = ay + t * dy - y;
        const d2 = px * px + py * py;
        if (d2 < curD2) {
          curD2 = d2;
          const c0 = cum[seg / 2] ?? 0;
          curS = c0 + t * ((cum[seg / 2 + 1] ?? 0) - c0);
        }
      }
      if (curKind !== -1) finish();
    }

    // Stable insertion sort of the constraint indices by priority.
    for (let i = 0; i < n; i += 1) order[i] = i;
    for (let i = 1; i < n; i += 1) {
      const k = order[i] ?? 0;
      const p = cPri[k] ?? 0;
      let j = i - 1;
      while (j >= 0 && (cPri[order[j] ?? 0] ?? 0) > p) {
        order[j + 1] = order[j] ?? 0;
        j -= 1;
      }
      order[j + 1] = k;
    }
    let h = ground;
    for (let i = 0; i < n; i += 1) {
      const k = order[i] ?? 0;
      const lo = cLo[k] ?? 0;
      const hi = cHi[k] ?? 0;
      // Rounded at the band's edges, but never outside it: exact bands (cores) stay exact.
      let t = smax(lo, smin(h, hi, ROUND_M), ROUND_M);
      t = t < lo ? lo : t > hi ? hi : t;
      h += (cW[k] ?? 0) * (t - h);
    }
    out.h = h;
    out.wet = wet > 1 ? 1 : wet;
  };

  const scratch = emptySample();
  return {
    spec,
    bounds,
    height(x, y) {
      sample(x, y, scratch);
      return scratch.h;
    },
    sample,
    roads,
    pads,
    channels,
    water,
    cover,
    base,
    stats: {
      roads: roads.filter((r) => !r.bridge).length,
      bridges: roads.filter((r) => r.bridge).length,
      pads: pads.length,
      channels: channels.length,
      buckets: buckets.length,
      bucketEntries: entries,
      compileMs: ms,
    },
  };
}
