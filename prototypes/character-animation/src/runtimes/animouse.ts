/**
 * Candidate B: animouse 0.8.0 (MIT) — an animation state machine with 1D and
 * 2D blend trees on top of AnimationMixer, used the way its README shows:
 * states and transitions registered once, events and blend values fed each
 * frame, and `machine.update(dt)` advancing everything on its own clock.
 *
 * Built from the same clips, speeds and post-processing as the native
 * runtime. The workarounds animouse needed are marked WORKAROUND.
 */

import {
  type AnimationState,
  AnimationMachine,
  ClipState,
  FreeformBlendTree,
  LinearBlendTree,
} from 'animouse';
import * as THREE from 'three';
import { applyRestPose, restoreClipPose, saveClipPose, type SoldierView } from '../character';
import { clipVariants, type ClipVariants } from '../clip-bank';
import { slotSpeed } from '../locomotion';
import { type PoseInput, poseInputAt } from '../pose-input';
import type { ClipSlot } from '../rigs';
import { POSTURE_SECONDS, type Posture, type SimFrame } from '../sim';
import { upperBodySettings } from './native';
import type { Animator, FrameContext, Runtime } from './types';

/** Seconds of history replayed after a seek to rebuild the machines' state. */
export const ANIMOUSE_WARMUP_SECONDS = 2;
const WARMUP_DT = 1 / 30;

type Part = 'lower' | 'overlay';

class AnimouseAnimator implements Animator {
  private readonly soldier: SoldierView;
  private readonly bank: Map<ClipSlot, ClipVariants>;
  private mixer!: THREE.AnimationMixer;
  private lowerMachine!: AnimationMachine;
  private upperMachine!: AnimationMachine;
  private trees!: {
    standing: FreeformBlendTree;
    kneeling: LinearBlendTree | null;
    upperMove: LinearBlendTree | null;
  };
  private prev: PoseInput | null = null;
  private frames: readonly SimFrame[];
  private lastTime = -1;
  private replaySeconds = 0;

  constructor(soldier: SoldierView, frames: readonly SimFrame[]) {
    this.soldier = soldier;
    this.frames = frames;
    this.bank = clipVariants(soldier.asset);
    this.build();
  }

  private action(slot: ClipSlot, part: Part, once = false): THREE.AnimationAction | null {
    const v = this.bank.get(slot);
    if (!v) return null;
    const a = this.mixer.clipAction(v[part]);
    if (once) {
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
    }
    return a;
  }

  private built = false;

  private build(): void {
    if (this.built) {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.soldier.root);
    }
    this.built = true;
    applyRestPose(this.soldier);
    this.mixer = new THREE.AnimationMixer(this.soldier.root);
    const clips = this.soldier.asset.clips;
    const sp = (s: ClipSlot) => slotSpeed(clips, s);
    const need = (a: THREE.AnimationAction | null, what: string) => {
      if (!a) throw new Error(`animouse runtime: missing ${what}`);
      return a;
    };

    // Lower body: a 2D freeform blend tree (x = right speed, y = forward
    // speed) for standing, a 1D tree for kneeling, a clip for crawling.
    const pts: { action: THREE.AnimationAction; x: number; y: number }[] = [];
    const point = (slot: ClipSlot, x: number, y: number) => {
      const a = this.action(slot, 'lower');
      if (a) pts.push({ action: a, x, y });
    };
    point('idle', 0, 0);
    point('walk', 0, sp('walk'));
    point('run', 0, sp('run'));
    point('sprint', 0, sp('sprint'));
    point('walkBack', 0, -sp('walkBack'));
    point('walkLeft', -sp('walkLeft'), 0);
    point('walkRight', sp('walkRight'), 0);
    point('runBack', 0, -sp('runBack'));
    point('runLeft', -sp('runLeft'), 0);
    point('runRight', sp('runRight'), 0);
    // FreeformBlendTree needs points that are not all on one line (it throws
    // "All points are collinear" otherwise): a character with forward clips
    // only cannot use it.
    if (pts.every((q) => q.x === 0) || pts.length < 3) {
      throw new Error('animouse 2D blend tree needs directional clips this character lacks');
    }
    const standing = new FreeformBlendTree(pts);
    standing.name = 'standing (freeform 2D)';
    const kIdle = this.action('kneelIdle', 'lower');
    const kWalk = this.action('kneelWalk', 'lower');
    const kneeling =
      kIdle && kWalk
        ? new LinearBlendTree([
            { action: kIdle, value: 0 },
            { action: kWalk, value: sp('kneelWalk') },
          ])
        : null;
    if (kneeling) kneeling.name = 'kneeling (linear 1D)';
    const prone = new ClipState(need(this.action('crawl', 'lower'), 'crawl'));
    prone.name = 'prone (crawl clip)';
    const deathA = this.action('death', 'lower', true);
    const death = deathA ? new ClipState(deathA) : null;
    if (death) death.name = 'death';

