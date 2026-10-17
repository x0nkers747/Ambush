# ADR 0031: Procedural vegetation in the 3D view

- Status: Accepted
- Date: 2026-10-11
- Implements milestone 3 (phase 3, vegetation, and part of phase 4, quality presets) of
  `docs/3d-terrain-architecture-research.md`. Builds on ADR 0029 and ADR 0030 (the 3D view), ADR
  0011 and ADR 0014 (environment features), and ADR 0006 and ADR 0008 (one terrain triangulation).

## Context

The 3D view showed the ground, roads, water, buildings and land-cover colours, but no trees. Woods
cover about half of some battlefields (5.2 km² of 25 km² at Quantico, 11.7 km² at Grafenwöhr).
Without trees, the 3D view does not look like the place, and it does not look like the simulation
either, which treats every vegetation area as obscuring sight up to its canopy.

Constraints:

- **The simulation is unchanged.**
  - A `VegetationArea` (woodland, tree line or scrub) obscures a sight line by
    1/`seeThroughMeters` for each metre the line travels inside it below `canopyHeightMeters`.
  - Individual trees play no part: there is no ballistic or line-of-sight collision with them.
  - OSM tree rows and hedges arrive as strips of rectangles, 6 m and 2 m wide (canopy 10 m and
    2 m). Woods may have clearings, held as holes.
- **Speed.** Thousands of trees must draw in a few dozen draw calls, generation must not freeze
  the page, and the view must stay usable on integrated graphics.

## Decision

### The plant library

`plant-models.ts` builds nine procedural plants once, in about 70 ms. Each comes in three levels
of detail, and every instance of a plant shares that plant's geometry.

| Plant   | Kind           | Height | Crown radius | Triangles (near / medium / far) |
| ------- | -------------- | ------ | ------------ | ------------------------------- |
| oak     | broadleaf      | 15 m   | 5.3 m        | 438 / 70 / 26                   |
| beech   | broadleaf      | 16 m   | 4.9 m        | 438 / 70 / 26                   |
| lime    | broadleaf      | 14 m   | 5.1 m        | 438 / 70 / 26                   |
| spruce  | conifer        | 18 m   | 3.8 m        | 132 / 56 / 30                   |
| pine    | conifer (pine) | 17 m   | 4.2 m        | 350 / 48 / 26                   |
| sapling | small tree     | 7 m    | 2.8 m        | 358 / 70 / 26                   |
| snag    | dead tree      | 12 m   | 2.6 m        | 52 / 26 / 6                     |
| bush    | shrub          | 2 m    | 1.4 m        | 320 / 40 / 20                   |
| thicket | shrub          | 2.4 m  | 1.9 m        | 320 / 40 / 20                   |

How they are built, in stylised realism (natural proportions, believable silhouettes, few
triangles):

- **Broadleaf crowns** are four or five irregular foliage masses (roughened icospheres) around the
  upper trunk, with three visible limbs on the near model.
- **Spruces** are a straight trunk under tiers of jagged, drooping skirts.
- **Pines** are a long bare trunk with a high, flat crown.
- **Shading.** Each crown is shaded as one soft volume: foliage normals lean outwards from the
  crown's centre, and vertex colours darken low in the crown and in hollows (cheap self-shading).
- **Size.** Every level of detail is scaled to exactly the plant's height and crown radius, so a
  plant does not change size when its level changes.
- **Slopes.** Trunks reach 1 m below the ground and shrubs sit slightly into it, so nothing stands
  on air on a slope.

**Why not ez-tree.** `@dgreenheck/ez-tree` (MIT, 24 MB unpacked) was considered and not added.
Its trees are thousands of triangles with alpha-tested, textured leaf cards. That is the wrong
cost for 100–250 thousand instanced trees, and it would bring texture assets and alpha-test
overdraw. The procedural models give the silhouettes needed at tactical distances, with no
assets and full control of the triangle budget.

### Placement: in the vegetation areas, deterministic

`vegetation-placement.ts` plants only inside the battlefield's vegetation areas, outside their
holes, sized from each area's canopy height.

**Woodland:**

