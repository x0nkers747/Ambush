# ADR 0032: One authoritative, graded terrain

- Status: Accepted
- Date: 2026-10-11
- Implements milestone 4 (critical architectural change) of
  `docs/3d-terrain-architecture-research.md`. Amends ADR 0006 and ADR 0008 (the terrain dataset and
  its one triangulation), ADR 0020 (the fast sight tracer) and ADR 0030 (geographic features in the
  3D view). Builds on ADR 0005 and ADR 0026 (recording and replay) and ADR 0015 (scenarios).

## Context

Every battlefield's ground was its DEM: 10 m samples for imported battlefields, 5 m for the demo.
Roads and buildings were laid on that ground as it was. A road crossing a ditch dipped into it, a
road along a hillside leaned with the slope, and a building on a slope had one corner buried and
another on stilts. A 10 m grid cannot hold a 6 m road's level surface at all.

Changing only what the 3D view draws would make the view and the simulation disagree: a soldier
lying in a road cutting would be hidden in 3D and visible to the simulation, or the reverse.
The brief therefore asks for one modified ground that every system uses: 2D contours and hillshade,
the 3D mesh, roads, buildings, unit positions, movement, line of sight and viewsheds, vegetation,
the simulation, replay and the AAR. The original DEM must stay as it was, grading must be
deterministic and independent of feature order, old battlefields and scenarios must keep working,
and a replay must never silently run on different ground.

What existed:

- `heightAt(terrain, x, y)` was already the simulation's only elevation query (ADR 0008):
  linear on each cell's triangle, split south-west to north-east.
- The fast sight tracer (ADR 0020) re-implements that surface in typed arrays, crossing the
  same grid lines and diagonals as the reference `lineOfSight`.
- The 3D mesh, the 2D contours and the road and water drape each read the heightfield directly.
- Battlefield packages store the terrain in IndexedDB; scenarios store positions, not
  elevations. Simulation snapshots carry a fingerprint of the world (terrain and movement), and
  recordings live in memory with their exercise (ADR 0026).

## Decision

### The surface

The terrain keeps its regular heightfield, and may now carry a **refinement**: for chosen coarse
cells, a finer grid of samples (`src/sim/terrain.ts`, `src/sim/terrain-surface.ts`).

```ts
interface TerrainRefinement {
  factor: number; // k: each refined cell is k × k fine cells
  cells: number[]; // refined coarse cells, r·(columns − 1) + c, ascending
  samples: number[]; // (k + 1)² per cell, row-major from the cell's south-west corner
}
```

- A refined cell's fine grid is split the same way as the coarse grid (south-west to north-east),
  and the surface is linear on each fine triangle.
- **Continuity.** Validation requires a refined cell's corners to equal the heightfield samples,
  and its fine samples along an edge shared with an unrefined cell to lie on the straight coarse
  edge. The surface is therefore continuous everywhere, with no cracks, and with no change on the
  unrefined side.
- **One implementation.** `sampleSurface` is the surface. `heightAt`, the fast sight tracer and
  `surfaceSampler` all call it, on the same values (the tracer and the sampler on typed copies), so
  they agree bit for bit. A terrain without a refinement behaves exactly as before.
- `surfaceMesh(terrain)` is the exact triangulation of that surface: the coarse cells' two
  triangles, and in refined cells each fine cell's two triangles. An unrefined cell next to a
  refined one also has the fine samples along their shared edge as vertices, its triangle fanned
  from a centroid vertex, so the mesh has no T-junctions. Interpolating the mesh gives `heightAt`.
  It also returns the battlefield's outline, for the 3D skirt.

The user chose **local refinement tiles** over a uniformly finer grid: about 2.5 m only where roads
and buildings need it, and 10 m elsewhere. That keeps memory, mesh size and sight-line cost close
to what they were.

### Grading

`gradeTerrain(source)` (`src/sim/grading.ts`) returns a new terrain: the source's heightfield and
features, with graded base samples, a refinement, and a `grading` stamp
(`{ version: GRADING_VERSION, fineSpacingM }`). The source is not modified. Grading a terrain that
is already graded returns it unchanged.

