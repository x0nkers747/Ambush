import { surfaceHeightAt } from './bridge-navigation';
import type { SimEvent } from './events';
import { azimuthOf, normalizeAzimuth, type Vec2 } from './geometry';
import { isSegmentWalkable, OBSTACLE_CLEARANCE_M, planPath } from './navigation';
import { pointInPolygon } from './polygon';
import { roadNetwork, roadPointAt } from './road-network';
import type { Side, SimState } from './state';
import { heightAt, isOnTerrain, type TerrainDataset } from './terrain';
import type { SimWorld } from './world';
import type { TickTime } from './movement';
import { VEHICLE_PLATFORMS } from './combat/catalog';
import { slewMounts } from './combat/mounts';
import { builtInCatalog, catalogOf, platformOf, type CombatCatalog } from './combat/registry';
import { crewState, initialVehicleCombat, type VehicleCombat } from './combat/state';
import type { PlatformSpec } from './combat/types';

// Vehicles (prototype, docs/vehicles.md): a tracked armoured personnel
// carrier (an M113) driving from waypoint to waypoint. Each order's route is
// planned like a soldier's (round buildings and water, through woods); the
// vehicle steers along it as a tracked vehicle does: it pivots on the spot to
// face a turn it cannot drive round, steers otherwise at a rate its speed
// allows, accelerates to the speed the ground allows (a road, open ground,
// woods; slower uphill), slows for bends, and brakes to stop on its waypoint.
// Its crew, weapons and damage are the combat system's (docs/combined-arms.md):
// here it drives, as its platform's mobility allows, unless it cannot.

/** A vehicle type's driving characteristics (from its platform's mobility, `vehicleTypeOf`). */
export interface VehicleType {
  readonly kind: 'tracked' | 'wheeled';
  /** Top speeds (m/s): on a paved road, on a dirt track or open ground, in woods. */
  readonly roadSpeed: number;
  readonly openSpeed: number;
  readonly woodsSpeed: number;
  /** Accelerating and braking (m/s²). */
  readonly accel: number;
  readonly decel: number;
  /** Turning on the spot (rad/s; 0: it cannot, it is wheeled), and the most sideways acceleration in a turn (m/s²). */
  readonly pivotRate: number;
  readonly lateralAccel: number;
  /** The fastest it turns at speed (rad/s), and (wheeled) its least turning radius (m). */
  readonly maxTurnRate: number;
  readonly minTurnRadius: number;
  /** Speed lost per unit of grade uphill, and the most it loses (a share). */
  readonly climbLoss: number;
  readonly maxClimbLoss: number;
  /** Hull length and width (m): for drawing, its route's clearance, and how close to a point is "there". */
  readonly length: number;
  readonly width: number;
}

/** A platform id (`PlatformSpec.id`: `m113`, `m1a1`, `bmp2`, `t72b`, or a scenario's own). */
export type VehicleKind = string;

const DEG = Math.PI / 180;

/** The driving characteristics of a platform. */
export function vehicleTypeOf(platform: PlatformSpec): VehicleType {
  const m = platform.mobility;
  return {
    kind: m.kind,
    roadSpeed: m.roadSpeedMps,
    openSpeed: m.offRoadSpeedMps,
    woodsSpeed: m.woodsSpeedMps,
    accel: m.accelMps2,
    decel: m.decelMps2,
    pivotRate: m.kind === 'tracked' ? m.pivotRateDegS * DEG : 0,
    lateralAccel: m.lateralAccelMps2,
    maxTurnRate: m.turnRateDegS * DEG,
    minTurnRadius: m.minTurnRadiusM,
    climbLoss: m.climbLoss,
    maxClimbLoss: m.maxClimbLoss,
    length: platform.dimensions.lengthM,
    width: platform.dimensions.widthM,
  };
}

/** The built-in platforms. */
export type BuiltInPlatformId = 'm113' | 'm1a1' | 'bmp2' | 't72b';

/** The built-in platforms' driving characteristics, by id. */
export const VEHICLE_TYPES = Object.freeze(
  Object.fromEntries(VEHICLE_PLATFORMS.map((p) => [p.id, vehicleTypeOf(p)])),
) as Readonly<Record<BuiltInPlatformId, VehicleType>>;

