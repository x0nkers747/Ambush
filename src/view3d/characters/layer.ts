import * as THREE from 'three';
import { sinkDepth, type ViewEarthwork } from '../earthworks';
import type { PoseInput } from './motion';
import type { CombatEvent, MotionLog } from '#exercise';
import type { UnitMarker } from '../unit-markers';
import { emptyMotionSample } from '#exercise';
import { fingerprint, type PoseFingerprint } from './fingerprint';
import { createImpostorLayer, IMPOSTOR_HEAD_M, type ImpostorShape } from './impostors';
import { dressSoldier, loadSoldierAssets, type SoldierAssets } from './load';
import { Puppet } from './puppet';
import { useSoldierShadow } from './shadow';
import { makeWeapon, weaponKindOf } from './weapon-map';
import type { WeaponKind } from './weapons';

// The soldiers in the 3D view (docs/character-animation.md): an animated
// Rocketbox soldier for each soldier the map shows, posed for the simulation
// time from the motion and combat logs, with levels of detail (a soldier only
// a few pixels tall is an instanced figure in his posture; see
// `SHADOW_PX`, `IMPOSTOR_PX`); over each, a small team indicator
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

/** A soldier this close to his fighting position (m) is in it. */
const IN_POSITION_M = 1.2;

/** How far a soldier at (x, y) is sunk into his fighting position (m): 0 when he is not standing in one. */
function trenchDepth(frame: CharacterFrame, id: string, x: number, y: number): number {
  const work = frame.earthworks?.get(id);
  if (!work || Math.hypot(x - work.x, y - work.y) > IN_POSITION_M) return 0;
  return sinkDepth(work.level);
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
  /**
   * Fighting positions by soldier id (a defence's, docs/behavior-lab/force-on-force/09):
   * a soldier at his, dug in deep enough, is drawn standing in it, sunk into the ground.
   */
  readonly earthworks?: ReadonlyMap<string, ViewEarthwork>;
}

export interface CharacterStats {
  readonly ready: boolean;
  readonly failed: string | null;
  readonly loadMs: number;
  readonly soldiers: number;
  /** Soldiers posed in the last frame (others were off screen, far, or skipped this frame). */
  readonly posed: number;
  /** Soldiers at each level of detail in the last frame. */
  readonly lod: { readonly near: number; readonly mid: number; readonly far: number };
  /** Animated models made so far (one per soldier that has been near enough). */
  readonly models: number;
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
/** Far soldiers' figures: a uniform tone by side, near the models' look at a distance (the indicator above tells the sides apart too). */
const FIGURE_COLORS = { friendly: 0x80827a, enemy: 0x8a7c66, down: 0x5f6266 } as const;
/** The team indicator's size on screen (CSS px) and its least size in the world (m). */
const INDICATOR_PX = 11;
const INDICATOR_MIN_M = 0.16;
/**
 * Levels of detail, by a standing soldier's height on screen (px):
 * - from `SHADOW_PX`: the animated model, posed every frame, casting a shadow;
 * - from `IMPOSTOR_PX`: the animated model without its shadow, posed every
 *   other frame;
 * - below: an instanced figure in his posture (no model at all).
 */
const SHADOW_PX = 28;
const IMPOSTOR_PX = 16;

export type CharacterLod = 'near' | 'mid' | 'far';

interface Entry {
  /** The animated soldier, made the first time he is near enough. */
  puppet: Puppet | null;
  readonly kind: WeaponKind | null;
  readonly affiliation: UnitMarker['affiliation'];
  /** Spreads the posing of the soldiers posed every other frame. */
  readonly slot: number;
  frame: number;
  lod: CharacterLod;
  /** Whether his model casts a shadow (near). */
  shadows: boolean;
  /** Far: where his figure stands (three.js axes), and whether it lies. */
  far: { x: number; y: number; z: number; lying: boolean } | null;
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

  const impostors = createImpostorLayer(group);
  const colors = {
    friendly: new THREE.Color(COLORS.friendly),
    enemy: new THREE.Color(COLORS.enemy),
    down: new THREE.Color(COLORS.down),
    selected: new THREE.Color(COLORS.selected),
  };
  const figureColors = {
    friendly: new THREE.Color(FIGURE_COLORS.friendly),
    enemy: new THREE.Color(FIGURE_COLORS.enemy),
    down: new THREE.Color(FIGURE_COLORS.down),
  };
  const ringGeometry = new THREE.RingGeometry(0.55, 0.7, 32).rotateX(-Math.PI / 2);
  const ringMaterial = new THREE.MeshBasicMaterial({
    color: COLORS.selected,
    fog: false,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
  });
  // One ring, under the selected soldier.
  const ring = new THREE.Mesh(ringGeometry, ringMaterial);
  ring.renderOrder = 2;
  ring.name = 'selection ring';
  ring.visible = false;
  group.add(ring);

