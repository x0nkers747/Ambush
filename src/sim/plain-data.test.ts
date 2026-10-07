import { describe, expect, it } from 'vitest';
import { canonicalEncode, clonePlainData } from './plain-data';

describe('canonicalEncode', () => {
  it('is independent of property creation order, including integer-like keys', () => {
    const a = { b: 1, a: { y: [1, 2], x: null }, 10: 'ten', 2: 'two' };
    const b = { 2: 'two', a: { x: null, y: [1, 2] }, 10: 'ten', b: 1 };
    expect(canonicalEncode(a)).toBe(canonicalEncode(b));
    expect(canonicalEncode(a)).toBe('{"10":"ten","2":"two","a":{"x":null,"y":[1,2]},"b":1}');
  });

  it('keeps array order significant', () => {
    expect(canonicalEncode([1, 2])).not.toBe(canonicalEncode([2, 1]));
  });

  it('encodes numbers exactly and keeps -0 distinct', () => {
    expect(canonicalEncode([0.1 + 0.2, 1e21, 5e-324, -0, 0])).toBe(
      '[0.30000000000000004,1e+21,5e-324,-0,0]',
    );
  });

  it('distinguishes strings that differ only in escaping', () => {
    expect(canonicalEncode('a"b')).not.toBe(canonicalEncode('a\\"b'));
  });

  it.each([
    ['undefined', { a: undefined }],
    ['NaN', { a: Number.NaN }],
    ['Infinity', [Number.POSITIVE_INFINITY]],
    ['a Map', { a: new Map() }],
    [
      'a class instance',
      {
        a: new (class Point {
          x = 0;
        })(),
      },
    ],
    ['a function', { a: () => 0 }],
  ])('rejects %s with its path', (_label, value) => {
    expect(() => canonicalEncode(value)).toThrow(TypeError);
    expect(() => canonicalEncode(value)).toThrow(/^\$/);
  });
});

describe('clonePlainData', () => {
  it('produces an equal, fully independent copy', () => {
    const original = { a: [{ x: 1 }], b: { c: 'text', d: -0 } };
    const copy = clonePlainData(original);
    expect(copy).toEqual(original);
    expect(Object.is(copy.b.d, -0)).toBe(true);
    copy.a[0] = { x: 2 };
    expect(original.a[0]?.x).toBe(1);
  });

  it('rejects non-plain data', () => {
    expect(() => clonePlainData({ at: new Map([[1, 2]]) })).toThrow(TypeError);
  });
});
