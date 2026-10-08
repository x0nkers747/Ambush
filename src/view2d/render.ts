import { polygonCentroid, type PlannedRoute } from '#exercise';
import type {
  DeepReadonly,
  RoadClass,
  Soldier,
  SoldierId,
  TerrainDataset,
  VegetationKind,
  Vec2,
  Viewshed,
} from '#sim';
import { formatBearing } from './bearing';
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
  SYMBOL_BOX_PX,
  symbolLayout,
  type MapScene,
} from './scene';
import { symbolImage } from './symbology';
import { contourLines, terrainRaster } from './terrain-layer';

// Canvas 2D rendering of the tactical map. Map coordinates are drawn through
// the camera transform; symbols and labels are drawn in screen pixels so they
// keep their size at every zoom.

const COLORS = {
  background: '#1b1f23',
  contour: 'rgba(92, 66, 40, 0.38)',
  indexContour: 'rgba(92, 66, 40, 0.72)',
  grid: 'rgba(30, 35, 40, 0.18)',
  gridLabel: 'rgba(20, 24, 28, 0.75)',
  friendly: '#2f6fc4',
  friendlyCompact: '#80c0ff',
  orpFill: 'rgba(47, 111, 196, 0.1)',
  orpEdge: 'rgba(29, 64, 120, 0.8)',
  badge: '#1d4078',
  hostile: '#c8433a',
  symbolOutline: '#f4f6f8',
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
  woodlandFill: 'rgba(70, 125, 60, 0.42)',
  woodlandEdge: 'rgba(36, 82, 32, 0.85)',
  treeLineFill: 'rgba(52, 106, 46, 0.6)',
  scrubFill: 'rgba(122, 152, 82, 0.3)',
  scrubEdge: 'rgba(80, 112, 50, 0.75)',
  roadCasing: '#6f5b3b',
  roadFill: '#ecdfbf',
  track: 'rgba(110, 86, 52, 0.9)',
  building: '#4b4b4b',
  buildingEdge: '#191919',
  featureLabel: 'rgba(20, 24, 28, 0.85)',
  impossible: '#d6301f',
  visibleEdge: '#0d6b30',
} as const;

const MINOR_CONTOUR_INTERVAL_M = 2;
const INDEX_CONTOUR_EVERY = 5;
const SOLDIER_RADIUS_PX = 6;
const FACING_TICK_PX = 14;
/** milsymbol's base size for trainee symbols (about 21 px across for a dismounted individual). */
const SYMBOL_SIZE = 18;
/** Radius of a decluttered (compact) trainee symbol. */
const COMPACT_RADIUS_PX = 3.5;
/** Soldier labels appear once soldiers are far enough apart to read them. */
const LABEL_MAX_METERS_PER_PIXEL = 0.45;
/** Building and vegetation ids appear from this zoom. */
const FEATURE_LABEL_MAX_METERS_PER_PIXEL = 0.6;
/** Opacity (0–255) of the visibility overlay, inside the visible area and along its edge. */
const VISIBLE_ALPHA = 80;
const VISIBLE_EDGE_ALPHA = 150;

/** Canvas objects for one terrain, built once. */
export interface TerrainLayer {
  readonly terrain: TerrainDataset;
  readonly bounds: Bounds;
  readonly image: HTMLCanvasElement;
  readonly minorContours: Path2D;
  readonly indexContours: Path2D;
  /** Environment features as map-coordinate paths, with label anchors. */
  readonly vegetation: readonly { id: string; kind: VegetationKind; path: Path2D; anchor: Vec2 }[];
  readonly roads: readonly {
    id: string;
    roadClass: RoadClass;
    widthMeters: number;
    path: Path2D;
  }[];
  readonly buildings: readonly { id: string; path: Path2D; anchor: Vec2 }[];
}

