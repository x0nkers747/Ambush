/**
 * Benchmarks: N soldiers playing the test sequence at staggered times, in a
 * minimal scene or an Ambush!-representative one (uneven ground, the game's
 * trees, shadows), measured over real browser frames.
 *
 * Modes:
 * - `native`: an AnimationMixer per soldier, every frame (candidate A).
 * - `native-lod`: the same, updated every frame within 20 m of the camera,
 *   every 2nd frame to 50 m and every 4th beyond (possible only because the
 *   pose is a function of time: skipped frames need no catching up).
 * - `native-shared`: K = 8 animated "pose slots"; every soldier's skinned
 *   mesh is bound to a slot's skeleton (bind mode "detached"), so per-soldier
 *   cost is only drawing.
 * - `animouse`: animouse machines per soldier (candidate B).
 * - `instanced`: @three.ez/instanced-mesh (InstancedMesh2) — one draw call;
 *   one driver rig is posed per instance and its bones written with
 *   `setBonesAt` (candidate E).
 * - `instanced-shared`: InstancedMesh2 with 8 pose slots (8 mixer evaluations,
 *   N bone-texture writes).
 */

import { InstancedMesh2 } from '@three.ez/instanced-mesh';
import * as THREE from 'three';
import type { AssetSet, CharacterId } from './assets';
import { createSoldier, placeSoldier, postProcess, type SoldierView } from './character';
import { createForest } from './forest';
import { poseInputAt } from './pose-input';
import { animouseRuntime } from './runtimes/animouse';
import { nativeRuntime } from './runtimes/native';
import type { Animator } from './runtimes/types';
import { type Stage, unevenHeight } from './scene';
import { recordTestSequence, type SimFrame } from './sim';
import type { WeaponInstance } from './weapons';

export type BenchMode =
  'native' | 'native-lod' | 'native-shared' | 'animouse' | 'instanced' | 'instanced-shared';

export interface BenchConfig {
  n: number;
  mode: BenchMode;
  scene: 'plane' | 'terrain';
  shadows: boolean;
  /** Rifle, hand IK and spine aim on every soldier (not available instanced). */
  weapons: boolean;
  character?: CharacterId;
  warmupMs?: number;
  measureMs?: number;
}

interface Stat {
  mean: number;
  p95: number;
}

export interface BenchResult {
  config: BenchConfig;
  frames: number;
  frame: Stat;
  anim: Stat;
  render: Stat;
  gpu: Stat | null;
  calls: number;
  triangles: number;
  createMs: number;
  firstFrameMs: number;
  seekMsPerSoldier: number;
  heapMB: number | null;
  heapDeltaMB: number | null;
}

const SLOTS = 8;
const stat = (a: number[]): Stat => {
  if (a.length === 0) return { mean: 0, p95: 0 };
  const s = [...a].sort((x, y) => x - y);
  return {
    mean: a.reduce((x, y) => x + y, 0) / a.length,
    p95: s[Math.floor(s.length * 0.95)] ?? 0,
  };
};
const heap = () => {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return m ? m.usedJSHeapSize / 1048576 : null;
};
const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));

interface Unit {
  view: SoldierView | null;
  animator: Animator | null;
  offset: number;
  x: number;
  y: number;
}

