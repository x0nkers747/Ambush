// The five-stage workflow (docs/adr/0025, docs/constructive-simulation/03):
// Terrain, Scenario Setup, Planning, Combat and the After-Action
// Review. A workflow stage says what the user is doing; it is not the
// simulation's phase. What blocks a stage change is read from the page's own
// rules (`WorkflowRules`: terrain selection's, or the battle's: its scenario's
// issues, the combat ended), never from a copy of them.

export type WorkflowStage = 'terrain' | 'scenario' | 'bluefor' | 'combat' | 'aar';

export const WORKFLOW_STAGES: readonly WorkflowStage[] = [
  'terrain',
  'scenario',
  'bluefor',
  'combat',
  'aar',
];

export const STAGE_NAMES: Readonly<Record<WorkflowStage, string>> = {
  terrain: 'Select Terrain',
  scenario: 'Scenario Setup',
  bluefor: 'Planning',
  combat: 'Combat',
  aar: 'After-Action Review',
};

/** The short labels of the header's stage segments; `STAGE_NAMES` stays the full name. */
export const STAGE_LABELS: Readonly<Record<WorkflowStage, string>> = {
  terrain: 'Terrain',
  scenario: 'Setup',
  bluefor: 'Planning',
  combat: 'Sim',
  aar: 'AAR',
};

/** 1 to 5. */
export function stageNumber(stage: WorkflowStage): number {
  return WORKFLOW_STAGES.indexOf(stage) + 1;
}

export function previousStage(stage: WorkflowStage): WorkflowStage | null {
  return WORKFLOW_STAGES[WORKFLOW_STAGES.indexOf(stage) - 1] ?? null;
}

export function nextStage(stage: WorkflowStage): WorkflowStage | null {
  return WORKFLOW_STAGES[WORKFLOW_STAGES.indexOf(stage) + 1] ?? null;
}

/**
 * A page's stage gates: why Next is not available from a stage, and why an
 * earlier stage cannot be returned to (`null` when it can).
 */
export interface WorkflowRules {
  next(stage: WorkflowStage): string | null;
  back(to: WorkflowStage): string | null;
}

/** Why Previous is not available from `stage`, or `null` when it is. */
export function previousBlocker(stage: WorkflowStage, rules: WorkflowRules): string | null {
  const previous = previousStage(stage);
  return previous === null ? 'This is the first stage.' : rules.back(previous);
}

/**
 * Why the header cannot go straight from `from` to `to`, or `null` when it
 * can. An earlier stage is open unless the rules' `back` says no, as for
 * Previous. The next stage has Next's gate. A later one is reached only
 * through the next, since entering a stage does work (starting the battle,
 * replaying it) that skipping would miss.
 */
export function stageBlocker(
  from: WorkflowStage,
  to: WorkflowStage,
  rules: WorkflowRules,
): string | null {
  const next = nextStage(from);
  if (to === from) return null;
  if (stageNumber(to) < stageNumber(from)) return rules.back(to);
  if (to === next) return rules.next(from);
  return next === null ? null : (rules.next(from) ?? `Go through ${STAGE_NAMES[next]} first.`);
}
