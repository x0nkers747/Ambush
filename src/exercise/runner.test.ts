import { describe, expect, it } from 'vitest';
import {
  createFixedStepRunner,
  DEFAULT_MAX_CATCH_UP_SECONDS,
  maxTicksPerAdvance,
  type FixedStepRunnerOptions,
} from './runner';

/** A steppable that only counts its ticks. */
function setup(tickRateHz: number, options: FixedStepRunnerOptions = {}) {
  const target = {
    ticks: 0,
    dtSeconds: 1 / tickRateHz,
    step() {
      target.ticks += 1;
    },
  };
  return { target, runner: createFixedStepRunner(target, options) };
}

/** Frame durations for `seconds` of real time: 60 Hz, with every `missEvery`-th refresh missed. */
function frames(seconds: number, missEvery = 0): number[] {
  const out: number[] = [];
  let total = 0;
  for (let i = 1; total < seconds - 1e-9; i += 1) {
    const dt = missEvery > 0 && i % missEvery === 0 ? 2 / 60 : 1 / 60;
    out.push(dt);
    total += dt;
  }
  return out;
}

describe('createFixedStepRunner', () => {
  it.each([10, 20, 30, 60])('steps whole ticks from 60 fps frames at %i Hz', (tickRateHz) => {
    const { target, runner } = setup(tickRateHz);
    for (let frame = 0; frame < 600; frame += 1) runner.advance(1 / 60);
    expect(target.ticks).toBe(tickRateHz * 10);
    expect(runner.droppedSeconds).toBe(0);
  });

  it('carries the remainder between frames and exposes it as alpha', () => {
    const { target, runner } = setup(10);
    expect(runner.advance(0.1)).toBe(1);
    expect(runner.advance(0.15)).toBe(1);
    expect(target.ticks).toBe(2);
    expect(runner.alpha).toBeCloseTo(0.5);
    expect(runner.advance(0.05)).toBe(1);
    expect(runner.alpha).toBeCloseTo(0);
  });

  it('keeps alpha within [0, 1)', () => {
    const { runner } = setup(30);
    for (let frame = 0; frame < 1000; frame += 1) {
      runner.advance(0.0137);
      expect(runner.alpha).toBeGreaterThanOrEqual(0);
      expect(runner.alpha).toBeLessThan(1);
    }
  });

  it('runs unbounded with maxCatchUpSeconds = Infinity (headless)', () => {
    const { target, runner } = setup(30, { maxCatchUpSeconds: Number.POSITIVE_INFINITY });
    expect(runner.advance(10)).toBe(300);
    expect(target.ticks).toBe(300);
    expect(runner.droppedSeconds).toBe(0);
  });

  it('does not step or accumulate time while paused', () => {
    const { target, runner } = setup(30);
    runner.pause();
    expect(runner.advance(5)).toBe(0);
    runner.resume();
    expect(runner.advance(0)).toBe(0);
    expect(target.ticks).toBe(0);
  });

  it('scales real time by timeScale', () => {
    const { target, runner } = setup(30);
    runner.timeScale = 4;
    for (let frame = 0; frame < 60; frame += 1) runner.advance(1 / 60);
    expect(target.ticks).toBe(120);
    runner.timeScale = 0;
    runner.advance(1);
    expect(target.ticks).toBe(120);
  });

  it('rejects invalid input', () => {
    const { runner, target } = setup(30);
    expect(() => runner.advance(-0.1)).toThrow(RangeError);
    expect(() => runner.advance(Number.NaN)).toThrow(RangeError);
    expect(() => {
      runner.timeScale = -1;
    }).toThrow(RangeError);
    expect(() => createFixedStepRunner(target, { maxCatchUpSeconds: 0 })).toThrow(RangeError);
    expect(() => createFixedStepRunner(target, { maxCatchUpSeconds: Number.NaN })).toThrow(
      RangeError,
    );
  });
});

