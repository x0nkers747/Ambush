import {
  boundsOf,
  polygonCentroid,
  type LandUseKind,
  type RoadClass,
  type TerrainDataset,
  type VegetationKind,
  type Vec2,
  type WaterArea,
  type WaterwayKind,
} from '#sim';
import { joinSegments, simplifyLine } from './contour-lines';
import { roadStrokes } from './roads';
import {
  screenToWorld,
  terrainBounds,
  worldToScreen,
  worldToScreenTransform,
  type Bounds,
} from './camera';
import type { MapScene } from './scene';
import {
  contourIntervals,
  contourLines,
  placeSpotHeights,
  SPOT_LABEL_OFFSET_PX,
  spotHeightLabel,
  spotHeights,
  terrainRaster,
  type SpotHeight,
} from './terrain-layer';

// Canvas 2D rendering of the tactical map. Map coordinates are drawn through
// the camera transform; symbols and labels are drawn in screen pixels so they
// keep their size at every zoom.

export const COLORS = {
  background: '#1b1f23',
  contour: 'rgba(92, 66, 40, 0.38)',
  indexContour: 'rgba(92, 66, 40, 0.72)',
  grid: 'rgba(30, 35, 40, 0.18)',
  gridLabel: 'rgba(20, 24, 28, 0.75)',
  woodlandFill: 'rgba(70, 125, 60, 0.42)',
  woodlandEdge: 'rgba(36, 82, 32, 0.85)',
  treeLineFill: 'rgba(52, 106, 46, 0.6)',
  scrubFill: 'rgba(122, 152, 82, 0.3)',
  scrubEdge: 'rgba(80, 112, 50, 0.75)',
  roadCasing: '#6f5b3b',
  roadFill: '#ecdfbf',
  majorRoadCasing: '#6e2116',
  majorRoadFill: '#e2683f',
  track: 'rgba(110, 86, 52, 0.9)',
  path: 'rgba(40, 32, 24, 0.85)',
  waterFill: 'rgba(115, 168, 222, 0.9)',
  waterEdge: '#2b67a3',
  wetlandFill: 'rgba(115, 168, 222, 0.28)',
  wetlandEdge: 'rgba(43, 103, 163, 0.75)',
  waterway: '#2b67a3',
  building: '#4b4b4b',
  buildingEdge: '#191919',
  featureLabel: 'rgba(20, 24, 28, 0.85)',
  spotHeight: '#3b2a18',
  labelHalo: 'rgba(255, 255, 255, 0.8)',
} as const;

/** Building and vegetation ids appear from this zoom. */
const FEATURE_LABEL_MAX_METERS_PER_PIXEL = 0.6;

/** Land-use tints: light, so terrain shading and contours read through them. */
const LAND_USE_FILL: Readonly<Record<LandUseKind, string>> = {
  farmland: 'rgba(236, 222, 150, 0.32)',
  meadow: 'rgba(196, 226, 150, 0.32)',
  orchard: 'rgba(170, 210, 130, 0.38)',
  residential: 'rgba(214, 196, 188, 0.42)',
  commercial: 'rgba(214, 190, 206, 0.42)',
  industrial: 'rgba(200, 188, 210, 0.42)',
  military: 'rgba(214, 150, 140, 0.18)',
  cemetery: 'rgba(170, 196, 170, 0.4)',
  recreation: 'rgba(186, 228, 170, 0.36)',
  paved: 'rgba(196, 192, 186, 0.45)',
  other: 'rgba(210, 204, 190, 0.25)',
  beach: 'rgba(240, 226, 170, 0.6)',
  shingle: 'rgba(210, 204, 190, 0.55)',
  bareRock: 'rgba(190, 186, 178, 0.5)',
  mud: 'rgba(190, 172, 140, 0.45)',
};

/** Contour lines in one square of the map, so that only the squares in view are drawn. */
export interface ContourTile {
  /** Bounds of the segments in the tile, in map metres. */
  readonly bounds: Bounds;
  readonly minor: Path2D | null;
  readonly index: Path2D | null;
  /** Line segments in `minor` and in `index`. */
  readonly minorSegments: number;
  readonly indexSegments: number;
}

/** Side of a contour tile in map metres. */
const CONTOUR_TILE_M = 250;

