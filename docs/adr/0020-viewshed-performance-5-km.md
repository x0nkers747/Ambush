# ADR 0020: Viewsheds on 5 km battlefields

- Status: Accepted
- Date: 2026-10-09
- Builds on ADR 0011 (line of sight and the viewshed), ADR 0016 (5 km battlefields) and ADR 0017
  (map rendering).

## Context

The planning map shows what the selected Marine can see (ADR 0011): a viewshed on a 4 m grid,
every cell decided by the same exact sight-line trace as the line-of-sight query
(`traceSightLine`), computed in a pool of Web Workers. On the 1 km demo map that took about 0.15 s.
On a 5 km battlefield it took minutes, and the planning map was unusable with visibility on.

### What the time was spent on

A 5 km battlefield has 1,250 × 1,250 = 1.56 million viewshed cells. The workers used for each cell
the same code as a single line-of-sight query:

1. **All cut points first.** The trace computed every cut point of the whole sight line, sorted
   them, and then walked them. Cut points are terrain grid lines, diagonals, and building and
   vegetation edges, about 600 on a 2 km line. It stopped at the first obstruction, but only after
   all of that work. With buildings and vegetation, 97–99.9% of cells are hidden, most within a
   few hundred metres of the observer.
2. **Every feature for every line.** The trace kept every building and vegetation area (1,300–3,600
   buildings) whose bounding box overlapped the line's, and intersected every edge of each with the
   line.
3. **Whole polygons, again and again.** It tested every candidate feature at every piece of the
   line with a point-in-polygon test over the whole polygon. Vegetation polygons have hundreds of
   vertices, and a line passing over a wood is inside its box for hundreds of pieces.

Neither the number of workers, nor the transfer of data or results, nor drawing was a significant
cost.

The profile below is single-threaded (Node 24, the same V8 as Chrome), on sampled rows of the
recorded battlefields:

| Observer                          | Per cell, terrain only | Per cell, with features | Full viewshed |
| --------------------------------- | ---------------------- | ----------------------- | ------------- |
| Grafenwöhr, open field (200, 500) | 188 µs                 | 1,764 µs                | 46 min        |
| Grafenwöhr, town centre (0, 0)    | 192 µs                 | 759 µs                  | 20 min        |
| Quantico, woods (0, 0)            | 194 µs                 | 375 µs                  | 10 min        |
| Quantico, open (0, −100)          | 174 µs                 | 400 µs                  | 10 min        |

With the 3–4 workers of the pool, that is 3–15 minutes per viewshed.

## Decision

Keep the viewshed's meaning exactly: every cell visible or not exactly as `traceSightLine` decides
it. Make each decision far cheaper, and avoid most traces altogether. `traceSightLine` stays as it
is: it remains the line-of-sight query, the one combat uses, and the reference the new code is
tested against.

### A tracer that stops at the first obstruction (`sim/sight-tracer.ts`)

`sightLineTracer(terrain).blocked(eye, target)` decides exactly what `traceSightLine` decides.
Every value a decision depends on is computed with the same floating-point operations in the same
order:

- the cut points;
- the ground at them;
- the clearance, roof and canopy crossings;
- the point-in-polygon tests;
- the accumulated obscuration.

It does much less work:

- **Lazy cut points.** Cut points are generated in increasing order as the walk proceeds, not
  computed for the whole line and sorted. The terrain grid lines and diagonals are three
  arithmetic sequences, merged on the fly, using the reference's formula
  `t = (k − v0) / (v1 − v0)`. The walk stops at the first obstruction.
- **Bucket index.** Feature edges and feature bounding boxes sit in a 32 m bucket index. A line
  loads a bucket only when its walk reaches it, and so intersects only the edges near it. A
  feature is tested at a piece of the line only while the piece lies within the feature's box.
  Features and edges that the line never comes near contribute no cut points and are never inside
  at a midpoint, so leaving them out changes nothing.
- **Point-in-polygon on nearby edges only.** The tests look only at edges whose y-range can
  contain the point, using a band index. These are the only edges the reference's test can be
  decided by.
