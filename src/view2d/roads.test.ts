import { describe, expect, it } from 'vitest';
import { boundsOf, type RoadClass, type Vec2 } from '#sim';
import type { Bounds } from './camera';
import { roadStrokes, type RoadStroke, type RoadStrokeStyle } from './roads';

interface TestRoad {
  readonly id: string;
  readonly roadClass: RoadClass;
  readonly widthMeters: number;
  readonly centerline: readonly Vec2[];
  readonly bounds: Bounds;
}

function road(id: string, roadClass: RoadClass, centerline: Vec2[], widthMeters = 6): TestRoad {
  return Object.freeze({
    id,
    roadClass,
    widthMeters,
    centerline: Object.freeze(centerline.map((p) => Object.freeze({ ...p }))),
    bounds: Object.freeze(boundsOf(centerline)),
  });
}

const p = (x: number, y: number): Vec2 => ({ x, y });
const WORLD: Bounds = { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 };
const MPP = 0.5;

const styles = (strokes: RoadStroke<TestRoad>[]) => strokes.map((s) => `${s.style}:${s.road.id}`);

function distanceToSegment(q: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / len2));
  return Math.hypot(q.x - (a.x + t * dx), q.y - (a.y + t * dy));
}

function distanceToLine(q: Vec2, line: readonly Vec2[]): number {
  let d = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    if (a && b) d = Math.min(d, distanceToSegment(q, a, b));
  }
  return d;
}

/**
 * Paints solid strokes in order, as Canvas 2D does with round caps and joins
 * (every point within half the line width of the centreline), without
 * antialiasing. Returns the style on top at each sample point, or null.
 */
function paint(
  strokes: RoadStroke<TestRoad>[],
  samples: readonly Vec2[],
): (RoadStrokeStyle | null)[] {
  return samples.map((q) => {
    let top: RoadStrokeStyle | null = null;
    for (const s of strokes) {
      if (distanceToLine(q, s.road.centerline) <= s.width / 2) top = s.style;
    }
    return top;
  });
}

/** Points every `step` metres along a polyline. */
function along(line: readonly Vec2[], step = 0.25): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    if (!a || !b) continue;
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let k = 0; k <= n; k++) {
      out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
    }
  }
  return out;
}

/** The old order: each road's casing, then its fill, road by road. */
function roadByRoad(strokes: RoadStroke<TestRoad>[]): RoadStroke<TestRoad>[] {
  const ids = [...new Set(strokes.map((s) => s.road.id))];
  return ids.flatMap((id) => strokes.filter((s) => s.road.id === id));
}

const isFill = (s: RoadStrokeStyle | null) => s === 'roadFill' || s === 'majorRoadFill';

