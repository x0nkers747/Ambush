import { clipPolygon, type BattlefieldPackage } from '#geo';
import { isSimplePolygon, type TerrainDataset, type Vec2, type VegetationArea } from '#sim';

// Tree cover found in aerial imagery that OpenStreetMap does not map
// (tools/tree-cover/, docs/adr/0049): woods classified from NAIP imagery and
// traced as rings in the battlefield's UTM zone. Added to the opened copy of
// a battlefield's terrain, never to the stored package. Switched off for now:
// no battlefield has a file in `TREE_COVER_FILES`, so nothing is fetched.

/** A tree cover file, as tools/tree-cover/classify.mts writes it. */
export interface TreeCoverData {
  readonly source: string;
  /** The EPSG code of the rings' coordinates (a UTM zone). */
  readonly epsg: number;
  readonly areas: readonly {
    readonly id: string;
    /** Outer ring, easting and northing pairs. */
    readonly ring: readonly (readonly [number, number])[];
    /** Clearings inside it. */
    readonly holes?: readonly (readonly (readonly [number, number])[])[];
  }[];
}

/** Canopy and sight through it of the woods added, metres: a mixed broadleaf wood. */
const CANOPY_M = 15;
const SEE_THROUGH_M = 25;

/** Where each battlefield's tree cover file is served, by battlefield id. Empty: switched off. */
const TREE_COVER_FILES: Readonly<Record<string, string>> = {};

/** Where battlefield `id`'s tree cover file is served, or null when it has none. */
export function treeCoverUrl(id: string): string | null {
  return TREE_COVER_FILES[id] ?? null;
}

/**
 * The woods of `data` on battlefield `pkg`: each ring in the battlefield's
 * frame, clipped to it; clearings kept where a wood lies wholly on the
 * battlefield. None when the file is in another coordinate system.
 */
export function treeCoverAreas(
  data: TreeCoverData,
  pkg: Pick<BattlefieldPackage, 'frame' | 'terrain'>,
): VegetationArea[] {
  if (data.epsg !== pkg.frame.epsg) return [];
  const hf = pkg.terrain.heightfield;
  const bounds = {
    minX: hf.originX,
    minY: hf.originY,
    maxX: hf.originX + (hf.columns - 1) * hf.cellSize,
    maxY: hf.originY + (hf.rows - 1) * hf.cellSize,
  };
  const local = (r: readonly (readonly [number, number])[]): Vec2[] =>
    r.map(([e, n]) => ({ x: e - pkg.frame.falseEasting, y: n - pkg.frame.falseNorthing }));
  const out: VegetationArea[] = [];
  for (const area of data.areas) {
    const ring = local(area.ring);
    const within = ring.every(
      (p) => p.x > bounds.minX && p.x < bounds.maxX && p.y > bounds.minY && p.y < bounds.maxY,
    );
    const holes = within
      ? (area.holes ?? []).map(local).filter((h) => h.length >= 3 && isSimplePolygon(h))
      : [];
    clipPolygon(ring, bounds).forEach((boundary, i) => {
      if (boundary.length < 3 || !isSimplePolygon(boundary)) return;
      out.push({
        id: `${area.id}-${String(i)}`,
        kind: 'woodland',
        boundary,
        ...(holes.length > 0 ? { holes } : {}),
        canopyHeightMeters: CANOPY_M,
        seeThroughMeters: SEE_THROUGH_M,
      });
    });
  }
  return out;
}

/** `terrain` with `areas` added to its vegetation. */
export function withTreeCover(
  terrain: TerrainDataset,
  areas: readonly VegetationArea[],
): TerrainDataset {
  if (areas.length === 0) return terrain;
  return {
    ...terrain,
    features: { ...terrain.features, vegetation: [...terrain.features.vegetation, ...areas] },
  };
}

/** Battlefield `pkg`'s terrain with its tree cover, when a file is served for it; else as it is. */
export async function terrainWithTreeCover(pkg: BattlefieldPackage): Promise<TerrainDataset> {
  const url = treeCoverUrl(pkg.id);
  if (url === null) return pkg.terrain;
  try {
    const response = await fetch(url);
    if (!response.ok) return pkg.terrain;
    return withTreeCover(
      pkg.terrain,
      treeCoverAreas((await response.json()) as TreeCoverData, pkg),
    );
  } catch {
    return pkg.terrain;
  }
}
