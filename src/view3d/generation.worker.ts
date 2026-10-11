import {
  battlefieldBuffers,
  generateBattlefield,
  type GenerationReply,
  type GenerationRequest,
} from './generation';

// The 3D generation worker (docs/adr/0031): runs the pure feature and
// vegetation generators for one terrain and transfers the typed arrays back.
// One worker per job; the main thread terminates it to cancel.

interface WorkerScope {
  onmessage: ((event: MessageEvent<GenerationRequest>) => void) | null;
  postMessage(message: GenerationReply, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = ({ data }) => {
  const { jobId, terrain } = data;
  try {
    const result = generateBattlefield(terrain, (stage) => {
      scope.postMessage({ type: 'progress', jobId, stage });
    });
    scope.postMessage({ type: 'done', jobId, result }, battlefieldBuffers(result));
  } catch (error) {
    scope.postMessage({
      type: 'error',
      jobId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
