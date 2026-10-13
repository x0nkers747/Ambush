# Terrain Lab: Ground-Level Terrain Prototype Report

- Status: Prototype complete, for review. **Not integrated into the game.**
- Date: 2026-10-13
- Implements stage 2 of [`ground-level-terrain-architecture-research.md`](ground-level-terrain-architecture-research.md)
  (architecture A4★). Decision record: [ADR 0047](adr/0047-terrain-lab-prototype.md).
- Evidence: [`docs/research/terrain-lab`](research/terrain-lab/README.md) holds the screenshots and
  the benchmark results.
- Hardware: AMD Radeon 880M (integrated GPU, Direct3D 11 through ANGLE), Chrome 155, Node 24.

## Summary

**The architecture works, and ground level looks clearly better.** The lab is an isolated,
interactive page at `#terrain-lab` that renders recorded battlefields from their real DEM and
OSM data with:

- a deterministic, constraint-based terrain field;
- a lazily tiled 0.5 m (or 1 m) surface with exact line of sight;
- a CDLOD renderer;
- a material system driven by distance fields;
- deterministic ground clutter.

**Gains over the current renderer**, side by side on Grafenwöhr, Quantico and Amsterdam with the
same camera:

- **Roads and verges improve most.** The current renderer shows flat grey slabs with beige
  edges. The lab shows textured asphalt, gravel shoulders or paved footways, ragged worn edges,
  then grass.
- **Streams** sit in channels with banks.
- **Meadows** have real grass instead of a flat texture.

**Frame rate.** On the integrated GPU the lab renders faster than the current renderer: about
95 fps when walking, with half the triangles and a p95 frame time of 13 ms instead of 31 ms.

**Simulation queries:**

- Exact line of sight against the 0.5 m terrain takes about 5 µs per 300 m line, with min/max
  skipping. That is terrain only; the current tracer also checks buildings and vegetation.
- Random height queries are 2–3× slower than today's.
- Tile memory at 0.5 m rules out holding a whole battlefield in memory. Tiles must stay lazy, and
  be stored more compactly.

**Weak points:**

- Procedural relief barely reads at eye height.
- Built-up shores have no quay walls.
- Dense battlefields get structures only around the test area.
- Cross-engine determinism is proven only on V8 (Node and Chrome); Firefox and Edge were not
  tested.

**Recommendation: proceed with A4★**, with the changes in §9.

## 1. Opening the lab

```sh
npm run dev
```

1. Open <http://localhost:5173/#terrain-lab>. After deployment it is also at
   <https://x0nkers747.github.io/Ambush/#terrain-lab>.
2. The lab lists the battlefields saved in this browser. Generate one from terrain selection
   first (Grafenwöhr, Quantico and Amsterdam have pre-set test areas).
3. **Camera:**
   - **Walk** (1.7 m eye height), **Fly** and **Tactical**.
   - WASD to move, Shift to go faster, Q/E down and up (fly).
   - Drag to look, or double-click for pointer lock (Esc leaves it).
   - The wheel sets speed, or zoom in tactical mode.
4. **Viewpoints** are found from the data: the twelve views of the brief.
5. **Renderer:** _Experimental_ or _Current_ switches renderer with the camera kept. _Capture
   pair_ saves matched screenshots.
6. **Terrain controls:** lattice (0.5 m or 1 m), relief on/off and amplitude, seed, simple or
   advanced materials, clutter quality, debug views (LOD levels, tile boundaries, material
   fields), wireframe, LOD morphing, structures.
7. **Overlay:** FPS, frame time, draw calls, triangles, nodes per level, atlas and cache tiles,
   worker tile times, clutter, terrain GPU memory, and the JS heap.
8. **Benchmark** runs a 30 s walk and a 30 s orbit.

Nothing in the game imports the lab. Only the composition root loads it, lazily, for this
address. A test enforces that (`src/app/terrain-lab-isolation.test.ts`).

## 2. What was built

