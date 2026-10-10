import { isSimplePolygon, pointInPolygon, polygonArea, type Vec2 } from '#sim';
import { clipPolyline, dedupe, joinAlongEdge, onEdge, signedArea, type Rect } from './clip';
import type { LatLon } from './utm';

// The sea from OpenStreetMap coastlines (docs/adr/0014). OSM does not map the
// sea as areas: it maps the shore as `natural=coastline` ways, drawn with the
// land on their left and the water on their right, and leaves the sea to be
// filled in. Here the coastline ways are joined in drawing order, clipped to
// the battlefield, reversed (so the sea is on their left) and closed along
// the battlefield's edge, as polygon outlines are when clipped. Islands
// (coastline rings drawn counter-clockwise, entirely inside) become holes.
// A battlefield no coastline reaches is all land. Broken coastline data
// (a coastline that ends inside the battlefield) gives no sea rather than a
// wrong one.

const key = (p: LatLon) => `${String(p.lat)},${String(p.lon)}`;

/**
 * Joins coastline ways end to start, as they are drawn (a coastline's
 * direction matters: the land is on its left). A way that closes on itself
 * stays a closed ring (first point repeated at the end).
 */
export function joinCoastlines(ways: readonly (readonly LatLon[])[]): LatLon[][] {
  const pending = ways.filter((w) => w.length >= 2).map((w) => [...w]);
  const chains: LatLon[][] = [];
  const closedRing = (c: readonly LatLon[]) =>
    c.length >= 4 &&
    key(c[0] ?? { lat: NaN, lon: NaN }) === key(c[c.length - 1] ?? { lat: NaN, lon: NaN });
  while (pending.length > 0) {
    const chain = pending.shift() ?? [];
    let grew = true;
    while (grew && !closedRing(chain)) {
      grew = false;
      const end = key(chain[chain.length - 1] ?? { lat: NaN, lon: NaN });
      const start = key(chain[0] ?? { lat: NaN, lon: NaN });
      for (let i = 0; i < pending.length; i += 1) {
        const w = pending[i] ?? [];
        if (key(w[0] ?? { lat: NaN, lon: NaN }) === end) chain.push(...w.slice(1));
        else if (key(w[w.length - 1] ?? { lat: NaN, lon: NaN }) === start)
          chain.unshift(...w.slice(0, -1));
        else continue;
        pending.splice(i, 1);
        grew = true;
        break;
      }
    }
    chains.push(chain);
  }
  return chains;
}

/** A sea area in local metres: its outline and its islands. */
export interface SeaArea {
  readonly boundary: Vec2[];
  readonly holes: Vec2[][];
}

/**
 * The sea inside the rectangle, from joined coastlines in local metres. With
 * `problem` set (the coastline data is broken) there is no sea.
 */
export function seaFromCoastlines(
  chains: readonly (readonly Vec2[])[],
  r: Rect,
): { readonly areas: SeaArea[]; readonly problem: string | null } {
  const inside = (p: Vec2) => p.x > r.minX && p.x < r.maxX && p.y > r.minY && p.y < r.maxY;
  /** Coastline pieces crossing the battlefield, each from edge to edge, the sea on their left. */
  const pieces: Vec2[][] = [];
  /** Coastline rings entirely inside: islands (land inside) and lagoons (sea inside). */
  const islands: Vec2[][] = [];
  const lagoons: Vec2[][] = [];
  let broken = 0;
  for (const chain of chains) {
    const first = chain[0];
    const last = chain[chain.length - 1];
    const closed =
      chain.length >= 4 && !!first && !!last && first.x === last.x && first.y === last.y;
    let line: readonly Vec2[] = chain;
    if (closed) {
      const ring = chain.slice(0, -1);
      const outside = ring.findIndex((p) => !inside(p) && !onEdge(p, r));
      if (outside < 0) {
        const loop = dedupe(ring);
        if (loop.length >= 3 && Math.abs(signedArea(loop)) >= 1) {
          if (signedArea(loop) > 0) islands.push(loop);
          else lagoons.push([...loop].reverse());
        }
        continue;
      }
      // Start outside, so no piece is cut in two at the ring's join.
      const rotated = [...ring.slice(outside), ...ring.slice(0, outside)];
      line = [...rotated, rotated[0] ?? { x: 0, y: 0 }];
    }
    for (const piece of clipPolyline(line, r)) {
      const a = piece[0];
      const b = piece[piece.length - 1];
      if (!a || !b || !onEdge(a, r) || !onEdge(b, r)) broken += 1;
      else pieces.push([...piece].reverse());
    }
  }
  if (broken > 0) {
    return {
      areas: [],
      problem: `${String(broken)} coastline piece(s) end inside the battlefield (incomplete data), so the sea is not drawn`,
    };
  }

  const outlines =
    pieces.length > 0
      ? joinAlongEdge(pieces, r)
      : islands.length > 0
        ? // Islands and no shore crossing the battlefield: all of it is sea, but the islands.
          [
            [
              { x: r.minX, y: r.minY },
              { x: r.maxX, y: r.minY },
              { x: r.maxX, y: r.maxY },
              { x: r.minX, y: r.maxY },
            ],
          ]
        : [];
  const areas: SeaArea[] = [];
  let invalid = 0;
  for (const boundary of [...outlines, ...lagoons]) {
    if (polygonArea(boundary) < 1) continue;
    if (!isSimplePolygon(boundary)) {
      invalid += 1;
      continue;
    }
    const holes = islands.filter(
      (island) => isSimplePolygon(island) && island.every((p) => pointInPolygon(p, boundary)),
    );
    areas.push({ boundary, holes });
  }
  return {
    areas,
    problem:
      invalid > 0
        ? `${String(invalid)} sea area(s) with a self-intersecting coastline were left out`
        : null,
  };
}
