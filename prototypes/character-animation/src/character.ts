/**
 * A soldier in the scene: a skinned model clone, its weapon, and the
 * post-processing every runtime shares (so visual differences come from the
 * runtimes alone): spine aim, the weapon hold with hand IK, recoil, muzzle
 * flash, and foot placement on uneven ground. All of it is a function of the
 * pose input and the sampled clip pose — no state of its own.
 */

import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { boneOf, type CharacterAsset } from './assets';
import { aimBone, CcdArm, rotateWorld, twoBoneIK } from './ik';
import type { PoseInput } from './pose-input';
import { type BoneKey, RIG_BONES } from './rigs';
import { placeOnMap } from './scene';
import type { WeaponInstance } from './weapons';

export type IkMode = 'two-bone' | 'ccd' | 'off';

export interface PostOptions {
  ik: IkMode;
  /** Head looks along the aim (custom look-at; three.js has none for bones). */
  headLook?: boolean;
  footIk: boolean;
  weaponHold: boolean;
  spineAim: boolean;
}

export interface SoldierView {
  readonly asset: CharacterAsset;
  readonly root: THREE.Object3D;
  readonly bones: Partial<Record<BoneKey, THREE.Bone>>;
  readonly skinned: THREE.SkinnedMesh[];
  weapon: WeaponInstance | null;
  /** The face's forward direction in the head bone's local frame (from the rest pose). */
  readonly headForward: THREE.Vector3;
  /** Hand direction toward the fingers, in each hand bone's local frame. */
  readonly fingerDir: { L: THREE.Vector3; R: THREE.Vector3 };
  ccd: { L: CcdArm; R: CcdArm } | null;
  /** Every bone's local transform as the mixer last wrote it (see `saveClipPose`). */
  readonly clipPose: Float64Array;
  /** The rest pose (for binding mixers: see `applyRestPose`). */
  readonly restPose: Float64Array;
  readonly allBones: THREE.Bone[];
}

/**
 * Puts the bones in the rest pose. Call before creating a mixer's actions:
 * three.js records each bound property's "original state" when it is first
 * bound and blends it in wherever clip weights sum to less than 1, so a
 * mixer bound on a posed skeleton would carry that pose forever.
 */
export function applyRestPose(s: SoldierView): void {
  s.clipPose.set(s.restPose);
  restoreClipPose(s);
}

/**
 * three.js's PropertyMixer only writes a bone when the newly sampled value
 * differs from the value it wrote last time, so a bone that post-processing
 * (IK, aim) changed afterwards keeps the change, and the next frame's IK is
 * applied on top of it. The fix: save the sampled pose right after the mixer
 * runs and restore it before the next update.
 */
export function saveClipPose(s: SoldierView): void {
  s.allBones.forEach((b, i) => {
    s.clipPose.set(
      [
        b.position.x,
        b.position.y,
        b.position.z,
        b.quaternion.x,
        b.quaternion.y,
        b.quaternion.z,
        b.quaternion.w,
      ],
      i * 7,
    );
  });
}

export function restoreClipPose(s: SoldierView): void {
  const p = s.clipPose;
  s.allBones.forEach((b, i) => {
    const o = i * 7;
    b.position.set(p[o] ?? 0, p[o + 1] ?? 0, p[o + 2] ?? 0);
    b.quaternion.set(p[o + 3] ?? 0, p[o + 4] ?? 0, p[o + 5] ?? 0, p[o + 6] ?? 1);
  });
}

