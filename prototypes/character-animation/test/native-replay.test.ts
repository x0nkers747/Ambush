/**
 * The native runtime's replay property on a synthetic rig, in node: the pose
 * at a time is the same whether reached in order, backward, shuffled or
 * repeatedly — including when post-processing edits mixer-driven bones after
 * every update (the three.js PropertyMixer write-skipping case).
 */

import * as THREE from 'three';
import { expect, test } from 'vitest';
import type { CharacterAsset, ClipSource } from '../src/assets';
import { createSoldier, placeSoldier, type SoldierView } from '../src/character';
import { rotateWorld } from '../src/ik';
import { poseInputAt } from '../src/pose-input';
import { CLIP_SLOTS, type ClipSlot, RIG_BONES } from '../src/rigs';
import { nativeRuntime } from '../src/runtimes/native';
import { recordTestSequence } from '../src/sim';

const N = RIG_BONES.m2m;

function syntheticAsset(): CharacterAsset {
  const bone = (name: string | undefined, parent: THREE.Object3D | null, y: number, x = 0) => {
    const b = new THREE.Bone();
    b.name = name ?? '';
    b.position.set(x, y, 0);
    parent?.add(b);
    return b;
  };
  const pelvis = bone(N.hips, null, 1);
  const s1 = bone(N.spine1, pelvis, 0.12);
  const s2 = bone(N.spine2, s1, 0.12);
  const s3 = bone(N.spine3, s2, 0.12);
  bone(N.head, bone(N.neck, s3, 0.15), 0.1);
  const arm = (side: 'L' | 'R', sx: number) => {
    const clav = bone(side === 'L' ? N.shoulderL : N.shoulderR, s3, 0.1, 0.05 * sx);
    const up = bone(side === 'L' ? N.upperArmL : N.upperArmR, clav, 0, 0.15 * sx);
    const lo = bone(side === 'L' ? N.lowerArmL : N.lowerArmR, up, 0, 0.28 * sx);
    bone(side === 'L' ? N.handL : N.handR, lo, 0, 0.26 * sx);
  };
  arm('L', 1);
  arm('R', -1);
  const leg = (side: 'L' | 'R', sx: number) => {
    const th = bone(side === 'L' ? N.upperLegL : N.upperLegR, pelvis, -0.05, 0.09 * sx);
    const ca = bone(side === 'L' ? N.lowerLegL : N.lowerLegR, th, -0.42);
    const ft = bone(side === 'L' ? N.footL : N.footR, ca, -0.42);
    bone(side === 'L' ? N.toesL : N.toesR, ft, -0.08);
  };
  leg('L', 1);
  leg('R', -1);
  const bones: THREE.Bone[] = [];
  pelvis.traverse((o) => {
    if (o instanceof THREE.Bone) bones.push(o as THREE.Bone);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 1, 0, 0.1, 1, 0, 0, 1.1, 0], 3),
  );
  geo.setAttribute(
    'skinIndex',
    new THREE.Uint16BufferAttribute([0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0], 4),
  );
  geo.setAttribute(
    'skinWeight',
    new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4),
  );
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshBasicMaterial());
  const template = new THREE.Group();
  template.add(pelvis, mesh);
  mesh.bind(new THREE.Skeleton(bones));

  // Deterministic synthetic clips: every bone swings with its own frequency.
  const clips: Partial<Record<ClipSlot, ClipSource>> = {};
  CLIP_SLOTS.forEach((slot, si) => {
    const duration = 0.8 + (si % 5) * 0.3;
    const times = Array.from({ length: 31 }, (_, i) => (duration * i) / 30);
    const tracks: THREE.KeyframeTrack[] = bones.map((b, bi) => {
      const q = new THREE.Quaternion();
      const values = times.flatMap((t) => {
        q.setFromEuler(
          new THREE.Euler(0.4 * Math.sin(t * 6 + bi + si), 0.2 * Math.cos(t * 4 + bi), 0),
        );
        return [q.x, q.y, q.z, q.w];
      });
      return new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, values);
    });
    tracks.push(
      new THREE.VectorKeyframeTrack(
        `${pelvis.name}.position`,
        times,
        times.flatMap((t) => [0, 1 + 0.03 * Math.sin(t * 8 + si), 0]),
      ),
    );
    const speed =
      { walk: 1.4, run: 3.5, sprint: 5.8, kneelWalk: 1, crawl: 0.35 }[slot as string] ?? 1.1;
    clips[slot] = {
      clip: new THREE.AnimationClip(slot, duration, tracks),
      origin: 'synthetic',
      retargeted: false,
      metrics: { speed, cycleDistance: speed * duration },
    };
  });
  return {
    id: 'mannequin',
    label: 'synthetic',
    rig: 'm2m',
    template,
    scale: 1,
    clips,
    triangles: 1,
    boneCount: bones.length,
    licence: 'test',
  };
}

const frames = recordTestSequence();
const asset = syntheticAsset();

function capture(s: SoldierView): number[] {
  return s.allBones.flatMap((b) => [...b.quaternion.toArray(), ...b.position.toArray()]);
}

function poseAt(s: SoldierView, a: ReturnType<typeof nativeRuntime.create>, t: number): number[] {
  const input = poseInputAt(frames, t);
  placeSoldier(s, input, 0);
  a.update(input, { dt: 0, seeked: true, frames });
  // Post-processing that edits a mixer-driven bone (like IK or spine aim).
  const spine = s.bones.spine2;
  if (spine)
    rotateWorld(spine, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.3));
  return capture(s);
}

const TIMES = [0.5, 4.2, 9.1, 14.4, 19.37, 22.5, 24.9, 28, 31, 36.2, 39, 43.4];

test('pose is identical in any order of evaluation, with post-processing', () => {
  const s1 = createSoldier(asset);
  const a1 = nativeRuntime.create(s1, frames);
  const ref = new Map(TIMES.map((t) => [t, poseAt(s1, a1, t)]));

  const s2 = createSoldier(asset);
  const a2 = nativeRuntime.create(s2, frames);
  for (const t of [...TIMES].reverse()) expect(poseAt(s2, a2, t)).toEqual(ref.get(t));

  const s3 = createSoldier(asset);
  const a3 = nativeRuntime.create(s3, frames);
  for (const t of [28, 0.5, 43.4, 9.1, 9.1, 22.5, 4.2])
    expect(poseAt(s3, a3, t)).toEqual(ref.get(t));
});

test('continuous playback at any frame rate lands on the same poses', () => {
  const s = createSoldier(asset);
  const a = nativeRuntime.create(s, frames);
  const ref = poseAt(s, a, 19.37);
  for (const hz of [24, 60, 144]) {
    const sc = createSoldier(asset);
    const ac = nativeRuntime.create(sc, frames);
    for (let t = 15; t < 19.37; t += 1 / hz) poseAt(sc, ac, t);
    expect(poseAt(sc, ac, 19.37)).toEqual(ref);
  }
});
