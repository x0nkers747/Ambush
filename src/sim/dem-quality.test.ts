import { describe, expect, it } from 'vitest';
import { authoritativeGround, TERRAIN_MODEL } from './authoritative-terrain';
import {
  cleanElevations,
  cleanTerrain,
  DEM_CLEANING,
  DEM_CLEANING_VERSION,
  DemQualityError,
  demQualitySummary,
  type SourceCorrections,
} from './dem-quality';
import { gradeTerrain, terrainModelId } from './ground';
import { fingerprintPlainData } from './hash';
import { createSyntheticTerrain } from './synthetic-terrain';
import { heightAt } from './terrain';

// DEM quality (docs/adr/0033): faulty samples found and repaired; real
// terrain, however steep, left exactly as it was.

const CELL = 10;
const SIZE = 41;

function field(f: (c: number, r: number) => number, columns = SIZE, rows = SIZE) {
  return {
    originX: 0,
    originY: 0,
    cellSize: CELL,
    columns,
    rows,
    elevations: Array.from({ length: columns * rows }, (_, i) =>
      f(i % columns, Math.floor(i / columns)),
    ),
  };
}

/** A gentle plane: harmonic repair reproduces it exactly. */
const plane = (c: number, r: number) => 50 + 0.3 * c + 0.2 * r;
/** Rolling hills. */
const rolling = (c: number, r: number) => 50 + 3 * Math.sin(c / 3.1) * Math.cos(r / 4.3) + 0.2 * c;
/** Deterministic noise in [−1, 1). */
const noise = (c: number, r: number) => {
  const x = Math.sin(c * 127.1 + r * 311.7) * 43758.5453;
  return 2 * (x - Math.floor(x)) - 1;
};

/** A field with some samples replaced. */
function withFaults(
  base: ReturnType<typeof field>,
  faults: readonly (readonly [number, number, number])[],
) {
  const elevations = [...base.elevations];
  for (const [c, r, v] of faults) elevations[r * base.columns + c] = v;
  return { ...base, elevations };
}

/** Samples that differ between two grids. */
function changed(a: readonly number[], b: readonly number[]): number[] {
  return a.flatMap((v, i) => (Object.is(v, b[i]) ? [] : [i]));
}

