import { describe, expect, it } from 'vitest';
import type { SimEvent } from './events';
import { hashSimState } from './hash';
import { clonePlainData } from './plain-data';
import type { Scenario } from './scenario';
import { createSimulation, type Simulation } from './simulation';
import { soldierId, waypointId, type Orders } from './state';
import {
  createSyntheticTerrain,
  flatElevation,
  ridgeElevation,
  slopeElevation,
  type ElevationFunction,
} from './synthetic-terrain';

const S = soldierId('S');
const QUARTER = Math.PI / 2;

/** One soldier at (0, 0) facing north on 400 m × 400 m terrain, 2 m/s, turning 90°/s. */
function setup({
  elevation = flatElevation(0),
  tickRateHz = 10,
  azimuthDeg = 0,
}: { elevation?: ElevationFunction; tickRateHz?: number; azimuthDeg?: number } = {}) {
  const scenario: Scenario = {
    id: 'movement',
    terrain: createSyntheticTerrain(
      { originX: -200, originY: -200, cellSize: 10, columns: 41, rows: 41 },
      elevation,
    ),
    movement: { speed: 2, maxTurnRate: QUARTER },
    units: [{ id: 'U', echelon: 'fireTeam', parentId: null, leaderId: null }],
    soldiers: [
      {
        id: 'S',
        side: 'BLUEFOR',
        unitId: 'U',
        position: { x: 0, y: 0 },
        azimuthDeg,
        posture: 'standing',
      },
    ],
  };
  const sim = createSimulation({ tickRateHz, seed: 1 }, scenario);
  const soldier = () => {
    const s = sim.state.soldiers[0];
    if (!s) throw new Error('no soldier');
    return s;
  };
  return { sim, soldier };
}

function orders(points: [number, number][], finalFacing = 0): Orders {
  return {
    waypoints: points.map(([x, y], i) => ({ id: waypointId(`W${String(i + 1)}`), x, y })),
    finalFacing,
  };
}

function order(sim: Simulation, o: Orders | null, tick = sim.tick): void {
  sim.submit({ type: 'setOrders', tick, soldierId: S, orders: o });
}

function runSeconds(sim: Simulation, seconds: number): SimEvent[] {
  const events: SimEvent[] = [];
  const ticks = Math.round(seconds * sim.config.tickRateHz);
  for (let i = 0; i < ticks; i += 1) events.push(...sim.step());
  return events;
}

const movementEvents = (events: readonly SimEvent[]) =>
  events.filter((e) => e.type !== 'ordersChanged');

/** Positions accumulate rounding of order 1e-15 m per tick; arrivals are exact. */
function expectAt(position: { x: number; y: number; z: number }, x: number, y: number, z = 0) {
  expect(position.x).toBeCloseTo(x, 9);
  expect(position.y).toBeCloseTo(y, 9);
  expect(position.z).toBeCloseTo(z, 9);
}

const at = (seconds: number) => expect.closeTo(seconds, 9) as number;

describe('moving toward a waypoint', () => {
  it('travels straight at constant speed and arrives exactly', () => {
    const { sim, soldier } = setup();
    order(sim, orders([[30, 40]], Math.atan2(3, 4)));
    runSeconds(sim, 5); // 10 m of 50 m
    expect(soldier().position.x).toBeCloseTo(6, 12);
    expect(soldier().position.y).toBeCloseTo(8, 12);
    expect(soldier().orders?.behavior).toBe('moving');

    const events = movementEvents(runSeconds(sim, 25));
    expect(soldier().position).toEqual({ x: 30, y: 40, z: 0 });
    expect(events).toEqual([
      { type: 'waypointReached', tick: 249, soldierId: S, waypointId: 'W1', atSeconds: at(25) },
      { type: 'soldierInPosition', tick: 249, soldierId: S, atSeconds: at(25) },
    ]);
  });

  it('does not move further once in position', () => {
    const { sim, soldier } = setup();
    order(sim, orders([[0, 4]]));
    runSeconds(sim, 2);
    expect(soldier().orders?.behavior).toBe('inPosition');
    const before = clonePlainData(sim.state.soldiers);
    expect(runSeconds(sim, 10)).toEqual([]);
    expect(sim.state.soldiers).toEqual(before);
  });

  it('records the original orders unchanged and tracks progress separately', () => {
    const { sim, soldier } = setup();
    const given = orders([
      [0, 1],
      [0, 2],
      [0, 30],
    ]);
    order(sim, given);
    runSeconds(sim, 1.2);
    expect(soldier().orders).toEqual({
      orders: given,
      nextWaypointIndex: 2,
      behavior: 'moving',
      legPaths: [[], [], []], // open terrain: every leg is straight
      nextTurnIndex: 0,
    });
  });
});

