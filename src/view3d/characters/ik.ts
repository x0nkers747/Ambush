/**
 * Inverse kinematics used after the clip pose is sampled.
 *
 * - `twoBoneIK`: closed-form two-bone IK with a pole (elbows, knees). About
 *   80 lines; deterministic.
 */

import * as THREE from 'three';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _t = new THREE.Vector3();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qw = new THREE.Quaternion();
const _qp = new THREE.Quaternion();

/** Rotates `bone` by `delta` in world space (keeps its children attached). */
export function rotateWorld(bone: THREE.Object3D, delta: THREE.Quaternion): void {
  bone.getWorldQuaternion(_qw);
  _qw.premultiply(delta);
  if (bone.parent) {
    bone.parent.getWorldQuaternion(_qp).invert();
    _qw.premultiply(_qp);
  }
  bone.quaternion.copy(_qw);
  bone.updateMatrixWorld(true);
}

/** Sets `bone`'s world rotation. */
export function setWorldQuaternion(bone: THREE.Object3D, q: THREE.Quaternion): void {
  _qw.copy(q);
  if (bone.parent) {
    bone.parent.getWorldQuaternion(_qp).invert();
    _qw.premultiply(_qp);
  }
  bone.quaternion.copy(_qw);
  bone.updateMatrixWorld(true);
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/**
 * Moves the end of the chain upper → lower → end to `target`, bending in the
 * plane of `pole` (a world point the middle joint should point toward).
 * `weight` blends from the animated pose (0) to the solved pose (1).
 */
export function twoBoneIK(
  upper: THREE.Object3D,
  lower: THREE.Object3D,
  end: THREE.Object3D,
  target: THREE.Vector3,
  pole: THREE.Vector3,
  weight = 1,
): void {
  if (weight <= 0) return;
  upper.updateMatrixWorld(true);
  upper.getWorldPosition(_a);
  lower.getWorldPosition(_b);
  end.getWorldPosition(_c);
  _t.copy(_c).lerp(target, clamp(weight, 0, 1));
  const lab = _b.distanceTo(_a);
  const lcb = _c.distanceTo(_b);
  const lat = clamp(_t.distanceTo(_a), 1e-4, (lab + lcb) * 0.9999);

  // 1. Bend the middle joint to the length the target needs.
  const acAb0 = angle(_v.subVectors(_c, _a), _w.subVectors(_b, _a));
  const baBc0 = angle(_v.subVectors(_a, _b), _w.subVectors(_c, _b));
  const acAb1 = Math.acos(clamp((lcb * lcb - lab * lab - lat * lat) / (-2 * lab * lat), -1, 1));
  const baBc1 = Math.acos(clamp((lat * lat - lab * lab - lcb * lcb) / (-2 * lab * lcb), -1, 1));
  const axis = new THREE.Vector3().crossVectors(_v.subVectors(_c, _a), _w.subVectors(_b, _a));
  if (axis.lengthSq() < 1e-10) axis.crossVectors(_v.subVectors(_c, _a), _w.subVectors(pole, _a));
  axis.normalize();
  rotateWorld(upper, _q.setFromAxisAngle(axis, acAb1 - acAb0));
  rotateWorld(lower, _q.setFromAxisAngle(axis, baBc1 - baBc0));

  // 2. Swing the chain so its end points at the target.
  end.getWorldPosition(_c);
  _v.subVectors(_c, _a).normalize();
  _w.subVectors(_t, _a).normalize();
  rotateWorld(upper, _q.setFromUnitVectors(_v, _w));

  // 3. Twist about the shoulder → target axis so the middle joint faces the pole.
  lower.getWorldPosition(_b);
  const dir = _w.clone();
  const toMid = _v.subVectors(_b, _a);
  toMid.addScaledVector(dir, -toMid.dot(dir));
  const toPole = new THREE.Vector3().subVectors(pole, _a);
  toPole.addScaledVector(dir, -toPole.dot(dir));
  if (toMid.lengthSq() > 1e-10 && toPole.lengthSq() > 1e-10) {
    toMid.normalize();
    toPole.normalize();
    let twist = Math.acos(clamp(toMid.dot(toPole), -1, 1));
    if (new THREE.Vector3().crossVectors(toMid, toPole).dot(dir) < 0) twist = -twist;
    rotateWorld(upper, _q.setFromAxisAngle(dir, twist * clamp(weight, 0, 1)));
  }
}

function angle(a: THREE.Vector3, b: THREE.Vector3): number {
  const la = a.length();
  const lb = b.length();
  if (la < 1e-9 || lb < 1e-9) return 0;
  return Math.acos(clamp(a.dot(b) / (la * lb), -1, 1));
}

/**
 * Rotates the end bone so a direction fixed in it (`localDir`, e.g. toward
 * the fingers) points along world `want`, by the shortest rotation.
 */
export function aimBone(bone: THREE.Object3D, localDir: THREE.Vector3, want: THREE.Vector3) {
  bone.updateMatrixWorld(true);
  bone.getWorldQuaternion(_qw);
  const cur = _v.copy(localDir).applyQuaternion(_qw).normalize();
  rotateWorld(bone, _q.setFromUnitVectors(cur, _w.copy(want).normalize()));
}
