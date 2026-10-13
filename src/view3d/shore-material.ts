import {
  ClampToEdgeWrapping,
  DataTexture,
  DoubleSide,
  LinearFilter,
  MeshStandardMaterial,
  NoColorSpace,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  Texture,
  UnsignedByteType,
} from 'three';
import type { ShoreGrid, ShoreMask } from './shoreline';

// The shore's GPU side (docs/adr/0046): the shore mask as a texture, shared by
// the terrain's material (which cuts the ground above the water inside it)
// and the water's (natural shallows), and the two materials of the shore's
// walls: brick quays and earth banks, textured in world space.

/** The shore mask on the GPU, and how a map point finds its texel. */
export interface ShoreTexture {
  readonly texture: DataTexture;
  readonly grid: ShoreGrid;
  readonly levelBase: number;
  /** u = x·xform[0] + xform[2], v = y·xform[1] + xform[3] (map metres, y north). */
  readonly xform: readonly [number, number, number, number];
  /** GPU bytes. */
  readonly bytes: number;
  dispose(): void;
}

export function createShoreTexture(mask: ShoreMask): ShoreTexture {
  const { columns, rows, step, originX, originY } = mask.grid;
  const t = new DataTexture(mask.pixels, columns, rows, RGBAFormat, UnsignedByteType);
  t.colorSpace = NoColorSpace;
  t.wrapS = ClampToEdgeWrapping;
  t.wrapT = ClampToEdgeWrapping;
  // Linear for the signed distance (R, A); the level (G, B) is fetched exactly.
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return {
    texture: t,
    grid: mask.grid,
    levelBase: mask.levelBase,
    // Sample (c, r) at the centre of texel (c, r).
    xform: [
      1 / (step * columns),
      1 / (step * rows),
      (0.5 - originX / step) / columns,
      (0.5 - originY / step) / rows,
    ],
    bytes: columns * rows * 4,
    dispose() {
      t.dispose();
    },
  };
}

/** World-space texture scale of the walls: metres per repeat. */
const QUAY_TILE_M = 2.4;
const BANK_TILE_M = 2.6;

const canLoad = () => typeof fetch === 'function' && typeof createImageBitmap === 'function';

async function load(url: string, tile: number): Promise<Texture> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${String(response.status)}`);
  const image = await createImageBitmap(await response.blob());
  const t = new Texture(image);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.repeat.set(1 / tile, 1 / tile);
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

export interface ShoreMaterials {
  readonly quay: MeshStandardMaterial;
  readonly bank: MeshStandardMaterial;
  dispose(): void;
}

/** The walls' materials: vertex colours alone until their textures load. */
export function createShoreMaterials(): ShoreMaterials {
  const make = (roughness: number) =>
    new MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness,
      metalness: 0,
      // Seen from either side: a sliver at the top of a wall never shows through.
      side: DoubleSide,
    });
  const quay = make(0.85);
  const bank = make(0.95);
  // Untextured, a quay is dark brick and a bank earth.
  quay.color.setHex(0x7a5a4c);
  bank.color.setHex(0x7a6a55);
  const textures: Texture[] = [];
  let disposed = false;
  if (canLoad()) {
    const use = (material: MeshStandardMaterial, url: string, tile: number) => {
      load(url, tile).then(
        (t) => {
          if (disposed) {
            t.dispose();
            return;
          }
          textures.push(t);
          material.map = t;
          material.color.setHex(0xffffff);
          material.needsUpdate = true;
        },
        () => undefined,
      );
    };
    use(quay, new URL('./textures/wall-brick.jpg', import.meta.url).href, QUAY_TILE_M);
    use(bank, new URL('./textures/ground-earth.jpg', import.meta.url).href, BANK_TILE_M);
  }
  return {
    quay,
    bank,
    dispose() {
      disposed = true;
      for (const t of textures) t.dispose();
      quay.dispose();
      bank.dispose();
    },
  };
}
