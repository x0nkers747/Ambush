import { describe, expect, it } from 'vitest';
import { createMemoryStore, DEFAULT_SERVICES, ServiceError, type BattlefieldStore } from '#acquire';
import {
  battleScenarioId,
  newBattleScenario,
  renameSquad,
  type BattleScenarioDefinition,
} from '#exercise/battle';
import type { BattlefieldPackage } from '#geo';
import { terrainModelId } from '#sim';
import {
  editableFingerprint,
  parseScenarioDocument,
  serializeScenarioDocument,
  type PlanningStage,
  type ScenarioDocument,
} from './document';
import { createScenarioLibrary, type ScenarioLibrary } from './library';
import { createScenarioManager, type OpenScenario } from './manager';
import type { TerrainSources } from './terrain';
import { plannedScenario, testBattlefield, testRequest } from './test-fixtures';
import type { ProgressDialog, ScenarioDialogs } from './ui';

// The scenario workflow (docs/scenarios.md), with scripted answers in place
// of the dialogs: saving from the planning stages, loading and importing
// from terrain selection or planning, unsaved changes, colliding imports,
// battlefields found, generated again or not found, and loads that fail or
// are cancelled changing nothing.

const fieldA = testBattlefield();
const fieldB = testBattlefield(testRequest(48.137, 11.575, 'Bavarian ground'));
const modelOf = (pkg: BattlefieldPackage) => terrainModelId(pkg.terrain);

type Answer = string | null;

/** Dialogs answered from a script, recording what was asked. */
function scripted(answers: Answer[] = []) {
  const asked: string[] = [];
  const notes: string[] = [];
  const failures: string[] = [];
  const next = (what: string): Answer => {
    asked.push(what);
    if (answers.length === 0) throw new Error(`Unexpected question: ${what}`);
    return answers.shift() ?? null;
  };
  const dialogs: ScenarioDialogs = {
    choose: (o) => {
      if (o.choices.length === 0) {
        failures.push(o.message);
        return Promise.resolve(null);
      }
      return Promise.resolve(next(`choose:${o.title}`) as never);
    },
    askName: (o) => Promise.resolve(next(`name:${o.title}:${o.value}`)),
    progress: (): ProgressDialog => ({
      signal: new AbortController().signal,
      update: () => undefined,
      failed: (message) => {
        failures.push(message);
        return Promise.resolve(next('retry?') === 'retry');
      },
      close: () => undefined,
    }),
    notify: (m) => {
      notes.push(m);
    },
  };
  return { dialogs, asked, notes, failures, answers };
}

interface World {
  store: BattlefieldStore;
  library: ScenarioLibrary;
  opened: { battlefieldId: string; stage: PlanningStage; notice: string | null }[];
  generated: string[];
  /** The battlefield open on a page, if any. */
  openId: string | null;
}

async function world(
  o: {
    saved?: readonly BattlefieldPackage[];
    /** What generating gives (by default: fails, as offline). */
    generate?: (request: BattlefieldPackage['request']) => BattlefieldPackage;
  } = {},
): Promise<World> {
  const store = createMemoryStore();
  for (const pkg of o.saved ?? [fieldA, fieldB])
    await store.put(pkg, { overpassText: null, overpassEndpoint: '', tiles: [] });
  let id = 0;
  let minute = 0;
  const library = createScenarioLibrary(store, {
    now: () => new Date(Date.UTC(2026, 9, 15, 9, (minute += 1))),
    newId: () => `s${String((id += 1))}`,
  });
  return { store, library, opened: [], generated: [], openId: null };
}