export function createSoldier(asset: CharacterAsset): SoldierView {
  const root = SkeletonUtils.clone(asset.template);
  root.updateMatrixWorld(true);
  const bones: Partial<Record<BoneKey, THREE.Bone>> = {};
  for (const k of Object.keys(RIG_BONES[asset.rig]) as BoneKey[]) {
    const b = boneOf(root, asset.rig, k);
    if (b) bones[k] = b;
  }
  const skinned: THREE.SkinnedMesh[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.SkinnedMesh) skinned.push(o as THREE.SkinnedMesh);
  });
  const finger = (hand?: THREE.Bone, fore?: THREE.Bone) => {
    const child = hand?.children.find((c) => c instanceof THREE.Bone);
    const v = new THREE.Vector3();
    if (hand && child) v.copy(child.position);
    else if (hand && fore) {
      v.copy(hand.getWorldPosition(new THREE.Vector3())).sub(
        fore.getWorldPosition(new THREE.Vector3()),
      );
      v.transformDirection(new THREE.Matrix4().copy(hand.matrixWorld).invert());
    } else v.set(0, 1, 0);
    return v.normalize();
  };
  const headQ = bones.head?.getWorldQuaternion(new THREE.Quaternion()) ?? new THREE.Quaternion();
  const rootQ = root.getWorldQuaternion(new THREE.Quaternion());
  const headForward = new THREE.Vector3(0, 0, 1)
    .applyQuaternion(rootQ)
    .applyQuaternion(headQ.invert());
  const allBones: THREE.Bone[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.Bone) allBones.push(o as THREE.Bone);
  });
  const view = {
    asset,
    root,
    bones,
    skinned,
    headForward,
    allBones,
    clipPose: new Float64Array(allBones.length * 7),
    restPose: new Float64Array(allBones.length * 7),
    weapon: null,
    fingerDir: { L: finger(bones.handL, bones.lowerArmL), R: finger(bones.handR, bones.lowerArmR) },
    ccd: null,
  };
  saveClipPose(view);
  view.restPose.set(view.clipPose);
  return view;
}

export function enableCcd(s: SoldierView): void {
  if (s.ccd) return;
  const mesh = s.skinned[0];
  const b = s.bones;
  if (!mesh || !b.upperArmL || !b.lowerArmL || !b.handL || !b.upperArmR || !b.lowerArmR || !b.handR)
    return;
  s.ccd = {
    L: new CcdArm(mesh, b.upperArmL, b.lowerArmL, b.handL),
    R: new CcdArm(mesh, b.upperArmR, b.lowerArmR, b.handR),
  };
  // Every skinned mesh of the model shares the rebound skeleton.
  for (const m of s.skinned) if (m !== mesh) m.bind(mesh.skeleton, m.bindMatrix);
}

/** Places the root from the pose input (map → three.js). */
export function placeSoldier(s: SoldierView, input: PoseInput, groundZ: number): void {
  placeOnMap(s.root, input.x, input.y, groundZ, input.azimuth);
  s.root.updateMatrixWorld(true);
}

const smooth = (t: number) => t * t * (3 - 2 * t);
/** Torso twist when holding a rifle at the shoulder (left shoulder forward). */
const BLADE_RAD = 0.78;
const UP = new THREE.Vector3(0, 1, 0);

interface Hold {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
}

/**
 * The weapon's grip-origin transform for a carry state, in the body frame
 * after the torso has been bladed:
 * - aimed: butt in the shoulder pocket (inside the right shoulder joint),
 *   barrel along the aim;
 * - ready (low ready): butt in the pocket, muzzle 30° below the aim;
 * - lowered (patrol): weapon across the body, grip at the right hip-front,
 *   muzzle down and to the left.
 * Prone: always along the ground at the shoulder.
 */
function holdFor(
  carry: PoseInput['carry'],
  s: SoldierView,
  w: WeaponInstance,
  pitch: number,
  prone: boolean,
): Hold {
  const F = new THREE.Vector3(0, 0, 1).applyQuaternion(s.root.quaternion);
  const R = new THREE.Vector3().crossVectors(F, UP).normalize();
  const shoulder = s.bones.upperArmR?.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3();
  const aim = (p: number) => F.clone().multiplyScalar(Math.cos(p)).addScaledVector(UP, Math.sin(p));
  let dir: THREE.Vector3;
  let anchor: THREE.Vector3;
  let anchorIsGrip = false;
  const pocket = shoulder
    .clone()
    .addScaledVector(R, -0.07)
    .addScaledVector(F, 0.04)
    .addScaledVector(UP, -0.03);
  if (prone) {
    dir = aim(carry === 'aimed' ? pitch : -0.06);
    anchor = pocket;
  } else if (carry === 'aimed') {
    dir = aim(pitch);
    anchor = pocket;
  } else if (carry === 'ready') {
    dir = aim(pitch - 0.52);
    anchor = pocket.addScaledVector(UP, -0.04);
  } else {
    dir = F.clone()
      .multiplyScalar(0.7)
      .addScaledVector(R, -0.45)
      .addScaledVector(UP, -0.55)
      .normalize();
    anchor = shoulder
      .clone()
      .addScaledVector(R, -0.08)
      .addScaledVector(UP, -0.3)
      .addScaledVector(F, 0.22);
    anchorIsGrip = true;
  }
  // Orientation: forward along `dir`, up as close to world up as possible.
  const z = dir.normalize();
  const x = new THREE.Vector3().crossVectors(UP, z);
  if (x.lengthSq() < 1e-6) x.copy(R).negate();
  x.normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  const pos = anchorIsGrip ? anchor : anchor.sub(w.profile.butt.clone().applyQuaternion(quat));
  return { pos, quat };
}

