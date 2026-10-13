import {
  Box3,
  BufferAttribute,
  DataArrayTexture,
  FloatType,
  Frustum,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  NoColorSpace,
  RedFormat,
  RGBAFormat,
  Sphere,
  UnsignedByteType,
  Vector3,
  type PerspectiveCamera,
} from 'three';
import { MATERIAL_BYTES, type SurfaceTile, type TerrainSurface } from '#sim/terrain-lab';
import type { GroundTextures } from './ground-textures';
import {
  FRAGMENT_ALBEDO,
  FRAGMENT_BEGIN,
  FRAGMENT_HEAD,
  FRAGMENT_NORMAL,
  FRAGMENT_ROUGHNESS,
  VERTEX_BODY,
  VERTEX_HEAD,
  VERTEX_NORMAL,
} from './terrain-shader';
import type { TilePool } from './tile-pool';

// CDLOD terrain (research §5.4; Strugar 2009): a quadtree over the
// battlefield, nodes selected by distance and frustum each frame, every node
// drawn as one instance of a single 32 × 32 grid in one draw call, heights
// and material fields read from tile atlases. Tiles come from the workers;
// a node whose finer children have no tiles yet is drawn at its own level
// until they arrive.

/** Quads per node side. */
export const NODE_QUADS = 32;
/** Level 0 range as a multiple of the level 0 node size. */
const RANGE_FACTOR = 3;
/** Atlas layers (tiles resident on the GPU). */
const ATLAS_LAYERS = 256;
/** Most tile uploads per frame. */
const UPLOADS_PER_FRAME = 12;
/** Most instances. */
const MAX_NODES = 2048;

export type DebugView = 'off' | 'lod' | 'tiles' | 'fields';

export interface TerrainRendererStats {
  nodes: number;
  nodesPerLevel: number[];
  triangles: number;
  resident: number;
  uploads: number;
  waiting: number;
  atlasBytes: number;
  /** Tiles made by the workers, and their total generation time (worker clocks). */
  workerTiles: number;
  workerMs: number;
}

export interface TerrainRenderer {
  readonly mesh: Mesh;
  /** Selects nodes for this camera, requests and uploads tiles. Call every frame before rendering. */
  update(camera: PerspectiveCamera): void;
  setTextures(t: GroundTextures): void;
  setDebug(view: DebugView): void;
  setWireframe(on: boolean): void;
  setAdvanced(on: boolean): void;
  setMorph(on: boolean): void;
  readonly stats: TerrainRendererStats;
  /** Levels in the quadtree (0 = finest). */
  readonly levels: number;
  dispose(): void;
}

const tintVectors = (t: readonly number[]) =>
  Array.from({ length: t.length / 3 }, (_, i) => new Vector3(t[3 * i], t[3 * i + 1], t[3 * i + 2]));

function gridGeometry(): InstancedBufferGeometry {
  const n = NODE_QUADS;
  const pos = new Float32Array((n + 1) * (n + 1) * 3);
  for (let j = 0; j <= n; j += 1)
    for (let i = 0; i <= n; i += 1) {
      const k = (j * (n + 1) + i) * 3;
      pos[k] = i;
      pos[k + 1] = j;
    }
  // Two triangles per cell, split SW–NE, as the simulation's surface.
  const idx = new Uint16Array(n * n * 6);
  let o = 0;
  for (let j = 0; j < n; j += 1)
    for (let i = 0; i < n; i += 1) {
      const sw = j * (n + 1) + i;
      const se = sw + 1;
      const nw = sw + n + 1;
      const ne = nw + 1;
      // Three's y is up and map y becomes −z: wind so the faces point up.
      idx.set([sw, se, ne, sw, ne, nw], o);
      o += 6;
    }
  const g = new InstancedBufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setIndex(new BufferAttribute(idx, 1));
  g.setAttribute('iNode', new InstancedBufferAttribute(new Float32Array(MAX_NODES * 4), 4));
  g.setAttribute('iTile', new InstancedBufferAttribute(new Float32Array(MAX_NODES * 4), 4));
  g.instanceCount = 0;
  // Culled per node, not per mesh.
  g.boundingSphere = new Sphere(new Vector3(), 1e9);
  g.boundingBox = new Box3(new Vector3(-1e9, -1e9, -1e9), new Vector3(1e9, 1e9, 1e9));
  return g;
}