- **Spacing.** Dart throwing on a global 2.9 m grid in row order, at most one tree per cell. This
  gives blue-noise spacing with no rows or grid pattern. Each tree needs room in proportion to its
  crown: 1.4 × the radius for broadleaf trees and 1.6 × for conifers, with a minimum of 4.2 m.
- **Density.** A 70 m noise field makes some stands up to 28 % sparser.
- **Gaps.** A 30 m noise field leaves rare small gaps, about 3 % of the area.
- **Species.** Stands are mixed by slow noise fields. Conifer stands vary over about 140 m, with
  spruce or pine over 220 m. Broadleaf stands hold mostly one species over about 90 m, with 30 %
  of trees mixed in.
- **Edges and understorey.** Within 9 m of the edge, 25 % of trees are saplings and the rest about
  8 % lower: a soft forest edge. Inside, 5 % are saplings and 1.5 % dead snags.
- **Heights.** Main trees are 0.85–1.22 × the canopy height, so crown tops sit within ±25 % of the
  canopy that the simulation uses (tested). Saplings are 0.4–0.65 ×.
- **Inset.** Trunks stand at least 0.35 × their crown radius inside the area's edge, so crowns end
  about where the area ends.

**Tree lines and hedges:**

- **Tree rows** are planted along the strip's main axis, every 5.2–7.8 m, with a little sideways
  jitter. They are 80 % broadleaf.
- **Hedges** (canopy below 4 m) are planted with shrubs every 1.2–1.8 m.
- The shared spacing grids keep the joins between strip segments from doubling up. A strip wider
  than 20 m is filled like a wood.

**Scrub:** shrubs from 1.6 m apart on a finer, separate grid. They grow in clusters with open
patches between, set by an 18 m noise field, and are 0.5–1 × the canopy height (at most 2.5 m).
Shrubs never look like small forests: there are no trunks, they stay low, and they are wide for
their height.

**Exclusions** (`exclusion.ts`, `spatial-index.ts`). These are tests on the source data, which is
never changed:

- **Roads.** No trunk within a road's half-width, plus its verge, plus 1 m plus a quarter of the
  crown radius. Crowns may overhang a little, as over a forest road.
- **Buildings.** No plant inside a footprint, or within 0.5 m plus 0.8 × its crown radius of a
  wall.
- **Water.** No plant in open water, or within 1 m of a shore or a waterway. Wetland is allowed.

The indexes make these tests cheap: band-bucketed polygon edges for containment, and grid-bucketed
segments for distances.

**Determinism:**

- Candidates come from integer hashes of grid cells, and choices from hashes and value noise of
  positions. There are no random numbers and no time.
- Areas are processed in order of id, so the same battlefield gives identical plants, sizes,
  species and turns whatever order its features arrive in (tested by shuffling the inputs).
- `PLACEMENT_VERSION` and `GEOMETRY_VERSION` are kept for a cache key.

**Ground.** Every plant's foot is at `heightAt` (tested to 1 mm).

**Output layout.** Typed arrays (position, yaw, crown and height scale, tint, rank), sorted by
plant, then by 100 m tile, then by rank. Each tile records its run of each plant and its height
range.

**Limit.** At most 500,000 plants; beyond that the lowest-ranked are dropped, deterministically.

### Instancing and levels of detail

`vegetation-layer.ts` creates one `InstancedMesh` per plant and level: at most 27, all sharing one
material, with vertex colours tinted per instance. Each instance has a position, a turn, a crown
and height scale, and a colour tint (±11 % brightness, slightly warmer or cooler, plus a stand-wide
variation).

`vegetation-lod.ts` chooses what to draw:

- **Bands.** Per plant, by distance from the camera: near, medium, far, or none. Small plants
  switch sooner (shrubs at half the distance).
- **Thinning.** In the far band plants are thinned progressively, by their fixed rank, down to
  12–20 % at the far limit. The ones kept get crowns up to 1.8 × wider, so a distant forest keeps
  its cover and trees fade out one by one, never a tile at a time.
- **Beyond the far band** the woodland ground colour stands for the forest.
- **Culling.** Whole 100 m tiles are skipped when out of range or outside the camera's view, and
  the rank order lets the thinning stop early. The work therefore follows what is seen.
- **When it runs.** Only when the camera has moved noticeably: 1 % of its height, or a slight
  turn. At most every 150 ms, longer when a selection is costly, and once more when the camera
  stops. Only the used part of each instance buffer is uploaded.