function managerOf(
  w: World,
  d: ReturnType<typeof scripted>,
  generate?: (r: BattlefieldPackage['request']) => BattlefieldPackage,
) {
  const terrain: TerrainSources = {
    config: DEFAULT_SERVICES,
    openId: () => w.openId,
    isSaved: async (id) => (await w.store.list()).some((b) => b.id === id),
    generate: async (request) => {
      w.generated.push(request.name ?? '');
      if (!generate) throw new ServiceError('Elevation tiles', 'The network is unreachable.');
      const pkg = generate(request);
      await w.store.put(pkg, { overpassText: null, overpassEndpoint: '', tiles: [] });
      return pkg;
    },
  };
  let n = 100;
  return createScenarioManager({
    store: w.store,
    library: w.library,
    dialogs: d.dialogs,
    terrain,
    open: (battlefieldId, stage, notice) => {
      w.opened.push({ battlefieldId, stage, notice });
      w.openId = battlefieldId;
      return Promise.resolve();
    },
    now: () => new Date('2026-10-15T12:00:00Z'),
    newId: () => `n${String((n += 1))}`,
  });
}

/** A planning page's scenario: edited in place, saved as the working scenario as it is edited. */
function page(
  w: World,
  pkg: BattlefieldPackage,
  definition: BattleScenarioDefinition,
  stage: PlanningStage = 'bluefor',
) {
  let d: BattleScenarioDefinition = {
    ...definition,
    id: battleScenarioId(pkg.id),
    battlefieldId: pkg.id,
  };
  void w.store.putScenario(pkg.id, d.id, d);
  w.openId = pkg.id;
  const open: OpenScenario & { set(next: BattleScenarioDefinition): void } = {
    battlefield: pkg,
    terrainModel: modelOf(pkg),
    definition: () => d,
    stage: () => stage,
    rename: (name) => {
      open.set({ ...d, name });
    },
    set: (next) => {
      d = next;
      void w.store.putScenario(pkg.id, d.id, d);
    },
  };
  return open;
}

const working = async (w: World, pkg: BattlefieldPackage) =>
  ((await w.store.listScenarios(pkg.id)) as BattleScenarioDefinition[]).find(
    (d) => d.id === battleScenarioId(pkg.id),
  );

const renamed = (d: BattleScenarioDefinition, squad: string, name: string) => {
  const r = renameSquad(d, squad, name);
  if (!r.ok) throw new Error(r.problem);
  return r.definition;
};

