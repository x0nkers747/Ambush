import { TRAINEE_SIDE, type SoldierPlan } from '#exercise';
import type { DeepReadonly, Soldier, TerrainDataset, Vec2 } from '#sim';
import { formatBearing } from './bearing';
import {
  screenToWorld,
  terrainBounds,
  worldToScreen,
  worldToScreenTransform,
  type Bounds,
} from './camera';
import { routeGeometry, WAYPOINT_RADIUS_PX, type MapScene } from './scene';
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
  hostile: '#c8433a',
  symbolOutline: '#f4f6f8',
  facingTick: '#15191d',
  route: '#1d4f9c',
  routeHalo: 'rgba(255, 255, 255, 0.7)',
  otherRoute: 'rgba(29, 79, 156, 0.45)',
  selection: '#f2c230',
  label: '#15191d',
  labelHalo: 'rgba(255, 255, 255, 0.8)',
} as const;

const MINOR_CONTOUR_INTERVAL_M = 2;
const INDEX_CONTOUR_EVERY = 5;
const SOLDIER_RADIUS_PX = 6;
const FACING_TICK_PX = 14;
/** Soldier labels appear once soldiers are far enough apart to read them. */
const LABEL_MAX_METERS_PER_PIXEL = 0.45;

/** Canvas objects for one terrain, built once. */
export interface TerrainLayer {
  readonly terrain: TerrainDataset;
  readonly bounds: Bounds;
  readonly image: HTMLCanvasElement;
  readonly minorContours: Path2D;
  readonly indexContours: Path2D;
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
  return { terrain, bounds: terrainBounds(terrain), image, minorContours, indexContours };
}

/** Draws the whole map. `ctx` must already be scaled for the device pixel ratio. */
export function drawMap(ctx: CanvasRenderingContext2D, scene: MapScene, layer: TerrainLayer): void {
  const { width, height } = scene.viewport;
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, width, height);

  drawTerrain(ctx, scene, layer);
  drawGrid(ctx, scene, layer.bounds);
  for (const plan of scene.plans) {
    if (plan.soldierId !== scene.selectedId) drawOtherRoute(ctx, scene, plan);
  }
  drawSelectedRoute(ctx, scene);
  for (const soldier of scene.soldiers) drawSoldier(ctx, scene, soldier);
  drawFacingArrow(ctx, scene);
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

function routePoints(scene: MapScene, plan: SoldierPlan): Vec2[] | undefined {
  const soldier = scene.soldiers.find((s) => s.id === plan.soldierId);
  if (!soldier) return undefined;
  const toScreen = (p: Vec2) => worldToScreen(scene.camera, scene.viewport, p);
  return [toScreen(soldier.position), ...plan.waypoints.map(toScreen)];
}

function drawOtherRoute(ctx: CanvasRenderingContext2D, scene: MapScene, plan: SoldierPlan): void {
  const points = routePoints(scene, plan);
  if (!points || points.length < 2) return;
  ctx.save();
  ctx.strokeStyle = COLORS.otherRoute;
  ctx.fillStyle = COLORS.otherRoute;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  polyline(ctx, points);
  ctx.setLineDash([]);
  for (const p of points.slice(1)) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, 2 * Math.PI);
    ctx.fill();
  }
  ctx.restore();
}

function drawSelectedRoute(ctx: CanvasRenderingContext2D, scene: MapScene): void {
  const route = routeGeometry(scene);
  if (!route) return;
  const { points } = route;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (!scene.editable) ctx.setLineDash([8, 5]);
  ctx.strokeStyle = COLORS.routeHalo;
  ctx.lineWidth = 5;
  polyline(ctx, points);
  ctx.strokeStyle = COLORS.route;
  ctx.lineWidth = 2.5;
  polyline(ctx, points);
  ctx.setLineDash([]);

  // A chevron at the middle of each leg shows the direction of travel.
  ctx.fillStyle = COLORS.route;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (!a || !b || Math.hypot(b.x - a.x, b.y - a.y) < 4 * WAYPOINT_RADIUS_PX) continue;
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    ctx.save();
    ctx.translate((a.x + b.x) / 2, (a.y + b.y) / 2);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(6, 0);
    ctx.lineTo(-4, -5);
    ctx.lineTo(-4, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  ctx.font = 'bold 10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  points.slice(1).forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, WAYPOINT_RADIUS_PX, 0, 2 * Math.PI);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = COLORS.route;
    ctx.stroke();
    ctx.fillStyle = COLORS.route;
    ctx.fillText(String(i + 1), p.x, p.y + 0.5);
  });
  ctx.restore();
}

function drawSoldier(
  ctx: CanvasRenderingContext2D,
  scene: MapScene,
  soldier: DeepReadonly<Soldier>,
): void {
  const p = worldToScreen(scene.camera, scene.viewport, soldier.position);
  const friendly = soldier.side === TRAINEE_SIDE;
  const selected = soldier.id === scene.selectedId;
  ctx.save();

  // Facing: a tick from the centre along the azimuth.
  ctx.strokeStyle = COLORS.facingTick;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(
    p.x + Math.sin(soldier.azimuth) * FACING_TICK_PX,
    p.y - Math.cos(soldier.azimuth) * FACING_TICK_PX,
  );
  ctx.stroke();

  // Friendly: circle. Hostile: diamond (echoing, not implementing, APP-6/MIL-STD-2525 frames).
  ctx.beginPath();
  if (friendly) {
    ctx.arc(p.x, p.y, SOLDIER_RADIUS_PX, 0, 2 * Math.PI);
  } else {
    const r = SOLDIER_RADIUS_PX + 1.5;
    ctx.moveTo(p.x, p.y - r);
    ctx.lineTo(p.x + r, p.y);
    ctx.lineTo(p.x, p.y + r);
    ctx.lineTo(p.x - r, p.y);
    ctx.closePath();
  }
  ctx.fillStyle = friendly ? COLORS.friendly : COLORS.hostile;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = COLORS.symbolOutline;
  ctx.stroke();

  if (selected) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, SOLDIER_RADIUS_PX + 5, 0, 2 * Math.PI);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = COLORS.selection;
    ctx.stroke();
  }

  if (selected || scene.camera.metersPerPixel <= LABEL_MAX_METERS_PER_PIXEL) {
    ctx.font = `${selected ? 'bold ' : ''}11px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = COLORS.labelHalo;
    ctx.strokeText(soldier.id, p.x + 10, p.y + 9);
    ctx.fillStyle = COLORS.label;
    ctx.fillText(soldier.id, p.x + 10, p.y + 9);
  }
  ctx.restore();
}

function drawFacingArrow(ctx: CanvasRenderingContext2D, scene: MapScene): void {
  const route = routeGeometry(scene);
  const plan = scene.selectedPlan;
  if (!route || !plan) return;
  const { facingAnchor: a, facingTip: tip } = route;
  const angle = Math.atan2(tip.y - a.y, tip.x - a.x);
  ctx.save();
  ctx.strokeStyle = COLORS.route;
  ctx.fillStyle = COLORS.route;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
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

  if (scene.editable) {
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, 6, 0, 2 * Math.PI);
    ctx.fillStyle = COLORS.selection;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = COLORS.route;
    ctx.stroke();
  }

  const label = formatBearing(plan.finalFacing);
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
