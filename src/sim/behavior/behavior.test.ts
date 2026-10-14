import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../events';
import { hashSimState } from '../hash';
import { canonicalEncode } from '../plain-data';
import type { Scenario } from '../scenario';
import { createSimulation, type Simulation } from '../simulation';
import { orgUnitId, soldierId, waypointId, type SimState } from '../state';
import { behaviorDiagnostics } from './diagnostics';
import { flattenFormation } from './formation-spec';
import { buildGroupRoute, routeAt, routePoint } from './route';
import {
  block,
  flatTerrain,
  squadScenario,
  squadWedge,
  teamScenario,
  teamWedge3,
} from './test-fixtures';
import type { FormationSpec, UnitOrder } from './types';

// Unit tasks (docs/behavior-lab/03): the route, the orderUnit command and
// its rules, the movement of a squad in a hand-made wedge, and determinism:
// repeatability, tick-rate equality, snapshot/restore.

const SQD = orgUnitId('SQD');

function order(
  destination: { x: number; y: number },
  formation: FormationSpec = squadWedge(),
  extra: Partial<UnitOrder> = {},
): UnitOrder {
  return { kind: 'moveInFormation', destination, formation, pace: 1.4, ...extra };
}

function run(sim: Simulation, seconds: number, until?: (e: SimEvent) => boolean): SimEvent[] {
  const events: SimEvent[] = [];
  const ticks = Math.round(seconds * sim.config.tickRateHz);
  for (let i = 0; i < ticks; i += 1) {
    const step = sim.step();
    events.push(...step);
    if (until && step.some(until)) break;
  }
  return events;
}

const ended = (e: SimEvent) => e.type === 'unitTaskEnded';

function squadSim(rate = 30, scenario: Scenario = squadScenario()) {
  return createSimulation({ tickRateHz: rate, seed: 1 }, scenario);
}

describe('group route', () => {
  const terrain = flatTerrain();

  it('is straight between two points, with arc length and tangent', () => {
    const route = buildGroupRoute(
      terrain,
      [
        { x: 0, y: 0 },
        { x: 0, y: 100 },
      ],
      20,
    );
    expect(route.length).toBe(100);
    const p = routeAt(route, 40, routePoint());
    expect([p.x, p.y, p.tx, p.ty, p.k]).toEqual([0, 40, 0, 1, 0]);
    // Beyond the ends it goes on straight.
    expect(routeAt(route, -10, routePoint()).y).toBe(-10);
    expect(routeAt(route, 110, routePoint()).y).toBe(110);
  });

  it('rounds a right-angle corner to the radius, turning right with positive curvature', () => {
    const route = buildGroupRoute(
      terrain,
      [
        { x: 0, y: 0 },
        { x: 0, y: 150 },
        { x: 150, y: 150 },
      ],
      20,
    );
    // Two 130 m straights and a quarter circle of radius 20 m.
    expect(route.length).toBeCloseTo(260 + (Math.PI / 2) * 20, 1);
    const mid = routeAt(route, 130 + (Math.PI / 4) * 20, routePoint());
    expect(mid.k).toBeCloseTo(1 / 20, 9);
    expect(Math.hypot(mid.x - 20, mid.y - 130)).toBeCloseTo(20, 1);
    // The tangent turns continuously: no step larger than one arc step.
    let last = routeAt(route, 0, routePoint());
    for (let s = 0.5; s <= route.length; s += 0.5) {
      const p = routeAt(route, s, routePoint());
      expect(Math.acos(Math.min(1, p.tx * last.tx + p.ty * last.ty))).toBeLessThan(0.1);
      last = p;
    }
  });

  it('shortens a corner to fit short pieces, and keeps it sharp where an arc would hit a building', () => {
    const short = buildGroupRoute(
      terrain,
      [
        { x: 0, y: 0 },
        { x: 0, y: 10 },
        { x: 10, y: 10 },
      ],
      50,
    );
    expect(short.length).toBeLessThan(20);
    expect(Math.max(...short.k)).toBeGreaterThan(0);
    // A building inside the corner: the rounded arc would cut through it.
    const blocked = flatTerrain(block('B', 6, 144));
    const sharp = buildGroupRoute(
      blocked,
      [
        { x: -20, y: 0 },
        { x: -20, y: 160 },
        { x: 150, y: 160 },
      ],
      60,
    );
    expect(sharp.k.every((k) => Math.abs(k) < 1 / 3.6)).toBe(true);
  });
});

