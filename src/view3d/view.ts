import {
  ACESFilmicToneMapping,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Fog,
  Group,
  HemisphereLight,
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import type { Exercise } from '#exercise';
import type { Session } from '#session';
import { heightAt, isOnTerrain, type TerrainDataset } from '#sim';
import type { BattlefieldExtent, GroundAt } from './camera-math';
import { createGeoFeatures, type GeoFeatureLayer } from './geo-features';
import {
  createGenerator,
  GenerationCancelled,
  type GenerationJob,
  type GenerationStage,
} from './generation';
import { landCoverTints } from './landcover';
import { createMarkerLayer } from './markers';
import { plantModels, type PlantModel } from './plant-models';
import { detectQuality, QUALITY_PRESETS, type QualityLevel, type QualityPreset } from './quality';
import { createTacticalCamera, type TacticalCamera } from './tactical-camera';
import { apronElevation, skirtMesh, terrainMesh, type TerrainMeshData } from './terrain-mesh';
import { destinationMarkers, unitMarkers } from './unit-markers';
import { createVegetationLayer, type VegetationLayer } from './vegetation-layer';

// The 3D battlefield view (docs/adr/0029, 0030, 0031): the simulated terrain
// coloured by land cover, the roads, water, buildings and vegetation on it,
// daylight, shadows, sky and fog, the tactical camera, and the soldiers. The
// terrain is drawn at once; roads, water, buildings and vegetation are
// generated in a worker and appear when ready. Like the 2D
// map it renders whatever exercise it is given (live, the scenario preview, or
// an After Action Review frame) and owns no game state: it reads, never writes.

/** Elevation tints for the terrain: sRGB bytes per sample, in heightfield order. */
export type TerrainTints = (terrain: TerrainDataset) => {
  readonly data: ArrayLike<number>;
  readonly channels: 3 | 4;
};

export interface BattlefieldView3dOptions {
  /** The exercise to show now: the same one the 2D map shows. */
  readonly exercise: () => Exercise;
  readonly session: () => Session;
  /** Whether the trainee's squad is hidden (no ORP yet), as on the 2D map. */
  readonly hideTrainee: () => boolean;
  /** Colours for ground with no land cover (e.g. the 2D map's elevation tints). */
  readonly tints?: TerrainTints;
  /** Rendering quality; by default chosen from the GPU. */
  readonly quality?: QualityLevel | 'auto';
}

export interface BattlefieldView3d {
  /** The canvas the view draws into; the caller places it. */
  readonly canvas: HTMLCanvasElement;
  /** Draws a frame from the current exercise. Call once per animation frame while shown. */
  render(): void;
  /** Back to the default overhead view. */
  resetView(): void;
  /** What the view is still preparing, for the user (e.g. "Growing vegetation…"), or null. */
  status(): string | null;
  /** Frees the GPU resources and listeners. The view cannot be used afterwards. */
  dispose(): void;
}

/** What the view knows about one terrain: its mesh, built once. */
interface TerrainEntry {
  readonly terrain: TerrainDataset;
  readonly data: TerrainMeshData;
  readonly mesh: Mesh<BufferGeometry, MeshStandardMaterial>;
  /** Roads, water and buildings, and vegetation, once generated. */
  features: GeoFeatureLayer | null;
  vegetation: VegetationLayer | null;
  /** The generation of features and vegetation for this terrain. */
  readonly job: GenerationJob;
  readonly generation: {
    stage: GenerationStage | 'done' | 'failed';
    /** Worker times per stage, ms. */
    workerMs: { features: number; vegetation: number } | null;
    /** From starting the job to its result arriving, ms. */
    waitMs: number | null;
    /** Main-thread time to turn the result into scene objects, ms. */
    applyMs: number | null;
    /** Main-thread time of shader compilation before showing them, ms (async where supported). */
    compileMs: number | null;
    /** Main-thread time of the frames that first drew them (uploads), ms. */
    revealFrameMs: number[];
    error: string | null;
  };
  /** Time taken to build the terrain mesh (with its land cover), in ms. */
  readonly buildMs: { readonly terrain: number };
  /** The edge walls and the plain around the battlefield (decoration, not simulated ground). */
  readonly surround: Mesh<BufferGeometry, MeshStandardMaterial>[];
  readonly extent: BattlefieldExtent;
  readonly groundAt: GroundAt;
  /** The elevation of the plain round the battlefield. */
  readonly apronZ: number;
  readonly camera: TacticalCamera;
}

/** The sun: from the south-west, 38° above the horizon. */
const SUN_AZIMUTH_DEG = 225;
const SUN_ELEVATION_DEG = 38;
/** Haze on the horizon, matched by the fog. */
const HAZE = new Color(0xc9d4dc);

/** Which vegetation meshes cast and receive shadows at a quality level. */
function vegetationShadows(q: QualityPreset): { cast: boolean; receive: boolean } {
  return { cast: q.shadows !== null, receive: q.shadows?.treesReceive ?? false };
}

export function createBattlefieldView3d(o: BattlefieldView3dOptions): BattlefieldView3d {
  const canvas = document.createElement('canvas');
  canvas.className = 'view3d';
  canvas.setAttribute('aria-label', '3D battlefield view');
  // WebGLRenderer is WebGL 2 only in current Three.js.
  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
    // For water, which takes each pixel once (geo-features.ts).
    stencil: true,
  });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.6;
  // Quality: from the GPU unless given.
  const gl = renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : null;
  let quality: QualityPreset =
    QUALITY_PRESETS[!o.quality || o.quality === 'auto' ? detectQuality(gpu) : o.quality];
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.maxPixelRatio));
  renderer.shadowMap.enabled = quality.shadows !== null;

  const scene = new Scene();
  scene.background = HAZE;

  // Sun direction (Three.js axes: x east, y up, z south).
  const az = (SUN_AZIMUTH_DEG * Math.PI) / 180;
  const el = (SUN_ELEVATION_DEG * Math.PI) / 180;
  const sunDirection = new Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    -Math.cos(az) * Math.cos(el),
  ).normalize();

  const sky = new Sky();
  sky.scale.setScalar(450_000);
  const skyUniforms = sky.material.uniforms as Record<string, { value: unknown }>;
  (skyUniforms['turbidity'] as { value: number }).value = 5;
  (skyUniforms['rayleigh'] as { value: number }).value = 1.4;
  (skyUniforms['mieCoefficient'] as { value: number }).value = 0.004;
  (skyUniforms['mieDirectionalG'] as { value: number }).value = 0.8;
  (skyUniforms['sunPosition'] as { value: Vector3 }).value.copy(sunDirection);
  scene.add(sky);

  const sun = new DirectionalLight(0xfff7ea, 2.6);
  scene.add(sun, sun.target);
  // Shadows are cast only in a square round the camera's focus, which moves
  // with it: enough for the trees and buildings near where one is looking.
  sun.castShadow = quality.shadows !== null;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.4;
  const generator = createGenerator();
  let models: PlantModel[] | null = null;
  const ambient = new HemisphereLight(0xd6e4f0, 0x6f7062, 1.0);
  scene.add(ambient);

  const markers = createMarkerLayer();
  scene.add(markers.group);

  let current: TerrainEntry | null = null;
  /** How many times a terrain's meshes have been built (for checks: once per terrain). */
  let terrainBuilds = 0;
  let width = 0;
  let height = 0;

  /** The terrain's mesh and camera, built the first time it is shown and kept. */
  const terrainEntry = (terrain: TerrainDataset): TerrainEntry => {
    if (current?.terrain === terrain) return current;
    if (current) dropTerrain(current);
    terrainBuilds += 1;
    const started = performance.now();
    const data = terrainMesh(terrain, landCoverTints(terrain, o.tints?.(terrain)));
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(data.normals, 3));
    if (data.colors) geometry.setAttribute('color', new BufferAttribute(data.colors, 3));
    geometry.setIndex(new BufferAttribute(data.indices, 1));
    geometry.computeBoundingSphere();
    const material = new MeshStandardMaterial({
      color: data.colors ? 0xffffff : 0x9aa77e,
      vertexColors: data.colors !== null,
      roughness: 0.95,
      metalness: 0,
    });
    const mesh = new Mesh(geometry, material);
    mesh.name = 'terrain';
    mesh.receiveShadow = true;
    scene.add(mesh);
    const buildMs = { terrain: performance.now() - started };

    const b = data.bounds;
    const extent = { minX: b.minX, maxX: b.maxX, minY: b.minY, maxY: b.maxY };
    const span = Math.max(b.maxX - b.minX, b.maxY - b.minY);

    // The surroundings: walls down from the edge, and a plain beyond it.
    const apronZ = apronElevation(terrain);
    const skirt = skirtMesh(terrain, apronZ);
    const skirtGeometry = new BufferGeometry();
    skirtGeometry.setAttribute('position', new BufferAttribute(skirt.positions, 3));
    skirtGeometry.setAttribute('normal', new BufferAttribute(skirt.normals, 3));
    skirtGeometry.setIndex(new BufferAttribute(skirt.indices, 1));
    const walls = new Mesh(
      skirtGeometry,
      new MeshStandardMaterial({ color: 0x6b6252, roughness: 1, metalness: 0, side: DoubleSide }),
    );
    walls.name = 'terrain edge';
    const apron = new Mesh(
      new CircleGeometry(12 * span, 64).rotateX(-Math.PI / 2),
      new MeshStandardMaterial({ color: 0x59604f, roughness: 1, metalness: 0 }),
    );
    apron.name = 'surroundings';
    apron.position.set((b.minX + b.maxX) / 2, apronZ - 0.05, -(b.minY + b.maxY) / 2);
    scene.add(walls, apron);
    const groundAt: GroundAt = (x, z) =>
      isOnTerrain(terrain, x, -z) ? heightAt(terrain, x, -z) : null;
    // Subtle haze: the far side of a battlefield seen from the default view is just touched.
    scene.fog = new Fog(HAZE, 1.4 * span, 6 * span);
    // The sun lights the whole battlefield from far away.
    const cx = (b.minX + b.maxX) / 2;
    const cz = -(b.minY + b.maxY) / 2;
    sun.position.set(cx, (b.minZ + b.maxZ) / 2, cz).addScaledVector(sunDirection, 4 * span);
    sun.target.position.set(cx, b.minZ, cz);

    const camera = createTacticalCamera(canvas, extent, groundAt, apronZ);
    if (width > 0) camera.resize(width, height);
    // Roads, water, buildings and vegetation, off the main thread.
    const generation: TerrainEntry['generation'] = {
      stage: 'features',
      workerMs: null,
      waitMs: null,
      applyMs: null,
      compileMs: null,
      revealFrameMs: [],
      error: null,
    };
    const jobStarted = performance.now();
    const job = generator.start(terrain, (stage) => {
      generation.stage = stage;
    });
    job.result.then(
      (result) => {
        if (disposed || current?.job !== job) return;
        const entry = current;
        generation.waitMs = performance.now() - jobStarted;
        generation.workerMs = result.ms;
        const applying = performance.now();
        const features = createGeoFeatures(result.features);
        models ??= plantModels();
        const vegetation = createVegetationLayer(
          models,
          result.vegetation.instances,
          quality.vegetation,
          vegetationShadows(quality),
        );
        generation.applyMs = performance.now() - applying;
        // Compile their shaders without blocking (where the browser can),
        // then show them.
        const staging = new Group();
        staging.add(features.group, vegetation.group);
        vegetation.group.traverse((obj) => {
          obj.visible = true;
        });
        const show = () => {
          if (disposed || current !== entry) {
            features.dispose();
            vegetation.dispose();
            return;
          }
          // Features on one frame, vegetation on the next: their buffers
          // are uploaded to the GPU in two smaller steps.
          reveal.push(
            () => {
              entry.features = features;
              scene.add(features.group);
            },
            () => {
              entry.vegetation = vegetation;
              scene.add(vegetation.group);
              generation.stage = 'done';
            },
          );
          revealEntry = entry;
          pendingLayers = [features, vegetation];
        };
        const compiling = performance.now();
        const compiled = renderer.compileAsync(staging, entry.camera.camera, scene);
        generation.compileMs = performance.now() - compiling;
        compiled.then(show, show);
      },
      (error: unknown) => {
        if (error instanceof GenerationCancelled) return;
        generation.stage = 'failed';
        generation.error = error instanceof Error ? error.message : String(error);
      },
    );

    current = {
      terrain,
      data,
      mesh,
      features: null,
      vegetation: null,
      job,
      generation,
      buildMs,
      surround: [walls, apron],
      extent,
      groundAt,
      apronZ,
      camera,
    };
    return current;
  };

  const dropTerrain = (entry: TerrainEntry) => {
    for (const m of [entry.mesh, ...entry.surround]) {
      scene.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
    entry.job.cancel();
    if (revealEntry === entry) {
      // Layers still waiting to be shown are not in the scene: free them here.
      for (const layer of pendingLayers) {
        if (layer !== entry.features && layer !== entry.vegetation) layer.dispose();
      }
      pendingLayers = [];
      reveal = [];
      revealEntry = null;
    }
    if (entry.features) {
      scene.remove(entry.features.group);
      entry.features.dispose();
    }
    if (entry.vegetation) {
      scene.remove(entry.vegetation.group);
      entry.vegetation.dispose();
    }
    entry.camera.dispose();
  };

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (w === width && h === height) return;
    width = w;
    height = h;
    renderer.setSize(w, h, false);
    current?.camera.resize(w, h);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);

  /** Keeps the shadowed square on the camera's focus, sized to the view. */
  const followWithShadows = (entry: TerrainEntry) => {
    const shadows = quality.shadows;
    if (!shadows) return;
    const { target, position } = entry.camera.pose();
    const extent = Math.min(shadows.extent, Math.max(150, 1.3 * position.distanceTo(target)));
    // Moved in whole shadow-map texels, so shadow edges do not shimmer as the camera moves.
    const texel = extent / shadows.mapSize;
    const fx = Math.round(target.x / texel) * texel;
    const fz = Math.round(target.z / texel) * texel;
    const cam = sun.shadow.camera;
    if (cam.right !== extent / 2) {
      cam.left = -extent / 2;
      cam.right = extent / 2;
      cam.top = extent / 2;
      cam.bottom = -extent / 2;
      cam.near = 1;
      cam.far = 4 * extent + 2000;
      cam.updateProjectionMatrix();
    }
    sun.target.position.set(fx, target.y, fz);
    sun.position.set(fx, target.y, fz).addScaledVector(sunDirection, 2 * extent + 1000);
  };
  const applyQuality = (next: QualityPreset) => {
    quality = next;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.maxPixelRatio));
    width = 0; // re-fit the drawing buffer
    renderer.shadowMap.enabled = quality.shadows !== null;
    sun.castShadow = quality.shadows !== null;
    if (quality.shadows) {
      sun.shadow.mapSize.set(quality.shadows.mapSize, quality.shadows.mapSize);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
    // Materials compile differently with and without shadows.
    scene.traverse((obj) => {
      if (obj instanceof Mesh) (obj.material as MeshStandardMaterial).needsUpdate = true;
    });
    current?.vegetation?.setSettings(quality.vegetation, vegetationShadows(quality));
  };
  if (quality.shadows) sun.shadow.mapSize.set(quality.shadows.mapSize, quality.shadows.mapSize);

  /** Generated layers being shown, one step per frame, and what they belong to. */
  let reveal: (() => void)[] = [];
  let revealEntry: TerrainEntry | null = null;
  let pendingLayers: { dispose(): void }[] = [];
  let disposed = false;
  const view: BattlefieldView3d = {
    canvas,
    render() {
      if (disposed) return;
      resize();
      const exercise = o.exercise();
      const entry = terrainEntry(exercise.simulation.world.terrain);
      const step = revealEntry === entry ? reveal.shift() : undefined;
      step?.();
      if (reveal.length === 0) pendingLayers = [];
      const revealing = step !== undefined;
      entry.camera.update();
      entry.vegetation?.update(entry.camera.camera);
      followWithShadows(entry);
      const session = o.session();
      const hide = o.hideTrainee();
      markers.update(
        unitMarkers(exercise, session, hide),
        destinationMarkers(exercise, session, hide),
        entry.camera.camera,
        height,
      );
      const drawing = performance.now();
      renderer.render(scene, entry.camera.camera);
      if (revealing) entry.generation.revealFrameMs.push(performance.now() - drawing);
    },
    resetView() {
      current?.camera.reset();
    },
    status() {
      switch (current?.generation.stage) {
        case 'features':
          return 'Building roads, water and buildings…';
        case 'vegetation':
          return 'Growing vegetation…';
        case 'failed':
          return 'Roads, buildings and vegetation could not be built.';
        default:
          return null;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      if (current) dropTerrain(current);
      current = null;

      generator.dispose();
      sun.shadow.dispose();
      markers.dispose();
      sky.geometry.dispose();
      sky.material.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
  // For automated browser checks: a camera pose in battlefield metres. The
  // camera looks at ground point (x, y) from `distance` metres away, `pitch`
  // degrees down, facing `azimuth` degrees (clockwise from north).
  Object.defineProperty(canvas, 'ambushSetView', {
    value: (x: number, y: number, distance: number, pitch: number, azimuth: number) => {
      if (!current) return;
      const z = current.groundAt(x, -y) ?? current.apronZ;
      const p = (pitch * Math.PI) / 180;
      const a = (azimuth * Math.PI) / 180;
      const back = distance * Math.cos(p);
      current.camera.setPose(
        new Vector3(x, z, -y),
        new Vector3(x - back * Math.sin(a), z + distance * Math.sin(p), -(y - back * Math.cos(a))),
      );
    },
  });
  // For automated browser checks: switch the quality level.
  Object.defineProperty(canvas, 'ambushSetQuality', {
    value: (level: QualityLevel) => {
      applyQuality(QUALITY_PRESETS[level]);
    },
  });
  // For automated browser checks: camera pose and renderer statistics.
  Object.defineProperty(canvas, 'ambushDebug', {
    value: () => {
      const pose = current?.camera.pose();
      return {
        target: pose ? { x: pose.target.x, y: pose.target.y, z: pose.target.z } : null,
        position: pose ? { x: pose.position.x, y: pose.position.y, z: pose.position.z } : null,
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
        terrainVertices: current?.data.vertexCount ?? 0,
        terrainBuilds,
        features: current?.features?.stats ?? null,
        vegetation: current?.vegetation?.stats() ?? null,
        generation: current?.generation ?? null,
        quality: quality.level,
        gpu,
        // Vertex and index buffers in the scene, in bytes.
        geometryBytes: (() => {
          let bytes = 0;
          scene.traverse((o) => {
            if (!(o instanceof Mesh)) return;
            const g = o.geometry as BufferGeometry;
            for (const a of Object.values(g.attributes)) bytes += a.array.byteLength;
            bytes += g.index?.array.byteLength ?? 0;
            if (o instanceof InstancedMesh) {
              bytes += o.instanceMatrix.array.byteLength + (o.instanceColor?.array.byteLength ?? 0);
            }
          });
          return bytes;
        })(),
        buildMs: current?.buildMs ?? null,
        bounds: current?.data.bounds ?? null,
        markers: markers.group.children.length,
        clearance:
          pose && current
            ? pose.position.y -
              (current.groundAt(pose.position.x, pose.position.z) ?? current.apronZ)
            : null,
        // Marker feet back in battlefield metres, beside the simulated positions.
        soldiers: o.exercise().simulation.state.soldiers.map((s) => {
          const m = markers.positions().get(s.id);
          return {
            id: s.id,
            sim: { x: s.position.x, y: s.position.y, z: s.position.z },
            marker: m ? { x: m.x, y: -m.z, z: m.y, lying: m.lying } : null,
          };
        }),
      };
    },
  });
  return view;
}
