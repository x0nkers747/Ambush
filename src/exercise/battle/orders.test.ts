import { describe, expect, it } from 'vitest';
import {
  orderSpecProblem,
  validateFofSetup,
  validateOrderSquad,
  type FofSetup,
  type OrderSpec,
  type ScenarioSoldier,
  type ScenarioUnit,
  type Side,
} from '#sim';
import { FOF_DEFAULT_CONFIG } from '../forces/forces';

// Orders and plans (docs/constructive-simulation/02): their shape, and the
// setups they need. Their behaviour in a battle is tested in
// src/exercise/battle/battle.test.ts.

const units = (ids: readonly string[]): ScenarioUnit[] =>
  ids.map((id) => ({ id, echelon: 'squad', parentId: null, leaderId: null }));
const soldiers = (forces: readonly [string, Side][]): ScenarioSoldier[] =>
  forces.map(([unitId, side]) => ({
    id: `${unitId}-01`,
    side,
    unitId,
    position: { x: 0, y: 0 },
    azimuthDeg: 0,
    posture: 'standing',
  })) as unknown as ScenarioSoldier[];

function setup(forces: readonly [string, Side][], termination?: FofSetup['termination']): FofSetup {
  return {
    config: FOF_DEFAULT_CONFIG,
    visibility: 'open',
    forces: forces.map(([unitId, side]) => ({ unitId, side, weapons: {} })),
    ...(termination ? { termination } : {}),
  };
}

describe('setups', () => {
  const three: [string, Side][] = [
    ['A', 'BLUEFOR'],
    ['B', 'BLUEFOR'],
    ['C', 'OPFOR'],
  ];

  it('a battle (manual termination) takes any number of squads, of either side', () => {
    expect(() => {
      validateFofSetup(setup(three, 'manual'), units(['A', 'B', 'C']), soldiers(three));
    }).not.toThrow();
  });

  it('an experiment (the lab) still needs exactly two opposed forces', () => {
    expect(() => {
      validateFofSetup(setup(three), units(['A', 'B', 'C']), soldiers(three));
    }).toThrow(/exactly two/);
    const same: [string, Side][] = [
      ['A', 'BLUEFOR'],
      ['B', 'BLUEFOR'],
    ];
    expect(() => {
      validateFofSetup(setup(same), units(['A', 'B']), soldiers(same));
    }).toThrow(/opposite sides/);
  });

  it('refuses a force given twice and a malformed initial plan', () => {
    const twice: [string, Side][] = [
      ['A', 'BLUEFOR'],
      ['A', 'OPFOR'],
    ];
    expect(() => {
      validateFofSetup(setup(twice, 'manual'), units(['A']), soldiers([['A', 'BLUEFOR']]));
    }).toThrow(/given twice/);
    const planned: FofSetup = {
      ...setup([['A', 'BLUEFOR']], 'manual'),
      forces: [
        { unitId: 'A', side: 'BLUEFOR', weapons: {}, plan: [{ kind: 'move', destination: null }] },
      ],
    };
    expect(() => {
      validateFofSetup(planned, units(['A']), soldiers([['A', 'BLUEFOR']]));
    }).toThrow(/order 1: a move order needs a destination/);
  });
});

describe('orders as given', () => {
  it('names what is wrong with an order', () => {
    const order = (o: unknown) => orderSpecProblem(o as OrderSpec);
    expect(order({ kind: 'move', destination: { x: 1, y: 2 } })).toBeNull();
    expect(order({ kind: 'charge', destination: { x: 1, y: 2 } })).toMatch(/unknown order kind/);
    expect(order({ kind: 'attack', destination: null })).toMatch(/needs a destination/);
    expect(order({ kind: 'withdraw', destination: { x: Infinity, y: 0 } })).toMatch(/finite/);
  });

  it('refuses a malformed orderSquad command', () => {
    const command = (patch: Record<string, unknown>) => () => {
      validateOrderSquad({
        type: 'orderSquad',
        tick: 0,
        unitId: 'A',
        mode: 'replace',
        orders: [],
        ...patch,
      } as never);
    };
    expect(command({})).not.toThrow();
    expect(command({ unitId: '' })).toThrow(/unitId/);
    expect(command({ mode: 'insert' })).toThrow(/replace, pending or append/);
    expect(command({ mode: 'pending' })).not.toThrow();
    expect(command({ orders: [{ kind: 'move', destination: null }] })).toThrow(/order 1/);
  });
});
