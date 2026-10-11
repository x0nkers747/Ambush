import { describe, expect, it } from 'vitest';
import { DEMO_SCENARIO } from '#exercise';
import { bakeGroundMap } from './ground-map';
import {
  bakeGround,
  battlefieldBuffers,
  createGenerator,
  generateBattlefield,
  GenerationCancelled,
  type GenerationReply,
  type GenerationRequest,
  type GenerationWorker,
} from './generation';

/** Whether two byte arrays hold the same bytes. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// Generating features and vegetation off the main thread (docs/adr/0031):
// the latest job wins, cancelled jobs end, stale replies are ignored.

const terrain = DEMO_SCENARIO.terrain;

/** A stand-in worker the test answers by hand. */
class FakeWorker implements GenerationWorker {
  onmessage: ((event: { readonly data: GenerationReply }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: GenerationRequest[] = [];
  terminated = false;
  postMessage(message: GenerationRequest): void {
    this.sent.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(data: GenerationReply): void {
    this.onmessage?.({ data });
  }
}

function fakes() {
  const workers: FakeWorker[] = [];
  const generator = createGenerator({
    createWorker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
  });
  return { workers, generator };
}

const result = generateBattlefield(terrain);

describe('createGenerator', () => {
  it('sends the terrain to a worker and resolves with its result, reporting progress', async () => {
    const { workers, generator } = fakes();
    const stages: string[] = [];
    const job = generator.start(terrain, (s) => stages.push(s));
    const w = workers[0];
    expect(w?.sent[0]).toMatchObject({ type: 'generate', jobId: job.id, terrain });
    w?.reply({ type: 'progress', jobId: job.id, stage: 'vegetation' });
    w?.reply({ type: 'done', jobId: job.id, result });
    await expect(job.result).resolves.toBe(result);
    expect(stages).toEqual(['vegetation']);
    expect(w?.terminated).toBe(true);
  });

  it('cancels a job: its worker stops and its promise rejects', async () => {
    const { workers, generator } = fakes();
    const job = generator.start(terrain);
    job.cancel();
    await expect(job.result).rejects.toBeInstanceOf(GenerationCancelled);
    expect(workers[0]?.terminated).toBe(true);
  });

  it('a new job cancels the previous one, and stale replies are ignored', async () => {
    const { workers, generator } = fakes();
    const first = generator.start(terrain);
    const second = generator.start(terrain);
    await expect(first.result).rejects.toBeInstanceOf(GenerationCancelled);
    expect(workers[0]?.terminated).toBe(true);
    // A late reply from the first worker, or one for another job, changes nothing.
    workers[0]?.reply({ type: 'done', jobId: first.id, result });
    workers[1]?.reply({ type: 'done', jobId: first.id, result });
    let settled = false;
    void second.result.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    workers[1]?.reply({ type: 'done', jobId: second.id, result });
    await expect(second.result).resolves.toBe(result);
  });

  it('reports worker errors', async () => {
    const { workers, generator } = fakes();
    const job = generator.start(terrain);
    workers[0]?.reply({ type: 'error', jobId: job.id, message: 'boom' });
    await expect(job.result).rejects.toThrow('boom');
  });

  it('works on this thread without workers, with the same result', async () => {
    const generator = createGenerator({ createWorker: () => null });
    const g = await generator.start(terrain).result;
    expect(Array.from(g.vegetation.instances.position)).toEqual(
      Array.from(result.vegetation.instances.position),
    );
    expect(Array.from(g.features.buildings.positions)).toEqual(
      Array.from(result.features.buildings.positions),
    );
    const cancelled = generator.start(terrain);
    generator.dispose();
    await expect(cancelled.result).rejects.toBeInstanceOf(GenerationCancelled);
  });

  it('lists every typed array for transfer, once', () => {
    const buffers = battlefieldBuffers(result);
    expect(new Set(buffers).size).toBe(buffers.length);
    expect(buffers).toContain(result.vegetation.instances.position.buffer);
    expect(buffers).toContain(result.features.buildings.positions.buffer);
    // The result survives structured cloning (what postMessage does).
    const clone = structuredClone(result);
    expect(clone.vegetation.instances.count).toBe(result.vegetation.instances.count);
  });

  it('bakes the ground map in its own worker, alongside the features', async () => {
    const { workers, generator } = fakes();
    const job = generator.start(terrain);
    const ground = generator.ground(terrain);
    // Two workers: starting the bake does not cancel the features, nor the reverse.
    expect(workers).toHaveLength(2);
    expect(workers[1]?.sent[0]).toMatchObject({ type: 'ground', jobId: ground.id, terrain });
    const baked = bakeGround(terrain);
    workers[1]?.reply({ type: 'ground', jobId: ground.id, result: baked });
    await expect(ground.result).resolves.toBe(baked);
    workers[0]?.reply({ type: 'done', jobId: job.id, result });
    await expect(job.result).resolves.toBe(result);
    // A new bake cancels the previous one only.
    const next = generator.ground(terrain);
    const again = generator.ground(terrain);
    await expect(next.result).rejects.toBeInstanceOf(GenerationCancelled);
    generator.dispose();
    await expect(again.result).rejects.toBeInstanceOf(GenerationCancelled);
  });

  it('bakes the same map on this thread', async () => {
    const generator = createGenerator({ createWorker: () => null });
    const baked = await generator.ground(terrain).result;
    expect(sameBytes(baked.map.weights0, bakeGroundMap(terrain).weights0)).toBe(true);
    expect(baked.ms).toBeGreaterThanOrEqual(0);
  });
});
