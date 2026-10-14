/**
 * A rifleman's prone position and low crawl for the Rocketbox soldier, built
 * from its own skeleton (no openly licensed prone-with-rifle clip exists: the
 * KayKit "Lie_Idle" lies on its side and the crawl clip keeps the face down).
 *
 * Prone: on the stomach, the body angled off the line of fire (left shoulder
 * forward, as riflemen lie, so the head comes over the stock), legs back and
 * apart with the feet turned out, chest raised on the elbows, head up and
 * tipped onto the stock, looking along the rifle. Crawl: the same, drawing
 * each knee up in turn. The arms are only a starting pose: the weapon hold
 * and arm IK place the hands.
 *
 * Each pose is set bone by bone in world terms on a clone of the character
 * (facing +Z, up +Y, its right toward −X), then read back as clip keys, so
 * the poses play through the same mixer as every other clip.
 */

import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import type { ClipSource } from './assets';
import { rotateWorld, setWorldQuaternion, twoBoneIK } from './ik';
import { type BoneKey, RIG_BONES, type RigId } from './rigs';

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const deg = (d: number) => (d * Math.PI) / 180;

/** The body's angle off the line of fire, toward the right (degrees). */
const BODY_YAW = 30;
/** Chest raise, spread over the three spine bones (degrees): the chest
 * stays on the ground, the elbows propping the shoulders a little. */
const SPINE_RAISE = [2, 3, 4];
/** The face looks slightly down along the sights (degrees). */
const LOOK_DOWN = 8;
/** The head tips right onto the stock (degrees). */
const CHEEK = 16;
/** Leg bones' heights when the legs lie on the ground (m): the knee joint
 * (the kneecap on the ground) and the ankle (the foot on its inner edge),
 * which gives the knee a slight bend. */
const KNEE_HEIGHT = 0.055;
const ANKLE_HEIGHT = 0.12;
/** Low crawl: one cycle (two knee draws), its distance and duration. */
const CRAWL_SPEED = 0.35;
const CRAWL_SECONDS = 1.8;

/** Turns `bone` so the direction to `child` points along `want` (world). */
function pointBone(bone: THREE.Object3D, child: THREE.Object3D, want: THREE.Vector3): void {
  bone.updateMatrixWorld(true);
  const from = child
    .getWorldPosition(new THREE.Vector3())
    .sub(bone.getWorldPosition(new THREE.Vector3()))
    .normalize();
  rotateWorld(bone, new THREE.Quaternion().setFromUnitVectors(from, want.clone().normalize()));
}

/**
 * The lowest point of the skinned body, leaving out the vertices that follow
 * `exclude`'s bones (the arms: they are posed later, by the weapon hold).
 */
function lowestPoint(root: THREE.Object3D, exclude: Set<THREE.Object3D>): number {
  let min = Infinity;
  const v = new THREE.Vector3();
  root.traverse((o) => {
    if (!(o instanceof THREE.SkinnedMesh)) return;
    const mesh = o as THREE.SkinnedMesh;
    const index = mesh.geometry.getAttribute('skinIndex');
    const weight = mesh.geometry.getAttribute('skinWeight');
    const count = mesh.geometry.getAttribute('position').count;
    for (let i = 0; i < count; i++) {
      // The vertex's main bone.
      let best = 0;
      for (let j = 1; j < 4; j++)
        if (weight.getComponent(i, j) > weight.getComponent(i, best)) best = j;
      const bone = mesh.skeleton.bones[index.getComponent(i, best)];
      if (bone && exclude.has(bone)) continue;
      mesh.getVertexPosition(i, v);
      v.applyMatrix4(mesh.matrixWorld);
      if (v.y < min) min = v.y;
    }
  });
  return Number.isFinite(min) ? min : 0;
}

interface Pose {
  readonly rotations: Map<string, THREE.Quaternion>;
  readonly hips: THREE.Vector3;
  readonly hipsName: string;
}

/**
 * The prone pose with each knee drawn up by `draw.L` / `draw.R` (0 = leg
 * straight back, 1 = thigh out to the side and knee bent: the low crawl).
 */
