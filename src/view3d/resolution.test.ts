import { describe, expect, it } from 'vitest';
import { createResolutionGovernor, RESOLUTION_STEPS } from './resolution';

// Adaptive render resolution: down when frames are slow, back when it
// gains nothing, up when there is room.

/**
 * Runs `seconds` of frames: each takes `cost(scale)` ms of drawing, shown
 * at the display's next refresh (every `periodMs`). The scales used.
 */
function run(
  governor: ReturnType<typeof createResolutionGovernor>,
  seconds: number,
  cost: (scale: number) => number,
  periodMs = 1000 / 60,
  start = 0,
) {
  let t = start;
  const scales: number[] = [];
  let scale = governor.scale;
  while (t < start + seconds * 1000) {
    const busy = cost(scale);
    t += Math.ceil(busy / periodMs - 1e-9) * periodMs;
    scale = governor.frame(t);
    scales.push(scale);
  }
  return { scales, end: t, last: scale };
}

/** A GPU filling pixels: its frame time grows with the pixels (the square of the scale). */
const gpuBound = (fullMs: number) => (scale: number) => 3 + (fullMs - 3) * scale * scale;

describe('adaptive resolution', () => {
  it('a GPU too slow for full resolution steps down until frames keep up', () => {
    const g = createResolutionGovernor();
    // 28 ms a frame at full resolution: 36 fps.
    const { last } = run(g, 20, gpuBound(28));
    expect(last).toBeLessThan(1);
    // At the scale it settles on, a frame fits the display's 60 Hz.
    expect(gpuBound(28)(last)).toBeLessThanOrEqual(1000 / 60);
    // And not lower than it needs.
    const above = RESOLUTION_STEPS[RESOLUTION_STEPS.indexOf(last) - 1] ?? 1;
    expect(gpuBound(28)(above)).toBeGreaterThan(1000 / 60);
  });

  it('a GPU with room stays at full resolution', () => {
    const g = createResolutionGovernor();
    const { scales } = run(g, 20, gpuBound(9));
    expect(new Set(scales)).toEqual(new Set([1]));
  });

  it('slow for another reason (the CPU), a lower resolution gains nothing: it goes back up', () => {
    const g = createResolutionGovernor();
    // 30 ms a frame whatever the resolution.
    const { scales } = run(g, 20, () => 30);
    // It tried two steps, saw no gain, and is back at full resolution (for a while).
    expect(scales.at(-1)).toBe(1);
    expect(Math.min(...scales)).toBeGreaterThanOrEqual(RESOLUTION_STEPS[2] ?? 0);
  });

  it('when the load passes, it comes back up to full resolution', () => {
    const g = createResolutionGovernor();
    const heavy = run(g, 15, gpuBound(28));
    expect(heavy.last).toBeLessThan(1);
    const light = run(g, 60, gpuBound(9), 1000 / 60, heavy.end);
    expect(light.last).toBe(1);
  });

  it('a pause (a hidden tab) is not a slow frame; reset is full resolution', () => {
    const g = createResolutionGovernor();
    g.frame(0);
    for (let k = 1; k <= 70; k += 1) g.frame(k * 16.7);
    // A long gap, then normal frames: no step down.
    let t = 70 * 16.7 + 5000;
    for (let k = 0; k < 70; k += 1) {
      t += 16.7;
      expect(g.frame(t)).toBe(1);
    }
    run(g, 15, gpuBound(28), 1000 / 60, t);
    expect(g.scale).toBeLessThan(1);
    g.reset();
    expect(g.scale).toBe(1);
  });
});
