import type { Exercise } from '#exercise';
import type { SoldierId } from '#sim';

// Ephemeral UI state (docs/adr/0004): never recorded, never seen by the simulation.

export const TIME_SCALES = [1, 2, 4] as const;
export type TimeScale = (typeof TIME_SCALES)[number];

export interface Session {
  /** The trainee soldier whose plan is being viewed and edited, if any. */
  readonly selectedSoldierId: SoldierId | null;
  /** Ratio of simulation time to real time while executing. */
  readonly timeScale: TimeScale;
}

export function createSession(): Session {
  return { selectedSoldierId: null, timeScale: 1 };
}

/**
 * Selects a soldier the trainee can plan for. Returns the session unchanged
 * for any other soldier (e.g. OPFOR).
 */
export function selectSoldier(session: Session, exercise: Exercise, id: SoldierId): Session {
  return exercise.isPlannable(id) ? { ...session, selectedSoldierId: id } : session;
}

export function clearSelection(session: Session): Session {
  return { ...session, selectedSoldierId: null };
}

export function setTimeScale(session: Session, timeScale: TimeScale): Session {
  return { ...session, timeScale };
}
