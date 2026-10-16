import { surfaceHeightAt } from './bridge-navigation';
import type { SimEvent } from './events';
import { azimuthOf, normalizeAzimuth, type Vec2 } from './geometry';
import { isSegmentWalkable, planPath } from './navigation';
import { pointInPolygon } from './polygon';
import { roadNetwork, roadPointAt } from './road-network';
import type { Side, SimState } from './state';
import { heightAt, isOnTerrain, type TerrainDataset } from './terrain';
import type { SimWorld } from './world';

// Vehicles (prototype, docs/vehicles.md): a tracked armoured personnel
// carrier (an M113) driving from waypoint to waypoint. Each order's route is
// planned like a soldier's (round buildings and water, through woods); the
// vehicle steers along it as a tracked vehicle does: it pivots on the spot to
// face a turn it cannot drive round, steers otherwise at a rate its speed
// allows, accelerates to the speed the ground allows (a road, open ground,
// woods; slower uphill), slows for bends, and brakes to stop on its waypoint.
// No crew, no weapons, not seen or shot at: it drives.

/** A vehicle type's driving characteristics. */
export interface VehicleType {
  /** Top speeds (m/s): on a paved road, on a dirt track or open ground, in woods. */
  readonly roadSpeed: number;
  readonly openSpeed: number;
  readonly woodsSpeed: number;
  /** Accelerating and braking (m/s²). */
  readonly accel: number;
  readonly decel: number;
  /** Turning on the spot (rad/s), and the most sideways acceleration in a turn (m/s²). */
  readonly pivotRate: number;
  readonly lateralAccel: number;
  /** The fastest it turns at speed (rad/s). */
  readonly maxTurnRate: number;
  /** Hull length and width (m): for drawing, and how close to a point is "there". */
  readonly length: number;
  readonly width: number;
}

export type VehicleKind = 'm113';

export const VEHICLE_TYPES: Readonly<Record<VehicleKind, VehicleType>> = {
  // M113A2/A3: about 64 km/h on roads, 30–40 km/h across country; 4.86 × 2.69 m.
  m113: {
    roadSpeed: 14,
    openSpeed: 8.5,
    woodsSpeed: 2.8,
    accel: 1.2,
    decel: 2.5,
    pivotRate: (35 * Math.PI) / 180,
    lateralAccel: 2.5,
    maxTurnRate: (40 * Math.PI) / 180,
    length: 4.86,
    width: 2.69,
  },
};

/** Where a vehicle is sent: a point, and whether it prefers the roads on the way. */
export interface VehicleDestination {
  readonly x: number;
  readonly y: number;
  /** Prefer roads: by the roads when they help (`roadsRoute`). */
  readonly followRoads?: boolean;
}

/** A vehicle's move order (plain data in the state). */
export interface VehicleOrder {
  readonly id: string;
  readonly destination: Vec2;
  /** Prefer roads (absent: it does not). */
  readonly followRoads?: true;
  status: 'pending' | 'active' | 'completed' | 'failed' | 'superseded' | 'canceled';
  reason: string | null;
}

/** A vehicle (plain data in the state). */
export interface VehicleState {
  readonly id: string;
  readonly name: string;
  readonly side: Side;
  readonly kind: VehicleKind;
  position: { x: number; y: number; z: number };
  /** Radians clockwise from grid north. */
  heading: number;
  /** Forward speed (m/s). */
  speed: number;
  orders: VehicleOrder[];
  nextOrder: number;
  /** The active order's route: the points to drive through, its destination last. */
  route: Vec2[];
  routeIndex: number;
}

/** A vehicle as a scenario gives it. */
export interface ScenarioVehicle {
  readonly id: string;
  readonly name: string;
  readonly side: Side;
  readonly kind: VehicleKind;
  readonly position: Vec2;
  readonly headingDeg: number;
  /** Its move orders, in turn. */
  readonly destinations: readonly VehicleDestination[];
}

/** Gives vehicles move orders: `replace` drops the pending and active ones (it stops, then goes on). */
export interface OrderVehicleCommand {
  readonly type: 'orderVehicle';
  readonly tick: number;
  readonly vehicleId: string;
  readonly mode: 'replace' | 'append';
  readonly destinations: readonly VehicleDestination[];
}

