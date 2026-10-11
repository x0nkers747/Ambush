import {
  ClampToEdgeWrapping,
  DataArrayTexture,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  MeshStandardMaterial,
  NoColorSpace,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  type Texture,
  UnsignedByteType,
  Vector3,
} from 'three';
import { GROUND_LAYERS, type GroundLayer, type GroundMap } from './ground-map';
import { hashInts, unit } from './hash';
import { srgbToLinear } from './terrain-mesh';

// The terrain's material (docs/adr/0038): three's MeshStandardMaterial,
// extended through `onBeforeCompile` so the sun, sky light, shadows and fog
// stay exactly as for everything else. Per pixel it reads the ground map
// (ground-map.ts) at the pixel's map position and blends eight ground
// textures (CC0, see textures/CREDITS.md) by it:
//
// - World space at real scale: each texture repeats every 2–3 m of ground,
//   whatever the mesh, so refined tiles and their edges show no seams and
//   nothing slides as the camera moves.
// - No visible tiling: each layer is sampled twice with offsets and
//   rotations chosen by slow noise (two virtual tilings blended), plus once
//   at about five times the scale; a macro noise brightens and tints the
//   ground over hundreds of metres. Mipmaps and explicit gradients keep
//   distant ground calm: far away it is the layers' average colours, varied
//   only by the broad patterns.
// - Layers meet by height (the texture's brightness): grass clumps over soil
//   rather than a uniform cross-fade; far away blending is linear again.
// - Normal maps near the camera, fields' furrows and harvest swaths, damp
//   ground darker and a little smoother, dry grass paler.
//
// Until the map and textures arrive, the terrain shows its vertex colours
// (land-cover tints), so it never looks broken. Cheaper paths serve low
// quality and software renderers (`GroundPath`). A simpler path (one sample per
// layer, no normal maps) is used at the low quality level.

const ALBEDO_URLS: readonly string[] = [
  new URL('./textures/ground-grass.jpg', import.meta.url).href,
  new URL('./textures/ground-meadow.jpg', import.meta.url).href,
  new URL('./textures/ground-leaves.jpg', import.meta.url).href,
  new URL('./textures/ground-needles.jpg', import.meta.url).href,
  new URL('./textures/ground-soil.jpg', import.meta.url).href,
  new URL('./textures/ground-earth.jpg', import.meta.url).href,
  new URL('./textures/ground-gravel.jpg', import.meta.url).href,
  new URL('./textures/ground-rock.jpg', import.meta.url).href,
];
const NORMAL_URLS: readonly string[] = [
  new URL('./textures/ground-grass-n.jpg', import.meta.url).href,
  new URL('./textures/ground-meadow-n.jpg', import.meta.url).href,
  new URL('./textures/ground-leaves-n.jpg', import.meta.url).href,
  new URL('./textures/ground-needles-n.jpg', import.meta.url).href,
  new URL('./textures/ground-soil-n.jpg', import.meta.url).href,
  new URL('./textures/ground-earth-n.jpg', import.meta.url).href,
  new URL('./textures/ground-gravel-n.jpg', import.meta.url).href,
  new URL('./textures/ground-rock-n.jpg', import.meta.url).href,
];

/** Per layer: colour to show (sRGB), metres per texture repeat, roughness. */
export const GROUND_LOOK: Readonly<
  Record<GroundLayer, { readonly color: number; readonly tile: number; readonly roughness: number }>
> = {
  grass: { color: 0x71864a, tile: 2.2, roughness: 0.95 },
  meadow: { color: 0x8e8f5e, tile: 2.4, roughness: 0.95 },
  leaves: { color: 0x75603f, tile: 2.8, roughness: 0.92 },
  needles: { color: 0x6e5238, tile: 2.0, roughness: 0.92 },
  soil: { color: 0x6a5038, tile: 2.4, roughness: 0.97 },
  earth: { color: 0x6d624d, tile: 2.2, roughness: 0.95 },
  gravel: { color: 0x8f877a, tile: 2.6, roughness: 0.9 },
  rock: { color: 0x7d786f, tile: 2.6, roughness: 0.85 },
};

const ALBEDO_PX = 512;
const NORMAL_PX = 256;
const NOISE_PX = 256;
const LAYERS = GROUND_LAYERS.length;

