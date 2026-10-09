import type { Azimuth, SoldierId, Vec2 } from '#sim';
import { rosterMembers, type RosterUnit } from './organization';

// Fire-team formation planning (docs/adr/0022): geometry and membership.
// A formation is a planning convenience. It generates ordinary single
// destinations and facings for the team's Marines (docs/adr/0012), which stay
// the only orders; there is no formation unit in the simulation.

/** The echelon of a template unit that can be selected and placed as a formation. */
export const FIRE_TEAM_ECHELON = 'fireTeam';

/** Default distance between adjacent Marines of a line formation, metres. */
export const DEFAULT_FORMATION_SPACING_M = 10;

/** A fire team of the trainee organization, with its Marines in slot order. */
export interface FireTeam {
  /** The template unit's id (e.g. "FT1"). */
  readonly unitId: string;
  readonly name: string;
  /**
   * Its Marines, in the organization template's slot order (the order of
   * `rosterMembers`): formation slot `i` is held by `memberIds[i]`.
   */
  readonly memberIds: readonly SoldierId[];
}

/**
 * Every fire team of the organization, in template order: each unit of echelon
 * `fireTeam` with the soldiers holding its slots (and those of any units
 * below it). Teams without soldiers are left out. Nobody belongs to a team
 * unless the template puts that soldier's slot in it: the squad leader, whose slot is in
 * the squad, is in none.
 */
export function fireTeamsOf(roster: RosterUnit): FireTeam[] {
  const teams: FireTeam[] = [];
  const visit = (node: RosterUnit) => {
    if (node.unit.echelon === FIRE_TEAM_ECHELON) {
      const memberIds = rosterMembers(node).map((m) => m.soldierId as SoldierId);
      if (memberIds.length > 0)
        teams.push({ unitId: node.unit.id, name: node.unit.name, memberIds });
    }
    node.children.forEach(visit);
  };
  visit(roster);
  return teams;
}

/**
 * Where slot `index` of `count` stands, as an offset in metres along the line
 * to the right of the facing: `(index − (count − 1) / 2) × spacingM`. Slot 0
 * is the leftmost seen from behind the line, looking the way it faces.
 */
export function lineSlotOffset(index: number, count: number, spacingM: number): number {
  return (index - (count - 1) / 2) * spacingM;
}

/**
 * The points of a line formation of `count` Marines centred on `centre`,
 * facing `azimuth` (radians clockwise from grid north, docs/adr/0002): a
 * straight line through the centre, perpendicular to the facing, with
 * `spacingM` between neighbours, slot 0 on the left. In map metres; nothing
 * depends on the view.
 */
export function lineFormationPoints(
  centre: Vec2,
  azimuth: Azimuth,
  count: number,
  spacingM: number = DEFAULT_FORMATION_SPACING_M,
): Vec2[] {
  // Facing (sin θ, cos θ) in (east, north); to its right is (cos θ, −sin θ).
  const rightX = Math.cos(azimuth);
  const rightY = -Math.sin(azimuth);
  return Array.from({ length: count }, (_, i) => {
    const offset = lineSlotOffset(i, count, spacingM);
    return { x: centre.x + offset * rightX, y: centre.y + offset * rightY };
  });
}
