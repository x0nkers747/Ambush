import { ExerciseError, type Exercise } from '#exercise';
import { selectSoldier, type Session } from '#session';
import type { SoldierId } from '#sim';
import { formatBearing } from './bearing';
import type { Camera } from './camera';
import type { MapActions } from './interaction';

/**
 * Connects map interactions to the exercise (plan edits for the selected
 * soldier or fire team, kill-zone edits) and the session (selection).
 * Edits the exercise refuses (a destination inside a building, a kill zone that
 * would cross itself, …) change nothing and are reported through `notify`, so
 * a drag simply stops at the last acceptable position.
 */
export function createMapActions(
  exercise: Exercise,
  session: { get: () => Session; set: (session: Session) => void },
  setCamera: (camera: Camera) => void,
  /**
   * Tells the trainee why an edit was refused (e.g. a destination inside a
   * building), that a formation was placed, or that a Marine left one.
   */
  notify: (message: string) => void = () => undefined,
): MapActions {
  const ignoreRefused = (change: () => void) => {
    try {
      change();
    } catch (error) {
      if (!(error instanceof ExerciseError)) throw error;
      notify(error.message);
    }
  };
  const label = (id: SoldierId) => exercise.rosterMember(id)?.slot.label ?? id;
  /** The formations (squad's, fire team's) the soldier still follows. */
  const following = (id: SoldierId) =>
    exercise.formationGroups.filter(
      (g) => exercise.formation(g.unitId)?.linked.includes(id) ?? false,
    );
  const edit = (change: (soldierId: SoldierId) => void) => {
    const id = session.get().selectedSoldierId;
    if (id === null) return;
    const before = following(id);
    ignoreRefused(() => {
      change(id);
    });
    const left = before.filter((g) => !following(id).includes(g));
    const group = left[0];
    if (group) {
      notify(
        `${label(id)} now has separate orders: moving or turning the ${group.name}'s formation no longer changes them.`,
      );
    }
  };
  /** An edit of the selected fire team's formation. */
  const editTeam = (change: (unitId: string) => void) => {
    const unitId = session.get().selectedFireTeamId;
    if (unitId === null) return;
    ignoreRefused(() => {
      change(unitId);
    });
  };
  return {
    select: (id) => {
      session.set(selectSoldier(session.get(), exercise, id));
    },
    setDestination: (point) => {
      edit((id) => {
        exercise.setDestination(id, point);
      });
    },
    clearDestination: () => {
      edit((id) => {
        exercise.clearDestination(id);
      });
    },
    setFacing: (azimuth) => {
      edit((id) => {
        exercise.setFacing(id, azimuth);
      });
    },
    placeFormation: (point) => {
      editTeam((unitId) => {
        const formation = exercise.placeFormation(unitId, point);
        const team = exercise.formationGroups.find((t) => t.unitId === unitId);
        const moved = (ids: readonly SoldierId[], where: string) =>
          ids.length > 0
            ? ` ${ids.map(label).join(', ')} ${ids.length === 1 ? 'was' : 'were'} moved ${where}.`
            : '';
        notify(
          `${team?.name ?? unitId} placed: ${String(formation.slots.length)} Marines ${String(formation.spacingM)} m apart, facing ${formatBearing(formation.azimuth)}.${moved(
            formation.movedClear,
            'clear of a building',
          )}${moved(formation.movedAshore, 'out of the water onto the bank')}`,
        );
      });
    },
    moveFormation: (point) => {
      editTeam((unitId) => {
        exercise.moveFormation(unitId, point);
      });
    },
    setFormationFacing: (azimuth) => {
      editTeam((unitId) => {
        exercise.setFormationFacing(unitId, azimuth);
      });
    },
    clearFormation: () => {
      editTeam((unitId) => {
        exercise.clearFormation(unitId);
      });
    },
    addKillZoneVertex: (point, index) => {
      ignoreRefused(() => {
        exercise.addKillZoneVertex(point, index);
      });
    },
    moveKillZoneVertex: (index, point) => {
      ignoreRefused(() => {
        exercise.moveKillZoneVertex(index, point);
      });
    },
    deleteKillZoneVertex: (index) => {
      ignoreRefused(() => {
        exercise.deleteKillZoneVertex(index);
      });
    },
    setCamera,
  };
}
