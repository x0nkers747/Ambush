import { describe, expect, it } from 'vitest';
import { SPECIES, SPECIES_NAMES, treeModels } from './tree-models';

// The lab's trees and shrubs (tree-models.ts): every species built, every
// level sound, and each level cheaper than the one before.

describe('terrain lab: tree models', () => {
  const models = treeModels();

  it('builds every species, in variants, with three levels each', () => {
    for (const name of SPECIES_NAMES) expect(models.some((m) => m.species === name)).toBe(true);
    expect(models.length).toBeGreaterThan(SPECIES_NAMES.length);
    for (const m of models) expect(m.lods).toHaveLength(3);
  });

  it('keeps every level finite, on its feet, within its size, with texture coordinates in the atlas', () => {
    for (const m of models) {
      const spec = SPECIES[m.species];
      for (const g of m.lods) {
        expect(g.triangles).toBeGreaterThan(0);
        expect(g.positions.length).toBe(g.triangles * 9);
        expect(g.uvs.length).toBe(g.triangles * 6);
        expect(g.sway.length).toBe(g.triangles * 3);
        for (let i = 0; i < g.positions.length; i += 3) {
          const x = g.positions[i] ?? NaN;
          const y = g.positions[i + 1] ?? NaN;
          const z = g.positions[i + 2] ?? NaN;
          expect(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)).toBe(true);
          // Cards overhang a little; nothing goes far below the ground or above the crown.
          expect(y).toBeGreaterThan(-spec.card * 3.5);
          expect(y).toBeLessThan(spec.height * 1.25 + spec.card * 3);
          expect(Math.hypot(x, z)).toBeLessThan(spec.crown * 1.6 + spec.card * 2.5 + 1);
        }
        for (const v of g.uvs) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('makes each level cheaper than the one before', () => {
    for (const m of models) {
      const [near, medium, far] = m.lods;
      expect(medium.triangles).toBeLessThanOrEqual(near.triangles);
      expect(far.triangles).toBeLessThanOrEqual(medium.triangles);
    }
    // Far trees are cheap: they are drawn by the tens of thousands.
    for (const m of models) expect(m.lods[2].triangles).toBeLessThan(60);
  });

  it('is the same every time', () => {
    const again = treeModels();
    expect(again[3]?.lods[0].positions).toEqual(models[3]?.lods[0].positions);
  });
});
