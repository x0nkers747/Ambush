import { pointInPolygon, type EnvironmentFeatures } from '#sim';
import { polygonIndex, polylineSegments, segmentGrid, type PolygonIndex } from './spatial-index';
import { VERGE_M } from './road-geometry';

// Where plants may not grow (docs/adr/0031), from the battlefield's own
// features: on roads and their verges, in and against buildings, in open
// water and watercourses. Wetland is not excluded. The source data is never
// changed; these are only tests on it.

export type ExclusionReason = 'road' | 'building' | 'water';

export interface Exclusions {
  /**
   * Why a plant whose crown has radius `crown` (metres) may not stand at
   * (x, y), or null if it may.
   */
  reason(x: number, y: number, crown: number): ExclusionReason | null;
}

/** Trunks keep at least this far off a road's verge, more for wide crowns (a quarter of the radius). */
export const ROAD_CLEARANCE_M = 1;
/** Crowns keep clear of walls: this far plus most of the crown's radius. */
export const BUILDING_CLEARANCE_M = 0.5;
export const BUILDING_CROWN_SHARE = 0.8;
/** Trunks keep this far from open water and watercourses. */
export const WATER_CLEARANCE_M = 1;

/** The largest crown radius asked about: sets how far the indexes look. */
const MAX_CROWN_M = 8;

export function vegetationExclusions(features: EnvironmentFeatures): Exclusions {
  const roads = segmentGrid(
    polylineSegments(
      features.roads.map((r) => ({
        points: r.centerline,
        halfWidth:
          r.widthMeters / 2 + (r.roadClass === 'paved' || r.roadClass === 'major' ? VERGE_M : 0),
      })),
    ),
    ROAD_CLEARANCE_M + MAX_CROWN_M / 4,
  );
  const waterways = segmentGrid(
    polylineSegments(
      (features.waterways ?? []).map((w) => ({
        points: w.centerline,
        halfWidth: w.widthMeters / 2,
      })),
    ),
    WATER_CLEARANCE_M,
  );
  const openWater = (features.water ?? []).filter((w) => w.kind === 'water');
  const waterAreas: PolygonIndex[] = openWater.map((w) =>
    polygonIndex([w.boundary, ...(w.holes ?? [])]),
  );
  const shores = segmentGrid(
    polylineSegments(
      openWater.flatMap((w) =>
        [w.boundary, ...(w.holes ?? [])].map((points) => ({ points, halfWidth: 0 })),
      ),
      true,
    ),
    WATER_CLEARANCE_M,
  );
  const buildingEdges = segmentGrid(
    polylineSegments(
      features.buildings.map((b) => ({ points: b.footprint, halfWidth: 0 })),
      true,
    ),
    BUILDING_CLEARANCE_M + BUILDING_CROWN_SHARE * MAX_CROWN_M,
  );
  // Buildings by 25 m cell, for "inside a footprint" tests.
  const CELL = 25;
  const buildingCells = new Map<number, number[]>();
  features.buildings.forEach((b, index) => {
    const xs = b.footprint.map((p) => p.x);
    const ys = b.footprint.map((p) => p.y);
    for (let i = Math.floor(Math.min(...xs) / CELL); i <= Math.floor(Math.max(...xs) / CELL); i++) {
      for (
        let j = Math.floor(Math.min(...ys) / CELL);
        j <= Math.floor(Math.max(...ys) / CELL);
        j++
      ) {
        const k = i * 100_003 + j;
        const list = buildingCells.get(k) ?? [];
        list.push(index);
        buildingCells.set(k, list);
      }
    }
  });

  return {
    reason(x, y, crown) {
      if (roads.near(x, y, ROAD_CLEARANCE_M + Math.min(crown, MAX_CROWN_M) / 4)) return 'road';
      if (
        buildingEdges.near(
          x,
          y,
          BUILDING_CLEARANCE_M + BUILDING_CROWN_SHARE * Math.min(crown, MAX_CROWN_M),
        )
      ) {
        return 'building';
      }
      const cell = buildingCells.get(Math.floor(x / CELL) * 100_003 + Math.floor(y / CELL));
      for (const i of cell ?? []) {
        const b = features.buildings[i];
        if (b && pointInPolygon({ x, y }, b.footprint)) return 'building';
      }
      if (waterways.near(x, y, WATER_CLEARANCE_M) || shores.near(x, y, WATER_CLEARANCE_M)) {
        return 'water';
      }
      for (const w of waterAreas) if (w.contains(x, y)) return 'water';
      return null;
    },
  };
}
