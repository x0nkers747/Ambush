import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { createMemoryStore, openIndexedDbStore } from '#acquire';
import { decodeTypedJson, encodeBundle, encodeTypedJson } from '#geo';
import { TERRAIN_MODEL } from '#sim';
import { seedBundledBattlefields, type SeedMemory } from './bundled-battlefields';
import { authoritativeTerrain } from './terrain-grading';
import { testBattlefield } from './scenarios/test-fixtures';

// Battlefields that come with the game (docs/bundled-battlefields.md): the
// file format exact; a first visit stores them once; and
// a battlefield's prepared terrain is kept, so it is prepared only once.

const memory = (): SeedMemory & { readonly keys: Set<string> } => {
  const keys = new Set<string>();
  return { keys, has: (k) => keys.has(k), add: (k) => keys.add(k) };
};

describe('the file format', () => {
  it('keeps −0, NaN and typed arrays', () => {
    const data = {
      a: -0,
      b: Number.NaN,
      c: Infinity,
      d: new Float32Array([1.5, -0, 2]),
      e: [0, -0],
    };
    const back = decodeTypedJson(encodeTypedJson(data)) as typeof data;
    expect(Object.is(back.a, -0)).toBe(true);
    expect(back.b).toBeNaN();
    expect(back.c).toBe(Infinity);
    expect(back.d).toBeInstanceOf(Float32Array);
    expect(Array.from(back.d)).toEqual([1.5, -0, 2]);
    expect(Object.is(back.e[1], -0)).toBe(true);
  });
});

describe('seeding on a first visit', () => {
  const pkg = testBattlefield();
  // As served without compression (`readMaybeGzipped` reads either).
  const file = encodeBundle({
    schema: 'ambush.bundled-battlefield',
    version: 1,
    terrainModel: TERRAIN_MODEL,
    package: pkg,
  });
  const fetchFile = () => Promise.resolve(new Response(file));

  it('stores each bundled battlefield once, and not again once deleted', async () => {
    const store = createMemoryStore();
    const seen = memory();
    expect(await seedBundledBattlefields(store, seen, fetchFile)).toEqual([pkg.id]);
    expect((await store.list()).map((b) => b.id)).toEqual([pkg.id]);
    expect(await seedBundledBattlefields(store, seen, fetchFile)).toEqual([]);
    await store.delete(pkg.id);
    expect(await seedBundledBattlefields(store, seen, fetchFile)).toEqual([]);
    expect(await store.list()).toEqual([]);
  });

  it('leaves an already saved one as it is, and an unreadable file for next time', async () => {
    const store = createMemoryStore();
    await store.put(pkg, { overpassText: 'mine', overpassEndpoint: 'x', tiles: [] });
    const seen = memory();
    expect(await seedBundledBattlefields(store, seen, fetchFile)).toEqual([]);
    expect((await store.getSources(pkg.id))?.overpassText).toBe('mine');
    const other = memory();
    const empty = createMemoryStore();
    expect(
      await seedBundledBattlefields(empty, other, () =>
        Promise.resolve(new Response('', { status: 404 })),
      ),
    ).toEqual([]);
    expect(other.keys.size).toBe(0);
  });
});

describe('prepared terrain kept between visits', () => {
  it('is saved once prepared, read back next time, and dropped with its battlefield', async () => {
    const store = await openIndexedDbStore(new IDBFactory());
    const pkg = testBattlefield();
    await store.put(pkg, { overpassText: null, overpassEndpoint: '', tiles: [] });
    const cache = {
      get: (model: string) => store.getPrepared(pkg.id, model),
      put: (model: string, p: unknown) => store.putPrepared(pkg.id, model, p),
    };
    const made = await authoritativeTerrain(`${pkg.id}-a`, pkg.terrain, null, cache);
    const stored = await store.getPrepared(pkg.id, TERRAIN_MODEL);
    expect(stored).toBeDefined();
    expect(await store.getPrepared(pkg.id, 'some-other-model')).toBeUndefined();
    // Another page (a new memory key): read back, not prepared again.
    let prepared = 0;
    const counting = {
      get: cache.get,
      put: (model: string, p: unknown) => {
        prepared += 1;
        return cache.put(model, p);
      },
    };
    const again = await authoritativeTerrain(`${pkg.id}-b`, pkg.terrain, null, counting);
    expect(prepared).toBe(0);
    expect(again.terrain).toEqual(made.terrain);
    await store.delete(pkg.id);
    expect(await store.getPrepared(pkg.id, TERRAIN_MODEL)).toBeUndefined();
  });
});