function pose(template: THREE.Object3D, rig: RigId, draw: { L: number; R: number }): Pose | null {
  const root = SkeletonUtils.clone(template);
  root.position.set(0, 0, 0);
  root.quaternion.identity();
  root.updateMatrixWorld(true);
  const b = (k: BoneKey): THREE.Bone | undefined => {
    const name = RIG_BONES[rig][k];
    const o = name ? root.getObjectByName(name) : undefined;
    return o instanceof THREE.Bone ? o : undefined;
  };
  const hips = b('hips');
  const head = b('head');
  if (!hips || !head) return null;

  // The face's direction in the head bone's frame (the rest pose faces +Z).
  const faceLocal = Z.clone().applyQuaternion(
    head.getWorldQuaternion(new THREE.Quaternion()).invert(),
  );
  // The body frame: turned BODY_YAW to the right of the line of fire.
  const yaw = new THREE.Quaternion().setFromAxisAngle(Y, -deg(BODY_YAW));
  const body = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyQuaternion(yaw);
  const lateral = X.clone().applyQuaternion(yaw);

  // 1. Face down: the body's up turns to forward, its front to down.
  const down = yaw.clone().multiply(new THREE.Quaternion().setFromAxisAngle(X, Math.PI / 2));
  setWorldQuaternion(hips, down.multiply(hips.getWorldQuaternion(new THREE.Quaternion())));

  // 2. Chest up on the elbows: pitch the spine back (head end up).
  [b('spine1'), b('spine2'), b('spine3')].forEach((sp, i) => {
    if (sp)
      rotateWorld(sp, new THREE.Quaternion().setFromAxisAngle(lateral, -deg(SPINE_RAISE[i] ?? 0)));
  });

  // 3. Legs back and apart, feet turned out (inner edges down); a drawn leg
  //    goes out to the side with the knee bent. `onGround`: slope the thigh
  //    down to put the knee on the ground and the shin from there to the
  //    ankle (false: a first guess, before the body is put on the ground).
  const legs = (onGround: boolean) => {
    for (const [side, out] of [
      ['L', 1],
      ['R', -1],
    ] as const) {
      const thigh = b(side === 'L' ? 'upperLegL' : 'upperLegR');
      const calf = b(side === 'L' ? 'lowerLegL' : 'lowerLegR');
      const foot = b(side === 'L' ? 'footL' : 'footR');
      const toes = b(side === 'L' ? 'toesL' : 'toesR');
      if (!thigh || !calf || !foot) continue;
      const d = draw[side];
      const lerp = (a: THREE.Vector3, c: THREE.Vector3) => a.clone().lerp(c, d);
      const thighDir = lerp(body(0.22 * out, 0, -1), body(0.95 * out, 0, -0.35)).normalize();
      const calfDir = lerp(body(0.24 * out, 0, -1), body(0.35 * out, 0, -1)).normalize();
      root.updateMatrixWorld(true);
      const at = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());
      const thighLen = at(thigh).distanceTo(at(calf));
      const shinLen = at(calf).distanceTo(at(foot));
      const slope = (v: THREE.Vector3, sin: number) => {
        const s = Math.max(-0.6, Math.min(0.6, sin));
        return v.multiplyScalar(Math.sqrt(1 - s * s)).setY(s);
      };
      const hipY = at(thigh).y;
      pointBone(thigh, calf, slope(thighDir, onGround ? (KNEE_HEIGHT - hipY) / thighLen : -0.1));
      pointBone(
        calf,
        foot,
        slope(calfDir, onGround ? (ANKLE_HEIGHT - at(calf).y) / shinLen : -0.1),
      );
      if (toes)
        pointBone(foot, toes, lerp(body(0.8 * out, -0.3, -0.5), body(0.75 * out, -0.4, -0.5)));
    }
  };
  legs(false);

  // 4. On the ground: the lowest point of the body (arms aside) at y = 0, the
  //    right shoulder (the rifle's butt) over the soldier's position.
  root.updateMatrixWorld(true);
  const arms = new Set<THREE.Object3D>();
  for (const k of ['upperArmL', 'upperArmR'] as const) b(k)?.traverse((o) => arms.add(o));
  const hp = hips.getWorldPosition(new THREE.Vector3());
  hp.y -= lowestPoint(root, arms);
  const shoulder = b('upperArmR')?.getWorldPosition(new THREE.Vector3());
  if (shoulder) {
    hp.x -= shoulder.x;
    hp.z -= shoulder.z;
  }
  hips.position.copy(hips.parent ? hips.parent.worldToLocal(hp.clone()) : hp);
  root.updateMatrixWorld(true);
  // The body rests on its front (the vest); the knees on the ground.
  legs(true);

  // 5. Head up: neck and head share the turn that brings the face level
  //    with the rifle, then the head tips onto the stock.
  const neck = b('neck');
  const want = new THREE.Vector3(0, -Math.sin(deg(LOOK_DOWN)), Math.cos(deg(LOOK_DOWN)));
  const faceNow = () =>
    faceLocal.clone().applyQuaternion(head.getWorldQuaternion(new THREE.Quaternion())).normalize();
  const turn = new THREE.Quaternion().setFromUnitVectors(faceNow(), want);
  if (neck) rotateWorld(neck, new THREE.Quaternion().slerp(turn, 0.55));
  rotateWorld(head, new THREE.Quaternion().setFromUnitVectors(faceNow(), want));
  rotateWorld(head, new THREE.Quaternion().setFromAxisAngle(want, deg(CHEEK)));

  // 6. Arms: elbows on the ground ahead of the shoulders, hands forward
  //    toward where the rifle will be.
  for (const [side, out, reach] of [
    ['R', -1, 0.28],
    ['L', 1, 0.48],
  ] as const) {
    const up = b(side === 'L' ? 'upperArmL' : 'upperArmR');
    const lo = b(side === 'L' ? 'lowerArmL' : 'lowerArmR');
    const hand = b(side === 'L' ? 'handL' : 'handR');
    if (!up || !lo || !hand) continue;
    const sh = up.getWorldPosition(new THREE.Vector3());
    const target = new THREE.Vector3(sh.x - out * 0.12, Math.max(0.12, sh.y - 0.12), sh.z + reach);
    const pole = new THREE.Vector3(sh.x + out * 0.25, -0.5, sh.z + 0.1);
    twoBoneIK(up, lo, hand, target, pole);
  }

  const rotations = new Map<string, THREE.Quaternion>();
  root.traverse((o) => {
    if (o instanceof THREE.Bone) rotations.set(o.name, o.quaternion.clone());
  });
  return { rotations, hips: hips.position.clone(), hipsName: hips.name };
}

