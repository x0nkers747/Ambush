import {
  BATTLE_SCHEMA_VERSION,
  battleScenarioId,
  BattleScenarioError,
  parseBattleScenario,
  SCENARIO_SCHEMA,
  type BattleScenarioDefinition,
} from '#exercise/battle';
import {
  IMPORTER_VERSION,
  type BattlefieldPackage,
  type BattlefieldRequest,
  type GeoBox,
} from '#geo';
import { fingerprintPlainData } from '#sim';

// Saved scenarios (docs/scenarios.md): a battle scenario as the user keeps
// it, in the scenario library or in a `.ambush.json` file. One document
// format serves both. It holds the scenario itself (`ambush.scenario`
// version 2, as Scenario Setup and BLUEFOR Planning edit it), its name and
// times, the planning stage it was saved at, and a reference to the
// battlefield it was made on: never the terrain itself, which the browser's
// battlefields keep (or which is generated again from the reference).
//
// Reading is strict: a document is checked completely before anything
// uses it, every field is of the right kind, unknown fields are refused
// (a newer Ambush! may have meant something by them), and older formats are
// migrated (`parseScenarioDocument`).

export const SAVED_SCENARIO_SCHEMA = 'ambush.saved-scenario';
export const SAVED_SCENARIO_SCHEMA_VERSION = 1;
/** The recommended file extension. */
export const SCENARIO_FILE_EXTENSION = '.ambush.json';
/** Files larger than this are refused unread (a scenario is a few kilobytes). */
export const MAX_SCENARIO_FILE_BYTES = 5_000_000;
/** Most squads, and most orders per squad, a scenario may have. */
export const MAX_SQUADS = 500;
export const MAX_ORDERS_PER_SQUAD = 500;
/** Longest scenario name. */
export const MAX_SCENARIO_NAME = 80;

/** The planning stage a scenario returns to when loaded. */
export type PlanningStage = 'scenario' | 'bluefor';

/**
 * The battlefield a scenario was made on. `battlefieldId` is the
 * battlefield's content fingerprint (of its request and terrain): two
 * battlefields with the same id have the same ground, whatever else differs;
 * matching coordinates alone prove nothing. The rest says how to generate it
 * again and what to expect: a battlefield generated again from the same
 * request and settings has the same id only if its source data has not
 * changed.
 */
export interface TerrainReference {
  readonly battlefieldId: string;
  readonly name: string;
  /** What was asked for: centre, size and grid spacing. */
  readonly request: BattlefieldRequest;
  /** The local map frame: UTM zone and hemisphere (EPSG code), metres east and north of the centre. */
  readonly crs: {
    readonly epsg: number;
    readonly zone: number;
    readonly hemisphere: 'N' | 'S';
  };
  /** WGS84 boxes covering the battlefield. */
  readonly geographicBounds: readonly GeoBox[];
  /** The model of the ground the simulation ran on (`terrainModelId`), when known. */
  readonly terrainModel: string | null;
  /** How it was generated, to generate it again the same way. */
  readonly generation: {
    readonly importerVersion: string;
    readonly createdAt: string;
    /** Where its buildings came from. */
    readonly buildingSource: 'overture' | 'openstreetmap' | 'none';
    /** The Overture release read, when the buildings are Overture's. */
    readonly overtureRelease: string | null;
    /** Whether woods were added from canopy heights. */
    readonly treeCover: 'canopy' | 'off';
    /** Whether it has OpenStreetMap features (false: terrain only). */
    readonly osmAvailable: boolean;
    /** The OpenStreetMap data's timestamp. */
    readonly osmTimestamp: string | null;
    readonly elevation: {
      readonly provider: string;
      readonly zoom: number;
      readonly finestResolutionM: number | null;
    };
  } | null;
}

