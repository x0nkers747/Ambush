import type { BuildingAppearance, RoofShape } from '#sim';

// Building appearance from source tags (docs/adr/0035): OSM's Simple 3D
// Buildings tags and Overture's building properties, normalised into one
// `BuildingAppearance`. Display only: nothing here changes a building's
// simulated height or footprint. Every value is checked; a malformed or
// contradictory one is left out (the 3D view then infers a default), never
// guessed into something else.

const ROOF_SHAPES: Readonly<Record<string, RoofShape>> = {
  flat: 'flat',
  gabled: 'gabled',
  hipped: 'hipped',
  'half-hipped': 'half-hipped',
  half_hipped: 'half-hipped',
  skillion: 'skillion',
  pyramidal: 'pyramidal',
  gambrel: 'gambrel',
  mansard: 'mansard',
  saltbox: 'saltbox',
  dome: 'dome',
  onion: 'onion',
  round: 'round',
  sawtooth: 'sawtooth',
  // Common variants.
  pitched: 'gabled',
  gable: 'gabled',
  hip: 'hipped',
  shed: 'skillion',
  lean_to: 'skillion',
  pyramid: 'pyramidal',
  spherical: 'dome',
};

/** Roof materials, OSM `roof:material` and Overture `roof_material`, to a small vocabulary. */
const ROOF_MATERIALS: Readonly<Record<string, string>> = {
  roof_tiles: 'roof_tiles',
  tiles: 'roof_tiles',
  tile: 'roof_tiles',
  clay: 'roof_tiles',
  ceramic: 'roof_tiles',
  concrete_tiles: 'concrete_tiles',
  eternit: 'concrete_tiles',
  slate: 'slate',
  metal: 'metal',
  metal_sheet: 'metal',
  tin: 'metal',
  steel: 'metal',
  copper: 'metal',
  zinc: 'metal',
  aluminium: 'metal',
  asphalt_shingle: 'shingles',
  asphalt_shingles: 'shingles',
  shingle: 'shingles',
  shingles: 'shingles',
  tar_paper: 'membrane',
  asphalt: 'membrane',
  bitumen: 'membrane',
  concrete: 'membrane',
  gravel: 'membrane',
  plastic: 'membrane',
  glass: 'glass',
  grass: 'grass',
  thatch: 'thatch',
  wood: 'wood',
  stone: 'slate',
  solar_panels: 'metal',
};

/** Wall materials, OSM `building:material` and Overture `facade_material`. */
const WALL_MATERIALS: Readonly<Record<string, string>> = {
  brick: 'brick',
  bricks: 'brick',
  plaster: 'plaster',
  render: 'plaster',
  stucco: 'plaster',
  cement_block: 'block',
  concrete: 'concrete',
  reinforced_concrete: 'concrete',
  stone: 'stone',
  sandstone: 'stone',
  limestone: 'stone',
  wood: 'wood',
  timber: 'wood',
  timber_framing: 'wood',
  vinyl: 'wood',
  metal: 'metal',
  steel: 'metal',
  metal_plates: 'metal',
  glass: 'glass',
  mirror: 'glass',
};

/** CSS colour names in common use on buildings (OSM `*:colour`), as hex. */
const COLOUR_NAMES: Readonly<Record<string, string>> = {
  white: '#ffffff',
  black: '#000000',
  grey: '#808080',
  gray: '#808080',
  lightgrey: '#d3d3d3',
  lightgray: '#d3d3d3',
  darkgrey: '#a9a9a9',
  darkgray: '#a9a9a9',
  silver: '#c0c0c0',
  red: '#ff0000',
  darkred: '#8b0000',
  maroon: '#800000',
  brown: '#a52a2a',
  sienna: '#a0522d',
  orange: '#ffa500',
  yellow: '#ffff00',
  beige: '#f5f5dc',
  wheat: '#f5deb3',
  tan: '#d2b48c',
  ivory: '#fffff0',
  cream: '#fffdd0',
  green: '#008000',
  darkgreen: '#006400',
  olive: '#808000',
  blue: '#0000ff',
  navy: '#000080',
  lightblue: '#add8e6',
  pink: '#ffc0cb',
  salmon: '#fa8072',
  terracotta: '#e2725b',
};

