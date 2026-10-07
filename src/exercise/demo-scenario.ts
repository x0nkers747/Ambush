import { createSyntheticTerrain, type Scenario, type ScenarioSoldier } from '#sim';

// Development content for the interactive vertical slice (Phase 3): a BLUEFOR
// rifle squad and a small OPFOR team on 800 m × 600 m of synthetic terrain.
// Not the doctrinal ambush scenario.

/** Smooth bump of `height` metres centred on (cx, cy) with spread `sigma` metres. */
function bump(x: number, y: number, cx: number, cy: number, height: number, sigma: number): number {
  return height * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * sigma ** 2));
}

/**
 * Ground rising gently to the north, a hill to the north-east, a knoll to the
 * west, a long spur in the south-east, and a meandering north–south draw
 * through the middle.
 */
function demoElevation(x: number, y: number): number {
  const drawCentre = 40 * Math.sin(y / 110);
  const draw = -9 * Math.exp(-((x - drawCentre) ** 2) / (2 * 30 ** 2));
  // A spur running from the south-east toward the centre of the map.
  const along = (x - 220) * 0.94 + (y + 120) * 0.34;
  const across = -(x - 220) * 0.34 + (y + 120) * 0.94;
  const spur = 8 * Math.exp(-(along ** 2) / (2 * 150 ** 2) - across ** 2 / (2 * 30 ** 2));
  return (
    100 + 0.025 * y + bump(x, y, 250, 170, 22, 85) + bump(x, y, -250, -40, 14, 70) + spur + draw
  );
}

const blufor = (id: string, unitId: string, x: number, y: number): ScenarioSoldier => ({
  id,
  side: 'BLUEFOR',
  unitId,
  position: { x, y },
  azimuthDeg: 0,
  posture: 'standing',
});

const opfor = (id: string, x: number, y: number, azimuthDeg: number): ScenarioSoldier => ({
  id,
  side: 'OPFOR',
  unitId: 'EN-TM',
  position: { x, y },
  azimuthDeg,
  posture: 'standing',
});

export const DEMO_SCENARIO: Scenario = {
  id: 'phase3-demo',
  terrain: createSyntheticTerrain(
    { originX: -400, originY: -300, cellSize: 5, columns: 161, rows: 121 },
    demoElevation,
  ),
  movement: { speed: 1.5, maxTurnRate: Math.PI / 2 },
  units: [
    { id: 'SQD', echelon: 'squad', parentId: null, leaderId: 'SL' },
    { id: 'A-TM', echelon: 'fireTeam', parentId: 'SQD', leaderId: 'A-TL' },
    { id: 'B-TM', echelon: 'fireTeam', parentId: 'SQD', leaderId: 'B-TL' },
    { id: 'EN-TM', echelon: 'fireTeam', parentId: null, leaderId: 'EN-1' },
  ],
  soldiers: [
    blufor('SL', 'SQD', -60, -240),
    blufor('A-TL', 'A-TM', -80, -225),
    blufor('A-AR', 'A-TM', -88, -232),
    blufor('A-GR', 'A-TM', -74, -234),
    blufor('A-RFL', 'A-TM', -82, -241),
    blufor('B-TL', 'B-TM', -40, -225),
    blufor('B-AR', 'B-TM', -32, -232),
    blufor('B-GR', 'B-TM', -46, -234),
    blufor('B-RFL', 'B-TM', -38, -241),
    opfor('EN-1', 30, 210, 180),
    opfor('EN-2', 38, 202, 160),
    opfor('EN-3', 22, 202, 200),
  ],
};
