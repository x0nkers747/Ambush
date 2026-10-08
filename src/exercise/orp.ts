import { isOnTerrain, pointProblem, type TerrainDataset, type Vec2 } from '#sim';

// The objective rally point (docs/adr/0012): a scenario-defined reference area
// where the trainee's organization starts. A planning reference only: it is not
// an obstacle and the simulation never sees it.

export type OrpShape =
  | { readonly kind: 'circle'; readonly radiusM: number }
  | {
      readonly kind: 'ellipse';
      /** Full length of the major axis, metres. */
      readonly majorAxisM: number;
      /** Full length of the minor axis, metres. */
      readonly minorAxisM: number;
      /** Direction of the major axis, degrees clockwise from grid north. */
      readonly orientationDeg: number;
    };

export interface ObjectiveRallyPoint {
  readonly id: string;
  readonly name: string;
  readonly centre: { readonly east: number; readonly north: number };
  readonly shape: OrpShape;
}

/** Grid spacing of the default starting layout. */
export const ORP_LAYOUT_SPACING_M = 3;
/** Laid-out positions keep at least this far inside the ORP boundary. */
export const ORP_LAYOUT_MARGIN_M = 0.5;
/** Minimum distance between two starting positions. */
export const MIN_START_SPACING_M = 1;

/** Semi-axes (metres) and the unit vector of the first axis, in map (east, north) terms. */
function axes(orp: ObjectiveRallyPoint) {
  if (orp.shape.kind === 'circle') {
    return { a: orp.shape.radiusM, b: orp.shape.radiusM, ux: 0, uy: 1 };
  }
  const theta = (orp.shape.orientationDeg * Math.PI) / 180;
  return {
    a: orp.shape.majorAxisM / 2,
    b: orp.shape.minorAxisM / 2,
    ux: Math.sin(theta),
    uy: Math.cos(theta),
  };
}

/** Whether `point` lies inside the ORP, at least `margin` metres from its boundary (approximately, for ellipses). */
export function orpContains(orp: ObjectiveRallyPoint, point: Vec2, margin = 0): boolean {
  const { a, b, ux, uy } = axes(orp);
  const sa = a - margin;
  const sb = b - margin;
  if (sa <= 0 || sb <= 0) return false;
  const dx = point.x - orp.centre.east;
  const dy = point.y - orp.centre.north;
  // Coordinates along the first axis and the one 90° clockwise from it.
  const u = dx * ux + dy * uy;
  const v = dx * uy - dy * ux;
  return (u / sa) ** 2 + (v / sb) ** 2 <= 1;
}

/** The ORP boundary as a closed polygon of map points (the first point is not repeated). */
export function orpOutline(orp: ObjectiveRallyPoint, segments = 72): Vec2[] {
  const { a, b, ux, uy } = axes(orp);
  return Array.from({ length: segments }, (_, i) => {
    const t = (2 * Math.PI * i) / segments;
    const u = a * Math.cos(t);
    const v = b * Math.sin(t);
    return { x: orp.centre.east + u * ux + v * uy, y: orp.centre.north + u * uy - v * ux };
  });
}

/** Problems with the ORP itself (shape, position on the terrain); empty when valid. */
export function orpProblems(orp: ObjectiveRallyPoint, terrain: TerrainDataset): string[] {
  const problems: string[] = [];
  if (orp.id.trim() === '') problems.push('the ORP has no id');
  if (orp.name.trim() === '') problems.push('the ORP has no name');
  if (!Number.isFinite(orp.centre.east) || !Number.isFinite(orp.centre.north)) {
    return [...problems, 'the ORP centre is not a finite point'];
  }
  const { shape } = orp;
  if (shape.kind === 'circle') {
    if (!(shape.radiusM > 0 && Number.isFinite(shape.radiusM))) {
      problems.push('the ORP radius must be a positive number of metres');
    }
  } else if (
    !(shape.minorAxisM > 0 && shape.majorAxisM >= shape.minorAxisM) ||
    !Number.isFinite(shape.majorAxisM) ||
    !Number.isFinite(shape.orientationDeg)
  ) {
    problems.push('the ORP ellipse needs major ≥ minor > 0 metres and a finite orientation');
  }
  if (problems.length > 0) return problems;
  if (orpOutline(orp).some((p) => !isOnTerrain(terrain, p.x, p.y))) {
    problems.push('the ORP extends off the terrain');
  }
  return problems;
}