describe('terrain following', () => {
  it('takes Z from the terrain on a slope, moving at constant ground speed', () => {
    const { sim, soldier } = setup({
      elevation: slopeElevation({ base: 5, gradientX: 0, gradientY: 0.25 }),
    });
    expect(soldier().position.z).toBe(5);
    order(sim, orders([[0, 100]]));
    for (let t = 1; t <= 10; t += 1) {
      runSeconds(sim, 1);
      expect(soldier().position.y).toBeCloseTo(2 * t, 9);
      expect(soldier().position.z).toBeCloseTo(5 + 0.25 * 2 * t, 9);
    }
  });

  it('follows a ridge up and down', () => {
    const { sim, soldier } = setup({
      elevation: ridgeElevation({ base: 0, height: 10, crestY: 50, halfWidth: 20 }),
    });
    order(sim, orders([[0, 100]]));
    const profile: number[] = [];
    for (let t = 0; t < 50; t += 1) {
      runSeconds(sim, 1);
      profile.push(soldier().position.z);
    }
    // y = 2t: flat until y = 30, crest at y = 50, flat again from y = 70.
    expect(profile[9]).toBe(0); // y = 20
    expect(profile[19]).toBeCloseTo(5, 9); // y = 40
    expect(profile[24]).toBeCloseTo(10, 9); // y = 50
    expect(profile[29]).toBeCloseTo(5, 9); // y = 60
    expect(profile[39]).toBe(0); // y = 80
  });
});

describe('heading', () => {
  it('turns toward the direction of travel at the maximum turn rate without bending the path', () => {
    const { sim, soldier } = setup();
    order(sim, orders([[100, 0]], QUARTER));
    runSeconds(sim, 0.5);
    expect(soldier().azimuth).toBeCloseTo(Math.PI / 4, 12);
    expectAt(soldier().position, 1, 0);
    runSeconds(sim, 0.5);
    expect(soldier().azimuth).toBe(QUARTER);
    runSeconds(sim, 1);
    expect(soldier().azimuth).toBe(QUARTER);
  });

  it('turns the shorter way', () => {
    const { sim, soldier } = setup();
    order(sim, orders([[-100, 0]], 3 * QUARTER));
    runSeconds(sim, 0.5);
    expect(soldier().azimuth).toBeCloseTo(2 * Math.PI - Math.PI / 4, 12);
  });
});

