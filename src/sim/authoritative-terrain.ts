import {
  cleanTerrain,
  DEM_CLEANING_VERSION,
  type DemQualityReport,
  type SourceCorrections,
} from './dem-quality';
import { gradeTerrain } from './ground';
import { TERRAIN_FIELD_VERSION } from './terrain-field/field';
import type { TerrainDataset } from './terrain';

// The authoritative ground (docs/adr/0033, docs/adr/0049): an imported
// terrain's raw DEM, cleaned of faulty elevations, then the terrain field
// (roads, bridges, building pads and water built in) sampled from it. Every system uses the result; the raw
// terrain is kept as it was.

/** The model of the ground `authoritativeGround` makes (its `terrainModelId`). */
export const TERRAIN_MODEL = `${DEM_CLEANING_VERSION}+field-v${String(TERRAIN_FIELD_VERSION)}`;

/** The authoritative ground of a raw terrain, and the DEM quality report. */
export function authoritativeGround(
  source: TerrainDataset,
  corrections: SourceCorrections | null = null,
): { terrain: TerrainDataset; quality: DemQualityReport } {
  const { terrain, report } = cleanTerrain(source, corrections);
  return { terrain: gradeTerrain(terrain), quality: report };
}
