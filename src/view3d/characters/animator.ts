import * as THREE from 'three';
import { applyRestPose, restoreClipPose, saveClipPose, type SoldierView } from './character';
import { clipVariants, type ClipVariants } from './clip-bank';
import type { GaitClock } from './gait';
import { locomotionBlend } from './locomotion';
import type { PoseInput } from './motion';
import type { ClipSlot } from './rig';

// A soldier's animator (docs/character-animation.md): three.js's own animation
// system (AnimationMixer and AnimationAction) used as a sampler. Every
// action's weight and time are computed from the pose input, then
// `mixer.update(0)` samples them: the pose is a pure function of (motion log,
// combat log, time), so pause, slow motion, fast forward and seeking in any
// order give identical poses. Ported from the approved prototype
// (prototypes/character-animation/src/runtimes/native.ts).
//
// What three.js provides: clip sampling, weighted blending with quaternion
// slerp, track-filtered layers (upper and lower body). What this file adds:
// the weights — a 2D locomotion blend space, posture crossfades, the
// weapon-carrying upper-body layer, the death blend — and gait-phase timing.

const smooth = (t: number) => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
};
const frac = (x: number) => x - Math.floor(x);

type Part = 'lower' | 'upper' | 'overlay';
interface Sample {
  w: number;
  time: number;
}

const IDLE_SLOTS = new Set<ClipSlot>(['idle', 'kneelIdle', 'proneIdle']);

/** The part of the death clip played (s): from the collapse to lying still. */
const DEATH_CLIP = { start: 1.55, end: 4.0 };
/** How long an incapacitated soldier takes to go down (s of simulation time). */
export const FALL_SECONDS = 1.2;

/** The parts of three.js's mixer `forceWrites` reaches (not in its typings). */
interface MixerInternals {
  readonly _accuIndex: number;
  readonly _bindings: readonly {
    readonly buffer: Float64Array;
    readonly valueSize: number;
    readonly _origIndex: number;
  }[];
  readonly _nActiveBindings: number;
}

/**
 * Makes the next `mixer.update` a function of this update's weights and
 * times alone. three.js's PropertyMixer keeps two accumulators per property
 * and alternates between them:
 * - a property no playing clip animates (weight 0) is set to its original
 *   value by blending the accumulator's stale content — from two updates
 *   ago — toward it at t = 1, and `Quaternion.slerpFlat` has no exact path
 *   for t = 1: whether the result is renormalised depends on how close the
 *   stale value was (seen as 5e-8 on a face bone after seeking backward);
 * - and a property whose new value equals the previous update's is not
 *   written at all.
 * So the accumulator about to be written starts at the original value, and
 * the one it is compared with (the previous update's) is invalidated.
 */
function forceWrites(mixer: THREE.AnimationMixer): number {
  const m = mixer as unknown as MixerInternals;
  // The next update writes accumulator `_accuIndex ^ 1` and compares it with `_accuIndex`.
  const previous = m._accuIndex;
  for (let i = 0; i < m._nActiveBindings; i += 1) {
    const binding = m._bindings[i];
    if (!binding) continue;
    const n = binding.valueSize;
    const original = binding._origIndex * n;
    binding.buffer.copyWithin((previous ^ 1) * n + n, original, original + n);
    binding.buffer.fill(Number.NaN, previous * n + n, previous * n + n + n);
  }
  return previous;
}

/**
 * After `forceWrites` and the update: the invalidated accumulator gets the
 * update's result, as the mixer would have left it (it is written next time,
 * and a property with no weight then blends it by 0, which NaN would survive).
 */
function settleAccumulators(mixer: THREE.AnimationMixer, previous: number): void {
  const m = mixer as unknown as MixerInternals;
  const written = previous ^ 1;
  for (let i = 0; i < m._nActiveBindings; i += 1) {
    const binding = m._bindings[i];
    if (!binding) continue;
    const n = binding.valueSize;
    binding.buffer.copyWithin(previous * n + n, written * n + n, written * n + n + n);
  }
}

/** Each playing action's weight and time, for checks (`layer|slot` keys). */
export type AnimatorState = Readonly<Record<string, readonly [number, number]>>;

export class Animator {
  private readonly mixer: THREE.AnimationMixer;
  private readonly bank: Map<ClipSlot, ClipVariants>;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private readonly lower = new Map<ClipSlot, Sample>();
  private readonly overlay = new Map<ClipSlot, Sample>();
  private upperWeight = 0;
  private readonly soldier: SoldierView;
  private readonly gait: GaitClock;
  private readonly idleOffset: number;