describe('faults it repairs', () => {
  it('repairs an isolated deep pit from the ground round it, and nothing else', () => {
    const base = field(plane);
    const faulty = withFaults(base, [[20, 20, -782.48]]);
    const { elevations, report } = cleanElevations(faulty);
    const i = 20 * SIZE + 20;
    expect(changed(faulty.elevations, elevations)).toEqual([i]);
    expect(elevations[i]).toBeCloseTo(plane(20, 20), 2);
    expect(report.anomalies).toBe(1);
    expect(report.repairedSamples).toBe(1);
    const [finding] = report.findings;
    expect(finding).toMatchObject({
      kind: 'pit',
      confidence: 'high',
      action: 'repaired',
      method: 'harmonic',
      samples: 1,
      x: 200,
      y: 200,
      original: -782.48,
    });
    expect(finding?.excursionM).toBeGreaterThan(800);
    expect(report.maxCorrectionM).toBeCloseTo(plane(20, 20) + 782.48, 1);
  });

  it('repairs an isolated high spike', () => {
    const faulty = withFaults(field(rolling), [[12, 30, 400]]);
    const { elevations, report } = cleanElevations(faulty);
    expect(changed(faulty.elevations, elevations)).toEqual([30 * SIZE + 12]);
    expect(report.findings[0]).toMatchObject({ kind: 'spike', action: 'repaired' });
    const around = [-1, 0, 1].flatMap((dr) => [-1, 0, 1].map((dc) => rolling(12 + dc, 30 + dr)));
    expect(elevations[30 * SIZE + 12]).toBeGreaterThanOrEqual(Math.min(...around));
    expect(elevations[30 * SIZE + 12]).toBeLessThanOrEqual(Math.max(...around));
  });

  it('repairs a two-sample fault, and leaves a faint dip beside it', () => {
    // Two bad source pixels side by side reach two grid samples; a third sample
    // is only 15 m low, under the minimum excursion: not judged a fault.
    const base = field(plane);
    const faulty = withFaults(base, [
      [20, 20, plane(20, 20) - 700],
      [21, 20, plane(21, 20) - 300],
      [22, 20, plane(22, 20) - 15],
    ]);
    const { elevations, report } = cleanElevations(faulty);
    expect(report.anomalies).toBe(1);
    expect(report.findings[0]).toMatchObject({ kind: 'pit', samples: 2, action: 'repaired' });
    expect(changed(faulty.elevations, elevations)).toEqual([20 * SIZE + 20, 20 * SIZE + 21]);
    for (const c of [20, 21]) {
      const v = elevations[20 * SIZE + c] ?? 0;
      // Between the faint dip and the plane round it.
      expect(v).toBeGreaterThan(plane(c, 20) - 15);
      expect(v).toBeLessThan(plane(c, 20) + 1);
    }
  });

  it('repairs adjacent and nearby faults together', () => {
    const faulty = withFaults(field(plane), [
      [10, 10, -300],
      [11, 11, -500], // diagonal neighbours
      [14, 10, 900], // a spike two samples away
    ]);
    const { elevations, report } = cleanElevations(faulty);
    expect(report.repairedSamples).toBe(3);
    for (const [c, r] of [
      [10, 10],
      [11, 11],
      [14, 10],
    ] as const) {
      expect(elevations[r * SIZE + c]).toBeCloseTo(plane(c, r), 1);
    }
  });

  it('repairs faults on the edge and in the corner of the grid', () => {
    const faulty = withFaults(field(plane), [
      [0, 0, -500],
      [20, 0, -400],
      [SIZE - 1, 25, 700],
    ]);
    const { elevations, report } = cleanElevations(faulty);
    expect(report.repairedSamples).toBe(3);
    // From the neighbours there are (a corner has three): within half a metre of the plane.
    expect(elevations[0]).toBeCloseTo(plane(0, 0), 0);
    expect(elevations[20]).toBeCloseTo(plane(20, 0), 0);
    expect(elevations[25 * SIZE + SIZE - 1]).toBeCloseTo(plane(SIZE - 1, 25), 0);
  });

  it('rebuilds NaN, infinite and no-data samples (definite faults)', () => {
    const faulty = withFaults(field(plane), [
      [5, 5, Number.NaN],
      [15, 5, Number.POSITIVE_INFINITY],
      [25, 5, Number.NEGATIVE_INFINITY],
      [5, 15, -32768],
      [15, 15, -9999],
      [25, 15, 3.4e38],
    ]);
    const { elevations, report } = cleanElevations(faulty);
    expect(report.invalidSamples).toBe(6);
    expect(report.repairedSamples).toBe(6);
    expect(report.unresolvedRegions).toBe(0);
    expect(elevations.every(Number.isFinite)).toBe(true);
    for (const [c, r] of [
      [5, 5],
      [15, 5],
      [25, 5],
      [5, 15],
      [15, 15],
      [25, 15],
    ] as const) {
      expect(elevations[r * SIZE + c]).toBeCloseTo(plane(c, r), 1);
    }
    expect(report.findings.filter((f) => f.kind === 'invalid')).toHaveLength(6);
    expect(report.findings.every((f) => f.confidence !== 'suspicious')).toBe(true);
  });

  it('honours the source’s own no-data value', () => {
    const faulty = withFaults(field(plane), [[8, 8, -1234]]);
    expect(cleanElevations(faulty, -1234).report.invalidSamples).toBe(1);
    // Without it, the value is judged on its merits (here an isolated pit, also repaired).
    expect(cleanElevations(faulty).report).toMatchObject({ invalidSamples: 0, anomalies: 1 });
  });

  it('rebuilds a missing region smoothly from its boundary, with no new peak or pit', () => {
    const missing: [number, number, number][] = [];
    for (let r = 10; r < 20; r += 1) {
      for (let c = 12; c < 22; c += 1) missing.push([c, r, Number.NaN]);
    }
    const base = field(rolling);
    const { elevations, report } = cleanElevations(withFaults(base, missing));
    expect(report.invalidSamples).toBe(100);
    expect(report.unresolvedRegions).toBe(0);
    // Harmonic: no value beyond the boundary's range, and continuous at the boundary.
    const boundary: number[] = [];
    for (let r = 9; r <= 20; r += 1) {
      for (let c = 11; c <= 22; c += 1) {
        if (r === 9 || r === 20 || c === 11 || c === 22)
          boundary.push(base.elevations[r * SIZE + c] ?? 0);
      }
    }
    for (const [c, r] of missing) {
      const v = elevations[r * SIZE + c] ?? Number.NaN;
      expect(v).toBeGreaterThanOrEqual(Math.min(...boundary) - 0.01);
      expect(v).toBeLessThanOrEqual(Math.max(...boundary) + 0.01);
    }
    expect(
      Math.abs((elevations[10 * SIZE + 12] ?? 0) - (base.elevations[9 * SIZE + 11] ?? 0)),
    ).toBeLessThan(3);
  });

  it('reports a region too large to rebuild as unresolved, and rejects a mostly invalid DEM', () => {
    const missing: [number, number, number][] = [];
    for (let r = 5; r < 30; r += 1) {
      for (let c = 5; c < 30; c += 1) missing.push([c, r, Number.NaN]);
    }
    const { elevations, report } = cleanElevations(withFaults(field(plane, 61, 61), missing));
    expect(report.unresolvedRegions).toBe(1);
    expect(report.findings[0]).toMatchObject({
      kind: 'invalid',
      action: 'unresolved',
      samples: 625,
    });
    // Still finite (interpolated), but flagged: the summary asks for attention.
    expect(elevations.every(Number.isFinite)).toBe(true);
    expect(demQualitySummary(report)).toContain(
      '1 unresolved elevation region requiring attention',
    );
    // More than a quarter invalid: no terrain is made.
    const mostly = field((c) => (c < 15 ? Number.NaN : 50));
    expect(() => cleanElevations(mostly)).toThrow(DemQualityError);
  });

  it('reports an isolated block too large to repair as unresolved, and leaves it', () => {
    const block: [number, number, number][] = [];
    for (let r = 15; r < 21; r += 1) {
      for (let c = 15; c < 21; c += 1) block.push([c, r, -500]);
    }
    const faulty = withFaults(field(plane), block);
    const { elevations, report } = cleanElevations(faulty);
    expect(report.repairedSamples).toBe(0);
    expect(report.unresolvedRegions).toBe(1);
    expect(report.findings[0]).toMatchObject({ kind: 'pit', action: 'unresolved', samples: 36 });
    expect(elevations).toEqual(faulty.elevations);
  });
});

