/**
 * An Ambush!-representative environment for the benchmarks: the uneven
 * ground and the game's own tree models and foliage atlas (src/view3d, used
 * read-only), instanced, casting shadows, with fog — so soldiers are measured
 * alongside the kind of scene they will live in.
 */

import * as THREE from 'three';
import { createFoliageTextures } from '../../../src/view3d/foliage-atlas';
import { treeModels } from '../../../src/view3d/tree-models';

export interface Forest {
  readonly group: THREE.Group;
  /** Settles when the foliage photographs are loaded and in the textures. */
  readonly loaded: Promise<boolean>;
  readonly trees: number;
  readonly triangles: number;
}

export function createForest(heightAt: (x: number, y: number) => number, count = 2400): Forest {
  const models = treeModels();
  const tex = createFoliageTextures();
  const material = new THREE.MeshStandardMaterial({
    map: tex.map,
    normalMap: tex.normalMap,
    vertexColors: true,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    roughness: 0.9,
  });
  const group = new THREE.Group();
  // Deterministic placement (LCG): a ring of woods from 25 m to 220 m.
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const perModel = Math.ceil(count / models.length);
  let triangles = 0;
  let trees = 0;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  for (const model of models) {
    const lod = model.lods[1];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(lod.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(lod.normals, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(lod.uvs, 2));
    g.setAttribute('color', new THREE.BufferAttribute(lod.colors, 3));
    const mesh = new THREE.InstancedMesh(g, material, perModel);
    for (let i = 0; i < perModel; i++) {
      const a = rnd() * Math.PI * 2;
      const r = 25 + Math.sqrt(rnd()) * 195;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      const s = 0.8 + rnd() * 0.5;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI * 2);
      m.compose(new THREE.Vector3(x, heightAt(x, y), -y), q, new THREE.Vector3(s, s, s));
      mesh.setMatrixAt(i, m);
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    triangles += lod.triangles * perModel;
    trees += perModel;
  }
  return { group, trees, triangles, loaded: tex.loaded };
}