/**
 * The contours' levels of detail: lines simplified to within these many
 * metres (0: as traced). Each view draws the coarsest whose error is under
 * `CONTOUR_LOD_PIXELS` of a device pixel, so the whole map draws a fraction
 * of the points, and close in nothing is lost.
 */
export const CONTOUR_LOD_TOLERANCES_M = [0, 1, 2.5, 6] as const;
const CONTOUR_LOD_PIXELS = 0.6;

/** The contours' level of detail for a view: the coarsest within `CONTOUR_LOD_PIXELS` of a device pixel. */
export function contourLod(metersPerDevicePixel: number): number {
  let lod = 0;
  CONTOUR_LOD_TOLERANCES_M.forEach((t, k) => {
    if (t <= CONTOUR_LOD_PIXELS * metersPerDevicePixel) lod = k;
  });
  return lod;
}

/**
 * Most line segments stroked as one path. Chrome silently drops a stroke of
 * about a million segments, and every drawing operation after it in the same
 * batch, which is what a whole large battlefield's contours come to.
 */
export const MAX_CONTOUR_SEGMENTS_PER_STROKE = 100_000;

/**
 * Canvas objects for one terrain, built once. Every feature carries its
 * bounds (map metres), so that drawing a part of the map skips what lies
 * outside it.
 */
export interface TerrainLayer {
  readonly terrain: TerrainDataset;
  readonly bounds: Bounds;
  readonly image: HTMLCanvasElement;
  /**
   * The contours at each level of detail (`CONTOUR_LOD_TOLERANCES_M`), finest
   * first: lines simplified to within `tolerance` metres, in tiles.
   */
  readonly contours: readonly {
    readonly tolerance: number;
    readonly tiles: readonly ContourTile[];
  }[];
  /** Summits, most prominent first (docs/adr/0024). */
  readonly spotHeights: readonly SpotHeight[];
  /**
   * Environment features as map-coordinate paths. Ids are drawn only for
   * hand-authored features (`label`), not for imported ones, whose ids are
   * source references.
   */
  readonly vegetation: readonly {
    id: string;
    kind: VegetationKind;
    path: Path2D;
    bounds: Bounds;
    anchor: Vec2;
    label: boolean;
  }[];
  readonly roads: readonly {
    id: string;
    roadClass: RoadClass;
    widthMeters: number;
    path: Path2D;
    bounds: Bounds;
  }[];
  readonly buildings: readonly {
    id: string;
    path: Path2D;
    bounds: Bounds;
    anchor: Vec2;
    label: boolean;
  }[];
  readonly landUse: readonly { kind: LandUseKind; path: Path2D; bounds: Bounds }[];
  readonly water: readonly { kind: WaterArea['kind']; path: Path2D; bounds: Bounds }[];
  readonly waterways: readonly {
    kind: WaterwayKind;
    widthMeters: number;
    path: Path2D;
    bounds: Bounds;
  }[];
}

/** A polygon (and its holes, as further subpaths) for filling with the even-odd rule. */
function polygonPath(points: readonly Vec2[], holes: readonly (readonly Vec2[])[] = []): Path2D {
  const path = new Path2D();
  for (const ring of [points, ...holes]) {
    ring.forEach((p, i) => {
      if (i === 0) path.moveTo(p.x, p.y);
      else path.lineTo(p.x, p.y);
    });
    path.closePath();
  }
  return path;
}

function linePath(points: readonly Vec2[]): Path2D {
  const path = new Path2D();
  points.forEach((p, i) => {
    if (i === 0) path.moveTo(p.x, p.y);
    else path.lineTo(p.x, p.y);
  });
  return path;
}

