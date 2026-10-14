/**
 * Hands on the weapon: where the wrist must be for the palm to sit on a grip,
 * the hand's full orientation there, and a finger pose closed around it.
 *
 * Each hand is measured once from the bind pose (`measureHand`): the
 * direction from the wrist to the middle knuckle, the side the palm faces
 * (the side the thumb is on), and the five finger chains. A weapon names its
 * grasps (`Grasp`) in its own frame: a point on the part held, the hand's
 * forward and palm directions there, where that point lies in the hand (in
 * hand lengths), and how far each finger joint curls. Nothing here keeps
 * state between frames: the pose is a function of the weapon's transform.
 */

import * as THREE from 'three';
import { setWorldQuaternion } from './ik';

export type FingerName = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky';
const FINGERS: readonly FingerName[] = ['thumb', 'index', 'middle', 'ring', 'pinky'];

/** Curl per joint, base to tip (radians; positive closes toward the palm). */
export type Curl = Readonly<Record<FingerName, readonly [number, number, number]>>;

/** A hand's hold on a weapon part, in the weapon frame (+Z muzzle, +Y up, +X left). */
export interface Grasp {
  /** The point held (e.g. the middle of the pistol grip). */
  readonly point: THREE.Vector3;
  /** Wrist → knuckles. */
  readonly forward: THREE.Vector3;
  /** The direction the palm faces. */
  readonly palm: THREE.Vector3;
  /**
   * Where `point` lies in the hand, in hand lengths (wrist to middle
   * knuckle): along forward, toward the palm, toward the index finger.
   */
  readonly at: readonly [number, number, number];
  readonly curl: Curl;
  /** Swing of the thumb across the palm (radians). */
  readonly thumbOppose: number;
}

interface Joint {
  readonly bone: THREE.Bone;
  /** The bind-pose local rotation. */
  readonly rest: THREE.Quaternion;
  /** The curl axis in the joint's own frame. */
  readonly axis: THREE.Vector3;
}

export interface HandModel {
  readonly hand: THREE.Bone;
  /** Unit directions in the hand bone's frame: wrist → middle knuckle, palm, forward × palm. */
  readonly forward: THREE.Vector3;
  readonly palm: THREE.Vector3;
  readonly across: THREE.Vector3;
  /** +1 when the index finger is on the `across` side, −1 otherwise (left/right hands). */
  readonly indexSign: number;
  /** Wrist to middle knuckle, in the hand bone's local units. */
  readonly length: number;
  readonly fingers: Readonly<Record<FingerName, readonly Joint[]>>;
  /** The thumb's base swing axis (in the base joint's frame). */
  readonly thumbSwing: THREE.Vector3;
}

const chain = (base: THREE.Bone): THREE.Bone[] => {
  const out = [base];
  for (let b = base; ;) {
    const next = b.children.find((c): c is THREE.Bone => c instanceof THREE.Bone);
    if (!next) return out;
    out.push(next);
    b = next;
  }
};

/** A finger in the hand bone's frame, from its knuckle to its last joint. */
interface Digit {
  readonly bones: THREE.Bone[];
  /** Each joint's position and rotation relative to the hand. */
  readonly pos: THREE.Vector3[];
  readonly rot: THREE.Quaternion[];
  readonly knuckle: THREE.Vector3;
  readonly tip: THREE.Vector3;
}

/**
 * Walks a finger chain. Some rigs (Quaternius) root every finger at the
 * wrist; the knuckle is the first joint well away from it, and only joints
 * from there on curl.
 */
function digit(base: THREE.Bone): Digit | null {
  const all = chain(base);
  const pos: THREE.Vector3[] = [];
  const rot: THREE.Quaternion[] = [];
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  for (const b of all) {
    p.add(b.position.clone().applyQuaternion(q));
    q.multiply(b.quaternion);
    pos.push(p.clone());
    rot.push(q.clone());
  }
  const tip = pos[pos.length - 1];
  if (!tip || tip.length() < 1e-9) return null;
  const k = Math.max(
    0,
    pos.findIndex((x) => x.length() > 0.35 * tip.length()),
  );
  const knuckle = pos[k];
  if (!knuckle) return null;
  return { bones: all.slice(k), pos: pos.slice(k), rot: rot.slice(k), knuckle, tip };
}

/**
 * Measures a hand from its current (bind) pose. Null when the rig has no
 * five-fingered hand (the caller keeps the simple hold).
 */
