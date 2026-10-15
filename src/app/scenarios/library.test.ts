import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { createMemoryStore, openIndexedDbStore, type BattlefieldStore } from '#acquire';
import { renameSquad, type BattleScenarioDefinition } from '#exercise/battle';
import { terrainModelId } from '#sim';
import { editableFingerprint, terrainReferenceOf, workingScenario } from './document';
import { copyName, createScenarioLibrary, isDirty, type ScenarioLibrary } from './library';
import { plannedScenario, testBattlefield, testRequest } from './test-fixtures';

// The scenario library (docs/scenarios.md): saving, Save As, renaming,
// duplicating and deleting saved scenarios, their persistence in the
// browser, and the working scenarios' links to them (unsaved changes).

const fieldA = testBattlefield();
const fieldB = testBattlefield(testRequest(48.137, 11.575, 'Other ground'));
const refA = terrainReferenceOf(fieldA, terrainModelId(fieldA.terrain));
const refB = terrainReferenceOf(fieldB, terrainModelId(fieldB.terrain));

/** A library with a clock that ticks a minute per reading, and sequential ids. */
function library(store: BattlefieldStore = createMemoryStore()): {
  lib: ScenarioLibrary;
  store: BattlefieldStore;
} {
  let minute = 0;
  let id = 0;
  const lib = createScenarioLibrary(store, {
    now: () => new Date(Date.UTC(2026, 9, 15, 10, (minute += 1))),
    newId: () => `id-${String((id += 1))}`,
  });
  return { lib, store };
}

const scenario = (name = 'Woodland encounter'): BattleScenarioDefinition => ({
  ...plannedScenario(fieldA),
  name,
});

describe('saving', () => {
  it('saves a new scenario, then saves over it keeping its creation time', async () => {
    const { lib } = library();
    const first = await lib.save({
      id: null,
      name: 'Woodland encounter',
      stage: 'scenario',
      terrain: refA,
      scenario: scenario(),
    });
    expect(first).toMatchObject({ id: 'id-1', name: 'Woodland encounter', stage: 'scenario' });
    const edited = { ...scenario(), seed: 7 };
    const again = await lib.save({
      id: first.id,
      name: 'Woodland encounter',
      stage: 'bluefor',
      terrain: refA,
      scenario: edited,
    });
    expect(again.id).toBe(first.id);
    expect(again.createdAt).toBe(first.createdAt);
    expect(again.modifiedAt > first.modifiedAt).toBe(true);
    expect((await lib.get(first.id)).scenario.seed).toBe(7);
    expect((await lib.list()).entries).toHaveLength(1);
  });

  it('Save As makes an independent scenario; the original is untouched', async () => {
    const { lib } = library();
    const original = await lib.save({
      id: null,
      name: 'Plan A',
      stage: 'bluefor',
      terrain: refA,
      scenario: scenario('Plan A'),
    });
    const copy = await lib.save({
      id: null,
      name: 'Plan B',
      stage: 'bluefor',
      terrain: refA,
      scenario: { ...scenario('Plan A'), seed: 99 },
    });
    expect(copy.id).not.toBe(original.id);
    expect((await lib.get(original.id)).scenario.seed).toBe(4242);
    expect((await lib.get(original.id)).name).toBe('Plan A');
    expect((await lib.get(copy.id)).name).toBe('Plan B');
    expect((await lib.get(copy.id)).scenario.name).toBe('Plan B');
  });

  it('refuses a scenario without a name', async () => {
    const { lib } = library();
    await expect(
      lib.save({ id: null, name: '   ', stage: 'scenario', terrain: refA, scenario: scenario() }),
    ).rejects.toThrow(/needs a name/);
  });
});

