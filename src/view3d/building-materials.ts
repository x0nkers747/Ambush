import {
  CanvasTexture,
  DataArrayTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
} from 'three';

// Materials for the 3D view's buildings (docs/adr/0035): one for walls, roofs
// and trim, sampling a texture array (one layer per wall or roof material,
// chosen per vertex), and one for windows and doors, sampling the openings
// atlas. Two materials for every building on the battlefield, so two draw
// calls. The textures (CC0, see textures/CREDITS.md) load in the background;
// until they arrive the surfaces show each material's average colour and the
// openings are hidden, so nothing ever looks broken or missing.

/** Wall then roof textures, in the order of WALL_LAYERS and ROOF_LAYERS. */
const SURFACE_URLS = [
  new URL('./textures/wall-plaster.jpg', import.meta.url).href,
  new URL('./textures/wall-brick.jpg', import.meta.url).href,
  new URL('./textures/wall-siding.jpg', import.meta.url).href,
  new URL('./textures/wall-concrete.jpg', import.meta.url).href,
  new URL('./textures/wall-block.jpg', import.meta.url).href,
  new URL('./textures/wall-metal.jpg', import.meta.url).href,
  new URL('./textures/roof-clay.jpg', import.meta.url).href,
  new URL('./textures/roof-tiles.jpg', import.meta.url).href,
  new URL('./textures/roof-slate.jpg', import.meta.url).href,
  new URL('./textures/roof-shingles.jpg', import.meta.url).href,
  new URL('./textures/roof-metal.jpg', import.meta.url).href,
  new URL('./textures/roof-gravel.jpg', import.meta.url).href,
];
const OPENINGS_URL = new URL('./textures/openings.png', import.meta.url).href;

/** Each texture's average colour (sRGB), shown until the textures load. */
const AVERAGE = [
  0xdbdbdb, 0x87624d, 0xd1d1d1, 0xbcbcbc, 0xa8a8a8, 0xc6c6c6, 0x7d674f, 0x9e9e9e, 0x7f827f,
  0x939393, 0xb7b7b7, 0x9e9e9e,
];
/** Texture array layer size, pixels. */
const LAYER_PX = 512;
const ATLAS_PX = 1024;

export interface BuildingMaterials {
  readonly surfaces: MeshStandardMaterial;
  readonly openings: MeshStandardMaterial;
  /** Resolves when the textures are in use (or cannot load: then the placeholders stay). */
  readonly ready: Promise<boolean>;
  dispose(): void;
}

type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function canvas(
  size: number,
): { ctx: Canvas2D; element: OffscreenCanvas | HTMLCanvasElement } | null {
  if (typeof OffscreenCanvas !== 'undefined') {
    const element = new OffscreenCanvas(size, size);
    const ctx = element.getContext('2d', { willReadFrequently: true });
    return ctx ? { ctx, element } : null;
  }
  if (typeof document !== 'undefined') {
    const element = document.createElement('canvas');
    element.width = size;
    element.height = size;
    const ctx = element.getContext('2d', { willReadFrequently: true });
    return ctx ? { ctx, element } : null;
  }
  return null;
}

const canLoad = () =>
  typeof fetch === 'function' &&
  typeof createImageBitmap === 'function' &&
  (typeof OffscreenCanvas !== 'undefined' || typeof document !== 'undefined');

async function bitmap(url: string): Promise<ImageBitmap> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${String(response.status)}`);
  return createImageBitmap(await response.blob());
}

/** The decoded textures, shared by every battlefield (decoded once per page). */
let decoded: Promise<{ layers: Uint8Array; atlas: ImageBitmap } | null> | null = null;

function decode() {
  decoded ??= (async () => {
    if (!canLoad()) return null;
    const c = canvas(LAYER_PX);
    if (!c) return null;
    const layers = new Uint8Array(LAYER_PX * LAYER_PX * 4 * SURFACE_URLS.length);
    const images = await Promise.all(SURFACE_URLS.map(bitmap));
    images.forEach((image, i) => {
      // Flipped, so texture v runs up the wall as row 0 is uploaded first.
      c.ctx.setTransform(1, 0, 0, -1, 0, LAYER_PX);
      c.ctx.drawImage(image, 0, 0, LAYER_PX, LAYER_PX);
      layers.set(c.ctx.getImageData(0, 0, LAYER_PX, LAYER_PX).data, i * LAYER_PX * LAYER_PX * 4);
      image.close();
    });
    return { layers, atlas: await bitmap(OPENINGS_URL) };
  })().catch(() => {
    decoded = null;
    return null;
  });
  return decoded;
}

function arrayTexture(data: Uint8Array, size: number): DataArrayTexture {
  const t = new DataArrayTexture(data, size, size, SURFACE_URLS.length);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = size > 1 ? LinearMipmapLinearFilter : LinearFilter;
  t.generateMipmaps = size > 1;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

function placeholder(): DataArrayTexture {
  const data = new Uint8Array(4 * AVERAGE.length);
  AVERAGE.forEach((c, i) => {
    data.set([(c >> 16) & 255, (c >> 8) & 255, c & 255, 255], i * 4);
  });
  return arrayTexture(data, 1);
}

export function createBuildingMaterials(): BuildingMaterials {
  const uniforms = { surfaceTextures: { value: placeholder() as Texture } };
  const surfaces = new MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 });
  surfaces.onBeforeCompile = (shader) => {
    shader.uniforms['surfaceTextures'] = uniforms.surfaceTextures;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec2 surfaceUv;
attribute float surfaceLayer;
varying vec2 vSurfaceUv;
varying float vSurfaceLayer;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vSurfaceUv = surfaceUv;
vSurfaceLayer = surfaceLayer;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform highp sampler2DArray surfaceTextures;
varying vec2 vSurfaceUv;
varying float vSurfaceLayer;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
if (vSurfaceLayer > -0.5) {
  diffuseColor.rgb *= texture(surfaceTextures, vec3(vSurfaceUv, floor(vSurfaceLayer + 0.5))).rgb;
}`,
      );
  };
  surfaces.customProgramCacheKey = () => 'ambush-building-surfaces';

  const openings = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.55,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });

  let disposed = false;
  const owned: Texture[] = [uniforms.surfaceTextures.value];
  const ready = decode().then((d) => {
    if (!d || disposed) return false;
    const layers = arrayTexture(d.layers, LAYER_PX);
    const old = uniforms.surfaceTextures.value;
    uniforms.surfaceTextures.value = layers;
    old.dispose();
    owned.push(layers);
    const c = canvas(ATLAS_PX);
    if (c) {
      c.ctx.drawImage(d.atlas, 0, 0, ATLAS_PX, ATLAS_PX);
      const atlas = new CanvasTexture(c.element);
      atlas.colorSpace = SRGBColorSpace;
      atlas.anisotropy = 4;
      openings.map = atlas;
      openings.needsUpdate = true;
      owned.push(atlas);
    }
    return true;
  });

  return {
    surfaces,
    openings,
    ready,
    dispose() {
      disposed = true;
      for (const t of owned) t.dispose();
      surfaces.dispose();
      openings.dispose();
    },
  };
}