/** Keyed poses as a clip: every bone's rotation and the hips' position. */
function clipOf(name: string, keys: readonly [number, Pose][], duration: number) {
  const times = keys.map(([t]) => t);
  const first = keys[0]?.[1];
  if (!first) return new THREE.AnimationClip(name, duration, []);
  const tracks: THREE.KeyframeTrack[] = [...first.rotations.keys()].map(
    (bone) =>
      new THREE.QuaternionKeyframeTrack(
        `${bone}.quaternion`,
        times,
        keys.flatMap(([, p]) => p.rotations.get(bone)?.toArray() ?? [0, 0, 0, 1]),
      ),
  );
  tracks.push(
    new THREE.VectorKeyframeTrack(
      `${first.hipsName}.position`,
      times,
      keys.flatMap(([, p]) => p.hips.toArray()),
    ),
  );
  return new THREE.AnimationClip(name, duration, tracks);
}

/** The prone idle (aiming) pose and the low crawl, as clip slots. */
export function makeProneClips(
  template: THREE.Object3D,
  rig: RigId,
): { proneIdle: ClipSource; crawl: ClipSource } | null {
  const still = pose(template, rig, { L: 0, R: 0 });
  const left = pose(template, rig, { L: 1, R: 0 });
  const right = pose(template, rig, { L: 0, R: 1 });
  if (!still || !left || !right) return null;
  const c = CRAWL_SECONDS;
  return {
    proneIdle: {
      clip: clipOf(
        'proneIdle',
        [
          [0, still],
          [1, still],
        ],
        1,
      ),
      origin: 'procedural prone pose (prone.ts)',
      retargeted: false,
      metrics: { speed: 0, cycleDistance: 0 },
    },
    crawl: {
      clip: clipOf(
        'crawl',
        [
          [0, still],
          [c * 0.25, left],
          [c * 0.5, still],
          [c * 0.75, right],
          [c, still],
        ],
        c,
      ),
      origin: 'procedural low crawl (prone.ts)',
      retargeted: false,
      metrics: { speed: CRAWL_SPEED, cycleDistance: CRAWL_SPEED * c },
    },
  };
}
