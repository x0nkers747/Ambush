import * as THREE from 'three';
import type { SoldierView } from './character';
import { setWorldQuaternion } from './ik';
import type { BoneKey } from './rig';

// The fall of an incapacitated soldier (docs/character-animation.md): a
// ragdoll — the body as point masses joined by bones (Verlet integration,
// distance constraints, a rigid torso, simple joint limits), falling under
// gravity onto the battlefield's surface from the soldier's pose at the
// moment he was hit, pushed away from the shot.
//
// Deterministic: a fixed step, a fixed order of operations, and its steps
// memoised from the moment of the hit, so the body at a time is the same
// however that time is reached (live, in the review, seeking anywhere).

/** Simulation step (s) and how long the body moves before it is still. */
const STEP = 1 / 120;
const SECONDS = 3;
const STEPS = Math.round(SECONDS / STEP);
const ITERATIONS = 10;
const GRAVITY = 9.81;
/** Velocity kept per step (air drag), and on the ground (friction). */
const DRAG = 0.998;
const FRICTION = 0.55;
/** The shot's push (m/s): the torso away from the shooter, and the knees giving way. */
const PUSH = 2.4;
/** The feet's push the other way (m/s): the body topples rather than folding in place. */
const KICK = 0.6;
const BUCKLE = 0.35;

/** The body's points: what bone (or offset) each stands for, and its radius on the ground. */
const POINTS = [
  'pelvis',
  'hipL',
  'hipR',
  'chest',
  'shoulderL',
  'shoulderR',
  'head',
  'headTop',
  'elbowL',
  'elbowR',
  'wristL',
  'wristR',
  'kneeL',
  'kneeR',
  'ankleL',
  'ankleR',
  'toeL',
  'toeR',
] as const;
type Point = (typeof POINTS)[number];
const P = Object.fromEntries(POINTS.map((p, i) => [p, i])) as Record<Point, number>;

const RADIUS: Record<Point, number> = {
  pelvis: 0.13,
  hipL: 0.09,
  hipR: 0.09,
  chest: 0.14,
  shoulderL: 0.07,
  shoulderR: 0.07,
  head: 0.1,
  headTop: 0.09,
  elbowL: 0.05,
  elbowR: 0.05,
  wristL: 0.04,
  wristR: 0.04,
  kneeL: 0.06,
  kneeR: 0.06,
  ankleL: 0.05,
  ankleR: 0.05,
  toeL: 0.04,
  toeR: 0.04,
};

/** Where each point is taken from: a bone's position (and, for `headTop`, along the head). */
const SOURCE: Record<Point, BoneKey> = {
  pelvis: 'hips',
  hipL: 'upperLegL',
  hipR: 'upperLegR',
  chest: 'spine3',
  shoulderL: 'upperArmL',
  shoulderR: 'upperArmR',
  head: 'head',
  headTop: 'head',
  elbowL: 'lowerArmL',
  elbowR: 'lowerArmR',
  wristL: 'handL',
  wristR: 'handR',
  kneeL: 'lowerLegL',
  kneeR: 'lowerLegR',
  ankleL: 'footL',
  ankleR: 'footR',
  toeL: 'toesL',
  toeR: 'toesR',
};

const TORSO: readonly Point[] = ['pelvis', 'hipL', 'hipR', 'chest', 'shoulderL', 'shoulderR'];
/** Bones: [a, b] kept at their length. */
const LINKS: readonly [Point, Point][] = [
  ['chest', 'head'],
  ['head', 'headTop'],
  ['shoulderL', 'head'],
  ['shoulderR', 'head'],
  ['shoulderL', 'elbowL'],
  ['elbowL', 'wristL'],
  ['shoulderR', 'elbowR'],
  ['elbowR', 'wristR'],
  ['hipL', 'kneeL'],
  ['kneeL', 'ankleL'],
  ['ankleL', 'toeL'],
  ['kneeL', 'toeL'],
  ['hipR', 'kneeR'],
  ['kneeR', 'ankleR'],
  ['ankleR', 'toeR'],
  ['kneeR', 'toeR'],
];
/** Joint limits as least distances (fraction of the full length): no folding flat. */
const LEAST: readonly [Point, Point, number][] = [
  ['hipL', 'ankleL', 0.8],
  ['hipR', 'ankleR', 0.8],
  ['shoulderL', 'wristL', 0.35],
  ['shoulderR', 'wristR', 0.35],
  ['chest', 'headTop', 0.92],
  ['pelvis', 'kneeL', 0.85],
  ['pelvis', 'kneeR', 0.85],
  // Knees stay roughly under the hips: no splits.
  ['kneeL', 'kneeR', 0.6],
];

