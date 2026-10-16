import { describe, expect, it } from 'vitest';
import {
  nextStage,
  previousBlocker,
  previousStage,
  STAGE_LABELS,
  STAGE_NAMES,
  stageBlocker,
  stageNumber,
  WORKFLOW_STAGES,
  type WorkflowRules,
  type WorkflowStage,
} from './workflow';

// The five-stage workflow (docs/adr/0025, docs/constructive-simulation/03).
// The pages' own gates are tested with them (the battle's in
// battle/planner.test.ts and battle/combat.test.ts); here, how the header
// combines a page's gates.

/** Rules with Next blocked from the stages in `blocked` (by that reason), and Back from those in `noBack`. */
function rules(
  blocked: Partial<Record<WorkflowStage, string>> = {},
  noBack: Partial<Record<WorkflowStage, string>> = {},
): WorkflowRules & { asked: WorkflowStage[] } {
  const asked: WorkflowStage[] = [];
  return {
    asked,
    next: (stage) => {
      asked.push(stage);
      return blocked[stage] ?? null;
    },
    back: (to) => noBack[to] ?? null,
  };
}

describe('the workflow', () => {
  it('has exactly five stages, numbered and named in order', () => {
    expect(WORKFLOW_STAGES.map((s) => [stageNumber(s), STAGE_NAMES[s]])).toEqual([
      [1, 'Select Terrain'],
      [2, 'Scenario Setup'],
      [3, 'BLUEFOR Planning'],
      [4, 'Combat'],
      [5, 'After-Action Review'],
    ]);
    expect(previousStage('terrain')).toBeNull();
    expect(nextStage('aar')).toBeNull();
    expect(previousStage('combat')).toBe('bluefor');
    expect(nextStage('scenario')).toBe('bluefor');
  });

  it('labels the header segments with the stages of the constructive simulation', () => {
    expect(WORKFLOW_STAGES.map((s) => STAGE_LABELS[s])).toEqual([
      'Terrain',
      'Setup',
      'Planning',
      'Sim',
      'AAR',
    ]);
  });

  it('blocks Previous at the first stage, and where the page says the way back is closed', () => {
    expect(previousBlocker('terrain', rules())).toBe('This is the first stage.');
    for (const s of ['scenario', 'bluefor', 'combat', 'aar'] as const)
      expect(previousBlocker(s, rules())).toBeNull();
    const closed = rules({}, { combat: 'The battle has ended.' });
    expect(previousBlocker('aar', closed)).toBe('The battle has ended.');
  });

  it('lets a stage segment open any earlier stage, the next one through its gate, and no further', () => {
    const open = rules();
    for (const s of ['terrain', 'scenario', 'bluefor'] as const)
      expect(stageBlocker('combat', s, open)).toBeNull();
    expect(stageBlocker('scenario', 'scenario', open)).toBeNull();
    expect(stageBlocker('scenario', 'bluefor', open)).toBeNull();
    const blocked = rules({ scenario: 'Place at least one OPFOR squad.' });
    expect(stageBlocker('scenario', 'bluefor', blocked)).toBe('Place at least one OPFOR squad.');
    // Further on: Next's reason first, then the stage to go through.
    expect(stageBlocker('scenario', 'aar', blocked)).toBe('Place at least one OPFOR squad.');
    expect(stageBlocker('scenario', 'combat', open)).toBe('Go through BLUEFOR Planning first.');
    expect(stageBlocker('terrain', 'aar', open)).toBe('Go through Scenario Setup first.');
    // Back: as the page says.
    const noBack = rules({}, { scenario: 'End the combat first.' });
    expect(stageBlocker('combat', 'scenario', noBack)).toBe('End the combat first.');
    expect(stageBlocker('combat', 'terrain', noBack)).toBeNull();
  });

  it('asks the page only about the stage being left', () => {
    const r = rules();
    stageBlocker('bluefor', 'combat', r);
    expect(r.asked).toEqual(['bluefor']);
  });
});
