import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { type BakedCharacter, type CharacterAsset, clipsFromBaked } from './asset';

// Loading the soldier (docs/character-animation.md): the Microsoft Rocketbox
// "Military_Male_01" (MIT) exactly as the approved prototype loads it (its
// FBX, its four colour and normal maps as standard materials, about 1.8 m
// tall), the baked clips, and the weapon models. Loaded once and shared by
// every soldier: clones share geometry, materials and textures.

export interface SoldierAssets {
  readonly soldier: CharacterAsset;
  /**
   * The rifle models: "Assault Rifle West" by Pichuliru (CC0, the M16A2
   * stand-in) and "Assault Rifle" by Zsky (CC BY 3.0, the AK-47).
   */
  readonly rifle: THREE.Object3D;
  readonly ak: THREE.Object3D;
  /** Materials by side: OPFOR's uniform is tinted (`opforMaterials`). */
  readonly materials: { readonly friendly: Materials; readonly enemy: Materials };
  readonly loadMs: number;
}

/** The model's materials by name (body, head, helmet, equipment). */
export type Materials = ReadonlyMap<string, THREE.Material>;

/** The model's height (m). */
const HEIGHT_M = 1.8;

const PARTS: Record<string, [string, string]> = {
  sm002_body: ['sm002_body_color_acu.jpg', 'sm002_body_normal.jpg'],
  sm002_head: ['sm002_head_color.jpg', 'sm002_head_normal.jpg'],
  sm002_helmet: ['sm002_helmet_color_acu.jpg', 'sm002_helmet_normal.jpg'],
  sm002_equipment: ['sm002_equipment_color_acu.jpg', 'sm002_equipment_normal.jpg'],
};

/**
 * OPFOR wear the same model in a different uniform: the camouflage and the
 * helmet cover tinted a warm khaki over the ACU pattern (the face and skin
 * stay as they are). A uniform, not a marker: blue and red stay on the
 * tactical indicators.
 */
const OPFOR_TINT: Record<string, number> = {
  sm002_body: 0xc9ad84,
  sm002_helmet: 0xc4a77c,
  sm002_equipment: 0xb39a74,
};

/**
 * Removes the lights and cameras a model file brings with it. The FBX loader
 * adds an ambient light for the file's ambient colour (the soldier's has one);
 * cloned into every soldier, and shown only with the soldiers close up, they
 * lit the whole scene more the closer the camera came. Returns how many it removed.
 */
export function stripLightsAndCameras(root: THREE.Object3D): number {
  const found: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (o !== root && ((o as THREE.Light).isLight || (o as THREE.Camera).isCamera)) found.push(o);
  });
  for (const o of found) o.removeFromParent();
  return found.length;
}

/** Loads everything from `base` (the folder holding `rocketbox/` and `weapons/`). */
export async function loadSoldierAssets(base: string): Promise<SoldierAssets> {
  const t0 = performance.now();
  const url = (path: string) => new URL(path, base).href;
  const textures = new THREE.TextureLoader();
  const texture = (f: string, srgb: boolean) => {
    const t = textures.load(url(`rocketbox/${f}`));
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 4;
    return t;
  };
  const gltf = new GLTFLoader();
  const [fbx, baked, rifle, ak] = await Promise.all([
    new FBXLoader().loadAsync(url('rocketbox/Military_Male_01.fbx')),
    fetch(url('rocketbox/clips.json')).then(async (r) => {
      if (!r.ok) throw new Error(`clips.json: HTTP ${String(r.status)}`);
      return (await r.json()) as BakedCharacter;
    }),
    gltf.loadAsync(url('weapons/rifle-west.glb')).then((g) => g.scene),
    gltf.loadAsync(url('weapons/ak47.glb')).then((g) => g.scene),
  ]);

  // The scene lights the soldiers: none of the files' own lights or cameras.
  for (const root of [fbx, rifle, ak]) stripLightsAndCameras(root);

  const friendly = new Map<string, THREE.Material>();
  fbx.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const m = o as THREE.Mesh;
    const convert = (mat: THREE.Material) => {
      const key = mat.name.replace(/\.\d+$/, '');
      const hit = friendly.get(key);
      if (hit) return hit;
      const files = PARTS[key];
      const std = new THREE.MeshStandardMaterial({
        name: key,
        roughness: 0.82,
        metalness: 0.0,
        ...(files ? { map: texture(files[0], true), normalMap: texture(files[1], false) } : {}),
        color: files ? 0xffffff : 0x3a3a34,
      });
      friendly.set(key, std);
      return std;
    };
    m.material = Array.isArray(m.material) ? m.material.map(convert) : convert(m.material);
    m.castShadow = true;
    m.receiveShadow = true;
    // Skinned bounds do not follow the pose: the layer culls whole soldiers.
    m.frustumCulled = false;
  });
  const enemy = new Map<string, THREE.Material>();
  for (const [key, mat] of friendly) {
    const tint = OPFOR_TINT[key];
    if (tint === undefined || !(mat instanceof THREE.MeshStandardMaterial)) {
      enemy.set(key, mat);
      continue;
    }
    const tinted = mat.clone();
    tinted.color.setHex(tint);
    enemy.set(key, tinted);
  }

  // About 1.8 m tall, as the clips were baked (their hip heights are in this scale).
  fbx.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(fbx, true);
  const h = box.max.y - box.min.y;
  fbx.scale.setScalar(h > 0 ? HEIGHT_M / h : 1);
  fbx.updateMatrixWorld(true);

  return {
    soldier: {
      id: baked.id,
      rig: 'rocketbox',
      template: fbx,
      clips: clipsFromBaked(baked),
      sighting: true,
    },
    rifle,
    ak,
    materials: { friendly, enemy },
    loadMs: performance.now() - t0,
  };
}

/** Puts a side's materials on a clone of the model. */
export function dressSoldier(root: THREE.Object3D, materials: Materials): void {
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const m = o as THREE.Mesh;
    const pick = (mat: THREE.Material) => materials.get(mat.name) ?? mat;
    m.material = Array.isArray(m.material) ? m.material.map(pick) : pick(m.material);
  });
}
