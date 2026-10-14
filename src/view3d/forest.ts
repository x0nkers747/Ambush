import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Frustum,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  ShaderChunk,
  Vector3,
  type PerspectiveCamera,
} from 'three';
import type { TerrainField, TerrainSurface } from '#sim/terrain-field';
import { fromThree } from './axes';
import { LOD_LEVELS, PLANTS, plantModels } from './plant-models';
import type { VegetationLayer, VegetationStats } from './vegetation-layer';
import { keepFraction, lodBand, type LodSettings } from './vegetation-lod';
import type { VegetationInstances } from './vegetation-placement';
import { groundFieldsAt } from './clutter';
import {
  ALPHA_CUT,
  barkUvTest,
  createFoliageTextures,
  type FoliageTextures,
} from './foliage-atlas';
import { SPECIES, treeModels, type SpeciesName, type TreeModel } from './tree-models';

// The vegetation (docs/adr/0049, research §5.5). Where trees and shrubs
// stand is the placement's (vegetation-placement.ts: spacing, stands, forest
// edges, clear of roads, buildings and water); each plant becomes a species
// of the Quantico area, chosen per plant from its kind with species growing
// in stands, drawn with the procedural models of tree-models.ts. Under the
// woods' canopy an understorey of shrubs, saplings and ferns grows round the
// camera. One InstancedMesh per model and level, chosen by distance per
// 100 m tile, distant plants thinned by rank with wider crowns; roadside props
// keep their own models (plant-models.ts).

/** Most plants per model and band (near, medium); far is unbounded. */
const NEAR_CAPACITY = 12_000;
const MEDIUM_CAPACITY = 60_000;
/** Instance buffers start this big and double as needed. */
const INITIAL_CAPACITY = 256;

/** How much of each card's own facing shows through the crown's (0: the crown is one smooth mass). */
const CARD_NORMAL_SHARE = 0.45;
/**
 * Sunlight through leaves (linear, × the leaf's colour): looking towards the
 * sun through them, and lighting the crown's shaded side. Shadowed leaves get none.
 */
const TRANSLUCENCY = { through: 2.6, back: 0.5, tint: [1.1, 1.25, 0.45] } as const;

/**
 * The standard light loop with sunlight through the leaves added after each
 * directional light (with its shadow already applied).
 */
function foliageLights(): string {
  const chunk = ShaderChunk.lights_fragment_begin;
  const dir = chunk.indexOf('NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )');
  const call =
    'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
  const at = chunk.indexOf(call, dir);
  if (dir < 0 || at < 0)
    throw new Error('three.js light loop changed: foliage translucency needs updating');
  const t = TRANSLUCENCY;
  const added = `${call}
		{
			float vegThrough = pow( saturate( dot( -geometryViewDir, directLight.direction ) ), 3.0 );
			float vegBack = saturate( dot( -geometryNormal, directLight.direction ) );
			reflectedLight.directDiffuse += directLight.color * diffuseColor.rgb
				* vec3( ${t.tint.map((v) => v.toFixed(2)).join(', ')} )
				* ( ${t.through.toFixed(2)} * vegThrough + ${t.back.toFixed(2)} * vegBack ) * vegLeaf;
		}`;
  return chunk.slice(0, at) + added + chunk.slice(at + call.length);
}
/**
 * The trees' material (docs/adr/0051): the foliage atlas with alpha cut and
 * coverage, swaying by `time` (seconds), crown and card normals, and
 * sunlight through the leaves. Bark shares it (its own normals, no light through).
 */
