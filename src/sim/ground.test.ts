import { describe, expect, it } from 'vitest';
import type { EnvironmentFeatures } from './environment';
import type { Vec2 } from './geometry';
import {
  assembleGround,
  FINE_SPACING_M,
  gradeTerrain,
  groundBand,
  groundBands,
  groundDecks,
  groundField,
  groundFieldInput,
  REFINE_TOLERANCE_M,
  terrainModelId,
} from './ground';
import { fingerprintPlainData } from './hash';
import { shareTerrain } from './shared-terrain';
import { planBridges } from './bridges';
import { createSyntheticTerrain } from './synthetic-terrain';
import { heightAt, validateTerrain, type TerrainDataset } from './terrain';
import { TERRAIN_FIELD_VERSION } from './terrain-field/field';

// The authoritative ground sampled from the terrain field (docs/adr/0049): a
// small battlefield on rolling ground, a road crossing a stream on a mapped
// bridge, a house on the slope and a pond.

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const ring = (cx: number, cy: number, r: number, n = 24): Vec2[] =>
  Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });
const line = (...pts: [number, number][]) => pts.map(([x, y]) => ({ x, y }));

const features: EnvironmentFeatures = {
  roads: [
    { id: 'road-w', roadClass: 'paved', widthMeters: 6, centerline: line([-190, -20], [-8, -20]) },
    {
      id: 'road-b',
      roadClass: 'paved',
      widthMeters: 6,
      bridge: true,
      centerline: line([-8, -20], [8, -20]),
    },
    { id: 'road-e', roadClass: 'paved', widthMeters: 6, centerline: line([8, -20], [190, -20]) },
  ],
  buildings: [{ id: 'house', footprint: rect(-80, 20, -66, 30), heightMeters: 7 }],
  vegetation: [],
  water: [{ id: 'pond', kind: 'water', waterClass: 'pond', boundary: ring(-120, -120, 30) }],
  waterways: [
    { id: 'stream', kind: 'river', widthMeters: 8, centerline: line([0, 190], [0, -190]) },
  ],
  landUse: [],
};
const source: TerrainDataset = {
  ...createSyntheticTerrain(
    { originX: -200, originY: -200, cellSize: 10, columns: 41, rows: 41 },
    (x, y) => 100 + 0.04 * y - 0.02 * x + 3 * Math.min(1, Math.abs(x) / 40),
    features,
  ),
  formatVersion: 3,
};
const graded = gradeTerrain(source);
const field = groundField(source);

describe('the ground sampled from the terrain field', () => {
  it('is a valid terrain, refined to a 1 m lattice where the field has detail', () => {
    expect(() => {
      validateTerrain(graded);
    }).not.toThrow();
    expect(graded.refinement?.factor).toBe(10);
    expect(graded.grading?.fineSpacingM).toBe(FINE_SPACING_M);
    expect(graded.refinement?.samples).toBeInstanceOf(Float32Array);
    const refined = graded.refinement?.cells.length ?? 0;
    expect(refined).toBeGreaterThan(50);
    expect(refined).toBeLessThan(40 * 40);
    expect(terrainModelId(graded)).toBe(`field-v${String(TERRAIN_FIELD_VERSION)}`);
  });

  it('is the field at every lattice point, to within the tolerance', () => {
    let worst = 0;
    for (let y = -195; y <= 195; y += 1)
      for (let x = -195; x <= 195; x += 1) {
        worst = Math.max(worst, Math.abs(heightAt(graded, x, y) - field.height(x, y)));
      }
    // Refined edges are straightened next to unrefined cells, which hold the tolerance.
    expect(worst).toBeLessThan(REFINE_TOLERANCE_M * 2);
  });

  it('keeps the cleaned elevations and the water levels, for the 3D view', () => {
    expect(graded.grading?.baseElevations).toBe(source.heightfield.elevations);
    const input = groundFieldInput(graded);
    expect(input.heightfield.elevations).toEqual(source.heightfield.elevations);
    expect(input.water).toBe(graded.grading?.water);
  });

  it('does not depend on how the rows are shared out between workers', () => {
    const input = groundFieldInput(source);
    const rows = source.heightfield.rows;
    const shares = groundBands(rows, 7).map(([r0, r1]) =>
      groundBand(field, source.heightfield, r0, r1),
    );
    const split = assembleGround(source, input.water, shares.reverse(), groundDecks(field));
    expect(split.heightfield.elevations).toEqual(graded.heightfield.elevations);
    expect(split.refinement?.cells).toEqual(graded.refinement?.cells);
    expect(split.refinement?.samples).toEqual(graded.refinement?.samples);
    expect(fingerprintPlainData(split)).toBe(fingerprintPlainData(graded));
  });

  it('carries soldiers over the mapped bridge on the deck the field lays', () => {
    expect(graded.grading?.decks?.map((d) => d.roadId)).toEqual(['road-b']);
    const [bridge] = planBridges(graded).bridges;
    expect(bridge?.mapped).toBe(true);
    const deck = graded.grading?.decks?.[0];
    const mid = Math.floor((deck?.top.length ?? 0) / 2);
    const k = Math.floor((bridge?.deck.length ?? 0) / 2);
    expect(Math.abs((bridge?.deck[k] ?? 0) - (deck?.top[mid] ?? 0))).toBeLessThan(0.05);
    // The ground under it is held below the deck.
    expect(heightAt(graded, 0, -20)).toBeLessThan((deck?.top[mid] ?? 0) - 0.8);
  });

  it('can be shared and fingerprinted, its Float32 samples included', () => {
    const shared = shareTerrain(graded);
    expect(shared.refinement?.samples).toEqual(graded.refinement?.samples);
    expect(shared.refinement?.samples).not.toBe(graded.refinement?.samples);
    expect(fingerprintPlainData(shared)).toBe(fingerprintPlainData(graded));
    const changed = shareTerrain(graded);
    const samples = changed.refinement?.samples;
    if (samples instanceof Float32Array) samples[0] = (samples[0] ?? 0) + 0.5;
    expect(fingerprintPlainData(changed)).not.toBe(fingerprintPlainData(graded));
  });

  it('leaves a graded terrain as it is', () => {
    expect(gradeTerrain(graded)).toBe(graded);
  });
});
