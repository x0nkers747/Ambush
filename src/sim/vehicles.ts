import { surfaceHeightAt } from './bridge-navigation';
import type { SimEvent } from './events';
import { azimuthOf, normalizeAzimuth, type Vec2 } from './geometry';
import {
  isSegmentClear,
  isSegmentWalkable,
  planHullPath,
  planPath,
  type Clearance,
} from './navigation';
import { pointInPolygon } from './polygon';
import { roadNetwork, roadPointAt } from './road-network';
import type { Side, SimState, Soldier } from './state';
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
/**
 * It steers for a point this far along its route ahead of it (m): its speed
 * (m/s) times `LOOK_AHEAD_S`, within these bounds. So the route's little
 * jogs are driven through smoothly, and a turn just missed is not driven
 * back to; slow, round a sharp corner, it follows the route closely.
 */
const LOOK_AHEAD_S = 0.7;
const LOOK_AHEAD_MIN_M = 3;
const LOOK_AHEAD_MAX_M = 12;
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
  const types = vehicles.map((v) => typeOf(platformOf(catalog, v.kind)));
  // The soldiers' velocities (those moving with their units), to see who is stepping into its way.
  const walking = new Map<string, { readonly x: number; readonly y: number }>();
  for (const a of state.behavior?.agents ?? [])
    if (a.vx !== 0 || a.vy !== 0) walking.set(a.soldierId, { x: a.vx, y: a.vy });
  // Soldiers of its side in the way of a vehicle that cannot pass them.
  const blockers: Blocker[] = [];
  vehicles.forEach((v, i) => {
    const platform = platformOf(catalog, v.kind);
    const type = types[i] ?? typeOf(platform);
    slewMounts(platform, v.combat, time.dtSeconds);
    drive(v, world.terrain, type, time.dtSeconds, time.startSeconds, {
      speed: (wanted) => keepInterval(v, type, wanted, vehicles, types),
      steer: (target, toEnd, leg) => {
        const round = bypass(v, type, world.terrain, target, toEnd, leg, vehicles, types);
        // Round a stopped vehicle: the line to its way round is the way on.
        const line = round.speed === Infinity ? leg : { from: v.position, to: round.target };
        const clear = avoidSoldiers(
          v,
          type,
          world.terrain,
          round.target,
          toEnd,
          line,
          state.soldiers,
          walking,
          oncoming(v, type, line, vehicles, types),
        );
        const guard = guardVehicles(v, type, vehicles, types);
        if (clear.blockers) blockers.push(...clear.blockers);
        return { target: clear.target, speed: Math.min(round.speed, clear.speed, guard) };
      },
      taken: (p) => {
        let room = 0;
        vehicles.forEach((o, j) => {
          const other = types[j];
          if (o === v || !other || (canDrive(o) && activeVehicleOrder(o))) return;
          // It stops that far short of the place, clear of the vehicle wherever it stands there.
          const need = (type.length + other.length) / 2 + 1;
          const d = Math.hypot(o.position.x - p.x, o.position.y - p.y);
          if (d < need) room = Math.max(room, need + d);
        });
        return room;
      },
    });
  });
  makeWay(world.terrain, blockers, walking, time.dtSeconds);
}

/** Vehicles in column keep this gap (m, from one's rear to the next one's front) at least. */
const INTERVAL_M = 25;
/** Closing on the vehicle ahead, it may go this much faster than it per metre of gap beyond the interval (1/s). */
const CLOSING_PER_M = 1 / 3;
/** A vehicle is looked at as ahead within this far (m) of the front. */
const LOOK_AHEAD_M = 80;
/** It is in the way within this of the line ahead (m) beyond the two half-widths. */
const LANE_MARGIN_M = 1.5;

/** A vehicle stopped for good this far ahead (m, front to its rear) is driven round. */
const BYPASS_AHEAD_M = 30;
/** Passing one, it keeps this clear of it (m, beyond the two half-widths), at most this fast (m/s). */
const BYPASS_CLEAR_M = 2;
const BYPASS_SPEED = 4;
/** It steers for a point beside it and this far beyond it (m, past the two half-lengths). */
const BYPASS_BEYOND_M = 4;

/**
 * Where it steers (`target`) to drive round a vehicle stopped for good in
 * its way (a wreck, one immobilized, one parked: those `keepInterval` does
 * not wait for), and how fast it may pass; the target as it was, and no
 * limit, when none is in its way. It passes the nearest beside it, away from
 * it if it can: of a pass to either side, then wider ones (off the road), the first clear
 * of every vehicle stopped there and of what cannot be crossed (buildings,
 * water). With none clear, it stops.
 */
