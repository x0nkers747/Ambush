/**
 * Clip retargeting between rigs with different bone names, axes and rest
 * poses. Two methods are offered so they can be compared in the prototype:
 *
 * - `three`: three.js's own `SkeletonUtils.retargetClip` (the existing tool);
 * - `rest-aligned` (default): world-space rotation deltas from the source
 *   rest pose, applied to the target rest pose after aligning each target
 *   bone's direction with the source's (so an A-pose source drives a T-pose
 *   target). About 100 lines; this is the "offline retarget" step the
 *   proposal would run in a build script instead of at load time.
 */

import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { BONE_KEYS, type BoneKey, RIG_BONES, type RigId } from './rigs';

export type RetargetMethod = 'rest-aligned' | 'three';
export const retargetSettings: { method: RetargetMethod } = { method: 'rest-aligned' };

interface Rigged {
  readonly rig: RigId;
  readonly root: THREE.Object3D;
  readonly skeleton?: THREE.Skeleton;
  /** Pose the source in this clip's first frame before reading its rest pose. */
  readonly restClip?: THREE.AnimationClip;
}

/** The canonical child used to find each bone's direction. */
const CHILD: Partial<Record<BoneKey, BoneKey>> = {
  spine1: 'spine2',
  spine2: 'spine3',
  spine3: 'neck',
  neck: 'head',
  shoulderL: 'upperArmL',
  upperArmL: 'lowerArmL',
  lowerArmL: 'handL',
  shoulderR: 'upperArmR',
  upperArmR: 'lowerArmR',
  lowerArmR: 'handR',
  upperLegL: 'lowerLegL',
  lowerLegL: 'footL',
  footL: 'toesL',
  upperLegR: 'lowerLegR',
  lowerLegR: 'footR',
  footR: 'toesR',
};

const FPS = 30;

function bones(root: THREE.Object3D, rig: RigId) {
  const out = new Map<BoneKey, THREE.Object3D>();
  for (const k of BONE_KEYS) {
    const name = RIG_BONES[rig][k];
    const b = name ? root.getObjectByName(name) : undefined;
    if (b) out.set(k, b);
  }
  return out;
}

const worldQuat = (o: THREE.Object3D) => o.getWorldQuaternion(new THREE.Quaternion());
const worldPos = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());

const CONTACT_JOINTS: readonly BoneKey[] = [
  'hips',
  'spine3',
  'head',
  'lowerArmL',
  'lowerArmR',
  'handL',
  'handR',
  'lowerLegL',
  'lowerLegR',
  'footL',
  'footR',
  'toesL',
  'toesR',
];

/** World height of the lowest contact joint. */
function lowestJoint(b: ReadonlyMap<BoneKey, THREE.Object3D>): number {
  let min = Infinity;
  for (const k of CONTACT_JOINTS) {
    const o = b.get(k);
    if (o) min = Math.min(min, worldPos(o).y);
  }
  return min;
}

/**
 * @param groundContact keep the lowest joint on the ground (lying, crawling,
 *   kneeling, deaths); off for locomotion, whose flight phases must survive.
 */
export function retargetClip(
  clip: THREE.AnimationClip,
  source: Rigged,
  target: Rigged,
  name: string,
  groundContact = false,
): THREE.AnimationClip {
  if (retargetSettings.method === 'three') return retargetWithThree(clip, source, target, name);
  return retargetRestAligned(clip, source, target, name, groundContact);
}

function retargetWithThree(
  clip: THREE.AnimationClip,
  source: Rigged,
  target: Rigged,
  name: string,
): THREE.AnimationClip {
  const names: Record<string, string> = {};
  for (const k of BONE_KEYS) {
    const t = RIG_BONES[target.rig][k];
    const s = RIG_BONES[source.rig][k];
    if (t && s) names[t] = s;
  }
  let targetMesh: THREE.SkinnedMesh | undefined;
  target.root.traverse((o) => {
    if (!targetMesh && o instanceof THREE.SkinnedMesh) targetMesh = o as THREE.SkinnedMesh;
  });
  let sourceMesh: THREE.SkinnedMesh | undefined;
  const srcClone = SkeletonUtils.clone(source.root);
  srcClone.traverse((o) => {
    if (!sourceMesh && o instanceof THREE.SkinnedMesh) sourceMesh = o as THREE.SkinnedMesh;
  });
  if (!targetMesh || !sourceMesh) throw new Error('retarget: no skinned mesh');
  const out = SkeletonUtils.retargetClip(targetMesh, sourceMesh, clip, {
    names,
    hip: RIG_BONES[target.rig].hips ?? 'hip',
    fps: FPS,
    useFirstFramePosition: false,
  });
  out.name = name;
  // retargetClip emits tracks named `.bones[name].quaternion`; rebind to bone names.
  for (const t of out.tracks) t.name = t.name.replace(/^\.bones\[([^\]]+)\]/, '$1');
  return out;
}

