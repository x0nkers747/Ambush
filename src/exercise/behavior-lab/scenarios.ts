import type { SimEvent } from '#sim';
import { createMetrics, type LabMetrics, type LabSample } from './metrics';
import { createLabRun, type LabOrganization, type LabRun, type LabRunSpec } from './run';

// The Behavior Lab's scenario suite, first part (docs/behavior-lab/05 §2,
// scenarios 1–5), for any organization. Each is a `LabRunSpec`: the lab
// page offers them, the tests assert their acceptance metrics, the seed
// sweep runs them over many seeds.

export type LabScenarioId =
  's1-straight' | 's2-speeds' | 's3-straggler' | 's4-turn' | 's5-waypoints' | 'fall-in';

export interface LabScenario {
  readonly id: LabScenarioId;
  readonly name: string;
  readonly description: string;
}

export const LAB_SCENARIOS: readonly LabScenario[] = [
  {
    id: 's1-straight',
    name: '1. Straight line',
    description: '300 m north on flat ground.',
  },
  {
    id: 's2-speeds',
    name: '2. Speed and spacing',
    description:
      'As 1, at the chosen pace and interval (the tests run 1.0, 1.4, 1.8 m/s and 5, 10, 15 m).',
  },
  {
    id: 's3-straggler',
    name: '3. Straggler recovery',
    description: 'As 1; one Marine is held for 10 s at T+30 s, then released.',
  },
  {
    id: 's4-turn',
    name: '4. 90° turn',
    description: '150 m north, then 150 m east (one order with a route point).',
  },
  {
    id: 'fall-in',
    name: '6. Falling in (ordered off to the rear)',
    description:
      'Standing loosely facing north, ordered 210 m to the south-east: the leader steps off at once and the others fall in on the move.',
  },
  {
    id: 's5-waypoints',
    name: '5. Consecutive waypoints',
    description: 'Four legs, north, east, south, east, each ordered as the previous one ends.',
  },
];

/** The default formation of each organization. */
export const DEFAULT_FORMATION: Readonly<Record<LabOrganization, string>> = {
  element3: 'element3.wedge',
  fireTeam: 'usmc.fireTeam.wedge',
  squad: 'usmc.squad.wedge',
};

/** The Marine held in scenario 3, by organization (a flank or rear Marine). */
const HELD: Readonly<Record<LabOrganization, string>> = {
  element3: 'TM.AR',
  fireTeam: 'FT.AR',
  squad: 'FT2.AAR',
};

export interface ScenarioOptions {
  readonly organization: LabOrganization;
  readonly formation?: string;
  readonly seed?: number;
  readonly tickRateHz?: number;
  readonly pace?: number;
  readonly interval?: number;
  readonly elementSpacing?: number;
}

/** The run of scenario `id` with `options`. */
export function scenarioSpec(id: LabScenarioId, options: ScenarioOptions): LabRunSpec {
  const interval = options.interval ?? 10;
  const base = {
    organization: options.organization,
    formation: options.formation ?? DEFAULT_FORMATION[options.organization],
    interval,
    elementSpacing: options.elementSpacing ?? 2 * interval,
    pace: options.pace ?? 1.4,
    start: { x: 0, y: 0 },
    seed: options.seed ?? 1,
    tickRateHz: options.tickRateHz ?? 30,
  };
  switch (id) {
    case 's1-straight':
    case 's2-speeds':
      return { ...base, waypoints: [{ x: 0, y: 300 }] };
    case 's3-straggler':
      return {
        ...base,
        waypoints: [{ x: 0, y: 300 }],
        disturbances: [
          { atSeconds: 30, slotId: HELD[options.organization], disturbance: { kind: 'hold' } },
          { atSeconds: 40, slotId: HELD[options.organization], disturbance: null },
        ],
      };
    case 's4-turn':
      return { ...base, via: [{ x: 0, y: 150 }], waypoints: [{ x: 150, y: 150 }] };
    case 'fall-in':
      return { ...base, waypoints: [{ x: 150, y: -150 }] };
    case 's5-waypoints':
      return {
        ...base,
        waypoints: [
          { x: 0, y: 150 },
          { x: 150, y: 150 },
          { x: 150, y: 0 },
          { x: 300, y: 0 },
        ],
      };
  }
}

export interface ScenarioResult {
  readonly run: LabRun;
  readonly metrics: LabMetrics;
  readonly samples: readonly LabSample[];
  readonly events: readonly SimEvent[];
}

/** Runs `spec` until its last task ends (or `maxSeconds`), measuring as it goes. */
export function runScenario(spec: LabRunSpec, maxSeconds = 900): ScenarioResult {
  const run = createLabRun(spec);
  const metrics = createMetrics(run.sim, run.unitId);
  const events: SimEvent[] = [];
  for (let i = 0; i < maxSeconds * spec.tickRateHz && !run.done; i += 1) {
    const step = run.step();
    events.push(...step);
    metrics.sample(step);
  }
  return { run, metrics: metrics.result(), samples: metrics.samples, events };
}
