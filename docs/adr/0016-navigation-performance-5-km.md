# ADR 0016: Navigation performance on 5 km battlefields (phase 1)

- Status: Accepted
- Date: 2026-10-09
- Builds on ADR 0011 (navigation grid and path planning), ADR 0014 (standing water, generated
  battlefields) and ADR 0015 (three stages, each a fresh page).

## Context

Generated battlefields grew from 1 × 1 km to 5 × 5 km: 6.25 million navigation cells at 2 m.
Profiling the recorded Quantico (VA) and Grafenwöhr (DE) 5 km battlefields confirmed four causes
of freezes of up to minutes:

1. **Grid construction.** Every cell centre inside an obstacle's bounds was tested against the
   whole polygon (point-in-polygon plus the distance to every edge). The Potomac's
   256-vertex polygon has 17 km² bounds, so about 4 million cells × 256 edges × 2 tests. Building
   Quantico's grid took about 150 s; Grafenwöhr's (3,567 buildings) took 1.2–1.5 s.
2. **No reuse.** `createWorld` deep-copied the terrain for every simulation, and every cache
   (navigation grid, line of sight) is keyed by the terrain object. Every exercise, including the
   scenario editor's preview after each edit, built its grid again. The world fingerprint
   (BigInt FNV-1a over a 3.8-million-character encoding, about 0.9 s) was also computed twice per
   exercise.
3. **Path planning.** With the grid built, long routes still took 5–10 s. String pulling tested
   O(n²) segments against every building and water polygon, allocating edge lists each time. The
   A* heap was an array of tuples. An unreachable goal was only found after flooding everything
   reachable from the start (8 s at Quantico).
4. **Repetition.** One scenario edit planned the same legs several times: the edit's own check,
   `buildScenario` (route and patrol start points), the preview exercise and the panel.

## Decision

Make the existing navigation fast without changing a single answer. Every change below was
checked against the original implementation, cell for cell and path for path (see
Verification).

### Grid construction: rows and edge bands (`blockPolygon`)

The blocking rule is unchanged: a cell is blocked when its centre is inside the polygon or closer
than the margin to its boundary. It is now evaluated without testing whole polygons per cell:

- **Inside.** For one row of cell centres, the even-odd ray cast crosses the same edges at the
  same x, whatever the cell. The crossings are computed once per row, with the same arithmetic
  as `pointInPolygon`. A centre is inside when an odd number of them lie east of it. A centre on
  the boundary is at distance 0, so the margin test blocks it, as before.
- **Near the boundary.** The distance to a polygon is a minimum over its edges, so each edge
  blocks the cells closer than the margin to it. Only a narrow band of cells along each edge is
  tested, one cell wider than needed on each side, using the same distance function.

Holes (islands) stay impassable, as ADR 0014 decided. Polygons on the map edge are clipped to
the grid as before.

### Spatial queries: obstacle index

`pointProblem` and `isSegmentWalkable` look up obstacles in a 32 m bucket grid. Each obstacle is
registered under its bounds, grown by the largest query margin plus 1 m. An obstacle that a
query does not visit is therefore more than 1 m beyond any margin, and the exact test would have
passed it. A point's bucket lists obstacles in their original order, so the first problem
reported is the same. A segment's result is a conjunction, so the order does not matter. In
`segmentClearOfPolygon`, edges whose bounds are further than the clearance (plus 1 mm) from the
segment's bounds are skipped. Points outside a polygon's bounds skip the point-in-polygon test.
The polygon loops no longer allocate.

### Search

- **Connected areas.** A diagonal step needs both cells beside it free, so it never joins cells
  that two orthogonal steps would not. The areas A* can search are the 4-connected areas of free
  cells. They are labelled once per grid (row runs and union-find, about 50 ms). A goal in
  another area is reported `unreachable` at once, which is exactly when A* would have failed.
- **A\*** keeps its order (f, then h, then cell index) in a typed-array binary heap. Equal
  entries cannot be told apart, so the expansion order and the path are unchanged. Its scratch
  arrays rely on lazy zero-filling instead of being filled with ∞ and −1.

### Reuse

