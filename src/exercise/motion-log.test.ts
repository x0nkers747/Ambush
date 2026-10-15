import { describe, expect, it } from 'vitest';
import type { SimState } from '#sim';
import { createMotionRecorder, emptyMotionSample } from './motion-log';

// The soldiers' motion log, the 3D characters' input (docs/character-animation.md).

const state = (tick: number, xs: number[], ids = xs.map((_, i) => `S${String(i)}`)) =>
  ({
    tick,
    soldiers: xs.map((x, i) => ({
      id: ids[i],
      position: { x, y: -x, z: 1 },
      azimuth: 0.5,
      posture: 'kneeling',
      status: 'active',
    })),
  }) as unknown as SimState;

describe('the motion recorder', () => {
  it('appends ticks and reads them back exactly, clamped to the recorded ticks', () => {
    const log = createMotionRecorder(30);
    log.record(state(5, [1.25, 2]));
    log.record(state(6, [1.5, 3]));
    log.record(state(7, [1.75, 4]));
    expect(log.firstTick).toBe(5);
    expect(log.lastTick).toBe(7);
    const s = emptyMotionSample();
    expect(log.read(1, 6, s)).toMatchObject({ x: 3, y: -3, z: 1, azimuth: 0.5 });
    expect(s.posture).toBe('kneeling');
    expect(log.read(0, 2, s).x).toBe(1.25);
    expect(log.read(0, 99, s).x).toBe(1.75);
    expect(log.indexOf('S1')).toBe(1);
    expect(log.indexOf('nobody')).toBe(-1);
  });

  it('keeps the latest tick as the state is now (edits between ticks)', () => {
    const log = createMotionRecorder(30);
    log.record(state(0, [1]));
    const epoch = log.epoch;
    log.record(state(0, [4]));
    expect(log.read(0, 0, emptyMotionSample()).x).toBe(4);
    expect(log.epoch).toBe(epoch);
  });

  it('starts again when time does not follow on or the soldiers change', () => {
    const log = createMotionRecorder(30);
    log.record(state(0, [1]));
    log.record(state(1, [2]));
    const epoch = log.epoch;
    log.record(state(9, [3]));
    expect(log.firstTick).toBe(9);
    expect(log.epoch).toBe(epoch + 1);
    log.record(state(10, [3, 4]));
    expect(log.soldierIds).toEqual(['S0', 'S1']);
    expect(log.firstTick).toBe(10);
  });

  it('holds thousands of ticks across chunks', () => {
    const log = createMotionRecorder(30);
    for (let t = 0; t < 5000; t += 1) log.record(state(t, [t / 8]));
    const s = emptyMotionSample();
    for (const t of [0, 1023, 1024, 2047, 4999]) expect(log.read(0, t, s).x).toBe(t / 8);
  });
});
