import {
  boundsOf,
  pointInPolygon,
  type Building,
  type LandUseArea,
  type TerrainDataset,
  type Vec2,
} from '#sim';
import { hashString, unit } from './hash';

// Architectural styles for the 3D view's buildings (docs/adr/0035). A
// building's look is decided from what its source says (its appearance tags),
// what it is used for (its kind, or the land use round it), the battlefield's
// region, and a hash of its id for variation. These are plausible visual
// defaults, not claims about the real building. The simulation never sees
// any of it.

/** Regional families of buildings. */
export type Region = 'north-american' | 'central-european' | 'generic';

/** What a building is for, as far as its look goes. */
export type BuildingCategory =
  | 'residential'
  | 'outbuilding'
  | 'commercial'
  | 'industrial'
  | 'institutional'
  | 'agricultural'
  | 'military';

/** Wall texture layers, in the order of the wall texture array. */
export const WALL_LAYERS = ['plaster', 'brick', 'siding', 'concrete', 'block', 'metal'] as const;
export type WallLayer = (typeof WALL_LAYERS)[number];
/** Roof texture layers, in the order of the roof texture array. */
export const ROOF_LAYERS = ['clay', 'tiles', 'slate', 'shingles', 'metal', 'gravel'] as const;
export type RoofLayer = (typeof ROOF_LAYERS)[number];

/** Real-world size of one texture tile, metres: the textures keep their real scale on any wall or roof. */
export const WALL_TILE_M: Readonly<Record<WallLayer, number>> = {
  plaster: 2,
  brick: 1.2,
  siding: 1.6,
  concrete: 2.5,
  block: 1.6,
  metal: 2,
};
export const ROOF_TILE_M: Readonly<Record<RoofLayer, number>> = {
  clay: 2,
  tiles: 2,
  slate: 1.8,
  shingles: 4,
  metal: 2,
  gravel: 1.5,
};

export type RoofKind = 'flat' | 'gabled' | 'hipped' | 'skillion';

/** Cells of the openings atlas (`textures/openings.png`, 4 × 4). */
export const OPENING_CELLS = {
  casement: 0,
  casementShuttersGreen: 1,
  casementShuttersBrown: 2,
  doubleHung: 3,
  doubleHungShutters: 4,
  modern: 5,
  strip: 6,
  attic: 7,
  doorWood: 8,
  doorPainted: 9,
  doorGlass: 10,
  shopfront: 11,
  garage: 12,
  roller: 13,
  barn: 14,
  plain: 15,
} as const;

export type DoorKind = 'wood' | 'painted' | 'glass' | 'shop' | 'roller' | 'barn';

export interface WindowStyle {
  /** Atlas cell. */
  readonly cell: number;
  readonly widthM: number;
  readonly heightM: number;
  /** Sill above the storey's floor. */
  readonly sillM: number;
  /** Distance between window centres along a wall, at least. */
  readonly moduleM: number;
  /** One long strip per storey instead of windows (industrial). */
  readonly strip: boolean;
}

export interface BuildingStyle {
  readonly region: Region;
  readonly category: BuildingCategory;
  readonly roof: RoofKind;
  readonly pitchDegrees: number;
  readonly overhangM: number;
  readonly parapet: boolean;
  readonly roofLayer: RoofLayer;
  /** sRGB tints multiplied into the textures. */
  readonly roofTint: number;
  readonly wallLayer: WallLayer;
  readonly wallTint: number;
  readonly trimTint: number;
  readonly storeyM: number;
  readonly window: WindowStyle | null;
  readonly door: DoorKind;
  readonly doorTint: number;
  /** A garage door beside the entrance (houses). */
  readonly garage: boolean;
}

// --- Region ---------------------------------------------------------------------------

const NORTH_AMERICA = new Set(['US', 'CA']);
const CENTRAL_EUROPE = new Set([
  'DE',
  'AT',
  'CH',
  'CZ',
  'PL',
  'SK',
  'SI',
  'HU',
  'LI',
  'LU',
  'BE',
  'NL',
  'DK',
]);

/**
 * The region a battlefield's buildings are drawn in: the terrain's own
 * `metadata.architecture` when set; else the country most of its buildings'
 * addresses give; else the continent its georeference lies in (UTM zone and
 * northing, at continental resolution only); else generic.
 */
