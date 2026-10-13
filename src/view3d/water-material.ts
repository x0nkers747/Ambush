import { Color, MeshStandardMaterial, NotEqualStencilFunc, ReplaceStencilOp } from 'three';

// The water's material (docs/adr/0040, docs/adr/0046): three's
// MeshStandardMaterial, so the sun, sky light, fog and tone mapping are as for
// everything else, with colours per visual profile from the mesh
// (water-profiles.ts) and
//
// - opaque: the water's own colour, not the bed seen through it;
// - small static ripples in the shading normal, which break up the sun's glint
//   near the camera and fade out with distance (where they would only
//   shimmer);
// - the sky reflected by a Fresnel term: dark looking down, the haze's colour
//   at grazing angles.
//
// No real reflections or refraction: they would cost a render of the scene
// each frame.

/** The sky the water reflects (sRGB; a little darker than the horizon haze). */
export const WATER_SKY = 0xaebcc6;
/** How much of the sky the water reflects at grazing angles (0–1). */
export const WATER_FRESNEL = 0.75;
/** The ripples' slope: subtle, for canals as for lakes. */
export const WATER_RIPPLE = 0.018;

const VERTEX_HEAD = /* glsl */ `
varying vec2 vWaterXY;`;
const VERTEX_BODY = /* glsl */ `
vWaterXY = (modelMatrix * vec4(transformed, 1.0)).xz;`;

const FRAGMENT_HEAD = /* glsl */ `
varying vec2 vWaterXY;
uniform vec3 waterSky;
uniform float waterFresnel;
uniform float waterRipple;
// Ripples: sine waves in different directions and lengths (metres), each
// waxing and waning over tens of metres, so no pattern repeats in view.
vec2 waterSlope(vec2 p) {
  vec2 s = vec2(0.0);
  const vec2 d0 = vec2(0.8, 0.6);
  const vec2 d1 = vec2(-0.45, 0.89);
  const vec2 d2 = vec2(0.97, -0.24);
  const vec2 d3 = vec2(-0.7, -0.71);
  const vec2 d4 = vec2(0.26, -0.97);
  const vec2 d5 = vec2(-0.93, 0.37);
  vec4 m = 0.5 + 0.5 * sin(vec4(p.x * 0.041 + p.y * 0.017, p.y * 0.037 - p.x * 0.023,
    p.x * 0.029 + 1.7, p.y * 0.031 + 4.1));
  s += d0 * cos(dot(p, d0) * 6.2831853 / 3.1) * 0.55 * m.x;
  s += d1 * cos(dot(p, d1) * 6.2831853 / 1.7 + 1.3) * 0.35 * m.y;
  s += d2 * cos(dot(p, d2) * 6.2831853 / 0.93 + 2.1) * 0.25 * m.z;
  s += d3 * cos(dot(p, d3) * 6.2831853 / 5.3 + 0.4) * 0.4 * m.w;
  s += d4 * cos(dot(p, d4) * 6.2831853 / 2.37 + 0.9) * 0.3 * (1.0 - m.x);
  s += d5 * cos(dot(p, d5) * 6.2831853 / 1.29 + 2.6) * 0.25 * (1.0 - m.y);
  return s;
}`;

const FRAGMENT_NORMAL = /* glsl */ `
{
  float waterDist = length(vViewPosition);
  float waterFade = 1.0 - smoothstep(40.0, 260.0, waterDist);
  if (waterFade > 0.0) {
    vec2 sl = waterSlope(vWaterXY) * waterRipple * waterFade;
    // World up, tilted by the ripple slopes (map x east is three x; three z is south).
    vec3 world = normalize(vec3(-sl.x, 1.0, -sl.y));
    normal = normalize((viewMatrix * vec4(world, 0.0)).xyz);
  }
}`;

// The sky, by Schlick's Fresnel term (water's F0 is 0.02).
const FRAGMENT_SKY = /* glsl */ `
{
  float cosV = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - cosV, 5.0);
  outgoingLight = mix(outgoingLight, waterSky, fresnel * waterFresnel);
}`;

/** The water's material: opaque, each pixel taking water once. */
export function createWaterMaterial(): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.5,
    metalness: 0,
    // Drawn after the opaque scene, as before, but covering what is under it.
    transparent: true,
    opacity: 1,
    depthWrite: false,
    // In front of a ground standing exactly at the water's level.
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    // The stencil lets each pixel take water once, so where a river's line
    // overlaps its area, or its own bends, they never fight.
    stencilWrite: true,
    stencilRef: 1,
    stencilFunc: NotEqualStencilFunc,
    stencilZPass: ReplaceStencilOp,
  });
  const uniforms = {
    waterSky: { value: new Color(WATER_SKY) },
    waterFresnel: { value: WATER_FRESNEL },
    waterRipple: { value: WATER_RIPPLE },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>${VERTEX_HEAD}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>${VERTEX_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>${FRAGMENT_HEAD}`)
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>${FRAGMENT_NORMAL}`,
      )
      .replace(
        '#include <opaque_fragment>',
        `${FRAGMENT_SKY}
#include <opaque_fragment>`,
      );
  };
  material.customProgramCacheKey = () => 'ambush-water-3';
  return material;
}
