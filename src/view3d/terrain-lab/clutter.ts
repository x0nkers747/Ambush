import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Vector3,
  type Group,
} from 'three';
import {
  BUILDING_RANGE,
  hash01,
  MATERIAL_BYTES,
  ROAD_EDGE_RANGE,
  RoadSurface,
  SHORE_RANGE,
  type TerrainSurface,
} from '#sim/terrain-lab';

// Near-field ground clutter (research §5.4): grass clumps, weeds, pebbles and
// leaf litter, GPU-instanced (one draw call per kind), placed per 4 m cell
// from a hash of the cell, so the same everywhere and always. Where it goes
// comes from the same material fields as the ground's shader: never on roads,
// water or against walls. Display only: it is not in the simulation.

const CELL_M = 4;

export interface ClutterSettings {
  /** Radius of grass, metres. */
  readonly radius: number;
  /** Multiplies every density. */
  readonly density: number;
}

export const CLUTTER_QUALITY: Readonly<Record<'low' | 'medium' | 'high', ClutterSettings>> = {
  low: { radius: 25, density: 0.5 },
  medium: { radius: 40, density: 1 },
  high: { radius: 60, density: 1.6 },
};

interface Kind {
  readonly name: string;
  readonly mesh: InstancedMesh;
  readonly capacity: number;
  count: number;
}