- **Raster for large polygons.** Large polygons also get a 4 m raster. Where no edge comes within
  0.25 m of a raster cell, the answer anywhere in it is known, because that far from every edge
  the exact test cannot be swayed by rounding. Cells near an edge use the exact test.

### Proofs instead of traces

Neighbouring cells are nearly always hidden by the same obstruction. Before tracing a cell, the
viewshed tries to prove it hidden from the obstruction recorded for:

- the cell to its left;
- the cell below it;
- the four most recent new obstructions.

Three kinds of proof are tried:

- **Terrain:** a point of this cell's line where the ground stands at least 1 cm above it. The
  ground is linear between cut points, so the reference's piece containing that point has
  negative clearance at one end, and the reference reports an obstruction there or earlier.
- **Building:** a point of the line at least 1 cm inside a building's footprint and below its
  roof. The reference's piece containing it lies inside the footprint, because no edge crossing
  is within it. Its sub-part there is below the roof, so the reference reports an obstruction
  there or earlier.
- **A short walk** of this line through the stretch where the neighbour was obstructed: from
  16 m before to 48 m after. This also covers vegetation.
  - Cut points do not depend on where a walk starts. From the second cut point on, every piece
    is exactly the reference's piece and is checked in the same way.
  - Vegetation obscuration starts from 0 rather than from what the reference had gathered by
    then. Floating-point addition is monotonic, so it never exceeds the reference's.
  - An obstruction this walk finds, the reference therefore finds at the same point or earlier.

A proof only ever shows a cell hidden; it never shows one visible. When no proof succeeds, the
cell is traced in full. 1 cm is about eight orders of magnitude larger than the rounding of
coordinates on a 5 km map. On the recorded battlefields 93–99.7% of cells are settled by a proof,
and the remaining traces are mostly of visible cells.

### Work in the browser (`view2d/viewshed-service.ts`)

- **Pool and terrain.** The pool of persistent workers is unchanged: `hardwareConcurrency − 1`, at
  most 4. Each worker receives the terrain once.
- **Ready before the first request.** Each worker builds the visibility index on arrival (0.2–0.4
  s) and computes a small warm-up viewshed so that its code is optimized. This happens while the
  map loads, before anyone asks for a viewshed.
- **Bands.** Each band spans 64 rows, and the rows of a band are computed in order, so each cell
  has its neighbours' obstructions to prove from. A viewshed takes two passes:
  1. every other row of every band;
  2. the rows between.

  After the first pass, the half-computed result is shown as a preview. Each row between is copied
  from the row below it, and the panel says it is a preview. The preview costs nothing extra; the
  second pass completes the same grid.

- **Superseding and cancelling.**
  - A new request supersedes the job in progress: its remaining bands are never handed out, and
    replies for it are dropped by job id. An outdated result can never overwrite a newer one.
  - When visibility is turned off or nothing is selected, the work in progress is cancelled.
    Finished viewsheds stay cached.
- **Cache.** Viewsheds are cached by exact observer position and cell size, without rounding. The
  cache is least recently used first, bounded at 32 viewsheds and 12.5 million cells: about 8
  full-detail viewsheds, with their 6 MB overlay images.
- **Worker failure.** If a worker fails, its band goes to another worker. If all fail, the panel
  says visibility cannot be calculated.
- **Timings.** Each viewshed records its timings as a `performance.measure` entry, for
  diagnostics.

Nothing else changes:

- the grid (4 m, or 8 m while a destination is dragged);
- heights, ranges, line-of-sight rules and display;
- the cached map (ADR 0017), the engagement wedge and combat.

## Verification

### Equivalence

- **Recorded battlefields.** Full reference viewsheds, every cell traced with `traceSightLine`,
  were computed for four observers on the recorded battlefields: Grafenwöhr open field and town
  centre, and Quantico woods and open ground. That is 6.25 million cells, which took 8–37
  CPU-minutes per viewshed. The new viewshed agrees on every cell, computed both in contiguous bands and in
  the two-pass order the browser uses.
