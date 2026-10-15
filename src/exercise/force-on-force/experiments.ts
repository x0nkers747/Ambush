import type { FofConfig } from '#sim';
import { FOF_DEFAULT_CONFIG, type FofRunSpec } from './run';
import { headOn, SQUAD } from './test-specs';

// The Force-on-Force Lab's experiments (docs/behavior-lab/force-on-force/04):
// reproducible setups for the questions the lab is for. Each is a function of
// the seed giving one or more variants (plain run specs); nothing in them
// decides an outcome. They differ only in where the forces are, what they are
// ordered to do, the ground, the observation conditions and, where the
// question needs it, configuration values (stated in the description).

export type FofExperimentId =
  | 'demo'
  | 'open-approach'
  | 'observation-distance'
  | 'first-detection'
  | 'simultaneous-detection'
  | 'wooded-delay'
  | 'contact-loss'
  | 'urban-sight-lines'
  | 'combat-ineffective'
  | 'ammunition-exhaustion'
  | 'bounded-stalemate'
  | 'mutual-disengagement'
  | 'replay-restore';

export interface FofVariant {
  readonly label: string;
  readonly spec: FofRunSpec;
}

export interface FofExperiment {
  readonly id: FofExperimentId;
  readonly name: string;
  readonly description: string;
  /** The question's variants for a seed (the first is what the lab shows). */
  variants(seed: number, tickRateHz?: number): readonly FofVariant[];
}

type DeepMutable<T> = T extends object ? { -readonly [K in keyof T]: DeepMutable<T[K]> } : T;

/** The default configuration with changes. */
export function withConfig(patch: (c: DeepMutable<FofConfig>) => void): FofConfig {
  const c = JSON.parse(JSON.stringify(FOF_DEFAULT_CONFIG)) as DeepMutable<FofConfig>;
  patch(c);
  return c;
}

const one = (label: string, spec: FofRunSpec): readonly FofVariant[] => [{ label, spec }];