interface Constraint {
  readonly a: number;
  readonly b: number;
  readonly length: number;
  /** Only pushes apart (a least distance). */
  readonly least: boolean;
}

/** The bones the ragdoll poses, and from which points (start → end of the bone). */
const LIMBS: readonly { readonly bone: BoneKey; readonly from: Point; readonly to: Point }[] = [
  { bone: 'upperArmL', from: 'shoulderL', to: 'elbowL' },
  { bone: 'lowerArmL', from: 'elbowL', to: 'wristL' },
  { bone: 'upperArmR', from: 'shoulderR', to: 'elbowR' },
  { bone: 'lowerArmR', from: 'elbowR', to: 'wristR' },
  { bone: 'upperLegL', from: 'hipL', to: 'kneeL' },
  { bone: 'lowerLegL', from: 'kneeL', to: 'ankleL' },
  { bone: 'footL', from: 'ankleL', to: 'toeL' },
  { bone: 'upperLegR', from: 'hipR', to: 'kneeR' },
  { bone: 'lowerLegR', from: 'kneeR', to: 'ankleR' },
  { bone: 'footR', from: 'ankleR', to: 'toeR' },
  { bone: 'head', from: 'head', to: 'headTop' },
];
/** Bones that move with the torso (and the hands with their forearms). */
const RIGID: readonly BoneKey[] = ['hips', 'spine1', 'spine2', 'spine3', 'shoulderL', 'shoulderR'];

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();

/** The torso's frame (three.js axes) from its points: right (hips), up (pelvis → chest). */
function torsoFrame(p: Float64Array, out: THREE.Quaternion): THREE.Quaternion {
  const at = (i: number, v: THREE.Vector3) =>
    v.set(p[i * 3] ?? 0, p[i * 3 + 1] ?? 0, p[i * 3 + 2] ?? 0);
  const right = at(P.hipR, new THREE.Vector3()).sub(at(P.hipL, _a));
  const up = at(P.chest, new THREE.Vector3()).sub(at(P.pelvis, _a));
  up.normalize();
  right.addScaledVector(up, -right.dot(up)).normalize();
  const forward = new THREE.Vector3().crossVectors(right, up);
  return out.setFromRotationMatrix(_m.makeBasis(right, up, forward));
}

export class Ragdoll {
  /** Point positions (x, y, z per point) at each step done, from the moment of the hit. */
  private readonly steps: Float64Array[] = [];
  private previous: Float64Array;
  private readonly constraints: Constraint[] = [];
  private readonly surfaceAt: (x: number, y: number) => number;
  /** At the hit: each bone's world rotation, and the torso's frame. */
  private readonly rest = new Map<BoneKey, THREE.Quaternion>();
  private readonly restTorso = new THREE.Quaternion();
  /** Each limb's world direction at the hit. */
  private readonly restDir = new Map<BoneKey, THREE.Vector3>();
  /** The pelvis bone's offset from the pelvis point in the torso frame (0, it is the point). */
  readonly downAt: number;

