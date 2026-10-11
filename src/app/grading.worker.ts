import {
  cleanTerrain,
  gradeTerrain,
  type DemQualityReport,
  type SourceCorrections,
  type TerrainDataset,
} from '#sim';

// Prepares a battlefield's authoritative terrain off the main thread
// (docs/adr/0032, docs/adr/0033): the raw DEM cleaned of faulty elevations,
// then graded. A few seconds of work for a 5 km battlefield, timed per step.

export interface TerrainJob {
  readonly source: TerrainDataset;
  readonly corrections: SourceCorrections | null;
}

export type TerrainJobResult =
  | {
      readonly terrain: TerrainDataset;
      readonly quality: DemQualityReport;
      readonly cleanMs: number;
      readonly gradeMs: number;
    }
  | { readonly error: string };

interface WorkerScope {
  onmessage: ((event: MessageEvent<TerrainJob>) => void) | null;
  postMessage(message: TerrainJobResult): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = ({ data }) => {
  try {
    const t0 = performance.now();
    const { terrain: clean, report } = cleanTerrain(data.source, data.corrections);
    const t1 = performance.now();
    const terrain = gradeTerrain(clean);
    const t2 = performance.now();
    scope.postMessage({ terrain, quality: report, cleanMs: t1 - t0, gradeMs: t2 - t1 });
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
