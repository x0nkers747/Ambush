import { describe, expect, it } from 'vitest';
import type { SimCommand } from './commands';
import { MAX_TICK_RATE_HZ, MIN_TICK_RATE_HZ } from './config';
import { clonePlainData } from './plain-data';
import { createSimulation } from './simulation';
import { soldierId, waypointId, type Orders } from './state';
import { EMPTY_TEST_SCENARIO as EMPTY, TEST_SCENARIO } from './test-scenario';

const SL = soldierId('B-SL');

const ordersTo = (x: number): Orders => ({
  waypoints: [{ id: waypointId('W1'), x, y: 0 }],
  finalFacing: 0,
});

function setOrders(tick: number, x: number, id = SL): SimCommand {
  return { type: 'setOrders', tick, soldierId: id, orders: ordersTo(x) };
}

describe('createSimulation', () => {
  it('starts at tick 0 and time 0', () => {
    const sim = createSimulation({ tickRateHz: 30, seed: 0 }, EMPTY);
    expect(sim.tick).toBe(0);
    expect(sim.timeSeconds).toBe(0);
    expect(sim.state.tick).toBe(0);
  });

  it.each([10, 20, 30, 60])('derives dt and time from the tick count at %i Hz', (tickRateHz) => {
    const sim = createSimulation({ tickRateHz, seed: 0 }, EMPTY);
    expect(sim.dtSeconds).toBe(1 / tickRateHz);

    for (let i = 0; i < tickRateHz * 10; i += 1) sim.step();

    expect(sim.tick).toBe(tickRateHz * 10);
    expect(sim.timeSeconds).toBe(10);
  });

  it('does not share or expose mutable config', () => {
    const config = { tickRateHz: 30, seed: 0 };
    const sim = createSimulation(config, EMPTY);
    config.tickRateHz = 60;
    expect(sim.config.tickRateHz).toBe(30);
    expect(Object.isFrozen(sim.config)).toBe(true);
  });

  it.each([
    0,
    -1,
    MIN_TICK_RATE_HZ - 0.5,
    MAX_TICK_RATE_HZ + 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects tickRateHz = %s', (tickRateHz) => {
    expect(() => createSimulation({ tickRateHz, seed: 0 }, EMPTY)).toThrow(RangeError);
  });

  it('accepts the boundary tick rates', () => {
    expect(() => createSimulation({ tickRateHz: MIN_TICK_RATE_HZ, seed: 0 }, EMPTY)).not.toThrow();
    expect(() => createSimulation({ tickRateHz: MAX_TICK_RATE_HZ, seed: 0 }, EMPTY)).not.toThrow();
  });

  it.each([-1, 1.5, 2 ** 32])('rejects seed = %s', (seed) => {
    expect(() => createSimulation({ tickRateHz: 30, seed }, EMPTY)).toThrow(RangeError);
  });
});

