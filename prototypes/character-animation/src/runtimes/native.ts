/**
 * Candidate A: three.js's own animation system (AnimationMixer and
 * AnimationAction), used as a sampler. Every action's weight and time are
 * computed from the pose input and the recording, then `mixer.update(0)`
 * samples them: the pose is a pure function of (recording, time), so pause,
 * slow motion, fast forward and seeking in any order give identical poses.
 *
 * What three.js provides: clip sampling, weighted blending with quaternion
 * slerp, track-filtered layers (upper/lower body), clip cloning per soldier.
 * What this file adds (the custom part): the weights — a 2D locomotion blend
 * space, posture crossfades, the upper-body layer, fire and death blends —
 * and distance-based gait phase.
 */

import * as THREE from 'three';
import type { CharacterAsset } from '../assets';
import { applyRestPose, restoreClipPose, saveClipPose, type SoldierView } from '../character';
import { clipVariants, type ClipVariants } from '../clip-bank';
import { GaitClock } from '../gait';
import { cycleDistanceFor, locomotionBlend } from '../locomotion';
import type { PoseInput } from '../pose-input';
import type { ClipSlot } from '../rigs';
import { angleDelta, type Carry, type SimFrame } from '../sim';
import type { Animator, FrameContext, Runtime } from './types';

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

/**
 * Where the rifle-carrying upper body comes from: the retargeted KayKit
 * rifle clips (aim, run-with-rifle, shoot), or the idle clip's calm upper
 * body with the hold made procedurally (blade, aim pitch, hand IK).
 */
export const upperBodySettings: { source: 'kaykit' | 'idle' } = { source: 'idle' };

export function gaitFor(asset: CharacterAsset, frames: readonly SimFrame[]): GaitClock {
  return new GaitClock(frames, (s) => {
    const speed = Math.hypot(s.vx, s.vy);
    const angle = speed > 1e-4 ? angleDelta(s.azimuth, Math.atan2(s.vx, s.vy)) : 0;
    return cycleDistanceFor(asset.clips, s.posture, speed, angle);
  });
}

class NativeAnimator implements Animator {
  private readonly mixer: THREE.AnimationMixer;
  private readonly bank: Map<ClipSlot, ClipVariants>;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private gait: GaitClock;
  private text = '';
  private readonly soldier: SoldierView;
  /** Cosmetic per-soldier offset for idle clips (a hash of the id, never Math.random). */
  private readonly idleOffset: number;

  constructor(soldier: SoldierView, frames: readonly SimFrame[], idleOffset = 0) {
    this.soldier = soldier;
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
    this.gait = gaitFor(soldier.asset, frames);
  }

  reset(frames: readonly SimFrame[]): void {
    this.gait = gaitFor(this.soldier.asset, frames);
  }

  private add(map: Map<ClipSlot, Sample>, slot: ClipSlot, w: number, time: number) {
    if (w <= 1e-5 || !this.bank.has(slot)) return;
    const s = map.get(slot);
    if (s) s.w += w;
    else map.set(slot, { w, time });
  }

  private loopTime(slot: ClipSlot, phase: number, t: number): number {
    const d = this.bank.get(slot)?.duration ?? 1;
    return IDLE_SLOTS.has(slot) ? (t + this.idleOffset) % d : frac(phase) * d;
  }

  update(input: PoseInput): void {
    restoreClipPose(this.soldier);
    const clips = this.soldier.asset.clips;
    const t = input.time;
    const phase = this.gait.phaseAt(t);
    const lower = new Map<ClipSlot, Sample>();

    // Locomotion of the current posture, crossfaded from the previous one
    // over the simulation's posture-change window.
    const k = input.postureFrom === input.posture ? 1 : smooth(input.postureT);
    const addPosture = (p: PoseInput['posture'], scale: number) => {
      if (scale <= 0) return;
      const b = locomotionBlend(clips, p, input.speed, input.moveAngle, input.turnRate);
      for (const [slot, w] of b.weights)
        this.add(lower, slot, w * scale, this.loopTime(slot, phase, t));
    };
    addPosture(input.postureFrom, 1 - k);
    addPosture(input.posture, k);

    // Incapacitation: blend into the death clip from its start time.
    let alive = 1;
    if (input.sinceDown >= 0 && this.bank.has('death')) {
      const d = smooth(input.sinceDown / 0.25);
      alive = 1 - d;
      for (const s of lower.values()) s.w *= alive;
      const dur = this.bank.get('death')?.duration ?? 1;
      this.add(lower, 'death', d, Math.min(input.sinceDown, dur - 1e-3));
    }

    // Upper body: a weapon-carrying layer over the locomotion's upper body.
    const overlay = new Map<ClipSlot, Sample>();
    const moving = input.speed > 0.4 && input.posture === 'standing';
    const useKaykit = upperBodySettings.source === 'kaykit';
    const carrySlot = (c: Carry): [ClipSlot, number] => {
      if (useKaykit && c === 'aimed' && this.bank.has('aim'))
        return ['aim', t % (this.bank.get('aim')?.duration ?? 1)];
      if (useKaykit && moving && this.bank.has('runRifle'))
        return ['runRifle', this.loopTime('runRifle', phase, t)];
      const idle = input.posture === 'kneeling' ? 'kneelIdle' : 'idle';
      return [idle, this.loopTime(idle, phase, t)];
    };
    const kc = smooth(input.carryT);
    const [fromSlot, fromTime] = carrySlot(input.carryFrom);
    const [toSlot, toTime] = carrySlot(input.carry);
    let fire = 0;
    const fireDur = this.bank.get('fire')?.duration ?? 0;
    if (useKaykit && fireDur > 0 && input.sinceShot < fireDur * 0.6)
      fire = 1 - smooth(input.sinceShot / (fireDur * 0.6));
    this.add(overlay, fromSlot, (1 - kc) * (1 - fire), fromTime);
    this.add(overlay, toSlot, kc * (1 - fire), toTime);
    if (fire > 0) this.add(overlay, 'fire', fire, Math.min(input.sinceShot, fireDur - 1e-3));
    const prone = input.posture === 'prone' || input.postureFrom === 'prone';
    const u = (prone ? 0 : 1) * alive;

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
    this.mixer.update(0);
    saveClipPose(this.soldier);

    const fmt = (m: Map<ClipSlot, Sample>) =>
      [...m]
        .sort((a, b) => b[1].w - a[1].w)
        .map(([slot, s]) => `${slot} ${(s.w * 100).toFixed(0)}% @${s.time.toFixed(2)}s`)
        .join(', ');
    this.text =
      `lower/full: ${fmt(lower)}\n` +
      `upper layer (${(u * 100).toFixed(0)}%): ${fmt(overlay)}\n` +
      `gait phase ${frac(phase).toFixed(3)} (loop ${String(Math.floor(phase))})`;
  }

  describe(): string {
    return this.text;
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.soldier.root);
  }
}

export const nativeRuntime: Runtime = {
  id: 'native',
  label: 'A. three.js AnimationMixer, explicit time (stateless)',
  stateless: true,
  create(soldier, frames) {
    return new NativeAnimator(soldier, frames);
  },
};

export type { FrameContext };