function bypass(
  v: VehicleState,
  type: VehicleType,
  terrain: TerrainDataset,
  target: Vec2,
  /** How far it has yet to drive (m): one beyond that is not in its way. */
  toEnd: number,
  /** The leg of its route it is on. */
  leg: { readonly from: Vec2; readonly to: Vec2 },
  vehicles: readonly VehicleState[],
  types: readonly VehicleType[],
): { readonly target: Vec2; readonly speed: number } {
  // The way on (the route's leg it is on, which does not turn as it does), and its right.
  const wx = leg.to.x - leg.from.x;
  const wy = leg.to.y - leg.from.y;
  const wl = Math.hypot(wx, wy);
  const fx = wl > 0.5 ? wx / wl : Math.sin(v.heading);
  const fy = wl > 0.5 ? wy / wl : Math.cos(v.heading);
  const rx = fy;
  const ry = -fx;
  const stopped: { readonly at: Vec2; readonly type: VehicleType }[] = [];
  let nearest: { along: number; lateral: number; at: Vec2; clear: number; half: number } | null =
    null;
  vehicles.forEach((o, j) => {
    const other = types[j];
    if (!other) return;
    if (o === v || (canDrive(o) && activeVehicleOrder(o) && !gridlocked(v, type, o, other))) return;
    stopped.push({ at: o.position, type: other });
    const dx = o.position.x - v.position.x;
    const dy = o.position.y - v.position.y;
    const along = dx * fx + dy * fy;
    const half = (type.length + other.length) / 2;
    // Ahead, or alongside until passed.
    if (along < -half || along - half > Math.min(BYPASS_AHEAD_M, toEnd)) return;
    const lateral = dx * rx + dy * ry;
    // Which side of the leg it stands (a fixed line: the side passed does not change as it passes).
    const side = (o.position.x - leg.from.x) * rx + (o.position.y - leg.from.y) * ry;
    const clear = (type.width + other.width) / 2 + BYPASS_CLEAR_M;
    // (Alongside, a little more: it does not turn back into it as it passes.)
    if (Math.abs(lateral) >= clear + 0.5) return;
    if (nearest && along >= nearest.along) return;
    nearest = { along, lateral: side, at: o.position, clear, half };
  });
  const found = nearest as {
    along: number;
    lateral: number;
    at: Vec2;
    clear: number;
    half: number;
  } | null;
  if (!found) return { target, speed: Infinity };
  // Away from it first: to its left if it is to the right of the line ahead.
  const away = found.lateral >= 0 ? -1 : 1;
  for (const offset of [away, -away, 2 * away, -2 * away, 3 * away, -3 * away]) {
    const aim = {
      x: found.at.x + rx * offset * found.clear + fx * (found.half + BYPASS_BEYOND_M),
      y: found.at.y + ry * offset * found.clear + fy * (found.half + BYPASS_BEYOND_M),
    };
    const blocked = stopped.some(
      (o) =>
        Math.hypot(o.at.x - aim.x, o.at.y - aim.y) <
        (type.width + o.type.width) / 2 + BYPASS_CLEAR_M / 2,
    );
    if (!blocked && clearWay(terrain, v.position, aim, type.width))
      return { target: aim, speed: BYPASS_SPEED };
  }
  // No way round: it stops short.
  return { target, speed: 0 };
}

/** Soldiers this far ahead (m, from its front) are in its way if in its path. */
const SOLDIERS_AHEAD_M = 35;
/** It keeps this clear of a soldier (m, beyond its half-width). */
const SOLDIER_CLEAR_M = 1.5;
/** The sideways shifts of its path it tries (m), to either side, to pass soldiers. */
const PATH_SHIFTS_M = [0, 1.5, 3, 4.5, 6, 7.5, 9];
/** Passing soldiers, or near them, at most this fast (m/s); stopping, this short of one (m). */
const PASSING_SOLDIERS_SPEED = 5;
const SOLDIER_STOP_M = 4;
/** It stops this short of a soldier in front of it, and so far beyond its sides (m). */
const GUARD_MARGIN_M = 1;
/** It looks this far ahead (s) at where soldiers are walking to. */
const GUARD_LOOK_S = 1.5;
/** A shifted path is steered along by a point this far ahead on it (m). */
const SHIFT_AIM_M = 12;

/**
 * Where it steers (`target`) and how fast it may go, so as not to drive over
 * soldiers (either side's): the strip its hull sweeps along its way on
 * (`leg`), up to `SOLDIERS_AHEAD_M` ahead, kept clear of every soldier up. If
 * one is in it, its path is shifted sideways, smoothly (the steering point
 * moves; the vehicle eases over): of the shifts that clear them all and do
 * not cross what cannot be crossed (buildings, water), the nearest to where
 * it is now, so it holds a shift while it passes them and comes back once
 * past. Near soldiers it slows; with no clear path it stops short of them
 * and waits for them to move.
 */