/**
 * Clavicle reach: when a hand target is beyond the arm's reach, swing the
 * shoulder (clavicle) bone part of the way toward it, as people do.
 */
function reach(s: SoldierView, side: 'L' | 'R', target: THREE.Vector3): void {
  const b = s.bones;
  const clav = side === 'L' ? b.shoulderL : b.shoulderR;
  const up = side === 'L' ? b.upperArmL : b.upperArmR;
  const lo = side === 'L' ? b.lowerArmL : b.lowerArmR;
  const hand = side === 'L' ? b.handL : b.handR;
  if (!clav || !up || !lo || !hand) return;
  const pu = up.getWorldPosition(new THREE.Vector3());
  const len =
    pu.distanceTo(lo.getWorldPosition(new THREE.Vector3())) +
    lo.getWorldPosition(new THREE.Vector3()).distanceTo(hand.getWorldPosition(new THREE.Vector3()));
  const d = pu.distanceTo(target);
  if (d < len * 0.92) return;
  const pc = clav.getWorldPosition(new THREE.Vector3());
  const from = pu.clone().sub(pc).normalize();
  const to = target.clone().sub(pc).normalize();
  const full = new THREE.Quaternion().setFromUnitVectors(from, to);
  const f = Math.min(0.45, (d - len * 0.92) / Math.max(1e-3, pc.distanceTo(pu)));
  rotateWorld(clav, new THREE.Quaternion().slerp(full, f));
}