describe('roadStrokes', () => {
  it('draws a straight road of many segments as one casing and one fill stroke', () => {
    const r = road('a', 'paved', [p(0, 0), p(10, 0), p(20, 0), p(30, 0), p(40, 0)]);
    const strokes = roadStrokes([r], MPP, WORLD, 1);
    expect(styles(strokes)).toEqual(['roadCasing:a', 'roadFill:a']);
    expect(strokes[0]?.width).toBeGreaterThan(strokes[1]?.width ?? Infinity);
    expect(paint(strokes, along(r.centerline)).every(isFill)).toBe(true);
  });

  it('keeps a curved road filled along its whole centreline', () => {
    const arc = Array.from({ length: 13 }, (_, i) => {
      const a = (i / 12) * Math.PI;
      return p(50 * Math.cos(a), 50 * Math.sin(a));
    });
    const r = road('curve', 'major', arc, 8);
    const strokes = roadStrokes([r], MPP, WORLD, 1);
    expect(styles(strokes)).toEqual(['majorRoadCasing:curve', 'majorRoadFill:curve']);
    expect(paint(strokes, along(arc)).every((s) => s === 'majorRoadFill')).toBe(true);
  });

  it('joins two connected ways without a casing seam', () => {
    // One road split into two OSM ways at (40, 20), as the diagonal major road was.
    const w1 = road('w1', 'major', [p(0, 0), p(20, 10), p(40, 20)], 8);
    const w2 = road('w2', 'major', [p(40, 20), p(60, 30), p(80, 40)], 8);
    const strokes = roadStrokes([w1, w2], MPP, WORLD, 1);
    expect(styles(strokes)).toEqual([
      'majorRoadCasing:w1',
      'majorRoadCasing:w2',
      'majorRoadFill:w1',
      'majorRoadFill:w2',
    ]);
    // Across the join, perpendicular to the road, within the fill width.
    const centre = [...along(w1.centerline), ...along(w2.centerline)];
    const n = { x: -1 / Math.hypot(1, 2), y: 2 / Math.hypot(1, 2) };
    const across = centre.flatMap((c) =>
      [-3.5, -2, 0, 2, 3.5].map((o) => p(c.x + o * n.x, c.y + o * n.y)),
    );
    expect(paint(strokes, across).every((s) => s === 'majorRoadFill')).toBe(true);
    // Drawn road by road, w2's casing cap cuts across w1's fill at the join.
    expect(paint(roadByRoad(strokes), across).some((s) => s === 'majorRoadCasing')).toBe(true);
  });

  it('draws a T-junction without casing across the through road', () => {
    const through = road('through', 'paved', [p(-50, 0), p(50, 0)]);
    const stem = road('stem', 'paved', [p(0, 0), p(0, -50)]);
    const strokes = roadStrokes([through, stem], MPP, WORLD, 1);
    const samples = [...along(through.centerline), ...along(stem.centerline)];
    expect(paint(strokes, samples).every(isFill)).toBe(true);
    expect(paint(roadByRoad(strokes), samples).every(isFill)).toBe(false);
  });

  it('draws four-way and crossing intersections as open junctions', () => {
    const ns = road('ns', 'paved', [p(0, -50), p(0, 50)]);
    const ew = road('ew', 'unpaved', [p(-50, 0), p(50, 0)], 4);
    const arms = [
      road('n', 'paved', [p(0, 0), p(0, 50)]),
      road('s', 'paved', [p(0, 0), p(0, -50)]),
      road('e', 'paved', [p(0, 0), p(50, 0)]),
      road('w', 'paved', [p(0, 0), p(-50, 0)]),
    ];
    for (const roads of [[ns, ew], arms]) {
      const strokes = roadStrokes(roads, MPP, WORLD, 1);
      const samples = roads.flatMap((r) => along(r.centerline));
      expect(paint(strokes, samples).every(isFill)).toBe(true);
    }
  });

  it('keeps parallel roads apart, each with its own casing', () => {
    const a = road('a', 'paved', [p(0, 0), p(100, 0)]);
    const b = road('b', 'paved', [p(0, 20), p(100, 20)]);
    const strokes = roadStrokes([a, b], MPP, WORLD, 1);
    // Between the two carriageways is bare ground; each road's edge shows casing.
    expect(paint(strokes, [p(50, 10)])).toEqual([null]);
    expect(paint(strokes, [p(50, 3.5), p(50, 16.5)])).toEqual(['roadCasing', 'roadCasing']);
    expect(paint(strokes, along(a.centerline)).every(isFill)).toBe(true);
    expect(paint(strokes, along(b.centerline)).every(isFill)).toBe(true);
  });

  it('orders classes: dashed tracks and paths, casings, then fills, major on top', () => {
    const roads = [
      road('maj', 'major', [p(0, 0), p(100, 0)], 8),
      road('trk', 'track', [p(50, 0), p(50, 80)], 3),
      road('pav', 'paved', [p(20, -50), p(20, 50)]),
      road('pth', 'path', [p(70, 0), p(70, -60)], 1.5),
      road('unp', 'unpaved', [p(90, 0), p(90, 60)], 4),
    ];
    const strokes = roadStrokes(roads, MPP, WORLD, 1);
    expect(styles(strokes)).toEqual([
      'track:trk',
      'path:pth',
      'roadCasing:pav',
      'roadCasing:unp',
      'majorRoadCasing:maj',
      'roadFill:pav',
      'roadFill:unp',
      'majorRoadFill:maj',
    ]);
    expect(strokes.find((s) => s.style === 'track')?.dash).toEqual([3, 2]);
    expect(strokes.find((s) => s.style === 'path')?.dash).toEqual([1, 1.5]);
    expect(strokes.filter((s) => s.dash === null)).toHaveLength(6);
    // The major road is continuous through its junction with the paved road.
    expect(paint(strokes, along(roads[0]?.centerline ?? []))).not.toContain('roadFill');
    expect(
      paint(strokes, along(roads[0]?.centerline ?? [])).every((s) => s === 'majorRoadFill'),
    ).toBe(true);
  });

  it('keeps roads that reach the drawn area and drops the rest', () => {
    const area: Bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    const crossing = road('crossing', 'paved', [p(-200, 50), p(200, 50)]);
    const edge = road('edge', 'major', [p(-500, 105), p(500, 105)], 8); // casing reaches y = 100
    const away = road('away', 'paved', [p(-200, 300), p(200, 300)]);
    const strokes = roadStrokes([crossing, edge, away], MPP, area, 1);
    expect([...new Set(strokes.map((s) => s.road.id))]).toEqual(['crossing', 'edge']);
  });

  it('scales widths with zoom, keeping a minimum on screen', () => {
    const r = road('a', 'paved', [p(0, 0), p(10, 0), p(20, 0)], 6);
    const near = roadStrokes([r], 0.25, WORLD, 1);
    const far = roadStrokes([r], 5, WORLD, 1);
    // Zoomed in: true width, casing 2 px wider.
    expect(near.map((s) => s.width)).toEqual([6.5, 6]);
    // Zoomed out: 3 px fill, 5 px casing.
    expect(far.map((s) => s.width)).toEqual([25, 15]);
    for (const strokes of [near, far]) {
      expect(paint(strokes, along(r.centerline)).every(isFill)).toBe(true);
    }
  });

  it('draws any part of the view (a cache strip) in the same order as the whole view', () => {
    const roads = [
      road('w1', 'major', [p(-300, -300), p(0, 0)], 8),
      road('w2', 'major', [p(0, 0), p(300, 300)], 8),
      road('side', 'paved', [p(0, 0), p(300, -100)]),
      road('trk', 'track', [p(-100, 0), p(-100, 300)], 3),
    ];
    const whole = styles(roadStrokes(roads, MPP, WORLD, 1));
    const strip: Bounds = { minX: -20, minY: -1000, maxX: 20, maxY: 1000 };
    const part = styles(roadStrokes(roads, MPP, strip, 1));
    expect(part.length).toBeGreaterThan(0);
    // A subsequence of the whole view's order: every casing still before every fill.
    let i = 0;
    for (const s of whole) if (s === part[i]) i++;
    expect(i).toBe(part.length);
    const firstFill = part.findIndex((s) => s.includes('Fill'));
    expect(firstFill).toBeGreaterThan(0);
    expect(part.slice(firstFill).some((s) => s.includes('Casing'))).toBe(false);
  });

  it('leaves the road data unchanged and strokes the imported geometry itself', () => {
    const r = road('a', 'major', [p(0, 0), p(3, 4), p(10, 4)], 8);
    const before = JSON.stringify(r);
    const strokes = roadStrokes([r], MPP, WORLD, 1);
    expect(JSON.stringify(r)).toBe(before);
    for (const s of strokes) expect(s.road).toBe(r);
  });
});
