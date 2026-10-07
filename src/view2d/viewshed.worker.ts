import { computeViewshedRows, type TerrainDataset, type Vec2, type ViewshedGrid } from '#sim';

// Viewshed worker: computes bands of viewshed rows off the main thread with
// the simulation's own sight-line code (see viewshed-service.ts).

export type WorkerRequest =
  | { readonly type: 'terrain'; readonly terrain: TerrainDataset }
  | {
      readonly type: 'rows';
      readonly jobId: number;
      readonly observer: Vec2;
      readonly grid: ViewshedGrid;
      readonly rowStart: number;
      readonly rowEnd: number;
    };

export interface WorkerReply {
  readonly jobId: number;
  readonly rowStart: number;
  readonly rowEnd: number;
  readonly data: Uint8Array;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerReply, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
let terrain: TerrainDataset | null = null;

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === 'terrain') {
    terrain = message.terrain;
    return;
  }
  if (!terrain) return;
  const data = computeViewshedRows(
    terrain,
    message.observer,
    message.grid,
    message.rowStart,
    message.rowEnd,
  );
  scope.postMessage(
    { jobId: message.jobId, rowStart: message.rowStart, rowEnd: message.rowEnd, data },
    [data.buffer],
  );
};