export function measureHand(hand: THREE.Bone): HandModel | null {
  const digits = hand.children
    .filter((c): c is THREE.Bone => c instanceof THREE.Bone)
    .map(digit)
    .filter((d): d is Digit => d !== null);
  if (digits.length !== 5) return null;
  const mean = digits.reduce((a, d) => a.add(d.knuckle), new THREE.Vector3()).normalize();
  // The thumb's knuckle is the one nearest the wrist along the hand.
  const sorted = [...digits].sort((a, b) => a.knuckle.dot(mean) - b.knuckle.dot(mean));
  const [thumb, ...others] = sorted as [Digit, Digit, Digit, Digit, Digit];
  // Across the knuckles: the axis of greatest spread of the four fingers.
  const spread = new THREE.Vector3();
  for (const a of others)
    for (const b of others)
      if (a.knuckle.distanceTo(b.knuckle) > spread.length())
        spread.subVectors(a.knuckle, b.knuckle);
  // Order the fingers along the spread: pinky … index, the index nearest the thumb.
  const sideOf = (d: Digit) => d.knuckle.dot(spread);
  const ordered = [...others].sort((a, b) => sideOf(a) - sideOf(b)) as [Digit, Digit, Digit, Digit];
  if (sideOf(thumb) < (sideOf(ordered[0]) + sideOf(ordered[3])) / 2) ordered.reverse();
  const [pinky, ring, middle, index] = ordered;

  const length = middle.knuckle.length();
  if (length < 1e-9) return null;
  const forward = middle.knuckle.clone().normalize();
  const indexDir = index.knuckle.clone().sub(pinky.knuckle);
  indexDir.addScaledVector(forward, -indexDir.dot(forward)).normalize();
  // The palm faces the side of the hand plane the thumb is on.
  const palm = new THREE.Vector3().crossVectors(indexDir, forward).normalize();
  if (thumb.tip.dot(palm) < 0) palm.negate();
  const across = new THREE.Vector3().crossVectors(forward, palm).normalize();
  const indexSign = indexDir.dot(across) >= 0 ? 1 : -1;

  // A joint's curl axis: the hand-frame axis in the joint's own frame.
  const joints = (d: Digit, axisInHand: THREE.Vector3): Joint[] =>
    d.bones.map((bone, i) => ({
      bone,
      rest: bone.quaternion.clone(),
      axis: axisInHand
        .clone()
        .applyQuaternion((d.rot[i] ?? new THREE.Quaternion()).clone().invert())
        .normalize(),
    }));
  // The thumb closes toward the palm about the axis across its own direction.
  const thumbDir = thumb.tip.clone().sub(thumb.knuckle);
  const thumbAxis = new THREE.Vector3().crossVectors(thumbDir, palm).normalize();
  const thumbSwing = forward
    .clone()
    .applyQuaternion((thumb.rot[0] ?? new THREE.Quaternion()).clone().invert());

  return {
    hand,
    forward,
    palm,
    across,
    indexSign,
    length,
    fingers: {
      thumb: joints(thumb, thumbAxis),
      index: joints(index, across),
      middle: joints(middle, across),
      ring: joints(ring, across),
      pinky: joints(pinky, across),
    },
    thumbSwing,
  };
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _ql = new THREE.Quaternion();
const _s = new THREE.Vector3();

/**
 * The hand bone's world rotation and wrist position for `grasp` on a weapon
 * whose world transform is `weapon`. Only the hand's own geometry is used, so
 * it works for any arm pose; the arm IK then takes the wrist there.
 */
export function graspTarget(
  m: HandModel,
  grasp: Grasp,
  weapon: THREE.Matrix4,
): { wrist: THREE.Vector3; quat: THREE.Quaternion } {
  const wq = new THREE.Quaternion().setFromRotationMatrix(_m.extractRotation(weapon));
  const fwd = grasp.forward.clone().applyQuaternion(wq).normalize();
  const palm = grasp.palm.clone().applyQuaternion(wq);
  palm.addScaledVector(fwd, -palm.dot(fwd)).normalize();
  const across = new THREE.Vector3().crossVectors(fwd, palm);
  _ql.setFromRotationMatrix(_m.makeBasis(m.forward, m.palm, m.across));
  const quat = new THREE.Quaternion()
    .setFromRotationMatrix(_m.makeBasis(fwd, palm, across))
    .multiply(_ql.invert());
  // The hand's world scale, from this frame's pose (a stale matrix would
  // carry the previous frame into this one).
  m.hand.updateWorldMatrix(true, false);
  m.hand.matrixWorld.decompose(new THREE.Vector3(), _q, _s);
  const len = m.length * _s.x;
  const [a, b, c] = grasp.at;
  const wrist = grasp.point
    .clone()
    .applyMatrix4(weapon)
    .addScaledVector(fwd, -a * len)
    .addScaledVector(palm, -b * len)
    .addScaledVector(across, -c * m.indexSign * len);
  return { wrist, quat };
}

/** Turns the hand to `quat` (world), blended by `weight` from its current rotation. */
export function orientHand(m: HandModel, quat: THREE.Quaternion, weight: number): void {
  if (weight <= 0) return;
  m.hand.getWorldQuaternion(_q);
  setWorldQuaternion(m.hand, _q.slerp(quat, Math.min(1, weight)));
}

/** Closes the fingers to `grasp`'s curl, blended by `weight` from the clip's fingers. */
export function poseFingers(m: HandModel, grasp: Grasp, weight: number): void {
  if (weight <= 0) return;
  const w = Math.min(1, weight);
  for (const f of FINGERS) {
    const curl = grasp.curl[f];
    m.fingers[f].forEach((j, i) => {
      const target = j.rest
        .clone()
        .multiply(_q.setFromAxisAngle(j.axis, curl[Math.min(i, 2)] ?? 0));
      if (f === 'thumb' && i === 0)
        target.multiply(_q.setFromAxisAngle(m.thumbSwing, -grasp.thumbOppose * m.indexSign));
      j.bone.quaternion.slerp(target, w);
    });
  }
  m.hand.updateMatrixWorld(true);
}