export function createTerrainLayer(terrain: TerrainDataset): TerrainLayer {
  const raster = terrainRaster(terrain);
  const image = document.createElement('canvas');
  image.width = raster.width;
  image.height = raster.height;
  const ctx = image.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is not available');
  const pixels = ctx.createImageData(raster.width, raster.height);
  pixels.data.set(raster.data);
  ctx.putImageData(pixels, 0, 0);

  // Each level's segments joined into lines, then each line simplified for
  // each level of detail and cut into tiles where it crosses into another.
  const intervals = contourIntervals(terrain);
  const bounds = terrainBounds(terrain);
  const tileColumns = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / CONTOUR_TILE_M));
  const tileRows = Math.max(1, Math.ceil((bounds.maxY - bounds.minY) / CONTOUR_TILE_M));
  const tileOf = (x: number, y: number) =>
    Math.min(tileRows - 1, Math.max(0, Math.floor((y - bounds.minY) / CONTOUR_TILE_M))) *
      tileColumns +
    Math.min(tileColumns - 1, Math.max(0, Math.floor((x - bounds.minX) / CONTOUR_TILE_M)));
  interface TileBuild {
    minor: Path2D | null;
    index: Path2D | null;
    minorSegments: number;
    indexSegments: number;
    box: [number, number, number, number];
  }
  const lods = CONTOUR_LOD_TOLERANCES_M.map(() => new Map<number, TileBuild>());
  for (const { level, segments } of contourLines(terrain, intervals.minor)) {
    const isIndex = Math.round(level / intervals.minor) % (intervals.index / intervals.minor) === 0;
    for (const line of joinSegments(segments)) {
      CONTOUR_LOD_TOLERANCES_M.forEach((tolerance, lod) => {
        const points = simplifyLine(line, tolerance);
        const tiles = lods[lod];
        if (!tiles) return;
        let tile: TileBuild | null = null;
        let tileKey = -1;
        let path: Path2D | null = null;
        for (let k = 0; k + 1 < points.length; k += 2) {
          const x = points[k] ?? 0;
          const y = points[k + 1] ?? 0;
          const key = tileOf(x, y);
          if (!tile || !path) {
            tileKey = key;
            tile = tiles.get(key) ?? null;
            if (!tile) {
              tile = {
                minor: null,
                index: null,
                minorSegments: 0,
                indexSegments: 0,
                box: [x, y, x, y],
              };
              tiles.set(key, tile);
            }
            path = isIndex ? (tile.index ??= new Path2D()) : (tile.minor ??= new Path2D());
            path.moveTo(x, y);
          } else {
            path.lineTo(x, y);
            if (isIndex) tile.indexSegments += 1;
            else tile.minorSegments += 1;
          }
          const box = tile.box;
          box[0] = Math.min(box[0], x);
          box[1] = Math.min(box[1], y);
          box[2] = Math.max(box[2], x);
          box[3] = Math.max(box[3], y);
          // Into another tile: the line goes on there, from this point.
          if (key !== tileKey) {
            tileKey = key;
            tile = tiles.get(key) ?? null;
            if (!tile) {
              tile = {
                minor: null,
                index: null,
                minorSegments: 0,
                indexSegments: 0,
                box: [x, y, x, y],
              };
              tiles.set(key, tile);
            }
            path = isIndex ? (tile.index ??= new Path2D()) : (tile.minor ??= new Path2D());
            path.moveTo(x, y);
          }
        }
      });
    }
  }
  const contours = lods.map((tiles, lod) => ({
    tolerance: CONTOUR_LOD_TOLERANCES_M[lod] ?? 0,
    tiles: [...tiles.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, { minor, index, minorSegments, indexSegments, box }]) => ({
        minor,
        index,
        minorSegments,
        indexSegments,
        bounds: { minX: box[0], minY: box[1], maxX: box[2], maxY: box[3] },
      })),
  }));
  const {
    roads,
    buildings,
    vegetation,
    water = [],
    waterways = [],
    landUse = [],
  } = terrain.features;
  return {
    terrain,
    bounds,
    image,
    contours,
    spotHeights: spotHeights(terrain),
    vegetation: vegetation.map((v) => ({
      id: v.id,
      kind: v.kind,
      path: polygonPath(v.boundary, v.holes),
      bounds: boundsOf(v.boundary),
      anchor: polygonCentroid(v.boundary) ?? v.boundary[0] ?? { x: 0, y: 0 },
      label: v.source === undefined,
    })),
    roads: roads.map((r) => ({
      id: r.id,
      roadClass: r.roadClass,
      widthMeters: r.widthMeters,
      path: linePath(r.centerline),
      bounds: boundsOf(r.centerline),
    })),
    buildings: buildings.map((b) => ({
      id: b.id,
      path: polygonPath(b.footprint),
      bounds: boundsOf(b.footprint),
      anchor: polygonCentroid(b.footprint) ?? b.footprint[0] ?? { x: 0, y: 0 },
      label: b.source === undefined,
    })),
    landUse: landUse.map((l) => ({
      kind: l.kind,
      path: polygonPath(l.boundary, l.holes),
      bounds: boundsOf(l.boundary),
    })),
    water: water.map((w) => ({
      kind: w.kind,
      path: polygonPath(w.boundary, w.holes),
      bounds: boundsOf(w.boundary),
    })),
    waterways: waterways.map((w) => ({
      kind: w.kind,
      widthMeters: w.widthMeters,
      path: linePath(w.centerline),
      bounds: boundsOf(w.centerline),
    })),
  };
}

