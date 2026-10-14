/**
 * Deterministic-replay test: the pose (every bone's local rotation and
 * position, after IK, plus the weapon) is recorded at fixed simulation times
 * reached in different ways, and compared with a reference pass.
 *
 * Passes: continuous playback at 60 Hz (reference), at 144 Hz, at irregular
 * frame times, in slow motion (0.25×) and fast forward (16×); seeking
 * forward, backward and in a shuffled order; the reference repeated on a
 * fresh animator; and the 3D view hidden for a stretch (no updates) then
 * shown again.
 */

import * as THREE from 'three';
import type { SoldierView } from './character';
import type { Animator, FrameContext } from './runtimes/types';
import type { SimFrame } from './sim';

/** Equal within float32 noise: the definition of "same pose" for exact replay. */
export const EXACT_DEG = 0.01;
export const EXACT_MM = 0.1;
/** Indistinguishable on screen at close range. */
export const VISUAL_DEG = 1;
export const VISUAL_MM = 5;

export const CHECK_TIMES = [
  1.7, 4.2, 9.1, 10.9, 14.4, 16.3, 19.37, 21.3, 24.9, 27.5, 31.0, 33.6, 36.2, 38.9, 43.4,
];

export interface PassResult {
  readonly name: string;
  readonly maxDeg: number;
  readonly maxMm: number;
  readonly worstAt: number;
  /** The bone (or "weapon") with the largest rotation difference. */
  readonly worstBone: string;
  readonly exact: boolean;
  readonly visual: boolean;
  readonly ms: number;
}

type Pose = Float64Array;

export interface Harness {
  /** A fresh soldier (new skeleton clone) and animator: no history at all. */
  create(): { soldier: SoldierView; animator: Animator };
  /** Places the soldier, runs the animator and the shared post-processing. */
  pose(soldier: SoldierView, animator: Animator, time: number, ctx: FrameContext): void;
}

function capture(s: SoldierView): Pose {
  const bones = s.skinned[0]?.skeleton.bones ?? [];
  const out = new Float64Array(bones.length * 7 + 7);
  bones.forEach((b, i) => {
    out.set(
      [
        b.quaternion.x,
        b.quaternion.y,
        b.quaternion.z,
        b.quaternion.w,
        b.position.x,
        b.position.y,
        b.position.z,
      ],
      i * 7,
    );
  });
  const w = s.weapon?.object;
  if (w) {
    const q = w.quaternion;
    out.set([q.x, q.y, q.z, q.w, w.position.x, w.position.y, w.position.z], bones.length * 7);
  }
  return out;
}

/** Largest rotation difference (degrees) and translation difference (mm). */
function diff(a: Pose, b: Pose, scale: number): { deg: number; mm: number; at: number } {
  let deg = 0;
  let mm = 0;
  let at = -1;
  const qa = new THREE.Quaternion();
  const qb = new THREE.Quaternion();
  for (let i = 0; i + 7 <= a.length; i += 7) {
    // Normalised first: a slightly non-unit quaternion (clip data, float32)
    // gives angleTo(q, q) ≈ 0.05° instead of 0.
    qa.set(a[i] ?? 0, a[i + 1] ?? 0, a[i + 2] ?? 0, a[i + 3] ?? 1).normalize();
    qb.set(b[i] ?? 0, b[i + 1] ?? 0, b[i + 2] ?? 0, b[i + 3] ?? 1).normalize();
    const dd = (qa.angleTo(qb) * 180) / Math.PI;
    if (dd > deg) {
      deg = dd;
      at = i / 7;
    }
    const d = Math.hypot(
      (a[i + 4] ?? 0) - (b[i + 4] ?? 0),
      (a[i + 5] ?? 0) - (b[i + 5] ?? 0),
      (a[i + 6] ?? 0) - (b[i + 6] ?? 0),
    );
    // Bone positions are in bone-parent units; the model scale converts them to metres.
    mm = Math.max(mm, d * 1000 * (i + 7 >= a.length ? 1 : scale));
  }
  return { deg, mm, at };
}

function* playback(
  times: readonly number[],
  step: (i: number) => number,
): Generator<[number, number]> {
  // Yields (time, dt) so that every check time is hit exactly.
  let t = 0;
  let i = 0;
  for (const target of times) {
    while (t < target - 1e-9) {
      const dt = Math.min(step(i++), target - t);
      t += dt;
      // Land exactly on the check time (accumulated steps drift by ~1e-15 s).
      if (Math.abs(t - target) < 1e-9) t = target;
      yield [t, dt];
    }
  }
}

