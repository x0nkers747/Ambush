import { validateTerrain, type DemQualityReport, type TerrainDataset } from '#sim';
import { parseBattlefieldPackage, type BattlefieldPackage } from './package';

// A bundled battlefield's file (docs/bundled-battlefields.md): a battlefield
// package and its prepared terrain (cleaned and graded by the terrain model
// it names), as JSON with its typed arrays encoded. Written by
// `tools/bundle-battlefield.ts`, read by the app on a first visit.

/** A terrain prepared for play, and the DEM quality report of its cleaning. */
export interface BundledPreparedTerrain {
  readonly terrain: TerrainDataset;
  readonly quality: DemQualityReport;
}

export const BUNDLE_SCHEMA = 'ambush.bundled-battlefield';
export const BUNDLE_VERSION = 1;

export interface BattlefieldBundle {
  readonly schema: typeof BUNDLE_SCHEMA;
  readonly version: typeof BUNDLE_VERSION;
  /** The terrain model its prepared terrain was made by (`TERRAIN_MODEL`). */
  readonly terrainModel: string;
  readonly package: BattlefieldPackage;
  /**
   * Its prepared terrain, when bundled. Usually not: a 5 km battlefield's is
   * tens of megabytes (its refined samples), so the game prepares it once on
   * the first opening and keeps it.
   */
  readonly prepared?: BundledPreparedTerrain;
}

/** A prepared terrain as stored or bundled, or `null` when it is not one. */
export function preparedTerrainFrom(data: unknown): BundledPreparedTerrain | null {
  if (typeof data !== 'object' || data === null) return null;
  const { terrain, quality } = data as Partial<BundledPreparedTerrain>;
  if (typeof terrain !== 'object' || typeof quality !== 'object') return null;
  try {
    validateTerrain(terrain);
  } catch {
    return null;
  }
  return terrain.grading ? { terrain, quality } : null;
}

type TypedArray =
  | Float32Array
  | Float64Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Uint8Array
  | Uint16Array
  | Uint32Array;
const TYPED: Readonly<Record<string, new (b: ArrayBuffer) => TypedArray>> = {
  Float32Array,
  Float64Array,
  Int8Array,
  Int16Array,
  Int32Array,
  Uint8Array,
  Uint16Array,
  Uint32Array,
};

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Map(Array.from(B64, (c, i) => [c, i]));

function toBase64(bytes: Uint8Array): string {
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    out.push(
      (B64[(n >> 18) & 63] ?? '') +
        (B64[(n >> 12) & 63] ?? '') +
        (i + 1 < bytes.length ? (B64[(n >> 6) & 63] ?? '') : '=') +
        (i + 2 < bytes.length ? (B64[n & 63] ?? '') : '='),
    );
  }
  return out.join('');
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const clean = text.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      ((B64_INDEX.get(clean[i] ?? 'A') ?? 0) << 18) |
      ((B64_INDEX.get(clean[i + 1] ?? 'A') ?? 0) << 12) |
      ((B64_INDEX.get(clean[i + 2] ?? 'A') ?? 0) << 6) |
      (B64_INDEX.get(clean[i + 3] ?? 'A') ?? 0);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

/**
 * JSON of any plain data, its typed arrays as `{ "$typed": name, "base64": … }`
 * and the numbers JSON cannot hold (−0, NaN, ±∞) as `{ "$number": text }`, so
 * the data decoded is exactly the data encoded (its fingerprint unchanged).
 */
export function encodeTypedJson(data: unknown): string {
  return JSON.stringify(data, (_, value: unknown) => {
    if (typeof value === 'number' && (Object.is(value, -0) || !Number.isFinite(value)))
      return { $number: Object.is(value, -0) ? '-0' : String(value) };
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      const name = value.constructor.name;
      if (!(name in TYPED)) throw new Error(`cannot encode a ${name}`);
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return { $typed: name, base64: toBase64(bytes) };
    }
    return value;
  });
}

/** JSON of a bundle (`encodeTypedJson`). */
export function encodeBundle(bundle: BattlefieldBundle): string {
  return encodeTypedJson(bundle);
}

/** JSON whose typed arrays were encoded by `encodeBundle`, decoded. */
export function decodeTypedJson(text: string): unknown {
  return JSON.parse(text, (_, value: unknown) => {
    if (typeof value === 'object' && value !== null && '$number' in value)
      return Number((value as { $number: string }).$number);
    if (typeof value === 'object' && value !== null && '$typed' in value) {
      const { $typed, base64 } = value as { $typed: string; base64: string };
      const Ctor = TYPED[$typed];
      if (!Ctor) throw new Error(`unknown typed array ${$typed}`);
      return new Ctor(fromBase64(base64).buffer);
    }
    return value;
  });
}

/** A bundle from its JSON; throws an Error naming what is wrong. */
export function decodeBundle(text: string): BattlefieldBundle {
  const data = decodeTypedJson(text);
  const b = data as Partial<BattlefieldBundle>;
  if (b.schema !== BUNDLE_SCHEMA || b.version !== BUNDLE_VERSION)
    throw new Error('not a bundled battlefield of this version');
  if (typeof b.terrainModel !== 'string') throw new Error('the bundle names no terrain model');
  const pkg = parseBattlefieldPackage(b.package);
  const prepared = b.prepared === undefined ? null : preparedTerrainFrom(b.prepared);
  if (b.prepared !== undefined && !prepared)
    throw new Error('the bundle’s prepared terrain is damaged');
  return {
    schema: BUNDLE_SCHEMA,
    version: BUNDLE_VERSION,
    terrainModel: b.terrainModel,
    package: pkg,
    ...(prepared ? { prepared } : {}),
  };
}
