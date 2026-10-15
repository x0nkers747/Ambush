import type { Azimuth, Posture, SoldierId, SoldierStatus, Vec3 } from '#sim';

// A soldier as the 3D view shows it (docs/adr/0029): given to the view by
// its owner (`ViewFigures`), drawn as a character, or a simple marker until
// the character models have loaded.

export interface UnitMarker {
  readonly id: SoldierId;
  readonly affiliation: 'friendly' | 'enemy';
  /** Where the simulation has the soldier: z is the surface stood on (`surfaceHeightAt`: the ground, or a bridge deck). */
  readonly position: Vec3;
  readonly azimuth: Azimuth;
  readonly posture: Posture;
  readonly status: SoldierStatus;
  /** Selected (alone, or with his squad). */
  readonly selected: boolean;
}