export function createTerrainRenderer(
  surface: TerrainSurface,
  pool: TilePool,
  textures: GroundTextures,
): TerrainRenderer {
  const s = surface.spacing;
  const cells = surface.cells;
  const stride = cells + 3;
  const nodeCells = NODE_QUADS;
  const nodesPerTile = cells / nodeCells;
  const ox = surface.originX;
  const oy = surface.originY;
  const b = surface.field.bounds;
  const extent = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  let top = 0;
  while (nodeCells * s * 2 ** top < extent) top += 1;
  const levels = top + 1;
  const nodeSize = (m: number) => nodeCells * s * 2 ** m;
  const range = (m: number) => RANGE_FACTOR * nodeSize(0) * 2 ** m;

  // Atlases.
  const heightData = new Float32Array(stride * stride * ATLAS_LAYERS);
  const matAData = new Uint8Array(stride * stride * 4 * ATLAS_LAYERS);
  const matBData = new Uint8Array(stride * stride * 4 * ATLAS_LAYERS);
  const heightTex = new DataArrayTexture(heightData, stride, stride, ATLAS_LAYERS);
  heightTex.format = RedFormat;
  heightTex.type = FloatType;
  heightTex.minFilter = NearestFilter;
  heightTex.magFilter = NearestFilter;
  heightTex.generateMipmaps = false;
  heightTex.colorSpace = NoColorSpace;
  heightTex.needsUpdate = true;
  const matTex = (data: Uint8Array) => {
    const t = new DataArrayTexture(data, stride, stride, ATLAS_LAYERS);
    t.format = RGBAFormat;
    t.type = UnsignedByteType;
    t.minFilter = LinearFilter;
    t.magFilter = LinearFilter;
    t.generateMipmaps = false;
    t.colorSpace = NoColorSpace;
    t.needsUpdate = true;
    return t;
  };
  const matATex = matTex(matAData);
  const matBTex = matTex(matBData);

  const key = (m: number, tx: number, ty: number) => `${String(m)}/${String(tx)}/${String(ty)}`;
  /** Resident tiles: key → layer, with the frame each was last used. */
  const resident = new Map<string, { layer: number; used: number; tile: SurfaceTile }>();
  const freeLayers: number[] = [];
  for (let i = ATLAS_LAYERS - 1; i >= 0; i -= 1) freeLayers.push(i);
  const arrived: SurfaceTile[] = [];
  const requested = new Set<string>();
  let frame = 0;

  const upload = (t: SurfaceTile): boolean => {
    let layer = freeLayers.pop();
    if (layer === undefined) {
      // Evict the least recently used tile not used this frame.
      let oldest: string | null = null;
      let oldestUsed = Infinity;
      for (const [k, r] of resident)
        if (r.used < frame - 1 && r.used < oldestUsed) {
          oldest = k;
          oldestUsed = r.used;
        }
      if (oldest === null) return false;
      layer = resident.get(oldest)?.layer;
      resident.delete(oldest);
      if (layer === undefined) return false;
    }
    const n = stride * stride;
    heightData.set(t.heights, layer * n);
    const a = layer * n * 4;
    const mat = t.material;
    for (let i = 0; i < n; i += 1) {
      const src = i * MATERIAL_BYTES;
      const dst = a + i * 4;
      matAData[dst] = mat[src] ?? 0;
      matAData[dst + 1] = mat[src + 1] ?? 0;
      matAData[dst + 2] = mat[src + 2] ?? 0;
      matAData[dst + 3] = mat[src + 3] ?? 0;
      matBData[dst] = mat[src + 4] ?? 0;
      matBData[dst + 1] = mat[src + 5] ?? 0;
      matBData[dst + 2] = mat[src + 6] ?? 0;
      matBData[dst + 3] = mat[src + 7] ?? 0;
    }
    heightTex.addLayerUpdate(layer);
    matATex.addLayerUpdate(layer);
    matBTex.addLayerUpdate(layer);
    heightTex.needsUpdate = true;
    matATex.needsUpdate = true;
    matBTex.needsUpdate = true;
    resident.set(key(t.level, t.tx, t.ty), { layer, used: frame, tile: t });
    return true;
  };

  const request = (m: number, tx: number, ty: number) => {
    const k = key(m, tx, ty);
    if (requested.has(k) || resident.has(k)) return false;
    // Already made on this thread (or adopted earlier)?
    const cached = surface.peek(m, tx, ty);
    if (cached) {
      arrived.push(cached);
      requested.add(k);
      return true;
    }
    const ok = pool.request(m, tx, ty, (tile) => {
      surface.adopt(tile);
      arrived.push(tile);
      stats.workerTiles += 1;
      stats.workerMs += tile.ms;
    });
    if (ok) requested.add(k);
    return ok;
  };

  const material = new MeshStandardMaterial({ roughness: 1, metalness: 0 });
  const uniforms = {
    labHeight: { value: heightTex },
    labMatA: { value: matATex },
    labMatB: { value: matBTex },
    labAlbedo: { value: textures.albedo },
    labNormalMap: { value: textures.normal },
    labHra: { value: textures.hra },
    labStride: { value: stride },
    labCells: { value: cells },
    labCam: { value: new Vector3() },
    labDebug: { value: 0 },
    labAdvanced: { value: 1 },
    labMorph: { value: 1 },
    labBounds: { value: [b.minX, b.minY, b.maxX, b.maxY] },
    labTint: { value: tintVectors(textures.tints) },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_HEAD}`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${VERTEX_NORMAL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERTEX_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_HEAD}`)
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>\n${FRAGMENT_BEGIN}`,
      )
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAGMENT_ALBEDO}`)
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>\n${FRAGMENT_ROUGHNESS}`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>\n${FRAGMENT_NORMAL}`,
      );
  };
  material.customProgramCacheKey = () => 'terrain-lab-cdlod';

  const geometry = gridGeometry();
  const mesh = new Mesh(geometry, material);
  mesh.name = 'terrain-lab';
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  const iNode = geometry.getAttribute('iNode') as InstancedBufferAttribute;
  const iTile = geometry.getAttribute('iTile') as InstancedBufferAttribute;

  const stats: TerrainRendererStats = {
    nodes: 0,
    nodesPerLevel: Array.from({ length: levels }, () => 0),
    triangles: 0,
    resident: 0,
    uploads: 0,
    waiting: 0,
    atlasBytes: heightData.byteLength + matAData.byteLength + matBData.byteLength,
    workerTiles: 0,
    workerMs: 0,
  };

  const frustum = new Frustum();
  const projScreen = new Matrix4();
  const box = new Box3();
  const cam = new Vector3();
  const want: { m: number; tx: number; ty: number; d: number }[] = [];

  /** The resident tile holding node (m, nx, ny), or null. */
  const nodeTile = (m: number, nx: number, ny: number) => {
    const tx = Math.floor(nx / nodesPerTile);
    const ty = Math.floor(ny / nodesPerTile);
    const r = resident.get(key(m, tx, ty));
    return r ? { r, tx, ty } : null;
  };

  /** Distance from the camera (map frame) to a box. */
  const boxDistance = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
    const dx = Math.max(x0 - cam.x, 0, cam.x - x1);
    const dy = Math.max(y0 - cam.y, 0, cam.y - y1);
    const dz = Math.max(z0 - cam.z, 0, cam.z - z1);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  };

  let count = 0;
  const emit = (
    m: number,
    nx: number,
    ny: number,
    tile: { r: { layer: number }; tx: number; ty: number },
  ) => {
    if (count >= MAX_NODES) return;
    const size = nodeSize(m);
    iNode.setXYZW(count, ox + nx * size, oy + ny * size, s * 2 ** m, m);
    iTile.setXYZW(
      count,
      tile.r.layer,
      (nx - tile.tx * nodesPerTile) * nodeCells,
      (ny - tile.ty * nodesPerTile) * nodeCells,
      range(m),
    );
    count += 1;
    stats.nodesPerLevel[m] = (stats.nodesPerLevel[m] ?? 0) + 1;
  };

  const select = (m: number, nx: number, ny: number, zr: [number, number]) => {
    const size = nodeSize(m);
    const x0 = ox + nx * size;
    const y0 = oy + ny * size;
    if (x0 > b.maxX || y0 > b.maxY) return;
    const tile = nodeTile(m, nx, ny);
    if (!tile) return;
    tile.r.used = frame;
    const z0 = tile.r.tile.min;
    const z1 = tile.r.tile.max;
    zr[0] = z0;
    zr[1] = z1;
    // Three frame: (x, z, −y).
    box.min.set(x0, z0 - 1, -(y0 + size));
    box.max.set(x0 + size, z1 + 1, -y0);
    if (!frustum.intersectsBox(box)) return;
    const d = boxDistance(x0, y0, z0, x0 + size, y0 + size, z1);
    if (m === 0 || d > range(m - 1)) {
      emit(m, nx, ny, tile);
      return;
    }
    // Finer children need their tiles.
    let ready = true;
    for (let k = 0; k < 4; k += 1) {
      const cx = 2 * nx + (k & 1);
      const cy = 2 * ny + (k >> 1);
      const ctx = Math.floor(cx / nodesPerTile);
      const cty = Math.floor(cy / nodesPerTile);
      const ck = key(m - 1, ctx, cty);
      const r = resident.get(ck);
      if (r) r.used = frame;
      else {
        ready = false;
        if (!requested.has(ck)) want.push({ m: m - 1, tx: ctx, ty: cty, d });
      }
    }
    if (!ready) {
      emit(m, nx, ny, tile);
      return;
    }
    const czr: [number, number] = [0, 0];
    for (let k = 0; k < 4; k += 1) select(m - 1, 2 * nx + (k & 1), 2 * ny + (k >> 1), czr);
  };

  return {
    mesh,
    levels,
    stats,
    update(camera) {
      frame += 1;
      // Tiles that arrived: upload a few per frame.
      let uploads = 0;
      while (arrived.length > 0 && uploads < UPLOADS_PER_FRAME) {
        const t = arrived.shift();
        if (!t) break;
        const k = key(t.level, t.tx, t.ty);
        requested.delete(k);
        if (resident.has(k)) continue;
        if (upload(t)) uploads += 1;
      }
      stats.uploads = uploads;
      camera.updateMatrixWorld();
      projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projScreen);
      const p = camera.position;
      cam.set(p.x, -p.z, p.y);
      uniforms.labCam.value.copy(cam);
      count = 0;
      stats.nodesPerLevel.fill(0);
      want.length = 0;
      // Roots: the top level's nodes over the battlefield.
      const rootSize = nodeSize(top);
      const nr = Math.ceil(extent / rootSize);
      const zr: [number, number] = [0, 0];
      for (let ny = 0; ny < nr; ny += 1)
        for (let nx = 0; nx < nr; nx += 1) {
          const tile = nodeTile(top, nx, ny);
          if (!tile) {
            request(top, Math.floor(nx / nodesPerTile), Math.floor(ny / nodesPerTile));
            continue;
          }
          select(top, nx, ny, zr);
        }
      iNode.needsUpdate = true;
      iTile.needsUpdate = true;
      iNode.addUpdateRange(0, count * 4);
      iTile.addUpdateRange(0, count * 4);
      geometry.instanceCount = count;
      // Nearest first.
      want.sort((p1, p2) => p1.d - p2.d || p1.m - p2.m);
      for (const w of want) if (!request(w.m, w.tx, w.ty) && pool.pending() > pool.size * 3) break;
      stats.nodes = count;
      stats.triangles = count * NODE_QUADS * NODE_QUADS * 2;
      stats.resident = resident.size;
      stats.waiting = pool.pending() + arrived.length;
    },
    setTextures(t) {
      uniforms.labTint.value = tintVectors(t.tints);
      uniforms.labAlbedo.value = t.albedo;
      uniforms.labNormalMap.value = t.normal;
      uniforms.labHra.value = t.hra;
    },
    setDebug(view) {
      uniforms.labDebug.value = view === 'off' ? 0 : view === 'lod' ? 1 : view === 'tiles' ? 2 : 3;
    },
    setWireframe(on) {
      material.wireframe = on;
    },
    setAdvanced(on) {
      uniforms.labAdvanced.value = on ? 1 : 0;
    },
    setMorph(on) {
      uniforms.labMorph.value = on ? 1 : 0;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      heightTex.dispose();
      matATex.dispose();
      matBTex.dispose();
    },
  };
}