/**
 * The shader's paths: `full` (medium and high quality), `simple` (low: one
 * sample per layer, no normal maps) and `flat` (software renderers at low
 * quality: each layer its plain colour, no texture reads beyond the map).
 */
export type GroundPath = 'full' | 'simple' | 'flat';

const PATH_DEFINES: Readonly<Record<GroundPath, Record<string, string>>> = {
  full: {},
  simple: { GROUND_SIMPLE: '' },
  flat: { GROUND_FLAT: '' },
};

export interface GroundMaterial {
  readonly material: MeshStandardMaterial;
  /** Starts using a ground map (the terrain's). Replaces any earlier one. */
  setMap(map: GroundMap): void;
  /** Whether a ground map is in use. */
  hasMap(): boolean;
  /** Which shader path to use (see `GroundPath`). */
  setPath(path: GroundPath): void;
  /** Resolves when the textures are in use (false: they could not load; the layers' colours stay). */
  readonly ready: Promise<boolean>;
  /** Whether the ground textures are in use (else the layers' plain colours). */
  texturesReady(): boolean;
  /** GPU bytes of the ground textures in use (mipmaps included, estimated). */
  textureBytes(): number;
  dispose(): void;
}

type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function canvas(size: number): Canvas2D | null {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(size, size).getContext('2d', { willReadFrequently: true });
  }
  if (typeof document !== 'undefined') {
    const element = document.createElement('canvas');
    element.width = size;
    element.height = size;
    return element.getContext('2d', { willReadFrequently: true });
  }
  return null;
}

const canLoad = () =>
  typeof fetch === 'function' &&
  typeof createImageBitmap === 'function' &&
  (typeof OffscreenCanvas !== 'undefined' || typeof document !== 'undefined');

