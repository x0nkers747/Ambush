// Makes a bundled battlefield (docs/bundled-battlefields.md): the file in
// `public/battlefields/` that a first visit stores, so the battlefield is
// there without generating it. Its input is a battlefield package as JSON
// (from `tools/record-battlefield.ts`, or exported from a browser's saved
// battlefields with its typed arrays encoded as the bundle encodes them);
// with `--prepared`, its terrain is also prepared here exactly as the game
// prepares it (DEM cleaning, then the terrain field) and bundled, under the
// current `TERRAIN_MODEL` (tens of megabytes for 5 km: the game prepares it on
// the first opening instead, and keeps it).
//
//   npx tsx tools/bundle-battlefield.ts [--prepared] <package.json> public/battlefields/<name>.ambush-battlefield.gz
//
// Run it again whenever the importer changes: the test
// `src/app/bundled-battlefields.test.ts` fails while a bundle is out of date.

import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { cleanTerrain, gradeTerrain, TERRAIN_MODEL } from '#sim';
import {
  BUNDLE_SCHEMA,
  BUNDLE_VERSION,
  decodeTypedJson,
  encodeBundle,
  parseBattlefieldPackage,
} from '#geo';

const args = process.argv.slice(2);
const withPrepared = args.includes('--prepared');
const [input, output] = args.filter((a) => a !== '--prepared');
if (!input || !output) {
  console.error(
    'usage: npx tsx tools/bundle-battlefield.ts <package.json> <out.ambush-battlefield.gz>',
  );
  process.exit(1);
}
const pkg = parseBattlefieldPackage(decodeTypedJson(readFileSync(input, 'utf8')));
const t0 = performance.now();
const prepare = () => {
  const { terrain, report } = cleanTerrain(pkg.terrain, pkg.elevation.cleaning ?? null);
  return { terrain: gradeTerrain(terrain), quality: report };
};
const text = encodeBundle({
  schema: BUNDLE_SCHEMA,
  version: BUNDLE_VERSION,
  terrainModel: TERRAIN_MODEL,
  package: pkg,
  ...(withPrepared ? { prepared: prepare() } : {}),
});
const gz = gzipSync(text, { level: 9 });
writeFileSync(output, gz);
console.log(
  `${pkg.name} (${pkg.id}): ${withPrepared ? `prepared in ${String(Math.round(performance.now() - t0))} ms, ` : ''}` +
    `${(text.length / 1e6).toFixed(1)} MB JSON, ${(gz.length / 1e6).toFixed(2)} MB gzipped, model ${TERRAIN_MODEL}`,
);
