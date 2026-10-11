import { heightAt, type LandUseArea, type Road, type TerrainDataset, type Vec2 } from '#sim';
import { landUseLookup, regionOf, type Region } from './building-style';
import { vegetationExclusions, type Exclusions } from './exclusion';
import {
  polygonIndex,
  polylineSegments,
  segmentGrid,
  type PolygonIndex,
  type SegmentGrid,
} from './spatial-index';

// What the roadside details are placed from (docs/adr/0036): the
// battlefield's own features, read, never changed. How built-up a place is
// (buildings round it), its land use, whether it is in a wood, how steep the
// ground is, and the vehicle road network with its junctions. Pure.

/** Highway types that are not for vehicles. */
const FOOT = new Set([
  'footway',
  'path',
  'cycleway',
  'bridleway',
  'steps',
  'pedestrian',
  'corridor',
]);

/** Whether a road carries vehicles (paths and footways do not). */
export const isVehicleRoad = (r: Road) =>
  r.roadClass !== 'path' && !(r.highway !== undefined && FOOT.has(r.highway));

/** Whether a mapped road is an access way: a path, footway, steps or a service road (driveways). */
export const isAccessWay = (r: Road) =>
  r.roadClass === 'path' ||
  r.highway === 'service' ||
  (r.highway !== undefined && FOOT.has(r.highway));

/** Roads that get streetside furniture: through roads, not service roads, tracks or paths. */
export const isStreet = (r: Road) =>
  isVehicleRoad(r) &&
  r.highway !== 'service' &&
  r.highway !== 'track' &&
  (r.roadClass === 'paved' || r.roadClass === 'major' || r.roadClass === 'unpaved');

/** Width of the verge drawn beside paved roads (road-geometry.ts). */
const VERGE_M = 0.6;

/** The edge of a road's drawn surface from its centreline, metres. */
export const roadEdge = (r: Road) =>
  r.widthMeters / 2 + (r.roadClass === 'paved' || r.roadClass === 'major' ? VERGE_M : 0);

export interface NearestRoad {
  readonly road: number;
  /** The nearest point on the centreline. */
  readonly x: number;
  readonly y: number;
  readonly distance: number;
  /** Unit direction of the segment there. */
  readonly dx: number;
  readonly dy: number;
}

export interface DecorContext {
  readonly terrain: TerrainDataset;
  readonly region: Region;
  /** Plants' exclusions (roads and verges, buildings, water), reused for every detail. */
  readonly exclusions: Exclusions;
  readonly landUse: (p: Vec2) => LandUseArea | null;
  /** Buildings within about 75 m. */
  builtUp(x: number, y: number): number;
  /** Inside a vegetation area of any kind (woods, tree lines, hedges, scrub). */
  inVegetation(x: number, y: number): boolean;
  /** Within `d` of a wood's edge, or in it. */
  nearWoodland(x: number, y: number, d: number): boolean;
  /** Ground slope (rise over run) at a point. */
  slope(x: number, y: number): number;
  /** Ground height, the point kept on the terrain. */
  ground(x: number, y: number): number;
  onTerrain(x: number, y: number): boolean;
  /** Vehicle roads, sorted by id. */
  readonly roads: readonly Road[];
  /** Junctions of the vehicle network. */
  readonly junctions: readonly Vec2[];
  /** Distance to the nearest junction, at most `limit`. */
  junctionDistance(x: number, y: number, limit: number): number;
  /** The nearest vehicle road centreline within `limit`, or null. */
  nearestRoad(
    x: number,
    y: number,
    limit: number,
    filter?: (road: number) => boolean,
  ): NearestRoad | null;
  /** Mapped paths, footways and service roads (driveways), as drawn surfaces. */
  readonly access: SegmentGrid;
  /** Building walls (for clearances). */
  readonly walls: SegmentGrid;
  /** The building whose footprint contains (x, y), if any (index into the features' buildings). */
  buildingAt(x: number, y: number): number;
  /** In open water or a watercourse, or within `clearance` of one. */
  water(x: number, y: number, clearance: number): boolean;
}

const CELL = 25;
const cellKey = (i: number, j: number) => i * 100_003 + j;

