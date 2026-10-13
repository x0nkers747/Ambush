import { describe, expect, it } from 'vitest';
import { ShaderLib } from 'three';
import { createSyntheticTerrain, type Vec2, type WaterClass } from '#sim';
import { srgbToLinear } from './srgb';
import { createWaterMaterial, WATER_FRESNEL } from './water-material';
import {
  URBAN_REACH_M,
  urbanGrid,
  urbanShare,
  WATER_PROFILES,
  waterProfileFor,
  type WaterProfileName,
} from './water-profiles';

// How water looks (docs/adr/0046): the visual profiles, how one is chosen,
// and the opaque water material.

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

const lum = (c: number) =>
  0.2126 * srgbToLinear((c >> 16) & 255) +
  0.7152 * srgbToLinear((c >> 8) & 255) +
  0.0722 * srgbToLinear(c & 255);

describe('water profiles', () => {
  it('picks a profile by the kind of water and how built-up its shore is', () => {
    const cases: [WaterClass, number, WaterProfileName][] = [
      ['sea', 0, 'ocean'],
      ['lake', 1, 'lake'],
      ['reservoir', 0, 'reservoir'],
      ['river', 1, 'river'],
      ['canal', 0.6, 'urbanCanal'],
      ['canal', 0, 'river'],
      // Amsterdam's canals are mapped as plain water: built-up, they are canals.
      ['other', 0.8, 'urbanCanal'],
      ['other', 0.1, 'lake'],
      ['pond', 0.9, 'urbanCanal'],
      ['pond', 0, 'pond'],
      ['basin', 0, 'lake'],
    ];
    for (const [cls, share, profile] of cases) expect(waterProfileFor(cls, share)).toBe(profile);
  });

  it('are dark and desaturated: no swimming-pool turquoise', () => {
    for (const [name, p] of Object.entries(WATER_PROFILES)) {
      expect(lum(p.color), name).toBeLessThan(0.08);
      const r = (p.color >> 16) & 255;
      const g = (p.color >> 8) & 255;
      const b = p.color & 255;
      expect(Math.max(r, g, b) - Math.min(r, g, b), name).toBeLessThan(48);
    }
    // An urban canal is green-grey; a lake bluer; every profile its own colour.
    const canal = WATER_PROFILES.urbanCanal.color;
    expect((canal >> 8) & 255).toBeGreaterThanOrEqual(canal & 255);
    expect(WATER_PROFILES.lake.color & 255).toBeGreaterThan(
      (WATER_PROFILES.lake.color >> 16) & 255,
    );
    expect(new Set(Object.values(WATER_PROFILES).map((p) => p.color)).size).toBe(
      Object.keys(WATER_PROFILES).length,
    );
    expect(WATER_PROFILES.urbanCanal.natural).toBe(false);
    expect(WATER_PROFILES.lake.natural).toBe(true);
  });

  it('measures how built-up a shore is from the buildings near it', () => {
    const terrain = createSyntheticTerrain(
      { originX: -200, originY: -200, cellSize: 10, columns: 41, rows: 41 },
      () => 5,
      {
        roads: [],
        buildings: [{ id: 'b', footprint: rect(0, 0, 10, 10), heightMeters: 8 }],
        vegetation: [],
      },
    );
    const urban = urbanGrid(terrain);
    expect(urban.at(5, 5)).toBe(true);
    expect(urban.at(5, 10 + URBAN_REACH_M - 8)).toBe(true);
    expect(urban.at(150, 150)).toBe(false);
    expect(urbanShare(rect(-5, -5, 15, 15), urban)).toBe(1);
    expect(urbanShare(rect(100, 100, 150, 150), urban)).toBe(0);
    // Built once per terrain.
    expect(urbanGrid(terrain)).toBe(urban);
  });
});

describe('the water material (docs/adr/0046)', () => {
  const compiled = () => {
    const material = createWaterMaterial();
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: ShaderLib.standard.vertexShader,
      fragmentShader: ShaderLib.standard.fragmentShader,
    };
    material.onBeforeCompile(shader as never, undefined as never);
    return { material, shader };
  };

  it('is opaque, rough enough to keep the sun’s glint small, and one program for every battlefield', () => {
    const a = compiled();
    const b = compiled();
    expect(a.material.opacity).toBe(1);
    expect(a.material.depthWrite).toBe(false);
    expect(a.material.roughness).toBeGreaterThanOrEqual(0.4);
    expect(a.material.metalness).toBe(0);
    expect(a.material.customProgramCacheKey()).toBe(b.material.customProgramCacheKey());
    expect(a.shader.uniforms['waterFresnel']?.value).toBe(WATER_FRESNEL);
  });

  it('reflects the sky by a Fresnel term before three writes its colour', () => {
    const { shader } = compiled();
    const f = shader.fragmentShader;
    expect(f.indexOf('outgoingLight = mix(outgoingLight, waterSky')).toBeGreaterThan(0);
    expect(f.indexOf('outgoingLight = mix(outgoingLight, waterSky')).toBeLessThan(
      f.indexOf('#include <opaque_fragment>'),
    );
  });
});
