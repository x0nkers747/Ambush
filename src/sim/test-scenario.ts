import type { Scenario } from './scenario';

/**
 * Minimal test content (not the ambush scenario): a BLUEFOR squad of a squad
 * leader and two two-soldier fire teams, and a two-soldier OPFOR team.
 * Used by tests only.
 */
export const TEST_SCENARIO: Scenario = {
  id: 'test-two-sides',
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
      position: { x: 0, y: 0, z: 0 },
      azimuthDeg: 0,
      posture: 'kneeling',
    },
    {
      id: 'B-A-TL',
      side: 'BLUEFOR',
      unitId: 'B-A',
      position: { x: -10, y: 5, z: 0 },
      azimuthDeg: 315,
      posture: 'prone',
    },
    {
      id: 'B-A-AR',
      side: 'BLUEFOR',
      unitId: 'B-A',
      position: { x: -15, y: 5, z: 0 },
      azimuthDeg: 270,
      posture: 'prone',
    },
    {
      id: 'B-B-TL',
      side: 'BLUEFOR',
      unitId: 'B-B',
      position: { x: 10, y: 5, z: 0 },
      azimuthDeg: 45,
      posture: 'prone',
    },
    {
      id: 'B-B-R',
      side: 'BLUEFOR',
      unitId: 'B-B',
      position: { x: 15, y: 5, z: 0 },
      azimuthDeg: 90,
      posture: 'prone',
    },
    {
      id: 'O-TL',
      side: 'OPFOR',
      unitId: 'O-TM',
      position: { x: 0, y: 200, z: 0 },
      azimuthDeg: 180,
      posture: 'standing',
    },
    {
      id: 'O-R',
      side: 'OPFOR',
      unitId: 'O-TM',
      position: { x: 5, y: 210, z: 0 },
      azimuthDeg: 180,
      posture: 'standing',
    },
  ],
};