/** Within this of its destination (m), slow enough, a vehicle has arrived. */
const ARRIVED_M = 1.5;
/** Passing a turn of its route within this (m), it steers for the next. */
const TURN_REACHED_M = 2.5;
/** A soldier's route turns close round a corner: a vehicle's is pushed this much further out (m). */
const CORNER_OFFSET_M = 3;
/** Facing further off than this from where it must go, nearly stopped, it pivots on the spot. */
const PIVOT_FROM_RAD = (50 * Math.PI) / 180;
/** Speed through a sharp bend (m/s), and the bend's angle from which it is sharp. */
const BEND_SPEED = 3;
const SHARP_BEND_RAD = (60 * Math.PI) / 180;

/** The initial vehicles of a scenario, as state. */
export function initialVehicles(
  terrain: TerrainDataset,
  vehicles: readonly ScenarioVehicle[],
): VehicleState[] {
  return vehicles.map((v) => ({
    id: v.id,
    name: v.name,
    side: v.side,
    kind: v.kind,
    position: {
      x: v.position.x,
      y: v.position.y,
      z: surfaceHeightAt(terrain, v.position.x, v.position.y),
    },
    heading: normalizeAzimuth((v.headingDeg * Math.PI) / 180),
    speed: 0,
    orders: v.destinations.map((d, k) => ({
      id: `${v.id}#${String(k + 1)}`,
      destination: { x: d.x, y: d.y },
      ...(d.followRoads === true ? { followRoads: true as const } : {}),
      status: 'pending',
      reason: null,
    })),
    nextOrder: v.destinations.length + 1,
    route: [],
    routeIndex: 0,
  }));
}

/** Applies an `orderVehicle` command. */
export function applyOrderVehicle(
  state: SimState,
  world: SimWorld,
  command: OrderVehicleCommand,
  events: SimEvent[],
): void {
  const vehicle = state.vehicles?.find((v) => v.id === command.vehicleId);
  if (!vehicle) {
    events.push({ type: 'commandRejected', tick: state.tick, command, reason: 'unknownVehicle' });
    return;
  }
  if (command.destinations.some((d) => !isOnTerrain(world.terrain, d.x, d.y))) {
    events.push({
      type: 'commandRejected',
      tick: state.tick,
      command,
      reason: 'destinationOffTerrain',
    });
    return;
  }
  if (command.mode === 'replace') {
    for (const o of vehicle.orders) {
      if (o.status === 'active' || o.status === 'pending') {
        o.status = command.destinations.length === 0 ? 'canceled' : 'superseded';
        o.reason = 'replaced by new orders';
      }
    }
    vehicle.route = [];
    vehicle.routeIndex = 0;
  }
  for (const d of command.destinations) {
    vehicle.orders.push({
      id: `${vehicle.id}#${String(vehicle.nextOrder)}`,
      destination: { x: d.x, y: d.y },
      ...(d.followRoads === true ? { followRoads: true as const } : {}),
      status: 'pending',
      reason: null,
    });
    vehicle.nextOrder += 1;
  }
}

/** The vehicle's active order, or `undefined`. */
export function activeVehicleOrder(v: {
  readonly orders: readonly VehicleOrder[];
}): VehicleOrder | undefined {
  return v.orders.find((o) => o.status === 'active');
}

/** Moves every vehicle by one tick. */
export function updateVehicles(state: SimState, world: SimWorld, dt: number): void {
  const vehicles = state.vehicles;
  if (!vehicles) return;
  for (const v of vehicles) drive(v, world.terrain, dt);
}

function startNext(v: VehicleState, terrain: TerrainDataset): void {
  while (!activeVehicleOrder(v)) {
    const next = v.orders.find((o) => o.status === 'pending');
    if (!next) return;
    const from = { x: v.position.x, y: v.position.y };
    const path = planPath(terrain, from, next.destination, {
      followRoads: next.followRoads === true,
    });
    if (!path.ok) {
      next.status = 'failed';
      next.reason = 'no way there';
      continue;
    }
    next.status = 'active';
    v.route = widenTurns(terrain, from, [
      ...path.turns.map((p) => ({ x: p.x, y: p.y })),
      { ...next.destination },
    ]);
    v.routeIndex = 0;
  }
}

/**
 * The route's turns pushed out from the inside of each bend (where the corner
 * it turns round is) by `CORNER_OFFSET_M`, so the hull clears it; a turn is
 * left where it was if the push would take it, or the legs to it, into an obstacle.
 */
