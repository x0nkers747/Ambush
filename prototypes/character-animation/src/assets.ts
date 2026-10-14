/**
 * Loads the test characters and clip libraries (public/assets/, fetched by
 * tools/fetch-assets.mjs) and fills each character's canonical clip slots,
 * retargeting clips authored on another rig.
 */

import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { type BoneKey, type ClipSlot, RIG_BONES, type RigId } from './rigs';
import { type ClipMetrics, measureClip } from './clip-analysis';
import { retargetClip } from './retarget';

const BASE = `${import.meta.env.BASE_URL}assets/`;

export type CharacterId = 'rocketbox' | 'mannequin' | 'quaternius' | 'kaykit';

export interface ClipSource {
  readonly clip: THREE.AnimationClip;
  /** Where the clip came from (library and original name), for the info panel. */
  readonly origin: string;
  /** Retargeted from another rig at load time. */
  readonly retargeted: boolean;
  /** Stride speed and cycle distance measured from the planted foot. */
  readonly metrics: ClipMetrics;
}

export interface CharacterAsset {
  readonly id: CharacterId;
  readonly label: string;
  readonly rig: RigId;
  /** The loaded model; clone it with SkeletonUtils.clone for each soldier. */
  readonly template: THREE.Object3D;
  /** Uniform scale applied to the template so it is about 1.8 m tall. */
  readonly scale: number;
  readonly clips: Partial<Record<ClipSlot, ClipSource>>;
  readonly triangles: number;
  readonly boneCount: number;
  readonly licence: string;
}

/** Clip libraries by rig: every source clip, keyed by original name. */
export interface Library {
  readonly rig: RigId;
  readonly name: string;
  readonly skeleton: THREE.Skeleton;
  readonly root: THREE.Object3D;
  readonly clips: ReadonlyMap<string, THREE.AnimationClip>;
  /** A clip whose first frame is the rig's T-pose, used as the retargeting rest pose. */
  readonly restClip?: THREE.AnimationClip;
}

const gltf = new GLTFLoader();

async function loadGltf(path: string) {
  return gltf.loadAsync(BASE + path);
}

function firstSkinned(root: THREE.Object3D): THREE.SkinnedMesh {
  let found: THREE.SkinnedMesh | undefined;
  root.traverse((o) => {
    if (!found && o instanceof THREE.SkinnedMesh) found = o as THREE.SkinnedMesh;
  });
  if (!found) throw new Error('no skinned mesh');
  return found;
}

function countTriangles(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      const g = (o as THREE.Mesh).geometry;
      n += (g.index ? g.index.count : (g.attributes['position']?.count ?? 0)) / 3;
    }
  });
  return n;
}

/** Drops scale tracks and the root-motion translation of everything but the hips. */
function cleanClip(clip: THREE.AnimationClip, rig: RigId, name: string): THREE.AnimationClip {
  const hips = RIG_BONES[rig].hips;
  const tracks = clip.tracks.filter((t) => {
    const [node, prop] = splitTrack(t.name);
    if (prop === 'scale') return false;
    if (prop === 'position' && node !== hips) return false;
    return true;
  });
  const out = new THREE.AnimationClip(name, clip.duration, tracks);
  return out;
}

export function splitTrack(name: string): [string, string] {
  const i = name.lastIndexOf('.');
  return [name.slice(0, i), name.slice(i + 1)];
}

/** Removes horizontal hips motion (the simulation moves the soldier), keeping height. */
export function makeInPlace(clip: THREE.AnimationClip, hips: string): THREE.AnimationClip {
  const out = clip.clone();
  for (const t of out.tracks) {
    const [node, prop] = splitTrack(t.name);
    if (node !== hips || prop !== 'position') continue;
    const v = t.values;
    const n = v.length / 3;
    const x0 = v[0] ?? 0;
    const z0 = v[2] ?? 0;
    const x1 = v[(n - 1) * 3] ?? 0;
    const z1 = v[(n - 1) * 3 + 2] ?? 0;
    for (let i = 0; i < n; i++) {
      const f = n > 1 ? i / (n - 1) : 0;
      // Subtract the straight-line drift, keep the sway around it.
      v[i * 3] = (v[i * 3] ?? 0) - (x0 + (x1 - x0) * f) + x0;
      v[i * 3 + 2] = (v[i * 3 + 2] ?? 0) - (z0 + (z1 - z0) * f) + z0;
    }
  }
  return out;
}

