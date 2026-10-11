import {
  cleanTerrain,
  DEM_CLEANING_VERSION,
  type DemQualityReport,
  type SourceCorrections,
} from './dem-quality';
import { GRADING_VERSION, gradeTerrain } from './grading';
import type { TerrainDataset } from './terrain';

// The authoritative ground (docs/adr/0032, docs/adr/0033): an imported
// terrain's raw DEM, cleaned of faulty elevations, then graded (roads and
// building foundations built in). Every system uses the result; the raw
// terrain is kept as it was.

/** The model of the ground `authoritativeGround` makes (its `terrainModelId`). */
export const TERRAIN_MODEL = `${DEM_CLEANING_VERSION}+graded-v${String(GRADING_VERSION)}`;

/** The authoritative ground of a raw terrain, and the DEM quality report. */
export function authoritativeGround(
  source: TerrainDataset,
  corrections: SourceCorrections | null = null,
): { terrain: TerrainDataset; quality: DemQualityReport } {
  const { terrain, report } = cleanTerrain(source, corrections);
  return { terrain: gradeTerrain(terrain), quality: report };
}
