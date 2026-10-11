import { describe, expect, it } from 'vitest';
import { createExercise, DEMO_SCENARIO, TRAINEE_SIDE } from '#exercise';
import { createSession, selectFireTeam, selectSoldier } from '#session';
import { DEFAULT_TICK_RATE_HZ, heightAt, soldierId } from '#sim';
import { destinationMarkers, unitMarkers } from './unit-markers';

// The 3D view's soldiers come straight from the exercise (docs/adr/0029).

const demo = () =>
  createExercise({
    config: { tickRateHz: DEFAULT_TICK_RATE_HZ, seed: 1 },
    scenario: DEMO_SCENARIO,
  });

describe('3D unit markers', () => {
  it('are every soldier, at the simulated position, on the ground, with side and facing', () => {
    const exercise = demo();
    const markers = unitMarkers(exercise, createSession(), false);
    const soldiers = exercise.simulation.state.soldiers;
    expect(markers.map((m) => m.id)).toEqual(soldiers.map((s) => s.id));
    for (const [i, m] of markers.entries()) {
      const s = soldiers[i];
      if (!s) throw new Error('missing soldier');
      expect(m.position).toEqual(s.position);
      expect(m.position.z).toBeCloseTo(
        heightAt(exercise.simulation.world.terrain, s.position.x, s.position.y),
        9,
      );
      expect(m.azimuth).toBe(s.azimuth);
      expect(m.affiliation).toBe(s.side === TRAINEE_SIDE ? 'friendly' : 'enemy');
    }
    expect(markers.some((m) => m.affiliation === 'enemy')).toBe(true);
  });

  it('leave out the trainee squad while it is hidden, as the 2D map does', () => {
    const exercise = demo();
    const markers = unitMarkers(exercise, createSession(), true);
    expect(markers.every((m) => m.affiliation === 'enemy')).toBe(true);
    expect(destinationMarkers(exercise, createSession(), true)).toEqual([]);
  });

  it('follow the selection: one Marine, or a whole fire team', () => {
    const exercise = demo();
    const first = exercise.simulation.state.soldiers.find((s) => s.side === TRAINEE_SIDE);
    if (!first) throw new Error('no Marine');
    const one = selectSoldier(createSession(), exercise, first.id);
    expect(
      unitMarkers(exercise, one, false)
        .filter((m) => m.selected)
        .map((m) => m.id),
    ).toEqual([first.id]);
    const team = exercise.formationGroups[0];
    if (!team) throw new Error('no team');
    const all = selectFireTeam(createSession(), exercise, team.unitId);
    expect(
      unitMarkers(exercise, all, false)
        .filter((m) => m.selected)
        .map((m) => m.id),
    ).toEqual([...team.memberIds]);
  });

  it('move with the simulation, and read replay frames like the 2D map', () => {
    const exercise = demo();
    const id = soldierId('M01');
    exercise.setDestination(id, { x: -60, y: -200 });
    const planned = destinationMarkers(exercise, createSession(), false);
    expect(planned).toHaveLength(1);
    expect(planned[0]?.position.x).toBe(-60);
    expect(planned[0]?.position.y).toBe(-200);
    expect(planned[0]?.position.z).toBeCloseTo(
      heightAt(exercise.simulation.world.terrain, -60, -200),
      9,
    );
    const before = unitMarkers(exercise, createSession(), false).find((m) => m.id === id);
    exercise.execute();
    for (let i = 0; i < 30 * 5; i += 1) exercise.advance(1 / 30);
    const after = unitMarkers(exercise, createSession(), false).find((m) => m.id === id);
    expect(after?.position).not.toEqual(before?.position);
    expect(after?.position).toEqual(
      exercise.simulation.state.soldiers.find((s) => s.id === id)?.position,
    );
  });
});