function grassClump(blades: number, height: number, seed: number): BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const nrm: number[] = [];
  const base = new Color(0x34401f);
  const tip = new Color(0x9aab62);
  for (let b = 0; b < blades; b += 1) {
    const a = hash01(b, seed, 11) * Math.PI * 2;
    const r = Math.sqrt(hash01(b, seed, 12)) * 0.13;
    const x0 = Math.cos(a) * r;
    const z0 = Math.sin(a) * r;
    const lean = (hash01(b, seed, 13) - 0.3) * 0.5;
    const facing = hash01(b, seed, 14) * Math.PI * 2;
    const h = height * (0.55 + 0.6 * hash01(b, seed, 15));
    const w = 0.008 + 0.008 * hash01(b, seed, 16);
    const fx = Math.cos(facing);
    const fz = Math.sin(facing);
    const lx = Math.cos(a) * lean;
    const lz = Math.sin(a) * lean;
    const segs = 2;
    const pts: [number, number, number, number][] = [];
    for (let s = 0; s <= segs; s += 1) {
      const t = s / segs;
      const bend = t * t;
      const width = w * (1 - t * 0.9);
      pts.push([x0 + lx * bend * h, t * h, z0 + lz * bend * h, width]);
    }
    for (let s = 0; s < segs; s += 1) {
      const p = pts[s];
      const q = pts[s + 1];
      if (!p || !q) continue;
      const quad = [
        [p[0] - fx * p[3], p[1], p[2] - fz * p[3], s / segs],
        [p[0] + fx * p[3], p[1], p[2] + fz * p[3], s / segs],
        [q[0] + fx * q[3], q[1], q[2] + fz * q[3], (s + 1) / segs],
        [q[0] - fx * q[3], q[1], q[2] - fz * q[3], (s + 1) / segs],
      ] as const;
      for (const i of [0, 1, 2, 0, 2, 3]) {
        const v = quad[i];
        if (!v) continue;
        pos.push(v[0], v[1], v[2]);
        const c = base.clone().lerp(tip, v[3]);
        col.push(c.r, c.g, c.b);
        // Lit like the ground under it.
        nrm.push(0, 1, 0);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  return g;
}

function leaf(): BufferGeometry {
  const pos = [-0.5, 0, -0.3, 0.5, 0, -0.3, 0.5, 0, 0.3, -0.5, 0, -0.3, 0.5, 0, 0.3, -0.5, 0, 0.3];
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute(
    'normal',
    new BufferAttribute(new Float32Array(Array.from({ length: 6 }, () => [0, 1, 0]).flat()), 3),
  );
  return g;
}

/** Fade and sway: added to three's standard vertex shader. */
function clutterMaterial(options: {
  sway: number;
  vertexColors: boolean;
  color?: number;
  side?: typeof DoubleSide;
}) {
  const m = new MeshStandardMaterial({
    vertexColors: options.vertexColors,
    color: options.color ?? 0xffffff,
    roughness: 0.95,
    metalness: 0,
    ...(options.side ? { side: options.side } : {}),
  });
  const uniforms = {
    clutterTime: { value: 0 },
    clutterFar: { value: 40 },
    clutterSway: { value: options.sway },
  };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float clutterTime;\nuniform float clutterFar;\nuniform float clutterSway;',
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec3 clutterAt = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float clutterD = distance(clutterAt, cameraPosition);
        float clutterK = 1.0 - smoothstep(clutterFar * 0.7, clutterFar, clutterD);
        transformed *= clutterK;
        float sw = sin(clutterTime * 1.7 + clutterAt.x * 0.31 + clutterAt.z * 0.27) + 0.5 * sin(clutterTime * 3.1 + clutterAt.x * 0.9);
        transformed.x += sw * clutterSway * transformed.y * transformed.y;`,
      );
    // Lit like the ground under them on both faces (no flipped back faces).
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_begin>',
      `#include <normal_fragment_begin>
  normal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);`,
    );
  };
  m.customProgramCacheKey = () =>
    `terrain-lab-clutter-${String(options.sway)}-${String(options.vertexColors)}`;
  return { material: m, uniforms };
}

export interface Clutter {
  update(cameraX: number, cameraY: number, time: number, force?: boolean): void;
  setSettings(s: ClutterSettings): void;
  setVisible(on: boolean): void;
  readonly stats: { instances: number; triangles: number; rebuildMs: number };
  dispose(): void;
}

export function createClutter(surface: TerrainSurface, group: Group): Clutter {
  let settings = CLUTTER_QUALITY.medium;
  const grassGeo = [grassClump(16, 0.22, 1), grassClump(12, 0.34, 2), grassClump(20, 0.16, 3)];
  const weedGeo = grassClump(5, 0.85, 4);
  const pebbleGeo = new IcosahedronGeometry(1, 0);
  const leafGeo = leaf();
  const grassMat = clutterMaterial({ sway: 0.12, vertexColors: true, side: DoubleSide });
  const weedMat = clutterMaterial({ sway: 0.08, vertexColors: true, side: DoubleSide });
  const pebbleMat = clutterMaterial({ sway: 0, vertexColors: false, color: 0x8d877c });
  const leafMat = clutterMaterial({
    sway: 0,
    vertexColors: false,
    color: 0xffffff,
    side: DoubleSide,
  });
  const make = (
    name: string,
    geo: BufferGeometry,
    mat: MeshStandardMaterial,
    capacity: number,
  ): Kind => {
    const mesh = new InstancedMesh(geo, mat, capacity);
    mesh.name = `clutter: ${name}`;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    group.add(mesh);
    return { name, mesh, capacity, count: 0 };
  };
  const kinds = {
    grass: grassGeo.map((g, i) => make(`grass ${String(i)}`, g, grassMat.material, 60_000)),
    weed: make('weeds', weedGeo, weedMat.material, 6_000),
    pebble: make('pebbles', pebbleGeo, pebbleMat.material, 20_000),
    leaf: make('leaves', leafGeo, leafMat.material, 30_000),
  };
  for (const m of [pebbleMat, leafMat]) m.material.vertexColors = false;
  const all = [...kinds.grass, kinds.weed, kinds.pebble, kinds.leaf];
  // Per-instance colours (pebbles and leaves vary).
  kinds.pebble.mesh.instanceColor = null;
  const stats = { instances: 0, triangles: 0, rebuildMs: 0 };
  let lastX = Infinity;
  let lastY = Infinity;
  const m4 = new Matrix4();
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const scale = new Vector3();
  const at = new Vector3();
  const tmp = new Object3D();
  const leafColour = new Color();

  const dec = (v: number, lo: number, hi: number) => lo + (v / 255) * (hi - lo);
  /** Material fields at a point from the level 0 tile (nearest sample), or null if not loaded. */
  const fieldsAt = (x: number, y: number) => {
    const s = surface.spacing;
    const I = Math.round((x - surface.originX) / s);
    const J = Math.round((y - surface.originY) / s);
    const tx = Math.floor(I / surface.cells);
    const ty = Math.floor(J / surface.cells);
    const t = surface.peek(0, tx, ty);
    if (!t) return null;
    const i = (J - ty * surface.cells + 1) * t.stride + (I - tx * surface.cells + 1);
    const m = i * MATERIAL_BYTES;
    const mat = t.material;
    return {
      road: dec(mat[m] ?? 0, ROAD_EDGE_RANGE[0], ROAD_EDGE_RANGE[1]),
      shore: dec(mat[m + 1] ?? 0, SHORE_RANGE[0], SHORE_RANGE[1]),
      building: dec(mat[m + 2] ?? 0, BUILDING_RANGE[0], BUILDING_RANGE[1]),
      surf: (mat[m + 3] ?? 0) & 7,
      shoreKind: ((mat[m + 3] ?? 0) >> 3) & 3,
      urban: ((mat[m + 3] ?? 0) & 64) !== 0,
      grass: (mat[m + 4] ?? 0) / 255,
      soil: (mat[m + 5] ?? 0) / 255,
      litter: (mat[m + 6] ?? 0) / 255,
      wet: (mat[m + 7] ?? 0) / 255,
    };
  };

  const rebuild = (cx: number, cy: number) => {
    const started = performance.now();
    for (const k of all) k.count = 0;
    const R = settings.radius;
    const dens = settings.density;
    const c0 = Math.floor((cx - R) / CELL_M);
    const c1 = Math.floor((cx + R) / CELL_M);
    const r0 = Math.floor((cy - R) / CELL_M);
    const r1 = Math.floor((cy + R) / CELL_M);
    const put = (
      k: Kind,
      x: number,
      y: number,
      z: number,
      s: number,
      yaw: number,
      tiltX = 0,
      sy = s,
    ) => {
      if (k.count >= k.capacity) return;
      q.setFromAxisAngle(up, yaw);
      if (tiltX !== 0) q.multiply(tmp.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), tiltX));
      at.set(x, z, -y);
      scale.set(s, sy, s);
      m4.compose(at, q, scale);
      k.mesh.setMatrixAt(k.count, m4);
      k.count += 1;
    };
    for (let r = r0; r <= r1; r += 1)
      for (let c = c0; c <= c1; c += 1) {
        const mx = (c + 0.5) * CELL_M - cx;
        const my = (r + 0.5) * CELL_M - cy;
        const d = Math.sqrt(mx * mx + my * my);
        if (d > R + CELL_M) continue;
        // Dense at one's feet, thinner further out (they also shrink in the shader).
        const rate = d < 14 ? 9 : d < 30 ? 3.5 : 1.2;
        const n = Math.round(CELL_M * CELL_M * rate * dens);
        for (let i = 0; i < n; i += 1) {
          const x = (c + hash01(c * 131 + i, r, 1)) * CELL_M;
          const y = (r + hash01(c * 131 + i, r, 2)) * CELL_M;
          const f = fieldsAt(x, y);
          if (!f) continue;
          if (f.shore < 0.15 || f.building < 0.5) continue;
          const onRoad = f.surf !== RoadSurface.None && f.road < (f.urban ? 1.3 : 0.5);
          const roll = hash01(c * 131 + i, r, 3);
          const z = surface.heightAt(x, y);
          const yaw = hash01(c * 131 + i, r, 4) * Math.PI * 2;
          if (onRoad) {
            // Track centres grow grass; carriageways and pavements nothing; shoulders some pebbles.
            if (f.surf === RoadSurface.Track && f.road < -1.0 && roll < 0.7)
              put(kinds.grass[i % 3] ?? kinds.weed, x, y, z, 0.6 + 0.4 * roll, yaw);
            else if (f.road > -0.2 && f.surf !== RoadSurface.Paving && roll < 0.25)
              put(
                kinds.pebble,
                x,
                y,
                z - 0.01,
                0.02 + 0.03 * hash01(i, r, c),
                yaw,
                0,
                0.012 + 0.02 * roll,
              );
            continue;
          }
          const grassy =
            f.grass * (1 - f.wet * 0.5) * (f.urban ? 0.45 : 1) * (f.shore < 1.2 ? 0.2 : 1);
          if (roll < grassy * 0.9) {
            const k = kinds.grass[(i + c + r) % 3] ?? kinds.weed;
            // Taller in meadows and verges than on lawns; a little longer further out, to fill the view.
            const tall = (f.urban ? 0.7 : 1) * (1 + Math.min(1, d / 40) * 0.5);
            put(k, x, y, z, (0.7 + 0.7 * hash01(i, r, c + 7)) * tall, yaw);
            if (roll < grassy * 0.015) put(kinds.weed, x, y, z, 0.8 + 0.5 * roll, yaw);
          } else if (f.litter > 0.3 && roll < 0.9 + 0.08 * f.litter) {
            put(
              kinds.leaf,
              x,
              y,
              z + 0.01,
              0.05 + 0.04 * hash01(i, c, r),
              yaw,
              (hash01(r, i, c) - 0.5) * 0.4,
            );
          }
          // Stones: on soil, shores and shoulders.
          const stony =
            (f.soil > 0.4 ? 0.06 : 0.015) + (f.shore < 1.5 && f.shoreKind === 1 ? 0.25 : 0);
          if (hash01(i, c, r + 9) < stony)
            put(
              kinds.pebble,
              x,
              y,
              z - 0.015,
              0.025 + 0.06 * roll * roll,
              yaw,
              0,
              0.015 + 0.03 * roll,
            );
          if (f.litter > 0.3 && hash01(c, r, i + 3) < f.litter * 1.2)
            put(
              kinds.leaf,
              x + 0.3,
              y - 0.2,
              z + 0.01,
              0.05 + 0.05 * roll,
              yaw + 1,
              (roll - 0.5) * 0.3,
            );
        }
      }
    let instances = 0;
    let triangles = 0;
    for (const k of all) {
      k.mesh.count = k.count;
      k.mesh.instanceMatrix.needsUpdate = true;
      if (k.count > 0) k.mesh.instanceMatrix.addUpdateRange(0, k.count * 16);
      instances += k.count;
      const pos = k.mesh.geometry.getAttribute('position');
      const tris = k.mesh.geometry.index ? k.mesh.geometry.index.count / 3 : pos.count / 3;
      triangles += tris * k.count;
    }
    // Instance colours (once): grass from lush to dry, autumn leaves, grey pebbles.
    if (!kinds.leaf.mesh.instanceColor) {
      for (const k of [...kinds.grass, kinds.weed])
        for (let i = 0; i < k.capacity; i += 1) {
          const v = 0.78 + 0.4 * hash01(i, 3, 3);
          const dry = hash01(i, 4, 4) ** 3;
          leafColour.setRGB(v * (1 + 0.25 * dry), v * (1 + 0.08 * dry), v * (1 - 0.15 * dry));
          k.mesh.setColorAt(i, leafColour);
        }
      for (let i = 0; i < kinds.leaf.capacity; i += 1) {
        const h = hash01(i, 5, 5);
        leafColour.setHSL(
          0.06 + 0.06 * h,
          0.45 + 0.25 * hash01(i, 6, 6),
          0.18 + 0.14 * hash01(i, 7, 7),
        );
        kinds.leaf.mesh.setColorAt(i, leafColour);
      }
      for (let i = 0; i < kinds.pebble.capacity; i += 1) {
        const v = 0.45 + 0.35 * hash01(i, 8, 8);
        leafColour.setRGB(v, v * 0.97, v * 0.92);
        kinds.pebble.mesh.setColorAt(i, leafColour);
      }
    }
    stats.instances = instances;
    stats.triangles = Math.round(triangles);
    stats.rebuildMs = performance.now() - started;
  };

  return {
    stats,
    update(cx, cy, time, force = false) {
      for (const m of [grassMat, weedMat, pebbleMat, leafMat]) {
        m.uniforms.clutterTime.value = time;
        m.uniforms.clutterFar.value = settings.radius;
      }
      const dx = cx - lastX;
      const dy = cy - lastY;
      if (!force && dx * dx + dy * dy < 9) return;
      lastX = cx;
      lastY = cy;
      rebuild(cx, cy);
    },
    setSettings(s) {
      settings = s;
      lastX = Infinity;
    },
    setVisible(on) {
      for (const k of all) k.mesh.visible = on;
    },
    dispose() {
      for (const k of all) {
        group.remove(k.mesh);
        k.mesh.dispose();
      }
      for (const g of [...grassGeo, weedGeo, pebbleGeo, leafGeo]) g.dispose();
      for (const m of [grassMat, weedMat, pebbleMat, leafMat]) m.material.dispose();
    },
  };
}
