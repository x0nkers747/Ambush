import { polygonCentroid, type PlannedRoute } from '#exercise';
import {
  boundsOf,
  type CombatBehavior,
  type LandUseKind,
  type RoadClass,
  type SoldierId,
  type TerrainDataset,
  type VegetationKind,
  type Vec2,
  type Viewshed,
  type WaterArea,
  type WaterwayKind,
} from '#sim';
import { formatBearing } from './bearing';
import { roadStrokes } from './roads';
import { pointAlong, wedgeEdges, wedgeOnScreen } from './engagement';
import {
  screenToWorld,
  terrainBounds,
  worldToScreen,
  worldToScreenTransform,
  type Bounds,
} from './camera';
import {
  deploymentGeometry,
  DESTINATION_RADIUS_PX,
  formationGeometry,
  isSelected,
  SHOT_DISPLAY_SECONDS,
  SOLDIER_ICON_PX,
  SYMBOL_BOX_PX,
  symbolLayout,
  type MapScene,
  type OpforStatus,
} from './scene';
import {
  AFFILIATION_COLORS,
  drawSoldierIcon,
  FACING_REACH,
  ICON_INK,
  type Affiliation,
} from './soldier-icons';
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
  orpFill: 'rgba(47, 111, 196, 0.1)',
  orpEdge: 'rgba(29, 64, 120, 0.8)',
  badge: '#1d4078',
  facingTick: '#15191d',
  route: '#1d4f9c',
  routeHalo: 'rgba(255, 255, 255, 0.7)',
  otherRoute: 'rgba(29, 79, 156, 0.45)',
  selection: '#f2c230',
  label: '#15191d',
  labelHalo: 'rgba(255, 255, 255, 0.8)',
  killZoneFill: 'rgba(214, 48, 39, 0.16)',
  killZoneEdge: 'rgba(176, 30, 24, 0.9)',
  killZoneLabel: '#9c1c16',
  opforRoute: 'rgba(122, 22, 40, 0.8)',
  trigger: '#d6301f',
  bluforShot: '#f5d90a',
  opforShot: '#ff5a3c',
  incapacitated: '#d6301f',
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
  impossible: '#d6301f',
  // The visible area is light purple: it stands out from the green of woods and grass.
  visibleEdge: '#5e2ca5',
} as const;

/** Radius of a decluttered (compact) soldier symbol. */
const COMPACT_RADIUS_PX = 3.5;
/** Building and vegetation ids appear from this zoom. */
const FEATURE_LABEL_MAX_METERS_PER_PIXEL = 0.6;
/** Opacity (0–255) of the visibility overlay, inside the visible area and along its edge. */
const VISIBLE_ALPHA = 95;
const VISIBLE_EDGE_ALPHA = 150;

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
}

/** Side of a contour tile in map metres. */
const CONTOUR_TILE_M = 250;

/**
 * Canvas objects for one terrain, built once. Every feature carries its
 * bounds (map metres), so that drawing a part of the map skips what lies
 * outside it.
 */
export interface TerrainLayer {
  readonly terrain: TerrainDataset;
  readonly bounds: Bounds;
  readonly image: HTMLCanvasElement;
  readonly contours: readonly ContourTile[];
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