function avoidSoldiers(
  v: VehicleState,
  type: VehicleType,
  terrain: TerrainDataset,
  target: Vec2,
  /** How far it has yet to drive (m): soldiers beyond its destination are not in its way. */
  toEnd: number,
  leg: { readonly from: Vec2; readonly to: Vec2 },
  soldiers: readonly Soldier[],
  /** Soldiers' velocities by id (m/s; absent: standing). */
  walking: ReadonlyMap<string, { readonly x: number; readonly y: number }> = new Map(),
  /** Vehicles coming the other way to pass (`oncoming`). */
  coming: readonly Oncoming[] = [],
): { readonly target: Vec2; readonly speed: number; readonly blockers?: readonly Blocker[] } {
  const wx = leg.to.x - leg.from.x;
  const wy = leg.to.y - leg.from.y;
  const wl = Math.hypot(wx, wy);
  const fx = wl > 0.5 ? wx / wl : Math.sin(v.heading);
  const fy = wl > 0.5 ? wy / wl : Math.cos(v.heading);
  const rx = fy;
  const ry = -fx;
  const halfLength = type.length / 2;
  const reach = Math.min(SOLDIERS_AHEAD_M, toEnd + halfLength);
  // The soldiers by it or ahead: how far ahead of its centre, and where across the leg.
  const soldierHalf = type.width / 2 + SOLDIER_CLEAR_M;
  const near: { along: number; across: number; half: number; soldier?: Soldier }[] = [];
  for (const s of soldiers) {
    if (s.status !== 'active') continue;
    const dx = s.position.x - v.position.x;
    const dy = s.position.y - v.position.y;
    const along = dx * fx + dy * fy;
    if (along < -halfLength || along > halfLength + reach) continue;
    if (Math.abs(dx * rx + dy * ry) > 12) continue;
    near.push({
      along,
      across: (s.position.x - leg.from.x) * rx + (s.position.y - leg.from.y) * ry,
      half: soldierHalf,
      soldier: s,
    });
  }
  for (const c of coming) near.push(c);
  // Whatever its path, never onto a soldier: one in the ground it would
  // cover, as it is heading now, before it could stop (where he is, or where
  // he is walking to within `GUARD_LOOK_S`), and it brakes to stop short of
  // him (turning, it sweeps ground off its path).
  const hx = Math.sin(v.heading);
  const hy = Math.cos(v.heading);
  const stopping = (v.speed * v.speed) / (2 * type.decel);
  let guard = Infinity;
  // Soldiers of its side it has stopped for, close in front: they make way.
  const blockers: Blocker[] = [];
  for (const s of soldiers) {
    if (s.status !== 'active') continue;
    const step = walking.get(s.id);
    for (const look of step ? [0, GUARD_LOOK_S] : [0]) {
      const dx = s.position.x + (step?.x ?? 0) * look - v.position.x;
      const dy = s.position.y + (step?.y ?? 0) * look - v.position.y;
      const ahead = dx * hx + dy * hy;
      if (ahead <= 0 || ahead > halfLength + stopping + GUARD_MARGIN_M + 2) continue;
      if (Math.abs(dx * hy - dy * hx) > type.width / 2 + GUARD_MARGIN_M) continue;
      const room = ahead - halfLength - GUARD_MARGIN_M;
      guard = Math.min(guard, Math.sqrt(2 * type.decel * Math.max(0, room)));
      if (look === 0 && room < SOLDIER_STOP_M && s.side === v.side) {
        const side = dx * hy - dy * hx >= 0 ? 1 : -1;
        blockers.push({ soldier: s, x: hy * side, y: -hx * side });
      }
    }
  }
  if (near.length === 0) return { target, speed: guard, blockers };
  const here = (v.position.x - leg.from.x) * rx + (v.position.y - leg.from.y) * ry;
  const clearAt = (shift: number) => near.every((n) => Math.abs(n.across - shift) >= n.half);
  // Shifts that clear them all, the nearest to where it is first (then the
  // smaller); passing a vehicle coming the other way, to its right first (as
  // that one does, so they pass).
  const shifts = PATH_SHIFTS_M.flatMap((m) => (m === 0 ? [0] : [m, -m])).sort(
    coming.length > 0
      ? (a, b) => Number(a < 0) - Number(b < 0) || Math.abs(a) - Math.abs(b)
      : (a, b) => Math.abs(a - here) - Math.abs(b - here) || Math.abs(a) - Math.abs(b),
  );
  for (const shift of shifts) {
    if (!clearAt(shift)) continue;
    // A point a little ahead on the shifted line (near: the shift steers it).
    const ahead = Math.min(
      SHIFT_AIM_M,
      Math.hypot(target.x - v.position.x, target.y - v.position.y),
    );
    const moved = {
      x: v.position.x + fx * ahead + rx * (shift - here),
      y: v.position.y + fy * ahead + ry * (shift - here),
    };
    // Its own line, unshifted, needs no check; a shifted one must not cross a building or water.
    if (shift !== 0 && !clearWay(terrain, v.position, moved, type.width)) continue;
    // Slowly past soldiers (not for a vehicle passed).
    const passing = near.some(
      (n) => n.half === soldierHalf && (shift !== 0 || Math.abs(n.across - shift) < n.half + 3),
    );
    return {
      blockers,
      target: shift === 0 && Math.abs(here) < 0.5 ? target : moved,
      speed: Math.min(guard, passing ? PASSING_SOLDIERS_SPEED : Infinity),
    };
  }
  // No way past: it stops short of the nearest in its path, and those of
  // its own side in its path make way (`makeWay`), out to the side they are on.
  const inPath = near.filter((n) => Math.abs(n.across - here) < n.half && n.along > 0);
  const blocking = inPath.reduce((m, n) => Math.min(m, n.along), Infinity);
  const gap = blocking - halfLength - SOLDIER_STOP_M;
  for (const n of inPath) {
    if (n.soldier?.side !== v.side) continue;
    const side = n.across >= here ? 1 : -1;
    blockers.push({ soldier: n.soldier, x: rx * side, y: ry * side });
  }
  return {
    target,
    speed: Math.min(guard, Math.max(0, Math.min(PASSING_SOLDIERS_SPEED, gap / 2))),
    blockers,
  };
}

