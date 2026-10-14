import { describe, expect, it } from 'vitest';
import { screenshotName } from './screenshot';

describe('screenshot names', () => {
  it('names a screenshot by battlefield, view and local time, safe as a file name', () => {
    const when = new Date(2026, 9, 13, 9, 5, 7);
    expect(screenshotName('Quantico, Prince William County, Virginia', '3d', when)).toBe(
      'quantico-3d-20261013-090507',
    );
    expect(screenshotName('38.52230° N, 77.29340° W', '2d', when)).toBe(
      '38.52230-n-2d-20261013-090507',
    );
    expect(screenshotName('', '2d', when)).toBe('battlefield-2d-20261013-090507');
  });
});
