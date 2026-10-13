import { describe, expect, it } from 'vitest';
import { NoColorSpace, ShaderLib, SRGBColorSpace, type Texture } from 'three';
import { createSyntheticTerrain } from '#sim';
import { bakeGroundMap, GROUND_LAYERS } from './ground-map';
import { createGroundMaterial, GROUND_LOOK, groundNoisePixels } from './ground-material';
import { createShoreTexture } from './shore-material';
import { maskLevel, SHORE_CUT_M, type ShoreMask } from './shoreline';

/** Whether two byte arrays hold the same bytes. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// The terrain material (docs/adr/0038): its shader hooks into three's
// standard material, it starts from vertex colours, it reads the ground map
// at the right place, and it frees what it made.

/** Runs the material's shader hook on three's own standard shaders, as the renderer would. */
function compiled(material: ReturnType<typeof createGroundMaterial>['material']) {
  const shader = {
    uniforms: {} as Record<string, { value: unknown }>,
    vertexShader: ShaderLib.standard.vertexShader,
    fragmentShader: ShaderLib.standard.fragmentShader,
  };
  material.onBeforeCompile(shader as never, undefined as never);
  return shader;
}

const terrain = createSyntheticTerrain(
  { originX: -100, originY: -60, cellSize: 10, columns: 21, rows: 13 },
  () => 50,
  { roads: [], buildings: [], vegetation: [] },
);

describe('createGroundMaterial', () => {
  it('hooks into every place it needs in three’s standard shaders', () => {
    const ground = createGroundMaterial();
    const { vertexShader, fragmentShader, uniforms } = compiled(ground.material);
    expect(vertexShader).toContain('vGroundXY = (modelMatrix');
    expect(fragmentShader).toContain('uniform highp sampler2DArray groundAlbedo;');
    // Albedo after the vertex colours, roughness after three's, normals after three's maps.
    const at = (s: string) => fragmentShader.indexOf(s);
    expect(at('diffuseColor.rgb = albedo;')).toBeGreaterThan(at('#include <color_fragment>'));
    expect(at('roughnessFactor = groundRoughness;')).toBeGreaterThan(
      at('#include <roughnessmap_fragment>'),
    );
    expect(at('normal = normalize((viewMatrix')).toBeGreaterThan(
      at('#include <normal_fragment_maps>'),
    );
    // Lighting, shadows and fog stay three's own.
    for (const chunk of ['#include <lights_fragment_begin>', '#include <fog_fragment>']) {
      expect(fragmentShader).toContain(chunk);
    }
    for (const name of [
      'groundAlbedo',
      'groundNormal',
      'groundWeights0',
      'groundWeights1',
      'groundParams',
      'groundNoise',
      'groundMapXform',
      'groundTint',
      'groundTile',
      'groundRough',
      'groundMeanLum',
      'groundOn',
    ]) {
      expect(uniforms[name], name).toBeDefined();
    }
    // Arrays sized to the layers.
    expect((uniforms['groundTile']?.value as number[]).length).toBe(GROUND_LAYERS.length);
    ground.dispose();
  });

  it('starts on vertex colours, with the ground map off', () => {
    const ground = createGroundMaterial();
    expect(ground.material.vertexColors).toBe(true);
    expect(ground.hasMap()).toBe(false);
    expect(compiled(ground.material).uniforms['groundOn']?.value).toBe(0);
    ground.dispose();
  });

  it('keeps the layers’ plain colours when the textures cannot load (no browser here)', async () => {
    const ground = createGroundMaterial();
    await expect(ground.ready).resolves.toBe(false);
    expect(ground.texturesReady()).toBe(false);
    const { uniforms } = compiled(ground.material);
    const albedo = uniforms['groundAlbedo']?.value as Texture;
    // One texel per layer: each layer's colour.
    expect((albedo.image as { width: number }).width).toBe(1);
    const data = (albedo.image as { data: Uint8Array }).data;
    GROUND_LAYERS.forEach((l, i) => {
      const c = GROUND_LOOK[l].color;
      expect([...data.slice(i * 4, i * 4 + 3)]).toEqual([(c >> 16) & 255, (c >> 8) & 255, c & 255]);
    });
    ground.dispose();
  });

  it('reads the map at the right place: each map point at the centre of its texel', () => {
    const ground = createGroundMaterial();
    const map = bakeGroundMap(terrain);
    ground.setMap(map);
    expect(ground.hasMap()).toBe(true);
    const { uniforms } = compiled(ground.material);
    expect(uniforms['groundOn']?.value).toBe(1);
    const [sx, sy, ox, oy] = uniforms['groundMapXform']?.value as number[];
    const { originX, originY, stepX, stepY, columns, rows } = map.grid;
    for (const [c, r] of [
      [0, 0],
      [columns - 1, rows - 1],
      [7, 3],
    ] as const) {
      const u = (originX + c * stepX) * (sx ?? 0) + (ox ?? 0);
      const v = (originY + r * stepY) * (sy ?? 0) + (oy ?? 0);
      expect(u).toBeCloseTo((c + 0.5) / columns, 9);
      expect(v).toBeCloseTo((r + 0.5) / rows, 9);
    }
    // Weights and parameters are data, not colours; the textures are sRGB albedo, linear normals.
    for (const name of ['groundWeights0', 'groundWeights1', 'groundParams', 'groundNoise']) {
      expect((uniforms[name]?.value as Texture).colorSpace).toBe(NoColorSpace);
    }
    expect((uniforms['groundAlbedo']?.value as Texture).colorSpace).toBe(SRGBColorSpace);
    expect((uniforms['groundNormal']?.value as Texture).colorSpace).toBe(NoColorSpace);
    ground.dispose();
  });

  it('frees its textures and replaced maps', () => {
    const ground = createGroundMaterial();
    const disposed = new Set<unknown>();
    const watch = (t: Texture) => {
      t.addEventListener('dispose', () => disposed.add(t));
    };
    const uniforms = compiled(ground.material).uniforms;
    ground.setMap(bakeGroundMap(terrain));
    const first = uniforms['groundWeights0']?.value as Texture;
    watch(first);
    ground.setMap(bakeGroundMap(terrain));
    // The first map's textures are freed when a new one replaces them.
    expect(disposed.has(first)).toBe(true);
    const owned = [
      'groundWeights0',
      'groundWeights1',
      'groundParams',
      'groundNoise',
      'groundAlbedo',
      'groundNormal',
    ].map((n) => uniforms[n]?.value as Texture);
    owned.forEach(watch);
    let materialDisposed = false;
    ground.material.addEventListener('dispose', () => (materialDisposed = true));
    ground.dispose();
    for (const t of owned) expect(disposed.has(t)).toBe(true);
    expect(materialDisposed).toBe(true);
    // A map arriving after disposal (a late bake) is ignored.
    const late = createGroundMaterial();
    late.dispose();
    late.setMap(bakeGroundMap(terrain));
    expect(late.hasMap()).toBe(false);
  });

  it('one program per path, shared by every terrain', () => {
    const a = createGroundMaterial();
    const b = createGroundMaterial();
    expect(a.material.customProgramCacheKey()).toBe(b.material.customProgramCacheKey());
    const keys = new Set<string>();
    for (const [path, define] of [
      ['simple', 'GROUND_SIMPLE'],
      ['flat', 'GROUND_FLAT'],
    ] as const) {
      const version = a.material.version;
      a.setPath(path);
      keys.add(a.material.customProgramCacheKey());
      expect(a.material.defines).toHaveProperty(define);
      expect(a.material.version).toBeGreaterThan(version);
    }
    expect(keys.size).toBe(2);
    expect(createGroundMaterial({ path: 'flat' }).material.customProgramCacheKey()).toBe(
      a.material.customProgramCacheKey(),
    );
    a.setPath('full');
    expect(a.material.defines).toEqual({});
    expect(a.material.customProgramCacheKey()).toBe(b.material.customProgramCacheKey());
    a.dispose();
    b.dispose();
  });

  it('every path’s shader keeps the hooks', () => {
    for (const path of ['full', 'simple', 'flat'] as const) {
      const g = createGroundMaterial({ path });
      const { fragmentShader } = compiled(g.material);
      expect(fragmentShader).toContain('#ifdef GROUND_FLAT');
      expect(fragmentShader).toContain('diffuseColor.rgb = albedo;');
      g.dispose();
    }
  });
});