/** A soldier in a stopped vehicle's way, and the way out of it (a unit vector). */
interface Blocker {
  readonly soldier: Soldier;
  readonly x: number;
  readonly y: number;
}

/** Making way for a vehicle, a soldier steps aside this fast (m/s). */
const MAKE_WAY_SPEED = 1.2;

/**
 * Soldiers of its side standing in the way of a vehicle that cannot pass
 * them step out of it, sideways, at `MAKE_WAY_SPEED` (the other way if that
 * side is a building or water); those walking (with their unit) go on
 * walking. Without this a vehicle waited for good behind a squad halted
 * across a street.
 */
function makeWay(
  terrain: TerrainDataset,
  blockers: readonly Blocker[],
  walking: ReadonlyMap<string, unknown>,
  dt: number,
): void {
  const step = MAKE_WAY_SPEED * dt;
  const moved = new Set<string>();
  for (const b of blockers) {
    const s = b.soldier;
    if (walking.has(s.id) || s.status !== 'active' || moved.has(s.id)) continue;
    moved.add(s.id);
    for (const side of [1, -1]) {
      const to = { x: s.position.x + b.x * side * step, y: s.position.y + b.y * side * step };
      if (!isSegmentWalkable(terrain, s.position, to)) continue;
      s.position.x = to.x;
      s.position.y = to.y;
      s.position.z = surfaceHeightAt(terrain, to.x, to.y);
      break;
    }
  }
}

/** A vehicle coming the other way, as `avoidSoldiers` keeps clear of it: ahead, across the leg, and how far clear. */
interface Oncoming {
  readonly along: number;
  readonly across: number;
  readonly half: number;
}

/** Vehicles coming the other way within this (m, centre to centre; at least 4 s at their closing speed) are passed. */
const ONCOMING_AHEAD_M = 40;
const ONCOMING_LOOK_S = 4;
/** Passing one, it keeps this clear of it (m, beyond the two half-widths). */
const ONCOMING_CLEAR_M = 1;

/**
 * The vehicles coming the other way along its leg (heading more than 120
 * degrees from its way on), ahead within `ONCOMING_AHEAD_M` (more when
 * closing fast) and near its line: each is passed, keeping right.
 */
function oncoming(
  v: VehicleState,
  type: VehicleType,
  leg: { readonly from: Vec2; readonly to: Vec2 },
  vehicles: readonly VehicleState[],
  types: readonly VehicleType[],
): Oncoming[] {
  const wx = leg.to.x - leg.from.x;
  const wy = leg.to.y - leg.from.y;
  const wl = Math.hypot(wx, wy);
  const fx = wl > 0.5 ? wx / wl : Math.sin(v.heading);
  const fy = wl > 0.5 ? wy / wl : Math.cos(v.heading);
  const out: Oncoming[] = [];
  vehicles.forEach((o, j) => {
    if (o === v || !canDrive(o) || !activeVehicleOrder(o)) return;
    const other = types[j];
    if (!other) return;
    const ox = Math.sin(o.heading);
    const oy = Math.cos(o.heading);
    if (fx * ox + fy * oy > -0.5) return;
    const dx = o.position.x - v.position.x;
    const dy = o.position.y - v.position.y;
    const along = dx * fx + dy * fy;
    const reach = Math.max(ONCOMING_AHEAD_M, (v.speed + o.speed) * ONCOMING_LOOK_S);
    if (along < -(type.length + other.length) / 2 || along > reach) return;
    if (Math.abs(dx * fy - dy * fx) > 15) return;
    out.push({
      along,
      across: (o.position.x - leg.from.x) * fy - (o.position.y - leg.from.y) * fx,
      half: (type.width + other.width) / 2 + ONCOMING_CLEAR_M,
    });
  });
  return out;
}

