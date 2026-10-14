import * as THREE from 'three';

// The soldiers' shadows (docs/character-animation.md). The sun's shadow uses a
// normal bias (`SUN_NORMAL_BIAS`) so the terrain does not shadow itself in
// speckles: a ground point looks up its shadow that far above itself, so the
// ground shows the shadow cast on a plane that high. Whatever is lower than
// that casts none — nothing a tree or a building misses, but a soldier's legs:
// his shadow came loose from his feet. The soldiers are drawn into the shadow
// map that much higher, which gives the ground their whole shadow, at their
// feet.

/** The sun's shadow normal bias (m), set in view.ts. */
export const SUN_NORMAL_BIAS = 0.4;

let material: THREE.MeshDepthMaterial | null = null;

/** The depth material for the soldiers' shadow pass (shared). */
export function soldierShadowMaterial(): THREE.MeshDepthMaterial {
  if (material) return material;
  // As three.js's own shadow depth material (default packing), with the shift.
  const m = new THREE.MeshDepthMaterial();
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      `vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
#endif
vec4 shadowCasterWorld = modelMatrix * mvPosition;
shadowCasterWorld.y += ${SUN_NORMAL_BIAS.toFixed(3)};
mvPosition = viewMatrix * shadowCasterWorld;
gl_Position = projectionMatrix * mvPosition;`,
    );
  };
  material = m;
  return m;
}

/** Gives every mesh under `root` the soldiers' shadow pass. */
export function useSoldierShadow(root: THREE.Object3D): void {
  const m = soldierShadowMaterial();
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) o.customDepthMaterial = m;
  });
}
