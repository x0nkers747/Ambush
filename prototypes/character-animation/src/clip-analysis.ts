/**
 * Measurements taken from clips at load time (the proposal does this in an
 * offline build step): the ground speed a locomotion clip was authored for,
 * found from its planted feet, so playback can be matched to the simulation's
 * speed without foot sliding.
 */

import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { RIG_BONES, type RigId } from './rigs';

export interface ClipMetrics {
  /** Ground speed implied by the planted foot (m/s); 0 for clips without stepping. */
  readonly speed: number;
  /** Distance covered by one loop of the clip (m). */
  readonly cycleDistance: number;
}

const SAMPLES = 120;

/** Ground speed of an in-place locomotion clip, from its planted feet. */
export function measureClip(
  template: THREE.Object3D,
  rig: RigId,
  clip: THREE.AnimationClip,
  contacts: 'feet' | 'hands' = 'feet',
): ClipMetrics {
  const o = SkeletonUtils.clone(template);
  o.position.set(0, 0, 0);
  o.quaternion.identity();
  const mixer = new THREE.AnimationMixer(o);
  mixer.clipAction(clip).play();
  const names = RIG_BONES[rig];
  const byName = (n: string | undefined) => (n ? o.getObjectByName(n) : undefined);
  const hands = contacts === 'hands';
  const fl = byName(hands ? names.handL : names.footL);
  const fr = byName(hands ? names.handR : names.footR);
  const tl = byName(hands ? names.lowerArmL : names.toesL);
  const tr = byName(hands ? names.lowerArmR : names.toesR);
  if (!fl || !fr) return { speed: 0, cycleDistance: 0 };
  const pts: { l: THREE.Vector3; r: THREE.Vector3; tl: THREE.Vector3; tr: THREE.Vector3 }[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    mixer.setTime((clip.duration * i) / SAMPLES);
    o.updateMatrixWorld(true);
    pts.push({
      l: fl.getWorldPosition(new THREE.Vector3()),
      r: fr.getWorldPosition(new THREE.Vector3()),
      tl: (tl ?? fl).getWorldPosition(new THREE.Vector3()),
      tr: (tr ?? fr).getWorldPosition(new THREE.Vector3()),
    });
  }
  // The clips are in place, so a planted foot slides backward at the speed the
  // body would travel. At each sample the lowest of the four foot joints
  // (ankles, toes) is taken as the contact, if it is within 3 cm of that
  // joint's lowest point; the median of its horizontal speed over those
  // samples is the clip's ground speed (robust to heel strike and toe-off).
  const dt = clip.duration / SAMPLES;
  const joints = ['l', 'r', 'tl', 'tr'] as const;
  const mins = joints.map((j) => Math.min(...pts.map((p) => p[j].y)));
  const speeds: number[] = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const a = pts[i - 1];
    const b = pts[i + 1];
    if (!p || !a || !b) continue;
    let best = -1;
    for (let j = 0; j < joints.length; j++) {
      const k = joints[j];
      if (k === undefined) continue;
      if (best < 0 || p[k].y < p[joints[best] ?? 'l'].y) best = j;
    }
    const k = joints[best];
    if (k === undefined || p[k].y - (mins[best] ?? 0) > 0.03) continue;
    speeds.push(Math.hypot(b[k].x - a[k].x, b[k].z - a[k].z) / (2 * dt));
  }
  speeds.sort((x, y) => x - y);
  const time = speeds.length >= 4 ? 1 : 0;
  const distance = speeds[Math.floor(speeds.length / 2)] ?? 0;
  if (time <= 0) return { speed: 0, cycleDistance: 0 };
  const speed = distance / time;
  return { speed, cycleDistance: speed * clip.duration };
}
