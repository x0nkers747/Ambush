import {
  isOnTerrain,
  isSimplePolygon,
  pointInPolygon,
  polygonArea,
  type DeepReadonly,
  type EngagementAreaId,
  type Soldier,
  type TerrainDataset,
  type Vec2,
} from '#sim';

// The trainee's kill zone (docs/adr/0010): a map polygon that becomes the
// simulation's engagement area when the OPFOR approach starts. Editing
// helpers are pure and refuse edits that would make the polygon invalid.

export interface KillZone {
  readonly id: EngagementAreaId;
  readonly vertices: readonly Vec2[];
}

/** Vertices closer than this are treated as the same point. */
export const MIN_VERTEX_SPACING_M = 1;
/** Smallest kill zone accepted for the approach. */
export const MIN_KILL_ZONE_AREA_M2 = 25;

/** Why an edit was refused; the zone is left unchanged. */
export class KillZoneEditError extends Error {
  override name = 'KillZoneEditError';
}

export function insertVertex(
  zone: KillZone,
  point: Vec2,
  index: number,
  terrain: TerrainDataset,
): KillZone {
  if (!Number.isInteger(index) || index < 0 || index > zone.vertices.length) {
    throw new KillZoneEditError(`vertex index ${String(index)} is out of range`);
  }
  const vertices = [...zone.vertices];
  vertices.splice(index, 0, { x: point.x, y: point.y });
  return checked(zone, vertices, terrain, index);
}

export function moveVertex(
  zone: KillZone,
  index: number,
  point: Vec2,
  terrain: TerrainDataset,
): KillZone {
  if (index < 0 || index >= zone.vertices.length) {
    throw new KillZoneEditError(`no vertex ${String(index)}`);
  }
  const vertices = [...zone.vertices];
  vertices[index] = { x: point.x, y: point.y };
  return checked(zone, vertices, terrain, index);
}

export function deleteVertex(zone: KillZone, index: number): KillZone {
  if (index < 0 || index >= zone.vertices.length) {
    throw new KillZoneEditError(`no vertex ${String(index)}`);
  }
  const vertices = zone.vertices.filter((_, i) => i !== index);
  if (vertices.length >= 3 && !isSimplePolygon(vertices)) {
    throw new KillZoneEditError('deleting this vertex would make the kill zone cross itself');
  }
  return { ...zone, vertices };
}

function checked(
  zone: KillZone,
  vertices: Vec2[],
  terrain: TerrainDataset,
  changed: number,
): KillZone {
  const point = vertices[changed];
  if (!point || !isOnTerrain(terrain, point.x, point.y)) {
    throw new KillZoneEditError('kill zone vertices must be on the map');
  }
  if (
    vertices.some(
      (v, i) => i !== changed && Math.hypot(v.x - point.x, v.y - point.y) < MIN_VERTEX_SPACING_M,
    )
  ) {
    throw new KillZoneEditError('kill zone vertices must be at least 1 m apart');
  }
  if (vertices.length >= 3 && !isSimplePolygon(vertices)) {
    throw new KillZoneEditError('the kill zone cannot cross itself');
  }
  return { ...zone, vertices };
}

/** Why the kill zone cannot be used to start the OPFOR approach; empty when it can. */
export function killZoneProblems(
  zone: KillZone | null,
  opfor: readonly DeepReadonly<Soldier>[],
): string[] {
  if (zone === null) return ['No kill zone: draw one on the map.'];
  if (zone.vertices.length < 3) {
    return [`The kill zone needs at least 3 corners (it has ${String(zone.vertices.length)}).`];
  }
  const problems: string[] = [];
  if (!isSimplePolygon(zone.vertices)) problems.push('The kill zone crosses itself.');
  else if (polygonArea(zone.vertices) < MIN_KILL_ZONE_AREA_M2) {
    problems.push(`The kill zone is smaller than ${String(MIN_KILL_ZONE_AREA_M2)} m².`);
  }
  const inside = opfor.filter((s) => pointInPolygon(s.position, zone.vertices)).map((s) => s.id);
  if (inside.length > 0) {
    problems.push(
      `OPFOR already inside the kill zone: ${inside.join(', ')}. It must be entered, not start inside.`,
    );
  }
  return problems;
}