/** A saved scenario (version 1 of `ambush.saved-scenario`). */
export interface ScenarioDocument {
  readonly schema: typeof SAVED_SCENARIO_SCHEMA;
  readonly schemaVersion: typeof SAVED_SCENARIO_SCHEMA_VERSION;
  /** Stable identity in the library (a UUID). */
  readonly id: string;
  readonly name: string;
  /** ISO 8601. */
  readonly createdAt: string;
  readonly modifiedAt: string;
  /** What made it, for compatibility checks. */
  readonly application: {
    readonly name: 'Ambush!';
    /** The `ambush.scenario` version of `scenario`. */
    readonly scenarioSchemaVersion: typeof BATTLE_SCHEMA_VERSION;
    readonly importerVersion: string;
  };
  readonly stage: PlanningStage;
  readonly terrain: TerrainReference;
  /** The scenario: squads, positions, facings, formations, plans and seed. */
  readonly scenario: BattleScenarioDefinition;
}

export class ScenarioDocumentError extends Error {
  override name = 'ScenarioDocumentError';
}

/** The terrain reference of a battlefield (`terrainModel`: its authoritative ground's model id). */
export function terrainReferenceOf(
  pkg: BattlefieldPackage,
  terrainModel: string | null,
): TerrainReference {
  return {
    battlefieldId: pkg.id,
    name: pkg.name,
    request: { ...pkg.request, centre: { ...pkg.request.centre } },
    crs: { epsg: pkg.frame.epsg, zone: pkg.frame.zone, hemisphere: pkg.frame.hemisphere },
    geographicBounds: pkg.geographicBounds.map((b) => ({ ...b })),
    terrainModel,
    generation: {
      importerVersion: pkg.processing.importerVersion,
      createdAt: pkg.createdAt,
      buildingSource: pkg.buildings?.source ?? (pkg.osm.available ? 'openstreetmap' : 'none'),
      overtureRelease: pkg.buildings?.overture?.release ?? null,
      treeCover: pkg.treeCover ? 'canopy' : 'off',
      osmAvailable: pkg.osm.available,
      osmTimestamp: pkg.osm.timestampOsmBase,
      elevation: {
        provider: pkg.elevation.provider,
        zoom: pkg.elevation.zoom,
        finestResolutionM: pkg.elevation.finestResolutionM,
      },
    },
  };
}

/** A new random id. */
export const newScenarioId = (): string => crypto.randomUUID();

/** Makes a document of a scenario as it is now. */
export function scenarioDocument(o: {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly modifiedAt: string;
  readonly stage: PlanningStage;
  readonly terrain: TerrainReference;
  readonly scenario: BattleScenarioDefinition;
}): ScenarioDocument {
  const name = cleanName(o.name);
  return {
    schema: SAVED_SCENARIO_SCHEMA,
    schemaVersion: SAVED_SCENARIO_SCHEMA_VERSION,
    id: o.id,
    name,
    createdAt: o.createdAt,
    modifiedAt: o.modifiedAt,
    application: {
      name: 'Ambush!',
      scenarioSchemaVersion: BATTLE_SCHEMA_VERSION,
      importerVersion: IMPORTER_VERSION,
    },
    stage: o.stage,
    terrain: o.terrain,
    scenario: {
      ...structuredClone(o.scenario),
      name,
      battlefieldId: o.terrain.battlefieldId,
    },
  };
}

/** A scenario name as stored: trimmed, inner whitespace collapsed, at most `MAX_SCENARIO_NAME` characters. */
export function cleanName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_SCENARIO_NAME);
}

/** Why a name cannot be a scenario's, or `null`. */
export function nameProblem(name: string): string | null {
  return cleanName(name) === '' ? 'A scenario needs a name.' : null;
}

/**
 * What decides whether a scenario has changed: its name, seed and squads
 * (with their positions, facings, formations and plans). Not where it is
 * stored, nor the stage it is planned in.
 */
export function editableFingerprint(d: BattleScenarioDefinition): string {
  return fingerprintPlainData({ name: d.name, seed: d.seed, squads: d.squads });
}

