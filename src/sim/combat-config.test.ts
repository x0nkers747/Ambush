import { describe, expect, it } from 'vitest';
import {
  CombatConfigError,
  hitProbabilityAt,
  validateCombatConfig,
  weaponCombatProfile,
} from './combat-config';
import { clonePlainData } from './plain-data';
import { TEST_COMBAT_CONFIG, TEST_RIFLE } from './test-combat';

// Weapon effectiveness and the combat configuration's validation (docs/adr/0019).

describe('hitProbabilityAt', () => {
  it('interpolates linearly between control points', () => {
    expect(hitProbabilityAt(TEST_RIFLE, 50)).toBeCloseTo(0.4, 12);
    expect(hitProbabilityAt(TEST_RIFLE, 25)).toBeCloseTo(0.45, 12);
    expect(hitProbabilityAt(TEST_RIFLE, 200)).toBeCloseTo(0.2, 12);
    expect(hitProbabilityAt(TEST_RIFLE, 250)).toBeCloseTo(0.15, 12);
  });

  it('gives exactly the control point’s probability at its range', () => {
    expect(hitProbabilityAt(TEST_RIFLE, 0)).toBe(0.5);
    expect(hitProbabilityAt(TEST_RIFLE, 100)).toBe(0.3);
    expect(hitProbabilityAt(TEST_RIFLE, 300)).toBe(0.1);
  });

  it('holds the last point’s probability out to the maximum engagement range, and 0 beyond', () => {
    expect(hitProbabilityAt(TEST_RIFLE, 350)).toBe(0.1);
    expect(hitProbabilityAt(TEST_RIFLE, 400)).toBe(0.1);
    expect(hitProbabilityAt(TEST_RIFLE, 400.001)).toBe(0);
    expect(hitProbabilityAt(TEST_RIFLE, 5000)).toBe(0);
    expect(hitProbabilityAt(TEST_RIFLE, -1)).toBe(0);
  });

  it('falls monotonically along a falling curve', () => {
    let previous = Infinity;
    for (let range = 0; range <= 400; range += 7) {
      const p = hitProbabilityAt(TEST_RIFLE, range);
      expect(p).toBeLessThanOrEqual(previous);
      previous = p;
    }
  });

  it('handles a one-point curve', () => {
    const flat = { ...TEST_RIFLE, hitProbabilityByRange: [{ rangeM: 0, probability: 0.25 }] };
    expect(hitProbabilityAt(flat, 0)).toBe(0.25);
    expect(hitProbabilityAt(flat, 399)).toBe(0.25);
    expect(hitProbabilityAt(flat, 401)).toBe(0);
  });
});

