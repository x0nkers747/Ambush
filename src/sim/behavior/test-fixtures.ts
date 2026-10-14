import { NO_FEATURES, rectangle, type EnvironmentFeatures } from '../environment';
import type { Scenario, ScenarioSoldier, ScenarioUnit } from '../scenario';
import { orgUnitId, soldierId } from '../state';
import { createSyntheticTerrain, flatElevation } from '../synthetic-terrain';
import type { FormationNode, FormationSpec } from './types';

// Test content for unit movement (tests only): a 13-Marine squad (squad
// leader and three fire teams of four, ids M01–M13 as the game's roster) and
// a 3-Marine team on 1.2 km × 1.2 km of flat synthetic ground, with a
// hand-made wedge (the doctrinal templates live in #exercise).

export function flatTerrain(features: EnvironmentFeatures = NO_FEATURES) {
  return createSyntheticTerrain(
    { originX: -600, originY: -600, cellSize: 20, columns: 61, rows: 61 },
    flatElevation(10),
    features,
  );
}

/** A 20 m × 20 m building centred at (x, y). */
export function block(id: string, x: number, y: number): EnvironmentFeatures {
  return {
    ...NO_FEATURES,
    buildings: [{ id, footprint: rectangle(x, y, 20, 20), heightMeters: 6 }],
  };
}

const ROLES = ['FTL', 'AR', 'AAR', 'R'] as const;

/** The squad's soldiers and units, standing loosely around (x, y) facing north. */
export function squadScenario(
  options: { x?: number; y?: number; features?: EnvironmentFeatures } = {},
): Scenario {
  const { x = 0, y = 0 } = options;
  const units: ScenarioUnit[] = [
    { id: 'SQD', echelon: 'squad', parentId: null, leaderId: 'M01' },
    { id: 'FT1', echelon: 'fireTeam', parentId: 'SQD', leaderId: 'M02' },
    { id: 'FT2', echelon: 'fireTeam', parentId: 'SQD', leaderId: 'M06' },
    { id: 'FT3', echelon: 'fireTeam', parentId: 'SQD', leaderId: 'M10' },
  ];
  const soldiers: ScenarioSoldier[] = [];
  const at = (i: number) => ({ x: x + ((i * 7) % 5) * 4 - 8, y: y - Math.floor(i / 3) * 4 });
  soldiers.push({
    id: 'M01',
    side: 'BLUEFOR',
    unitId: 'SQD',
    position: at(0),
    azimuthDeg: 0,
    posture: 'standing',
  });
  for (let t = 0; t < 3; t += 1) {
    for (let r = 0; r < 4; r += 1) {
      const i = 1 + t * 4 + r;
      soldiers.push({
        id: `M${String(i + 1).padStart(2, '0')}`,
        side: 'BLUEFOR',
        unitId: `FT${String(t + 1)}`,
        position: at(i),
        azimuthDeg: 0,
        posture: 'standing',
      });
    }
  }
  return {
    id: 'behavior-squad',
    terrain: flatTerrain(options.features),
    movement: { speed: 1.5, maxTurnRate: Math.PI / 2 },
    units,
    soldiers,
  };
}

/** A 3-Marine team (unit `TM`, soldiers T1–T3) standing around (x, y). */
export function teamScenario(options: { x?: number; y?: number } = {}): Scenario {
  const { x = 0, y = 0 } = options;
  return {
    id: 'behavior-team',
    terrain: flatTerrain(),
    movement: { speed: 1.5, maxTurnRate: Math.PI / 2 },
    units: [{ id: 'TM', echelon: 'fireTeam', parentId: null, leaderId: 'T1' }],
    soldiers: ['T1', 'T2', 'T3'].map((id, i) => ({
      id,
      side: 'BLUEFOR' as const,
      unitId: 'TM',
      position: { x: x + i * 3 - 3, y: y - i * 2 },
      azimuthDeg: 0,
      posture: 'standing' as const,
    })),
  };
}

/** A fire-team wedge of interval `d` (rifleman at the point; leader left, AAR right; AR rear). */
function teamWedge(team: number, d: number, back: number, right: number): FormationNode {
  const base = 1 + (team - 1) * 4;
  const offsets: Record<(typeof ROLES)[number], [number, number]> = {
    R: [-d, 0],
    FTL: [0, -0.7 * d],
    AAR: [0, 0.7 * d],
    AR: [0.7 * d, 0],
  };
  return {
    unitId: orgUnitId(`FT${String(team)}`),
    back,
    right,
    slots: ROLES.map((role, r) => ({
      id: `FT${String(team)}.${role}`,
      soldierId: soldierId(`M${String(base + r + 1).padStart(2, '0')}`),
      back: offsets[role][0],
      right: offsets[role][1],
    })),
    children: [],
  };
}

/** The squad wedge: FT1 at the point, the squad leader behind it, FT2 left and FT3 right behind. */
export function squadWedge(d = 10, teamSpacing = 2 * d): FormationSpec {
  return {
    interval: d,
    root: {
      unitId: orgUnitId('SQD'),
      back: 0,
      right: 0,
      slots: [{ id: 'SL', soldierId: soldierId('M01'), back: teamSpacing / 2, right: 0 }],
      children: [
        teamWedge(1, d, 0, 0),
        teamWedge(2, d, teamSpacing, -teamSpacing),
        teamWedge(3, d, teamSpacing, teamSpacing),
      ],
    },
  };
}

/** A 3-Marine wedge: T1 at the point, T2 left and T3 right behind. */
export function teamWedge3(d = 10): FormationSpec {
  return {
    interval: d,
    root: {
      unitId: orgUnitId('TM'),
      back: 0,
      right: 0,
      slots: [
        { id: 'TM.1', soldierId: soldierId('T1'), back: 0, right: 0 },
        { id: 'TM.2', soldierId: soldierId('T2'), back: 0.7 * d, right: -0.7 * d },
        { id: 'TM.3', soldierId: soldierId('T3'), back: 0.7 * d, right: 0.7 * d },
      ],
      children: [],
    },
  };
}