/** Whether a scenario that was never saved holds any work (a new one has no squads and seed 1). */
export function hasWork(d: BattleScenarioDefinition): boolean {
  return d.squads.length > 0 || d.seed !== 1;
}

/** The scenario as the battlefield's working scenario: its id and battlefield that battlefield's. */
export function workingScenario(
  doc: ScenarioDocument,
  battlefieldId: string,
  terrainModel: string | null,
): BattleScenarioDefinition {
  return {
    ...structuredClone(doc.scenario),
    id: battleScenarioId(battlefieldId),
    battlefieldId,
    name: doc.name,
    ...(terrainModel !== null ? { terrainModel } : {}),
  };
}

/** A file name for a scenario: `woodland-encounter.ambush.json`. */
export function scenarioFileName(name: string): string {
  const slug = cleanName(name)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'scenario'}${SCENARIO_FILE_EXTENSION}`;
}

/** The document as a file's text. */
export function serializeScenarioDocument(doc: ScenarioDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

// --- Reading ------------------------------------------------------------------

type Fail = (message: string) => never;
type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Refuses fields other than `allowed` (they may mean something to a newer Ambush!). */
function onlyKnown(o: Json, allowed: readonly string[], where: string, fail: Fail): void {
  const unknown = Object.keys(o).filter((k) => !allowed.includes(k));
  if (unknown.length > 0)
    fail(
      `${where} has ${unknown.length === 1 ? 'a field' : 'fields'} this version of Ambush! does not know (${unknown
        .map((k) => `"${k}"`)
        .join(', ')}); it may come from a newer version`,
    );
}

const str = (o: Json, key: string, where: string, fail: Fail, empty = false): string => {
  const v = o[key];
  if (typeof v !== 'string' || (!empty && v.trim() === ''))
    return fail(`${where}: "${key}" is missing or not text`);
  return v;
};
const num = (o: Json, key: string, where: string, fail: Fail): number => {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v))
    return fail(`${where}: "${key}" is not a number`);
  return v;
};
const time = (o: Json, key: string, where: string, fail: Fail): string => {
  const v = str(o, key, where, fail);
  if (Number.isNaN(Date.parse(v))) fail(`${where}: "${key}" is not a date and time`);
  return v;
};
const object = (o: Json, key: string, where: string, fail: Fail): Json => {
  const v = o[key];
  if (!isObject(v)) return fail(`${where}: "${key}" is missing`);
  return v;
};

const SQUAD_KEYS = [
  'id',
  'name',
  'side',
  'organization',
  'formation',
  'position',
  'facingDeg',
  'plan',
];
const ORDER_KEYS = ['kind', 'destination'];
const POINT_KEYS = ['east', 'north'];
const SCENARIO_KEYS = [
  'schema',
  'schemaVersion',
  'id',
  'battlefieldId',
  'name',
  'terrainModel',
  'seed',
  'squads',
];

/** The scenario part: refuses unknown fields, then reads it as the game does (`parseBattleScenario`). */
function readScenario(raw: unknown, fail: Fail): BattleScenarioDefinition {
  if (!isObject(raw)) return fail('"scenario" is missing');
  // Version 1 (the ambush's) has its own fields, read and migrated by `parseBattleScenario`.
  if (raw['schemaVersion'] === BATTLE_SCHEMA_VERSION)
    onlyKnown(raw, SCENARIO_KEYS, 'The scenario', fail);
  if (raw['schemaVersion'] === BATTLE_SCHEMA_VERSION && Array.isArray(raw['squads'])) {
    const squads = raw['squads'] as unknown[];
    if (squads.length > MAX_SQUADS) fail(`the scenario has more than ${String(MAX_SQUADS)} squads`);
    squads.forEach((s, i) => {
      if (!isObject(s)) return;
      const where = `Squad ${String(i + 1)}`;
      onlyKnown(s, SQUAD_KEYS, where, fail);
      if (isObject(s['position']))
        onlyKnown(s['position'], POINT_KEYS, `${where}'s position`, fail);
      if (Array.isArray(s['plan'])) {
        const plan = s['plan'] as unknown[];
        if (plan.length > MAX_ORDERS_PER_SQUAD)
          fail(`${where} has more than ${String(MAX_ORDERS_PER_SQUAD)} orders`);
        plan.forEach((o, k) => {
          if (!isObject(o)) return;
          onlyKnown(o, ORDER_KEYS, `${where}, order ${String(k + 1)}`, fail);
          if (isObject(o['destination']))
            onlyKnown(
              o['destination'],
              POINT_KEYS,
              `${where}, order ${String(k + 1)}'s destination`,
              fail,
            );
        });
      }
    });
  }
  try {
    return parseBattleScenario(raw);
  } catch (error) {
    if (error instanceof BattleScenarioError)
      return fail(error.message.replace(/^Scenario not loaded: /, '').replace(/\.$/, ''));
    throw error;
  }
}

