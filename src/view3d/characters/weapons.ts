/**
 * Weapons with authored sockets. Every weapon is normalised to one frame:
 * origin at the pistol grip, +Z toward the muzzle, +Y up. The hold code places
 * the weapon from the body (shoulder, aim direction) and the hands follow by
 * IK, so one hold serves weapons of different lengths and characters of
 * different proportions.
 */

import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import type { Grasp } from './hands';

/** The weapons drawn: the M16A2, the M249 SAW and OPFOR's AK-pattern rifle. */
export type WeaponKind = 'm16' | 'm249' | 'ak';

export interface WeaponProfile {
  readonly kind: WeaponKind;
  readonly label: string;
  /** Socket positions in the weapon frame (metres). */
  readonly butt: THREE.Vector3;
  /** The firing hand on the pistol grip, and the support hand on the handguard. */
  readonly grip: Grasp;
  readonly support: Grasp;
  readonly muzzle: THREE.Vector3;
  /** Where the aiming eye goes: on the sight line, behind the rear sight. */
  readonly eye: THREE.Vector3;
  /** Height of the sight line above the grip origin. */
  readonly sightHeight: number;
  /** Recoil impulse: kick back (m) and muzzle rise (rad). */
  readonly kick: number;
  readonly rise: number;
  readonly placeholder: boolean;
}

export interface WeaponInstance {
  readonly profile: WeaponProfile;
  readonly object: THREE.Object3D;
  readonly flash: THREE.Object3D;
}

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/**
 * The firing hand around a pistol grip raked back 12°: palm on the grip's
 * right side, knuckles along the grip, middle, ring and little fingers
 * wrapped round its front, index finger on the trigger, thumb over the left.
 */
function pistolGrip(point: THREE.Vector3): Grasp {
  return {
    point,
    forward: v(0, -0.2, 0.98),
    palm: v(1, 0, 0),
    at: [0.66, 0.3, -0.12],
    curl: {
      thumb: [0.35, 0.35, 0.25],
      index: [0.35, 0.75, 0.35],
      middle: [1.25, 1.35, 0.7],
      ring: [1.3, 1.35, 0.7],
      pinky: [1.35, 1.3, 0.7],
    },
    thumbOppose: 0.5,
  };
}

/**
 * The support hand under a handguard: palm up, fingers forward and to the
 * right wrapping its right side, thumb along the left. `depth`: from the
 * hand bone's axis to the handguard's centre, in hand lengths (half the
 * palm's thickness plus the handguard's half-height).
 */
function handguard(point: THREE.Vector3, depth: number): Grasp {
  return {
    point,
    forward: v(-0.75, 0, 0.66),
    palm: v(0, 1, 0),
    at: [0.6, depth, 0],
    curl: {
      thumb: [0.2, 0.2, 0.15],
      index: [0.55, 0.6, 0.35],
      middle: [0.65, 0.65, 0.35],
      ring: [0.7, 0.65, 0.35],
      pinky: [0.75, 0.65, 0.35],
    },
    thumbOppose: 0.2,
  };
}

/** How a rifle model is turned and scaled into the weapon frame, and its sockets there. */
interface RifleModel {
  readonly label: string;
  /** Overall length (m). */
  readonly length: number;
  /** Turn about +Y that brings the model's muzzle to +Z. */
  readonly turn: number;
  /** Sockets, in metres of the scaled model (`len`: its length). */
  readonly sockets: (
    len: number,
  ) => Pick<WeaponProfile, 'butt' | 'grip' | 'support' | 'eye' | 'muzzle' | 'sightHeight'>;
}

const RIFLES: Record<'m16' | 'ak', RifleModel> = {
  // "Assault Rifle West" (AR-15 pattern): muzzle at −Z; the M16A2 is about 1,006 mm.
  m16: {
    label: 'M16A2 stand-in: "Assault Rifle West" (CC0), scaled to 1.0 m',
    length: 1.0,
    turn: Math.PI,
    sockets: (len) => ({
      butt: v(0, -0.02, -0.36 * len),
      // Measured on the model (side view): pistol grip 7.5 cm below the
      // origin, handguard from 26 to 55 cm, 2 to 10 cm above it.
      grip: pistolGrip(v(0, -0.075 * len, -0.016 * len)),
      support: handguard(v(0, 0.058 * len, 0.3 * len), 0.57),
      // Sight line 13 cm above the origin (rear sight at the receiver's
      // rear); the eye 9 cm behind the rear sight.
      eye: v(0, 0.13 * len, -0.09 * len),
      muzzle: v(0, 0, len * 0.64),
      sightHeight: 0.075,
    }),
  },
  // "Assault Rifle" by Zsky (an AK-47, CC BY 3.0): muzzle at −Z; the AK-47
  // is about 880 mm.
  ak: {
    label: 'AK-47: "Assault Rifle" by Zsky (CC BY 3.0), scaled to 0.88 m',
    length: 0.88,
    turn: Math.PI,
    // Measured on the model (side view, scaled to 0.88 m): pistol grip
    // centred 7 cm behind the origin and 6 cm below it, lower handguard 19
    // to 35 cm ahead, centred 5.5 cm up, sight line (rear sight mid-gun,
    // front post at the muzzle) 10.5 cm up, stock butt at −33.5 cm, muzzle
    // at 58.5 cm, 4 cm up. The eye sits on the sight line over the stock.
    sockets: () => ({
      butt: v(0, -0.02, -0.335),
      grip: pistolGrip(v(0, -0.06, -0.07)),
      support: handguard(v(0, 0.055, 0.27), 0.57),
      eye: v(0, 0.105, -0.16),
      muzzle: v(0, 0.04, 0.585),
      sightHeight: 0.105,
    }),
  },
};