/**
 * Draws the whole map. `ctx` must already be scaled for the device pixel
 * ratio. Bottom to top: the ground (background and terrain shading), the
 * geographic features (contours and environment), then the grid, the north
 * arrow and the scale bar. The map widget caches the ground
 * and the features between frames (`geo-cache.ts`) and draws the same layers
 * in the same order.
 */
export function drawMap(ctx: CanvasRenderingContext2D, scene: MapScene, layer: TerrainLayer): void {
  const area = viewArea(scene);
  drawGround(ctx, scene, layer, area);
  drawFeatures(ctx, scene, layer, area);
  drawOverlays(ctx, scene, layer);
}

/** The map area on screen, in map metres. */
export function viewArea(scene: MapScene): Bounds {
  const { camera, viewport } = scene;
  const a = screenToWorld(camera, viewport, { x: 0, y: 0 });
  const b = screenToWorld(camera, viewport, { x: viewport.width, y: viewport.height });
  return { minX: a.x, minY: b.y, maxX: b.x, maxY: a.y };
}

/** Whether `bounds`, grown by `margin` metres, overlaps `area`. */
function overlaps(bounds: Bounds, area: Bounds, margin: number): boolean {
  return (
    bounds.minX - margin <= area.maxX &&
    bounds.maxX + margin >= area.minX &&
    bounds.minY - margin <= area.maxY &&
    bounds.maxY + margin >= area.minY
  );
}

/** Clips to the terrain's rectangle (in screen pixels, under the device pixel ratio). */
function clipToTerrain(ctx: CanvasRenderingContext2D, scene: MapScene, layer: TerrainLayer): void {
  const edges = worldToScreen(scene.camera, scene.viewport, {
    x: layer.bounds.minX,
    y: layer.bounds.maxY,
  });
  const far = worldToScreen(scene.camera, scene.viewport, {
    x: layer.bounds.maxX,
    y: layer.bounds.minY,
  });
  ctx.beginPath();
  ctx.rect(edges.x, edges.y, far.x - edges.x, far.y - edges.y);
  ctx.clip();
}

/**
 * The background and the shaded terrain image. `area` (map metres) is the
 * part of the map being drawn: the image is skipped when it lies outside.
 */
export function drawGround(
  ctx: CanvasRenderingContext2D,
  scene: MapScene,
  layer: TerrainLayer,
  area: Bounds,
): void {
  const { width, height } = scene.viewport;
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, width, height);
  const { cellSize } = layer.terrain.heightfield;
  if (!overlaps(layer.bounds, area, cellSize)) return;
  // Pixel centres sit on the samples, so the image extends half a cell past the bounds.
  const topLeft = worldToScreen(scene.camera, scene.viewport, {
    x: layer.bounds.minX - cellSize / 2,
    y: layer.bounds.maxY + cellSize / 2,
  });
  const scale = 1 / scene.camera.metersPerPixel;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  clipToTerrain(ctx, scene, layer);
  ctx.drawImage(
    layer.image,
    topLeft.x,
    topLeft.y,
    layer.image.width * cellSize * scale,
    layer.image.height * cellSize * scale,
  );
  ctx.restore();
}

/** Horizontal bands the ground is drawn in, one per step of a settled redraw (`geo-cache.ts`). */
const GROUND_BANDS = 4;

/**
 * The ground in steps: horizontal bands of the view, each clipped at whole
 * device pixels. The shaded image is resampled the same way however it is
 * clipped, so the bands together give exactly `drawGround`; drawing one band
 * costs about a quarter as much, which keeps each step of a redraw short.
 */
