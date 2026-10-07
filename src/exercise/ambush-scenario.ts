import { isOnTerrain, type Scenario } from '#sim';

// The administrator-authored tactical problem for an ambush exercise
// (docs/adr/0010): the simulation scenario (terrain, both sides' soldiers and
// starting positions) plus the OPFOR routes. Immutable during the exercise.
// OPFOR routes are deliberately a separate concept from the trainee's
// BLUEFOR plans (`SoldierPlan`), even though both are lists of waypoints.

/** A waypoint of an administrator-defined route, with an id stable across exercises. */
export interface ScenarioRouteWaypoint {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

/** The route one OPFOR soldier follows once the trainee starts the OPFOR approach. */
export interface OpforRoute {
  readonly id: string;
  /** The OPFOR soldier that follows this route, from its scenario starting position. */
  readonly soldierId: string;
  readonly waypoints: readonly ScenarioRouteWaypoint[];
  /** Facing at the end of the route, in degrees clockwise from grid north. */
  readonly finalFacingDeg: number;
  /**
   * Whether the trainee may see this route on the map. A scenario setting: some
   * exercises reveal the expected enemy route, others will not.
   */
  readonly shownToTrainee: boolean;
}

export interface AmbushScenario extends Scenario {
  readonly opforRoutes: readonly OpforRoute[];
}

/** Throws an Error describing the first problem with the scenario's OPFOR routes. */
export function validateOpforRoutes(scenario: AmbushScenario, traineeSide: string): void {
  const fail = (message: string): never => {
    throw new Error(`Scenario "${scenario.id}": ${message}`);
  };
  const routeIds = new Set<string>();
  const waypointIds = new Set<string>();
  const routedSoldiers = new Set<string>();
  for (const route of scenario.opforRoutes) {
    if (routeIds.has(route.id)) fail(`duplicate route id "${route.id}"`);
    routeIds.add(route.id);
    const soldier = scenario.soldiers.find((s) => s.id === route.soldierId);
    if (!soldier) fail(`route "${route.id}" is for unknown soldier "${route.soldierId}"`);
    if (soldier?.side === traineeSide) fail(`route "${route.id}" is for a trainee soldier`);
    if (routedSoldiers.has(route.soldierId)) fail(`soldier "${route.soldierId}" has two routes`);
    routedSoldiers.add(route.soldierId);
    if (route.waypoints.length === 0) fail(`route "${route.id}" has no waypoints`);
    if (!Number.isFinite(route.finalFacingDeg)) fail(`route "${route.id}" has a non-finite facing`);
    for (const w of route.waypoints) {
      if (waypointIds.has(w.id)) fail(`duplicate route waypoint id "${w.id}"`);
      waypointIds.add(w.id);
      if (!isOnTerrain(scenario.terrain, w.x, w.y))
        fail(`route waypoint "${w.id}" is off the terrain`);
    }
  }
}
