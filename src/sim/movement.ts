import type { SimEvent } from './events';
import { azimuthDelta, azimuthOf, turnToward } from './geometry';
import type { SimState, Soldier } from './state';
import { heightAt } from './terrain';
import type { SimWorld } from './world';

// Movement system (docs/adr/0008). Soldiers travel in straight lines between
// waypoints at constant ground speed. The path depends only on the waypoints and
// on simulation time, never on the tick length: each tick is split at every
// waypoint arrival, and the remaining time carries on to the next leg.
// Facing turns toward the direction of travel at a limited rate but does not
// steer the path.
//
// Navigation seam: a leg is currently the straight line to the next waypoint.
// A future pathfinder replaces only how a leg is travelled (a route stored
// alongside the progress in `ActiveOrders`); the trainee's `Orders` stay as given.

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
    const remaining = time.dtSeconds - elapsed;
    const dx = waypoint.x - soldier.position.x;
    const dy = waypoint.y - soldier.position.y;
    const distance = Math.hypot(dx, dy);
    const legSeconds = distance / speed;
    const arrives = legSeconds <= remaining + COMPLETION_EPSILON_SECONDS;
    const seconds = Math.min(legSeconds, remaining);

    if (distance > 0) {
      soldier.azimuth = turnToward(soldier.azimuth, azimuthOf(dx, dy), maxTurnRate * seconds);
    }
    if (!arrives) {
      const fraction = (speed * seconds) / distance;
      placeOnTerrain(
        soldier,
        world,
        soldier.position.x + dx * fraction,
        soldier.position.y + dy * fraction,
      );
      return;
    }

    // Arrive exactly on the waypoint and carry the rest of the tick forward.
    placeOnTerrain(soldier, world, waypoint.x, waypoint.y);
    elapsed += seconds;
    active.nextWaypointIndex += 1;
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

function placeOnTerrain(soldier: Soldier, world: SimWorld, x: number, y: number): void {
  soldier.position.x = x;
  soldier.position.y = y;
  soldier.position.z = heightAt(world.terrain, x, y);
}