describe('multiple waypoints', () => {
  it('visits waypoints in order with exact arrival times', () => {
    const { sim, soldier } = setup();
    order(
      sim,
      orders(
        [
          [0, 10],
          [10, 10],
          [10, 0],
          [0, 0],
        ],
        Math.PI,
      ),
    );
    const events = movementEvents(runSeconds(sim, 30));
    expect(events.map((e) => [e.type, 'waypointId' in e ? e.waypointId : null])).toEqual([
      ['waypointReached', 'W1'],
      ['waypointReached', 'W2'],
      ['waypointReached', 'W3'],
      ['waypointReached', 'W4'],
      ['soldierInPosition', null],
    ]);
    const times = events.map((e) => ('atSeconds' in e ? e.atSeconds : Number.NaN));
    // 5 s per 10 m leg; the last leg heads west (270°) and must turn 90° to face south.
    [5, 10, 15, 20, 21].forEach((t, i) => {
      expect(times[i]).toBeCloseTo(t, 9);
    });
    expect(soldier().position).toEqual({ x: 0, y: 0, z: 0 });
    expect(soldier().azimuth).toBe(Math.PI);
  });

  it('reaches several closely spaced waypoints within one tick without overshooting', () => {
    const { sim, soldier } = setup({ tickRateHz: 1 }); // one 1 s tick covers 2 m
    order(
      sim,
      orders([
        [0, 0.5],
        [0, 0.7],
        [0.4, 1.0], // 0.5 m diagonal leg
        [0.4, 1.0], // duplicate point: reached with no travel
        [0.4, 1.5],
        [0.4, 50],
      ]),
    );
    const events = sim.step();
    expect(movementEvents(events)).toEqual(
      [0.25, 0.35, 0.6, 0.6, 0.85].map((atSeconds, i) => ({
        type: 'waypointReached',
        tick: 0,
        soldierId: S,
        waypointId: `W${String(i + 1)}`,
        atSeconds: expect.closeTo(atSeconds, 12) as number,
      })),
    );
    // The remaining 0.15 s carries on toward W6: 0.3 m past W5.
    expect(soldier().position.x).toBeCloseTo(0.4, 12);
    expect(soldier().position.y).toBeCloseTo(1.8, 12);
    expect(soldier().orders?.nextWaypointIndex).toBe(5);
  });

  it('stops exactly on the final waypoint and spends the rest of the tick turning', () => {
    const { sim, soldier } = setup({ tickRateHz: 1 });
    order(
      sim,
      orders(
        [
          [0, 0.5],
          [0, 1.2],
        ],
        QUARTER,
      ),
    );
    const events = movementEvents(sim.step());
    expect(soldier().position).toEqual({ x: 0, y: 1.2, z: 0 });
    // Arrives at 0.6 s; 0.4 s at 90°/s turns 36° of the 90° to face east.
    expect(soldier().azimuth).toBeCloseTo(0.4 * QUARTER, 12);
    expect(soldier().orders?.behavior).toBe('facing');
    expect(events.map((e) => e.type)).toEqual(['waypointReached', 'waypointReached']);

    const next = movementEvents(sim.step());
    expect(next).toEqual([
      {
        type: 'soldierInPosition',
        tick: 1,
        soldierId: S,
        atSeconds: expect.closeTo(1.6, 12) as number,
      },
    ]);
  });

  it('treats a waypoint at the current position as reached immediately', () => {
    const { sim } = setup();
    order(sim, orders([[0, 0]]));
    expect(movementEvents(sim.step())).toEqual([
      { type: 'waypointReached', tick: 0, soldierId: S, waypointId: 'W1', atSeconds: 0 },
      { type: 'soldierInPosition', tick: 0, soldierId: S, atSeconds: 0 },
    ]);
  });
});

