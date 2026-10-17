import { describe, expect, it } from 'vitest';
import { dugInFrom } from './defence';
import type { FofForce } from './types';

// A fighting position protects toward its front (docs/behavior-lab/force-on-force/09).

/** A force fully dug in on its defend order, one soldier's position facing north (azimuth 0). */
const force = {
  phase: 'engaged',
  dugIn: 1,
  activeOrderId: 'd',
  orders: [{ id: 'd', kind: 'defend' }],
  earthworks: [{ soldierId: 'B1-01', x: 0, y: 0, azimuth: 0, level: 1, hard: false }],
} as unknown as FofForce;
const soldier = { id: 'B1-01', position: { x: 0, y: 0 } };
/** Fire from this bearing (degrees), 300 m off. */
const from = (deg: number) => ({
  x: 300 * Math.sin((deg * Math.PI) / 180),
  y: 300 * Math.cos((deg * Math.PI) / 180),
});

describe('a fighting position', () => {
  it('protects fully from its front, less from the flank, not at all from behind', () => {
    expect(dugInFrom(force, soldier, from(0))).toBe(1);
    expect(dugInFrom(force, soldier, from(-55))).toBe(1);
    expect(dugInFrom(force, soldier, from(90))).toBeCloseTo(0.5, 6);
    expect(dugInFrom(force, soldier, from(-90))).toBeCloseTo(0.5, 6);
    expect(dugInFrom(force, soldier, from(130))).toBe(0);
    expect(dugInFrom(force, soldier, from(180))).toBe(0);
  });

  it('half dug in, half of that; with no position yet, as dug in from anywhere', () => {
    expect(dugInFrom({ ...force, dugIn: 0.5 }, soldier, from(0))).toBe(0.5);
    expect(dugInFrom({ ...force, earthworks: [] }, soldier, from(180))).toBe(1);
  });
});
