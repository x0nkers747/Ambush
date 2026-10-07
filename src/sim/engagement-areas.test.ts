import { describe, expect, it } from 'vitest';
import type { SimEvent } from './events';
import { hashSimState } from './hash';
import type { Scenario } from './scenario';
import { createSimulation, type Simulation } from './simulation';
import { engagementAreaId, soldierId, waypointId, type EngagementArea, type Side } from './state';
import { createSyntheticTerrain, flatElevation } from './synthetic-terrain';

const KZ = engagementAreaId('KZ');
const E1 = soldierId('E1');
const E2 = soldierId('E2');

/** Two OPFOR soldiers and one BLUEFOR soldier on flat 400 m × 400 m terrain, 2 m/s. */
function scenario(): Scenario {
  const soldier = (id: string, side: Side, x: number, y: number) => ({
    id,
    side,
    unitId: side === 'OPFOR' ? 'EN' : 'TM',
    position: { x, y },
    azimuthDeg: 180,
    posture: 'standing' as const,
  });
  return {
    id: 'areas',
    terrain: createSyntheticTerrain(
      { originX: -200, originY: -200, cellSize: 20, columns: 21, rows: 21 },
      flatElevation(0),
    ),
    movement: { speed: 2, maxTurnRate: Math.PI / 2 },
    units: [
      { id: 'EN', echelon: 'fireTeam', parentId: null, leaderId: null },
      { id: 'TM', echelon: 'fireTeam', parentId: null, leaderId: null },
    ],
    soldiers: [
      soldier('E1', 'OPFOR', 0, 100),
      soldier('E2', 'OPFOR', 6, 100),
      soldier('F1', 'BLUEFOR', -50, 0),
    ],
  };
}

/** A square kill zone, 20 m wide, from y = −10 to y = 10. */
const SQUARE: EngagementArea = {
  id: KZ,
  vertices: [
    { x: -10, y: -10 },
    { x: 10, y: -10 },
    { x: 10, y: 10 },
    { x: -10, y: 10 },
  ],
  monitoredSide: 'OPFOR',
};

function setup(tickRateHz = 10, area: EngagementArea = SQUARE) {
  const sim = createSimulation({ tickRateHz, seed: 0 }, scenario());
  sim.submit({ type: 'setEngagementArea', tick: 0, area });
  return sim;
}

function move(sim: Simulation, id: string, points: [number, number][], tick = sim.tick): void {
  sim.submit({
    type: 'setOrders',
    tick,
    soldierId: soldierId(id),
    orders: {
      waypoints: points.map(([x, y], i) => ({ id: waypointId(`${id}.${String(i)}`), x, y })),
      finalFacing: Math.PI,
    },
  });
}

function runSeconds(sim: Simulation, seconds: number): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < Math.round(seconds * sim.config.tickRateHz); i += 1)
    events.push(...sim.step());
  return events;
}

const entries = (events: readonly SimEvent[]) =>
  events.filter((e) => e.type === 'engagementAreaEntered');

describe('engagement areas', () => {
  it('are set by command, recorded in state and reported', () => {
    const sim = setup();
    expect(sim.step()).toEqual([{ type: 'engagementAreaChanged', tick: 0, area: SQUARE }]);
    expect(sim.state.engagementAreas).toEqual([SQUARE]);
    expect(sim.snapshot().state.engagementAreas).toEqual([SQUARE]);
  });

  it('are replaced by id', () => {
    const sim = setup();
    const moved = { ...SQUARE, vertices: SQUARE.vertices.map((v) => ({ x: v.x + 50, y: v.y })) };
    sim.submit({ type: 'setEngagementArea', tick: 0, area: moved });
    sim.step();
    expect(sim.state.engagementAreas).toEqual([moved]);
  });

  it('reject malformed polygons at submission and areas off the terrain when applied', () => {
    const sim = createSimulation({ tickRateHz: 10, seed: 0 }, scenario());
    const bowTie = {
      ...SQUARE,
      vertices: [SQUARE.vertices[0], SQUARE.vertices[2], SQUARE.vertices[1], SQUARE.vertices[3]],
    } as EngagementArea;
    expect(() => {
      sim.submit({ type: 'setEngagementArea', tick: 0, area: bowTie });
    }).toThrow(RangeError);
    expect(() => {
      sim.submit({
        type: 'setEngagementArea',
        tick: 0,
        area: { ...SQUARE, vertices: SQUARE.vertices.slice(0, 2) },
      });
    }).toThrow(RangeError);
    const offMap = { ...SQUARE, vertices: [...SQUARE.vertices.slice(0, 3), { x: -10, y: 500 }] };
    sim.submit({ type: 'setEngagementArea', tick: 0, area: offMap });
    expect(sim.step()).toEqual([
      expect.objectContaining({ type: 'commandRejected', reason: 'areaOffTerrain' }),
    ]);
    expect(sim.state.engagementAreas).toEqual([]);
  });
});

