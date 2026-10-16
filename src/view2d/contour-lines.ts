// Contour lines for drawing (render.ts): the traced segments of a level
// (`contourLines`, two points each, in triangle order) joined into lines, and
// the lines simplified for coarser zooms. Stroked as separate two-point
// segments, a battlefield's contours were hundreds of thousands of tiny
// subpaths, which took the browser most of a second to rasterize on the
// whole-map view; joined and simplified to what a pixel can show, they are a
// small fraction of that.

/** Endpoints closer than this (metres) are the same point (a crossing traced from either side of an edge). */
const JOIN_M = 1e-3;

/**
 * The segments of one contour level (flat: x1, y1, x2, y2, …) joined into
 * lines where they share an endpoint: each line a flat array of points
 * (x, y, …), closed rings ending on their first point. Every segment is in
 * exactly one line. Deterministic: lines start from the earliest unused
 * segment, extended forwards then backwards.
 */
export function joinSegments(segments: readonly number[]): number[][] {
  const n = Math.floor(segments.length / 4);
  const key = (x: number, y: number) =>
    `${String(Math.round(x / JOIN_M))},${String(Math.round(y / JOIN_M))}`;
  // Endpoint → segments ending there (as segment * 2 + end).
  const at = new Map<string, number[]>();
  for (let s = 0; s < n; s += 1) {
    for (let end = 0; end < 2; end += 1) {
      const k = key(segments[4 * s + 2 * end] ?? 0, segments[4 * s + 2 * end + 1] ?? 0);
      const list = at.get(k);
      if (list) list.push(2 * s + end);
      else at.set(k, [2 * s + end]);
    }
  }
  const used = new Uint8Array(n);
  /** The next unused segment from the point (x, y), and its far end, or null. */
  const next = (x: number, y: number): { s: number; far: number } | null => {
    for (const e of at.get(key(x, y)) ?? []) {
      const s = e >> 1;
      if (!used[s]) return { s, far: 1 - (e & 1) };
    }
    return null;
  };
  const point = (s: number, end: number): [number, number] => [
    segments[4 * s + 2 * end] ?? 0,
    segments[4 * s + 2 * end + 1] ?? 0,
  ];
  const lines: number[][] = [];
  for (let first = 0; first < n; first += 1) {
    if (used[first]) continue;
    used[first] = 1;
    const forward: number[] = [...point(first, 0), ...point(first, 1)];
    for (let step = next(...point(first, 1)); step;) {
      used[step.s] = 1;
      const [x, y] = point(step.s, step.far);
      forward.push(x, y);
      step = next(x, y);
    }
    const backward: number[] = [];
    for (let step = next(...point(first, 0)); step;) {
      used[step.s] = 1;
      const [x, y] = point(step.s, step.far);
      backward.push(y, x);
      step = next(x, y);
    }
    backward.reverse();
    lines.push(backward.length > 0 ? [...backward, ...forward] : forward);
  }
  return lines;
}

/**
 * A line (flat points) simplified by Douglas–Peucker: the fewest of its
 * points that keep it within `tolerance` metres of the original. Its ends
 * are kept (so a closed ring stays closed).
 */
export function simplifyLine(line: readonly number[], tolerance: number): number[] {
  const count = line.length / 2;
  if (tolerance <= 0 || count <= 2) return [...line];
  const keep = new Uint8Array(count);
  keep[0] = 1;
  keep[count - 1] = 1;
  const stack: number[] = [0, count - 1];
  const t2 = tolerance * tolerance;
  while (stack.length > 0) {
    const j = stack.pop() ?? 0;
    const i = stack.pop() ?? 0;
    const ax = line[2 * i] ?? 0;
    const ay = line[2 * i + 1] ?? 0;
    const dx = (line[2 * j] ?? 0) - ax;
    const dy = (line[2 * j + 1] ?? 0) - ay;
    const l2 = dx * dx + dy * dy;
    let worst = -1;
    let far = t2;
    for (let k = i + 1; k < j; k += 1) {
      const px = (line[2 * k] ?? 0) - ax;
      const py = (line[2 * k + 1] ?? 0) - ay;
      const t = l2 > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / l2)) : 0;
      const ex = px - t * dx;
      const ey = py - t * dy;
      const d2 = ex * ex + ey * ey;
      if (d2 > far) {
        far = d2;
        worst = k;
      }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push(i, worst, worst, j);
    }
  }
  const out: number[] = [];
  for (let k = 0; k < count; k += 1) if (keep[k]) out.push(line[2 * k] ?? 0, line[2 * k + 1] ?? 0);
  return out;
}
