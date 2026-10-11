import type { LodSettings } from './vegetation-lod';

// Quality presets for the 3D view (docs/adr/0031). They change how far and
// how finely vegetation is drawn, shadows and resolution, never where
// anything is: positions, the terrain and the simulation are the same at
// every level.

export type QualityLevel = 'low' | 'medium' | 'high';

export interface QualityPreset {
  readonly level: QualityLevel;
  readonly vegetation: LodSettings;
  /** Sun shadows round the camera's focus, or none. */
  readonly shadows: {
    readonly mapSize: number;
    /** Width of the shadowed square, metres, at most. */
    readonly extent: number;
    /** Whether trees receive shadows too (self-shading of the forest). */
    readonly treesReceive: boolean;
  } | null;
  readonly maxPixelRatio: number;
}

export const QUALITY_PRESETS: Readonly<Record<QualityLevel, QualityPreset>> = {
  // Integrated graphics (Intel Iris Xe class).
  low: {
    level: 'low',
    vegetation: { near: 90, medium: 320, far: 1800, thinStart: 450, minFraction: 0.2 },
    shadows: null,
    maxPixelRatio: 1,
  },
  // Mainstream desktop GPUs.
  medium: {
    level: 'medium',
    vegetation: { near: 150, medium: 600, far: 4500, thinStart: 1000, minFraction: 0.12 },
    shadows: { mapSize: 2048, extent: 700, treesReceive: false },
    maxPixelRatio: 1.5,
  },
  // Dedicated GPUs.
  high: {
    level: 'high',
    vegetation: { near: 240, medium: 950, far: 7000, thinStart: 1500, minFraction: 0.12 },
    shadows: { mapSize: 4096, extent: 1100, treesReceive: true },
    maxPixelRatio: 2,
  },
};

/**
 * A quality level for a GPU, from the renderer string WebGL reports
 * (`WEBGL_debug_renderer_info`), or medium when it is unknown. Software
 * renderers and integrated Intel graphics get low; Apple silicon medium;
 * NVIDIA and AMD high.
 */
export function detectQuality(renderer: string | null): QualityLevel {
  const r = (renderer ?? '').toLowerCase();
  if (/swiftshader|llvmpipe|softpipe|software|basic render/.test(r)) return 'low';
  if (r.includes('intel')) return 'low';
  if (r.includes('apple')) return 'medium';
  if (/nvidia|geforce|rtx|quadro|radeon|amd/.test(r)) return 'high';
  return 'medium';
}