/**
 * A rifle model in the weapon frame at its real length: the CC0 "Assault
 * Rifle West" (AR-15 pattern) for the M16A2, the CC0 AK for OPFOR's
 * AK-pattern rifle.
 */
export function makeRifle(source: THREE.Object3D, kind: 'm16' | 'ak' = 'm16'): WeaponInstance {
  const spec = RIFLES[kind];
  // SkeletonUtils.clone: the CC0 rifle is a skinned mesh (it has bones for its parts).
  const model = SkeletonUtils.clone(source);
  const pivot = new THREE.Group();
  model.rotation.y = spec.turn;
  pivot.add(model);
  pivot.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(pivot, true);
  model.scale.multiplyScalar(spec.length / (box.max.z - box.min.z));
  pivot.updateMatrixWorld(true);
  const b2 = new THREE.Box3().setFromObject(pivot, true);
  // Origin: 36% of the length from the butt, at 62% of the height (near the bore).
  const len = b2.max.z - b2.min.z;
  const gripZ = b2.min.z + 0.36 * len;
  const boreY = b2.min.y + (b2.max.y - b2.min.y) * 0.62;
  model.position.set(-(b2.min.x + b2.max.x) / 2, -boreY, -gripZ);
  model.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = true;
      o.frustumCulled = false;
    }
  });
  const object = new THREE.Group();
  object.add(pivot);
  const sockets = spec.sockets(len);
  const flash = makeFlash();
  flash.position.copy(sockets.muzzle).add(v(0, 0, 0.05));
  object.add(flash);
  return {
    profile: {
      kind,
      label: spec.label,
      ...sockets,
      kick: 0.025,
      rise: 0.045,
      placeholder: false,
    },
    object,
    flash,
  };
}

/**
 * An M249 SAW PLACEHOLDER built from boxes (no openly licensed M249 model or
 * M249 animation was found): receiver, heavy barrel, box magazine, folded
 * bipod, stock. Its sockets differ from the rifle's (support hand further
 * back on the receiver top / handguard, heavier recoil).
 */
export function makeSawPlaceholder(): WeaponInstance {
  const mat = new THREE.MeshStandardMaterial({ color: 0x2b2d2a, roughness: 0.6, metalness: 0.4 });
  const box = new THREE.MeshStandardMaterial({ color: 0x4a4f36, roughness: 0.8 });
  const g = new THREE.Group();
  const part = (w: number, h: number, d: number, x: number, y: number, z: number, m = mat) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    g.add(mesh);
  };
  part(0.07, 0.11, 0.42, 0, 0.02, 0.08); // receiver
  part(0.06, 0.06, 0.24, 0, 0.04, 0.38); // handguard
  part(0.03, 0.03, 0.24, 0, 0.05, 0.6); // barrel
  part(0.11, 0.13, 0.12, -0.07, -0.08, 0.1, box); // 200-round box
  part(0.06, 0.09, 0.3, 0, -0.01, -0.3); // stock
  part(0.03, 0.09, 0.03, 0, -0.07, 0.0); // pistol grip
  part(0.015, 0.015, 0.22, 0.03, 0.0, 0.58); // bipod leg (folded)
  part(0.015, 0.015, 0.22, -0.03, 0.0, 0.58);
  part(0.05, 0.03, 0.06, 0, 0.1, 0.12); // carry handle
  const flash = makeFlash();
  flash.position.set(0, 0.05, 0.77);
  g.add(flash);
  return {
    profile: {
      kind: 'm249',
      label: 'M249 SAW PLACEHOLDER (boxes; no licensed model or clips)',
      butt: new THREE.Vector3(0, -0.02, -0.45),
      grip: pistolGrip(v(0, -0.075, 0)),
      support: handguard(v(0, 0.04, 0.33), 0.46),
      eye: v(0, 0.14, -0.12),
      muzzle: new THREE.Vector3(0, 0.05, 0.75),
      sightHeight: 0.11,
      kick: 0.018,
      rise: 0.025,
      placeholder: true,
    },
    object: g,
    flash,
  };
}

function makeFlash(): THREE.Object3D {
  const m = new THREE.MeshBasicMaterial({
    color: 0xffd27a,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const g = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.16), m);
    p.rotation.z = (i * Math.PI) / 3;
    p.rotation.y = i === 2 ? Math.PI / 2 : 0;
    g.add(p);
  }
  g.visible = false;
  return g;
}
