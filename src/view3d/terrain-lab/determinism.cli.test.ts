import { describe, expect, it } from 'vitest';
import { hashPackageData, type HashablePackage } from './determinism';

// Terrain lab tile hashes in Node, for comparison with browsers (the same
// function the lab page exposes as `terrainLabHash`). Skipped unless asked for:
//
//   AMBUSH_LAB_HASH_FILE=<battlefield package.json>
//   AMBUSH_LAB_HASH_TILES="level,tx,ty;…" [AMBUSH_LAB_HASH_SPACING=0.5]
//   npx vitest run src/view3d/terrain-lab/determinism.cli.test.ts

const env =
  (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process
    ?.env ?? {};
const file = env['AMBUSH_LAB_HASH_FILE'];

interface NodeFs {
  readFileSync(path: string, encoding: 'utf8'): string;
}

describe.skipIf(file === undefined)('terrain lab tile hashes in Node', () => {
  it('hashes', { timeout: 600_000 }, async () => {
    const tiles = (env['AMBUSH_LAB_HASH_TILES'] ?? '')
      .split(';')
      .filter(Boolean)
      .map((t) => t.split(',').map(Number) as [number, number, number]);
    const nodeFs = 'node:fs';
    const fs = (await import(/* @vite-ignore */ nodeFs)) as unknown as NodeFs;
    const pkg = JSON.parse(fs.readFileSync(file ?? '', 'utf8')) as HashablePackage;
    const hashes = hashPackageData(pkg, tiles, Number(env['AMBUSH_LAB_HASH_SPACING'] ?? '0.5'));
    console.log(`HASHES ${JSON.stringify(hashes)}`);
    expect(hashes).toHaveLength(tiles.length);
  });
});