describe('groundNoisePixels', () => {
  it('is fixed, tiles seamlessly and spans its range', () => {
    const a = groundNoisePixels(64);
    expect(sameBytes(groundNoisePixels(64), a)).toBe(true);
    // Opposite edges match their wrapped neighbours as closely as neighbours inside do.
    let edge = 0;
    let inside = 0;
    for (let y = 0; y < 64; y += 1) {
      edge += Math.abs((a[(y * 64 + 63) * 4] ?? 0) - (a[y * 64 * 4] ?? 0));
      inside += Math.abs((a[(y * 64 + 31) * 4] ?? 0) - (a[(y * 64 + 32) * 4] ?? 0));
    }
    expect(edge).toBeLessThan(2 * inside + 64);
    const values = [...a.filter((_, i) => i % 4 === 0)];
    expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(100);
  });
});

describe('the visibility overlay on the ground (docs/adr/0039)', () => {
  /** A 5 × 3 grid of 4 m cells, a distinct pixel per cell, row 0 the northernmost (as the 2D map's). */
  const grid = { originX: -10, originY: 20, cellSize: 4, columns: 5, rows: 3 };
  const pixels = new Uint8ClampedArray(grid.columns * grid.rows * 4);
  for (let row = 0; row < grid.rows; row += 1) {
    for (let c = 0; c < grid.columns; c += 1) {
      pixels.set([row * 40, c * 40, 200, 255], (row * grid.columns + c) * 4);
    }
  }

  it('each cell of the 2D map’s viewshed lands on the ground where the 2D map draws it', () => {
    const ground = createGroundMaterial();
    ground.setOverlay({ pixels, grid });
    const { uniforms } = compiled(ground.material);
    expect(uniforms['groundOverlayOn']?.value).toBe(1);
    const [sx, sy, ox, oy] = uniforms['groundOverlayXform']?.value as number[];
    const texture = uniforms['groundOverlay']?.value as Texture;
    const data = (texture.image as { data: Uint8Array }).data;
    for (let r = 0; r < grid.rows; r += 1) {
      for (let c = 0; c < grid.columns; c += 1) {
        // The centre of viewshed cell (c, r), r counted from the south as the viewshed grid is.
        const x = grid.originX + (c + 0.5) * grid.cellSize;
        const y = grid.originY + (r + 0.5) * grid.cellSize;
        const u = x * (sx ?? 0) + (ox ?? 0);
        const v = y * (sy ?? 0) + (oy ?? 0);
        const tc = Math.floor(u * grid.columns);
        const tr = Math.floor(v * grid.rows);
        // The texel there is the pixel the 2D map draws for that cell (image row 0 = north).
        const imageRow = grid.rows - 1 - r;
        expect([tc, tr]).toEqual([c, imageRow]);
        const i = (tr * grid.columns + tc) * 4;
        expect([...data.slice(i, i + 2)]).toEqual([imageRow * 40, c * 40]);
      }
    }
    ground.dispose();
  });

  it('is premultiplied (no dark fringe), replaced only for a new viewshed, and cleared', () => {
    const ground = createGroundMaterial();
    const half = new Uint8ClampedArray([200, 100, 50, 128]);
    const one = { originX: 0, originY: 0, cellSize: 4, columns: 1, rows: 1 };
    ground.setOverlay({ pixels: half, grid: one });
    const { uniforms } = compiled(ground.material);
    const first = uniforms['groundOverlay']?.value as Texture;
    expect([...(first.image as { data: Uint8Array }).data]).toEqual([100, 50, 25, 128]);
    // The same viewshed again: the same texture.
    ground.setOverlay({ pixels: half, grid: one });
    expect(uniforms['groundOverlay']?.value).toBe(first);
    let freed = false;
    first.addEventListener('dispose', () => (freed = true));
    ground.setOverlay(null);
    expect(uniforms['groundOverlayOn']?.value).toBe(0);
    expect(freed).toBe(true);
    ground.dispose();
  });
});

