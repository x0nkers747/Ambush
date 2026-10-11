import { isSimplePolygon, polygonArea, type Building, type FeatureSource } from '#sim';
import { buildingAppearance } from './building-tags';
import { clipPolygon, dedupe, type Rect } from './clip';
import { geographicBounds, toLocal, type BattlefieldFrame } from './frame';
import { decodeMvt, ringArea, type MvtValue } from './mvt';
import { DEFAULT_BUILDING_M, STOREY_M } from './osm';
import { normalizeLon, type LatLon } from './utm';

// Buildings from Overture Maps (docs/adr/0023): the `building` layer of
// Overture's vector tiles, which combines OpenStreetMap with machine-learned
// and community footprints. Pure: decompressed tiles in, terrain buildings
// out.
//
// Vector tiles cut every building at tile edges. Each piece is clipped
// exactly to its own tile, in the tiles' global integer coordinates (shared
// by neighbouring tiles at one zoom, so seams match exactly), and the pieces
// of each building are joined again by dissolving the seams they share. Only
// then is the building projected and clipped to the battlefield, like an
// OpenStreetMap building.

/** The zoom the buildings are read at: Overture's most detailed (about 0.4 m per tile unit). */
export const OVERTURE_BUILDINGS_ZOOM = 14;
/** Margin around the battlefield for the tiles fetched, as for the OSM query. */
export const OVERTURE_MARGIN_M = 100;

/** A tile to read: its address, and its column before wrapping round ±180°. */
export interface OvertureTileId {
  readonly z: number;
  readonly x: number;
  readonly y: number;
  /** `x` unwrapped, so a battlefield across ±180° keeps continuous coordinates. */
  readonly column: number;
}

/** A downloaded tile: its decompressed MVT bytes, or `null` when the archive has none (no buildings). */
export interface OvertureTile extends OvertureTileId {
  readonly data: Uint8Array | null;
}

export interface OvertureImportReport {
  /** Buildings produced (pieces of a building cut by the battlefield edge count separately). */
  readonly buildings: number;
  /** Buildings by the dataset their outline came from (e.g. "OpenStreetMap"). */
  readonly bySource: Readonly<Record<string, number>>;
  /** Every dataset the buildings' outlines or properties came from, for attribution. */
  readonly datasets: readonly string[];
  /** Buildings cut by tile edges and joined again. */
  readonly merged: number;
  /** How each building's height was found. */
  readonly heights: { readonly data: number; readonly floors: number; readonly defaulted: number };
  readonly dropped: readonly { readonly ref: string; readonly reason: string }[];
  readonly warnings: readonly string[];
}