const typeCache = new WeakMap<PlatformSpec, VehicleType>();
function typeOf(platform: PlatformSpec): VehicleType {
  let t = typeCache.get(platform);
  if (!t) {
    t = vehicleTypeOf(platform);
    typeCache.set(platform, t);
  }
  return t;
}

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
  /** Its crew, mounts, weapons, targets and damage (docs/combined-arms.md). */
  combat: VehicleCombat;
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
/**
 * A turn on a road's centreline bending less than this is no corner: it is
 * driven as it is (pushed out, a road's gentle bends became a zig-zag).
 */
const ROAD_BEND_RAD = (25 * Math.PI) / 180;
/** A turn this close (m) to a road's centreline is on the road. */
const ON_CENTRELINE_M = 1;
/** Facing further off than this from where it must go, nearly stopped, it pivots on the spot. */
const PIVOT_FROM_RAD = (50 * Math.PI) / 180;
/** Speed through a sharp bend (m/s), and the bend's angle from which it is sharp. */
const BEND_SPEED = 3;
const SHARP_BEND_RAD = (60 * Math.PI) / 180;
/** The least speed it keeps while turning onto a point it can reach (m/s). */
const MIN_TURN_SPEED = 0.6;

/** The initial vehicles of a scenario, as state. */
export function initialVehicles(
  terrain: TerrainDataset,
  vehicles: readonly ScenarioVehicle[],
  catalog: CombatCatalog = builtInCatalog(),
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
    combat: initialVehicleCombat(platformOf(catalog, v.kind), v.position),
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

/**
 * Moves every vehicle by one tick: its mounts turn toward where they are
 * being laid, and it drives, unless it cannot (immobilized, destroyed, its
 * driver out) or has halted to fire.
 */
export function updateVehicles(state: SimState, world: SimWorld, time: TickTime): void {
  const vehicles = state.vehicles;
  if (!vehicles) return;
  const catalog = catalogOf(world);
  for (const v of vehicles) {
    const platform = platformOf(catalog, v.kind);
    slewMounts(platform, v.combat, time.dtSeconds);
    drive(v, world.terrain, typeOf(platform), time.dtSeconds, time.startSeconds);
  }
}

/** Whether a vehicle can drive: not destroyed or immobilized, its driver able. */
export function canDrive(v: VehicleState): boolean {
  return (
    !v.combat.damage.destroyed &&
    !v.combat.damage.mobility &&
    crewState(v.combat, 'driver') !== 'incapacitated'
  );
}

/** Its orders end: it cannot drive any more (`reason`). */
function failOrders(v: VehicleState, reason: string): void {
  for (const o of v.orders) {
    if (o.status !== 'active' && o.status !== 'pending') continue;
    o.status = 'failed';
    o.reason = reason;
  }
  v.route = [];
  v.routeIndex = 0;
}

/**
 * Whether a hull `width` wide can drive straight from `a` to `b`: its centre
 * line and both its sides clear of buildings and water (`isSegmentWalkable`
 * keeps `OBSTACLE_CLEARANCE_M` itself).
 */
export function hullClear(terrain: TerrainDataset, a: Vec2, b: Vec2, width: number): boolean {
  if (!isSegmentWalkable(terrain, a, b)) return false;
  const offset = width / 2 - OBSTACLE_CLEARANCE_M;
  if (offset <= 0) return true;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-6) return true;
  // Right of the leg's direction, and left.
  const rx = ((b.y - a.y) / len) * offset;
  const ry = (-(b.x - a.x) / len) * offset;
  return (
    isSegmentWalkable(terrain, { x: a.x + rx, y: a.y + ry }, { x: b.x + rx, y: b.y + ry }) &&
    isSegmentWalkable(terrain, { x: a.x - rx, y: a.y - ry }, { x: b.x - rx, y: b.y - ry })
  );
}

/** Whether every leg of a route is clear for the hull. */
function routeClear(
  terrain: TerrainDataset,
  from: Vec2,
  route: readonly Vec2[],
  width: number,
): boolean {
  let at = from;
  for (const p of route) {
    if (!hullClear(terrain, at, p, width)) return false;
    at = p;
  }
  return true;
}

