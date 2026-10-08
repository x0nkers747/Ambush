import { describe, expect, it } from 'vitest';
import {
  createSyntheticTerrain,
  flatElevation,
  pointProblem,
  rectangle,
  type TerrainDataset,
  type Vec2,
} from '#sim';
import { placeOrp, scenarioForTerrain, ScenarioPlacementError } from './battlefield-scenario';
import { createExercise } from './exercise';

// The minimal scenario on imported terrain (docs/adr/0014): the squad at an
// ORP on open ground near the centre, never in buildings or water.

const square = (cx: number, cy: number, half: number): Vec2[] => [
  { x: cx - half, y: cy - half },
  { x: cx + half, y: cy - half },
  { x: cx + half, y: cy + half },
  { x: cx - half, y: cy + half },
];

function terrain(over: Partial<TerrainDataset['features']> = {}): TerrainDataset {
  const base = createSyntheticTerrain(
    { originX: -500, originY: -500, cellSize: 10, columns: 101, rows: 101 },
    flatElevation(50),
  );
  return {
    ...base,
    formatVersion: 3,
    features: {
      roads: [],
      buildings: [],
      vegetation: [],
      water: [],
      waterways: [],
      landUse: [],
      ...over,
    },
  };
}

describe('the squad on imported terrain', () => {
  it('assembles at the centre when the ground there is open', () => {
    const scenario = scenarioForTerrain(terrain(), 'battlefield-test');
    expect(scenario.orp.centre).toEqual({ east: 0, north: 0 });
    expect(scenario.soldiers).toHaveLength(13);
    expect(scenario.opforRoutes).toEqual([]);
  });

  it('moves the ORP off a lake and out of a village, deterministically', () => {
    const t = terrain({
      water: [{ id: 'lake', kind: 'water', boundary: square(0, 0, 60) }],
      buildings: Array.from({ length: 9 }, (_, i) => ({
        id: `b${String(i)}`,
        footprint: rectangle(-100 + (i % 3) * 25, 90 + Math.floor(i / 3) * 25, 12, 12, 0),
        heightMeters: 6,
      })),
    });
    const scenario = scenarioForTerrain(t, 'battlefield-test');
    const { east, north } = scenario.orp.centre;
    expect(Math.hypot(east, north)).toBeGreaterThan(60);
    for (const s of scenario.soldiers) expect(pointProblem(t, s.position)).toBeNull();
    expect(scenarioForTerrain(t, 'battlefield-test')).toEqual(scenario);
  });

  it('refuses a battlefield with nowhere to stand', () => {
    const flooded = terrain({ water: [{ id: 'sea', kind: 'water', boundary: square(0, 0, 500) }] });
    expect(() => placeOrp(flooded, 13)).toThrow(ScenarioPlacementError);
  });

  it('runs as an exercise: plan, execute, reach the ready state; OPFOR cannot start', () => {
    const t = terrain({ water: [{ id: 'pond', kind: 'water', boundary: square(150, 0, 30) }] });
    const exercise = createExercise({
      config: { tickRateHz: 30, seed: 0 },
      scenario: scenarioForTerrain(t, 'battlefield-test'),
    });
    const id = exercise.simulation.state.soldiers[0]?.id;
    if (!id) throw new Error('no soldiers');
    expect(() => {
      exercise.setDestination(id, { x: 150, y: 0 });
    }).toThrow(/in water \(pond\)/);
    exercise.setDestination(id, { x: 250, y: 0 });
    expect(exercise.execute().ok).toBe(true);
    for (let i = 0; i < 2000 && exercise.phase === 'bluforOccupation'; i += 1)
      exercise.advance(1, 16);
    expect(exercise.phase).toBe('bluforReady');
    const at = exercise.simulation.state.soldiers.find((s) => s.id === id)?.position;
    expect(at?.x).toBeCloseTo(250, 6);
    expect(exercise.startOpforProblems()).toContain('The scenario defines no OPFOR route.');
  });
});
