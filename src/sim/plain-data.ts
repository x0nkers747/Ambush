// Generic helpers for plain simulation data (docs/adr/0007): null, booleans,
// finite numbers, strings, arrays, plain objects and Float32Arrays (bulk
// elevation samples: a terrain's refinement). Anything else (undefined,
// NaN, ±Infinity, Map, class instances, functions) is rejected with a TypeError
// naming its path, which doubles as a check that state really is plain data.

/** Deep copy of plain data. Preserves -0. */
export function clonePlainData<T>(value: T): T {
  return cloneAt(value, '$') as T;
}

/**
 * Canonical text encoding of plain data: object keys sorted by UTF-16 code
 * unit, numbers in ECMAScript's shortest round-trip form (with -0 kept
 * distinct from 0), strings JSON-escaped. Equal data always encodes equally,
 * whatever order its properties were created in.
 */
export function canonicalEncode(value: unknown): string {
  return encodeAt(value, '$');
}

function cloneAt(value: unknown, path: string): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return checkNumber(value, path);
  if (value instanceof Float32Array) {
    checkFloats(value, path);
    return value.slice();
  }
  if (Array.isArray(value)) {
    // Elements' paths are built only when needed (for an error): terrain
    // arrays hold millions of numbers.
    return value.map((item: unknown, i) =>
      typeof item === 'number' && Number.isFinite(item)
        ? item
        : cloneAt(item, `${path}[${String(i)}]`),
    );
  }
  const record = checkPlainObject(value, path);
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(record)) copy[key] = cloneAt(record[key], `${path}.${key}`);
  return copy;
}

function encodeAt(value: unknown, path: string): string {
  if (value === null || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    checkNumber(value, path);
    return Object.is(value, -0) ? '-0' : String(value);
  }
  if (value instanceof Float32Array) return encodeFloat32(value, path);
  if (Array.isArray(value)) {
    return `[${value
      .map((item: unknown, i) =>
        typeof item === 'number' && Number.isFinite(item)
          ? Object.is(item, -0)
            ? '-0'
            : String(item)
          : encodeAt(item, `${path}[${String(i)}]`),
      )
      .join(',')}]`;
  }
  const record = checkPlainObject(value, path);
  const fields = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${encodeAt(record[key], `${path}.${key}`)}`);
  return `{${fields.join(',')}}`;
}

/**
 * A Float32Array as `f32[length]` then its little-endian bytes, two per
 * UTF-16 code unit: compact (millions of samples encode in a fraction of a
 * second), and never equal to an array of numbers' encoding.
 */
function encodeFloat32(value: Float32Array, path: string): string {
  checkFloats(value, path);
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  const units = new Uint16Array(value.length * 2);
  for (let i = 0; i < units.length; i += 1) {
    units[i] = (bytes[2 * i] ?? 0) | ((bytes[2 * i + 1] ?? 0) << 8);
  }
  const parts: string[] = [];
  for (let i = 0; i < units.length; i += 8192) {
    parts.push(String.fromCharCode(...units.subarray(i, i + 8192)));
  }
  return `f32[${String(value.length)}]${parts.join('')}`;
}

function checkFloats(value: Float32Array, path: string): void {
  for (let i = 0; i < value.length; i += 1) {
    if (!Number.isFinite(value[i])) checkNumber(value[i] ?? NaN, `${path}[${String(i)}]`);
  }
}

function checkNumber(value: number, path: string): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${path}: numbers must be finite, got ${String(value)}`);
  }
  return value;
}

function checkPlainObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value === 'object' && value !== null) {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) return value as Record<string, unknown>;
  }
  const kind =
    value === undefined
      ? 'undefined'
      : typeof value === 'object'
        ? 'non-plain object'
        : typeof value;
  throw new TypeError(`${path}: expected plain data, got ${kind}`);
}
