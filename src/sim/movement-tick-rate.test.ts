import { describe, expect, it } from 'vitest';
import type { SimCommand } from './commands';
import type { SimEvent } from './events';
import { azimuthDelta } from './geometry';
import { createSimulation } from './simulation';
import { soldierId, waypointId, type DeepReadonly, type Soldier } from './state';
import { TEST_SCENARIO } from './test-scenario';

// Movement must depend on simulation time, not on the tick rate (docs/adr/0003,
// docs/adr/0008). The same orders over the ridge terrain of the test scenario
// are run at each rate and compared with the 120 Hz run every 0.1 s of
// simulation time (a whole number of ticks at every rate).

const RATES = [10, 20, 30, 60, 120] as const;
const REFERENCE_RATE = 120;
const DURATION_SECONDS = 240;
const SAMPLE_SECONDS = 0.1;

/**
 * Tolerances. The movement algorithm is exact in real arithmetic: legs are
 * straight, every arrival splits the tick, and turns are clamped exactly. The
 * only differences between rates are floating-point rounding, which grows with
 * the number of ticks, and the 1e-9 s completion epsilon. Measured over this
 * 240 s script: below 5e-11 m, 5e-11 rad and 3e-11 s at every rate.
 */
const POSITION_TOLERANCE_M = 1e-6;
const AZIMUTH_TOLERANCE_RAD = 1e-6;
const TIME_TOLERANCE_S = 1e-6;

type Route = [number, number][];
interface ScriptEntry {
  atSeconds: number;
  soldier: string;
  route: Route | null;
  finalFacingDeg?: number;
}

const SCRIPT: ScriptEntry[] = [
  // Over the ridge (crest y = 100) and down the far side.
  {
    atSeconds: 0,
    soldier: 'B-SL',
    route: [
      [0, 40],
      [0, 100],
      [10, 160],
    ],
    finalFacingDeg: 180,
  },
  // A cluster of waypoints centimetres apart: several are reached within one tick at low rates.
  {
    atSeconds: 0,
    soldier: 'B-A-TL',
    route: [
      [-10, 6],
      [-10.02, 6.03],
      [-9.98, 6.05],
      [-10, 6.1],
      [-10, 6.1],
      [-30, 90],
    ],
    finalFacingDeg: 45,
  },
  // No waypoints: turn in place.
  { atSeconds: 0, soldier: 'B-A-AR', route: [], finalFacingDeg: 90 },
  // Replaced mid-leg at 4.0 s.
  {
    atSeconds: 0,
    soldier: 'B-B-TL',
    route: [
      [60, 80],
      [80, 150],
    ],
    finalFacingDeg: 0,
  },
  {
    atSeconds: 4,
    soldier: 'B-B-TL',
    route: [
      [-40, 20],
      [-40, 120],
    ],
    finalFacingDeg: 270,
  },
  // Cleared mid-leg at 6.3 s.
  { atSeconds: 0, soldier: 'B-B-R', route: [[15, 60]], finalFacingDeg: 0 },
  { atSeconds: 6.3, soldier: 'B-B-R', route: null },
  // Starts on its first waypoint, then reverses its facing (an exact 180° turn).
  { atSeconds: 2.5, soldier: 'O-TL', route: [[0, 200]], finalFacingDeg: 0 },
  // Zig-zag across the ridge with sharp turns.
  {
    atSeconds: 1.2,
    soldier: 'O-R',
    route: [
      [20, 180],
      [-20, 160],
      [20, 130],
      [-20, 100],
      [20, 70],
      [0, 40],
    ],
    finalFacingDeg: 200,
  },
];

function commandsAt(tickRateHz: number): SimCommand[] {
  return SCRIPT.map(({ atSeconds, soldier, route, finalFacingDeg = 0 }) => {
    const exactTick = atSeconds * tickRateHz;
    const tick = Math.round(exactTick);
    if (Math.abs(tick - exactTick) > 1e-9)
      throw new Error(`${String(atSeconds)} s is not a whole tick`);
    return {
      type: 'setOrders',
      tick,
      soldierId: soldierId(soldier),
      orders: route && {
        waypoints: route.map(([x, y], i) => ({ id: waypointId(`${soldier}-${String(i)}`), x, y })),
        finalFacing: (finalFacingDeg * Math.PI) / 180,
      },
    };
  });
}

interface Run {
  /** Soldier states every SAMPLE_SECONDS. */
  samples: DeepReadonly<Soldier[]>[];
  events: SimEvent[];
}

function run(tickRateHz: number): Run {
  const sim = createSimulation({ tickRateHz, seed: 0 }, TEST_SCENARIO);
  for (const command of commandsAt(tickRateHz)) sim.submit(command);
  const ticksPerSample = Math.round(SAMPLE_SECONDS * tickRateHz);
  const samples: DeepReadonly<Soldier[]>[] = [structuredCopy(sim.state.soldiers)];
  const events: SimEvent[] = [];
  for (let s = 0; s < DURATION_SECONDS / SAMPLE_SECONDS; s += 1) {
    for (let t = 0; t < ticksPerSample; t += 1) events.push(...sim.step());
    samples.push(structuredCopy(sim.state.soldiers));
  }
  return { samples, events };
}

function structuredCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Simulation time of an event: exact for movement events, the tick start for the others. */
function eventSeconds(event: SimEvent, tickRateHz: number): number {
  return 'atSeconds' in event ? event.atSeconds : event.tick / tickRateHz;
}

/** An event without its tick-rate-dependent fields (tick, exact time, command tick). */
function eventIdentity(event: SimEvent): string {
  return JSON.stringify({ ...event, tick: null, atSeconds: null, command: null });
}

function bySoldier(events: SimEvent[]): Map<string, SimEvent[]> {
  const groups = new Map<string, SimEvent[]>();
  for (const event of events) {
    const id =
      'soldierId' in event
        ? event.soldierId
        : event.type === 'commandRejected' && event.command.type === 'setOrders'
          ? event.command.soldierId
          : '';
    groups.set(id, [...(groups.get(id) ?? []), event]);
  }
  return groups;
}

const reference = run(REFERENCE_RATE);

describe('tick-rate independence of movement', () => {
  it('exercises every behavior in the reference run', () => {
    const final = reference.samples.at(-1) ?? [];
    expect(final.map((s) => [s.id, s.orders?.behavior ?? 'idle'])).toEqual([
      ['B-SL', 'inPosition'],
      ['B-A-TL', 'inPosition'],
      ['B-A-AR', 'inPosition'],
      ['B-B-TL', 'inPosition'],
      ['B-B-R', 'idle'],
      ['O-TL', 'inPosition'],
      ['O-R', 'inPosition'],
    ]);
    const types = new Set(reference.events.map((e) => e.type));
    expect([...types].sort()).toEqual(['ordersChanged', 'soldierInPosition', 'waypointReached']);
    // Several waypoints within one 10 Hz tick (0.1 s, 0.15 m) in the B-A-TL cluster.
    const low = run(10).events.filter((e) => e.type === 'waypointReached');
    const perTick = new Map<number, number>();
    for (const e of low) perTick.set(e.tick, (perTick.get(e.tick) ?? 0) + 1);
    expect(Math.max(...perTick.values())).toBeGreaterThanOrEqual(3);
  });

  it.each(RATES)('matches the %i Hz run with the 120 Hz run in simulation time', (tickRateHz) => {
    const { samples, events } = run(tickRateHz);
    expect(samples).toHaveLength(reference.samples.length);

    let maxPosition = 0;
    let maxAzimuth = 0;
    samples.forEach((soldiers, i) => {
      soldiers.forEach((s, j) => {
        const r = reference.samples[i]?.[j];
        if (!r) throw new Error('missing reference sample');
        maxPosition = Math.max(
          maxPosition,
          Math.abs(s.position.x - r.position.x),
          Math.abs(s.position.y - r.position.y),
          Math.abs(s.position.z - r.position.z),
        );
        maxAzimuth = Math.max(maxAzimuth, Math.abs(azimuthDelta(s.azimuth, r.azimuth)));
        // Discrete state agrees except within the time tolerance of a transition.
        if (
          s.orders?.behavior !== r.orders?.behavior ||
          s.orders?.nextWaypointIndex !== r.orders?.nextWaypointIndex
        ) {
          const t = i * SAMPLE_SECONDS;
          const nearTransition = reference.events.some(
            (e) => 'atSeconds' in e && Math.abs(e.atSeconds - t) <= TIME_TOLERANCE_S,
          );
          expect(nearTransition, `${s.id} at ${String(t)} s`).toBe(true);
        }
      });
    });
    expect(maxPosition).toBeLessThanOrEqual(POSITION_TOLERANCE_M);
    expect(maxAzimuth).toBeLessThanOrEqual(AZIMUTH_TOLERANCE_RAD);

    // Same events per soldier, in the same order, at the same simulation times.
    const mine = bySoldier(events);
    const theirs = bySoldier(reference.events);
    expect([...mine.keys()].sort()).toEqual([...theirs.keys()].sort());
    let maxTime = 0;
    for (const [id, list] of mine) {
      const ref = theirs.get(id) ?? [];
      expect(list.map(eventIdentity)).toEqual(ref.map(eventIdentity));
      list.forEach((e, k) => {
        const r = ref[k];
        if (!r) return;
        maxTime = Math.max(
          maxTime,
          Math.abs(eventSeconds(e, tickRateHz) - eventSeconds(r, REFERENCE_RATE)),
        );
        // The event happened within the tick that reported it.
        const t = eventSeconds(e, tickRateHz);
        expect(t).toBeGreaterThanOrEqual(e.tick / tickRateHz - 1e-12);
        expect(t).toBeLessThanOrEqual((e.tick + 1) / tickRateHz + 1e-12);
      });
    }
    expect(maxTime).toBeLessThanOrEqual(TIME_TOLERANCE_S);
  });
});
