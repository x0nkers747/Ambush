import { describe, expect, it } from 'vitest';
import { createExercise, DEMO_SCENARIO } from '#exercise';
import { soldierId } from '#sim';
import { clearSelection, createSession, selectSoldier, setTimeScale } from './session';

const exercise = createExercise({ config: { tickRateHz: 30, seed: 0 }, scenario: DEMO_SCENARIO });

describe('session', () => {
  it('starts with no selection at 1×', () => {
    expect(createSession()).toEqual({ selectedSoldierId: null, timeScale: 1 });
  });

  it('selects BLUEFOR soldiers, one at a time', () => {
    let session = selectSoldier(createSession(), exercise, soldierId('A-TL'));
    expect(session.selectedSoldierId).toBe('A-TL');
    session = selectSoldier(session, exercise, soldierId('B-AR'));
    expect(session.selectedSoldierId).toBe('B-AR');
    expect(clearSelection(session).selectedSoldierId).toBeNull();
  });

  it('ignores OPFOR and unknown soldiers', () => {
    const session = selectSoldier(createSession(), exercise, soldierId('SL'));
    expect(selectSoldier(session, exercise, soldierId('EN-1'))).toBe(session);
    expect(selectSoldier(session, exercise, soldierId('nobody'))).toBe(session);
  });

  it('sets the time scale without touching the simulation', () => {
    const tick = exercise.simulation.tick;
    expect(setTimeScale(createSession(), 4).timeScale).toBe(4);
    expect(exercise.simulation.tick).toBe(tick);
  });
});