describe('validateCombatConfig', () => {
  const edited = (edit: (c: Record<string, unknown>) => void): unknown => {
    const copy = clonePlainData(TEST_COMBAT_CONFIG) as unknown as Record<string, unknown>;
    edit(copy);
    return copy;
  };
  const item = (list: unknown, i: number): Record<string, unknown> => {
    const value = (list as Record<string, unknown>[])[i];
    if (value === undefined) throw new Error(`no item ${String(i)}`);
    return value;
  };
  const weapon0 = (c: Record<string, unknown>) => item(c['weapons'], 0);
  /** The first weapon's curve point `k`. */
  const point = (c: Record<string, unknown>, k: number) =>
    item(weapon0(c)['hitProbabilityByRange'], k);

  it('accepts a valid configuration and returns it', () => {
    expect(validateCombatConfig(TEST_COMBAT_CONFIG)).toBe(TEST_COMBAT_CONFIG);
  });

  it.each([
    [
      'a probability above 1',
      (c: Record<string, unknown>) => {
        point(c, 1)['probability'] = 1.2;
      },
      /probability: 1.2 is outside \[0, 1\]/,
    ],
    [
      'a negative probability',
      (c: Record<string, unknown>) => {
        point(c, 0)['probability'] = -0.1;
      },
      /probability/,
    ],
    [
      'a curve not starting at 0 m',
      (c: Record<string, unknown>) => {
        point(c, 0)['rangeM'] = 10;
      },
      /first point must be at 0 m/,
    ],
    [
      'repeated ranges',
      (c: Record<string, unknown>) => {
        point(c, 2)['rangeM'] = 100;
      },
      /strictly increase/,
    ],
    [
      'decreasing ranges',
      (c: Record<string, unknown>) => {
        point(c, 2)['rangeM'] = 50;
      },
      /strictly increase/,
    ],
    [
      'an empty curve',
      (c: Record<string, unknown>) => {
        weapon0(c)['hitProbabilityByRange'] = [];
      },
      /must not be empty/,
    ],
    [
      'a maximum range short of the curve',
      (c: Record<string, unknown>) => {
        weapon0(c)['maxEngagementRangeM'] = 250;
      },
      /at least the last curve point/,
    ],
    [
      'no time between shots',
      (c: Record<string, unknown>) => {
        weapon0(c)['secondsBetweenShots'] = 0;
      },
      /secondsBetweenShots/,
    ],
    [
      'an incapacitation probability above 1',
      (c: Record<string, unknown>) => {
        weapon0(c)['incapacitationProbabilityOnHit'] = 2;
      },
      /incapacitationProbabilityOnHit/,
    ],
    [
      'a repeated weapon',
      (c: Record<string, unknown>) => {
        (c['weapons'] as unknown[]).push(weapon0(c));
      },
      /repeats "rifle"/,
    ],
    [
      'reaction probabilities not summing to 1',
      (c: Record<string, unknown>) => {
        (
          (c['opfor'] as Record<string, unknown>)['reactionProbabilities'] as Record<
            string,
            unknown
          >
        )['flee'] = 0.5;
      },
      /must sum to 1/,
    ],
    [
      'a reaction delay range the wrong way round',
      (c: Record<string, unknown>) => {
        ((c['opfor'] as Record<string, unknown>)['reactionDelay'] as Record<string, unknown>)[
          'maxSeconds'
        ] = 0.1;
      },
      /at least minSeconds/,
    ],
    [
      'a zero maximum duration',
      (c: Record<string, unknown>) => {
        (c['engagement'] as Record<string, unknown>)['maxDurationSeconds'] = 0;
      },
      /maxDurationSeconds/,
    ],
    [
      'an unknown target policy',
      (c: Record<string, unknown>) => {
        (
          (c['engagement'] as Record<string, unknown>)['targetSelection'] as Record<string, unknown>
        )['OPFOR'] = 'random';
      },
      /targetSelection.OPFOR: must be one of nearest/,
    ],
    [
      'a misspelt field',
      (c: Record<string, unknown>) => {
        (c['opfor'] as Record<string, unknown>)['fleeSpeed'] = 3;
      },
      /\$.opfor.fleeSpeed: is not a known field/,
    ],
    [
      'a missing field',
      (c: Record<string, unknown>) => {
        delete (c['postureHitMultipliers'] as Record<string, unknown>)['prone'];
      },
      /postureHitMultipliers.prone: is missing/,
    ],
    [
      'another schema version',
      (c: Record<string, unknown>) => {
        c['schemaVersion'] = 2;
      },
      /schemaVersion: 2 is not supported/,
    ],
    [
      'a version that is not semantic',
      (c: Record<string, unknown>) => {
        c['version'] = 'v1';
      },
      /\$.version/,
    ],
  ])('refuses %s', (_, edit, message) => {
    expect(() => validateCombatConfig(edited(edit))).toThrow(CombatConfigError);
    expect(() => validateCombatConfig(edited(edit))).toThrow(message);
  });

  it('finds weapons by exact reference only', () => {
    expect(weaponCombatProfile(TEST_COMBAT_CONFIG, 'rifle')).toBe(TEST_RIFLE);
    expect(weaponCombatProfile(TEST_COMBAT_CONFIG, 'Rifle')).toBeUndefined();
    expect(weaponCombatProfile(TEST_COMBAT_CONFIG, 'unknown')).toBeUndefined();
  });
});