function polygonPath(points: readonly Vec2[]): Path2D {
  const path = new Path2D();
  points.forEach((p, i) => {
    if (i === 0) path.moveTo(p.x, p.y);
    else path.lineTo(p.x, p.y);
  });
  path.closePath();
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

  const minorContours = new Path2D();
  const indexContours = new Path2D();
  for (const { level, segments } of contourLines(terrain, MINOR_CONTOUR_INTERVAL_M)) {
    const isIndex = Math.round(level / MINOR_CONTOUR_INTERVAL_M) % INDEX_CONTOUR_EVERY === 0;
    const path = isIndex ? indexContours : minorContours;
    for (let i = 0; i + 3 < segments.length; i += 4) {
      path.moveTo(segments[i] ?? 0, segments[i + 1] ?? 0);
      path.lineTo(segments[i + 2] ?? 0, segments[i + 3] ?? 0);
    }
  }
  const { roads, buildings, vegetation } = terrain.features;
  return {
    terrain,
    bounds: terrainBounds(terrain),
    image,
    minorContours,
    indexContours,
    vegetation: vegetation.map((v) => ({
      id: v.id,
      kind: v.kind,
      path: polygonPath(v.boundary),
      anchor: polygonCentroid(v.boundary) ?? v.boundary[0] ?? { x: 0, y: 0 },
    })),
    roads: roads.map((r) => {
      const path = new Path2D();
      r.centerline.forEach((p, i) => {
        if (i === 0) path.moveTo(p.x, p.y);
        else path.lineTo(p.x, p.y);
      });
      return { id: r.id, roadClass: r.roadClass, widthMeters: r.widthMeters, path };
    }),
    buildings: buildings.map((b) => ({
      id: b.id,
      path: polygonPath(b.footprint),
      anchor: polygonCentroid(b.footprint) ?? b.footprint[0] ?? { x: 0, y: 0 },
    })),
  };
}

/** Draws the whole map. `ctx` must already be scaled for the device pixel ratio. */
export function drawMap(ctx: CanvasRenderingContext2D, scene: MapScene, layer: TerrainLayer): void {
  const { width, height } = scene.viewport;
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, width, height);

  drawTerrain(ctx, scene, layer);
  drawEnvironment(ctx, scene, layer);
  drawGrid(ctx, scene, layer.bounds);
  drawOrp(ctx, scene);
  drawKillZone(ctx, scene);
  for (const { path } of scene.opforRoutes) drawOpforRoute(ctx, scene, path);
  for (const plan of scene.plans) {
    if (plan.soldierId !== scene.selectedId) drawOtherPlan(ctx, scene, plan.soldierId);
  }
  drawSelectedPlan(ctx, scene);
  drawObserver(ctx, scene);
  for (const soldier of scene.soldiers) {
    if (!scene.markings.has(soldier.id)) drawOpforSoldier(ctx, scene, soldier);
  }
  drawTraineeSoldiers(ctx, scene);
  drawFacingArrow(ctx, scene);
  drawTrigger(ctx, scene);
  drawNorthArrow(ctx, width);
  drawScaleBar(ctx, scene, height);
}

function drawTerrain(ctx: CanvasRenderingContext2D, scene: MapScene, layer: TerrainLayer): void {
  const { cellSize } = layer.terrain.heightfield;
  // Pixel centres sit on the samples, so the image extends half a cell past the bounds.
  const topLeft = worldToScreen(scene.camera, scene.viewport, {
    x: layer.bounds.minX - cellSize / 2,
    y: layer.bounds.maxY + cellSize / 2,
  });
  const scale = 1 / scene.camera.metersPerPixel;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
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
  ctx.drawImage(
    layer.image,
    topLeft.x,
    topLeft.y,
    layer.image.width * cellSize * scale,
    layer.image.height * cellSize * scale,
  );
  // The visibility overlay goes on the shaded terrain, beneath contours and features.
  drawViewshed(ctx, scene);

  const dpr = ctx.getTransform().a;
  const [a, b, c, d, e, f] = worldToScreenTransform(scene.camera, scene.viewport);
  ctx.setTransform(a * dpr, b * dpr, c * dpr, d * dpr, e * dpr, f * dpr);
  ctx.lineJoin = 'round';
  ctx.strokeStyle = COLORS.contour;
  ctx.lineWidth = 0.8 * scene.camera.metersPerPixel;
  ctx.stroke(layer.minorContours);
  ctx.strokeStyle = COLORS.indexContour;
  ctx.lineWidth = 1.4 * scene.camera.metersPerPixel;
  ctx.stroke(layer.indexContours);
  ctx.restore();
}

