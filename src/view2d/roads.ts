import type { RoadClass } from '#sim';
import type { Bounds } from './camera';

// The order and style of the strokes that draw roads on the tactical map.
//
// A paved road is two strokes of its centreline: a wider dark casing and a
// narrower light fill. OpenStreetMap splits one visible road into many ways
// (at junctions, bridges, changes of speed limit or surface, ...), and each way
// is a road of its own here. Drawing each road's casing and fill before the
// next road's would paint the next way's casing, round end cap included, over
// the fill of the way it continues, leaving a dark arc across the road at
// every way boundary and junction. Instead every casing is drawn before any
// fill, so connected ways and crossing roads merge into one network:
//
//   1. tracks and paths (dashed, beneath the roads they join);
//   2. casings: minor roads, then major roads;
//   3. fills: minor roads, then major roads, so a major road runs through its
//      junctions with minor ones.
//
// Fills are opaque and share one colour per class, so where two connected
// ways overlap (round caps against round caps) nothing shows: the result is
// the same as one continuous polyline with round joins. Ways therefore need
// not be merged, and the centrelines are drawn exactly as imported.

/** The style of a road stroke; also the name of its colour on the map. */
export type RoadStrokeStyle =
  'track' | 'path' | 'roadCasing' | 'majorRoadCasing' | 'roadFill' | 'majorRoadFill';

export interface RoadStroke<R> {
  readonly road: R;
  readonly style: RoadStrokeStyle;
  /** Line width in map metres. */
  readonly width: number;
  /** Dash pattern in map metres, or null for a solid line. */
  readonly dash: readonly number[] | null;
}

export interface RoadLike {
  readonly roadClass: RoadClass;
  readonly widthMeters: number;
  readonly bounds: Bounds;
}

/** Width in map metres of a road's fill: its own width, but at least a few pixels. */
function fillWidth(r: RoadLike, mpp: number): number {
  return Math.max(r.widthMeters, (r.roadClass === 'major' ? 4 : 3) * mpp);
}

/** The widest stroke drawn for a road, in map metres. */
function strokeWidth(r: RoadLike, mpp: number): number {
  switch (r.roadClass) {
    case 'path':
      return 1.2 * mpp;
    case 'track':
      return Math.max(r.widthMeters, 1.5 * mpp);
    default:
      return fillWidth(r, mpp) + 2 * mpp;
  }
}

function overlaps(bounds: Bounds, area: Bounds, margin: number): boolean {
  return (
    bounds.minX - margin <= area.maxX &&
    bounds.maxX + margin >= area.minX &&
    bounds.minY - margin <= area.maxY &&
    bounds.maxY + margin >= area.minY
  );
}

/**
 * The strokes that draw the roads reaching `area` (map metres, widened by
 * `margin` for antialiasing) at `mpp` metres per CSS pixel, in drawing order.
 * Within each step, roads keep their order in `roads`.
 */
export function roadStrokes<R extends RoadLike>(
  roads: readonly R[],
  mpp: number,
  area: Bounds,
  margin: number,
): RoadStroke<R>[] {
  const visible = roads.filter((r) => overlaps(r.bounds, area, strokeWidth(r, mpp) / 2 + margin));
  const out: RoadStroke<R>[] = [];
  for (const road of visible) {
    if (road.roadClass === 'path') {
      out.push({ road, style: 'path', width: 1.2 * mpp, dash: [2 * mpp, 3 * mpp] });
    } else if (road.roadClass === 'track') {
      out.push({ road, style: 'track', width: strokeWidth(road, mpp), dash: [6 * mpp, 4 * mpp] });
    }
  }
  const paved = visible.filter((r) => r.roadClass !== 'path' && r.roadClass !== 'track');
  const minor = paved.filter((r) => r.roadClass !== 'major');
  const major = paved.filter((r) => r.roadClass === 'major');
  for (const road of minor) {
    out.push({ road, style: 'roadCasing', width: strokeWidth(road, mpp), dash: null });
  }
  for (const road of major) {
    out.push({ road, style: 'majorRoadCasing', width: strokeWidth(road, mpp), dash: null });
  }
  for (const road of minor) {
    out.push({ road, style: 'roadFill', width: fillWidth(road, mpp), dash: null });
  }
  for (const road of major) {
    out.push({ road, style: 'majorRoadFill', width: fillWidth(road, mpp), dash: null });
  }
  return out;
}
