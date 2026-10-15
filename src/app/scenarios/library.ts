import type { BattlefieldStore } from '#acquire';
import {
  battleScenarioId,
  parseBattleScenario,
  type BattleScenarioDefinition,
} from '#exercise/battle';
import {
  cleanName,
  editableFingerprint,
  nameProblem,
  newScenarioId,
  parseScenarioDocument,
  scenarioDocument,
  ScenarioDocumentError,
  type PlanningStage,
  type ScenarioDocument,
  type TerrainReference,
} from './document';

// The scenario library (docs/scenarios.md): the user's saved scenarios, kept
// in the browser (IndexedDB, through the battlefield store) apart from the
// battlefields they refer to, so that any number of scenarios share one
// battlefield's terrain and deleting a scenario never deletes a battlefield.
//
// Each battlefield also keeps its working scenario (what its planning pages
// edit, saved as it is edited), and a link saying which saved scenario that
// is and what it was when last saved (`ScenarioLink`). The working scenario
// has unsaved changes when it is no longer what was saved (`isDirty`).

/** What the library lists of a saved scenario. */
export interface LibraryEntry {
  readonly id: string;
  readonly name: string;
  readonly battlefieldId: string;
  readonly terrainName: string;
  readonly createdAt: string;
  readonly modifiedAt: string;
  readonly blufor: number;
  readonly opfor: number;
  readonly stage: PlanningStage;
}

/** Which saved scenario a battlefield's working scenario is, and its fingerprint when last saved. */
export interface ScenarioLink {
  readonly libraryId: string;
  /** `editableFingerprint` of the scenario as saved. */
  readonly fingerprint: string;
}

/** A battlefield's working scenario and its link. */
export interface WorkingState {
  readonly definition: BattleScenarioDefinition;
  readonly link: ScenarioLink | null;
}

/**
 * Whether a working scenario has changes not in the library: it differs
 * from what was saved; or, never saved, it holds any work.
 */
export function isDirty(state: WorkingState): boolean {
  if (state.link) return editableFingerprint(state.definition) !== state.link.fingerprint;
  return state.definition.squads.length > 0 || state.definition.seed !== 1;
}

export interface ScenarioLibrary {
  /** The saved scenarios, most recently modified first, and any that could not be read. */
  list(): Promise<{
    readonly entries: readonly LibraryEntry[];
    readonly damaged: readonly { readonly id: string; readonly problem: string }[];
  }>;
  /** A saved scenario; throws a `ScenarioDocumentError` when it is missing or damaged. */
  get(id: string): Promise<ScenarioDocument>;
  has(id: string): Promise<boolean>;
  /** Stores a document (a new one, or a replacement of the one with its id). */
  put(doc: ScenarioDocument): Promise<void>;
  /**
   * Saves a working scenario: over saved scenario `id` (keeping its creation
   * time), or with `id` `null` as a new saved scenario named `name`.
   */
  save(o: {
    readonly id: string | null;
    readonly name: string;
    readonly stage: PlanningStage;
    readonly terrain: TerrainReference;
    readonly scenario: BattleScenarioDefinition;
  }): Promise<ScenarioDocument>;
  rename(id: string, name: string): Promise<ScenarioDocument>;
  /** A copy under a new id, named "… copy" (or `name`). */
  duplicate(id: string, name?: string): Promise<ScenarioDocument>;
  /** Deletes a saved scenario (never a battlefield); working scenarios linked to it are unlinked. */
  remove(id: string): Promise<void>;
  link(battlefieldId: string): Promise<ScenarioLink | null>;
  setLink(battlefieldId: string, link: ScenarioLink | null): Promise<void>;
}

export interface LibraryOptions {
  readonly now?: () => Date;
  readonly newId?: () => string;
}

const readLink = (raw: unknown): ScenarioLink | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const { libraryId, fingerprint } = raw as Record<string, unknown>;
  return typeof libraryId === 'string' && typeof fingerprint === 'string'
    ? { libraryId, fingerprint }
    : null;
};