export function decorContext(terrain: TerrainDataset): DecorContext {
  const { features } = terrain;
  const { originX, originY, cellSize, columns, rows } = terrain.heightfield;
  const maxX = originX + (columns - 1) * cellSize;
  const maxY = originY + (rows - 1) * cellSize;
  const clampX = (x: number) => Math.min(maxX, Math.max(originX, x));
  const clampY = (y: number) => Math.min(maxY, Math.max(originY, y));
  const ground = (x: number, y: number) => heightAt(terrain, clampX(x), clampY(y));

  // Building density: centroids counted on a 50 m grid, read over 3 × 3 cells.
  const D = 50;
  const density = new Map<number, number>();
  const buildingCells = new Map<number, number[]>();
  features.buildings.forEach((b, index) => {
    let cx = 0;
    let cy = 0;
    for (const p of b.footprint) {
      cx += p.x;
      cy += p.y;
    }
    cx /= b.footprint.length;
    cy /= b.footprint.length;
    const k = cellKey(Math.floor(cx / D), Math.floor(cy / D));
    density.set(k, (density.get(k) ?? 0) + 1);
    const xs = b.footprint.map((p) => p.x);
    const ys = b.footprint.map((p) => p.y);
    for (let i = Math.floor(Math.min(...xs) / CELL); i <= Math.floor(Math.max(...xs) / CELL); i++) {
      for (
        let j = Math.floor(Math.min(...ys) / CELL);
        j <= Math.floor(Math.max(...ys) / CELL);
        j++
      ) {
        const list = buildingCells.get(cellKey(i, j)) ?? [];
        list.push(index);
        buildingCells.set(cellKey(i, j), list);
      }
    }
  });
  const builtUp = (x: number, y: number) => {
    const i = Math.floor(x / D);
    const j = Math.floor(y / D);
    let n = 0;
    for (let a = -1; a <= 1; a += 1)
      for (let b = -1; b <= 1; b += 1) n += density.get(cellKey(i + a, j + b)) ?? 0;
    return n;
  };
  const buildingAt = (x: number, y: number) => {
    for (const i of buildingCells.get(cellKey(Math.floor(x / CELL), Math.floor(y / CELL))) ?? []) {
      const b = features.buildings[i];
      if (b && polygonContains(b.footprint, x, y)) return i;
    }
    return -1;
  };

  // Vegetation areas.
  const areas: PolygonIndex[] = features.vegetation.map((v) =>
    polygonIndex([v.boundary, ...(v.holes ?? [])]),
  );
  const areaCells = new Map<number, number[]>();
  areas.forEach((a, index) => {
    for (let i = Math.floor(a.minX / 100); i <= Math.floor(a.maxX / 100); i++) {
      for (let j = Math.floor(a.minY / 100); j <= Math.floor(a.maxY / 100); j++) {
        const list = areaCells.get(cellKey(i, j)) ?? [];
        list.push(index);
        areaCells.set(cellKey(i, j), list);
      }
    }
  });
  const inVegetation = (x: number, y: number) =>
    (areaCells.get(cellKey(Math.floor(x / 100), Math.floor(y / 100))) ?? []).some((i) =>
      areas[i]?.contains(x, y),
    );
  const woods = features.vegetation.filter((v) => v.kind === 'woodland');
  const woodEdges = segmentGrid(
    polylineSegments(
      woods.flatMap((w) =>
        [w.boundary, ...(w.holes ?? [])].map((points) => ({ points, halfWidth: 0 })),
      ),
      true,
    ),
    40,
    50,
  );
  const woodAreas = woods.map((w) => polygonIndex([w.boundary, ...(w.holes ?? [])]));
  const inWood = (x: number, y: number) => woodAreas.some((w) => w.contains(x, y));

  // Vehicle roads, their segments and junctions.
  const byId = (a: Road, b: Road) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const roads = features.roads.filter(isVehicleRoad).sort(byId);
  const SEG_CELL = 40;
  const segCells = new Map<number, number[]>();
  const segs: number[] = []; // road, ax, ay, bx, by
  roads.forEach((r, ri) => {
    for (let i = 0; i + 1 < r.centerline.length; i += 1) {
      const a = r.centerline[i];
      const b = r.centerline[i + 1];
      if (!a || !b) continue;
      const s = segs.length / 5;
      segs.push(ri, a.x, a.y, b.x, b.y);
      for (
        let ci = Math.floor(Math.min(a.x, b.x) / SEG_CELL) - 2;
        ci <= Math.floor(Math.max(a.x, b.x) / SEG_CELL) + 2;
        ci++
      ) {
        for (
          let cj = Math.floor(Math.min(a.y, b.y) / SEG_CELL) - 2;
          cj <= Math.floor(Math.max(a.y, b.y) / SEG_CELL) + 2;
          cj++
        ) {
          const list = segCells.get(cellKey(ci, cj)) ?? [];
          list.push(s);
          segCells.set(cellKey(ci, cj), list);
        }
      }
    }
  });
  const nearestRoad: DecorContext['nearestRoad'] = (x, y, limit, filter) => {
    let best: NearestRoad | null = null;
    // Segments are bucketed with two cells of margin (80 m): wider searches look further.
    const reach = Math.max(0, Math.ceil((limit - 2 * SEG_CELL) / SEG_CELL));
    const ci = Math.floor(x / SEG_CELL);
    const cj = Math.floor(y / SEG_CELL);
    const seen = new Set<number>();
    for (let a = -reach; a <= reach; a += 1) {
      for (let b = -reach; b <= reach; b += 1) {
        for (const s of segCells.get(cellKey(ci + a, cj + b)) ?? []) {
          if (seen.has(s)) continue;
          seen.add(s);
          const road = segs[s * 5] ?? 0;
          if (filter && !filter(road)) continue;
          const ax = segs[s * 5 + 1] ?? 0;
          const ay = segs[s * 5 + 2] ?? 0;
          const dx = (segs[s * 5 + 3] ?? 0) - ax;
          const dy = (segs[s * 5 + 4] ?? 0) - ay;
          const len2 = dx * dx + dy * dy;
          if (len2 === 0) continue;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
          const px = ax + t * dx;
          const py = ay + t * dy;
          const d = Math.hypot(x - px, y - py);
          if (d <= limit && (!best || d < best.distance - 1e-9)) {
            const len = Math.sqrt(len2);
            best = { road, x: px, y: py, distance: d, dx: dx / len, dy: dy / len };
          }
        }
      }
    }
    return best;
  };

  // Junctions: nodes where three or more segment ends meet, or two from different roads at an angle.
  const key = (p: Vec2) => `${String(Math.round(p.x * 100))},${String(Math.round(p.y * 100))}`;
  const ends = new Map<string, { p: Vec2; dirs: { road: number; dx: number; dy: number }[] }>();
  roads.forEach((r, ri) => {
    const pts = r.centerline;
    pts.forEach((p, i) => {
      const touch = (q: Vec2 | undefined) => {
        if (!q) return;
        const len = Math.hypot(q.x - p.x, q.y - p.y);
        if (len === 0) return;
        const k = key(p);
        const e = ends.get(k) ?? { p, dirs: [] };
        e.dirs.push({ road: ri, dx: (q.x - p.x) / len, dy: (q.y - p.y) / len });
        ends.set(k, e);
      };
      touch(pts[i - 1]);
      touch(pts[i + 1]);
    });
  });
  const junctions: Vec2[] = [];
  for (const { p, dirs } of [...ends.values()].sort((a, b) => a.p.x - b.p.x || a.p.y - b.p.y)) {
    if (dirs.length >= 3) junctions.push(p);
    else if (dirs.length === 2) {
      const [a, b] = dirs;
      // A way continuing another is no junction; a sharp meeting of two roads is.
      if (a && b && a.road !== b.road && a.dx * b.dx + a.dy * b.dy > -0.7) junctions.push(p);
    }
  }
  // A road that ends on another road's side (not at one of its points) meets it there too.
  const atVertex = new Set(junctions.map(key));
  roads.forEach((r, ri) => {
    for (const p of [r.centerline[0], r.centerline[r.centerline.length - 1]]) {
      if (!p || atVertex.has(key(p))) continue;
      if (nearestRoad(p.x, p.y, 1, (o) => o !== ri)) {
        junctions.push(p);
        atVertex.add(key(p));
      }
    }
  });
  const junctionGrid = segmentGrid(
    Float64Array.from(junctions.flatMap((p) => [p.x, p.y, p.x, p.y, 0])),
    40,
    40,
  );

  const access = segmentGrid(
    polylineSegments(
      features.roads
        .filter(isAccessWay)
        .map((r) => ({ points: r.centerline, halfWidth: r.widthMeters / 2 })),
    ),
    20,
  );
  const walls = segmentGrid(
    polylineSegments(
      features.buildings.map((b) => ({ points: b.footprint, halfWidth: 0 })),
      true,
    ),
    20,
  );

  const openWater = (features.water ?? []).filter((w) => w.kind === 'water');
  const waterAreas = openWater.map((w) => polygonIndex([w.boundary, ...(w.holes ?? [])]));
  const shores = segmentGrid(
    polylineSegments(
      [
        ...openWater.flatMap((w) =>
          [w.boundary, ...(w.holes ?? [])].map((points) => ({ points, halfWidth: 0 })),
        ),
      ],
      true,
    ),
    10,
  );
  const streams = segmentGrid(
    polylineSegments(
      (features.waterways ?? []).map((w) => ({
        points: w.centerline,
        halfWidth: w.widthMeters / 2,
      })),
    ),
    10,
  );

  return {
    terrain,
    region: regionOf(terrain),
    water: (x, y, clearance) =>
      streams.near(x, y, clearance) ||
      shores.near(x, y, clearance) ||
      waterAreas.some((w) => w.contains(x, y)),
    exclusions: vegetationExclusions(features),
    landUse: landUseLookup(features.landUse ?? []),
    builtUp,
    inVegetation,
    nearWoodland: (x, y, d) => inWood(x, y) || woodEdges.near(x, y, d),
    slope: (x, y) => {
      const e = 1.5;
      const gx = (ground(x + e, y) - ground(x - e, y)) / (2 * e);
      const gy = (ground(x, y + e) - ground(x, y - e)) / (2 * e);
      return Math.hypot(gx, gy);
    },
    ground,
    onTerrain: (x, y) => x >= originX && x <= maxX && y >= originY && y <= maxY,
    roads,
    junctions,
    junctionDistance: (x, y, limit) => junctionGrid.distance(x, y, limit),
    nearestRoad,
    access,
    walls,
    buildingAt,
  };
}

/** Even–odd point in polygon. */
export function polygonContains(ring: readonly Vec2[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
