import type { Exercise } from '#exercise';
import type { SoldierId } from '#sim';

// Ephemeral UI state (docs/adr/0004): never recorded, never seen by the simulation.

export const TIME_SCALES = [1, 4, 8, 16] as const;
export type TimeScale = (typeof TIME_SCALES)[number];

/**
 * What map clicks edit: the selected soldier's destination and facing, or the
 * kill zone; with `view`, nothing (clicks only select), e.g. once planning is
 * over (docs/adr/0025).
 */
export type MapTool = 'deploy' | 'killZone' | 'view';

export interface Session {
  /** The trainee soldier whose plan is being viewed and edited, if any. */
  readonly selectedSoldierId: SoldierId | null;
  /**
   * The fire team (template unit id) selected for formation planning
   * (docs/adr/0022), if any. Never set together with `selectedSoldierId`.
   */
  readonly selectedFireTeamId: string | null;
  /** Ratio of simulation time to real time while executing. */
  readonly timeScale: TimeScale;
  readonly tool: MapTool;
  /** Whether the selected soldier's visible area (viewshed) is shown. */
  readonly showVisibility: boolean;
}

export function createSession(): Session {
  return {
    selectedSoldierId: null,
    selectedFireTeamId: null,
    timeScale: 1,
    tool: 'deploy',
    showVisibility: false,
  };
}

/**
 * Selects a soldier the trainee can plan for. Returns the session unchanged
 * for any other soldier (e.g. OPFOR).
 */
export function selectSoldier(session: Session, exercise: Exercise, id: SoldierId): Session {
  return exercise.isPlannable(id)
    ? { ...session, selectedSoldierId: id, selectedFireTeamId: null }
    : session;
}

/**
 * Selects a whole fire team (one at a time) in place of any single soldier.
 * Returns the session unchanged for anything that is not a fire team.
 * Selecting never changes a plan.
 */
export function selectFireTeam(session: Session, exercise: Exercise, unitId: string): Session {
  return exercise.formationGroups.some((t) => t.unitId === unitId)
    ? { ...session, selectedSoldierId: null, selectedFireTeamId: unitId }
    : session;
}

export function clearSelection(session: Session): Session {
  return { ...session, selectedSoldierId: null, selectedFireTeamId: null };
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

export function setShowVisibility(session: Session, showVisibility: boolean): Session {
  return { ...session, showVisibility };
}
