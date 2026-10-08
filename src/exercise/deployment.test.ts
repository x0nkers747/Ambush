import { describe, expect, it } from 'vitest';
import { createSyntheticTerrain, flatElevation, soldierId } from '#sim';
import {
  defaultFacing,
  DeploymentPlanError,
  emptyPlan,
  facingDegreesOf,
  parseDeploymentPlans,
  resolvedFacing,
  samePlan,
  serializeDeploymentPlans,
  validateDeploymentPlan,
  type SoldierDeploymentPlan,
} from './deployment';

const A = soldierId('A');
const B = soldierId('B');
const TERRAIN = createSyntheticTerrain(
  { originX: -50, originY: -50, cellSize: 10, columns: 11, rows: 11 },
  flatElevation(0),
);
const PLAN: SoldierDeploymentPlan = {
  soldierId: A,
  destination: { east: 10, north: 20 },
  facingDegrees: 90,
};

describe('SoldierDeploymentPlan', () => {
  it('compares by soldier, destination and facing', () => {
    expect(samePlan(PLAN, { ...PLAN, destination: { east: 10, north: 20 } })).toBe(true);
    expect(samePlan(PLAN, { ...PLAN, destination: null })).toBe(false);
    expect(samePlan(PLAN, { ...PLAN, facingDegrees: null })).toBe(false);
    expect(samePlan(emptyPlan(A), emptyPlan(B))).toBe(false);
    expect(samePlan(emptyPlan(A), { soldierId: A, destination: null, facingDegrees: null })).toBe(
      true,
    );
  });

  it('stores facings as degrees in [0, 360)', () => {
    expect(facingDegreesOf(Math.PI / 2)).toBeCloseTo(90, 12);
    expect(facingDegreesOf(-Math.PI / 2)).toBeCloseTo(270, 12);
    expect(facingDegreesOf(2 * Math.PI)).toBe(0);
  });

  it('defaults the facing to the direction of the last piece of path, else the current facing', () => {
    const path = [
      { x: 0, y: 0 },
      { x: 0, y: 10 },
      { x: 10, y: 10 },
    ];
    expect(defaultFacing(path, 1)).toBeCloseTo(Math.PI / 2, 12);
    expect(
      defaultFacing(
        [
          { x: 3, y: 3 },
          { x: 3, y: 3 },
        ],
        1,
      ),
    ).toBe(1);
    expect(defaultFacing([], 1)).toBe(1);
    expect(resolvedFacing({ ...PLAN, facingDegrees: null }, path, 1)).toEqual({
      azimuth: defaultFacing(path, 1),
      explicit: false,
    });
    expect(resolvedFacing(PLAN, path, 1)).toEqual({ azimuth: Math.PI / 2, explicit: true });
  });

  it('is validated at the boundary', () => {
    expect(validateDeploymentPlan(PLAN, TERRAIN)).toEqual([]);
    expect(validateDeploymentPlan({ ...PLAN, facingDegrees: 360 }, TERRAIN)).toEqual([
      'facing 360 is not a bearing in [0, 360) degrees',
    ]);
    expect(
      validateDeploymentPlan({ ...PLAN, destination: { east: 99, north: 0 } }, TERRAIN),
    ).toEqual(['destination is off the map']);
    expect(
      validateDeploymentPlan({ ...PLAN, destination: { east: Number.NaN, north: 0 } }, TERRAIN),
    ).toEqual(['destination is not a finite map point']);
  });
});

