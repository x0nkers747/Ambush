import {
  cleanTerrain,
  compileField,
  DEFAULT_FIELD_SPEC,
  groundBand,
  groundDecks,
  type DemQualityReport,
  type FieldInput,
  type GroundBand,
  type SourceCorrections,
  type TerrainDataset,
  type TerrainDeck,
  waterLevels,
  type WaterSurfaces,
} from '#sim';

// Prepares a battlefield's authoritative ground off the main thread
// (docs/adr/0033, docs/adr/0049), in two kinds of job: cleaning the raw DEM
// and finding the water levels (one worker), then sampling the terrain field
// over bands of grid rows (a pool of workers, as the field takes tens of
// seconds of work on one thread for a 5 km battlefield).

export type TerrainJob =
  | {
      readonly kind: 'clean';
      readonly source: TerrainDataset;
      readonly corrections: SourceCorrections | null;
    }
  | {
      readonly kind: 'bands';
      readonly input: FieldInput;
      readonly bands: readonly (readonly [number, number])[];
      /** Whether to send the bridges' decks too (one worker does). */
      readonly decks: boolean;
    };

export type TerrainJobResult =
  | {
      readonly kind: 'clean';
      readonly terrain: TerrainDataset;
      readonly water: WaterSurfaces | null;
      readonly quality: DemQualityReport;
    }
  | {
      readonly kind: 'bands';
      readonly bands: readonly GroundBand[];
      readonly decks: readonly TerrainDeck[];
    }
  | { readonly kind: 'error'; readonly error: string };

interface WorkerScope {
  onmessage: ((event: MessageEvent<TerrainJob>) => void) | null;
  postMessage(message: TerrainJobResult, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = ({ data }) => {
  try {
    if (data.kind === 'clean') {
      const { terrain, report } = cleanTerrain(data.source, data.corrections);
      scope.postMessage({ kind: 'clean', terrain, water: waterLevels(terrain), quality: report });
      return;
    }
    const field = compileField(data.input, DEFAULT_FIELD_SPEC);
    const bands = data.bands.map(([r0, r1]) => groundBand(field, data.input.heightfield, r0, r1));
    scope.postMessage(
      { kind: 'bands', bands, decks: data.decks ? groundDecks(field) : [] },
      bands.flatMap((b) => [b.nodes.buffer, b.cells.buffer, b.samples.buffer]),
    );
  } catch (error) {
    scope.postMessage({
      kind: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
