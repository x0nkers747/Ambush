import { CLUTTER_QUALITY, type ClutterSettings } from './clutter';
import type { LodSettings } from './vegetation-lod';

// Quality presets for the 3D view (docs/adr/0031, docs/adr/0049). They change
// how far and how finely the ground and vegetation are drawn, grass, shadows
// and resolution, never where anything is: positions, the terrain and the
// simulation are the same at every level.

export type QualityLevel = 'low' | 'medium' | 'high';

/** How the ground is drawn (docs/adr/0049). */
export interface GroundQuality {
  /** How far the finest level of the ground reaches, metres (each coarser one twice as far). */
  readonly lodRangeM: number;
  /** Where the ground's fine detail (normal maps) starts to fade, metres; gone at three times this. */
  readonly detailM: number;
  /** Hex tiling, height blending and parallax of the ground's materials. */
  readonly advanced: boolean;
  /** Grass, weeds, pebbles and leaves near the camera, or none. */
  readonly clutter: ClutterSettings | null;
}

export interface QualityPreset {
  readonly level: QualityLevel;
  readonly ground: GroundQuality;
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
    ground: { lodRangeM: 75, detailM: 45, advanced: true, clutter: CLUTTER_QUALITY.low },
    vegetation: { near: 90, medium: 320, far: 1800, thinStart: 450, minFraction: 0.2 },
    shadows: null,
    maxPixelRatio: 1,
  },
  // Mainstream desktop GPUs.
  medium: {
    level: 'medium',
    ground: { lodRangeM: 100, detailM: 60, advanced: true, clutter: CLUTTER_QUALITY.medium },
    vegetation: { near: 150, medium: 600, far: 4500, thinStart: 1000, minFraction: 0.12 },
    shadows: { mapSize: 2048, extent: 700, treesReceive: false },
    maxPixelRatio: 1.5,
  },
  // Dedicated GPUs.
  high: {
    level: 'high',
    ground: { lodRangeM: 130, detailM: 80, advanced: true, clutter: CLUTTER_QUALITY.high },
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
  if (isSoftwareRenderer(renderer)) return 'low';
  if (r.includes('intel')) return 'low';
  if (r.includes('apple')) return 'medium';
  if (/nvidia|geforce|rtx|quadro|radeon|amd/.test(r)) return 'high';
  return 'medium';
}

/** Whether WebGL is drawn on the CPU (SwiftShader, llvmpipe, Microsoft Basic Render). */
export function isSoftwareRenderer(renderer: string | null): boolean {
  return /swiftshader|llvmpipe|softpipe|software|basic render/.test((renderer ?? '').toLowerCase());
}
