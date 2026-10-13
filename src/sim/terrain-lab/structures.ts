import type { DecorFeatures, EnvironmentFeatures } from '../environment';
import type { Vec2 } from '../geometry';
import { GRADING_VERSION } from '../grading';
import type { TerrainDataset } from '../terrain';
import type { WaterSurfaces } from '../water-grading';
import type { TerrainSurface } from './surface';

// The ground the structures stand on (research §5.6). The lab draws its
// buildings, bridges, roadside details, trees and water with the game's own
// generators (src/view3d), which take a TerrainDataset: this makes one for an
// area, its heights sampled from the lab surface on a 1 m lattice (every one a
// lattice point of the simulation surface, so equal to it), with the area's
// features cropped to it. It is display input only.

export interface Rect {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

const inRect = (r: Rect, p: Vec2) =>
  p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY;

/** Sutherland–Hodgman clip of a ring to a rectangle. */
export function clipRing(ring: readonly Vec2[], r: Rect): Vec2[] {
  let pts: Vec2[] = [...ring];
  const edges: [(p: Vec2) => boolean, (a: Vec2, b: Vec2) => Vec2][] = [
    [
      (p) => p.x >= r.minX,
      (a, b) => ({ x: r.minX, y: a.y + ((r.minX - a.x) * (b.y - a.y)) / (b.x - a.x) }),
    ],
    [
      (p) => p.x <= r.maxX,
      (a, b) => ({ x: r.maxX, y: a.y + ((r.maxX - a.x) * (b.y - a.y)) / (b.x - a.x) }),
    ],
    [
      (p) => p.y >= r.minY,
      (a, b) => ({ x: a.x + ((r.minY - a.y) * (b.x - a.x)) / (b.y - a.y), y: r.minY }),
    ],
    [
      (p) => p.y <= r.maxY,
      (a, b) => ({ x: a.x + ((r.maxY - a.y) * (b.x - a.x)) / (b.y - a.y), y: r.maxY }),
    ],
  ];
  for (const [inside, cross] of edges) {
    const out: Vec2[] = [];
    const n = pts.length;
    for (let i = 0; i < n; i += 1) {
      const a = pts[(i + n - 1) % n];
      const b = pts[i];
      if (!a || !b) continue;
      const ia = inside(a);
      const ib = inside(b);
      if (ib) {
        if (!ia) out.push(cross(a, b));
        out.push(b);
      } else if (ia) out.push(cross(a, b));
    }
    pts = out;
    if (pts.length === 0) break;
  }
  // Drop repeated points.
  return pts.filter((p, i) => {
    const q = pts[(i + pts.length - 1) % pts.length];
    if (!q) return true;
    return q.x !== p.x || q.y !== p.y;
  });
}

/** Pieces of a polyline inside a rectangle (Liang–Barsky per segment). */
export function clipLine(line: readonly Vec2[], r: Rect): Vec2[][] {
  const pieces: Vec2[][] = [];
  let cur: Vec2[] = [];
  for (let i = 0; i + 1 < line.length; i += 1) {
    const a = line[i];
    const b = line[i + 1];
    if (!a || !b) continue;
    let t0 = 0;
    let t1 = 1;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    let ok = true;
    for (const [p, q] of [
      [-dx, a.x - r.minX],
      [dx, r.maxX - a.x],
      [-dy, a.y - r.minY],
      [dy, r.maxY - a.y],
    ] as const) {
      if (p === 0) {
        if (q < 0) ok = false;
        continue;
      }
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
    if (!ok || t0 > t1) {
      if (cur.length >= 2) pieces.push(cur);
      cur = [];
      continue;
    }
    const pa = t0 === 0 ? a : { x: a.x + t0 * dx, y: a.y + t0 * dy };
    const pb = t1 === 1 ? b : { x: a.x + t1 * dx, y: a.y + t1 * dy };
    if (cur.length === 0) cur.push(pa);
    cur.push(pb);
    if (t1 < 1) {
      if (cur.length >= 2) pieces.push(cur);
      cur = [];
    }
  }
  if (cur.length >= 2) pieces.push(cur);
  return pieces;
}

const piecesOf = <T extends { id: string }>(
  f: T,
  pieces: Vec2[][],
  make: (f: T, pts: Vec2[], id: string) => T,
): T[] => pieces.map((pts, k) => make(f, pts, pieces.length === 1 ? f.id : `${f.id}#${String(k)}`));

export function cropFeatures(f: EnvironmentFeatures, r: Rect): EnvironmentFeatures {
  const ring = <T extends { boundary: readonly Vec2[]; holes?: readonly (readonly Vec2[])[] }>(
    a: T,
  ): T | null => {
    const boundary = clipRing(a.boundary, r);
    if (boundary.length < 3) return null;
    const holes = (a.holes ?? []).map((h) => clipRing(h, r)).filter((h) => h.length >= 3);
    const out = { ...a, boundary };
    if (holes.length > 0) return { ...out, holes };
    delete (out as { holes?: unknown }).holes;
    return out;
  };
  return {
    roads: f.roads.flatMap((road) =>
      piecesOf(road, clipLine(road.centerline, r), (o, pts, id) => ({ ...o, id, centerline: pts })),
    ),
    buildings: f.buildings.filter((b) => b.footprint.every((p) => inRect(r, p))),
    vegetation: f.vegetation.flatMap((v) => ring(v) ?? []),
    water: (f.water ?? []).flatMap((w) => ring(w) ?? []),
    waterways: (f.waterways ?? []).flatMap((w) =>
      piecesOf(w, clipLine(w.centerline, r), (o, pts, id) => ({ ...o, id, centerline: pts })),
    ),
    landUse: (f.landUse ?? []).flatMap((l) => ring(l) ?? []),
  };
}

export function cropDecor(d: DecorFeatures, r: Rect): DecorFeatures {
  return {
    points: d.points.filter((p) => inRect(r, p.position)),
    lines: d.lines.flatMap((l) =>
      piecesOf(l, clipLine(l.points, r), (o, pts, id) => ({ ...o, id, points: pts })),
    ),
  };
}

/**
 * A TerrainDataset for `area` whose ground is the lab surface: `height` gives
 * it at lattice points `spacing` apart (aligned to the surface's lattice, so
 * equal to the surface there), with the source's features cropped to it and
 * the water levels kept.
 */
export function structureTerrain(
  surface: Pick<TerrainSurface, 'originX' | 'originY' | 'field'>,
  source: TerrainDataset,
  water: WaterSurfaces | null,
  area: Rect,
  spacing = 1,
  height: (x: number, y: number) => number = (x, y) => Math.fround(surface.field.height(x, y)),
): TerrainDataset {
  const ox = surface.originX;
  const oy = surface.originY;
  // Align to the lattice.
  const x0 = ox + Math.ceil((area.minX - ox) / spacing) * spacing;
  const y0 = oy + Math.ceil((area.minY - oy) / spacing) * spacing;
  const columns = Math.floor((area.maxX - x0) / spacing) + 1;
  const rows = Math.floor((area.maxY - y0) / spacing) + 1;
  const elevations = new Array<number>(columns * rows);
  for (let r = 0; r < rows; r += 1)
    for (let c = 0; c < columns; c += 1)
      elevations[r * columns + c] = height(x0 + c * spacing, y0 + r * spacing);
  const rect = {
    minX: x0,
    minY: y0,
    maxX: x0 + (columns - 1) * spacing,
    maxY: y0 + (rows - 1) * spacing,
  };
  return {
    formatVersion: 3,
    georef: source.georef,
    heightfield: { originX: x0, originY: y0, cellSize: spacing, columns, rows, elevations },
    features: cropFeatures(source.features, rect),
    ...(source.metadata ? { metadata: source.metadata } : {}),
    ...(source.decor ? { decor: cropDecor(source.decor, rect) } : {}),
    grading: {
      version: GRADING_VERSION,
      fineSpacingM: spacing,
      ...(water ? { water } : {}),
    },
  };
}