- **Never regenerated.** Nothing is regenerated when the camera moves.

### Quality presets

`quality.ts` chooses a preset from the renderer string WebGL reports: software renderers and Intel
graphics get low, Apple medium, NVIDIA and AMD high, and anything unknown medium. The presets
change only how much is drawn, never where anything is.

| Preset | Near / medium / far band | Thinned to | Shadows                                | Max pixel ratio |
| ------ | ------------------------ | ---------- | -------------------------------------- | --------------- |
| Low    | 90 / 320 / 1,800 m       | 20 %       | none                                   | 1               |
| Medium | 150 / 600 / 4,500 m      | 12 %       | 2048² map, ≤ 700 m round the focus     | 1.5             |
| High   | 240 / 950 / 7,000 m      | 12 %       | 4096² map, ≤ 1.1 km, trees receive too | 2               |

**Adaptive resolution** (2026-10-17, `resolution.ts`). On top of the preset, the drawing buffer is
scaled down when frames are slow and back up when there is room: through 100, 85, 72, 60 and 50 %
of the preset's pixel ratio. A second of frames averaging over 18.5 ms (under about 54 fps) is one
step down; frames steady at the display's own rate for 4 s, one step up (one that is slow again
within 3 s waits twice as long next time, up to 64 s). Two steps down that gain nothing (the frames
are slow for another reason: the simulation, the CPU) go back to where they were, and none is tried
for 20 s. Frames while the view loads are not measured. On a Radeon 880M (integrated, detected
high) at 1920 × 1080 and 1.5× scaling, the combined-arms demo: still 48 fps to 63, orbiting 43 to
60, settling at half resolution (pixel ratio 0.75): at high, the shadow pass and some 1,300 draw
calls cost what resolution cannot save.

### Light and atmosphere

- **Shadows.** The sun casts shadows only in a square round the camera's focus, sized to the view
  and moved in whole shadow-map texels so the edges do not shimmer.
  - Casters: buildings, and the near and medium trees.
  - Receivers: the terrain, roads and buildings, plus the trees themselves on high.
- **The rest is shared with the ground:** the sky, hemisphere light and fog from milestone 1 light
  and fade the trees as they do the ground.
- **Woodland ground** is a little darker, so gaps between crowns read as forest floor.
- **No post-processing.**

### Generation off the main thread

`generation.ts` and `generation.worker.ts` take the feature geometry (ADR 0030) and the vegetation
placement off the main thread.

- **The job.** One module worker per job receives the terrain once (structured clone), runs the
  pure generators and returns typed arrays with their buffers transferred, not copied. It reports
  progress: "Building roads, water and buildings…", then "Growing vegetation…", shown in the map
  bar.
- **Cancellation.** Starting another job, or leaving the battlefield, terminates the worker.
  Replies carry a job id, and a reply for any job but the current one is ignored, so a stale
  result can never reach a newer battlefield. The same code runs on the main thread, after a tick,
  where there are no workers (tests).
- **The terrain is drawn at once,** as in milestone 1. Features and vegetation appear when ready:
  - their shaders are compiled with `compileAsync`;
  - they are added on two frames (features, then vegetation), so their GPU uploads are split.

### Caching

- **In memory.** The generated layers are kept with the terrain. Switching 2D and 3D, moving the
  camera and changing quality never regenerate anything (tested in the browser: ten switches leave
  every count unchanged, and the terrain is built once).
- **No persistent cache, by choice.**
  - A battlefield's generated data is 60–100 MB, which is a lot for IndexedDB.
  - Keeping a cache valid needs a reliable fingerprint of the battlefield's geography together with
    the generator versions.
  - With generation off the main thread (3–4 s in the background on a 5 km battlefield, measured
    in software rendering), the gain no longer justifies the risk.
  - `GEOMETRY_VERSION` and `PLACEMENT_VERSION` are kept as the generator part of a future key.

### Soldiers stay visible

Soldiers among trees or behind buildings would disappear from the 3D view. Each marker now has a
dim silhouette drawn last, with a "greater depth" test, so it shows only where something nearer
hides the marker. It shows through hills too, which is a viewing aid, not a line-of-sight
indication: the 2D map likewise shows every soldier.