/** It stops this short of another vehicle in its way (m). */
const VEHICLE_GUARD_M = 2;
/** Its hull and another's are in each other's way within this of touching side to side (m). */
const VEHICLE_GUARD_SIDE_M = 0.25;
/** Ways crossing at more than this sine of the angle between them are taken in turn where they cross. */
const CROSSING_SIN = 0.3;
/** It looks this far ahead (s) for a vehicle whose way crosses its own. */
const CROSSING_HORIZON_S = 8;
/** Through a crossing, each keeps this clear of the other (m). */
const CROSSING_CLEAR_M = 1.5;

/**
 * How far ahead of `a`'s front the hull of `b`, where it is, lies in its way
 * (as `a` heads now), within `limit`; `null`: not in it.
 */
function inWay(
  a: VehicleState,
  at: VehicleType,
  b: VehicleState,
  bt: VehicleType,
  limit: number,
): number | null {
  const hx = Math.sin(a.heading);
  const hy = Math.cos(a.heading);
  const bx = Math.sin(b.heading);
  const by = Math.cos(b.heading);
  const dx = b.position.x - a.position.x;
  const dy = b.position.y - a.position.y;
  const ahead = dx * hx + dy * hy;
  const cos = Math.abs(hx * bx + hy * by);
  const sin = Math.abs(hx * by - hy * bx);
  const extAlong = (cos * bt.length + sin * bt.width) / 2;
  const extAcross = (sin * bt.length + cos * bt.width) / 2;
  const front = ahead - extAlong - at.length / 2;
  if (ahead <= 0 || front > limit) return null;
  if (Math.abs(dx * hy - dy * hx) > at.width / 2 + extAcross + VEHICLE_GUARD_SIDE_M) return null;
  return front;
}

/**
 * Whether `o` has stopped in `v`'s way with `v` in its own (nose to side
 * where their ways met): then `v`, if it is the one to give way (the higher
 * id), drives round `o` as round a vehicle stopped for good (`bypass`).
 */
function gridlocked(
  v: VehicleState,
  type: VehicleType,
  o: VehicleState,
  other: VehicleType,
): boolean {
  return (
    o.speed < 0.3 &&
    v.id > o.id &&
    inWay(v, type, o, other, VEHICLE_GUARD_M + 2) !== null &&
    inWay(o, other, v, type, VEHICLE_GUARD_M + 2) !== null
  );
}

/** When a vehicle is in the place two ways cross (s, from now): `Infinity` for one not coming. */
interface Occupancy {
  /** How far along its heading to the near edge of that place (m; 0 or less: in it). */
  readonly toEntry: number;
  readonly enter: number;
  readonly leave: number;
}

/**
 * Where the ways of `a` and `b` (straight on as each heads) cross, and when
 * each is in that place (`a`'s first); `null` when their ways do not cross
 * (near parallel, or crossed behind one of them).
 */
function crossingOf(
  a: VehicleState,
  at: VehicleType,
  b: VehicleState,
  bt: VehicleType,
): readonly [Occupancy, Occupancy] | null {
  const ax = Math.sin(a.heading);
  const ay = Math.cos(a.heading);
  const bx = Math.sin(b.heading);
  const by = Math.cos(b.heading);
  const cross = ax * by - ay * bx;
  if (Math.abs(cross) < CROSSING_SIN) return null;
  const sin = Math.abs(cross);
  const cos = Math.abs(ax * bx + ay * by);
  const dx = b.position.x - a.position.x;
  const dy = b.position.y - a.position.y;
  // a + sa·(ax, ay) = b + sb·(bx, by).
  const sa = (dx * by - dy * bx) / cross;
  const sb = (dx * ay - dy * ax) / cross;
  const occupancy = (
    s: number,
    speed: number,
    own: VehicleType,
    other: VehicleType,
  ): Occupancy | null => {
    // Along its way, it is in the other's lane while its hull overlaps it.
    const half =
      own.length / 2 + (other.width / 2 + (own.width / 2) * cos + CROSSING_CLEAR_M) / sin;
    if (s + half < 0) return null;
    const toEntry = s - half;
    if (speed < 0.3)
      return toEntry <= 0
        ? { toEntry, enter: 0, leave: Infinity }
        : { toEntry, enter: Infinity, leave: Infinity };
    return {
      toEntry,
      enter: Math.max(0, toEntry / speed),
      leave: (s + half) / speed,
    };
  };
  const oa = occupancy(sa, a.speed, at, bt);
  const ob = occupancy(sb, b.speed, bt, at);
  return oa && ob ? [oa, ob] : null;
}