/** Everything after the clip pose, in order: feet, spine, weapon, hands. */
export function postProcess(
  s: SoldierView,
  input: PoseInput,
  opts: PostOptions,
  heightAt: (x: number, y: number) => number,
  flatGround: boolean,
): void {
  const b = s.bones;
  s.root.updateMatrixWorld(true);
  const down = input.sinceDown >= 0;
  const prone = input.posture === 'prone' && input.postureT > 0.5;

  // 1. Feet on uneven ground: lower the pelvis by the lower foot's offset,
  //    then two-bone IK each leg to the ground under its foot.
  if (opts.footIk && !flatGround && !down && input.posture !== 'prone') {
    footIk(s, heightAt);
  }

  // 2. Spine aim: blade the torso (left shoulder forward, as a rifleman
  //    stands) and distribute the aim pitch over the spine; the head turns
  //    back to look along the aim.
  const aimW =
    input.carry === 'aimed'
      ? smooth(input.carryT)
      : input.carryFrom === 'aimed'
        ? 1 - smooth(input.carryT)
        : 0;
  const bladeFor = (c: PoseInput['carry']) => (c === 'aimed' ? 1 : c === 'ready' ? 0.75 : 0.2);
  const blade =
    (bladeFor(input.carryFrom) +
      (bladeFor(input.carry) - bladeFor(input.carryFrom)) * smooth(input.carryT)) *
    (down ? 1 - smooth(Math.min(1, input.sinceDown / 0.3)) : 1);
  if (opts.spineAim && s.weapon && !prone) {
    const F = new THREE.Vector3(0, 0, 1).applyQuaternion(s.root.quaternion);
    const R = new THREE.Vector3().crossVectors(F, UP).normalize();
    const spines = [b.spine1, b.spine2, b.spine3].filter((x): x is THREE.Bone => !!x);
    const yaw = -BLADE_RAD * blade;
    const pitch = aimW * input.aimPitch;
    for (const sp of spines) {
      rotateWorld(sp, new THREE.Quaternion().setFromAxisAngle(UP, yaw / spines.length));
      if (Math.abs(pitch) > 1e-4)
        rotateWorld(sp, new THREE.Quaternion().setFromAxisAngle(R, pitch / spines.length));
    }
    const look = b.neck ?? b.head;
    if (look) rotateWorld(look, new THREE.Quaternion().setFromAxisAngle(UP, -yaw * 0.8));
    // Look along the aim, the head tipped onto the stock when aiming.
    if (opts.headLook !== false && b.head) {
      const want = F.clone()
        .multiplyScalar(Math.cos(input.aimPitch * aimW - 0.18 * aimW))
        .addScaledVector(UP, Math.sin(input.aimPitch * aimW - 0.18 * aimW));
      const hq = b.head.getWorldQuaternion(new THREE.Quaternion());
      const cur = s.headForward.clone().applyQuaternion(hq).normalize();
      const fix = new THREE.Quaternion().setFromUnitVectors(cur, want.normalize());
      rotateWorld(b.head, new THREE.Quaternion().slerp(fix, 0.85 * (1 - (down ? 1 : 0))));
    }
  }

  // 3. Weapon hold and hands.
  const w = s.weapon;
  if (!w) return;
  if (!opts.weaponHold) {
    w.object.visible = false;
    return;
  }
  w.object.visible = true;
  const pitch = input.aimPitch;
  const to = holdFor(input.carry, s, w, pitch, prone);
  const from = holdFor(input.carryFrom, s, w, pitch, prone);
  const k = smooth(input.carryT);
  const hold: Hold = { pos: from.pos.lerp(to.pos, k), quat: from.quat.slerp(to.quat, k) };

  // Reload: weapon canted and lowered a little; the support hand goes to a
  // pouch and back (procedural — no usable rifle reload clip for these rigs).
  let supportW = 1;
  let reloadHand: THREE.Vector3 | null = null;
  if (input.reloadT >= 0) {
    const r = input.reloadT;
    const env = smooth(Math.min(1, r / 0.15)) * smooth(Math.min(1, (1 - r) / 0.15));
    hold.quat.multiply(
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.5 * env),
    );
    hold.pos.addScaledVector(UP, -0.05 * env);
    const magwell = new THREE.Vector3(0, -0.12, 0.06).applyQuaternion(hold.quat).add(hold.pos);
    const pouch = (b.spine1?.getWorldPosition(new THREE.Vector3()) ?? magwell.clone())
      .addScaledVector(new THREE.Vector3(0, 0, 1).applyQuaternion(s.root.quaternion), 0.16)
      .addScaledVector(UP, -0.05);
    const path = (u: number) =>
      u < 0.5
        ? magwell.clone().lerp(pouch, smooth(u / 0.5))
        : pouch.clone().lerp(magwell, smooth((u - 0.5) / 0.5));
    if (r > 0.12 && r < 0.75) {
      reloadHand = path((r - 0.12) / 0.63);
      supportW = 0;
    } else if (r >= 0.75) {
      supportW = smooth((r - 0.75) / 0.25);
    }
  }

  // Recoil: closed-form decay from the last shot's time (no integration).
  if (input.sinceShot < 0.5 && !down) {
    const e = Math.exp(-input.sinceShot / 0.06);
    const F = new THREE.Vector3(0, 0, 1).applyQuaternion(hold.quat);
    hold.pos.addScaledVector(F, -w.profile.kick * e);
    const R = new THREE.Vector3(1, 0, 0).applyQuaternion(hold.quat);
    hold.quat.premultiply(new THREE.Quaternion().setFromAxisAngle(R, -w.profile.rise * e));
  }
  w.flash.visible = input.sinceShot < 0.045 && !down;
  if (w.flash.visible) w.flash.rotation.z = input.lastShot * 37;

  // Incapacitated: hands let go over 0.3 s and the weapon falls beside the body.
  let handW = 1;
  if (down) {
    handW = 1 - smooth(Math.min(1, input.sinceDown / 0.3));
    const F = new THREE.Vector3(0, 0, 1).applyQuaternion(s.root.quaternion);
    const R = new THREE.Vector3().crossVectors(F, UP).normalize();
    const g = s.root.position.clone().addScaledVector(F, 0.7).addScaledVector(R, 0.35);
    g.y += 0.03;
    const fall = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), R);
    fall.premultiply(new THREE.Quaternion().setFromAxisAngle(R, 0));
    const f = smooth(Math.min(1, input.sinceDown / 0.6));
    hold.pos.lerp(g, f);
    hold.quat.slerp(
      fall.multiply(
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2),
      ),
      f,
    );
  }

  w.object.position.copy(hold.pos);
  w.object.quaternion.copy(hold.quat);
  w.object.updateMatrixWorld(true);

  if (opts.ik === 'off' || handW <= 0) return;
  const grip = w.object.position.clone();
  const support = reloadHand ?? w.profile.support.clone().applyMatrix4(w.object.matrixWorld);
  const F = new THREE.Vector3(0, 0, 1).applyQuaternion(hold.quat);
  const Wup = new THREE.Vector3(0, 1, 0).applyQuaternion(hold.quat);
  const Wr = new THREE.Vector3(-1, 0, 0).applyQuaternion(hold.quat);
  const RR = new THREE.Vector3()
    .crossVectors(new THREE.Vector3(0, 0, 1).applyQuaternion(s.root.quaternion), UP)
    .normalize();

  if (opts.ik === 'ccd' && s.ccd) {
    s.ccd.R.solve(grip);
    s.ccd.L.solve(support);
  } else {
    reach(s, 'R', grip);
    reach(s, 'L', reloadHand ?? support);
    if (b.upperArmR && b.lowerArmR && b.handR) {
      const sh = b.upperArmR.getWorldPosition(new THREE.Vector3());
      const pole = sh.clone().addScaledVector(RR, 0.45).addScaledVector(UP, -0.7);
      twoBoneIK(b.upperArmR, b.lowerArmR, b.handR, grip, pole, handW);
    }
    if (b.upperArmL && b.lowerArmL && b.handL) {
      const sh = b.upperArmL.getWorldPosition(new THREE.Vector3());
      const pole = sh.clone().addScaledVector(RR, -0.35).addScaledVector(UP, -0.8);
      const wL = reloadHand ? handW : handW * supportW;
      const target = reloadHand ?? support;
      twoBoneIK(
        b.upperArmL,
        b.lowerArmL,
        b.handL,
        target,
        pole,
        reloadHand ? handW : Math.max(wL, 0),
      );
    }
  }
  // Hands: fingers wrap the grip (forward-down) and cradle the handguard.
  if (b.handR)
    aimBone(b.handR, s.fingerDir.R, F.clone().multiplyScalar(0.55).addScaledVector(Wup, -0.8));
  if (b.handL && !reloadHand && supportW > 0.5)
    aimBone(
      b.handL,
      s.fingerDir.L,
      F.clone().multiplyScalar(0.45).addScaledVector(Wr, 0.75).addScaledVector(Wup, 0.3),
    );
}