| Part               | Where                                                                                                            | Notes                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Terrain field      | `src/sim/terrain-lab/field.ts`, `base.ts`, `roads.ts`, `buildings.ts`, `channels.ts`, `landcover.ts`, `noise.ts` | Pure, deterministic; no lattice in the features                                                                                 |
| Tiled surface      | `src/sim/terrain-lab/surface.ts`                                                                                 | 64 m tiles, 0.5 m or 1 m lattice, LRU cache, min/max blocks, exact tracer                                                       |
| Structures' ground | `src/sim/terrain-lab/structures.ts`                                                                              | A `TerrainDataset` sampled from the lab surface, so the game's own generators place buildings, bridges, details and trees on it |
| CDLOD renderer     | `src/view3d/terrain-lab/terrain-renderer.ts`, `terrain-shader.ts`                                                | One 32 × 32 grid instanced per node, one draw call; heights and material fields in tile atlases                                 |
| Materials          | `terrain-shader.ts`, `ground-textures.ts`, `textures/`                                                           | 9 CC0 PBR materials at 1024 px                                                                                                  |
| Clutter            | `clutter.ts`                                                                                                     | Grass, weeds, pebbles, leaves; 6 instanced draw calls                                                                           |
| Water              | `water.ts`                                                                                                       | The game's opaque water material; sheets at the water grading's levels; ribbons for channels                                    |
| Workers            | `tile.worker.ts`, `tile-pool.ts`                                                                                 | Each worker compiles the same field; tiles transferred                                                                          |
| Lab page           | `lab.ts`, `lab-camera.ts`, `presets.ts`, `current-scene.ts`, `lab-structures.ts`                                 | UI, cameras, automatic viewpoints, the current renderer for comparison                                                          |
| Measurement        | `bench.cli.test.ts`, `determinism.ts`, `determinism.cli.test.ts`                                                 | Opt-in CLI tests, as `diagnose.cli.test.ts`                                                                                     |

### 2.1 The terrain field

The field is `height(x, y)` and `sample(x, y)`, which also gives material fields.

- **Base.** The cleaned DEM (`cleanTerrain`), interpolated with Catmull–Rom bicubic and clamped
  to each cell's four samples, so it never overshoots. A test checks this.
- **Relief.** Four octaves of integer-hash gradient noise (28, 14, 7 and 3.5 m), with
  amplitudes per land cover read from a 2 m raster and blended bilinearly. Woodland gets up to
  0.15 + 0.14 + 0.10 + 0.05 m; lawns almost none. Seed and amplitude are parameters.
- **Constraints.** All are continuous functions of distance, so none depends on a lattice:
  - **Roads** are profiled along their length (smoothed DEM, depth-limited, pinned at junctions
    in rank order, bridges laid straight between their ends). Their cross-sections give:
    - a cambered carriageway;
    - a shoulder, or a pavement in built-up areas;
    - a parabolic ditch, which fades out on embankments;
    - cut and fill slopes, which fade out after their reach;
    - wheel ruts on tracks.
  - **Building pads** sit at the median ground under the footprint, with a 0.8 m apron and
    slopes beyond.
  - **Water areas and levelled rivers** use the water grading's own levels and query
    (`waterLevels`, `waterQuery`, ADR 0040). They get a bed, banks that start at the water
    level, and ragged sandy shores.
  - **Unlevelled streams and ditches** get a channel cut with a bed falling downstream.
- **Composition.** Constraints are gathered at each point and applied lowest priority first.
  - Each one clamps the height so far into its band, with a 0.3 m rounding that never leaves
    the band, weighted by its fade.
  - The order is: banks, then pad slopes, road slopes, pad cores, water beds, road cores.
  - Cores are therefore exact, the highest priority wins, and the ground is continuous.
  - A test checks for steps of 15 cm or more over 5 cm across roads, pads, junctions and shores.
- **Determinism.**
  - Arithmetic is `+ − × ÷`, `sqrt`, `floor` and `Math.imul` hashing only, in a fixed order.
  - Features are sorted by id. Rasters are filled in priority-then-id order.
  - The one exception is the reused production water query, which uses `Math.hypot` (see §8).

### 2.2 The surface

