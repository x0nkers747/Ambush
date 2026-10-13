import { ShaderChunk } from 'three';

// Sun shadows fade out towards the edge of the square they are cast in
// (docs/adr/0049). Shadows cover only a square round the camera's focus
// (view.ts); cut off at its edge, the shaded forest floor inside met the
// sunlit floor outside in a hard, light-coloured rectangle. Faded over the
// outer part of the square, the shade thins out gradually instead.

/** The share of the shadow square, from each edge inward, over which shadows fade in. */
export const SHADOW_FADE = 0.2;

const FADE = /* glsl */ `
float shadowEdgeFade( vec4 shadowCoord ) {
  // (getShadow has already divided the coordinates by w.)
  vec2 c = shadowCoord.xy;
  float d = min( min( c.x, 1.0 - c.x ), min( c.y, 1.0 - c.y ) );
  return smoothstep( 0.0, ${SHADOW_FADE.toFixed(3)}, d );
}
`;

const RETURN = 'return mix( 1.0, shadow, shadowIntensity );';

let installed = false;

/**
 * Makes every material's directional and spot light shadows fade at the
 * shadow map's edges. Patches three's shadow chunk once; materials compiled
 * afterwards use it. Point light shadows are left as they are.
 */
export function installShadowEdgeFade(): void {
  if (installed) return;
  installed = true;
  const chunk = ShaderChunk.shadowmap_pars_fragment;
  const point = chunk.indexOf('float getPointShadow(');
  const head = point >= 0 ? chunk.slice(0, point) : chunk;
  const tail = point >= 0 ? chunk.slice(point) : '';
  // The directional and spot variants of getShadow: their coordinates are the shadow map's, 0–1.
  const faded = head
    .split(RETURN)
    .join('return mix( 1.0, shadow, shadowIntensity * shadowEdgeFade( shadowCoord ) );');
  if (faded === head) return;
  ShaderChunk.shadowmap_pars_fragment = FADE + faded + tail;
}
