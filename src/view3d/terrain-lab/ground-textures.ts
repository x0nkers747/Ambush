import {
  DataArrayTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three';

// The lab's ground materials (CC0, textures/CREDITS.md): albedo, normal and
// packed height/roughness/ambient occlusion maps, one texture array each.
// Layer order is the shader's material index.

export const MATERIALS = [
  'asphalt',
  'gravel',
  'soil',
  'grass',
  'mud',
  'rock',
  'sand',
  'litter',
  'paving',
  'lush',
  'dense',
] as const;
export type MaterialName = (typeof MATERIALS)[number];

/** Real-world size one texture tile covers, metres (from the sources, some estimated). */
export const MATERIAL_TILE_M: Readonly<Record<MaterialName, number>> = {
  asphalt: 2.6,
  gravel: 1.6,
  soil: 2.2,
  grass: 1.5,
  mud: 2.2,
  rock: 2.4,
  sand: 3.5,
  litter: 1.8,
  paving: 2.5,
  lush: 1.4,
  dense: 1.4,
};

/**
 * Each material's mean colour (sRGB), as the game's ground colours where it
 * has them (ground-material.ts): textures are tinted to these, so the lab and
 * the current renderer agree on tone, and they are the placeholders.
 */
const FLAT: Readonly<Record<MaterialName, number>> = {
  asphalt: 0x5d5d5a,
  gravel: 0x8f877a,
  soil: 0x6a5038,
  grass: 0x71864a,
  mud: 0x4d4234,
  rock: 0x7d786f,
  sand: 0xb3a27e,
  litter: 0x7a6646,
  paving: 0x8a857d,
  // Grass variants, blended in broad patches: deeper green, and darker and denser.
  lush: 0x6b8744,
  dense: 0x687b43,
};

const lin = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** A material's texture file (kind: albedo, normal or hra). */
export const textureUrl = (name: MaterialName, kind: string) =>
  new URL(`./textures/${name}-${kind}.jpg`, import.meta.url).href;

export const TEXTURE_PX = 1024;

export interface GroundTextures {
  readonly albedo: DataArrayTexture;
  readonly normal: DataArrayTexture;
  readonly hra: DataArrayTexture;
  /** Bytes on the GPU (with mipmaps). */
  readonly bytes: number;
  /** Per material, linear RGB factors bringing its texture's mean to its colour. */
  readonly tints: readonly number[];
  dispose(): void;
}

function arrayTexture(
  data: Uint8Array,
  size: number,
  layers: number,
  srgb: boolean,
): DataArrayTexture {
  const t = new DataArrayTexture(data, size, size, layers);
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

export function placeholderTextures(): GroundTextures {
  const n = MATERIALS.length;
  const albedo = new Uint8Array(4 * n);
  const normal = new Uint8Array(4 * n);
  const hra = new Uint8Array(4 * n);
  MATERIALS.forEach((m, i) => {
    const c = FLAT[m];
    albedo.set([(c >> 16) & 255, (c >> 8) & 255, c & 255, 255], i * 4);
    normal.set([128, 128, 255, 255], i * 4);
    hra.set([128, 230, 255, 255], i * 4);
  });
  const t = {
    albedo: arrayTexture(albedo, 1, n, true),
    normal: arrayTexture(normal, 1, n, false),
    hra: arrayTexture(hra, 1, n, false),
  };
  return {
    ...t,
    bytes: 12 * n,
    tints: MATERIALS.flatMap(() => [1, 1, 1]),
    dispose() {
      t.albedo.dispose();
      t.normal.dispose();
      t.hra.dispose();
    },
  };
}

async function pixels(kind: string, size: number): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no 2D canvas');
  const out = new Uint8Array(size * size * 4 * MATERIALS.length);
  const images = await Promise.all(
    MATERIALS.map(async (m) => {
      const response = await fetch(textureUrl(m, kind));
      if (!response.ok) throw new Error(`${m}-${kind}: ${String(response.status)}`);
      // Colour space conversion off: normal and data maps are not colours.
      return createImageBitmap(await response.blob(), {
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none',
      });
    }),
  );
  images.forEach((image, i) => {
    // Flipped, so texture v runs up the image (as the normal maps' green channel expects).
    ctx.setTransform(1, 0, 0, -1, 0, size);
    ctx.drawImage(image, 0, 0, size, size);
    out.set(ctx.getImageData(0, 0, size, size).data, i * size * size * 4);
    image.close();
  });
  return out;
}

/** Loads the textures; the result's arrays replace the placeholders. */
export async function loadGroundTextures(): Promise<GroundTextures> {
  const n = MATERIALS.length;
  const [a, nm, h] = await Promise.all([
    pixels('albedo', TEXTURE_PX),
    pixels('normal', TEXTURE_PX),
    pixels('hra', TEXTURE_PX),
  ]);
  const t = {
    albedo: arrayTexture(a, TEXTURE_PX, n, true),
    normal: arrayTexture(nm, TEXTURE_PX, n, false),
    hra: arrayTexture(h, TEXTURE_PX, n, false),
  };
  const tints: number[] = [];
  const px = TEXTURE_PX * TEXTURE_PX;
  MATERIALS.forEach((m, i) => {
    const sum = [0, 0, 0];
    let k = 0;
    for (let p = 0; p < px; p += 7) {
      const o = (i * px + p) * 4;
      for (let ch = 0; ch < 3; ch += 1) sum[ch] = (sum[ch] ?? 0) + lin(a[o + ch] ?? 0);
      k += 1;
    }
    const c = FLAT[m];
    const target = [lin((c >> 16) & 255), lin((c >> 8) & 255), lin(c & 255)];
    for (let ch = 0; ch < 3; ch += 1)
      tints.push((target[ch] ?? 0) / Math.max(1e-4, (sum[ch] ?? 0) / k));
  });
  return {
    ...t,
    tints,
    bytes: Math.round(3 * n * TEXTURE_PX * TEXTURE_PX * 4 * (4 / 3)),
    dispose() {
      t.albedo.dispose();
      t.normal.dispose();
      t.hra.dispose();
    },
  };
}
