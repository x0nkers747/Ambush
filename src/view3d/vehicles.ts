import * as THREE from 'three';
import { emptyMotionSample, type MotionLog } from '#exercise';

// Vehicles in 3D (docs/vehicles.md): an M113 armoured personnel carrier, built
// here from simple shapes, posed from the battle's motion log. It sits on the
// ground as a tracked vehicle does: each of its ten road wheels rides the
// ground under it on its own suspension, the hull pitching and rolling to the
// plane that fits them, nosing up as it accelerates and down as it brakes.
// Its tracks are shoes running round the drive sprocket (front), the road
// wheels and the idler (rear), moving as far as the vehicle has driven on
// each side (the outer track faster in a turn, the two in opposite ways as it
// pivots), and the wheels turn with them.

/** A vehicle to show: its motion is the motion log's (its id there). */
export interface ViewVehicle {
  readonly id: string;
  readonly side: 'BLUEFOR' | 'OPFOR';
}

/** A point of the side profile (m): `along` forward of the hull's centre, `up` above the ground. */
export interface ProfilePoint {
  readonly along: number;
  readonly up: number;
}

/** The M113's running gear (m). */
export const M113 = {
  length: 4.86,
  width: 2.69,
  /** Track centres apart, and a track's width. */
  trackGauge: 2.3,
  trackWidth: 0.38,
  /** Shoe thickness, and the pitch the shoes are laid at. */
  shoeThickness: 0.06,
  shoePitch: 0.153,
  wheelRadius: 0.305,
  /** Road wheel centres along the hull, and their height with the suspension at rest. */
  wheelsAlong: [-1.37, -0.69, 0, 0.69, 1.37] as readonly number[],
  wheelUp: 0.37,
  /** How far a road wheel rises (bump) or drops (rebound) from rest. */
  bump: 0.16,
  rebound: 0.12,
  sprocket: { along: 2.0, up: 0.66, radius: 0.27 },
  idler: { along: -2.02, up: 0.56, radius: 0.27 },
  /** The top run's sag at its middle. */
  sag: 0.035,
} as const;

/** Clockwise from north (radians) → the shortest signed turn from `a` to `b`. */
const turn = (a: number, b: number) => {
  let d = b - a;
  d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
  return d;
};

/**
 * One track's path (a closed loop, counterclockwise seen from the vehicle's
 * left, `along` to the right): over the idler, under each road wheel at its
 * height (`wheelUp`, centres), up round the sprocket, and back along the top.
 */
