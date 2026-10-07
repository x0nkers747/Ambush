import { describe, expect, it } from 'vitest';
import type { SimCommand } from './commands';
import type { SimEvent } from './events';
import { fingerprintWorld, hashSimState } from './hash';
import { clonePlainData } from './plain-data';
import type { Scenario } from './scenario';
import { createSimulation, type SimSnapshot, type Simulation } from './simulation';
import { soldierId, waypointId } from './state';
import { TEST_SCENARIO } from './test-scenario';

// Determinism and snapshot/restore of the whole kernel. Tick-rate independence
// is tested in movement-tick-rate.test.ts.

/** A command script authored in simulation seconds, converted to ticks per tick rate. */
const SCRIPT: readonly {
  atSeconds: number;
  soldier: string;
  waypoints: [number, number][] | null;
}[] = [
  { atSeconds: 0, soldier: 'B-SL', waypoints: [[0, 50]] },
  {
    atSeconds: 0,
    soldier: 'B-A-TL',
    waypoints: [
      [-10, 40],
      [-20, 60],
    ],
  },
  { atSeconds: 0.5, soldier: 'O-TL', waypoints: [[0, 0]] },
  { atSeconds: 1.5, soldier: 'B-SL', waypoints: [[5, 55]] },
  { atSeconds: 1.5, soldier: 'GHOST', waypoints: null },
  { atSeconds: 2, soldier: 'B-A-TL', waypoints: null },
];

function commandsAt(tickRateHz: number): SimCommand[] {
  return SCRIPT.map(({ atSeconds, soldier, waypoints }) => {
    const tick = atSeconds * tickRateHz;
    if (!Number.isInteger(tick))
      throw new Error(`${String(atSeconds)} s is not a whole tick at ${String(tickRateHz)} Hz`);
    return {
      type: 'setOrders',
      tick,
      soldierId: soldierId(soldier),
      orders: waypoints && {
        waypoints: waypoints.map(([x, y], i) => ({ id: waypointId(`W${String(i)}`), x, y })),
        finalFacing: Math.PI / 2,
      },
    };
  });
}

function runFor(sim: Simulation, ticks: number): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < ticks; i += 1) events.push(...sim.step());
  return events;
}

function scriptedRun(seed: number, tickRateHz = 30, seconds = 3) {
  const sim = createSimulation({ tickRateHz, seed }, TEST_SCENARIO);
  for (const command of commandsAt(tickRateHz)) sim.submit(command);
  const events = runFor(sim, seconds * tickRateHz);
  return { sim, events, hash: hashSimState(sim.state) };
}

describe('determinism', () => {
  it('produces identical state, hash and events for identical scenario, seed and commands', () => {
    const a = scriptedRun(1234);
    const b = scriptedRun(1234);
    expect(b.sim.state).toEqual(a.sim.state);
    expect(b.events).toEqual(a.events);
    expect(b.hash).toBe(a.hash);
  });

  it('produces a different state hash for a different seed', () => {
    expect(scriptedRun(1).hash).not.toBe(scriptedRun(2).hash);
  });

  it('changes the hash when any command changes', () => {
    const sim = createSimulation({ tickRateHz: 30, seed: 1234 }, TEST_SCENARIO);
    for (const command of commandsAt(30)) sim.submit(command);
    sim.submit({
      type: 'setOrders',
      tick: 89,
      soldierId: soldierId('O-R'),
      orders: { waypoints: [], finalFacing: 0 },
    });
    runFor(sim, 90);
    expect(hashSimState(sim.state)).not.toBe(scriptedRun(1234).hash);
  });

  it('pins the state hash of the test scenario (update deliberately when state changes)', () => {
    const initial = createSimulation({ tickRateHz: 30, seed: 1234 }, TEST_SCENARIO);
    expect(hashSimState(initial.state)).toBe(PINNED_INITIAL_HASH);
    expect(scriptedRun(1234).hash).toBe(PINNED_SCRIPTED_HASH);
  });
});

