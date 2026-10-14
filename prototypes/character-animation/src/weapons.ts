/**
 * Weapons with authored sockets. Every weapon is normalised to one frame:
 * origin at the pistol grip, +Z toward the muzzle, +Y up. The hold code places
 * the weapon from the body (shoulder, aim direction) and the hands follow by
 * IK, so one hold serves weapons of different lengths and characters of
 * different proportions.
 */

import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import type { WeaponKind } from './sim';

export interface WeaponProfile {
  readonly kind: WeaponKind;
  readonly label: string;
  /** Socket positions in the weapon frame (metres). */
  readonly butt: THREE.Vector3;
  readonly support: THREE.Vector3;
  readonly muzzle: THREE.Vector3;
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

const M16_LENGTH = 1.0; // M16A2 overall length, about 1,006 mm

/** The CC0 "Assault Rifle West" (AR-15 pattern) scaled to an M16A2's length. */
export function makeRifle(source: THREE.Object3D): WeaponInstance {
  // SkeletonUtils.clone: the CC0 rifle is a skinned mesh (it has bones for its parts).
  const model = SkeletonUtils.clone(source);
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model, true);
  const size = box.getSize(new THREE.Vector3());
  // The model's barrel runs along Z with the muzzle at -Z (see the prototype
  // results document); turn it to +Z and scale to the M16A2's length.
  const scale = M16_LENGTH / size.z;
  const pivot = new THREE.Group();
  model.scale.multiplyScalar(scale);
  model.rotation.y = Math.PI;
  pivot.add(model);
  pivot.updateMatrixWorld(true);
  const b2 = new THREE.Box3().setFromObject(pivot, true);
  // Grip origin: 36% of the length from the butt, at the bore height.
  const butt = b2.min.z;
  const len = b2.max.z - b2.min.z;
  const gripZ = butt + 0.36 * len;
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
  const flash = makeFlash();
  flash.position.set(0, 0, len * 0.64 + 0.05);
  object.add(flash);
  return {
    profile: {
      kind: 'm16',
      label: 'M16A2 stand-in: "Assault Rifle West" (CC0), scaled to 1.0 m',
      butt: new THREE.Vector3(0, -0.02, -0.36 * len),
      support: new THREE.Vector3(0, -0.035, 0.21),
      muzzle: new THREE.Vector3(0, 0, len * 0.64),
      sightHeight: 0.075,
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
  const label = makeLabel('M249 PLACEHOLDER');
  label.position.set(0, 0.2, 0.1);
  g.add(label);
  const flash = makeFlash();
  flash.position.set(0, 0.05, 0.77);
  g.add(flash);
  return {
    profile: {
      kind: 'm249',
      label: 'M249 SAW PLACEHOLDER (boxes; no licensed model or clips)',
      butt: new THREE.Vector3(0, -0.02, -0.45),
      support: new THREE.Vector3(0, 0.0, 0.33),
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

function makeLabel(text: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 64;
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#c00';
    ctx.fillRect(0, 0, 512, 64);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 40px sans-serif';
    ctx.fillText(text, 12, 46);
  }
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }),
  );
  s.scale.set(0.5, 0.0625, 1);
  return s;
}