  /**
   * @param s The soldier posed as at the moment of the hit.
   * @param before The point positions 1/60 s earlier (for the body's velocity), or null.
   * @param push The shot's direction (three.js axes, horizontal), or null.
   * @param surfaceAt The surface at a map point (x east, y north).
   */
  constructor(
    s: SoldierView,
    before: Float64Array | null,
    push: THREE.Vector3 | null,
    surfaceAt: (x: number, y: number) => number,
    downAt: number,
  ) {
    this.surfaceAt = surfaceAt;
    this.downAt = downAt;
    const start = Ragdoll.points(s);
    for (const key of [
      ...RIGID,
      ...LIMBS.map((l) => l.bone),
      'neck',
      'handL',
      'handR',
    ] as BoneKey[]) {
      const bone = s.bones[key];
      if (bone) this.rest.set(key, bone.getWorldQuaternion(new THREE.Quaternion()));
    }
    torsoFrame(start, this.restTorso);
    for (const l of LIMBS) this.restDir.set(l.bone, Ragdoll.direction(start, l.from, l.to));
    for (let i = 0; i < TORSO.length; i += 1)
      for (let j = i + 1; j < TORSO.length; j += 1) this.link(start, TORSO[i], TORSO[j], false);
    for (const [a, b] of LINKS) this.link(start, a, b, false);
    for (const [a, b, f] of LEAST) {
      const c = this.distance(start, a, b);
      this.constraints.push({ a: P[a], b: P[b], length: c * f, least: true });
    }
    // The previous positions give the starting velocity: the body's own, the
    // shot's push on the upper body, the knees giving way.
    const prev = new Float64Array(start);
    if (before) prev.set(before);
    const nudge = (p: Point, v: THREE.Vector3) => {
      const i = P[p] * 3;
      prev[i] = (prev[i] ?? 0) - v.x * STEP;
      prev[i + 1] = (prev[i + 1] ?? 0) - v.y * STEP;
      prev[i + 2] = (prev[i + 2] ?? 0) - v.z * STEP;
    };
    // Velocities from the earlier positions were per 1/60 s: scale to a step.
    if (before)
      for (let i = 0; i < prev.length; i += 1)
        prev[i] = (start[i] ?? 0) - ((start[i] ?? 0) - (before[i] ?? 0)) * (60 * STEP);
    if (push) {
      const v = push.clone().setY(0).normalize().multiplyScalar(PUSH);
      for (const p of ['chest', 'shoulderL', 'shoulderR', 'head', 'headTop'] as Point[])
        nudge(p, v);
      const back = v.clone().multiplyScalar(-KICK / PUSH);
      for (const p of ['ankleL', 'ankleR', 'toeL', 'toeR'] as Point[]) nudge(p, back);
    }
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(this.restTorso).setY(0).normalize();
    for (const p of ['kneeL', 'kneeR'] as Point[]) nudge(p, forward.clone().multiplyScalar(BUCKLE));
    this.steps.push(start);
    this.previous = prev;
  }

  /** The point positions of a posed soldier (three.js world axes). */
  static points(s: SoldierView): Float64Array {
    const out = new Float64Array(POINTS.length * 3);
    s.root.updateMatrixWorld(true);
    POINTS.forEach((p, i) => {
      const bone = s.bones[SOURCE[p]];
      if (!bone) return;
      bone.getWorldPosition(_a);
      if (p === 'headTop') {
        // 20 cm along the head's up (its rest up: s.headUp).
        bone.getWorldQuaternion(_q);
        _a.addScaledVector(_b.copy(s.headUp).applyQuaternion(_q).normalize(), 0.2);
      }
      out.set([_a.x, _a.y, _a.z], i * 3);
    });
    return out;
  }

  private static direction(p: Float64Array, a: Point, b: Point): THREE.Vector3 {
    const i = P[a] * 3;
    const j = P[b] * 3;
    return new THREE.Vector3(
      (p[j] ?? 0) - (p[i] ?? 0),
      (p[j + 1] ?? 0) - (p[i + 1] ?? 0),
      (p[j + 2] ?? 0) - (p[i + 2] ?? 0),
    ).normalize();
  }

  private distance(p: Float64Array, a: Point, b: Point): number {
    const i = P[a] * 3;
    const j = P[b] * 3;
    return Math.hypot(
      (p[j] ?? 0) - (p[i] ?? 0),
      (p[j + 1] ?? 0) - (p[i + 1] ?? 0),
      (p[j + 2] ?? 0) - (p[i + 2] ?? 0),
    );
  }

  private link(p: Float64Array, a: Point | undefined, b: Point | undefined, least: boolean) {
    if (!a || !b) return;
    this.constraints.push({ a: P[a], b: P[b], length: this.distance(p, a, b), least });
  }

  /** One step after `cur` (Verlet), its constraints and the ground. */
  private step(cur: Float64Array): Float64Array {
    const prev = this.previous;
    const next = new Float64Array(cur.length);
    for (let i = 0; i < cur.length; i += 3) {
      const x = cur[i] ?? 0;
      const y = cur[i + 1] ?? 0;
      const z = cur[i + 2] ?? 0;
      next[i] = x + (x - (prev[i] ?? 0)) * DRAG;
      next[i + 1] = y + (y - (prev[i + 1] ?? 0)) * DRAG - GRAVITY * STEP * STEP;
      next[i + 2] = z + (z - (prev[i + 2] ?? 0)) * DRAG;
    }
    for (let k = 0; k < ITERATIONS; k += 1) {
      for (const c of this.constraints) {
        const i = c.a * 3;
        const j = c.b * 3;
        const dx = (next[j] ?? 0) - (next[i] ?? 0);
        const dy = (next[j + 1] ?? 0) - (next[i + 1] ?? 0);
        const dz = (next[j + 2] ?? 0) - (next[i + 2] ?? 0);
        const d = Math.hypot(dx, dy, dz);
        if (d < 1e-9 || (c.least && d >= c.length)) continue;
        const f = ((d - c.length) / d) * 0.5;
        next[i] = (next[i] ?? 0) + dx * f;
        next[i + 1] = (next[i + 1] ?? 0) + dy * f;
        next[i + 2] = (next[i + 2] ?? 0) + dz * f;
        next[j] = (next[j] ?? 0) - dx * f;
        next[j + 1] = (next[j + 1] ?? 0) - dy * f;
        next[j + 2] = (next[j + 2] ?? 0) - dz * f;
      }
      this.ground(next, cur);
    }
    this.previous = cur;
    return next;
  }