function widenTurns(terrain: TerrainDataset, from: Vec2, route: Vec2[]): Vec2[] {
  const out = route.map((p) => ({ ...p }));
  for (let i = 0; i < out.length - 1; i += 1) {
    const a = out[i - 1] ?? from;
    const b = out[i];
    const c = out[i + 1];
    if (!b || !c) continue;
    const la = Math.hypot(b.x - a.x, b.y - a.y);
    const lc = Math.hypot(c.x - b.x, c.y - b.y);
    if (la < 1e-6 || lc < 1e-6) continue;
    // In minus out: points away from the inside of the bend.
    const nx = (b.x - a.x) / la - (c.x - b.x) / lc;
    const ny = (b.y - a.y) / la - (c.y - b.y) / lc;
    const n = Math.hypot(nx, ny);
    if (n < 1e-6) continue;
    const q = { x: b.x + (nx / n) * CORNER_OFFSET_M, y: b.y + (ny / n) * CORNER_OFFSET_M };
    if (isSegmentWalkable(terrain, a, q) && isSegmentWalkable(terrain, q, c)) out[i] = q;
  }
  return out;
}

/** The angle (rad, 0–π) the route bends by at its point `i`. */
function bendAt(route: readonly Vec2[], i: number, from: Vec2): number {
  const a = route[i - 1] ?? from;
  const b = route[i];
  const c = route[i + 1];
  if (!b || !c) return 0;
  let d = azimuthOf(c.x - b.x, c.y - b.y) - azimuthOf(b.x - a.x, b.y - a.y);
  d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
  return Math.abs(d);
}

function drive(v: VehicleState, terrain: TerrainDataset, dt: number): void {
  const type = VEHICLE_TYPES[v.kind];
  startNext(v, terrain);
  const order = activeVehicleOrder(v);
  const here = { x: v.position.x, y: v.position.y };
  let wanted = 0;
  let turn = 0;
  if (order) {
    // Passing a turn of the route, it steers for the next.
    while (v.routeIndex < v.route.length - 1) {
      const p = v.route[v.routeIndex];
      if (!p || Math.hypot(p.x - here.x, p.y - here.y) > TURN_REACHED_M) break;
      v.routeIndex += 1;
    }
    // Passing its destination with another order to follow, it drives on to that one.
    const next = v.orders.find((o) => o.status === 'pending');
    const destination = v.route[v.route.length - 1] ?? order.destination;
    if (
      next &&
      v.routeIndex >= v.route.length - 1 &&
      Math.hypot(destination.x - here.x, destination.y - here.y) <= TURN_REACHED_M
    ) {
      order.status = 'completed';
      order.reason = 'arrived';
      v.route = [];
      v.routeIndex = 0;
      startNext(v, terrain);
    }
  }
  const current = activeVehicleOrder(v);
  if (current) {
    // What is ahead: this order's route, then the later orders' destinations (their routes are planned when reached).
    const ahead: Vec2[] = [
      ...v.route,
      ...v.orders.filter((o) => o.status === 'pending').map((o) => o.destination),
    ];
    const target = v.route[v.routeIndex] ?? current.destination;
    const last = v.routeIndex >= ahead.length - 1;
    const dx = target.x - here.x;
    const dy = target.y - here.y;
    const toTarget = Math.hypot(dx, dy);
    let toEnd = toTarget;
    for (let i = v.routeIndex; i < ahead.length - 1; i += 1) {
      const a = ahead[i];
      const b = ahead[i + 1];
      if (a && b) toEnd += Math.hypot(b.x - a.x, b.y - a.y);
    }
    if (last && toTarget < ARRIVED_M && v.speed < 0.6) {
      current.status = 'completed';
      current.reason = 'arrived';
      v.route = [];
      v.routeIndex = 0;
    } else {
      let error = azimuthOf(dx, dy) - v.heading;
      error -= 2 * Math.PI * Math.round(error / (2 * Math.PI));
      if (Math.abs(error) > PIVOT_FROM_RAD && v.speed < 1) {
        // Facing well away: stop and pivot on the spot.
        wanted = 0;
        turn = Math.sign(error) * Math.min(Math.abs(error), type.pivotRate * dt);
      } else {
        const rate = Math.min(type.maxTurnRate, type.lateralAccel / Math.max(v.speed, 0.5));
        turn = Math.sign(error) * Math.min(Math.abs(error), rate * dt);
        // The ground's speed; slower while still turning toward the way on.
        wanted = groundSpeed(terrain, type, here.x, here.y, v.heading);
        if (Math.abs(error) > 0.35) wanted = Math.min(wanted, BEND_SPEED);
        // Slow enough to take the next bend, and to stop at the end.
        const bend = last ? 0 : bendAt(ahead, v.routeIndex, here);
        if (bend > 0.2) {
          const share = Math.min(1, bend / SHARP_BEND_RAD);
          const at = Math.max(BEND_SPEED, wanted * (1 - share) + BEND_SPEED * share);
          wanted = Math.min(wanted, Math.sqrt(at * at + 2 * type.decel * 0.8 * toTarget));
        }
        wanted = Math.min(wanted, Math.sqrt(2 * type.decel * 0.8 * Math.max(0, toEnd - 0.5)));
      }
    }
  }
  // Speed toward what is wanted, within its acceleration and braking.
  const dv = wanted - v.speed;
  v.speed += dv > 0 ? Math.min(dv, type.accel * dt) : Math.max(dv, -type.decel * dt);
  if (v.speed < 1e-3 && wanted === 0) v.speed = 0;
  v.heading = normalizeAzimuth(v.heading + turn);
  const step = v.speed * dt;
  if (step > 0) {
    const x = v.position.x + Math.sin(v.heading) * step;
    const y = v.position.y + Math.cos(v.heading) * step;
    if (isOnTerrain(terrain, x, y)) {
      v.position.x = x;
      v.position.y = y;
    } else v.speed = 0;
  }
  v.position.z = surfaceHeightAt(terrain, v.position.x, v.position.y);
}

