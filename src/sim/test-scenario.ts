import type { Scenario } from './scenario';
import { createSyntheticTerrain, flatElevation, ridgeElevation } from './synthetic-terrain';

/**
 * Minimal test content (not the ambush scenario): a BLUEFOR squad of a squad
 * leader and two two-soldier fire teams, and a two-soldier OPFOR team, on
 * 200 m × 400 m of synthetic terrain with an east–west ridge (10 m high) between
 * them. Used by tests only.
 */
export const TEST_SCENARIO: Scenario = {
  id: 'test-two-sides',
  terrain: createSyntheticTerrain(
    { originX: -100, originY: -100, cellSize: 10, columns: 21, rows: 41 },
    ridgeElevation({ base: 50, height: 10, crestY: 100, halfWidth: 50 }),
  ),
  movement: { speed: 1.5, maxTurnRate: Math.PI / 2 },
  units: [
    { id: 'B-SQD', echelon: 'squad', parentId: null, leaderId: 'B-SL' },
    { id: 'B-A', echelon: 'fireTeam', parentId: 'B-SQD', leaderId: 'B-A-TL' },
    { id: 'B-B', echelon: 'fireTeam', parentId: 'B-SQD', leaderId: 'B-B-TL' },
    { id: 'O-TM', echelon: 'fireTeam', parentId: null, leaderId: 'O-TL' },
  ],
  soldiers: [
    {
      id: 'B-SL',
      side: 'BLUEFOR',
      unitId: 'B-SQD',
      position: { x: 0, y: 0 },
      azimuthDeg: 0,
      posture: 'kneeling',
    },
    {
      id: 'B-A-TL',
      side: 'BLUEFOR',
      unitId: 'B-A',
      position: { x: -10, y: 5 },
      azimuthDeg: 315,
      posture: 'prone',
    },
    {
      id: 'B-A-AR',
      side: 'BLUEFOR',
      unitId: 'B-A',
      position: { x: -15, y: 5 },
      azimuthDeg: 270,
      posture: 'prone',
    },
    {
      id: 'B-B-TL',
      side: 'BLUEFOR',
      unitId: 'B-B',
      position: { x: 10, y: 5 },
      azimuthDeg: 45,
      posture: 'prone',
    },
    {
      id: 'B-B-R',
      side: 'BLUEFOR',
      unitId: 'B-B',
      position: { x: 15, y: 5 },
      azimuthDeg: 90,
      posture: 'prone',
    },
    {
      id: 'O-TL',
      side: 'OPFOR',
      unitId: 'O-TM',
      position: { x: 0, y: 200 },
      azimuthDeg: 180,
      posture: 'standing',
    },
    {
      id: 'O-R',
      side: 'OPFOR',
      unitId: 'O-TM',
      position: { x: 5, y: 210 },
      azimuthDeg: 180,
      posture: 'standing',
    },
  ],
};

/** No soldiers, on a flat 100 m square. */
export const EMPTY_TEST_SCENARIO: Scenario = {
  id: 'empty',
  terrain: createSyntheticTerrain(
    { originX: 0, originY: 0, cellSize: 100, columns: 2, rows: 2 },
    flatElevation(0),
  ),
  movement: { speed: 1.5, maxTurnRate: Math.PI / 2 },
  units: [],
  soldiers: [],
};
