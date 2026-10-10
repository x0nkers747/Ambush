// The five-stage workflow (docs/adr/0025). A workflow stage says what the
// trainee is doing; it is not the exercise's phase. Stage 3 holds BLUEFOR
// planning and execution, stage 4 the OPFOR approach and the ambush, and the
// exercise's own phases run inside them. What blocks a stage change is read
// from the existing rules (`scenarioProblems`, `startOpforProblems`, the
// exercise phase), never from a copy of them.

export type WorkflowStage = 'terrain' | 'scenario' | 'bluefor' | 'opfor' | 'aar';

export const WORKFLOW_STAGES: readonly WorkflowStage[] = [
  'terrain',
  'scenario',
  'bluefor',
  'opfor',
  'aar',
];

export const STAGE_NAMES: Readonly<Record<WorkflowStage, string>> = {
  terrain: 'Select Terrain',
  scenario: 'Edit Scenario',
  bluefor: 'BLUEFOR Planning',
  opfor: 'OPFOR & Combat',
  aar: 'After Action Review',
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
 * What the stage gates need, read lazily from the existing state: each is
 * asked only for the stage being left.
 */
export interface WorkflowFacts {
  /** Stage 1: whether a battlefield (the demo or a saved one) is selected. */
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
        : 'Select a battlefield first: the demo, a saved one, or generate a new one.';
    case 'scenario':
      return facts.scenarioProblems()[0] ?? null;
    case 'bluefor':
      return facts.opforStarted() ? null : (facts.startOpforProblems()[0] ?? null);
    case 'opfor':
      return facts.engagementComplete()
        ? null
        : 'The After Action Review opens when the engagement is complete.';
    case 'aar':
      return 'This is the last stage.';
  }
}

/** Why Previous is not available from `stage`, or `null` when it is. */
export function previousBlocker(stage: WorkflowStage): string | null {
  return previousStage(stage) === null ? 'This is the first stage.' : null;
}