describe('saving from the planning stages', () => {
  it('Scenario Setup: a scenario never saved is named, saved, and clean; edits make it dirty; Save saves over it', async () => {
    const w = await world();
    const d = scripted(['Dawn attack']);
    const m = managerOf(w, d);
    const open = page(w, fieldA, plannedScenario(fieldA), 'scenario');
    await m.attach(fieldA.id);
    expect(m.status(fieldA.id, open.definition())).toEqual({ savedName: null, dirty: true });
    expect(await m.save(open)).toBe(true);
    expect(d.asked).toEqual(['name:Save scenario:Woodland encounter']);
    expect(open.definition().name).toBe('Dawn attack');
    expect(m.status(fieldA.id, open.definition())).toEqual({
      savedName: 'Dawn attack',
      dirty: false,
    });
    const [entry] = (await w.library.list()).entries;
    expect(entry).toMatchObject({
      name: 'Dawn attack',
      stage: 'scenario',
      battlefieldId: fieldA.id,
    });

    open.set(renamed(open.definition(), 'B1', 'Alpha'));
    expect(m.status(fieldA.id, open.definition()).dirty).toBe(true);
    expect(await m.save(open)).toBe(true);
    expect(d.asked).toHaveLength(1); // no second question
    expect(m.status(fieldA.id, open.definition()).dirty).toBe(false);
    const { entries } = await w.library.list();
    expect(entries).toHaveLength(1);
    expect((await w.library.get(entries[0]?.id ?? '')).scenario.squads[0]?.name).toBe('Alpha');
  });

  it('BLUEFOR Planning: saves with incomplete plans, and remembers the stage', async () => {
    const w = await world();
    const m = managerOf(w, scripted(['Half planned']));
    const incomplete = {
      ...plannedScenario(fieldA),
      squads: plannedScenario(fieldA).squads.map((s) => ({ ...s, plan: [] })),
    };
    const open = page(w, fieldA, incomplete, 'bluefor');
    await m.attach(fieldA.id);
    expect(await m.save(open)).toBe(true);
    const doc = await w.library.get((await w.library.list()).entries[0]?.id ?? '');
    expect(doc.stage).toBe('bluefor');
    expect(doc.scenario.squads.every((s) => s.plan.length === 0)).toBe(true);
  });

  it('a cancelled name saves nothing', async () => {
    const w = await world();
    const m = managerOf(w, scripted([null]));
    const open = page(w, fieldA, plannedScenario(fieldA));
    await m.attach(fieldA.id);
    expect(await m.save(open)).toBe(false);
    expect((await w.library.list()).entries).toEqual([]);
  });

  it('Save As makes a new saved scenario and leaves the original as it was', async () => {
    const w = await world();
    const m = managerOf(w, scripted(['Plan A', 'Plan B']));
    const open = page(w, fieldA, plannedScenario(fieldA));
    await m.attach(fieldA.id);
    await m.save(open);
    open.set({ ...open.definition(), seed: 99 });
    expect(await m.saveAs(open)).toBe(true);
    const { entries } = await w.library.list();
    expect(entries.map((e) => e.name).sort()).toEqual(['Plan A', 'Plan B']);
    const a = await w.library.get(entries.find((e) => e.name === 'Plan A')?.id ?? '');
    const b = await w.library.get(entries.find((e) => e.name === 'Plan B')?.id ?? '');
    expect(a.scenario.seed).toBe(4242);
    expect(b.scenario.seed).toBe(99);
    expect(m.status(fieldA.id, open.definition())).toEqual({ savedName: 'Plan B', dirty: false });
  });

  it('Export writes the scenario as it is, saved or not, without saving it', async () => {
    const w = await world();
    const m = managerOf(w, scripted());
    const open = page(w, fieldA, plannedScenario(fieldA));
    await m.attach(fieldA.id);
    const file = m.exportFile(open);
    expect(file.name).toBe('woodland-encounter.ambush.json');
    const doc = parseScenarioDocument(file.text);
    expect(doc.scenario.squads).toEqual(open.definition().squads);
    expect(doc.terrain.battlefieldId).toBe(fieldA.id);
    expect((await w.library.list()).entries).toEqual([]);
    expect(m.status(fieldA.id, open.definition()).dirty).toBe(true);
  });
});

/** A saved scenario on `pkg`, by saving a page. */
async function saved(
  w: World,
  pkg: BattlefieldPackage,
  name: string,
  stage: PlanningStage,
  def = plannedScenario(pkg),
) {
  const m = managerOf(w, scripted([name]));
  const open = page(w, pkg, def, stage);
  await m.attach(pkg.id);
  await m.save(open);
  const entry = (await w.library.list()).entries.find((e) => e.name === name);
  if (!entry) throw new Error('not saved');
  return entry.id;
}

