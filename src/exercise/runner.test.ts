import { describe, expect, it } from 'vitest';
import { createSimulation } from '#sim';
import { createFixedStepRunner } from './runner';

function setup(tickRateHz: number, maxTicksPerAdvance?: number) {
  const sim = createSimulation({ tickRateHz });
  const runner = createFixedStepRunner(
    sim,
    maxTicksPerAdvance === undefined ? {} : { maxTicksPerAdvance },
  );
  return { sim, runner };
}

describe('createFixedStepRunner', () => {
  it.each([10, 20, 30, 60])('steps whole ticks from 60 fps frames at %i Hz', (tickRateHz) => {
    const { sim, runner } = setup(tickRateHz);
    for (let frame = 0; frame < 600; frame += 1) runner.advance(1 / 60);
    expect(sim.tick).toBe(tickRateHz * 10);
    expect(runner.droppedSeconds).toBe(0);
  });

  it('carries the remainder between frames and exposes it as alpha', () => {
    const { sim, runner } = setup(10);
    expect(runner.advance(0.25)).toBe(2);
    expect(sim.tick).toBe(2);
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

  it('caps ticks per advance and drops the excess time', () => {
    const { sim, runner } = setup(30, 10);
    expect(runner.advance(1)).toBe(10);
    expect(sim.tick).toBe(10);
    expect(runner.droppedSeconds).toBeCloseTo(20 / 30);
    expect(runner.advance(0)).toBe(0);
  });

  it('runs unbounded with maxTicksPerAdvance = Infinity (headless)', () => {
    const { sim, runner } = setup(30, Number.POSITIVE_INFINITY);
    expect(runner.advance(10)).toBe(300);
    expect(sim.timeSeconds).toBe(10);
  });

  it('does not step or accumulate time while paused', () => {
    const { sim, runner } = setup(30);
    runner.pause();
    expect(runner.advance(5)).toBe(0);
    runner.resume();
    expect(runner.advance(0)).toBe(0);
    expect(sim.tick).toBe(0);
  });

  it('scales real time by timeScale', () => {
    const { sim, runner } = setup(30, Number.POSITIVE_INFINITY);
    runner.timeScale = 4;
    runner.advance(1);
    expect(sim.tick).toBe(120);
    runner.timeScale = 0;
    runner.advance(1);
    expect(sim.tick).toBe(120);
  });

  it('rejects invalid input', () => {
    const { runner, sim } = setup(30);
    expect(() => runner.advance(-0.1)).toThrow(RangeError);
    expect(() => runner.advance(Number.NaN)).toThrow(RangeError);
    expect(() => {
      runner.timeScale = -1;
    }).toThrow(RangeError);
    expect(() => createFixedStepRunner(sim, { maxTicksPerAdvance: 0 })).toThrow(RangeError);
  });
});