describe('final facing and in position', () => {
  it('turns to the final facing after the last waypoint, then is in position', () => {
    const { sim, soldier } = setup();
    order(sim, orders([[0, 10]], Math.PI)); // arrive facing north, then reverse
    const events = movementEvents(runSeconds(sim, 5));
    expect(events.map((e) => e.type)).toEqual(['waypointReached']);
    expect(soldier().orders?.behavior).toBe('facing');

    runSeconds(sim, 1);
    expect(soldier().azimuth).toBeCloseTo(QUARTER, 12); // an exact reversal turns clockwise
    expect(movementEvents(runSeconds(sim, 1))).toEqual([
      {
        type: 'soldierInPosition',
        tick: 69,
        soldierId: S,
        atSeconds: expect.closeTo(7, 12) as number,
      },
    ]);
    expect(soldier().azimuth).toBe(Math.PI);
    expect(soldier().orders?.behavior).toBe('inPosition');
  });

  it('turns in place when the orders have no waypoints', () => {
    const { sim, soldier } = setup();
    order(sim, orders([], QUARTER));
    expect(soldier().orders).toBeNull();
    sim.step();
    expect(soldier().orders?.behavior).toBe('facing');
    const events = movementEvents(runSeconds(sim, 2));
    expect(events).toEqual([
      {
        type: 'soldierInPosition',
        tick: 9,
        soldierId: S,
        atSeconds: expect.closeTo(1, 12) as number,
      },
    ]);
    expect(soldier().position).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('is in position immediately when already at the final facing', () => {
    const { sim } = setup({ azimuthDeg: 90 });
    order(sim, orders([], QUARTER));
    expect(movementEvents(sim.step())).toEqual([
      { type: 'soldierInPosition', tick: 0, soldierId: S, atSeconds: 0 },
    ]);
  });
});

describe('changing orders', () => {
  it('replaces orders while moving, heading for the new waypoint from where the soldier is', () => {
    const { sim, soldier } = setup();
    order(sim, orders([[0, 100]]));
    runSeconds(sim, 5); // at (0, 10)
    order(sim, { waypoints: [{ id: waypointId('N1'), x: 30, y: 50 }], finalFacing: 0 });
    const events = runSeconds(sim, 27);
    expect(events[0]).toEqual({
      type: 'ordersChanged',
      tick: 50,
      soldierId: S,
      orders: { waypoints: [{ id: 'N1', x: 30, y: 50 }], finalFacing: 0 },
    });
    // 50 m at 2 m/s, then turn back from the leg's azimuth to north at 90°/s.
    expect(movementEvents(events)).toEqual([
      expect.objectContaining({ type: 'waypointReached', waypointId: 'N1', atSeconds: at(30) }),
      expect.objectContaining({
        type: 'soldierInPosition',
        atSeconds: at(30 + Math.atan2(30, 40) / QUARTER),
      }),
    ]);
    expectAt(soldier().position, 30, 50);
    expect(soldier().orders?.nextWaypointIndex).toBe(1);
  });

  it('clears orders: the soldier stops where it is and stays idle', () => {
    const { sim, soldier } = setup();
    order(sim, orders([[0, 100]]));
    runSeconds(sim, 3);
    order(sim, null);
    const events = runSeconds(sim, 10);
    expect(events).toEqual([{ type: 'ordersChanged', tick: 30, soldierId: S, orders: null }]);
    expect(soldier().orders).toBeNull();
    const stopped = { ...soldier().position };
    expectAt(stopped, 0, 6);
    runSeconds(sim, 5);
    expect(soldier().position).toEqual(stopped);
  });

  it('accepts new orders after reaching a position', () => {
    const { sim, soldier } = setup();
    order(sim, orders([[0, 2]]));
    runSeconds(sim, 2);
    expect(soldier().orders?.behavior).toBe('inPosition');
    order(sim, orders([[0, 0]], Math.PI));
    runSeconds(sim, 4);
    expect(soldier().position).toEqual({ x: 0, y: 0, z: 0 });
    expect(soldier().azimuth).toBe(Math.PI);
    expect(soldier().orders?.behavior).toBe('inPosition');
  });
});

describe('movement determinism', () => {
  function scripted(tickRateHz = 30) {
    const { sim } = setup({
      tickRateHz,
      elevation: ridgeElevation({ base: 3, height: 12, crestY: 40, halfWidth: 25 }),
    });
    order(
      sim,
      orders(
        [
          [5, 20],
          [5.1, 20.05],
          [-12, 60],
          [0, 80],
        ],
        1.0,
      ),
    );
    order(
      sim,
      orders(
        [
          [40, 40],
          [-20, 70],
        ],
        4.0,
      ),
      tickRateHz * 8,
    );
    return sim;
  }

  it('repeats exactly', () => {
    const a = scripted();
    const b = scripted();
    const eventsA = runSeconds(a, 60);
    const eventsB = runSeconds(b, 60);
    expect(eventsB).toEqual(eventsA);
    expect(hashSimState(b.state)).toBe(hashSimState(a.state));
  });

  it('restores a snapshot taken mid-leg and repeats the same result', () => {
    const sim = scripted();
    runSeconds(sim, 3.5);
    expect(sim.state.soldiers[0]?.orders?.behavior).toBe('moving');
    const snapshot = sim.snapshot();
    const first = runSeconds(sim, 30);
    const firstHash = hashSimState(sim.state);

    sim.restore(snapshot);
    order(
      sim,
      orders(
        [
          [40, 40],
          [-20, 70],
        ],
        4.0,
      ),
      30 * 8,
    ); // resubmit the pending command
    expect(runSeconds(sim, 30)).toEqual(first);
    expect(hashSimState(sim.state)).toBe(firstHash);
  });
});