export async function runBenchmark(
  stage: Stage,
  assets: AssetSet,
  cfg: BenchConfig,
  extra: { makeWeapon: (w: 'm16') => WeaponInstance | null; loop: () => void },
): Promise<BenchResult> {
  const renderer = stage.renderer;
  renderer.setAnimationLoop(null);
  const asset = assets.characters[cfg.character ?? 'rocketbox'] ?? assets.characters.rocketbox;
  const frames: SimFrame[] = recordTestSequence();
  const height = cfg.scene === 'terrain' ? unevenHeight : () => 0;

  // Scene: same light and fog as the comparison page.
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xb9cde0);
  scene.fog = new THREE.Fog(0xb9cde0, 80, 400);
  scene.add(new THREE.HemisphereLight(0xdfe9f5, 0x5b5140, 1.1));
  const sun = new THREE.DirectionalLight(0xfff2dd, 2.6);
  sun.castShadow = cfg.shadows;
  sun.shadow.mapSize.set(2048, 2048);
  const ext = 40;
  Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, far: 150 });
  sun.position.set(30, 50, 20);
  scene.add(sun, sun.target);
  const groundGeo = new THREE.PlaneGeometry(
    500,
    500,
    cfg.scene === 'terrain' ? 250 : 1,
    cfg.scene === 'terrain' ? 250 : 1,
  );
  groundGeo.rotateX(-Math.PI / 2);
  const gp = groundGeo.attributes['position'] as THREE.BufferAttribute;
  for (let i = 0; i < gp.count; i++) gp.setY(i, height(gp.getX(i), -gp.getZ(i)));
  groundGeo.computeVertexNormals();
  const ground = new THREE.Mesh(
    groundGeo,
    new THREE.MeshStandardMaterial({ color: 0x6f7a55, roughness: 0.95 }),
  );
  ground.receiveShadow = true;
  scene.add(ground);
  if (cfg.scene === 'terrain') {
    const forest = createForest(height);
    scene.add(forest.group);
    await forest.loaded;
  }

  // Layout: a square block, 2 m spacing, centred on the origin.
  const cols = Math.ceil(Math.sqrt(cfg.n));
  const units: Unit[] = [];
  const heap0 = heap();
  const c0 = performance.now();
  for (let i = 0; i < cfg.n; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    units.push({
      view: null,
      animator: null,
      offset: (i * 1.37) % 38,
      x: (col - (cols - 1) / 2) * 2,
      y: (row - (cols - 1) / 2) * 2,
    });
  }

  // Shared-pose slots (native-shared, instanced-shared) and the instanced driver.
  const slotViews: SoldierView[] = [];
  const slotAnimators: Animator[] = [];
  let instanced: InstancedMesh2[] = [];
  const mode = cfg.mode;
  const needsSlots =
    mode === 'native-shared' || mode === 'instanced-shared' || mode === 'instanced';
  if (needsSlots) {
    const k = mode === 'instanced' ? 1 : SLOTS;
    for (let s = 0; s < k; s++) {
      const v = createSoldier(asset);
      v.root.visible = false;
      scene.add(v.root);
      slotViews.push(v);
      slotAnimators.push(nativeRuntime.create(v, frames));
    }
  }

  if (mode === 'native' || mode === 'native-lod' || mode === 'animouse') {
    const rt = mode === 'animouse' ? animouseRuntime : nativeRuntime;
    for (const u of units) {
      u.view = createSoldier(asset);
      if (cfg.weapons) {
        u.view.weapon = extra.makeWeapon('m16');
        if (u.view.weapon) scene.add(u.view.weapon.object);
      }
      scene.add(u.view.root);
      u.animator = rt.create(u.view, frames);
    }
  } else if (mode === 'native-shared') {
    // Each soldier: the template's meshes (shared geometry and material)
    // bound to a slot's skeleton, placed by its own group.
    units.forEach((u, i) => {
      const slot = slotViews[i % SLOTS];
      if (!slot) return;
      const g = new THREE.Group();
      for (const sm of slot.skinned) {
        const m = new THREE.SkinnedMesh(sm.geometry, sm.material);
        m.bindMode = THREE.DetachedBindMode;
        m.bind(sm.skeleton, sm.bindMatrix);
        m.matrixAutoUpdate = false;
        m.matrix.copy(sm.bindMatrix);
        m.castShadow = true;
        m.frustumCulled = false;
        g.add(m);
      }
      g.position.set(u.x, height(u.x, u.y), -u.y);
      scene.add(g);
    });
  } else {
    // InstancedMesh2: geometry pre-transformed by the bind matrix (it skins
    // without one); one InstancedMesh2 per skinned part.
    const driver = slotViews[0];
    if (!driver) throw new Error('no driver');
    instanced = driver.skinned.map((sm) => {
      const geo = sm.geometry.clone();
      geo.applyMatrix4(sm.bindMatrix);
      const im = new InstancedMesh2(geo, sm.material as THREE.Material, { capacity: cfg.n });
      im.initSkeleton(sm.skeleton);
      im.addInstances(cfg.n, (obj, i) => {
        const u = units[i];
        if (!u) return;
        obj.position.set(u.x, height(u.x, u.y), -u.y);
        obj.rotateY(Math.PI - ((i * 0.7) % 6.28));
      });
      im.castShadow = true;
      im.receiveShadow = false;
      scene.add(im);
      return im;
    });
  }
  const createMs = performance.now() - c0;
  const heap1 = heap();

  // Camera: tactical oblique view over the block.
  const cam = stage.camera;
  const saved = { p: cam.position.clone(), t: stage.controls.target.clone() };
  const span = Math.max(6, cols * 2);
  cam.position.set(span * 0.55, span * 0.7 + 4, span * 0.9 + 4);
  cam.lookAt(0, 0, 0);

  const gl = renderer.getContext() as WebGL2RenderingContext;
  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2') as {
    TIME_ELAPSED_EXT: number;
    GPU_DISJOINT_EXT: number;
  } | null;
  const pending: WebGLQuery[] = [];
  const gpu: number[] = [];
  const collect = () => {
    while (pending.length) {
      const q = pending[0];
      if (!q || !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      pending.shift();
      if (timer && !gl.getParameter(timer.GPU_DISJOINT_EXT))
        gpu.push(Number(gl.getQueryParameter(q, gl.QUERY_RESULT)) / 1e6);
      gl.deleteQuery(q);
    }
  };

  let frameIndex = 0;
  const camPos = cam.position;
  let lastT = -1;
  const animate = (t: number) => {
    frameIndex++;
    // Stateful runtimes (animouse) need the true step; a mismatch counts as a seek.
    const step = lastT < 0 ? 0 : t - lastT;
    lastT = t;
    if (mode === 'native-shared' || mode === 'instanced-shared') {
      slotAnimators.forEach((a, s) => {
        const v = slotViews[s];
        if (!v) return;
        const input = { ...poseInputAt(frames, (t + s * 4.7) % 40), x: 0, y: 0, azimuth: 0 };
        placeSoldier(v, input, 0);
        a.update(input, { dt: 1 / 60, seeked: false, frames });
        v.root.updateMatrixWorld(true);
      });
      if (mode === 'instanced-shared') {
        // For each slot, write its pose into its instances' bone rows.
        for (let s = 0; s < SLOTS; s++) {
          const v = slotViews[s];
          if (!v) continue;
          instanced.forEach((im, part) => {
            const sk = v.skinned[part]?.skeleton;
            if (!sk) return;
            // The driver skeleton for this part is the slot's: point at it.
            (im as unknown as { skeleton: THREE.Skeleton }).skeleton = sk;
            for (let i = s; i < cfg.n; i += SLOTS) im.setBonesAt(i, i === s);
          });
        }
      }
      return;
    }
    if (mode === 'instanced') {
      const v = slotViews[0];
      const a = slotAnimators[0];
      if (!v || !a) return;
      for (let i = 0; i < cfg.n; i++) {
        const u = units[i];
        if (!u) continue;
        const input = { ...poseInputAt(frames, (t + u.offset) % 40), x: 0, y: 0, azimuth: 0 };
        a.update(input, { dt: 0, seeked: true, frames });
        v.root.updateMatrixWorld(true);
        instanced.forEach((im, part) => {
          im.setBonesAt(i, part === 0);
        });
      }
      return;
    }
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (!u?.view || !u.animator) continue;
      const base = poseInputAt(frames, (t + u.offset) % 40);
      const input = { ...base, x: u.x + base.x * 0, y: u.y };
      if (mode === 'native-lod') {
        const d = camPos.distanceTo(u.view.root.position);
        const every = d < 20 ? 1 : d < 50 ? 2 : 4;
        if ((frameIndex + i) % every !== 0) continue;
      }
      placeSoldier(u.view, input, height(input.x, input.y));
      u.animator.update(input, { dt: step, seeked: false, frames });
      if (cfg.weapons)
        postProcess(
          u.view,
          input,
          { ik: 'two-bone', footIk: cfg.scene === 'terrain', weaponHold: true, spineAim: true },
          height,
          cfg.scene !== 'terrain',
        );
    }
  };

  // First frame (shader compilation, uploads).
  const f0 = performance.now();
  animate(5);
  renderer.render(scene, cam);
  gl.finish();
  const firstFrameMs = performance.now() - f0;

  // Seek cost per soldier (time jump on every animator).
  let seekMsPerSoldier = 0;
  if (units[0]?.animator) {
    const sample = units.slice(0, Math.min(10, units.length));
    const s0 = performance.now();
    for (const u of sample) {
      if (!u.view || !u.animator) continue;
      const input = { ...poseInputAt(frames, 30), x: u.x, y: u.y };
      u.animator.update(input, { dt: 0, seeked: true, frames });
    }
    seekMsPerSoldier = (performance.now() - s0) / sample.length;
  }

  const frameTimes: number[] = [];
  const animTimes: number[] = [];
  const renderTimes: number[] = [];
  const warm = cfg.warmupMs ?? 1500;
  const measure = cfg.measureMs ?? 4000;
  // Warm up for at least `warm` ms and 30 frames (shader compilation can
  // stall the first frames for seconds), then measure for `measure` ms.
  let last = await nextFrame();
  let simT = 5;
  let calls = 0;
  let triangles = 0;
  let warmFrames = 0;
  const warmStart = performance.now();
  let measureStart = -1;
  for (;;) {
    const now = await nextFrame();
    const measuring = measureStart >= 0;
    if (!measuring && performance.now() - warmStart >= warm && warmFrames >= 30) measureStart = now;
    if (measureStart >= 0 && now - measureStart > measure) break;
    warmFrames++;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    simT += dt;
    const a0 = performance.now();
    animate(simT);
    const a1 = performance.now();
    let q: WebGLQuery | null = null;
    if (timer && measuring) {
      q = gl.createQuery();
      gl.beginQuery(timer.TIME_ELAPSED_EXT, q);
    }
    renderer.render(scene, cam);
    if (q && timer) {
      gl.endQuery(timer.TIME_ELAPSED_EXT);
      pending.push(q);
    }
    const r1 = performance.now();
    collect();
    if (measuring) {
      frameTimes.push(dt * 1000);
      animTimes.push(a1 - a0);
      renderTimes.push(r1 - a1);
      calls = renderer.info.render.calls;
      triangles = renderer.info.render.triangles;
    }
  }
  for (let i = 0; i < 30 && pending.length; i++) {
    await nextFrame();
    collect();
  }

  // Tear down.
  for (const u of units) u.animator?.dispose();
  for (const a of slotAnimators) a.dispose();
  for (const im of instanced) im.dispose();
  groundGeo.dispose();
  cam.position.copy(saved.p);
  stage.controls.target.copy(saved.t);
  stage.controls.update();
  renderer.setAnimationLoop(extra.loop);
  return {
    config: cfg,
    frames: frameTimes.length,
    frame: stat(frameTimes),
    anim: stat(animTimes),
    render: stat(renderTimes),
    gpu: gpu.length ? stat(gpu) : null,
    calls,
    triangles,
    createMs,
    firstFrameMs,
    seekMsPerSoldier,
    heapMB: heap1,
    heapDeltaMB: heap0 !== null && heap1 !== null ? heap1 - heap0 : null,
  };
}