  const entries = new Map<string, Entry>();
  let frameCount = 0;
  let created = 0;
  let posed = 0;
  let poseMs = 0;
  let counts = { near: 0, mid: 0, far: 0 };
  let clock: AnimationClock | null = null;
  const frustum = new THREE.Frustum();
  const projection = new THREE.Matrix4();
  const sphere = new THREE.Sphere();
  const head = new THREE.Vector3();
  const sampleA = emptyMotionSample();
  const sampleB = emptyMotionSample();

  const disposePuppet = (e: Entry) => {
    const puppet = e.puppet;
    if (!puppet) return;
    puppet.dispose();
    // Clones share the model's geometry and materials, but each has its own
    // skeletons (the soldier's and a skinned rifle's), with bone textures.
    const skeletons = new Set<THREE.Skeleton>();
    const collect = (o: THREE.Object3D) => {
      if (o instanceof THREE.SkinnedMesh) skeletons.add((o as THREE.SkinnedMesh).skeleton);
    };
    puppet.view.root.traverse(collect);
    puppet.view.weapon?.object.traverse(collect);
    for (const sk of skeletons) sk.dispose();
    group.remove(puppet.view.root);
    const weapon = puppet.view.weapon;
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
    e.puppet = null;
  };
  const remove = (id: string, e: Entry) => {
    disposePuppet(e);
    entries.delete(id);
  };

  const makePuppet = (a: SoldierAssets, id: string, e: Entry, log: MotionLog): Puppet => {
    const puppet = new Puppet(a.soldier, id, makeWeapon(e.kind, a), log);
    dressSoldier(
      puppet.view.root,
      e.affiliation === 'friendly' ? a.materials.friendly : a.materials.enemy,
    );
    puppet.view.root.name = `soldier ${id}`;
    useSoldierShadow(puppet.view.root);
    if (puppet.view.weapon) useSoldierShadow(puppet.view.weapon.object);
    group.add(puppet.view.root);
    if (puppet.view.weapon) group.add(puppet.view.weapon.object);
    e.puppet = puppet;
    e.shadows = true;
    e.frame = -1;
    return puppet;
  };

  /** Whether the model (and its weapon) casts a shadow. */
  const castShadows = (puppet: Puppet, on: boolean) => {
    const set = (o: THREE.Object3D) => {
      if (o instanceof THREE.Mesh) o.castShadow = on;
    };
    puppet.view.root.traverse(set);
    puppet.view.weapon?.object.traverse(set);
  };