  /**
   * @param idleOffset Cosmetic per-soldier offset into idle clips (seconds;
   * from a hash of the soldier's id, never `Math.random`), so a squad does not
   * breathe in step.
   */
  constructor(soldier: SoldierView, gait: GaitClock, idleOffset = 0) {
    this.soldier = soldier;
    this.gait = gait;
    this.idleOffset = idleOffset;
    applyRestPose(soldier);
    this.mixer = new THREE.AnimationMixer(soldier.root);
    this.bank = clipVariants(soldier.asset);
    for (const [slot, v] of this.bank) {
      for (const part of ['lower', 'upper', 'overlay'] as const) {
        const a = this.mixer.clipAction(v[part]);
        a.setLoop(THREE.LoopRepeat, Infinity);
        a.weight = 0;
        a.play();
        this.actions.set(`${slot}:${part}`, a);
      }
    }
  }

  private add(map: Map<ClipSlot, Sample>, slot: ClipSlot, w: number, time: number) {
    if (w <= 1e-5 || !this.bank.has(slot)) return;
    const s = map.get(slot);
    if (s) s.w += w;
    else map.set(slot, { w, time });
  }

  private loopTime(slot: ClipSlot, phase: number, t: number): number {
    const d = this.bank.get(slot)?.duration ?? 1;
    return IDLE_SLOTS.has(slot) ? (((t + this.idleOffset) % d) + d) % d : frac(phase) * d;
  }

  /** Samples the clips for `input` into the skeleton (before post-processing). */
  update(input: PoseInput): void {
    restoreClipPose(this.soldier);
    const clips = this.soldier.asset.clips;
    const t = input.time;
    const phase = this.gait.phaseAt(t);
    const lower = this.lower;
    const overlay = this.overlay;
    lower.clear();
    overlay.clear();

    // Locomotion of the current posture, crossfaded from the previous one
    // over the posture change.
    const k = input.postureFrom === input.posture ? 1 : smooth(input.postureT);
    const addPosture = (p: PoseInput['posture'], scale: number) => {
      if (scale <= 0) return;
      const b = locomotionBlend(clips, p, input.speed, input.moveAngle, input.turnRate);
      for (const [slot, w] of b.weights)
        this.add(lower, slot, w * scale, this.loopTime(slot, phase, t));
    };
    addPosture(input.postureFrom, 1 - k);
    addPosture(input.posture, k);

    // Incapacitation: blend into the death clip's collapse (its first 1.5 s
    // are a stagger), sped up so the soldier is down within FALL_SECONDS.
    let alive = 1;
    if (input.sinceDown >= 0 && this.bank.has('death')) {
      const d = smooth(input.sinceDown / 0.2);
      alive = 1 - d;
      for (const s of lower.values()) s.w *= alive;
      const dur = this.bank.get('death')?.duration ?? 1;
      const end = Math.min(DEATH_CLIP.end, dur - 1e-3);
      const at = DEATH_CLIP.start + (input.sinceDown / FALL_SECONDS) * (end - DEATH_CLIP.start);
      this.add(lower, 'death', d, Math.min(at, end));
    }

    // Upper body: the idle clip's calm upper body under the procedural weapon
    // hold (blade, aim, hand IK: character.ts), over the locomotion's.
    // (Every carry uses it: lowered, ready and aimed differ in the hold alone.)
    const idle = input.posture === 'kneeling' ? 'kneelIdle' : 'idle';
    this.add(overlay, idle, 1, this.loopTime(idle, phase, t));
    const prone = input.posture === 'prone' || input.postureFrom === 'prone';
    const u = (prone ? 0 : 1) * alive;
    this.upperWeight = u;

    for (const a of this.actions.values()) a.weight = 0;
    const set = (slot: ClipSlot, part: Part, w: number, time: number) => {
      const a = this.actions.get(`${slot}:${part}`);
      if (!a || w <= 0) return;
      a.weight = w;
      a.time = time;
    };
    for (const [slot, s] of lower) {
      set(slot, 'lower', s.w, s.time);
      set(slot, 'upper', s.w * (1 - u), s.time);
    }
    for (const [slot, s] of overlay) set(slot, 'overlay', s.w * u, s.time);
    const previous = forceWrites(this.mixer);
    this.mixer.update(0);
    settleAccumulators(this.mixer, previous);
    saveClipPose(this.soldier);
  }

  /** The playing actions' weights and times. */
  state(): AnimatorState {
    const out: Record<string, readonly [number, number]> = {};
    for (const [slot, s] of this.lower) out[`lower|${slot}`] = [s.w, s.time];
    for (const [slot, s] of this.overlay) out[`upper|${slot}`] = [s.w * this.upperWeight, s.time];
    return out;
  }

  /** A one-line summary, for checks and the debug hook. */
  describe(): string {
    return Object.entries(this.state())
      .filter(([, [w]]) => w > 0.01)
      .map(([key, [w, time]]) => `${key} ${(w * 100).toFixed(0)}% @${time.toFixed(2)}s`)
      .join(', ');
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.soldier.root);
  }
}
