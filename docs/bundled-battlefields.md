# Bundled battlefields and prepared terrain

The game comes with a battlefield: on a first visit, Quantico (Prince William
County, Virginia, 5 × 5 km) is in the saved battlefields already, selected,
and its map shown. Generating a battlefield is optional. No scenario comes
with it: the player sets one up.

## 1. What a first visit does

On start-up (`src/app/main.ts`), `seedBundledBattlefields`
(`src/app/bundled-battlefields.ts`) fetches each bundled battlefield not yet
seeded in this browser from `public/battlefields/` and stores its package
like a generated one, without the downloaded sources it was built from. The
terrain selection then opens on it. Each battlefield is seeded once per
browser (remembered in `localStorage`): one the player deletes is not brought
back. One already saved (the same package id) is left as it is. A file that
cannot be fetched or read is tried again on the next visit.

Terrain selection opens on the battlefield just seeded; on later visits, on
the battlefield last looked at, else the newest saved.

## 2. Prepared terrain is kept

Before it is played, a battlefield's stored terrain is prepared: its DEM
cleaned (docs/adr/0033) and the terrain field sampled (docs/adr/0049), about
6 s for a 5 km battlefield. This used to happen on every page load. Now the
prepared terrain is saved in the browser's store (`preparedTerrain`, keyed by
battlefield, with the terrain model that made it) the first time, and read
back after: Quantico opens in about 0.4 s on later visits instead of 6 s. This
holds for every battlefield, generated or bundled. A prepared terrain made by
another terrain model (after an update that changes the rules) is not used:
the battlefield is prepared again once and saved. Deleting a battlefield
deletes its prepared terrain.

## 3. The file

`public/battlefields/quantico.ambush-battlefield.gz` (about 1 MB): gzipped
JSON (`#geo`'s bundle format, `src/geo/bundle.ts`) holding the battlefield
package. Typed arrays are encoded, and −0, NaN and ±∞ are kept, so the
decoded package matches its content id exactly. The format can also carry the
prepared terrain, but a 5 km battlefield's is about 45 MB of refined samples
that barely compress: it is prepared on the first opening instead.

The file is made by `tools/bundle-battlefield.ts` from a battlefield package
as JSON (from `tools/record-battlefield.ts`, or exported from a browser's
saved battlefields):

    npx tsx tools/bundle-battlefield.ts <package.json> public/battlefields/quantico.ambush-battlefield.gz

`tools/bundled-battlefields.test.ts` checks that each bundled package is whole
and built by the current importer (`IMPORTER_VERSION`): after an importer
change it fails until the battlefield is recorded and bundled again.

## 4. Code and tests

- `src/geo/bundle.ts`: the file format.
- `src/acquire/store.ts`: `getPrepared` / `putPrepared` (database version 4).
- `src/app/terrain-grading.ts`: `authoritativeTerrain` with its cache.
- `src/app/bundled-battlefields.ts`: seeding.
- `src/app/bundled-battlefields.test.ts`: the format, seeding once (not again
  once deleted), prepared terrain saved, read back and deleted.