- **Tiles.** 64 m tiles (129² samples at 0.5 m, 65² at 1 m) with a one-sample border, stored as
  Float32 heights plus 8 material bytes per sample:
  - signed distance to a road edge;
  - signed distance to a shore;
  - distance to a wall;
  - surface codes;
  - grass, soil and litter weights;
  - wetness.
- **Levels.** Level _m_ samples the same lattice points 2^m apart. Every coarse sample is
  bit-equal to the level-0 sample at that point (tested).
- **Queries.**
  - `heightAt` is piecewise linear, split south-west to north-east, as today (tested).
  - `traceSight` is exact: it cuts at every lattice line and cell diagonal, and skips 64 m tiles
    and 4 m blocks whose highest sample lies below the line. It equals the unpruned reference on
    every line tested: 4 × 2000 real lines plus 300 in unit tests. Dense sampling confirms it.
- **Repeatability.** Tile hashes do not depend on generation order or cache state (tested).

### 2.3 Rendering

- **CDLOD.**
  - The quadtree has its root at 8192 m (10 levels at 0.5 m).
  - Nodes are 32 quads: 16 m at level 0 (0.5 m spacing), doubling each level.
  - The range is 3 × node size, so level 0 extends to 48 m and level 1 (1 m) to 96 m.
  - Vertices morph to the next level over the last 25 % of the range. Collapsed odd vertices
    reproduce the coarse SW–NE mesh exactly, so levels meet without cracks.
  - Nodes are frustum-culled with the tile's min/max heights.
  - A node whose children have no tiles yet is drawn at its own level until they arrive.
- **Atlases.** 256 layers of height (R32F) and two material (RGBA8) atlases, 53 MB. Up to 12
  tile uploads per frame, with least-recently-used eviction.
- **Materials.**
  - The shader composes nine materials per pixel from the interpolated distance fields:
    - roads by surface (asphalt, paving, gravel, track with a grass middle, dirt), with ragged
      noise-perturbed edges;
    - shoulders and pavements, and worn verges;
    - sand or mud shores and damp bands;
    - drip strips along walls;
    - land-cover grass, soil and litter;
    - earth on moderate slopes and triplanar rock on steep ones.
  - The three strongest materials are blended by height (from each texture's height map).
  - Each is sampled with hex tiling and a variance-preserving blend.
  - Detail normals are reoriented to the ground. There is parallax offset within 14 m, broad
    colour variation, and a second large-scale sample beyond about 150 m.
  - Textures are tinted so each material's mean matches the game's ground colours, so both
    renderers share a tone.
- **This is the "software material cache" in a smaller form.** Instead of a camera-centred
  virtual texture of colours, the tiles carry distance fields at the lattice spacing. They
  interpolate exactly, so road and shore edges stay crisp at any distance without a cache
  re-render. Not done: baked colour pages, decals, painted markings (the game's marking mesh is
  drawn instead).
- **Clutter.**
  - Per 4 m cell, hashed from the cell: grass tufts in three variants (9 per m² within 14 m, 3.5
    to 30 m, 1.2 beyond), weeds, pebbles and leaves.
  - Placed from the level-0 tiles' material fields: never on carriageways, water or against
    walls.
  - Grass sways and fades with distance; tufts are lit like the ground. 6 draw calls.
  - Quality: low 25 m, medium 40 m, high 60 m.
- **Structures.**
  - The game's own generators run on a `TerrainDataset` sampled from the lab surface: buildings
    (walls to the pad, plinth band), bridges (decks from `planBridges`, piers to the lab
    ground), road markings, roadside details and trees.
  - The battlefield is sampled at 2 m from the workers' tiles. Dense battlefields (more than
    20,000 buildings) use only the test area plus 150 m, at 1 m.
  - The game's draped roads and water are hidden: the lab's ground and water draw them.

## 3. Test areas

| Battlefield | Area centre (1 km square) | Features found                                                                                          | Missing                        |
| ----------- | ------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Grafenwöhr  | 250, 750                  | Roads on slopes, buildings on slopes (348), 6 mapped bridges, 4 water areas, 6 waterways, woods, meadow | Little farmland in this square |
| Quantico    | 0, 500                    | Roads, slopes, bridges, Potomac shore and ponds, creeks, woods, fields                                  | —                              |
| Amsterdam   | 250, 1000                 | 126 bridges, canals, river, dense buildings                                                             | Steep slopes; natural streams  |