describe('the library', () => {
  const filled = async () => {
    const { lib, store } = library();
    const a1 = await lib.save({
      id: null,
      name: 'Dawn',
      stage: 'scenario',
      terrain: refA,
      scenario: scenario(),
    });
    const a2 = await lib.save({
      id: null,
      name: 'Dusk',
      stage: 'bluefor',
      terrain: refA,
      scenario: scenario(),
    });
    const b1 = await lib.save({
      id: null,
      name: 'Bavaria',
      stage: 'scenario',
      terrain: refB,
      scenario: { ...scenario(), squads: [], battlefieldId: fieldB.id },
    });
    return { lib, store, a1, a2, b1 };
  };

  it('lists scenarios most recently modified first, with their terrain and forces', async () => {
    const { lib } = await filled();
    const { entries, damaged } = await lib.list();
    expect(damaged).toEqual([]);
    expect(entries.map((e) => e.name)).toEqual(['Bavaria', 'Dusk', 'Dawn']);
    expect(entries[1]).toMatchObject({
      terrainName: fieldA.name,
      battlefieldId: fieldA.id,
      blufor: 2,
      opfor: 2,
      stage: 'bluefor',
    });
    expect(entries[0]).toMatchObject({ terrainName: fieldB.name, blufor: 0, opfor: 0 });
  });

  it('holds several scenarios on one battlefield and on different ones', async () => {
    const { lib } = await filled();
    const { entries } = await lib.list();
    expect(entries.filter((e) => e.battlefieldId === fieldA.id)).toHaveLength(2);
    expect(entries.filter((e) => e.battlefieldId === fieldB.id)).toHaveLength(1);
  });

  it('renames, duplicates and deletes', async () => {
    const { lib, a1, a2 } = await filled();
    const renamed = await lib.rename(a1.id, '  First   light ');
    expect(renamed.name).toBe('First light');
    expect(renamed.scenario.name).toBe('First light');
    expect(renamed.createdAt).toBe(a1.createdAt);
    const dup = await lib.duplicate(a2.id);
    expect(dup.name).toBe('Dusk copy');
    expect(dup.id).not.toBe(a2.id);
    expect(dup.scenario.squads).toEqual(a2.scenario.squads);
    expect((await lib.duplicate(a2.id)).name).toBe('Dusk copy 2');
    await lib.remove(a2.id);
    expect(await lib.has(a2.id)).toBe(false);
    expect(await lib.has(dup.id)).toBe(true);
    await expect(lib.get(a2.id)).rejects.toThrow(/no longer exists/);
  });

  it('deleting a scenario keeps its battlefield; deleting a battlefield keeps its saved scenarios', async () => {
    const store = createMemoryStore();
    await store.put(fieldA, { overpassText: null, overpassEndpoint: '', tiles: [] });
    const { lib } = library(store);
    const saved = await lib.save({
      id: null,
      name: 'Dawn',
      stage: 'scenario',
      terrain: refA,
      scenario: scenario(),
    });
    await lib.remove(saved.id);
    expect((await store.list()).map((b) => b.id)).toEqual([fieldA.id]);
    const kept = await lib.save({
      id: null,
      name: 'Dusk',
      stage: 'scenario',
      terrain: refA,
      scenario: scenario(),
    });
    await store.delete(fieldA.id);
    expect(await lib.has(kept.id)).toBe(true);
  });

  it('reports a damaged saved scenario instead of listing it', async () => {
    const { lib, store } = await filled();
    await store.putSavedScenario('broken', {
      schema: 'ambush.saved-scenario',
      schemaVersion: 1,
      id: 'broken',
    });
    const { entries, damaged } = await lib.list();
    expect(entries).toHaveLength(3);
    expect(damaged).toEqual([
      { id: 'broken', problem: expect.stringMatching(/"name" is missing/) as unknown },
    ]);
  });

  it('names copies so they do not collide', () => {
    expect(copyName('Dusk', [])).toBe('Dusk copy');
    expect(copyName('Dusk copy', ['Dusk copy'])).toBe('Dusk copy 2');
    expect(copyName('Dusk', ['Dusk copy', 'Dusk copy 2'])).toBe('Dusk copy 3');
  });
});