  // Contour segments are grouped into tiles by their first point.
  const intervals = contourIntervals(terrain);
  const bounds = terrainBounds(terrain);
  const tileColumns = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / CONTOUR_TILE_M));
  const tileRows = Math.max(1, Math.ceil((bounds.maxY - bounds.minY) / CONTOUR_TILE_M));
  const tiles = new Map<
    number,
    { minor: Path2D | null; index: Path2D | null; box: [number, number, number, number] }
  >();
  for (const { level, segments } of contourLines(terrain, intervals.minor)) {
    const isIndex = Math.round(level / intervals.minor) % (intervals.index / intervals.minor) === 0;
    for (let i = 0; i + 3 < segments.length; i += 4) {
      const x1 = segments[i] ?? 0;
      const y1 = segments[i + 1] ?? 0;
      const x2 = segments[i + 2] ?? 0;
      const y2 = segments[i + 3] ?? 0;
      const tc = Math.min(
        tileColumns - 1,
        Math.max(0, Math.floor((x1 - bounds.minX) / CONTOUR_TILE_M)),
      );
      const tr = Math.min(
        tileRows - 1,
        Math.max(0, Math.floor((y1 - bounds.minY) / CONTOUR_TILE_M)),
      );
      const key = tr * tileColumns + tc;
      let tile = tiles.get(key);
      if (!tile) {
        tile = { minor: null, index: null, box: [x1, y1, x1, y1] };
        tiles.set(key, tile);
      }
      const path = isIndex ? (tile.index ??= new Path2D()) : (tile.minor ??= new Path2D());
      path.moveTo(x1, y1);
      path.lineTo(x2, y2);
      const box = tile.box;
      box[0] = Math.min(box[0], x1, x2);
      box[1] = Math.min(box[1], y1, y2);
      box[2] = Math.max(box[2], x1, x2);
      box[3] = Math.max(box[3], y1, y2);
    }
  }
  const contours = [...tiles.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, { minor, index, box }]) => ({
      minor,
      index,
      bounds: { minX: box[0], minY: box[1], maxX: box[2], maxY: box[3] },
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
 * visibility overlay, the geographic features (contours and environment),
 * then the grid and everything tactical. The map widget caches the ground
 * and the features between frames (`geo-cache.ts`) and draws the same layers
 * in the same order.
 */
export function drawMap(ctx: CanvasRenderingContext2D, scene: MapScene, layer: TerrainLayer): void {
  const area = viewArea(scene);
  drawGround(ctx, scene, layer, area);
  drawVisibility(ctx, scene, layer);
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

/**
 * Whether the scene has a visibility overlay to draw between the ground and
 * the features (the only thing that changes how the map is cached; the
 * weapon wedge and everything else tactical is drawn over it).
 */
export function hasVisibilityOverlay(scene: MapScene): boolean {
  return scene.visibility?.viewshed != null;
}

/** The visibility overlay: on the shaded terrain, beneath contours and features. */
export function drawVisibility(
  ctx: CanvasRenderingContext2D,
  scene: MapScene,
  layer: TerrainLayer,
): void {
  if (!scene.visibility?.viewshed) return;
  ctx.save();
  clipToTerrain(ctx, scene, layer);
  drawViewshed(ctx, scene);
  ctx.restore();
}

/** A part of the geographic map, drawn within `area` (map metres). */
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

/** Contours: the visible tiles joined into one path per weight, so overlapping translucent lines blend as in one stroke. */
function drawContours(
  ctx: CanvasRenderingContext2D,
  scene: MapScene,
  layer: TerrainLayer,
  area: Bounds,
): void {
  const mpp = scene.camera.metersPerPixel;
  const dpr = ctx.getTransform().a;
  const minor = new Path2D();
  const index = new Path2D();
  let any = false;
  for (const tile of layer.contours) {
    if (!overlaps(tile.bounds, area, 2 * mpp)) continue;
    if (tile.minor) minor.addPath(tile.minor);
    if (tile.index) index.addPath(tile.index);
    any = true;
  }
  if (!any) return;
  ctx.save();
  clipToTerrain(ctx, scene, layer);
  useMapTransform(ctx, scene, dpr);
  ctx.lineJoin = 'round';
  ctx.strokeStyle = COLORS.contour;
  ctx.lineWidth = 0.8 * mpp;
  ctx.stroke(minor);
  ctx.strokeStyle = COLORS.indexContour;
  ctx.lineWidth = 1.4 * mpp;
  ctx.stroke(index);
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
export function drawOverlays(
  ctx: CanvasRenderingContext2D,
  scene: MapScene,
  layer: TerrainLayer,
): void {
  const { height } = scene.viewport;
  const plan = !scene.projection.perspective;
  if (plan) drawGrid(ctx, scene, layer.bounds);
  drawEngagementWedge(ctx, scene, layer);
  drawOrp(ctx, scene);
  drawKillZone(ctx, scene);
  for (const { path } of scene.opforRoutes) drawOpforRoute(ctx, scene, path);
  for (const plan of scene.plans) {
    if (!isSelected(scene, plan.soldierId)) drawOtherPlan(ctx, scene, plan.soldierId);
  }
  if (scene.selectedTeam) {
    for (const id of scene.selectedTeam.memberIds) drawSelectedPlan(ctx, scene, id);
  } else {
    drawSelectedPlan(ctx, scene);
  }
  drawObserver(ctx, scene);
  drawShots(ctx, scene);
  drawSoldiers(ctx, scene);
  if (scene.selectedTeam) {
    for (const id of scene.selectedTeam.memberIds) drawFacingArrow(ctx, scene, id);
    drawFormation(ctx, scene);
  } else {
    drawFacingArrow(ctx, scene);
  }
  drawTrigger(ctx, scene);
  if (plan) {
    drawNorthArrow(ctx);
    drawScaleBar(ctx, scene, height);
  }
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
const WEDGE_BAND_ALPHAS = [0.13, 0.08, 0.04] as const;

/**
 * The selected Marine's weapon engagement wedge (`engagement.ts`), or each
 * Marine's wedge of a selected fire team: translucent BLUEFOR blue in distance
 * bands that lighten outwards, thin edges, and a thin arc at the weapon's
 * maximum engagement range. Drawn over the map and beneath everything
 * tactical, so symbols, routes and the facing arrows stay on top. The bands
 * suggest that effectiveness falls with distance; they are not hit
 * probabilities. Each band of every wedge is filled as one path (non-zero
 * winding, all wedges turning the same way), so where wedges overlap the band
 * is filled once and does not darken; each wedge keeps its own edges and arc.
 */
function drawEngagementWedge(
  ctx: CanvasRenderingContext2D,
  scene: MapScene,
  layer: TerrainLayer,
): void {
  if (scene.projection.perspective) {
    drawEngagementWedgeOnGround(ctx, scene);
    return;
  }
  const wedges = scene.engagements
    .map((wedge) => ({ wedge, ...wedgeOnScreen(wedge, scene.camera, scene.viewport) }))
    .filter(({ radius }) => radius > 0);
  if (wedges.length === 0) return;
  ctx.save();
  // Within the map's edges (as the visibility overlay); the terrain itself does not clip it.
  clipToTerrain(ctx, scene, layer);
  const bands = WEDGE_BAND_ALPHAS.length;
  WEDGE_BAND_ALPHAS.forEach((alpha, i) => {
    ctx.beginPath();
    for (const { apex, radius, start, end } of wedges) {
      const inner = (radius * i) / bands;
      const outer = (radius * (i + 1)) / bands;
      ctx.moveTo(apex.x + outer * Math.cos(start), apex.y + outer * Math.sin(start));
      ctx.arc(apex.x, apex.y, outer, start, end);
      ctx.arc(apex.x, apex.y, inner, end, start, true);
      ctx.closePath();
    }
    ctx.fillStyle = `rgba(47, 111, 196, ${String(alpha)})`;
    ctx.fill('nonzero');
  });
  const labels: { x: number; y: number; text: string }[] = [];
  for (const { wedge, apex, radius, start, end } of wedges) {
    // Edges, then the range arc.
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(29, 64, 120, 0.35)';
    ctx.beginPath();
    ctx.moveTo(apex.x + radius * Math.cos(start), apex.y + radius * Math.sin(start));
    ctx.lineTo(apex.x, apex.y);
    ctx.lineTo(apex.x + radius * Math.cos(end), apex.y + radius * Math.sin(end));
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(29, 64, 120, 0.6)';
    ctx.beginPath();
    ctx.arc(apex.x, apex.y, radius, start, end);
    ctx.stroke();
    // The weapon and its range, just beyond the arc on the facing line; a
    // label that would sit on the same one of another wedge is left out.
    const mid = (start + end) / 2;
    const x = apex.x + (radius + 12) * Math.cos(mid);
    const y = apex.y + (radius + 12) * Math.sin(mid);
    const text = `${wedge.weaponName} · ${String(wedge.rangeM)} m`;
    if (!labels.some((l) => l.text === text && Math.hypot(l.x - x, l.y - y) < 60)) {
      labels.push({ x, y, text });
    }
  }
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const { x, y, text } of labels) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = COLORS.labelHalo;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = COLORS.orpEdge;
    ctx.fillText(text, x, y);
  }
  ctx.restore();
}

/** Points along an arc of a wedge in map metres, `steps` + 1 of them, from bearing `from` to `to`. */
function arcPoints(origin: Vec2, radius: number, from: number, to: number, steps: number): Vec2[] {
  return Array.from({ length: steps + 1 }, (_, k) => {
    const a = from + ((to - from) * k) / steps;
    return { x: origin.x + radius * Math.sin(a), y: origin.y + radius * Math.cos(a) };
  });
}

/**
 * The engagement wedges in perspective (docs/adr/0039): the same bands,
 * edges, arc and label as on the 2D map, laid on the ground in map metres
 * and projected, so they follow the terrain and shrink with distance.
 */
function drawEngagementWedgeOnGround(ctx: CanvasRenderingContext2D, scene: MapScene): void {
  const wedges = scene.engagements.filter((w) => w.rangeM > 0);
  if (wedges.length === 0) return;
  const { projection } = scene;
  const bands = WEDGE_BAND_ALPHAS.length;
  const STEPS = 24;
  ctx.save();
  WEDGE_BAND_ALPHAS.forEach((alpha, i) => {
    ctx.beginPath();
    for (const wedge of wedges) {
      const [left, right] = wedgeEdges(wedge);
      const inner = (wedge.rangeM * i) / bands;
      const outer = (wedge.rangeM * (i + 1)) / bands;
      const ring = [
        ...arcPoints(wedge.origin, outer, left, right, STEPS),
        ...(inner > 0 ? arcPoints(wedge.origin, inner, right, left, STEPS) : [wedge.origin]),
      ].map((p) => projection.toScreen(p));
      tracePolygon(ctx, ring);
    }
    ctx.fillStyle = `rgba(47, 111, 196, ${String(alpha)})`;
    ctx.fill('nonzero');
  });
  const labels: { x: number; y: number; text: string }[] = [];
  for (const wedge of wedges) {
    const [left, right] = wedgeEdges(wedge);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(29, 64, 120, 0.35)';
    polyline(
      ctx,
      projection.line([
        pointAlong(wedge.origin, left, wedge.rangeM),
        wedge.origin,
        pointAlong(wedge.origin, right, wedge.rangeM),
      ]),
    );
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(29, 64, 120, 0.6)';
    polyline(
      ctx,
      arcPoints(wedge.origin, wedge.rangeM, left, right, STEPS).map((p) => projection.toScreen(p)),
    );
    const at = projection.along(
      pointAlong(wedge.origin, (left + right) / 2, wedge.rangeM),
      (left + right) / 2,
      12,
    );
    const text = `${wedge.weaponName} · ${String(wedge.rangeM)} m`;
    if (!labels.some((l) => l.text === text && Math.hypot(l.x - at.x, l.y - at.y) < 60)) {
      labels.push({ x: at.x, y: at.y, text });
    }
  }
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const { x, y, text } of labels) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = COLORS.labelHalo;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = COLORS.orpEdge;
    ctx.fillText(text, x, y);
  }
  ctx.restore();
}

/** Adds a closed polygon to the current path, starting afresh after any point that cannot be drawn. */
function tracePolygon(ctx: CanvasRenderingContext2D, points: readonly Vec2[]): void {
  const drawable = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (drawable.length < 3) return;
  drawable.forEach((p, i) => {
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.closePath();
}

/** A planned route as walked: start, then each leg's generated turns and its waypoint. */
function walkedPoints(route: PlannedRoute): Vec2[] {
  return [route.start, ...route.legs.flatMap((leg) => [...(leg.turns ?? []), leg.to])];
}

/** The objective rally point: a subtle outline and fill with its name, beneath everything planned. */
function drawOrp(ctx: CanvasRenderingContext2D, scene: MapScene): void {
  const orp = scene.orp;
  if (!orp) return;
  const first = orp.outline[0];
  if (orp.outline.length < 3 || !first) return;
  const points = scene.projection.line([...orp.outline, first]);
  ctx.save();
  ctx.beginPath();
  tracePolygon(ctx, points);
  ctx.fillStyle = COLORS.orpFill;
  ctx.fill();
  ctx.setLineDash([6, 3]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = COLORS.orpEdge;
  ctx.stroke();
  ctx.setLineDash([]);
  // The name sits just outside the northern edge, clear of the soldiers inside.
  const top = points.reduce((a, b) => (b.y < a.y ? b : a));
  const centre = scene.projection.toScreen(orp.centre);
  ctx.font = 'bold 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.lineWidth = 3;
  ctx.strokeStyle = COLORS.labelHalo;
  ctx.strokeText(orp.name, centre.x, top.y - 3);
  ctx.fillStyle = COLORS.orpEdge;
  ctx.fillText(orp.name, centre.x, top.y - 3);
  ctx.restore();
}

/** Another soldier's plan: a faint path to a small destination marker. No turn points. */
function drawOtherPlan(ctx: CanvasRenderingContext2D, scene: MapScene, id: SoldierId): void {
  const geometry = deploymentGeometry(scene, id);
  if (!geometry?.destination) return;
  const { path, destination: d } = geometry;
  ctx.save();
  ctx.strokeStyle = COLORS.otherRoute;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  polyline(ctx, path);
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(d.x, d.y, 3.5, 0, 2 * Math.PI);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** A selected soldier's path (as it will be walked) and destination marker (default: the selected soldier's). */
function drawSelectedPlan(
  ctx: CanvasRenderingContext2D,
  scene: MapScene,
  id: SoldierId | null = scene.selectedId,
): void {
  const geometry = deploymentGeometry(scene, id);
  if (!geometry?.destination) return;
  const { path, impossible, destination: d } = geometry;
  const colour = impossible ? COLORS.impossible : COLORS.route;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const editable = scene.editable || scene.selectedTeam?.editable === true;
  ctx.setLineDash(impossible ? [4, 4] : editable ? [] : [8, 5]);
  ctx.strokeStyle = COLORS.routeHalo;
  ctx.lineWidth = 5;
  polyline(ctx, path);
  ctx.strokeStyle = colour;
  ctx.lineWidth = 2.5;
  polyline(ctx, path);
  ctx.setLineDash([]);

  // Destination: a ring with a centre dot, the only planning handle besides the facing.
  ctx.beginPath();
  ctx.arc(d.x, d.y, DESTINATION_RADIUS_PX, 0, 2 * Math.PI);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = colour;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(d.x, d.y, 2, 0, 2 * Math.PI);
  ctx.fillStyle = colour;
  ctx.fill();
  ctx.restore();
}

/**
 * How far a label beside an icon must start (east `side` 1, west −1) to clear
 * its facing triangle; 0 when the triangle points away from the label's line.
 */
function triangleClearance(azimuth: number, side: 1 | -1): number {
  const reach = FACING_REACH * SOLDIER_ICON_PX;
  const x = reach * Math.sin(azimuth) * side;
  const y = reach * Math.cos(azimuth);
  return x > 0 && Math.abs(y) < 10 ? x + 3 : 0;
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  bold: boolean,
): void {
  ctx.font = `${bold ? 'bold ' : ''}11px system-ui, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3;
  ctx.strokeStyle = COLORS.labelHalo;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = COLORS.label;
  ctx.fillText(text, x, y);
}

/**
 * Every soldier, whatever its side, at its true position (docs/adr/0013): the
 * icon with its facing triangle, or a compact dot with a facing tick where
 * icons would overlap (`symbolLayout`), plus its label, "+n" badges for the
 * soldiers hidden beneath it, and the selection ring. Compact soldiers are
 * drawn first, full icons over them, the selected soldier last, on top.
 */
function drawSoldiers(ctx: CanvasRenderingContext2D, scene: MapScene): void {
  const layout = symbolLayout(scene);
  const rank = (id: SoldierId, mode: string) =>
    isSelected(scene, id) ? 2 : mode === 'full' ? 1 : 0;
  const entries = [...layout].sort(([a, p], [b, q]) => rank(a, p.mode) - rank(b, q.mode));
  for (const [id, { at, mode, affiliation, label, showLabel, hidden }] of entries) {
    const soldier = scene.soldiers.find((s) => s.id === id);
    if (!soldier) continue;
    const selected = isSelected(scene, id);
    const full = mode === 'full';
    ctx.save();

    // The selection ring goes beneath the icon, so the facing triangle stays on top of it.
    if (selected) {
      ctx.beginPath();
      ctx.arc(at.x, at.y, SOLDIER_ICON_PX / 2 + 3.5, 0, 2 * Math.PI);
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = COLORS.selection;
      ctx.stroke();
    }

    const behavior = scene.combat?.behaviors.get(id);
    // An incapacitated soldier stays on the map, faded and crossed out.
    if (behavior === 'incapacitated') ctx.globalAlpha = 0.45;
    if (scene.projection.perspective) {
      // The 3D view draws the soldier himself; the overlay adds the ring, label and status.
    } else if (full) {
      // Soldiers outside the trainee's organization (OPFOR) have no role: the plain circle.
      const role = scene.markings.get(id)?.icon ?? null;
      drawSoldierIcon(ctx, { role, affiliation, facing: soldier.azimuth }, at, SOLDIER_ICON_PX);
    } else {
      // Facing: a short tick beyond the dot.
      const inner = COMPACT_RADIUS_PX;
      const outer = inner + 7;
      const sin = Math.sin(soldier.azimuth);
      const cos = Math.cos(soldier.azimuth);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(at.x + sin * inner, at.y - cos * inner);
      ctx.lineTo(at.x + sin * outer, at.y - cos * outer);
      ctx.lineWidth = 4;
      ctx.strokeStyle = COLORS.labelHalo;
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.strokeStyle = COLORS.facingTick;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(at.x, at.y, COMPACT_RADIUS_PX, 0, 2 * Math.PI);
      ctx.fillStyle = AFFILIATION_COLORS[affiliation];
      ctx.fill();
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = ICON_INK;
      ctx.stroke();
    }
    if (showLabel) {
      // Keep a selected Marine's label clear of an eastward facing arrow.
      const facing = selected ? scene.facings.get(id) : undefined;
      const east = facing !== undefined && Math.sin(facing.azimuth) > 0.6;
      const offset = full
        ? Math.max(SYMBOL_BOX_PX / 2 + 2, triangleClearance(soldier.azimuth, east ? -1 : 1))
        : 6;
      if (east) {
        ctx.font = `bold 11px system-ui, sans-serif`;
        const width = ctx.measureText(label).width;
        drawLabel(ctx, label, at.x - offset - width, at.y, selected);
      } else {
        drawLabel(ctx, label, at.x + offset, at.y, selected);
      }
    }
    ctx.globalAlpha = 1;
    if (behavior !== undefined) {
      drawCombatMarker(ctx, behavior, scene.combat?.opforStatuses.get(id) ?? null, at, full);
    }
    if (hidden.length > 0) drawHiddenBadges(ctx, hidden, at);
    ctx.restore();
  }
}

/**
 * Combat feedback on a soldier's symbol: an X when incapacitated, and under
 * every OPFOR soldier a label of what it is doing (`OpforStatus`).
 */
function drawCombatMarker(
  ctx: CanvasRenderingContext2D,
  behavior: CombatBehavior,
  status: OpforStatus | null,
  at: Vec2,
  full: boolean,
): void {
  const radius = full ? SOLDIER_ICON_PX / 2 : COMPACT_RADIUS_PX;
  if (behavior === 'incapacitated') {
    const r = radius + 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(at.x - r, at.y - r);
    ctx.lineTo(at.x + r, at.y + r);
    ctx.moveTo(at.x + r, at.y - r);
    ctx.lineTo(at.x - r, at.y + r);
    ctx.lineWidth = 5;
    ctx.strokeStyle = COLORS.labelHalo;
    ctx.stroke();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = COLORS.incapacitated;
    ctx.stroke();
  }
  if (status === null) return;
  // A pill under the symbol: white text on the status colour.
  ctx.font = 'bold 10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const width = ctx.measureText(status).width + 8;
  const height = 14;
  const top = at.y + radius + 4;
  ctx.beginPath();
  ctx.roundRect(at.x - width / 2, top, width, height, 3);
  ctx.fillStyle = STATUS_COLORS[status];
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = COLORS.labelHalo;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.fillText(status, at.x, top + height / 2 + 0.5);
}

/** The OPFOR status pill's background: red while fighting, amber while running, grey once out. */
const STATUS_COLORS: Readonly<Record<OpforStatus, string>> = {
  REACTING: '#6b5a2a',
  FIRING: '#b3261e',
  PRONE: '#7a3b36',
  FLEEING: '#b06d00',
  ESCAPED: '#4a5560',
  DOWN: '#3a3f44',
};

/**
 * Recent shots (docs/adr/0019): a line from shooter to target in the side's
 * colour, fading over `SHOT_DISPLAY_SECONDS`; a hit ends in a small dot.
 */
function drawShots(ctx: CanvasRenderingContext2D, scene: MapScene): void {
  const shots = scene.combat?.shots;
  if (!shots || shots.length === 0) return;
  ctx.save();
  ctx.lineCap = 'round';
  for (const shot of shots) {
    // From the shooter's weapon to the target's body where the view shows height.
    const from = scene.projection.toScreen(shot.from, SHOT_LIFT_M);
    const to = scene.projection.toScreen(shot.to, SHOT_LIFT_M);
    ctx.globalAlpha = Math.max(0.15, 1 - shot.ageSeconds / SHOT_DISPLAY_SECONDS);
    ctx.strokeStyle = shot.side === 'BLUEFOR' ? COLORS.bluforShot : COLORS.opforShot;
    ctx.lineWidth = shot.hit ? 2 : 1.25;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    if (shot.hit) {
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.arc(to.x, to.y, 3.5, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
  ctx.restore();
}

/**
 * Height above the ground, in metres, at which a shot line starts and ends
 * where the view shows height: about a kneeling or standing soldier's weapon
 * and body. The simulation records shooter and target, not a trajectory.
 */
export const SHOT_LIFT_M = 1.2;

/** Badge colours, darker than the icons so white "+n" text reads on them. */
const BADGE_COLORS: Readonly<Record<Affiliation, string>> = {
  friendly: COLORS.badge,
  enemy: '#8f1f19',
  friendly2: '#2f6a28',
  neutral: '#7a5a00',
  unknown: '#45494e',
};

/**
 * "+n" badges on a symbol that hides n more soldiers beneath it: one badge per
 * affiliation, in the affiliation's colour, so an enemy hidden under a friendly
 * soldier is never counted as friendly.
 */
function drawHiddenBadges(
  ctx: CanvasRenderingContext2D,
  hidden: readonly { readonly affiliation: Affiliation }[],
  at: Vec2,
): void {
  const counts = new Map<Affiliation, number>();
  for (const { affiliation } of hidden) counts.set(affiliation, (counts.get(affiliation) ?? 0) + 1);
  ctx.font = 'bold 10px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  let x = at.x + SYMBOL_BOX_PX / 2 - 4;
  const y = at.y - SYMBOL_BOX_PX / 2 - 6;
  for (const [affiliation, count] of counts) {
    const text = `+${String(count)}`;
    const width = ctx.measureText(text).width + 6;
    ctx.beginPath();
    ctx.roundRect(x, y, width, 13, 6);
    ctx.fillStyle = BADGE_COLORS[affiliation];
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, x + 3, y + 7);
    x += width + 2;
  }
}

/**
 * A selected soldier's facing arrow (default: the selected soldier's), with its
 * drag handle while editable. A fire team's Marines get no handle and no
 * bearing: the formation's own arrow turns them all.
 */
function drawFacingArrow(
  ctx: CanvasRenderingContext2D,
  scene: MapScene,
  id: SoldierId | null = scene.selectedId,
): void {
  const geometry = deploymentGeometry(scene, id);
  if (!geometry) return;
  const member = scene.selectedTeam !== null;
  const { facingAnchor: a, facingShaftStart: from, facingTip: tip, facing } = geometry;
  const angle = Math.atan2(tip.y - a.y, tip.x - a.x);
  ctx.save();
  ctx.strokeStyle = COLORS.route;
  ctx.fillStyle = COLORS.route;
  ctx.lineWidth = 2.5;
  // A default facing (not chosen by the trainee) is dashed.
  ctx.setLineDash(facing.explicit ? [] : [5, 4]);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(tip.x, tip.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.save();
  ctx.translate(tip.x, tip.y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(2, 0);
  ctx.lineTo(-9, -6);
  ctx.lineTo(-9, 6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  if (member) {
    ctx.restore();
    return;
  }
  if (scene.editable) {
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, 6, 0, 2 * Math.PI);
    ctx.fillStyle = COLORS.selection;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = COLORS.route;
    ctx.stroke();
  }

  // The bearing alone; a default facing is shown by the dashed shaft.
  const label = formatBearing(facing.azimuth);
  const lx = tip.x + Math.cos(angle) * 16;
  const ly = tip.y + Math.sin(angle) * 16;
  ctx.font = 'bold 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3;
  ctx.strokeStyle = COLORS.labelHalo;
  ctx.strokeText(label, lx, ly);
  ctx.fillStyle = COLORS.label;
  ctx.fillText(label, lx, ly);
  ctx.restore();
}

/** The trainee's kill zone: translucent so the terrain stays readable, corners shown while editing. */
function drawKillZone(ctx: CanvasRenderingContext2D, scene: MapScene): void {
  const zone = scene.killZone;
  if (!zone || zone.vertices.length === 0) return;
  const points = zone.vertices.map((v) => scene.projection.toScreen(v));
  const closed = points.length >= 3;
  const first = zone.vertices[0];
  // The outline as drawn: on the ground between corners, in perspective.
  const outline = scene.projection.line(
    closed && first ? [...zone.vertices, first] : zone.vertices,
  );
  ctx.save();
  ctx.beginPath();
  if (closed) {
    tracePolygon(ctx, outline);
    ctx.fillStyle = COLORS.killZoneFill;
    ctx.fill();
  } else {
    outline.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
  }
  ctx.strokeStyle = COLORS.killZoneEdge;
  ctx.lineWidth = 2;
  ctx.setLineDash(closed ? [10, 4] : [4, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  if (scene.killZoneEditable) {
    for (const p of points) {
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = COLORS.killZoneEdge;
      ctx.lineWidth = 2;
      ctx.fillRect(p.x - 5, p.y - 5, 10, 10);
      ctx.strokeRect(p.x - 5, p.y - 5, 10, 10);
    }
  }

  if (closed) {
    const c = scene.projection.perspective
      ? scene.projection.toScreen(centroid(zone.vertices))
      : centroid(points);
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = COLORS.labelHalo;
    ctx.strokeText('KILL ZONE', c.x, c.y);
    ctx.fillStyle = COLORS.killZoneLabel;
    ctx.fillText('KILL ZONE', c.x, c.y);
  }
  ctx.restore();
}

/** Scenario information: the expected enemy route, distinct from trainee plans. */
function drawOpforRoute(ctx: CanvasRenderingContext2D, scene: MapScene, path: PlannedRoute): void {
  const points = scene.projection.line(walkedPoints(path));
  const waypoints = path.legs.map((leg) => scene.projection.toScreen(leg.to));
  ctx.save();
  ctx.strokeStyle = COLORS.opforRoute;
  ctx.fillStyle = COLORS.opforRoute;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.setLineDash([12, 4, 2, 4]);
  polyline(ctx, points);
  ctx.setLineDash([]);
  for (const p of waypoints) ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (!a || !b || Math.hypot(b.x - a.x, b.y - a.y) < 40) continue;
    ctx.save();
    ctx.translate((a.x + b.x) / 2, (a.y + b.y) / 2);
    ctx.rotate(Math.atan2(b.y - a.y, b.x - a.x));
    ctx.beginPath();
    ctx.moveTo(5, 0);
    ctx.lineTo(-4, -4);
    ctx.lineTo(-4, 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

/** The observation point of the visibility overlay: a ring, dashed when it is only the current position. */
function drawObserver(ctx: CanvasRenderingContext2D, scene: MapScene): void {
  const visibility = scene.visibility;
  if (!visibility) return;
  ctx.save();
  for (const observer of visibility.observers ?? [visibility.observer]) {
    const p = scene.projection.toScreen(observer);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 10, 0, 2 * Math.PI);
    ctx.lineWidth = 3;
    ctx.strokeStyle = COLORS.labelHalo;
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = COLORS.visibleEdge;
    ctx.setLineDash(visibility.planned ? [] : [3, 3]);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * The selected fire team's formation: a thin line through its slots, the
 * centre as a diamond (the drag handle), and the common facing arrow from the
 * centre with its handle and bearing.
 */
function drawFormation(ctx: CanvasRenderingContext2D, scene: MapScene): void {
  const geometry = formationGeometry(scene);
  if (!geometry) return;
  const editable = scene.selectedTeam?.editable === true;
  const { centre: c, slots, facingTip: tip, azimuth } = geometry;
  const first = slots[0];
  const last = slots[slots.length - 1];
  ctx.save();
  ctx.lineCap = 'round';
  if (first && last) {
    ctx.setLineDash([2, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = COLORS.route;
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // The facing arrow from the centre.
  const angle = Math.atan2(tip.y - c.y, tip.x - c.x);
  ctx.strokeStyle = COLORS.route;
  ctx.fillStyle = COLORS.route;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(c.x + Math.cos(angle) * 8, c.y + Math.sin(angle) * 8);
  ctx.lineTo(tip.x, tip.y);
  ctx.stroke();
  ctx.save();
  ctx.translate(tip.x, tip.y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(2, 0);
  ctx.lineTo(-9, -6);
  ctx.lineTo(-9, 6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  // The centre: a diamond.
  const r = DESTINATION_RADIUS_PX + 1;
  ctx.beginPath();
  ctx.moveTo(c.x, c.y - r);
  ctx.lineTo(c.x + r, c.y);
  ctx.lineTo(c.x, c.y + r);
  ctx.lineTo(c.x - r, c.y);
  ctx.closePath();
  ctx.fillStyle = editable ? COLORS.selection : '#ffffff';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = COLORS.route;
  ctx.stroke();
  if (editable) {
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, 6, 0, 2 * Math.PI);
    ctx.fillStyle = COLORS.selection;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = COLORS.route;
    ctx.stroke();
  }
  const label = formatBearing(azimuth);
  const lx = tip.x + Math.cos(angle) * 16;
  const ly = tip.y + Math.sin(angle) * 16;
  ctx.font = 'bold 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3;
  ctx.strokeStyle = COLORS.labelHalo;
  ctx.strokeText(label, lx, ly);
  ctx.fillStyle = COLORS.label;
  ctx.fillText(label, lx, ly);
  ctx.restore();
}

/** Translucent light purple over visible cells, deeper along the edge of the visible area. */
export function viewshedPixels(viewshed: Viewshed): Uint8ClampedArray {
  const { grid, visible } = viewshed;
  const { columns, rows } = grid;
  const data = new Uint8ClampedArray(columns * rows * 4);
  const at = (c: number, r: number) =>
    c < 0 || r < 0 || c >= columns || r >= rows ? 1 : (visible[r * columns + c] ?? 0);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < columns; c += 1) {
      if (!at(c, r)) continue;
      const edge = !at(c - 1, r) || !at(c + 1, r) || !at(c, r - 1) || !at(c, r + 1);
      // Image row 0 is the northernmost grid row.
      const i = ((rows - 1 - r) * columns + c) * 4;
      // Light purple inside, a deeper purple along the edge.
      data[i] = edge ? 120 : 185;
      data[i + 1] = edge ? 60 : 135;
      data[i + 2] = edge ? 200 : 255;
      data[i + 3] = edge ? VISIBLE_EDGE_ALPHA : VISIBLE_ALPHA;
    }
  }
  return data;
}

const overlayCache = new WeakMap<Viewshed, HTMLCanvasElement>();

function overlayImage(viewshed: Viewshed): HTMLCanvasElement {
  let canvas = overlayCache.get(viewshed);
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.width = viewshed.grid.columns;
    canvas.height = viewshed.grid.rows;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const pixels = ctx.createImageData(canvas.width, canvas.height);
      pixels.data.set(viewshedPixels(viewshed));
      ctx.putImageData(pixels, 0, 0);
    }
    overlayCache.set(viewshed, canvas);
  }
  return canvas;
}

/** Draws the viewshed over the terrain shading, beneath contours and everything else. */
function drawViewshed(ctx: CanvasRenderingContext2D, scene: MapScene): void {
  const viewshed = scene.visibility?.viewshed;
  if (!viewshed) return;
  const { grid } = viewshed;
  const topLeft = worldToScreen(scene.camera, scene.viewport, {
    x: grid.originX,
    y: grid.originY + grid.rows * grid.cellSize,
  });
  const size = grid.cellSize / scene.camera.metersPerPixel;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';
  ctx.drawImage(
    overlayImage(viewshed),
    topLeft.x,
    topLeft.y,
    grid.columns * size,
    grid.rows * size,
  );
  ctx.restore();
}

/**
 * Marks where each OPFOR soldier stood when the ambush was triggered: two rings
 * for those in the kill zone, one dashed ring for the rest.
 */
function drawTrigger(ctx: CanvasRenderingContext2D, scene: MapScene): void {
  if (!scene.trigger) return;
  ctx.save();
  ctx.strokeStyle = COLORS.trigger;
  ctx.lineWidth = 3;
  for (const opfor of scene.trigger.opforPositions) {
    const p = scene.projection.toScreen(opfor.point);
    ctx.setLineDash(opfor.inKillZone ? [] : [4, 4]);
    for (const r of opfor.inKillZone ? [10, 18] : [14]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, 2 * Math.PI);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function centroid(points: readonly Vec2[]): Vec2 {
  // Area-weighted centroid; falls back to the vertex mean for degenerate shapes.
  let area = 0;
  let cx = 0;
  let cy = 0;
  points.forEach((a, i) => {
    const b = points[(i + 1) % points.length] ?? a;
    const cross = a.x * b.y - b.x * a.y;
    area += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  });
  if (area === 0) {
    const n = points.length || 1;
    return {
      x: points.reduce((s, p) => s + p.x, 0) / n,
      y: points.reduce((s, p) => s + p.y, 0) / n,
    };
  }
  return { x: cx / (3 * area), y: cy / (3 * area) };
}

/** The north arrow, in the map's top-left corner (its box spans 14 to 50 px across, 10 to 62 down). */
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

function polyline(ctx: CanvasRenderingContext2D, points: readonly Vec2[]): void {
  ctx.beginPath();
  // A point that cannot be drawn (behind a perspective camera) breaks the line.
  let pen = false;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      pen = false;
      continue;
    }
    if (pen) ctx.lineTo(p.x, p.y);
    else ctx.moveTo(p.x, p.y);
    pen = true;
  }
  ctx.stroke();
}