/**
 * Every deterministic starting position in the ORP, in layout order: points of
 * a square grid (`spacing` metres, aligned with grid north) round the centre
 * that lie inside the ORP with a margin and where a soldier may stand, nearest
 * the centre first (ties: northernmost, then westernmost). Integer arithmetic
 * orders them, so no platform rounding can change the result.
 */
export function orpLayoutCandidates(
  orp: ObjectiveRallyPoint,
  terrain: TerrainDataset,
  spacing = ORP_LAYOUT_SPACING_M,
): Vec2[] {
  const { a, b } = axes(orp);
  const reach = Math.ceil(Math.max(a, b) / spacing);
  const candidates: { i: number; j: number; point: Vec2 }[] = [];
  for (let j = -reach; j <= reach; j += 1) {
    for (let i = -reach; i <= reach; i += 1) {
      const point = { x: orp.centre.east + i * spacing, y: orp.centre.north + j * spacing };
      if (orpContains(orp, point, ORP_LAYOUT_MARGIN_M) && pointProblem(terrain, point) === null) {
        candidates.push({ i, j, point });
      }
    }
  }
  candidates.sort((p, q) => p.i ** 2 + p.j ** 2 - (q.i ** 2 + q.j ** 2) || q.j - p.j || p.i - q.i);
  return candidates.map((c) => c.point);
}

/**
 * Deterministic starting positions for `count` soldiers: the first `count`
 * layout candidates that keep `MIN_START_SPACING_M` from every point in
 * `occupied` (e.g. soldiers the scenario placed explicitly). Throws when the
 * ORP cannot hold them.
 */
export function layoutOrp(
  orp: ObjectiveRallyPoint,
  terrain: TerrainDataset,
  count: number,
  occupied: readonly Vec2[] = [],
  spacing = ORP_LAYOUT_SPACING_M,
): Vec2[] {
  const free = orpLayoutCandidates(orp, terrain, spacing).filter((p) =>
    occupied.every((q) => Math.hypot(p.x - q.x, p.y - q.y) >= MIN_START_SPACING_M),
  );
  if (free.length < count) {
    throw new Error(
      `ORP "${orp.id}" has room for ${String(free.length)} of ${String(count)} soldiers at ${String(spacing)} m spacing`,
    );
  }
  return free.slice(0, count);
}

/**
 * Problems with soldiers' starting positions in the ORP: outside it, where a
 * soldier cannot stand (in or against a building, off the map), or closer than
 * `MIN_START_SPACING_M` to another. Empty when all are acceptable.
 */
export function orpPlacementProblems(
  orp: ObjectiveRallyPoint,
  terrain: TerrainDataset,
  starts: readonly { readonly id: string; readonly point: Vec2 }[],
): string[] {
  const problems: string[] = [];
  starts.forEach(({ id, point }, k) => {
    if (!orpContains(orp, point))
      problems.push(`soldier "${id}" does not start inside ORP "${orp.id}"`);
    const blocked = pointProblem(terrain, point);
    if (blocked) problems.push(`soldier "${id}" starts where nobody can stand (${blocked.kind})`);
    for (const other of starts.slice(0, k)) {
      if (Math.hypot(point.x - other.point.x, point.y - other.point.y) < MIN_START_SPACING_M) {
        problems.push(
          `soldiers "${other.id}" and "${id}" start less than ${String(MIN_START_SPACING_M)} m apart`,
        );
      }
    }
  });
  return problems;
}
