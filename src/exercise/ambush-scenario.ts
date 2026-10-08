import { isOnTerrain, type Scenario, type TerrainDataset } from '#sim';
import {
  instantiateOrganization,
  validateOrganizationTemplate,
  type OrganizationInstance,
  type OrganizationTemplate,
  type TraineeOrganization,
} from './organization';
import { layoutOrp, orpPlacementProblems, orpProblems, type ObjectiveRallyPoint } from './orp';

// The administrator-authored tactical problem for an ambush exercise
// (docs/adr/0010, docs/adr/0012): the simulation scenario (terrain, both
// sides' soldiers and starting positions), the trainee's organization (a
// template instance) and its objective rally point, and the OPFOR routes.
// Immutable during the exercise.
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
  /** Where the trainee's organization starts. */
  readonly orp: ObjectiveRallyPoint;
  /**
   * The trainee's organization: every trainee soldier fills exactly one slot
   * of the template, and stands in the unit that slot belongs to.
   */
  readonly organization: TraineeOrganization;
}

/**
 * The units and soldiers of an organization instance starting in an ORP.
 * Members with an explicit `start` stand there; the rest take the ORP's
 * deterministic layout positions in member order. Throws when the template
 * or instance is invalid or the ORP cannot hold everyone.
 */
export function deployInOrp(
  template: OrganizationTemplate,
  instance: OrganizationInstance,
  orp: ObjectiveRallyPoint,
  terrain: TerrainDataset,
): ReturnType<typeof instantiateOrganization> {
  validateOrganizationTemplate(template);
  const explicit = instance.members.flatMap((m) =>
    m.start ? [{ x: m.start.east, y: m.start.north }] : [],
  );
  const laidOut = layoutOrp(
    orp,
    terrain,
    instance.members.filter((m) => !m.start).length,
    explicit,
  );
  let next = 0;
  return instantiateOrganization(template, instance, (member) => {
    if (member.start) return member.start;
    const point = laidOut[next++];
    if (!point) throw new Error('ORP layout exhausted');
    return { east: point.x, north: point.y };
  });
}

/**
 * Throws an Error describing the problems with the scenario's trainee
 * organization and ORP: an invalid template, soldiers and slots that do not
 * correspond one to one, soldiers in the wrong unit, or starting positions
 * outside the ORP, where nobody can stand, or on top of each other.
 */
export function validateTraineeSetup(scenario: AmbushScenario, traineeSide: string): void {
  const fail = (message: string): never => {
    throw new Error(`Scenario "${scenario.id}": ${message}`);
  };
  const { organization, orp } = scenario;
  try {
    validateOrganizationTemplate(organization.template);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const slots = new Map(organization.template.slots.map((s) => [s.id, s]));
  const trainees = scenario.soldiers.filter((s) => s.side === traineeSide);
  const memberOf = new Map(organization.members.map((m) => [m.soldierId, m.slotId]));
  if (new Set(organization.members.map((m) => m.slotId)).size !== organization.members.length) {
    fail('a slot of the trainee organization is filled twice');
  }
  for (const soldier of trainees) {
    const slotId =
      memberOf.get(soldier.id) ??
      fail(`trainee soldier "${soldier.id}" fills no organization slot`);
    const slot =
      slots.get(slotId) ?? fail(`soldier "${soldier.id}" fills unknown slot "${slotId}"`);
    const unitId = `${organization.unitIdPrefix}${slot.unitId}`;
    if (soldier.unitId !== unitId)
      fail(`soldier "${soldier.id}" is in unit "${soldier.unitId}", not "${unitId}"`);
  }
  if (organization.members.length !== trainees.length) {
    fail('the trainee organization lists soldiers that are not trainee soldiers of the scenario');
  }
  if (slots.size !== organization.members.length) fail('not every organization slot is filled');
  const problems = [
    ...orpProblems(orp, scenario.terrain),
    ...orpPlacementProblems(
      orp,
      scenario.terrain,
      trainees.map((s) => ({ id: s.id, point: s.position })),
    ),
  ];
  if (problems.length > 0) fail(problems.join('; '));
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