export const GROUND_PHASES: readonly MapPhase[] = Array.from(
  { length: GROUND_BANDS },
  (_, band) => (ctx, scene, layer, area) => {
    const { width, height } = scene.viewport;
    const dpr = ctx.getTransform().a;
    const rows = Math.round(height * dpr);
    const top = Math.round((band * rows) / GROUND_BANDS) / dpr;
    const bottom = Math.round(((band + 1) * rows) / GROUND_BANDS) / dpr;
    const a = screenToWorld(scene.camera, scene.viewport, { x: 0, y: top });
    const b = screenToWorld(scene.camera, scene.viewport, { x: width, y: bottom });
    const bandArea = {
      minX: Math.max(area.minX, a.x),
      maxX: Math.min(area.maxX, b.x),
      minY: Math.max(area.minY, b.y),
      maxY: Math.min(area.maxY, a.y),
    };
    if (bandArea.minX > bandArea.maxX || bandArea.minY > bandArea.maxY) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, width, bottom - top);
    ctx.clip();
    drawGround(ctx, scene, layer, bandArea);
    ctx.restore();
  },
);

export type MapPhase = (
  ctx: CanvasRenderingContext2D,
  scene: MapScene,
  layer: TerrainLayer,
  area: Bounds,
) => void;

/**
 * Contours and environment features within `area` (map metres): the
 * geographic map above the ground. Features outside the area (with a margin
 * for line widths) are skipped; what is drawn is drawn as before.
 */
export function drawFeatures(
  ctx: CanvasRenderingContext2D,
  scene: MapScene,
  layer: TerrainLayer,
  area: Bounds,
): void {
  for (const phase of FEATURE_PHASES) phase(ctx, scene, layer, area);
}

/**
 * The visible tiles' paths joined into as few paths as `MAX_CONTOUR_SEGMENTS_PER_STROKE`
 * allows (one, unless the view shows a great many contours), in tile order.
 */
export function contourBatches(
  tiles: readonly ContourTile[],
  weight: 'minor' | 'index',
): { readonly tiles: readonly ContourTile[]; readonly segments: number }[] {
  const batches: { tiles: ContourTile[]; segments: number }[] = [];
  let current: { tiles: ContourTile[]; segments: number } | null = null;
  for (const tile of tiles) {
    const segments = weight === 'minor' ? tile.minorSegments : tile.indexSegments;
    if (segments === 0) continue;
    if (!current || current.segments + segments > MAX_CONTOUR_SEGMENTS_PER_STROKE) {
      current = { tiles: [], segments: 0 };
      batches.push(current);
    }
    current.tiles.push(tile);
    current.segments += segments;
  }
  return batches;
}

/**
 * Contours: the visible tiles joined into one path per weight, so overlapping
 * translucent lines blend as in one stroke (in a few, on the largest views:
 * `contourBatches`), at the level of detail the view's scale needs (`contourLod`).
 */
function drawContours(
  ctx: CanvasRenderingContext2D,
  scene: MapScene,
  layer: TerrainLayer,
  area: Bounds,
): void {
  const mpp = scene.camera.metersPerPixel;
  const dpr = ctx.getTransform().a;
  const tiles = layer.contours[contourLod(mpp / Math.max(dpr, 1e-9))]?.tiles ?? [];
  const visible = tiles.filter((tile) => overlaps(tile.bounds, area, 2 * mpp));
  if (visible.length === 0) return;
  ctx.save();
  clipToTerrain(ctx, scene, layer);
  useMapTransform(ctx, scene, dpr);
  ctx.lineJoin = 'round';
  for (const [weight, style, width] of [
    ['minor', COLORS.contour, 0.8],
    ['index', COLORS.indexContour, 1.4],
  ] as const) {
    ctx.strokeStyle = style;
    ctx.lineWidth = width * mpp;
    for (const batch of contourBatches(visible, weight)) {
      const path = new Path2D();
      for (const tile of batch.tiles) {
        const tilePath = tile[weight];
        if (tilePath) path.addPath(tilePath);
      }
      ctx.stroke(path);
    }
  }
  ctx.restore();
}

/**
 * The geographic features in drawing order, in steps that can be drawn one at
 * a time (each draws everything of its kind, so drawing them in turn gives
 * exactly `drawFeatures`): contours; land use, vegetation and water; roads;
 * buildings and labels. A topographic-map look, not imagery.
 */