- **Lattice.** Fine spacing is the cell size divided by k = round(cellSize / 2.5 m): k = 4 (2.5 m)
  on a 10 m grid and k = 2 (2.5 m) on the demo's 5 m grid.
- **Constraints, not edits.** Each road and building contributes, at each fine node it reaches, a
  target level or a lower bound (fill: the ground must be at least this high) and an upper bound
  (cut: at most this high). Everything is collected first, then settled per node in a fixed order
  of precedence (below). Ties are broken by feature id and bounds combine by max and min, so the
  **result does not depend on the order of features**, and the arithmetic is fixed, so it is
  **deterministic** to the bit.
- **Roads** (major, paved and unpaved; tracks and paths are not graded):
  - **Chains.** OSM splits roads into many ways. Ways of one class that simply continue each other
    (they meet end to end, and nothing else meets them there) are joined into one chain, and a
    closed chain is a loop. Without this, a road split into 20 m ways was smoothed over 20 m
    pieces and followed every dip.
  - **Profile.** A chain's level is the source ground along its centreline, smoothed over 50 m
    (major), 36 m (paved) or 24 m (unpaved), wrapping round a loop, then held within ±4 m of the
    ground.
  - **Junctions** are points shared by two or more chains, and chain ends that stop inside another
    road's carriageway (within its half-width plus 0.5 m) without sharing a point. Junctions within
    8 m of each other are one junction (a staggered crossroads, or one junction mapped as several
    points). Its level is the mean of the smoothed levels of the chains meeting there, and each
    chain's profile is corrected to it, linearly between junctions and fading out over 40 m beyond
    the outermost. A road ending at a junction has no rounded end; beyond it is the road it joins.
  - **Cross-section.** The ground is held exactly at the road's level out to its half-width plus a
    shoulder: 1 m (0.5 m unpaved), and at least one fine diagonal, so every fine triangle the
    carriageway touches is level. Beyond that, side slopes run out: fill at 1 : 2 (0.5 m per
    metre), cut at 2 : 3, up to 8 m beyond the level part, faded out over the last 3 m.
  - Each node takes the level at its **nearest point on the whole chain**. When every segment
    constrained its nodes separately, neighbouring segments disagreed near bends, and the largest
    fill won, leaving plateaus and steps of up to 0.6 m on steep roads.
- **Buildings.** The pad is the median of the source ground under the footprint. It is held exactly
  over the footprint and an apron of max(1 m, one fine diagonal), with the same side slopes. The
  roof is the pad plus the building's height, as before (now on the graded ground).
- **Precedence**, at each node:
  1. **A road's level part.** Where two roads' level parts overlap (at a junction), the nearest
     road's level wins; on a tie, the first chain in id order.
  2. **A building's pad and apron.** Where pads overlap, the highest fill and lowest cut win.
  3. **Side slopes** of roads and buildings, combined by max and min; where an embankment and a
     cutting are both asked for, the midpoint.

  Roads come first because buildings often stand within a few metres of the carriageway. With
  every constraint simply combined by max and min, a pad pulled the road's edge to its own level,
  and that accounted for most of the remaining kinks in Grafenwöhr's roads. A footprint that
  overlaps a road's level part (a careless mapping, or a house built to the kerb) takes the road's
  level there.

- **Water.** No grading in open water, or within a waterway's half-width plus 2 m: roads keep
  their source ground where they cross a stream, and nothing is filled into a river.
- **Refinement.** Changes under 5 cm are dropped. A coarse cell is refined when any of its fine
  nodes changed. A refined cell's corners take their graded values, so the heightfield holds the
  graded ground at every base sample.
- **Identity.** `terrainModelId(terrain)` is `"graded-v1"` for a terrain graded with this version
  and `"source"` for one that is not.

### Every system on the graded terrain

| System                                               | How it gets the graded ground                                                      |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Simulation: positions, movement, line of sight, fire | `heightAt` (refinement-aware), on the world's terrain                              |
| Fast sight tracer, viewsheds (worker)                | `sampleSurface`, plus the fine lines in refined cells (below)                      |
| 3D terrain mesh, skirt                               | `surfaceMesh`                                                                      |
| 3D roads, water, land cover, vegetation (drape)      | Drape pieces cut to fine cells in refined cells, with each fine cell's face normal |
| 3D buildings, unit markers, camera clearance         | `heightAt`, `buildingRoofElevations`; the camera's `terrainGround`                 |
| 2D contours                                          | `surfaceMesh` triangles                                                            |
| 2D elevation readout                                 | `elevationAt` (= `heightAt`)                                                       |
| Replay and AAR                                       | The exercise's own terrain (recordings live in memory with it)                     |

