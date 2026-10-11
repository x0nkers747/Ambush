import {
  ACESFilmicToneMapping,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Fog,
  HemisphereLight,
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
import { landCoverTints } from './landcover';
import { createMarkerLayer } from './markers';
import { createTacticalCamera, type TacticalCamera } from './tactical-camera';
import { apronElevation, skirtMesh, terrainMesh, type TerrainMeshData } from './terrain-mesh';
import { destinationMarkers, unitMarkers } from './unit-markers';

// The 3D battlefield view (docs/adr/0029, docs/adr/0030): the simulated
// terrain coloured by land cover, the roads, water and buildings on it,
// daylight, sky and fog, the tactical camera, and the soldiers. Like the 2D
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
}

export interface BattlefieldView3d {
  /** The canvas the view draws into; the caller places it. */
  readonly canvas: HTMLCanvasElement;
  /** Draws a frame from the current exercise. Call once per animation frame while shown. */
  render(): void;
  /** Back to the default overhead view. */
  resetView(): void;
  /** Frees the GPU resources and listeners. The view cannot be used afterwards. */
  dispose(): void;
}

/** What the view knows about one terrain: its mesh, built once. */
interface TerrainEntry {
  readonly terrain: TerrainDataset;
  readonly data: TerrainMeshData;
  readonly mesh: Mesh<BufferGeometry, MeshStandardMaterial>;
  /** Roads, water and buildings. */
  readonly features: GeoFeatureLayer;
  /** Time taken to build the terrain mesh (with its land cover) and the features, in ms. */
  readonly buildMs: { readonly terrain: number; readonly features: number };
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
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

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
    scene.add(mesh);
    const terrainMs = performance.now() - started;
    const features = createGeoFeatures(terrain, data.normals);
    scene.add(features.group);
    const buildMs = { terrain: terrainMs, features: performance.now() - started - terrainMs };

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
    current = {
      terrain,
      data,
      mesh,
      features,
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
    scene.remove(entry.features.group);
    entry.features.dispose();
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

  let disposed = false;
  const view: BattlefieldView3d = {
    canvas,
    render() {
      if (disposed) return;
      resize();
      const exercise = o.exercise();
      const entry = terrainEntry(exercise.simulation.world.terrain);
      entry.camera.update();
      const session = o.session();
      const hide = o.hideTrainee();
      markers.update(
        unitMarkers(exercise, session, hide),
        destinationMarkers(exercise, session, hide),
        entry.camera.camera,
        height,
      );
      renderer.render(scene, entry.camera.camera);
    },
    resetView() {
      current?.camera.reset();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      if (current) dropTerrain(current);
      current = null;
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
        features: current?.features.stats ?? null,
        // Vertex and index buffers in the scene, in bytes.
        geometryBytes: (() => {
          let bytes = 0;
          scene.traverse((o) => {
            if (!(o instanceof Mesh)) return;
            const g = o.geometry as BufferGeometry;
            for (const a of Object.values(g.attributes)) bytes += a.array.byteLength;
            bytes += g.index?.array.byteLength ?? 0;
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
