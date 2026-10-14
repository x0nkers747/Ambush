/**
 * Locomotion blend weights from speed and direction (a 2D blend space: a 1D
 * speed chain per cardinal direction, cardinal weights from the travel angle)
 * and the cycle distance the gait clock needs. Pure functions of the pose
 * input; the native runtime applies these weights directly, and the animouse
 * runtime feeds the same speed and direction to its own blend trees.
 */

import type { ClipSource } from './assets';
import type { Posture } from './sim';
import type { ClipSlot } from './rigs';
import { TURN_STEP_M_PER_RAD } from './gait';

export type Weights = Map<ClipSlot, number>;

/** Typical speeds (m/s) when a clip's measured speed is unusable. */
const FALLBACK_SPEED: Partial<Record<ClipSlot, number>> = {
  walk: 1.4,
  walkBack: 1.1,
  walkLeft: 1.1,
  walkRight: 1.1,
  run: 3.5,
  runBack: 3,
  runLeft: 3,
  runRight: 3,
  sprint: 5.8,
  kneelWalk: 1.0,
  crawl: 0.35,
};

export interface LocomotionSet {
  readonly clips: Partial<Record<ClipSlot, ClipSource>>;
}

export function slotSpeed(clips: LocomotionSet['clips'], slot: ClipSlot): number {
  const m = clips[slot]?.metrics.speed ?? 0;
  const f = FALLBACK_SPEED[slot] ?? 1;
  // A measurement far from the expected range is a failed measurement.
  return m > f * 0.35 && m < f * 3 ? m : f;
}

export function slotCycle(clips: LocomotionSet['clips'], slot: ClipSlot): number {
  const c = clips[slot];
  return c ? slotSpeed(clips, slot) * c.clip.duration : 0;
}

/** Weights along a chain of clips ordered by speed, for `speed`. */
function chain(
  clips: LocomotionSet['clips'],
  slots: readonly ClipSlot[],
  speed: number,
  out: Weights,
  scale: number,
): void {
  const present = slots.filter((s) => clips[s]);
  if (present.length === 0 || scale <= 0) return;
  const speeds = present.map((s, i) => (i === 0 && isIdle(s) ? 0 : slotSpeed(clips, s)));
  const add = (s: ClipSlot | undefined, w: number) => {
    if (s && w > 0) out.set(s, (out.get(s) ?? 0) + w * scale);
  };
  if (speed <= (speeds[0] ?? 0)) {
    add(present[0], 1);
    return;
  }
  for (let i = 1; i < present.length; i++) {
    const v0 = speeds[i - 1] ?? 0;
    const v1 = speeds[i] ?? 0;
    if (speed <= v1) {
      const t = (speed - v0) / Math.max(1e-6, v1 - v0);
      add(present[i - 1], 1 - t);
      add(present[i], t);
      return;
    }
  }
  add(present[present.length - 1], 1);
}

const isIdle = (s: ClipSlot) => s === 'idle' || s === 'kneelIdle' || s === 'proneIdle';

/** The idle and moving slots of each posture, by direction. */
export const POSTURE_SETS: Record<
  Posture,
  { idle: ClipSlot; forward: ClipSlot[]; back: ClipSlot[]; left: ClipSlot[]; right: ClipSlot[] }
> = {
  standing: {
    idle: 'idle',
    forward: ['walk', 'run', 'sprint'],
    back: ['walkBack', 'runBack'],
    left: ['walkLeft', 'runLeft'],
    right: ['walkRight', 'runRight'],
  },
  kneeling: { idle: 'kneelIdle', forward: ['kneelWalk'], back: [], left: [], right: [] },
  prone: { idle: 'proneIdle', forward: ['crawl'], back: [], left: [], right: [] },
};

export interface LocomotionBlend {
  readonly weights: Weights;
  /** Metres per loop of the moving part of the blend (0 when only idle). */
  readonly cycleDistance: number;
}

/**
 * Weights of a posture's locomotion clips for a speed and travel angle
 * (radians relative to facing, clockwise). Directions without clips fall back
 * to the forward chain.
 */
export function locomotionBlend(
  clips: LocomotionSet['clips'],
  posture: Posture,
  speed: number,
  moveAngle: number,
  turnRate = 0,
): LocomotionBlend {
  const set = POSTURE_SETS[posture];
  const weights: Weights = new Map();
  const effective = Math.max(speed, Math.abs(turnRate) * TURN_STEP_M_PER_RAD);
  const angle = speed > 0.05 ? moveAngle : 0;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  let dirs: [ClipSlot[], number][] = [
    [set.forward, Math.max(0, c)],
    [set.back, Math.max(0, -c)],
    [set.right, Math.max(0, s)],
    [set.left, Math.max(0, -s)],
  ];
  // Directions with no clips give their share to the forward chain.
  let spill = 0;
  dirs = dirs.map(([slots, w]) => {
    if (slots === set.forward || slots.some((x) => clips[x])) return [slots, w];
    spill += w;
    return [slots, 0];
  });
  const first = dirs[0];
  if (first) first[1] += spill;
  const total = dirs.reduce((a, [, w]) => a + w, 0) || 1;
  for (const [slots, w] of dirs) {
    chain(clips, [set.idle, ...slots], effective, weights, w / total);
  }
  if (!clips[set.idle]) {
    // No idle clip (prone): hold the moving clip still instead.
    const w = weights.get(set.idle) ?? 0;
    weights.delete(set.idle);
    const f = set.forward[0];
    if (f && w > 0) weights.set(f, (weights.get(f) ?? 0) + w);
  }
  let cycle = 0;
  let moving = 0;
  for (const [slot, w] of weights) {
    if (isIdle(slot)) continue;
    cycle += w * slotCycle(clips, slot);
    moving += w;
  }
  return { weights, cycleDistance: moving > 0 ? cycle / moving : 0 };
}

/** Cycle distance for the gait clock (any posture, moving or not). */
export function cycleDistanceFor(
  clips: LocomotionSet['clips'],
  posture: Posture,
  speed: number,
  moveAngle: number,
): number {
  const b = locomotionBlend(clips, posture, Math.max(speed, 0.3), moveAngle);
  return b.cycleDistance;
}
