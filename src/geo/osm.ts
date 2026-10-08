import {
  isSimplePolygon,
  pointInPolygon,
  polygonArea,
  type Building,
  type EnvironmentFeatures,
  type FeatureSource,
  type LandUseArea,
  type LandUseKind,
  type Road,
  type RoadClass,
  type Vec2,
  type VegetationArea,
  type WaterArea,
  type Waterway,
  type WaterwayKind,
} from '#sim';
import { clipPolygon, clipPolyline, dedupe, type Rect } from './clip';
import { toLocal, type BattlefieldFrame, type GeoBox } from './frame';
import type { LatLon } from './utm';

// OpenStreetMap features from an Overpass API response (docs/adr/0014):
// roads and tracks, buildings, woods and other vegetation, water, waterways
// and land use, in the battlefield's local metres, clipped to it. OSM data is
// often incomplete or imperfect: anything that cannot be turned into valid
// geometry is dropped and reported, never allowed to fail the import, and
// every value taken from a default rather than the data is marked estimated.

/** The parts of an Overpass `[out:json]` response with `out geom` that the importer reads. */
export interface OverpassResponse {
  readonly osm3s?: { readonly timestamp_osm_base?: string };
  readonly elements: readonly OsmElement[];
}

export type OsmElement =
  | { readonly type: 'node'; readonly id: number; readonly tags?: Tags }
  | {
      readonly type: 'way';
      readonly id: number;
      readonly tags?: Tags;
      readonly geometry?: readonly (LatLon | null)[];
    }
  | {
      readonly type: 'relation';
      readonly id: number;
      readonly tags?: Tags;
      readonly members?: readonly {
        readonly type: string;
        readonly ref: number;
        readonly role: string;
        readonly geometry?: readonly (LatLon | null)[];
      }[];
    };

type Tags = Readonly<Record<string, string>>;

/**
 * The Overpass QL query for a battlefield: every way or multipolygon the
 * importer uses, with full geometry, within the given boxes (two when the
 * battlefield crosses ±180°).
 */
export function overpassQuery(boxes: readonly GeoBox[], timeoutSeconds = 90): string {
  const parts = boxes.map((b) => {
    const bbox = [b.south, b.west, b.north, b.east].map((v) => v.toFixed(6)).join(',');
    return [
      `way["highway"](${bbox});`,
      `way["building"](${bbox});`,
      `relation["building"]["type"="multipolygon"](${bbox});`,
      `way["natural"~"^(wood|scrub|heath|wetland|water|grassland|tree_row)$"](${bbox});`,
      `relation["natural"~"^(wood|scrub|heath|wetland|water|grassland)$"]["type"="multipolygon"](${bbox});`,
      `way["landuse"](${bbox});`,
      `relation["landuse"]["type"="multipolygon"](${bbox});`,
      `way["waterway"](${bbox});`,
      `way["water"](${bbox});`,
      `relation["water"]["type"="multipolygon"](${bbox});`,
      `way["barrier"="hedge"](${bbox});`,
    ].join('\n  ');
  });
  return `[out:json][timeout:${String(timeoutSeconds)}];\n(\n  ${parts.join('\n  ')}\n);\nout geom;`;
}

/** What happened to the source data. */
export interface OsmImportReport {
  readonly elements: number;
  /** Features produced, by kind. */
  readonly counts: Readonly<
    Record<'roads' | 'buildings' | 'vegetation' | 'water' | 'waterways' | 'landUse', number>
  >;
  /** Elements (or parts) that could not be used, and why. */
  readonly dropped: readonly { readonly ref: string; readonly reason: string }[];
  /** Notes about approximations, e.g. holes ignored at the battlefield edge. */
  readonly warnings: readonly string[];
  readonly timestampOsmBase: string | null;
}

// --- Tag mapping (data, versioned with the importer) -------------------------

const ROAD_SKIP = new Set([
  'proposed',
  'construction',
  'abandoned',
  'razed',
  'platform',
  'corridor',
  'elevator',
  'bus_stop',
  'raceway',
  'no',
]);
const MAJOR = /^(motorway|trunk|primary|secondary)(_link)?$/;
const PATH = /^(path|footway|cycleway|bridleway|steps|pedestrian)$/;
const UNPAVED_SURFACE =
  /^(unpaved|gravel|fine_gravel|dirt|earth|ground|grass|mud|sand|compacted|pebblestone|woodchips)$/;
