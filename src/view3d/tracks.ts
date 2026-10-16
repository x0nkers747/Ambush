import { emptyMotionSample, type MotionLog } from '#exercise';

// Tracks (docs/vehicles.md): the path a track runs round its sprocket, road
// wheels and idler, the hull's fit to the ground under its road wheels, and
// how far each track has run, from the motion log. For every tracked
// platform's running gear (`RunningGear`), the M113's by default.

/** A tracked vehicle's running gear (m): what its tracks run round. */
export interface RunningGear {
  readonly length: number;
  readonly width: number;
  /** Track centres apart, and a track's width. */
  readonly trackGauge: number;
  readonly trackWidth: number;
  /** Shoe thickness, and the pitch the shoes are laid at. */
  readonly shoeThickness: number;
  readonly shoePitch: number;
  readonly wheelRadius: number;
  /** Road wheel centres along the hull, and their height with the suspension at rest. */
  readonly wheelsAlong: readonly number[];
  readonly wheelUp: number;
  /** How far a road wheel rises (bump) or drops (rebound) from rest. */
  readonly bump: number;
  readonly rebound: number;
  readonly sprocket: { readonly along: number; readonly up: number; readonly radius: number };
  readonly idler: { readonly along: number; readonly up: number; readonly radius: number };
  /** Return rollers: along the hull, at the top run's height. */
  readonly rollersAlong: readonly number[];
  /** The top run's sag at its middle. */
  readonly sag: number;
}

/** The M113's running gear (as measured for its model). */
export const M113: RunningGear = {
  length: 4.86,
  width: 2.69,
  trackGauge: 2.3,
  trackWidth: 0.38,
  shoeThickness: 0.06,
  shoePitch: 0.153,
  wheelRadius: 0.305,
  wheelsAlong: [-1.37, -0.69, 0, 0.69, 1.37],
  wheelUp: 0.37,
  bump: 0.16,
  rebound: 0.12,
  sprocket: { along: 2.0, up: 0.66, radius: 0.27 },
  idler: { along: -2.02, up: 0.56, radius: 0.27 },
  rollersAlong: [],
  sag: 0.035,
};

/** A point of the side profile (m): `along` forward of the hull's centre, `up` above the ground. */
export interface ProfilePoint {
  readonly along: number;
  readonly up: number;
}

/** Clockwise from north (radians) → the shortest signed turn from `a` to `b`. */
export const turn = (a: number, b: number) => {
  let d = b - a;
  d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
  return d;
};

/**
 * One track's path (a closed loop, counterclockwise seen from the vehicle's
 * left, `along` to the right): over the idler, under each road wheel at its
 * height (`wheelUp`, centres), up round the sprocket, and back along the top.
 */
export function trackPath(wheelUp: readonly number[], gear: RunningGear = M113): ProfilePoint[] {
  const { wheelRadius: r, shoeThickness: t, sprocket, idler, sag } = gear;
  const half = t / 2;
  const points: ProfilePoint[] = [];
  const arc = (c: { along: number; up: number; radius: number }, from: number, to: number) => {
    const R = c.radius + half;
    const steps = Math.max(2, Math.ceil(Math.abs(to - from) / (Math.PI / 10)));
    for (let i = 0; i <= steps; i += 1) {
      const a = from + ((to - from) * i) / steps;
      points.push({ along: c.along + R * Math.cos(a), up: c.up + R * Math.sin(a) });
    }
  };
  const bottoms = gear.wheelsAlong.map((along, i) => ({
    along,
    up: (wheelUp[i] ?? gear.wheelUp) - r - half,
  }));
  const first = bottoms[0] ?? { along: idler.along + 0.6, up: 0 };
  const last = bottoms[bottoms.length - 1] ?? { along: sprocket.along - 0.6, up: 0 };
  /** Where the track leaves a circle for a point below and beyond it (`sign`: −1 the idler, +1 the sprocket). */
  const tangent = (
    c: { along: number; up: number; radius: number },
    p: ProfilePoint,
    sign: number,
  ) => {
    const R = c.radius + half;
    const dx = p.along - c.along;
    const dy = p.up - c.up;
    const d = Math.max(R + 1e-6, Math.hypot(dx, dy));
    return Math.atan2(dy, dx) + sign * Math.acos(R / d);
  };
  // Over the idler: from its top, round the back, to where it leaves for the rear road wheel.
  let leave = tangent(idler, first, -1);
  while (leave < Math.PI / 2) leave += 2 * Math.PI;
  arc(idler, Math.PI / 2, leave);
  for (const b of bottoms) points.push(b);
  // Round the sprocket: from where it meets the front road wheel's run, to its top.
  let meet = tangent(sprocket, last, 1);
  while (meet > Math.PI / 2) meet -= 2 * Math.PI;
  arc(sprocket, meet, Math.PI / 2);
  // The top run, sagging a little between the sprocket and the idler.
  const a = { along: sprocket.along, up: sprocket.up + sprocket.radius + half };
  const b = { along: idler.along, up: idler.up + idler.radius + half };
  const steps = 8;
  for (let i = 1; i < steps; i += 1) {
    const f = i / steps;
    points.push({
      along: a.along + (b.along - a.along) * f,
      up: a.up + (b.up - a.up) * f - sag * 4 * f * (1 - f),
    });
  }
  return points;
}

