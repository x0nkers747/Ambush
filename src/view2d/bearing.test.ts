import { describe, expect, it } from 'vitest';
import { azimuthFromBearing, bearingDegrees, facingToward, formatBearing } from './bearing';

const DEG = Math.PI / 180;

describe('bearings', () => {
  it.each([
    [0, '000°'],
    [90 * DEG, '090°'],
    [180 * DEG, '180°'],
    [270 * DEG, '270°'],
    [45.4 * DEG, '045°'],
    [359.6 * DEG, '000°'],
    [7 * DEG, '007°'],
  ])('formats azimuth %f rad as %s', (azimuth, label) => {
    expect(formatBearing(azimuth)).toBe(label);
  });

  it('converts whole-degree bearings to normalized azimuths', () => {
    expect(azimuthFromBearing(90)).toBeCloseTo(Math.PI / 2, 12);
    expect(azimuthFromBearing(-90)).toBeCloseTo(270 * DEG, 12);
    expect(azimuthFromBearing(360)).toBe(0);
    expect(azimuthFromBearing(44.6)).toBeCloseTo(45 * DEG, 12);
    for (let degrees = 0; degrees < 360; degrees += 1) {
      expect(bearingDegrees(azimuthFromBearing(degrees))).toBe(degrees);
    }
  });
});

describe('facingToward', () => {
  const anchor = { x: 10, y: 20 };

  it.each([
    [{ x: 10, y: 50 }, 0],
    [{ x: 40, y: 20 }, 90],
    [{ x: 10, y: -5 }, 180],
    [{ x: -30, y: 20 }, 270],
    [{ x: 20, y: 30 }, 45],
  ])('dragging toward %o faces %i°', (pointer, degrees) => {
    expect(bearingDegrees(facingToward(anchor, pointer) ?? Number.NaN)).toBe(degrees);
  });

  it('snaps to whole degrees', () => {
    const azimuth = facingToward(anchor, {
      x: 10 + Math.sin(33.3 * DEG),
      y: 20 + Math.cos(33.3 * DEG),
    });
    expect(azimuth).toBeCloseTo(33 * DEG, 12);
  });

  it('is undefined when the pointer is on the anchor', () => {
    expect(facingToward(anchor, anchor)).toBeUndefined();
  });
});