async function loadLibrary(
  rig: RigId,
  name: string,
  paths: string[],
  restClipName?: string,
): Promise<Library> {
  const clips = new Map<string, THREE.AnimationClip>();
  let root: THREE.Object3D | undefined;
  for (const p of paths) {
    const g = await loadGltf(p);
    root ??= g.scene;
    for (const c of g.animations) {
      const short = c.name.replace(/^CharacterArmature\|/, '');
      clips.set(short, cleanClip(c, rig, short));
    }
  }
  if (!root) throw new Error('no library');
  const restClip = restClipName ? clips.get(restClipName) : undefined;
  return {
    rig,
    name,
    root,
    skeleton: firstSkinned(root).skeleton,
    clips,
    ...(restClip ? { restClip } : {}),
  };
}

/** Slot → [library, clip name, in place?] for the Mesh2Motion (Quaternius UAL) clips. */
const M2M_SLOTS: Partial<Record<ClipSlot, string>> = {
  idle: 'Idle_A',
  walk: 'Walk',
  walkBack: 'Walk_Backwards',
  walkLeft: 'Strafe_left',
  walkRight: 'Strafe_right',
  run: 'Jog',
  sprint: 'Sprint',
  kneelIdle: 'Crouch_Idle',
  kneelWalk: 'Crouch_Walk',
  crawl: 'Crawl',
  aimUp: 'Pistol_Aim_Up',
  aimDown: 'Pistol_Aim_Down',
  hit: 'Hit_Chest',
  death: 'Death_A',
  turnLeft: 'Turn_Left_90',
  turnRight: 'Turn_Right_90',
};

/** Slot → clip name for the Quaternius soldier's own two-handed gun clips. */
const QUATERNIUS_SLOTS: Partial<Record<ClipSlot, string>> = {
  idle: 'Idle_Neutral',
  // Its "gun" clips (Idle_Gun, Idle_Gun_Pointing, Gun_Shoot) are one-handed
  // pistol poses, so they fill no rifle slot.
  walk: 'Walk',
  run: 'Run',
  runBack: 'Run_Back',
  runLeft: 'Run_Left',
  runRight: 'Run_Right',
  hit: 'HitRecieve',
  death: 'Death',
};

/**
 * KayKit Character Animations 1.1 (CC0): the only openly licensed two-handed
 * rifle clips found, plus lying down and standing up. Stylised (chibi)
 * proportions, so they are retargeted and the hands are corrected by IK.
 */
const KAYKIT_SLOTS: Partial<Record<ClipSlot, string>> = {
  aim: 'Ranged_2H_Aiming',
  fire: 'Ranged_2H_Shoot',
  reload: 'Ranged_2H_Reload',
  runRifle: 'Running_HoldingRifle',
  toProne: 'Lie_Down',
  proneIdle: 'Lie_Idle',
  getUp: 'Lie_StandUp',
};

/** Clips whose lowest joint stays on the ground after retargeting (see retargetClip). */
const GROUND_CONTACT = new Set<ClipSlot>([
  'kneelIdle',
  'kneelWalk',
  'toProne',
  'proneIdle',
  'crawl',
  'getUp',
  'death',
]);

function fill(
  lib: Library,
  slots: Partial<Record<ClipSlot, string>>,
  target: { rig: RigId; skeleton: THREE.Skeleton; root: THREE.Object3D } | null,
  only?: readonly ClipSlot[],
): Partial<Record<ClipSlot, ClipSource>> {
  const out: Partial<Record<ClipSlot, ClipSource>> = {};
  const hips = RIG_BONES[lib.rig].hips ?? '';
  for (const [slot, name] of Object.entries(slots) as [ClipSlot, string][]) {
    if (only && !only.includes(slot)) continue;
    const src = lib.clips.get(name);
    if (!src) continue;
    const inPlace = makeInPlace(src, hips);
    const clip = target
      ? retargetClip(inPlace, lib, target, slot, GROUND_CONTACT.has(slot))
      : Object.assign(inPlace.clone(), { name: slot });
    const metrics = measureClip(
      target ? target.root : lib.root,
      target ? target.rig : lib.rig,
      clip,
      slot === 'crawl' ? 'hands' : 'feet',
    );
    out[slot] = { clip, origin: `${lib.name}: ${name}`, retargeted: target !== null, metrics };
  }
  return out;
}