/**
 * How fast it may go so as never to drive into another vehicle:
 *
 * - one in its way where it is (ahead, as it heads now), before it could
 *   stop, it brakes to stop `VEHICLE_GUARD_M` short of (two in each
 *   other's way: the lower id goes on);
 * - one whose way crosses its own, the two take the crossing in turn: the
 *   one there first (in it, or the sooner to it; equal, the lower id) goes
 *   on, and the other, if they would be in it together, stops short of it.
 *
 * Vehicles stopped for good are driven round (`bypass`); those in a column
 * keep their interval (`keepInterval`); coming the other way, they pass
 * (`oncoming`).
 */
function guardVehicles(
  v: VehicleState,
  type: VehicleType,
  vehicles: readonly VehicleState[],
  types: readonly VehicleType[],
): number {
  if (v.speed <= 0) return Infinity;
  const stopping = (v.speed * v.speed) / (2 * type.decel);
  const reach = stopping + VEHICLE_GUARD_M + 2;
  let allowed = Infinity;
  vehicles.forEach((o, j) => {
    // One stopped for good is driven round (`bypass`, which stops if it cannot).
    if (o === v || !canDrive(o) || !activeVehicleOrder(o)) return;
    const other = types[j];
    if (!other) return;
    // Gridlocked with it: it drives round it (`bypass`).
    if (gridlocked(v, type, o, other)) return;
    const far = reach + type.length + other.length + o.speed * CROSSING_HORIZON_S;
    if (Math.abs(o.position.x - v.position.x) > far || Math.abs(o.position.y - v.position.y) > far)
      return;
    // In its way now.
    const front = inWay(v, type, o, other, reach);
    if (front !== null && !(v.id < o.id && inWay(o, other, v, type, Infinity) !== null))
      allowed = Math.min(allowed, Math.sqrt(2 * type.decel * Math.max(0, front - VEHICLE_GUARD_M)));
    // Crossing its way.
    const crossing = crossingOf(v, type, o, other);
    if (!crossing) return;
    const [mine, theirs] = crossing;
    if (mine.toEntry <= 0 || mine.enter > CROSSING_HORIZON_S) return;
    const together = mine.enter < theirs.leave && theirs.enter < mine.leave;
    if (!together) return;
    const first =
      theirs.toEntry > 0 &&
      (mine.enter < theirs.enter || (mine.enter === theirs.enter && v.id < o.id));
    if (first) return;
    allowed = Math.min(allowed, Math.sqrt(2 * type.decel * Math.max(0, mine.toEntry)));
  });
  return allowed;
}

/**
 * The speed `wanted` limited to keep its interval behind the vehicle ahead
 * of it in its lane (docs/vehicles.md): a column closes up to `INTERVAL_M`,
 * then goes at its leader's speed; one stopped (pivoting, waiting) holds it
 * there. A vehicle that is stopped for good (a wreck, one immobilized, one
 * that has arrived) does not: the follower drives on. Two coming head on
 * do not wait for each other. Two that each have the other ahead (crossing
 * at a junction): the lower id goes first.
 */
