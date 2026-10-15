import { describe, expect, it } from 'vitest';
import {
  nextBlocker,
  nextStage,
  previousBlocker,
  previousStage,
  STAGE_LABELS,
  STAGE_NAMES,
  stageBlocker,
  stageNumber,
  WORKFLOW_STAGES,
  type WorkflowFacts,
} from './workflow';

// The five-stage workflow (docs/adr/0025).

const facts = (over: Partial<WorkflowFacts> = {}): WorkflowFacts => ({
  battlefieldSelected: () => true,
  scenarioProblems: () => [],
  startOpforProblems: () => [],
  opforStarted: () => false,
  engagementComplete: () => false,
  ...over,
});

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

  it('blocks Previous only at the first stage and Next only at the last or on an unmet prerequisite', () => {
    expect(previousBlocker('terrain', facts())).toBe('This is the first stage.');
    for (const s of ['scenario', 'bluefor', 'combat', 'aar'] as const)
      expect(previousBlocker(s, facts())).toBeNull();
    expect(nextBlocker('aar', facts())).toBe('This is the last stage.');
  });

  it('needs a selected battlefield to leave terrain selection', () => {
    expect(nextBlocker('terrain', facts())).toBeNull();
    expect(nextBlocker('terrain', facts({ battlefieldSelected: () => false }))).toMatch(
      /Select a battlefield/,
    );
  });

  it('uses the scenario rules to leave scenario editing, reporting the first problem', () => {
    expect(nextBlocker('scenario', facts())).toBeNull();
    expect(
      nextBlocker(
        'scenario',
        facts({ scenarioProblems: () => ['Place the OPFOR.', 'Give the OPFOR a route.'] }),
      ),
    ).toBe('Place the OPFOR.');
  });

  it('uses the START OPFOR rules to leave BLUEFOR planning, and stays open once OPFOR has started', () => {
    const blocked = facts({
      startOpforProblems: () => ['BLUEFOR has not occupied its positions: press Move first.'],
    });
    expect(nextBlocker('bluefor', blocked)).toMatch(/press Move first/);
    expect(nextBlocker('bluefor', facts())).toBeNull();
    // After START OPFOR the exercise reports "already started": that never blocks stage 4.
    expect(
      nextBlocker(
        'bluefor',
        facts({
          opforStarted: () => true,
          startOpforProblems: () => ['OPFOR has already been started.'],
        }),
      ),
    ).toBeNull();
  });

  it('opens the After Action Review once the engagement is complete', () => {
    expect(nextBlocker('combat', facts())).toMatch(/engagement is complete/);
    expect(nextBlocker('combat', facts({ engagementComplete: () => true }))).toBeNull();
  });

  it('asks only for the facts of the stage being left', () => {
    const asked: string[] = [];
    const spy = (name: string, value: unknown) => () => {
      asked.push(name);
      return value as never;
    };
    const f: WorkflowFacts = {
      battlefieldSelected: spy('battlefieldSelected', true),
      scenarioProblems: spy('scenarioProblems', []),
      startOpforProblems: spy('startOpforProblems', []),
      opforStarted: spy('opforStarted', false),
      engagementComplete: spy('engagementComplete', false),
    };
    nextBlocker('scenario', f);
    expect(asked).toEqual(['scenarioProblems']);
  });

  it('labels the header segments with the stages of the constructive simulation', () => {
    expect(WORKFLOW_STAGES.map((s) => STAGE_LABELS[s])).toEqual([
      'Terrain',
      'Setup',
      'BLUEFOR',
      'Combat',
      'AAR',
    ]);
  });

  it('lets a stage segment open any earlier stage, the next one through its gate, and no further', () => {
    const open = facts({ engagementComplete: () => true });
    for (const s of ['terrain', 'scenario', 'bluefor'] as const)
      expect(stageBlocker('combat', s, open)).toBeNull();
    expect(stageBlocker('scenario', 'bluefor', open)).toBeNull();
    expect(
      stageBlocker('scenario', 'bluefor', facts({ scenarioProblems: () => ['Place the OPFOR.'] })),
    ).toBe('Place the OPFOR.');
    // Further on: Next's reason first, then the stage to go through.
    expect(
      stageBlocker('scenario', 'aar', facts({ scenarioProblems: () => ['Place the OPFOR.'] })),
    ).toBe('Place the OPFOR.');
    expect(stageBlocker('scenario', 'combat', open)).toBe('Go through BLUEFOR Planning first.');
    expect(stageBlocker('terrain', 'aar', open)).toBe('Go through Scenario Setup first.');
  });

  it('allows no way back to the scenario or BLUEFOR planning once OPFOR has started', () => {
    const started = facts({ opforStarted: () => true, engagementComplete: () => true });
    expect(previousBlocker('combat', started)).toMatch(
      /^OPFOR has started: there is no going back to BLUEFOR Planning\. Choose Terrain/,
    );
    expect(stageBlocker('combat', 'scenario', started)).toMatch(/no going back to Scenario Setup/);
    expect(stageBlocker('aar', 'bluefor', started)).toMatch(/no going back to BLUEFOR Planning/);
    // Terrain selection (leaving the battlefield) and the AAR's way back to combat stay open.
    expect(stageBlocker('combat', 'terrain', started)).toBeNull();
    expect(previousBlocker('aar', started)).toBeNull();
    // Before OPFOR starts, every earlier stage is open.
    expect(stageBlocker('combat', 'scenario', facts())).toBeNull();
    expect(previousBlocker('combat', facts())).toBeNull();
  });
});