describe('real terrain it preserves', () => {
  /** Cleans and expects nothing repaired or unresolved, and every sample exactly as it was. */
  function preserved(name: string, base: ReturnType<typeof field>) {
    const { elevations, report } = cleanElevations(base);
    expect(report.repairedSamples, name).toBe(0);
    expect(report.unresolvedRegions, name).toBe(0);
    expect(elevations, name).toEqual(base.elevations);
    expect(demQualitySummary(report), name).toBeNull();
    return report;
  }

  const centre = (SIZE - 1) / 2;
  const dist = (c: number, r: number) => Math.hypot(c - centre, r - centre) * CELL;

  it('steep mountains, with a summit one sample wide', () => {
    // 3 : 1 slopes (72°) up to a single-sample summit 1,500 m high.
    preserved(
      'mountain',
      field((c, r) => 500 + Math.max(0, 1500 - 3 * dist(c, r))),
    );
  });

  it('cliffs, straight and diagonal', () => {
    preserved(
      'cliff',
      field((c, r) => rolling(c, r) + (c >= 20 ? 120 : 0)),
    );
    preserved(
      'diagonal cliff',
      field((c, r) => rolling(c, r) + (c + r >= 40 ? 150 : 0)),
    );
    preserved(
      'sea cliff',
      field((c, r) => (c < 10 ? -2 : 60 + rolling(c, r) - 50)),
    );
  });

  it('narrow valleys and sharp ridges one sample wide', () => {
    preserved(
      'gorge',
      field((c, r) => rolling(c, r) - (c === 20 ? 60 : 0)),
    );
    preserved(
      'ridge',
      field((c, r) => rolling(c, r) + (r === 20 ? 60 : 0)),
    );
    preserved(
      'diagonal ravine',
      field((c, r) => rolling(c, r) - (c === r ? 45 : 0)),
    );
  });

  it('quarries with vertical walls, and real depressions', () => {
    preserved(
      'quarry',
      field((c, r) => plane(c, r) - (c >= 18 && c < 22 && r >= 18 && r < 22 ? 45 : 0)),
    );
    preserved(
      'small deep quarry',
      field((c, r) => plane(c, r) - (c >= 19 && c < 22 && r >= 19 && r < 22 ? 40 : 0)),
    );
    preserved(
      'depression',
      field((c, r) => 100 - 80 * Math.exp(-((dist(c, r) / 120) ** 2))),
    );
  });

  it('terraced slopes', () => {
    preserved(
      'terraces',
      field((c, r) => 100 + 15 * Math.floor(c / 3) + 0.1 * r),
    );
  });

  it('ground below sea level, coasts and sea stacks', () => {
    preserved(
      'Dead Sea shore',
      field((c, r) => -430 + rolling(c, r) - 50 + (c > 25 ? 40 : 0)),
    );
    preserved(
      'polder',
      field((c, r) => (r < 20 ? -6 + 0.01 * c : 2 + 0.05 * r)),
    );
    // A stack two samples across, 40 m out of a flat sea.
    const stack = preserved(
      'sea stack',
      field((c, r) => (c >= 20 && c < 22 && r >= 20 && r < 22 ? 40 : 0)),
    );
    // Unusual, so listed, but kept.
    expect(stack.suspiciousRegions).toBe(1);
    expect(stack.findings[0]).toMatchObject({ confidence: 'suspicious', action: 'preserved' });
  });

  it('naturally rough ground', () => {
    preserved(
      'rough',
      field((c, r) => rolling(c, r) + 25 * noise(c, r)),
    );
    preserved(
      'badlands',
      field((c, r) => 40 * Math.abs(Math.sin(c * 0.9) * Math.cos(r * 1.3)) + 8 * noise(c, r)),
    );
  });
});

