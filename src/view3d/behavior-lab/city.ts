import {
  BoxGeometry,
  type BufferGeometry,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three';
import { urbanKind, urbanStreets, type UrbanKind } from '#exercise/behavior-lab';
import type { TerrainDataset } from '#sim';

// The Behavior Lab's urban district in 3D: every obstacle the simulation
// knows (the terrain's buildings) as a box of its footprint and height,
// coloured by kind (instanced, one draw per kind), with asphalt streets.
// Drawn from the terrain the run uses, so what blocks the soldiers is what
// is seen.

const COLOURS: Readonly<Record<UrbanKind, readonly number[]>> = {
  building: [0xb9b2a6, 0xa9a39a, 0xc4bcae, 0x9c958b],
  house: [0xd8cdb6, 0xc9b79c, 0xe0d6c4, 0xb8a58c, 0xcfc2ab],
  shed: [0x8a6f4e, 0x7b6346],
  wall: [0x9a9590, 0x8d8882],
  car: [0x3a5f8f, 0x8f2f2f, 0xd0d0d0, 0x2b2b2b, 0x6f7f3a, 0xc9a23a],
  container: [0xa8432f, 0x2f6a8f, 0x4f7a3a, 0xb07a2a],
};

export interface CityLayer {
  readonly group: Group;
  dispose(): void;
}

/** The district of `terrain` (its buildings), standing on ground at `elevation`. */
export function createCityLayer(terrain: TerrainDataset, elevation: number): CityLayer {
  const group = new Group();
  group.name = 'city';
  const buildings = terrain.features.buildings;
  const box = new BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const materials: MeshStandardMaterial[] = [];
  const byKind = new Map<UrbanKind, typeof buildings>();
  for (const b of buildings) {
    const kind = urbanKind(b.id);
    const list = byKind.get(kind) ?? [];
    byKind.set(kind, [...list, b]);
  }
  const m = new Matrix4();
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const colour = new Color();
  for (const [kind, list] of byKind) {
    const material = new MeshStandardMaterial({
      roughness: kind === 'car' ? 0.4 : 0.9,
      metalness: kind === 'car' || kind === 'container' ? 0.3 : 0,
    });
    materials.push(material);
    const mesh = new InstancedMesh(box, material, list.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    list.forEach((b, i) => {
      // A rectangle footprint: centre, width (first edge), depth (second edge), angle.
      const [p0, p1, p2] = b.footprint;
      if (!p0 || !p1 || !p2) return;
      const ex = p1.x - p0.x;
      const ey = p1.y - p0.y;
      const w = Math.hypot(ex, ey);
      const d = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const cx = (p0.x + p2.x) / 2;
      const cy = (p0.y + p2.y) / 2;
      // Three.js: x east, y up, z south; the edge's angle about y.
      q.setFromAxisAngle(up, Math.atan2(ey, ex));
      m.compose(new Vector3(cx, elevation, -cy), q, new Vector3(w, b.heightMeters, d));
      mesh.setMatrixAt(i, m);
      const palette = COLOURS[kind];
      mesh.setColorAt(i, colour.setHex(palette[i % palette.length] ?? 0x999999));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    group.add(mesh);
  }
  // Streets: asphalt just above the grass.
  const asphalt = new MeshStandardMaterial({ color: 0x4a4c4e, roughness: 0.95 });
  materials.push(asphalt);
  const geometries: BufferGeometry[] = [box];
  if (buildings.length > 0) {
    for (const s of urbanStreets()) {
      const plane = new PlaneGeometry(s.w, s.d).rotateX(-Math.PI / 2);
      geometries.push(plane);
      const street = new Mesh(plane, asphalt);
      street.position.set(s.x, elevation + 0.02, -s.y);
      street.receiveShadow = true;
      group.add(street);
    }
  }
  return {
    group,
    dispose() {
      for (const g of geometries) g.dispose();
      for (const mat of materials) mat.dispose();
    },
  };
}