  /** The soldier in the motion log at `seconds`, interpolated between ticks (into `sampleA`). */
  const sampleAt = (log: MotionLog, index: number, seconds: number) => {
    const tick = Math.max(0, seconds * log.tickRateHz);
    const k = Math.floor(tick);
    log.read(index, k, sampleA);
    log.read(index, k + 1, sampleB);
    const w = tick - k;
    if (w > 0) {
      sampleA.x += (sampleB.x - sampleA.x) * w;
      sampleA.y += (sampleB.y - sampleA.y) * w;
      sampleA.z += (sampleB.z - sampleA.z) * w;
      let d = sampleB.azimuth - sampleA.azimuth;
      d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
      sampleA.azimuth += d * w;
    }
    return sampleA;
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
      counts = { near: 0, mid: 0, far: 0 };
      const camera = frame.camera;
      camera.updateMatrixWorld();
      projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projection);
      const metresPerPxAt = (d: number) =>
        (2 * d * Math.tan(((camera.fov / 2) * Math.PI) / 180)) /
        Math.max(1, frame.viewportHeightPx);
      const log = frame.clock.log;
      const seen = new Set<string>();
      ring.visible = false;
      impostors.begin(frame.units.length);
      for (const u of frame.units) {
        seen.add(u.id);
        let e = entries.get(u.id);
        const kind = weaponKindOf(frame.weapons[u.id]);
        if (e && (e.kind !== kind || e.affiliation !== u.affiliation)) {
          remove(u.id, e);
          e = undefined;
        }
        // Soldiers outside the log (none, normally) cannot be posed.
        const index = log.indexOf(u.id);
        if (index < 0) {
          seen.delete(u.id);
          continue;
        }
        if (!e) {
          e = {
            puppet: null,
            kind,
            affiliation: u.affiliation,
            slot: created++,
            frame: -1,
            lod: 'far',
            shadows: false,
            far: null,
          };
          entries.set(u.id, e);
        }
        // The simulation's position (interpolated) decides culling and detail, before posing.
        const p = u.position;
        sphere.center.set(p.x, p.z + 0.9, -p.y);
        sphere.radius = 2.2;
        const visible = frustum.intersectsSphere(sphere);
        const distance = camera.position.distanceTo(sphere.center);
        const px = 1.8 / metresPerPxAt(distance);
        const lod: CharacterLod = px >= SHADOW_PX ? 'near' : px >= IMPOSTOR_PX ? 'mid' : 'far';
        const wasFar = e.lod === 'far';
        e.lod = lod;
        counts[lod] += 1;
        const down = u.status !== 'active';
        let groundY: number;
        if (lod === 'far') {
          if (e.puppet) {
            e.puppet.view.root.visible = false;
            if (e.puppet.view.weapon) e.puppet.view.weapon.object.visible = false;
          }
          const s = sampleAt(log, index, frame.clock.seconds);
          const sunk = s.status === 'active' ? trenchDepth(frame, u.id, s.x, s.y) : 0;
          const shape: ImpostorShape =
            s.status !== 'active' ? 'down' : sunk > 0 ? 'standing' : s.posture;
          const x = s.x;
          const y = s.z - sunk;
          const z = -s.y;
          const lying = shape === 'prone' || shape === 'down';
          if (visible) {
            impostors.figure(
              shape,
              x,
              y,
              z,
              Math.PI - s.azimuth,
              shape === 'down'
                ? figureColors.down
                : u.affiliation === 'friendly'
                  ? figureColors.friendly
                  : figureColors.enemy,
            );
          }
          e.far = { x, y, z, lying };
          head.set(x, y + IMPOSTOR_HEAD_M[shape], z);
          groundY = y;
        } else {
          e.far = null;
          const puppet = e.puppet ?? makePuppet(a, u.id, e, log);
          if (e.shadows !== (lod === 'near')) {
            e.shadows = lod === 'near';
            castShadows(puppet, e.shadows);
          }
          const root = puppet.view.root;
          root.visible = visible;
          if (puppet.view.weapon) puppet.view.weapon.object.visible = visible;
          // Near: every frame; middle: every other frame (spread), and at once when he comes in.
          const due = lod === 'near' || wasFar || e.frame < 0 || (frameCount + e.slot) % 2 === 0;
          if (visible && due) {
            const work = frame.earthworks?.get(u.id);
            const surfaceAt = frame.surfaceAt;
            // In his fighting position, dug in deep enough: standing in it, sunk, his feet on its floor.
            const inTrench = work
              ? (input: PoseInput): PoseInput => {
                  const depth = trenchDepth(frame, u.id, input.x, input.y);
                  if (depth <= 0 || input.speed > 0.4) return input;
                  return {
                    ...input,
                    z: input.z - depth,
                    posture: 'standing',
                    postureFrom: 'standing',
                    postureT: 1,
                  };
                }
              : undefined;
            const floor = work
              ? (x: number, y: number) =>
                  surfaceAt(x, y) -
                  (Math.hypot(x - work.x, y - work.y) < 1.5 ? sinkDepth(work.level) : 0)
              : surfaceAt;
            puppet.pose(log, frame.clock.combatLog, frame.clock.seconds, floor, inTrench);
            e.frame = frameCount;
            posed += 1;
          }
          const headBone = puppet.view.bones.head;
          if (headBone && e.frame >= 0) headBone.getWorldPosition(head);
          else head.set(root.position.x, root.position.y + 1.7, root.position.z);
          groundY = puppet.input?.z ?? p.z;
          head.y = Math.max(head.y, root.position.y + 0.3);
        }
        // The indicator over the head, a constant size on screen.
        const size = Math.max(INDICATOR_MIN_M, INDICATOR_PX * metresPerPxAt(distance));
        impostors.indicator(
          head.x,
          head.y + 0.3 + size,
          head.z,
          size,
          down
            ? colors.down
            : u.selected
              ? colors.selected
              : u.affiliation === 'friendly'
                ? colors.friendly
                : colors.enemy,
        );
        if (u.selected && !down) {
          ring.visible = true;
          ring.position.set(head.x, groundY + 0.04, head.z);
        }
      }
      impostors.finish();
      for (const [id, e] of entries) if (!seen.has(id)) remove(id, e);
      poseMs = performance.now() - t0;
    },
    positions() {
      const out = new Map<string, { x: number; y: number; z: number; lying: boolean }>();
      for (const [id, e] of entries) {
        if (e.far) {
          out.set(id, { ...e.far });
          continue;
        }
        if (!e.puppet) continue;
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
      // The soldiers drawn as models (far ones are figures, not posed).
      for (const [id, e] of entries)
        if (e.puppet?.input && e.lod !== 'far')
          out.set(id, { fingerprint: fingerprint(e.puppet), describe: e.puppet.describe() });
      return out;
    },
    stats: () => ({
      ready: assets !== null,
      failed,
      loadMs: assets?.loadMs ?? 0,
      soldiers: entries.size,
      posed,
      lod: { ...counts },
      models: [...entries.values()].filter((e) => e.puppet !== null).length,
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
      impostors.dispose();
      group.remove(ring);
      ringGeometry.dispose();
      ringMaterial.dispose();
    },
  };
}
