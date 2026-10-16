import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeBundle, IMPORTER_VERSION } from '#geo';
import { TERRAIN_MODEL } from '#sim';

// The battlefields bundled with the game (docs/bundled-battlefields.md) are
// whole and current: their packages match their ids and were built by this
// importer. When the importer changes, this fails until they are bundled
// again (`tools/bundle-battlefield.ts`).

const ROOT = join(import.meta.dirname, '..');
const FILES = ['battlefields/quantico.ambush-battlefield.gz'];

describe('bundled battlefields', () => {
  it.each(FILES)(
    '%s is a whole package of the current importer',
    (file) => {
      const bundle = decodeBundle(
        gunzipSync(readFileSync(join(ROOT, 'public', file))).toString('utf8'),
      );
      expect(bundle.package.processing.importerVersion).toBe(IMPORTER_VERSION);
      expect(bundle.package.name).toMatch(/Quantico/);
      if (bundle.prepared) expect(bundle.terrainModel).toBe(TERRAIN_MODEL);
    },
    60_000,
  );
});
