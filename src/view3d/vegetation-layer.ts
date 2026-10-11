import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Frustum,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Vector3,
  type PerspectiveCamera,
} from 'three';
import { fromThree } from './axes';
import { LOD_LEVELS, PLANTS, type PlantModel } from './plant-models';
import { selectVegetation, type LodSettings, type LodTarget } from './vegetation-lod';
import type { VegetationInstances } from './vegetation-placement';

// The vegetation in the scene (docs/adr/0031): one InstancedMesh per plant
// model and level of detail (27 at most), all sharing one material, so the
// whole battlefield's trees and shrubs cost a few dozen draw calls. Which
// plants each mesh draws is chosen by `selectVegetation` when the camera has
// moved noticeably, at most a few times a second, never every frame; the
// instance buffers are then uploaded once. Nothing is regenerated when the
// camera moves.

/** The most plants drawn near and at medium range, per model (beyond: skipped). */
const NEAR_CAPACITY = 30_000;
const MEDIUM_CAPACITY = 150_000;
/** Reselect at most this often while the camera moves, milliseconds. */
const RESELECT_MS = 150;

export interface VegetationStats {
  readonly instances: number;
  /** Plants drawn in the last selection, per band (near, medium, far). */
  readonly drawn: readonly number[];
  readonly selections: number;
  /** Time of the last selection, milliseconds. */
  readonly lastSelectMs: number;
  readonly tilesDrawn: number;
}

export interface VegetationLayer {
  readonly group: Group;
  /** Chooses what to draw for this camera if it has moved enough. Call before each render. */
  update(camera: PerspectiveCamera): void;
  /** New distances (quality presets); reselects on the next update. */
  setSettings(settings: LodSettings, shadows: { cast: boolean; receive: boolean }): void;
  stats(): VegetationStats;
  dispose(): void;
}

export function createVegetationLayer(
  models: readonly PlantModel[],
  instances: VegetationInstances,
  initial: LodSettings,
  initialShadows: { cast: boolean; receive: boolean },
): VegetationLayer {
  const group = new Group();
  group.name = 'vegetation';
  // One material for every plant: vertex colours, tinted per instance.
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  const perPlant = PLANTS.map((_, p) => {
    const { tiles } = instances;
    const tileCount = tiles.columns * tiles.rows;
    return (tiles.starts[(p + 1) * tileCount] ?? 0) - (tiles.starts[p * tileCount] ?? 0);
  });

  const meshes: InstancedMesh[] = [];
  const targets: LodTarget[][] = models.map((model, p) =>
    model.lods.map((data, band) => {
      const capacity = Math.max(
        1,
        Math.min(
          perPlant[p] ?? 0,
          band === 0 ? NEAR_CAPACITY : band === 1 ? MEDIUM_CAPACITY : Infinity,
        ),
      );
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
      geometry.setAttribute('normal', new BufferAttribute(data.normals, 3));
      if (data.colors) geometry.setAttribute('color', new BufferAttribute(data.colors, 3));
      const mesh = new InstancedMesh(geometry, material, capacity);
      mesh.name = `vegetation: ${model.spec.name} ${['near', 'medium', 'far'][band] ?? ''}`;
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      mesh.instanceColor.setUsage(DynamicDrawUsage);
      mesh.count = 0;
      mesh.visible = false;
      // Culled by tile in `selectVegetation`; the default bounding-sphere test
      // would need the bounds of every instance.
      mesh.frustumCulled = false;
      meshes.push(mesh);
      group.add(mesh);
      return {
        matrices: mesh.instanceMatrix.array as Float32Array,
        colors: mesh.instanceColor.array as Float32Array,
        capacity: perPlant[p] ? capacity : 0,
        count: 0,
      };
    }),
  );

  // Tile bounds in Three.js axes, for the frustum test.
  const { tiles } = instances;
  const tileBoxes = Array.from({ length: tiles.columns * tiles.rows }, (_, t) => {
    const x0 = tiles.originX + (t % tiles.columns) * tiles.size;
    const y0 = tiles.originY + Math.floor(t / tiles.columns) * tiles.size;
    // A margin for crowns that overhang the tile.
    const m = 10;
    return new Box3(
      new Vector3(x0 - m, tiles.zMin[t] ?? 0, -(y0 + tiles.size + m)),
      new Vector3(x0 + tiles.size + m, tiles.zMax[t] ?? 0, -(y0 - m)),
    );
  });

  let settings = initial;
  const applyShadows = (s: { cast: boolean; receive: boolean }) => {
    meshes.forEach((mesh, i) => {
      // Only the near and medium meshes cast shadows; far plants are too small to matter.
      mesh.castShadow = s.cast && i % LOD_LEVELS < 2;
      mesh.receiveShadow = s.receive;
    });
  };
  applyShadows(initialShadows);

  const frustum = new Frustum();
  const projection = new Matrix4();
  const lastPosition = new Vector3(Infinity, 0, 0);
  const lastDirection = new Vector3();
  const direction = new Vector3();
  let lastSelect = -Infinity;
  let pending = true;
  let stats: VegetationStats = {
    instances: instances.count,
    drawn: [0, 0, 0],
    selections: 0,
    lastSelectMs: 0,
    tilesDrawn: 0,
  };

  const select = (camera: PerspectiveCamera) => {
    const started = performance.now();
    camera.updateMatrixWorld();
    projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projection);
    const view = fromThree(camera.position);
    const result = selectVegetation(
      instances,
      view,
      settings,
      (t) => {
        const box = tileBoxes[t];
        return box ? frustum.intersectsBox(box) : false;
      },
      targets,
    );
    const drawn = [0, 0, 0];
    targets.forEach((row, p) => {
      row.forEach((target, band) => {
        const mesh = meshes[p * LOD_LEVELS + band];
        if (!mesh) return;
        drawn[band] = (drawn[band] ?? 0) + target.count;
        mesh.count = target.count;
        mesh.visible = target.count > 0;
        if (target.count === 0) return;
        // Upload only the part in use.
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, target.count * 16);
        mesh.instanceMatrix.needsUpdate = true;
        const colors = mesh.instanceColor;
        if (colors) {
          colors.clearUpdateRanges();
          colors.addUpdateRange(0, target.count * 3);
          colors.needsUpdate = true;
        }
      });
    });
    stats = {
      instances: instances.count,
      drawn,
      selections: stats.selections + 1,
      lastSelectMs: performance.now() - started,
      tilesDrawn: result.tilesDrawn,
    };
  };

  return {
    group,
    update(camera) {
      camera.getWorldDirection(direction);
      const height = Math.max(1, camera.position.y);
      // Moved by more than a small share of the view's scale, or turned.
      const moved =
        camera.position.distanceTo(lastPosition) > Math.max(2, 0.01 * height) ||
        direction.dot(lastDirection) < 0.9995;
      if (moved) pending = true;
      const now = performance.now();
      // A costly selection (a wide view of a big forest) is repeated less often.
      const interval = Math.max(RESELECT_MS, 8 * stats.lastSelectMs);
      if (!pending || now - lastSelect < interval) return;
      // Select for where the camera is now; if it is still moving, the next
      // update after the interval catches up, and the last one is exact.
      lastSelect = now;
      lastPosition.copy(camera.position);
      lastDirection.copy(direction);
      pending = false;
      select(camera);
    },
    setSettings(next, shadows) {
      settings = next;
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
      material.dispose();
      group.clear();
    },
  };
}
