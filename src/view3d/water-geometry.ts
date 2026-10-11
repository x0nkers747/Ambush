import type { TerrainDataset } from '#sim';
import { finishMesh, meshBuffers, type Draper, type MeshData } from './drape';
import { drapeNetwork } from './line-network';

// Water in 3D (docs/adr/0030): lakes, ponds, river surfaces and the sea
// (`water` areas, islands left open), and watercourses drawn as lines
// (`waterways`), as one draped, slightly transparent surface.
//
// Water is draped on the ground rather than drawn as a level sheet. The
// elevation data rarely models a water surface as exactly flat; a level sheet
// would cut into the banks or float above the ground wherever it does not,
// while a draped one can do neither. On imported ground, which is flat over
// water, the two look the same. Wetland is marshy ground, not open water: it
// is shown in the ground's colours (landcover.ts), not here.

/** Water lies just above the ground, below the roads that cross it. */
export const WATER_OFFSET_M = 0.03;

export interface WaterGeometry {
  readonly mesh: MeshData;
  readonly areas: number;
  readonly waterways: number;
}

export function waterGeometry(terrain: TerrainDataset, draper: Draper): WaterGeometry {
  const { water = [], waterways = [] } = terrain.features;
  const out = meshBuffers();
  const areas = water
    .filter((w) => w.kind === 'water')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const area of areas) {
    draper.polygon(area.boundary, area.holes ?? [], WATER_OFFSET_M, out);
  }
  const lines = drapeNetwork(
    waterways.map((w) => ({
      id: w.id,
      style: 'waterway' as const,
      centerline: w.centerline,
      halfWidth: w.widthMeters / 2,
    })),
    draper,
    () => WATER_OFFSET_M,
  ).get('waterway');
  if (lines) {
    // (Element by element: spreading a long array overflows the call stack.)
    for (const v of lines.positions) out.positions.push(v);
    for (const v of lines.normals) out.normals.push(v);
  }
  // Lit as a level surface whatever the ground under it: following the
  // ground's normals, bumps in the elevation data under the water would catch
  // the sun as bright streaks.
  for (let i = 0; i < out.normals.length; i += 3) {
    out.normals[i] = 0;
    out.normals[i + 1] = 1;
    out.normals[i + 2] = 0;
  }
  return { mesh: finishMesh(out), areas: areas.length, waterways: waterways.length };
}