The areas were chosen by a deterministic scan of the recorded packages, scoring each 1 km window
on bridges, water, waterways, woods, fields, roads, sloping buildings and relief. Viewpoints are
found by searches over the field (`presets.ts`):

- the steepest road stretch and its verge;
- the building nearest the centre, and the most sloping one;
- the nearest stream;
- the most natural shoreline;
- the planned bridge over the most water;
- the most open grassland;
- the deepest woodland;
- the steepest natural slope;
- a tactical view and an overview.

## 4. Visual comparison

The images are in [`docs/research/terrain-lab`](research/terrain-lab/README.md):

- all 12 views in both renderers for Grafenwöhr;
- 5 views for Quantico and 3 for Amsterdam;
- debug views.

The camera and lighting are identical. The current renderer's ground is the game's graded
terrain, so the eye can be a few centimetres higher or lower there.

| #   | View                | Experimental vs current (Grafenwöhr unless noted)                                                                                                                                                  |
| --- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | On a road           | **Much better.** Asphalt texture, paved footway, ragged edges, grass verge, against flat grey and beige slabs. Quantico and Amsterdam: gravel shoulders and verges, same gain.                     |
| 2   | Shoulder and verge  | **Much better.** Paving slabs, wear, grass tufts.                                                                                                                                                  |
| 3   | Beside a building   | **Better.** Paved drip strip and trodden earth at the wall instead of grass to a sharp line.                                                                                                       |
| 4   | Building on a slope | **Better.** Pad and grass; the wall sits on the pad. Similar silhouette.                                                                                                                           |
| 5   | Beside a stream     | **Better.** A channel with banks and a track along it, against a flat ribbon on the ground. The banks are uniform and too dark where steep.                                                        |
| 6   | Natural shoreline   | **Better.** A ragged sand and gravel shore with damp ground. The current renderer shows a brick quay strip, and at Quantico a rock mound artefact.                                                 |
| 7   | Bridge from below   | **About equal.** The deck and channel are drawn in both. The Grafenwöhr viewpoint is poor (a wall in the foreground). At Amsterdam the current renderer shows sand pyramids that the lab does not. |
| 8   | Open grassland      | **Much better.** Dense meadow grass against a flat texture.                                                                                                                                        |
| 9   | Woods               | **Equal to slightly better.** Litter, leaves and tufts. The ground is darker than the current renderer's; litter tone needs work.                                                                  |
| 10  | Steep slope         | **Equal.** The slope here is in woodland. Rock appears only above about 35°, which these battlefields barely have.                                                                                 |
| 11  | Tactical, 320 m     | **Equal.** Similar overall; roads crisper.                                                                                                                                                         |
| 12  | Overview, 6 km      | **Equal.** Both are dominated by the land-cover pattern.                                                                                                                                           |

**Debug views:**

- LOD rings by level and morphing.
- Tile boundaries.
- Wireframe at 0.5 m near the camera, coarser behind.
- Relief at ×0 and ×2. The difference is hardly visible at eye height under the midday sun.

## 5. Performance

Node figures are from `bench.cli.test.ts`; browser figures are from the lab's benchmark, in
Chrome with vsync and the frame-rate limit off. The JSON files are in
`docs/research/terrain-lab/benchmarks`.

### 5.1 Field and tiles (Node, one thread)

|                                         | Grafenwöhr                 | Quantico                  | Amsterdam (stress, 2 km area)  |
| --------------------------------------- | -------------------------- | ------------------------- | ------------------------------ |
| Features                                | 1211 roads, 3567 buildings | 955 roads, 1273 buildings | 15,646 roads, 53,377 buildings |
| `waterLevels`                           | 10 ms                      | 16 ms                     | 245 ms                         |
| Field compile (index)                   | 147 ms                     | 113 ms                    | 930 ms (pads 583 ms)           |
| Tile, 0.5 m (mean / p95)                | 9.8 / 16 ms                | 10.2 / 16 ms              | 21.7 / 34 ms                   |
| Tile, 1 m                               | 2.7 / 4.2 ms               | 2.8 / 4.3 ms              | 6.0 / 9.1 ms                   |
| Field samples per second                | 1.7 M                      | 1.6 M                     | 0.79 M                         |
| 1 km² at 0.5 m (256 tiles)              | 2.6 s                      | 2.7 s                     | 22 s for 4 km²                 |
| Bytes per tile, 0.5 m / 1 m             | 207 kB / 54 kB             | same                      | same                           |
| Whole battlefield, 0.5 m (heights only) | 1.29 GB (428 MB)           | same                      | same                           |
| Whole battlefield, 1 m (heights only)   | 338 MB (112 MB)            | same                      | same                           |

