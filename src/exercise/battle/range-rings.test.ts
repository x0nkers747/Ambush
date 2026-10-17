import { describe, expect, it } from 'vitest';
import { squadRangeRings, vehicleRangeRings } from './range-rings';

// Range rings (docs/range-rings.md): what a squad or vehicle sees, its main
// weapon's effective range, and the furthest it fires.

describe('range rings', () => {
  it('a squad: it sees 1,200 m, its rifles are effective to 550 m, its automatic rifle reaches 800 m', () => {
    expect(squadRangeRings('BLUEFOR', 'squad', 'rockets')).toEqual({
      detectionM: 1200,
      effectiveM: 550,
      maxM: 800,
    });
  });

  it('a squad with a missile fires farthest with it', () => {
    expect(squadRangeRings('BLUEFOR', 'squad', 'rocketsAndMissile').maxM).toBe(2500);
    expect(squadRangeRings('OPFOR', 'fireTeam', 'none').maxM).toBe(800);
  });

  it('a vehicle: its sights see farther, its main armament sets the rest', () => {
    expect(vehicleRangeRings('m1a1')).toEqual({ detectionM: 3000, effectiveM: 3000, maxM: 4000 });
    expect(vehicleRangeRings('t72b')).toEqual({ detectionM: 2400, effectiveM: 2100, maxM: 4000 });
    expect(vehicleRangeRings('bmp2')).toEqual({ detectionM: 1920, effectiveM: 1500, maxM: 4000 });
    expect(vehicleRangeRings('m113')).toEqual({ detectionM: 1200, effectiveM: 1500, maxM: 1800 });
  });

  it('every ring of every vehicle is a positive distance', () => {
    for (const kind of ['m113', 'm1a1', 'bmp2', 't72b'])
      for (const r of Object.values(vehicleRangeRings(kind))) expect(r).toBeGreaterThan(0);
  });
});
