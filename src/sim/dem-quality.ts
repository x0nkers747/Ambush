import type { Heightfield, TerrainDataset } from './terrain';

// DEM quality (docs/adr/0033): finds elevation samples that cannot be real
// ground and repairs those it is sure about, before grading (docs/adr/0032).
// The imported (raw) heightfield is never changed: cleaning makes a new
// terrain, stamped with the cleaning version, and grading starts from that.
//
// Two kinds of fault are repaired:
//
// - Invalid samples: not finite, a recognised no-data value, or beyond the
//   elevations of the Earth's surface. Always wrong; repaired when the region
//   is small enough to rebuild from the ground round it.
// - Isolated pits and spikes: a sample, or a small cluster, lying entirely
//   below (or above) every sample round it by far more than the steepest step
//   in the ground round it. A real hollow or summit is reached by slopes that
//   show in its surroundings; a data fault is not.
//
// Cliffs, ravines, quarries, terraces and ridges are preserved: some of the
// samples round any part of them lie at the same height (the feature
// continues), or the surroundings are as steep as the step itself. Nothing is
// smoothed except the samples judged faulty, and those are rebuilt by
// harmonic interpolation from their surroundings, which cannot create a new
// peak or pit. Deterministic: the result depends only on the samples.

/** Bump when any rule or parameter below changes: cleaned terrains of different versions differ. */
export const DEM_CLEANING_VERSION = 'dem-clean-v1';

/** The parameters of `DEM_CLEANING_VERSION` (a test pins them to the version). */
export const DEM_CLEANING = {
  /** A pit or spike must lie this far beyond every sample round it, metres. */
  minExcursionM: 20,
  /** … and this many times the steepest step between neighbouring samples round it. */
  isolationRatio: 4,
  /** Below the isolation ratio but above this: reported as suspicious, preserved. */
  suspiciousRatio: 2,
  /** The steepest step round a sample is taken as at least this, metres. */
  stepFloorM: 1,
  /**
   * … and at least this many times as deep (or high) as it is wide, times its
   * width in samples: a single 10 m sample at least 20 m, two samples across
   * at least 80 m. Larger regions need ever stronger evidence; real pits,
   * shafts and stacks are rarely deeper than they are wide.
   */
  minDepthToWidth: 2,
  /** Isolated regions that cannot be repaired are reported unresolved from this far, metres. */
  unresolvedExcursionM: 100,
  /** A cluster repaired as a fault has at most this many samples … */
  maxClusterSamples: 16,
  /** … and spans at most this many samples across. */
  maxClusterSpan: 5,
  /** Candidates: samples this far (as a share of `minExcursionM`) from the median round them. */
  candidateShare: 0.5,
  /** Distance of the samples a candidate is compared with, in samples. */
  candidateRadius: 3,
  /** Invalid regions up to this size are rebuilt; larger ones are reported unresolved. */
  maxInvalidRegionSamples: 400,
  /** More of the grid invalid than this, and the terrain is rejected. */
  maxInvalidShare: 0.25,
  /** The Earth's surface lies between about −11,000 m (Challenger Deep) and 8,849 m. */
  physicalMinM: -11000,
  physicalMaxM: 9000,
  /** No-data values used by common elevation formats (Terrarium's black pixel is −32768). */
  noDataValues: [-32768, -32767, -9999, -3.4028234663852886e38],
} as const;

/** What was found at one place. */
export interface DemFinding {
  /** `source`: a grid sample corrected at import, where a faulty source pixel had reached it. */
  readonly kind: 'invalid' | 'pit' | 'spike' | 'source';
  /** `definite`: invalid data; `high`: an isolated fault; `suspicious`: unusual, preserved. */
  readonly confidence: 'definite' | 'high' | 'suspicious';
  readonly action: 'repaired' | 'unresolved' | 'preserved';
  /** Samples in the region. */
  readonly samples: number;
  /** The region's most extreme sample (index, battlefield position, value; null when not finite). */
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly original: number | null;
  /** The value there after cleaning. */
  readonly cleaned: number;
  /** Range of the samples round the region. */
  readonly surroundingMinM: number | null;
  readonly surroundingMaxM: number | null;
  /** How far the region lies beyond every sample round it, and the steepest step round it. */
  readonly excursionM: number | null;
  readonly stepM: number | null;
  readonly method: 'harmonic' | 'source-pixels' | null;
  /** Largest change made in the region, metres (null for invalid samples, which had no value). */
  readonly maxChangeM: number | null;
}

