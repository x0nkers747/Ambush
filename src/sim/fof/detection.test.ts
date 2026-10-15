import { describe, expect, it } from 'vitest';
import { NO_FEATURES, rectangle } from '../environment';
import { soldierId, type Soldier } from '../state';
import { flatTerrain } from '../behavior/test-fixtures';
import type { DetectionConfig, VisibilityConditions } from './config';
import {
  chanceIn,
  confidenceAt,
  cyclesOnTarget,
  levelAt,
  sight,
  ttpf,
  vegetationTransmission,
} from './detection';
import type { FofTrack } from './types';

// The detection model's parts (docs/behavior-lab/force-on-force/02).

const DETECTION: DetectionConfig = {
  scanIntervalSeconds: 1,
  cycleArcmin: 3,
  detectionCycles50: 1,
  identificationCycles50: 4,
  searchSeconds: 3.4,
  unalertedSearchFactor: 0.3,
  alertedSearchFactor: 1,
  centralHalfAngleDeg: 60,
  regardHalfAngleDeg: 110,
  peripheralFactor: 0.3,
  criticalDimensionM: { standing: 0.95, kneeling: 0.71, prone: 0.46 },
  eyeHeightM: { standing: 1.65, kneeling: 1, prone: 0.3 },
  targetSampleHeightsM: {
    standing: [1.6, 1.1, 0.5],
    kneeling: [1, 0.6, 0.3],
    prone: [0.3, 0.2, 0.1],
  },
  movingTargetFactor: 1.5,
  firingSignatureFactor: 3,
  firingSignatureSeconds: 3,
  movingSpeedMps: 0.3,
  confidenceGain: 0.4,
  confirmConfidence: 0.7,
  lostConfidence: 0.3,
  dropConfidence: 0.1,
  forgetConfidence: 0.03,
  confidenceHalfLifeSeconds: 15,
  trackingFactor: 4,
  underFireConfidence: 0.45,
};
const OPEN: VisibilityConditions = {
  label: 'open',
  backgroundContrast: 0.25,
  meteorologicalVisibilityM: 20000,
  maxObservationRangeM: 1200,
};

function soldier(
  id: string,
  x: number,
  y: number,
  azimuth = 0,
  posture: Soldier['posture'] = 'standing',
): Soldier {
  return {
    id: soldierId(id),
    side: 'BLUEFOR',
    unitId: 'U' as Soldier['unitId'],
    position: { x, y, z: 10 },
    azimuth,
    posture,
    status: 'active',
    orders: null,
  };
}

describe('the target transfer probability function', () => {
  it('is one half at the 50 % cycles, rises with cycles, and is 0 without any', () => {
    expect(ttpf(1, 1)).toBeCloseTo(0.5, 12);
    expect(ttpf(4, 4)).toBeCloseTo(0.5, 12);
    expect(ttpf(0, 1)).toBe(0);
    let last = 0;
    for (const n of [0.1, 0.3, 0.6, 1, 1.5, 2, 4, 8]) {
      const p = ttpf(n, 1);
      expect(p).toBeGreaterThan(last);
      last = p;
    }
    expect(ttpf(3, 1)).toBeGreaterThan(0.99);
  });
});