export function createFoliageMaterial(): {
  textures: FoliageTextures;
  material: MeshStandardMaterial;
  time: { value: number };
} {
  const atlas = createFoliageTextures();
  const time = { value: 0 };
  const foliage = new MeshStandardMaterial({
    map: atlas.map,
    // The barks' relief (flat on leaves).
    normalMap: atlas.normalMap,
    vertexColors: true,
    alphaTest: ALPHA_CUT,
    alphaToCoverage: true,
    side: DoubleSide,
    // Leaves are a little waxy: a soft sheen where the sun catches them.
    roughness: 0.74,
    metalness: 0,
  });
  foliage.onBeforeCompile = (shader) => {
    shader.uniforms['vegTime'] = time;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
  attribute float sway;
  uniform float vegTime;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
  #ifdef USE_INSTANCING
  vec3 vegAt = instanceMatrix[3].xyz;
  #else
  vec3 vegAt = vec3(0.0);
  #endif
  float vegPhase = vegTime * 1.3 + vegAt.x * 0.21 + vegAt.z * 0.17;
  transformed.x += sway * 0.05 * (sin(vegPhase) + 0.4 * sin(vegPhase * 2.7 + position.y));
  transformed.z += sway * 0.04 * sin(vegPhase * 1.3 + position.x);`,
      );
    // Lit by the crown's outward normals on both faces (no flipped back faces),
    // with some of each card's own facing (turned to the crown's side), so
    // clusters catch the light one by one.
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
  // Leaves 1, bark 0: bark keeps its own (round) normals and lets no light through.
  float vegLeaf = ${barkUvTest('vMapUv')} ? 0.0 : 1.0;
  vec3 vegCrown = normalize(vNormal);
  vec3 vegCard = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
  if (dot(vegCard, vegCrown) < 0.0) vegCard = -vegCard;
  normal = normalize(mix(vegCrown, vegCard, ${CARD_NORMAL_SHARE.toFixed(2)} * vegLeaf));
  // The normal map's frame round the normal just chosen.
  tbn = getTangentFrame(-vViewPosition, normal, vNormalMapUv);`,
      )
      .replace('#include <lights_fragment_begin>', foliageLights());
  };
  foliage.customProgramCacheKey = () => 'forest';
  return { textures: atlas, material: foliage, time };
}

const RESELECT_MS = 150;
/** Understorey: round the camera, grown cell by cell for at most this long per frame, milliseconds. */
const UNDER_RADIUS_M = 80;
const UNDER_BUDGET_MS = 1.5;
/** Cells waiting for their ground are retried this often, milliseconds. */
const UNDER_RETRY_MS = 300;
const UNDER_CELL_M = 4;
const MAX_WIDEN = 1.8;
/** Distance steps of the widening, metres. */
const WIDEN_STEP_M = 40;
/**
 * The bands: the near models are rich (layers of leaf cards, costly to fill),
 * so they reach only this far, and medium ones this far; the far band and
 * thinning are the quality preset's, metres.
 */
const NEAR_M = 45;
const MEDIUM_M = 320;
const forestBands = (s: LodSettings): LodSettings => ({
  ...s,
  near: Math.min(s.near, NEAR_M),
  medium: Math.min(s.medium, MEDIUM_M),
});

/** Species for each of the game's plant kinds, with weights. */
const KIND_SPECIES: Readonly<Record<string, readonly [SpeciesName, number][]>> = {
  broadleaf: [
    ['whiteOak', 22],
    ['redOak', 17],
    ['chestnutOak', 8],
    ['tulipPoplar', 18],
    ['redMaple', 14],
    ['sweetgum', 9],
    ['beech', 8],
    ['hickory', 6],
  ],
  conifer: [
    ['redCedar', 50],
    ['virginiaPine', 50],
  ],
  pine: [
    ['loblolly', 70],
    ['virginiaPine', 30],
  ],
  smallTree: [
    ['dogwood', 35],
    ['holly', 35],
    ['redMaple', 15],
    ['beech', 15],
  ],
  deadTree: [['snag', 1]],
  shrub: [
    ['laurel', 30],
    ['spicebush', 25],
    ['blueberry', 20],
    ['greenbrier', 25],
  ],
};

/** Saplings of these grow as small trees (scaled down). */
const UNDERSTOREY: readonly [SpeciesName, number, number][] = [
  // species, weight, height scale range low (high = low + 0.6)
  ['laurel', 3, 0.7],
  ['spicebush', 2, 0.6],
  ['blueberry', 1.5, 0.7],
  ['greenbrier', 1.2, 0.7],
  ['fern', 4, 0.7],
  ['holly', 0.5, 0.25],
  ['dogwood', 0.35, 0.35],
  ['beech', 0.3, 0.12],
];