/** A terrain-quality report (docs/adr/0033). */
export interface DemQualityReport {
  readonly version: string;
  readonly samples: number;
  /** From the check of the source tiles' pixels at import (absent when it was not made with this version). */
  readonly source?: {
    readonly faultyPixels: number;
    readonly invalidPixels: number;
    readonly brokenEdges: number;
    readonly seamOffsets: number;
    readonly unresolvedRegions: number;
    readonly correctedSamples: number;
  };
  readonly invalidSamples: number;
  /** Regions of high-confidence faults (pits and spikes). */
  readonly anomalies: number;
  readonly repairedSamples: number;
  readonly repairedRegions: number;
  /** Regions left as they were (or filled without enough evidence) that need attention. */
  readonly unresolvedRegions: number;
  /** Unusual but plausible regions, preserved. */
  readonly suspiciousRegions: number;
  readonly maxCorrectionM: number;
  readonly methods: readonly string[];
  /** Repaired, unresolved and suspicious regions, most severe first (at most 100). */
  readonly findings: readonly DemFinding[];
}

/** Stamped on a cleaned terrain. */
export interface TerrainCleaning {
  readonly version: string;
}

/** Thrown when too much of a DEM is invalid to rebuild. */
export class DemQualityError extends Error {
  override name = 'DemQualityError';
}

const MAX_FINDINGS = 100;
/** Candidate regions larger than this (bands along cliffs and banks) are not examined. */
const MAX_EXAMINED_REGION = 1000;

/**
 * What the import found in the source tiles' pixels (docs/adr/0033), stored
 * with the battlefield beside its raw grid: the grid samples a faulty pixel
 * reached, and their values with the pixel repaired.
 */
export interface SourceCorrections {
  readonly version: string;
  readonly faultyPixels: number;
  readonly invalidPixels: number;
  /** Tile edge lines rebuilt (stitching faults), and steady steps across tile edges (left). */
  readonly brokenEdges: number;
  readonly seamOffsets: number;
  readonly unresolvedRegions: number;
  /** `[sample index, corrected elevation]`, ascending by index. */
  readonly samples: readonly (readonly [number, number])[];
}

/**
 * The terrain with its DEM cleaned, and what was found: first the
 * corrections taken at import from the source pixels (when made with this cleaning version),
 * then the grid's own check. `source` must not be graded (cleaning comes
 * first); grading a cleaned terrain gives the authoritative ground.
 */
export function cleanTerrain(
  source: TerrainDataset,
  corrections: SourceCorrections | null = null,
  noDataValue: number | null = null,
): { terrain: TerrainDataset; report: DemQualityReport } {
  if (source.grading || source.refinement) {
    throw new RangeError('the DEM is cleaned before grading: this terrain is already graded');
  }
  const h = source.heightfield;
  const raw = h.elevations;
  const usable = corrections !== null && corrections.version === DEM_CLEANING_VERSION;
  const corrected = Array.from(raw);
  const sourceFindings: DemFinding[] = [];
  let sourceMax = 0;
  if (usable) {
    for (const [index, value] of corrections.samples) {
      if (!Number.isInteger(index) || index < 0 || index >= raw.length || !Number.isFinite(value)) {
        throw new RangeError(`source correction ${String(index)} is not a sample of this terrain`);
      }
      corrected[index] = value;
    }
  }
  const { elevations, report } = cleanElevations({ ...h, elevations: corrected }, noDataValue);
  if (usable) {
    for (const [index] of corrections.samples) {
      const before = raw[index] ?? 0;
      const after = elevations[index] ?? 0;
      sourceMax = Math.max(sourceMax, Math.abs(after - before));
      sourceFindings.push({
        kind: 'source',
        confidence: 'high',
        action: 'repaired',
        samples: 1,
        index,
        x: h.originX + (index % h.columns) * h.cellSize,
        y: h.originY + Math.floor(index / h.columns) * h.cellSize,
        original: before,
        cleaned: after,
        surroundingMinM: null,
        surroundingMaxM: null,
        excursionM: null,
        stepM: null,
        method: 'source-pixels',
        maxChangeM: Math.abs(after - before),
      });
    }
    sourceFindings.sort((a, b) => (b.maxChangeM ?? 0) - (a.maxChangeM ?? 0) || a.index - b.index);
  }
  const n = usable ? corrections.samples.length : 0;
  return {
    terrain: {
      ...source,
      heightfield: { ...h, elevations },
      cleaning: { version: DEM_CLEANING_VERSION },
    },
    report: {
      ...report,
      ...(usable
        ? {
            source: {
              faultyPixels: corrections.faultyPixels,
              invalidPixels: corrections.invalidPixels,
              brokenEdges: corrections.brokenEdges,
              seamOffsets: corrections.seamOffsets,
              unresolvedRegions: corrections.unresolvedRegions,
              correctedSamples: n,
            },
          }
        : {}),
      repairedSamples: report.repairedSamples + n,
      unresolvedRegions: report.unresolvedRegions + (usable ? corrections.unresolvedRegions : 0),
      maxCorrectionM: Math.max(report.maxCorrectionM, sourceMax),
      methods: [...(n > 0 ? ['source-pixels'] : []), ...report.methods],
      findings: [
        ...report.findings.filter((f) => f.action === 'unresolved'),
        ...sourceFindings,
        ...report.findings.filter((f) => f.action !== 'unresolved'),
      ].slice(0, MAX_FINDINGS),
    },
  };
}

