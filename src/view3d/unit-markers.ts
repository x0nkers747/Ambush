import { TRAINEE_SIDE, type Exercise } from '#exercise';
import type { Session } from '#session';
import {
  heightAt,
  isOnTerrain,
  type Azimuth,
  type Posture,
  type SoldierId,
  type SoldierStatus,
  type Vec3,
} from '#sim';

// What the 3D view shows of the soldiers (docs/adr/0029): read from the
// exercise it is given, exactly as the 2D map reads it (live, the scenario
// preview, or a replay frame from `Exercise.replayAt`). No state of its own.

export interface UnitMarker {
  readonly id: SoldierId;
  readonly affiliation: 'friendly' | 'enemy';
  /** Where the simulation has the soldier: z is the ground (`heightAt`). */
  readonly position: Vec3;
  readonly azimuth: Azimuth;
  readonly posture: Posture;
  readonly status: SoldierStatus;
  /** Selected in the roster or on the map (alone, or with its fire team). */
  readonly selected: boolean;
}

/** A trainee soldier's planned destination that the soldier has not reached yet. */
export interface DestinationMarker {
  readonly id: SoldierId;
  readonly position: Vec3;
  readonly selected: boolean;
}

/**
 * The soldiers to draw, as the 2D map draws them (`buildScene`): every soldier
 * of the exercise, except the trainee's squad while it is hidden (a scenario
 * without an ORP yet).
 */
export function unitMarkers(
  exercise: Exercise,
  session: Session,
  hideTrainee: boolean,
): UnitMarker[] {
  const team = exercise.formationGroups.find((g) => g.unitId === session.selectedFireTeamId);
  return exercise.simulation.state.soldiers
    .filter((s) => !(hideTrainee && s.side === TRAINEE_SIDE))
    .map((s) => ({
      id: s.id,
      affiliation: s.side === TRAINEE_SIDE ? 'friendly' : 'enemy',
      position: { x: s.position.x, y: s.position.y, z: s.position.z },
      azimuth: s.azimuth,
      posture: s.posture,
      status: s.status,
      selected: session.selectedSoldierId === s.id || (team?.memberIds.includes(s.id) ?? false),
    }));
}

/**
 * Planned destinations still to be reached, as the 2D map shows them during
 * planning and while BLUEFOR moves: on the ground at the destination.
 */
export function destinationMarkers(
  exercise: Exercise,
  session: Session,
  hideTrainee: boolean,
): DestinationMarker[] {
  if (hideTrainee) return [];
  const terrain = exercise.simulation.world.terrain;
  const team = exercise.formationGroups.find((g) => g.unitId === session.selectedFireTeamId);
  return exercise.simulation.state.soldiers.flatMap((s) => {
    if (s.side !== TRAINEE_SIDE || s.status !== 'active') return [];
    const d = exercise.displayedPlan(s.id)?.destination;
    const status = exercise.deploymentStatus(s.id);
    if (!d || status === 'inPosition' || !isOnTerrain(terrain, d.east, d.north)) return [];
    // Already there (within 0.5 m): nothing to show.
    if (Math.hypot(d.east - s.position.x, d.north - s.position.y) < 0.5) return [];
    return [
      {
        id: s.id,
        position: { x: d.east, y: d.north, z: heightAt(terrain, d.east, d.north) },
        selected: session.selectedSoldierId === s.id || (team?.memberIds.includes(s.id) ?? false),
      },
    ];
  });
}
