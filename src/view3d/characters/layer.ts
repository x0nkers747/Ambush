import * as THREE from 'three';
import type { CombatEvent, MotionLog } from '#exercise';
import type { UnitMarker } from '../unit-markers';
import { fingerprint, type PoseFingerprint } from './fingerprint';
import { dressSoldier, loadSoldierAssets, type SoldierAssets } from './load';
import { Puppet } from './puppet';
import { useSoldierShadow } from './shadow';
import { makeWeapon, weaponKindOf } from './weapon-map';
import type { WeaponKind } from './weapons';

// The soldiers in the 3D view (docs/character-animation.md): an animated
// Rocketbox soldier for each soldier the map shows, posed for the simulation
// time from the motion and combat logs; over each, a small team indicator
// that keeps its size on screen and shows through trees and buildings (blue
// BLUEFOR, red OPFOR, grey when down, yellow when selected, with a ring on
// the ground). Display only: nothing here feeds back into the simulation.

/** What the soldiers are posed from: the logs and the simulation time to show. */
export interface AnimationClock {
  readonly log: MotionLog;
  readonly combatLog: readonly CombatEvent[];
  /** Simulation seconds (fractional: between ticks, motion is interpolated). */
  readonly seconds: number;
  /**
   * Nothing comes after `seconds`: the timeline has ended (the engagement is
   * complete, or the review is at its end). The view then lets the soldiers'
   * animation run on for a moment (`AFTERMATH_SECONDS`), so a fall under way
   * finishes; positions stay where they were.
   */
  readonly ended?: boolean;
}

/** How long the animation runs on after the timeline has ended (s). */
export const AFTERMATH_SECONDS = 3;

/**
 * The aftermath clock: how far past an ended timeline the soldiers are
 * posed. Grows with real time while the clock stays ended at the same
 * moment, up to `AFTERMATH_SECONDS`; back to 0 as soon as it moves.
 */
export function createAftermath(): (clock: AnimationClock, nowMs: number) => number {
  let at = Number.NaN;
  let since = 0;
  return (clock, nowMs) => {
    if (!clock.ended || clock.seconds !== at) {
      at = clock.seconds;
      since = nowMs;
      return 0;
    }
    return Math.min(AFTERMATH_SECONDS, (nowMs - since) / 1000);
  };
}

export interface CharacterFrame {
  readonly units: readonly UnitMarker[];
  readonly clock: AnimationClock;
  /** The weapon each soldier fires (simulation profile), by soldier id. */
  readonly weapons: Readonly<Record<string, string | null>>;
  /** The surface stood on at a map point (`surfaceHeightAt`). */
  readonly surfaceAt: (x: number, y: number) => number;
  readonly camera: THREE.PerspectiveCamera;
  readonly viewportHeightPx: number;
}

export interface CharacterStats {
  readonly ready: boolean;
  readonly failed: string | null;
  readonly loadMs: number;
  readonly soldiers: number;
  /** Soldiers posed in the last frame (others were off screen or skipped far away). */
  readonly posed: number;
  /** Milliseconds spent posing in the last frame (CPU). */
  readonly poseMs: number;
  /** The last frame's simulation time and the motion log's ticks. */
  readonly seconds: number;
  readonly firstTick: number;
  readonly lastTick: number;
}

export interface CharacterLayer {
  readonly group: THREE.Group;
  /** Whether the models are loaded (until then, or if loading failed, markers stand in). */
  readonly ready: boolean;
  update(frame: CharacterFrame): void;
  /** Where each soldier stands (three.js axes) and its pose input, for checks. */
  positions(): Map<string, { x: number; y: number; z: number; lying: boolean }>;
  /** The posed soldiers' fingerprints and states (for replay checks in the browser). */
  fingerprints(): Map<string, { fingerprint: PoseFingerprint; describe: string }>;
  stats(): CharacterStats;
  dispose(): void;
}

const COLORS = {
  friendly: 0x2f6fd0,
  enemy: 0xc8372d,
  down: 0x6e737a,
  selected: 0xf2c230,
} as const;
/** The team indicator's size on screen (CSS px) and its least size in the world (m). */
const INDICATOR_PX = 11;
const INDICATOR_MIN_M = 0.16;
/** Beyond this on-screen height a soldier is posed every frame; below it, every 4th (px). */
const FAR_PX = 14;

interface Entry {
  readonly puppet: Puppet;
  readonly kind: WeaponKind | null;
  readonly affiliation: UnitMarker['affiliation'];
  readonly indicator: THREE.Mesh;
  readonly ring: THREE.Mesh;
  frame: number;
}