function retargetRestAligned(
  clip: THREE.AnimationClip,
  source: Rigged,
  target: Rigged,
  name: string,
  groundContact: boolean,
): THREE.AnimationClip {
  const src = SkeletonUtils.clone(source.root);
  const tgt = SkeletonUtils.clone(target.root);
  src.position.set(0, 0, 0);
  src.quaternion.identity();
  tgt.position.set(0, 0, 0);
  tgt.quaternion.identity();
  const mixer = new THREE.AnimationMixer(src);
  if (source.restClip) {
    const rest = mixer.clipAction(source.restClip);
    rest.play();
    mixer.setTime(0);
    rest.stop();
  }
  src.updateMatrixWorld(true);
  tgt.updateMatrixWorld(true);
  const sb = bones(src, source.rig);
  const tb = bones(tgt, target.rig);
  const keys = BONE_KEYS.filter((k) => sb.has(k) && tb.has(k));

  // Rest data.
  const sRest = new Map<BoneKey, THREE.Quaternion>();
  const tRestAligned = new Map<BoneKey, THREE.Quaternion>();
  for (const k of keys) {
    const s = sb.get(k);
    const t = tb.get(k);
    if (!s || !t) continue;
    sRest.set(k, worldQuat(s));
    const tq = worldQuat(t);
    const child = CHILD[k];
    const sc = child ? sb.get(child) : undefined;
    const tc = child ? tb.get(child) : undefined;
    if (sc && tc) {
      const sd = worldPos(sc).sub(worldPos(s)).normalize();
      const td = worldPos(tc).sub(worldPos(t)).normalize();
      const align = new THREE.Quaternion().setFromUnitVectors(td, sd);
      tq.premultiply(align);
    }
    tRestAligned.set(k, tq);
  }
  const tLocalRest = new Map<THREE.Object3D, THREE.Quaternion>();
  tgt.traverse((o) => tLocalRest.set(o, o.quaternion.clone()));
  const sHips = sb.get('hips');
  const tHips = tb.get('hips');
  if (!sHips || !tHips) throw new Error('retarget: no hips');
  const sHipsRest = worldPos(sHips);
  const tHipsRest = worldPos(tHips);
  const heightRatio = tHipsRest.y / Math.max(1e-6, sHipsRest.y);
  const tHipsLocalRest = tHips.position.clone();
  const tGround = lowestJoint(tb);

  mixer.clipAction(clip).play();
  const frames = Math.max(2, Math.round(clip.duration * FPS) + 1);
  const times = new Float32Array(frames);
  const quats = new Map<BoneKey, Float32Array>(keys.map((k) => [k, new Float32Array(frames * 4)]));
  const hipPos = new Float32Array(frames * 3);
  const d = new THREE.Quaternion();
  const q = new THREE.Quaternion();
  const pInv = new THREE.Quaternion();
  const p = new THREE.Vector3();

  for (let f = 0; f < frames; f++) {
    const time = Math.min(clip.duration, f / FPS);
    times[f] = time;
    mixer.setTime(time);
    src.updateMatrixWorld(true);
    for (const [o, r] of tLocalRest) o.quaternion.copy(r);
    for (const k of keys) {
      const s = sb.get(k);
      const t = tb.get(k);
      const sr = sRest.get(k);
      const tr = tRestAligned.get(k);
      if (!s || !t || !sr || !tr) continue;
      // Desired target world rotation = (source delta from rest) · aligned target rest.
      d.copy(worldQuat(s)).multiply(q.copy(sr).invert());
      const want = d.multiply(tr);
      t.parent?.updateWorldMatrix(true, false);
      if (t.parent) pInv.copy(worldQuat(t.parent)).invert();
      else pInv.identity();
      t.quaternion.copy(pInv.multiply(want));
      t.updateMatrixWorld(true);
      quats.get(k)?.set([t.quaternion.x, t.quaternion.y, t.quaternion.z, t.quaternion.w], f * 4);
    }
    // Hips translation: the source's offset from rest, scaled to the target's leg length.
    const sp = worldPos(sHips).sub(sHipsRest).multiplyScalar(heightRatio);
    p.copy(tHipsRest).add(sp);
    // Ground contact: proportions differ (a chibi lying down is thicker than a
    // soldier), so keep the target's lowest joint at its rest height above the
    // ground. Walking keeps its bob (the planted foot is the lowest joint).
    tHips.position.copy(p);
    tHips.parent?.updateWorldMatrix(true, false);
    if (tHips.parent) tHips.parent.worldToLocal(tHips.position);
    tgt.updateMatrixWorld(true);
    if (groundContact) p.y += tGround - lowestJoint(tb);
    tHips.parent?.updateWorldMatrix(true, false);
    if (tHips.parent) tHips.parent.worldToLocal(p);
    hipPos.set([p.x, p.y, p.z], f * 3);
  }
  tHips.position.copy(tHipsLocalRest);
  const tracks: THREE.KeyframeTrack[] = [];
  for (const k of keys) {
    const t = tb.get(k);
    const v = quats.get(k);
    if (t && v) tracks.push(new THREE.QuaternionKeyframeTrack(`${t.name}.quaternion`, times, v));
  }
  tracks.push(new THREE.VectorKeyframeTrack(`${tHips.name}.position`, times, hipPos));
  return new THREE.AnimationClip(name, clip.duration, tracks);
}
