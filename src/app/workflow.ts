// The five-stage workflow (docs/adr/0025, docs/constructive-simulation/03):
// Terrain, Scenario Setup, BLUEFOR Planning, Combat and the After-Action
// Review. A workflow stage says what the user is doing; it is not the
// simulation's phase. What blocks a stage change is read from the page's own
// rules (`WorkflowRules`): the battle's (scenario issues, combat ended) or the
// legacy ambush exercise's (`WorkflowFacts`: `scenarioProblems`,
// `startOpforProblems`, the exercise phase), never from a copy of them.

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
  bluefor: 'BLUEFOR Planning',
  combat: 'Combat',
  aar: 'After-Action Review',
};

/** The short labels of the header's stage segments; `STAGE_NAMES` stays the full name. */
export const STAGE_LABELS: Readonly<Record<WorkflowStage, string>> = {
  terrain: 'Terrain',
  scenario: 'Setup',
  bluefor: 'BLUEFOR',
  combat: 'Combat',
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

/**
 * What the legacy ambush exercise's stage gates need, read lazily from its
 * state: each is asked only for the stage being left.
 */
export interface WorkflowFacts {
  /** Stage 1: whether a saved battlefield is selected. */
  readonly battlefieldSelected: () => boolean;
  /** Stage 2: why the scenario cannot be played (`scenarioProblems`); empty when it can. */
  readonly scenarioProblems: () => readonly string[];
  /** Stage 3: why START OPFOR is not available (`startOpforProblems`); empty when it is. */
  readonly startOpforProblems: () => readonly string[];
  /** Whether START OPFOR has been pressed: stage 4 then stays open. */
  readonly opforStarted: () => boolean;
  /** Whether the engagement has ended: the After Action Review opens then. */
  readonly engagementComplete: () => boolean;
}

/** Why Next is not available from `stage`, or `null` when it is. */
export function nextBlocker(stage: WorkflowStage, facts: WorkflowFacts): string | null {
  switch (stage) {
    case 'terrain':
      return facts.battlefieldSelected()
        ? null
        : 'Select a battlefield first: a saved one, or generate a new one.';
    case 'scenario':
      return facts.scenarioProblems()[0] ?? null;
    case 'bluefor':
      return facts.opforStarted() ? null : (facts.startOpforProblems()[0] ?? null);
    case 'combat':
      return facts.engagementComplete()
        ? null
        : 'The After Action Review opens when the engagement is complete.';
    case 'aar':
      return 'This is the last stage.';
  }
}

/** The legacy exercise's gates as `WorkflowRules`. */
export function factsRules(facts: WorkflowFacts): WorkflowRules {
  return {
    next: (stage) => nextBlocker(stage, facts),
    back: (to) => backBlocker(to, facts),
  };
}

const rulesOf = (r: WorkflowFacts | WorkflowRules): WorkflowRules =>
  'next' in r ? r : factsRules(r);

/** Why Previous is not available from `stage`, or `null` when it is. */
export function previousBlocker(
  stage: WorkflowStage,
  facts: WorkflowFacts | WorkflowRules,
): string | null {
  const previous = previousStage(stage);
  return previous === null ? 'This is the first stage.' : rulesOf(facts).back(previous);
}

/**
 * Why an earlier stage cannot be returned to, or `null` when it can: once
 * OPFOR has started, the scenario and the BLUEFOR plan are behind the
 * trainee for good. Terrain selection stays open (leaving the battlefield).
 */
export function backBlocker(to: WorkflowStage, facts: WorkflowFacts): string | null {
  return facts.opforStarted() && (to === 'scenario' || to === 'bluefor')
    ? `OPFOR has started: there is no going back to ${STAGE_NAMES[to]}. Choose Terrain to leave the battlefield.`
    : null;
}

/**
 * Why the header cannot go straight from `from` to `to`, or `null` when it
 * can. An earlier stage is open unless `backBlocker` says no, as for
 * Previous. The next stage has Next's gate. A later one is reached only
 * through the next, since entering a stage does work (building the exercise)
 * that skipping would miss.
 */
export function stageBlocker(
  from: WorkflowStage,
  to: WorkflowStage,
  facts: WorkflowFacts | WorkflowRules,
): string | null {
  const rules = rulesOf(facts);
  const next = nextStage(from);
  if (to === from) return null;
  if (stageNumber(to) < stageNumber(from)) return rules.back(to);
  if (to === next) return rules.next(from);
  return next === null ? null : (rules.next(from) ?? `Go through ${STAGE_NAMES[next]} first.`);
}
