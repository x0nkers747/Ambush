import { isCancelled, type GenerationProgress, type ServiceConfig } from '#acquire';
import { battlefieldRequest, type BattlefieldPackage } from '#geo';
import { canRegenerate, type TerrainReference } from './document';

// Finding a saved scenario's battlefield (docs/scenarios.md): the one open
// now, else the one saved in this browser, else the same battlefield
// generated again from the reference's request and settings. A battlefield
// is the one referred to only when its id (the fingerprint of its request
// and terrain) is the reference's: one generated again from changed source
// data is another battlefield, and is never taken for it silently.

export type TerrainResolution =
  /** The battlefield open now. */
  | { readonly kind: 'open'; readonly battlefieldId: string }
  /** Saved in this browser. */
  | { readonly kind: 'saved'; readonly battlefieldId: string }
  /**
   * Generated again (and now saved). `identical`: it is the battlefield
   * referred to; otherwise its source data has changed, and it is another
   * battlefield (`battlefieldId`), which the user must accept.
   */
  | {
      readonly kind: 'regenerated';
      readonly battlefieldId: string;
      readonly identical: boolean;
      readonly name: string;
    };

/** The battlefield cannot be found or generated. `retry`: trying again may work (a service failed). */
export class TerrainUnavailableError extends Error {
  override name = 'TerrainUnavailableError';
  readonly retry: boolean;
  constructor(message: string, retry: boolean) {
    super(message);
    this.retry = retry;
  }
}

export interface TerrainSources {
  /** The id of the battlefield open now, if any. */
  readonly openId: () => string | null;
  /** Whether battlefield `id` is saved and readable; throws only for a storage failure. */
  readonly isSaved: (id: string) => Promise<boolean>;
  /** Generates a battlefield (and saves it), with the settings given. */
  readonly generate: (
    request: TerrainReference['request'],
    config: ServiceConfig,
    allowMissingOsm: boolean,
    onProgress: (p: GenerationProgress) => void,
    signal: AbortSignal | undefined,
  ) => Promise<BattlefieldPackage>;
  /** The service settings generation starts from. */
  readonly config: ServiceConfig;
}

/** The settings that generate the referred battlefield again: its building source, Overture release and tree cover. */
export function regenerationSettings(
  base: ServiceConfig,
  ref: TerrainReference,
): { readonly config: ServiceConfig; readonly allowMissingOsm: boolean } {
  const g = ref.generation;
  if (!g) return { config: base, allowMissingOsm: false };
  return {
    config: {
      ...base,
      buildingSource: g.buildingSource === 'overture' ? 'overture' : 'openstreetmap',
      overtureRelease: g.overtureRelease ?? base.overtureRelease,
      treeCover: g.treeCover,
    },
    allowMissingOsm: !g.osmAvailable,
  };
}

/**
 * Finds the battlefield `ref` refers to (see `TerrainResolution`). Throws a
 * `TerrainUnavailableError` when it is neither open nor saved and cannot be
 * generated again, or generating it failed.
 */
export async function resolveTerrain(
  ref: TerrainReference,
  sources: TerrainSources,
  o: {
    readonly onProgress?: (p: GenerationProgress) => void;
    readonly signal?: AbortSignal;
  } = {},
): Promise<TerrainResolution> {
  const id = ref.battlefieldId;
  if (sources.openId() === id) return { kind: 'open', battlefieldId: id };
  if (await sources.isSaved(id)) return { kind: 'saved', battlefieldId: id };
  if (!canRegenerate(ref))
    throw new TerrainUnavailableError(
      `The battlefield this scenario was made on (${ref.name}) is not saved in this browser, and the scenario does not say how to generate it again. Open the browser it was made in, or ask for a newer export of it.`,
      false,
    );
  let request: TerrainReference['request'];
  try {
    request = battlefieldRequest(ref.request.centre, {
      widthM: ref.request.widthM,
      heightM: ref.request.heightM,
      cellSizeM: ref.request.cellSizeM,
      ...(ref.request.name !== undefined ? { name: ref.request.name } : {}),
    });
  } catch (error) {
    throw new TerrainUnavailableError(
      `The battlefield's position cannot be generated: ${error instanceof Error ? error.message : String(error)}`,
      false,
    );
  }
  const { config, allowMissingOsm } = regenerationSettings(sources.config, ref);
  let pkg: BattlefieldPackage;
  try {
    pkg = await sources.generate(
      request,
      config,
      allowMissingOsm,
      o.onProgress ?? (() => undefined),
      o.signal,
    );
  } catch (error) {
    if (isCancelled(error)) throw error;
    throw new TerrainUnavailableError(
      `The battlefield ${ref.name} could not be generated again: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
  return { kind: 'regenerated', battlefieldId: pkg.id, identical: pkg.id === id, name: pkg.name };
}
