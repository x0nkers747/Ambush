import type { ScenarioVehicle, TerrainDataset } from '#sim';
import { labTerrain } from '../behavior-lab/run';
import type { BattleSpec, SquadSpec } from './battle';

// The combined-arms range (docs/combined-arms.md §14): six scenarios on the
// lab's open ground (±1 200 m, flat) that put each part of combined arms on
// show, run by the real battle simulation: tank against tank, a tank against
// infantry, the carriers' fight, anti-tank infantry against armour, mixed
// forces, and several vehicles at once. The range page plays them with
// diagnostics; the tests run the same specs.

export interface RangeScenario {
  readonly id: string;
  readonly name: string;
  /** What it shows, and what to look for. */
  readonly description: string;
  readonly spec: BattleSpec;
  /** How long it is worth watching (s). */
  readonly seconds: number;
}

type Side = 'BLUEFOR' | 'OPFOR';

const vehicle = (
  id: string,
  name: string,
  kind: string,
  side: Side,
  x: number,
  y: number,
  headingDeg: number,
  to: readonly { x: number; y: number }[] = [],
): ScenarioVehicle => ({
  id,
  name,
  kind,
  side,
  position: { x, y },
  headingDeg,
  destinations: to,
});

const squad = (
  id: string,
  name: string,
  side: Side,
  x: number,
  y: number,
  facingDeg: number,
  extra: Partial<SquadSpec> = {},
): SquadSpec => ({
  id,
  name,
  side,
  organization: 'squad',
  position: { x, y },
  facingDeg,
  plan: [],
  ...extra,
});

/** Squads out of the fight on both sides (a battle has its forces). */
const RESERVES = [
  squad('BR', 'BLUEFOR reserve', 'BLUEFOR', -1050, -1050, 0, { antiTank: 'none' }),
  squad('OR', 'OPFOR reserve', 'OPFOR', 1050, 1050, 180, { antiTank: 'none' }),
];
const [BLUE_RESERVE, RED_RESERVE] = RESERVES as [SquadSpec, SquadSpec];

const spec = (
  seed: number,
  squads: readonly SquadSpec[],
  vehicles: readonly ScenarioVehicle[],
) => ({
  seed,
  tickRateHz: 30,
  squads,
  vehicles,
});