function keepInterval(
  v: VehicleState,
  type: VehicleType,
  wanted: number,
  vehicles: readonly VehicleState[],
  types: readonly VehicleType[],
): number {
  const fx = Math.sin(v.heading);
  const fy = Math.cos(v.heading);
  let allowed = wanted;
  vehicles.forEach((o, j) => {
    if (o === v || !canDrive(o) || !activeVehicleOrder(o)) return;
    const other = types[j];
    if (!other) return;
    const dx = o.position.x - v.position.x;
    const dy = o.position.y - v.position.y;
    const along = dx * fx + dy * fy;
    const gap = along - (type.length + other.length) / 2;
    if (along <= 0 || gap > LOOK_AHEAD_M) return;
    if (Math.abs(dx * fy - dy * fx) > (type.width + other.width) / 2 + LANE_MARGIN_M) return;
    const ox = Math.sin(o.heading);
    const oy = Math.cos(o.heading);
    // Head on: neither waits.
    if (fx * ox + fy * oy < -0.5) return;
    // Each ahead of the other (crossing): the lower id goes on.
    const back = -dx * ox - dy * oy;
    const mutual =
      back > 0 && Math.abs(-dx * oy + dy * ox) <= (type.width + other.width) / 2 + LANE_MARGIN_M;
    if (mutual && v.id < o.id) return;
    allowed = Math.min(allowed, Math.max(0, o.speed + (gap - INTERVAL_M) * CLOSING_PER_M));
  });
  return allowed;
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

/** A hull keeps this clear of buildings beyond its half-width (m). */
const HULL_MARGIN_M = 0.25;

/** What a hull `width` wide keeps clear of: buildings by `HULL_MARGIN_M`, water by none. */
function hullClearance(width: number): Clearance {
  return { buildings: width / 2 + HULL_MARGIN_M, water: width / 2 };
}

/**
 * Whether a hull `width` wide can drive straight from `a` to `b` (or stand
 * at `a`, `b` = `a`): its sides clear of buildings and water.
 */
export function hullClear(terrain: TerrainDataset, a: Vec2, b: Vec2, width: number): boolean {
  return isSegmentClear(terrain, a, b, hullClearance(width));
}

/**
 * Whether it can steer from where it is to `to` off its route (round a
 * wreck, past soldiers): a line a soldier could walk, and from halfway along
 * it on, clear for the hull (where it is may be closer to a wall than that).
 */
function clearWay(terrain: TerrainDataset, from: Vec2, to: Vec2, width: number): boolean {
  const half = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  return isSegmentWalkable(terrain, from, to) && hullClear(terrain, half, to, width);
}

/** A destination the hull does not fit at is moved to the nearest place it does, within this (m). */
const DESTINATION_ROOM_M = 15;

/** Where a hull `width` wide fits nearest `p` (rings 1 m apart), within `DESTINATION_ROOM_M`; `null`: nowhere. */
function roomFor(terrain: TerrainDataset, p: Vec2, width: number): Vec2 | null {
  if (hullClear(terrain, p, p, width)) return p;
  for (let r = 1; r <= DESTINATION_ROOM_M; r += 1) {
    const steps = Math.max(8, Math.ceil((2 * Math.PI * r) / 1.5));
    for (let k = 0; k < steps; k += 1) {
      const a = (2 * Math.PI * k) / steps;
      const q = { x: p.x + r * Math.sin(a), y: p.y + r * Math.cos(a) };
      if (hullClear(terrain, q, q, width)) return q;
    }
  }
  return null;
}

/**
 * The route's legs the hull does not fit along replanned for it
 * (`planHullPath`): each such leg, widened to the nearest turns either side
 * where it fits, is replaced by a path that keeps the hull's clearance. `null`
 * when one cannot be.
 */
function fitRoute(
  terrain: TerrainDataset,
  from: Vec2,
  route: readonly Vec2[],
  width: number,
): Vec2[] | null {
  const points = [from, ...route];
  const fits = (i: number) => {
    const p = points[i];
    return p !== undefined && (i === 0 || hullClear(terrain, p, p, width));
  };
  const out: Vec2[] = [];
  let i = 0;
  while (i < points.length - 1) {
    const a = points[i];
    const b = points[i + 1];
    if (!a || !b) break;
    if (hullClear(terrain, a, b, width)) {
      out.push(b);
      i += 1;
      continue;
    }
    // From the last turn kept (it fits, or is the start) to the next turn that fits.
    let e = i + 1;
    while (e < points.length - 1 && !fits(e)) e += 1;
    const to = points[e];
    if (!to || !fits(e)) return null;
    const path = planHullPath(terrain, a, to, hullClearance(width));
    if (!path.ok) return null;
    out.push(...path.turns.map((p) => ({ x: p.x, y: p.y })), { ...to });
    i = e;
  }
  return out;
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
    // Where it fits at its destination (not against a wall, between two).
    const end = roomFor(terrain, next.destination, type.width);
    // As ordered, the legs too narrow for the hull replanned for it; then the
    // other way (by the roads, or not).
    const tries = next.followRoads === true ? [true, false] : [false, true];
    let route: Vec2[] | null = null;
    let reason = end ? 'no way there' : 'no room for the vehicle there';
    for (const followRoads of end ? tries : []) {
      const path = planPath(terrain, from, end ?? next.destination, { followRoads });
      if (!path.ok) continue;
      const planned = smoothKinks(
        terrain,
        from,
        widenTurns(terrain, from, [
          ...path.turns.map((p) => ({ x: p.x, y: p.y })),
          { ...(end ?? next.destination) },
        ]),
        type.width,
      );
      const fitted = routeClear(terrain, from, planned, type.width)
        ? planned
        : fitRoute(terrain, from, planned, type.width);
      if (fitted) {
        route = fitted;
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

/** How far along the leg from `a` to `b` the point `p` is (0 at `a`, 1 at `b`, beyond: more). */
function alongLeg(a: Vec2, b: Vec2, p: Vec2): number {
  const lx = b.x - a.x;
  const ly = b.y - a.y;
  const l2 = lx * lx + ly * ly;
  return l2 < 1e-9 ? 1 : ((p.x - a.x) * lx + (p.y - a.y) * ly) / l2;
}

/**
 * The point `distance` metres along the route ahead of `here`: from where
 * `here` is along the leg to turn `index` (the point of that leg nearest it),
 * on through the later turns; the route's end at most.
 */
function lookAhead(route: readonly Vec2[], index: number, here: Vec2, distance: number): Vec2 {
  const to = route[index];
  if (!to) return here;
  const from = route[index - 1];
  let at: Vec2 = here;
  if (from) {
    const t = Math.min(1, Math.max(0, alongLeg(from, to, here)));
    at = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
  }
  let left = distance;
  for (let i = index; i < route.length; i += 1) {
    const next = route[i];
    if (!next) break;
    const d = Math.hypot(next.x - at.x, next.y - at.y);
    if (d >= left) {
      const f = left / d;
      return { x: at.x + (next.x - at.x) * f, y: at.y + (next.y - at.y) * f };
    }
    left -= d;
    at = next;
  }
  return at;
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
  /** The traffic: the speed it may drive at (`keepInterval`), and its way round what is stopped in its way (`bypass`). */
  traffic: {
    readonly speed: (wanted: number) => number;
    readonly steer: (
      target: Vec2,
      toEnd: number,
      leg: { readonly from: Vec2; readonly to: Vec2 },
    ) => { readonly target: Vec2; readonly speed: number };
    /** How far round `p` (m) a vehicle stopped for good there takes the place up; 0: free. */
    readonly taken?: (p: Vec2) => number;
  } = { speed: (wanted) => wanted, steer: (target) => ({ target, speed: Infinity }) },
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
  /** At most this fast, passing a vehicle stopped in its way. */
  let passingSpeed = Infinity;
  if (order) {
    // Passing a turn of the route (near it, or beyond it along the leg to
    // it), it steers for the next.
    while (v.routeIndex < v.route.length - 1) {
      const p = v.route[v.routeIndex];
      if (!p) break;
      const from = v.route[v.routeIndex - 1];
      const near = Math.hypot(p.x - here.x, p.y - here.y) <= TURN_REACHED_M;
      if (!near && !(from && alongLeg(from, p, here) >= 1)) break;
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
    const turnAt = v.route[v.routeIndex] ?? current.destination;
    const last = v.routeIndex >= ahead.length - 1;
    // Steering for a point a little way along the route (on the last leg, its end).
    const along = last
      ? turnAt
      : lookAhead(
          v.route,
          v.routeIndex,
          here,
          Math.min(LOOK_AHEAD_MAX_M, Math.max(LOOK_AHEAD_MIN_M, v.speed * LOOK_AHEAD_S)),
        );
    // How far to the next turn, and to the end.
    const toTurn = Math.hypot(turnAt.x - here.x, turnAt.y - here.y);
    let toEnd = toTurn;
    for (let i = v.routeIndex; i < ahead.length - 1; i += 1) {
      const a = ahead[i];
      const b = ahead[i + 1];
      if (a && b) toEnd += Math.hypot(b.x - a.x, b.y - a.y);
    }
    // Another vehicle parked where it is going: it stops beside it, short of the place.
    const end = ahead[ahead.length - 1];
    const taken = end && traffic.taken ? traffic.taken(end) : 0;
    toEnd = Math.max(0, toEnd - taken);
    // Round a vehicle stopped in its way.
    const { target, speed: passing } = traffic.steer(along, toEnd, {
      from: v.route[v.routeIndex - 1] ?? here,
      to: turnAt,
    });
    passingSpeed = passing;
    const dx = target.x - here.x;
    const dy = target.y - here.y;
    const toTarget = Math.hypot(dx, dy);
    if (last && toTurn < (taken > 0 ? taken + 3 : ARRIVED_M) && v.speed < 0.6) {
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
        // Slow enough to take each bend ahead it could not brake for later (a
        // sharp one just beyond a gentle one too), and to stop at the end.
        const reach = (wanted * wanted) / (2 * type.decel * 0.8);
        let toBend = toTurn;
        for (let i = v.routeIndex; i < ahead.length - 1 && toBend <= reach; i += 1) {
          const bend = bendAt(ahead, i, here);
          if (bend > 0.2) {
            const share = Math.min(1, bend / SHARP_BEND_RAD);
            const at = Math.max(BEND_SPEED, wanted * (1 - share) + BEND_SPEED * share);
            wanted = Math.min(wanted, Math.sqrt(at * at + 2 * type.decel * 0.8 * toBend));
          }
          const a = ahead[i];
          const b = ahead[i + 1];
          if (a && b) toBend += Math.hypot(b.x - a.x, b.y - a.y);
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
  // Its interval behind the vehicle ahead (not while pivoting on the spot); slowly round one stopped.
  if (wanted > 0) wanted = Math.min(traffic.speed(wanted), passingSpeed);
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
