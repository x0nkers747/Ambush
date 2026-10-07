import type { Exercise } from '#exercise';
import type { SoldierId, Vec2 } from '#sim';

// Ephemeral UI state (docs/adr/0004): never recorded, never seen by the simulation.

export const TIME_SCALES = [1, 8, 16] as const;
export type TimeScale = (typeof TIME_SCALES)[number];

/**
 * What map clicks do: edit the selected soldier's route, edit the kill zone,
 * or inspect line of sight from the selected soldier (CHECK LOS).
 */
export type MapTool = 'routes' | 'killZone' | 'los';

export interface Session {
  /** The trainee soldier whose plan is being viewed and edited, if any. */
  readonly selectedSoldierId: SoldierId | null;
  /** Ratio of simulation time to real time while executing. */
  readonly timeScale: TimeScale;
  readonly tool: MapTool;
  /** The map point being inspected with CHECK LOS. */
  readonly losTarget: Vec2 | null;
  /** Whether CHECK LOS also assesses the whole kill zone. */
  readonly losKillZone: boolean;
}

export function createSession(): Session {
  return {
    selectedSoldierId: null,
    timeScale: 1,
    tool: 'routes',
    losTarget: null,
    losKillZone: false,
  };
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

/** The next faster (`+1`) or slower (`-1`) time scale, staying at the ends. */
export function stepTimeScale(session: Session, direction: 1 | -1): Session {
  const index = TIME_SCALES.indexOf(session.timeScale) + direction;
  const timeScale = TIME_SCALES[Math.min(Math.max(index, 0), TIME_SCALES.length - 1)];
  return timeScale === undefined ? session : { ...session, timeScale };
}

export function setTool(session: Session, tool: MapTool): Session {
  return { ...session, tool };
}

export function setLosTarget(session: Session, losTarget: Vec2 | null): Session {
  return { ...session, losTarget };
}

export function setLosKillZone(session: Session, losKillZone: boolean): Session {
  return { ...session, losKillZone };
}
