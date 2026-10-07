import { ExerciseError, type Exercise } from '#exercise';
import { selectSoldier, type Session } from '#session';
import type { SoldierId } from '#sim';
import type { Camera } from './camera';
import type { MapActions } from './interaction';

/**
 * Connects map interactions to the exercise (plan edits for the selected
 * soldier) and the session (selection). Edits the current phase or soldier does
 * not allow are ignored: the map only offers them when they are allowed.
 */
export function createMapActions(
  exercise: Exercise,
  session: { get: () => Session; set: (session: Session) => void },
  setCamera: (camera: Camera) => void,
): MapActions {
  const edit = (change: (soldierId: SoldierId) => void) => {
    const id = session.get().selectedSoldierId;
    if (id === null) return;
    try {
      change(id);
    } catch (error) {
      if (!(error instanceof ExerciseError)) throw error;
    }
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
    setCamera,
  };
}