describe('loading', () => {
  it('from terrain selection: on its saved battlefield, at the stage it was saved at, clean', async () => {
    const w = await world();
    const id = await saved(w, fieldB, 'Bavaria', 'bluefor', {
      ...plannedScenario(fieldB),
      squads: [],
    });
    await w.store.putScenario(
      fieldB.id,
      battleScenarioId(fieldB.id),
      newBattleScenario(fieldB.terrain, fieldB.id),
    );
    await w.library.setLink(fieldB.id, null);
    w.openId = null;
    const m = managerOf(w, scripted());
    expect(await m.load(id)).toBe(true);
    expect(w.opened).toEqual([{ battlefieldId: fieldB.id, stage: 'bluefor', notice: null }]);
    const loaded = await working(w, fieldB);
    if (!loaded) throw new Error('not loaded');
    expect(loaded.name).toBe('Bavaria');
    expect(m.status(fieldB.id, loaded)).toEqual({
      savedName: 'Bavaria',
      dirty: false,
    });
  });

  it('restores the squads, plans and seed exactly (the same battle)', async () => {
    const w = await world();
    const id = await saved(w, fieldA, 'Dawn', 'scenario');
    await w.store.putScenario(
      fieldA.id,
      battleScenarioId(fieldA.id),
      newBattleScenario(fieldA.terrain, fieldA.id),
    );
    await w.library.setLink(fieldA.id, null);
    const m = managerOf(w, scripted());
    await m.load(id);
    const loaded = await working(w, fieldA);
    expect(loaded && editableFingerprint({ ...loaded, name: 'Woodland encounter' })).toBe(
      editableFingerprint(plannedScenario(fieldA)),
    );
  });

  it('scenarios on different battlefields in succession', async () => {
    const w = await world();
    const a = await saved(w, fieldA, 'On A', 'scenario');
    const b = await saved(w, fieldB, 'On B', 'bluefor');
    const m = managerOf(w, scripted());
    expect(await m.load(a)).toBe(true);
    expect(await m.load(b)).toBe(true);
    expect(await m.load(a)).toBe(true);
    expect(w.opened.map((x) => [x.battlefieldId, x.stage])).toEqual([
      [fieldA.id, 'scenario'],
      [fieldB.id, 'bluefor'],
      [fieldA.id, 'scenario'],
    ]);
  });

  it('asks before replacing a battlefield’s working scenario that has unsaved changes', async () => {
    const w = await world();
    const id = await saved(w, fieldA, 'Dawn', 'scenario');
    // Edited since, not saved.
    const open = page(w, fieldA, renamed(plannedScenario(fieldA), 'B1', 'Edited'));
    w.openId = null;
    const cancel = scripted([null]);
    expect(await managerOf(w, cancel).load(id)).toBe(false);
    expect(cancel.asked).toEqual(['choose:Unsaved changes']);
    expect((await working(w, fieldA))?.squads[0]?.name).toBe('Edited');
    expect(w.opened).toEqual([]);

    const discard = scripted(['discard']);
    expect(await managerOf(w, discard).load(id)).toBe(true);
    expect((await working(w, fieldA))?.squads[0]?.name).not.toBe('Edited');
    expect(open.definition().squads[0]?.name).toBe('Edited');
  });

  it('does not ask when there are no unsaved changes', async () => {
    const w = await world();
    const id = await saved(w, fieldA, 'Dawn', 'scenario');
    const d = scripted();
    expect(await managerOf(w, d).load(id)).toBe(true);
    expect(d.asked).toEqual([]);
  });
});

