import { canonicalEncode } from './plain-data';
import type { DeepReadonly, SimState } from './state';

/**
 * Stable hash of simulation state for determinism and regression tests
 * (docs/adr/0007): 64-bit FNV-1a over the UTF-16LE bytes of the canonical
 * encoding, as 16 hex digits. An engineering tool, not a storage format.
 */
export function hashSimState(state: SimState | DeepReadonly<SimState>): string {
  return fnv1a64(utf16leBytes(canonicalEncode(state)));
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
