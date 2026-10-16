import type { BattlefieldStore } from '#acquire';
import { decodeBundle } from '#geo';
import { TERRAIN_MODEL } from '#sim';

// Battlefields that come with the game (docs/bundled-battlefields.md): on a
// first visit Quantico is there already, so generating a battlefield is
// optional. Each is a file in `public/battlefields/`: the battlefield package
// (what is played, without the downloaded sources it was built from), as
// gzipped JSON (`#geo`'s bundle format). Seeding stores it; its terrain is
// prepared on its first opening and kept (`authoritativeTerrain`), like any
// battlefield's. A battlefield the user deletes is not brought back: each is
// seeded once per browser.

/** The battlefields that come with the game: their files under the site's base. */
export const BUNDLED_BATTLEFIELDS: readonly {
  readonly key: string;
  readonly name: string;
  readonly file: string;
}[] = [{ key: 'quantico', name: 'Quantico', file: 'battlefields/quantico.ambush-battlefield.gz' }];

// --- The file format ---------------------------------------------------------------

/** A response's bytes, reporting the share read (when its length is known). */
async function readAll(
  response: Response,
  onFraction?: (f: number) => void,
): Promise<Uint8Array<ArrayBuffer>> {
  const total = Number(response.headers.get('content-length') ?? 0);
  if (!response.body || !onFraction || !(total > 0))
    return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    read += value.byteLength;
    onFraction(Math.min(1, read / total));
  }
  const out = new Uint8Array(read);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** The text of a file that may be gzipped (its first bytes tell), whatever the server did with it. */
export async function readMaybeGzipped(
  response: Response,
  onFraction?: (f: number) => void,
): Promise<string> {
  const bytes = await readAll(response, onFraction);
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return new TextDecoder().decode(bytes);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

// --- Seeding -----------------------------------------------------------------------

/** Remembers, per browser, which bundled battlefields were seeded. */
export interface SeedMemory {
  has(key: string): boolean;
  add(key: string): void;
}

export function localSeedMemory(storage: Storage | null): SeedMemory {
  const name = (key: string) => `ambush.bundled.${key}`;
  return {
    has: (key) => storage?.getItem(name(key)) === '1',
    add: (key) => {
      try {
        storage?.setItem(name(key), '1');
      } catch {
        // Private browsing without storage: seeded again next time (harmless).
      }
    },
  };
}

/**
 * Stores the bundled battlefields not yet seeded in this browser (their
 * packages and prepared terrain), and returns the ids of those stored now.
 * A battlefield already saved (the same package id) is only marked seeded;
 * one that cannot be fetched or read is left for the next visit.
 */
export async function seedBundledBattlefields(
  store: BattlefieldStore,
  memory: SeedMemory,
  fetchFile: (file: string) => Promise<Response>,
  /** A blocking task while one is fetched and stored (the loading overlay). */
  onTask?: (label: string) => {
    update(progress: number | null, label?: string): void;
    done(): void;
  },
): Promise<string[]> {
  const seeded: string[] = [];
  for (const { key, name, file } of BUNDLED_BATTLEFIELDS) {
    if (memory.has(key)) continue;
    const task = onTask?.(`Getting ${name} ready (first visit only)…`);
    try {
      const response = await fetchFile(file);
      if (!response.ok) continue;
      // The download is most of it; reading and storing the rest.
      const text = await readMaybeGzipped(response, (f) => task?.update(0.9 * f));
      const bundle = decodeBundle(text);
      task?.update(0.95);
      const saved = await store.list();
      if (!saved.some((b) => b.id === bundle.package.id)) {
        await store.put(bundle.package, {
          overpassText: null,
          overpassEndpoint: '',
          tiles: [],
          overture: null,
          canopy: null,
        });
        seeded.push(bundle.package.id);
      }
      // Its prepared terrain, when bundled and made by this game's terrain model.
      if (bundle.prepared && bundle.terrainModel === TERRAIN_MODEL)
        await store.putPrepared(bundle.package.id, TERRAIN_MODEL, bundle.prepared);
      memory.add(key);
    } catch {
      // Offline, or a damaged file: tried again next visit.
    } finally {
      task?.done();
    }
  }
  return seeded;
}
