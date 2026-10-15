import type { StoredCanopy } from './canopy';
import {
  parseBattlefieldPackage,
  type BattlefieldPackage,
  type LatLon,
  type OvertureTile,
  type TileId,
} from '#geo';

// Saved battlefields (docs/adr/0014). Each battlefield is stored as its
// package (what is played) plus its source data (the Overpass response as
// received, the elevation tiles as PNG and the Overture building tiles,
// docs/adr/0023, and the canopy heights, docs/adr/0050), so it can be reprocessed later by
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
  /**
   * The Overture building tiles as read (decompressed), with their release;
   * absent for battlefields generated before importer 1.1, `null` when the
   * buildings came from OpenStreetMap.
   */
  readonly overture?: {
    readonly release: string;
    readonly url: string;
    readonly tiles: readonly OvertureTile[];
  } | null;
  /**
   * The canopy height windows tree cover was found in (docs/adr/0050);
   * absent before importer 1.10, `null` when tree cover was off.
   */
  readonly canopy?: StoredCanopy | null;
}

export interface BattlefieldStore {
  /** Saved battlefields, newest first. */
  list(): Promise<BattlefieldSummary[]>;
  /** A saved package, validated; throws a `BattlefieldPackageError` when it is damaged or incompatible. */
  get(id: string): Promise<BattlefieldPackage>;
  getSources(id: string): Promise<BattlefieldSources | undefined>;
  put(pkg: BattlefieldPackage, sources: BattlefieldSources): Promise<void>;
  /**
   * Deletes a battlefield, its working scenario and that scenario's link.
   * Saved scenarios are kept: they only refer to the battlefield, which can
   * be found again or regenerated when one is loaded.
   */
  delete(id: string): Promise<void>;
  /**
   * Scenarios saved for a battlefield (docs/adr/0015), as stored: this layer
   * does not know the scenario format, so the caller validates them.
   */
  listScenarios(battlefieldId: string): Promise<unknown[]>;
  /** Saves (or replaces) a scenario of a battlefield. Kept apart from the battlefield package. */
  putScenario(battlefieldId: string, scenarioId: string, data: unknown): Promise<void>;
  /**
   * The scenario library (docs/scenarios.md): saved scenarios by id, as
   * stored. Like the working scenarios, this layer does not know their
   * format; the caller validates them. They are independent of the
   * battlefields they refer to.
   */
  listSavedScenarios(): Promise<unknown[]>;
  getSavedScenario(id: string): Promise<unknown>;
  putSavedScenario(id: string, data: unknown): Promise<void>;
  deleteSavedScenario(id: string): Promise<void>;
  /**
   * Which saved scenario a battlefield's working scenario was loaded from or
   * saved as (`undefined`: none), as stored.
   */
  getScenarioLink(battlefieldId: string): Promise<unknown>;
  /** Sets (or with `null`, removes) a battlefield's scenario link. */
  putScenarioLink(battlefieldId: string, link: unknown): Promise<void>;
  /** Every scenario link, by battlefield. */
  listScenarioLinks(): Promise<{ readonly battlefieldId: string; readonly link: unknown }[]>;
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
  const scenarios = new Map<string, { battlefieldId: string; data: unknown }>();
  const library = new Map<string, unknown>();
  const links = new Map<string, unknown>();
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
      for (const [key, s] of scenarios) if (s.battlefieldId === id) scenarios.delete(key);
      links.delete(id);
      return Promise.resolve();
    },
    listScenarios: (battlefieldId) =>
      Promise.resolve(
        [...scenarios.entries()]
          .filter(([, s]) => s.battlefieldId === battlefieldId)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, s]) => structuredClone(s.data)),
      ),
    putScenario: (battlefieldId, scenarioId, data) => {
      scenarios.set(scenarioId, { battlefieldId, data: structuredClone(data) });
      return Promise.resolve();
    },
    listSavedScenarios: () => Promise.resolve([...library.values()].map((d) => structuredClone(d))),
    getSavedScenario: (id) => Promise.resolve(structuredClone(library.get(id))),
    putSavedScenario: (id, data) => {
      library.set(id, structuredClone(data));
      return Promise.resolve();
    },
    deleteSavedScenario: (id) => {
      library.delete(id);
      return Promise.resolve();
    },
    getScenarioLink: (battlefieldId) => Promise.resolve(structuredClone(links.get(battlefieldId))),
    putScenarioLink: (battlefieldId, link) => {
      if (link === null) links.delete(battlefieldId);
      else links.set(battlefieldId, structuredClone(link));
      return Promise.resolve();
    },
    listScenarioLinks: () =>
      Promise.resolve(
        [...links.entries()].map(([battlefieldId, link]) => ({
          battlefieldId,
          link: structuredClone(link),
        })),
      ),
  };
}