export const FEATURE_PHASES: readonly MapPhase[] = [
  drawContours,
  (ctx, scene, layer, area) => {
    withEnvironmentStyle(ctx, scene, () => {
      drawAreas(ctx, scene, layer, area);
    });
  },
  (ctx, scene, layer, area) => {
    withEnvironmentStyle(ctx, scene, () => {
      drawRoads(ctx, scene, layer, area);
    });
  },
  (ctx, scene, layer, area) => {
    withEnvironmentStyle(ctx, scene, () => {
      drawBuildings(ctx, scene, layer, area);
    });
    drawFeatureLabels(ctx, scene, layer, area);
    drawSpotHeights(ctx, scene, layer, area);
  },
];

/** The grid and everything tactical, over the geographic map. */
/**
 * What is drawn over the cached map, in screen pixels: in plan view the
 * grid, the north arrow and the scale bar (a perspective view has none).
 */
export function drawOverlays(
  ctx: CanvasRenderingContext2D,
  scene: MapScene,
  layer: TerrainLayer,
): void {
  if (scene.projection.perspective) return;
  drawGrid(ctx, scene, layer.bounds);
  drawNorthArrow(ctx);
  drawScaleBar(ctx, scene, scene.viewport.height);
}

/** Sets the context to draw in map coordinates (metres), keeping the device pixel ratio. */
function useMapTransform(ctx: CanvasRenderingContext2D, scene: MapScene, dpr: number): void {
  const [a, b, c, d, e, f] = worldToScreenTransform(scene.camera, scene.viewport);
  ctx.setTransform(a * dpr, b * dpr, c * dpr, d * dpr, e * dpr, f * dpr);
}

/** Margin (map metres) for strokes on polygon edges (at most 1.5 px wide), with room for antialiasing. */
const edgeMargin = (scene: MapScene) => 2 * scene.camera.metersPerPixel;

/** Runs `draw` in map coordinates with the environment's round joins and caps. */
function withEnvironmentStyle(ctx: CanvasRenderingContext2D, scene: MapScene, draw: () => void) {
  const dpr = ctx.getTransform().a;
  ctx.save();
  useMapTransform(ctx, scene, dpr);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  draw();
  ctx.restore();
}

/** Land use, vegetation, water and waterways, bottom to top. */
function drawAreas(
  ctx: CanvasRenderingContext2D,
  scene: MapScene,
  layer: TerrainLayer,
  area: Bounds,
): void {
  const mpp = scene.camera.metersPerPixel;
  const edge = edgeMargin(scene);
  for (const l of layer.landUse) {
    if (!overlaps(l.bounds, area, edge)) continue;
    ctx.fillStyle = LAND_USE_FILL[l.kind];
    ctx.fill(l.path, 'evenodd');
    if (l.kind === 'military') {
      ctx.strokeStyle = 'rgba(150, 40, 30, 0.55)';
      ctx.lineWidth = 1.5 * mpp;
      ctx.setLineDash([8 * mpp, 5 * mpp]);
      ctx.stroke(l.path);
      ctx.setLineDash([]);
    }
  }
  for (const v of layer.vegetation) {
    if (!overlaps(v.bounds, area, edge)) continue;
    ctx.fillStyle =
      v.kind === 'scrub'
        ? COLORS.scrubFill
        : v.kind === 'treeLine'
          ? COLORS.treeLineFill
          : COLORS.woodlandFill;
    ctx.fill(v.path, 'evenodd');
    ctx.strokeStyle = v.kind === 'scrub' ? COLORS.scrubEdge : COLORS.woodlandEdge;
    ctx.lineWidth = 1.2 * mpp;
    ctx.setLineDash(v.kind === 'scrub' ? [4 * mpp, 3 * mpp] : []);
    ctx.stroke(v.path);
  }
  ctx.setLineDash([]);
  for (const w of layer.water) {
    if (!overlaps(w.bounds, area, edge)) continue;
    ctx.fillStyle = w.kind === 'wetland' ? COLORS.wetlandFill : COLORS.waterFill;
    ctx.fill(w.path, 'evenodd');
    ctx.strokeStyle = w.kind === 'wetland' ? COLORS.wetlandEdge : COLORS.waterEdge;
    ctx.lineWidth = 1 * mpp;
    ctx.setLineDash(w.kind === 'wetland' ? [3 * mpp, 3 * mpp] : []);
    ctx.stroke(w.path);
  }
  ctx.setLineDash([]);
  for (const w of layer.waterways) {
    const width = Math.max(
      w.widthMeters,
      (w.kind === 'river' || w.kind === 'canal' ? 2.5 : 1.4) * mpp,
    );
    if (!overlaps(w.bounds, area, width / 2 + edge)) continue;
    ctx.strokeStyle = COLORS.waterway;
    ctx.lineWidth = width;
    ctx.setLineDash(w.kind === 'drain' || w.kind === 'ditch' ? [5 * mpp, 3 * mpp] : []);
    ctx.stroke(w.path);
  }
  ctx.setLineDash([]);
}

