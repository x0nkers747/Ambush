import { finishMesh, type Draper, type MeshData } from './drape';
import type { PathLine, PathStyle } from './decor-paths';
import type { Occupancy } from './planar';
import { ROAD_OFFSET_M } from './road-geometry';
import { drapeSurface, type SurfaceLine, type SurfaceOwner } from './road-surface';

// Inferred paths and driveways as geometry (docs/adr/0036). Paths are draped
// on the authoritative ground like the roads, and cut by them (docs/adr/0044):
// given the roads' occupancy, a driveway stops at the road's verge, so the
// join is clean and no surface lies on another. Pure.

export const PATH_STYLES: readonly PathStyle[] = [
  'trackDirt',
  'driveGravel',
  'drivePaving',
  'driveConcrete',
  'driveAsphalt',
  'walkPaving',
  'walkConcrete',
];

/** sRGB colours: concrete, pavers, asphalt, gravel and earth. */
export const PATH_COLOR: Readonly<Record<PathStyle, number>> = {
  trackDirt: 0x8f7c5c,
  driveGravel: 0xa69c88,
  drivePaving: 0xa89482,
  driveConcrete: 0xb9b5ab,
  driveAsphalt: 0x6c6b67,
  walkPaving: 0xb7a08c,
  walkConcrete: 0xc4c0b6,
};

/** Height above the ground: the roads' (paths are cut by the roads, so they do not overlap). */
export const pathOffset = (): number => ROAD_OFFSET_M;

/**
 * The draped paths, one mesh per style (styles with no paths are left out),
 * cut by whatever `occupancy` already holds (the roads).
 */
export function pathGeometry(
  paths: readonly PathLine[],
  draper: Draper,
  occupancy?: Occupancy<SurfaceOwner>,
): (readonly [PathStyle, MeshData])[] {
  const lines: SurfaceLine<PathStyle>[] = paths.map((p) => ({
    id: p.id,
    style: p.style,
    rank: 100 + PATH_STYLES.indexOf(p.style),
    centerline: p.points,
    halfWidth: p.halfWidth,
    // On the ground, as the roads not on bridges or in tunnels.
    level: ':0',
    fillets: false,
    yields: true,
  }));
  const built = drapeSurface(lines, draper, pathOffset, occupancy).meshes;
  return PATH_STYLES.flatMap((style) => {
    const b = built.get(style);
    return b && b.positions.length > 0 ? [[style, finishMesh(b)] as const] : [];
  });
}
