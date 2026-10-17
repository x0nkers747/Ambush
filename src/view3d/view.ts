import {
  ACESFilmicToneMapping,
  type BufferGeometry,
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  InstancedMesh,
  Mesh,
  type MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import {
  COMBAT_WEAPONS,
  groundFieldInput,
  isOnTerrain,
  surfaceHeightAt,
  type TerrainDataset,
} from '#sim';
import {
  compileField,
  createSurface,
  deckIndex,
  DEFAULT_FIELD_SPEC,
  type DeckIndex,
  type TerrainField,
  type TerrainSurface,
} from '#sim/terrain-field';
import { createBridgeDecks, type BridgeDecks } from './bridge-decks';
import { terrainGround, type BattlefieldExtent, type GroundAt } from './camera-math';
import { createClutter, type Clutter } from './clutter';
import { createForest } from './forest';
import { createGeoFeatures, type GeoFeatureLayer } from './geo-features';
import {
  createGenerator,
  GenerationCancelled,
  type GenerationJob,
  type GenerationStage,
} from './generation';
import { loadGroundTextures, placeholderTextures, type GroundTextures } from './ground-textures';
import {
  groundProjection,
  type GroundProjection,
  type MapPoint,
  type ScreenPoint,
} from './ground-projection';
import { createMotionRecorder, emptyMotionSample } from '#exercise';
import { benchCrowd, type BenchCrowd } from './characters/bench';
import { type AnimationClock, createAftermath, createCharacterLayer } from './characters/layer';
import { SUN_DEPTH_BIAS_M, SUN_NORMAL_BIAS } from './characters/shadow';
import { createEarthworksLayer, type ViewEarthwork } from './earthworks';
import { createVehicleLayer, type ViewVehicle } from './vehicles';
import { createImpactLayer } from './impacts';
import { createTracerLayer } from './tracers';
import { createHeavyEffectsLayer } from './heavy-effects';
import { createMarkerLayer } from './markers';
import {
  detectQuality,
  isSoftwareRenderer,
  QUALITY_PRESETS,
  type QualityLevel,
  type QualityPreset,
} from './quality';
import { installShadowEdgeFade } from './shadow-fade';
import { apronElevation, surroundings } from './surroundings';
import { createTacticalCamera, type TacticalCamera } from './tactical-camera';
import {
  createTerrainRenderer,
  type GroundOverlay,
  type TerrainRenderer,
} from './terrain-renderer';
import { createTilePool, type TilePool } from './tile-pool';
import type { UnitMarker } from './unit-markers';
import type { VegetationLayer } from './vegetation-layer';
import { createWaterSurface, type WaterSurface } from './water-surface';

// The 3D battlefield view (docs/adr/0029, 0030, 0031, 0049): the ground drawn
// from the terrain field the simulation's ground is sampled from (tiles made
// by workers, CDLOD, materials from the field: roads, shores, land cover), its
// water, bridge decks and grass; the buildings, road markings and vegetation
// on it; daylight, shadows, sky and fog, the tactical camera, and the
// soldiers. The ground appears once the tile workers have compiled the field;
// buildings and vegetation are generated in a worker and appear when ready.
// It shows the terrain it is given and the soldiers its owner gives it
// (`figures`: a battle's, live or replayed), and owns no game state: it
// reads, never writes.

/** The clock of no soldiers (an empty motion log), for a view given none. */
const NO_SOLDIERS: AnimationClock = { log: createMotionRecorder(30), combatLog: [], seconds: 0 };

export interface BattlefieldView3dOptions {
  /** The battlefield's terrain: the same the 2D map shows. */
  readonly terrain: TerrainDataset;
  /** Rendering quality; by default chosen from the GPU. */
  readonly quality?: QualityLevel | 'auto';
  /**
   * Animated soldiers (default), or the simple markers alone (`false`; also
   * `?characters=off` in the page's address). Until the soldier models have
   * loaded, and if they cannot be, markers stand in.
   */
  readonly characters?: boolean;
  /** Where the soldier models are (the folder holding `rocketbox/` and `weapons/`). */
  readonly characterAssets?: string;
  /**
   * The soldiers to show now (a battle's, docs/constructive-simulation/03),
   * and what poses them (docs/character-animation.md); `null`: none.
   */
  readonly figures?: () => ViewFigures | null;
}

/** Soldiers the view is given to show: where they are, what poses them, what they carry. */
export interface ViewFigures {
  readonly units: readonly UnitMarker[];
  readonly clock: AnimationClock;
  /** The weapon each soldier carries (display model), by soldier id. */
  readonly weapons: Readonly<Record<string, string | null>>;
  /** Fighting positions dug by defences (docs/behavior-lab/force-on-force/09), drawn on the ground. */
  readonly earthworks?: readonly ViewEarthwork[];
  /** Vehicles (docs/vehicles.md), posed from the clock's motion log. */
  readonly vehicles?: readonly ViewVehicle[];
}

/**
 * Pointer input the view hands over (docs/adr/0039), in CSS pixels of its
 * canvas. A left press the handler claims becomes its drag, and the camera
 * does not move; any other press is the camera's (orbit, pan), and if the
 * pointer comes up without having moved, it is a click.
 */
export interface PointerHandler {
  /** A press: `true` claims it (a handle drag). */
  press(screen: ScreenPoint, button: number): boolean;
  drag(screen: ScreenPoint): void;
  release(screen: ScreenPoint): void;
  click(screen: ScreenPoint, button: number): void;
  /** The cursor for a hover. */
  hover(screen: ScreenPoint): string;
}

/**
 * How far the view has loaded, as it stands (docs/loading-overlay.md): each
 * part that appears after the view itself, done or not. `done` once all are
 * (or one failed: nothing more is coming).
 */
export interface ViewLoading {
  /** The ground mesh (once the workers have compiled the terrain field). */
  readonly ground: boolean;
  /** Buildings, roads and the like, and the vegetation, in the scene. */
  readonly features: boolean;
  readonly vegetation: boolean;
  /** The ground's material textures. */
  readonly textures: boolean;
  /** Ground tiles still awaited for this camera (0 once the finest near it are in). */
  readonly tilesWaiting: number;
  /** The soldiers' models, when there are soldiers to show (else `true`). */
  readonly characters: boolean;
  readonly done: boolean;
}

export interface BattlefieldView3d {
  /** The canvas the view draws into; the caller places it. */
  readonly canvas: HTMLCanvasElement;
  /** How far it has loaded (for a progress bar until it is all in). */
  loading(): ViewLoading;
  /** A transparent canvas for 2D overlays over the view, the same size; the caller places it above `canvas`. */
  readonly overlay: HTMLCanvasElement;
  /** Draws a frame. Call once per animation frame while shown. */
  render(): void;
  /** The ground as a map projection, as the camera stands now (`GroundProjection`). */
  projection(): GroundProjection;
  /** Who gets clicks and drags on the view; `null`: the camera alone. */
  setPointerHandler(handler: PointerHandler | null): void;
  /** Shows these soldiers (and vehicles) from now on, or none: a view handed from one page to another. */
  setFigures(figures: (() => ViewFigures | null) | null): void;
  /** Draws the 2D overlay after each frame (on `overlay`, cleared first, in CSS pixels). */
  setOverlayPainter(paint: ((ctx: CanvasRenderingContext2D) => void) | null): void;
  /** Paints a raster on the ground (a viewshed), or none; kept across terrain reloads. */
  setGroundOverlay(overlay: GroundOverlay | null): void;
  /** The map point the camera looks at, and how far it is from it (metres), or null before the first frame. */
  focus(): { readonly point: MapPoint; readonly distance: number } | null;
  /** Looks at a map point (keeping the angle), from `distance` metres if given. */
  focusOn(point: MapPoint, distance?: number): void;
  /** The map point and ground elevation under the pointer, or null. */
  readonly pointer: { readonly x: number; readonly y: number; readonly z: number } | null;
  /** Back to the default overhead view. */
  resetView(): void;
  /** What the view is still preparing, for the user (e.g. "Growing vegetation…"), or null. */
  status(): string | null;
  /** A frame drawn now, with the overlay (the tactical picture) over it, at the canvas's resolution. */
  capture(): HTMLCanvasElement;
  /**
   * The camera: it looks at map point (x, y) from `distance` metres away,
   * `pitch` degrees down, facing `azimuth` degrees (clockwise from north).
   */
  view(): {
    readonly x: number;
    readonly y: number;
    readonly distance: number;
    readonly pitch: number;
    readonly azimuth: number;
  } | null;
  /** The camera exactly (scene coordinates), to hand to another view of the terrain; null before the first frame. */
  cameraPose(): CameraPose | null;
  /** Puts the camera where another view's `cameraPose` had it. */
  setCameraPose(pose: CameraPose): void;
  /** Frees the GPU resources and listeners. The view cannot be used afterwards. */
  dispose(): void;
}

/** Where the camera stands and what it looks at, in the 3D scene's coordinates. */
export interface CameraPose {
  readonly target: { readonly x: number; readonly y: number; readonly z: number };
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
}

/** What the view knows about one terrain, built once. */
interface TerrainEntry {
  readonly terrain: TerrainDataset;
  /** The terrain field (docs/adr/0049), compiled here from the terrain's cleaned elevations. */
  readonly field: TerrainField;
  /** Tiles of the field made on this thread, and those adopted from the workers. */
  readonly surface: TerrainSurface;
  /** The workers making the ground's tiles. */
  readonly pool: TilePool;
  /** The ground, once the workers have compiled the field. */
  ground: TerrainRenderer | null;
  readonly water: WaterSurface;
  readonly bridges: BridgeDecks;
  readonly decks: DeckIndex;
  readonly clutter: Clutter;
  /** The ground, its water, bridge decks and grass. */
  readonly group: Group;
  /** Buildings and road markings, and vegetation, once generated. */
  features: GeoFeatureLayer | null;
  vegetation: VegetationLayer | null;
  /** The generation of features and vegetation for this terrain. */
  readonly job: GenerationJob;
  readonly generation: {
    stage: 'ground' | GenerationStage | 'done' | 'failed';
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
  /** Compiling the field on this thread, and in the slowest tile worker, ms. */
  readonly buildMs: { readonly field: number; workers: number | null };
  /** The edge walls and the plain around the battlefield (decoration, not simulated ground). */
  readonly surround: readonly Mesh[];
  readonly extent: BattlefieldExtent;
  readonly groundAt: GroundAt;
  /** The elevation of the plain round the battlefield. */
  readonly apronZ: number;
  readonly camera: TacticalCamera;
  /** When grass was last placed although the finest tiles were still coming, ms. */
  clutterForcedAt: number;
}

/** The sun: from the south-west, 38° above the horizon. */
const SUN_AZIMUTH_DEG = 225;
const SUN_ELEVATION_DEG = 38;
/** Haze on the horizon, matched by the fog. */
const HAZE = new Color(0xc9d4dc);
/** Spacing of the ground's finest lattice, metres (the field is sampled there exactly). */
const GROUND_SPACING_M = 0.5;
/** Grass waits this long for the ground's finest tiles before it is placed anyway, ms. */
const CLUTTER_PATIENCE_MS = 1000;

/** Which vegetation meshes cast and receive shadows: trees shade one another wherever there are shadows. */
function vegetationShadows(q: QualityPreset): { cast: boolean; receive: boolean } {
  return { cast: q.shadows !== null, receive: q.shadows !== null };
}

/** Workers making the ground's tiles: fewer for a dense city, whose field is large to copy. */
function tileWorkers(terrain: TerrainDataset): number {
  const heavy = terrain.features.buildings.length > 20_000;
  return Math.max(1, Math.min(heavy ? 2 : 4, (navigator.hardwareConcurrency || 4) - 1));
}

export function createBattlefieldView3d(o: BattlefieldView3dOptions): BattlefieldView3d {
  installShadowEdgeFade();
  const canvas = document.createElement('canvas');
  canvas.className = 'view3d';
  canvas.setAttribute('aria-label', '3D battlefield view');
  // Tactical overlays (routes, arrows, labels, shots) are drawn on a 2D canvas above.
  const overlay = document.createElement('canvas');
  overlay.className = 'view3d-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  const overlayContext = overlay.getContext('2d');
  let paintOverlay: ((ctx: CanvasRenderingContext2D) => void) | null = null;
  /** The raster painted on the ground (`setGroundOverlay`). */
  let groundOverlay: GroundOverlay | null = null;
  let pointerHandler: PointerHandler | null = null;
  let pointerGround: { x: number; y: number; z: number } | null = null;
  // WebGLRenderer is WebGL 2 only in current Three.js.
  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
    // For water, which takes each pixel once.
    stencil: true,
  });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.8;
  // Quality: from the GPU unless given.
  const gl = renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : null;
  let quality: QualityPreset =
    QUALITY_PRESETS[!o.quality || o.quality === 'auto' ? detectQuality(gpu) : o.quality];
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.maxPixelRatio));
  renderer.shadowMap.enabled = quality.shadows !== null;

  /** The ground's materials: simple on software renderers. */
  const advancedGround = () => quality.ground.advanced && !isSoftwareRenderer(gpu);
  /** Grass and clutter: none on software renderers. */
  const clutterSettings = () => (isSoftwareRenderer(gpu) ? null : quality.ground.clutter);

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
  sun.shadow.normalBias = SUN_NORMAL_BIAS;
  const generator = createGenerator();
  const ambient = new HemisphereLight(0xd6e4f0, 0x6f7062, 1.0);
  scene.add(ambient);

  const markers = createMarkerLayer();
  scene.add(markers.group);
  /** The soldiers shown (`o.figures`, or as set since). */
  let figuresOf = o.figures;
  const charactersOn =
    o.characters ?? new URLSearchParams(location.search).get('characters') !== 'off';
  const characters = charactersOn
    ? createCharacterLayer(o.characterAssets ?? new URL('characters/', document.baseURI).href)
    : null;
  if (characters) scene.add(characters.group);
  const impacts = createImpactLayer();
  const earthworks = createEarthworksLayer();
  scene.add(earthworks.group);
  const vehicles = createVehicleLayer();
  scene.add(vehicles.group);
  scene.add(impacts.group);
  const tracers = createTracerLayer();
  scene.add(tracers.group);
  // Combined arms' fire, missiles, impacts and burning wrecks (docs/combined-arms.md §11).
  const weaponKinds = new Map(COMBAT_WEAPONS.map((w) => [w.id, w.kind as string]));
  const heavy = createHeavyEffectsLayer((w) => weaponKinds.get(w) ?? 'machineGun');
  scene.add(heavy.group);
  const aftermath = createAftermath();
  /** A stand-in crowd for measuring (`ambushBenchCharacters`), replacing the soldiers while set. */
  let bench: { crowd: BenchCrowd; startMs: number } | null = null;
  const benchSample = emptyMotionSample();

  let current: TerrainEntry | null = null;
  /** How many times a terrain's ground has been built (for checks: once per terrain). */
  let terrainBuilds = 0;
  let width = 0;
  let height = 0;
  let disposed = false;

  // The ground's material textures: plain colours until they have loaded.
  let textures: GroundTextures = placeholderTextures();
  let texturesReady = false;
  void loadGroundTextures().then(
    (loaded) => {
      if (disposed) {
        loaded.dispose();
        return;
      }
      textures.dispose();
      textures = loaded;
      texturesReady = true;
      current?.ground?.setTextures(loaded);
      current?.bridges.setTints(loaded.tints);
    },
    (error: unknown) => {
      console.error('The ground textures could not be loaded', error);
    },
  );

  /** Sets the ground's distances and materials, and the grass, from the quality. */
  const applyGroundQuality = (entry: TerrainEntry) => {
    const g = quality.ground;
    if (entry.ground) {
      entry.ground.setLodRange(g.lodRangeM);
      entry.ground.setDetailDistance(g.detailM);
      entry.ground.setAdvanced(advancedGround());
    }
    const clutter = clutterSettings();
    entry.clutter.setVisible(clutter !== null);
    if (clutter) entry.clutter.setSettings(clutter);
  };

  /** The terrain's ground, water, bridges and camera, built the first time it is shown and kept. */
  const terrainEntry = (terrain: TerrainDataset): TerrainEntry => {
    if (current?.terrain === terrain) return current;
    if (current) dropTerrain(current);
    terrainBuilds += 1;
    const started = performance.now();
    // The field from the terrain's cleaned elevations, features and water
    // levels: the one its simulated ground was sampled from.
    const input = groundFieldInput(terrain);
    const field = compileField(input, DEFAULT_FIELD_SPEC);
    const buildMs: TerrainEntry['buildMs'] = { field: performance.now() - started, workers: null };
    const surface = createSurface(field, {
      spacing: GROUND_SPACING_M,
      capacity: 384,
      clock: () => performance.now(),
    });
    const pool = createTilePool(input, DEFAULT_FIELD_SPEC, GROUND_SPACING_M, tileWorkers(terrain));
    const group = new Group();
    group.name = 'ground';
    const water = createWaterSurface(field, terrain.features, input.water);
    group.add(water.mesh);
    const bridges = createBridgeDecks(field);
    if (texturesReady) bridges.setTints(textures.tints);
    group.add(bridges.group);
    const decks = deckIndex(field.roads);
    const clutter = createClutter(surface, group);
    // Nothing grows through a bridge deck that is close over the ground.
    clutter.setCovered((x, y, z) => {
      const deck = decks.topAt(x, y);
      return deck !== null && deck - z < 2;
    });
    scene.add(group);

    const b = field.bounds;
    const extent = { minX: b.minX, maxX: b.maxX, minY: b.minY, maxY: b.maxY };
    const span = Math.max(b.maxX - b.minX, b.maxY - b.minY);
    const apronZ = apronElevation(terrain);
    const surround = surroundings(field, apronZ);
    scene.add(...surround);
    const groundAt: GroundAt = terrainGround(terrain);
    // Subtle haze: the far side of a battlefield seen from the default view is just touched.
    scene.fog = new Fog(HAZE, 1.4 * span, 6 * span);
    // The sun lights the whole battlefield from far away.
    const cx = (b.minX + b.maxX) / 2;
    const cz = -(b.minY + b.maxY) / 2;
    sun.position.set(cx, apronZ, cz).addScaledVector(sunDirection, 4 * span);
    sun.target.position.set(cx, apronZ, cz);

    const camera = createTacticalCamera(canvas, extent, groundAt, apronZ);
    if (width > 0) camera.resize(width, height);
    // Buildings, road markings and vegetation, off the main thread.
    const generation: TerrainEntry['generation'] = {
      stage: 'ground',
      workerMs: null,
      waitMs: null,
      applyMs: null,
      compileMs: null,
      revealFrameMs: [],
      error: null,
    };
    const jobStarted = performance.now();
    const job = generator.start(terrain, (stage) => {
      if (generation.stage !== 'ground') generation.stage = stage;
    });
    const entry: TerrainEntry = {
      terrain,
      field,
      surface,
      pool,
      ground: null,
      water,
      bridges,
      decks,
      clutter,
      group,
      features: null,
      vegetation: null,
      job,
      generation,
      buildMs,
      surround,
      extent,
      groundAt,
      apronZ,
      camera,
      clutterForcedAt: performance.now(),
    };
    current = entry;
    applyGroundQuality(entry);
    // The ground, once every worker has compiled the field.
    pool.ready.then(
      (ms) => {
        if (disposed || current !== entry) return;
        buildMs.workers = ms;
        const ground = createTerrainRenderer(surface, pool, textures);
        entry.ground = ground;
        ground.setOverlay(groundOverlay);
        applyGroundQuality(entry);
        group.add(ground.mesh);
        if (generation.stage === 'ground') generation.stage = entry.features ? 'done' : 'features';
      },
      (error: unknown) => {
        if (disposed || current !== entry) return;
        generation.stage = 'failed';
        generation.error = error instanceof Error ? error.message : String(error);
      },
    );
    job.result.then(
      (result) => {
        if (disposed || current !== entry) return;
        generation.waitMs = performance.now() - jobStarted;
        generation.workerMs = result.ms;
        const applying = performance.now();
        const features = createGeoFeatures(result.features);
        const vegetation = createForest({
          instances: result.vegetation.instances,
          field,
          surface,
          settings: quality.vegetation,
          shadows: vegetationShadows(quality),
          impostors: { renderer, lighting: { sunDirection, sun, ambient } },
        });
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
              if (generation.stage !== 'ground') generation.stage = 'done';
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
    return entry;
  };

  const dropTerrain = (entry: TerrainEntry) => {
    for (const m of entry.surround) {
      scene.remove(m);
      m.geometry.dispose();
      (m.material as MeshStandardMaterial).dispose();
    }
    scene.remove(entry.group);
    entry.pool.dispose();
    entry.ground?.dispose();
    entry.water.dispose();
    entry.bridges.dispose();
    entry.clutter.dispose();
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
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    overlay.width = Math.round(w * ratio);
    overlay.height = Math.round(h * ratio);
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
    // The depth bias in metres, whatever the depth range (shadow.ts).
    sun.shadow.bias = -SUN_DEPTH_BIAS_M / (cam.far - cam.near);
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
    if (current) applyGroundQuality(current);
  };
  if (quality.shadows) sun.shadow.mapSize.set(quality.shadows.mapSize, quality.shadows.mapSize);

  /** Generated layers being shown, one step per frame, and what they belong to. */
  let reveal: (() => void)[] = [];
  let revealEntry: TerrainEntry | null = null;
  let pendingLayers: { dispose(): void }[] = [];
  // --- Pointer input for gameplay (docs/adr/0039) ---------------------------
  // Listened to in the capture phase, before the camera's own listeners: a
  // left press the handler claims (a handle) is stopped there, so the camera
  // does not orbit while a destination or arrow is dragged.
  /** The ground as a map projection, as the camera stands now. */
  const fallbackCamera = new PerspectiveCamera();
  const projectionNow = (): GroundProjection =>
    current
      ? groundProjection(current.camera.camera, current.groundAt, { width, height }, current.apronZ)
      : groundProjection(fallbackCamera, () => null, { width, height }, 0);
  const local = (event: MouseEvent): ScreenPoint => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  /** The press in progress: where it began, its button, whether it moved and whether it was claimed. */
  let gesture: {
    start: ScreenPoint;
    button: number;
    moved: boolean;
    claimed: boolean;
    pointerId: number;
  } | null = null;
  /** Movement in CSS pixels that turns a press into a drag (as on the 2D map). */
  const DRAG_PX = 4;
  const onPointerDown = (event: PointerEvent) => {
    const p = local(event);
    const claimed = pointerHandler?.press(p, event.button) ?? false;
    gesture = { start: p, button: event.button, moved: false, claimed, pointerId: event.pointerId };
    if (claimed) {
      event.stopImmediatePropagation();
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
    }
  };
  const onPointerMove = (event: PointerEvent) => {
    const p = local(event);
    const hit = projectionNow().toWorld(p);
    const z = hit && current ? current.groundAt(hit.x, -hit.y) : null;
    pointerGround = hit && z !== null ? { x: hit.x, y: hit.y, z } : null;
    if (gesture) {
      if (Math.hypot(p.x - gesture.start.x, p.y - gesture.start.y) >= DRAG_PX) gesture.moved = true;
      if (gesture.claimed) {
        event.stopImmediatePropagation();
        pointerHandler?.drag(p);
      }
      return;
    }
    if (pointerHandler) canvas.style.cursor = pointerHandler.hover(p);
  };
  const onPointerUp = (event: PointerEvent) => {
    const g = gesture;
    if (g?.pointerId !== event.pointerId) return;
    gesture = null;
    const p = local(event);
    if (g.claimed) {
      event.stopImmediatePropagation();
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      pointerHandler?.release(p);
    } else if (!g.moved) {
      // A click where the button went down, ignoring jitter (as on the 2D map).
      pointerHandler?.click(g.start, g.button);
    }
    if (pointerHandler) canvas.style.cursor = pointerHandler.hover(p);
  };
  const onPointerCancel = () => {
    gesture = null;
  };
  const onPointerLeave = () => {
    pointerGround = null;
  };
  canvas.addEventListener('pointerdown', onPointerDown, { capture: true });
  canvas.addEventListener('pointermove', onPointerMove, { capture: true });
  canvas.addEventListener('pointerup', onPointerUp, { capture: true });
  canvas.addEventListener('pointercancel', onPointerCancel, { capture: true });
  canvas.addEventListener('pointerleave', onPointerLeave);

  const view: BattlefieldView3d = {
    canvas,
    overlay,
    projection: projectionNow,
    setPointerHandler(handler) {
      pointerHandler = handler;
      gesture = null;
      if (!handler) canvas.style.cursor = '';
    },
    setFigures(next) {
      figuresOf = next ?? undefined;
    },
    setOverlayPainter(paint) {
      paintOverlay = paint;
    },
    setGroundOverlay(overlay) {
      groundOverlay = overlay;
      current?.ground?.setOverlay(overlay);
    },
    focus() {
      if (!current) return null;
      const { target, position } = current.camera.pose();
      return { point: { x: target.x, y: -target.z }, distance: position.distanceTo(target) };
    },
    cameraPose() {
      if (!current) return null;
      const { target, position } = current.camera.pose();
      return {
        target: { x: target.x, y: target.y, z: target.z },
        position: { x: position.x, y: position.y, z: position.z },
      };
    },
    setCameraPose(pose) {
      if (!current) return;
      const { target, position } = pose;
      current.camera.setPose(
        new Vector3(target.x, target.y, target.z),
        new Vector3(position.x, position.y, position.z),
      );
    },
    focusOn(point, distance) {
      if (!current) return;
      const { target, position } = current.camera.pose();
      const offset = position.clone().sub(target);
      if (distance !== undefined && offset.length() > 0) offset.setLength(distance);
      const z = current.groundAt(point.x, -point.y) ?? current.apronZ;
      const nextTarget = new Vector3(point.x, z, -point.y);
      current.camera.setPose(nextTarget, nextTarget.clone().add(offset));
    },
    loading() {
      const entry = current;
      const failed = entry?.generation.stage === 'failed';
      const ground = entry?.ground !== null && entry?.ground !== undefined;
      const features = entry?.features !== null && entry?.features !== undefined;
      const vegetation = entry?.vegetation !== null && entry?.vegetation !== undefined;
      const tilesWaiting = entry?.ground?.stats.waiting ?? 0;
      const wantsCharacters = (figuresOf?.()?.units.length ?? 0) > 0;
      const charactersIn =
        !characters || !wantsCharacters || characters.ready || characters.stats().failed !== null;
      return {
        ground,
        features,
        vegetation,
        textures: texturesReady,
        tilesWaiting,
        characters: charactersIn,
        done:
          failed ||
          (ground && features && vegetation && texturesReady && tilesWaiting === 0 && charactersIn),
      };
    },
    get pointer() {
      return pointerGround;
    },
    render() {
      if (disposed) return;
      resize();
      const terrain = o.terrain;
      const entry = terrainEntry(terrain);
      const step = revealEntry === entry ? reveal.shift() : undefined;
      step?.();
      if (reveal.length === 0) pendingLayers = [];
      const revealing = step !== undefined;
      entry.camera.update();
      const eye = entry.camera.camera;
      entry.ground?.update(eye);
      if (entry.ground && clutterSettings()) {
        // Grass waits for the ground's finest tiles near it, but not for long.
        const now = performance.now();
        const force =
          now - entry.clutterForcedAt > CLUTTER_PATIENCE_MS && entry.ground.stats.waiting > 0;
        if (force) entry.clutterForcedAt = now;
        entry.clutter.update(eye.position.x, -eye.position.z, now / 1000, force);
      }
      entry.vegetation?.update(eye);
      followWithShadows(entry);
      const figures = figuresOf?.() ?? null;
      const units = figures?.units ?? [];
      const surfaceAt = (x: number, y: number) =>
        isOnTerrain(terrain, x, y) ? surfaceHeightAt(terrain, x, y) : Number.NaN;
      const works = figures?.earthworks ?? [];
      earthworks.update(works, surfaceAt);
      if (figures)
        vehicles.update(
          figures.vehicles ?? [],
          figures.clock.log,
          figures.clock.seconds,
          surfaceAt,
        );
      else vehicles.update([], NO_SOLDIERS.log, 0, surfaceAt);
      const worksBySoldier = new Map(works.map((w) => [w.soldierId, w]));
      if (characters?.ready && bench) {
        const { crowd, startMs } = bench;
        const seconds = ((performance.now() - startMs) / 1000) % crowd.seconds;
        const tick = Math.floor(seconds * crowd.log.tickRateHz);
        characters.update({
          units: crowd.units.map((u, i) => {
            const p = crowd.log.read(i, tick, benchSample);
            return { ...u, position: { x: p.x, y: p.y, z: p.z } };
          }),
          clock: { log: crowd.log, combatLog: [], seconds },
          weapons: crowd.weapons,
          surfaceAt,
          camera: eye,
          viewportHeightPx: height,
        });
        markers.update([], eye, height);
      } else if (characters?.ready) {
        // The soldiers are drawn as characters (none without figures).
        const clock = figures?.clock ?? NO_SOLDIERS;
        characters.update({
          units,
          clock: { ...clock, seconds: clock.seconds + aftermath(clock, performance.now()) },
          weapons: figures?.weapons ?? {},
          surfaceAt,
          camera: eye,
          viewportHeightPx: height,
          earthworks: worksBySoldier,
        });
        markers.update([], eye, height);
      } else markers.update(units, eye, height);
      // Tracers and grenade explosions, on the battle's clock.
      if (figures && !bench) {
        impacts.update(figures.clock.combatLog, figures.clock.seconds, surfaceAt, eye.position);
        tracers.update(
          figures.clock.log,
          figures.clock.combatLog,
          figures.clock.seconds,
          surfaceAt,
          eye.position,
        );
        heavy.update(figures.clock.combatLog, figures.clock.seconds, vehicles.wrecks, surfaceAt);
      } else {
        impacts.update([], 0, surfaceAt, eye.position);
        tracers.update(NO_SOLDIERS.log, [], 0, surfaceAt, eye.position);
        heavy.update([], 0, [], surfaceAt);
      }
      const drawing = performance.now();
      renderer.render(scene, eye);
      if (overlayContext) {
        const ratio = overlay.width / Math.max(width, 1);
        overlayContext.setTransform(1, 0, 0, 1, 0, 0);
        overlayContext.clearRect(0, 0, overlay.width, overlay.height);
        if (paintOverlay) {
          overlayContext.setTransform(ratio, 0, 0, ratio, 0, 0);
          paintOverlay(overlayContext);
        }
      }
      if (revealing) entry.generation.revealFrameMs.push(performance.now() - drawing);
    },
    resetView() {
      current?.camera.reset();
    },
    capture() {
      // Drawn and copied in one go (the drawing buffer is not preserved).
      view.render();
      const out = document.createElement('canvas');
      out.width = canvas.width;
      out.height = canvas.height;
      const ctx = out.getContext('2d');
      if (ctx) {
        ctx.drawImage(canvas, 0, 0);
        ctx.drawImage(overlay, 0, 0, out.width, out.height);
      }
      return out;
    },
    view() {
      if (!current) return null;
      const { target, position } = current.camera.pose();
      const dx = position.x - target.x;
      const dy = position.y - target.y;
      // Map y is north: Three.js -z.
      const dn = -(position.z - target.z);
      const distance = Math.hypot(dx, dy, dn);
      const deg = 180 / Math.PI;
      return {
        x: target.x,
        y: -target.z,
        distance,
        pitch: Math.asin(Math.max(-1, Math.min(1, dy / Math.max(distance, 1e-6)))) * deg,
        azimuth: (Math.atan2(-dx, -dn) * deg + 360) % 360,
      };
    },
    status() {
      switch (current?.generation.stage) {
        case 'ground':
          return 'Building the ground…';
        case 'features':
          return 'Building the buildings…';
        case 'vegetation':
          return 'Growing vegetation…';
        case 'failed':
          return 'The ground, buildings or vegetation could not be built.';
        default:
          return null;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown, { capture: true });
      canvas.removeEventListener('pointermove', onPointerMove, { capture: true });
      canvas.removeEventListener('pointerup', onPointerUp, { capture: true });
      canvas.removeEventListener('pointercancel', onPointerCancel, { capture: true });
      canvas.removeEventListener('pointerleave', onPointerLeave);
      overlay.remove();
      if (current) dropTerrain(current);
      current = null;

      generator.dispose();
      textures.dispose();
      sun.shadow.dispose();
      markers.dispose();
      impacts.dispose();
      earthworks.dispose();
      vehicles.dispose();
      tracers.dispose();
      heavy.dispose();
      characters?.dispose();
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
  // For automated browser checks: where a map point (on the ground, raised
  // `lift` metres) is on the canvas, in CSS pixels, as clicks see it.
  Object.defineProperty(canvas, 'ambushProject', {
    value: (x: number, y: number, lift = 0) => projectionNow().toScreen({ x, y }, lift),
  });
  // For automated browser checks: show or hide the vegetation, buildings and grass (to see the ground).
  Object.defineProperty(canvas, 'ambushShowLayers', {
    value: (o: {
      vegetation?: boolean;
      features?: boolean;
      clutter?: boolean;
      water?: boolean;
      ground?: boolean;
    }) => {
      if (!current) return;
      if (o.water !== undefined) current.water.mesh.visible = o.water;
      if (o.ground !== undefined && current.ground) current.ground.mesh.visible = o.ground;
      if (o.vegetation !== undefined && current.vegetation)
        current.vegetation.group.visible = o.vegetation;
      if (o.features !== undefined && current.features) current.features.group.visible = o.features;
      if (o.clutter !== undefined) current.clutter.setVisible(o.clutter);
    },
  });
  // For automated browser checks: a frame drawn and read back at once, as a JPEG data URL.
  Object.defineProperty(canvas, 'ambushCapture', {
    value: () => {
      view.render();
      return canvas.toDataURL('image/jpeg', 0.9);
    },
  });
  // For automated browser checks: each posed soldier's pose fingerprint (the
  // numbers of its root, bones, weapon and clips) and its playing clips.
  Object.defineProperty(canvas, 'ambushCharacters', {
    value: () => {
      const prints = characters?.fingerprints();
      if (!prints) return {};
      return Object.fromEntries(
        [...prints].map(([id, f]) => [
          id,
          {
            numbers: Array.from(f.fingerprint.numbers),
            state: f.fingerprint.state,
            describe: f.describe,
          },
        ]),
      );
    },
  });
  // For automated performance checks: `count` stand-in soldiers walking round
  // the camera's focus in place of the exercise's (0: back to the exercise).
  Object.defineProperty(canvas, 'ambushBenchCharacters', {
    value: (count: number) => {
      const target = current?.camera.pose().target;
      if (!current || !target || count <= 0) {
        bench = null;
        return;
      }
      const terrain = o.terrain;
      bench = {
        crowd: benchCrowd(count, { x: target.x, y: -target.z }, (x, y) =>
          isOnTerrain(terrain, x, y) ? surfaceHeightAt(terrain, x, y) : Number.NaN,
        ),
        startMs: performance.now(),
      };
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
        terrainBuilds,
        ground: current
          ? {
              ready: current.ground !== null,
              textures: texturesReady,
              advanced: advancedGround(),
              stats: current.ground?.stats ?? null,
              clutter: current.clutter.stats,
              field: current.field.stats,
              buildMs: current.buildMs,
            }
          : null,
        features: current?.features?.stats ?? null,
        vegetation: current?.vegetation?.stats() ?? null,
        generation: current?.generation ?? null,
        quality: quality.level,
        gpu,
        // Vertex and index buffers in the scene, in bytes.
        geometryBytes: (() => {
          let bytes = 0;
          scene.traverse((obj) => {
            if (!(obj instanceof Mesh)) return;
            const g = obj.geometry as BufferGeometry;
            for (const a of Object.values(g.attributes)) bytes += a.array.byteLength;
            bytes += g.index?.array.byteLength ?? 0;
            if (obj instanceof InstancedMesh) {
              bytes +=
                obj.instanceMatrix.array.byteLength + (obj.instanceColor?.array.byteLength ?? 0);
            }
          });
          return bytes;
        })(),
        bounds: current?.extent ?? null,
        markers: markers.group.children.length,
        tracers: tracers.inFlight,
        explosions: impacts.active,
        characters: characters?.stats() ?? null,
        clearance:
          pose && current
            ? pose.position.y -
              (current.groundAt(pose.position.x, pose.position.z) ?? current.apronZ)
            : null,
        // Marker (or character) feet back in battlefield metres, beside the simulated positions.
        soldiers: (figuresOf?.()?.units ?? []).map((s) => {
          const m = (characters?.ready ? characters.positions() : markers.positions()).get(s.id);
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