In the browser, tiles come from 4 workers (2 on dense battlefields), each compiling the field
itself (about 170 ms on Grafenwöhr). The lab is ready with the test area's tiles, structures and
textures in 4–21 s.

### 5.2 Queries (Node)

These use 1 M random points and 2000 random 50–300 m sight lines over the area.

|                                                           | Grafenwöhr            | Quantico     | Amsterdam     |
| --------------------------------------------------------- | --------------------- | ------------ | ------------- |
| `heightAt`, warm, random, 0.5 m / 1 m                     | 327 / 227 ns          | 201 / 197 ns | 316 / 309 ns  |
| `heightAt`, cold (tile generated on first touch)          | 131 / 37 µs           | 129 / 36 µs  | 1105 / 315 µs |
| `heightAt`, warm, sequential (a walk), 0.5 m / 1 m        | 116 / 46 ns           | —            | —             |
| Current terrain `heightAt`                                | 94 ns                 | 81 ns        | 401 ns        |
| Lab sight line, pruned, 0.5 m (mean / p95)                | 5.4 / 12 µs           | 4.8 / 11 µs  | 4.5 / 9.5 µs  |
| Lab sight line, 1 m                                       | 4.8 / 13 µs           | 4.3 / 12 µs  | 4.0 / 9.7 µs  |
| Lab sight line, reference (no pruning), 0.5 m             | 46 µs                 | 45 µs        | 55 µs         |
| Mismatches, pruned against reference                      | 0 / 2000              | 0 / 2000     | 0 / 2000      |
| Current `lineOfSight` (terrain, buildings and vegetation) | 94 µs                 | 78 µs        | 837 µs        |
| A 20 km walk with a 64-tile cache, 0.5 m                  | 216 tiles made, 2.1 s | 203, 2.1 s   | 319, 6.7 s    |

The lab tracer is terrain only. Buildings and vegetation would add the current tracer's feature
tests, so the comparison is not like for like. The terrain part of line of sight is no longer
the problem.

### 5.3 Rendering (Chrome, AMD 880M, 1270 × 908 canvas, Grafenwöhr)

| 30 s run                               | Mean frame (FPS) | p95     | Max draw calls | Max triangles |
| -------------------------------------- | ---------------- | ------- | -------------- | ------------- |
| Experimental 0.5 m, walking a road     | 10.6 ms (95)     | 12.8 ms | 88             | 3.45 M        |
| Experimental 0.5 m, orbit at 400–700 m | 5.9 ms           | 8.8 ms  | 63             | 2.86 M        |
| Experimental 1 m, walking              | 9.6 ms           | 11.5 ms | 88             | 3.47 M        |
| Experimental 1 m, orbit                | 6.0 ms           | 8.2 ms  | 63             | 2.86 M        |
| Current, walking                       | 10.2 ms          | 31.1 ms | 95             | 6.86 M        |
| Current, orbit                         | 13.3 ms          | 49.7 ms | 69             | 5.98 M        |

- **Terrain cost.** The terrain is one draw call of about 70–110 nodes and 0.15–0.3 M triangles.
  Most of the triangles are trees, buildings and clutter: clutter is about 0.26 M triangles in
  20–30 k instances.
- **Stalls.** Every run, current included, has rare stalls of about 150 ms (p99). They come from
  tile uploads, clutter rebuilds and garbage collection, and need profiling.
- **GPU memory for the terrain** is about 204 MB: 53 MB of tile atlas and 151 MB of material
  arrays (9 × 3 maps at 1024² with mipmaps).