export function runDeterminism(
  h: Harness,
  frames: readonly SimFrame[],
  times = CHECK_TIMES,
): PassResult[] {
  const probe = h.create();
  const scale = probe.soldier.asset.scale;
  const boneNames = (probe.soldier.skinned[0]?.skeleton.bones ?? []).map((b) => b.name);
  probe.animator.dispose();
  const ctxFor = (dt: number, seeked: boolean): FrameContext => ({ dt, seeked, frames });
  const continuous = (step: (i: number) => number): Map<number, Pose> => {
    const { soldier, animator: a } = h.create();
    const out = new Map<number, Pose>();
    h.pose(soldier, a, 0, ctxFor(0, true));
    const set = new Set(times);
    for (const [t, dt] of playback(times, step)) {
      h.pose(soldier, a, t, ctxFor(dt, false));
      for (const c of set) if (Math.abs(c - t) < 1e-9) out.set(c, capture(soldier));
    }
    a.dispose();
    return out;
  };
  const seeks = (order: readonly number[]): Map<number, Pose> => {
    const { soldier, animator: a } = h.create();
    const out = new Map<number, Pose>();
    for (const t of order) {
      h.pose(soldier, a, t, ctxFor(0, true));
      out.set(t, capture(soldier));
    }
    a.dispose();
    return out;
  };
  const hidden = (): Map<number, Pose> => {
    // Play to the 4th check time, skip updates until the 7th (3D hidden),
    // then resume with one large frame step, as the app does when the view
    // comes back.
    const { soldier, animator: a } = h.create();
    const out = new Map<number, Pose>();
    h.pose(soldier, a, 0, ctxFor(0, true));
    const hideFrom = times[3] ?? 0;
    const showAt = times[6] ?? 0;
    let last = 0;
    for (const [t, dt] of playback(times, () => 1 / 60)) {
      if (t > hideFrom + 1e-9 && t < showAt - 1e-9) continue;
      h.pose(soldier, a, t, ctxFor(t - last > dt + 1e-9 ? t - last : dt, false));
      last = t;
      for (const c of times)
        if (Math.abs(c - t) < 1e-9 && (c <= hideFrom || c >= showAt)) out.set(c, capture(soldier));
    }
    a.dispose();
    return out;
  };

  // Deterministic "irregular" frame times (an LCG, not Math.random).
  let seed = 12345;
  const jitter = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return 1 / 240 + ((seed >>> 8) / 0xffffff) * (1 / 30);
  };
  const shuffled = [...times].sort(
    (x, y) =>
      ((Math.sin(x * 12.9898) * 43758.5453) % 1) - ((Math.sin(y * 12.9898) * 43758.5453) % 1),
  );

  const timed = <T>(f: () => T): [T, number] => {
    const t0 = performance.now();
    const r = f();
    return [r, performance.now() - t0];
  };
  const [ref, refMs] = timed(() => continuous(() => 1 / 60));
  const passes: [string, () => Map<number, Pose>][] = [
    ['continuous 144 Hz', () => continuous(() => 1 / 144)],
    ['continuous, irregular frame times', () => continuous(jitter)],
    ['slow motion 0.25× (60 Hz)', () => continuous(() => 0.25 / 60)],
    ['fast forward 16× (60 Hz)', () => continuous(() => 16 / 60)],
    ['seek forward (ascending)', () => seeks(times)],
    ['seek backward (descending)', () => seeks([...times].reverse())],
    ['seek shuffled', () => seeks(shuffled)],
    ['repeat reference on fresh animator', () => continuous(() => 1 / 60)],
    ['3D hidden then resumed', hidden],
  ];
  const results: PassResult[] = [
    {
      name: 'reference: continuous 60 Hz',
      maxDeg: 0,
      maxMm: 0,
      worstAt: 0,
      worstBone: '',
      exact: true,
      visual: true,
      ms: refMs,
    },
  ];
  for (const [name, f] of passes) {
    const [poses, ms] = timed(f);
    let maxDeg = 0;
    let maxMm = 0;
    let worstAt = 0;
    let worstBone = '';
    for (const [t, p] of poses) {
      const r = ref.get(t);
      if (!r) continue;
      const d = diff(r, p, scale);
      if (d.deg > maxDeg) {
        worstAt = t;
        worstBone = boneNames[d.at] ?? 'weapon';
      }
      maxDeg = Math.max(maxDeg, d.deg);
      maxMm = Math.max(maxMm, d.mm);
    }
    results.push({
      name,
      maxDeg,
      maxMm,
      worstAt,
      worstBone,
      exact: maxDeg <= EXACT_DEG && maxMm <= EXACT_MM,
      visual: maxDeg <= VISUAL_DEG && maxMm <= VISUAL_MM,
      ms,
    });
  }
  return results;
}
