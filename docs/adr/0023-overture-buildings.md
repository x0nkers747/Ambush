# ADR 0023: Buildings from Overture Maps

- Status: Accepted
- Date: 2026-10-10
- Amends ADR 0014 (real-world terrain import): buildings now come from Overture Maps, with
  OpenStreetMap as the fallback. Everything else still comes from OpenStreetMap.

## Context

Generated battlefields took their buildings from OpenStreetMap through the Overpass API (ADR
0014). OSM is excellent where it is well mapped and poor where it is not. Building counts for the
same 5 × 5 km battlefield (OSM is the live OSM API, Overture is release 2026-09-23.1):

| Battlefield    | OSM   | Overture | Extra buildings in Overture                                |
| -------------- | ----- | -------- | ---------------------------------------------------------- |
| Grafenwöhr, DE | 3,607 | 3,604    | none                                                       |
| Quantico, VA   | 1,419 | 1,550    | 131 machine-learned (Microsoft)                            |
| Alachua, FL    | 234   | 2,697    | 1,944 Esri Community Maps, 519 machine-learned (Microsoft) |

(Counted by footprint centre in the battlefield plus a 100 m margin.) Where OSM lacks buildings,
the battlefield shows open ground where houses stand: soldiers walk and see through them.

Overture Maps combines OSM with machine-learned and community footprints. Every OSM building we
checked was in Overture, apart from differences between snapshot dates. It publishes each release
as one PMTiles archive per theme: about 180 GB for buildings, on a public bucket that serves
HTTP range requests to browsers (`Access-Control-Allow-Origin: *`, `Range` allowed). Google Maps
and similar commercial maps were ruled out: their terms forbid extracting geometry, storing it
and using it offline.

## Decision

### Source and fallback

Generation (`#acquire`) asks Overture first, then Overpass:

1. **Overture.** The newest release is found by listing the tiles folder. The release can be
   pinned with the `overtureRelease` setting. The building tiles covering the battlefield plus
   100 m are read from that release's `buildings.pmtiles` by byte ranges: header and root
   directory, any leaf directories, then each tile.
2. **Overpass, without buildings** when Overture succeeded (`osmQueryWithoutBuildings`). The OSM
   importer then ignores building elements (`featuresFromOsm(…, { buildings: false })`).
3. **Fallback.** When Overture fails in any way (unreachable, no release, a damaged or unexpected
   archive), the Overpass query includes buildings, as before. The battlefield records why:
   "Buildings are from OpenStreetMap: Overture Maps could not be used (…)". Cancelling cancels
   both.

The `buildingSource` setting (`"overture"` by default, or `"openstreetmap"`) can switch Overture
off. If OSM itself fails and the player continues without it, the battlefield keeps Overture's
buildings: terrain and buildings, no roads, vegetation or water.

A server that ignores the range header would send the whole archive. It is refused: anything but
`206 Partial Content` fails the read, and the generation falls back to OSM buildings.

### Reading the tiles

No new dependencies. Two small pure modules in `#geo`:

- **`pmtiles.ts`:** the version 3 header, the varint-encoded directories, run lengths and leaf
  directories, and Hilbert tile ids. The ids were checked against the reference implementation
  on 34,000 tiles at zooms 0–26.
- **`mvt.ts`:** Mapbox Vector Tile 2.1 decoding: layers, properties and integer geometry. It
  matched `@mapbox/vector-tile` on all 10,831 features of 44 real tiles.

Gzip is decompressed with the platform's `DecompressionStream`; other compressions are refused.

### Buildings from tiles (`overture.ts`)

The `building` layer is read at zoom 14, Overture's most detailed. A tile unit there is about
0.4 m, against a 2 m navigation grid.

- **Clipping to the tile.** Vector tiles cut buildings at tile edges and repeat their parts in
  each tile's buffer. Each piece is clipped exactly to its own tile, in global integer tile
  coordinates. Neighbouring tiles share these coordinates exactly, so seams match.
- **Joining.** The pieces of a building are joined by dissolving the seams they share: seam
  edges are split at every piece's seam points, opposite edges cancel, and what is left is
  walked back into rings.
