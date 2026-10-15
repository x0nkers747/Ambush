import { describe, expect, it } from 'vitest';
import { newBattleScenario } from '#exercise/battle';
import { terrainModelId } from '#sim';
import {
  editableFingerprint,
  hasWork,
  parseScenarioDocument,
  SAVED_SCENARIO_SCHEMA,
  SAVED_SCENARIO_SCHEMA_VERSION,
  scenarioDocument,
  ScenarioDocumentError,
  scenarioFileName,
  serializeScenarioDocument,
  terrainReferenceOf,
  workingScenario,
  type ScenarioDocument,
} from './document';
import { plannedScenario, testBattlefield } from './test-fixtures';

// The saved-scenario document (docs/scenarios.md): what it holds, its file
// form, and how strictly it is read.

const pkg = testBattlefield();
const model = terrainModelId(pkg.terrain);

const document = (over: Partial<Parameters<typeof scenarioDocument>[0]> = {}): ScenarioDocument =>
  scenarioDocument({
    id: '0f6b5a2e-1111-4222-8333-944445555666',
    name: 'Woodland encounter',
    createdAt: '2026-10-15T10:00:00.000Z',
    modifiedAt: '2026-10-15T11:00:00.000Z',
    stage: 'bluefor',
    terrain: terrainReferenceOf(pkg, model),
    scenario: plannedScenario(),
    ...over,
  });

const refused = (input: unknown, message: RegExp) => {
  expect(() => parseScenarioDocument(input)).toThrow(ScenarioDocumentError);
  expect(() => parseScenarioDocument(input)).toThrow(message);
};

describe('the saved-scenario document', () => {
  it('holds the scenario, its identity, times, stage and its battlefield', () => {
    const doc = document();
    expect(doc.schema).toBe(SAVED_SCENARIO_SCHEMA);
    expect(doc.schemaVersion).toBe(SAVED_SCENARIO_SCHEMA_VERSION);
    expect(doc.application.name).toBe('Ambush!');
    expect(doc.terrain).toMatchObject({
      battlefieldId: pkg.id,
      name: pkg.name,
      request: pkg.request,
      crs: { epsg: pkg.frame.epsg, zone: pkg.frame.zone, hemisphere: pkg.frame.hemisphere },
      terrainModel: model,
      generation: {
        importerVersion: pkg.processing.importerVersion,
        buildingSource: 'none',
        treeCover: 'off',
        osmAvailable: false,
        elevation: { provider: pkg.elevation.provider, zoom: pkg.elevation.zoom },
      },
    });
    expect(doc.terrain.geographicBounds).toEqual(pkg.geographicBounds);
    expect(doc.scenario.battlefieldId).toBe(pkg.id);
  });

  it('round-trips through its file exactly: forces, formations, plans, facings, seed', () => {
    const doc = document();
    const text = serializeScenarioDocument(doc);
    const read = parseScenarioDocument(text);
    expect(read).toEqual(doc);
    const squads = read.scenario.squads;
    expect(squads.map((s) => [s.id, s.side, s.organization])).toEqual([
      ['B1', 'BLUEFOR', 'squad'],
      ['B2', 'BLUEFOR', 'fireTeam'],
      ['O1', 'OPFOR', 'element3'],
      ['O2', 'OPFOR', 'squad'],
    ]);
    expect(squads[0]?.formation).toBe('usmc.squad.line');
    expect(squads[1]?.facingDeg).toBe(15);
    expect(squads[0]?.plan.map((o) => o.kind)).toEqual(['move', 'attack']);
    expect(read.scenario.seed).toBe(4242);
    expect(editableFingerprint(read.scenario)).toBe(editableFingerprint(plannedScenario()));
    // Read twice: the same.
    expect(parseScenarioDocument(serializeScenarioDocument(read))).toEqual(doc);
  });

  it('becomes a battlefield’s working scenario with that battlefield’s ids', () => {
    const working = workingScenario(document(), 'other-field', 'model-x');
    expect(working).toMatchObject({
      id: 'other-field/battle',
      battlefieldId: 'other-field',
      name: 'Woodland encounter',
      terrainModel: 'model-x',
    });
    expect(working.squads).toEqual(plannedScenario().squads);
  });

  it('names its file after the scenario', () => {
    expect(scenarioFileName('Woodland Encounter')).toBe('woodland-encounter.ambush.json');
    expect(scenarioFileName('  Hill 402 / Night  ')).toBe('hill-402-night.ambush.json');
    expect(scenarioFileName('Élan vital')).toBe('elan-vital.ambush.json');
    expect(scenarioFileName('???')).toBe('scenario.ambush.json');
  });

  it('knows work from a new, empty scenario', () => {
    expect(hasWork(newBattleScenario(pkg.terrain, pkg.id))).toBe(false);
    expect(hasWork(plannedScenario())).toBe(true);
  });
});

