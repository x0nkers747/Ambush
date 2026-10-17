import { describe, expect, it } from 'vitest';
import { hashSimState } from './hash';
import type { Scenario } from './scenario';
import { createSimulation, type Simulation } from './simulation';
import { createSyntheticTerrain, flatElevation, slopeElevation } from './synthetic-terrain';
import type { EnvironmentFeatures } from './environment';
import type { DeepReadonly } from './state';
import { VEHICLE_TYPES, type ScenarioVehicle, type VehicleState } from './vehicles';

const RATE = 30;

const FEATURES: EnvironmentFeatures = {
  // An east–west paved road along y = 500.
  roads: [
    {
      id: 'road',
      roadClass: 'paved',
      centerline: [
        { x: 20, y: 500 },
        { x: 1980, y: 500 },
      ],
      widthMeters: 7,
    },
  ],
  buildings: [
    {
      id: 'block',
      footprint: [
        { x: 1000, y: 900 },
        { x: 1040, y: 900 },
        { x: 1040, y: 1100 },
        { x: 1000, y: 1100 },
      ],
      heightMeters: 8,
    },
  ],
  // A wood from y = 1300 to 1700.
  vegetation: [
    {
      id: 'wood',
      kind: 'woodland',
      boundary: [
        { x: 100, y: 1300 },
        { x: 1900, y: 1300 },
        { x: 1900, y: 1700 },
        { x: 100, y: 1700 },
      ],
      canopyHeightMeters: 15,
      seeThroughMeters: 40,
    },
  ],
};

function scenario(vehicle: Partial<ScenarioVehicle>, elevation = flatElevation(10)): Scenario {
  return {
    id: 'vehicles',
    terrain: createSyntheticTerrain(
      { originX: 0, originY: 0, cellSize: 50, columns: 41, rows: 41 },
      elevation,
      FEATURES,
    ),
    movement: { speed: 1.5, maxTurnRate: Math.PI / 2 },
    units: [],
    soldiers: [],
    vehicles: [
      {
        id: 'V1',
        name: 'M113',
        side: 'BLUEFOR',
        kind: 'm113',
        position: { x: 200, y: 200 },
        headingDeg: 0,
        destinations: [],
        ...vehicle,
      },
    ],
  };
}

function run(
  sim: Simulation,
  seconds: number,
  each?: (v: DeepReadonly<VehicleState>, t: number) => void,
): DeepReadonly<VehicleState> {
  for (let k = 0; k < seconds * RATE; k += 1) {
    sim.step();
    const v = sim.state.vehicles?.[0];
    if (v && each) each(v, sim.timeSeconds);
  }
  const v = sim.state.vehicles?.[0];
  if (!v) throw new Error('no vehicle');
  return v;
}