function startNext(v: VehicleState, terrain: TerrainDataset, type: VehicleType): void {
  while (!activeVehicleOrder(v)) {
    const next = v.orders.find((o) => o.status === 'pending');
    if (!next) return;
    if (!canDrive(v)) {
      failOrders(v, v.combat.damage.destroyed ? 'destroyed' : 'immobilized');
      return;
    }
    const from = { x: v.position.x, y: v.position.y };
    // As ordered; and if that is too narrow for the hull somewhere, by the roads.
    const tries = next.followRoads === true ? [true] : [false, true];
    let route: Vec2[] | null = null;
    let reason = 'no way there';
    for (const followRoads of tries) {
      const path = planPath(terrain, from, next.destination, { followRoads });
      if (!path.ok) continue;
      const planned = smoothKinks(
        terrain,
        from,
        widenTurns(terrain, from, [
          ...path.turns.map((p) => ({ x: p.x, y: p.y })),
          { ...next.destination },
        ]),
        type.width,
      );
      if (routeClear(terrain, from, planned, type.width)) {
        route = planned;
        break;
      }
      reason = 'no way there wide enough for the vehicle';
    }
    if (!route) {
      next.status = 'failed';
      next.reason = reason;
      continue;
    }
    next.status = 'active';
    v.route = route;
    v.routeIndex = 0;
  }
}

/**
 * The route's turns pushed out from the inside of each bend (where the corner
 * it turns round is) by `CORNER_OFFSET_M`, so the hull clears it; a turn is
 * left where it was if the push would take it, or the legs to it, into an
 * obstacle, or if it is a road's gentle bend (`ROAD_BEND_RAD`: no corner to clear).
 */
