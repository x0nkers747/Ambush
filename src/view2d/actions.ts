import { ExerciseError, type Exercise } from '#exercise';
import { selectSoldier, type Session } from '#session';
import type { SoldierId } from '#sim';
import type { Camera } from './camera';
import type { MapActions } from './interaction';

/**
 * Connects map interactions to the exercise (plan edits for the selected
 * soldier, kill-zone edits) and the session (selection). Edits the exercise
 * refuses (wrong phase, a kill zone that would cross itself, …) are ignored, so
 * a drag simply stops at the last acceptable position.
 */
export function createMapActions(
  exercise: Exercise,
  session: { get: () => Session; set: (session: Session) => void },
  setCamera: (camera: Camera) => void,
): MapActions {
  const ignoreRefused = (change: () => void) => {
    try {
      change();
    } catch (error) {
      if (!(error instanceof ExerciseError)) throw error;
    }
  };
  const edit = (change: (soldierId: SoldierId) => void) => {
    const id = session.get().selectedSoldierId;
    if (id === null) return;
    ignoreRefused(() => {
      change(id);
    });
  };
  return {
    select: (id) => {
      session.set(selectSoldier(session.get(), exercise, id));
    },
    addWaypoint: (point, index) => {
      edit((id) => exercise.addWaypoint(id, point, index));
    },
    moveWaypoint: (waypoint, point) => {
      edit((id) => {
        exercise.moveWaypoint(id, waypoint, point);
      });
    },
    deleteWaypoint: (waypoint) => {
      edit((id) => {
        exercise.deleteWaypoint(id, waypoint);
      });
    },
    setFinalFacing: (azimuth) => {
      edit((id) => {
        exercise.setFinalFacing(id, azimuth);
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
