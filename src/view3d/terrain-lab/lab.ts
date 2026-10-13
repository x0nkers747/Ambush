import {
  ACESFilmicToneMapping,
  CircleGeometry,
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { cleanTerrain, waterLevels, type SourceCorrections, type TerrainDataset } from '#sim';
import {
  compileField,
  createSurface,
  deckIndex,
  DEFAULT_FIELD_SPEC,
  structureTerrain,
  TERRAIN_FIELD_VERSION,
  tileHash,
  type DeckIndex,
  type FieldInput,
  type FieldSpec,
  type Rect,
  type SurfaceTile,
  type TerrainField,
  type TerrainSurface,
} from '#sim/terrain-lab';
import { detectQuality, QUALITY_PRESETS, type QualityPreset } from '../quality';
import { createClutter, CLUTTER_QUALITY, type Clutter } from './clutter';
import { hashPackage } from './determinism';
import { createCurrentScene, type CurrentScene } from './current-scene';
import { loadGroundTextures, placeholderTextures, type GroundTextures } from './ground-textures';
import { createLabCamera, EYE_HEIGHT_M, type CameraMode, type LabCamera } from './lab-camera';
import { createLabBridges, type LabBridges } from './lab-bridges';
import { createLabStructures, type LabStructures } from './lab-structures';
import { bridgeViewpoint, findViewpoints, type Viewpoint } from './presets';
import { createTerrainRenderer, type DebugView, type TerrainRenderer } from './terrain-renderer';
import { DETAIL_DEFAULT_M } from './terrain-shader';
import { createTilePool, type TilePool } from './tile-pool';
import type { VegetationLayer } from '../vegetation-layer';
import { labWater, type LabWater } from './water';

// The terrain lab (stage 2 of docs/ground-level-terrain-architecture-research.md):
// an isolated page at #terrain-lab that renders a recorded battlefield with the
// experimental terrain (field → tiles → CDLOD, material fields, clutter) or
// with the game's current renderer, from the same camera.

export interface LabBattlefieldSummary {
  readonly id: string;
  readonly name: string;
  readonly centre: { readonly lat: number; readonly lon: number };
}

export interface LabBattlefield {
  readonly id: string;
  readonly name: string;
  readonly centre: { readonly lat: number; readonly lon: number };
  /** The stored (raw) terrain. */
  readonly terrain: TerrainDataset;
  readonly corrections: SourceCorrections | null;
  /** The game's authoritative (graded) terrain, for the current renderer. */
  graded(): Promise<TerrainDataset>;
}

export interface LabSource {
  list(): Promise<LabBattlefieldSummary[]>;
  open(id: string): Promise<LabBattlefield>;
}

/**
 * Test areas (centres of a 1 km square, metres from the battlefield's centre)
 * chosen for their features, for battlefields centred near these places;
 * others use their centre.
 */
const AREAS: readonly {
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
  readonly x: number;
  readonly y: number;
}[] = [
  { name: 'Grafenwöhr', lat: 49.717, lon: 11.906, x: 250, y: 750 },
  { name: 'Quantico', lat: 38.5223, lon: -77.2934, x: 0, y: 500 },
  { name: 'Amsterdam', lat: 52.3702, lon: 4.8952, x: 250, y: 1000 },
];
const areaFor = (c: { lat: number; lon: number }) =>
  AREAS.find((a) => Math.abs(a.lat - c.lat) < 0.02 && Math.abs(a.lon - c.lon) < 0.02);
const AREA_M = 1000;
/** How far the finest ground level reaches by default, metres (chosen by eye). */
const LOD_DEFAULT_M = 100;

const SUN_AZIMUTH_DEG = 225;
const SUN_ELEVATION_DEG = 38;
const HAZE = new Color(0xc9d4dc);

const STYLE = `
.terrain-lab { position: fixed; inset: 0; display: grid; grid-template-columns: 300px 1fr; background: var(--bg); }
.terrain-lab .tl-side { overflow-y: auto; background: var(--panel); border-right: 1px solid var(--line); padding: 10px 12px; }
.terrain-lab .tl-side h1 { font-size: 14px; margin: 0 0 2px; }
.terrain-lab .tl-side section { border-top: 1px solid var(--line); padding: 8px 0; }
.terrain-lab label { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
.terrain-lab label > span { flex: 0 0 96px; color: var(--muted); }
.terrain-lab select, .terrain-lab input[type=number] { flex: 1; font: inherit; background: var(--panel-2); color: var(--text); border: 1px solid var(--line); border-radius: 4px; padding: 3px 5px; }
.terrain-lab input[type=range] { flex: 1; }
.terrain-lab .tl-row { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0; }
.terrain-lab .tl-row button { padding: 3px 8px; font-size: 12px; }
.terrain-lab button[aria-pressed=true] { background: var(--blue-bg); border-color: var(--blue); }
.terrain-lab .tl-views button { display: block; width: 100%; text-align: left; margin: 2px 0; }
.terrain-lab .tl-main { position: relative; overflow: hidden; }
.terrain-lab canvas.tl-canvas { width: 100%; height: 100%; display: block; }
.terrain-lab .tl-hud { position: absolute; left: 8px; top: 8px; background: rgba(20,23,26,0.78); border-radius: 4px; padding: 6px 9px; font: 12px ui-monospace, Consolas, monospace; white-space: pre; pointer-events: none; }
.terrain-lab .tl-status { position: absolute; right: 8px; bottom: 8px; background: rgba(20,23,26,0.78); border-radius: 4px; padding: 4px 9px; font-size: 12px; }
.terrain-lab .tl-help { color: var(--muted); font-size: 11px; line-height: 1.4; }
.terrain-lab pre.tl-settings { font-size: 11px; color: var(--muted); white-space: pre-wrap; margin: 4px 0; }
`;

interface Built {
  readonly bf: LabBattlefield;
  readonly clean: TerrainDataset;
  readonly input: FieldInput;
  readonly field: TerrainField;
  readonly surface: TerrainSurface;
  readonly pool: TilePool;
  readonly terrain: TerrainRenderer;
  readonly water: LabWater;
  readonly clutter: Clutter;
  readonly bridges: LabBridges;
  readonly decks: DeckIndex;
  readonly area: Rect;
  readonly views: Viewpoint[];
  readonly compileMs: number;
  readonly workerMs: number;
  structures: LabStructures | null;
  vegetation: VegetationLayer | null;
  current: CurrentScene | null;
  currentLoading: Promise<CurrentScene> | null;
  readonly group: Group;
}

export interface TerrainLabHandle {
  dispose(): void;
}

export function startTerrainLab(root: HTMLElement, source: LabSource): TerrainLabHandle {
  // Before anything that needs WebGL, so it works in any browser.
  (window as unknown as { terrainLabHash?: typeof hashPackage }).terrainLabHash = hashPackage;
  root.className = 'terrain-lab';
  root.innerHTML = `<style>${STYLE}</style>
  <aside class="tl-side">
    <h1>Terrain lab</h1>
    <p class="muted">Stage 2 prototype: constraint-based terrain field, CDLOD, material fields. Not part of the game.</p>
    <section>
      <label><span>Battlefield</span><select data-tl="battlefield"></select></label>
      <label><span>Area centre</span><input type="number" data-tl="ax" step="50"><input type="number" data-tl="ay" step="50"></label>
      <div class="tl-row"><button data-tl="apply-area">Load area</button></div>
    </section>
    <section>
      <h2>RENDERER</h2>
      <div class="tl-row"><button data-tl="r-lab" aria-pressed="true">Experimental</button><button data-tl="r-current" aria-pressed="false">Current</button></div>
      <div class="tl-row"><button data-tl="capture">Capture screenshot</button><button data-tl="capture-pair">Capture pair</button></div>
    </section>
    <section>
      <h2>CAMERA</h2>
      <div class="tl-row"><button data-tl="m-walk">Walk</button><button data-tl="m-fly">Fly</button><button data-tl="m-tactical">Tactical</button><button data-tl="reset">Reset</button></div>
      <label><span>Speed (m/s)</span><input type="range" data-tl="speed" min="-0.3" max="2.6" step="0.01" value="0.15"><output data-tl="speed-out"></output></label>
      <p class="tl-help">Walk/fly: WASD to move, Shift faster, Q/E down/up (fly); drag or double-click (pointer lock, Esc to leave) to look. Wheel: speed (walk/fly) or zoom (tactical). Tactical: drag to turn, right-drag to pan.</p>
    </section>
    <section>
      <h2>VIEWPOINTS</h2>
      <div class="tl-views" data-tl="views"></div>
    </section>
    <section>
      <h2>TERRAIN</h2>
      <label><span>Surface</span><select data-tl="spacing"><option value="0.5">0.5 m lattice</option><option value="1">1 m lattice</option></select></label>
      <label><span>Ground LOD (m)</span><input type="range" data-tl="lod-m" min="32" max="512" step="4" value="100"><output data-tl="lod-m-out"></output></label>
      <label><span>Relief</span><input type="checkbox" data-tl="relief" checked><input type="range" data-tl="relief-amp" min="0" max="2.5" step="0.05" value="1"><output data-tl="relief-out"></output></label>
      <label><span>Seed</span><input type="number" data-tl="seed" value="1" min="0" step="1"></label>
      <div class="tl-row"><button data-tl="apply-field">Rebuild terrain</button></div>
      <label><span>Materials</span><select data-tl="advanced"><option value="1">Advanced (hex tiling, height blend)</option><option value="0">Simple</option></select></label>
      <label><span>Clutter</span><select data-tl="clutter"><option value="medium">Medium</option><option value="high">High</option><option value="low">Low</option><option value="off">Off</option></select></label>
      <label><span>Grass distance (m)</span><input type="range" data-tl="grass-m" min="10" max="150" step="5" value="40"><output data-tl="grass-m-out"></output></label>
      <label><span>Texture detail (m)</span><input type="range" data-tl="detail-m" min="10" max="250" step="5" value="60"><output data-tl="detail-m-out"></output></label>
      <label><span>Debug view</span><select data-tl="debug"><option value="off">Off</option><option value="lod">LOD levels</option><option value="tiles">Tile boundaries</option><option value="fields">Material fields</option></select></label>
      <label><span>Wireframe</span><input type="checkbox" data-tl="wire"></label>
      <label><span>LOD morphing</span><input type="checkbox" data-tl="morph" checked></label>
      <label><span>Structures</span><input type="checkbox" data-tl="structures" checked></label>
    </section>
    <section>
      <h2>BENCHMARK</h2>
      <div class="tl-row"><button data-tl="bench">Run 2 × 30 s</button></div>
      <pre class="tl-settings" data-tl="bench-out"></pre>
    </section>
    <section>
      <h2>SETTINGS</h2>
      <pre class="tl-settings" data-tl="settings"></pre>
    </section>
  </aside>
  <div class="tl-main">
    <canvas class="tl-canvas" aria-label="Terrain lab 3D view"></canvas>
    <div class="tl-hud" data-tl="hud"></div>
    <div class="tl-status" data-tl="status">Loading…</div>
  </div>`;
  const q = (name: string): HTMLElement => {
    const el = root.querySelector<HTMLElement>(`[data-tl="${name}"]`);
    if (!el) throw new Error(`terrain lab: missing ${name}`);
    return el;
  };
  const qi = (name: string) => q(name) as HTMLInputElement;
  const qs = (name: string) => q(name) as HTMLSelectElement;
  const canvas = root.querySelector<HTMLCanvasElement>('canvas.tl-canvas');
  if (!canvas) throw new Error('terrain lab: no canvas');
  const status = q('status');
  const hud = q('hud');
  const setStatus = (text: string) => {
    status.textContent = text;
    status.hidden = text === '';
  };

  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
    stencil: true,
  });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.6;
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : null;
  const quality: QualityPreset =
    QUALITY_PRESETS[detectQuality(gpu) === 'low' ? 'medium' : detectQuality(gpu)];
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.maxPixelRatio));
  renderer.shadowMap.enabled = true;
  const scene = new Scene();
  scene.background = HAZE;
  const az = (SUN_AZIMUTH_DEG * Math.PI) / 180;
  const el = (SUN_ELEVATION_DEG * Math.PI) / 180;
  const sunDirection = new Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    -Math.cos(az) * Math.cos(el),
  ).normalize();
  const sky = new Sky();
  sky.scale.setScalar(450_000);
  const su = sky.material.uniforms as Record<string, { value: unknown }>;
  (su['turbidity'] as { value: number }).value = 5;
  (su['rayleigh'] as { value: number }).value = 1.4;
  (su['mieCoefficient'] as { value: number }).value = 0.004;
  (su['mieDirectionalG'] as { value: number }).value = 0.8;
  (su['sunPosition'] as { value: Vector3 }).value.copy(sunDirection);
  scene.add(sky);
  const sun = new DirectionalLight(0xfff7ea, 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.3;
  scene.add(sun, sun.target);
  scene.add(new HemisphereLight(0xd6e4f0, 0x6f7062, 1.0));

  let textures: GroundTextures = placeholderTextures();
  let texturesReady = false;
  const texturesLoading = loadGroundTextures().then(
    (t) => {
      textures.dispose();
      textures = t;
      texturesReady = true;
      built?.terrain.setTextures(t);
      built?.bridges.setTints(t.tints);
    },
    (e: unknown) => {
      console.error('terrain lab textures', e);
    },
  );

  let built: Built | null = null;
  let building: Promise<Built> | null = null;
  let mode: 'lab' | 'current' = 'lab';
  const modeNow = () => mode;
  /** Why no battlefield could be shown, if so. */
  let loadFailed: string | null = null;
  const builtNow = () => built;
  let spec: FieldSpec = DEFAULT_FIELD_SPEC;
  let spacing = 0.5;
  let debugView: DebugView = 'off';
  let wire = false;
  let morph = true;
  let advanced = true;
  let clutterQuality: 'low' | 'medium' | 'high' | 'off' = 'medium';
  /** Grass and clutter radius, and where the ground's fine detail starts to fade (the sliders), metres. */
  let grassM = CLUTTER_QUALITY.medium.radius;
  let detailM = DETAIL_DEFAULT_M;
  /** How far the finest ground level reaches (the slider), metres. */
  let lodM: number | null = LOD_DEFAULT_M;
  let lodShown = 0;
  const clutterSettings = () =>
    clutterQuality === 'off'
      ? CLUTTER_QUALITY.medium
      : { ...CLUTTER_QUALITY[clutterQuality], radius: grassM };
  let showStructures = true;
  const life = { disposed: false };

  const groundAt = (x: number, y: number) => {
    if (!built) return 0;
    const s = built.surface;
    if (mode === 'current') return s.heightAt(x, y);
    const deck = built.decks.topAt(x, y);
    const g = s.heightAt(x, y);
    return deck !== null && deck > g ? deck : g;
  };
  const cam: LabCamera = createLabCamera(canvas, (x, y) => {
    if (!built) return 0;
    const b = built.field.bounds;
    return groundAt(Math.max(b.minX, Math.min(b.maxX, x)), Math.max(b.minY, Math.min(b.maxY, y)));
  });

  // The surroundings, out to the horizon: below the battlefield's lowest
  // ground, so they never cover it.
  const apron = new Mesh(
    new CircleGeometry(1, 64).rotateX(-Math.PI / 2),
    new MeshStandardMaterial({ color: 0x59604f, roughness: 1 }),
  );
  apron.name = 'surroundings';
  scene.add(apron);

  const dispose = (b: Built) => {
    b.pool.dispose();
    b.terrain.dispose();
    b.water.dispose();
    b.clutter.dispose();
    b.bridges.dispose();
    b.structures?.dispose();
    b.current?.dispose();
    scene.remove(b.group);
  };

  const build = async (id: string, centre: { x: number; y: number } | null): Promise<Built> => {
    setStatus('Opening the battlefield…');
    const bf = await source.open(id);
    const t0 = performance.now();
    const clean = cleanTerrain(bf.terrain, bf.corrections).terrain;
    const water = waterLevels(clean);
    const input: FieldInput = { heightfield: clean.heightfield, features: clean.features, water };
    const field = compileField(input, spec, () => performance.now());
    const compileMs = performance.now() - t0;
    const surface = createSurface(field, {
      spacing,
      capacity: 384,
      clock: () => performance.now(),
    });
    const heavy = clean.features.buildings.length > 20000;
    const workers = Math.max(1, Math.min(heavy ? 2 : 4, (navigator.hardwareConcurrency || 4) - 1));
    setStatus('Compiling the terrain field in the workers…');
    const pool = createTilePool(input, spec, spacing, workers);
    const workerMs = await pool.ready;
    const terrain = createTerrainRenderer(surface, pool, textures);
    terrain.setDebug(debugView);
    terrain.setWireframe(wire);
    terrain.setMorph(morph);
    terrain.setDetailDistance(detailM);
    // The finest ground level's reach: the slider's, once moved; else this lattice's default.
    lodShown = terrain.setLodRange(lodM ?? terrain.defaultLodRange);
    qi('lod-m').value = String(lodShown);
    terrain.setAdvanced(advanced);
    const group = new Group();
    group.name = 'lab';
    group.add(terrain.mesh);
    const lw = labWater(field, clean.features, water);
    group.add(lw.mesh);
    const clutter = createClutter(surface, group);
    // The lab's own bridges, on the field's bridge roads.
    const decks = deckIndex(field.roads);
    const bridges = createLabBridges(field);
    group.add(bridges.group);
    if (texturesReady) bridges.setTints(textures.tints);
    clutter.setVisible(clutterQuality !== 'off');
    if (clutterQuality !== 'off') clutter.setSettings(clutterSettings());
    const match = areaFor(bf.centre);
    const c = centre ?? (match ? { x: match.x, y: match.y } : { x: 0, y: 0 });
    const area: Rect = {
      minX: c.x - AREA_M / 2,
      minY: c.y - AREA_M / 2,
      maxX: c.x + AREA_M / 2,
      maxY: c.y + AREA_M / 2,
    };
    const views = findViewpoints(field, clean.features, area);
    const b = field.bounds;
    const span = Math.max(b.maxX - b.minX, b.maxY - b.minY);
    apron.scale.setScalar(12 * span);
    let lowest = Infinity;
    for (const e of clean.heightfield.elevations) if (e < lowest) lowest = e;
    apron.position.set((b.minX + b.maxX) / 2, lowest - 2, -(b.minY + b.maxY) / 2);
    scene.fog = new Fog(HAZE, 1.4 * span, 6 * span);
    const result: Built = {
      bf,
      clean,
      input,
      field,
      surface,
      pool,
      terrain,
      water: lw,
      clutter,
      bridges,
      decks,
      area,
      views,
      compileMs,
      workerMs,
      structures: null,
      vegetation: null,
      current: null,
      currentLoading: null,
      group,
    };
    // Structures on the lab ground: a TerrainDataset sampled from it.
    setStatus('Generating buildings, bridges and trees…');
    // Everywhere, on 2 m samples from the workers' tiles, so distant views have
    // their buildings and woods as the game does (dense cities included: the
    // game draws all of them too).
    let sTerrain: TerrainDataset;
    {
      const level = Math.round(Math.log2(2 / spacing));
      const size = 64 * 2 ** level;
      const nx = Math.ceil((b.maxX - b.minX) / size);
      const ny = Math.ceil((b.maxY - b.minY) / size);
      const tiles = new Map<string, SurfaceTile>();
      await new Promise<void>((resolve) => {
        let left = nx * ny;
        const queue: [number, number][] = [];
        for (let ty = 0; ty < ny; ty += 1) for (let tx = 0; tx < nx; tx += 1) queue.push([tx, ty]);
        const pump = () => {
          while (queue.length > 0) {
            const next = queue[0];
            if (!next) break;
            const ok = pool.request(level, next[0], next[1], (t) => {
              tiles.set(`${String(t.tx)},${String(t.ty)}`, t);
              left -= 1;
              if (left === 0) resolve();
              else pump();
            });
            if (!ok) break;
            queue.shift();
          }
        };
        pump();
      });
      const sp = spacing * 2 ** level;
      const cells = surface.cells;
      sTerrain = structureTerrain(surface, clean, water, b, sp, (x, y) => {
        const I = Math.round((x - b.minX) / sp);
        const J = Math.round((y - b.minY) / sp);
        const tx = Math.min(nx - 1, Math.floor(I / cells));
        const ty = Math.min(ny - 1, Math.floor(J / cells));
        const t = tiles.get(`${String(tx)},${String(ty)}`);
        if (!t) return field.height(x, y);
        return t.heights[(J - ty * cells + 1) * t.stride + (I - tx * cells + 1)] ?? 0;
      });
    }
    result.structures = createLabStructures(sTerrain, quality, {
      field,
      surface,
      deckAt: (x, y) => decks.topAt(x, y),
      ground: (x, y) => surface.heightAt(x, y),
    });
    // Nothing grows through a bridge deck that is close over the ground.
    clutter.setCovered((x, y, z) => {
      const deck = decks.topAt(x, y);
      return deck !== null && deck - z < 2;
    });
    void result.structures.ready.then(
      ({ features, vegetation }) => {
        if (built !== result) return;
        group.add(features.group, vegetation.group);
        result.vegetation = vegetation;
        const plan = result.structures?.plan ?? [];
        const bv = bridgeViewpoint(field, plan, area);
        if (bv) {
          const at = result.views.findIndex((v) => v.id === 'bridge-below');
          if (at >= 0) result.views[at] = bv;
          else result.views.splice(6, 0, bv);
          if (built === result) showViews(result.views);
        }
        features.group.visible = showStructures;
        vegetation.group.visible = showStructures;
      },
      (e: unknown) => {
        console.error('terrain lab structures', e);
      },
    );
    return result;
  };

  const ensureCurrent = (b: Built): Promise<CurrentScene> => {
    if (b.current) return Promise.resolve(b.current);
    b.currentLoading ??= (async () => {
      setStatus('Preparing the current renderer (grading the terrain)…');
      const graded = await b.bf.graded();
      const current = createCurrentScene(graded, quality);
      b.current = current;
      await current.ready;
      return current;
    })();
    return b.currentLoading;
  };

  const setMode = async (next: 'lab' | 'current') => {
    mode = next;
    q('r-lab').setAttribute('aria-pressed', String(next === 'lab'));
    q('r-current').setAttribute('aria-pressed', String(next === 'current'));
    const b = built;
    if (!b) return;
    if (next === 'current') {
      const cur = await ensureCurrent(b);
      // The choice or the battlefield may have changed while it loaded.
      if (modeNow() !== 'current' || builtNow() !== b) return;
      scene.remove(b.group);
      scene.add(cur.group);
      setStatus('');
    } else {
      if (b.current) scene.remove(b.current.group);
      scene.add(b.group);
    }
    setStatus('');
  };

  const viewList = q('views');
  const showViews = (views: Viewpoint[]) => {
    viewList.innerHTML = '';
    for (const v of views) {
      const b = document.createElement('button');
      b.textContent = v.label;
      b.title = `${v.id}: ${v.note}`;
      b.dataset['view'] = v.id;
      b.addEventListener('click', () => {
        goView(v);
      });
      viewList.append(b);
    }
  };
  const goView = (v: Viewpoint) => {
    cam.view(v.mode, v.x, v.y, v.heading, v.pitch, v.distance);
    syncModeButtons();
  };
  const syncModeButtons = () => {
    for (const m of ['walk', 'fly', 'tactical'] as const)
      q(`m-${m}`).setAttribute('aria-pressed', String(cam.state.mode === m));
  };

  const load = async (id: string, centre: { x: number; y: number } | null) => {
    const previous = built;
    built = null;
    if (previous) dispose(previous);
    building = build(id, centre);
    try {
      const b = await building;
      if (life.disposed) {
        dispose(b);
        return;
      }
      built = b;
      scene.add(b.group);
      qi('ax').value = String((b.area.minX + b.area.maxX) / 2);
      qi('ay').value = String((b.area.minY + b.area.maxY) / 2);
      showViews(b.views);
      const first = b.views[0];
      if (first) goView(first);
      else
        cam.view(
          'tactical',
          (b.area.minX + b.area.maxX) / 2,
          (b.area.minY + b.area.maxY) / 2,
          0,
          -40,
          600,
        );
      if (mode === 'current') await setMode('current');
      setStatus('');
      window.location.hash = `#terrain-lab/${id}`;
    } catch (e) {
      loadFailed = e instanceof Error ? e.message : String(e);
      setStatus(`Could not open: ${loadFailed}`);
      throw e;
    }
  };

  // Controls.
  const bfSelect = qs('battlefield');
  void source.list().then((list) => {
    if (list.length === 0) {
      setStatus('No saved battlefields. Generate one from terrain selection first.');
      loadFailed = 'no saved battlefields';
      return;
    }
    for (const s of list) {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = areaFor(s.centre) ? `${s.name} (${areaFor(s.centre)?.name ?? ''})` : s.name;
      bfSelect.append(o);
    }
    const wanted = window.location.hash.split('/')[1];
    const pick =
      list.find((s) => s.id === wanted) ??
      list.find((s) => areaFor(s.centre)?.name === 'Grafenwöhr') ??
      list[0];
    if (pick) {
      bfSelect.value = pick.id;
      void load(pick.id, null);
    }
  });
  bfSelect.addEventListener('change', () => {
    void load(bfSelect.value, null);
  });
  q('apply-area').addEventListener('click', () => {
    const x = Number(qi('ax').value);
    const y = Number(qi('ay').value);
    if (built) void load(built.bf.id, { x, y });
  });
  q('r-lab').addEventListener('click', () => {
    void setMode('lab');
  });
  q('r-current').addEventListener('click', () => {
    void setMode('current');
  });
  for (const m of ['walk', 'fly', 'tactical'] as const)
    q(`m-${m}`).addEventListener('click', () => {
      const s = cam.state;
      const f = { x: Math.sin(s.heading), y: Math.cos(s.heading) };
      if (m === 'tactical')
        cam.view(
          'tactical',
          s.x + f.x * 150,
          s.y + f.y * 150,
          (s.heading * 180) / Math.PI,
          -35,
          300,
        );
      else if (s.mode === 'tactical') {
        const t = {
          x: s.x + Math.sin(s.heading) * Math.cos(s.pitch) * s.distance,
          y: s.y + Math.cos(s.heading) * Math.cos(s.pitch) * s.distance,
        };
        cam.view(m, t.x, t.y, (s.heading * 180) / Math.PI, -5);
      } else cam.set({ mode: m, speed: m === 'walk' ? 1.4 : Math.max(s.speed, 8) });
      syncModeButtons();
    });
  q('reset').addEventListener('click', () => {
    const first = built?.views[0];
    if (first) goView(first);
  });
  const speed = qi('speed');
  speed.addEventListener('input', () => {
    cam.set({ speed: 10 ** Number(speed.value) });
  });
  const reliefAmp = qi('relief-amp');
  const reliefOn = qi('relief');
  const rebuildField = () => {
    spec = {
      seed: Math.max(0, Math.floor(Number(qi('seed').value) || 0)),
      relief: reliefOn.checked ? Number(reliefAmp.value) : 0,
    };
    spacing = Number(qs('spacing').value);
    if (built) {
      const s = cam.state;
      const keep = { ...s };
      void load(built.bf.id, {
        x: (built.area.minX + built.area.maxX) / 2,
        y: (built.area.minY + built.area.maxY) / 2,
      }).then(() => {
        cam.set(keep);
        syncModeButtons();
      });
    }
  };
  q('apply-field').addEventListener('click', rebuildField);
  qs('spacing').addEventListener('change', rebuildField);
  reliefOn.addEventListener('change', rebuildField);
  qs('advanced').addEventListener('change', (e) => {
    advanced = (e.target as HTMLSelectElement).value === '1';
    built?.terrain.setAdvanced(advanced);
  });
  qs('clutter').addEventListener('change', (e) => {
    clutterQuality = (e.target as HTMLSelectElement).value as typeof clutterQuality;
    built?.clutter.setVisible(clutterQuality !== 'off');
    if (clutterQuality !== 'off') {
      // A quality sets its own distance; the slider then adjusts it.
      grassM = CLUTTER_QUALITY[clutterQuality].radius;
      qi('grass-m').value = String(grassM);
      built?.clutter.setSettings(clutterSettings());
    }
  });
  qi('grass-m').addEventListener('input', (e) => {
    grassM = Number((e.target as HTMLInputElement).value);
    if (clutterQuality !== 'off') built?.clutter.setSettings(clutterSettings());
  });
  qi('lod-m').addEventListener('input', (e) => {
    lodM = Number((e.target as HTMLInputElement).value);
    if (built) lodShown = built.terrain.setLodRange(lodM);
  });
  qi('detail-m').addEventListener('input', (e) => {
    detailM = Number((e.target as HTMLInputElement).value);
    built?.terrain.setDetailDistance(detailM);
  });
  qs('debug').addEventListener('change', (e) => {
    debugView = (e.target as HTMLSelectElement).value as DebugView;
    built?.terrain.setDebug(debugView);
  });
  qi('wire').addEventListener('change', (e) => {
    wire = (e.target as HTMLInputElement).checked;
    built?.terrain.setWireframe(wire);
  });
  qi('morph').addEventListener('change', (e) => {
    morph = (e.target as HTMLInputElement).checked;
    built?.terrain.setMorph(morph);
  });
  qi('structures').addEventListener('change', (e) => {
    showStructures = (e.target as HTMLInputElement).checked;
    for (const child of built?.group.children ?? [])
      if (child.name === 'geographic features' || child.name === 'vegetation')
        child.visible = showStructures;
  });

  // Frame loop and statistics.
  const frameTimes: number[] = [];
  let last = performance.now();
  let raf = 0;
  let width = 0;
  let height = 0;
  let cpuMs = 0;
  const resize = () => {
    const r = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    if (w === width && h === height) return;
    width = w;
    height = h;
    renderer.setSize(w, h, false);
    cam.camera.aspect = w / h;
    cam.camera.updateProjectionMatrix();
  };
  const followShadows = () => {
    const s = cam.state;
    const above = s.z - groundAt(s.x, s.y);
    const extent = Math.min(1100, Math.max(120, above * 3 + 80));
    const texel = extent / sun.shadow.mapSize.x;
    const fx = s.x + Math.sin(s.heading) * extent * 0.3;
    const fy = s.y + Math.cos(s.heading) * extent * 0.3;
    const tx = Math.round(fx / texel) * texel;
    const tz = Math.round(-fy / texel) * texel;
    const c = sun.shadow.camera;
    if (c.right !== extent / 2) {
      c.left = -extent / 2;
      c.right = extent / 2;
      c.top = extent / 2;
      c.bottom = -extent / 2;
      c.near = 1;
      c.far = 4 * extent + 2000;
      c.updateProjectionMatrix();
    }
    const gz = groundAt(fx, fy);
    sun.target.position.set(tx, gz, tz);
    sun.position.set(tx, gz, tz).addScaledVector(sunDirection, 2 * extent + 1000);
  };
  let clutterForce = 0;
  const frame = () => {
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    frameTimes.push(now - last);
    if (frameTimes.length > 120) frameTimes.shift();
    last = now;
    resize();
    const startCpu = performance.now();
    cam.update(dt);
    const b = built;
    if (b) {
      if (mode === 'lab') {
        b.terrain.update(cam.camera);
        if (clutterQuality !== 'off') {
          clutterForce += dt;
          const force = clutterForce > 1 && b.terrain.stats.waiting > 0;
          if (force) clutterForce = 0;
          b.clutter.update(cam.state.x, cam.state.y, now / 1000, force);
        }
      }
      const veg = mode === 'lab' ? b.vegetation : b.current?.vegetation();
      veg?.update(cam.camera);
      followShadows();
    }
    renderer.render(scene, cam.camera);
    cpuMs = performance.now() - startCpu;
    updateHud();
  };
  let hudAt = 0;
  const updateHud = () => {
    const now = performance.now();
    if (now - hudAt < 250) return;
    hudAt = now;
    const ft = [...frameTimes].sort((a, b) => a - b);
    const mean = frameTimes.reduce((a, b) => a + b, 0) / Math.max(1, frameTimes.length);
    const p95 = ft[Math.floor(ft.length * 0.95)] ?? 0;
    const info = renderer.info.render;
    const b = built;
    const t = b?.terrain.stats;
    const lines = [
      `${mode === 'lab' ? 'EXPERIMENTAL' : 'CURRENT'}  ${(1000 / Math.max(mean, 0.1)).toFixed(0)} fps  ${mean.toFixed(1)} ms (p95 ${p95.toFixed(1)})  cpu ${cpuMs.toFixed(1)} ms`,
      `draw calls ${String(info.calls)}  triangles ${(info.triangles / 1e6).toFixed(2)} M`,
    ];
    if (b && t && mode === 'lab') {
      lines.push(
        `nodes ${String(t.nodes)} [${t.nodesPerLevel.map(String).join(' ')}]  terrain tris ${(t.triangles / 1e6).toFixed(2)} M`,
        `tiles: atlas ${String(t.resident)}/256  cpu cache ${String(b.surface.cachedCount())} (${(b.surface.cachedBytes() / 1e6).toFixed(0)} MB)  waiting ${String(t.waiting)}`,
        `tile gen: workers ${String(t.workerTiles)} tiles, ${(t.workerMs / Math.max(1, t.workerTiles)).toFixed(1)} ms each (${String(b.pool.size)} workers); main thread ${String(b.surface.stats.generated)}`,
        `clutter ${String(b.clutter.stats.instances)} inst, ${(b.clutter.stats.triangles / 1e6).toFixed(2)} M tris, ${b.clutter.stats.rebuildMs.toFixed(1)} ms`,
        `terrain GPU ≈ ${((t.atlasBytes + textures.bytes) / 1e6).toFixed(0)} MB (atlas ${(t.atlasBytes / 1e6).toFixed(0)} + materials ${(textures.bytes / 1e6).toFixed(0)})`,
      );
    }
    const s = cam.state;
    lines.push(
      `${s.mode} at ${s.x.toFixed(1)}, ${s.y.toFixed(1)}  eye ${(s.z - groundAt(s.x, s.y)).toFixed(2)} m  hdg ${((s.heading * 180) / Math.PI).toFixed(0)}°  pitch ${((s.pitch * 180) / Math.PI).toFixed(0)}°  ${s.speed.toFixed(1)} m/s`,
    );
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    if (mem) lines.push(`JS heap ${(mem.usedJSHeapSize / 1e6).toFixed(0)} MB`);
    hud.textContent = lines.join('\n');
    q('speed-out').textContent = s.speed.toFixed(1);
    q('relief-out').textContent = Number(reliefAmp.value).toFixed(2);
    q('grass-m-out').textContent = String(grassM);
    q('detail-m-out').textContent = String(detailM);
    q('lod-m-out').textContent = String(Math.round(lodShown));
    if (b)
      q('settings').textContent = [
        `battlefield ${b.bf.name} (${b.bf.id})`,
        `area ${String(b.area.minX)}…${String(b.area.maxX)}, ${String(b.area.minY)}…${String(b.area.maxY)}`,
        `field v${String(TERRAIN_FIELD_VERSION)} seed ${String(spec.seed)} relief ×${String(spec.relief)}`,
        `lattice ${String(spacing)} m, tiles 64 m, ${String(b.terrain.levels)} LOD levels`,
        `field compile ${b.compileMs.toFixed(0)} ms (workers ${b.workerMs.toFixed(0)} ms)`,
        `roads ${String(b.field.stats.roads)} bridges ${String(b.field.stats.bridges)} pads ${String(b.field.stats.pads)} channels ${String(b.field.stats.channels)}`,
        `textures ${texturesReady ? 'loaded' : 'loading'}; quality ${quality.level}; GPU ${gpu ?? '?'}`,
      ].join('\n');
  };
  raf = requestAnimationFrame(frame);

  // Screenshots: drawn and read in one go, so no preserveDrawingBuffer is needed.
  const capture = (name: string) => {
    renderer.render(scene, cam.camera);
    const url = canvas.toDataURL('image/jpeg', 0.9);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.jpg`;
    a.click();
  };
  const shotName = () => {
    const s = cam.state;
    return `${built?.bf.name.split(',')[0]?.toLowerCase() ?? 'lab'}-${mode}-${s.x.toFixed(0)}_${s.y.toFixed(0)}`;
  };
  q('capture').addEventListener('click', () => {
    capture(shotName());
  });
  /** Waits until tiles, clutter and textures have settled (or `timeoutMs`). */
  const settle = async (timeoutMs = 60000) => {
    const start = performance.now();
    await texturesLoading;
    if (built?.structures) await built.structures.ready.catch(() => undefined);
    let quiet = 0;
    while (performance.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 100));
      const busy = mode === 'lab' ? (built?.terrain.stats.waiting ?? 1) > 0 : !built?.current;
      quiet = busy ? 0 : quiet + 1;
      if (quiet >= 8) break;
    }
    built?.clutter.update(cam.state.x, cam.state.y, performance.now() / 1000, true);
    await new Promise((r) => setTimeout(r, 300));
  };
  q('capture-pair').addEventListener('click', () => {
    void (async () => {
      const was = mode;
      await setMode('lab');
      await settle();
      capture(shotName());
      await setMode('current');
      await settle();
      capture(shotName());
      await setMode(was);
    })();
  });

  // Benchmark: 30 s walking along the road view, 30 s orbiting overhead.
  const bench = async () => {
    if (!built) return null;
    const out: Record<string, unknown> = { renderer: mode, gpu, spacing, relief: spec.relief };
    const run = async (name: string, seconds: number, step: (t: number) => void) => {
      const times: number[] = [];
      let prev = performance.now();
      const start = prev;
      const calls: number[] = [];
      const tris: number[] = [];
      while (performance.now() - start < seconds * 1000) {
        await new Promise((r) => requestAnimationFrame(r));
        const now = performance.now();
        times.push(now - prev);
        prev = now;
        step((now - start) / 1000);
        calls.push(renderer.info.render.calls);
        tris.push(renderer.info.render.triangles);
      }
      times.sort((a, b) => a - b);
      const mean = times.reduce((a, b) => a + b, 0) / times.length;
      out[name] = {
        frames: times.length,
        meanMs: +mean.toFixed(2),
        p50Ms: +(times[Math.floor(times.length / 2)] ?? 0).toFixed(2),
        p95Ms: +(times[Math.floor(times.length * 0.95)] ?? 0).toFixed(2),
        p99Ms: +(times[Math.floor(times.length * 0.99)] ?? 0).toFixed(2),
        maxCalls: Math.max(...calls),
        maxTrianglesM: +(Math.max(...tris) / 1e6).toFixed(2),
      };
    };
    const road = built.views.find((v) => v.id === 'road-along') ?? built.views[0];
    if (road) {
      goView(road);
      await settle(20000);
      const h = (road.heading * Math.PI) / 180;
      const x0 = cam.state.x;
      const y0 = cam.state.y;
      await run('walk', 30, (t) => {
        // 1.4 m/s, then back, with the head turning.
        const d = 1.4 * (t < 15 ? t : 30 - t) * 2;
        cam.set({
          x: x0 + Math.sin(h) * d,
          y: y0 + Math.cos(h) * d,
          heading: h + 0.6 * Math.sin(t * 0.7),
        });
      });
    }
    const cx = (built.area.minX + built.area.maxX) / 2;
    const cy = (built.area.minY + built.area.maxY) / 2;
    cam.view('tactical', cx, cy, 0, -40, 700);
    await settle(20000);
    await run('orbit', 30, (t) => {
      cam.view('tactical', cx, cy, t * 12, -40, 700 - 300 * Math.sin(t * 0.2));
    });
    const text = JSON.stringify(out, null, 1);
    q('bench-out').textContent = text;
    return out;
  };
  q('bench').addEventListener('click', () => {
    void bench();
  });

  // For automated checks (Playwright): the same actions as the controls.
  const hooks = {
    ready: async () => {
      while (!built) {
        if (loadFailed !== null) throw new Error(`terrain lab: ${loadFailed}`);
        await new Promise((r) => setTimeout(r, 100));
      }
      await settle();
      return true;
    },
    views: () => built?.views ?? [],
    view: async (id: string) => {
      const v = built?.views.find((w) => w.id === id);
      if (v) goView(v);
      await settle();
      return v ?? null;
    },
    setView: async (
      m: CameraMode,
      x: number,
      y: number,
      heading: number,
      pitch: number,
      distance?: number,
    ) => {
      cam.view(m, x, y, heading, pitch, distance);
      await settle();
    },
    setRenderer: async (r: 'lab' | 'current') => {
      await setMode(r);
      await settle();
    },
    settle,
    bench,
    debug: (v: DebugView) => {
      debugView = v;
      built?.terrain.setDebug(v);
    },
    wireframe: (on: boolean) => {
      wire = on;
      built?.terrain.setWireframe(on);
    },
    stats: () => ({
      hud: hud.textContent,
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      terrain: built?.terrain.stats,
      clutter: built?.clutter.stats,
      vegetation: built?.vegetation?.stats() ?? null,
      surface: built?.surface.stats,
      field: built?.field.stats,
      compileMs: built?.compileMs,
      workerMs: built?.workerMs,
      memory: (performance as unknown as { memory?: unknown }).memory ?? null,
      eye: cam.state.z - groundAt(cam.state.x, cam.state.y),
    }),
    hashes: (n = 9) => {
      if (!built) return [];
      const out: string[] = [];
      const cx = (built.area.minX + built.area.maxX) / 2;
      const cy = (built.area.minY + built.area.maxY) / 2;
      const s = built.surface;
      const tx = Math.floor((cx - s.originX) / 64);
      const ty = Math.floor((cy - s.originY) / 64);
      const r = Math.floor(Math.sqrt(n) / 2);
      for (let i = -r; i <= r; i += 1)
        for (let j = -r; j <= r; j += 1)
          out.push(`${String(tx + i)},${String(ty + j)}:${tileHash(s.tile(0, tx + i, ty + j))}`);
      return out;
    },
    eyeHeight: EYE_HEIGHT_M,
    /** As the terrain controls: lattice spacing and relief (rebuilds), clutter quality. */
    configure: async (o: {
      spacing?: number;
      relief?: number;
      clutter?: 'low' | 'medium' | 'high' | 'off';
    }) => {
      if (o.clutter) {
        qs('clutter').value = o.clutter;
        qs('clutter').dispatchEvent(new Event('change'));
      }
      if (o.spacing !== undefined || o.relief !== undefined) {
        if (o.spacing !== undefined) qs('spacing').value = String(o.spacing);
        if (o.relief !== undefined) {
          qi('relief').checked = o.relief > 0;
          qi('relief-amp').value = String(o.relief);
        }
        rebuildField();
        await new Promise((r) => setTimeout(r, 200));
        while (!built) await new Promise((r) => setTimeout(r, 100));
        await settle();
      }
    },
    structures: (on: boolean) => {
      showStructures = on;
      for (const child of built?.group.children ?? [])
        if (child.name === 'geographic features' || child.name === 'vegetation') child.visible = on;
    },
    clutter: (on: boolean) => {
      built?.clutter.setVisible(on);
    },
    water: (on: boolean) => {
      if (built) built.water.mesh.visible = on;
    },
    /** For debugging in the console. */
    three: { scene, renderer, sun },
    hud: (on: boolean) => {
      hud.hidden = !on;
      status.hidden = !on || status.textContent === '';
    },
  };
  (window as unknown as { terrainLab?: typeof hooks }).terrainLab = hooks;

  return {
    dispose() {
      life.disposed = true;
      cancelAnimationFrame(raf);
      if (built) dispose(built);
      void building?.then(dispose, () => undefined);
      cam.dispose();
      textures.dispose();
      renderer.dispose();
    },
  };
}
