import * as THREE from 'three';
import type { CombatEvent, MotionLog } from '#exercise';
import { Animator } from './animator';
import type { CharacterAsset } from './asset';
import {
  createSoldier,
  placeSoldier,
  postProcess,
  type PostOptions,
  type SoldierView,
} from './character';
import { GaitClock } from './gait';
import { cycleDistanceFor } from './locomotion';
import { type PoseInput, SoldierMotion } from './motion';
import { Ragdoll } from './ragdoll';
import type { WeaponInstance } from './weapons';

// One soldier on screen (docs/character-animation.md): the model, its weapon
// and its animator, posed for a simulation time from the motion log and the
// combat log. Nothing here is gameplay: the simulation never reads a pose.
//
// pose = f(motion log, combat log, time): placement on the recorded surface,
// clip sampling (animator.ts), then the procedural layer of the approved
// prototype (character.ts): feet on the ground, torso blade and aim, the
// weapon held at the shoulder with both hands on it (IK), recoil and muzzle
// flash from the shot times, the head to the sights.

/** The approved prototype's post-processing, all on. */
const POST: PostOptions = {
  ik: 'two-bone',
  headLook: true,
  footIk: true,
  weaponHold: true,
  spineAim: true,
};

/** A small, stable number from a string (FNV-1a): cosmetic variety, never `Math.random`. */
export function hashUnit(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x100000000;
}

export class Puppet {
  readonly id: string;
  readonly view: SoldierView;
  private motion: SoldierMotion;
  private animator: Animator;
  private log: MotionLog;
  private epoch: number;
  /** The last pose input (after `pose`). */
  input: PoseInput | null = null;
  /** The fall, once the soldier is down (from the moment of the hit). */
  private ragdoll: Ragdoll | null = null;

  constructor(asset: CharacterAsset, id: string, weapon: WeaponInstance | null, log: MotionLog) {
    this.id = id;
    this.view = createSoldier(asset);
    this.view.weapon = weapon;
    this.log = log;
    this.epoch = log.epoch;
    this.motion = new SoldierMotion(log, id);
    this.animator = this.makeAnimator();
  }

  private makeAnimator(): Animator {
    const motion = this.motion;
    const clips = this.view.asset.clips;
    const gait = new GaitClock(
      this.log,
      motion.index,
      (tick) => motion.travelAt(tick),
      (t) => cycleDistanceFor(clips, t.posture, t.speed, t.moveAngle),
    );
    // Idle clips start somewhere different for each soldier (up to 3 s in).
    return new Animator(this.view, gait, hashUnit(this.id) * 3);
  }

  /** Whether the soldier is in `log` (by id). */
  inLog(log: MotionLog): boolean {
    return log.indexOf(this.id) >= 0;
  }

  /**
   * Poses the soldier for `seconds` of simulation time. `surfaceAt` gives
   * the surface stood on at a map point (for the feet on slopes).
   */
  pose(
    log: MotionLog,
    combatLog: readonly CombatEvent[],
    seconds: number,
    surfaceAt: (x: number, y: number) => number,
    /** Changes the pose's input before it is posed (a soldier standing in his trench); not when he is down. */
    adjust?: (input: PoseInput) => PoseInput,
  ): PoseInput {
    if (log !== this.log || log.epoch !== this.epoch) {
      // A new exercise, or its log started again: forget memoised facts.
      this.animator.dispose();
      this.log = log;
      this.epoch = log.epoch;
      this.motion = new SoldierMotion(log, this.id);
      this.animator = this.makeAnimator();
      this.ragdoll = null;
    }
    this.motion.updateCombat(combatLog);
    let input = this.motion.at(seconds);
    if (input.sinceDown >= 0) {
      const downAt = input.time - input.sinceDown;
      if (this.ragdoll?.downAt !== downAt) this.ragdoll = this.fall(downAt, surfaceAt);
      input = this.motion.at(seconds);
    }
    if (adjust && input.sinceDown < 0) input = adjust(input);
    this.posed(input, surfaceAt);
    // Down: the body is the ragdoll's (the weapon falls as the hold lets go).
    if (input.sinceDown >= 0) this.ragdoll?.pose(this.view, input.sinceDown);
    this.input = input;
    return input;
  }

  /** The animated pose for `input`: clips, then the procedural layer. */
  private posed(input: PoseInput, surfaceAt: (x: number, y: number) => number): void {
    placeSoldier(this.view, input);
    this.animator.update(input);
    postProcess(this.view, input, POST, surfaceAt);
  }

  /**
   * The ragdoll for a hit at `downAt`: from the pose just before it (and
   * 1/60 s earlier, for the body's velocity), pushed away from the shooter.
   * A function of the logs alone, so it is the same however it is reached.
   */
  private fall(downAt: number, surfaceAt: (x: number, y: number) => number): Ragdoll {
    const just = (dt: number) => {
      this.posed(this.motion.at(downAt - dt), surfaceAt);
      return Ragdoll.points(this.view);
    };
    const before = just(1 / 60 + 1e-6);
    just(1e-6);
    const from = this.motion.shooterPosition();
    const at = this.view.root.position;
    const push = from ? new THREE.Vector3(at.x - from.x, 0, at.z + from.y) : null;
    return new Ragdoll(this.view, before, push, surfaceAt, downAt);
  }

  /** The playing clips' weights and times (for checks). */
  animationState() {
    return this.animator.state();
  }

  describe(): string {
    return this.animator.describe();
  }

  /** The muzzle in world space (three.js axes), or null without a weapon. */
  muzzle(out: THREE.Vector3): THREE.Vector3 | null {
    const w = this.view.weapon;
    if (!w?.object.visible) return null;
    return out.copy(w.profile.muzzle).applyMatrix4(w.object.matrixWorld);
  }

  dispose(): void {
    this.animator.dispose();
  }
}
