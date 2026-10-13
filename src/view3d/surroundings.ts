import {
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  DoubleSide,
  Mesh,
  MeshStandardMaterial,
} from 'three';
import type { TerrainDataset } from '#sim';
import type { TerrainField } from '#sim/terrain-field';

// The battlefield's surroundings (decoration, not simulated ground): walls
// from its edge down to a plain that reaches to the horizon. The plain lies
// below the lowest ground, so it never covers any of it.

/** Wall points along the edge at most this far apart, metres. */
const EDGE_STEP_M = 2;

/** The elevation of the plain round the battlefield: 2 m below its lowest ground. */
export function apronElevation(terrain: TerrainDataset): number {
  let lowest = Infinity;
  for (const e of terrain.heightfield.elevations) if (e < lowest) lowest = e;
  for (const e of terrain.refinement?.samples ?? []) if (e < lowest) lowest = e;
  return (Number.isFinite(lowest) ? lowest : 0) - 2;
}

/** The walls and the plain, round `field`'s battlefield, down to `baseZ`. */
export function surroundings(field: TerrainField, baseZ: number): Mesh[] {
  const b = field.bounds;
  // The outline, counter-clockwise from the south-west corner.
  const corners = [
    [b.minX, b.minY],
    [b.maxX, b.minY],
    [b.maxX, b.maxY],
    [b.minX, b.maxY],
  ] as const;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  corners.forEach(([ax, ay], i) => {
    const [bx, by] = corners[(i + 1) % 4] ?? corners[0];
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(len / EDGE_STEP_M));
    // Outward, to the right of a counter-clockwise outline, in Three.js axes.
    const nx = (by - ay) / len;
    const nz = (bx - ax) / len;
    for (let k = 0; k < n; k += 1) {
      const first = positions.length / 3;
      for (const t of [k / n, (k + 1) / n]) {
        const x = ax + (bx - ax) * t;
        const y = ay + (by - ay) * t;
        positions.push(x, field.height(x, y), -y, x, baseZ, -y);
        normals.push(nx, 0, nz, nx, 0, nz);
      }
      indices.push(first, first + 1, first + 2, first + 2, first + 1, first + 3);
    }
  });
  const wallGeometry = new BufferGeometry();
  wallGeometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  wallGeometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  wallGeometry.setIndex(indices);
  const walls = new Mesh(
    wallGeometry,
    new MeshStandardMaterial({ color: 0x6b6252, roughness: 1, metalness: 0, side: DoubleSide }),
  );
  walls.name = 'terrain edge';
  const span = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  const apron = new Mesh(
    new CircleGeometry(12 * span, 64).rotateX(-Math.PI / 2),
    new MeshStandardMaterial({ color: 0x59604f, roughness: 1, metalness: 0 }),
  );
  apron.name = 'surroundings';
  apron.position.set((b.minX + b.maxX) / 2, baseZ - 0.05, -(b.minY + b.maxY) / 2);
  return [walls, apron];
}