async function pixels(urls: readonly string[], size: number): Promise<Uint8Array> {
  const c = canvas(size);
  if (!c) throw new Error('no canvas');
  const out = new Uint8Array(size * size * 4 * urls.length);
  const images = await Promise.all(
    urls.map(async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url}: ${String(response.status)}`);
      return createImageBitmap(await response.blob());
    }),
  );
  images.forEach((image, i) => {
    // Flipped, so texture v runs up the image (as normal maps' green channel expects).
    c.setTransform(1, 0, 0, -1, 0, size);
    c.drawImage(image, 0, 0, size, size);
    out.set(c.getImageData(0, 0, size, size).data, i * size * size * 4);
    image.close();
  });
  return out;
}

/** The noise texture's pixels, made once per page. */
let noisePixels: Uint8Array | null = null;

/** The decoded textures, shared by every battlefield (decoded once per page). */
let decoded: Promise<{ albedo: Uint8Array; normal: Uint8Array } | null> | null = null;

function decode() {
  decoded ??= (async () => {
    if (!canLoad()) return null;
    const [albedo, normal] = await Promise.all([
      pixels(ALBEDO_URLS, ALBEDO_PX),
      pixels(NORMAL_URLS, NORMAL_PX),
    ]);
    return { albedo, normal };
  })().catch(() => {
    decoded = null;
    return null;
  });
  return decoded;
}

function arrayTexture(data: Uint8Array, size: number, srgb: boolean): DataArrayTexture {
  const t = new DataArrayTexture(data, size, size, LAYERS);
  t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = size > 1 ? LinearMipmapLinearFilter : LinearFilter;
  t.generateMipmaps = size > 1;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/** One-texel layers of the layers' colours, until the textures load. */
function placeholders(): { albedo: DataArrayTexture; normal: DataArrayTexture } {
  const albedo = new Uint8Array(4 * LAYERS);
  const normal = new Uint8Array(4 * LAYERS);
  GROUND_LAYERS.forEach((l, i) => {
    const c = GROUND_LOOK[l].color;
    albedo.set([(c >> 16) & 255, (c >> 8) & 255, c & 255, 255], i * 4);
    normal.set([128, 128, 255, 255], i * 4);
  });
  return { albedo: arrayTexture(albedo, 1, true), normal: arrayTexture(normal, 1, false) };
}

/**
 * A tileable noise texture: four independent channels of smooth value noise
 * (three octaves), hashed from fixed seeds, so the same everywhere and always.
 */
export function groundNoisePixels(size = NOISE_PX): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const octave = (x: number, y: number, cells: number, seed: number) => {
    const gx = (x / size) * cells;
    const gy = (y / size) * cells;
    const ix = Math.floor(gx);
    const iy = Math.floor(gy);
    const fx = gx - ix;
    const fy = gy - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    // Wrapped lattice: the texture tiles.
    const v = (i: number, j: number) =>
      unit(hashInts(((i % cells) + cells) % cells, ((j % cells) + cells) % cells, seed));
    const top = v(ix, iy) + sx * (v(ix + 1, iy) - v(ix, iy));
    const bottom = v(ix, iy + 1) + sx * (v(ix + 1, iy + 1) - v(ix, iy + 1));
    return top + sy * (bottom - top);
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      for (let ch = 0; ch < 4; ch += 1) {
        const seed = 0x3800 + ch * 16;
        const v =
          0.57 * octave(x, y, 8, seed) +
          0.29 * octave(x, y, 16, seed + 1) +
          0.14 * octave(x, y, 32, seed + 2);
        out[(y * size + x) * 4 + ch] = Math.round(255 * Math.min(1, Math.max(0, v)));
      }
    }
  }
  return out;
}

function dataTexture(
  data: Uint8Array,
  width: number,
  height: number,
  repeat: boolean,
): DataTexture {
  const t = new DataTexture(data, width, height, RGBAFormat, UnsignedByteType);
  t.colorSpace = NoColorSpace;
  t.wrapS = repeat ? RepeatWrapping : ClampToEdgeWrapping;
  t.wrapT = repeat ? RepeatWrapping : ClampToEdgeWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

const VERTEX_HEAD = /* glsl */ `
varying vec2 vGroundXY;`;
const VERTEX_BODY = /* glsl */ `
// The point in battlefield metres (x east, y north): Three.js (x, z) is (x, −y).
vGroundXY = (modelMatrix * vec4(transformed, 1.0)).xz * vec2(1.0, -1.0);`;

const FRAGMENT_HEAD = /* glsl */ `
uniform highp sampler2DArray groundAlbedo;
uniform highp sampler2DArray groundNormal;
uniform sampler2D groundWeights0;
uniform sampler2D groundWeights1;
uniform sampler2D groundParams;
uniform sampler2D groundNoise;
uniform vec4 groundMapXform;
uniform vec3 groundTint[${String(LAYERS)}];
uniform float groundTile[${String(LAYERS)}];
uniform float groundRough[${String(LAYERS)}];
uniform float groundMeanLum[${String(LAYERS)}];
uniform vec3 groundColor[${String(LAYERS)}];
uniform float groundOn;
varying vec2 vGroundXY;

float groundLum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
mat2 groundRot(float a) { float c = cos(a); float s = sin(a); return mat2(c, s, -s, c); }

// One layer at map point p: albedo (tinted) and tangent-space normal xy.
// Two virtual tilings, offset and rotated by slow noise, blended; and a
// broad sample at about five times the scale for mid-distance patterns.
void groundLayer(int i, vec2 p, vec2 dpx, vec2 dpy, float dist, out vec3 albedo, out vec2 nxy) {
  float layer = float(i);
  float inv = 1.0 / groundTile[i];
  vec2 uv = p * inv;
  vec2 gx = dpx * inv;
  vec2 gy = dpy * inv;
#if defined(GROUND_FLAT)
  albedo = groundColor[i];
  nxy = vec2(0.0);
  return;
#elif defined(GROUND_SIMPLE)
  mat2 r0 = groundRot(1.3 * layer);
  albedo = textureGrad(groundAlbedo, vec3(r0 * uv, layer), r0 * gx, r0 * gy).rgb;
  nxy = vec2(0.0);
#else
  float k = textureLod(groundNoise, p * (inv / 9.0) + 0.13 * layer, 0.0).g * 8.0;
  float ia = floor(k);
  float f = fract(k);
  mat2 ra = groundRot(ia * 2.39996 + layer);
  mat2 rb = groundRot((ia + 1.0) * 2.39996 + layer);
  vec2 oa = sin(vec2(3.0, 7.0) * ia);
  vec2 ob = sin(vec2(3.0, 7.0) * (ia + 1.0));
  vec3 ca = textureGrad(groundAlbedo, vec3(ra * uv + oa, layer), ra * gx, ra * gy).rgb;
  vec3 cb = textureGrad(groundAlbedo, vec3(rb * uv + ob, layer), rb * gx, rb * gy).rgb;
  float t = smoothstep(0.2, 0.8, f - 0.1 * dot(ca - cb, vec3(1.0)));
  vec3 near = mix(ca, cb, t);
  mat2 rc = groundRot(0.7 + layer);
  vec3 broad = textureGrad(groundAlbedo, vec3(rc * uv * 0.213 + 0.37, layer), rc * gx * 0.213, rc * gy * 0.213).rgb;
  float mean = max(groundMeanLum[i], 1e-3);
  albedo = near * mix(1.0, clamp(groundLum(broad) / mean, 0.6, 1.5), 0.55);
  nxy = vec2(0.0);
  if (dist < 260.0) {
    vec2 na = textureGrad(groundNormal, vec3(ra * uv + oa, layer), ra * gx, ra * gy).xy * 2.0 - 1.0;
    vec2 nb = textureGrad(groundNormal, vec3(rb * uv + ob, layer), rb * gx, rb * gy).xy * 2.0 - 1.0;
    // Back from each tiling's rotation to map axes.
    nxy = mix(na * ra, nb * rb, t) * (1.0 - smoothstep(120.0, 260.0, dist));
  }
#endif
  albedo *= groundTint[i];
}
`;

const FRAGMENT_ALBEDO = /* glsl */ `
float groundRoughness = roughness;
vec2 groundNxy = vec2(0.0);
if (groundOn > 0.5) {
  vec2 p = vGroundXY;
  // Derivatives outside any branch (they are undefined inside one).
  vec2 dpx = dFdx(p);
  vec2 dpy = dFdy(p);
  float dist = length(vViewPosition);
  vec2 muv = p * groundMapXform.xy + groundMapXform.zw;
  vec4 w0 = texture(groundWeights0, muv);
  vec4 w1 = texture(groundWeights1, muv);
  vec4 prm = texture(groundParams, muv);
  vec4 macro = texture(groundNoise, p / 347.0);
  vec4 macro2 = texture(groundNoise, p / 1733.0 + 0.5);
  float w[${String(LAYERS)}] = float[${String(LAYERS)}](w0.r, w0.g, w0.b, w0.a, w1.r, w1.g, w1.b, w1.a);
  vec3 col[${String(LAYERS)}];
  vec2 nrm[${String(LAYERS)}];
  float h[${String(LAYERS)}];
  float top = -1.0;
  for (int i = 0; i < ${String(LAYERS)}; i++) {
    col[i] = vec3(0.0);
    nrm[i] = vec2(0.0);
    h[i] = 0.0;
    if (w[i] < 0.02) continue;
    groundLayer(i, p, dpx, dpy, dist, col[i], nrm[i]);
    // Height for blending: the texture's brightness against its average.
#ifdef GROUND_FLAT
    h[i] = 0.5;
#else
    h[i] = clamp(0.5 * groundLum(col[i]) / max(groundLum(groundTint[i]) * groundMeanLum[i], 1e-3), 0.0, 1.0);
#endif
    top = max(top, w[i] + 0.6 * h[i]);
  }
  // Height blending near the camera; plain weights far away (no colour shift with distance).
  float depth = mix(0.2, 2.0, smoothstep(150.0, 700.0, dist));
  vec3 albedo = vec3(0.0);
  float rough = 0.0;
  float total = 0.0;
  for (int i = 0; i < ${String(LAYERS)}; i++) {
    if (w[i] < 0.02) continue;
    float b = max(w[i] + 0.6 * h[i] - top + depth, 0.0) * w[i];
    albedo += col[i] * b;
    groundNxy += nrm[i] * b;
    rough += groundRough[i] * b;
    total += b;
  }
  albedo /= max(total, 1e-4);
  groundNxy /= max(total, 1e-4);
  rough /= max(total, 1e-4);
  // Dry grass is paler and yellower.
  float grassy = w[0] + w[1];
  albedo = mix(albedo, albedo * vec3(1.18, 1.08, 0.78), prm.g * grassy * 0.7);
  // Fields: furrows along the field (0.75 m) and harvest swaths (6 m), faded
  // before they would alias.
  float ang = prm.b * PI;
  vec2 across = vec2(-sin(ang), cos(ang));
  float u = dot(p, across);
  float strength = prm.a;
  if (strength > 0.01) {
    float ph = u / 0.75;
    float fw = length(vec2(dot(dpx, across), dot(dpy, across))) / 0.75;
    float aa = 1.0 - smoothstep(0.25, 0.5, fw);
    float wave = sin(6.2831853 * ph);
    albedo *= 1.0 + 0.13 * strength * aa * wave * (w[4] + 0.4 * w[1]);
    groundNxy += across * cos(6.2831853 * ph) * 0.45 * strength * aa * (w[4] + 0.3 * w[1]);
    float aa2 = 1.0 - smoothstep(0.25, 0.5, fw * 0.125);
    float swath = smoothstep(-0.3, 0.3, sin(6.2831853 * u / 6.0));
    albedo *= 1.0 + 0.07 * strength * aa2 * (swath - 0.5);
  }
  // Damp ground: darker, a little smoother (never glossy).
  albedo *= 1.0 - 0.28 * prm.r;
  rough = mix(rough, 0.62, 0.6 * prm.r);
  // Broad variation over hundreds of metres: brightness and a slight hue drift.
  albedo *= 0.93 + 0.14 * macro.r;
  albedo *= vec3(1.0 + 0.05 * (macro2.g - 0.5), 1.0 + 0.04 * (macro.b - 0.5), 1.0 - 0.04 * (macro2.g - 0.5));
  diffuseColor.rgb = albedo;
  groundRoughness = rough;
}
`;

const FRAGMENT_ROUGHNESS = /* glsl */ `
if (groundOn > 0.5) roughnessFactor = groundRoughness;
`;

const FRAGMENT_NORMAL = /* glsl */ `
if (groundOn > 0.5 && dot(groundNxy, groundNxy) > 1e-6) {
  // Tangent frame in world space: map x (east) and map y (north, −z), around the surface normal.
  vec3 nw = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
  vec3 tw = normalize(vec3(1.0, 0.0, 0.0) - nw * nw.x);
  vec3 bw = cross(nw, tw);
  vec2 nxy = groundNxy * 0.8;
  float nz = sqrt(max(1.0 - dot(nxy, nxy), 0.05));
  vec3 world = normalize(tw * nxy.x + bw * nxy.y + nw * nz);
  normal = normalize((viewMatrix * vec4(world, 0.0)).xyz);
}
`;

/** The terrain's material. Starts with vertex colours; `setMap` turns the ground textures on. */
export function createGroundMaterial(options: { path?: GroundPath } = {}): GroundMaterial {
  const holders = placeholders();
  const tints = GROUND_LAYERS.map(() => new Vector3(1, 1, 1));
  const meanLum = GROUND_LAYERS.map((l) => {
    const c = GROUND_LOOK[l].color;
    return (
      0.2126 * srgbToLinear((c >> 16) & 255) +
      0.7152 * srgbToLinear((c >> 8) & 255) +
      0.0722 * srgbToLinear(c & 255)
    );
  });
  const empty = dataTexture(new Uint8Array(4), 1, 1, false);
  noisePixels ??= groundNoisePixels();
  const noise = dataTexture(noisePixels, NOISE_PX, NOISE_PX, true);
  const uniforms = {
    groundAlbedo: { value: holders.albedo as Texture },
    groundNormal: { value: holders.normal as Texture },
    groundWeights0: { value: empty as Texture },
    groundWeights1: { value: empty as Texture },
    groundParams: { value: empty as Texture },
    groundNoise: { value: noise as Texture },
    groundMapXform: { value: [0, 0, 0, 0] as number[] },
    groundTint: { value: tints },
    groundTile: { value: GROUND_LAYERS.map((l) => GROUND_LOOK[l].tile) },
    groundRough: { value: GROUND_LAYERS.map((l) => GROUND_LOOK[l].roughness) },
    groundMeanLum: { value: meanLum },
    // The layers' colours, linear: the flat path's albedo.
    groundColor: {
      value: GROUND_LAYERS.map((l) => {
        const c = GROUND_LOOK[l].color;
        return new Vector3(
          srgbToLinear((c >> 16) & 255),
          srgbToLinear((c >> 8) & 255),
          srgbToLinear(c & 255),
        );
      }),
    },
    groundOn: { value: 0 },
  };
  let path: GroundPath = options.path ?? 'full';
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
  });
  material.defines = { ...PATH_DEFINES[path] };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>${VERTEX_HEAD}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>${VERTEX_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>${FRAGMENT_HEAD}`)
      .replace('#include <color_fragment>', `#include <color_fragment>${FRAGMENT_ALBEDO}`)
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>${FRAGMENT_ROUGHNESS}`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>${FRAGMENT_NORMAL}`,
      );
  };
  material.customProgramCacheKey = () => `ambush-ground-${path}`;

  let disposed = false;
  let mapTextures: DataTexture[] = [];
  let textures: DataArrayTexture[] = [holders.albedo, holders.normal];
  let mapBytes = 0;
  let loaded = false;
  const ready = decode().then((d) => {
    if (!d || disposed) return false;
    const albedo = arrayTexture(d.albedo, ALBEDO_PX, true);
    const normal = arrayTexture(d.normal, NORMAL_PX, false);
    // Tints: each texture's average colour brought to its layer's colour.
    GROUND_LAYERS.forEach((l, i) => {
      const sum = [0, 0, 0];
      const px = ALBEDO_PX * ALBEDO_PX;
      // Every 7th pixel is plenty for an average.
      let n = 0;
      for (let k = 0; k < px; k += 7) {
        const o = (i * px + k) * 4;
        for (let ch = 0; ch < 3; ch += 1)
          sum[ch] = (sum[ch] ?? 0) + srgbToLinear(d.albedo[o + ch] ?? 0);
        n += 1;
      }
      const c = GROUND_LOOK[l].color;
      const target = [(c >> 16) & 255, (c >> 8) & 255, c & 255].map(srgbToLinear);
      const mean = sum.map((s) => Math.max(s / n, 1e-4));
      tints[i]?.set(
        (target[0] ?? 0) / (mean[0] ?? 1),
        (target[1] ?? 0) / (mean[1] ?? 1),
        (target[2] ?? 0) / (mean[2] ?? 1),
      );
      meanLum[i] = 0.2126 * (mean[0] ?? 0) + 0.7152 * (mean[1] ?? 0) + 0.0722 * (mean[2] ?? 0);
    });
    uniforms.groundAlbedo.value = albedo;
    uniforms.groundNormal.value = normal;
    for (const t of textures) t.dispose();
    textures = [albedo, normal];
    loaded = true;
    return true;
  });

  return {
    material,
    setMap(map) {
      if (disposed) return;
      const { columns, rows, stepX, stepY, originX, originY } = map.grid;
      const next = [map.weights0, map.weights1, map.params].map((data) =>
        dataTexture(data, columns, rows, false),
      );
      for (const t of mapTextures) t.dispose();
      mapTextures = next;
      uniforms.groundWeights0.value = next[0] ?? empty;
      uniforms.groundWeights1.value = next[1] ?? empty;
      uniforms.groundParams.value = next[2] ?? empty;
      // Map point (c, r) is at the centre of texel (c, r).
      uniforms.groundMapXform.value = [
        1 / (stepX * columns),
        1 / (stepY * rows),
        (0.5 - originX / stepX) / columns,
        (0.5 - originY / stepY) / rows,
      ];
      uniforms.groundOn.value = 1;
      mapBytes = Math.round(3 * columns * rows * 4 * (4 / 3));
    },
    hasMap() {
      return uniforms.groundOn.value === 1;
    },
    setPath(next) {
      if (next === path) return;
      path = next;
      material.defines = { ...PATH_DEFINES[path] };
      material.needsUpdate = true;
    },
    ready,
    texturesReady() {
      return loaded;
    },
    textureBytes() {
      const array = (t: Texture, size: number) =>
        t.image && (t.image as { width: number }).width > 1
          ? size * size * 4 * LAYERS * (4 / 3)
          : 0;
      return Math.round(
        mapBytes +
          array(uniforms.groundAlbedo.value, ALBEDO_PX) +
          array(uniforms.groundNormal.value, NORMAL_PX) +
          NOISE_PX * NOISE_PX * 4 * (4 / 3),
      );
    },
    dispose() {
      disposed = true;
      for (const t of [...textures, ...mapTextures, empty, noise]) t.dispose();
      material.dispose();
    },
  };
}