/** Cleans a heightfield's samples (see the module comment); the input is not changed. */
export function cleanElevations(
  h: Pick<Heightfield, 'originX' | 'originY' | 'cellSize' | 'columns' | 'rows'> & {
    readonly elevations: ArrayLike<number>;
  },
  noDataValue: number | null = null,
): { elevations: number[]; report: DemQualityReport } {
  const P = DEM_CLEANING;
  const { columns, rows } = h;
  const count = columns * rows;
  const raw = h.elevations;
  const z = new Float64Array(count);
  const invalid = new Uint8Array(count);
  const noData = Float64Array.from([
    ...P.noDataValues,
    ...(noDataValue === null ? [] : [noDataValue]),
  ]);
  const isNoData = (v: number) => {
    for (const n of noData) if (v === n) return true;
    return false;
  };
  let invalidCount = 0;
  for (let i = 0; i < count; i += 1) {
    const v = raw[i] ?? Number.NaN;
    if (!Number.isFinite(v) || v < P.physicalMinM || v > P.physicalMaxM || isNoData(v)) {
      invalid[i] = 1;
      invalidCount += 1;
    } else {
      z[i] = v;
    }
  }
  if (invalidCount === count || invalidCount > count * P.maxInvalidShare) {
    throw new DemQualityError(
      `elevation data is invalid for ${String(Math.round((invalidCount / count) * 100))}% of the battlefield`,
    );
  }

  const xOf = (i: number) => h.originX + (i % columns) * h.cellSize;
  const yOf = (i: number) => h.originY + Math.floor(i / columns) * h.cellSize;
  /** The 8 neighbours of `i` on the grid. */
  const neighbours = (i: number, out: number[]) => {
    out.length = 0;
    const c = i % columns;
    const r = (i - c) / columns;
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        if (dr === 0 && dc === 0) continue;
        const rr = r + dr;
        const cc = c + dc;
        if (rr >= 0 && cc >= 0 && rr < rows && cc < columns) out.push(rr * columns + cc);
      }
    }
    return out;
  };
  /** 8-connected components of the samples where `member` is set, in index order. */
  const components = (member: Uint8Array): number[][] => {
    const seen = new Uint8Array(count);
    const out: number[][] = [];
    const around: number[] = [];
    for (let i = 0; i < count; i += 1) {
      if (!member[i] || seen[i]) continue;
      const region = [i];
      seen[i] = 1;
      // A breadth-first walk: for…of also visits the samples pushed during it.
      for (const at of region) {
        for (const n of neighbours(at, around)) {
          if (member[n] && !seen[n]) {
            seen[n] = 1;
            region.push(n);
          }
        }
      }
      out.push(region.sort((a, b) => a - b));
    }
    return out;
  };

  // --- Candidates: far from the median of the samples a few cells away -------------------
  // `core`: at least the minimum excursion from it (the sign: −1 below, +1 above);
  // `weak`: at least `candidateShare` of that (a fault's fainter edges).
  const core = new Int8Array(count);
  const weak = new Int8Array(count);
  const R = P.candidateRadius;
  const weakThreshold = P.minExcursionM * P.candidateShare;
  const ring = new Float64Array(8);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < columns; c += 1) {
      const i = r * columns + c;
      if (invalid[i]) continue;
      let m = 0;
      let lo = Infinity;
      let hi = -Infinity;
      for (let dr = -R; dr <= R; dr += R) {
        const rr = r + dr;
        if (rr < 0 || rr >= rows) continue;
        for (let dc = -R; dc <= R; dc += R) {
          const cc = c + dc;
          if ((dr === 0 && dc === 0) || cc < 0 || cc >= columns) continue;
          const j = rr * columns + cc;
          if (invalid[j]) continue;
          const v = z[j] ?? 0;
          ring[m] = v;
          m += 1;
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
      if (m < 3) continue;
      const v = z[i] ?? 0;
      // The median lies between the lowest and highest: most samples are ruled out here.
      if (v < lo + weakThreshold && v > hi - weakThreshold) continue;
      // Insertion sort (at most 8 values).
      for (let k = 1; k < m; k += 1) {
        const x = ring[k] ?? 0;
        let l = k;
        while (l > 0 && (ring[l - 1] ?? 0) > x) {
          ring[l] = ring[l - 1] ?? 0;
          l -= 1;
        }
        ring[l] = x;
      }
      const median =
        m % 2 === 1 ? (ring[(m - 1) / 2] ?? 0) : ((ring[m / 2 - 1] ?? 0) + (ring[m / 2] ?? 0)) / 2;
      const residual = v - median;
      const sign = Math.sign(residual);
      if (Math.abs(residual) >= P.minExcursionM) core[i] = sign;
      if (Math.abs(residual) >= weakThreshold) weak[i] = sign;
    }
  }

  /** How isolated a region (all below, `s` = −1, or all above, +1, its surroundings) is. */
  const evaluate = (region: readonly number[], s: -1 | 1) => {
    const inRegion = new Set(region);
    const around: number[] = [];
    // The surroundings: valid samples next to the region (ring 1) and next to those
    // (ring 2), leaving out other candidate faults.
    const usable = (n: number) => !inRegion.has(n) && !invalid[n] && core[n] === 0;
    const ring1 = new Set<number>();
    for (const i of region) for (const n of neighbours(i, around)) if (usable(n)) ring1.add(n);
    if (ring1.size < 3) return null;
    const ring2 = new Set<number>();
    for (const i of ring1) {
      for (const n of neighbours(i, around)) if (usable(n) && !ring1.has(n)) ring2.add(n);
    }
    let ringMin = Infinity;
    let ringMax = -Infinity;
    for (const i of ring1) {
      ringMin = Math.min(ringMin, z[i] ?? 0);
      ringMax = Math.max(ringMax, z[i] ?? 0);
    }
    let lo = Infinity;
    let hi = -Infinity;
    let extreme = region[0] ?? 0;
    let minC = columns;
    let maxC = -1;
    let minR = rows;
    let maxR = -1;
    for (const i of region) {
      const v = z[i] ?? 0;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
      if (s < 0 ? v < (z[extreme] ?? 0) : v > (z[extreme] ?? 0)) extreme = i;
      const c = i % columns;
      const r = (i - c) / columns;
      minC = Math.min(minC, c);
      maxC = Math.max(maxC, c);
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
    }
    const excursion = s < 0 ? ringMin - hi : lo - ringMax;
    // The steepest step between 4-adjacent samples in the surroundings.
    const surround = new Set([...ring1, ...ring2]);
    let step = 0;
    for (const i of surround) {
      const right = (i % columns) + 1 < columns ? i + 1 : -1;
      const up = i + columns < count ? i + columns : -1;
      for (const j of [right, up]) {
        if (j >= 0 && surround.has(j)) step = Math.max(step, Math.abs((z[i] ?? 0) - (z[j] ?? 0)));
      }
    }
    const span = Math.max(maxC - minC + 1, maxR - minR + 1);
    return {
      region,
      extreme,
      ringMin,
      ringMax,
      excursion,
      step,
      ratio: excursion / Math.max(step, P.stepFloorM),
      // How deep (or high) it reaches, at its deepest (highest) point.
      steep: (s < 0 ? ringMin - lo : hi - ringMax) >= P.minDepthToWidth * span * span * h.cellSize,
      small:
        region.length <= P.maxClusterSamples &&
        maxC - minC < P.maxClusterSpan &&
        maxR - minR < P.maxClusterSpan,
    };
  };
  /** Isolated: all beyond the surroundings, by far more than the surroundings' steepest step. */
  const isolated = (e: ReturnType<typeof evaluate>) =>
    e !== null && e.excursion >= P.minExcursionM && e.ratio >= P.isolationRatio;
  /** A fault to repair: isolated, small, and far deeper (or higher) than it is wide. */
  const isFault = (e: ReturnType<typeof evaluate>) =>
    isolated(e) && e !== null && e.steep && e.small;

  // --- Classify candidate regions --------------------------------------------------------
  const findings: DemFinding[] = [];
  const repair = new Uint8Array(count);
  const regionMeta = new Map<number, Omit<DemFinding, 'cleaned' | 'maxChangeM' | 'action'>>();
  let anomalies = 0;
  let suspicious = 0;
  let unresolved = 0;
  for (const s of [-1, 1] as const) {
    const member = new Uint8Array(count);
    for (let i = 0; i < count; i += 1) if (core[i] === s) member[i] = 1;
    for (const coreRegion of components(member)) {
      // Long bands (cliffs, banks) are far beyond any fault's size: real ground.
      if (coreRegion.length > MAX_EXAMINED_REGION) continue;
      // With its fainter edges (a fault smeared by resampling) when that is still a
      // clear fault; otherwise the core alone.
      const inCore = new Set(coreRegion);
      const edges = new Set<number>();
      const around: number[] = [];
      for (const i of coreRegion) {
        for (const n of neighbours(i, around)) {
          if (!inCore.has(n) && weak[n] === s && core[n] === 0 && !invalid[n]) edges.add(n);
        }
      }
      const grown =
        edges.size > 0
          ? evaluate(
              [...coreRegion, ...edges].sort((a, b) => a - b),
              s,
            )
          : null;
      const e = grown && isFault(grown) ? grown : evaluate(coreRegion, s);
      if (!e || e.excursion < P.minExcursionM || e.ratio < P.suspiciousRatio) continue;
      const base = {
        kind: s < 0 ? ('pit' as const) : ('spike' as const),
        samples: e.region.length,
        index: e.extreme,
        x: xOf(e.extreme),
        y: yOf(e.extreme),
        original: z[e.extreme] ?? 0,
        surroundingMinM: e.ringMin,
        surroundingMaxM: e.ringMax,
        excursionM: e.excursion,
        stepM: e.step,
        method: null,
      };
      if (isFault(e)) {
        anomalies += 1;
        for (const i of e.region) repair[i] = 1;
        regionMeta.set(e.extreme, { ...base, confidence: 'high', method: 'harmonic' });
      } else if (isolated(e) && e.excursion >= P.unresolvedExcursionM) {
        // Isolated and far off, but too large (or too wide) to rebuild with confidence.
        unresolved += 1;
        findings.push({
          ...base,
          confidence: 'high',
          action: 'unresolved',
          cleaned: z[e.extreme] ?? 0,
          maxChangeM: 0,
        });
      } else {
        suspicious += 1;
        findings.push({
          ...base,
          confidence: 'suspicious',
          action: 'preserved',
          cleaned: z[e.extreme] ?? 0,
          maxChangeM: 0,
        });
      }
    }
  }

  // --- Invalid regions ---------------------------------------------------------------------
  const invalidRegions = components(invalid);
  const invalidMeta = new Map<number, { resolved: boolean; samples: number }>();
  for (const region of invalidRegions) {
    const first = region[0] ?? 0;
    const around: number[] = [];
    let boundary = 0;
    const inRegion = new Set(region);
    const counted = new Set<number>();
    for (const i of region) {
      for (const n of neighbours(i, around)) {
        if (!inRegion.has(n) && !counted.has(n)) {
          counted.add(n);
          boundary += 1;
        }
      }
    }
    const resolved = region.length <= P.maxInvalidRegionSamples && boundary >= 3;
    if (!resolved) unresolved += 1;
    invalidMeta.set(first, { resolved, samples: region.length });
    for (const i of region) repair[i] = 1;
  }

  // --- Repair: harmonic interpolation over each region, from the samples round it ----------
  const cleaned = Float64Array.from(z);
  const repairRegions = components(repair);
  for (const region of repairRegions) harmonicFill(cleaned, region, repair, columns, rows);
  // A plain loop: Array.from on a typed array is slow.
  const out = new Array<number>(count);
  for (let i = 0; i < count; i += 1) out[i] = cleaned[i] ?? 0;
  for (const region of repairRegions) {
    for (const i of region) out[i] = Math.round((cleaned[i] ?? 0) * 100) / 100;
  }

  // --- Report ------------------------------------------------------------------------------
  let repairedSamples = 0;
  let maxCorrection = 0;
  for (const region of repairRegions) {
    for (const i of region) {
      repairedSamples += 1;
      if (!invalid[i])
        maxCorrection = Math.max(maxCorrection, Math.abs((out[i] ?? 0) - (z[i] ?? 0)));
    }
  }
  for (const [extreme, meta] of regionMeta) {
    const region = repairRegions.find((r) => r.includes(extreme)) ?? [extreme];
    let change = 0;
    for (const i of region) {
      if (!invalid[i]) change = Math.max(change, Math.abs((out[i] ?? 0) - (z[i] ?? 0)));
    }
    findings.push({ ...meta, action: 'repaired', cleaned: out[extreme] ?? 0, maxChangeM: change });
  }
  for (const region of invalidRegions) {
    const first = region[0] ?? 0;
    const meta = invalidMeta.get(first);
    if (!meta) continue;
    findings.push({
      kind: 'invalid',
      confidence: 'definite',
      action: meta.resolved ? 'repaired' : 'unresolved',
      samples: meta.samples,
      index: first,
      x: xOf(first),
      y: yOf(first),
      original: Number.isFinite(raw[first]) ? (raw[first] ?? null) : null,
      cleaned: out[first] ?? 0,
      surroundingMinM: null,
      surroundingMaxM: null,
      excursionM: null,
      stepM: null,
      method: 'harmonic',
      maxChangeM: null,
    });
  }
  const rank = { unresolved: 0, repaired: 1, preserved: 2 } as const;
  findings.sort(
    (a, b) =>
      rank[a.action] - rank[b.action] ||
      (b.excursionM ?? Infinity) - (a.excursionM ?? Infinity) ||
      a.index - b.index,
  );
  const resolvedInvalid = invalidRegions.filter((r) => invalidMeta.get(r[0] ?? 0)?.resolved).length;
  return {
    elevations: out,
    report: {
      version: DEM_CLEANING_VERSION,
      samples: count,
      invalidSamples: invalidCount,
      anomalies,
      repairedSamples,
      repairedRegions: anomalies + resolvedInvalid,
      unresolvedRegions: unresolved,
      suspiciousRegions: suspicious,
      maxCorrectionM: maxCorrection,
      methods: repairedSamples > 0 ? ['harmonic'] : [],
      findings: findings.slice(0, MAX_FINDINGS),
    },
  };
}

