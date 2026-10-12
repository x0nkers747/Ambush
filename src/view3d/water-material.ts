import { MeshStandardMaterial, NotEqualStencilFunc, ReplaceStencilOp } from 'three';

// The water's material (docs/adr/0040): three's MeshStandardMaterial, so the
// sun, sky light, fog and tone mapping are as for everything else, with
// colours per kind of water from the mesh (sea, lakes, rivers: water-geometry.ts)
// and small static ripples in the shading normal, which break up the sun's
// glint near the camera and fade out with distance (where they would only
// shimmer). No reflections or refraction: they would cost a render of the
// scene each frame.

const VERTEX_HEAD = /* glsl */ `
varying vec2 vWaterXY;`;
const VERTEX_BODY = /* glsl */ `
vWaterXY = (modelMatrix * vec4(transformed, 1.0)).xz;`;

const FRAGMENT_HEAD = /* glsl */ `
varying vec2 vWaterXY;
// Ripples: a few sine waves in different directions and lengths (metres).
vec2 waterSlope(vec2 p) {
  vec2 s = vec2(0.0);
  const vec2 d0 = vec2(0.8, 0.6);
  const vec2 d1 = vec2(-0.45, 0.89);
  const vec2 d2 = vec2(0.97, -0.24);
  const vec2 d3 = vec2(-0.7, -0.71);
  s += d0 * cos(dot(p, d0) * 6.2831853 / 3.1) * 0.55;
  s += d1 * cos(dot(p, d1) * 6.2831853 / 1.7 + 1.3) * 0.35;
  s += d2 * cos(dot(p, d2) * 6.2831853 / 0.9 + 2.1) * 0.25;
  s += d3 * cos(dot(p, d3) * 6.2831853 / 5.3 + 0.4) * 0.4;
  return s;
}`;

const FRAGMENT_NORMAL = /* glsl */ `
{
  float waterDist = length(vViewPosition);
  float waterFade = 1.0 - smoothstep(40.0, 260.0, waterDist);
  if (waterFade > 0.0) {
    vec2 sl = waterSlope(vWaterXY) * 0.06 * waterFade;
    // World up, tilted by the ripple slopes (map x east is three x; three z is south).
    vec3 world = normalize(vec3(-sl.x, 1.0, -sl.y));
    normal = normalize((viewMatrix * vec4(world, 0.0)).xyz);
  }
}`;

/** The water's material: slightly transparent, each pixel taking water once. */
export function createWaterMaterial(): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.3,
    metalness: 0,
    transparent: true,
    opacity: 0.84,
    depthWrite: false,
    // In front of a ground standing exactly at the water's level.
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    // The stencil lets each pixel take water once, so where a river's line
    // overlaps its area, or its own bends, it is no darker.
    stencilWrite: true,
    stencilRef: 1,
    stencilFunc: NotEqualStencilFunc,
    stencilZPass: ReplaceStencilOp,
  });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>${VERTEX_HEAD}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>${VERTEX_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>${FRAGMENT_HEAD}`)
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>${FRAGMENT_NORMAL}`,
      );
  };
  material.customProgramCacheKey = () => 'ambush-water';
  return material;
}