describe('loading from a planning stage', () => {
  it('clean: no question', async () => {
    const w = await world();
    const a = await saved(w, fieldA, 'Dawn', 'scenario');
    const b = await saved(w, fieldB, 'Bavaria', 'bluefor');
    const d = scripted();
    const m = managerOf(w, d);
    const open = page(w, fieldA, (await w.library.get(a)).scenario);
    await m.attach(fieldA.id);
    const decision = await m.beforeLeaving({
      ...open,
      definition: () => ({ ...open.definition(), name: 'Dawn' }),
    });
    expect(decision).toEqual({ discard: null, decided: fieldA.id });
    expect(await m.load(b, decision ?? undefined)).toBe(true);
    expect(d.asked).toEqual([]);
  });

  it('Save, then load', async () => {
    const w = await world();
    const b = await saved(w, fieldB, 'Bavaria', 'bluefor');
    const d = scripted(['save', 'My plan']);
    const m = managerOf(w, d);
    const open = page(w, fieldA, plannedScenario(fieldA));
    await m.attach(fieldA.id);
    const decision = await m.beforeLeaving(open);
    expect(decision).toEqual({ discard: null, decided: fieldA.id });
    expect((await w.library.list()).entries.map((e) => e.name)).toContain('My plan');
    expect(await m.load(b, decision ?? undefined)).toBe(true);
  });

  it('Cancel stays', async () => {
    const w = await world();
    const m = managerOf(w, scripted([null]));
    const open = page(w, fieldA, plannedScenario(fieldA));
    await m.attach(fieldA.id);
    expect(await m.beforeLeaving(open)).toBeNull();
  });

  it('Discard takes effect only once the new scenario is in place: a failed load keeps the changes', async () => {
    const w = await world({ saved: [fieldA] });
    // A scenario on B, whose battlefield is not saved here and cannot be generated (offline).
    const bDoc = parseScenarioDocument(
      serializeScenarioDocument(
        await (async () => {
          const w2 = await world();
          return w2.library.get(await saved(w2, fieldB, 'Bavaria', 'bluefor'));
        })(),
      ),
    );
    const d = scripted(['discard', 'give up']);
    const m = managerOf(w, d);
    const open = page(w, fieldA, plannedScenario(fieldA));
    await m.attach(fieldA.id);
    const decision = await m.beforeLeaving(open);
    expect(decision).toEqual({ discard: fieldA.id, decided: fieldA.id });
    expect(await m.importDocument(bDoc, decision ?? undefined)).toBe(false);
    expect(d.failures.join(' ')).toMatch(/could not be generated again.*Nothing was changed/);
    // Nothing changed: A's work is still there, the library has nothing new.
    expect((await working(w, fieldA))?.squads).toHaveLength(4);
    expect((await w.library.list()).entries).toEqual([]);
    expect(w.opened).toEqual([]);
  });

  it('Discard: once the new scenario is loaded, the scenario left goes back to what was saved', async () => {
    const w = await world();
    const a = await saved(w, fieldA, 'Dawn', 'scenario');
    const b = await saved(w, fieldB, 'Bavaria', 'bluefor');
    const m = managerOf(w, scripted(['discard']));
    const open = page(w, fieldA, renamed((await w.library.get(a)).scenario, 'B1', 'Edited'));
    await m.attach(fieldA.id);
    const decision = await m.beforeLeaving(open);
    expect(await m.load(b, decision ?? undefined)).toBe(true);
    const back = await working(w, fieldA);
    expect(back?.squads[0]?.name).not.toBe('Edited');
    expect(back && m.status(fieldA.id, back)).toEqual({ savedName: 'Dawn', dirty: false });
  });
});

describe('importing', () => {
  const fileOf = async (pkg: BattlefieldPackage, name: string, stage: PlanningStage) => {
    const w2 = await world();
    return serializeScenarioDocument(await w2.library.get(await saved(w2, pkg, name, stage)));
  };

  it('a valid file: added to the library and loaded at its stage', async () => {
    const w = await world();
    const d = scripted();
    const m = managerOf(w, d);
    const doc = await m.read(await fileOf(fieldB, 'Imported', 'bluefor'));
    if (!doc) throw new Error('not read');
    expect(await m.importDocument(doc)).toBe(true);
    expect((await w.library.list()).entries.map((e) => e.name)).toEqual(['Imported']);
    expect(w.opened).toEqual([{ battlefieldId: fieldB.id, stage: 'bluefor', notice: null }]);
    const loaded = await working(w, fieldB);
    expect(loaded && m.status(fieldB.id, loaded)).toEqual({ savedName: 'Imported', dirty: false });
  });

  it('an invalid file: refused with the reason, nothing changed', async () => {
    const w = await world();
    const d = scripted();
    const m = managerOf(w, d);
    expect(await m.read('{"schema": "ambush.saved-scenario", "schemaVersion": 9}')).toBeNull();
    expect(d.failures[0]).toMatch(/newer Ambush!/);
    expect(await m.read('not json')).toBeNull();
    expect(d.failures[1]).toMatch(/not valid JSON/);
    expect((await w.library.list()).entries).toEqual([]);
  });

  it('the same scenario id as a saved one: never written over unasked', async () => {
    const w = await world();
    const id = await saved(w, fieldA, 'Dawn', 'scenario');
    const file = serializeScenarioDocument({
      ...(await w.library.get(id)),
      scenario: { ...(await w.library.get(id)).scenario, seed: 77 },
    });
    const doc = parseScenarioDocument(file);

    const cancel = scripted([null]);
    expect(await managerOf(w, cancel).importDocument(doc)).toBe(false);
    expect((await w.library.get(id)).scenario.seed).toBe(4242);

    const copy = scripted(['copy']);
    expect(await managerOf(w, copy).importDocument(doc)).toBe(true);
    const { entries } = await w.library.list();
    expect(entries.map((e) => e.name).sort()).toEqual(['Dawn', 'Dawn copy']);
    expect((await w.library.get(id)).scenario.seed).toBe(4242);
    expect(
      (await w.library.get(entries.find((e) => e.name === 'Dawn copy')?.id ?? '')).scenario.seed,
    ).toBe(77);

    const replace = scripted(['replace']);
    expect(await managerOf(w, replace).importDocument(doc)).toBe(true);
    expect((await w.library.get(id)).scenario.seed).toBe(77);
  });
});

