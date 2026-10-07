import { describe, expect, it } from 'vitest';
import { createInitialState, type Scenario, type ScenarioSoldier } from './scenario';
import type { SimState } from './state';
import { TEST_SCENARIO } from './test-scenario';

function membersOf(state: SimState, unitId: string): string[] {
  const inUnit = (id: string): boolean => {
    for (let u = state.units.find((x) => x.id === id); u;) {
      if (u.id === unitId) return true;
      const parentId = u.parentId;
      u = parentId === null ? undefined : state.units.find((x) => x.id === parentId);
    }
    return false;
  };
  return state.soldiers.filter((s) => inUnit(s.unitId)).map((s) => s.id);
}

describe('createInitialState', () => {
  const state = createInitialState(TEST_SCENARIO, 1);

  it('starts at tick 0', () => {
    expect(state.tick).toBe(0);
  });

  it('creates every soldier in scenario order with side, unit and starting pose', () => {
    expect(state.soldiers.map((s) => [s.id, s.side, s.unitId])).toEqual([
      ['B-SL', 'BLUEFOR', 'B-SQD'],
      ['B-A-TL', 'BLUEFOR', 'B-A'],
      ['B-A-AR', 'BLUEFOR', 'B-A'],
      ['B-B-TL', 'BLUEFOR', 'B-B'],
      ['B-B-R', 'BLUEFOR', 'B-B'],
      ['O-TL', 'OPFOR', 'O-TM'],
      ['O-R', 'OPFOR', 'O-TM'],
    ]);
    expect(state.soldiers[2]).toEqual({
      id: 'B-A-AR',
      side: 'BLUEFOR',
      unitId: 'B-A',
      position: { x: -15, y: 5, z: 0 },
      azimuth: (3 * Math.PI) / 2,
      posture: 'prone',
      status: 'active',
      orders: null,
    });
  });

  it('converts azimuths from degrees to normalized radians', () => {
    const expected = [0, 7 / 4, 3 / 2, 1 / 4, 1 / 2, 1, 1].map((turns) => turns * Math.PI);
    state.soldiers.forEach((s, i) => {
      expect(s.azimuth).toBeCloseTo(expected[i] ?? Number.NaN, 12);
    });
  });

  it('builds the organization: parents, leaders and nested membership', () => {
    expect(state.units).toEqual([
      { id: 'B-SQD', echelon: 'squad', parentId: null, leaderId: 'B-SL' },
      { id: 'B-A', echelon: 'fireTeam', parentId: 'B-SQD', leaderId: 'B-A-TL' },
      { id: 'B-B', echelon: 'fireTeam', parentId: 'B-SQD', leaderId: 'B-B-TL' },
      { id: 'O-TM', echelon: 'fireTeam', parentId: null, leaderId: 'O-TL' },
    ]);
    expect(membersOf(state, 'B-SQD')).toEqual(['B-SL', 'B-A-TL', 'B-A-AR', 'B-B-TL', 'B-B-R']);
    expect(membersOf(state, 'B-A')).toEqual(['B-A-TL', 'B-A-AR']);
    expect(membersOf(state, 'O-TM')).toEqual(['O-TL', 'O-R']);
  });

  it('does not share objects with the scenario', () => {
    const fresh = createInitialState(TEST_SCENARIO, 1);
    const [first] = fresh.soldiers;
    if (first) first.position.x = 999;
    expect(TEST_SCENARIO.soldiers[0]?.position.x).toBe(0);
  });

  it('seeds the PRNG from the seed', () => {
    expect(createInitialState(TEST_SCENARIO, 1).rng).toEqual(state.rng);
    expect(createInitialState(TEST_SCENARIO, 2).rng).not.toEqual(state.rng);
  });

  it('accepts an empty scenario', () => {
    expect(createInitialState({ id: 'empty', units: [], soldiers: [] }, 0).soldiers).toEqual([]);
  });
});

describe('createInitialState validation', () => {
  const soldier = (overrides: Partial<ScenarioSoldier> = {}): ScenarioSoldier => ({
    id: 'S1',
    side: 'BLUEFOR',
    unitId: 'U1',
    position: { x: 0, y: 0, z: 0 },
    azimuthDeg: 0,
    posture: 'standing',
    ...overrides,
  });
  const unit = (id: string, parentId: string | null = null, leaderId: string | null = null) => ({
    id,
    echelon: 'fireTeam' as const,
    parentId,
    leaderId,
  });

  it.each<[string, Scenario, RegExp]>([
    [
      'duplicate unit',
      { id: 't', units: [unit('U1'), unit('U1')], soldiers: [] },
      /duplicate unit/,
    ],
    [
      'duplicate soldier',
      { id: 't', units: [unit('U1')], soldiers: [soldier(), soldier()] },
      /duplicate soldier/,
    ],
    ['unknown parent', { id: 't', units: [unit('U1', 'X')], soldiers: [] }, /unknown parent/],
    [
      'parent cycle',
      { id: 't', units: [unit('U1', 'U2'), unit('U2', 'U1')], soldiers: [] },
      /cycle/,
    ],
    [
      'unknown soldier unit',
      { id: 't', units: [unit('U1')], soldiers: [soldier({ unitId: 'X' })] },
      /unknown unit/,
    ],
    ['unknown leader', { id: 't', units: [unit('U1', null, 'X')], soldiers: [] }, /unknown leader/],
    [
      'leader outside the unit',
      {
        id: 't',
        units: [unit('U1', null, 'S2'), unit('U2')],
        soldiers: [soldier(), soldier({ id: 'S2', unitId: 'U2' })],
      },
      /not a member/,
    ],
    [
      'mixed sides in one organization',
      {
        id: 't',
        units: [unit('U1'), unit('U2', 'U1')],
        soldiers: [soldier(), soldier({ id: 'S2', unitId: 'U2', side: 'OPFOR' })],
      },
      /mixes BLUEFOR and OPFOR/,
    ],
    [
      'non-finite position',
      {
        id: 't',
        units: [unit('U1')],
        soldiers: [soldier({ position: { x: Number.NaN, y: 0, z: 0 } })],
      },
      /non-finite/,
    ],
    [
      'non-finite azimuth',
      {
        id: 't',
        units: [unit('U1')],
        soldiers: [soldier({ azimuthDeg: Number.POSITIVE_INFINITY })],
      },
      /non-finite/,
    ],
  ])('rejects %s', (_label, scenario, message) => {
    expect(() => createInitialState(scenario, 0)).toThrow(message);
  });

  it('allows a leader from a subordinate unit', () => {
    const scenario: Scenario = {
      id: 't',
      units: [unit('U1', null, 'S1'), unit('U2', 'U1')],
      soldiers: [soldier({ unitId: 'U2' })],
    };
    expect(() => createInitialState(scenario, 0)).not.toThrow();
  });
});