    this.lowerMachine = new AnimationMachine(standing, this.mixer);
    const postures: Partial<Record<Posture, AnimationState>> = { standing, prone };
    if (kneeling) postures.kneeling = kneeling;
    for (const [from, fs] of Object.entries(postures) as [Posture, AnimationState][]) {
      for (const [to, ts] of Object.entries(postures) as [Posture, AnimationState][]) {
        if (from === to) continue;
        this.lowerMachine.addEventTransition(`posture:${to}`, {
          from: fs,
          to: ts,
          duration: POSTURE_SECONDS[from][to],
        });
      }
    }
    if (death) this.lowerMachine.addEventTransition('down', { to: death, duration: 0.25 });

    // WORKAROUND (no layers or bone masks): a second machine drives the
    // upper-body copies of the clips. It must not update the mixer a second
    // time, so it is given a stub mixer; the real mixer is updated by the
    // lower machine after both have set their weights.
    const stub = { update: () => undefined } as unknown as THREE.AnimationMixer;
    const upIdle = new ClipState(need(this.action('idle', 'overlay'), 'idle'));
    upIdle.name = 'carry (idle)';
    const kaykit = upperBodySettings.source === 'kaykit';
    const runA = kaykit ? this.action('runRifle', 'overlay') : null;
    const upMove = runA
      ? new LinearBlendTree([
          { action: need(this.action('walk', 'overlay'), 'walk'), value: 0 },
          { action: runA, value: 1 },
        ])
      : null;
    if (upMove) upMove.name = 'carry (moving)';
    const aimA = kaykit ? this.action('aim', 'overlay') : null;
    const aim = aimA ? new ClipState(aimA) : upIdle;
    aim.name = aimA ? 'aim' : aim.name;
    const fireA = kaykit ? this.action('fire', 'overlay', true) : null;
    const fire = fireA ? new ClipState(fireA) : null;
    if (fire) fire.name = 'fire';
    const upProne = new ClipState(need(this.action('crawl', 'overlay'), 'crawl'));
    upProne.name = 'prone (crawl upper)';
    const kIdleUp = this.action('kneelIdle', 'overlay');
    const upKneel = kIdleUp ? new ClipState(kIdleUp) : upIdle;
    if (kIdleUp) upKneel.name = 'kneeling (upper)';
    const deathU = this.action('death', 'overlay', true);
    const upDeath = deathU ? new ClipState(deathU) : null;

    this.upperMachine = new AnimationMachine(upIdle, stub);
    const upStates = [
      ...new Set<AnimationState>([upIdle, aim, upProne, ...(upMove ? [upMove] : []), upKneel]),
    ];
    const allTo = (event: string, to: AnimationState, duration: number) => {
      for (const s of upStates)
        if (s !== to) this.upperMachine.addEventTransition(event, { from: s, to, duration });
      if (fire && fire !== to)
        this.upperMachine.addEventTransition(event, { from: fire, to, duration });
    };
    if (aim !== upIdle) allTo('carry:aimed', aim, 0.35);
    allTo('carry:still', upIdle, 0.3);
    if (upMove) allTo('carry:moving', upMove, 0.3);
    allTo('upper:prone', upProne, 0.8);
    if (upKneel !== upIdle) allTo('upper:kneeling', upKneel, 0.6);
    if (fire && aim !== upIdle) {
      this.upperMachine.addEventTransition('fire', { from: aim, to: fire, duration: 0.05 });
      this.upperMachine.addAutomaticTransition(fire, { to: aim, duration: 0.15 });
    }
    if (upDeath) allTo('down', upDeath, 0.25);

