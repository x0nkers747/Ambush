import { describe, expect, it } from 'vitest';
import { createMotionRecorder } from '#exercise';
import { addTravel, alongLoop, fitHull, loopLengths, M113, trackPath } from './vehicles';

// The M113's running gear in 3D (docs/vehicles.md): its tracks' path round
// the wheels, the hull on the ground under them, and how far each track runs.

describe('M113 running gear', () => {
  it('lays each track round the idler, under the road wheels and round the sprocket', () => {
    const rest = trackPath(M113.wheelsAlong.map(() => M113.wheelUp));
    const lengths = loopLengths(rest);
    const perimeter = lengths[lengths.length - 1] ?? 0;
    // About 9.5 m of track: 62 shoes at 15.3 cm.
    expect(perimeter).toBeGreaterThan(9);
    expect(perimeter).toBeLessThan(10.5);
    // The bottom run on the ground, the top run above the wheels.
    const ups = rest.map((p) => p.up);
    expect(Math.min(...ups)).toBeCloseTo(M113.wheelUp - M113.wheelRadius - M113.shoeThickness / 2);
    expect(Math.max(...ups)).toBeGreaterThan(M113.wheelUp + M113.wheelRadius);
    // A wheel raised by a bump lifts the run under it.
    const bumped = trackPath(M113.wheelsAlong.map((_, i) => M113.wheelUp + (i === 2 ? 0.1 : 0)));
    const under = bumped.find((p) => Math.abs(p.along) < 1e-9);
    expect(under?.up).toBeCloseTo(M113.wheelUp + 0.1 - M113.wheelRadius - M113.shoeThickness / 2);
    // Along the loop: a point at any distance, its direction a unit vector.
    const at = { along: 0, up: 0, dx: 0, dy: 0 };
    alongLoop(rest, lengths, perimeter * 2.3, at);
    expect(Math.hypot(at.dx, at.dy)).toBeCloseTo(1);
  });

  it('fits the hull to the ground under its wheels', () => {
    // Rising 10% ahead and 5% to the right, 3 m up at the centre.
    const ground = [-1, 1].map((s) =>
      M113.wheelsAlong.map((along) => 3 + 0.1 * along + 0.05 * s * (M113.trackGauge / 2)),
    );
    const fit = fitHull(ground);
    expect(fit.height).toBeCloseTo(3);
    expect(fit.slopeAlong).toBeCloseTo(0.1);
    expect(fit.slopeAcross).toBeCloseTo(0.05);
  });

  it('runs both tracks as far as it drives, and the two opposite ways as it pivots', () => {
    const log = createMotionRecorder(30);
    const state = (tick: number, y: number, azimuth: number) => ({
      tick,
      rng: { s0: 0, s1: 0, s2: 0, s3: 0 },
      units: [],
      soldiers: [],
      vehicles: [
        {
          id: 'V1',
          name: 'V1',
          side: 'BLUEFOR' as const,
          kind: 'm113' as const,
          position: { x: 0, y, z: 0 },
          heading: azimuth,
          speed: 0,
          orders: [],
          nextOrder: 1,
          route: [],
          routeIndex: 0,
        },
      ],
    });
    // 10 m north, then a quarter turn to the right on the spot.
    for (let k = 0; k <= 10; k += 1) log.record(state(k, k, 0));
    for (let k = 1; k <= 10; k += 1) log.record(state(10 + k, 10, (k / 10) * (Math.PI / 2)));
    const t = { tick: 0, left: 0, right: 0 };
    addTravel(log, 0, 0, 10, t);
    expect(t.left).toBeCloseTo(10);
    expect(t.right).toBeCloseTo(10);
    addTravel(log, 0, 10, 20, t);
    const arc = (Math.PI / 2) * (M113.trackGauge / 2);
    expect(t.left).toBeCloseTo(10 + arc);
    expect(t.right).toBeCloseTo(10 - arc);
  });
});
