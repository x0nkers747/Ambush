import { describe, expect, it } from 'vitest';
import { CancelledError, DEFAULT_SERVICES, ServiceError, type ServiceConfig } from '#acquire';
import type { BattlefieldPackage, BattlefieldRequest } from '#geo';
import { terrainModelId } from '#sim';
import { terrainReferenceOf, type TerrainReference } from './document';
import {
  regenerationSettings,
  resolveTerrain,
  TerrainUnavailableError,
  type TerrainSources,
} from './terrain';
import { testBattlefield, testRequest } from './test-fixtures';

// Finding a saved scenario's battlefield (docs/scenarios.md): open, saved,
// or generated again, and never another battlefield taken for it.

const field = testBattlefield();
const ref = terrainReferenceOf(field, terrainModelId(field.terrain));

interface Calls {
  generated: { request: BattlefieldRequest; config: ServiceConfig; allowMissingOsm: boolean }[];
}

function sources(o: {
  open?: string | null;
  saved?: readonly string[];
  /** What generating gives: the battlefield, or an error thrown. */
  generates?: (request: BattlefieldRequest) => BattlefieldPackage;
}): TerrainSources & { calls: Calls } {
  const calls: Calls = { generated: [] };
  return {
    calls,
    config: DEFAULT_SERVICES,
    openId: () => o.open ?? null,
    isSaved: (id) => Promise.resolve((o.saved ?? []).includes(id)),
    generate: (request, config, allowMissingOsm) => {
      calls.generated.push({ request, config, allowMissingOsm });
      return o.generates
        ? Promise.resolve().then(() =>
            (o.generates as (r: BattlefieldRequest) => BattlefieldPackage)(request),
          )
        : Promise.reject(new Error('no generator'));
    },
  };
}

describe('finding a scenario’s battlefield', () => {
  it('uses the battlefield open now', async () => {
    const s = sources({ open: field.id, saved: [field.id] });
    expect(await resolveTerrain(ref, s)).toEqual({ kind: 'open', battlefieldId: field.id });
    expect(s.calls.generated).toEqual([]);
  });

  it('uses the one saved in this browser', async () => {
    const s = sources({ open: 'another', saved: ['x', field.id] });
    expect(await resolveTerrain(ref, s)).toEqual({ kind: 'saved', battlefieldId: field.id });
    expect(s.calls.generated).toEqual([]);
  });

  it('generates a missing battlefield again from its request and settings: the same ground is the same battlefield', async () => {
    const s = sources({ generates: (request) => testBattlefield(request) });
    expect(await resolveTerrain(ref, s)).toEqual({
      kind: 'regenerated',
      battlefieldId: field.id,
      identical: true,
      name: field.name,
    });
    const [call] = s.calls.generated;
    expect(call?.request).toEqual(field.request);
    // Terrain only when it was made: OpenStreetMap may be missing; no canopy; buildings from OSM.
    expect(call?.allowMissingOsm).toBe(true);
    expect(call?.config.treeCover).toBe('off');
    expect(call?.config.buildingSource).toBe('openstreetmap');
  });

  it('says so when the source data has changed: another battlefield, not taken for the scenario’s', async () => {
    const s = sources({ generates: (request) => testBattlefield(request, 0.07) });
    const result = await resolveTerrain(ref, s);
    expect(result).toMatchObject({ kind: 'regenerated', identical: false });
    expect(result.battlefieldId).not.toBe(field.id);
  });

  it('matching coordinates prove nothing: another saved battlefield at the same place is not used', async () => {
    const samePlace = testBattlefield(testRequest(), 0.09);
    const s = sources({ saved: [samePlace.id], generates: (request) => testBattlefield(request) });
    expect(await resolveTerrain(ref, s)).toMatchObject({ kind: 'regenerated', identical: true });
  });

  it('fails, saying it may work later, when generating fails', async () => {
    const s = sources({
      generates: () => {
        throw new ServiceError(
          'Elevation tiles (AWS Terrain Tiles)',
          'The service did not answer.',
        );
      },
    });
    const error = await resolveTerrain(ref, s).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TerrainUnavailableError);
    expect((error as TerrainUnavailableError).retry).toBe(true);
    expect((error as Error).message).toMatch(/could not be generated again: .*did not answer/);
  });

  it('passes a cancellation on', async () => {
    const s = sources({
      generates: () => {
        throw new CancelledError();
      },
    });
    await expect(resolveTerrain(ref, s)).rejects.toBeInstanceOf(CancelledError);
  });

  it('cannot generate a battlefield named by id only (an old export), and says so', async () => {
    const bare: TerrainReference = {
      ...ref,
      request: { centre: { lat: 0, lon: 0 }, widthM: 0, heightM: 0, cellSizeM: 0 },
      generation: null,
    };
    const error = await resolveTerrain(bare, sources({})).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TerrainUnavailableError);
    expect((error as TerrainUnavailableError).retry).toBe(false);
  });
});

describe('generating a battlefield again', () => {
  it('uses the building source, Overture release and tree cover it was made with', () => {
    const generation = ref.generation;
    if (!generation) throw new Error('no generation');
    const overture: TerrainReference = {
      ...ref,
      generation: {
        ...generation,
        buildingSource: 'overture',
        overtureRelease: '2026-09-23.1',
        treeCover: 'canopy',
        osmAvailable: true,
      },
    };
    const base = {
      ...DEFAULT_SERVICES,
      buildingSource: 'openstreetmap' as const,
      treeCover: 'off' as const,
    };
    expect(regenerationSettings(base, overture)).toEqual({
      config: {
        ...base,
        buildingSource: 'overture',
        overtureRelease: '2026-09-23.1',
        treeCover: 'canopy',
      },
      allowMissingOsm: false,
    });
  });
});