/**
 * Replaces the samples of `region` with the discrete harmonic interpolation
 * of the samples round it: each becomes the mean of its (up to 8) neighbours,
 * solved by Gauss–Seidel iteration in index order. A harmonic surface has no
 * maximum or minimum inside the region, so no new peak or pit; it meets the
 * surroundings without a step and reproduces a plane exactly.
 */
function harmonicFill(
  z: Float64Array,
  region: readonly number[],
  mask: Uint8Array,
  columns: number,
  rows: number,
): void {
  // Start from the mean of the samples round the region.
  let sum = 0;
  let n = 0;
  const neighbourLists = region.map((i) => {
    const c = i % columns;
    const r = (i - c) / columns;
    const list: number[] = [];
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        if (dr === 0 && dc === 0) continue;
        const rr = r + dr;
        const cc = c + dc;
        if (rr >= 0 && cc >= 0 && rr < rows && cc < columns) list.push(rr * columns + cc);
      }
    }
    for (const j of list) {
      if (!mask[j]) {
        sum += z[j] ?? 0;
        n += 1;
      }
    }
    return list;
  });
  const start = n > 0 ? sum / n : 0;
  for (const i of region) z[i] = start;
  const maxIterations = 20_000;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let change = 0;
    region.forEach((i, k) => {
      const list = neighbourLists[k] ?? [];
      let s = 0;
      for (const j of list) s += z[j] ?? 0;
      const v = s / list.length;
      change = Math.max(change, Math.abs(v - (z[i] ?? 0)));
      z[i] = v;
    });
    if (change < 1e-7) break;
  }
}

/** One line for the user about a report: null when there is nothing worth saying. */
export function demQualitySummary(report: DemQualityReport): string | null {
  const parts: string[] = [];
  const fixed =
    report.repairedRegions + (report.source?.faultyPixels ?? 0) + (report.source?.brokenEdges ?? 0);
  if (fixed > 0) {
    parts.push(
      `Terrain validation complete. ${String(fixed)} elevation ${fixed === 1 ? 'anomaly' : 'anomalies'} corrected (largest change ${report.maxCorrectionM.toFixed(1)} m).`,
    );
  }
  if (report.unresolvedRegions > 0) {
    parts.push(
      `Terrain validation found ${String(report.unresolvedRegions)} unresolved elevation ${report.unresolvedRegions === 1 ? 'region' : 'regions'} requiring attention.`,
    );
  }
  return parts.length > 0 ? parts.join(' ') : null;
}