describe('snapshot and restore', () => {
  it('snapshot → advance → restore → same commands → identical result', () => {
    const sim = createSimulation({ tickRateHz: 30, seed: 99 }, TEST_SCENARIO);
    const commands = commandsAt(30);
    const early = commands.filter((c) => c.tick < 30);
    const late = commands.filter((c) => c.tick >= 30);

    for (const command of early) sim.submit(command);
    runFor(sim, 30);
    const snapshot = sim.snapshot();
    const snapshotHash = hashSimState(snapshot.state);

    for (const command of late) sim.submit(command);
    const firstEvents = runFor(sim, 60);
    const firstHash = hashSimState(sim.state);

    sim.restore(snapshot);
    expect(sim.tick).toBe(30);
    expect(hashSimState(sim.state)).toBe(snapshotHash);

    for (const command of late) sim.submit(command);
    expect(runFor(sim, 60)).toEqual(firstEvents);
    expect(hashSimState(sim.state)).toBe(firstHash);
    expect(firstHash).toBe(scriptedRun(99).hash);
  });

  it('can restore the same snapshot repeatedly, unaffected by later steps', () => {
    const sim = createSimulation({ tickRateHz: 30, seed: 5 }, TEST_SCENARIO);
    const snapshot = sim.snapshot();
    const hash = hashSimState(snapshot.state);
    for (let round = 0; round < 3; round += 1) {
      sim.submit({ type: 'setOrders', tick: sim.tick, soldierId: soldierId('B-SL'), orders: null });
      runFor(sim, 10);
      expect(hashSimState(snapshot.state)).toBe(hash);
      sim.restore(snapshot);
      expect(hashSimState(sim.state)).toBe(hash);
    }
  });

  it('discards pending commands on restore', () => {
    const sim = createSimulation({ tickRateHz: 30, seed: 5 }, TEST_SCENARIO);
    const snapshot = sim.snapshot();
    sim.submit({ type: 'setOrders', tick: 5, soldierId: soldierId('B-SL'), orders: null });
    sim.restore(snapshot);
    expect(runFor(sim, 10)).toEqual([]);
  });

  it('produces a snapshot that is plain data independent of the live state', () => {
    const sim = createSimulation({ tickRateHz: 30, seed: 5 }, TEST_SCENARIO);
    const snapshot = sim.snapshot();
    expect(snapshot.state).not.toBe(sim.state);
    expect(clonePlainData(snapshot)).toEqual(snapshot);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it('restores into a fresh simulation with the same tick rate', () => {
    const { sim } = scriptedRun(7);
    const other = createSimulation({ tickRateHz: 30, seed: 0 }, TEST_SCENARIO);
    other.restore(sim.snapshot());
    expect(hashSimState(other.state)).toBe(hashSimState(sim.state));
  });

  it('rejects a snapshot taken at a different tick rate', () => {
    const snapshot = createSimulation({ tickRateHz: 30, seed: 0 }, TEST_SCENARIO).snapshot();
    const other = createSimulation({ tickRateHz: 60, seed: 0 }, TEST_SCENARIO);
    expect(() => {
      other.restore(snapshot);
    }).toThrow(RangeError);
  });
});

describe('snapshot world compatibility', () => {
  const { terrain } = TEST_SCENARIO;
  const elevations = [...terrain.heightfield.elevations];
  elevations[123] = (elevations[123] ?? 0) + 0.01;

  /** A snapshot of the test scenario taken while soldiers are moving. */
  function movingSnapshot() {
    const { sim } = scriptedRun(5, 30, 1);
    return { sim, snapshot: sim.snapshot() };
  }

  function restoreInto(scenario: Scenario, snapshot: SimSnapshot): Simulation {
    const sim = createSimulation({ tickRateHz: 30, seed: 0 }, scenario);
    sim.restore(snapshot);
    return sim;
  }

  it('carries the fingerprint computed when the simulation was created', () => {
    const { sim, snapshot } = movingSnapshot();
    expect(snapshot.worldFingerprint).toBe(sim.worldFingerprint);
    expect(sim.worldFingerprint).toBe(fingerprintWorld(sim.world));
    expect(sim.worldFingerprint).toBe(PINNED_TEST_WORLD_FINGERPRINT);
    expect(JSON.stringify(snapshot)).not.toContain('"elevations"');
  });

  it('restores into a simulation of an equal but separately built world', () => {
    const { sim, snapshot } = movingSnapshot();
    const copy = clonePlainData({ ...TEST_SCENARIO, terrain, movement: TEST_SCENARIO.movement });
    const other = restoreInto(copy, snapshot);
    expect(other.worldFingerprint).toBe(sim.worldFingerprint);
    expect(hashSimState(other.state)).toBe(hashSimState(sim.state));
    // Seed and initial soldiers are not part of the world: the snapshot replaces them.
    const reseeded = createSimulation({ tickRateHz: 30, seed: 99 }, TEST_SCENARIO);
    reseeded.restore(snapshot);
    expect(hashSimState(reseeded.state)).toBe(hashSimState(sim.state));
  });

  it.each<[string, Scenario]>([
    [
      'one terrain elevation',
      {
        ...TEST_SCENARIO,
        terrain: { ...terrain, heightfield: { ...terrain.heightfield, elevations } },
      },
    ],
    [
      'the terrain origin',
      {
        ...TEST_SCENARIO,
        terrain: { ...terrain, heightfield: { ...terrain.heightfield, originX: -101 } },
      },
    ],
    [
      'the terrain georeference',
      {
        ...TEST_SCENARIO,
        terrain: {
          ...terrain,
          georef: {
            crs: 'EPSG:32633',
            falseEasting: 500000,
            falseNorthing: 0,
            verticalDatum: 'EGM2008',
          },
        },
      },
    ],
    [
      'the movement speed',
      { ...TEST_SCENARIO, movement: { ...TEST_SCENARIO.movement, speed: 1.6 } },
    ],
    [
      'the maximum turn rate',
      { ...TEST_SCENARIO, movement: { ...TEST_SCENARIO.movement, maxTurnRate: 1 } },
    ],
  ])('refuses to restore into a world with a different %s', (_label, changed) => {
    const { sim, snapshot } = movingSnapshot();
    const other = createSimulation({ tickRateHz: 30, seed: 0 }, changed);
    expect(other.worldFingerprint).not.toBe(sim.worldFingerprint);
    const before = hashSimState(other.state);
    expect(() => {
      other.restore(snapshot);
    }).toThrow(/different world/);
    expect(hashSimState(other.state)).toBe(before);
  });
});

const PINNED_INITIAL_HASH = '18235a8ab57f44c1';
const PINNED_SCRIPTED_HASH = 'b8a396b56b4fa8c0';
const PINNED_TEST_WORLD_FINGERPRINT = '703a0d35e7aa6b71';
