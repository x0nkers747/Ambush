import { describe, expect, it } from 'vitest';
import {
  cleanElevations,
  cleanTerrain,
  clonePlainData,
  DEM_CLEANING_VERSION,
  demQualitySummary,
} from '#sim';
import {
  battlefieldRequest,
  buildBattlefield,
  parseBattlefieldPackage,
  planBattlefield,
  type BattlefieldInputs,
} from './package';
import type { OverpassResponse } from './osm';
import { cleanElevationTiles, type ElevationTile } from './terrarium';
import { QUANTICO_DEM_EXCERPT } from './test-data/fixtures';
import quantico from './test-data/quantico-va.overpass.json';
import { TILE_SIZE } from './tiles';

// DEM quality at import (docs/adr/0033), and the recorded Quantico fault it
// was built for.

const S = TILE_SIZE;

describe('Quantico: a real fault in the source data', () => {
  const g = QUANTICO_DEM_EXCERPT.grid;
  const raw = g.centimetres.map((v) => v / 100);
  const heightfield = { ...g, elevations: raw };
  const index = (x: number, y: number) =>
    Math.round((y - g.originY) / g.cellSize) * g.columns + Math.round((x - g.originX) / g.cellSize);
  const neighbours = (i: number) =>
    [-1, 0, 1].flatMap((dr) =>
      [-1, 0, 1].flatMap((dc) => (dr === 0 && dc === 0 ? [] : [raw[i + dr * g.columns + dc] ?? 0])),
    );

  it('finds the −782 m pit by its surroundings, not its place, and repairs it', () => {
    const { elevations, report } = cleanElevations(heightfield);
    const i = index(230, 1240);
    expect(raw[i]).toBe(-782.48);
    const around = neighbours(i);
    // Its neighbours: the bank of the Potomac, 0.2–17.6 m.
    expect(Math.min(...around)).toBeCloseTo(0.21, 2);
    expect(Math.max(...around)).toBeCloseTo(17.57, 2);
    const finding = report.findings.find((f) => f.index === i);
    expect(finding).toMatchObject({
      kind: 'pit',
      confidence: 'high',
      action: 'repaired',
      method: 'harmonic',
      samples: 1,
      x: 230,
      y: 1240,
      original: -782.48,
    });
    // 782 m below every neighbour, against a steepest step round it of about 17 m.
    expect(finding?.excursionM).toBeGreaterThan(780);
    expect(finding?.stepM).toBeLessThan(20);
    const fixed = elevations[i] ?? Number.NaN;
    expect(fixed).toBeGreaterThanOrEqual(Math.min(...around));
    expect(fixed).toBeLessThanOrEqual(Math.max(...around));
    expect(fixed).toBeCloseTo(9.13, 2);
    expect(finding?.maxChangeM).toBeCloseTo(791.61, 2);
  });

  it('repairs the other fault in the excerpt too, and changes nothing else', () => {
    const { elevations, report } = cleanElevations(heightfield);
    const faults = [index(230, 1240), index(80, 1630)];
    expect(raw[index(80, 1630)]).toBe(-148.95);
    expect(report.repairedSamples).toBe(2);
    expect(report.unresolvedRegions).toBe(0);
    expect(report.suspiciousRegions).toBe(0);
    raw.forEach((v, i) => {
      if (!faults.includes(i)) expect(elevations[i]).toBe(v);
    });
    // The steep river bank beside it (a 15 m step between neighbours) is kept.
    expect(Math.abs((raw[index(220, 1240)] ?? 0) - (raw[index(230, 1250)] ?? 0))).toBeGreaterThan(
      10,
    );
    // No pit or spike is left: no sample lies 20 m beyond all of its neighbours.
    for (let r = 1; r < g.rows - 1; r += 1) {
      for (let c = 1; c < g.columns - 1; c += 1) {
        const i = r * g.columns + c;
        const v = elevations[i] ?? 0;
        const n = [-1, 0, 1].flatMap((dr) =>
          [-1, 0, 1].flatMap((dc) =>
            dr === 0 && dc === 0 ? [] : [elevations[i + dr * g.columns + dc] ?? 0],
          ),
        );
        expect(Math.min(...n) - v).toBeLessThan(20);
        expect(v - Math.max(...n)).toBeLessThan(20);
      }
    }
    expect(demQualitySummary(report)).toBe(
      'Terrain validation complete. 2 elevation anomalies corrected (largest change 791.6 m).',
    );
    // A second pass finds nothing.
    expect(cleanElevations({ ...heightfield, elevations }).report.repairedSamples).toBe(0);
  });

  it('finds the fault in the source tile itself: two pixels, −1062 m and −398 m', () => {
    const t = QUANTICO_DEM_EXCERPT.tile;
    const pixels = {
      originX: 0,
      originY: 0,
      cellSize: 3.74,
      columns: t.size,
      rows: t.size,
      elevations: t.elevations,
    };
    const { elevations, report } = cleanElevations(pixels);
    const at = (x: number, y: number) => (y - t.firstPixelY) * t.size + (x - t.firstPixelX);
    expect(t.elevations[at(202, 180)]).toBeCloseTo(-1061.59, 2);
    expect(t.elevations[at(202, 181)]).toBeCloseTo(-397.7, 1);
    expect(report.repairedSamples).toBe(2);
    expect(report.findings[0]).toMatchObject({ kind: 'pit', samples: 2, action: 'repaired' });
    for (const i of [at(202, 180), at(202, 181)]) {
      expect(elevations[i]).toBeGreaterThan(10);
      expect(elevations[i]).toBeLessThan(25);
    }
  });
});