describe('reading a document', () => {
  const json = () => JSON.parse(serializeScenarioDocument(document())) as Record<string, unknown>;

  it('refuses what is not JSON, not an object, or not a scenario', () => {
    refused('{ not json', /not valid JSON/);
    refused('[1, 2]', /not hold a JSON object/);
    refused({ schema: 'ambush.battlefield', schemaVersion: 1 }, /not an Ambush! scenario/);
    refused('x'.repeat(5_000_001), /too large/);
  });

  it('refuses versions it does not know, newer ones saying so', () => {
    refused({ ...json(), schemaVersion: 2 }, /saved by a newer Ambush!/);
    refused({ ...json(), schemaVersion: 0 }, /version 0 is not supported/);
    refused({ ...json(), schemaVersion: '1' }, /schema version is missing/);
  });

  it('refuses missing or wrong fields, naming them', () => {
    const noName = json();
    delete noName['name'];
    refused(noName, /"name" is missing/);
    refused({ ...json(), stage: 'combat' }, /planning stage is unknown/);
    refused({ ...json(), modifiedAt: 'yesterday' }, /"modifiedAt" is not a date/);
    refused({ ...json(), terrain: null }, /terrain reference is missing/);
    const terrain = json()['terrain'] as Record<string, unknown>;
    refused({ ...json(), terrain: { ...terrain, battlefieldId: '' } }, /"battlefieldId"/);
    refused(
      { ...json(), terrain: { ...terrain, crs: { epsg: 32618, zone: 18, hemisphere: 'X' } } },
      /hemisphere/,
    );
  });

  it('refuses fields it does not know (a newer version may mean something by them)', () => {
    refused({ ...json(), weather: 'rain' }, /does not know \("weather"\)/);
    const scenario = json()['scenario'] as { squads: Record<string, unknown>[] };
    const squads = scenario.squads.map((s, i) => (i === 1 ? { ...s, morale: 0.4 } : s));
    refused({ ...json(), scenario: { ...scenario, squads } }, /Squad 2 has a field.*"morale"/);
    const plan = [{ kind: 'move', destination: { east: 1, north: 2 }, speed: 3 }];
    const withSpeed = scenario.squads.map((s, i) => (i === 0 ? { ...s, plan } : s));
    refused(
      { ...json(), scenario: { ...scenario, squads: withSpeed } },
      /order 1 has a field.*"speed"/,
    );
  });

  it('checks the scenario as the game does: ids, sides, organizations, formations, orders, points', () => {
    const scenario = json()['scenario'] as { squads: Record<string, unknown>[] };
    const edit = (i: number, change: Record<string, unknown>) => ({
      ...json(),
      scenario: {
        ...scenario,
        squads: scenario.squads.map((s, k) => (k === i ? { ...s, ...change } : s)),
      },
    });
    refused(edit(1, { id: 'B1' }), /squad id "B1" is used twice/);
    refused(edit(0, { id: '1st' }), /has no valid id/);
    refused(edit(0, { side: 'GREEN' }), /side is not BLUEFOR or OPFOR/);
    refused(edit(0, { organization: 'platoon' }), /organization is unknown/);
    refused(edit(0, { formation: 'blob' }), /formation is unknown/);
    refused(
      edit(0, { plan: [{ kind: 'dance', destination: { east: 0, north: 0 } }] }),
      /kind is unknown/,
    );
    refused(edit(0, { position: { east: 'x', north: 0 } }), /position is not a map point/);
    refused(edit(0, { facingDeg: null }), /facing is not a number/);
    refused({ ...json(), scenario: { ...scenario, seed: -1 } }, /seed/);
    refused(
      { ...json(), scenario: { ...scenario, battlefieldId: 'elsewhere' } },
      /not the one its terrain reference names/,
    );
  });

  it('refuses absurd sizes', () => {
    const scenario = json()['scenario'] as { squads: Record<string, unknown>[] };
    const many = Array.from({ length: 501 }, (_, i) => ({
      ...scenario.squads[0],
      id: `B${String(i + 1)}`,
    }));
    refused({ ...json(), scenario: { ...scenario, squads: many } }, /more than 500 squads/);
  });

  it('migrates a bare battle scenario (as exported before the library), its battlefield named by id only', () => {
    const bare = plannedScenario();
    const doc = parseScenarioDocument(JSON.stringify(bare), {
      newId: () => 'new-id',
      now: () => new Date('2026-10-16T09:00:00Z'),
    });
    expect(doc).toMatchObject({
      id: 'new-id',
      name: 'Woodland encounter',
      createdAt: '2026-10-16T09:00:00.000Z',
      stage: 'scenario',
      terrain: { battlefieldId: pkg.id, generation: null },
    });
    expect(doc.scenario.squads).toEqual(bare.squads);
  });

  it('migrates a version 1 (ambush) scenario', () => {
    const v1 = {
      schema: 'ambush.scenario',
      schemaVersion: 1,
      id: `${pkg.id}/1`,
      battlefieldId: pkg.id,
      name: 'Old ambush',
      orp: { east: -100, north: -200 },
      opfor: {
        force: 'patrol-3',
        route: [
          { east: 0, north: 300 },
          { east: 0, north: -300 },
        ],
      },
    };
    const doc = parseScenarioDocument(v1);
    expect(doc.scenario.squads.map((s) => s.id)).toEqual(['B1', 'O1']);
    expect(doc.scenario.squads[1]?.plan).toEqual([
      { kind: 'move', destination: { east: 0, north: -300 } },
    ]);
  });
});
