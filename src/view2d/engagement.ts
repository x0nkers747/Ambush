import { primaryWeapon, TRAINEE_SIDE, type Exercise } from '#exercise';
import type { Azimuth, DeepReadonly, Soldier, SoldierId, Vec2 } from '#sim';
import { worldToScreen, type Camera, type Viewport } from './camera';

// The selected Marine's weapon engagement wedge: a sector centred on where he
// faces, out to his primary weapon's nominal effective range (`primaryWeapon`).
// A planning aid drawn over the map, not a combat calculation: it ignores the
// terrain and line of sight (the visibility overlay shows those).

/** Total angular width of the wedge, in degrees: half on each side of the facing. */
export const ENGAGEMENT_WEDGE_WIDTH_DEG = 35;

export interface EngagementWedge {
  readonly soldierId: SoldierId;
  /** The soldier's current position (map metres). */
  readonly origin: Vec2;
  /** The soldier's current facing: radians clockwise from grid north (docs/adr/0002). */
  readonly azimuth: Azimuth;
  /** Half the angular width, in radians. */
  readonly halfWidth: number;
  /** The weapon's nominal effective range, in metres. */
  readonly rangeM: number;
  /** The weapon shown: its profile reference and name. */
  readonly weaponRef: string;
  readonly weaponName: string;
}

/**
 * The wedge of a selected trainee soldier, from where he stands and the way he
 * faces now, or `null` when nothing is selected, the soldier is not the
 * trainee's or not active, or his loadout has no known primary firearm.
 */
export function engagementWedge(
  exercise: Exercise,
  soldiers: readonly DeepReadonly<Soldier>[],
  selectedId: SoldierId | null,
): EngagementWedge | null {
  if (selectedId === null) return null;
  const soldier = soldiers.find((s) => s.id === selectedId);
  if (soldier?.side !== TRAINEE_SIDE || soldier.status !== 'active') return null;
  // The slot's resolved loadout: its own when it overrides the role's default.
  const member = exercise.rosterMember(selectedId);
  const weapon = member ? primaryWeapon(member.loadout) : null;
  if (weapon?.kind !== 'weapon') return null;
  return {
    soldierId: soldier.id,
    origin: { x: soldier.position.x, y: soldier.position.y },
    azimuth: soldier.azimuth,
    halfWidth: ((ENGAGEMENT_WEDGE_WIDTH_DEG / 2) * Math.PI) / 180,
    rangeM: weapon.effectiveRangeM,
    weaponRef: weapon.ref,
    weaponName: weapon.name,
  };
}

/** The map point at `distance` metres from the origin along azimuth `azimuth` (clockwise from north). */
export function pointAlong(origin: Vec2, azimuth: number, distance: number): Vec2 {
  return {
    x: origin.x + distance * Math.sin(azimuth),
    y: origin.y + distance * Math.cos(azimuth),
  };
}

/** The wedge's two edges as azimuths: anticlockwise, then clockwise of the facing. */
export function wedgeEdges(wedge: EngagementWedge): [number, number] {
  return [wedge.azimuth - wedge.halfWidth, wedge.azimuth + wedge.halfWidth];
}

/**
 * The wedge on screen: its apex and radius in CSS pixels, and its edges as
 * canvas arc angles (from +x towards +y, i.e. clockwise on screen). North is
 * up on the map, so an azimuth θ points along (sin θ, −cos θ) on screen, the
 * canvas angle θ − π/2. The angles need no wrapping at 0°/360°.
 */
export function wedgeOnScreen(
  wedge: EngagementWedge,
  camera: Camera,
  viewport: Viewport,
): { apex: Vec2; radius: number; start: number; end: number } {
  const [left, right] = wedgeEdges(wedge);
  return {
    apex: worldToScreen(camera, viewport, wedge.origin),
    radius: wedge.rangeM / camera.metersPerPixel,
    start: left - Math.PI / 2,
    end: right - Math.PI / 2,
  };
}