const ROAD_WIDTH: Record<RoadClass, number> = {
  major: 8,
  paved: 6,
  unpaved: 4,
  track: 3,
  path: 1.5,
};

function roadClassOf(t: Tags): RoadClass | null {
  const h = t['highway'];
  if (h === undefined || ROAD_SKIP.has(h) || t['area'] === 'yes') return null;
  if (MAJOR.test(h)) return 'major';
  if (PATH.test(h)) return 'path';
  if (h === 'track') return 'track';
  return t['surface'] && UNPAVED_SURFACE.test(t['surface']) ? 'unpaved' : 'paved';
}

/** Default storey height when only `building:levels` is known. */
const STOREY_M = 3;
const DEFAULT_BUILDING_M = 6;

/** Vegetation kinds with defaults for values OSM rarely records. */
const VEGETATION = {
  woodland: { kind: 'woodland', canopy: 15, seeThrough: 25 },
  scrub: { kind: 'scrub', canopy: 2.5, seeThrough: 40 },
  treeRow: { kind: 'treeLine', canopy: 10, seeThrough: 20, width: 6 },
  hedge: { kind: 'treeLine', canopy: 2, seeThrough: 3, width: 2 },
} as const;

function vegetationOf(t: Tags): keyof typeof VEGETATION | null {
  if (t['natural'] === 'wood' || t['landuse'] === 'forest') return 'woodland';
  if (t['natural'] === 'scrub' || t['natural'] === 'heath') return 'scrub';
  return null;
}

function waterOf(t: Tags): WaterArea['kind'] | null {
  if (t['natural'] === 'wetland') return 'wetland';
  if (
    t['natural'] === 'water' ||
    t['water'] !== undefined ||
    t['landuse'] === 'reservoir' ||
    t['landuse'] === 'basin' ||
    t['waterway'] === 'riverbank'
  ) {
    return 'water';
  }
  return null;
}

const WATERWAY_WIDTH: Record<WaterwayKind, number> = {
  river: 12,
  canal: 8,
  stream: 2,
  drain: 1.5,
  ditch: 1,
};
function waterwayOf(t: Tags): WaterwayKind | null {
  const w = t['waterway'];
  return w === 'river' || w === 'stream' || w === 'canal' || w === 'drain' || w === 'ditch'
    ? w
    : null;
}

const LAND_USE: Record<string, LandUseKind> = {
  farmland: 'farmland',
  farmyard: 'farmland',
  meadow: 'meadow',
  grass: 'meadow',
  village_green: 'meadow',
  orchard: 'orchard',
  vineyard: 'orchard',
  plant_nursery: 'orchard',
  residential: 'residential',
  commercial: 'commercial',
  retail: 'commercial',
  industrial: 'industrial',
  railway: 'industrial',
  quarry: 'industrial',
  military: 'military',
  cemetery: 'cemetery',
  recreation_ground: 'recreation',
  allotments: 'recreation',
  religious: 'other',
  brownfield: 'other',
  greenfield: 'other',
  construction: 'other',
};
function landUseOf(t: Tags): LandUseKind | null {
  if (t['natural'] === 'grassland') return 'meadow';
  const l = t['landuse'];
  if (l === undefined || l === 'forest' || l === 'reservoir' || l === 'basin') return null;
  return LAND_USE[l] ?? null;
}

