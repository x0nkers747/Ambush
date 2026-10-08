# ADR 0014: Real-world terrain import (1 km battlefields)

- Status: Accepted
- Date: 2026-10-08
- Implements ADR 0006 (georeference and import chain). Extends ADR 0011 (water, waterways, land
  use, vegetation holes) and ADR 0012 (the squad on imported terrain).

## Context

A player should be able to pick almost any place on Earth and play on it, without preparing any
files. The design report "Ambush! Real-World Terrain Design" (2026-10-08) proposed OpenStreetMap
for features and AWS Terrain Tiles for elevation, fetched from the browser. It also proposed a
Canvas 2D map, a versioned battlefield package and IndexedDB storage. Those recommendations were
approved, with the battlefield fixed at **1 × 1 km** for now instead of 5 × 5 km. The report's
large-terrain optimisation phase was deferred until measurements require it.

## Decision

### Layers

Two new layers, with boundaries enforced by `tsc` and ESLint (ADR 0001):

| Layer                      | Depends on     | Responsibilities                                                                                                      |
| -------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------- |
| `src/geo` (`#geo`)         | `#sim`         | UTM, local frame, tile maths, Terrarium decoding and resampling, OSM normalization, clipping, battlefield packages    |
| `src/acquire` (`#acquire`) | `#sim`, `#geo` | HTTP with retries, rate limits and cancellation; Overpass, Terrain Tiles and Nominatim clients; IndexedDB; generation |

`#geo` is pure, like `sim`: no DOM, no network, no clock (lint-enforced), and fully tested in
Node. `#acquire` is browser code, with its network, clock and PNG decoder injected so that it is
also tested in Node. The simulation knows nothing of either. The app wires them together.
`#geo/fixtures` exposes the recorded test data to tests in other layers; the app never imports
it.

### Coordinates

WGS84 input is converted to the **UTM zone of the battlefield's centre**, including the Norway and
Svalbard exceptions, between 80° S and 84° N. The local origin (0, 0) is the centre rounded to
the metre. Local x is east and y is north (grid north), as in ADR 0002.

The projection is implemented in-house (`geo/utm.ts`, Krüger series to n⁶ after Karney 2011)
rather than adding `proj4`. It matches PROJ to within 1 mm at 13 reference points, including both
hemispheres, the polar limits and both sides of the antimeridian, and it round-trips across all 60
zones. A battlefield that crosses the antimeridian is handled: its query is split into two boxes,
and tile columns wrap.

### Data sources and services

Each service is fetched directly from the browser; all of them answer with
`Access-Control-Allow-Origin: *`. There is no backend.

| Service                          | Used for                | Notes                                                                                                            |
| -------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Overpass API (`overpass-api.de`) | OSM features, one query | Retries with backoff; 30 s after 429/406; error remarks inside a 200 answer are retried; endpoints tried in turn |
| AWS Terrain Tiles, Terrarium PNG | Elevation               | About 4–9 tiles at zoom 14–15; 404/403 means a missing tile                                                      |
| Nominatim                        | Optional place search   | Only on an explicit Search, at most one request per second, never search-as-you-type                             |

Endpoints are configuration (`acquire/config.ts`). They can be overridden per browser through
`localStorage["ambush.services"]` (JSON with `overpassEndpoints`, `nominatimEndpoint`,
`terrainTileUrl`, `contactEmail`, `tileConcurrency`), for example with a self-hosted or paid
Overpass instance, which the public instance's policy asks commercial users to use.

**Elevation sources and honesty.** Each tile names its source rasters in the
`x-amz-meta-x-imagery-sources` header. `geo/elevation-sources.ts` maps them to a dataset, an
approximate native resolution, a terrain model (DTM: bare earth; DSM: includes canopy and
buildings) and the required attribution. Examples:

- USGS NED: 3 or 10 m, DTM;
- SRTM: 30 m, DSM;
- EU-DEM: 25 m, DSM;
- UK lidar: 2 m, DTM;
- Austria and Kartverket: 10 m, DTM;
- ArcticDEM: 5 m, DSM.

The package records the finest and coarsest resolution listed and the surface model, and warns
when the source is a surface model.

The local grid is **10 m (101 × 101 samples)**. Where the source is coarser, the UI says the grid
adds no detail. Contour intervals are never finer than the source supports (§ Rendering).

### Data model

`TerrainDataset` **format 3** is additive. Format 2 data, including the demo, is unchanged and
still valid, so its world fingerprint and the pinned determinism hashes are unchanged.

- `features.water`: `WaterArea` with kind `water` (blocks movement) or `wetland` (display only),
  and optional holes (islands; drawn as land, still unreachable).
- `features.waterways`: rivers, streams, canals, drains and ditches as centrelines with widths.
  Display only.
- `features.landUse`: farmland, meadow, orchard, residential, commercial, industrial, military,
  cemetery, recreation, other. Display only.
- `VegetationArea.holes`: clearings. Line of sight through a clearing is not obscured
  (`los.ts`).
- `source` on every imported feature: the OSM reference, and the fields set from defaults
  (`estimated`).
- `RoadClass` gains `path` and `major`.
- `metadata`: the elevation source's resolution and surface model.

**Movement:** `pointProblem` reports `inWater`. Straight legs may not cross standing water, and
the navigation grid blocks cells within half a cell diagonal of it, so no grid step crosses
water. Water has no clearance: soldiers may stand on the shore.

**Battlefield package** (`geo/package.ts`, `ambush.battlefield` schema version 1): a
self-contained, JSON-safe record of a generated battlefield. It holds:

- the request;
- the UTM frame and the WGS84 bounds;
- the terrain;
- the elevation tiles used, their sources and recorded resolution;
- the OSM endpoint, query and `timestamp_osm_base`;
- the attribution;
- the processing report: counts, dropped elements with reasons, and warnings.

Its `id` is a fingerprint of the request and terrain. `parseBattlefieldPackage` refuses other
schemas and versions, invalid terrain, and content that no longer matches its id (damage).

### Import rules

- **One Overpass query** (`out geom`) covers the battlefield plus a 100 m margin.
- **Tag mapping is a versioned table** (importer 1.0.0):
  - highways map to `major`, `paved`, `unpaved`, `track` or `path`, with widths from tags or
    class defaults;
  - building heights come from `height`, else `building:levels` × 3 m, else 6 m;
  - woods, scrub, tree rows and hedges become vegetation, with default canopy and see-through
    depth;
  - tree rows and hedges become strips of rectangles;
  - water, wetland, waterways and land use are mapped as listed above.
- **Multipolygons:** relation rings are assembled from member ways.
- **Clipping:** everything is clipped to the battlefield. Polygons use a Weiler–Atherton walk
  specialised to the rectangle, so a polygon that leaves and re-enters becomes separate simple
  polygons. Lines use Liang–Barsky.
- **Bad data is dropped and reported, never allowed to fail the import:** self-intersecting
  outlines, unclosed rings, missing geometry. Holes crossing the edge are filled (warned).
  Building courtyards are not represented (warned).
- **Missing OSM data does not stop generation.** If Overpass fails, the player may continue with
  terrain only.
- **Missing elevation:** samples in a missing area are filled from their neighbours, up to 25% of
  the grid. Beyond that the battlefield is refused rather than invented. On a 1 km battlefield,
  one missing tile is usually more than that.

### Persistence and reproducibility

IndexedDB database `ambush`, version 1, with three stores:

- **summaries:** for the list;
- **packages:** what is played;
- **sources:** the Overpass response as received and the tile PNGs with their source headers,
  for reprocessing without downloading again.

Persistent storage is requested. Loading re-validates the package. A saved battlefield is
identical every time it is loaded, whatever happens to OSM afterwards. The package format is
plain JSON, so export and import of files can be added without format changes (deferred). Without
IndexedDB, an in-memory store is used and the player is told.

### Scenario on imported terrain

`scenarioForTerrain` (exercise layer) places the MCWP 3-11.2 squad at an automatically chosen ORP:

- a 14 m circle, nearest the centre on a 10 m search grid;
- the deterministic ORP layout, so nobody stands in or against a building or in water;
- no OPFOR;
- the demo's movement settings.

Movement, facing, viewshed and the kill zone work as on the demo. START OPFOR explains that the
scenario has no OPFOR route. A scenario editor comes later.

### Rendering

The Canvas 2D map is unchanged in structure (ADR 0009). It draws, bottom to top:

1. land-use tints (military areas with a dashed red edge);
2. vegetation (with clearings);
3. water (wetland lighter and dashed);
4. waterways;
5. roads: major roads red with a dark casing, paved and unpaved as before, tracks dashed, paths
   dotted;
6. buildings;
7. then all tactical overlays as before.

Ids of imported features are not drawn as labels. A compact attribution strip sits on the map,
the full credits in the battlefield panel, and the pointer readout adds latitude and longitude.

**Contour intervals** (`contourIntervals`): the demo, which has no metadata, keeps 2 m with 10 m
index lines. Imported terrain uses at least 1 m for sources of 3 m or finer, 2 m for 10 m, 5 m
for 30 m, otherwise 10 m, widened until the relief needs at most 40 levels. Index lines are every
fifth.

### Selection UI

A start screen offers:

- **the demo;**
- **a new battlefield:**
  - entered as latitude and longitude, or found by place search;
  - the chosen location is shown with its UTM zone, the size (1,000 × 1,000 m) and a link to view
    it on OpenStreetMap;
  - Generate shows step-by-step progress, can be cancelled, and gives errors that name the
    service;
- **saved battlefields:** open or delete, with a two-step delete.

The battlefield button in the exercise header returns to the start screen.

## Measurements (1 km)

Real Grafenwöhr OSM data (888 buildings), Node, single thread:

| Operation                                             | Time   |
| ----------------------------------------------------- | ------ |
| `buildBattlefield` (resample, OSM import, validation) | 85 ms  |
| ORP placement                                         | 6 ms   |
| `createExercise` (two world fingerprints)             | 86 ms  |
| Contours at 2 m                                       | 14 ms  |
| `planPath` corner to corner (with the 2 m nav grid)   | ~60 ms |
| `lineOfSight`, per line                               | 85 µs  |
| Viewshed, whole map at 4 m (single thread)            | 3.0 s  |

In the browser:

- generation took 3.9 s (Quantico) and 20 s (Grafenwöhr, almost all of it waiting for Overpass);
- the map ran at 60 frames/s;
- the full 4 m viewshed appeared in 0.4 s with the worker pool.

None of the deferred optimisations (spatial index, viewshed range, path or layer caching) are
needed at 1 km.

## Consequences

- Any place in UTM coverage is playable within seconds, offline once saved, with credits shown.
- Accuracy is as good as the free data. Outside the US and a few countries, elevation is about
  25–30 m and a surface model, so it misses ditches and banks and may count canopy twice. The UI
  says so.
- The public Overpass and Nominatim instances suit development and light use. A commercial release
  needs its own or paid endpoints (configuration only) and a review of ODbL share-alike for
  distributed packages.
- Larger battlefields need the deferred performance work: the viewshed cost grows with area and
  feature count.
- No OPFOR, ORP choice or export/import yet: the next phases.