const hash = (a: number, b: number, c: number): number => {
  let h =
    Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
/** Smooth value noise in [0, 1) at `scale` metres. */
const noise = (x: number, y: number, scale: number, seed: number): number => {
  const fx = x / scale;
  const fy = y / scale;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const v00 = hash(ix, iy, seed);
  const v10 = hash(ix + 1, iy, seed);
  const v01 = hash(ix, iy + 1, seed);
  const v11 = hash(ix + 1, iy + 1, seed);
  return v00 + (v10 - v00) * sx + (v01 - v00) * sy + (v00 - v10 - v01 + v11) * sx * sy;
};

interface Model {
  readonly name: string;
  readonly height: number;
  readonly lodScale: number;
  readonly tree: boolean;
  readonly meshes: InstancedMesh[];
  readonly targets: Target[];
}

/** One buffer set: arrays and the attributes drawing from them (null until needed). */
interface Buffers {
  m: Float32Array;
  c: Float32Array;
  am: InstancedBufferAttribute | null;
  ac: InstancedBufferAttribute | null;
  count: number;
}

/**
 * A model's instances in one band. Selections are written into the spare
 * buffers, which then take the front's place (double buffering): the GPU is
 * never asked to update a buffer it may still be drawing from, which can
 * stall the driver. A selection that changed nothing uploads nothing.
 */
interface Target {
  /** The spare set's arrays, being written. */
  matrices: Float32Array;
  colors: Float32Array;
  capacity: number;
  /** Most it may hold (beyond: skipped). */
  limit: number;
  count: number;
  front: Buffers;
  spare: Buffers;
}

const attribute = (array: Float32Array, size: number) => {
  const a = new InstancedBufferAttribute(array, size);
  a.setUsage(DynamicDrawUsage);
  return a;
};
const samePrefix = (a: Float32Array, b: Float32Array, n: number) => {
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return false;
  return true;
};

export interface ForestOptions {
  readonly instances: VegetationInstances;
  readonly field: TerrainField;
  /** The ground's surface (its loaded tiles give where the understorey can grow). */
  readonly surface: TerrainSurface;
  readonly settings: LodSettings;
  readonly shadows: { cast: boolean; receive: boolean };
}

export function createForest(o: ForestOptions): VegetationLayer & {
  readonly understorey: () => number;
} {
  const { instances: inst, field } = o;
  const group = new Group();
  group.name = 'vegetation';
  const { textures: atlas, material: foliage, time } = createFoliageMaterial();
  const propMaterial = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.9,
    metalness: 0,
  });

  const trees: TreeModel[] = treeModels();
  const modelOf = new Map<string, number>();
  const models: Model[] = [];
  const bySpecies = new Map<SpeciesName, number[]>();
  trees.forEach((t) => {
    modelOf.set(`${t.species}:${String(t.variant)}`, models.length);
    const list = bySpecies.get(t.species) ?? [];
    list.push(models.length);
    bySpecies.set(t.species, list);
    models.push({
      name: `${t.spec.name} ${String(t.variant)}`,
      height: t.spec.height,
      lodScale: t.spec.lodScale,
      tree: true,
      meshes: [],
      targets: [],
    });
  });
  const firstProp = models.length;
  const props = plantModels();
  const propModel = new Map<number, number>();
  props.forEach((pm, p) => {
    if (pm.spec.kind !== 'prop') return;
    propModel.set(p, models.length);
    models.push({
      name: pm.spec.name,
      height: pm.spec.height,
      lodScale: pm.spec.lodScale,
      tree: false,
      meshes: [],
      targets: [],
    });
  });

  // Each placed plant: its model, scale and colour.
  const n = inst.count;
  const mModel = new Int32Array(n).fill(-1);
  const mScale = new Float32Array(n * 2);
  const mTint = new Float32Array(n * 3);
  const counts = new Array<number>(models.length).fill(0);
  const pick = (
    choices: readonly [SpeciesName, number][],
    x: number,
    y: number,
    salt: number,
  ): SpeciesName => {
    // Species grow in stands: each species' weight swells and shrinks with its own slow noise.
    let total = 0;
    const w = choices.map(([s, wt], k) => {
      const v = wt * (0.25 + 1.5 * noise(x, y, 70, 0x5ec1 + k * 97 + salt));
      total += v;
      return [s, v] as const;
    });
    let r = hash(Math.round(x * 10), Math.round(y * 10), 0x51) * total;
    for (const [s, v] of w) {
      r -= v;
      if (r <= 0) return s;
    }
    return w[w.length - 1]?.[0] ?? 'whiteOak';
  };
  for (let i = 0; i < n; i += 1) {
    const p = inst.plant[i] ?? 0;
    const spec = PLANTS[p];
    if (!spec) continue;
    const x = inst.position[i * 3] ?? 0;
    const y = inst.position[i * 3 + 1] ?? 0;
    if (spec.kind === 'prop') {
      const m = propModel.get(p);
      if (m === undefined) continue;
      mModel[i] = m;
      mScale[i * 2] = inst.scale[i * 2] ?? 1;
      mScale[i * 2 + 1] = inst.scale[i * 2 + 1] ?? 1;
      mTint.set(
        [inst.tint[i * 3] ?? 1, inst.tint[i * 3 + 1] ?? 1, inst.tint[i * 3 + 2] ?? 1],
        i * 3,
      );
      counts[m] = (counts[m] ?? 0) + 1;
      continue;
    }
    const choices = KIND_SPECIES[spec.kind];
    if (!choices) continue;
    const species = pick(choices, x, y, p);
    const variants = bySpecies.get(species) ?? [];
    const m =
      variants[Math.floor(hash(Math.round(x * 10), Math.round(y * 10), 0x77) * variants.length)];
    if (m === undefined) continue;
    mModel[i] = m;
    // The height the game gave this plant (its area's canopy), in this model's units.
    const want = (inst.scale[i * 2 + 1] ?? 1) * spec.height;
    const sh = (want / SPECIES[species].height) * (spec.kind === 'smallTree' ? 0.9 : 1);
    const aspect = 0.85 + 0.3 * hash(Math.round(x * 10), Math.round(y * 10), 0x99);
    mScale[i * 2] = sh * aspect;
    mScale[i * 2 + 1] = sh;
    // A little colour variety per plant (the game's tint, softened).
    for (let c = 0; c < 3; c += 1) mTint[i * 3 + c] = Math.sqrt(inst.tint[i * 3 + c] ?? 1);
    counts[m] = (counts[m] ?? 0) + 1;
  }

  // Meshes per model and band.
  const understoreyRoom = (name: SpeciesName) => (UNDERSTOREY.some(([s]) => s === name) ? 6000 : 0);
  const meshes: InstancedMesh[] = [];
  models.forEach((model, mi) => {
    const tree = mi < firstProp ? trees[mi] : undefined;
    const prop =
      mi >= firstProp ? [...propModel.entries()].find(([, v]) => v === mi)?.[0] : undefined;
    for (let band = 0; band < LOD_LEVELS; band += 1) {
      const extra = tree && band < 2 ? understoreyRoom(tree.species) : 0;
      const total = (counts[mi] ?? 0) + extra;
      const limit = Math.min(
        total,
        band === 0 ? NEAR_CAPACITY + extra : band === 1 ? MEDIUM_CAPACITY + extra : Infinity,
      );
      // Buffers start small and grow as needed: updating part of a large
      // buffer the GPU is drawing from can cost a copy of all of it.
      const capacity = Math.max(1, Math.min(limit, INITIAL_CAPACITY));
      const geometry = new BufferGeometry();
      if (tree) {
        const g = tree.lods[band] ?? tree.lods[0];
        geometry.setAttribute('position', new BufferAttribute(g.positions, 3));
        geometry.setAttribute('normal', new BufferAttribute(g.normals, 3));
        geometry.setAttribute('uv', new BufferAttribute(g.uvs, 2));
        geometry.setAttribute('color', new BufferAttribute(g.colors, 3));
        geometry.setAttribute('sway', new BufferAttribute(g.sway, 1));
      } else if (prop !== undefined) {
        const data = props[prop]?.lods[band];
        if (data) {
          geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
          geometry.setAttribute('normal', new BufferAttribute(data.normals, 3));
          if (data.colors) geometry.setAttribute('color', new BufferAttribute(data.colors, 3));
        }
      }
      const mesh = new InstancedMesh(geometry, tree ? foliage : propMaterial, capacity);
      mesh.name = `vegetation: ${model.name} ${['near', 'medium', 'far'][band] ?? ''}`;
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      mesh.instanceColor.setUsage(DynamicDrawUsage);
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false;
      meshes.push(mesh);
      group.add(mesh);
      model.meshes.push(mesh);
      const spare: Buffers = {
        m: new Float32Array(capacity * 16),
        c: new Float32Array(capacity * 3),
        am: null,
        ac: null,
        count: 0,
      };
      model.targets.push({
        matrices: spare.m,
        colors: spare.c,
        capacity: total > 0 ? capacity : 0,
        limit: total > 0 ? limit : 0,
        count: 0,
        front: {
          m: mesh.instanceMatrix.array as Float32Array,
          c: mesh.instanceColor.array as Float32Array,
          am: mesh.instanceMatrix,
          ac: mesh.instanceColor,
          count: 0,
        },
        spare,
      });
    }
  });

  const { tiles } = inst;
  const tileCount = tiles.columns * tiles.rows;
  const tileBoxes = Array.from({ length: tileCount }, (_, t) => {
    const x0 = tiles.originX + (t % tiles.columns) * tiles.size;
    const y0 = tiles.originY + Math.floor(t / tiles.columns) * tiles.size;
    const m = 14;
    return new Box3(
      new Vector3(x0 - m, tiles.zMin[t] ?? 0, -(y0 + tiles.size + m)),
      new Vector3(x0 + tiles.size + m, (tiles.zMax[t] ?? 0) + 15, -(y0 - m)),
    );
  });

  let settings = forestBands(o.settings);
  const applyShadows = (s: { cast: boolean; receive: boolean }) => {
    for (const model of models)
      model.meshes.forEach((mesh, band) => {
        mesh.castShadow = s.cast && band < (model.lodScale < 0.5 ? 1 : 2);
        mesh.receiveShadow = s.receive;
      });
  };
  applyShadows(o.shadows);

  // Understorey round the camera.
  interface Under {
    model: number;
    x: number;
    y: number;
    z: number;
    yaw: number;
    s: number;
    h: number;
  }
  let under: Under[] = [];
  /** Cells grown so far (by key); a cell whose ground tile was not loaded yet is retried later. */
  const cells = new Map<number, Under[]>();
  const cellKey = (c: number, r: number) => (c + 50_000) * 100_000 + (r + 50_000);
  /** Where the last scan was, and whether it left cells to grow. */
  let scanX = Infinity;
  let scanY = Infinity;
  let incomplete = true;
  let scanAt = -Infinity;
  let cellsChanged = false;
  /** Grows one cell's understorey, or returns null when its ground is not loaded yet. */
  const growCell = (c: number, r: number): Under[] | null => {
    const out: Under[] = [];
    const b = field.bounds;
    for (let k = 0; k < 2; k += 1) {
      const x = (c + hash(c, r, 11 + k)) * UNDER_CELL_M;
      const y = (r + hash(c, r, 23 + k)) * UNDER_CELL_M;
      if (x < b.minX || y < b.minY || x > b.maxX || y > b.maxY) continue;
      const f = groundFieldsAt(o.surface, x, y);
      if (!f) return null;
      // Under the woods' canopy only, clear of roads, walls and water.
      if (f.litter < 0.4 || f.road < 2.5 || f.building < 2.5 || f.shore < 1.5) continue;
      if (hash(c, r, 37 + k) > 0.75 * f.litter) continue;
      // Laurel thickets and fern patches; the rest scattered.
      const thicket = noise(x, y, 28, 0x1a);
      const ferny = noise(x, y, 22, 0x2b);
      let total = 0;
      const w = UNDERSTOREY.map(([s, wt]) => {
        let v = wt;
        if (s === 'laurel') v *= thicket > 0.55 ? 2.5 : 0.2;
        if (s === 'fern') v *= (ferny > 0.5 ? 2 : 0.4) * (1 + 2 * f.wet);
        total += v;
        return v;
      });
      let pickR = hash(c, r, 51 + k) * total;
      let choice = 0;
      for (let q = 0; q < w.length; q += 1) {
        pickR -= w[q] ?? 0;
        if (pickR <= 0) {
          choice = q;
          break;
        }
      }
      const [species, , low] = UNDERSTOREY[choice] ?? UNDERSTOREY[0] ?? ['fern', 1, 0.7];
      const variants = bySpecies.get(species) ?? [];
      const model = variants[Math.floor(hash(c, r, 61 + k) * variants.length)];
      if (model === undefined) continue;
      const sh = low + 0.6 * hash(c, r, 71 + k);
      out.push({
        model,
        x,
        y,
        z: o.surface.heightAt(x, y),
        yaw: hash(c, r, 81 + k) * Math.PI * 2,
        s: sh * (0.85 + 0.3 * hash(c, r, 91 + k)),
        h: sh,
      });
    }
    return out;
  };
  /**
   * Grows cells round (cx, cy), nearest first, for at most `budgetMs`; drops
   * cells out of range. Cheap once grown: only new cells cost anything.
   */
  const growUnderstorey = (cx: number, cy: number, budgetMs: number) => {
    // Nothing to do until the camera has moved a cell, unless cells are still to grow.
    // Nothing to do until the camera has moved a cell, unless cells are still to grow (and
    // then not more often than every few frames when they wait for their ground).
    const now = performance.now();
    const moved = (cx - scanX) ** 2 + (cy - scanY) ** 2 >= UNDER_CELL_M * UNDER_CELL_M;
    if (!moved && (!incomplete || now - scanAt < UNDER_RETRY_MS)) return false;
    scanX = cx;
    scanY = cy;
    scanAt = now;
    const started = now;
    const R = UNDER_RADIUS_M;
    const c0 = Math.floor((cx - R) / UNDER_CELL_M);
    const c1 = Math.floor((cx + R) / UNDER_CELL_M);
    const r0 = Math.floor((cy - R) / UNDER_CELL_M);
    const r1 = Math.floor((cy + R) / UNDER_CELL_M);
    const missing: [number, number, number][] = [];
    for (let r = r0; r <= r1; r += 1)
      for (let c = c0; c <= c1; c += 1) {
        const mx = (c + 0.5) * UNDER_CELL_M - cx;
        const my = (r + 0.5) * UNDER_CELL_M - cy;
        const d2 = mx * mx + my * my;
        if (d2 > R * R) continue;
        if (!cells.has(cellKey(c, r))) missing.push([d2, c, r]);
      }
    missing.sort((a, b) => a[0] - b[0]);
    incomplete = false;
    for (const [, c, r] of missing) {
      if (performance.now() - started > budgetMs) {
        incomplete = true;
        break;
      }
      const grown = growCell(c, r);
      if (!grown) {
        incomplete = true;
        continue;
      }
      cells.set(cellKey(c, r), grown);
      cellsChanged = true;
    }
    // Forget cells well out of range.
    const far = (R + 3 * UNDER_CELL_M) ** 2;
    for (const key of cells.keys()) {
      const c = Math.floor(key / 100_000) - 50_000;
      const r = (key % 100_000) - 50_000;
      const mx = (c + 0.5) * UNDER_CELL_M - cx;
      const my = (r + 0.5) * UNDER_CELL_M - cy;
      if (mx * mx + my * my > far) {
        cells.delete(key);
        cellsChanged = true;
      }
    }
    if (cellsChanged) {
      under = [...cells.values()].flat();
      cellsChanged = false;
      return true;
    }
    return false;
  };

  const write = (
    target: Model['targets'][number],
    x: number,
    y: number,
    z: number,
    yaw: number,
    sw: number,
    sh: number,
    r: number,
    g: number,
    bl: number,
  ) => {
    if (target.count >= target.capacity) {
      if (target.capacity >= target.limit) return;
      const capacity = Math.min(target.limit, target.capacity * 2);
      const matrices = new Float32Array(capacity * 16);
      matrices.set(target.matrices);
      const colors = new Float32Array(capacity * 3);
      colors.set(target.colors);
      target.matrices = matrices;
      target.colors = colors;
      target.capacity = capacity;
      // The spare set's attributes no longer fit: made anew when it is shown.
      target.spare = { m: matrices, c: colors, am: null, ac: null, count: 0 };
    }
    const k = target.count;
    target.count += 1;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const m = target.matrices;
    const o16 = k * 16;
    m[o16] = c * sw;
    m[o16 + 1] = 0;
    m[o16 + 2] = -s * sw;
    m[o16 + 3] = 0;
    m[o16 + 4] = 0;
    m[o16 + 5] = sh;
    m[o16 + 6] = 0;
    m[o16 + 7] = 0;
    m[o16 + 8] = s * sw;
    m[o16 + 9] = 0;
    m[o16 + 10] = c * sw;
    m[o16 + 11] = 0;
    m[o16 + 12] = x;
    m[o16 + 13] = z;
    m[o16 + 14] = -y;
    m[o16 + 15] = 1;
    target.colors[k * 3] = r;
    target.colors[k * 3 + 1] = g;
    target.colors[k * 3 + 2] = bl;
  };

  const frustum = new Frustum();
  const projection = new Matrix4();
  const lastPosition = new Vector3(Infinity, 0, 0);
  const lastDirection = new Vector3();
  const direction = new Vector3();
  let lastSelect = -Infinity;
  let pending = true;
  let stats: VegetationStats = {
    instances: n,
    drawn: [0, 0, 0],
    selections: 0,
    lastSelectMs: 0,
    tilesDrawn: 0,
  };
  const maxScale = 1;

  const select = (camera: PerspectiveCamera) => {
    const started = performance.now();
    camera.updateMatrixWorld();
    projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projection);
    const view = fromThree(camera.position);
    for (const model of models)
      for (const t of model.targets) {
        t.count = 0;
        t.matrices = t.spare.m;
        t.colors = t.spare.c;
        t.capacity = t.limit > 0 ? t.spare.m.length / 16 : 0;
      }
    const s = settings;
    let tilesDrawn = 0;
    for (let t = 0; t < tileCount; t += 1) {
      const zMin = tiles.zMin[t] ?? Infinity;
      if (zMin === Infinity) continue;
      const zMax = tiles.zMax[t] ?? zMin;
      const x0 = tiles.originX + (t % tiles.columns) * tiles.size;
      const y0 = tiles.originY + Math.floor(t / tiles.columns) * tiles.size;
      const dx = Math.max(x0 - view.x, 0, view.x - (x0 + tiles.size));
      const dy = Math.max(y0 - view.y, 0, view.y - (y0 + tiles.size));
      const dz = Math.max(zMin - view.z, 0, view.z - zMax);
      const nearest = Math.hypot(dx, dy, dz);
      if (nearest >= s.far * maxScale) continue;
      const box = tileBoxes[t];
      if (!box || !frustum.intersectsBox(box)) continue;
      tilesDrawn += 1;
      for (let p = 0; p < PLANTS.length; p += 1) {
        const a = tiles.starts[p * tileCount + t] ?? 0;
        const b = tiles.starts[p * tileCount + t + 1] ?? 0;
        if (a === b) continue;
        // In rank order: past the tile's thinning (for the largest plants) nothing more is drawn.
        const bound = keepFraction(nearest, s, maxScale);
        for (let i = a; i < b; i += 1) {
          const mi = mModel[i] ?? -1;
          const model = models[mi];
          if (!model) continue;
          const scale = model.lodScale;
          if (nearest >= s.far * scale) continue;
          const rank = inst.rank[i] ?? 0;
          // (The tile's nearest point keeps the most: past it, no plant of the tile is kept.)
          if (rank >= bound) break;
          const x = inst.position[i * 3] ?? 0;
          const y = inst.position[i * 3 + 1] ?? 0;
          const z = inst.position[i * 3 + 2] ?? 0;
          const sw0 = mScale[i * 2] ?? 1;
          const sh = mScale[i * 2 + 1] ?? 1;
          const h = sh * model.height;
          const d = Math.hypot(x - view.x, y - view.y, z + h / 2 - view.z);
          const band = lodBand(d, s, scale);
          if (band < 0) continue;
          // Thinned by the plant's own distance, so the density changes smoothly,
          // never in steps at tile edges.
          const keep = keepFraction(d, s, scale);
          if (rank >= keep) continue;
          let widen = 1;
          if (band === LOD_LEVELS - 1 && model.tree) {
            // Kept crowns widen as the others thin, so cover is kept. In steps
            // of WIDEN_STEP_M of distance: rings, not tile edges, and buffers
            // need not be uploaded for every small move.
            const dq = Math.round(d / WIDEN_STEP_M) * WIDEN_STEP_M;
            widen = Math.min(MAX_WIDEN, 1 / Math.sqrt(keepFraction(dq, s, scale)));
          }
          const target = model.targets[band];
          if (!target) continue;
          write(
            target,
            x,
            y,
            z,
            inst.yaw[i] ?? 0,
            sw0 * widen,
            sh,
            mTint[i * 3] ?? 1,
            mTint[i * 3 + 1] ?? 1,
            mTint[i * 3 + 2] ?? 1,
          );
        }
      }
    }
    for (const u of under) {
      const model = models[u.model];
      if (!model) continue;
      const d = Math.hypot(u.x - view.x, u.y - view.y, u.z - view.z);
      const band = lodBand(d, s, model.lodScale);
      if (band < 0 || band > 1) continue;
      const target = model.targets[band];
      if (target) write(target, u.x, u.y, u.z, u.yaw, u.s, u.h, 1, 1, 1);
    }
    const drawn = [0, 0, 0];
    for (const model of models)
      model.targets.forEach((target, band) => {
        const mesh = model.meshes[band];
        if (!mesh) return;
        drawn[band] = (drawn[band] ?? 0) + target.count;
        const front = target.front;
        const back = target.spare;
        // Unchanged: keep drawing the front set.
        if (
          target.count === front.count &&
          samePrefix(target.matrices, front.m, target.count * 16) &&
          samePrefix(target.colors, front.c, target.count * 3)
        )
          return;
        back.count = target.count;
        mesh.count = target.count;
        mesh.visible = target.count > 0;
        if (target.count > 0) {
          back.am ??= attribute(back.m, 16);
          back.ac ??= attribute(back.c, 3);
          back.am.clearUpdateRanges();
          back.am.addUpdateRange(0, target.count * 16);
          back.am.needsUpdate = true;
          back.ac.clearUpdateRanges();
          back.ac.addUpdateRange(0, target.count * 3);
          back.ac.needsUpdate = true;
          mesh.instanceMatrix = back.am;
          mesh.instanceColor = back.ac;
        }
        target.front = back;
        target.spare = front;
      });
    stats = {
      instances: n,
      drawn,
      selections: stats.selections + 1,
      lastSelectMs: performance.now() - started,
      tilesDrawn,
    };
  };

  return {
    group,
    understorey: () => under.length,
    update(camera) {
      time.value = performance.now() / 1000;
      // The understorey grows round the camera a little each frame; new plants mean a new selection.
      const at = fromThree(camera.position);
      if (growUnderstorey(at.x, at.y, UNDER_BUDGET_MS)) pending = true;
      camera.getWorldDirection(direction);
      const height = Math.max(1, camera.position.y);
      const moved =
        camera.position.distanceTo(lastPosition) > Math.max(2, 0.01 * height) ||
        direction.dot(lastDirection) < 0.9995;
      if (moved) pending = true;
      const now = performance.now();
      const interval = Math.max(RESELECT_MS, 8 * stats.lastSelectMs);
      if (!pending || now - lastSelect < interval) return;
      lastSelect = now;
      lastPosition.copy(camera.position);
      lastDirection.copy(direction);
      pending = false;
      select(camera);
    },
    setSettings(next, shadows) {
      settings = forestBands(next);
      applyShadows(shadows);
      pending = true;
      lastSelect = -Infinity;
    },
    stats: () => stats,
    dispose() {
      for (const mesh of meshes) {
        mesh.geometry.dispose();
        mesh.dispose();
      }
      foliage.dispose();
      propMaterial.dispose();
      atlas.map.dispose();
      atlas.normalMap.dispose();
      group.clear();
    },
  };
}
