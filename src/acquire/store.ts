import { parseBattlefieldPackage, type BattlefieldPackage, type LatLon, type TileId } from '#geo';

// Saved battlefields (docs/adr/0014). Each battlefield is stored as its
// package (what is played) plus its source data (the Overpass response as
// received and the elevation tiles as PNG), so it can be reprocessed later by
// a newer importer without downloading again. Stored packages are re-validated
// on load: damaged or incompatible data is reported, never half-loaded.

/** What the battlefield list shows, without loading the terrain. */
export interface BattlefieldSummary {
  readonly id: string;
  readonly name: string;
  readonly centre: LatLon;
  readonly widthM: number;
  readonly heightM: number;
  readonly createdAt: string;
  readonly elevationResolutionM: number | null;
  readonly counts: BattlefieldPackage['processing']['counts'];
  readonly osmAvailable: boolean;
}

/** The downloaded data a package was built from. */
export interface BattlefieldSources {
  readonly overpassText: string | null;
  readonly overpassEndpoint: string;
  readonly tiles: readonly (TileId & { readonly png: Blob | null; readonly sources: string })[];
}

export interface BattlefieldStore {
  /** Saved battlefields, newest first. */
  list(): Promise<BattlefieldSummary[]>;
  /** A saved package, validated; throws a `BattlefieldPackageError` when it is damaged or incompatible. */
  get(id: string): Promise<BattlefieldPackage>;
  getSources(id: string): Promise<BattlefieldSources | undefined>;
  put(pkg: BattlefieldPackage, sources: BattlefieldSources): Promise<void>;
  delete(id: string): Promise<void>;
}

export function summarize(pkg: BattlefieldPackage): BattlefieldSummary {
  return {
    id: pkg.id,
    name: pkg.name,
    centre: pkg.request.centre,
    widthM: pkg.request.widthM,
    heightM: pkg.request.heightM,
    createdAt: pkg.createdAt,
    elevationResolutionM: pkg.elevation.finestResolutionM,
    counts: pkg.processing.counts,
    osmAvailable: pkg.osm.available,
  };
}

const newestFirst = (a: BattlefieldSummary, b: BattlefieldSummary) =>
  b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);

/** An in-memory store (tests, or when IndexedDB is unavailable: nothing survives a reload). */
export function createMemoryStore(): BattlefieldStore {
  const packages = new Map<string, unknown>();
  const sources = new Map<string, BattlefieldSources>();
  return {
    list: () =>
      Promise.resolve(
        [...packages.values()].map((p) => summarize(p as BattlefieldPackage)).sort(newestFirst),
      ),
    get: (id) => {
      const data = packages.get(id);
      if (data === undefined) return Promise.reject(new Error(`No saved battlefield "${id}".`));
      return Promise.resolve().then(() => parseBattlefieldPackage(structuredClone(data)));
    },
    getSources: (id) => Promise.resolve(sources.get(id)),
    put: (pkg, src) => {
      packages.set(pkg.id, structuredClone(pkg));
      sources.set(pkg.id, src);
      return Promise.resolve();
    },
    delete: (id) => {
      packages.delete(id);
      sources.delete(id);
      return Promise.resolve();
    },
  };
}

const DB_NAME = 'ambush';
const DB_VERSION = 1;
const SUMMARIES = 'battlefieldSummaries';
const PACKAGES = 'battlefieldPackages';
const SOURCES = 'battlefieldSources';

const request = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => {
      resolve(r.result);
    };
    r.onerror = () => {
      reject(r.error ?? new Error('IndexedDB request failed'));
    };
  });

const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onabort = tx.onerror = () => {
      reject(tx.error ?? new Error('IndexedDB transaction failed'));
    };
  });

/**
 * The browser's persistent store. Asks the browser to keep the data
 * (`navigator.storage.persist`) so saved battlefields are not evicted.
 */
export async function openIndexedDbStore(
  factory: IDBFactory = indexedDB,
): Promise<BattlefieldStore> {
  const open = factory.open(DB_NAME, DB_VERSION);
  open.onupgradeneeded = () => {
    const db = open.result;
    for (const name of [SUMMARIES, PACKAGES, SOURCES]) {
      if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
    }
  };
  const db = await request(open);
  // Ask the browser not to evict saved battlefields; refusal is harmless.
  if ('storage' in navigator && typeof navigator.storage.persist === 'function') {
    void navigator.storage.persist().catch(() => false);
  }
  return {
    async list() {
      const tx = db.transaction(SUMMARIES, 'readonly');
      const all = (await request(tx.objectStore(SUMMARIES).getAll())) as BattlefieldSummary[];
      return all.sort(newestFirst);
    },
    async get(id) {
      const tx = db.transaction(PACKAGES, 'readonly');
      const data: unknown = await request(tx.objectStore(PACKAGES).get(id));
      if (data === undefined) throw new Error(`No saved battlefield "${id}".`);
      return parseBattlefieldPackage(data);
    },
    async getSources(id) {
      const tx = db.transaction(SOURCES, 'readonly');
      return (await request(tx.objectStore(SOURCES).get(id))) as BattlefieldSources | undefined;
    },
    async put(pkg, src) {
      const tx = db.transaction([SUMMARIES, PACKAGES, SOURCES], 'readwrite');
      tx.objectStore(PACKAGES).put(pkg, pkg.id);
      tx.objectStore(SOURCES).put(src, pkg.id);
      tx.objectStore(SUMMARIES).put(summarize(pkg), pkg.id);
      await done(tx);
    },
    async delete(id) {
      const tx = db.transaction([SUMMARIES, PACKAGES, SOURCES], 'readwrite');
      for (const name of [SUMMARIES, PACKAGES, SOURCES]) tx.objectStore(name).delete(id);
      await done(tx);
    },
  };
}