/**
 * The layer, loading the soldier from `source` (the folder holding
 * `rocketbox/` and `weapons/`), or given the loaded assets (tests).
 */
export function createCharacterLayer(source: string | Promise<SoldierAssets>): CharacterLayer {
  const group = new THREE.Group();
  group.name = 'soldiers';
  let assets: SoldierAssets | null = null;
  let failed: string | null = null;
  let disposed = false;
  const loading = (typeof source === 'string' ? loadSoldierAssets(source) : source).then(
    (a) => {
      if (!disposed) assets = a;
    },
    (error: unknown) => {
      failed = error instanceof Error ? error.message : String(error);
    },
  );
  void loading;

  const indicatorGeometry = new THREE.OctahedronGeometry(0.5, 0).scale(0.75, 1, 0.75);
  const ringGeometry = new THREE.RingGeometry(0.55, 0.7, 32).rotateX(-Math.PI / 2);
  const indicatorMaterial = (color: number) =>
    new THREE.MeshBasicMaterial({
      color,
      fog: false,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
    });
  const materials = {
    friendly: indicatorMaterial(COLORS.friendly),
    enemy: indicatorMaterial(COLORS.enemy),
    down: indicatorMaterial(COLORS.down),
    selected: indicatorMaterial(COLORS.selected),
  };
  const ringMaterial = new THREE.MeshBasicMaterial({
    color: COLORS.selected,
    fog: false,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
  });

  const entries = new Map<string, Entry>();
  let frameCount = 0;
  let posed = 0;
  let poseMs = 0;
  let clock: AnimationClock | null = null;
  const frustum = new THREE.Frustum();
  const projection = new THREE.Matrix4();
  const sphere = new THREE.Sphere();
  const head = new THREE.Vector3();

  const remove = (id: string, e: Entry) => {
    e.puppet.dispose();
    // Clones share the model's geometry and materials, but each has its own
    // skeletons (the soldier's and a skinned rifle's), with bone textures.
    const skeletons = new Set<THREE.Skeleton>();
    const collect = (o: THREE.Object3D) => {
      if (o instanceof THREE.SkinnedMesh) skeletons.add((o as THREE.SkinnedMesh).skeleton);
    };
    e.puppet.view.root.traverse(collect);
    e.puppet.view.weapon?.object.traverse(collect);
    for (const sk of skeletons) sk.dispose();
    group.remove(e.puppet.view.root, e.indicator, e.ring);
    const weapon = e.puppet.view.weapon;
    if (weapon) {
      group.remove(weapon.object);
      // The placeholder SAW's boxes are its own; rifle clones share the loaded model's.
      if (e.kind === 'm249')
        weapon.object.traverse((o) => {
          if (!(o instanceof THREE.Mesh)) return;
          const mesh = o as THREE.Mesh;
          mesh.geometry.dispose();
          for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
            m.dispose();
        });
    }
    entries.delete(id);
  };

  const create = (a: SoldierAssets, u: UnitMarker, frame: CharacterFrame): Entry => {
    const kind = weaponKindOf(frame.weapons[u.id]);
    const puppet = new Puppet(a.soldier, u.id, makeWeapon(kind, a), frame.clock.log);
    dressSoldier(
      puppet.view.root,
      u.affiliation === 'friendly' ? a.materials.friendly : a.materials.enemy,
    );
    puppet.view.root.name = `soldier ${u.id}`;
    useSoldierShadow(puppet.view.root);
    if (puppet.view.weapon) useSoldierShadow(puppet.view.weapon.object);
    const indicator = new THREE.Mesh(indicatorGeometry, materials.friendly);
    indicator.renderOrder = 20;
    indicator.name = `indicator ${u.id}`;
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.renderOrder = 2;
    group.add(puppet.view.root, indicator, ring);
    if (puppet.view.weapon) group.add(puppet.view.weapon.object);
    const e: Entry = { puppet, kind, affiliation: u.affiliation, indicator, ring, frame: -1 };
    entries.set(u.id, e);
    return e;
  };

  return {
    group,
    get ready() {
      return assets !== null;
    },
    update(frame) {
      const a = assets;
      if (!a) return;
      frameCount += 1;
      clock = frame.clock;
      const t0 = performance.now();
      posed = 0;
      const camera = frame.camera;
      camera.updateMatrixWorld();
      projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projection);
      const metresPerPxAt = (d: number) =>
        (2 * d * Math.tan(((camera.fov / 2) * Math.PI) / 180)) /
        Math.max(1, frame.viewportHeightPx);
      const seen = new Set<string>();
      for (const u of frame.units) {
        seen.add(u.id);
        let e = entries.get(u.id);
        const kind = weaponKindOf(frame.weapons[u.id]);
        if (e && (e.kind !== kind || e.affiliation !== u.affiliation)) {
          remove(u.id, e);
          e = undefined;
        }
        // Soldiers outside the log (none, normally) cannot be posed.
        if (frame.clock.log.indexOf(u.id) < 0) {
          seen.delete(u.id);
          continue;
        }
        e ??= create(a, u, frame);
        const root = e.puppet.view.root;
        // The simulation's position (interpolated) decides culling, before posing.
        const p = u.position;
        sphere.center.set(p.x, p.z + 0.9, -p.y);
        sphere.radius = 2.2;
        const visible = frustum.intersectsSphere(sphere);
        const distance = camera.position.distanceTo(sphere.center);
        const px = 1.8 / metresPerPxAt(distance);
        const due = px >= FAR_PX || (frameCount + (e.frame & 3)) % 4 === 0 || e.frame < 0;
        root.visible = visible;
        if (e.puppet.view.weapon) e.puppet.view.weapon.object.visible = visible;
        if (visible && due) {
          e.puppet.pose(
            frame.clock.log,
            frame.clock.combatLog,
            frame.clock.seconds,
            frame.surfaceAt,
          );
          e.frame = frameCount;
          posed += 1;
        }
        // The indicator over the head, a constant size on screen.
        const input = e.puppet.input;
        const down = u.status !== 'active';
        e.indicator.material = down
          ? materials.down
          : u.selected
            ? materials.selected
            : u.affiliation === 'friendly'
              ? materials.friendly
              : materials.enemy;
        const headBone = e.puppet.view.bones.head;
        if (headBone && e.frame >= 0) headBone.getWorldPosition(head);
        else head.set(root.position.x, root.position.y + 1.7, root.position.z);
        const size = Math.max(INDICATOR_MIN_M, INDICATOR_PX * metresPerPxAt(distance));
        e.indicator.scale.setScalar(size);
        e.indicator.position.set(
          head.x,
          Math.max(head.y, root.position.y + 0.3) + 0.3 + size,
          head.z,
        );
        e.indicator.visible = true;
        e.ring.visible = u.selected && !down;
        e.ring.position.set(root.position.x, (input?.z ?? p.z) + 0.04, root.position.z);
      }
      for (const [id, e] of entries) if (!seen.has(id)) remove(id, e);
      poseMs = performance.now() - t0;
    },
    positions() {
      const out = new Map<string, { x: number; y: number; z: number; lying: boolean }>();
      for (const [id, e] of entries) {
        const r = e.puppet.view.root.position;
        const i = e.puppet.input;
        out.set(id, {
          x: r.x,
          y: r.y,
          z: r.z,
          lying: i !== null && (i.posture === 'prone' || i.sinceDown >= 0),
        });
      }
      return out;
    },
    fingerprints() {
      const out = new Map<string, { fingerprint: PoseFingerprint; describe: string }>();
      for (const [id, e] of entries)
        if (e.puppet.input)
          out.set(id, { fingerprint: fingerprint(e.puppet), describe: e.puppet.describe() });
      return out;
    },
    stats: () => ({
      ready: assets !== null,
      failed,
      loadMs: assets?.loadMs ?? 0,
      soldiers: entries.size,
      posed,
      poseMs,
      seconds: clock?.seconds ?? 0,
      firstTick: clock?.log.firstTick ?? 0,
      lastTick: clock?.log.lastTick ?? 0,
    }),
    dispose() {
      disposed = true;
      for (const [id, e] of entries) remove(id, e);
      // The shared model: geometry, materials and textures.
      if (assets) {
        const textures = new Set<THREE.Texture>();
        const all = [...assets.materials.friendly.values(), ...assets.materials.enemy.values()];
        for (const m of new Set(all)) {
          if (m instanceof THREE.MeshStandardMaterial) {
            if (m.map) textures.add(m.map);
            if (m.normalMap) textures.add(m.normalMap);
          }
          m.dispose();
        }
        for (const t of textures) t.dispose();
        for (const model of [assets.soldier.template, assets.rifle, assets.ak])
          model.traverse((o) => {
            if (o instanceof THREE.Mesh) (o as THREE.Mesh).geometry.dispose();
          });
        assets = null;
      }
      indicatorGeometry.dispose();
      ringGeometry.dispose();
      for (const m of Object.values(materials)) m.dispose();
      ringMaterial.dispose();
    },
  };
}
