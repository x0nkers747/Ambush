import { describe, expect, it } from 'vitest';
import { MAX_TICK_RATE_HZ, MIN_TICK_RATE_HZ } from './config';
import { createSimulation } from './simulation';

describe('createSimulation', () => {
  it('starts at tick 0 and time 0', () => {
    const sim = createSimulation({ tickRateHz: 30 });
    expect(sim.tick).toBe(0);
    expect(sim.timeSeconds).toBe(0);
  });

  it.each([10, 20, 30, 60])('derives dt and time from the tick count at %i Hz', (tickRateHz) => {
    const sim = createSimulation({ tickRateHz });
    expect(sim.dtSeconds).toBe(1 / tickRateHz);

    for (let i = 0; i < tickRateHz * 10; i += 1) sim.step();

    expect(sim.tick).toBe(tickRateHz * 10);
    expect(sim.timeSeconds).toBe(10);
  });

  it('does not share or expose mutable config', () => {
    const config = { tickRateHz: 30 };
    const sim = createSimulation(config);
    config.tickRateHz = 60;
    expect(sim.config.tickRateHz).toBe(30);
    expect(Object.isFrozen(sim.config)).toBe(true);
  });

  it.each([
    0,
    -1,
    MIN_TICK_RATE_HZ - 0.5,
    MAX_TICK_RATE_HZ + 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects tickRateHz = %s', (tickRateHz) => {
    expect(() => createSimulation({ tickRateHz })).toThrow(RangeError);
  });

  it('accepts the boundary tick rates', () => {
    expect(() => createSimulation({ tickRateHz: MIN_TICK_RATE_HZ })).not.toThrow();
    expect(() => createSimulation({ tickRateHz: MAX_TICK_RATE_HZ })).not.toThrow();
  });
});