  /** Keeps every point above the surface by its radius; on it, slides with friction. */
  private ground(next: Float64Array, cur: Float64Array) {
    POINTS.forEach((p, n) => {
      const i = n * 3;
      const x = next[i] ?? 0;
      const z = next[i + 2] ?? 0;
      const h = this.surfaceAt(x, -z);
      if (!Number.isFinite(h)) return;
      const floor = h + RADIUS[p];
      if ((next[i + 1] ?? 0) >= floor) return;
      next[i + 1] = floor;
      // Friction: keep only part of the step's sideways movement.
      next[i] = (cur[i] ?? 0) + (x - (cur[i] ?? 0)) * FRICTION;
      next[i + 2] = (cur[i + 2] ?? 0) + (z - (cur[i + 2] ?? 0)) * FRICTION;
    });
  }

  /** The points at `seconds` after the hit (interpolated between steps). */
  pointsAt(seconds: number): Float64Array {
    const f = Math.max(0, Math.min(STEPS, seconds / STEP));
    const k = Math.floor(f);
    while (this.steps.length <= Math.min(k + 1, STEPS)) {
      const last = this.steps[this.steps.length - 1];
      if (!last) break;
      this.steps.push(this.step(last));
    }
    const a = this.steps[k] ?? this.steps[this.steps.length - 1];
    const b = this.steps[Math.min(k + 1, STEPS)] ?? a;
    if (!a || !b) return new Float64Array(POINTS.length * 3);
    const w = f - k;
    if (w === 0) return a;
    const out = new Float64Array(a.length);
    for (let i = 0; i < a.length; i += 1) out[i] = (a[i] ?? 0) + ((b[i] ?? 0) - (a[i] ?? 0)) * w;
    return out;
  }

  /** Poses the soldier's skeleton from the points at `seconds` after the hit. */
  pose(s: SoldierView, seconds: number): void {
    const p = this.pointsAt(seconds);
    const torso = torsoFrame(p, new THREE.Quaternion()).multiply(_q.copy(this.restTorso).invert());
    const b = s.bones;
    // The pelvis where its point is, the torso turned as a whole.
    const hips = b.hips;
    if (hips) {
      const at = new THREE.Vector3(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0);
      hips.position.copy(hips.parent ? hips.parent.worldToLocal(at) : at);
    }
    const turn = (key: BoneKey, q: THREE.Quaternion) => {
      const bone = b[key];
      const r = this.rest.get(key);
      if (bone && r) setWorldQuaternion(bone, q.clone().multiply(r));
    };
    for (const key of RIGID) turn(key, torso);
    // Limbs in order down each chain: each turned from its direction at the
    // hit to its direction now, on top of the turn of the bone above it.
    const carried = new Map<BoneKey, THREE.Quaternion>();
    const above: Partial<Record<BoneKey, BoneKey>> = {
      lowerArmL: 'upperArmL',
      lowerArmR: 'upperArmR',
      lowerLegL: 'upperLegL',
      lowerLegR: 'upperLegR',
      footL: 'lowerLegL',
      footR: 'lowerLegR',
    };
    for (const l of LIMBS) {
      const base = carried.get(above[l.bone] ?? 'hips') ?? torso;
      const was = (this.restDir.get(l.bone) ?? _a.set(0, 1, 0)).clone().applyQuaternion(base);
      const now = Ragdoll.direction(p, l.from, l.to);
      const q = new THREE.Quaternion().setFromUnitVectors(was.normalize(), now).multiply(base);
      carried.set(l.bone, q);
      if (l.bone === 'head') {
        // The neck takes half the head's turn.
        turn('neck', torso.clone().slerp(q, 0.5));
      }
      turn(l.bone, q);
      if (l.bone === 'lowerArmL') turn('handL', q);
      if (l.bone === 'lowerArmR') turn('handR', q);
    }
    s.root.updateMatrixWorld(true);
  }
}