/** A metric value from a tag such as "12", "12 m" or "12.5m"; `null` for anything else (e.g. feet). */
export function parseMetres(value: string | undefined): number | null {
  if (value === undefined) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(m)?\s*$/.exec(value.replace(',', '.'));
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

// --- Geometry ------------------------------------------------------------------

function project(
  frame: BattlefieldFrame,
  geometry: readonly (LatLon | null)[] | undefined,
): Vec2[] | null {
  if (!geometry || geometry.some((p) => p === null)) return null;
  return (geometry as LatLon[]).map((p) => toLocal(frame, p));
}

const closed = (g: readonly (LatLon | null)[] | undefined): boolean => {
  const a = g?.[0];
  const b = g?.[g.length - 1];
  return !!g && g.length >= 4 && !!a && !!b && a.lat === b.lat && a.lon === b.lon;
};

/**
 * Joins open member ways into closed rings by matching end points (as OSM
 * multipolygons require). Returns the rings and how many ways were left over.
 */
export function assembleRings(ways: readonly (readonly LatLon[])[]): {
  rings: LatLon[][];
  unclosed: number;
} {
  const same = (a: LatLon | undefined, b: LatLon | undefined) =>
    !!a && !!b && a.lat === b.lat && a.lon === b.lon;
  const pending = ways.filter((w) => w.length >= 2).map((w) => [...w]);
  const rings: LatLon[][] = [];
  let unclosed = 0;
  while (pending.length > 0) {
    const ring = pending.shift() ?? [];
    let grew = true;
    while (!same(ring[0], ring[ring.length - 1]) && grew) {
      grew = false;
      const end = ring[ring.length - 1];
      for (let i = 0; i < pending.length; i += 1) {
        const w = pending[i] ?? [];
        if (same(w[0], end)) ring.push(...w.slice(1));
        else if (same(w[w.length - 1], end)) ring.push(...[...w].reverse().slice(1));
        else continue;
        pending.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (same(ring[0], ring[ring.length - 1]) && ring.length >= 4) rings.push(ring);
    else unclosed += 1;
  }
  return { rings, unclosed };
}

/** A polygon with holes, in local metres. */
interface Shape {
  readonly outer: Vec2[];
  readonly holes: Vec2[][];
}

// --- The importer ------------------------------------------------------------------

/** Normalizes an Overpass response into terrain features for a battlefield. */
export function featuresFromOsm(
  response: OverpassResponse,
  frame: BattlefieldFrame,
): { features: Required<EnvironmentFeatures>; report: OsmImportReport } {
  const rect: Rect = {
    minX: -frame.widthM / 2,
    minY: -frame.heightM / 2,
    maxX: frame.widthM / 2,
    maxY: frame.heightM / 2,
  };
  const roads: Road[] = [];
  const buildings: Building[] = [];
  const vegetation: VegetationArea[] = [];
  const water: WaterArea[] = [];
  const waterways: Waterway[] = [];
  const landUse: LandUseArea[] = [];
  const dropped: { ref: string; reason: string }[] = [];
  const warnings: string[] = [];
  let holesAtEdge = 0;
  let courtyards = 0;

  const elements = [...response.elements].sort(
    (a, b) => a.type.localeCompare(b.type) || a.id - b.id,
  );

  /** Clips a polygon with holes; holes crossing the edge are dropped (counted). */
  const clipShape = (shape: Shape, ref: string): Shape[] => {
    const pieces = clipPolygon(shape.outer, rect)
      .map((p) => dedupe(p))
      .filter((p) => p.length >= 3);
    const simple = pieces.filter((p) => isSimplePolygon(p));
    if (simple.length < pieces.length) dropped.push({ ref, reason: 'self-intersecting outline' });
    // Slivers left by clipping at the battlefield edge are too small to matter.
    const valid = simple.filter((p) => polygonArea(p) >= 1);
    return valid.map((outer) => {
      const holes = shape.holes.filter((hole) => {
        const fits = hole.every(
          (p) => p.x > rect.minX && p.x < rect.maxX && p.y > rect.minY && p.y < rect.maxY,
        );
        const ok = fits && isSimplePolygon(hole) && hole.every((p) => pointInPolygon(p, outer));
        if (!ok && hole.some((p) => pointInPolygon(p, outer))) holesAtEdge += 1;
        return ok;
      });
      return { outer, holes };
    });
  };

  /** Feature ids: one piece keeps the element's id; several are numbered. */
  const ids = (base: string, n: number) =>
    Array.from({ length: n }, (_, i) => (n === 1 ? base : `${base}-${String(i + 1)}`));

  const addArea = (tags: Tags, shapes: Shape[], ref: string, base: string) => {
    const veg = vegetationOf(tags);
    const wet = waterOf(tags);
    const land = landUseOf(tags);
    const isBuilding = tags['building'] !== undefined && tags['building'] !== 'no';
    if (!isBuilding && !veg && !wet && !land) return false;
    const clipped = shapes.flatMap((s) => clipShape(s, ref));
    if (clipped.length === 0) return true; // outside the battlefield, or dropped above
    const source = (estimated: string[]): FeatureSource =>
      estimated.length > 0 ? { ref, estimated } : { ref };
    if (isBuilding) {
      // A height from the number of storeys assumes a storey height, so it is estimated too.
      const tagged = parseMetres(tags['height']);
      const levels = parseMetres(tags['building:levels']);
      const height =
        tagged ?? (levels !== null ? Math.max(2, levels * STOREY_M) : DEFAULT_BUILDING_M);
      ids(base, clipped.length).forEach((id, i) => {
        const s = clipped[i];
        if (!s) return;
        if (s.holes.length > 0) courtyards += 1;
        buildings.push({
          id,
          footprint: s.outer,
          heightMeters: height,
          source: source(tagged !== null ? [] : ['heightMeters']),
        });
      });
      return true;
    }
    if (veg) {
      const d = VEGETATION[veg];
      ids(base, clipped.length).forEach((id, i) => {
        const s = clipped[i];
        if (!s) return;
        vegetation.push({
          id,
          kind: d.kind,
          boundary: s.outer,
          ...(s.holes.length > 0 ? { holes: s.holes } : {}),
          canopyHeightMeters: d.canopy,
          seeThroughMeters: d.seeThrough,
          source: source(['canopyHeightMeters', 'seeThroughMeters']),
        });
      });
    } else if (wet) {
      ids(base, clipped.length).forEach((id, i) => {
        const s = clipped[i];
        if (!s) return;
        water.push({
          id,
          kind: wet,
          boundary: s.outer,
          ...(s.holes.length > 0 ? { holes: s.holes } : {}),
          source: { ref },
        });
      });
    } else if (land) {
      ids(base, clipped.length).forEach((id, i) => {
        const s = clipped[i];
        if (!s) return;
        landUse.push({
          id,
          kind: land,
          boundary: s.outer,
          ...(s.holes.length > 0 ? { holes: s.holes } : {}),
          source: { ref },
        });
      });
    }
    return true;
  };

  /** A strip of rectangles along a line (tree rows and hedges): vegetation polygons must be areas. */
  const addStrip = (
    line: Vec2[],
    ref: string,
    base: string,
    d: (typeof VEGETATION)['treeRow' | 'hedge'],
  ) => {
    let k = 0;
    for (const piece of clipPolyline(line, rect)) {
      for (let i = 0; i + 1 < piece.length; i += 1) {
        const a = piece[i];
        const b = piece[i + 1];
        if (!a || !b) continue;
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 1) continue;
        const nx = (-(b.y - a.y) / len) * (d.width / 2);
        const ny = ((b.x - a.x) / len) * (d.width / 2);
        const ring = [
          { x: a.x + nx, y: a.y + ny },
          { x: a.x - nx, y: a.y - ny },
          { x: b.x - nx, y: b.y - ny },
          { x: b.x + nx, y: b.y + ny },
        ];
        for (const outer of clipPolygon(ring, rect)) {
          if (outer.length < 3 || polygonArea(outer) < 0.5) continue;
          k += 1;
          vegetation.push({
            id: `${base}-s${String(k)}`,
            kind: d.kind,
            boundary: outer,
            canopyHeightMeters: d.canopy,
            seeThroughMeters: d.seeThrough,
            source: { ref, estimated: ['canopyHeightMeters', 'seeThroughMeters', 'width'] },
          });
        }
      }
    }
  };

  for (const el of elements) {
    const tags = el.tags ?? {};
    if (el.type === 'way') {
      const ref = `osm:way/${String(el.id)}`;
      const base = `osm-w${String(el.id)}`;
      const isArea = closed(el.geometry) && tags['area'] !== 'no';
      // Lines first: roads, waterways, tree rows, hedges.
      const roadClass = roadClassOf(tags);
      const waterway = waterwayOf(tags);
      const strip =
        tags['natural'] === 'tree_row'
          ? VEGETATION.treeRow
          : tags['barrier'] === 'hedge'
            ? VEGETATION.hedge
            : null;
      if (roadClass || waterway || strip) {
        const line = project(frame, el.geometry);
        if (!line) {
          dropped.push({ ref, reason: 'missing geometry' });
          continue;
        }
        if (strip) {
          addStrip(line, ref, base, strip);
          continue;
        }
        const pieces = clipPolyline(line, rect).filter(
          (p) =>
            p.reduce(
              (s, q, i) =>
                i === 0
                  ? 0
                  : s + Math.hypot(q.x - (p[i - 1]?.x ?? q.x), q.y - (p[i - 1]?.y ?? q.y)),
              0,
            ) >= 0.5,
        );
        const tagged = parseMetres(tags['width']);
        ids(base, pieces.length).forEach((id, i) => {
          const centerline = pieces[i];
          if (!centerline) return;
          if (roadClass) {
            roads.push({
              id,
              roadClass,
              centerline,
              widthMeters: tagged ?? ROAD_WIDTH[roadClass],
              source: tagged !== null ? { ref } : { ref, estimated: ['widthMeters'] },
            });
          } else if (waterway) {
            waterways.push({
              id,
              kind: waterway,
              centerline,
              widthMeters: tagged ?? WATERWAY_WIDTH[waterway],
              source: tagged !== null ? { ref } : { ref, estimated: ['widthMeters'] },
            });
          }
        });
        continue;
      }
      if (!isArea) {
        if (
          vegetationOf(tags) ||
          waterOf(tags) ||
          landUseOf(tags) ||
          tags['building'] !== undefined
        ) {
          dropped.push({ ref, reason: 'area outline is not closed' });
        }
        continue;
      }
      const outer = project(frame, el.geometry);
      if (!outer) {
        dropped.push({ ref, reason: 'missing geometry' });
        continue;
      }
      addArea(tags, [{ outer: dedupe(outer), holes: [] }], ref, base);
    } else if (el.type === 'relation') {
      const ref = `osm:relation/${String(el.id)}`;
      if (tags['type'] !== 'multipolygon') continue;
      const members = el.members ?? [];
      const ringsOf = (role: string) =>
        assembleRings(
          members
            .filter(
              (m) =>
                m.type === 'way' && (role === 'outer' ? m.role !== 'inner' : m.role === 'inner'),
            )
            .flatMap((m) =>
              m.geometry && !m.geometry.some((p) => p === null) ? [m.geometry as LatLon[]] : [],
            ),
        );
      const outers = ringsOf('outer');
      const inners = ringsOf('inner');
      if (outers.unclosed + inners.unclosed > 0) {
        dropped.push({
          ref,
          reason: `${String(outers.unclosed + inners.unclosed)} ring(s) could not be closed`,
        });
      }
      const holes = inners.rings.map((r) => dedupe(r.map((p) => toLocal(frame, p))));
      const shapes = outers.rings.map((r) => {
        const outer = dedupe(r.map((p) => toLocal(frame, p)));
        return {
          outer,
          holes: holes.filter((h) => h[0] !== undefined && pointInPolygon(h[0], outer)),
        };
      });
      if (shapes.length > 0) addArea(tags, shapes, ref, `osm-r${String(el.id)}`);
    }
  }

  if (holesAtEdge > 0) {
    warnings.push(
      `${String(holesAtEdge)} hole(s) (clearings, islands, courtyards) crossing the battlefield edge or otherwise invalid were filled in`,
    );
  }
  if (courtyards > 0) {
    warnings.push(`${String(courtyards)} building courtyard(s) are drawn as part of the building`);
  }
  return {
    features: { roads, buildings, vegetation, water, waterways, landUse },
    report: {
      elements: response.elements.length,
      counts: {
        roads: roads.length,
        buildings: buildings.length,
        vegetation: vegetation.length,
        water: water.length,
        waterways: waterways.length,
        landUse: landUse.length,
      },
      dropped,
      warnings,
      timestampOsmBase: response.osm3s?.timestamp_osm_base ?? null,
    },
  };
}
