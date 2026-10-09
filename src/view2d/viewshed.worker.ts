import {
  computeViewshedRows,
  prepareViewsheds,
  viewshedGrid,
  type TerrainDataset,
  type Vec2,
  type ViewshedGrid,
} from '#sim';

// Viewshed worker: computes bands of viewshed rows off the main thread with
// the simulation's own visibility code (see viewshed-service.ts).

export type WorkerRequest =
  | { readonly type: 'terrain'; readonly terrain: TerrainDataset }
  | {
      readonly type: 'rows';
      readonly jobId: number;
      readonly observer: Vec2;
      readonly grid: ViewshedGrid;
      readonly rowStart: number;
      readonly rowEnd: number;
      /** Every `rowStep`th row from `rowStart`. */
      readonly rowStep: number;
    };

export type WorkerReply =
  | {
      readonly type: 'ready';
      /** Milliseconds spent preparing the terrain's visibility index. */
      readonly prepareMs: number;
    }
  | {
      readonly type: 'rows';
      readonly jobId: number;
      readonly rowStart: number;
      readonly rowEnd: number;
      readonly rowStep: number;
      /** The rows computed, packed in order. */
      readonly data: Uint8Array;
      /** Milliseconds spent computing the rows. */
      readonly computeMs: number;
    };

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerReply, transfer?: Transferable[]): void;
}

/** Cell size of the warm-up viewshed: about 24,000 cells on a 5 km battlefield. */
const WARM_UP_CELL_M = 32;

const scope = self as unknown as WorkerScope;
let terrain: TerrainDataset | null = null;

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === 'terrain') {
    terrain = message.terrain;
    // Build the index now, so that the first viewshed does not wait for it.
    const started = performance.now();
    prepareViewsheds(terrain);
    // A small viewshed warms the compiler up, so the first real one runs at full speed.
    const coarse = viewshedGrid(terrain, WARM_UP_CELL_M);
    const { originX, originY, cellSize, columns, rows } = terrain.heightfield;
    const centre = {
      x: originX + ((columns - 1) * cellSize) / 2,
      y: originY + ((rows - 1) * cellSize) / 2,
    };
    computeViewshedRows(terrain, centre, coarse, 0, coarse.rows);
    scope.postMessage({ type: 'ready', prepareMs: performance.now() - started });
    return;
  }
  if (!terrain) return;
  const started = performance.now();
  const data = computeViewshedRows(
    terrain,
    message.observer,
    message.grid,
    message.rowStart,
    message.rowEnd,
    {},
    message.rowStep,
  );
  scope.postMessage(
    {
      type: 'rows',
      jobId: message.jobId,
      rowStart: message.rowStart,
      rowEnd: message.rowEnd,
      rowStep: message.rowStep,
      data,
      computeMs: performance.now() - started,
    },
    [data.buffer],
  );
};