function readTerrain(raw: unknown, fail: Fail): TerrainReference {
  if (!isObject(raw)) return fail('the terrain reference is missing');
  const where = 'The terrain reference';
  onlyKnown(
    raw,
    ['battlefieldId', 'name', 'request', 'crs', 'geographicBounds', 'terrainModel', 'generation'],
    where,
    fail,
  );
  const request = object(raw, 'request', where, fail);
  onlyKnown(
    request,
    ['centre', 'widthM', 'heightM', 'cellSizeM', 'name'],
    `${where}'s request`,
    fail,
  );
  const centre = object(request, 'centre', `${where}'s request`, fail);
  onlyKnown(centre, ['lat', 'lon'], `${where}'s centre`, fail);
  const lat = num(centre, 'lat', `${where}'s centre`, fail);
  const lon = num(centre, 'lon', `${where}'s centre`, fail);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180)
    fail(`${where}'s centre is not a position on Earth`);
  const size = (key: string) => {
    const v = num(request, key, `${where}'s request`, fail);
    if (!(v > 0)) fail(`${where}'s request: "${key}" is not positive`);
    return v;
  };
  const crs = object(raw, 'crs', where, fail);
  onlyKnown(crs, ['epsg', 'zone', 'hemisphere'], `${where}'s coordinate system`, fail);
  const hemisphere = crs['hemisphere'];
  if (hemisphere !== 'N' && hemisphere !== 'S') fail(`${where}'s hemisphere is not N or S`);
  if (!Array.isArray(raw['geographicBounds'])) fail(`${where}: "geographicBounds" is missing`);
  const bounds = (raw['geographicBounds'] as unknown[]).map((b, i) => {
    if (!isObject(b)) return fail(`${where}: geographic box ${String(i + 1)} is not a box`);
    onlyKnown(b, ['south', 'west', 'north', 'east'], `${where}'s geographic box`, fail);
    return {
      south: num(b, 'south', `${where}'s geographic box`, fail),
      west: num(b, 'west', `${where}'s geographic box`, fail),
      north: num(b, 'north', `${where}'s geographic box`, fail),
      east: num(b, 'east', `${where}'s geographic box`, fail),
    };
  });
  const model = raw['terrainModel'];
  if (model !== null && typeof model !== 'string') fail(`${where}: "terrainModel" is not text`);
  const generation = raw['generation'] === null ? null : readGeneration(raw['generation'], fail);
  const requestName = request['name'];
  if (requestName !== undefined && typeof requestName !== 'string')
    fail(`${where}'s request: "name" is not text`);
  return {
    battlefieldId: str(raw, 'battlefieldId', where, fail),
    name: str(raw, 'name', where, fail),
    request: {
      centre: { lat, lon },
      widthM: size('widthM'),
      heightM: size('heightM'),
      cellSizeM: size('cellSizeM'),
      ...(typeof requestName === 'string' ? { name: requestName } : {}),
    },
    crs: {
      epsg: num(crs, 'epsg', `${where}'s coordinate system`, fail),
      zone: num(crs, 'zone', `${where}'s coordinate system`, fail),
      hemisphere: hemisphere,
    },
    geographicBounds: bounds,
    terrainModel: typeof model === 'string' ? model : null,
    generation,
  };
}

