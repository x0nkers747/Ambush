import { ExerciseError, samePlan, TRAINEE_SIDE, type Exercise } from '#exercise';
import { azimuthFromDegrees } from '#sim';

// Restarting an exercise without losing the trainee's work (docs/adr/0025):
// a new exercise (after a scenario change, or an explicit restart) gets the
// old one's kill zone, fire-team formations and each Marine's destination and
// facing, wherever the new exercise accepts them. Everything goes through the
// exercise's own edits, so nothing it would refuse is carried over.

export interface CarryResult {
  /** Marines whose plan was carried over unchanged (including those without one). */
  readonly kept: number;
  /** Marines (and the kill zone) whose plan could not be kept, and why. */
  readonly problems: readonly string[];
}

const reason = (error: unknown): string => {
  if (error instanceof ExerciseError) return error.message;
  throw error;
};

/** Copies the plans shown in `from` into `to`, which must be in BLUEFOR planning. */
export function carryPlans(from: Exercise, to: Exercise): CarryResult {
  const problems: string[] = [];
  const zone = from.killZone;
  if (zone) {
    try {
      for (const v of zone.vertices) to.addKillZoneVertex(v);
    } catch (error) {
      to.clearKillZone();
      problems.push(`Kill zone not kept: ${reason(error)}`);
    }
  }
  // Formations first, the squad's before its fire teams' (as they are listed):
  // placing one re-links its Marines, and Marines with their own orders are
  // then given them below, as they had them.
  for (const team of from.formationGroups) {
    const formation = from.formation(team.unitId);
    if (!formation) continue;
    try {
      to.placeFormation(team.unitId, formation.centre, formation.azimuth);
    } catch (error) {
      problems.push(`${team.name} formation not kept: ${reason(error)}`);
    }
  }
  let kept = 0;
  for (const soldier of from.simulation.state.soldiers) {
    if (soldier.side !== TRAINEE_SIDE || !from.isPlannable(soldier.id)) continue;
    const plan = from.displayedPlan(soldier.id);
    const now = to.displayedPlan(soldier.id);
    if (!plan || !now) continue;
    if (!samePlan(plan, now)) {
      try {
        if (plan.destination)
          to.setDestination(soldier.id, { x: plan.destination.east, y: plan.destination.north });
        else to.clearDestination(soldier.id);
        if (plan.facingDegrees === null) to.clearFacing(soldier.id);
        else to.setFacing(soldier.id, azimuthFromDegrees(plan.facingDegrees));
      } catch (error) {
        to.clearDestination(soldier.id);
        to.clearFacing(soldier.id);
        const label = from.rosterMember(soldier.id)?.slot.label ?? soldier.id;
        problems.push(`${label}: ${reason(error)}`);
      }
    }
    const result = to.displayedPlan(soldier.id);
    if (result && samePlan(plan, result)) kept += 1;
  }
  return { kept, problems };
}