describe('catch-up budget', () => {
  it('is 100 ms of real time by default', () => {
    expect(DEFAULT_MAX_CATCH_UP_SECONDS).toBe(0.1);
  });

  it('scales with time scale and tick rate: budget × timeScale × tickRate ticks', () => {
    expect(maxTicksPerAdvance(0.1, 1, 30)).toBe(3);
    expect(maxTicksPerAdvance(0.1, 8, 30)).toBe(24);
    expect(maxTicksPerAdvance(0.1, 16, 30)).toBe(48);
    expect(maxTicksPerAdvance(0.1, 16, 120)).toBe(192);
    expect(maxTicksPerAdvance(0.1, 1, 10)).toBe(1);
  });

  it('rounds up fractions and ignores floating-point noise', () => {
    expect(maxTicksPerAdvance(0.1, 1, 25)).toBe(3); // 2.5 ticks
    expect(0.1 * 3 * 10).toBeGreaterThan(3); // 3.0000000000000004
    expect(maxTicksPerAdvance(0.1, 3, 10)).toBe(3);
    expect(maxTicksPerAdvance(0.1, 0, 30)).toBe(1);
  });

  it.each([1, 8, 16])('keeps up exactly at %i× with ordinary 60 fps frames', (scale) => {
    const { target, runner } = setup(30, { timeScale: scale });
    for (const dt of frames(10)) runner.advance(dt);
    expect(target.ticks).toBe(30 * scale * 10);
    expect(runner.droppedSeconds).toBe(0);
  });

  it.each([1, 8, 16])(
    'keeps up exactly at %i× when every third refresh is missed (33 ms frames)',
    (scale) => {
      const { target, runner } = setup(30, { timeScale: scale });
      const pattern = frames(10, 3);
      expect(pattern.filter((dt) => dt > 0.03)).not.toHaveLength(0);
      for (const dt of pattern) runner.advance(dt);
      expect(target.ticks).toBe(Math.round(30 * scale * pattern.reduce((a, b) => a + b, 0)));
      expect(runner.droppedSeconds).toBe(0);
    },
  );

  it.each([1, 8, 16])('does not drop time for a frame of exactly the budget at %i×', (scale) => {
    const { target, runner } = setup(30, { timeScale: scale });
    expect(runner.advance(DEFAULT_MAX_CATCH_UP_SECONDS)).toBe(3 * scale);
    expect(target.ticks).toBe(3 * scale);
    expect(runner.droppedSeconds).toBe(0);
  });

  it('cuts a long stall short at 16×, then carries on normally', () => {
    const { target, runner } = setup(30, { timeScale: 16 });
    // 5 s of stall is worth 2400 ticks; only 100 ms worth (48 ticks) is simulated.
    expect(runner.advance(5)).toBe(48);
    expect(runner.droppedSeconds).toBeCloseTo((2400 - 48) / 30, 9);
    expect(runner.alpha).toBeLessThan(1);
    for (const dt of frames(1)) runner.advance(dt);
    expect(target.ticks).toBe(48 + 480);
    expect(runner.droppedSeconds).toBeCloseTo((2400 - 48) / 30, 9);
  });

  it('cuts a long stall short at 1×', () => {
    const { target, runner } = setup(30);
    expect(runner.advance(5)).toBe(3);
    expect(target.ticks).toBe(3);
    expect(runner.droppedSeconds).toBeCloseTo(147 / 30, 9);
  });

  it('drops only the part of a frame beyond the budget', () => {
    const { target, runner } = setup(30, { timeScale: 16 });
    // 150 ms at 16× is 72 ticks: 48 stepped, 24 dropped.
    expect(runner.advance(0.15)).toBe(48);
    expect(target.ticks).toBe(48);
    expect(runner.droppedSeconds).toBeCloseTo(24 / 30, 9);
  });

  it('follows time-scale changes from one frame to the next', () => {
    const { target, runner } = setup(30, { timeScale: 1 });
    runner.advance(0.1);
    expect(target.ticks).toBe(3);
    runner.timeScale = 16;
    runner.advance(0.1);
    expect(target.ticks).toBe(3 + 48);
    expect(runner.droppedSeconds).toBe(0);
  });

  it('honours a custom budget', () => {
    const { target, runner } = setup(30, { timeScale: 8, maxCatchUpSeconds: 0.25 });
    expect(runner.advance(1)).toBe(60);
    expect(target.ticks).toBe(60);
    expect(runner.droppedSeconds).toBeCloseTo((240 - 60) / 30, 9);
  });
});