/** Cumulative lengths along a closed loop of points: `[0, …, perimeter]` (its last back to its first). */
export function loopLengths(points: readonly ProfilePoint[]): number[] {
  const out = [0];
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (!a || !b) continue;
    out.push((out[out.length - 1] ?? 0) + Math.hypot(b.along - a.along, b.up - a.up));
  }
  return out;
}

/** The point and direction `s` along a closed loop (`lengths` from `loopLengths`). */
export function alongLoop(
  points: readonly ProfilePoint[],
  lengths: readonly number[],
  s: number,
  out: { along: number; up: number; dx: number; dy: number },
): void {
  const perimeter = lengths[lengths.length - 1] ?? 0;
  if (perimeter <= 0) return;
  const at = ((s % perimeter) + perimeter) % perimeter;
  let lo = 0;
  let hi = lengths.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((lengths[mid] ?? 0) <= at) lo = mid;
    else hi = mid - 1;
  }
  const a = points[lo];
  const b = points[(lo + 1) % points.length];
  if (!a || !b) return;
  const l0 = lengths[lo] ?? 0;
  const seg = Math.max(1e-9, (lengths[lo + 1] ?? l0) - l0);
  const f = (at - l0) / seg;
  out.along = a.along + (b.along - a.along) * f;
  out.up = a.up + (b.up - a.up) * f;
  out.dx = (b.along - a.along) / seg;
  out.dy = (b.up - a.up) / seg;
}

/**
 * The hull on the ground under its road wheels: the plane (height at the
 * centre, slope along and across) best fitting the ground under the ten
 * wheels (least squares). `ground[side][i]`: side 0 left, 1 right.
 */
export function fitHull(
  ground: readonly (readonly number[])[],
  gear: RunningGear = M113,
): {
  height: number;
  slopeAlong: number;
  slopeAcross: number;
} {
  let n = 0;
  let sh = 0;
  let sa = 0;
  let sc = 0;
  let saa = 0;
  let scc = 0;
  let sha = 0;
  let shc = 0;
  ground.forEach((row, side) => {
    const across = side === 0 ? -gear.trackGauge / 2 : gear.trackGauge / 2;
    row.forEach((h, i) => {
      const along = gear.wheelsAlong[i] ?? 0;
      n += 1;
      sh += h;
      sa += along;
      sc += across;
      saa += along * along;
      scc += across * across;
      sha += h * along;
      shc += h * across;
    });
  });
  if (n === 0) return { height: 0, slopeAlong: 0, slopeAcross: 0 };
  // The wheels are symmetric about the centre: the three fits are independent.
  const ma = sa / n;
  const mc = sc / n;
  const mh = sh / n;
  const va = saa / n - ma * ma;
  const vc = scc / n - mc * mc;
  const slopeAlong = va > 1e-9 ? (sha / n - mh * ma) / va : 0;
  const slopeAcross = vc > 1e-9 ? (shc / n - mh * mc) / vc : 0;
  return { height: mh - slopeAlong * ma - slopeAcross * mc, slopeAlong, slopeAcross };
}

/** How far each track has run (m) by a tick, from the log: its last tick's, carried on as the log is read. */
export interface Travel {
  tick: number;
  left: number;
  right: number;
}

/** The tracks' travel from tick `from` to `to` of vehicle `index` in `log`, added to `t`. */
export function addTravel(
  log: MotionLog,
  index: number,
  from: number,
  to: number,
  t: Travel,
  trackGauge: number = M113.trackGauge,
): void {
  const a = emptyMotionSample();
  const b = emptyMotionSample();
  log.read(index, from, a);
  for (let k = from + 1; k <= to; k += 1) {
    log.read(index, k, b);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    // Forward along the mean heading, and the turn (clockwise positive: the left track runs on).
    const mid = a.azimuth + turn(a.azimuth, b.azimuth) / 2;
    const ds = dx * Math.sin(mid) + dy * Math.cos(mid);
    const dt = turn(a.azimuth, b.azimuth) * (trackGauge / 2);
    t.left += ds + dt;
    t.right += ds - dt;
    a.x = b.x;
    a.y = b.y;
    a.azimuth = b.azimuth;
  }
  t.tick = to;
}