describe('serialized deployment plans', () => {
  const expected = { scenarioFingerprint: 'abc123', soldierIds: [A, B] };
  const set = { scenarioFingerprint: 'abc123', plans: [PLAN, emptyPlan(B)] };

  it('serialize deterministically, in a fixed key order', () => {
    const text = serializeDeploymentPlans(set);
    expect(text).toBe(
      '{"schema":"ambush.deployment-plans","schemaVersion":1,"scenarioFingerprint":"abc123","plans":[' +
        '{"soldierId":"A","destination":{"east":10,"north":20},"facingDegrees":90},' +
        '{"soldierId":"B","destination":null,"facingDegrees":null}]}',
    );
    // Property order of the input does not matter.
    const reordered = {
      plans: [
        { facingDegrees: 90, destination: { north: 20, east: 10 }, soldierId: A },
        emptyPlan(B),
      ],
      scenarioFingerprint: 'abc123',
    };
    expect(serializeDeploymentPlans(reordered)).toBe(text);
    expect(parseDeploymentPlans(text, expected)).toEqual(set);
  });

  it('refuse waypoint chains from before Phase 3.7 instead of guessing a destination', () => {
    const old = JSON.stringify({
      scenarioFingerprint: 'abc123',
      plans: [
        {
          soldierId: 'A',
          waypoints: [
            { id: 'A.1', x: 0, y: 10 },
            { id: 'A.2', x: 5, y: 20 },
          ],
          finalFacing: 1.57,
        },
      ],
    });
    expect(() => parseDeploymentPlans(old, expected)).toThrow(DeploymentPlanError);
    expect(() => parseDeploymentPlans(old, expected)).toThrow(
      /waypoint-chain plans from before Phase 3\.7/,
    );
    // Even inside an otherwise current envelope.
    const mixed = JSON.stringify({
      ...(JSON.parse(serializeDeploymentPlans(set)) as object),
      plans: [{ soldierId: 'A', waypoints: [] }],
    });
    expect(() => parseDeploymentPlans(mixed, expected)).toThrow(/waypoint-chain/);
  });

  it.each<[string, string, RegExp]>([
    ['text that is not JSON', '{plans', /not JSON/],
    ['another schema', JSON.stringify({ schema: 'x', schemaVersion: 1 }), /schema is not/],
    [
      'a newer schema version',
      JSON.stringify({
        schema: 'ambush.deployment-plans',
        schemaVersion: 2,
        scenarioFingerprint: 'abc123',
        plans: [],
      }),
      /schema version 2 is not supported/,
    ],
    [
      'plans for another scenario or template version',
      JSON.stringify({
        schema: 'ambush.deployment-plans',
        schemaVersion: 1,
        scenarioFingerprint: 'zzz',
        plans: [],
      }),
      /different scenario, organization template or template version/,
    ],
    [
      'an unknown soldier',
      JSON.stringify({
        schema: 'ambush.deployment-plans',
        schemaVersion: 1,
        scenarioFingerprint: 'abc123',
        plans: [{ soldierId: 'Q', destination: null, facingDegrees: null }],
      }),
      /unknown soldier "Q"/,
    ],
    [
      'two plans for one soldier',
      JSON.stringify({
        schema: 'ambush.deployment-plans',
        schemaVersion: 1,
        scenarioFingerprint: 'abc123',
        plans: [emptyPlan(A), emptyPlan(A)],
      }),
      /"A" has two plans/,
    ],
    [
      'an unknown field',
      JSON.stringify({
        schema: 'ambush.deployment-plans',
        schemaVersion: 1,
        scenarioFingerprint: 'abc123',
        plans: [{ ...emptyPlan(A), posture: 'prone' }],
      }),
      /unknown field "posture"/,
    ],
    [
      'a facing out of range',
      JSON.stringify({
        schema: 'ambush.deployment-plans',
        schemaVersion: 1,
        scenarioFingerprint: 'abc123',
        plans: [{ ...emptyPlan(A), facingDegrees: 400 }],
      }),
      /invalid facing/,
    ],
    [
      'a malformed destination',
      JSON.stringify({
        schema: 'ambush.deployment-plans',
        schemaVersion: 1,
        scenarioFingerprint: 'abc123',
        plans: [{ ...emptyPlan(A), destination: { east: '1', north: 2 } }],
      }),
      /invalid destination/,
    ],
  ])('refuse %s', (_label, text, message) => {
    expect(() => parseDeploymentPlans(text, expected)).toThrow(message);
  });
});
