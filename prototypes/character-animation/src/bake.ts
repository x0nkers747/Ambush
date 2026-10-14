/**
 * Bakes the approved soldier for the game (docs/character-animation.md): the
 * Rocketbox soldier's clips exactly as the prototype plays them (retargeted
 * library clips, the procedural prone and crawl) with their measured speeds,
 * and its skeleton's rest pose (for checking the baked clips against the
 * model, and for node tests). Run by `npm run bake` (tools/bake.mjs).
 */

import * as THREE from 'three';
import type { CharacterAsset } from './assets';
import type { ClipSlot } from './rigs';

/** The clip slots the game's animator uses. */
export const BAKED_SLOTS: readonly ClipSlot[] = [
  'idle',
  'walk',
  'walkBack',
  'walkLeft',
  'walkRight',
  'run',
  'sprint',
  'kneelIdle',
  'kneelWalk',
  'proneIdle',
  'crawl',
  'death',
];

export interface BakedTrack {
  /** `<bone>.quaternion` or `<bone>.position`. */
  readonly n: string;
  readonly t: number[];
  readonly v: number[];
}

export interface BakedClip {
  readonly duration: number;
  /** Ground speed implied by the clip (m/s) and metres per loop (clip-analysis.ts). */
  readonly speed: number;
  readonly cycleDistance: number;
  readonly origin: string;
  readonly tracks: BakedTrack[];
}

export interface BakedBone {
  readonly name: string;
  readonly parent: string | null;
  readonly p: number[];
  readonly q: number[];
  readonly s: number[];
}

export interface BakedCharacter {
  readonly version: 1;
  readonly id: string;
  readonly licence: string;
  /** The uniform scale the model is drawn at (about 1.8 m tall). */
  readonly scale: number;
  readonly skeleton: BakedBone[];
  readonly clips: Partial<Record<ClipSlot, BakedClip>>;
}

const round = (x: number, digits: number) => {
  const k = 10 ** digits;
  return Math.round(x * k) / k;
};

export function bakeCharacter(asset: CharacterAsset): BakedCharacter {
  const skeleton: BakedBone[] = [];
  asset.template.traverse((o) => {
    if (!(o instanceof THREE.Bone)) return;
    skeleton.push({
      name: o.name,
      parent: o.parent instanceof THREE.Bone ? o.parent.name : null,
      p: o.position.toArray().map((x) => round(x, 6)),
      q: o.quaternion.toArray().map((x) => round(x, 7)),
      s: o.scale.toArray().map((x) => round(x, 6)),
    });
  });
  const clips: Partial<Record<ClipSlot, BakedClip>> = {};
  for (const slot of BAKED_SLOTS) {
    const c = asset.clips[slot];
    if (!c) continue;
    clips[slot] = {
      duration: round(c.clip.duration, 6),
      speed: round(c.metrics.speed, 6),
      cycleDistance: round(c.metrics.cycleDistance, 6),
      origin: c.origin,
      tracks: c.clip.tracks.map((track) => ({
        n: track.name,
        t: Array.from(track.times, (x) => round(x, 5)),
        v: Array.from(track.values, (x) => round(x, track.name.endsWith('.position') ? 5 : 6)),
      })),
    };
  }
  return {
    version: 1,
    id: asset.id,
    licence: asset.licence,
    scale: asset.scale,
    skeleton,
    clips,
  };
}
