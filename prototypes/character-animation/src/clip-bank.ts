/**
 * Upper/lower-body variants of a character's clips. three.js has no bone
 * masks, so layers are made by track filtering: the "upper" copy keeps the
 * tracks of spine1 and its descendants (spine, arms, head), the "lower" copy
 * keeps everything else (hips, legs, root height). Built once per character.
 */

import * as THREE from 'three';
import { type CharacterAsset, splitTrack } from './assets';
import { type ClipSlot, RIG_BONES, UPPER_BODY_ROOT } from './rigs';

export interface ClipVariants {
  readonly full: THREE.AnimationClip;
  readonly upper: THREE.AnimationClip;
  readonly lower: THREE.AnimationClip;
  /** A second upper-body copy, so a clip can play on two layers at different times. */
  readonly overlay: THREE.AnimationClip;
  readonly duration: number;
}

const cache = new WeakMap<CharacterAsset, Map<ClipSlot, ClipVariants>>();

/**
 * The spine and everything above it, minus the legs: a 3ds Max Biped
 * (Rocketbox) parents the thighs to the first spine bone, so "the spine's
 * subtree" would include the legs. Masks are defined on canonical bones,
 * never by hierarchy alone.
 */
export function upperBodyBones(asset: CharacterAsset): Set<string> {
  const names = RIG_BONES[asset.rig];
  const rootName = names[UPPER_BODY_ROOT];
  const set = new Set<string>();
  const root = rootName ? asset.template.getObjectByName(rootName) : undefined;
  root?.traverse((o) => set.add(o.name));
  for (const leg of [names.upperLegL, names.upperLegR]) {
    const l = leg ? asset.template.getObjectByName(leg) : undefined;
    l?.traverse((o) => set.delete(o.name));
  }
  return set;
}

export function clipVariants(asset: CharacterAsset): Map<ClipSlot, ClipVariants> {
  const hit = cache.get(asset);
  if (hit) return hit;
  const upperSet = upperBodyBones(asset);
  const out = new Map<ClipSlot, ClipVariants>();
  for (const [slot, src] of Object.entries(asset.clips) as [
    ClipSlot,
    { clip: THREE.AnimationClip },
  ][]) {
    const c = src.clip;
    const isUpper = (t: THREE.KeyframeTrack) => upperSet.has(splitTrack(t.name)[0]);
    const upper = new THREE.AnimationClip(`${slot}:upper`, c.duration, c.tracks.filter(isUpper));
    out.set(slot, {
      full: c,
      upper,
      overlay: Object.assign(upper.clone(), { name: `${slot}:overlay` }),
      lower: new THREE.AnimationClip(
        `${slot}:lower`,
        c.duration,
        c.tracks.filter((t) => !isUpper(t)),
      ),
      duration: c.duration,
    });
  }
  cache.set(asset, out);
  return out;
}