/** The building tiles covering a battlefield and its margin, north-west first. */
export function overtureTilesFor(
  frame: BattlefieldFrame,
  zoom = OVERTURE_BUILDINGS_ZOOM,
  marginM = OVERTURE_MARGIN_M,
): OvertureTileId[] {
  const n = 2 ** zoom;
  const tiles: OvertureTileId[] = [];
  for (const box of geographicBounds(frame, marginM)) {
    // Columns from the centre's side of ±180°, so they stay contiguous.
    const west = box.west < frame.centre.lon - 180 ? box.west + 360 : box.west;
    const east = box.east < west ? box.east + 360 : box.east;
    const col = (lon: number) => Math.floor(((lon + 180) / 360) * n);
    const row = (lat: number) => {
      const phi = (Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180;
      const y = Math.floor(((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n);
      return Math.min(n - 1, Math.max(0, y));
    };
    for (let y = row(box.north); y <= row(box.south); y += 1) {
      for (let column = col(west); column <= col(east); column += 1) {
        const x = ((column % n) + n) % n;
        if (!tiles.some((t) => t.x === x && t.y === y)) tiles.push({ z: zoom, x, y, column });
      }
    }
  }
  return tiles;
}

type Point = readonly [number, number];

/** Sutherland–Hodgman against one axis-aligned half-plane; points on the line are kept exactly. */
function clipHalf(ring: readonly Point[], axis: 0 | 1, k: number, below: boolean): Point[] {
  const keep = (p: Point) => (below ? p[axis] <= k : p[axis] >= k);
  const out: Point[] = [];
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (!a || !b) continue;
    if (keep(a)) out.push(a);
    if (keep(a) !== keep(b)) {
      const t = (k - a[axis]) / (b[axis] - a[axis]);
      const other = axis === 0 ? 1 : 0;
      const v = a[other] + t * (b[other] - a[other]);
      out.push(axis === 0 ? [k, v] : [v, k]);
    }
  }
  return out;
}

/** A ring clipped to an axis-aligned box. */
function clipToBox(
  ring: readonly Point[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Point[] {
  let r: Point[] = [...ring];
  for (const [axis, k, below] of [
    [0, x0, false],
    [0, x1, true],
    [1, y0, false],
    [1, y1, true],
  ] as const) {
    if (r.length === 0) break;
    r = clipHalf(r, axis, k, below);
  }
  return r;
}

/**
 * Joins pieces of one building that touch along tile seams (all rings wound
 * the same way, in global tile coordinates). Seam edges of every piece are
 * split at every piece's seam points, so shared stretches become identical
 * edges in opposite directions; those cancel, and what is left is walked
 * back into rings. Points left in the middle of straight edges are removed.
 */
export function dissolveSeams(
  pieces: readonly (readonly Point[])[],
  seamsX: ReadonlySet<number>,
  seamsY: ReadonlySet<number>,
): Point[][] {
  const onX = new Map<number, number[]>();
  const onY = new Map<number, number[]>();
  for (const ring of pieces) {
    for (const [x, y] of ring) {
      if (seamsX.has(x)) onX.set(x, [...(onX.get(x) ?? []), y]);
      if (seamsY.has(y)) onY.set(y, [...(onY.get(y) ?? []), x]);
    }
  }
  const key = (p: Point) => `${String(p[0])},${String(p[1])}`;
  const edges = new Map<string, [Point, Point]>();
  const add = (a: Point, b: Point) => {
    if (a[0] === b[0] && a[1] === b[1]) return;
    const back = `${key(b)}>${key(a)}`;
    if (edges.has(back)) edges.delete(back);
    else edges.set(`${key(a)}>${key(b)}`, [a, b]);
  };
  for (const ring of pieces) {
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      if (!a || !b) continue;
      let cuts: Point[] = [];
      if (a[0] === b[0] && seamsX.has(a[0])) {
        cuts = (onX.get(a[0]) ?? [])
          .filter((y) => (y - a[1]) * (y - b[1]) < 0)
          .map((y): Point => [a[0], y]);
      } else if (a[1] === b[1] && seamsY.has(a[1])) {
        cuts = (onY.get(a[1]) ?? [])
          .filter((x) => (x - a[0]) * (x - b[0]) < 0)
          .map((x): Point => [x, a[1]]);
      }
      cuts.sort(
        (p, q) =>
          Math.abs(p[0] - a[0]) +
          Math.abs(p[1] - a[1]) -
          Math.abs(q[0] - a[0]) -
          Math.abs(q[1] - a[1]),
      );
      let previous = a;
      for (const c of cuts) {
        if (c[0] === previous[0] && c[1] === previous[1]) continue;
        add(previous, c);
        previous = c;
      }
      add(previous, b);
    }
  }
  // Walk the remaining edges into rings, in a deterministic order.
  const from = new Map<string, Point[]>();
  for (const [a, b] of edges.values()) from.set(key(a), [...(from.get(key(a)) ?? []), b]);
  const rings: Point[][] = [];
  for (const [start, list] of [...from.entries()]) {
    while (list.length > 0) {
      const ring: Point[] = [];
      let k = start;
      for (let guard = 0; guard <= edges.size; guard += 1) {
        const next = from.get(k)?.shift();
        if (!next) break;
        const [x, y] = k.split(',').map(Number);
        ring.push([x ?? 0, y ?? 0]);
        k = key(next);
        if (k === start) break;
      }
      if (ring.length >= 3) rings.push(ring);
    }
  }
  return rings.map((ring) =>
    ring.filter((p, i) => {
      const a = ring[(i - 1 + ring.length) % ring.length];
      const b = ring[(i + 1) % ring.length];
      return !a || !b || (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) !== 0;
    }),
  );
}

/** The datasets named in a feature's `sources` property (Overture stores it as JSON text). */
function datasetsOf(sources: MvtValue | undefined): string[] {
  if (typeof sources !== 'string') return [];
  try {
    const list = JSON.parse(sources) as unknown;
    if (!Array.isArray(list)) return [];
    return list.flatMap((s: unknown) => {
      const d = (s as { dataset?: unknown } | null)?.dataset;
      return typeof d === 'string' && d !== '' ? [d] : [];
    });
  } catch {
    return [];
  }
}

const positive = (v: MvtValue | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;

interface Gathered {
  readonly id: string;
  readonly properties: Readonly<Record<string, MvtValue>>;
  readonly pieces: Point[][];
}

/**
 * Overture buildings in a battlefield's local metres, clipped to it. Holes
 * (courtyards) are not represented, as for OpenStreetMap buildings;
 * underground buildings are left out. A building's height is Overture's
 * `height` when given, else its number of floors times a storey height, else
 * a default (both marked estimated). Deterministic: buildings are ordered by
 * Overture id.
 */
export function buildingsFromOverture(
  tiles: readonly OvertureTile[],
  frame: BattlefieldFrame,
): { buildings: Building[]; report: OvertureImportReport } {
  const rect: Rect = {
    minX: -frame.widthM / 2,
    minY: -frame.heightM / 2,
    maxX: frame.widthM / 2,
    maxY: frame.heightM / 2,
  };
  const dropped: { ref: string; reason: string }[] = [];
  const seamsX = new Set<number>();
  const seamsY = new Set<number>();
  const gathered = new Map<string, Gathered>();
  let zoom = OVERTURE_BUILDINGS_ZOOM;
  let extent = 4096;
  let underground = 0;
  let courtyards = 0;

  const ordered = [...tiles].sort((a, b) => a.y - b.y || a.column - b.column);
  for (const tile of ordered) {
    if (!tile.data) continue;
    let layers;
    try {
      layers = decodeMvt(tile.data);
    } catch (error) {
      dropped.push({
        ref: `overture:tile/${String(tile.z)}/${String(tile.x)}/${String(tile.y)}`,
        reason: `the tile could not be read (${error instanceof Error ? error.message : String(error)})`,
      });
      continue;
    }
    const layer = layers.find((l) => l.name === 'building');
    if (!layer) continue;
    zoom = tile.z;
    extent = layer.extent;
    const x0 = tile.column * extent;
    const y0 = tile.y * extent;
    seamsX.add(x0).add(x0 + extent);
    seamsY.add(y0).add(y0 + extent);
    layer.features.forEach((f, index) => {
      if (f.type !== 3) return;
      if (f.properties['is_underground'] === true) {
        underground += 1;
        return;
      }
      const idValue = f.properties['id'];
      const id =
        typeof idValue === 'string' && idValue !== ''
          ? idValue
          : `${String(tile.z)}-${String(tile.x)}-${String(tile.y)}-${String(f.id ?? index)}`;
      const entry = gathered.get(id) ?? { id, properties: f.properties, pieces: [] };
      for (const ring of f.geometry) {
        // Holes (negative area) are left out: courtyards are part of the building.
        if (ringArea(ring) < 0) {
          courtyards += 1;
          continue;
        }
        const open =
          ring.length > 1 &&
          ring[0]?.[0] === ring[ring.length - 1]?.[0] &&
          ring[0]?.[1] === ring[ring.length - 1]?.[1]
            ? ring.slice(0, -1)
            : ring;
        const global = open.map(([x, y]): Point => [x0 + x, y0 + y]);
        const clipped = clipToBox(global, x0, y0, x0 + extent, y0 + extent);
        if (clipped.length >= 3 && ringArea(clipped) > 0) entry.pieces.push(clipped);
      }
      gathered.set(id, entry);
    });
  }

  const world = extent * 2 ** zoom;
  const toLatLon = ([gx, gy]: Point): LatLon => ({
    lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * gy) / world))) * 180) / Math.PI,
    lon: normalizeLon((gx / world) * 360 - 180),
  });

  const buildings: Building[] = [];
  const bySource: Record<string, number> = {};
  const datasets = new Set<string>();
  const heights = { data: 0, floors: 0, defaulted: 0 };
  let merged = 0;
  const ids = [...gathered.keys()].sort();
  for (const id of ids) {
    const g = gathered.get(id);
    if (!g || g.pieces.length === 0) continue;
    const ref = `overture:building/${id}`;
    let rings: Point[][] = g.pieces;
    if (g.pieces.length > 1) {
      rings = dissolveSeams(g.pieces, seamsX, seamsY);
      merged += 1;
      // Any hole left by joining (a courtyard spanning a seam) is part of the building.
      const holes = rings.filter((r) => ringArea(r) < 0);
      if (holes.length > 0) courtyards += holes.length;
      rings = rings.filter((r) => ringArea(r) > 0);
    }
    const outlines = rings.flatMap((ring) => {
      const local = dedupe(ring.map((p) => toLocal(frame, toLatLon(p))));
      if (local.length < 3) return [];
      const pieces = clipPolygon(local, rect)
        .map((p) => dedupe(p))
        .filter((p) => p.length >= 3);
      const simple = pieces.filter((p) => isSimplePolygon(p));
      if (simple.length < pieces.length) dropped.push({ ref, reason: 'self-intersecting outline' });
      // Slivers left by clipping at the battlefield edge are too small to matter.
      return simple.filter((p) => polygonArea(p) >= 1);
    });
    if (outlines.length === 0) continue;

    const p = g.properties;
    const tagged = positive(p['height']);
    const floors = positive(p['num_floors']);
    const height =
      tagged ?? (floors !== null ? Math.max(2, floors * STOREY_M) : DEFAULT_BUILDING_M);
    if (tagged !== null) heights.data += 1;
    else if (floors !== null) heights.floors += 1;
    else heights.defaulted += 1;
    const source: FeatureSource = tagged !== null ? { ref } : { ref, estimated: ['heightMeters'] };
    const geometrySource = p['@geometry_source'];
    const outlineSource = typeof geometrySource === 'string' ? geometrySource : 'unknown';
    bySource[outlineSource] = (bySource[outlineSource] ?? 0) + 1;
    for (const d of datasetsOf(p['sources'])) datasets.add(d);
    if (typeof geometrySource === 'string') datasets.add(geometrySource);
    const base = `ovt-${id}`;
    // Display only (docs/adr/0035): Overture's architecture fields, as given.
    const appearance = buildingAppearance({
      kind: p['class'] ?? p['subtype'],
      levels: p['num_floors'],
      levelsUnderground: p['num_floors_underground'],
      height: p['height'],
      minHeight: p['min_height'],
      roofShape: p['roof_shape'],
      roofHeight: p['roof_height'],
      roofOrientation: p['roof_orientation'],
      // Overture gives the ridge's bearing; OSM (and `roofDirectionDegrees`) the face's.
      roofDirection: typeof p['roof_direction'] === 'number' ? p['roof_direction'] + 90 : undefined,
      roofMaterial: p['roof_material'],
      wallMaterial: p['facade_material'],
      roofColour: p['roof_color'],
      wallColour: p['facade_color'],
    });
    outlines.forEach((footprint, i) => {
      buildings.push({
        id: outlines.length === 1 ? base : `${base}-${String(i + 1)}`,
        footprint,
        heightMeters: height,
        source,
        ...(appearance ? { appearance } : {}),
      });
    });
  }

  const warnings: string[] = [];
  if (courtyards > 0)
    warnings.push(`${String(courtyards)} building courtyard(s) are drawn as part of the building`);
  if (underground > 0)
    warnings.push(`${String(underground)} underground building(s) were left out`);
  return {
    buildings,
    report: {
      buildings: buildings.length,
      bySource,
      datasets: [...datasets].sort(),
      merged,
      heights,
      dropped,
      warnings,
    },
  };
}

export const OVERTURE_ATTRIBUTION = 'Buildings: Overture Maps Foundation, overturemaps.org (ODbL)';

/**
 * Credits for the datasets Overture's buildings came from, as Overture's
 * attribution guidance asks (OpenStreetMap is credited with the map data).
 */
export function overtureAttribution(datasets: readonly string[]): string[] {
  const known: Readonly<Record<string, string>> = {
    'Microsoft ML Buildings': 'Global ML Building Footprints, licensed by Microsoft under the ODbL',
    'Esri Community Maps': 'Esri Community Maps contributors (CC BY 4.0)',
    'Google Open Buildings': 'Google Open Buildings (CC BY 4.0)',
  };
  return [
    OVERTURE_ATTRIBUTION,
    ...datasets
      .filter((d) => d !== 'OpenStreetMap')
      .map((d) => known[d] ?? `${d} (via Overture Maps)`),
  ];
}
