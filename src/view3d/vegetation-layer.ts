import type { Group, PerspectiveCamera } from 'three';
import type { LodSettings } from './vegetation-lod';

// The vegetation in the scene (docs/adr/0031, docs/adr/0049): what the view
// needs of it. forest.ts draws it.

export interface VegetationStats {
  readonly instances: number;
  /** Plants drawn in the last selection, per band (near, medium, far). */
  readonly drawn: readonly number[];
  readonly selections: number;
  /** Time of the last selection, milliseconds. */
  readonly lastSelectMs: number;
  readonly tilesDrawn: number;
}

export interface VegetationLayer {
  readonly group: Group;
  /** Chooses what to draw for this camera if it has moved enough. Call before each render. */
  update(camera: PerspectiveCamera): void;
  /** New distances (quality presets); reselects on the next update. */
  setSettings(settings: LodSettings, shadows: { cast: boolean; receive: boolean }): void;
  stats(): VegetationStats;
  dispose(): void;
}
