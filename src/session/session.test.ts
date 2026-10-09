import { describe, expect, it } from 'vitest';
import { createExercise, DEMO_SCENARIO } from '#exercise';
import { soldierId } from '#sim';
import {
  clearSelection,
  createSession,
  selectFireTeam,
  selectSoldier,
  setShowVisibility,
  setTimeScale,
  setTool,
  stepTimeScale,
  TIME_SCALES,
} from './session';

const exercise = createExercise({ config: { tickRateHz: 30, seed: 0 }, scenario: DEMO_SCENARIO });

describe('session', () => {
  it('starts with no selection at 1×', () => {
    expect(createSession()).toEqual({
      selectedSoldierId: null,
      selectedFireTeamId: null,
      timeScale: 1,
      tool: 'deploy',
      showVisibility: false,
    });
  });

  it('selects BLUEFOR soldiers, one at a time', () => {
    let session = selectSoldier(createSession(), exercise, soldierId('M02'));
    expect(session.selectedSoldierId).toBe('M02');
    session = selectSoldier(session, exercise, soldierId('M07'));
    expect(session.selectedSoldierId).toBe('M07');
    expect(clearSelection(session).selectedSoldierId).toBeNull();
  });

  // Fire-team formation planning (docs/adr/0022): one team or one Marine at a time.
  it('selects a whole fire team, switching between teams and back to single Marines', () => {
    const plans = exercise.deploymentPlans();
    let session = selectSoldier(createSession(), exercise, soldierId('M02'));
    session = selectFireTeam(session, exercise, 'FT1');
    expect(session).toMatchObject({ selectedFireTeamId: 'FT1', selectedSoldierId: null });
    session = selectFireTeam(session, exercise, 'FT3');
    expect(session.selectedFireTeamId).toBe('FT3');
    session = selectSoldier(session, exercise, soldierId('M07'));
    expect(session).toMatchObject({ selectedFireTeamId: null, selectedSoldierId: 'M07' });
    session = selectFireTeam(session, exercise, 'FT2');
    expect(clearSelection(session)).toMatchObject({
      selectedFireTeamId: null,
      selectedSoldierId: null,
    });
    // Not fire teams: the squad itself, or anything unknown.
    expect(selectFireTeam(session, exercise, 'SQD')).toBe(session);
    expect(selectFireTeam(session, exercise, 'nope')).toBe(session);
    // Selection never changes a plan.
    expect(exercise.deploymentPlans()).toEqual(plans);
  });

  it('ignores OPFOR and unknown soldiers', () => {
    const session = selectSoldier(createSession(), exercise, soldierId('M01'));
    expect(selectSoldier(session, exercise, soldierId('EN-1'))).toBe(session);
    expect(selectSoldier(session, exercise, soldierId('nobody'))).toBe(session);
  });

  it('sets the time scale without touching the simulation', () => {
    const tick = exercise.simulation.tick;
    expect(setTimeScale(createSession(), 16).timeScale).toBe(16);
    expect(exercise.simulation.tick).toBe(tick);
  });

  it('offers 1×, 4×, 8× and 16×, stepping between them and stopping at the ends', () => {
    expect(TIME_SCALES).toEqual([1, 4, 8, 16]);
    let session = createSession();
    const seen: number[] = [session.timeScale];
    for (let i = 0; i < 4; i += 1) {
      session = stepTimeScale(session, 1);
      seen.push(session.timeScale);
    }
    for (let i = 0; i < 4; i += 1) {
      session = stepTimeScale(session, -1);
      seen.push(session.timeScale);
    }
    expect(seen).toEqual([1, 4, 8, 16, 16, 8, 4, 1, 1]);
  });

  it('turns the visibility overlay on and off', () => {
    expect(setShowVisibility(createSession(), true).showVisibility).toBe(true);
    expect(setShowVisibility(setShowVisibility(createSession(), true), false).showVisibility).toBe(
      false,
    );
  });

  it('switches between route and kill-zone editing', () => {
    const session = setTool(createSession(), 'killZone');
    expect(session.tool).toBe('killZone');
    expect(setTool(session, 'deploy').tool).toBe('deploy');
  });
});
