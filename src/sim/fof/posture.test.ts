import { describe, expect, it } from 'vitest';
import { createSyntheticTerrain } from '../synthetic-terrain';
import { soldierId, type Soldier } from '../state';
import { postureToSee, type KnownContacts } from './force';
import type { FofContext } from './system';

// Halted in contact, a soldier takes the lowest posture from which he sees
// an enemy his force knows of (docs/behavior-lab/force-on-force/07): prone
// if he sees one lying down, else kneeling, else (in cover) prone.

/** Flat ground with a bank 0.7 m high, 3–5 m north of the origin, across the whole field. */
const terrain = createSyntheticTerrain(
  { originX: -100, originY: -100, cellSize: 1, columns: 201, rows: 201 },
  (_x: number, y: number) => (y >= 3 && y <= 5 ? 0.7 : 0),
);
const context = {
  world: { terrain },
  setup: { config: { detection: { eyeHeightM: { standing: 1.65, kneeling: 1.0, prone: 0.3 } } } },
} as unknown as FofContext;

const soldier = (x: number, y: number): Soldier =>
  ({ id: soldierId('S'), position: { x, y, z: 0 }, posture: 'prone' }) as unknown as Soldier;
const known = (...points: [number, number][]): KnownContacts => ({
  count: points.length,
  x: Float64Array.from(points.map((p) => p[0])),
  y: Float64Array.from(points.map((p) => p[1])),
});

describe('the posture a soldier in contact takes', () => {
  it('prone when he sees the enemy lying down', () => {
    // The enemy south: nothing between.
    expect(postureToSee(context, soldier(0, 0), known([0, -60]), 'prone')).toBe('prone');
  });

  it('kneeling when the bank in front hides the enemy from him lying down', () => {
    expect(postureToSee(context, soldier(0, 0), known([0, 60]), 'prone')).toBe('kneeling');
  });

  it('prone (in cover) when he sees nothing from either; leaders never lie down', () => {
    const high = createSyntheticTerrain(
      { originX: -100, originY: -100, cellSize: 1, columns: 201, rows: 201 },
      (_x: number, y: number) => (y >= 3 && y <= 5 ? 3 : 0),
    );
    const walled = { ...context, world: { terrain: high } } as unknown as FofContext;
    expect(postureToSee(walled, soldier(0, 0), known([0, 60]), 'prone')).toBe('prone');
    expect(postureToSee(walled, soldier(0, 0), known([0, 60]), 'kneeling')).toBe('kneeling');
    expect(postureToSee(context, soldier(0, 0), known(), 'prone')).toBe('prone');
  });
});