- **Projection and clipping to the battlefield.** The joined outline is projected into the
  battlefield and clipped to it like an OSM building. Its id is `ovt-<Overture id>` (`-1`,
  `-2`, … for pieces), and its source `overture:building/<id>`.
- **Holes and underground buildings.** Holes (courtyards) are part of the building, as with OSM.
  Buildings marked `is_underground` are left out.
- **Height.** Overture's `height` when given (in the US often a Microsoft estimate). Otherwise
  `num_floors` × 3 m, otherwise 6 m, both marked estimated: the same rules as OSM.
- **Order.** Buildings are ordered by Overture id, so the result does not depend on tile or
  feature order.

### The package and saved sources

- **Package.** Importer version 1.1.0. The package records `buildings`:
  - the source: `overture`, `openstreetmap` or `none`;
  - for Overture: the release, archive URL, zoom and tiles read;
  - buildings by outline source, the datasets used, the number joined across seams, and how
    heights were found.

  Packages from before 1.1 have no `buildings` field and still load.

- **Attribution.** Follows Overture's guidance: OpenStreetMap (also for Overture buildings drawn
  from OSM), "Buildings: Overture Maps Foundation, overturemaps.org (ODbL)", then each other
  dataset used:
  - Global ML Building Footprints, licensed by Microsoft under the ODbL;
  - Esri Community Maps contributors (CC BY 4.0);
  - Google Open Buildings (CC BY 4.0).
- **Saved sources.** The decompressed tiles are saved with the battlefield's other sources, so it
  can be rebuilt without downloading.

## Verification

- **Against Overture's own data.** For Quantico, Grafenwöhr and Alachua, the import was compared
  with Overture's full-geometry GeoParquet, which is not cut into tiles. Within each 5 km
  battlefield it gives the same buildings (1,390, 3,564 and 2,591), with total footprint area
  within 0.15% and each building's area within 1% (median) and 6–7% (p99). The p99 is the 0.4 m
  tile grid on small sheds. Joined buildings keep the area of their pieces to 1e-9. Import takes
  0.2–0.3 s.
- **Tests.**
  - Decoding and archive reading, including leaf directories, gzip and refusals.
  - Joining at a seam, a U crossing a seam twice, a building cut four ways at a tile corner, and
    six real buildings cut by a real seam.
  - Heights, holes, underground buildings, clipping at the battlefield edge, and attribution.
  - Generation with Overture, with the fallback, with Overture switched off, and cancelled.
- **Production build in Chromium.**

  | Battlefield                | Buildings step       | Requests, bytes      | Total | Buildings                                   |
  | -------------------------- | -------------------- | -------------------- | ----- | ------------------------------------------- |
  | Quantico                   | 1.1 s                | 14 requests, 156 KiB | 3.0 s | 1,390 (1,273 OSM, 117 Microsoft); 30 joined |
  | Grafenwöhr                 | 1.6 s                | 19 requests, 283 KiB | 4.6 s | 3,564                                       |
  | Alachua                    | about 1 s            |                      |       | 2,593                                       |
  | Quantico, Overture blocked | about 7 s of retries |                      | 9.3 s | 1,273 from OSM, with the warning            |

  At Quantico and Grafenwöhr, Overpass was asked only for non-building features. At Alachua,
  Overpass failed (as it does from the test environment) and the player continued without OSM:
  the battlefield has terrain and buildings. No console errors.

## Consequences

- **Coverage.** Battlefields get buildings wherever Overture has them, including the many towns
  that OSM maps poorly. In the US most buildings also get a measured or estimated height.
- **Faster building data.** The buildings come in about a second from a static file, and the
  Overpass answer is smaller. Overpass is still needed, and still the slowest and least reliable
  step, for roads, water, vegetation and land use.
- **A month behind.** Overture is released roughly monthly, so the newest OSM edits arrive up to a
  month late. The release used is recorded.
- **Machine-learned footprints** have no building type. Their outlines can be simplified or, rarely,
  wrong.
- **No service guarantee.** The bucket is free and public; when it is unavailable, generation falls
  back to OSM buildings.
- **Next.** Overture also publishes `base` (land use, water) and `transportation` (roads) tiles.
  Reading those with the same modules would remove the dependence on Overpass.