function drawRoads(
  ctx: CanvasRenderingContext2D,
  scene: MapScene,
  layer: TerrainLayer,
  area: Bounds,
): void {
  // All casings before any fill, so connected ways and junctions show no seams (roads.ts).
  for (const { road, style, width, dash } of roadStrokes(
    layer.roads,
    scene.camera.metersPerPixel,
    area,
    edgeMargin(scene),
  )) {
    ctx.strokeStyle = COLORS[style];
    ctx.lineWidth = width;
    ctx.setLineDash(dash ?? []);
    ctx.stroke(road.path);
  }
  ctx.setLineDash([]);
}

function drawBuildings(
  ctx: CanvasRenderingContext2D,
  scene: MapScene,
  layer: TerrainLayer,
  area: Bounds,
): void {
  const mpp = scene.camera.metersPerPixel;
  const edge = edgeMargin(scene);
  for (const b of layer.buildings) {
    if (!overlaps(b.bounds, area, edge)) continue;
    ctx.fillStyle = COLORS.building;
    ctx.fill(b.path);
    ctx.strokeStyle = COLORS.buildingEdge;
    ctx.lineWidth = 1 * mpp;
    ctx.stroke(b.path);
  }
}

/** Feature ids, once zoomed in far enough to read them. */
function drawFeatureLabels(
  ctx: CanvasRenderingContext2D,
  scene: MapScene,
  layer: TerrainLayer,
  area: Bounds,
): void {
  const mpp = scene.camera.metersPerPixel;
  if (mpp > FEATURE_LABEL_MAX_METERS_PER_PIXEL) return;
  ctx.save();
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Labels are centred on their anchor and at most a few hundred pixels wide.
  const textReach = 200 * mpp;
  const label = (text: string, at: Vec2, color: string) => {
    if (!overlaps({ minX: at.x, minY: at.y, maxX: at.x, maxY: at.y }, area, textReach)) return;
    const p = worldToScreen(scene.camera, scene.viewport, at);
    ctx.lineWidth = 3;
    ctx.strokeStyle = COLORS.labelHalo;
    ctx.strokeText(text, p.x, p.y);
    ctx.fillStyle = color;
    ctx.fillText(text, p.x, p.y);
  };
  for (const v of layer.vegetation) if (v.label) label(v.id, v.anchor, COLORS.woodlandEdge);
  for (const b of layer.buildings) if (b.label) label(b.id, b.anchor, COLORS.featureLabel);
  ctx.restore();
}

/**
 * Spot heights (docs/adr/0024): a dot on each summit shown at this zoom
 * (`placeSpotHeights`) with its height in whole metres beside it, haloed like
 * the other labels. Placed for the whole map, then drawn where they meet `area`.
 */
function drawSpotHeights(
  ctx: CanvasRenderingContext2D,
  scene: MapScene,
  layer: TerrainLayer,
  area: Bounds,
): void {
  const mpp = scene.camera.metersPerPixel;
  const reach = 60 * mpp;
  const shown = placeSpotHeights(layer.spotHeights, mpp).filter(
    (s) =>
      s.x >= area.minX - reach &&
      s.x <= area.maxX + reach &&
      s.y >= area.minY - reach &&
      s.y <= area.maxY + reach,
  );
  if (shown.length === 0) return;
  ctx.save();
  clipToTerrain(ctx, scene, layer);
  ctx.font = 'bold 10px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const s of shown) {
    const p = worldToScreen(scene.camera, scene.viewport, s);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.5, 0, 2 * Math.PI);
    ctx.lineWidth = 2;
    ctx.strokeStyle = COLORS.labelHalo;
    ctx.stroke();
    ctx.fillStyle = COLORS.spotHeight;
    ctx.fill();
    const text = spotHeightLabel(s);
    const x = p.x + SPOT_LABEL_OFFSET_PX;
    ctx.lineWidth = 3;
    ctx.strokeText(text, x, p.y);
    ctx.fillText(text, x, p.y);
  }
  ctx.restore();
}