describe('command timing', () => {
  const create = () => createSimulation({ tickRateHz: 10, seed: 0 }, TEST_SCENARIO);
  const ordersOfSL = (sim: ReturnType<typeof create>) =>
    sim.state.soldiers.find((s) => s.id === SL)?.orders?.orders ?? null;

  it('applies a command at the start of its tick, before that tick advances', () => {
    const sim = create();
    sim.submit(setOrders(5, 100));
    for (let i = 0; i < 5; i += 1) {
      expect(sim.step()).toEqual([]);
      expect(ordersOfSL(sim)).toBeNull();
    }
    expect(sim.tick).toBe(5);
    const events = sim.step();
    expect(events).toEqual([
      { type: 'ordersChanged', tick: 5, soldierId: SL, orders: ordersTo(100) },
    ]);
    expect(ordersOfSL(sim)).toEqual(ordersTo(100));
    expect(sim.tick).toBe(6);
  });

  it('applies a command stamped with the current tick on the next step', () => {
    const sim = create();
    sim.step();
    sim.submit(setOrders(1, 7));
    expect(sim.step()[0]?.tick).toBe(1);
  });

  it('clears orders with orders: null', () => {
    const sim = create();
    sim.submit(setOrders(0, 1));
    sim.submit({ type: 'setOrders', tick: 1, soldierId: SL, orders: null });
    sim.step();
    sim.step();
    expect(ordersOfSL(sim)).toBeNull();
  });

  const withOrders = (orders: Partial<Orders>): SimCommand => ({
    type: 'setOrders',
    tick: 4,
    soldierId: SL,
    orders: { ...ordersTo(0), ...orders },
  });
  const wp = (id: string) => ({ id: waypointId(id), x: 0, y: 0 });

  it.each([
    ['in the past', setOrders(2, 0)],
    ['with a fractional tick', setOrders(3.5, 0)],
    ['with a non-finite waypoint', setOrders(4, Number.NaN)],
    ['with duplicate waypoint ids', withOrders({ waypoints: [wp('A'), wp('B'), wp('A')] })],
    ['with an empty waypoint id', withOrders({ waypoints: [wp('')] })],
    ['with a negative final facing', withOrders({ finalFacing: -0.1 })],
    ['with a final facing of 2π', withOrders({ finalFacing: 2 * Math.PI })],
    ['with a non-finite final facing', withOrders({ finalFacing: Number.NaN })],
  ])('rejects a command %s at submission', (_label, command) => {
    const sim = create();
    sim.step();
    sim.step();
    sim.step();
    expect(() => {
      sim.submit(command);
    }).toThrow(RangeError);
  });

  it('rejects orders with a waypoint off the terrain, leaving current orders in place', () => {
    const sim = create();
    sim.submit(setOrders(0, 50));
    const offTerrain = setOrders(1, 100.001);
    sim.submit(offTerrain);
    sim.step();
    expect(sim.step()).toEqual([
      { type: 'commandRejected', tick: 1, command: offTerrain, reason: 'waypointOffTerrain' },
    ]);
    expect(ordersOfSL(sim)).toEqual(ordersTo(50));
  });

  it('reports a command for an unknown soldier as rejected without changing state', () => {
    const sim = create();
    const command = setOrders(0, 1, soldierId('NOBODY'));
    sim.submit(command);
    const before = clonePlainData(sim.state.soldiers);
    expect(sim.step()).toEqual([
      { type: 'commandRejected', tick: 0, command, reason: 'unknownSoldier' },
    ]);
    expect(sim.state.soldiers).toEqual(before);
  });

  it('copies submitted commands so later caller mutation has no effect', () => {
    const sim = create();
    const command = {
      type: 'setOrders' as const,
      tick: 0,
      soldierId: SL,
      orders: { waypoints: [{ id: waypointId('W1'), x: 1, y: 2 }], finalFacing: 0 },
    };
    sim.submit(command);
    command.orders.waypoints[0] = { id: waypointId('W1'), x: 99, y: 99 };
    sim.step();
    expect(ordersOfSL(sim)).toEqual({
      waypoints: [{ id: waypointId('W1'), x: 1, y: 2 }],
      finalFacing: 0,
    });
  });
});

describe('command ordering', () => {
  const create = () => createSimulation({ tickRateHz: 10, seed: 0 }, TEST_SCENARIO);

  it('applies same-tick commands in submission order (the last assignment wins)', () => {
    const sim = create();
    sim.submit(setOrders(0, 1));
    sim.submit(setOrders(0, 2));
    sim.submit(setOrders(0, 3));
    const events = sim.step();
    expect(
      events.map((e) => (e.type === 'ordersChanged' ? e.orders?.waypoints[0]?.x : null)),
    ).toEqual([1, 2, 3]);
    expect(sim.state.soldiers[0]?.orders?.orders.waypoints[0]?.x).toBe(3);
  });

  it('applies commands by tick regardless of the order they were submitted in', () => {
    const sim = create();
    sim.submit(setOrders(3, 30));
    sim.submit(setOrders(1, 10));
    sim.submit(setOrders(2, 20));
    const ticks: number[] = [];
    for (let i = 0; i < 4; i += 1) for (const e of sim.step()) ticks.push(e.tick);
    expect(ticks).toEqual([1, 2, 3]);
    expect(sim.state.soldiers[0]?.orders?.orders.waypoints[0]?.x).toBe(30);
  });

  it('gives the same result for the same submissions, interleaving soldiers and ticks', () => {
    const run = () => {
      const sim = create();
      const ids = ['B-SL', 'O-R', 'B-A-TL', 'O-TL'].map(soldierId);
      for (let i = 0; i < 20; i += 1) sim.submit(setOrders(i % 4, i, ids[i % ids.length]));
      const events = [];
      for (let i = 0; i < 5; i += 1) events.push(...sim.step());
      return { events, state: sim.state };
    };
    expect(run()).toEqual(run());
  });
});
