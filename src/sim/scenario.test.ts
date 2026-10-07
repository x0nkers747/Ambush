import { describe, expect, it } from 'vitest';
import { createInitialState, createWorld, type Scenario, type ScenarioSoldier } from './scenario';
import type { SimState } from './state';
import { createSyntheticTerrain, flatElevation } from './synthetic-terrain';
import { EMPTY_TEST_SCENARIO, TEST_SCENARIO } from './test-scenario';

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
      position: { x: -15, y: 5, z: 50 },
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

  it('places soldiers at the terrain elevation', () => {
    const moved: Record<string, { x: number; y: number }> = {
      'O-TL': { x: 3, y: 100 }, // ridge crest: 50 + 10
      'O-R': { x: 3, y: 125 }, // half-way down the north slope: 50 + 5
    };
    const onRidge = createInitialState(
      {
        ...TEST_SCENARIO,
        soldiers: TEST_SCENARIO.soldiers.map((s) => ({
          ...s,
          position: moved[s.id] ?? s.position,
        })),
      },
      0,
    );
    expect(onRidge.soldiers.map((s) => s.position.z)).toEqual([50, 50, 50, 50, 50, 60, 55]);
  });

  it('accepts an empty scenario', () => {
    expect(createInitialState(EMPTY_TEST_SCENARIO, 0).soldiers).toEqual([]);
  });
});

describe('createWorld', () => {
  it('deep-freezes a copy of the terrain and movement parameters', () => {
    const world = createWorld(TEST_SCENARIO);
    expect(world.terrain).toEqual(TEST_SCENARIO.terrain);
    expect(world.terrain).not.toBe(TEST_SCENARIO.terrain);
    expect(world.movement).toEqual(TEST_SCENARIO.movement);
    expect(Object.isFrozen(world.terrain.heightfield.elevations)).toBe(true);
    expect(Object.isFrozen(world.movement)).toBe(true);
    expect(Object.isFrozen(TEST_SCENARIO.terrain.heightfield.elevations)).toBe(false);
  });
});

describe('createInitialState validation', () => {
  const soldier = (overrides: Partial<ScenarioSoldier> = {}): ScenarioSoldier => ({
    id: 'S1',
    side: 'BLUEFOR',
    unitId: 'U1',
    position: { x: 0, y: 0 },
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
  const terrain = createSyntheticTerrain(
    { originX: -10, originY: -10, cellSize: 10, columns: 3, rows: 3 },
    flatElevation(0),
  );
  const scenario = (overrides: Partial<Scenario>): Scenario => ({
    id: 't',
    terrain,
    movement: { speed: 1, maxTurnRate: 1 },
    units: [unit('U1')],
    soldiers: [],
    ...overrides,
  });
  const heightfield = terrain.heightfield;

  it.each<[string, Scenario, RegExp]>([
    ['duplicate unit', scenario({ units: [unit('U1'), unit('U1')] }), /duplicate unit/],
    ['duplicate soldier', scenario({ soldiers: [soldier(), soldier()] }), /duplicate soldier/],
    ['unknown parent', scenario({ units: [unit('U1', 'X')] }), /unknown parent/],
    ['parent cycle', scenario({ units: [unit('U1', 'U2'), unit('U2', 'U1')] }), /cycle/],
    ['unknown soldier unit', scenario({ soldiers: [soldier({ unitId: 'X' })] }), /unknown unit/],
    ['unknown leader', scenario({ units: [unit('U1', null, 'X')] }), /unknown leader/],
    [
      'leader outside the unit',
      scenario({
        units: [unit('U1', null, 'S2'), unit('U2')],
        soldiers: [soldier(), soldier({ id: 'S2', unitId: 'U2' })],
      }),
      /not a member/,
    ],
    [
      'mixed sides in one organization',
      scenario({
        units: [unit('U1'), unit('U2', 'U1')],
        soldiers: [soldier(), soldier({ id: 'S2', unitId: 'U2', side: 'OPFOR' })],
      }),
      /mixes BLUEFOR and OPFOR/,
    ],
    [
      'non-finite position',
      scenario({ soldiers: [soldier({ position: { x: Number.NaN, y: 0 } })] }),
      /non-finite/,
    ],
    [
      'non-finite azimuth',
      scenario({ soldiers: [soldier({ azimuthDeg: Number.POSITIVE_INFINITY })] }),
      /non-finite/,
    ],
    [
      'a soldier off the terrain',
      scenario({ soldiers: [soldier({ position: { x: 10.5, y: 0 } })] }),
      /off the terrain/,
    ],
    [
      'too few terrain samples',
      scenario({
        terrain: { ...terrain, heightfield: { ...heightfield, columns: 1, elevations: [0, 0, 0] } },
      }),
      /at least 2 × 2/,
    ],
    [
      'a terrain elevation count mismatch',
      scenario({ terrain: { ...terrain, heightfield: { ...heightfield, elevations: [0] } } }),
      /expected 9/,
    ],
    [
      'a non-positive cell size',
      scenario({ terrain: { ...terrain, heightfield: { ...heightfield, cellSize: 0 } } }),
      /cellSize/,
    ],
    [
      'a non-finite elevation',
      scenario({
        terrain: {
          ...terrain,
          heightfield: { ...heightfield, elevations: [0, 0, 0, 0, Number.NaN, 0, 0, 0, 0] },
        },
      }),
      /elevations must be finite/,
    ],
    ['a zero speed', scenario({ movement: { speed: 0, maxTurnRate: 1 } }), /speed/],
    [
      'an infinite turn rate',
      scenario({ movement: { speed: 1, maxTurnRate: Number.POSITIVE_INFINITY } }),
      /maxTurnRate/,
    ],
  ])('rejects %s', (_label, invalid, message) => {
    expect(() => createInitialState(invalid, 0)).toThrow(message);
  });

  it('allows a leader from a subordinate unit', () => {
    const valid = scenario({
      units: [unit('U1', null, 'S1'), unit('U2', 'U1')],
      soldiers: [soldier({ unitId: 'U2' })],
    });
    expect(() => createInitialState(valid, 0)).not.toThrow();
  });

  it('accepts soldiers exactly on the terrain boundary', () => {
    const valid = scenario({ soldiers: [soldier({ position: { x: 10, y: -10 } })] });
    expect(() => createInitialState(valid, 0)).not.toThrow();
  });
});