describe('the battlefield of a scenario loaded', () => {
  const docOn = async (pkg: BattlefieldPackage) => {
    const w2 = await world();
    return w2.library.get(await saved(w2, pkg, 'Far away', 'bluefor'));
  };

  it('missing here: generated again, identical, and loaded', async () => {
    const doc = await docOn(fieldB);
    const w = await world({ saved: [fieldA] });
    const m = managerOf(w, scripted(), (request) => testBattlefield(request));
    expect(await m.importDocument(doc)).toBe(true);
    expect(w.generated).toEqual(['Bavarian ground']);
    expect(w.opened[0]).toMatchObject({
      battlefieldId: fieldB.id,
      notice: expect.stringMatching(/generated again, identical/) as unknown,
    });
  });

  it('missing and generated from changed source data: the user decides, and is warned', async () => {
    const doc: ScenarioDocument = await docOn(fieldB);
    const changed = (request: BattlefieldPackage['request']) => testBattlefield(request, 0.08);
    const refuse = await world({ saved: [fieldA] });
    const no = scripted([null]);
    expect(await managerOf(refuse, no, changed).importDocument(doc)).toBe(false);
    expect(no.asked).toEqual(['choose:Not the same ground']);
    expect(refuse.opened).toEqual([]);
    expect((await refuse.library.list()).entries).toEqual([]);

    const accept = await world({ saved: [fieldA] });
    const yes = scripted(['use']);
    const m = managerOf(accept, yes, changed);
    expect(await m.importDocument(doc)).toBe(true);
    const target = accept.opened[0]?.battlefieldId ?? '';
    expect(target).not.toBe(fieldB.id);
    expect(accept.opened[0]?.notice).toMatch(/changed source data/);
    // Unsaved until saved on this ground (the saved scenario still names the other).
    const loaded = await working(accept, { ...fieldB, id: target });
    expect(loaded && m.status(target, loaded).dirty).toBe(true);
  });

  it('missing and generation fails: try again, then it works', async () => {
    const doc = await docOn(fieldB);
    const w = await world({ saved: [fieldA] });
    let attempts = 0;
    const d = scripted(['retry']);
    const m = managerOf(w, d, (request) => {
      attempts += 1;
      if (attempts === 1) throw new ServiceError('Elevation tiles', 'The service did not answer.');
      return testBattlefield(request);
    });
    expect(await m.importDocument(doc)).toBe(true);
    expect(d.failures[0]).toMatch(/did not answer/);
    expect(attempts).toBe(2);
  });

  it('an old file naming its battlefield by id only loads where that battlefield is saved, and otherwise says why', async () => {
    const bare = JSON.stringify(plannedScenario(fieldA));
    const here = await world();
    const m = managerOf(here, scripted());
    const doc = await m.read(bare);
    if (!doc) throw new Error('not read');
    expect(await m.importDocument(doc)).toBe(true);
    const elsewhere = await world({ saved: [fieldB] });
    const d = scripted(['give up']);
    expect(await managerOf(elsewhere, d).importDocument(doc)).toBe(false);
    expect(d.failures[0]).toMatch(/does not say how to generate it again/);
  });
});
