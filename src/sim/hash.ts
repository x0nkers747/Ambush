import { canonicalEncode } from './plain-data';
import type { DeepReadonly, SimState } from './state';
import { isSharedTerrain } from './shared-terrain';
import type { TerrainDataset } from './terrain';
import type { SimWorld } from './world';

/**
 * Stable hash of simulation state for determinism and regression tests
 * (docs/adr/0007): 64-bit FNV-1a over the UTF-16LE bytes of the canonical
 * encoding, as 16 hex digits. An engineering tool, not a storage format.
 */
export function hashSimState(state: SimState | DeepReadonly<SimState>): string {
  return fnv1a64Utf16le(canonicalEncode(state));
}

/**
 * Content fingerprint of a simulation's immutable world (terrain and movement
 * parameters): the same hash as `hashSimState`, over the world instead of the
 * state. Identifies the context a snapshot belongs to (docs/adr/0008).
 */
export function fingerprintWorld(world: SimWorld): string {
  // A shared terrain cannot change, so its world's fingerprint is remembered
  // (per movement parameters) rather than recomputed for every simulation.
  if (!isSharedTerrain(world.terrain) || Object.keys(world).length !== 2)
    return fnv1a64Utf16le(canonicalEncode(world));
  const movement = canonicalEncode(world.movement);
  let known = worldFingerprints.get(world.terrain);
  if (!known) {
    known = new Map();
    worldFingerprints.set(world.terrain, known);
  }
  let fingerprint = known.get(movement);
  if (fingerprint === undefined) {
    fingerprint = fnv1a64Utf16le(canonicalEncode(world));
    known.set(movement, fingerprint);
  }
  return fingerprint;
}

const worldFingerprints = new WeakMap<TerrainDataset, Map<string, string>>();

/**
 * Content fingerprint of any plain data (the same hash as `fingerprintWorld`),
 * e.g. for a scenario's configuration outside the simulation (docs/adr/0012).
 */
export function fingerprintPlainData(value: unknown): string {
  return fnv1a64Utf16le(canonicalEncode(value));
}

/** FNV-1a 64-bit over a byte sequence, as 16 hex digits. */
export function fnv1a64(bytes: Iterable<number>): string {
  const h = new Fnv1a64();
  for (const byte of bytes) h.byte(byte);
  return h.hex();
}

/** `fnv1a64` over the UTF-16LE bytes of `text`, without materializing them. */
function fnv1a64Utf16le(text: string): string {
  const h = new Fnv1a64();
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    h.byte(unit & 0xff);
    h.byte(unit >>> 8);
  }
  return h.hex();
}

/**
 * FNV-1a 64-bit state in four 16-bit limbs (low first), so that it runs on
 * exact double arithmetic instead of BigInt. The prime is 2^40 + 0x1b3, so
 * h × prime mod 2^64 = h × 0x1b3 + (h << 40); every intermediate stays below
 * 2^26, far inside the exact integer range.
 */
class Fnv1a64 {
  // Offset basis 0xcbf29ce484222325.
  private h0 = 0x2325;
  private h1 = 0x8422;
  private h2 = 0x9ce4;
  private h3 = 0xcbf2;

  byte(byte: number): void {
    const h0 = this.h0 ^ (byte & 0xff);
    const t0 = h0 * 0x1b3;
    const t1 = this.h1 * 0x1b3 + (t0 >>> 16);
    const t2 = this.h2 * 0x1b3 + ((h0 << 8) & 0xffffff) + (t1 >>> 16);
    const t3 = this.h3 * 0x1b3 + ((this.h1 << 8) & 0xffffff) + (t2 >>> 16);
    this.h0 = t0 & 0xffff;
    this.h1 = t1 & 0xffff;
    this.h2 = t2 & 0xffff;
    this.h3 = t3 & 0xffff;
  }

  hex(): string {
    return [this.h3, this.h2, this.h1, this.h0]
      .map((v) => v.toString(16).padStart(4, '0'))
      .join('');
  }
}
