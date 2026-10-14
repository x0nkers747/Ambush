/**
 * The prototype's deterministic core, in node: the mini-simulation, pose
 * input interpolation, the gait clock and the locomotion weights.
 */

import { describe, expect, test } from 'vitest';
import type { ClipSource } from '../src/assets';
import { GaitClock } from '../src/gait';
import { locomotionBlend } from '../src/locomotion';
import { poseInputAt } from '../src/pose-input';
import type { ClipSlot } from '../src/rigs';
import { DT, MiniSim, POSTURE_SECONDS, recordTestSequence, TICK_HZ } from '../src/sim';

describe('mini-simulation', () => {
  test('the same commands give the same frames', () => {
    expect(JSON.stringify(recordTestSequence())).toBe(JSON.stringify(recordTestSequence()));
  });

  test('live commands are applied at the next tick and recorded', () => {
    const sim = new MiniSim();
    sim.stepTo(10);
    sim.command({ speed: 1.5, heading: 0 });
    sim.stepTo(40);
    expect(sim.frames).toHaveLength(41);
    expect(sim.frames[10]?.s.vx).toBe(0);
    expect(sim.frames[40]?.s.y).toBeGreaterThan(0.5);
  });

  test('a posture change takes the configured time and blocks movement', () => {
    const frames = recordTestSequence();
    // The sequence kneels at 21 s.
    const i = poseInputAt(frames, 21 + POSTURE_SECONDS.standing.kneeling / 2);
    expect(i.posture).toBe('kneeling');
    expect(i.postureFrom).toBe('standing');
    expect(i.postureT).toBeGreaterThan(0.3);
    expect(i.postureT).toBeLessThan(0.7);
    expect(i.speed).toBe(0);
  });
});

describe('pose input', () => {
  const frames = recordTestSequence();

  test('equals the recorded state at whole ticks', () => {
    for (const tick of [0, 30, 301, 900]) {
      const s = frames[tick]?.s;
      const i = poseInputAt(frames, tick / TICK_HZ);
      expect(i.x).toBeCloseTo(s?.x ?? NaN, 12);
      expect(i.y).toBeCloseTo(s?.y ?? NaN, 12);
      expect(i.odometer).toBeCloseTo(s?.odometer ?? NaN, 12);
    }
  });

  test('interpolates between ticks', () => {
    const a = frames[200]?.s;
    const b = frames[201]?.s;
    const i = poseInputAt(frames, (200 + 0.25) * DT);
    expect(i.y).toBeCloseTo((a?.y ?? 0) + ((b?.y ?? 0) - (a?.y ?? 0)) * 0.25, 9);
  });

  test('is a function of time only', () => {
    const t = 17.3456;
    expect(JSON.stringify(poseInputAt(frames, t))).toBe(JSON.stringify(poseInputAt(frames, t)));
  });
});

describe('gait clock', () => {
  const frames = recordTestSequence();
  const cycle = () => 1.6;

  test('gives the same phase whatever the order of queries', () => {
    const times = [3.3, 9.1, 0.5, 44, 12.25, 30, 7.77];
    const forward = new GaitClock(frames, cycle);
    const ref = new Map([...times].sort((a, b) => a - b).map((t) => [t, forward.phaseAt(t)]));
    const shuffled = new GaitClock(frames, cycle);
    for (const t of times) expect(shuffled.phaseAt(t)).toBe(ref.get(t));
    const backward = new GaitClock(frames, cycle);
    for (const t of [...times].sort((a, b) => b - a)) expect(backward.phaseAt(t)).toBe(ref.get(t));
  });

  test('advances by distance over cycle distance', () => {
    const g = new GaitClock(frames, cycle);
    const a = poseInputAt(frames, 6);
    const b = poseInputAt(frames, 7);
    // Moving straight (no turning) between 6 and 7 s.
    expect(g.phaseAt(7) - g.phaseAt(6)).toBeCloseTo((b.odometer - a.odometer) / 1.6, 6);
  });
});

describe('locomotion weights', () => {
  const clip = (speed: number, duration = 1): ClipSource =>
    ({
      clip: { duration },
      origin: 'test',
      retargeted: false,
      metrics: { speed, cycleDistance: speed * duration },
    }) as unknown as ClipSource;
  const clips: Partial<Record<ClipSlot, ClipSource>> = {
    idle: clip(0, 3),
    walk: clip(1.4),
    run: clip(3.5),
    sprint: clip(5.8),
    walkBack: clip(1.1),
    walkLeft: clip(1.1),
    walkRight: clip(1.1),
    kneelIdle: clip(0, 2),
    kneelWalk: clip(1),
    crawl: clip(0.35),
  };

  test('sum to 1 for every posture, speed and direction', () => {
    for (const posture of ['standing', 'kneeling', 'prone'] as const) {
      for (let speed = 0; speed <= 7; speed += 0.35) {
        for (let a = -Math.PI; a <= Math.PI; a += Math.PI / 8) {
          const b = locomotionBlend(clips, posture, speed, a);
          const sum = [...b.weights.values()].reduce((x, y) => x + y, 0);
          expect(sum).toBeCloseTo(1, 9);
        }
      }
    }
  });

  test('pick the clip matching the speed', () => {
    expect(locomotionBlend(clips, 'standing', 0, 0).weights.get('idle')).toBe(1);
    expect(locomotionBlend(clips, 'standing', 3.5, 0).weights.get('run')).toBeCloseTo(1, 9);
    const half = locomotionBlend(clips, 'standing', 2.45, 0).weights;
    expect(half.get('walk')).toBeCloseTo(0.5, 9);
    expect(half.get('run')).toBeCloseTo(0.5, 9);
    expect(locomotionBlend(clips, 'standing', 1.1, Math.PI).weights.get('walkBack')).toBeCloseTo(
      1,
      9,
    );
  });
});