/** A colour as "#rrggbb", from "#rgb", "#rrggbb" or a known name; null otherwise. */
export function parseColour(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, '');
  const expand = (h: string) => `#${h.length === 3 ? h.replace(/./g, (c) => c + c) : h}`;
  if (v.startsWith('#')) {
    const h = v.slice(1);
    return /^([0-9a-f]{3}|[0-9a-f]{6})$/.test(h) ? expand(h) : null;
  }
  return COLOUR_NAMES[v] ?? (/^[0-9a-f]{6}$/.test(v) ? expand(v) : null);
}

/** A length in metres ("12", "12.5", "12 m", "12,5"); feet ("30'", "30 ft") converted. */
export function parseLength(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const t = value.trim().replace(',', '.');
  const metres = /^(\d+(?:\.\d+)?)\s*(m|metres|meters)?$/.exec(t);
  if (metres) {
    const v = Number(metres[1]);
    return Number.isFinite(v) && v > 0 ? v : null;
  }
  const feet = /^(\d+(?:\.\d+)?)\s*('|ft|feet)$/.exec(t);
  if (feet) {
    const v = Number(feet[1]) * 0.3048;
    return Number.isFinite(v) && v > 0 ? v : null;
  }
  return null;
}

/** A storey count: a non-negative number up to 200 (half storeys allowed); null otherwise. */
export function parseLevels(value: unknown): number | null {
  const v =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  return Number.isFinite(v) && v >= 0 && v <= 200 && Number.isInteger(v * 2) ? v : null;
}

const COMPASS: Readonly<Record<string, number>> = {
  N: 0,
  NNE: 22.5,
  NE: 45,
  ENE: 67.5,
  E: 90,
  ESE: 112.5,
  SE: 135,
  SSE: 157.5,
  S: 180,
  SSW: 202.5,
  SW: 225,
  WSW: 247.5,
  W: 270,
  WNW: 292.5,
  NW: 315,
  NNW: 337.5,
};

/** A bearing in degrees [0, 360), from a number or a compass point; null otherwise. */
export function parseBearing(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? ((value % 360) + 360) % 360 : null;
  if (typeof value !== 'string') return null;
  const t = value.trim().toUpperCase();
  const named = COMPASS[t];
  if (named !== undefined) return named;
  const v = Number(t);
  return t !== '' && Number.isFinite(v) ? ((v % 360) + 360) % 360 : null;
}

/** Raw attributes from either source, before checking. */
export interface RawBuildingAttributes {
  readonly kind?: unknown;
  readonly part?: unknown;
  readonly use?: unknown;
  readonly levels?: unknown;
  readonly levelsUnderground?: unknown;
  readonly height?: unknown;
  readonly minHeight?: unknown;
  readonly roofShape?: unknown;
  readonly roofHeight?: unknown;
  readonly roofLevels?: unknown;
  readonly roofAngle?: unknown;
  readonly roofOrientation?: unknown;
  readonly roofDirection?: unknown;
  readonly roofMaterial?: unknown;
  readonly wallMaterial?: unknown;
  readonly roofColour?: unknown;
  readonly wallColour?: unknown;
  readonly country?: unknown;
}

const word = (v: unknown): string | null =>
  typeof v === 'string' && /^[a-z0-9_:;=-]{1,40}$/i.test(v.trim()) ? v.trim().toLowerCase() : null;

/** The checked, normalised appearance; null when nothing usable is given. */
export function buildingAppearance(raw: RawBuildingAttributes): BuildingAppearance | null {
  const out: Record<string, unknown> = {};
  const kind = word(raw.kind);
  if (kind && kind !== 'yes' && kind !== 'true') out['kind'] = kind;
  const part = word(raw.part);
  if (part && part !== 'no') out['part'] = part;
  const use =
    typeof raw.use === 'string' && /^[a-z_]+=[a-z0-9_;-]{1,40}$/.test(raw.use) ? raw.use : null;
  if (use) out['use'] = use;
  const levels = parseLevels(raw.levels);
  if (levels !== null) out['levels'] = levels;
  const under = parseLevels(raw.levelsUnderground);
  if (under !== null) out['levelsUnderground'] = under;
  const height = parseLength(raw.height);
  if (height !== null && height <= 1000) out['heightMeters'] = height;
  const minHeight =
    typeof raw.minHeight === 'number' && raw.minHeight === 0 ? null : parseLength(raw.minHeight);
  // A minimum height at or above the height contradicts it: dropped.
  if (minHeight !== null && (height === null || minHeight < height))
    out['minHeightMeters'] = minHeight;
  const shape =
    typeof raw.roofShape === 'string' ? ROOF_SHAPES[raw.roofShape.trim().toLowerCase()] : undefined;
  if (shape) out['roofShape'] = shape;
  const roofHeight = parseLength(raw.roofHeight);
  // A roof as tall as the whole building, or taller, contradicts the height: dropped.
  if (roofHeight !== null && roofHeight <= 60 && (height === null || roofHeight < height)) {
    out['roofHeightMeters'] = roofHeight;
  }
  const roofLevels = parseLevels(raw.roofLevels);
  if (roofLevels !== null) out['roofLevels'] = roofLevels;
  const angle =
    typeof raw.roofAngle === 'number'
      ? raw.roofAngle
      : typeof raw.roofAngle === 'string'
        ? Number(raw.roofAngle)
        : NaN;
  if (Number.isFinite(angle) && angle > 0 && angle < 80) out['roofAngleDegrees'] = angle;
  const orientation =
    typeof raw.roofOrientation === 'string' ? raw.roofOrientation.trim().toLowerCase() : '';
  if (orientation === 'along' || orientation === 'across') out['roofOrientation'] = orientation;
  const direction = parseBearing(raw.roofDirection);
  if (direction !== null) out['roofDirectionDegrees'] = direction;
  const roofMaterial =
    typeof raw.roofMaterial === 'string'
      ? ROOF_MATERIALS[raw.roofMaterial.trim().toLowerCase()]
      : undefined;
  if (roofMaterial) out['roofMaterial'] = roofMaterial;
  const wallMaterial =
    typeof raw.wallMaterial === 'string'
      ? WALL_MATERIALS[raw.wallMaterial.trim().toLowerCase()]
      : undefined;
  if (wallMaterial) out['wallMaterial'] = wallMaterial;
  const roofColour = parseColour(raw.roofColour);
  if (roofColour) out['roofColour'] = roofColour;
  const wallColour = parseColour(raw.wallColour);
  if (wallColour) out['wallColour'] = wallColour;
  const country = typeof raw.country === 'string' ? raw.country.trim().toUpperCase() : '';
  if (/^[A-Z]{2}$/.test(country)) out['country'] = country;
  return Object.keys(out).length > 0 ? out : null;
}

/** OSM tags to raw attributes. */
export function osmBuildingAttributes(t: Readonly<Record<string, string>>): RawBuildingAttributes {
  const use = t['amenity']
    ? `amenity=${t['amenity']}`
    : t['shop']
      ? `shop=${t['shop']}`
      : t['military']
        ? `military=${t['military']}`
        : undefined;
  return {
    kind: t['building'],
    part: t['building:part'],
    use,
    levels: t['building:levels'],
    levelsUnderground: t['building:levels:underground'],
    height: t['height'],
    minHeight: t['min_height'],
    roofShape: t['roof:shape'],
    roofHeight: t['roof:height'],
    roofLevels: t['roof:levels'],
    roofAngle: t['roof:angle'],
    roofOrientation: t['roof:orientation'],
    roofDirection: t['roof:direction'],
    roofMaterial: t['roof:material'],
    wallMaterial: t['building:material'],
    roofColour: t['roof:colour'],
    wallColour: t['building:colour'],
    country: t['addr:country'],
  };
}