describe('the cleaning itself', () => {
  const faulty = withFaults(field(rolling), [
    [10, 10, -782],
    [30, 5, 450],
    [5, 30, Number.NaN],
    [25, 25, -300],
    [26, 25, -120],
  ]);

  it('is deterministic, and does not depend on the order it scans the grid', () => {
    const a = cleanElevations(faulty);
    expect(cleanElevations(faulty)).toEqual(a);
    // The same ground mirrored: the same repairs, mirrored.
    const mirror = (e: readonly number[]) =>
      e.map((_, i) => e[Math.floor(i / SIZE) * SIZE + (SIZE - 1 - (i % SIZE))] ?? 0);
    const b = cleanElevations({ ...faulty, elevations: mirror(faulty.elevations) });
    mirror(b.elevations).forEach((v, i) => {
      expect(v).toBeCloseTo(a.elevations[i] ?? 0, 1);
    });
    expect(b.report.repairedSamples).toBe(a.report.repairedSamples);
  });

  it('is idempotent: a second pass finds nothing more', () => {
    const once = cleanElevations(faulty);
    const twice = cleanElevations({ ...faulty, elevations: once.elevations });
    expect(twice.report.repairedSamples).toBe(0);
    expect(twice.report.suspiciousRegions).toBe(0);
    expect(twice.elevations).toEqual(once.elevations);
  });

  it('changes only the faulty samples, and does not change its input', () => {
    const before = [...faulty.elevations];
    const { elevations } = cleanElevations(faulty);
    expect(faulty.elevations).toEqual(before);
    const faults = new Set([
      10 * SIZE + 10,
      5 * SIZE + 30,
      30 * SIZE + 5,
      25 * SIZE + 25,
      25 * SIZE + 26,
    ]);
    expect(changed(faulty.elevations, elevations).every((i) => faults.has(i))).toBe(true);
  });

  it('is versioned: its parameters are pinned to the version', () => {
    expect(DEM_CLEANING_VERSION).toBe('dem-clean-v1');
    // Changing any parameter changes the ground: it needs a new version (and this pin updated).
    expect(fingerprintPlainData(DEM_CLEANING)).toBe('9ea6f2e9e16e8374');
  });

  it('describes clean terrain with no warning', () => {
    const { report } = cleanElevations(field(rolling));
    expect(demQualitySummary(report)).toBeNull();
    expect(report).toMatchObject({ repairedSamples: 0, unresolvedRegions: 0, findings: [] });
    expect(demQualitySummary(cleanElevations(faulty).report)).toMatch(
      /^Terrain validation complete\. \d+ elevation anomalies corrected \(largest change \d+\.\d m\)\.$/,
    );
  });
});