/** Ground cells of `GROUND_CELL_M`, remembered per terrain: 0 open, 1 woods, 2 a paved road, 3 a track. */
const GROUND_CELL_M = 6;
const groundCache = new WeakMap<TerrainDataset, Map<number, number>>();

function groundAt(terrain: TerrainDataset, x: number, y: number): number {
  let cells = groundCache.get(terrain);
  if (!cells) {
    cells = new Map();
    groundCache.set(terrain, cells);
  }
  const cx = Math.floor(x / GROUND_CELL_M);
  const cy = Math.floor(y / GROUND_CELL_M);
  const key = cx * 100_003 + cy;
  const known = cells.get(key);
  if (known !== undefined) return known;
  const p = { x: (cx + 0.5) * GROUND_CELL_M, y: (cy + 0.5) * GROUND_CELL_M };
  let kind = 0;
  const on = roadPointAt(terrain, p);
  if (on) {
    const net = roadNetwork(terrain);
    const edge = net.edges[on.edge];
    const road = edge ? net.roads[edge.road] : undefined;
    if (edge && road && on.distance <= edge.halfWidth + 1)
      kind = road.roadClass === 'major' || road.roadClass === 'paved' ? 2 : 3;
  }
  if (kind === 0) {
    for (const v of terrain.features.vegetation) {
      if (v.kind !== 'woodland') continue;
      if (pointInPolygon(p, v.boundary) && !(v.holes ?? []).some((h) => pointInPolygon(p, h))) {
        kind = 1;
        break;
      }
    }
  }
  cells.set(key, kind);
  return kind;
}

/** The speed the ground allows at (x, y), heading `heading`: by what it is, slower uphill. */
export function groundSpeed(
  terrain: TerrainDataset,
  type: VehicleType,
  x: number,
  y: number,
  heading: number,
): number {
  const kind = groundAt(terrain, x, y);
  const top =
    kind === 2
      ? type.roadSpeed
      : kind === 1
        ? type.woodsSpeed
        : kind === 3
          ? type.openSpeed * 1.2
          : type.openSpeed;
  // The grade along the way it heads, over 5 m.
  const ahead = 5;
  const ax = x + Math.sin(heading) * ahead;
  const ay = y + Math.cos(heading) * ahead;
  if (!isOnTerrain(terrain, ax, ay)) return top;
  const grade = (heightAt(terrain, ax, ay) - heightAt(terrain, x, y)) / ahead;
  const slow = grade > 0 ? Math.max(0.3, 1 - grade * 2.5) : Math.max(0.6, 1 + grade);
  return top * slow;
}