function readGeneration(raw: unknown, fail: Fail): NonNullable<TerrainReference['generation']> {
  const where = "The terrain's generation";
  if (!isObject(raw)) return fail(`${where} is missing`);
  onlyKnown(
    raw,
    [
      'importerVersion',
      'createdAt',
      'buildingSource',
      'overtureRelease',
      'treeCover',
      'osmAvailable',
      'osmTimestamp',
      'elevation',
    ],
    where,
    fail,
  );
  const buildingSource = raw['buildingSource'];
  if (
    buildingSource !== 'overture' &&
    buildingSource !== 'openstreetmap' &&
    buildingSource !== 'none'
  )
    fail(`${where}: the building source is unknown`);
  const treeCover = raw['treeCover'];
  if (treeCover !== 'canopy' && treeCover !== 'off') fail(`${where}: the tree cover is unknown`);
  const release = raw['overtureRelease'];
  if (release !== null && typeof release !== 'string')
    fail(`${where}: "overtureRelease" is not text`);
  const osmTimestamp = raw['osmTimestamp'];
  if (osmTimestamp !== null && typeof osmTimestamp !== 'string')
    fail(`${where}: "osmTimestamp" is not text`);
  if (typeof raw['osmAvailable'] !== 'boolean')
    fail(`${where}: "osmAvailable" is not true or false`);
  const elevation = object(raw, 'elevation', where, fail);
  onlyKnown(elevation, ['provider', 'zoom', 'finestResolutionM'], `${where}'s elevation`, fail);
  const finest = elevation['finestResolutionM'];
  if (finest !== null && (typeof finest !== 'number' || !Number.isFinite(finest)))
    fail(`${where}'s elevation: "finestResolutionM" is not a number`);
  return {
    importerVersion: str(raw, 'importerVersion', where, fail),
    createdAt: time(raw, 'createdAt', where, fail),
    buildingSource: buildingSource,
    overtureRelease: typeof release === 'string' ? release : null,
    treeCover: treeCover,
    osmAvailable: raw['osmAvailable'],
    osmTimestamp: typeof osmTimestamp === 'string' ? osmTimestamp : null,
    elevation: {
      provider: str(elevation, 'provider', `${where}'s elevation`, fail),
      zoom: num(elevation, 'zoom', `${where}'s elevation`, fail),
      finestResolutionM: typeof finest === 'number' ? finest : null,
    },
  };
}

/**
 * A scenario that is not a saved-scenario document: what Ambush! exported
 * before the scenario library (a bare `ambush.scenario`, version 1 or 2),
 * migrated. It names its battlefield only by id, so it can be loaded only
 * where that battlefield is saved: it cannot be generated again.
 */
function migrateBareScenario(raw: Json, fail: Fail, now: string, id: string): ScenarioDocument {
  const scenario = readScenario(raw, fail);
  return {
    schema: SAVED_SCENARIO_SCHEMA,
    schemaVersion: SAVED_SCENARIO_SCHEMA_VERSION,
    id,
    name: cleanName(scenario.name) || 'Imported scenario',
    createdAt: now,
    modifiedAt: now,
    application: {
      name: 'Ambush!',
      scenarioSchemaVersion: BATTLE_SCHEMA_VERSION,
      importerVersion: IMPORTER_VERSION,
    },
    stage: 'scenario',
    terrain: {
      battlefieldId: scenario.battlefieldId,
      name: 'Unknown battlefield',
      request: { centre: { lat: 0, lon: 0 }, widthM: 0, heightM: 0, cellSizeM: 0 },
      crs: { epsg: 0, zone: 0, hemisphere: 'N' },
      geographicBounds: [],
      terrainModel: scenario.terrainModel ?? null,
      generation: null,
    },
    scenario,
  };
}