export const RANGE_SCENARIOS: readonly RangeScenario[] = [
  {
    id: 'tank-duel',
    name: 'Abrams vs T-72',
    description:
      'An M1A1 and a T-72B close from 1 400 m. Each lays its turret on the other and fires armour-piercing rounds from its main gun; neither ever fires its machine guns at the tank. Watch the turrets slew, the hits by face, and the first perforation decide it.',
    spec: spec(7, RESERVES, [
      vehicle('A1', 'Abrams 1', 'm1a1', 'BLUEFOR', 0, -700, 0, [{ x: 0, y: -300 }]),
      vehicle('T1', 'T-72 1', 't72b', 'OPFOR', 40, 700, 180, [{ x: 40, y: 300 }]),
    ]),
    seconds: 90,
  },
  {
    id: 'abrams-infantry',
    name: 'Abrams vs infantry',
    description:
      'An enemy squad without anti-tank weapons advances on a halted M1A1. The tank engages with its coaxial machine gun and the commander’s .50, never its main gun (dearer for little more effect); the squad goes to ground under the fire.',
    spec: spec(
      3,
      [
        BLUE_RESERVE,
        squad('O1', 'Enemy squad', 'OPFOR', 0, 0, 180, {
          antiTank: 'none',
          plan: [{ kind: 'move', destination: { x: 0, y: -300 } }],
        }),
      ],
      [vehicle('A1', 'Abrams 1', 'm1a1', 'BLUEFOR', 0, -500, 0)],
    ),
    seconds: 120,
  },
  {
    id: 'carriers',
    name: 'M113 vs BMP-2',
    description:
      'An M113 and a BMP-2 meet at about 900 m. The BMP-2’s 30 mm fires armour-piercing bursts that defeat the M113’s aluminium; the M113’s .50 is not offered the BMP-2’s front at that range (ineffective) and only fires when it can do harm.',
    spec: spec(5, RESERVES, [
      vehicle('M1', 'M113 1', 'm113', 'BLUEFOR', 0, -400, 0, [{ x: 0, y: -100 }]),
      vehicle('B1', 'BMP-2 1', 'bmp2', 'OPFOR', 30, 600, 180, [{ x: 30, y: 300 }]),
    ]),
    seconds: 120,
  },
  {
    id: 'anti-tank',
    name: 'Anti-tank infantry vs armour',
    description:
      'A BLUEFOR squad defends with three AT4s and a Javelin as a T-72 and a BMP-2 advance on it. The riflemen with the AT4s wait for the vehicles to close; the Javelin gunner locks on (12 s) and fires from long range, attacking the roof.',
    spec: spec(
      9,
      [
        squad('B1', '1st Squad', 'BLUEFOR', 0, -100, 0, {
          antiTank: 'rocketsAndMissile',
          plan: [
            {
              kind: 'defend',
              destination: { x: 0, y: -100 },
              sector: { facing: 0, arc: Math.PI },
            },
          ],
        }),
        RED_RESERVE,
      ],
      [
        vehicle('T1', 'T-72 1', 't72b', 'OPFOR', 100, 900, 180, [{ x: 100, y: -300 }]),
        vehicle('B1V', 'BMP-2 1', 'bmp2', 'OPFOR', -100, 900, 180, [{ x: -100, y: -300 }]),
      ],
    ),
    seconds: 200,
  },
  {
    id: 'mixed',
    name: 'Mixed forces',
    description:
      'An Abrams, an M113 and a squad with rockets against a T-72, a BMP-2 and a squad with RPG-7s. Each vehicle chooses among soldiers and vehicles by effect, threat and value, and keeps its target until a markedly better one appears.',
    spec: spec(
      21,
      [
        squad('B1', '1st Squad', 'BLUEFOR', -50, -300, 0, {
          antiTank: 'rockets',
          plan: [{ kind: 'move', destination: { x: -50, y: 0 } }],
        }),
        squad('O1', 'Enemy squad', 'OPFOR', 50, 400, 180, {
          plan: [{ kind: 'move', destination: { x: 50, y: 100 } }],
        }),
      ],
      [
        vehicle('A1', 'Abrams 1', 'm1a1', 'BLUEFOR', 100, -400, 0, [{ x: 100, y: -100 }]),
        vehicle('M1', 'M113 1', 'm113', 'BLUEFOR', -150, -400, 0, [{ x: -150, y: -150 }]),
        vehicle('T1', 'T-72 1', 't72b', 'OPFOR', 150, 600, 180, [{ x: 150, y: 250 }]),
        vehicle('B1V', 'BMP-2 1', 'bmp2', 'OPFOR', -100, 600, 180, [{ x: -100, y: 250 }]),
      ],
    ),
    seconds: 150,
  },
  {
    id: 'platoons',
    name: 'Several vehicles',
    description:
      'Two Abrams and two M113s against two T-72s and two BMP-2s: many engagements at once, each mount with its own target, hits and kills resolved together in each volley.',
    spec: spec(33, RESERVES, [
      vehicle('A1', 'Abrams 1', 'm1a1', 'BLUEFOR', -150, -800, 0, [{ x: -150, y: -400 }]),
      vehicle('A2', 'Abrams 2', 'm1a1', 'BLUEFOR', 150, -800, 0, [{ x: 150, y: -400 }]),
      vehicle('M1', 'M113 1', 'm113', 'BLUEFOR', -300, -900, 0, [{ x: -300, y: -600 }]),
      vehicle('M2', 'M113 2', 'm113', 'BLUEFOR', 300, -900, 0, [{ x: 300, y: -600 }]),
      vehicle('T1', 'T-72 1', 't72b', 'OPFOR', -150, 800, 180, [{ x: -150, y: 400 }]),
      vehicle('T2', 'T-72 2', 't72b', 'OPFOR', 150, 800, 180, [{ x: 150, y: 400 }]),
      vehicle('B1V', 'BMP-2 1', 'bmp2', 'OPFOR', -300, 900, 180, [{ x: -300, y: 600 }]),
      vehicle('B2V', 'BMP-2 2', 'bmp2', 'OPFOR', 300, 900, 180, [{ x: 300, y: 600 }]),
    ]),
    seconds: 150,
  },
];

/** The range's ground: the lab's open, flat square. */
export function rangeTerrain(): TerrainDataset {
  return labTerrain();
}
