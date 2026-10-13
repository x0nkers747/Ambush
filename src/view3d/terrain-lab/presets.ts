import type { Bridge, EnvironmentFeatures, Vec2 } from '#sim';
import { Cover, levelAt, type Rect, type TerrainField } from '#sim/terrain-lab';

// Viewpoints for the comparisons (stage 2 brief §12), found from the data so
// every battlefield gets its own: deterministic searches over the test area.

export interface Viewpoint {
  readonly id: string;
  readonly label: string;
  readonly mode: 'walk' | 'tactical';
  /** Walk: where one stands. Tactical: the point looked at. */
  readonly x: number;
  readonly y: number;
  /** Degrees clockwise from grid north. */
  readonly heading: number;
  /** Degrees above the horizon (negative: down). */
  readonly pitch: number;
  /** Tactical: distance from the point, metres. */
  readonly distance?: number;
  /** What was found, or why the view stands in for a missing feature. */
  readonly note: string;
}

const deg = (dx: number, dy: number) => ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;

export function findViewpoints(
  field: TerrainField,
  features: EnvironmentFeatures,
  area: Rect,
): Viewpoint[] {
  const cx = (area.minX + area.maxX) / 2;
  const cy = (area.minY + area.maxY) / 2;
  const inside = (x: number, y: number, m = 40) =>
    x > area.minX + m && x < area.maxX - m && y > area.minY + m && y < area.maxY - m;
  const out: Viewpoint[] = [];
  const base = field.base;

  // Distances to roads, buildings and water by the field's own materials.
  const s = {
    h: 0,
    roadEdge: 0,
    roadSurface: 0,
    shore: 0,
    shoreKind: 0,
    building: 0,
    grass: 0,
    soil: 0,
    litter: 0,
    wet: 0,
    urban: 0,
  } as Parameters<TerrainField['sample']>[2];
  const probe = (x: number, y: number) => {
    field.sample(x, y, s);
    return { ...s };
  };

  // 1, 2: a road on the steepest stretch, and its verge.
  let road: {
    x: number;
    y: number;
    dx: number;
    dy: number;
    half: number;
    grade: number;
    note: string;
  } | null = null;
  for (const r of field.roads) {
    if (r.bridge || r.rule.rank < 3) continue;
    const total = r.cum[r.cum.length - 1] ?? 0;
    for (let sAt = 15; sAt + 15 < total; sAt += 10) {
      let seg = 0;
      while (seg < r.cum.length - 2 && (r.cum[seg + 1] ?? 0) < sAt) seg += 1;
      const t =
        (sAt - (r.cum[seg] ?? 0)) / Math.max(1e-9, (r.cum[seg + 1] ?? 0) - (r.cum[seg] ?? 0));
      const ax = r.xy[2 * seg] ?? 0;
      const ay = r.xy[2 * seg + 1] ?? 0;
      const dx = (r.xy[2 * seg + 2] ?? 0) - ax;
      const dy = (r.xy[2 * seg + 3] ?? 0) - ay;
      const x = ax + t * dx;
      const y = ay + t * dy;
      if (!inside(x, y)) continue;
      const grade = Math.abs(levelAt(r, sAt + 10) - levelAt(r, sAt - 10)) / 20;
      // Steep, but a road one can see along: prefer roads away from the edges of the area.
      const score = Math.min(grade, 0.12) - Math.hypot(x - cx, y - cy) / 20000;
      if (!road || score > road.grade) {
        const l = Math.hypot(dx, dy) || 1;
        road = {
          x,
          y,
          dx: dx / l,
          dy: dy / l,
          half: r.half,
          grade: score,
          note: `${r.id}, grade ${(grade * 100).toFixed(1)} %`,
        };
      }
    }
  }
  if (road) {
    out.push({
      id: 'road-along',
      label: 'On a road, looking along it',
      mode: 'walk',
      x: road.x + road.dy * road.half * 0.4,
      y: road.y - road.dx * road.half * 0.4,
      heading: deg(road.dx, road.dy),
      pitch: -4,
      note: road.note,
    });
    const off = road.half + 3.5;
    out.push({
      id: 'road-verge',
      label: 'Across a shoulder and verge',
      mode: 'walk',
      x: road.x - road.dy * off,
      y: road.y + road.dx * off,
      heading: deg(road.dx * 0.8 + road.dy * 0.6, road.dy * 0.8 - road.dx * 0.6),
      pitch: -12,
      note: road.note,
    });
  }

  // 3, 4: buildings.
  let near: { pad: (typeof field.pads)[number]; d: number } | null = null;
  let slope: { pad: (typeof field.pads)[number]; drop: number } | null = null;
  for (const pad of field.pads) {
    const px = (pad.minX + pad.maxX) / 2;
    const py = (pad.minY + pad.maxY) / 2;
    if (!inside(px, py, 30)) continue;
    const area2 = (pad.maxX - pad.minX) * (pad.maxY - pad.minY);
    if (area2 < 60) continue;
    const d = Math.hypot(px - cx, py - cy);
    if (!near || d < near.d) near = { pad, d };
    const hs = [
      base.at(pad.minX, pad.minY),
      base.at(pad.maxX, pad.minY),
      base.at(pad.minX, pad.maxY),
      base.at(pad.maxX, pad.maxY),
    ];
    const drop = Math.max(...hs) - Math.min(...hs);
    if (!slope || drop > slope.drop) slope = { pad, drop };
  }
  if (near) {
    const p = near.pad;
    // The longest wall; stand 2.5 m out from its middle, looking along it.
    let best = { i: 0, l: 0 };
    const n = p.xy.length / 2;
    for (let i = 0; i < n; i += 1) {
      const j = (i + 1) % n;
      const l = Math.hypot(
        (p.xy[2 * j] ?? 0) - (p.xy[2 * i] ?? 0),
        (p.xy[2 * j + 1] ?? 0) - (p.xy[2 * i + 1] ?? 0),
      );
      if (l > best.l) best = { i, l };
    }
    const j = (best.i + 1) % n;
    const ax = p.xy[2 * best.i] ?? 0;
    const ay = p.xy[2 * best.i + 1] ?? 0;
    const dx = ((p.xy[2 * j] ?? 0) - ax) / best.l;
    const dy = ((p.xy[2 * j + 1] ?? 0) - ay) / best.l;
    // Outward normal: away from the centre.
    const mx = ax + dx * best.l * 0.15;
    const my = ay + dy * best.l * 0.15;
    const pcx = (p.minX + p.maxX) / 2;
    const pcy = (p.minY + p.maxY) / 2;
    let nx = dy;
    let ny = -dx;
    if ((mx - pcx) * nx + (my - pcy) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    out.push({
      id: 'building-beside',
      label: 'Beside a building',
      mode: 'walk',
      x: mx + nx * 2.2,
      y: my + ny * 2.2,
      heading: deg(dx * 0.85 - nx * 0.5, dy * 0.85 - ny * 0.5),
      pitch: -6,
      note: p.id,
    });
  }
  if (slope) {
    const p = slope.pad;
    const pcx = (p.minX + p.maxX) / 2;
    const pcy = (p.minY + p.maxY) / 2;
    // Downhill: against the base's gradient.
    const gx = base.at(pcx + 5, pcy) - base.at(pcx - 5, pcy);
    const gy = base.at(pcx, pcy + 5) - base.at(pcx, pcy - 5);
    const l = Math.hypot(gx, gy) || 1;
    const dist = 12 + Math.max(p.maxX - p.minX, p.maxY - p.minY) / 2;
    const x = pcx - (gx / l) * dist;
    const y = pcy - (gy / l) * dist;
    out.push({
      id: 'building-slope',
      label: 'A building on sloping ground',
      mode: 'walk',
      x,
      y,
      heading: deg(pcx - x, pcy - y),
      pitch: 2,
      note: `${p.id}, ${slope.drop.toFixed(1)} m across its corners`,
    });
  }

  // 5: a stream or river bank.
  let stream: { x: number; y: number; dx: number; dy: number; half: number; note: string } | null =
    null;
  for (const c of field.channels) {
    const n = c.xy.length / 2;
    for (let i = 0; i + 1 < n; i += 1) {
      const x = c.xy[2 * i] ?? 0;
      const y = c.xy[2 * i + 1] ?? 0;
      if (!inside(x, y)) continue;
      const d = Math.hypot(x - cx, y - cy);
      if (stream && Math.hypot(stream.x - cx, stream.y - cy) <= d) continue;
      const dx = (c.xy[2 * i + 2] ?? 0) - x;
      const dy = (c.xy[2 * i + 3] ?? 0) - y;
      const l = Math.hypot(dx, dy) || 1;
      stream = { x, y, dx: dx / l, dy: dy / l, half: c.half, note: `${c.id} (${c.kind})` };
    }
  }
  if (stream) {
    const off = stream.half + 2.5;
    out.push({
      id: 'stream',
      label: 'Beside a stream',
      mode: 'walk',
      x: stream.x - stream.dy * off,
      y: stream.y + stream.dx * off,
      heading: deg(stream.dx * 0.9 + stream.dy * 0.4, stream.dy * 0.9 - stream.dx * 0.4),
      pitch: -10,
      note: stream.note,
    });
  }

  // 6: a natural shoreline: a water area's edge, from the bank.
  let shore: { x: number; y: number; tx: number; ty: number; note: string; score: number } | null =
    null;
  for (const w of features.water ?? []) {
    if (w.kind !== 'water' || !field.water?.bodyClass(w.id)) continue;
    const ring = w.boundary;
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      if (!a || !b || !inside(a.x, a.y)) continue;
      const l = Math.hypot(b.x - a.x, b.y - a.y);
      if (l < 8) continue;
      const f = probe((a.x + b.x) / 2, (a.y + b.y) / 2);
      // Natural banks: away from roads and buildings.
      const score =
        Math.min(f.roadEdge, 30) + Math.min(f.building, 30) - Math.hypot(a.x - cx, a.y - cy) / 100;
      if (!shore || score > shore.score)
        shore = {
          x: (a.x + b.x) / 2,
          y: (a.y + b.y) / 2,
          tx: (b.x - a.x) / l,
          ty: (b.y - a.y) / l,
          note: `${w.id} (${field.water.bodyClass(w.id) ?? ''})`,
          score,
        };
    }
  }
  if (shore) {
    // Step out onto land.
    let x = shore.x;
    let y = shore.y;
    for (const side of [1, -1]) {
      const px = shore.x - shore.ty * 3 * side;
      const py = shore.y + shore.tx * 3 * side;
      if (field.water?.at(px, py)?.inWater !== true) {
        x = px;
        y = py;
        break;
      }
    }
    out.push({
      id: 'shoreline',
      label: 'Along a natural shoreline',
      mode: 'walk',
      x,
      y,
      heading: deg(shore.tx, shore.ty),
      pitch: -6,
      note: shore.note,
    });
  }

  // 7: a bridge, from below.
  let bridge: { x: number; y: number; dx: number; dy: number; note: string; d: number } | null =
    null;
  for (const r of field.roads) {
    if (!r.bridge) continue;
    const n = r.xy.length / 2;
    const mid = Math.floor(n / 2);
    const total = r.cum[r.cum.length - 1] ?? 0;
    if (total < 6) continue;
    let seg = 0;
    while (seg < r.cum.length - 2 && (r.cum[seg + 1] ?? 0) < total / 2) seg += 1;
    const t =
      (total / 2 - (r.cum[seg] ?? 0)) / Math.max(1e-9, (r.cum[seg + 1] ?? 0) - (r.cum[seg] ?? 0));
    const x = (r.xy[2 * seg] ?? 0) + t * ((r.xy[2 * seg + 2] ?? 0) - (r.xy[2 * seg] ?? 0));
    const y = (r.xy[2 * seg + 1] ?? 0) + t * ((r.xy[2 * seg + 3] ?? 0) - (r.xy[2 * seg + 1] ?? 0));
    if (!inside(x, y) || mid < 0) continue;
    const dx = (r.xy[2 * seg + 2] ?? 0) - (r.xy[2 * seg] ?? 0);
    const dy = (r.xy[2 * seg + 3] ?? 0) - (r.xy[2 * seg + 1] ?? 0);
    const l = Math.hypot(dx, dy) || 1;
    const d = Math.hypot(x - cx, y - cy) - total;
    if (!bridge || d < bridge.d)
      bridge = { x, y, dx: dx / l, dy: dy / l, note: `${r.id}, ${total.toFixed(0)} m`, d };
  }
  if (bridge) {
    // Along the water (across the bridge), to the first dry ground 8–25 m away.
    let at: Vec2 = { x: bridge.x - bridge.dy * 12, y: bridge.y + bridge.dx * 12 };
    for (let k = 8; k <= 25; k += 1) {
      for (const side of [1, -1]) {
        const px = bridge.x - bridge.dy * k * side + bridge.dx * 3;
        const py = bridge.y + bridge.dx * k * side + bridge.dy * 3;
        const f = probe(px, py);
        if (f.shore > 0.5 && f.roadEdge > 1) {
          at = { x: px, y: py };
          k = 99;
          break;
        }
      }
    }
    out.push({
      id: 'bridge-below',
      label: 'A bridge from below',
      mode: 'walk',
      x: at.x,
      y: at.y,
      heading: deg(bridge.x - at.x, bridge.y - at.y),
      pitch: 6,
      note: bridge.note,
    });
  }

  // 8, 9, 10: open grassland, inside a wood, and the steepest natural slope, on a 10 m grid.
  let open: { x: number; y: number; score: number } | null = null;
  let wood: { x: number; y: number; score: number } | null = null;
  let steep: { x: number; y: number; g: number; gx: number; gy: number } | null = null;
  for (let x = area.minX + 40; x < area.maxX - 40; x += 10)
    for (let y = area.minY + 40; y < area.maxY - 40; y += 10) {
      const c = field.cover.at(x, y);
      const f = probe(x, y);
      const clear =
        Math.min(f.roadEdge, 40) + Math.min(f.building, 8) * 3 + Math.min(Math.abs(f.shore), 40);
      if (c === Cover.Meadow || c === Cover.Open || c === Cover.Farmland || c === Cover.Military) {
        let ring = 0;
        for (const [ox, oy] of [
          [25, 0],
          [-25, 0],
          [0, 25],
          [0, -25],
        ] as const) {
          const cc = field.cover.at(x + ox, y + oy);
          if (cc === c) ring += 1;
        }
        const score = clear + ring * 10;
        if (!open || score > open.score) open = { x, y, score };
      }
      if (c === Cover.Woodland) {
        let ring = 0;
        for (const r of [15, 30])
          for (const [ox, oy] of [
            [r, 0],
            [-r, 0],
            [0, r],
            [0, -r],
          ] as const)
            if (field.cover.at(x + ox, y + oy) === Cover.Woodland) ring += 1;
        const score = ring * 10 + Math.min(f.roadEdge, 20) - Math.hypot(x - cx, y - cy) / 100;
        if (!wood || score > wood.score) wood = { x, y, score };
      }
      if (f.roadEdge > 15 && f.building > 8 && Math.abs(f.shore) > 10) {
        const gx = (base.at(x + 5, y) - base.at(x - 5, y)) / 10;
        const gy = (base.at(x, y + 5) - base.at(x, y - 5)) / 10;
        const g = Math.hypot(gx, gy);
        if (!steep || g > steep.g) steep = { x, y, g, gx, gy };
      }
    }
  if (open)
    out.push({
      id: 'grassland',
      label: 'Across open grassland',
      mode: 'walk',
      x: open.x,
      y: open.y,
      heading: deg(cx - open.x, cy - open.y),
      pitch: -3,
      note: `cover ${String(field.cover.at(open.x, open.y))}`,
    });
  if (wood)
    out.push({
      id: 'woods',
      label: 'Inside a wood',
      mode: 'walk',
      x: wood.x,
      y: wood.y,
      heading: 35,
      pitch: -5,
      note: 'woodland cover',
    });
  if (steep) {
    const l = steep.g || 1;
    const x = steep.x - (steep.gx / l) * 14;
    const y = steep.y - (steep.gy / l) * 14;
    out.push({
      id: 'steep-slope',
      label: 'Up a steep slope',
      mode: 'walk',
      x,
      y,
      heading: deg(steep.gx, steep.gy),
      pitch: Math.min(25, 4 + (Math.atan(steep.g) * 180) / Math.PI),
      note: `${((Math.atan(steep.g) * 180) / Math.PI).toFixed(0)}° over 10 m`,
    });
  }
  out.push({
    id: 'tactical',
    label: 'Medium-altitude tactical view',
    mode: 'tactical',
    x: road?.x ?? cx,
    y: road?.y ?? cy,
    heading: 30,
    pitch: -35,
    distance: 320,
    note: 'centred on the road view',
  });
  const b = field.bounds;
  out.push({
    id: 'overview',
    label: 'High-altitude overview',
    mode: 'tactical',
    x: (b.minX + b.maxX) / 2,
    y: (b.minY + b.maxY) / 2,
    heading: 0,
    pitch: -52,
    distance: 6200,
    note: 'whole battlefield',
  });
  return out;
}