describe('vehicles', () => {
  it('is absent from a state without vehicles', () => {
    const sim = createSimulation({ seed: 1, tickRateHz: RATE }, { ...scenario({}), vehicles: [] });
    expect('vehicles' in sim.state).toBe(false);
  });

  it('accelerates to the speed of open ground, then brakes smoothly to stop on its waypoint', () => {
    const sim = createSimulation(
      { seed: 1, tickRateHz: RATE },
      scenario({ position: { x: 200, y: 600 }, destinations: [{ x: 200, y: 1150 }] }),
    );
    let top = 0;
    let jerk = 0;
    let last = 0;
    let reachedTopAt = Infinity;
    const v = run(sim, 120, (s, t) => {
      top = Math.max(top, s.speed);
      jerk = Math.max(jerk, Math.abs(s.speed - last) * RATE);
      last = s.speed;
      if (s.speed > VEHICLE_TYPES.m113.openSpeed * 0.95 && t < reachedTopAt) reachedTopAt = t;
    });
    expect(top).toBeGreaterThan(VEHICLE_TYPES.m113.openSpeed * 0.95);
    expect(top).toBeLessThanOrEqual(VEHICLE_TYPES.m113.openSpeed + 1e-9);
    // About 7 s to reach it at 1.2 m/s².
    expect(reachedTopAt).toBeGreaterThan(5);
    expect(reachedTopAt).toBeLessThan(10);
    // Never faster to change speed than it can accelerate or brake.
    expect(jerk).toBeLessThanOrEqual(VEHICLE_TYPES.m113.decel + 1e-6);
    expect(v.speed).toBe(0);
    expect(Math.hypot(v.position.x - 200, v.position.y - 1150)).toBeLessThan(1.5);
    expect(v.orders[0]?.status).toBe('completed');
    expect(v.position.z).toBeCloseTo(10);
  });

  it('drives fastest on a road and slowest in woods', () => {
    const top = (from: { x: number; y: number }, to: { x: number; y: number }) => {
      const sim = createSimulation(
        { seed: 1, tickRateHz: RATE },
        scenario({
          position: from,
          headingDeg: (Math.atan2(to.x - from.x, to.y - from.y) * 180) / Math.PI,
          destinations: [to],
        }),
      );
      let best = 0;
      run(sim, 60, (v) => (best = Math.max(best, v.speed)));
      return best;
    };
    const road = top({ x: 100, y: 500 }, { x: 1800, y: 500 });
    const open = top({ x: 100, y: 250 }, { x: 1800, y: 250 });
    const woods = top({ x: 200, y: 1500 }, { x: 1800, y: 1500 });
    expect(road).toBeCloseTo(VEHICLE_TYPES.m113.roadSpeed, 1);
    expect(open).toBeCloseTo(VEHICLE_TYPES.m113.openSpeed, 1);
    expect(woods).toBeCloseTo(VEHICLE_TYPES.m113.woodsSpeed, 1);
  });

  it('is slower uphill', () => {
    const sim = createSimulation(
      { seed: 1, tickRateHz: RATE },
      scenario(
        { position: { x: 200, y: 600 }, destinations: [{ x: 200, y: 1200 }] },
        slopeElevation({ base: 0, gradientX: 0, gradientY: 0.15 }),
      ),
    );
    let best = 0;
    run(sim, 60, (v) => (best = Math.max(best, v.speed)));
    expect(best).toBeLessThan(VEHICLE_TYPES.m113.openSpeed * 0.75);
    expect(best).toBeGreaterThan(VEHICLE_TYPES.m113.openSpeed * 0.4);
  });

  it('pivots on the spot to face a waypoint behind it, then drives', () => {
    const sim = createSimulation(
      { seed: 1, tickRateHz: RATE },
      scenario({ position: { x: 600, y: 700 }, headingDeg: 0, destinations: [{ x: 600, y: 300 }] }),
    );
    let movedWhileTurning = 0;
    run(sim, 5, (v) => {
      if (Math.abs(Math.cos(v.heading)) > 0.5 && v.heading < Math.PI / 2)
        movedWhileTurning = Math.max(
          movedWhileTurning,
          Math.hypot(v.position.x - 600, v.position.y - 700),
        );
    });
    expect(movedWhileTurning).toBeLessThan(0.5);
    const v = run(sim, 80);
    expect(v.orders[0]?.status).toBe('completed');
    expect(Math.hypot(v.position.x - 600, v.position.y - 300)).toBeLessThan(1.5);
  });

  it('drives round a building, and takes its orders in turn', () => {
    const sim = createSimulation(
      { seed: 1, tickRateHz: RATE },
      scenario({
        position: { x: 1020, y: 850 },
        destinations: [
          { x: 1020, y: 1150 },
          { x: 1300, y: 1150 },
        ],
      }),
    );
    let inside = false;
    const v = run(sim, 180, (s) => {
      if (s.position.x > 998 && s.position.x < 1042 && s.position.y > 898 && s.position.y < 1102)
        inside = true;
    });
    expect(inside).toBe(false);
    expect(v.orders.map((o) => o.status)).toEqual(['completed', 'completed']);
    expect(Math.hypot(v.position.x - 1300, v.position.y - 1150)).toBeLessThan(1.5);
  });

  it('drives through a waypoint with another after it, slowing only for the bend', () => {
    const sim = createSimulation(
      { seed: 1, tickRateHz: RATE },
      scenario({
        position: { x: 200, y: 600 },
        destinations: [
          { x: 200, y: 900 },
          { x: 300, y: 1150 },
        ],
      }),
    );
    let slowest = Infinity;
    const v = run(sim, 120, (s) => {
      // From up to speed, until near the end.
      if (s.position.y > 700 && Math.hypot(s.position.x - 300, s.position.y - 1150) > 60)
        slowest = Math.min(slowest, s.speed);
    });
    // A 22° bend: barely slower than open ground's speed.
    expect(slowest).toBeGreaterThan(VEHICLE_TYPES.m113.openSpeed * 0.7);
    expect(v.orders.map((o) => o.status)).toEqual(['completed', 'completed']);
    expect(v.speed).toBe(0);
    expect(Math.hypot(v.position.x - 300, v.position.y - 1150)).toBeLessThan(1.5);
  });

  it('drives a road with gentle bends straight along it, not zig-zagging', () => {
    // The road along y = 500 made of short pieces, each bending a few degrees.
    const centerline = Array.from({ length: 40 }, (_, i) => ({
      x: 20 + i * 50,
      y: 500 + (i % 2 === 0 ? 0 : 2),
    }));
    const base = scenario({
      position: { x: 300, y: 480 },
      destinations: [{ x: 1700, y: 501, followRoads: true }],
    });
    const terrain = createSyntheticTerrain(
      { originX: 0, originY: 0, cellSize: 50, columns: 41, rows: 41 },
      flatElevation(10),
      { ...FEATURES, roads: [{ id: 'road', roadClass: 'paved', centerline, widthMeters: 7 }] },
    );
    const sim = createSimulation({ seed: 1, tickRateHz: RATE }, { ...base, terrain });
    let off = 0;
    const v = run(sim, 240, (s) => {
      if (s.position.x > 400 && s.position.x < 1600)
        off = Math.max(off, Math.abs(s.position.y - 501));
    });
    // Within the road's own wobble of its centre (pushed out at each bend, it was 3 m off).
    expect(off).toBeLessThan(1.6);
    expect(v.orders[0]?.status).toBe('completed');
  });

  it('replaces or appends to its orders by command', () => {
    const sim = createSimulation(
      { seed: 1, tickRateHz: RATE },
      scenario({ position: { x: 200, y: 600 }, destinations: [{ x: 200, y: 1150 }] }),
    );
    run(sim, 10);
    sim.submit({
      type: 'orderVehicle',
      tick: sim.tick,
      vehicleId: 'V1',
      mode: 'replace',
      destinations: [{ x: 500, y: 700 }],
    });
    sim.submit({
      type: 'orderVehicle',
      tick: sim.tick,
      vehicleId: 'V1',
      mode: 'append',
      destinations: [{ x: 600, y: 900 }],
    });
    const v = run(sim, 120);
    expect(v.orders.map((o) => o.status)).toEqual(['superseded', 'completed', 'completed']);
    expect(Math.hypot(v.position.x - 600, v.position.y - 900)).toBeLessThan(1.5);
  });

  it.each(['m113', 'm1a1', 't72b', 'bmp2'])(
    '%s: steers straight onto a waypoint close beside it and stops there, without circling it',
    (kind) => {
      // Moving, then a waypoint 6 m to its right and just behind: inside its turning circle.
      const sim = createSimulation(
        { seed: 1, tickRateHz: RATE },
        scenario({
          kind,
          position: { x: 200, y: 600 },
          destinations: [
            { x: 200, y: 800 },
            { x: 206, y: 797 },
          ],
        }),
      );
      let turned = 0;
      let last: number | null = null;
      const v = run(sim, 90, (s) => {
        if (last !== null) {
          let d = s.heading - last;
          d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
          turned += Math.abs(d);
        }
        last = s.heading;
      });
      expect(v.orders.map((o) => o.status)).toEqual(['completed', 'completed']);
      expect(Math.hypot(v.position.x - 206, v.position.y - 797)).toBeLessThan(1.5);
      expect(v.speed).toBe(0);
      // At most a half turn and a little to face it: never round and round.
      expect(turned).toBeLessThan(1.3 * Math.PI);
    },
  );

  it('is deterministic', () => {
    const go = () => {
      const sim = createSimulation(
        { seed: 1, tickRateHz: RATE },
        scenario({ position: { x: 1020, y: 850 }, destinations: [{ x: 1020, y: 1150 }] }),
      );
      run(sim, 40);
      return hashSimState(sim.state);
    };
    expect(go()).toBe(go());
  });
});