/** Sets the context to draw in map coordinates (metres), keeping the device pixel ratio. */
function useMapTransform(ctx: CanvasRenderingContext2D, scene: MapScene, dpr: number): void {
  const [a, b, c, d, e, f] = worldToScreenTransform(scene.camera, scene.viewport);
  ctx.setTransform(a * dpr, b * dpr, c * dpr, d * dpr, e * dpr, f * dpr);
}

/** Vegetation, then roads, then buildings: a topographic-map look, not imagery. */
function drawEnvironment(
  ctx: CanvasRenderingContext2D,
  scene: MapScene,
  layer: TerrainLayer,
): void {
  const mpp = scene.camera.metersPerPixel;
  const dpr = ctx.getTransform().a;
  ctx.save();
  useMapTransform(ctx, scene, dpr);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const v of layer.vegetation) {
    ctx.fillStyle =
      v.kind === 'scrub'
        ? COLORS.scrubFill
        : v.kind === 'treeLine'
          ? COLORS.treeLineFill
          : COLORS.woodlandFill;
    ctx.fill(v.path);
    ctx.strokeStyle = v.kind === 'scrub' ? COLORS.scrubEdge : COLORS.woodlandEdge;
    ctx.lineWidth = 1.2 * mpp;
    ctx.setLineDash(v.kind === 'scrub' ? [4 * mpp, 3 * mpp] : []);
    ctx.stroke(v.path);
  }
  ctx.setLineDash([]);
  for (const r of layer.roads) {
    if (r.roadClass === 'track') {
      ctx.strokeStyle = COLORS.track;
      ctx.lineWidth = Math.max(r.widthMeters, 1.5 * mpp);
      ctx.setLineDash([6 * mpp, 4 * mpp]);
      ctx.stroke(r.path);
      ctx.setLineDash([]);
      continue;
    }
    ctx.strokeStyle = COLORS.roadCasing;
    ctx.lineWidth = Math.max(r.widthMeters, 3 * mpp) + 2 * mpp;
    ctx.stroke(r.path);
    ctx.strokeStyle = COLORS.roadFill;
    ctx.lineWidth = Math.max(r.widthMeters, 3 * mpp);
    ctx.stroke(r.path);
  }
  for (const b of layer.buildings) {
    ctx.fillStyle = COLORS.building;
    ctx.fill(b.path);
    ctx.strokeStyle = COLORS.buildingEdge;
    ctx.lineWidth = 1 * mpp;
    ctx.stroke(b.path);
  }
  ctx.restore();

  // Feature ids, once zoomed in far enough to read them.
  if (mpp > FEATURE_LABEL_MAX_METERS_PER_PIXEL) return;
  ctx.save();
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const label = (text: string, at: Vec2, color: string) => {
    const p = worldToScreen(scene.camera, scene.viewport, at);
    ctx.lineWidth = 3;
    ctx.strokeStyle = COLORS.labelHalo;
    ctx.strokeText(text, p.x, p.y);
    ctx.fillStyle = color;
    ctx.fillText(text, p.x, p.y);
  };
  for (const v of layer.vegetation) label(v.id, v.anchor, COLORS.woodlandEdge);
  for (const b of layer.buildings) label(b.id, b.anchor, COLORS.featureLabel);
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

/** A planned route as walked: start, then each leg's generated turns and its waypoint. */
function walkedPoints(route: PlannedRoute): Vec2[] {
  return [route.start, ...route.legs.flatMap((leg) => [...(leg.turns ?? []), leg.to])];
}