describe('entry detection', () => {
  it('reports the exact time and place a monitored soldier enters', () => {
    const sim = setup();
    move(sim, 'E1', [[0, -100]]);
    const found = entries(runSeconds(sim, 60));
    // 90 m from (0, 100) to the north edge at y = 10, at 2 m/s.
    expect(found).toEqual([
      {
        type: 'engagementAreaEntered',
        tick: 449,
        areaId: KZ,
        soldierId: E1,
        atSeconds: expect.closeTo(45, 9) as number,
        point: { x: 0, y: expect.closeTo(10, 9) as number },
      },
    ]);
  });

  it('catches a crossing between ticks that end-point sampling would miss', () => {
    // At 1 Hz a soldier covers 2 m per tick; the area is a 0.5 m strip at y = 50.25 … 50.75.
    const strip: EngagementArea = {
      id: KZ,
      monitoredSide: 'OPFOR',
      vertices: [
        { x: -20, y: 50.25 },
        { x: 20, y: 50.25 },
        { x: 20, y: 50.75 },
        { x: -20, y: 50.75 },
      ],
    };
    const sim = setup(1, strip);
    move(sim, 'E1', [[0, 0]]);
    const ends: number[] = [];
    const found: SimEvent[] = [];
    for (let i = 0; i < 40; i += 1) {
      found.push(...entries(sim.step()));
      ends.push(sim.state.soldiers[0]?.position.y ?? Number.NaN);
    }
    expect(ends.some((y) => y >= 50.25 && y <= 50.75)).toBe(false);
    expect(found).toEqual([
      expect.objectContaining({ soldierId: E1, atSeconds: expect.closeTo(49.25 / 2, 9) as number }),
    ]);
  });

  it('ignores soldiers of other sides', () => {
    const sim = setup();
    move(sim, 'F1', [[50, 0]]);
    expect(entries(runSeconds(sim, 60))).toEqual([]);
  });

  it('does not treat a soldier already inside when the area is set as entering, until it leaves and returns', () => {
    const sim = createSimulation({ tickRateHz: 10, seed: 0 }, scenario());
    move(sim, 'E1', [[0, 0]]);
    runSeconds(sim, 60); // E1 now stands at the centre of where the area will be
    sim.submit({ type: 'setEngagementArea', tick: sim.tick, area: SQUARE });
    move(sim, 'E1', [
      [0, -30],
      [0, 0],
    ]);
    const found = entries(runSeconds(sim, 40));
    // Leaves through y = −10 after 5 s, turns at y = −30 (15 s), re-enters at y = −10 (25 s).
    expect(found).toEqual([
      expect.objectContaining({ soldierId: E1, atSeconds: expect.closeTo(60 + 25, 9) as number }),
    ]);
  });

  it('reports an arrival exactly on the boundary once, at the moment of arrival', () => {
    const sim = setup();
    move(sim, 'E1', [
      [0, 10],
      [0, 50],
    ]);
    const found = entries(runSeconds(sim, 60));
    expect(found).toEqual([
      expect.objectContaining({ atSeconds: expect.closeTo(45, 9) as number }),
    ]);
  });

  it('orders entries within one tick by time, not by soldier order', () => {
    // The north edge rises to the east, so E2 (x = 6) meets it before E1 (x = 0).
    const tilted: EngagementArea = {
      ...SQUARE,
      vertices: [
        { x: -10, y: -10 },
        { x: 10, y: -10 },
        { x: 10, y: 10.6 },
        { x: -10, y: 10 },
      ],
    };
    const sim = setup(1, tilted);
    move(sim, 'E1', [[0, -100]]); // meets the edge at y = 10.3: 44.85 s
    move(sim, 'E2', [[6, -100]]); // meets the edge at y = 10.48: 44.76 s
    const found = entries(runSeconds(sim, 60));
    expect(found.map((e) => [e.tick, e.soldierId, e.atSeconds])).toEqual([
      [44, E2, expect.closeTo(44.76, 9)],
      [44, E1, expect.closeTo(44.85, 9)],
    ]);
  });
});

describe('tick-rate independence of entries', () => {
  function run(tickRateHz: number) {
    const area: EngagementArea = {
      id: KZ,
      monitoredSide: 'OPFOR',
      vertices: [
        { x: -30, y: -5 },
        { x: 25, y: -12 },
        { x: 40, y: 20 },
        { x: 5, y: 8 },
        { x: -20, y: 30 },
      ],
    };
    const sim = setup(tickRateHz, area);
    move(sim, 'E1', [
      [10, 60],
      [-25, 15],
      [30, -40],
      [-60, -60],
    ]);
    move(sim, 'E2', [
      [6, 33.3],
      [37, 33.3],
      [37, -50],
    ]);
    return { found: entries(runSeconds(sim, 120)), hash: hashSimState({ ...sim.state, tick: 0 }) };
  }

  const reference = run(120);

  it('finds several entries in the reference run', () => {
    expect(reference.found.length).toBeGreaterThanOrEqual(3);
  });

  it.each([10, 20, 30, 60, 120])('finds the same entries at the same times at %i Hz', (rate) => {
    const { found } = run(rate);
    expect(found.map((e) => [e.soldierId, e.areaId])).toEqual(
      reference.found.map((e) => [e.soldierId, e.areaId]),
    );
    found.forEach((e, i) => {
      const r = reference.found[i];
      if (!r) throw new Error('missing reference entry');
      expect(Math.abs(e.atSeconds - r.atSeconds)).toBeLessThanOrEqual(1e-6);
      expect(Math.abs(e.point.x - r.point.x)).toBeLessThanOrEqual(1e-6);
      expect(Math.abs(e.point.y - r.point.y)).toBeLessThanOrEqual(1e-6);
      expect(e.atSeconds).toBeGreaterThanOrEqual(e.tick / rate - 1e-9);
      expect(e.atSeconds).toBeLessThanOrEqual((e.tick + 1) / rate + 1e-9);
    });
  });
});