### 5.4 Against the research budgets (§7)

| Budget                           | Target                      | Measured                                              | Met?                                      |
| -------------------------------- | --------------------------- | ----------------------------------------------------- | ----------------------------------------- |
| Frame time, integrated GPU       | ≤ 33 ms p95                 | 12.8 ms walking, 8.8 ms orbit                         | Yes, at about 1.3 Mpx                     |
| Terrain draw calls               | ≤ 10 terrain + ≤ 20 clutter | 1 + 6                                                 | Yes                                       |
| Terrain vertices drawn           | ≤ 1 M                       | about 0.08–0.11 M vertices (0.15–0.3 M triangles)     | Yes                                       |
| Terrain GPU memory               | ≤ 256 MB                    | 204 MB                                                | Yes                                       |
| Simulation tile cache per worker | ≤ 64 MB                     | 207 kB per tile: 64 MB holds about 310 tiles at 0.5 m | Yes, if heights are stored compactly (§9) |
| Field generation per tile        | ≤ 5 ms per worker           | 9.8–21.7 ms (0.5 m), 2.7–6 ms (1 m)                   | **No** at 0.5 m                           |
| `heightAt`                       | ≥ 5 M/s warm                | 3–5 M/s random, 8.6 M/s sequential                    | **Borderline**                            |
| 300 m sight line                 | ≤ 100 µs median             | 4–5 µs (terrain only)                                 | Yes                                       |
| Viewsheds                        | ≤ 2× today                  | not measured                                          | —                                         |

## 6. Determinism

- **Repeatability (Node).** Tiles from a freshly compiled field equal the cached ones, and tile
  hashes are identical across runs for all three battlefields, at both spacings. Generation
  order and cache state do not change any tile (unit test).
- **Node against Chrome 155.** Seven tiles (levels 0, 2 and 4) on Grafenwöhr hash identically
  (`benchmarks/xbrowser-grafenwoehr.json`). **Both are V8, so this is not a cross-engine
  result.** Firefox (SpiderMonkey) and Edge were not tested in this run; the comparison script
  supports them.
- **Known risk.** The field calls the game's water query, which uses `Math.hypot`. ECMAScript
  leaves its precision to the implementation. A different engine could round a shore distance
  differently and change a tile. Before relying on cross-engine equality, replace it with
  `Math.sqrt` in the field's path, and run the comparison on Firefox.

## 7. Simulation consistency

- **The renderer's level 0 is the simulation's surface.** The height atlas holds the tiles'
  Float32 samples, read with `texelFetch` and interpolated by the same SW–NE rule. Coarser
  levels are exact subsets of it.
- **Render-only geometry:**
  - **Clutter** (grass up to about 0.5 m, pebbles, leaves) is display only and conceals visually.
    Its concealment is not in the simulation (research §5.2 rule 3, open question 12).
  - **Normal maps and parallax** (about ±2 cm of apparent depth) are visual only.
- **Structures.** Buildings, bridges and trees stand on a 1–2 m sampling of the same surface,
  equal to it at its samples.
- **Units on bridges.** Walking over bridges uses the planned decks (`bridgeIndex`), not a
  simulated layer (stage 6).

## 8. What worked, what did not

**Worked:**

1. **Continuous constraints.** Road edges, ditches, pads and shores are resolution-independent
   and exact where they must be. Junction pinning and bridge profiles fit the game's bridge
   planner without changes.
2. **Material distance fields.** This gives most of the visual gain at low cost: 8 bytes per
   lattice sample, crisp edges at any distance, no draped meshes, and no z-fighting.
3. **CDLOD with one instanced grid.** It is cheap, and crack-free by construction.
4. **The exact tracer with min/max pruning** is about 8–10× faster than unpruned.
5. **Reusing the game's generators**, through a sampled `TerrainDataset`, avoided rewriting
   buildings, bridges, decor and trees.
6. **Workers each compiling the field.** This is simple, and repeatable because the field is
   pure.

**Problems found and fixed during the work:**

- **Picking the higher-priority side of a fill/cut conflict** made the ground discontinuous: a
  0.9 m cliff where a stream met a track. Ordered clamping fixed it.