describe('the authoritative ground', () => {
  /** A road over a faulty sample, beside a building. */
  const source = createSyntheticTerrain(
    { originX: 0, originY: 0, cellSize: CELL, columns: SIZE, rows: SIZE },
    (x, y) =>
      plane(x / CELL, y / CELL) + (Math.round(x) === 200 && Math.round(y) === 150 ? -782 : 0),
    {
      roads: [
        {
          id: 'road',
          roadClass: 'paved',
          widthMeters: 6,
          centerline: [
            { x: 20, y: 150 },
            { x: 380, y: 150 },
          ],
        },
      ],
      buildings: [],
      vegetation: [],
    },
  );

  it('grades the cleaned DEM, keeping the raw one, and names its model', () => {
    const { terrain, quality } = authoritativeGround(source);
    expect(quality.repairedSamples).toBe(1);
    expect(heightAt(source, 200, 150)).toBeLessThan(-700);
    // The road runs level over the repaired sample: no pit graded into it.
    expect(Math.abs(heightAt(terrain, 200, 150) - plane(20, 15))).toBeLessThan(1);
    expect(terrain.refinement?.factor).toBe(10);
    expect(terrainModelId(terrain)).toBe(TERRAIN_MODEL);
    expect(TERRAIN_MODEL).toBe('dem-clean-v1+field-v7');
    // Grading the raw DEM gives another model, and other ground.
    const uncleaned = gradeTerrain(source);
    expect(terrainModelId(uncleaned)).not.toBe(TERRAIN_MODEL);
    expect(heightAt(uncleaned, 200, 150)).toBeLessThan(heightAt(terrain, 200, 150) - 1);
  });

  it('cleans before grading only', () => {
    expect(() => cleanTerrain(gradeTerrain(source))).toThrow(/before grading/);
  });

  it('applies the corrections made at import from the source pixels, when of this version', () => {
    const corrections: SourceCorrections = {
      version: DEM_CLEANING_VERSION,
      faultyPixels: 2,
      invalidPixels: 0,
      brokenEdges: 0,
      seamOffsets: 0,
      unresolvedRegions: 0,
      samples: [[15 * SIZE + 20, 52.5]],
    };
    const { terrain, report } = cleanTerrain(source, corrections);
    expect(terrain.heightfield.elevations[15 * SIZE + 20]).toBe(52.5);
    expect(report.source).toMatchObject({ faultyPixels: 2, correctedSamples: 1 });
    expect(report.findings[0]).toMatchObject({
      kind: 'source',
      method: 'source-pixels',
      original: -782 + plane(20, 15),
    });
    // The grid's own check then has nothing left to do there.
    expect(report.anomalies).toBe(0);
    expect(demQualitySummary(report)).toContain('2 elevation anomalies corrected');
    // Made by another version: ignored (the grid's own check still repairs the pit).
    const old = cleanTerrain(source, { ...corrections, version: 'dem-clean-v0' });
    expect(old.report.source).toBeUndefined();
    expect(old.report.anomalies).toBe(1);
    // Not a sample of this terrain: refused.
    expect(() => cleanTerrain(source, { ...corrections, samples: [[SIZE * SIZE, 1]] })).toThrow(
      RangeError,
    );
  });
});