export function regionOf(terrain: TerrainDataset): Region {
  const set = terrain.metadata?.architecture;
  if (set) return set;
  const counts = new Map<string, number>();
  for (const b of terrain.features.buildings) {
    const c = b.appearance?.country;
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const [top] = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  if (top && top[1] >= 3) {
    if (NORTH_AMERICA.has(top[0])) return 'north-american';
    if (CENTRAL_EUROPE.has(top[0])) return 'central-european';
    return 'generic';
  }
  const where = approximateLocation(terrain);
  if (!where) return 'generic';
  const { lat, lon } = where;
  if (lat > 24 && lat < 72 && lon > -170 && lon < -50) return 'north-american';
  if (lat > 43 && lat < 56 && lon > -2 && lon < 25) return 'central-european';
  return 'generic';
}

/** Latitude and longitude of the battlefield's origin from a UTM georeference (to about 0.1°). */
export function approximateLocation(terrain: TerrainDataset): { lat: number; lon: number } | null {
  const g = terrain.georef;
  const m = g ? /^EPSG:32([67])(\d\d)$/.exec(g.crs) : null;
  if (!g || !m) return null;
  const zone = Number(m[2]);
  const north = m[1] === '6';
  const lat = (north ? g.falseNorthing : g.falseNorthing - 10_000_000) / 110_950;
  const lon =
    zone * 6 - 183 + (g.falseEasting - 500_000) / (111_320 * Math.cos((lat * Math.PI) / 180));
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

// --- Category -------------------------------------------------------------------------

const KIND_CATEGORY: Readonly<Record<string, BuildingCategory>> = {
  house: 'residential',
  detached: 'residential',
  semidetached_house: 'residential',
  terrace: 'residential',
  bungalow: 'residential',
  apartments: 'residential',
  residential: 'residential',
  dormitory: 'residential',
  farm: 'residential',
  cabin: 'residential',
  garage: 'outbuilding',
  garages: 'outbuilding',
  carport: 'outbuilding',
  shed: 'outbuilding',
  hut: 'outbuilding',
  roof: 'outbuilding',
  commercial: 'commercial',
  retail: 'commercial',
  supermarket: 'commercial',
  office: 'commercial',
  kiosk: 'commercial',
  hotel: 'commercial',
  industrial: 'industrial',
  warehouse: 'industrial',
  factory: 'industrial',
  manufacture: 'industrial',
  hangar: 'industrial',
  storage_tank: 'industrial',
  service: 'industrial',
  school: 'institutional',
  university: 'institutional',
  college: 'institutional',
  kindergarten: 'institutional',
  hospital: 'institutional',
  civic: 'institutional',
  public: 'institutional',
  government: 'institutional',
  church: 'institutional',
  chapel: 'institutional',
  fire_station: 'institutional',
  train_station: 'institutional',
  barn: 'agricultural',
  farm_auxiliary: 'agricultural',
  cowshed: 'agricultural',
  stable: 'agricultural',
  sty: 'agricultural',
  greenhouse: 'agricultural',
  silo: 'agricultural',
  military: 'military',
  barracks: 'military',
  bunker: 'military',
};

const LAND_USE_CATEGORY: Partial<Record<string, BuildingCategory>> = {
  residential: 'residential',
  commercial: 'commercial',
  industrial: 'industrial',
  military: 'military',
  farmland: 'agricultural',
};

/** Finds the land use at a point (the smallest area containing it). */
export function landUseLookup(areas: readonly LandUseArea[]): (p: Vec2) => LandUseArea | null {
  const boxed = areas.map((a) => ({ a, box: boundsOf(a.boundary), size: 0 }));
  for (const b of boxed) b.size = (b.box.maxX - b.box.minX) * (b.box.maxY - b.box.minY);
  boxed.sort((x, y) => x.size - y.size || (x.a.id < y.a.id ? -1 : 1));
  return (p) => {
    for (const { a, box } of boxed) {
      if (p.x < box.minX || p.x > box.maxX || p.y < box.minY || p.y > box.maxY) continue;
      if (pointInPolygon(p, a.boundary) && !(a.holes ?? []).some((h) => pointInPolygon(p, h))) {
        return a;
      }
    }
    return null;
  };
}

/** What a building is for: its kind or use when tagged, else the land use round it, else its size. */
export function categoryOf(
  building: Building,
  landUse: LandUseArea | null,
  area: number,
): BuildingCategory {
  const look = building.appearance;
  const kind = look?.kind ? KIND_CATEGORY[look.kind] : undefined;
  if (kind) return kind;
  const use = look?.use ?? '';
  if (use.startsWith('shop=')) return 'commercial';
  if (use.startsWith('military=')) return 'military';
  if (
    /^amenity=(school|college|university|kindergarten|hospital|place_of_worship|townhall|police|fire_station|library)$/.test(
      use,
    )
  ) {
    return 'institutional';
  }
  if (area < 30) return 'outbuilding';
  const fromLand = landUse ? LAND_USE_CATEGORY[landUse.kind] : undefined;
  if (fromLand) return area > 2500 && fromLand === 'residential' ? 'commercial' : fromLand;
  if (area > 1500) return 'industrial';
  return 'residential';
}

// --- Style ----------------------------------------------------------------------------

/** Deterministic choices from a building's hash. */
export function picker(id: string) {
  let h = hashString(id);
  const next = () => {
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
    h = (h ^ (h >>> 15)) >>> 0;
    return unit(h);
  };
  return {
    next,
    pick<T>(items: readonly (readonly [T, number])[]): T {
      const total = items.reduce((s, [, w]) => s + w, 0);
      let r = next() * total;
      for (const [item, w] of items) {
        r -= w;
        if (r < 0) return item;
      }
      const last = items[items.length - 1];
      if (!last) throw new RangeError('nothing to pick from');
      return last[0];
    },
    range: (a: number, b: number) => a + (b - a) * next(),
  };
}

const ROOF_SHAPE_KIND: Readonly<Record<string, RoofKind>> = {
  flat: 'flat',
  gabled: 'gabled',
  hipped: 'hipped',
  'half-hipped': 'hipped',
  pyramidal: 'hipped',
  skillion: 'skillion',
  gambrel: 'gabled',
  mansard: 'hipped',
  saltbox: 'gabled',
  dome: 'flat',
  onion: 'flat',
  round: 'flat',
  sawtooth: 'flat',
};
const ROOF_MATERIAL_LAYER: Readonly<Record<string, RoofLayer>> = {
  roof_tiles: 'clay',
  concrete_tiles: 'tiles',
  slate: 'slate',
  metal: 'metal',
  shingles: 'shingles',
  membrane: 'gravel',
  glass: 'gravel',
  grass: 'gravel',
  thatch: 'shingles',
  wood: 'shingles',
};
const WALL_MATERIAL_LAYER: Readonly<Record<string, WallLayer>> = {
  brick: 'brick',
  plaster: 'plaster',
  block: 'block',
  concrete: 'concrete',
  stone: 'block',
  wood: 'siding',
  metal: 'metal',
  glass: 'concrete',
};

/** "#rrggbb" to a number. */
const hex = (c: string) => Number.parseInt(c.slice(1), 16);

/**
 * A colour as a tint, brightened if needed so textured surfaces never go
 * near-black (sRGB luma at least `floor`).
 */
export function tintOf(colour: number, floor = 0.45): number {
  const r = (colour >> 16) & 255;
  const g = (colour >> 8) & 255;
  const b = colour & 255;
  const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (luma >= floor) return colour;
  const k = luma > 0 ? floor / luma : 0;
  const lift = (v: number) => Math.min(255, Math.round(luma > 0 ? v * k : floor * 255));
  return (lift(r) << 16) | (lift(g) << 8) | lift(b);
}

/** Footprint facts the style depends on. */
export interface FootprintFacts {
  readonly area: number;
  /** `rectangle`: one roof plane set; `rectilinear`: a few rectangles; `irregular`: neither. */
  readonly shape: 'rectangle' | 'rectilinear' | 'irregular';
  /** Width (short side) of the main rectangle, metres. */
  readonly width: number;
}

/** A building's style. Deterministic in its id, appearance, category, region and footprint. */
export function buildingStyle(
  building: Building,
  category: BuildingCategory,
  region: Region,
  footprint: FootprintFacts,
): BuildingStyle {
  const r = picker(building.id);
  const look = building.appearance;
  const eu = region === 'central-european';
  const na = region === 'north-american';

  // Defaults by region and category.
  let wallLayer: WallLayer;
  let wallTint: number;
  let roofLayer: RoofLayer;
  let roofTint: number;
  let roof: RoofKind;
  let pitch: number;
  let window: WindowStyle | null;
  let door: DoorKind;
  let doorTint = 0xffffff;
  let garage = false;
  let storeyM = 3;
  let overhangM = 0.4;

  const residentialWindow = (): WindowStyle =>
    na
      ? {
          cell: r.next() < 0.35 ? OPENING_CELLS.doubleHungShutters : OPENING_CELLS.doubleHung,
          widthM: r.range(0.85, 1.0),
          heightM: r.range(1.3, 1.5),
          sillM: 0.85,
          moduleM: r.range(3.0, 3.8),
          strip: false,
        }
      : eu
        ? {
            cell: r.pick([
              [OPENING_CELLS.casement, 6],
              [OPENING_CELLS.casementShuttersGreen, 2],
              [OPENING_CELLS.casementShuttersBrown, 2],
            ]),
            widthM: r.range(1.0, 1.25),
            heightM: r.range(1.25, 1.45),
            sillM: 0.9,
            moduleM: r.range(2.6, 3.1),
            strip: false,
          }
        : {
            cell: OPENING_CELLS.casement,
            widthM: 1.1,
            heightM: 1.35,
            sillM: 0.9,
            moduleM: r.range(2.8, 3.4),
            strip: false,
          };

  switch (category) {
    case 'residential':
    case 'military': {
      const military = category === 'military';
      if (na && !military) {
        wallLayer = r.pick([
          ['siding', 6],
          ['brick', 3],
          ['plaster', 1],
        ] as const);
        wallTint =
          wallLayer === 'siding'
            ? r.pick([
                [0xf4f2ec, 3],
                [0xdadcda, 2],
                [0xe8dec8, 2],
                [0xcdd8e0, 1],
                [0xcfd4be, 1],
                [0xeee2b6, 1],
              ])
            : wallLayer === 'brick'
              ? r.pick([
                  [0xffffff, 2],
                  [0xf2e2da, 1],
                  [0xe4d4cc, 1],
                ])
              : 0xefe6d6;
        roofLayer = r.next() < 0.88 ? 'shingles' : 'metal';
        roofTint =
          roofLayer === 'shingles'
            ? r.pick([
                [0xb8b8b8, 3],
                [0xb0a090, 2],
                [0xc4bcb0, 1],
                [0x9ea2a8, 2],
              ])
            : r.pick([
                [0xc0ccd2, 2],
                [0x8ea08e, 1],
                [0xa0645a, 1],
              ]);
        roof = r.next() < 0.7 ? 'gabled' : 'hipped';
        pitch = r.range(22, 32);
        door = r.next() < 0.75 ? 'painted' : 'wood';
        doorTint = r.pick([
          [0xa8403a, 2],
          [0x3c4e6a, 2],
          [0x46624e, 1],
          [0x343436, 1],
          [0xf0f0f0, 2],
        ]);
        garage = footprint.area > 110 && r.next() < 0.5;
        storeyM = 3;
      } else if (eu || military) {
        wallLayer = military
          ? r.pick([
              ['plaster', 3],
              ['concrete', 1],
            ] as const)
          : r.pick([
              ['plaster', 17],
              ['brick', 2],
              ['block', 1],
            ] as const);
        wallTint = military
          ? r.pick([
              [0xe2dcc6, 3],
              [0xd4d0bc, 2],
              [0xc8ccb4, 1],
            ])
          : wallLayer === 'plaster'
            ? r.pick([
                [0xf6f0e4, 4],
                [0xf0e4c8, 2],
                [0xeadac0, 2],
                [0xe2e6de, 1],
                [0xf2dfcc, 1],
                [0xe6e6e2, 2],
              ])
            : 0xffffff;
        roofLayer = r.pick([
          ['clay', 6],
          ['tiles', 4],
          ['slate', 1],
        ] as const);
        roofTint =
          roofLayer === 'tiles'
            ? r.pick([
                [0x9a9a9e, 3],
                [0xb09a8a, 1],
                [0xa8786a, 1],
              ])
            : roofLayer === 'clay'
              ? r.pick([
                  [0xffffff, 3],
                  [0xf0dcd0, 1],
                ])
              : 0xffffff;
        roof = military
          ? 'gabled'
          : r.pick([
              ['gabled', 6],
              ['hipped', 4],
            ] as const);
        pitch = military ? r.range(28, 34) : r.range(34, 46);
        overhangM = 0.5;
        door = military ? 'painted' : r.next() < 0.6 ? 'wood' : 'painted';
        doorTint = military
          ? 0x6a705a
          : r.pick([
              [0xf2f0ea, 2],
              [0x6a4a34, 1],
              [0x4c5c4a, 1],
              [0x8a3a32, 1],
            ]);
        storeyM = 2.9;
      } else {
        wallLayer = r.pick([
          ['plaster', 3],
          ['brick', 2],
          ['concrete', 1],
        ] as const);
        wallTint =
          wallLayer === 'brick'
            ? 0xffffff
            : r.pick([
                [0xf0ebe0, 2],
                [0xe2ddd2, 1],
                [0xe8dcc6, 1],
              ]);
        roofLayer = r.pick([
          ['tiles', 2],
          ['clay', 1],
          ['shingles', 1],
        ] as const);
        roofTint =
          roofLayer === 'tiles' ? 0xa4a4a8 : roofLayer === 'shingles' ? 0xb4b0aa : 0xffffff;
        roof = r.next() < 0.6 ? 'gabled' : 'hipped';
        pitch = r.range(26, 38);
        door = 'painted';
        doorTint = 0xe8e8e6;
      }
      window = military
        ? {
            cell: OPENING_CELLS.plain,
            widthM: 1.2,
            heightM: 1.3,
            sillM: 0.9,
            moduleM: 3.2,
            strip: false,
          }
        : residentialWindow();
      if (military && na) {
        roofLayer = r.next() < 0.5 ? 'metal' : 'gravel';
        roofTint = roofLayer === 'metal' ? 0xa8b4a4 : 0xc8c6c0;
        roof = roofLayer === 'gravel' ? 'flat' : 'gabled';
        pitch = r.range(10, 18);
      }
      break;
    }
    case 'outbuilding': {
      wallLayer = na
        ? r.pick([
            ['siding', 2],
            ['metal', 1],
          ] as const)
        : r.pick([
            ['plaster', 2],
            ['siding', 1],
          ] as const);
      wallTint =
        wallLayer === 'siding'
          ? na
            ? 0xe8e6e0
            : 0x9c7c5c
          : wallLayer === 'metal'
            ? 0xc8ccc8
            : 0xece4d4;
      roofLayer = na
        ? r.next() < 0.6
          ? 'shingles'
          : 'metal'
        : r.pick([
            ['tiles', 2],
            ['clay', 1],
            ['metal', 1],
          ] as const);
      roofTint = roofLayer === 'shingles' ? 0xb4b4b4 : roofLayer === 'metal' ? 0xb8c0c4 : 0xa4a4a8;
      roof =
        footprint.area < 25 && r.next() < 0.6 ? 'skillion' : r.next() < 0.3 ? 'flat' : 'gabled';
      pitch = roof === 'skillion' ? r.range(8, 14) : r.range(18, 30);
      window = null;
      door = 'painted';
      doorTint = 0xe6e6e4;
      garage =
        building.appearance?.kind === 'garage' ||
        building.appearance?.kind === 'garages' ||
        r.next() < 0.5;
      storeyM = 2.6;
      overhangM = 0.25;
      break;
    }
    case 'commercial':
    case 'institutional': {
      const inst = category === 'institutional';
      wallLayer = na
        ? r.pick([
            ['brick', 3],
            ['concrete', 2],
            ['block', 1],
          ] as const)
        : r.pick([
            ['plaster', 3],
            ['concrete', 1],
          ] as const);
      wallTint =
        wallLayer === 'plaster'
          ? r.pick([
              [0xf2ece0, 2],
              [0xe4e0d8, 1],
              [0xeedcc0, 1],
            ])
          : 0xffffff;
      const pitched = eu && footprint.area < 900 && r.next() < (inst ? 0.6 : 0.5);
      roof = pitched ? 'hipped' : 'flat';
      roofLayer = pitched ? (r.next() < 0.6 ? 'tiles' : 'clay') : 'gravel';
      roofTint = roofLayer === 'tiles' ? 0x9c9ca0 : roofLayer === 'gravel' ? 0xd0cec8 : 0xffffff;
      pitch = r.range(28, 38);
      window = {
        cell: inst ? OPENING_CELLS.plain : OPENING_CELLS.modern,
        widthM: inst ? 1.6 : 1.4,
        heightM: inst ? 1.7 : 1.6,
        sillM: 0.9,
        moduleM: inst ? 3.0 : 3.4,
        strip: false,
      };
      door = inst ? 'glass' : 'shop';
      storeyM = inst ? 3.6 : 3.4;
      overhangM = 0.3;
      break;
    }
    case 'industrial': {
      wallLayer = r.pick([
        ['metal', 3],
        ['block', 1],
        ['concrete', 1],
      ] as const);
      wallTint =
        wallLayer === 'metal'
          ? r.pick([
              [0xd2d6d6, 3],
              [0xb4c0c8, 1],
              [0xc0c8b4, 1],
              [0xd8d0c0, 1],
            ])
          : 0xf0ece4;
      const low = r.next() < 0.45;
      roof = low ? 'gabled' : 'flat';
      roofLayer = low ? 'metal' : 'gravel';
      roofTint = low ? 0xc0c6c8 : 0xd0cec8;
      pitch = r.range(6, 12);
      window = {
        cell: OPENING_CELLS.strip,
        widthM: 0,
        heightM: 1.0,
        sillM: 2.6,
        moduleM: 6,
        strip: true,
      };
      door = 'roller';
      storeyM = 6;
      overhangM = 0.3;
      break;
    }
    case 'agricultural': {
      wallLayer = na
        ? r.next() < 0.6
          ? 'siding'
          : 'metal'
        : r.pick([
            ['siding', 2],
            ['plaster', 1],
          ] as const);
      wallTint =
        wallLayer === 'siding'
          ? na
            ? r.pick([
                [0xa4463a, 2],
                [0xd8d4cc, 1],
              ])
            : 0x9c7c5c
          : wallLayer === 'metal'
            ? 0xc4c8c4
            : 0xe8e0d0;
      roofLayer = na
        ? 'metal'
        : r.pick([
            ['tiles', 2],
            ['metal', 1],
            ['clay', 1],
          ] as const);
      roofTint =
        roofLayer === 'metal'
          ? r.pick([
              [0xb8c0c4, 2],
              [0xa0645a, 1],
            ])
          : roofLayer === 'tiles'
            ? 0xa0a0a4
            : 0xffffff;
      roof = r.next() < 0.85 ? 'gabled' : 'skillion';
      pitch = roof === 'skillion' ? r.range(8, 14) : r.range(20, 32);
      window = null;
      door = 'barn';
      storeyM = 4;
      overhangM = 0.4;
      break;
    }
  }

  // Large buildings get flat roofs (unless agricultural), irregular footprints too.
  if (footprint.area > 1500 && category !== 'agricultural') roof = 'flat';
  if (footprint.shape === 'irregular') roof = 'flat';
  // Very wide spans get shallower pitches.
  if (roof !== 'flat' && footprint.width > 16) pitch = Math.min(pitch, 22);

  // Tags win where they are usable.
  if (look?.roofShape) {
    const k = ROOF_SHAPE_KIND[look.roofShape];
    if (k) roof = k === 'flat' || footprint.shape !== 'irregular' ? k : 'flat';
  }
  if (look?.roofAngleDegrees !== undefined)
    pitch = Math.min(60, Math.max(5, look.roofAngleDegrees));
  if (look?.roofMaterial) {
    const layer = ROOF_MATERIAL_LAYER[look.roofMaterial];
    if (layer) {
      roofLayer = layer;
      roofTint = layer === 'clay' || layer === 'slate' ? 0xffffff : roofTint;
    }
  }
  if (look?.roofColour) roofTint = tintOf(hex(look.roofColour), 0.5);
  if (look?.wallMaterial) {
    const layer = WALL_MATERIAL_LAYER[look.wallMaterial];
    if (layer) {
      wallLayer = layer;
      if (layer === 'brick' || layer === 'block') wallTint = 0xffffff;
    }
  }
  if (look?.wallColour) wallTint = tintOf(hex(look.wallColour), 0.55);
  if (roof === 'flat' && roofLayer !== 'gravel' && roofLayer !== 'metal') {
    roofLayer = 'gravel';
    roofTint = 0xd0cec8;
  }

  return {
    region,
    category,
    roof,
    pitchDegrees: pitch,
    overhangM: roof === 'flat' ? 0 : overhangM,
    parapet: roof === 'flat' && footprint.area > 60 && category !== 'outbuilding',
    roofLayer,
    roofTint: tintOf(roofTint, 0.5),
    wallLayer,
    wallTint: tintOf(wallTint, 0.5),
    trimTint: 0xf2f0ea,
    storeyM,
    window,
    door,
    doorTint,
    garage,
  };
}