describe('what an observer gets of a target', () => {
  const terrain = flatTerrain();
  it('fewer cycles farther, prone than standing, still than moving; more with fire', () => {
    const observer = soldier('A', 0, -300);
    const at = (y: number, posture: Soldier['posture'] = 'standing') => {
      const target = soldier('B', 0, y, 0, posture);
      const seen = sight(terrain, observer, target, DETECTION, OPEN);
      if (!seen) throw new Error('not in view');
      return (cue = 1) =>
        cyclesOnTarget(seen, DETECTION.criticalDimensionM[posture], DETECTION, OPEN, cue);
    };
    expect(at(0)()).toBeGreaterThan(at(300)());
    expect(at(0, 'prone')()).toBeLessThan(at(0)());
    expect(at(0)(1.5)).toBeGreaterThan(at(0)());
    expect(at(0)(3)).toBeCloseTo(3 * at(0)(), 12);
  });

  it('nothing outside the field of regard or beyond the observation range', () => {
    const observer = soldier('A', 0, 0, 0);
    expect(sight(terrain, observer, soldier('B', 0, -200), DETECTION, OPEN)).toBeNull();
    expect(sight(terrain, observer, soldier('B', 0, 1300), DETECTION, OPEN)).toBeNull();
    const side = sight(terrain, observer, soldier('B', 200, 50), DETECTION, OPEN);
    expect(side?.attention).toBe(DETECTION.peripheralFactor);
    expect(sight(terrain, observer, soldier('B', 20, 200), DETECTION, OPEN)?.attention).toBe(1);
  });

  it('a building between them hides the target; a low wall hides only a prone one', () => {
    const house = {
      ...NO_FEATURES,
      buildings: [{ id: 'house', footprint: rectangle(0, 100, 10, 10), heightMeters: 6 }],
    };
    const wall = {
      ...NO_FEATURES,
      buildings: [{ id: 'wall', footprint: rectangle(0, 150, 20, 0.5), heightMeters: 1 }],
    };
    const observer = soldier('A', 0, 0);
    const behindHouse = sight(flatTerrain(house), observer, soldier('B', 0, 200), DETECTION, OPEN);
    expect(behindHouse?.visibleFraction).toBe(0);
    const standing = sight(flatTerrain(wall), observer, soldier('B', 0, 152), DETECTION, OPEN);
    const prone = sight(
      flatTerrain(wall),
      observer,
      soldier('B', 0, 152, 0, 'prone'),
      DETECTION,
      OPEN,
    );
    expect(standing?.visibleFraction).toBeGreaterThan(0);
    expect(standing?.visibleFraction).toBeLessThan(1);
    expect(prone?.visibleFraction).toBe(0);
  });
});

describe('vegetation along the line', () => {
  it('lets through one minus depth over see-through depth, per area', () => {
    const wood = {
      ...NO_FEATURES,
      vegetation: [
        {
          id: 'wood',
          kind: 'woodland' as const,
          boundary: rectangle(0, 100, 40, 20),
          canopyHeightMeters: 15,
          seeThroughMeters: 40,
        },
      ],
    };
    const terrain = flatTerrain(wood);
    // 20 m of wood along the line, 40 m see-through: half the light.
    expect(vegetationTransmission(terrain, { x: 0, y: 0 }, { x: 0, y: 200 })).toBeCloseTo(0.5, 9);
    expect(vegetationTransmission(terrain, { x: 100, y: 0 }, { x: 100, y: 200 })).toBe(1);
    // From inside, 10 m to its edge.
    expect(vegetationTransmission(terrain, { x: 0, y: 100 }, { x: 0, y: 300 })).toBeCloseTo(
      0.75,
      9,
    );
  });
});

describe('track confidence and level', () => {
  const track = (confidence: number, confirmed: boolean, identified = false): FofTrack => ({
    force: 0,
    targetId: soldierId('B'),
    confidence,
    lastSeenAt: 0,
    confirmed,
    identified,
    level: 'possible',
    lastKnown: { x: 0, y: 0 },
    firstAt: 0,
    seenBy: null,
  });

  it('halves every half-life', () => {
    expect(confidenceAt(track(0.8, false), 15, 15)).toBeCloseTo(0.4, 12);
    expect(confidenceAt(track(0.8, false), 30, 15)).toBeCloseTo(0.2, 12);
  });

  it('confirms high, loses low (hysteresis), and drops or forgets lower still', () => {
    expect(levelAt(track(0.4, false), 0, DETECTION)).toEqual({
      level: 'possible',
      confirmed: false,
    });
    expect(levelAt(track(0.7, false), 0, DETECTION)).toEqual({
      level: 'detected',
      confirmed: true,
    });
    // Confirmed, then fading: still detected down to the lost threshold, below the confirm one.
    expect(levelAt(track(0.5, true), 0, DETECTION).level).toBe('detected');
    expect(levelAt(track(0.5, true, true), 0, DETECTION).level).toBe('identified');
    expect(levelAt(track(0.29, true), 0, DETECTION).level).toBe('lost');
    expect(levelAt(track(0.02, true), 0, DETECTION).level).toBeNull();
    expect(levelAt(track(0.09, false), 0, DETECTION).level).toBeNull();
  });

  it('chance in a window from a rate', () => {
    expect(chanceIn(0, 1)).toBe(0);
    expect(chanceIn(Math.LN2, 1)).toBeCloseTo(0.5, 12);
  });
});