- **The smooth clamp overshot its band by up to 7.5 cm**, so carriageways and pads were not
  level. Clamping into the band fixed it. Unit tests found this one.
- **Streams computed above the surrounding ground** got levees. The bed is now capped below the
  local ground.
- **Offset water outlines** produced spikes; the plain outline is now used.

**Not good enough yet:**

1. **Relief does not read at eye height.** Amplitudes of 0.1–0.5 m with wavelengths of 3.5–28 m
   are invisible under a high sun, even at ×2. Ground realism came from materials and clutter,
   not geometry. Relief still matters for cover; its look needs low-sun lighting, normal detail
   from the field, and larger, rarer features (mounds, ruts, hollows).
2. **Generation cost at 0.5 m.** Tiles take 10–22 ms against a 5 ms budget. Amsterdam's pads
   cost most: polygon distance for every pad in a 32 m bucket.
3. **Memory.** 207 kB per 0.5 m tile (Float32 heights plus 8 B of material per sample). A whole
   battlefield cannot be resident; heights alone are 428 MB.
4. **Random `heightAt` is 2–3× slower** than today's, from tile lookups and cache misses.
5. **Built-up water.** Amsterdam's canals get sloped banks, not quays: the field cannot hold a
   vertical step. Quays must be structures, as research §5.6 says.
6. **Structure coverage.** On dense battlefields, buildings and trees are generated only in the
   test area. Distant Amsterdam views are bare.
7. **Viewpoints are found automatically, and some are poor.** Amsterdam's shoreline view
   stands on a bridge, and Grafenwöhr's bridge view is half wall.
8. **Woodland floor** is darker than the current renderer's.
9. **Stalls** of about 150 ms occur in all modes.
10. **Repository size.** The textures add 11 MB.

## 9. Recommendation

**Proceed with A4★.** No other approach looks better on this evidence:

- The gains came from the parts only A4★ combines: continuous constraints, material fields from
  the same field, and LOD over an exact sampled surface.
- A constrained triangulation would not have produced the material fields.
- A heightfield with volumes would have added cost without visual gain.

**Before production, change the following:**

1. **Simulation lattice.**
   - Use 1 m for the simulation; keep 0.5 m only near the camera, for rendering.
   - At 1 m tiles take 2.7–6 ms, a 20 km walk costs 0.6–1.7 s of generation, and heights alone
     are 112 MB per battlefield.
   - Gameplay-scale features (ditches 1.8 m wide, embankments, ruts) survive at 1 m. The 0.5 m
     relief is not visible anyway.
   - Re-test a prone soldier against 1 m ditches.
2. **Compact storage.**
   - Store heights as Int16 centimetres from a per-tile base.
   - Keep material bytes only in render tiles.
   - Share tiles between workers: transferable `ArrayBuffer`s, or `SharedArrayBuffer` behind
     cross-origin isolation.
3. **Generation cost.**
   - Precompute per-tile stamp lists, with each pad's distance only where it can matter.
   - Give pads a cheaper signed distance (rectangles first).
   - Evaluate constraints at 1 m and interpolate where none is near.
4. **Arithmetic.** Remove `Math.hypot` from the field's path. Test Firefox, Edge and Safari
   tile hashes in CI.
5. **Quays and retaining walls** as structures with their own simulated edges; the field holds
   the levels either side.
6. **Generate structures from the field in workers**, not through a sampled `TerrainDataset`,
   so dense battlefields get them everywhere.
7. **Visual work, in order of payoff:**
   - lighting, with time of day and a lower sun;
   - woodland floor and litter tone;
   - clutter variety (flowers, dead grass, sticks) and density by land cover;
   - field-derived micro-normals for relief;
   - road markings in the material fields;
   - asphalt patching and cracks.
8. **Profile and remove the 150 ms stalls**: spread uploads, rebuild clutter incrementally, and
   use fewer allocations.
9. **Follow the research roadmap:** stage 1 (interfaces) next, then stage 3 (CDLOD over today's
   surface).

Integration into the game needs your authorisation. The lab stays isolated until then.