/** The objective rally point: a subtle outline and fill with its name, beneath everything planned. */
function drawOrp(ctx: CanvasRenderingContext2D, scene: MapScene): void {
  const points = scene.orp.outline.map((p) => worldToScreen(scene.camera, scene.viewport, p));
  if (points.length < 3) return;
  ctx.save();
  ctx.beginPath();
  points.forEach((p, i) => {
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.closePath();
  ctx.fillStyle = COLORS.orpFill;
  ctx.fill();
  ctx.setLineDash([6, 3]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = COLORS.orpEdge;
  ctx.stroke();
  ctx.setLineDash([]);
  // The name sits just outside the northern edge, clear of the soldiers inside.
  const top = points.reduce((a, b) => (b.y < a.y ? b : a));
  const centre = worldToScreen(scene.camera, scene.viewport, scene.orp.centre);
  ctx.font = 'bold 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.lineWidth = 3;
  ctx.strokeStyle = COLORS.labelHalo;
  ctx.strokeText(scene.orp.name, centre.x, top.y - 3);
  ctx.fillStyle = COLORS.orpEdge;
  ctx.fillText(scene.orp.name, centre.x, top.y - 3);
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

/** The selected soldier's path (as it will be walked) and destination marker. */
function drawSelectedPlan(ctx: CanvasRenderingContext2D, scene: MapScene): void {
  const geometry = deploymentGeometry(scene);
  if (!geometry?.destination) return;
  const { path, impossible, destination: d } = geometry;
  const colour = impossible ? COLORS.impossible : COLORS.route;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash(impossible ? [4, 4] : scene.editable ? [] : [8, 5]);
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

/** Opposing-force soldiers: a red diamond with a facing tick (not a standard symbol). */
function drawOpforSoldier(
  ctx: CanvasRenderingContext2D,
  scene: MapScene,
  soldier: DeepReadonly<Soldier>,
): void {
  const p = worldToScreen(scene.camera, scene.viewport, soldier.position);
  ctx.save();
  ctx.strokeStyle = COLORS.facingTick;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(
    p.x + Math.sin(soldier.azimuth) * FACING_TICK_PX,
    p.y - Math.cos(soldier.azimuth) * FACING_TICK_PX,
  );
  ctx.stroke();
  const r = SOLDIER_RADIUS_PX + 1.5;
  ctx.beginPath();
  ctx.moveTo(p.x, p.y - r);
  ctx.lineTo(p.x + r, p.y);
  ctx.lineTo(p.x, p.y + r);
  ctx.lineTo(p.x - r, p.y);
  ctx.closePath();
  ctx.fillStyle = COLORS.hostile;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = COLORS.symbolOutline;
  ctx.stroke();
  if (scene.camera.metersPerPixel <= LABEL_MAX_METERS_PER_PIXEL) {
    drawLabel(ctx, soldier.id, p.x + 10, p.y + 9, false);
  }
  ctx.restore();
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
 * The trainee's soldiers at their true positions (docs/adr/0012): the standard
 * symbol from milsymbol, or a compact dot where symbols would overlap, plus
 * the Ambush! facing indicator, role label and selection halo. The selected
 * soldier is drawn last, on top.
 */
function drawTraineeSoldiers(ctx: CanvasRenderingContext2D, scene: MapScene): void {
  const layout = symbolLayout(scene);
  const dpr = ctx.getTransform().a;
  const rank = (id: SoldierId, mode: string) =>
    id === scene.selectedId ? 2 : mode === 'full' ? 1 : 0;
  const entries = [...layout].sort(([a, p], [b, q]) => rank(a, p.mode) - rank(b, q.mode));
  for (const [id, { at, mode, showLabel, covered }] of entries) {
    const soldier = scene.soldiers.find((s) => s.id === id);
    const marking = scene.markings.get(id);
    if (!soldier || !marking) continue;
    const selected = id === scene.selectedId;
    const full = mode === 'full';
    ctx.save();

    // Facing: a stroke beyond the symbol's frame, separate from the standard symbol.
    const inner = full ? SYMBOL_BOX_PX / 2 - 1 : COMPACT_RADIUS_PX;
    const outer = inner + (full ? 9 : 7);
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

    if (full) {
      const symbol = symbolImage(marking.sidc, SYMBOL_SIZE, dpr);
      ctx.drawImage(
        symbol.image,
        at.x - symbol.anchor.x,
        at.y - symbol.anchor.y,
        symbol.width,
        symbol.height,
      );
    } else {
      ctx.beginPath();
      ctx.arc(at.x, at.y, COMPACT_RADIUS_PX, 0, 2 * Math.PI);
      ctx.fillStyle = COLORS.friendlyCompact;
      ctx.fill();
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = COLORS.friendly;
      ctx.stroke();
    }

    if (selected) {
      ctx.beginPath();
      ctx.arc(at.x, at.y, SYMBOL_BOX_PX / 2 + 4, 0, 2 * Math.PI);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = COLORS.selection;
      ctx.stroke();
    }
    if (showLabel) {
      const offset = full ? SYMBOL_BOX_PX / 2 + 2 : 6;
      // Keep the selected Marine's label clear of an eastward facing arrow.
      const facing = selected ? scene.facings.get(id) : undefined;
      const east = facing !== undefined && Math.sin(facing.azimuth) > 0.6;
      if (east) {
        ctx.font = `bold 11px system-ui, sans-serif`;
        const width = ctx.measureText(marking.label).width;
        drawLabel(ctx, marking.label, at.x - offset - width, at.y, selected);
      } else {
        drawLabel(ctx, marking.label, at.x + offset, at.y, selected);
      }
    }
    if (covered > 0) drawCountBadge(ctx, `+${String(covered)}`, at);
    ctx.restore();
  }
}

/** "+n" on a symbol that hides n more Marines beneath it. */
function drawCountBadge(ctx: CanvasRenderingContext2D, text: string, at: Vec2): void {
  ctx.font = 'bold 10px system-ui, sans-serif';
  const width = ctx.measureText(text).width + 6;
  const x = at.x + SYMBOL_BOX_PX / 2 - 4;
  const y = at.y - SYMBOL_BOX_PX / 2 - 6;
  ctx.beginPath();
  ctx.roundRect(x, y, width, 13, 6);
  ctx.fillStyle = COLORS.badge;
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 3, y + 7);
}

function drawFacingArrow(ctx: CanvasRenderingContext2D, scene: MapScene): void {
  const geometry = deploymentGeometry(scene);
  if (!geometry) return;
  const { facingAnchor: a, facingTip: tip, facing } = geometry;
  const angle = Math.atan2(tip.y - a.y, tip.x - a.x);
  ctx.save();
  ctx.strokeStyle = COLORS.route;
  ctx.fillStyle = COLORS.route;
  ctx.lineWidth = 2.5;
  // A default facing (not chosen by the trainee) is dashed.
  ctx.setLineDash(facing.explicit ? [] : [5, 4]);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
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

  if (scene.editable) {
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, 6, 0, 2 * Math.PI);
    ctx.fillStyle = COLORS.selection;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = COLORS.route;
    ctx.stroke();
  }

  const label = `${formatBearing(facing.azimuth)}${facing.explicit ? '' : ' (default)'}`;
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
  const points = zone.vertices.map((v) => worldToScreen(scene.camera, scene.viewport, v));
  const closed = points.length >= 3;
  ctx.save();
  ctx.beginPath();
  points.forEach((p, i) => {
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  if (closed) {
    ctx.closePath();
    ctx.fillStyle = COLORS.killZoneFill;
    ctx.fill();
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
    const c = centroid(points);
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
  const points = walkedPoints(path).map((p) => worldToScreen(scene.camera, scene.viewport, p));
  const waypoints = path.legs.map((leg) => worldToScreen(scene.camera, scene.viewport, leg.to));
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
  const p = worldToScreen(scene.camera, scene.viewport, visibility.observer);
  ctx.save();
  ctx.beginPath();
  ctx.arc(p.x, p.y, 10, 0, 2 * Math.PI);
  ctx.lineWidth = 3;
  ctx.strokeStyle = COLORS.labelHalo;
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.strokeStyle = COLORS.visibleEdge;
  ctx.setLineDash(visibility.planned ? [] : [3, 3]);
  ctx.stroke();
  ctx.restore();
}

/** Translucent green over visible cells, a little stronger along the edge of the visible area. */
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
      data[i] = 40;
      data[i + 1] = edge ? 130 : 170;
      data[i + 2] = 60;
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

/** Marks where the ambush was sprung. */
function drawTrigger(ctx: CanvasRenderingContext2D, scene: MapScene): void {
  if (!scene.trigger) return;
  const p = worldToScreen(scene.camera, scene.viewport, scene.trigger.point);
  ctx.save();
  ctx.strokeStyle = COLORS.trigger;
  ctx.lineWidth = 3;
  for (const r of [10, 18]) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, 2 * Math.PI);
    ctx.stroke();
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

function drawNorthArrow(ctx: CanvasRenderingContext2D, width: number): void {
  const x = width - 32;
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
  points.forEach((p, i) => {
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.stroke();
}
