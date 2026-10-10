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
      [2, 'Edit Scenario'],
      [3, 'BLUEFOR Planning'],
      [4, 'OPFOR & Combat'],
      [5, 'After Action Review'],
    ]);
    expect(previousStage('terrain')).toBeNull();
    expect(nextStage('aar')).toBeNull();
    expect(previousStage('opfor')).toBe('bluefor');
    expect(nextStage('scenario')).toBe('bluefor');
  });

  it('blocks Previous only at the first stage and Next only at the last or on an unmet prerequisite', () => {
    expect(previousBlocker('terrain')).toBe('This is the first stage.');
    for (const s of ['scenario', 'bluefor', 'opfor', 'aar'] as const)
      expect(previousBlocker(s)).toBeNull();
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
      startOpforProblems: () => ['BLUEFOR has not occupied its positions: Execute the plan first.'],
    });
    expect(nextBlocker('bluefor', blocked)).toMatch(/Execute the plan first/);
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
    expect(nextBlocker('opfor', facts())).toMatch(/engagement is complete/);
    expect(nextBlocker('opfor', facts({ engagementComplete: () => true }))).toBeNull();
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

  it('labels the header segments as the reference bar does', () => {
    expect(WORKFLOW_STAGES.map((s) => STAGE_LABELS[s])).toEqual([
      'Terrain',
      'Edit Scenario',
      'BLUEFOR',
      'OPFOR',
      'AAR',
    ]);
  });

  it('lets a stage segment open any earlier stage, the next one through its gate, and no further', () => {
    const open = facts({ engagementComplete: () => true });
    for (const s of ['terrain', 'scenario', 'bluefor'] as const)
      expect(stageBlocker('opfor', s, open)).toBeNull();
    expect(stageBlocker('scenario', 'bluefor', open)).toBeNull();
    expect(
      stageBlocker('scenario', 'bluefor', facts({ scenarioProblems: () => ['Place the OPFOR.'] })),
    ).toBe('Place the OPFOR.');
    // Further on: Next's reason first, then the stage to go through.
    expect(
      stageBlocker('scenario', 'aar', facts({ scenarioProblems: () => ['Place the OPFOR.'] })),
    ).toBe('Place the OPFOR.');
    expect(stageBlocker('scenario', 'opfor', open)).toBe('Go through BLUEFOR Planning first.');
    expect(stageBlocker('terrain', 'aar', open)).toBe('Go through Edit Scenario first.');
  });
});
