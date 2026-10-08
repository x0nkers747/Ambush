import { describe, expect, it } from 'vitest';
import { createExercise, DEMO_SCENARIO } from '#exercise';
import { soldierId } from '#sim';
import {
  clearSelection,
  createSession,
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

  it('offers 1×, 8× and 16×, stepping between them and stopping at the ends', () => {
    expect(TIME_SCALES).toEqual([1, 8, 16]);
    let session = createSession();
    const seen: number[] = [session.timeScale];
    for (let i = 0; i < 3; i += 1) {
      session = stepTimeScale(session, 1);
      seen.push(session.timeScale);
    }
    for (let i = 0; i < 3; i += 1) {
      session = stepTimeScale(session, -1);
      seen.push(session.timeScale);
    }
    expect(seen).toEqual([1, 8, 16, 16, 8, 1, 1]);
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