    this.trees = { standing, kneeling, upperMove: upMove };
    this.prev = null;
  }

  /** Blend-tree failures worked around (see test/animouse-freeform.test.ts). */
  private blendFailures = 0;

  /**
   * WORKAROUND: FreeformBlendTree.setBlend throws for many points of this
   * layout (an animouse 0.8.0 defect). Retry slightly off the axis, then
   * nearer the centre; if all fail, keep the previous weights.
   */
  private safeBlend(x: number, y: number): void {
    const tries: [number, number][] = [
      [x, y],
      [x + 0.013, y],
      [x - 0.013, y],
      [x * 0.9 + 0.02, y * 0.9],
    ];
    for (const [tx, ty] of tries) {
      try {
        this.trees.standing.setBlend(tx, ty);
        return;
      } catch {
        this.blendFailures++;
      }
    }
  }

  reset(frames: readonly SimFrame[]): void {
    this.frames = frames;
  }

  /** The event-driven part: compares the input with the previous one. */
  private feed(input: PoseInput, dt: number): void {
    const p = this.prev;
    if (p?.posture !== input.posture) this.lowerMachine.handleEvent(`posture:${input.posture}`);
    if (input.sinceDown >= 0 && (!p || p.sinceDown < 0)) {
      this.lowerMachine.handleEvent('down');
      this.upperMachine.handleEvent('down');
    }
    const upperKey = (i: PoseInput) =>
      i.posture === 'prone'
        ? 'upper:prone'
        : i.carry === 'aimed'
          ? 'carry:aimed'
          : i.posture === 'kneeling'
            ? 'upper:kneeling'
            : i.speed > 0.4
              ? 'carry:moving'
              : 'carry:still';
    if (!p || upperKey(p) !== upperKey(input)) this.upperMachine.handleEvent(upperKey(input));
    if (p && input.lastShot !== p.lastShot && input.lastShot >= 0)
      this.upperMachine.handleEvent('fire');

    // Blend values: travel velocity in the body frame.
    const right = Math.sin(input.moveAngle) * input.speed;
    const fwd = Math.cos(input.moveAngle) * input.speed;
    this.safeBlend(right, fwd);
    this.trees.kneeling?.setBlend(input.speed);
    this.trees.upperMove?.setBlend(Math.min(1, input.speed / 3));
    // Speed matching is not part of animouse: scale each moving action's rate.
    const clips = this.soldier.asset.clips;
    for (const slot of [
      'walk',
      'run',
      'sprint',
      'walkBack',
      'walkLeft',
      'walkRight',
      'kneelWalk',
      'crawl',
      'runRifle',
    ] as ClipSlot[]) {
      const v = slotSpeed(clips, slot);
      const rate =
        input.speed > 0.05
          ? Math.max(0.5, Math.min(1.6, input.speed / v))
          : slot === 'crawl'
            ? 0
            : 1;
      for (const part of ['lower', 'overlay'] as const) {
        const a = this.bank.has(slot) ? this.action(slot, part) : null;
        if (a) a.timeScale = rate;
      }
    }
    this.upperMachine.update(dt);
    this.lowerMachine.update(dt);
    this.prev = input;
  }

  update(input: PoseInput, ctx: FrameContext): void {
    restoreClipPose(this.soldier);
    this.frames = ctx.frames;
    const jumped =
      ctx.seeked || this.lastTime < 0 || Math.abs(input.time - this.lastTime - ctx.dt) > 1e-6;
    if (jumped) {
      // animouse cannot seek: rebuild and replay recent history at a fixed step.
      const t0 = performance.now();
      this.build();
      const start = Math.max(0, input.time - ANIMOUSE_WARMUP_SECONDS);
      for (let tt = start; tt < input.time - 1e-9; tt += WARMUP_DT) {
        this.feed(poseInputAt(this.frames, tt), this.prev ? WARMUP_DT : 0);
      }
      this.feed(input, this.prev ? Math.max(0, input.time - this.prev.time) : 0);
      this.replaySeconds = (performance.now() - t0) / 1000;
    } else {
      this.feed(input, ctx.dt);
    }
    this.lastTime = input.time;
    saveClipPose(this.soldier);
  }

  describe(): string {
    const lower = this.lowerMachine.currentState;
    const upper = this.upperMachine.currentState;
    const active: string[] = [];
    for (const a of (this.mixer as unknown as { _actions: THREE.AnimationAction[] })._actions) {
      if (a.weight > 0.01 && a.isRunning())
        active.push(`${a.getClip().name} ${(a.weight * 100).toFixed(0)}% @${a.time.toFixed(2)}s`);
    }
    return (
      `lower machine: ${lower.name}; upper machine: ${upper.name}\n` +
      `actions: ${active.join(', ')}\n` +
      `last seek rebuild: ${(this.replaySeconds * 1000).toFixed(1)} ms (${String(ANIMOUSE_WARMUP_SECONDS)} s replayed)\n` +
      `freeform setBlend exceptions worked around: ${String(this.blendFailures)}`
    );
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.soldier.root);
  }
}

export const animouseRuntime: Runtime = {
  id: 'animouse',
  label: 'B. animouse 0.8.0 state machine + blend trees (stateful)',
  stateless: false,
  create(soldier, frames) {
    return new AnimouseAnimator(soldier, frames);
  },
};
