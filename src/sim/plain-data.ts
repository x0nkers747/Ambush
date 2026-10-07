// Generic helpers for plain simulation data (docs/adr/0007): null, booleans,
// finite numbers, strings, arrays and plain objects. Anything else (undefined,
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
  if (Array.isArray(value)) return value.map((item, i) => cloneAt(item, `${path}[${String(i)}]`));
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
  if (Array.isArray(value)) {
    return `[${value.map((item, i) => encodeAt(item, `${path}[${String(i)}]`)).join(',')}]`;
  }
  const record = checkPlainObject(value, path);
  const fields = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${encodeAt(record[key], `${path}.${key}`)}`);
  return `{${fields.join(',')}}`;
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