export const FOF_EXPERIMENTS: readonly FofExperiment[] = [
  {
    id: 'demo',
    name: 'Default: two squads meet in the open',
    description:
      'BLUEFOR and OPFOR squads in wedge, 1.4 km apart, each ordered to the other’s start. They detect, halt, engage and fight to an outcome.',
    variants: (seed, rate = 30) => one('open', headOn('open', seed, rate)),
  },
  {
    id: 'open-approach',
    name: '1. Approach in open terrain',
    description: 'As the default: the reference for the other experiments.',
    variants: (seed, rate = 30) => one('open', headOn('open', seed, rate)),
  },
  {
    id: 'observation-distance',
    name: '2. Contact at different observation distances',
    description:
      'The same approach on open ground under three observation conditions: clear, urban haze and restricted visibility (dusk, mist). The ground is the same; only what the eye gets differs.',
    variants: (seed, rate = 30) =>
      (['open', 'urban', 'restricted'] as const).map((visibility) => ({
        label: visibility,
        spec: { ...headOn('open', seed, rate), visibility },
      })),
  },
  {
    id: 'first-detection',
    name: '3. One squad detects the other first',
    description:
      'OPFOR waits in a line, kneeling and still, facing BLUEFOR’s approach; BLUEFOR walks in, upright. The still, low force should usually see the moving one first.',
    variants: (seed, rate = 30) =>
      one('overwatch', {
        blufor: { ...SQUAD, start: { x: 0, y: -700 }, destination: { x: 0, y: 500 } },
        opfor: {
          ...SQUAD,
          formation: 'usmc.squad.line',
          start: { x: 0, y: 300 },
          destination: null,
          facingDeg: 180,
          posture: 'kneeling',
        },
        terrain: 'open',
        seed,
        tickRateHz: rate,
      }),
  },
  {
    id: 'simultaneous-detection',
    name: '4. Simultaneous detection',
    description:
      'Two identical squads, both moving, mirror images of each other on open ground: neither has an advantage, so detection should come at about the same time on both sides.',
    variants: (seed, rate = 30) =>
      one('mirror', {
        blufor: { ...SQUAD, start: { x: 0, y: -700 }, destination: { x: 0, y: 700 } },
        opfor: { ...SQUAD, start: { x: 0, y: 700 }, destination: { x: 0, y: -700 } },
        terrain: 'open',
        seed,
        tickRateHz: rate,
      }),
  },
  {
    id: 'wooded-delay',
    name: '5. Delayed detection in wooded terrain',
    description:
      'The approach on open and on wooded ground: woods obscure sight lines and lower contrast, so detection comes later and closer.',
    variants: (seed, rate = 30) => [
      { label: 'wooded', spec: headOn('wooded', seed, rate) },
      { label: 'open', spec: headOn('open', seed, rate) },
    ],
  },
  {
    id: 'contact-loss',
    name: '6. Temporary loss of contact',
    description:
      'BLUEFOR holds still, watching east; OPFOR walks north 450 m away (beyond engagement range) through woods and tree lines, in and out of sight: contacts are lost and regained.',
    variants: (seed, rate = 30) =>
      one('crossing', {
        blufor: {
          ...SQUAD,
          formation: 'usmc.squad.line',
          start: { x: -200, y: 0 },
          destination: null,
          facingDeg: 90,
          posture: 'kneeling',
        },
        opfor: { ...SQUAD, start: { x: 250, y: -650 }, destination: { x: 250, y: 650 } },
        terrain: 'wooded',
        seed,
        tickRateHz: rate,
      }),
  },
  {
    id: 'urban-sight-lines',
    name: '7. Urban line-of-sight obstruction',
    description:
      'The approach through the urban district: buildings block sight lines, so contact comes only where a street or open square gives a view.',
    variants: (seed, rate = 30) => one('urban', headOn('urban', seed, rate)),
  },
  {
    id: 'combat-ineffective',
    name: '8. One organization becomes combat ineffective',
    description:
      'A BLUEFOR squad (13) meets an OPFOR fire team (4) in the open: the smaller force is broken first in most seeds.',
    variants: (seed, rate = 30) =>
      one('squad vs fire team', {
        ...headOn('open', seed, rate),
        opfor: {
          ...SQUAD,
          organization: 'fireTeam',
          formation: 'usmc.fireTeam.wedge',
          start: { x: 40, y: 700 },
          destination: { x: 40, y: -700 },
        },
      }),
  },
  {
    id: 'ammunition-exhaustion',
    name: '9. Ammunition exhaustion',
    description:
      'The approach with a light load (rifles 40 rounds, automatic rifles 120): forces run low, withdraw for want of ammunition, or end with both nearly empty.',
    variants: (seed, rate = 30) =>
      one('light load', {
        ...headOn('open', seed, rate),
        config: withConfig((c) => {
          for (const w of c.fire.weapons) w.basicLoadRounds = w.id === 'rifle' ? 40 : 120;
        }),
      }),
  },
  {
    id: 'bounded-stalemate',
    name: '10. Engagement reaching a bounded stalemate',
    description:
      'Two squads, prone and still, 560 m apart, ordered to engage at that range (engage range 600 m): only the automatic rifles reach, hits on prone soldiers are rare, and the engagement stalls until it is adjudicated.',
    variants: (seed, rate = 30) =>
      one('long range', {
        blufor: {
          ...SQUAD,
          formation: 'usmc.squad.line',
          start: { x: 0, y: -280 },
          destination: null,
          facingDeg: 0,
          posture: 'prone',
        },
        opfor: {
          ...SQUAD,
          formation: 'usmc.squad.line',
          start: { x: 0, y: 280 },
          destination: null,
          facingDeg: 180,
          posture: 'prone',
        },
        terrain: 'open',
        seed,
        tickRateHz: rate,
        config: withConfig((c) => {
          c.force.engageRangeM = 600;
        }),
      }),
  },
  {
    id: 'mutual-disengagement',
    name: '11. Both organizations disengage',
    description:
      'The approach with cautious forces that break contact at the first loss or sustained fire (withdraw below 0.97 effectiveness, or suppressed above 0.1 for 3 s): both pull back.',
    variants: (seed, rate = 30) =>
      one('cautious', {
        ...headOn('open', seed, rate),
        config: withConfig((c) => {
          c.force.withdrawEffectiveness = 0.97;
          c.force.withdrawSuppression = 0.1;
          c.force.withdrawSuppressedSeconds = 3;
        }),
      }),
  },
  {
    id: 'replay-restore',
    name: '12. Replay and restoration during an active engagement',
    description:
      'The default approach: snapshot during the firefight, restore and continue; replay the whole run from its commands. Both must match the original to the bit.',
    variants: (seed, rate = 30) => one('open', headOn('open', seed, rate)),
  },
];

export function fofExperiment(id: FofExperimentId): FofExperiment {
  const found = FOF_EXPERIMENTS.find((e) => e.id === id);
  if (!found) throw new Error(`unknown force-on-force experiment "${id}"`);
  return found;
}