**Line of sight.** The reference `lineOfSight` finds where the surface's slope can change along
the line: the grid lines and diagonals it crosses. In refined cells the slope also changes at the
fine grid lines and diagonals, so `traceSightLine` adds those crossings (in fine units, skipping
coarse lines it already has), keeping only those in refined cells. The fast tracer (ADR 0020)
gains three more sequences with the same rule; it still equals the reference exactly. Its `nextCut`
codes for "end" and "pending" moved to −1 and −2, since codes 3 and 4 are now fine sequences.

### Entry points and migration

- **Battlefield packages are not migrated.** A package keeps its source DEM, as imported, in
  IndexedDB. When the app opens a battlefield, it grades it in a Web Worker
  (`src/app/grading.worker.ts`, inline if workers are unavailable) and uses only the graded terrain
  from then on. Grading again with a later version needs no data migration.
- **The demo** is `gradeTerrain(createSyntheticTerrain(...))`.
- **Scenarios** gain an optional `terrainModel` (the `terrainModelId` they were planned on). A new
  scenario records it. Loading a scenario whose `terrainModel` differs (including scenarios saved
  before this change, which have none) keeps its positions, records the current model and tells
  the user: "This scenario was planned on an earlier model of the ground…", pointing them at the
  ORP and the OPFOR route, and saying when the scenario check finds positions no longer valid on
  the new ground.
- **Serialized plans** (`serializeDeploymentPlans`) carry the scenario fingerprint, which includes
  the world fingerprint, so plans made on the source ground are refused on the graded ground
  rather than applied to it. (The app does not store plans between sessions today.)

### Replay and versioning

- A recording replays on its exercise's terrain object, which cannot change (ADR 0026), so a replay
  always uses exactly the ground it was recorded on.
- Simulation snapshots carry the world fingerprint, which covers the heightfield, the refinement
  and the grading stamp. Restoring a snapshot onto a different terrain version throws ("snapshot
  was taken in a different world"); it is never silently regenerated.
- Changing any grading rule must increase `GRADING_VERSION`. The new version gives a different
  `terrainModelId` (scenarios are then flagged as above) and a different world fingerprint
  (snapshots and plans from the old version are refused).

## Verification

Tests (all on the graded terrain, unless they compare it with the source):

- `src/sim/grading.test.ts` (20): validity; the source unchanged; version stamp; deterministic and
  independent of feature order; a level road on an embankment over a ditch and in a cutting
  through a ridge; tracks untouched; a level building pad with the roof on it; a road split into
  many ways (some drawn backwards) graded exactly as the whole road; a T-junction that shares no
  point meeting level, with a smooth approach; a loop smooth all the way round; continuity across
  refined edges; `surfaceMesh` equal to `heightAt` with no cracks; the sampler equal to `heightAt`;
  an embankment that blocks a sight line clear on the source, and a cutting that clears one blocked
  on the source; the fast tracer and viewsheds equal to the reference on refined ground; a
  1300-tick simulation with soldiers on the graded ground, reproducible hashes, different hashes
  from the source, and a snapshot refused on the source terrain.
- `src/view3d/graded-terrain.test.ts` (5): the 3D mesh equal to `heightAt` (graded site and demo);
  the camera's ground equal to `heightAt`; roads on the graded surface across refined cells;
  buildings on their pads, roofs at pad plus height; soldiers on the mesh.
- `src/app/terrain-consistency.test.ts`: 2D `elevationAt`, 3D `terrainGround` and `heightAt`
  identical at 5000 points.
- `src/view2d/terrain-layer.test.ts`: every contour vertex at its level on the graded surface,
  and contours moved by grading.
- `src/exercise/scenario-definition.test.ts`: the `terrainModel` round trip, and older scenarios
  without it.

Measured (Node, one core of the development container):

| Battlefield           | Refined cells | Max cut | Max fill | Grading    |
| --------------------- | ------------- | ------- | -------- | ---------- |
| Quantico (5 km, 10 m) | 33,877        | 3.7 m   | 10.3 m   | ~2.2 s     |
| Grafenwöhr (5 km)     | 51,395        | 5.8 m   | 5.4 m    | ~2.8–3.4 s |

Quantico's 10.3 m fill is a road over a pit in the DEM. (Its DEM also has one bad sample of
−782 m at (230, 1240), which is unchanged by grading.)

