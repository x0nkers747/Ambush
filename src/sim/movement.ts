import type { SimEvent } from './events';
import { azimuthDelta, azimuthOf, turnToward } from './geometry';
import type { PathPoint } from './bridge-navigation';
import { surfaceHeightAt } from './bridge-navigation';
import type { ActiveOrders, SimState, Soldier } from './state';
import type { SimWorld } from './world';

// Movement system (docs/adr/0008, docs/adr/0011). Soldiers travel at constant
// ground speed in straight lines between waypoints, or between the turn points
// navigation generated to take a leg around buildings. The path depends only on the waypoints and
// on simulation time, never on the tick length: each tick is split at every
// waypoint arrival, and the remaining time carries on to the next leg.
// Facing turns toward the direction of travel at a limited rate but does not
// steer the path.
//
// Navigation (docs/adr/0011, docs/adr/0043) plans how each leg is travelled:
// the turn points stored alongside the progress in `ActiveOrders`; the
// `Orders` stay as given.
//
// Height: a soldier stands on the surface (`surfaceHeightAt`: the ground, or
// a bridge's deck over water). Between two route points that both carry a
// deck height (a bridge's centreline), it follows the deck's profile between
// them instead, so a soldier crossing a bridge stays on it over dry land too.

/**
 * Tolerance, in seconds of travel or turning, for completing a leg or a turn
 * within the current tick. Absorbs rounding so that an arrival falling exactly
 * on a tick boundary is not left a few ulps short at some tick rates.
 */
const COMPLETION_EPSILON_SECONDS = 1e-9;

/** The tick being executed. */
export interface TickTime {
  readonly tick: number;
  /** Simulation time at the start of the tick. */
  readonly startSeconds: number;
  readonly dtSeconds: number;
}

/** Moves every soldier following individual orders through the tick. */
export function moveSoldiers(
  state: SimState,
  world: SimWorld,
  time: TickTime,
  events: SimEvent[],
): void {
  for (const soldier of state.soldiers) moveSoldier(soldier, world, time, events);
}

function moveSoldier(soldier: Soldier, world: SimWorld, time: TickTime, events: SimEvent[]): void {
  const active = soldier.orders;
  if (active === null || active.behavior === 'inPosition') return;

  const { speed, maxTurnRate } = world.movement;
  const { waypoints, finalFacing } = active.orders;
  /** Seconds of this tick used so far. */
  let elapsed = 0;

  while (active.behavior === 'moving') {
    const waypoint = waypoints[active.nextWaypointIndex];
    if (waypoint === undefined) {
      active.behavior = 'facing';
      break;
    }
    // Walk the leg's generated turn points first; only the waypoint itself is the author's intent.
    const turn = active.legPaths[active.nextWaypointIndex]?.[active.nextTurnIndex];
    const target = turn ?? waypoint;
    const remaining = time.dtSeconds - elapsed;
    const dx = target.x - soldier.position.x;
    const dy = target.y - soldier.position.y;
    const distance = Math.hypot(dx, dy);
    const legSeconds = distance / speed;
    const arrives = legSeconds <= remaining + COMPLETION_EPSILON_SECONDS;
    const seconds = Math.min(legSeconds, remaining);

    if (distance > 0) {
      soldier.azimuth = turnToward(soldier.azimuth, azimuthOf(dx, dy), maxTurnRate * seconds);
    }
    const previous = previousPoint(active);
    if (!arrives) {
      const fraction = (speed * seconds) / distance;
      place(
        soldier,
        world,
        soldier.position.x + dx * fraction,
        soldier.position.y + dy * fraction,
        previous,
        target,
      );
      return;
    }

    // Arrive exactly on the point and carry the rest of the tick forward.
    place(soldier, world, target.x, target.y, previous, target);
    elapsed += seconds;
    if (turn) {
      active.nextTurnIndex += 1;
      continue;
    }
    active.nextWaypointIndex += 1;
    active.nextTurnIndex = 0;
    if (active.nextWaypointIndex === waypoints.length) active.behavior = 'facing';
    events.push({
      type: 'waypointReached',
      tick: time.tick,
      soldierId: soldier.id,
      waypointId: waypoint.id,
      atSeconds: time.startSeconds + elapsed,
    });
  }

  // Facing: the last waypoint has been reached; turn to the final facing.
  const remaining = time.dtSeconds - elapsed;
  const turnSeconds = Math.abs(azimuthDelta(soldier.azimuth, finalFacing)) / maxTurnRate;
  if (turnSeconds > remaining + COMPLETION_EPSILON_SECONDS) {
    soldier.azimuth = turnToward(soldier.azimuth, finalFacing, maxTurnRate * remaining);
    return;
  }
  soldier.azimuth = finalFacing;
  active.behavior = 'inPosition';
  events.push({
    type: 'soldierInPosition',
    tick: time.tick,
    soldierId: soldier.id,
    atSeconds: time.startSeconds + elapsed + Math.min(turnSeconds, remaining),
  });
}

/** The route point the soldier is walking from, if it is one (not where the orders were given). */
function previousPoint(active: ActiveOrders): PathPoint | null {
  const leg = active.nextWaypointIndex;
  if (active.nextTurnIndex > 0) return active.legPaths[leg]?.[active.nextTurnIndex - 1] ?? null;
  return leg > 0 ? (active.orders.waypoints[leg - 1] ?? null) : null;
}

/**
 * Places a soldier at (x, y) on the way from `previous` to `target`: on the
 * deck's profile when both are deck points, else on the surface there.
 */
function place(
  soldier: Soldier,
  world: SimWorld,
  x: number,
  y: number,
  previous: PathPoint | null,
  target: PathPoint,
): void {
  soldier.position.x = x;
  soldier.position.y = y;
  if (previous?.z !== undefined && target.z !== undefined) {
    const length = Math.hypot(target.x - previous.x, target.y - previous.y);
    const t =
      length > 0
        ? Math.min(1, Math.max(0, Math.hypot(x - previous.x, y - previous.y) / length))
        : 1;
    soldier.position.z = previous.z + t * (target.z - previous.z);
    return;
  }
  soldier.position.z = surfaceHeightAt(world.terrain, x, y);
}