function drawGrid(ctx: CanvasRenderingContext2D, scene: MapScene, bounds: Bounds): void {
  const { camera, viewport } = scene;
  const spacing = gridSpacing(camera.metersPerPixel);
  const topLeft = screenToWorld(camera, viewport, { x: 0, y: 0 });
  const bottomRight = screenToWorld(camera, viewport, { x: viewport.width, y: viewport.height });
  const minX = Math.max(bounds.minX, topLeft.x);
  const maxX = Math.min(bounds.maxX, bottomRight.x);
  const minY = Math.max(bounds.minY, bottomRight.y);
  const maxY = Math.min(bounds.maxY, topLeft.y);
  if (minX > maxX || minY > maxY) return;

  ctx.save();
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = COLORS.gridLabel;
  const top = worldToScreen(camera, viewport, { x: minX, y: maxY }).y;
  const left = worldToScreen(camera, viewport, { x: minX, y: maxY }).x;
  ctx.beginPath();
  for (let x = Math.ceil(minX / spacing) * spacing; x <= maxX; x += spacing) {
    const sx = Math.round(worldToScreen(camera, viewport, { x, y: 0 }).x) + 0.5;
    const y0 = worldToScreen(camera, viewport, { x, y: maxY }).y;
    const y1 = worldToScreen(camera, viewport, { x, y: minY }).y;
    ctx.moveTo(sx, y0);
    ctx.lineTo(sx, y1);
    ctx.fillText(`${String(x)}E`, sx + 3, top + 11);
  }
  for (let y = Math.ceil(minY / spacing) * spacing; y <= maxY; y += spacing) {
    const sy = Math.round(worldToScreen(camera, viewport, { x: 0, y }).y) + 0.5;
    const x0 = worldToScreen(camera, viewport, { x: minX, y }).x;
    const x1 = worldToScreen(camera, viewport, { x: maxX, y }).x;
    ctx.moveTo(x0, sy);
    ctx.lineTo(x1, sy);
    ctx.fillText(`${String(y)}N`, left + 3, sy - 3);
  }
  ctx.stroke();
  ctx.restore();
}

/** Grid spacing in metres keeping lines at least ~70 px apart. */
export function gridSpacing(metersPerPixel: number): number {
  const target = 70 * metersPerPixel;
  for (const step of [10, 25, 50, 100, 250, 500, 1000, 2500, 5000]) if (step >= target) return step;
  return 10000;
}

/** Opacity of the wedge's distance bands, nearest first: lighter with distance. */
function drawNorthArrow(ctx: CanvasRenderingContext2D): void {
  const x = 32;
  const y = 22;
  ctx.save();
  ctx.fillStyle = 'rgba(20, 24, 28, 0.78)';
  ctx.beginPath();
  ctx.roundRect(x - 18, y - 12, 36, 52, 6);
  ctx.fill();
  ctx.fillStyle = '#f4f6f8';
  ctx.beginPath();
  ctx.moveTo(x, y + 2);
  ctx.lineTo(x + 8, y + 26);
  ctx.lineTo(x, y + 20);
  ctx.lineTo(x - 8, y + 26);
  ctx.closePath();
  ctx.fill();
  ctx.font = 'bold 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('N', x, y + 37);
  ctx.restore();
}

function drawScaleBar(ctx: CanvasRenderingContext2D, scene: MapScene, height: number): void {
  const meters = gridSpacing(scene.camera.metersPerPixel * 1.6);
  const px = meters / scene.camera.metersPerPixel;
  const x = 16;
  const y = height - 22;
  ctx.save();
  ctx.fillStyle = 'rgba(20, 24, 28, 0.78)';
  ctx.beginPath();
  ctx.roundRect(x - 8, y - 18, px + 60, 30, 6);
  ctx.fill();
  ctx.strokeStyle = '#f4f6f8';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y - 5);
  ctx.lineTo(x, y);
  ctx.lineTo(x + px, y);
  ctx.lineTo(x + px, y - 5);
  ctx.stroke();
  ctx.fillStyle = '#f4f6f8';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${String(meters)} m`, x + px + 8, y - 3);
  ctx.restore();
}