**Road smoothness.** The change of gradient between successive 2.5 m steps along every graded
road (|z₁ − 2z₂ + z₃|) shows whether the roads are smooth.

| Battlefield | Steps over 0.2 m: source ground | Graded | Graded p99 |
| ----------- | ------------------------------- | ------ | ---------- |
| Quantico    | 2.42%                           | 0.26%  | 0.13 m     |
| Grafenwöhr  | 0.09%                           | 0.06%  | 0.09 m     |

The first version (one profile per OSM way, junctions pinned to the raw ground, every constraint
combined by max and min) left Quantico at 1.2% and made Grafenwöhr worse than its source, at 0.88%.
In a browser close-up, a road there crossing a gully into a loop was jagged. The chains, junction
levels, nearest-point rule and precedence above came from those findings. The worst steps left are
at stream crossings, which are not graded.

**Opening a battlefield** (headless Chromium):

| Battlefield | Opened before (M3) | Opened now | Longest main-thread task, before → now |
| ----------- | ------------------ | ---------- | -------------------------------------- |
| Quantico    | 4.8 s              | 4.3–4.7 s  | 0.9 s → 2.0–2.1 s                      |
| Grafenwöhr  | 7.4 s              | 6.0–6.7 s  | 1.0 s → 2.7–2.9 s                      |

Grading runs in the worker while the page goes on loading, so the total does not grow. The graded
terrain is larger, though: 1.3–1.6 million refinement samples on top of 250,000 base samples. Work
that walks the whole terrain on the main thread grew with it: sharing (copy and freeze), the world
fingerprint, the 2D contours and the copy sent to the viewshed worker. Faster plain-data cloning
and encoding, freezing that skips numbers, an inlined hash loop (fingerprints unchanged, still
pinned by the determinism tests) and an array-indexed mesh builder took the longest task from
3.4 s to 2.7–2.9 s at Grafenwöhr.

The 3D terrain mesh has about 0.8 million vertices at Quantico and 1.1 million at Grafenwöhr
(from 0.25 million), and the demo's has 23,375 (from 19,481). The first 3D frame on the demo
takes 3.0–3.4 s with software rendering (2.9 s before).

## Consequences and limitations

- **Grading costs 2–3 s per battlefield opened**, in a worker, so the page stays responsive.
  Opening is no slower overall, but **the main thread is busy for up to about 3 s in one block**
  while it takes in the larger terrain (above). Caching the graded terrain with the package, and
  computing its fingerprint in the worker, would remove most of both, at the cost of a stored
  derived copy that must be invalidated by version. Not done yet.
- **2D hillshade and elevation tints** still use the base samples only. They show the graded ground
  at 10 m, so cuttings and embankments are visible in the contours but only coarsely in the
  shading.
- **Larger meshes.** The refined cells add vertices and triangles to the 3D mesh, and fine
  crossings to sight lines through refined cells (cost grows only where lines cross them).
- **Tracks and paths are not graded**, and **roads are not graded across water**, so an embankment
  has a gap where a stream crosses it (there are no culverts or bridges in the model).
- **Plans and snapshots** serialized on the source ground are refused on the graded ground.

## Deviations from the brief

- The brief lists vegetation among the consumers. Vegetation placement and drape use the graded
  surface, but no trees are cleared from cuttings or embankments beyond the existing road and
  building exclusions (ADR 0031).
- "Never silently regenerate an old replay": recordings are not persisted, so an old replay cannot
  be reopened on new ground. What could carry a replay across sessions (snapshots, serialized
  plans) is fingerprinted with the terrain and refused on a different terrain version.