## Consequences

### Measured

Headless Chromium with software WebGL (SwiftShader) on the CI-class test machine, 1600 × 1000. The
generation times are worker times in the browser.

| Battlefield | Plants (trees + shrubs) | Worker: features + vegetation | Result arrives | Geometry and instance buffers |
| ----------- | ----------------------- | ----------------------------- | -------------- | ----------------------------- |
| Demo        | 795                     | 0.03 + 0.04 s                 | 0.3 s          | 2 MiB                         |
| Quantico    | 122,304                 | 1.3–1.6 + 1.3–1.5 s           | 3.0–3.3 s      | 89 MiB                        |
| Grafenwöhr  | 239,573                 | 1.2–1.9 + 1.9–2.8 s           | 3.7–4.3 s      | 96 MiB                        |

**Draw calls and triangles:**

- Low quality: 12–36 draw calls on the real battlefields, with 1.2–1.6 M triangles.
- High quality: up to 50 draw calls, with 2–3 M triangles in close and low views of dense forest.
  The high-quality overview of Grafenwöhr draws about 69,000 thinned far trees.
- Both are within the 300-draw-call and 600 MB budgets.

**Main thread:**

- The first 3D frame appears in 0.9–1.4 s on the real battlefields (it was 1.9–2.4 s with
  milestone 2's main-thread generation).
- One long task follows when the roads, water and buildings first draw: 1.7–1.9 s in software
  rendering. That is shader linking plus about 80 MB of uploads; milestone 2 had the same cost
  inside its first frame.
- The vegetation frame takes under 1 ms.
- A LOD selection takes 1–45 ms in this environment, and runs only while the camera moves.

**Frame rate.** In software rendering it is 0.7–1.3 fps on the 5 km battlefields, which says
nothing about real GPUs. No GPU was available, so the 60 fps target is **not verified**.

**Milestone 1 checks still pass:** markers within 1 cm, camera, simulation and replay preserved,
disposal on leaving.

### Differences from the simulation, accepted

- **Trees are a picture of the area, not the area.**
  - The simulation obscures sight uniformly within a vegetation polygon below its canopy.
  - The picture has trunks, gaps under crowns and small gaps between crowns, so at eye level one
    seems to see further into a wood than the simulation allows (25 m of woodland fully obscures).
  - Conversely, crowns overhang the polygon's edge a little.
- **Kept clear of features.** Roads, verges, buildings and water inside a wood are drawn clear of
  trees, while the simulation still obscures sight there.
- **Gaps.** Small gaps (about 3 %) and dead trees exist only in the picture.
- **Strip widths.** Tree lines are 6 m strips in the simulation; their crowns are up to about 10 m
  wide.
- **Heights.** Saplings at forest edges are lower than the canopy height.
- **Not drawn.** Isolated trees (`natural=tree`) are not imported, so they are not drawn.
- **Not obstacles.** No tree is an obstacle to movement, fire or sight beyond what the areas
  already do.

### Limitations and future work

- **No GPU measurements.** Frame rates on real GPUs, and the Iris Xe experience, are untested; the
  presets are estimates to tune on hardware.
- **Shader compilation.** It is synchronous where `KHR_parallel_shader_compile` is missing
  (software rendering).
- **Shadows** cover only the area round the focus. Distant woods are unshadowed, with only their
  baked self-shading.
- **No transition blending.** There is no cross-fade between levels of detail; single trees switch
  at their distance, which is mostly hidden by the matching sizes.
- **No persistent cache.** A worker pool, or a cache keyed by a battlefield fingerprint plus the
  generator versions, are the next steps if load times matter.
- **Not included:** seasonal colour, wind, grass and imported single trees.

### Deviations from the research architecture

- **No ez-tree, no glTF assets and no `@three.ez/instanced-mesh`.** Procedural models and plain
  `InstancedMesh` with CPU-side tile culling and LOD do the job with no new dependencies.
- **No canopy shells.** The far field is thinned instanced trees, then the woodland ground colour.
- **Quality presets came early.** They were planned for phase 4 and arrived with vegetation,
  together with selective shadows.
- **The research put generation in a worker from phase 2.** It has moved there now, for features
  as well as vegetation.
