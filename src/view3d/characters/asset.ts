import * as THREE from 'three';
import { type BoneKey, type ClipSlot, RIG_BONES, type RigId } from './rig';

// A soldier character: the model to clone and its clips (docs/character-animation.md).
// The clips are baked from the approved prototype (`clips.json`, written by
// prototypes/character-animation/tools/bake.mjs): retargeted library clips and
// the procedural prone and crawl, with their measured ground speeds.

export interface ClipMetrics {
  /** Ground speed implied by the planted foot (m/s); 0 for clips without stepping. */
  readonly speed: number;
  /** Distance covered by one loop of the clip (m). */
  readonly cycleDistance: number;
}

export interface ClipSource {
  readonly clip: THREE.AnimationClip;
  readonly origin: string;
  readonly metrics: ClipMetrics;
}

export interface CharacterAsset {
  readonly id: string;
  readonly rig: RigId;
  /** The model at its drawn scale; clone it with SkeletonUtils.clone for each soldier. */
  readonly template: THREE.Object3D;
  readonly clips: Partial<Record<ClipSlot, ClipSource>>;
  /**
   * Sights used for real (the model has eye bones): aiming puts the sight
   * line through the right eye and the head goes onto the stock.
   */
  readonly sighting: boolean;
}

/** The baked file (`public/characters/<id>/clips.json`). */
export interface BakedCharacter {
  readonly version: 1;
  readonly id: string;
  readonly licence: string;
  readonly scale: number;
  readonly skeleton: readonly {
    readonly name: string;
    readonly parent: string | null;
    readonly p: readonly number[];
    readonly q: readonly number[];
    readonly s: readonly number[];
  }[];
  readonly clips: Partial<
    Record<
      ClipSlot,
      {
        readonly duration: number;
        readonly speed: number;
        readonly cycleDistance: number;
        readonly origin: string;
        readonly tracks: readonly {
          readonly n: string;
          readonly t: readonly number[];
          readonly v: readonly number[];
        }[];
      }
    >
  >;
}

/** The baked clips as three.js clips. */
export function clipsFromBaked(baked: BakedCharacter): Partial<Record<ClipSlot, ClipSource>> {
  const out: Partial<Record<ClipSlot, ClipSource>> = {};
  for (const [slot, c] of Object.entries(baked.clips) as [
    ClipSlot,
    NonNullable<BakedCharacter['clips'][ClipSlot]>,
  ][]) {
    const tracks = c.tracks.map((t) =>
      t.n.endsWith('.quaternion')
        ? new THREE.QuaternionKeyframeTrack(t.n, [...t.t], [...t.v])
        : new THREE.VectorKeyframeTrack(t.n, [...t.t], [...t.v]),
    );
    out[slot] = {
      clip: new THREE.AnimationClip(slot, c.duration, tracks),
      origin: c.origin,
      metrics: { speed: c.speed, cycleDistance: c.cycleDistance },
    };
  }
  return out;
}

/**
 * The baked skeleton alone (bones in their rest pose, no mesh), at the
 * model's scale: a stand-in for the model where it cannot be loaded (node
 * tests). Bones carry the model's names, so the clips bind to it.
 */
export function skeletonFromBaked(baked: BakedCharacter): THREE.Object3D {
  const root = new THREE.Group();
  root.scale.setScalar(baked.scale);
  const bones = new Map<string, THREE.Bone>();
  for (const b of baked.skeleton) {
    const bone = new THREE.Bone();
    bone.name = b.name;
    bone.position.fromArray(b.p);
    bone.quaternion.fromArray(b.q);
    bone.scale.fromArray(b.s);
    bones.set(b.name, bone);
    const parent = b.parent ? bones.get(b.parent) : undefined;
    if (parent) parent.add(bone);
    else root.add(bone);
  }
  root.updateMatrixWorld(true);
  return root;
}

export function splitTrack(name: string): [string, string] {
  const i = name.lastIndexOf('.');
  return [name.slice(0, i), name.slice(i + 1)];
}

/** The bone of `key` in an instance (after SkeletonUtils.clone). */
export function boneOf(root: THREE.Object3D, rig: RigId, key: BoneKey): THREE.Bone | undefined {
  const name = RIG_BONES[rig][key];
  const o = name ? root.getObjectByName(name) : undefined;
  return o instanceof THREE.Bone ? o : undefined;
}
