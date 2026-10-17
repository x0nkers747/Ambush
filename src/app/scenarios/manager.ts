import { generationFraction, isCancelled, type BattlefieldStore } from '#acquire';
import {
  battleScenarioId,
  parseBattleScenario,
  type BattleScenarioDefinition,
} from '#exercise/battle';
import type { BattlefieldPackage } from '#geo';
import {
  editableFingerprint,
  newScenarioId,
  parseScenarioDocument,
  scenarioDocument,
  ScenarioDocumentError,
  scenarioFileName,
  serializeScenarioDocument,
  terrainReferenceOf,
  workingScenario,
  type PlanningStage,
  type ScenarioDocument,
} from './document';
import { copyName, isDirty, type ScenarioLibrary, type ScenarioLink } from './library';
import { resolveTerrain, TerrainUnavailableError, type TerrainSources } from './terrain';
import type { ScenarioDialogs } from './ui';

// Saving, loading, importing and exporting scenarios (docs/scenarios.md):
// what each does, step by step, between the planning pages, the scenario
// library and the battlefields. The pages only call it; it asks the user
// through `ScenarioDialogs` and opens the scenario loaded through `open`.
//
// Loading is all or nothing: the document is read and checked, its
// battlefield found (or generated again), and every question asked, before
// anything is replaced. A failure or a Cancel at any step leaves the
// scenarios as they were.

/** A working scenario that is open for planning. */
export interface OpenScenario {
  /** Its battlefield (the stored package: its id, request and how it was made). */
  readonly battlefield: BattlefieldPackage;
  /** The model of the ground it is planned on (`terrainModelId` of the authoritative terrain). */
  readonly terrainModel: string | null;
  definition(): BattleScenarioDefinition;
  stage(): PlanningStage;
  /** Renames it (an edit like any other, saved as the working scenario). */
  rename(name: string): void;
}

/** What the planning page shows of the scenario's saved state. */
export interface ScenarioStatus {
  /** The saved scenario it is, or `null` when never saved (or that one was deleted). */
  readonly savedName: string | null;
  readonly dirty: boolean;
}

/**
 * What the user decided about the scenario being left, for the load that
 * follows: its unsaved changes discarded (only once the new scenario is in
 * place), or nothing to do.
 */
export interface LeaveDecision {
  /** The battlefield whose working scenario is replaced by its saved state, if discarded. */
  readonly discard: string | null;
  /** The battlefield the user was planning on (its changes are decided). */
  readonly decided: string | null;
}

