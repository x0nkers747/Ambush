import { cleanTerrain, waterLevels, type SourceCorrections, type TerrainDataset } from '#sim';
import { compileField, generateTile, tileHash } from '#sim/terrain-lab';

// Cross-engine repeatability (research §5.2 rule 5): tile hashes for a
// battlefield package, computed in whatever engine runs this, to compare with
// the same list computed in Node and in other browsers.

export interface HashablePackage {
  readonly terrain: TerrainDataset;
  readonly elevation: { readonly cleaning?: SourceCorrections | null };
}

/** The tile hashes of the package at `url` (fetched). */
export async function hashPackage(
  url: string,
  tiles: readonly (readonly [number, number, number])[],
  spacing = 0.5,
): Promise<string[]> {
  return hashPackageData((await (await fetch(url)).json()) as HashablePackage, tiles, spacing);
}

export function hashPackageData(
  pkg: HashablePackage,
  tiles: readonly (readonly [number, number, number])[],
  spacing = 0.5,
): string[] {
  const clean = cleanTerrain(pkg.terrain, pkg.elevation.cleaning ?? null).terrain;
  const field = compileField(
    { heightfield: clean.heightfield, features: clean.features, water: waterLevels(clean) },
    { seed: 1, relief: 1 },
  );
  return tiles.map(([level, tx, ty]) =>
    tileHash(generateTile(field, spacing, field.bounds.minX, field.bounds.minY, level, tx, ty)),
  );
}