describe('formation spec', () => {
  it('sums nested offsets into one slot table', () => {
    const flat = flattenFormation(squadWedge(10, 20));
    expect(flat.slotIds).toHaveLength(13);
    const i = flat.indexOf.get('FT3.AR') ?? -1;
    expect([flat.back[i], flat.right[i]]).toEqual([27, 20]);
    expect(flat.soldierIds[i]).toBe('M11');
  });
});

describe('orderUnit', () => {
  it('moves a 13-Marine squad 300 m in a wedge and stops cleanly in position', () => {
    const sim = squadSim();
    sim.submit({ type: 'orderUnit', tick: 0, unitId: SQD, order: order({ x: 0, y: 300 }) });
    let maxSpeed = 0;
    let moving = 0;
    let errorSum = 0;
    const phases: string[] = [];
    for (let i = 0; i < 30 * 400; i += 1) {
      const events = sim.step();
      for (const e of events) if (e.type === 'unitPhaseChanged') phases.push(e.phase);
      const behavior = sim.state.behavior;
      for (const a of behavior?.agents ?? []) maxSpeed = Math.max(maxSpeed, Math.hypot(a.vx, a.vy));
      const task = behavior?.tasks[0];
      if (task?.phase === 'moving' && task.anchorS > 30 && i % 30 === 0) {
        const d = behaviorDiagnostics(sim.state, sim.world, sim.timeSeconds);
        for (const a of d.agents) errorSum += a.desire.error;
        moving += d.agents.length;
      }
      if (events.some(ended)) break;
    }
    const task = sim.state.behavior?.tasks[0];
    expect(phases).toEqual(['moving', 'settling']);
    expect(task?.phase).toBe('complete');
    expect(task?.outcome).toBe('arrived');
    // Within the catch-up limit, never faster.
    expect(maxSpeed).toBeLessThanOrEqual(1.3 * 1.4 + 1e-9);
    // Steady formation error on open ground: a few centimetres.
    expect(errorSum / moving).toBeLessThan(0.5);
    // Every Marine stopped within the latch radius of his final slot, facing north.
    const d = behaviorDiagnostics(sim.state, sim.world, sim.timeSeconds);
    for (const a of d.agents) {
      expect(a.desire.error).toBeLessThanOrEqual(1);
      expect(a.speed).toBe(0);
    }
    // About 300 m at 1.4 m/s, plus forming and settling.
    expect(sim.timeSeconds).toBeLessThan(300 / 1.4 + 60);
    // The motion is written to the soldiers: the squad's centre is at the destination.
    const xs = sim.state.soldiers.map((s) => s.position.x);
    const ys = sim.state.soldiers.map((s) => s.position.y);
    expect(xs.reduce((a, b) => a + b) / 13).toBeCloseTo(0, 0);
    expect(ys.reduce((a, b) => a + b) / 13).toBeCloseTo(300, 0);
    for (const s of sim.state.soldiers) expect(s.position.z).toBe(10);
  }, 30_000);

  it('moves a 3-Marine element', () => {
    const sim = createSimulation({ tickRateHz: 30, seed: 1 }, teamScenario());
    sim.submit({
      type: 'orderUnit',
      tick: 0,
      unitId: orgUnitId('TM'),
      order: order({ x: 50, y: 150 }, teamWedge3()),
    });
    run(sim, 300, ended);
    expect(sim.state.behavior?.tasks[0]?.outcome).toBe('arrived');
  });

  it('rejects unknown units, foreign soldiers, and destinations off the map or in buildings', () => {
    const sim = squadSim(30, squadScenario({ features: block('B', 0, 200) }));
    const reasons = (unitId: string, o: UnitOrder) => {
      sim.submit({ type: 'orderUnit', tick: sim.tick, unitId: orgUnitId(unitId), order: o });
      return sim.step().flatMap((e) => (e.type === 'commandRejected' ? [e.reason] : []));
    };
    expect(reasons('NOPE', order({ x: 0, y: 100 }))).toEqual(['unknownUnit']);
    // FT1's formation may not hold squad members outside FT1.
    const foreign = squadWedge();
    expect(
      reasons('FT1', {
        ...order({ x: 0, y: 100 }),
        formation: { ...foreign, root: { ...foreign.root, unitId: orgUnitId('FT1') } },
      }),
    ).toEqual(['formationMismatch']);
    expect(reasons('SQD', order({ x: 0, y: 5000 }))).toEqual(['destinationOffTerrain']);
    expect(reasons('SQD', order({ x: 0, y: 200 }))).toEqual(['destinationBlocked']);
    expect(sim.state.behavior).toBeUndefined();
    expect(() => {
      sim.submit({
        type: 'orderUnit',
        tick: sim.tick,
        unitId: SQD,
        order: order({ x: Number.NaN, y: 0 }),
      });
    }).toThrow(RangeError);
  });

  it('releases a Marine given individual orders; the rest of the squad carries on and arrives', () => {
    const sim = squadSim();
    sim.submit({ type: 'orderUnit', tick: 0, unitId: SQD, order: order({ x: 0, y: 200 }) });
    sim.submit({
      type: 'setOrders',
      tick: 600,
      soldierId: soldierId('M07'),
      orders: { waypoints: [{ id: waypointId('W'), x: 100, y: 0 }], finalFacing: 0 },
    });
    const events = run(sim, 400, ended);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'memberReleased',
        soldierId: 'M07',
        reason: 'individualOrders',
      }),
    );
    const behavior = sim.state.behavior;
    expect(behavior?.agents.map((a) => a.soldierId)).not.toContain('M07');
    expect(behavior?.tasks[0]?.outcome).toBe('arrived');
    // He follows his own orders.
    expect(sim.state.soldiers.find((s) => s.id === 'M07')?.orders).not.toBeNull();
  }, 30_000);

  it('releases an incapacitated Marine without blocking the squad', () => {
    const sim = squadSim();
    sim.submit({ type: 'orderUnit', tick: 0, unitId: SQD, order: order({ x: 0, y: 150 }) });
    run(sim, 30);
    const m = (sim.state as SimState).soldiers.find((s) => s.id === 'M05');
    if (m) m.status = 'incapacitated';
    const events = run(sim, 300, ended);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'memberReleased',
        soldierId: 'M05',
        reason: 'incapacitated',
      }),
    );
    expect(sim.state.behavior?.tasks[0]?.outcome).toBe('arrived');
  }, 30_000);

  it('replaces a running order (same formation: carries on without stopping) and cancels with null', () => {
    const sim = squadSim();
    sim.submit({ type: 'orderUnit', tick: 0, unitId: SQD, order: order({ x: 0, y: 300 }) });
    run(sim, 60);
    const before = sim.state.behavior?.tasks[0];
    const speed = before?.anchorSpeed ?? 0;
    expect(before?.phase).toBe('moving');
    sim.submit({
      type: 'orderUnit',
      tick: sim.tick,
      unitId: SQD,
      order: order({ x: 200, y: 200 }),
    });
    const events = run(sim, 1 / 30);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'unitTaskEnded', outcome: 'superseded' }),
    );
    const tasks = sim.state.behavior?.tasks ?? [];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.phase).toBe('moving');
    expect(tasks[0]?.anchorSpeed).toBeCloseTo(speed, 1);
    // Cancel: the Marines stand where they are, no longer steered.
    sim.submit({ type: 'orderUnit', tick: sim.tick, unitId: SQD, order: null });
    const cancel = run(sim, 1 / 30);
    expect(cancel).toContainEqual(
      expect.objectContaining({ type: 'unitTaskEnded', outcome: 'cancelled' }),
    );
    expect(sim.state.behavior?.agents).toHaveLength(0);
    const at = sim.state.soldiers.map((s) => [s.position.x, s.position.y]);
    run(sim, 2);
    expect(sim.state.soldiers.map((s) => [s.position.x, s.position.y])).toEqual(at);
  }, 30_000);

  it('takes a fire team out of the squad task when the team is ordered separately', () => {
    const sim = squadSim();
    sim.submit({ type: 'orderUnit', tick: 0, unitId: SQD, order: order({ x: 0, y: 200 }) });
    run(sim, 30);
    const ft1: FormationSpec = {
      interval: 10,
      root: { ...squadWedge().root.children[0], back: 0, right: 0 } as FormationSpec['root'],
    };
    sim.submit({
      type: 'orderUnit',
      tick: sim.tick,
      unitId: orgUnitId('FT1'),
      order: order({ x: -100, y: 50 }, ft1),
    });
    const events = run(sim, 1 / 30);
    expect(
      events.filter((e) => e.type === 'memberReleased' && e.reason === 'reordered'),
    ).toHaveLength(4);
    const tasks = sim.state.behavior?.tasks ?? [];
    expect(tasks.map((t) => [t.unitId, t.phase])).toEqual([
      ['SQD', 'moving'],
      ['FT1', 'forming'],
    ]);
    run(sim, 400, (e) => e.type === 'unitTaskEnded' && e.unitId === 'SQD');
    expect(sim.state.behavior?.tasks.find((t) => t.unitId === 'SQD')?.outcome).toBe('arrived');
  }, 30_000);

  it('passes through route points (a 90° turn) and leaves soldiers without unit orders alone', () => {
    const sim = squadSim();
    sim.submit({
      type: 'orderUnit',
      tick: 0,
      unitId: SQD,
      order: order({ x: 150, y: 150 }, squadWedge(), { via: [{ x: 0, y: 150 }] }),
    });
    run(sim, 500, ended);
    const task = sim.state.behavior?.tasks[0];
    expect(task?.outcome).toBe('arrived');
    expect(task?.finalFacing).toBeCloseTo(Math.PI / 2, 9);
  }, 30_000);
});