export interface ScenarioManagerOptions {
  readonly store: BattlefieldStore;
  readonly library: ScenarioLibrary;
  readonly dialogs: ScenarioDialogs;
  readonly terrain: TerrainSources;
  /** Opens a battlefield's working scenario at a planning stage (replacing the page shown). */
  readonly open: (
    battlefieldId: string,
    stage: PlanningStage,
    notice: string | null,
  ) => Promise<void>;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export interface ScenarioManager {
  /** Reads a battlefield's link before its planning page shows (`status` is then immediate). */
  attach(battlefieldId: string): Promise<void>;
  status(battlefieldId: string, definition: BattleScenarioDefinition): ScenarioStatus;
  /** Save: over the saved scenario it is, or (never saved) under a name asked for. `false`: not saved. */
  save(open: OpenScenario): Promise<boolean>;
  /** Save As: a new saved scenario under a name asked for; the original is unchanged. */
  saveAs(open: OpenScenario): Promise<boolean>;
  /** The scenario as a file (it is not saved in the browser). */
  exportFile(open: OpenScenario): { readonly name: string; readonly text: string };
  /** The working scenario is no longer the saved one it was (New scenario). */
  detach(battlefieldId: string): Promise<void>;
  /**
   * Before loading or importing another scenario from a planning page:
   * unsaved changes are saved, discarded (later) or the load cancelled
   * (`null`).
   */
  beforeLeaving(open: OpenScenario | null): Promise<LeaveDecision | null>;
  /** Loads a saved scenario; `false` when it was not (cancelled, or failed and the user gave up). */
  load(id: string, decision?: LeaveDecision): Promise<boolean>;
  /** Reads a scenario file; the document, or `null` after telling the user why not. */
  read(text: string): Promise<ScenarioDocument | null>;
  /** Imports a scenario read from a file into the library and loads it. */
  importDocument(doc: ScenarioDocument, decision?: LeaveDecision): Promise<boolean>;
  /**
   * Loads a demo scenario (its file's text) at Planning, as it comes: not
   * put in the library (saving it asks for a name, so the demo stays as it is).
   */
  loadDemo(text: string, decision?: LeaveDecision): Promise<boolean>;
}

const NO_DECISION: LeaveDecision = { discard: null, decided: null };

/** What a document's battlefield is called in messages. */
const where = (doc: ScenarioDocument) => doc.terrain.name;

export function createScenarioManager(o: ScenarioManagerOptions): ScenarioManager {
  const { store, library, dialogs } = o;
  const now = () => (o.now ?? (() => new Date()))();
  const newId = o.newId ?? newScenarioId;
  /** Links read or written, and the name of the saved scenario, by battlefield. */
  const links = new Map<string, { link: ScenarioLink | null; name: string | null }>();

  const readLink = async (battlefieldId: string) => {
    const link = await library.link(battlefieldId);
    const name = link
      ? await library.get(link.libraryId).then(
          (d) => d.name,
          () => null,
        )
      : null;
    // A link to a saved scenario that was deleted is no link.
    const kept = link && name !== null ? link : null;
    links.set(battlefieldId, { link: kept, name });
    return links.get(battlefieldId) ?? { link: null, name: null };
  };
  const setLink = async (battlefieldId: string, link: ScenarioLink | null, name: string | null) => {
    await library.setLink(battlefieldId, link);
    links.set(battlefieldId, { link, name });
  };

  /** A battlefield's working scenario as stored (`null` when it has none or it cannot be read). */
  const storedWorking = async (battlefieldId: string): Promise<BattleScenarioDefinition | null> => {
    const raw = (await store.listScenarios(battlefieldId)).find(
      (d) =>
        typeof d === 'object' &&
        d !== null &&
        (d as Record<string, unknown>)['id'] === battleScenarioId(battlefieldId),
    );
    if (raw === undefined) return null;
    try {
      return parseBattleScenario(raw);
    } catch {
      return null;
    }
  };
  const putWorking = (d: BattleScenarioDefinition) => store.putScenario(d.battlefieldId, d.id, d);

  /** Saves `open` as saved scenario `id` (or a new one, `null`) named `name`. */
  const saveAs = async (open: OpenScenario, id: string | null, name: string) => {
    if (open.definition().name !== name) open.rename(name);
    const definition = open.definition();
    const doc = await library.save({
      id,
      name,
      stage: open.stage(),
      terrain: terrainReferenceOf(open.battlefield, open.terrainModel),
      scenario: definition,
    });
    await setLink(
      open.battlefield.id,
      { libraryId: doc.id, fingerprint: editableFingerprint(definition) },
      doc.name,
    );
    dialogs.notify(`Saved “${doc.name}”.`);
    return doc;
  };

  const save = async (open: OpenScenario): Promise<boolean> => {
    const bf = open.battlefield.id;
    const current = links.get(bf) ?? (await readLink(bf));
    if (current.link && (await library.has(current.link.libraryId))) {
      await saveAs(open, current.link.libraryId, open.definition().name);
      return true;
    }
    const name = await dialogs.askName({
      title: 'Save scenario',
      message: 'Save this scenario in the browser, under a name.',
      value: open.definition().name,
      action: 'Save',
    });
    if (name === null) return false;
    await saveAs(open, null, name);
    return true;
  };

  /** A working scenario that is not open (another battlefield's), as an `OpenScenario` to save. */
  const storedOpen = async (
    battlefieldId: string,
    definition: BattleScenarioDefinition,
  ): Promise<OpenScenario> => {
    const battlefield = await store.get(battlefieldId);
    let d = definition;
    return {
      battlefield,
      terrainModel: d.terrainModel ?? null,
      definition: () => d,
      stage: () => 'scenario',
      rename: (name) => {
        d = { ...d, name };
        void putWorking(d);
      },
    };
  };

  /**
   * Asks about a working scenario's unsaved changes: save them (now),
   * discard them, or cancel. `null` when cancelled; otherwise whether they
   * are discarded.
   */
  const askAboutChanges = async (
    open: OpenScenario,
    what: string,
  ): Promise<{ discard: boolean } | null> => {
    const answer = await dialogs.choose({
      title: 'Unsaved changes',
      message: `${what} has changes that are not saved. Save them first?`,
      choices: [
        { id: 'save', label: 'Save', kind: 'primary' },
        { id: 'discard', label: 'Discard changes', kind: 'danger' },
      ],
    });
    if (answer === null) return null;
    if (answer === 'discard') return { discard: true };
    return (await save(open)) ? { discard: false } : null;
  };

  /** Puts battlefield `bf`'s working scenario back to what was saved (or empty, never saved). */
  const discardChanges = async (bf: string) => {
    const working = await storedWorking(bf);
    if (!working) return;
    const { link } = await readLink(bf);
    const saved = link ? await library.get(link.libraryId).catch(() => null) : null;
    if (link && saved) {
      const restored = workingScenario(saved, bf, working.terrainModel ?? null);
      await putWorking(restored);
      await setLink(
        bf,
        { libraryId: saved.id, fingerprint: editableFingerprint(restored) },
        saved.name,
      );
    } else {
      await putWorking({ ...working, name: 'Scenario 1', seed: 1, squads: [] });
    }
  };

  /** Finds the document's battlefield, with a progress dialog; its id and a note, or `null` when the user gave up. */
  const findBattlefield = async (
    doc: ScenarioDocument,
  ): Promise<{ battlefieldId: string; note: string | null; changedGround: boolean } | null> => {
    const progress = dialogs.progress({
      title: `Opening “${doc.name}”`,
      message: `Finding its battlefield, ${where(doc)}…`,
    });
    for (;;) {
      try {
        const found = await resolveTerrain(doc.terrain, o.terrain, {
          onProgress: (p) => {
            progress.update(`Generating ${where(doc)} again: ${p.message}`, generationFraction(p));
          },
          signal: progress.signal,
        });
        progress.close();
        if (found.kind !== 'regenerated')
          return { battlefieldId: found.battlefieldId, note: null, changedGround: false };
        if (found.identical)
          return {
            battlefieldId: found.battlefieldId,
            note: `${where(doc)} was not saved in this browser: it was generated again, identical to the one the scenario was made on.`,
            changedGround: false,
          };
        const use = await dialogs.choose({
          title: 'Not the same ground',
          message: `${where(doc)} was not saved in this browser and was generated again, but its source data has changed since the scenario was made (map or elevation updates): it is not the same ground. Its squads and destinations may stand differently. Load the scenario on it anyway? The new battlefield is kept either way.`,
          choices: [{ id: 'use', label: 'Load it anyway', kind: 'danger' }],
        });
        if (use !== 'use') return null;
        return {
          battlefieldId: found.battlefieldId,
          note: `Loaded on a battlefield generated again from changed source data: check that the squads and destinations are still where you want them, then save.`,
          changedGround: true,
        };
      } catch (error) {
        if (isCancelled(error)) {
          progress.close();
          dialogs.notify('Loading cancelled. Nothing was changed.');
          return null;
        }
        const retry = error instanceof TerrainUnavailableError ? error.retry : true;
        const again = await progress.failed(
          `${error instanceof Error ? error.message : String(error)} Nothing was changed.`,
          retry,
        );
        if (!again) {
          progress.close();
          return null;
        }
      }
    }
  };

  /** Loads `doc` (all or nothing); `stored`: whether it is already in the library. */
  const loadDocument = async (
    input: ScenarioDocument,
    stored: boolean,
    decision: LeaveDecision,
  ): Promise<boolean> => {
    let doc = input;
    // 1. Its battlefield.
    const found = await findBattlefield(doc);
    if (!found) return false;
    const bf = found.battlefieldId;
    const { changedGround } = found;
    // 2. An import with the id of a saved scenario never writes over it unasked.
    if (!stored && (await library.has(doc.id))) {
      const existing = await library.get(doc.id).catch(() => null);
      const answer = await dialogs.choose({
        title: 'Already saved',
        message: `A saved scenario has the same identity as this file${existing ? `: “${existing.name}”, last saved ${new Date(existing.modifiedAt).toLocaleString()}` : ''}. Import the file as a new copy, or replace the saved scenario with it?`,
        choices: [
          { id: 'copy', label: 'Import as a new copy', kind: 'primary' },
          { id: 'replace', label: 'Replace the saved one', kind: 'danger' },
        ],
      });
      if (answer === null) return false;
      if (answer === 'copy') {
        const taken = (await library.list()).entries.map((e) => e.name);
        const at = now().toISOString();
        const name = taken.includes(doc.name) ? copyName(doc.name, taken) : doc.name;
        doc = {
          ...doc,
          id: newId(),
          name,
          createdAt: at,
          modifiedAt: at,
          scenario: { ...doc.scenario, name },
        };
      }
    }
    // 3. The working scenario it replaces, if it has changes not yet decided on.
    if (bf !== decision.decided) {
      const working = await storedWorking(bf);
      const { link } = await readLink(bf);
      if (working && isDirty({ definition: working, link })) {
        const sameScenario = link?.libraryId === doc.id;
        const answer = await askAboutChanges(
          await storedOpen(bf, working),
          `The scenario on ${where(doc)} (“${working.name}”)${sameScenario ? ', the one being loaded,' : ''}`,
        );
        if (answer === null) return false;
      }
    }
    // 4. Everything is decided: replace.
    if (!stored) await library.put(doc);
    const working = workingScenario(doc, bf, doc.scenario.terrainModel ?? null);
    await putWorking(working);
    await setLink(
      bf,
      // On changed ground the saved scenario still names the old battlefield: unsaved until saved here.
      { libraryId: doc.id, fingerprint: changedGround ? '' : editableFingerprint(working) },
      doc.name,
    );
    if (decision.discard !== null && decision.discard !== bf)
      await discardChanges(decision.discard);
    await o.open(bf, doc.stage, found.note);
    return true;
  };

  return {
    async attach(battlefieldId) {
      await readLink(battlefieldId);
    },
    status(battlefieldId, definition) {
      const current = links.get(battlefieldId) ?? { link: null, name: null };
      return { savedName: current.name, dirty: isDirty({ definition, link: current.link }) };
    },
    save,
    async saveAs(open) {
      const taken = (await library.list()).entries.map((e) => e.name);
      const name = await dialogs.askName({
        title: 'Save scenario as',
        message:
          'Save a copy of this scenario under a new name. The scenario saved before stays as it was.',
        value: copyName(open.definition().name, taken),
        action: 'Save as',
      });
      if (name === null) return false;
      await saveAs(open, null, name);
      return true;
    },
    exportFile(open) {
      const bf = open.battlefield.id;
      const linked = links.get(bf)?.link ?? null;
      const at = now().toISOString();
      const definition = open.definition();
      const doc = scenarioDocument({
        id: linked?.libraryId ?? newId(),
        name: definition.name,
        createdAt: at,
        modifiedAt: at,
        stage: open.stage(),
        terrain: terrainReferenceOf(open.battlefield, open.terrainModel),
        scenario: definition,
      });
      return { name: scenarioFileName(doc.name), text: serializeScenarioDocument(doc) };
    },
    async detach(battlefieldId) {
      await setLink(battlefieldId, null, null);
    },
    async beforeLeaving(open) {
      if (!open) return NO_DECISION;
      const bf = open.battlefield.id;
      const current = links.get(bf) ?? (await readLink(bf));
      if (!isDirty({ definition: open.definition(), link: current.link }))
        return { discard: null, decided: bf };
      const answer = await askAboutChanges(open, 'This scenario');
      if (answer === null) return null;
      return { discard: answer.discard ? bf : null, decided: bf };
    },
    async load(id, decision = NO_DECISION) {
      let doc: ScenarioDocument;
      try {
        doc = await library.get(id);
      } catch (error) {
        dialogs.notify(error instanceof Error ? error.message : String(error));
        return false;
      }
      return loadDocument(doc, true, decision);
    },
    async read(text) {
      try {
        return parseScenarioDocument(text, { now, newId });
      } catch (error) {
        await dialogs.choose({
          title: 'Not imported',
          message:
            error instanceof ScenarioDocumentError
              ? error.message
              : `The file could not be read: ${error instanceof Error ? error.message : String(error)}`,
          choices: [],
        });
        return null;
      }
    },
    importDocument(doc, decision = NO_DECISION) {
      return loadDocument(doc, false, decision);
    },
    async loadDemo(text, decision = NO_DECISION) {
      const doc = await this.read(text);
      if (!doc) return false;
      return loadDocument({ ...doc, stage: 'bluefor' }, true, decision);
    },
  };
}
