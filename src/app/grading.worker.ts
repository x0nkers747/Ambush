import { gradeTerrain, type TerrainDataset } from '#sim';

// Grades a battlefield's terrain off the main thread (docs/adr/0032): a few
// seconds of work for a 5 km battlefield, done before anything uses it.

interface WorkerScope {
  onmessage: ((event: MessageEvent<TerrainDataset>) => void) | null;
  postMessage(message: { terrain: TerrainDataset } | { error: string }): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = ({ data }) => {
  try {
    scope.postMessage({ terrain: gradeTerrain(data) });
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
