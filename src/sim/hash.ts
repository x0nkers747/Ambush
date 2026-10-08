import { canonicalEncode } from './plain-data';
import type { DeepReadonly, SimState } from './state';
import type { SimWorld } from './world';

/**
 * Stable hash of simulation state for determinism and regression tests
 * (docs/adr/0007): 64-bit FNV-1a over the UTF-16LE bytes of the canonical
 * encoding, as 16 hex digits. An engineering tool, not a storage format.
 */
export function hashSimState(state: SimState | DeepReadonly<SimState>): string {
  return fnv1a64(utf16leBytes(canonicalEncode(state)));
}

/**
 * Content fingerprint of a simulation's immutable world (terrain and movement
 * parameters): the same hash as `hashSimState`, over the world instead of the
 * state. Identifies the context a snapshot belongs to (docs/adr/0008).
 */
export function fingerprintWorld(world: SimWorld): string {
  return fnv1a64(utf16leBytes(canonicalEncode(world)));
}

/**
 * Content fingerprint of any plain data (the same hash as `fingerprintWorld`),
 * e.g. for a scenario's configuration outside the simulation (docs/adr/0012).
 */
export function fingerprintPlainData(value: unknown): string {
  return fnv1a64(utf16leBytes(canonicalEncode(value)));
}

const FNV64_OFFSET = 0xcbf2_9ce4_8422_2325n;
const FNV64_PRIME = 0x100_0000_01b3n;

export function fnv1a64(bytes: Iterable<number>): string {
  let hash = FNV64_OFFSET;
  for (const byte of bytes) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * FNV64_PRIME);
  return hash.toString(16).padStart(16, '0');
}

function* utf16leBytes(text: string): Generator<number> {
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    yield unit & 0xff;
    yield unit >>> 8;
  }
}