- **Tests.** The tests compare the two cell by cell on synthetic terrain (`sight-tracer.test.ts`):
  - flat ground, a ridge, a valley with rims, a hilltop, a saddle and rough ground;
  - buildings: concave, rotated, edges on grid lines and diagonals;
  - vegetation with clearings, and overlapping areas;
  - observers on terrain vertices, grid lines and diagonals, at viewshed cell centres, and at the
    battlefield's edges and corners;
  - 8 m preview grids.

  They also compare 4,000 random sight lines and special lines along building edges and grid lines,
  and check that no proof ever claims a clear line obstructed.

### Speed

Single-threaded, a full 4 m viewshed takes 5.4–6.6 s instead of 8–37 minutes: 90–340 times faster.

In the browser, the production build ran headless Chromium on 4 cores, with 3 workers. The times
are from the user's action until the panel reports the full 4 m result:

| Case (4 m grid, 1.56 million cells)       | Battlefield | Before  | After   | After: half-way preview |
| ----------------------------------------- | ----------- | ------- | ------- | ----------------------- |
| Marine in the ORP (woods)                 | Quantico    | 100.7 s | 2.65 s  | 1.72 s                  |
| Marine in the ORP (town)                  | Grafenwöhr  | 173.1 s | 2.10 s  | 1.31 s                  |
| Destination on open ground                | Quantico    | 99.7 s  | 1.86 s  | 0.93 s                  |
| Destination on open ground                | Grafenwöhr  | 379.1 s | 2.12 s  | 1.09 s                  |
| Another Marine (in the ORP)               | Quantico    | 93.2 s  | 2.06 s  | 1.10 s                  |
| Another Marine (in the ORP)               | Grafenwöhr  | –       | 2.00 s  | 1.08 s                  |
| Destination dragged 6 m (from drag start) | Quantico    | –       | 2.59 s  | 1.69 s                  |
| Destination dragged 6 m (from drag start) | Grafenwöhr  | –       | 3.49 s  | 2.40 s                  |
| Viewshed computed again (cached)          | both        | 7 ms    | 7–10 ms | –                       |

The "Another Marine" time before the change comes from the behaviour check; "–" marks a case not
measured with the original code (each takes minutes). After a 6 m drag, the computation itself
takes 1.8–2.3 s; the rest of the time is the drag and the 8 m previews computed during it.

During every computation the map kept drawing at 60 fps. The median frame was 17 ms and the 95th
percentile 33–50 ms, also while panning and zooming. The longest single frame (67–133 ms) is the
one in which a finished viewshed's 1,250 × 1,250 overlay image is built: 11–18 ms for the pixels,
the rest for the browser to create and upload the image.

The viewsheds drawn by the original and the new build are identical, pixel for pixel, on the
recorded Quantico battlefield for two Marines: 0 of 1,159,510 pixels differ.

## Consequences

- A viewshed on a 5 km battlefield is ready in about 2–3 s, with a preview after about 1–2 s.
  Repeating one is immediate.
- The map stays responsive throughout. Frames stay at 60 fps (median 17 ms; 95th percentile
  33–50 ms; worst frame 117 ms, when the overlay image is built).
- **Small moves are not under 1 s.** A small move of the destination still needs a full
  recomputation, about 2 s, because no cell of a viewshed from another position can be reused
  exactly. The preview from dragging and the half-way preview bridge the wait.
- **Cost depends on visible cells.** Every visible cell still needs a full trace. A viewshed with
  much more visible ground, such as from a bare hilltop over open country, takes longer, roughly in
  proportion. On the recorded battlefields visible cells are 0.1–2.2%.
- **Memory.** Each worker holds the terrain, the index and the rasters: about 15–25 MB on the recorded 5 km
  battlefields (terrain 8–11 MB, index 7–13 MB).
- **Combat unchanged.** Line of sight for combat and the point query are unchanged and still use
  `traceSightLine`.
