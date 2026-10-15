import type { BufferGeometry } from 'three';
import {
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Shape,
  ShapeGeometry,
  Vector2,
  Vector3,
} from 'three';
import { boundsOf, pointInPolygon, type TerrainDataset, type VegetationArea } from '#sim';

// The Force-on-Force Lab's woods in 3D: every vegetation area the simulation
// knows (the terrain's vegetation, which obscures sight lines) as a darker
// floor and simple instanced trees (a trunk and a cone) or bushes, placed on
// a fixed grid inside it. Display only: what obscures sight is the area, not
// the trees drawn. (The game's own forest renderer needs its terrain-field
// pipeline, which the lab's synthetic ground does not have.)

export interface WoodsLayer {
  readonly group: Group;
  dispose(): void;
}

/** Spacing of drawn trees and bushes (m), by kind. */
const SPACING: Readonly<Record<VegetationArea['kind'], number>> = {
  woodland: 7,
  treeLine: 5,
  scrub: 4,
};

/** A fixed hash in [0, 1) of a point (no randomness: the same woods every time). */
function hash(x: number, y: number, k: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233 + k * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

export function createWoodsLayer(terrain: TerrainDataset, elevation: number): WoodsLayer {
  const group = new Group();
  group.name = 'woods';
  const areas = terrain.features.vegetation;
  const geometries: BufferGeometry[] = [];
  const materials: MeshStandardMaterial[] = [];
  if (areas.length === 0) return { group, dispose: () => undefined };

  const floor = new MeshStandardMaterial({ color: 0x3f5a2a, roughness: 1 });
  materials.push(floor);
  const trees: { x: number; y: number; h: number; r: number; kind: VegetationArea['kind'] }[] = [];
  for (const area of areas) {
    // Floor: the area's outline, just above the grass.
    // In the shape's plane y is north; turned flat, it lies at three.js z = −north.
    const shape = new Shape(area.boundary.map((p) => new Vector2(p.x, p.y)));
    const outline = new ShapeGeometry(shape).rotateX(-Math.PI / 2);
    geometries.push(outline);
    const mesh = new Mesh(outline, floor);
    mesh.position.y = elevation + 0.03;
    mesh.receiveShadow = true;
    group.add(mesh);
    const box = boundsOf(area.boundary);
    const step = SPACING[area.kind];
    for (let x = box.minX + step / 2; x < box.maxX; x += step) {
      for (let y = box.minY + step / 2; y < box.maxY; y += step) {
        const px = x + (hash(x, y, 1) - 0.5) * step * 0.8;
        const py = y + (hash(x, y, 2) - 0.5) * step * 0.8;
        if (!pointInPolygon({ x: px, y: py }, area.boundary)) continue;
        if (area.holes?.some((h) => pointInPolygon({ x: px, y: py }, h))) continue;
        const scale = 0.75 + hash(x, y, 3) * 0.5;
        trees.push({
          x: px,
          y: py,
          h: area.canopyHeightMeters * scale,
          r: area.kind === 'scrub' ? 1.6 * scale : 2.6 * scale,
          kind: area.kind,
        });
      }
    }
  }

  const trunk = new CylinderGeometry(0.18, 0.25, 1, 6).translate(0, 0.5, 0);
  const crown = new ConeGeometry(1, 1, 7).translate(0, 0.5, 0);
  const bush = new ConeGeometry(1, 1, 6).translate(0, 0.5, 0);
  geometries.push(trunk, crown, bush);
  const bark = new MeshStandardMaterial({ color: 0x5a4632, roughness: 1 });
  const leaves = new MeshStandardMaterial({ roughness: 0.95 });
  materials.push(bark, leaves);
  const tall = trees.filter((t) => t.kind !== 'scrub');
  const low = trees.filter((t) => t.kind === 'scrub');
  const trunks = new InstancedMesh(trunk, bark, tall.length);
  const crowns = new InstancedMesh(crown, leaves, tall.length);
  const bushes = new InstancedMesh(bush, leaves, low.length);
  const m = new Matrix4();
  const q = new Quaternion();
  const colour = new Color();
  const greens = [0x2f5a2a, 0x37652e, 0x2a4f27, 0x41702f];
  tall.forEach((t, i) => {
    m.compose(new Vector3(t.x, elevation, -t.y), q, new Vector3(1, t.h * 0.45, 1));
    trunks.setMatrixAt(i, m);
    m.compose(new Vector3(t.x, elevation + t.h * 0.3, -t.y), q, new Vector3(t.r, t.h * 0.7, t.r));
    crowns.setMatrixAt(i, m);
    crowns.setColorAt(i, colour.setHex(greens[i % greens.length] ?? 0x2f5a2a));
  });
  low.forEach((t, i) => {
    m.compose(new Vector3(t.x, elevation, -t.y), q, new Vector3(t.r, t.h, t.r));
    bushes.setMatrixAt(i, m);
    bushes.setColorAt(i, colour.setHex(greens[(i + 1) % greens.length] ?? 0x37652e));
  });
  for (const mesh of [trunks, crowns, bushes]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    group.add(mesh);
  }
  return {
    group,
    dispose() {
      for (const g of geometries) g.dispose();
      for (const mat of materials) mat.dispose();
      trunks.dispose();
      crowns.dispose();
      bushes.dispose();
    },
  };
}
