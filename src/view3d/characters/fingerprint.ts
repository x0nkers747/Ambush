import type { Puppet } from './puppet';

// A posed soldier as numbers (docs/character-animation.md), for checking
// that a pose is reconstructed exactly: the root, every bone, the weapon,
// and the animator's clips, weights and times.

export interface PoseFingerprint {
  /** Root position and rotation, every bone's local rotation and position, the weapon's world matrix. */
  readonly numbers: Float64Array;
  /** The discrete part: posture, carry, clips playing (weights and times are in `numbers`). */
  readonly state: string;
}

export function fingerprint(p: Puppet): PoseFingerprint {
  const v = p.view;
  const out: number[] = [...v.root.position.toArray(), ...v.root.quaternion.toArray()];
  for (const b of v.allBones) out.push(...b.quaternion.toArray(), ...b.position.toArray());
  const w = v.weapon;
  if (w) out.push(...w.object.matrixWorld.elements, w.flash.visible ? 1 : 0);
  const state = p.animationState();
  const keys = Object.keys(state).sort();
  for (const k of keys) out.push(...(state[k] ?? [0, 0]));
  const i = p.input;
  return {
    numbers: Float64Array.from(out),
    state: JSON.stringify([
      i?.posture,
      i?.postureFrom,
      i?.carry,
      i?.carryFrom,
      i?.sinceDown !== undefined && i.sinceDown >= 0,
      keys,
    ]),
  };
}

/** The largest absolute difference between two fingerprints' numbers (Infinity if they differ in shape). */
export function fingerprintDistance(a: PoseFingerprint, b: PoseFingerprint): number {
  if (a.state !== b.state || a.numbers.length !== b.numbers.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.numbers.length; i += 1)
    d = Math.max(d, Math.abs((a.numbers[i] ?? 0) - (b.numbers[i] ?? 0)));
  return d;
}