const _g = new THREE.Vector3();

function footIk(s: SoldierView, heightAt: (x: number, y: number) => number) {
  const b = s.bones;
  if (
    !b.hips ||
    !b.upperLegL ||
    !b.lowerLegL ||
    !b.footL ||
    !b.upperLegR ||
    !b.lowerLegR ||
    !b.footR
  )
    return;
  const rootY = s.root.position.y;
  const feet = [
    [b.upperLegL, b.lowerLegL, b.footL],
    [b.upperLegR, b.lowerLegR, b.footR],
  ] as const;
  const offsets = feet.map(([, , f]) => {
    f.getWorldPosition(_g);
    // three.js (x, y, z) → map (x, -z).
    return heightAt(_g.x, -_g.z) - rootY;
  });
  const drop = Math.max(-0.45, Math.min(0, ...offsets));
  if (drop < 0) {
    const hp = b.hips.getWorldPosition(new THREE.Vector3());
    hp.y += drop;
    const parent = b.hips.parent;
    if (parent) parent.worldToLocal(hp);
    b.hips.position.copy(hp);
    b.hips.updateMatrixWorld(true);
  }
  const F = new THREE.Vector3(0, 0, 1).applyQuaternion(s.root.quaternion);
  feet.forEach(([u, l, f], i) => {
    const target = f.getWorldPosition(new THREE.Vector3());
    target.y += (offsets[i] ?? 0) - drop;
    const knee = l.getWorldPosition(new THREE.Vector3()).addScaledVector(F, 0.5);
    twoBoneIK(u, l, f, target, knee, 1);
    // Tilt the foot to the slope (finite differences of the height function).
    const p = f.getWorldPosition(new THREE.Vector3());
    const e = 0.15;
    const hx = (heightAt(p.x + e, -p.z) - heightAt(p.x - e, -p.z)) / (2 * e);
    const hz = (heightAt(p.x, -(p.z + e)) - heightAt(p.x, -(p.z - e))) / (2 * e);
    const n = new THREE.Vector3(-hx, 1, -hz).normalize();
    const tilt = new THREE.Quaternion().setFromUnitVectors(UP, n);
    rotateWorld(f, new THREE.Quaternion().slerp(tilt, 0.8));
  });
}