describe('unsaved changes', () => {
  it('a working scenario is dirty once it differs from what was saved, and clean again when it matches', () => {
    const d = scenario();
    const link = { libraryId: 'x', fingerprint: editableFingerprint(d) };
    expect(isDirty({ definition: d, link })).toBe(false);
    const renamed = renameSquad(d, 'B1', 'Alpha');
    if (!renamed.ok) throw new Error(renamed.problem);
    expect(isDirty({ definition: renamed.definition, link })).toBe(true);
    expect(isDirty({ definition: { ...d, seed: 5 }, link })).toBe(true);
    expect(isDirty({ definition: { ...d, name: 'Other' }, link })).toBe(true);
    // Where it is stored, or the ground model, are not changes of the scenario.
    expect(isDirty({ definition: { ...d, id: 'elsewhere', terrainModel: 'm2' }, link })).toBe(
      false,
    );
  });

  it('a scenario never saved is dirty only when it holds work', () => {
    expect(isDirty({ definition: { ...scenario(), squads: [], seed: 1 }, link: null })).toBe(false);
    expect(isDirty({ definition: scenario(), link: null })).toBe(true);
  });

  it('renaming a saved scenario renames unchanged working scenarios linked to it', async () => {
    const { lib, store } = library();
    const saved = await lib.save({
      id: null,
      name: 'Dawn',
      stage: 'scenario',
      terrain: refA,
      scenario: scenario(),
    });
    const working = workingScenario(saved, fieldA.id, null);
    await store.putScenario(fieldA.id, working.id, working);
    await lib.setLink(fieldA.id, {
      libraryId: saved.id,
      fingerprint: editableFingerprint(working),
    });
    await lib.rename(saved.id, 'First light');
    const [after] = (await store.listScenarios(fieldA.id)) as BattleScenarioDefinition[];
    expect(after?.name).toBe('First light');
    const link = await lib.link(fieldA.id);
    expect(after && link && isDirty({ definition: after, link })).toBe(false);
  });

  it('deleting a saved scenario unlinks working scenarios from it', async () => {
    const { lib } = library();
    const saved = await lib.save({
      id: null,
      name: 'Dawn',
      stage: 'scenario',
      terrain: refA,
      scenario: scenario(),
    });
    await lib.setLink(fieldA.id, { libraryId: saved.id, fingerprint: 'f' });
    await lib.remove(saved.id);
    expect(await lib.link(fieldA.id)).toBeNull();
  });
});

describe('in the browser (IndexedDB)', () => {
  it('keeps saved scenarios and links across a restart', async () => {
    const factory = new IDBFactory();
    const before = library(await openIndexedDbStore(factory));
    const saved = await before.lib.save({
      id: null,
      name: 'Dawn',
      stage: 'bluefor',
      terrain: refA,
      scenario: scenario(),
    });
    await before.lib.setLink(fieldA.id, { libraryId: saved.id, fingerprint: 'f1' });
    // The browser restarts: the database is opened afresh.
    const after = library(await openIndexedDbStore(factory));
    expect(await after.lib.get(saved.id)).toEqual(saved);
    expect((await after.lib.list()).entries.map((e) => e.name)).toEqual(['Dawn']);
    expect(await after.lib.link(fieldA.id)).toEqual({ libraryId: saved.id, fingerprint: 'f1' });
    await after.lib.remove(saved.id);
    const again = library(await openIndexedDbStore(factory));
    expect((await again.lib.list()).entries).toEqual([]);
    expect(await again.lib.link(fieldA.id)).toBeNull();
  });

  it('upgrades a database of the previous version, keeping its battlefields and scenarios', async () => {
    const factory = new IDBFactory();
    await new Promise<void>((resolve, reject) => {
      const open = factory.open('ambush', 2);
      open.onupgradeneeded = () => {
        for (const name of [
          'battlefieldSummaries',
          'battlefieldPackages',
          'battlefieldSources',
          'scenarios',
        ])
          open.result.createObjectStore(name);
        open.transaction
          ?.objectStore('scenarios')
          .put({ battlefieldId: 'bf', data: { kept: true } }, 'bf/battle');
      };
      open.onsuccess = () => {
        open.result.close();
        resolve();
      };
      open.onerror = () => {
        reject(open.error ?? new Error('open failed'));
      };
    });
    const store = await openIndexedDbStore(factory);
    expect(await store.listScenarios('bf')).toEqual([{ kept: true }]);
    expect(await store.listSavedScenarios()).toEqual([]);
    await store.putSavedScenario('s', { x: 1 });
    expect(await store.getSavedScenario('s')).toEqual({ x: 1 });
  });
});
