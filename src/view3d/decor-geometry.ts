import { finishMesh, type Draper, type MeshData } from './drape';
import type { PathLine, PathStyle } from './decor-paths';
import { drapeNetwork, type NetworkLine } from './line-network';
import type { WireSegments } from './decor-plan';

// Inferred paths and driveways, and overhead wires, as geometry
// (docs/adr/0036). Paths are draped on the authoritative ground like the
// roads (line-network.ts), just under the lowest road layer, so where a path
// meets a road the road is drawn over its end and the join is clean. Wires
// are thin lines, one draw call for all of them. Pure.

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

/** Height above the ground: under every road layer (the lowest, the verge, is at 0.04 m). */
export const pathOffset = (style: PathStyle) => 0.022 + 0.002 * PATH_STYLES.indexOf(style);

/** The draped paths, one mesh per style (styles with no paths are left out). */
export function pathGeometry(
  paths: readonly PathLine[],
  draper: Draper,
): (readonly [PathStyle, MeshData])[] {
  const lines: NetworkLine<PathStyle>[] = paths.map((p) => ({
    id: p.id,
    style: p.style,
    centerline: p.points,
    halfWidth: p.halfWidth,
  }));
  const built = drapeNetwork(lines, draper, pathOffset);
  return PATH_STYLES.flatMap((style) => {
    const b = built.get(style);
    return b && b.positions.length > 0 ? [[style, finishMesh(b)] as const] : [];
  });
}

/** Wire segments in Three.js axes (x, z, −y), for a line mesh. */
export function wirePositions(wires: WireSegments): Float32Array {
  const out = new Float32Array(wires.length);
  for (let i = 0; i < wires.length; i += 3) {
    out[i] = wires[i] ?? 0;
    out[i + 1] = wires[i + 2] ?? 0;
    out[i + 2] = -(wires[i + 1] ?? 0);
  }
  return out;
}