async function loadRocketbox(): Promise<THREE.Group> {
  const fbx = await new FBXLoader().loadAsync(`${BASE}rocketbox/Military_Male_01.fbx`);
  const tex = new THREE.TextureLoader();
  const load = (f: string, srgb: boolean) => {
    const t = tex.load(`${BASE}rocketbox/${f}`);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 4;
    return t;
  };
  const parts: Record<string, [string, string]> = {
    sm002_body: ['sm002_body_color_acu.jpg', 'sm002_body_normal.jpg'],
    sm002_head: ['sm002_head_color.jpg', 'sm002_head_normal.jpg'],
    sm002_helmet: ['sm002_helmet_color_acu.jpg', 'sm002_helmet_normal.jpg'],
    sm002_equipment: ['sm002_equipment_color_acu.jpg', 'sm002_equipment_normal.jpg'],
  };
  const cache = new Map<string, THREE.Material>();
  fbx.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const m = o as THREE.Mesh;
    const convert = (mat: THREE.Material) => {
      const key = mat.name.replace(/\.\d+$/, '');
      const hit = cache.get(key);
      if (hit) return hit;
      const files = parts[key];
      const std = new THREE.MeshStandardMaterial({
        name: key,
        roughness: 0.82,
        metalness: 0.0,
        ...(files ? { map: load(files[0], true), normalMap: load(files[1], false) } : {}),
        color: files ? 0xffffff : 0x3a3a34,
      });
      cache.set(key, std);
      return std;
    };
    m.material = Array.isArray(m.material) ? m.material.map(convert) : convert(m.material);
    m.castShadow = true;
    m.frustumCulled = false;
  });
  return fbx;
}

function normaliseHeight(root: THREE.Object3D, metres: number): number {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root, true);
  const h = box.max.y - box.min.y;
  const s = h > 0 ? metres / h : 1;
  root.scale.setScalar(s);
  root.updateMatrixWorld(true);
  return s;
}

export interface AssetSet {
  readonly characters: Partial<Record<CharacterId, CharacterAsset>> &
    Record<'rocketbox' | 'mannequin' | 'quaternius', CharacterAsset>;
  readonly libraries: readonly Library[];
  readonly ak: THREE.Object3D;
  /** "Assault Rifle West" (CC0), an AR-15-pattern rifle standing in for the M16A2. */
  readonly rifle: THREE.Object3D;
  readonly loadMs: number;
}