/** Whether a terrain reference says enough to generate its battlefield again. */
export function canRegenerate(ref: TerrainReference): boolean {
  return ref.generation !== null && ref.request.widthM > 0 && ref.request.cellSizeM > 0;
}

/**
 * Reads a saved scenario: a document of this version, or an older format
 * migrated (a bare battle scenario, version 1 or 2, as exported before the
 * library; it gets `newId()` and the time `now`). Takes the parsed JSON, or
 * the file's text. Throws a `ScenarioDocumentError` saying what is wrong;
 * nothing of a refused document is used.
 */
export function parseScenarioDocument(
  input: unknown,
  o: { readonly now?: () => Date; readonly newId?: () => string } = {},
): ScenarioDocument {
  const fail: Fail = (message) => {
    throw new ScenarioDocumentError(`This is not a scenario Ambush! can load: ${message}.`);
  };
  let data = input;
  if (typeof input === 'string') {
    if (input.length > MAX_SCENARIO_FILE_BYTES) fail('the file is too large to be a scenario');
    try {
      data = JSON.parse(input) as unknown;
    } catch (error) {
      return fail(
        `it is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  if (!isObject(data)) return fail('it does not hold a JSON object');
  const now = (o.now ?? (() => new Date()))().toISOString();
  if (data['schema'] === SCENARIO_SCHEMA)
    return migrateBareScenario(data, fail, now, (o.newId ?? newScenarioId)());
  if (data['schema'] !== SAVED_SCENARIO_SCHEMA)
    return fail(`it is not an Ambush! scenario (its schema is not "${SAVED_SCENARIO_SCHEMA}")`);
  const version = data['schemaVersion'];
  if (typeof version !== 'number' || !Number.isInteger(version))
    return fail('its schema version is missing');
  if (version > SAVED_SCENARIO_SCHEMA_VERSION)
    return fail(
      `it was saved by a newer Ambush! (scenario format version ${String(version)}; this version reads up to ${String(SAVED_SCENARIO_SCHEMA_VERSION)})`,
    );
  if (version !== SAVED_SCENARIO_SCHEMA_VERSION)
    return fail(`scenario format version ${String(version)} is not supported`);
  onlyKnown(
    data,
    [
      'schema',
      'schemaVersion',
      'id',
      'name',
      'createdAt',
      'modifiedAt',
      'application',
      'stage',
      'terrain',
      'scenario',
    ],
    'The document',
    fail,
  );
  const where = 'The document';
  const id = str(data, 'id', where, fail);
  if (id.length > 200) fail('the scenario id is too long');
  const name = cleanName(str(data, 'name', where, fail));
  if (name === '') fail('the scenario has no name');
  const application = object(data, 'application', where, fail);
  onlyKnown(
    application,
    ['name', 'scenarioSchemaVersion', 'importerVersion'],
    'The application',
    fail,
  );
  if (application['name'] !== 'Ambush!') fail('it was not made by Ambush!');
  const stage = data['stage'];
  if (stage !== 'scenario' && stage !== 'bluefor') fail('the planning stage is unknown');
  const terrain = readTerrain(data['terrain'], fail);
  const scenario = readScenario(data['scenario'], fail);
  if (scenario.battlefieldId !== terrain.battlefieldId)
    fail("the scenario's battlefield is not the one its terrain reference names");
  return {
    schema: SAVED_SCENARIO_SCHEMA,
    schemaVersion: SAVED_SCENARIO_SCHEMA_VERSION,
    id,
    name,
    createdAt: time(data, 'createdAt', where, fail),
    modifiedAt: time(data, 'modifiedAt', where, fail),
    application: {
      name: 'Ambush!',
      scenarioSchemaVersion: BATTLE_SCHEMA_VERSION,
      importerVersion: str(application, 'importerVersion', 'The application', fail),
    },
    stage: stage,
    terrain,
    scenario: { ...scenario, name },
  };
}