describe('the shore cut (docs/adr/0046)', () => {
  // A 3 × 2 mask: sample (c, r) at (−10 + 2c, 20 + 2r); levels 1.5 m and 2.25 m.
  const pixels = new Uint8Array(3 * 2 * 4);
  const mask: ShoreMask = {
    grid: { originX: -10, originY: 20, step: 2, columns: 3, rows: 2 },
    levelBase: 1,
    pixels,
  };
  for (let i = 0; i < 6; i += 1) {
    const q = i < 3 ? 50 : 125;
    pixels[i * 4] = 40;
    pixels[i * 4 + 1] = q >> 8;
    pixels[i * 4 + 2] = q & 255;
  }

  it('discards ground above the water inside it, first thing in the fragment shader', () => {
    const ground = createGroundMaterial();
    const { fragmentShader, vertexShader } = compiled(ground.material);
    expect(vertexShader).toContain('vGroundZ = (modelMatrix');
    const at = (s: string) => fragmentShader.indexOf(s);
    expect(at('discard;')).toBeGreaterThan(at('#include <clipping_planes_fragment>'));
    expect(at('discard;')).toBeLessThan(at('#include <color_fragment>'));
    expect(fragmentShader).toContain(`level + ${SHORE_CUT_M.toFixed(2)}`);
    ground.dispose();
  });

  it('reads the mask at its samples, off until given one', () => {
    const ground = createGroundMaterial();
    expect(compiled(ground.material).uniforms['groundShoreLevel']?.value).toEqual([0, 0]);
    const shore = createShoreTexture(mask);
    ground.setShore(shore);
    const { uniforms } = compiled(ground.material);
    expect(uniforms['groundShoreLevel']?.value).toEqual([1, 1]);
    expect(uniforms['groundShore']?.value).toBe(shore.texture);
    expect(shore.texture.colorSpace).toBe(NoColorSpace);
    const [sx, sy, ox, oy] = uniforms['groundShoreXform']?.value as number[];
    for (const [c, r] of [
      [0, 0],
      [2, 1],
    ] as const) {
      expect((-10 + 2 * c) * (sx ?? 0) + (ox ?? 0)).toBeCloseTo((c + 0.5) / 3, 9);
      expect((20 + 2 * r) * (sy ?? 0) + (oy ?? 0)).toBeCloseTo((r + 0.5) / 2, 9);
    }
    // The level as the shader decodes it.
    expect(maskLevel(mask, 1, 0)).toBeCloseTo(1.5, 9);
    expect(maskLevel(mask, 1, 1)).toBeCloseTo(2.25, 9);
    ground.setShore(null);
    expect(compiled(ground.material).uniforms['groundShoreLevel']?.value).toEqual([0, 0]);
    shore.dispose();
    ground.dispose();
  });
});