const DB_NAME = 'ambush';
/**
 * 2 added the scenarios store; 3 the scenario library and the working
 * scenarios' links to it (existing data is kept).
 */
const DB_VERSION = 3;
const SUMMARIES = 'battlefieldSummaries';
const PACKAGES = 'battlefieldPackages';
const SOURCES = 'battlefieldSources';
const SCENARIOS = 'scenarios';
const LIBRARY = 'savedScenarios';
const LINKS = 'scenarioLinks';

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
    for (const name of [SUMMARIES, PACKAGES, SOURCES, SCENARIOS, LIBRARY, LINKS]) {
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
      const tx = db.transaction([SUMMARIES, PACKAGES, SOURCES, SCENARIOS, LINKS], 'readwrite');
      for (const name of [SUMMARIES, PACKAGES, SOURCES, LINKS]) tx.objectStore(name).delete(id);
      const scenarios = tx.objectStore(SCENARIOS);
      const keys = (await request(scenarios.getAllKeys())) as string[];
      const values = (await request(scenarios.getAll())) as { battlefieldId: string }[];
      keys.forEach((key, i) => {
        if (values[i]?.battlefieldId === id) scenarios.delete(key);
      });
      await done(tx);
    },
    async listScenarios(battlefieldId) {
      const tx = db.transaction(SCENARIOS, 'readonly');
      const store = tx.objectStore(SCENARIOS);
      const keys = (await request(store.getAllKeys())) as string[];
      const values = (await request(store.getAll())) as { battlefieldId: string; data: unknown }[];
      return keys
        .map((key, i) => ({ key, value: values[i] }))
        .filter(({ value }) => value?.battlefieldId === battlefieldId)
        .sort((a, b) => a.key.localeCompare(b.key))
        .map(({ value }) => value?.data);
    },
    async putScenario(battlefieldId, scenarioId, data) {
      const tx = db.transaction(SCENARIOS, 'readwrite');
      tx.objectStore(SCENARIOS).put({ battlefieldId, data }, scenarioId);
      await done(tx);
    },
    async listSavedScenarios() {
      const tx = db.transaction(LIBRARY, 'readonly');
      return (await request(tx.objectStore(LIBRARY).getAll())) as unknown[];
    },
    async getSavedScenario(id) {
      const tx = db.transaction(LIBRARY, 'readonly');
      return (await request(tx.objectStore(LIBRARY).get(id))) as unknown;
    },
    async putSavedScenario(id, data) {
      const tx = db.transaction(LIBRARY, 'readwrite');
      tx.objectStore(LIBRARY).put(data, id);
      await done(tx);
    },
    async deleteSavedScenario(id) {
      const tx = db.transaction(LIBRARY, 'readwrite');
      tx.objectStore(LIBRARY).delete(id);
      await done(tx);
    },
    async getScenarioLink(battlefieldId) {
      const tx = db.transaction(LINKS, 'readonly');
      return (await request(tx.objectStore(LINKS).get(battlefieldId))) as unknown;
    },
    async putScenarioLink(battlefieldId, link) {
      const tx = db.transaction(LINKS, 'readwrite');
      if (link === null) tx.objectStore(LINKS).delete(battlefieldId);
      else tx.objectStore(LINKS).put(link, battlefieldId);
      await done(tx);
    },
    async listScenarioLinks() {
      const tx = db.transaction(LINKS, 'readonly');
      const store = tx.objectStore(LINKS);
      const keys = (await request(store.getAllKeys())) as string[];
      const values = (await request(store.getAll())) as unknown[];
      return keys.map((battlefieldId, i) => ({ battlefieldId, link: values[i] }));
    },
  };
}
