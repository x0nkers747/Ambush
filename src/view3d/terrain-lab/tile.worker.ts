import { compileField, generateTile, type TerrainField } from '#sim/terrain-lab';
import type { TileReply, TileRequest } from './tile-pool';

// A terrain lab tile worker: compiles the field once from the same inputs as
// every other worker (the field is a pure function, so each makes the same
// tiles), then generates tiles on request and transfers them back.

interface WorkerScope {
  onmessage: ((event: MessageEvent<TileRequest>) => void) | null;
  postMessage(message: TileReply, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
let field: TerrainField | null = null;
let spacing = 0.5;
const clock = () => performance.now();

scope.onmessage = ({ data }) => {
  try {
    if (data.type === 'init') {
      const started = clock();
      field = compileField(data.input, data.spec, clock);
      spacing = data.spacing;
      scope.postMessage({ type: 'ready', ms: clock() - started });
      return;
    }
    if (!field) throw new Error('tile worker: not initialised');
    const t = generateTile(
      field,
      spacing,
      field.bounds.minX,
      field.bounds.minY,
      data.level,
      data.tx,
      data.ty,
      clock,
    );
    scope.postMessage({ type: 'tile', id: data.id, tile: t }, [
      t.heights.buffer,
      t.material.buffer,
      t.blockMax.buffer,
    ]);
  } catch (error) {
    scope.postMessage({
      type: 'error',
      id: data.type === 'tile' ? data.id : -1,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