/** Gently sloping ground, continuous across tiles (1 mm per pixel east, 2 mm south). */
function slope(t: { z: number; x: number; y: number }): Float32Array {
  const e = new Float32Array(S * S);
  for (let j = 0; j < S; j += 1) {
    for (let k = 0; k < S; k += 1) {
      e[j * S + k] = 30 + 0.001 * ((t.x * S + k) % 100_000) + 0.002 * ((t.y * S + j) % 100_000);
    }
  }
  return e;
}

describe('checking source tiles at import', () => {
  const tile = (x: number, y: number, e?: Float32Array): ElevationTile => ({
    z: 15,
    x,
    y,
    elevations: e ?? slope({ z: 15, x, y }),
  });

  it('repairs faulty and no-data pixels, and leaves clean tiles untouched', () => {
    const bad = slope({ z: 15, x: 100, y: 200 });
    bad[50 * S + 60] = -1061.6; // a void pit
    bad[120 * S + 30] = -32768; // Terrarium's black pixel: no data
    const clean = tile(101, 200);
    const result = cleanElevationTiles([tile(100, 200, bad), clean]);
    expect(result).toMatchObject({
      faultyPixels: 1,
      invalidPixels: 1,
      brokenEdges: 0,
      seamOffsets: 0,
      unresolvedRegions: 0,
    });
    const fixed = result.tiles[0]?.elevations;
    expect(fixed?.[50 * S + 60]).toBeCloseTo(bad[50 * S + 59] ?? 0, 0);
    expect(fixed?.[120 * S + 30]).toBeCloseTo(bad[120 * S + 31] ?? 0, 0);
    expect(result.tiles[1]).toBe(clean);
    // Missing tiles stay missing.
    expect(
      cleanElevationTiles([{ z: 15, x: 1, y: 1, elevations: null }]).tiles[0]?.elevations,
    ).toBeNull();
  });

  it('rebuilds a broken tile edge line (a stitching fault)', () => {
    const left = slope({ z: 15, x: 100, y: 200 });
    for (let k = 0; k < S; k += 1) left[k * S + S - 1] = -500;
    const right = tile(101, 200);
    const result = cleanElevationTiles([tile(100, 200, left), right]);
    expect(result.brokenEdges).toBe(1);
    expect(result.unresolvedRegions).toBe(0);
    const fixed = result.tiles[0]?.elevations;
    for (const k of [0, 77, 200, S - 1]) {
      expect(fixed?.[k * S + S - 1]).toBeCloseTo(left[k * S + S - 2] ?? 0, 0);
    }
    // The neighbour's own, sound edge is not taken for broken.
    expect(result.tiles[1]).toBe(right);
  });

  it('reports a steady step between tiles (sources that disagree) and leaves it', () => {
    const higher = slope({ z: 15, x: 101, y: 200 }).map((v) => v + 5);
    const result = cleanElevationTiles([tile(100, 200), tile(101, 200, higher)]);
    expect(result.seamOffsets).toBe(1);
    expect(result.unresolvedRegions).toBe(1);
    expect(result.brokenEdges).toBe(0);
    expect(result.tiles[1]?.elevations).toEqual(higher);
  });

  it('keeps a real cliff that happens to cross a tile edge', () => {
    // A 60 m cliff running north–south through both tiles.
    const cliff = (x: number) => {
      const e = slope({ z: 15, x, y: 200 });
      for (let j = 0; j < S; j += 1) {
        for (let k = 0; k < S; k += 1)
          if (x * S + k >= 100 * S + 128) e[j * S + k] = (e[j * S + k] ?? 0) + 60;
      }
      return e;
    };
    const result = cleanElevationTiles([tile(100, 200, cliff(100)), tile(101, 200, cliff(101))]);
    expect(result).toMatchObject({
      faultyPixels: 0,
      brokenEdges: 0,
      seamOffsets: 0,
      unresolvedRegions: 0,
    });
  });
});