/** The name of a copy: "Name copy", "Name copy 2", … not yet used. */
export function copyName(name: string, taken: readonly string[]): string {
  const base = cleanName(`${name.replace(/ copy( \d+)?$/, '')} copy`);
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base} ${String(n)}`)) n += 1;
  return `${base} ${String(n)}`;
}

export function createScenarioLibrary(
  store: BattlefieldStore,
  o: LibraryOptions = {},
): ScenarioLibrary {
  const now = () => (o.now ?? (() => new Date()))().toISOString();
  const newId = o.newId ?? newScenarioId;

  const read = (raw: unknown): ScenarioDocument => parseScenarioDocument(raw, { newId });
  const get = async (id: string): Promise<ScenarioDocument> => {
    const raw = await store.getSavedScenario(id);
    if (raw === undefined) throw new ScenarioDocumentError('That saved scenario no longer exists.');
    const doc = read(raw);
    if (doc.id !== id) throw new ScenarioDocumentError('That saved scenario is damaged.');
    return doc;
  };
  const put = (doc: ScenarioDocument) => store.putSavedScenario(doc.id, doc);
  const checkName = (name: string) => {
    const problem = nameProblem(name);
    if (problem) throw new ScenarioDocumentError(problem);
  };

  /** Working scenarios linked to saved scenario `id` and unchanged since saved: their names follow it. */
  const followRename = async (doc: ScenarioDocument, previous: ScenarioDocument) => {
    for (const { battlefieldId, link: raw } of await store.listScenarioLinks()) {
      const link = readLink(raw);
      if (link?.libraryId !== doc.id) continue;
      const working = (await store.listScenarios(battlefieldId)).find(
        (d) =>
          typeof d === 'object' &&
          d !== null &&
          (d as Record<string, unknown>)['id'] === battleScenarioId(battlefieldId),
      );
      if (working === undefined) continue;
      let definition: BattleScenarioDefinition;
      try {
        definition = parseBattleScenario(working);
      } catch {
        continue;
      }
      if (editableFingerprint(definition) !== link.fingerprint || definition.name !== previous.name)
        continue;
      const renamed = { ...definition, name: doc.name };
      await store.putScenario(battlefieldId, renamed.id, renamed);
      await store.putScenarioLink(battlefieldId, {
        libraryId: doc.id,
        fingerprint: editableFingerprint(renamed),
      });
    }
  };

  return {
    async list() {
      const entries: LibraryEntry[] = [];
      const damaged: { id: string; problem: string }[] = [];
      for (const raw of await store.listSavedScenarios()) {
        try {
          const doc = read(raw);
          entries.push({
            id: doc.id,
            name: doc.name,
            battlefieldId: doc.terrain.battlefieldId,
            terrainName: doc.terrain.name,
            createdAt: doc.createdAt,
            modifiedAt: doc.modifiedAt,
            blufor: doc.scenario.squads.filter((s) => s.side === 'BLUEFOR').length,
            opfor: doc.scenario.squads.filter((s) => s.side === 'OPFOR').length,
            stage: doc.stage,
          });
        } catch (error) {
          const rawId =
            typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['id'] : null;
          const id = typeof rawId === 'string' ? rawId : '?';
          damaged.push({ id, problem: error instanceof Error ? error.message : String(error) });
        }
      }
      entries.sort(
        (a, b) =>
          b.modifiedAt.localeCompare(a.modifiedAt) ||
          a.name.localeCompare(b.name) ||
          a.id.localeCompare(b.id),
      );
      return { entries, damaged };
    },
    get,
    async has(id) {
      return (await store.getSavedScenario(id)) !== undefined;
    },
    put,
    async save({ id, name, stage, terrain, scenario }) {
      checkName(name);
      const existing = id === null ? null : await get(id).catch(() => null);
      const at = now();
      const doc = scenarioDocument({
        id: existing?.id ?? id ?? newId(),
        name,
        createdAt: existing?.createdAt ?? at,
        modifiedAt: at,
        stage,
        terrain,
        scenario,
      });
      await put(doc);
      return doc;
    },
    async rename(id, name) {
      checkName(name);
      const previous = await get(id);
      const clean = cleanName(name);
      const doc: ScenarioDocument = {
        ...previous,
        name: clean,
        modifiedAt: now(),
        scenario: { ...previous.scenario, name: clean },
      };
      await put(doc);
      await followRename(doc, previous);
      return doc;
    },
    async duplicate(id, name) {
      const original = await get(id);
      const taken = (await this.list()).entries.map((e) => e.name);
      const copy = cleanName(name ?? copyName(original.name, taken));
      checkName(copy);
      const at = now();
      const doc: ScenarioDocument = {
        ...structuredClone(original),
        id: newId(),
        name: copy,
        createdAt: at,
        modifiedAt: at,
        scenario: { ...structuredClone(original.scenario), name: copy },
      };
      await put(doc);
      return doc;
    },
    async remove(id) {
      await store.deleteSavedScenario(id);
      for (const { battlefieldId, link } of await store.listScenarioLinks()) {
        if (readLink(link)?.libraryId === id) await store.putScenarioLink(battlefieldId, null);
      }
    },
    async link(battlefieldId) {
      return readLink(await store.getScenarioLink(battlefieldId));
    },
    setLink: (battlefieldId, link) => store.putScenarioLink(battlefieldId, link),
  };
}
