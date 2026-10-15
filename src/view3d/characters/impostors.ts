import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { useSoldierShadow } from './shadow';

// Far soldiers and the team indicators, instanced (docs/character-animation.md,
// levels of detail). A soldier only a few pixels tall on screen is drawn as a
// simple figure in his posture (standing, kneeling, prone, or down), all of
// them in one draw call per posture, instead of an animated model in several;
// the indicators over every soldier are one draw call too. Display only.

export type ImpostorShape = 'standing' | 'kneeling' | 'prone' | 'down';
const SHAPES: readonly ImpostorShape[] = ['standing', 'kneeling', 'prone', 'down'];

/** Height of the top of the head above the ground, by shape (m): where the indicator goes. */
export const IMPOSTOR_HEAD_M: Readonly<Record<ImpostorShape, number>> = {
  standing: 1.75,
  kneeling: 1.25,
  prone: 0.35,
  down: 0.3,
};

const capsule = (
  radius: number,
  length: number,
  x: number,
  y: number,
  z: number,
  lying = false,
) => {
  const g = new THREE.CapsuleGeometry(radius, length, 2, 6);
  if (lying) g.rotateX(Math.PI / 2);
  return g.translate(x, y, z);
};
const ball = (radius: number, x: number, y: number, z: number) =>
  new THREE.SphereGeometry(radius, 6, 4).translate(x, y, z);

/**
 * The figures, about 1.8 m tall standing, facing local +z (as the soldier
 * model does: the layer turns them by π − azimuth).
 */
function shapeGeometry(shape: ImpostorShape): THREE.BufferGeometry {
  const parts =
    shape === 'standing'
      ? [
          capsule(0.2, 0.5, 0, 1.15, 0),
          ball(0.12, 0, 1.6, 0.02),
          capsule(0.09, 0.7, -0.1, 0.43, 0),
          capsule(0.09, 0.7, 0.1, 0.43, 0),
        ]
      : shape === 'kneeling'
        ? [
            capsule(0.2, 0.45, 0, 0.78, 0),
            ball(0.12, 0, 1.18, 0.04),
            capsule(0.09, 0.4, -0.12, 0.3, 0.12),
            capsule(0.09, 0.45, 0.12, 0.12, -0.15, true),
          ]
        : [
            capsule(0.19, 0.5, 0, 0.19, 0.1, true),
            ball(0.12, 0, 0.24, 0.62),
            capsule(0.09, 0.7, -0.1, 0.1, -0.55, true),
            capsule(0.09, 0.7, 0.1, 0.1, -0.55, true),
          ];
  const merged = mergeGeometries(parts.map((g) => g.toNonIndexed()));
  for (const g of parts) g.dispose();
  merged.computeVertexNormals();
  return merged;
}

/** One instanced mesh that grows as needed. */
class Instances {
  mesh: THREE.InstancedMesh;
  count = 0;
  private readonly group: THREE.Group;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.Material;
  private readonly setup: (mesh: THREE.InstancedMesh) => void;
  constructor(
    group: THREE.Group,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    setup: (mesh: THREE.InstancedMesh) => void,
  ) {
    this.group = group;
    this.geometry = geometry;
    this.material = material;
    this.setup = setup;
    this.mesh = this.make(64);
  }
  private make(capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, new THREE.Color());
    mesh.instanceColor?.setUsage(THREE.DynamicDrawUsage);
    // Instances are spread over the battlefield: never culled as a whole.
    mesh.frustumCulled = false;
    mesh.count = 0;
    this.setup(mesh);
    this.group.add(mesh);
    return mesh;
  }
  /** Room for `n` instances this frame. */
  reserve(n: number): void {
    this.count = 0;
    if (n <= this.mesh.instanceMatrix.count) return;
    let capacity = this.mesh.instanceMatrix.count;
    while (capacity < n) capacity *= 2;
    this.group.remove(this.mesh);
    this.mesh.dispose();
    this.mesh = this.make(capacity);
  }
  add(matrix: THREE.Matrix4, color: THREE.Color): void {
    this.mesh.setMatrixAt(this.count, matrix);
    this.mesh.setColorAt(this.count, color);
    this.count += 1;
  }
  finish(): void {
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
  dispose(): void {
    this.group.remove(this.mesh);
    this.mesh.dispose();
  }
}

export interface ImpostorLayer {
  /** Starts a frame with room for `n` soldiers. */
  begin(n: number): void;
  /** A far soldier: shape, position (three.js axes), turn about the vertical, colour. */
  figure(
    shape: ImpostorShape,
    x: number,
    y: number,
    z: number,
    turn: number,
    color: THREE.Color,
  ): void;
  /** An indicator: position (three.js axes), size (m), colour. */
  indicator(x: number, y: number, z: number, size: number, color: THREE.Color): void;
  finish(): void;
  /** Figures drawn in the last frame. */
  readonly figures: number;
  dispose(): void;
}

export function createImpostorLayer(group: THREE.Group): ImpostorLayer {
  const figureMaterial = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 });
  const geometries = new Map(SHAPES.map((s) => [s, shapeGeometry(s)]));
  const figures = new Map(
    SHAPES.map((s) => [
      s,
      new Instances(group, geometries.get(s) ?? new THREE.BufferGeometry(), figureMaterial, (m) => {
        m.name = `impostors ${s}`;
        m.castShadow = true;
        m.receiveShadow = true;
        useSoldierShadow(m);
      }),
    ]),
  );
  const indicatorGeometry = new THREE.OctahedronGeometry(0.5, 0).scale(0.75, 1, 0.75);
  const indicatorMaterial = new THREE.MeshBasicMaterial({
    fog: false,
    transparent: true,
    opacity: 0.9,
    depthTest: false,
    depthWrite: false,
  });
  const indicators = new Instances(group, indicatorGeometry, indicatorMaterial, (m) => {
    m.name = 'indicators';
    m.renderOrder = 20;
  });
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  let drawn = 0;

  return {
    begin(n) {
      for (const f of figures.values()) f.reserve(n);
      indicators.reserve(n);
    },
    figure(shape, x, y, z, turn, color) {
      matrix.compose(
        position.set(x, y, z),
        rotation.setFromAxisAngle(UP, turn),
        scale.set(1, 1, 1),
      );
      figures.get(shape)?.add(matrix, color);
    },
    indicator(x, y, z, size, color) {
      rotation.identity();
      matrix.compose(position.set(x, y, z), rotation, scale.setScalar(size));
      indicators.add(matrix, color);
    },
    finish() {
      drawn = 0;
      for (const f of figures.values()) {
        f.finish();
        drawn += f.count;
      }
      indicators.finish();
    },
    get figures() {
      return drawn;
    },
    dispose() {
      for (const f of figures.values()) f.dispose();
      indicators.dispose();
      for (const g of geometries.values()) g.dispose();
      figureMaterial.dispose();
      indicatorGeometry.dispose();
      indicatorMaterial.dispose();
    },
  };
}