/** The squad's soldiers and behaviour state, encoded exactly (every bit of every number). */
function exact(sim: Simulation): string {
  return canonicalEncode({ soldiers: sim.state.soldiers, behavior: sim.state.behavior });
}

function scripted(rate: number, seconds: number): Simulation {
  const sim = squadSim(rate);
  sim.submit({
    type: 'orderUnit',
    tick: 0,
    unitId: SQD,
    order: order({ x: 150, y: 150 }, squadWedge(), { via: [{ x: 0, y: 150 }] }),
  });
  run(sim, seconds);
  return sim;
}

describe('unit movement determinism', () => {
  it('repeats exactly', () => {
    expect(hashSimState(scripted(30, 120).state)).toBe(hashSimState(scripted(30, 120).state));
  });

  it('is bit-identical at 10, 30, 60 and 120 Hz (rates dividing the 120 Hz substep)', () => {
    const reference = exact(scripted(120, 90));
    for (const rate of [10, 30, 60]) expect(exact(scripted(rate, 90))).toBe(reference);
  }, 60_000);

  it('agrees within millimetres at a rate that does not divide 120 Hz', () => {
    const a = scripted(50, 90).state.soldiers;
    const b = scripted(60, 90).state.soldiers;
    a.forEach((s, i) => {
      const t = b[i];
      expect(
        Math.hypot(s.position.x - (t?.position.x ?? 0), s.position.y - (t?.position.y ?? 0)),
      ).toBeLessThan(0.05);
    });
  }, 60_000);

  it('continues identically after snapshot and restore mid-move', () => {
    const whole = scripted(30, 120);
    const first = scripted(30, 60);
    const snapshot = first.snapshot();
    const resumed = squadSim(30);
    resumed.restore(snapshot);
    run(resumed, 60);
    expect(hashSimState(resumed.state)).toBe(hashSimState(whole.state));
    expect(exact(resumed)).toBe(exact(whole));
  }, 60_000);
});
