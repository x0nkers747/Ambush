import * as THREE from 'three';

// The soldiers' shadows (docs/character-animation.md). The sun's shadow is
// biased so the terrain does not shadow itself in speckles:
// - a depth bias (`SUN_DEPTH_BIAS_M`, in metres: view.ts converts it for the
//   shadow camera's depth range each frame);
// - a normal bias (`SUN_NORMAL_BIAS`): a ground point looks up its shadow
//   that far above itself, so the lowest part of anything standing on the
//   ground casts no shadow there.
// Soldiers are drawn into the shadow map `SUN_NORMAL_BIAS` higher, which
// cancels the normal bias for them: their shadows start at their feet.

/** The sun's shadow normal bias (m), set in view.ts. */
export const SUN_NORMAL_BIAS = 0.4;
/**
 * The sun's shadow depth bias (m along the light). It was a fixed fraction of
 * the depth range (−0.0005), which is several kilometres: over 2 m, so the
 * ground lost the shadow of whatever stood within about 1.5 m of it.
 */
export const SUN_DEPTH_BIAS_M = 0.08;

let material: THREE.MeshDepthMaterial | null = null;

/** The depth material for the soldiers' shadow pass (shared). */
export function soldierShadowMaterial(): THREE.MeshDepthMaterial {
  if (material) return material;
  // As three.js's own shadow depth material (default packing), raised.
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
  m.customProgramCacheKey = () => 'soldier-shadow-raised';
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