export async function loadAssets(onProgress: (msg: string) => void): Promise<AssetSet> {
  const t0 = performance.now();
  onProgress('Mesh2Motion clip libraries…');
  const m2m = await loadLibrary('m2m', 'Mesh2Motion/Quaternius UAL (CC0)', [
    'm2m/human-base-animations.glb',
    'm2m/human-addon-animations.glb',
    'm2m/human-mocap-animations.glb',
  ]);
  onProgress('KayKit clip libraries…');
  const kay = await loadLibrary(
    'kaykit',
    'KayKit Character Animations 1.1 (CC0)',
    [
      'kaykit/Rig_Medium_CombatRanged.glb',
      'kaykit/Rig_Medium_General.glb',
      'kaykit/Rig_Medium_MovementAdvanced.glb',
      'kaykit/Rig_Medium_Simulation.glb',
    ],
    'T-Pose',
  );
  onProgress('Quaternius soldier…');
  const qGltf = await loadGltf('quaternius/soldier.glb');
  const qLib: Library = {
    rig: 'quaternius',
    name: 'Quaternius Soldier (CC0 / CC BY 3.0)',
    root: qGltf.scene,
    skeleton: firstSkinned(qGltf.scene).skeleton,
    clips: new Map(
      qGltf.animations.map((c) => {
        const short = c.name.replace(/^CharacterArmature\|/, '');
        return [short, cleanClip(c, 'quaternius', short)];
      }),
    ),
  };
  onProgress('Rocketbox Military_Male_01…');
  const rbRoot = await loadRocketbox();
  const ak = (await loadGltf('m2m/AK.glb')).scene;
  const rifle = (await loadGltf('weapons/rifle-west.glb')).scene;

  // Characters.
  const mannequinRoot = m2m.root;
  mannequinRoot.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = true;
      o.frustumCulled = false;
    }
  });
  qGltf.scene.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = true;
      o.frustumCulled = false;
    }
  });
  kay.root.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = true;
      o.frustumCulled = false;
    }
  });
  const kSkinned = firstSkinned(kay.root);
  const rbSkinned = firstSkinned(rbRoot);
  const mSkinned = firstSkinned(mannequinRoot);
  const qSkinned = firstSkinned(qGltf.scene);

  const rbScale = normaliseHeight(rbRoot, 1.8);
  const mScale = normaliseHeight(mannequinRoot, 1.8);
  const qScale = normaliseHeight(qGltf.scene, 1.8);
  const kScale = normaliseHeight(kay.root, 1.8);

  onProgress('Retargeting clips…');
  const rbTarget = { rig: 'rocketbox' as const, skeleton: rbSkinned.skeleton, root: rbRoot };
  const mTarget = { rig: 'm2m' as const, skeleton: mSkinned.skeleton, root: mannequinRoot };
  const characters: Partial<Record<CharacterId, CharacterAsset>> &
    Record<'rocketbox' | 'mannequin' | 'quaternius', CharacterAsset> = {
    rocketbox: {
      id: 'rocketbox',
      label: 'Rocketbox Military_Male_01 (realistic, MIT; clips retargeted)',
      rig: 'rocketbox',
      template: rbRoot,
      scale: rbScale,
      clips: {
        ...fill(m2m, M2M_SLOTS, rbTarget),
        ...fill(kay, KAYKIT_SLOTS, rbTarget),
      },
      triangles: countTriangles(rbRoot),
      boneCount: rbSkinned.skeleton.bones.length,
      licence: 'MIT (Microsoft Rocketbox)',
    },
    mannequin: {
      id: 'mannequin',
      label: 'Mesh2Motion mannequin (CC0; UAL clips native, KayKit rifle clips retargeted)',
      rig: 'm2m',
      template: mannequinRoot,
      scale: mScale,
      clips: {
        ...fill(m2m, M2M_SLOTS, null),
        ...fill(kay, KAYKIT_SLOTS, mTarget),
      },
      triangles: countTriangles(mannequinRoot),
      boneCount: mSkinned.skeleton.bones.length,
      licence: 'CC0 (Mesh2Motion / Quaternius)',
    },
    quaternius: {
      id: 'quaternius',
      label: 'Quaternius Soldier (stylised; own clips + KayKit retargeted)',
      rig: 'quaternius',
      template: qGltf.scene,
      scale: qScale,
      clips: {
        ...fill(kay, KAYKIT_SLOTS, {
          rig: 'quaternius',
          skeleton: qSkinned.skeleton,
          root: qGltf.scene,
        }),
        ...fill(qLib, QUATERNIUS_SLOTS, null),
      },
      triangles: countTriangles(qGltf.scene),
      boneCount: qSkinned.skeleton.bones.length,
      licence: 'CC0 (quaternius.com) / CC BY 3.0 (Poly Pizza listing)',
    },
  };
  characters.kaykit = {
    id: 'kaykit',
    label: 'KayKit mannequin (CC0; the rifle clips on their own rig, for reference)',
    rig: 'kaykit',
    template: kay.root,
    scale: kScale,
    clips: fill(kay, KAYKIT_SLOTS, null),
    triangles: countTriangles(kay.root),
    boneCount: kSkinned.skeleton.bones.length,
    licence: 'CC0 (Kay Lousberg)',
  };
  return { characters, libraries: [m2m, kay, qLib], ak, rifle, loadMs: performance.now() - t0 };
}

/** The bone of `key` in an instance (after SkeletonUtils.clone). */
export function boneOf(root: THREE.Object3D, rig: RigId, key: BoneKey): THREE.Bone | undefined {
  const name = RIG_BONES[rig][key];
  if (!name) return undefined;
  const o = root.getObjectByName(name);
  return o as THREE.Bone | undefined;
}