describe('a battlefield package', () => {
  const REQUEST = battlefieldRequest(
    { lat: 38.5223, lon: -77.2934 },
    { name: 'Quantico', widthM: 1000 },
  );
  const tiles = (fault: boolean) =>
    planBattlefield(REQUEST).tiles.map((t) => {
      const e = slope(t);
      // Void pits scattered through every tile: some reach grid samples.
      if (fault) {
        for (let j = 5; j < S; j += 16) for (let k = 5; k < S; k += 16) e[j * S + k] = -900;
      }
      return {
        ...t,
        elevations: e,
        sources: 'ned/ned19_n38x75_w077x50_va_ninenortherncos_2011.tif',
      };
    });
  const inputs = (fault: boolean): BattlefieldInputs => ({
    request: REQUEST,
    tiles: tiles(fault),
    elevationUrlTemplate: 'https://example.test/terrarium/{z}/{x}/{y}.png',
    osm: quantico as OverpassResponse,
    osmEndpoint: 'https://overpass.example.test/api/interpreter',
    createdAt: '2026-10-11T12:00:00Z',
  });

  it('keeps the raw grid, and the corrections from the source pixels beside it', () => {
    const pkg = buildBattlefield(inputs(true));
    const c = pkg.elevation.cleaning;
    expect(c?.version).toBe(DEM_CLEANING_VERSION);
    expect(c?.faultyPixels).toBeGreaterThan(0);
    expect(c?.samples.length).toBeGreaterThan(0);
    // The raw grid is as resampled, fault and all; the corrections say what it should be.
    const [i = 0, fixed = 0] = c?.samples[0] ?? [];
    const rawValue = pkg.terrain.heightfield.elevations[i] ?? 0;
    expect(rawValue).toBeLessThan(fixed - 20);
    // Opening applies them before grading: the ground there is the corrected value.
    const { terrain, report } = cleanTerrain(pkg.terrain, c ?? null);
    expect(terrain.heightfield.elevations[i]).toBe(fixed);
    expect(report.source?.correctedSamples).toBe(c?.samples.length);
    // A clean battlefield records an empty check.
    expect(buildBattlefield(inputs(false)).elevation.cleaning).toMatchObject({
      faultyPixels: 0,
      samples: [],
    });
  });

  it('refuses a package whose corrections are damaged', () => {
    const pkg = buildBattlefield(inputs(true));
    expect(parseBattlefieldPackage(clonePlainData(pkg))).toBeTruthy();
    const damaged = clonePlainData(pkg) as unknown as {
      elevation: { cleaning: { samples: unknown[] } };
    };
    damaged.elevation.cleaning.samples.push([10 ** 9, 1]);
    expect(() => parseBattlefieldPackage(damaged)).toThrow(/elevation corrections are invalid/);
  });
});