/**
 * A bridge seen from below: the planned bridge over the most water near the
 * area's centre, from dry ground beside the water 10–30 m off its middle.
 */
export function bridgeViewpoint(
  field: TerrainField,
  bridges: readonly Bridge[],
  area: Rect,
): Viewpoint | null {
  const cx = (area.minX + area.maxX) / 2;
  const cy = (area.minY + area.maxY) / 2;
  let best: { b: Bridge; score: number; i: number } | null = null;
  for (const b of bridges) {
    const wet = b.wet.filter(Boolean).length;
    if (wet < 3) continue;
    const i = b.wet.findIndex(Boolean) + Math.floor(wet / 2);
    const x = b.xy[2 * i] ?? 0;
    const y = b.xy[2 * i + 1] ?? 0;
    if (x < area.minX || x > area.maxX || y < area.minY || y > area.maxY) continue;
    const score = Math.min(wet, 40) - Math.hypot(x - cx, y - cy) / 50;
    if (!best || score > best.score) best = { b, score, i };
  }
  if (!best) return null;
  const { b, i } = best;
  const x = b.xy[2 * i] ?? 0;
  const y = b.xy[2 * i + 1] ?? 0;
  const j = Math.min(b.xy.length / 2 - 1, i + 1);
  const dx = (b.xy[2 * j] ?? 0) - x;
  const dy = (b.xy[2 * j + 1] ?? 0) - y;
  const l = Math.hypot(dx, dy) || 1;
  const s = {
    h: 0,
    roadEdge: 0,
    roadSurface: 0,
    shore: 0,
    shoreKind: 0,
    building: 0,
    grass: 0,
    soil: 0,
    litter: 0,
    wet: 0,
    urban: 0,
  } as Parameters<TerrainField['sample']>[2];
  for (let k = 18; k <= 45; k += 1)
    for (const side of [1, -1])
      for (const along of [0, 8, -8, 16, -16]) {
        const px = x - (dy / l) * k * side + (dx / l) * along;
        const py = y + (dx / l) * k * side + (dy / l) * along;
        field.sample(px, py, s);
        if (s.shore > 0.8 && s.shore < 6 && s.roadEdge > 1.5 && s.building > 2)
          return {
            id: 'bridge-below',
            label: 'A bridge from below',
            mode: 'walk',
            x: px,
            y: py,
            heading: deg(x - px, y - py),
            pitch: 3,
            note: `${b.id} (${b.style}, ${String(b.wet.filter(Boolean).length)} m over water, deck ${(b.deck[i] ?? 0).toFixed(1)} m)`,
          };
      }
  return null;
}