- **Shared terrain.** `shareTerrain(terrain)` makes a deep-frozen copy once. `createWorld` uses a
  terrain that is already shared as it is, and copies (and shares) any other terrain, as it
  always copied. The app shares the battlefield's terrain once per page, so scenario edits,
  previews and the exercise all use one object. The caches keep their terrain-object keys: a
  shared terrain cannot change, and a different battlefield is a different object. The demo
  passes its unshared module constant, so each of its exercises still gets its own copy, as
  before (it is small).
- **Paths.** `planPath` remembers the last 256 grid paths per terrain, keyed by exact
  coordinates and frozen. It is a pure function, so a remembered result is the one it would
  compute again. Straight-line results are cheap and are not kept.
- **Fingerprints.** FNV-1a 64 is computed on four 16-bit limbs instead of BigInt, with identical
  output (tested against a BigInt reference). A shared terrain's world fingerprint is remembered
  for each set of movement parameters. The exercise reuses `simulation.worldFingerprint`.

Navigation data lives only in memory, in `WeakMap`s keyed by the terrain, and is freed with it.
For a 5 km battlefield that is the grid (6.25 MB), its areas (25 MB) and the index (a few MB).
A* touches at most 81 MB of scratch arrays during a search, and only what it visits. The grid is
not stored: it builds in about 0.2 s, so persisting it is not worth a storage format.

### No path-planning worker (yet)

After these changes, navigation blocks the main thread for about 0.1–0.6 s per long-leg edit in
the browser. In the worst case, one edit plans three new long legs (the patrol leader's and both
followers'), about 1–1.5 s. On a cold stage load, navigation adds about 1 s on routes that cross
the whole map. The rest of each stage load's blocking is the terrain layer and map drawing
(phase 2). A worker would move about 1 s of work without making the page responsive while the
map is built. It would also need the terrain sent across and its results synchronized, so it is
deferred. If it is needed later, the design is a prefetcher: a worker runs the same edit and
scenario functions on its copy of the shared terrain and returns its remembered paths. The main
thread adds them to its own path cache, then runs the unchanged synchronous edit. A stale reply
only warms the cache, and the main thread never accepts a route it has not checked itself.

## Verification

- **Grids.** Quantico and Grafenwöhr 5 km grids are identical to the original cell-by-cell grids
  (6.25 million cells each).
- **Point and segment tests.** 20,000 random `pointProblem` and 3,000 `isSegmentWalkable` calls
  per site agree with the original.
- **Paths.** All sampled paths agree with the original: 84 random paths and the 15 benchmark
  routes, including long routes round the Potomac and an unreachable destination.
- **Unit tests** (`sim/navigation-grid.test.ts`) compare the grid with the original definition on
  large irregular water with an island, water reaching the map edges, narrow buildings and
  ditches, edges and vertices exactly on cell centres, a comb-shaped outline and many buildings.
  They also cover reuse, the path-cache bound and shared terrain.
- **Recorded data.** `tools/real-terrain.test.ts` pins 12 paths on the recorded 1 km OSM data, as
  planned by the original code.
- **Determinism.** The determinism and replay hashes are unchanged.

## Consequences

- Grid construction: Quantico 150 s → 0.17 s; Grafenwöhr 1.2–1.5 s → 0.2 s.
- Unreachable goals are reported in under 1 ms.
- Long cross-map routes take 0.3–0.9 s; typical legs take a few to 30 ms (Grafenwöhr) and up to
  about 0.25 s (Quantico).
- Repeated edits reuse paths.
- No behaviour, path or simulation result changed.
- `sim` exports `shareTerrain` and `isSharedTerrain`. The terrain in `SimWorld` may now be the
  same object as the scenario's, when that terrain is shared.
- Remaining navigation cost: A* on long legs (about 1 µs per expanded cell, 0.2–0.5 million cells
  on a cross-map leg), paid once per distinct leg on each page load. The next bottlenecks are not
  navigation: the terrain layer, contours and map drawing (about 1 s per load and 150–200 ms per
  frame on 5 km maps), reading the package from IndexedDB (0.3–0.4 s), and full-map viewsheds.
