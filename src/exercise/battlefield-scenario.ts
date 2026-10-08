import { isOnTerrain, pointProblem, type TerrainDataset } from '#sim';
import { deployInOrp, type AmbushScenario } from './ambush-scenario';
import { layoutOrp, orpProblems, type ObjectiveRallyPoint } from './orp';
import { DEFAULT_MOVEMENT, squadInstance, USMC_RIFLE_SQUAD_TEMPLATE } from './squad';

// A minimal scenario for imported terrain (docs/adr/0014): the trainee's
// squad at an objective rally point on open ground near the battlefield's
// centre, and no OPFOR. Enough to move, face and check visibility on real
// terrain; a scenario editor (ORP choice, OPFOR routes) comes later.

/** Radius of the automatically placed ORP: room for a 13-Marine squad at 3 m spacing. */
export const AUTO_ORP_RADIUS_M = 14;
/** Spacing of the candidate ORP centres searched outward from the battlefield's centre. */
const SEARCH_STEP_M = 10;

export class ScenarioPlacementError extends Error {
  override name = 'ScenarioPlacementError';
}

/**
 * The ORP nearest the centre of the terrain where the whole squad can stand:
 * candidate centres on a 10 m grid, nearest first (ties: northernmost, then
 * westernmost), each tried with the deterministic ORP layout, so it avoids
 * buildings and water. Throws a `ScenarioPlacementError` when there is none.
 */
export function placeOrp(
  terrain: TerrainDataset,
  soldiers: number,
  radiusM = AUTO_ORP_RADIUS_M,
): ObjectiveRallyPoint {
  const { originX, originY, cellSize, columns, rows } = terrain.heightfield;
  const cx = originX + ((columns - 1) * cellSize) / 2;
  const cy = originY + ((rows - 1) * cellSize) / 2;
  const reach = Math.floor(
    Math.min(((columns - 1) * cellSize) / 2, ((rows - 1) * cellSize) / 2) / SEARCH_STEP_M,
  );
  const candidates: { i: number; j: number }[] = [];
  for (let j = -reach; j <= reach; j += 1)
    for (let i = -reach; i <= reach; i += 1) candidates.push({ i, j });
  candidates.sort(
    (a, b) => a.i * a.i + a.j * a.j - (b.i * b.i + b.j * b.j) || b.j - a.j || a.i - b.i,
  );
  for (const { i, j } of candidates) {
    const centre = { east: cx + i * SEARCH_STEP_M, north: cy + j * SEARCH_STEP_M };
    const orp: ObjectiveRallyPoint = {
      id: 'ORP-1',
      name: 'ORP',
      centre,
      shape: { kind: 'circle', radiusM },
    };
    if (
      !isOnTerrain(terrain, centre.east, centre.north) ||
      pointProblem(terrain, { x: centre.east, y: centre.north })
    )
      continue;
    if (orpProblems(orp, terrain).length > 0) continue;
    try {
      layoutOrp(orp, terrain, soldiers);
      return orp;
    } catch {
      // Not enough room here: try the next candidate.
    }
  }
  throw new ScenarioPlacementError(
    'There is no open ground on this battlefield where the squad can assemble (every candidate ORP is in or against buildings or water).',
  );
}

/** A scenario on imported terrain: the squad at an automatically placed ORP, no OPFOR. */
export function scenarioForTerrain(terrain: TerrainDataset, id: string): AmbushScenario {
  const instance = squadInstance();
  const orp = placeOrp(terrain, instance.members.length);
  const squad = deployInOrp(USMC_RIFLE_SQUAD_TEMPLATE, instance, orp, terrain);
  return {
    id,
    terrain,
    movement: DEFAULT_MOVEMENT,
    units: squad.units,
    soldiers: squad.soldiers,
    opforRoutes: [],
    orp,
    organization: squad.organization,
  };
}