export function trackPath(wheelUp: readonly number[]): ProfilePoint[] {
  const { wheelRadius: r, shoeThickness: t, sprocket, idler, sag } = M113;
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
  const bottoms = M113.wheelsAlong.map((along, i) => ({
    along,
    up: (wheelUp[i] ?? M113.wheelUp) - r - half,
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
export function fitHull(ground: readonly (readonly number[])[]): {
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
    const across = side === 0 ? -M113.trackGauge / 2 : M113.trackGauge / 2;
    row.forEach((h, i) => {
      const along = M113.wheelsAlong[i] ?? 0;
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
interface Travel {
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
    const dt = turn(a.azimuth, b.azimuth) * (M113.trackGauge / 2);
    t.left += ds + dt;
    t.right += ds - dt;
    a.x = b.x;
    a.y = b.y;
    a.azimuth = b.azimuth;
  }
  t.tick = to;
}

const OLIVE: Readonly<Record<ViewVehicle['side'], number>> = {
  BLUEFOR: 0x66703f,
  OPFOR: 0x6f6c4a,
};

/** The hull's side profile, and its upper part (over the tracks, full width). */
const HULL_PROFILE: readonly [number, number][] = [
  [-2.33, 0.45],
  [2.2, 0.45],
  [2.43, 1.05],
  [1.28, 1.83],
  [-2.43, 1.83],
  [-2.43, 0.58],
];
const UPPER_PROFILE: readonly [number, number][] = [
  [-2.43, 1.0],
  [2.41, 1.0],
  [2.43, 1.05],
  [1.28, 1.83],
  [-2.43, 1.83],
];
const LOWER_WIDTH = 1.84;
const UPPER_WIDTH = 2.54;

/** A prism of a side profile (along, up), `width` across, in the model's frame (x right, y up, −z forward). */
function profilePrism(profile: readonly [number, number][], width: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(profile.map(([a, u]) => new THREE.Vector2(a, u)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false });
  // Shape x → along (−z), shape y → up; extrusion z → across, centred.
  g.translate(0, 0, -width / 2);
  g.rotateY(Math.PI / 2);
  // After the turn: shape x points to −z (forward) and the extrusion along −x… across either way.
  g.computeVertexNormals();
  return g;
}

interface VehicleModel {
  readonly root: THREE.Group;
  readonly hull: THREE.Group;
  /** Road wheels, sprockets and idlers, by side (0 left, 1 right). */
  readonly wheels: THREE.Object3D[][];
  readonly sprockets: THREE.Object3D[];
  readonly idlers: THREE.Object3D[];
  readonly shoes: THREE.InstancedMesh;
  readonly shoesPerTrack: number;
  readonly materials: THREE.Material[];
  readonly geometries: THREE.BufferGeometry[];
}

function buildM113(side: ViewVehicle['side']): VehicleModel {
  const geometries: THREE.BufferGeometry[] = [];
  const g = <T extends THREE.BufferGeometry>(x: T): T => {
    geometries.push(x);
    return x;
  };
  const paint = new THREE.MeshStandardMaterial({
    color: OLIVE[side],
    roughness: 0.82,
    metalness: 0.08,
  });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2c2d28, roughness: 0.7, metalness: 0.35 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x1a1a19, roughness: 0.95 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x9fb2b8, roughness: 0.2, metalness: 0.5 });
  const materials = [paint, dark, rubber, glass];
  const mesh = (geometry: THREE.BufferGeometry, material: THREE.Material) => {
    const m = new THREE.Mesh(geometry, material);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };
  /** A box at (across, up, along) in the hull's frame. */
  const box = (
    w: number,
    h: number,
    l: number,
    across: number,
    up: number,
    along: number,
    material = paint,
  ) => {
    const m = mesh(g(new THREE.BoxGeometry(w, h, l)), material);
    m.position.set(across, up, -along);
    return m;
  };

  const root = new THREE.Group();
  const hull = new THREE.Group();
  root.add(hull);
  hull.add(mesh(g(profilePrism(HULL_PROFILE, LOWER_WIDTH)), paint));
  hull.add(mesh(g(profilePrism(UPPER_PROFILE, UPPER_WIDTH)), paint));

  // The trim vane folded on the upper glacis.
  const glacis = Math.atan2(1.83 - 1.05, 2.43 - 1.28);
  const vane = box(2.2, 0.035, 0.95, 0, 0, 0);
  vane.position.set(0, (1.05 + 1.83) / 2 + 0.05, -((1.28 + 2.43) / 2 + 0.03));
  vane.rotation.x = -glacis;
  hull.add(vane);
  // Headlight guards and lamps at the front corners.
  for (const s of [-1, 1]) {
    hull.add(box(0.2, 0.16, 0.12, s * 1.0, 1.22, 2.4));
    hull.add(box(0.12, 0.09, 0.03, s * 1.0, 1.22, 2.47, glass));
  }
  // The exhaust on the right of the glacis.
  hull.add(box(0.16, 0.5, 0.12, 0.95, 1.5, 1.9, dark));
  // The driver's hatch (front left) and its periscopes.
  const hatch = mesh(g(new THREE.CylinderGeometry(0.3, 0.32, 0.12, 16)), paint);
  hatch.position.set(-0.62, 1.89, -1.0);
  hull.add(hatch);
  hull.add(box(0.36, 0.06, 0.06, -0.62, 1.93, 1.27, glass));
  // The commander's cupola, its hatch, and the .50 cal on it.
  const cupola = mesh(g(new THREE.CylinderGeometry(0.4, 0.44, 0.34, 20)), paint);
  cupola.position.set(0.15, 2.0, -0.15);
  hull.add(cupola);
  const lid = mesh(g(new THREE.CylinderGeometry(0.3, 0.3, 0.06, 16)), paint);
  lid.position.set(0.15, 2.2, 0.15);
  lid.rotation.x = -1.2;
  hull.add(lid);
  hull.add(box(0.12, 0.14, 0.55, 0.15, 2.32, 0.2, dark));
  const barrel = mesh(g(new THREE.CylinderGeometry(0.03, 0.03, 1.1, 8)), dark);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0.15, 2.35, -1.0);
  hull.add(barrel);
  // The cargo hatch on the rear deck, and the ramp at the back.
  hull.add(box(1.5, 0.04, 1.45, 0, 1.85, -1.4));
  hull.add(box(1.7, 1.15, 0.05, 0, 1.08, -2.45));
  hull.add(box(0.5, 0.9, 0.03, 0.35, 1.2, -2.48));
  // Fenders' lips along the sides, and grab rails.
  for (const s of [-1, 1]) {
    hull.add(box(0.06, 0.05, 4.7, s * (UPPER_WIDTH / 2 + 0.02), 1.0, 0, dark));
    hull.add(box(0.03, 0.03, 1.6, s * (UPPER_WIDTH / 2 + 0.02), 1.6, -0.6, dark));
  }

  // Road wheels (pairs of rubber-tyred discs), sprockets and idlers.
  const { wheelRadius: r, trackGauge, trackWidth } = M113;
  const wheelGeometry = g(new THREE.CylinderGeometry(r, r, trackWidth * 0.8, 20));
  wheelGeometry.rotateZ(Math.PI / 2);
  const hubGeometry = g(new THREE.CylinderGeometry(r * 0.55, r * 0.55, trackWidth * 0.86, 10));
  hubGeometry.rotateZ(Math.PI / 2);
  const toothGeometry = g(
    new THREE.CylinderGeometry(M113.sprocket.radius, M113.sprocket.radius, trackWidth * 0.5, 10),
  );
  toothGeometry.rotateZ(Math.PI / 2);
  const spokeGeometry = g(new THREE.BoxGeometry(trackWidth * 0.9, 0.05, r * 1.7));
  const wheels: THREE.Object3D[][] = [[], []];
  const sprockets: THREE.Object3D[] = [];
  const idlers: THREE.Object3D[] = [];
  for (const s of [0, 1]) {
    const across = (s === 0 ? -1 : 1) * (trackGauge / 2);
    for (const along of M113.wheelsAlong) {
      const wheel = new THREE.Group();
      wheel.add(mesh(wheelGeometry, rubber));
      wheel.add(mesh(hubGeometry, paint));
      // A spoke, to see it turn.
      wheel.add(mesh(spokeGeometry, dark));
      wheel.position.set(across, M113.wheelUp, -along);
      root.add(wheel);
      wheels[s]?.push(wheel);
    }
    for (const [c, list] of [
      [M113.sprocket, sprockets],
      [M113.idler, idlers],
    ] as const) {
      const w = new THREE.Group();
      w.add(mesh(toothGeometry, dark));
      w.add(mesh(spokeGeometry, paint));
      w.position.set(across, c.up, -c.along);
      root.add(w);
      list.push(w);
    }
  }

  // Track shoes: a plate and its grouser, laid round the path each frame.
  const shoeGeometry = g(
    new THREE.BoxGeometry(trackWidth, M113.shoeThickness, M113.shoePitch * 0.92),
  );
  const rest = trackPath(M113.wheelsAlong.map(() => M113.wheelUp));
  const lengths = loopLengths(rest);
  const shoesPerTrack = Math.round((lengths[lengths.length - 1] ?? 10) / M113.shoePitch);
  const shoes = new THREE.InstancedMesh(shoeGeometry, dark, 2 * shoesPerTrack);
  shoes.castShadow = true;
  shoes.receiveShadow = true;
  shoes.frustumCulled = false;
  root.add(shoes);
  return { root, hull, wheels, sprockets, idlers, shoes, shoesPerTrack, materials, geometries };
}

export interface VehicleLayer {
  readonly group: THREE.Group;
  /**
   * Poses the vehicles at `seconds` of `log` (interpolated between ticks), on
   * the ground `surfaceAt` gives (NaN off the terrain).
   */
  update(
    vehicles: readonly ViewVehicle[],
    log: MotionLog,
    seconds: number,
    surfaceAt: (x: number, y: number) => number,
  ): void;
  dispose(): void;
}

/** Pitch per m/s² of acceleration (rad): the nose lifts as it accelerates, dips as it brakes. */
const SQUAT_RAD = 0.009;

export function createVehicleLayer(): VehicleLayer {
  const group = new THREE.Group();
  group.name = 'vehicles';
  const models = new Map<
    string,
    { model: VehicleModel; side: ViewVehicle['side']; travel: Travel; epoch: number }
  >();
  const a = emptyMotionSample();
  const b = emptyMotionSample();
  const c = emptyMotionSample();
  const d = emptyMotionSample();
  const shoeMatrix = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const pos = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const shoeQ = new THREE.Quaternion();
  const xAxis = new THREE.Vector3(1, 0, 0);
  const at = { along: 0, up: 0, dx: 0, dy: 0 };

  const drop = (id: string) => {
    const m = models.get(id);
    if (!m) return;
    group.remove(m.model.root);
    m.model.shoes.dispose();
    for (const x of m.model.geometries) x.dispose();
    for (const x of m.model.materials) x.dispose();
    models.delete(id);
  };

  /** The pose at `tick + f`: position, heading, and speeds (for the squat), from the log. */
  const pose = (index: number, log: MotionLog, tick: number, f: number) => {
    log.read(index, tick, a);
    log.read(index, tick + 1, b);
    const x = a.x + (b.x - a.x) * f;
    const y = a.y + (b.y - a.y) * f;
    const heading = a.azimuth + turn(a.azimuth, b.azimuth) * f;
    // Acceleration over the last second (forward speed now less a second ago).
    const rate = log.tickRateHz;
    log.read(index, tick - rate, c);
    const speed = (p: typeof a, q2: typeof a, ticks: number) =>
      ((q2.x - p.x) * Math.sin(heading) + (q2.y - p.y) * Math.cos(heading)) * (rate / ticks);
    const now = speed(a, b, 1);
    log.read(index, tick - rate + 1, d);
    const before = speed(c, d, 1);
    const accel = log.firstTick <= tick - rate ? Math.max(-3, Math.min(3, now - before)) : 0;
    return { x, y, heading, accel };
  };

  return {
    group,
    update(vehicles, log, seconds, surfaceAt) {
      const wanted = new Set(vehicles.map((v) => v.id));
      for (const id of [...models.keys()]) if (!wanted.has(id)) drop(id);
      const exact = seconds * log.tickRateHz;
      const tick = Math.max(log.firstTick, Math.min(log.lastTick, Math.floor(exact)));
      const f = Math.max(0, Math.min(1, exact - tick));
      for (const v of vehicles) {
        const index = log.indexOf(v.id);
        let entry = models.get(v.id);
        if (entry?.side !== v.side) {
          drop(v.id);
          entry = undefined;
        }
        if (index < 0 || log.lastTick < log.firstTick) {
          if (entry) entry.model.root.visible = false;
          continue;
        }
        if (!entry) {
          const model = buildM113(v.side);
          group.add(model.root);
          entry = {
            model,
            side: v.side,
            travel: { tick: log.firstTick, left: 0, right: 0 },
            epoch: log.epoch,
          };
          models.set(v.id, entry);
        }
        const { model, travel } = entry;
        model.root.visible = true;
        // The tracks' travel to this tick: carried on, or counted again from the start.
        if (entry.epoch !== log.epoch || tick < travel.tick || travel.tick < log.firstTick) {
          travel.tick = log.firstTick;
          travel.left = 0;
          travel.right = 0;
          entry.epoch = log.epoch;
        }
        if (tick > travel.tick) addTravel(log, index, travel.tick, tick, travel);
        // And on, within the tick.
        log.read(index, tick, a);
        log.read(index, tick + 1, b);
        const mid = a.azimuth + turn(a.azimuth, b.azimuth) / 2;
        const ds = ((b.x - a.x) * Math.sin(mid) + (b.y - a.y) * Math.cos(mid)) * f;
        const dt = turn(a.azimuth, b.azimuth) * f * (M113.trackGauge / 2);
        const left = travel.left + ds + dt;
        const right = travel.right + ds - dt;

        const p = pose(index, log, tick, f);
        const sin = Math.sin(p.heading);
        const cos = Math.cos(p.heading);
        // The ground under each road wheel.
        const ground = [0, 1].map((s) => {
          const across = (s === 0 ? -1 : 1) * (M113.trackGauge / 2);
          return M113.wheelsAlong.map((along) => {
            const gx = p.x + sin * along + cos * across;
            const gy = p.y + cos * along - sin * across;
            const h = surfaceAt(gx, gy);
            return Number.isFinite(h) ? h : surfaceAt(p.x, p.y);
          });
        });
        const fit = fitHull(ground);
        const pitch = Math.atan(fit.slopeAlong) + p.accel * SQUAT_RAD;
        const roll = Math.atan(fit.slopeAcross);
        pos.set(p.x, fit.height, -p.y);
        // Heading about up, then pitch (nose up positive about the right axis), then roll.
        euler.set(pitch, -p.heading, roll, 'YXZ');
        q.setFromEuler(euler);
        model.root.position.copy(pos);
        model.root.quaternion.copy(q);
        model.root.updateMatrixWorld();

        // Each road wheel on its own suspension: down to its ground, within its travel.
        const wheelUp: number[][] = [[], []];
        for (const s of [0, 1]) {
          const across = (s === 0 ? -1 : 1) * (M113.trackGauge / 2);
          const run = s === 0 ? left : right;
          M113.wheelsAlong.forEach((along, i) => {
            const plane = fit.height + fit.slopeAlong * along + fit.slopeAcross * across;
            // Over the ground below the plane's wheel, measured square to the hull (near enough: small angles).
            const offset = Math.max(
              -M113.rebound,
              Math.min(M113.bump, (ground[s]?.[i] ?? plane) - plane),
            );
            const up = M113.wheelUp + offset;
            wheelUp[s]?.push(up);
            const w = model.wheels[s]?.[i];
            if (w) {
              w.position.set(across, up, -along);
              w.rotation.x = -run / M113.wheelRadius;
            }
          });
          const sp = model.sprockets[s];
          if (sp) sp.rotation.x = -run / M113.sprocket.radius;
          const id = model.idlers[s];
          if (id) id.rotation.x = -run / M113.idler.radius;
        }

        // The shoes, laid round each track's path, moved back along it as far as it has run.
        for (const s of [0, 1]) {
          const across = (s === 0 ? -1 : 1) * (M113.trackGauge / 2);
          const path = trackPath(wheelUp[s] ?? []);
          const lengths = loopLengths(path);
          const perimeter = lengths[lengths.length - 1] ?? 0;
          const n = model.shoesPerTrack;
          const pitchM = perimeter / n;
          const run = s === 0 ? left : right;
          for (let k = 0; k < n; k += 1) {
            alongLoop(path, lengths, k * pitchM - run, at);
            // The shoe lies along the path: its length along the tangent, in the hull's frame.
            const angle = Math.atan2(at.dy, at.dx);
            shoeQ.setFromAxisAngle(xAxis, angle);
            pos.set(across, at.up, -at.along);
            shoeMatrix.compose(pos, shoeQ, one);
            model.shoes.setMatrixAt(s * n + k, shoeMatrix);
          }
        }
        model.shoes.instanceMatrix.needsUpdate = true;
      }
    },
    dispose() {
      for (const id of [...models.keys()]) drop(id);
    },
  };
}