function widenTurns(terrain: TerrainDataset, from: Vec2, route: Vec2[]): Vec2[] {
  const out = route.map((p) => ({ ...p }));
  for (let i = 0; i < out.length - 1; i += 1) {
    const a = out[i - 1] ?? from;
    const b = out[i];
    const c = out[i + 1];
    if (!b || !c) continue;
    if (
      bendAt(route, i, from) < ROAD_BEND_RAD &&
      (roadPointAt(terrain, b)?.distance ?? Infinity) <= ON_CENTRELINE_M
    )
      continue;
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

/** A kink this short (m) and this sharp (rad) is driven straight across when the hull fits. */
const KINK_LEG_M = 12;
const KINK_BEND_RAD = (40 * Math.PI) / 180;

/**
 * The route without its kinks: a turn on a short leg (a road's little jog, a
 * junction's corner) that bends sharply, and that the hull can cut straight
 * across, is left out, so the vehicle does not stop and pivot for it. The
 * destination is always kept.
 */
function smoothKinks(
  terrain: TerrainDataset,
  from: Vec2,
  route: readonly Vec2[],
  width: number,
): Vec2[] {
  const out = route.map((p) => ({ ...p }));
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < out.length - 1; i += 1) {
      const a = out[i - 1] ?? from;
      const b = out[i];
      const c = out[i + 1];
      if (!b || !c) continue;
      const short =
        Math.hypot(b.x - a.x, b.y - a.y) < KINK_LEG_M ||
        Math.hypot(c.x - b.x, c.y - b.y) < KINK_LEG_M;
      if (!short || bendAt(out, i, from) < KINK_BEND_RAD) continue;
      if (!hullClear(terrain, a, c, width)) continue;
      out.splice(i, 1);
      changed = true;
      break;
    }
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

function drive(
  v: VehicleState,
  terrain: TerrainDataset,
  type: VehicleType,
  dt: number,
  now: number,
): void {
  if (!canDrive(v)) {
    // Immobilized, destroyed or without its driver: it stops where it is.
    if (activeVehicleOrder(v) || v.orders.some((o) => o.status === 'pending'))
      failOrders(v, v.combat.damage.destroyed ? 'destroyed' : 'immobilized');
    v.speed = Math.max(0, v.speed - type.decel * 2 * dt);
    advance(v, terrain, dt);
    return;
  }
  // Halted to fire (a missile): it brakes and waits.
  const halted = v.combat.haltUntil !== null && now < v.combat.haltUntil - 1e-9;
  // A wounded driver drives slower.
  const driverFactor = crewState(v.combat, 'driver') === 'degraded' ? 0.7 : 1;
  startNext(v, terrain, type);
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
      startNext(v, terrain, type);
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
      if (Math.abs(error) > PIVOT_FROM_RAD && v.speed < 1 && type.pivotRate > 0) {
        // Facing well away: stop and pivot on the spot.
        wanted = 0;
        turn = Math.sign(error) * Math.min(Math.abs(error), type.pivotRate * dt);
      } else if (Math.abs(error) > PIVOT_FROM_RAD && type.pivotRate <= 0) {
        // Wheeled, facing well away: round, slowly, on its tightest circle.
        wanted = BEND_SPEED * 0.6;
        const rate = Math.max(v.speed, 0.5) / Math.max(type.minTurnRadius, 1);
        turn = Math.sign(error) * Math.min(Math.abs(error), Math.min(type.maxTurnRate, rate) * dt);
      } else {
        const radiusRate =
          type.minTurnRadius > 0 ? Math.max(v.speed, 0.5) / type.minTurnRadius : Infinity;
        const rate = Math.min(
          type.maxTurnRate,
          type.lateralAccel / Math.max(v.speed, 0.5),
          radiusRate,
        );
        turn = Math.sign(error) * Math.min(Math.abs(error), rate * dt);
        // The ground's speed; slower while still turning toward the way on.
        wanted = groundSpeed(terrain, type, here.x, here.y, v.heading);
        if (Math.abs(error) > 0.35) wanted = Math.min(wanted, BEND_SPEED);
        // No faster than lets it turn onto its point: the arc to it (through
        // the point, tangent to its heading) must be one it can drive, so it
        // never circles a point inside its turning circle.
        const absError = Math.abs(error);
        if (absError > 1e-3) {
          const radius = toTarget / (2 * Math.sin(Math.min(absError, Math.PI / 2)));
          const onArc = Math.min(radius * type.maxTurnRate, Math.sqrt(type.lateralAccel * radius));
          wanted = Math.min(wanted, Math.max(MIN_TURN_SPEED, onArc));
        }
        // Tracked, facing well away: it brakes, turning, and pivots once stopped.
        if (type.pivotRate > 0 && absError > PIVOT_FROM_RAD) wanted = 0;
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
  } else if (v.speed < 0.3 && type.pivotRate > 0) {
    // Arrived (or without orders): its front toward the enemy, its strongest armour.
    const toward = enemyBearing(v);
    if (toward !== null) {
      let error = toward - v.heading;
      error -= 2 * Math.PI * Math.round(error / (2 * Math.PI));
      if (Math.abs(error) > FACE_ENEMY_TOLERANCE_RAD)
        turn = Math.sign(error) * Math.min(Math.abs(error), type.pivotRate * dt);
    }
  }
  wanted *= driverFactor;
  if (halted) {
    wanted = 0;
    turn = 0;
  }
  // Speed toward what is wanted, within its acceleration and braking.
  const dv = wanted - v.speed;
  v.speed += dv > 0 ? Math.min(dv, type.accel * dt) : Math.max(dv, -type.decel * dt);
  if (v.speed < 1e-3 && wanted === 0) v.speed = 0;
  v.heading = normalizeAzimuth(v.heading + turn);
  advance(v, terrain, dt);
}

/** It moves on at its speed along its heading, for `dt`, and stands on the surface. */
function advance(v: VehicleState, terrain: TerrainDataset, dt: number): void {
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

/** A vehicle at rest turns to face the enemy when it is off by more than this (rad). */
const FACE_ENEMY_TOLERANCE_RAD = (8 * Math.PI) / 180;

/**
 * The bearing of the enemy a vehicle should face: the nearest vehicle its
 * crew has confirmed, else the nearest soldier, where last seen; `null`
 * without any.
 */
function enemyBearing(v: VehicleState): number | null {
  let best: { vehicle: boolean; d: number; x: number; y: number } | null = null;
  for (const t of v.combat.tracks) {
    if (!t.confirmed) continue;
    const d = Math.hypot(t.lastKnown.x - v.position.x, t.lastKnown.y - v.position.y);
    const vehicle = t.target === 'vehicle';
    if (!best || (vehicle && !best.vehicle) || (vehicle === best.vehicle && d < best.d))
      best = { vehicle, d, x: t.lastKnown.x, y: t.lastKnown.y };
  }
  if (!best || best.d < 1) return null;
  return azimuthOf(best.x - v.position.x, best.y - v.position.y);
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
  const slow =
    grade > 0
      ? Math.max(1 - type.maxClimbLoss, 1 - grade * type.climbLoss)
      : Math.max(0.6, 1 + grade);
  return top * slow;
}
