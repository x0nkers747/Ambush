# Ground-Level Terrain: Architecture Investigation

- Status: Research and recommendation, awaiting review. Nothing here is implemented.
- Date: 2026-10-13
- Ambush! read at `c44c4e4` (after ADR 0046).
- Scope: whether, and how, to replace the terrain architecture so that the ground stays
  convincing from a 1.7 m eye height, while the simulation keeps one authoritative,
  deterministic ground.

Evidence conventions (as in [`3d-terrain-architecture-research.md`](3d-terrain-architecture-research.md)):

- **Verified**: read in the source, measured on the recorded battlefields, or read from a
  primary source (documentation, licence file, npm registry, GitHub API) on 2026-10-13.
- **Assumed**: an estimate or general knowledge, not checked here.
- **Unverified**: a claim found but not confirmed against a primary source.
- **Recommendation**: a judgement.

The battlefields measured are the recorded packages used for ADRs 0044–0046: Quantico (US,
Potomac shore), Grafenwöhr (Bavaria, training area and town) and central Amsterdam. Each is 5 km
square.

---

## Summary

**The DEM is not the main problem, and making it finer will not fix the ground.** The import
already samples the tiles at up to 5 m. The sources behind them are mostly 10–30 m data
(National Elevation Dataset, Shuttle Radar Topography Mission, EU-DEM), so the 10 m grid holds
almost all the detail they have (ADR 0014). What spoils the ground at eye height is how the
terrain is modelled, drawn and textured:

- **Feature shapes are tied to a grid.** Roads, building pads and water are written into one
  piecewise-linear lattice of 10 m cells, refined to 2.5 m where needed (ADR 0032). That lattice
  cannot hold a 30 cm ditch, a kerb, or a road shoulder at any angle without a stair-step.
- **Roads, verges and water are separate draped meshes.** They are not part of the ground, so
  every edge is a hard seam.
- **There is no level of detail.** The whole battlefield is one mesh, so near-field density
  cannot rise without raising the cost of the entire 25 km². Amsterdam already draws 24.75 M
  triangles in 1.6 GB of geometry (ADR 0046).
- **The ground material is coarse.** Its weight map is about 3.9 m per texel (ADR 0038). There
  is no height blending, no micro-relief, no ground clutter and no grass.

**Recommendation: a constraint-based terrain field.** This is the brief's alternative 4 (chunked
procedural terrain), made precise. It has four parts:

1. **One terrain field.** A versioned, pure, deterministic function in `src/sim` turns the DEM,
   the OSM features and a seed into heights at any resolution.
   - The cleaned DEM, smoothly interpolated, gives the broad shape.
   - Roads, pads, water beds, banks, ditches and embankments are stamped into it as distance-field
     cross-sections composed in a fixed order. They no longer depend on a lattice.
   - Seeded, land-use-masked small-scale relief (0.1–1 m) is added where nothing constrains the
     ground.
2. **One sampled surface for the simulation.** The field is sampled on a 0.5 m lattice (1 m as
   the fallback), in 64 m tiles generated lazily in workers, cached, and indexed by a min/max
   pyramid. `heightAt`, line of sight, viewsheds and navigation all read this surface. It keeps
   today's split-cell piecewise-linear convention, so the exact tracer of ADR 0020 carries over.
3. **A render that only reads the simulation surface.** The 3D view draws the same tiles with a
   quadtree level of detail that morphs smoothly between levels (CDLOD: one instanced grid,
   heights read in the vertex shader, WebGL2 today, WebGPU later).
   - At its finest level, every vertex is exactly a simulation sample.
   - Detail below the simulation's tolerance (at most ±3 cm) comes from normal maps, parallax and
     instanced clutter, never from geometry the simulation cannot see.
   - Roads, verges and land-use edges become part of the ground's material: a camera-centred
     texture cache at 2.5 cm–25 cm per texel replaces separate draped meshes.
4. **Structures as their own geometry.** Bridges, underpasses, culverts, quay walls, building
   plinths and cliffs are separate meshes and separate simulated surfaces, not terrain. A unit
   can stand on a deck or pass below it.

The brief's other alternatives rank 2nd to 4th:

- **(1) The current heightfield, drawn adaptively, with procedural detail.** Lowest risk, and its
  renderer becomes stage 3 of the migration, but it keeps the lattice-bound features.
- **(2) A constrained triangulation built from the DEM and OSM.** Exact edges, but slow,
  awkward to query and to stream, and fragile at Amsterdam's scale.
- **(3) A heightfield with volumetric or distance-field geometry.** Solves overhangs and caves
  the simulation does not need, at a large cost in queries, memory and complexity.

**Migration in six stages, each shippable, with the 2D map working throughout:**

1. Put the terrain behind query interfaces.
2. Prototype in an isolated lab page.
3. Draw today's surface through the new level-of-detail renderer.
4. The new material and surface detail.
5. The terrain field as a new authoritative terrain model.
6. Layered surfaces under bridges, and streaming.

**Stage 1 changes no behaviour, and the prototype comes before any commitment.**

**The biggest uncertainties, to settle in the prototype:**

- Line-of-sight and viewshed cost on a 0.5 m surface. Today a 300 m sight line takes 48–437 µs.
- Memory, and how worker copies scale. Today one graded Amsterdam copy is 209–279 MB.
- Field generation time.
- Bit-identical results across browsers, which rules out `Math.sin`, `Math.exp` and similar in
  the field.
- The browser's frame budget for the near-field material on the integrated GPU available here.

---

## 1. Current architecture assessment

### 1.1 Data and pipeline (verified)

| Stage             | What happens                                                                                                                                                                                                                                                                                                   | Where                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Import            | AWS Terrain Tiles (Terrarium PNG), at the lowest zoom whose pixels are ≤ cellSize/2 (z15 at mid-latitudes, about 3.7 m/px at Quantico). Each grid point is projected UTM → WGS84 → Web Mercator, interpolated bilinearly, gaps filled, rounded to 1 cm.                                                        | `geo/terrarium.ts:67-185`, `geo/tiles.ts:10`                 |
| Elevation sources | Read from the tile headers and mapped: NED 3/10 m (DTM), SRTM 30 m (DSM), EU-DEM 25 m (DSM), UK lidar 2 m, …                                                                                                                                                                                                   | `geo/elevation-sources.ts`, ADR 0014                         |
| Grid              | `DEFAULT_CELL_SIZE_M = 10`, so 501 × 501 = 251,001 samples for 5 km, stored as a plain `number[]`, row-major, rows running south to north. Local UTM frame, origin at the centre.                                                                                                                              | `geo/package.ts:45-47`, `sim/terrain.ts:30`                  |
| Package           | The raw terrain plus OSM/Overture features, in IndexedDB (`ambush` v2); the id is a content fingerprint.                                                                                                                                                                                                       | `geo/package.ts`, `acquire/store.ts`                         |
| Cleaning          | Repairs invalid samples, pits and spikes (`dem-clean-v1`).                                                                                                                                                                                                                                                     | `sim/dem-quality.ts`                                         |
| Grading           | Roads (major, paved, unpaved), building pads, and water levels, beds and banks are written into the lattice as lower and upper bounds per fine node. Cells are refined ×4 to 2.5 m where the corners cannot hold the result. **Recomputed at every load in a worker, never stored.**                           | `sim/grading.ts`, `sim/water-grading.ts`, ADRs 0032 and 0040 |
| Surface           | `sampleSurface`: linear on two triangles per cell (SW–NE diagonal), and the same on the fine lattice inside refined cells. **Every consumer reproduces it bit for bit.**                                                                                                                                       | `sim/terrain-surface.ts:43-86`                               |
| 3D mesh           | `surfaceMesh`: one vertex per sample, unrefined cells next to refined ones fanned from their centre. **One mesh, one draw call, no level of detail, no tiles, built on the main thread.**                                                                                                                      | `sim/terrain-surface.ts:178-335`, `view3d/terrain-mesh.ts`   |
| Features in 3D    | Roads, paths and unlevelled water are **draped**: clipped to every terrain triangle and lifted 6 cm (roads) or 3 cm (water). Buildings take their walls down to the lowest ground. Bridges come from `planBridges` in the simulation. As of ADR 0046, the shore is cut in the shader and quay walls are added. | `view3d/drape.ts`, `geo-features.ts`                         |
| Ground material   | 11 layers. Baked weight map of `MIN_TEXEL_M = 2.5`, capped at 1280² (about 3.9 m/texel at 5 km). 512 px albedo and 256 px normal texture arrays tiled every 1.6–2.8 m, two rotated tilings, no triplanar mapping.                                                                                              | `view3d/ground-map.ts`, `ground-material.ts`                 |
| Camera            | Orbit camera: minimum distance 15 m, at least **2 m above the ground**, at most 88° from straight down.                                                                                                                                                                                                        | `view3d/camera-math.ts:37-43`                                |
| 2D                | Hillshade with one pixel per base sample (refinement ignored); contours traced on `surfaceMesh`; spot heights.                                                                                                                                                                                                 | `view2d/terrain-layer.ts`                                    |

### 1.2 Who depends on the terrain (verified)

- **Height:**
  - `heightAt` and `surfaceHeightAt` (which returns the deck over impassable water).
  - Movement sets each soldier's `position.z` at every position update, at 30 Hz.
- **Line of sight:**
  - `traceSightLine` is exact: it cuts the line at every coarse and fine grid crossing and
    every diagonal.
  - `sightLineTracer` is a fast version that must give identical results (ADR 0020).
  - Combat calls `lineOfSight` for each candidate target.
- **Viewsheds:** 4 m cells (8 m while dragging), limited to the firing arc (ADR 0042), and run
  in workers that each hold a full copy of the terrain.
- **Navigation:**
  - A 2 m grid of obstacles (buildings and impassable water) only. **No elevation or slope is
    used.** Bridges are linked in (ADR 0043).
  - Movement speed does not depend on slope.
- **Fingerprints:**
  - `fingerprintWorld` hashes the whole `TerrainDataset`, refinement and water levels
    included.
  - A snapshot restore refuses a different terrain.
  - Scenarios record `terrainModel` (`dem-clean-v1+graded-v3`).
- **Replay:** recordings store full `SimState` frames, including `position.z`. They do not hold
  a terrain fingerprint.
- **Exact-equality tests a replacement must keep passing, or replace deliberately:**
  - `sim/determinism.test.ts`, `grading.test.ts`, `sight-tracer.test.ts`
  - `view3d/graded-terrain.test.ts`, `terrain-mesh.test.ts`
  - `app/terrain-consistency.test.ts`, which checks that 2D `elevationAt`, 3D `terrainGround`
    and `heightAt` agree at 5000 points.
- **No query interface.** Consumers call free functions on the frozen `TerrainDataset`, cached in
  WeakMaps. These read the raw `heightfield` or `refinement`, or assume the grid layout:
  - `sim/los.ts:143-184` and `sim/sight-tracer.ts:308-315`
  - `view3d/terrain-mesh.ts:44-67,168`, `view3d/drape.ts:105-115`, `view3d/ground-map.ts:610`,
    `view3d/landcover.ts:195`, `view3d/shoreline.ts:534`
  - `view2d/terrain-layer.ts` (lines 26-54, 64-77, 187-205 and 239)
  - `app/start-screen.ts:99`
  - `sim/combat.ts:356`, `sim/viewshed.ts:91`, `view2d/viewshed.worker.ts:71`

### 1.3 Measured baseline (verified, 2026-10-13, Node 24, this machine)

Measured with a temporary harness on the recorded packages (not committed): 1 M random
`heightAt` queries, and 5000 random 300 m sight lines at eye height 1.7 m, target 1.5 m.

|                                                | Quantico         | Grafenwöhr       | Amsterdam             |
| ---------------------------------------------- | ---------------- | ---------------- | --------------------- |
| Grid                                           | 501², 10 m       | 501², 10 m       | 501², 10 m            |
| Roads / buildings / water areas                | 955 / 1273 / 24  | 1211 / 3567 / 47 | 15,646 / 53,377 / 528 |
| Clean + grade                                  | 1.3 s            | 1.2 s            | 11.6 s                |
| Refined cells                                  | 14.0 %           | 19.6 %           | 67.8 %                |
| Surface samples (coarse + fine)                | 1.13 M           | 1.47 M           | 4.49 M                |
| `heightAt`                                     | 80 ns (12.5 M/s) | 91 ns (11.0 M/s) | 169 ns (5.9 M/s)      |
| 300 m sight line (`lineOfSight`)               | 48 µs            | 63 µs            | 437 µs                |
| Graded DEM: median \|Laplacian residual\|      | 3 mm             | 30 mm            | 44 mm                 |
| Samples equal to both west and east neighbours | 48 %             | 1.8 %            | 8.5 %                 |

What the numbers show:

- **The DEM carries almost no metre-scale relief.** The median curvature residual is 3–44 mm, so
  the ground between features is close to planar at 10 m.
- **Half of Quantico's samples sit on exactly flat runs.** That is the levelled water and the
  rounding of very smooth source data.
- **Amsterdam's cost comes from feature density, not from the DEM.** Two-thirds of its cells are
  refined, and a sight line costs 437 µs there.

From the ADRs: Amsterdam in 3D draws 38 calls, 24.75 M triangles and 1633 MB of geometry, with a
peak main heap of 2144 MB (ADR 0046). One graded Amsterdam terrain copy is 209–279 MB (ADR 0045).

### 1.4 What it looks like at eye height (verified, screenshots)

The camera cannot go below 2 m above the ground, so these shots are at that height, taken in
Chrome with a real GPU. They are in
[`docs/research/ground-level-terrain`](research/ground-level-terrain/).

- `current-gg4-town-eye` and `current-gg5-town-eye-b` (Grafenwöhr):
  - The grass is a single flat plane, with a visible repeat a few metres away and no relief.
  - Road verges are flat strips with a hard straight edge.
  - Buildings meet the ground at a perfectly sharp line.
  - Nothing grows at the foot of a wall or a post.
- `current-gg2-river-eye`: the river is a sheet in a rectangular cut with a kerb-like edge.
  A path is a flat brown ribbon.
- `current-gq4-river-eye` (Quantico): the lawn is a planar texture all the way to the kerb, and
  the road is a separate slab whose edge throws a dark line.
- `current-gg1-pond-eye`: a pond whose far shore is a flat sharp line. From 2 m, the gentle
  shoreline needs ground detail and clutter, not a better outline.
- `current-gg6-tactical`: the same place from the tactical camera (300 m, 40°), where all of the
  above reads acceptably.

---

## 2. Root-cause analysis

The visible problems, sorted by what actually causes them. Several have more than one cause.

| Symptom at 1.7 m                     | DEM resolution                                             | Mesh topology                                                                                          | Feature integration                                                                                                          | Materials and detail                                                                  | Camera and pipeline                   |
| ------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------- |
| Coarse, interpolated, faceted ground | **minor**: 10–30 m sources hold no detail below about 20 m | **major**: 10 m linear triangles; smooth normals hide shading facets, not silhouettes                  | —                                                                                                                            | **major**: no micro-relief, no normal or parallax detail at the feet, flat repetition | one mesh, so near density cannot rise |
| Road to ground transitions           | —                                                          | **major**: cross-sections live on a 2.5 m lattice, so edges and slopes stair-step on any diagonal road | **major**: roads and verges are separate meshes 6 cm above the ground, with no blend                                         | weight map at 3.9 m, so no crisp shoulder or gravel edge                              | —                                     |
| Buildings on the ground              | —                                                          | pads and aprons on the 2.5 m lattice, and saw-tooth side slopes                                        | walls stop at the lowest ground; no plinth or skirting; pad versus water conflicts (ADR 0046)                                | no dirt, damp or growth at the base                                                   | —                                     |
| Bridges                              | —                                                          | the heightfield cannot hold two surfaces                                                               | handled well as structures (ADRs 0041, 0043, 0044); the simulation has only `surfaceHeightAt` over water: no underpass layer | —                                                                                     | —                                     |
| Waterways                            | —                                                          | banks at 1.5:1 narrower than the lattice (ADR 0046)                                                    | levelling fights pads and embankments: 4.9 % of Amsterdam's water area                                                       | bed, rock and shingle bands at 3.9 m                                                  | —                                     |
| Smooth, simplistic close up          | **minor**                                                  | —                                                                                                      | no ditches, kerbs, ruts, rocks or hummocks: nothing generates them                                                           | no ground clutter, no grass                                                           | camera limited to 2 m                 |
| Steep slopes                         | **some**: 30 m DSM sources blur cliffs                     | stretched texture: planar projection only, no triplanar                                                | —                                                                                                                            | rock only by slope band                                                               | —                                     |

Conclusions:

1. **Increasing the DEM resolution would not help** (ADR 0014, `TerrainMetadata` comment,
   verified). A finer grid of 10–30 m data adds samples, not information. Where lidar exists
   (Netherlands AHN 0.5 m, UK 1–2 m, US 3DEP 1 m in places), real detail could be had. That is
   an import feature to add later, not the architecture.
2. **Making the lattice finer everywhere would not help either.** Amsterdam is already 68 %
   refined. A 0.5 m uniform lattice is 100 M samples. Edges would still be axis-aligned
   stair-steps unless features are evaluated as continuous shapes.
3. **The deepest cause is that features are written into the lattice as bounds per fine node.**
   A road's cross-section exists only where a lattice node happens to fall. The fix is to
   describe features as continuous shapes (cross-sections over a distance field) and to sample
   them at whatever resolution the consumer needs.
4. **The second cause is that roads, verges and water are drawn as separate surfaces lying on
   the terrain, rather than as the terrain's own material.** Every engine that looks right at
   ground level blends roads into the terrain material with a virtual texture and grades the
   ground under them; it does not drape them:
   - Frostbite's procedural virtual texturing (Widmark 2012);
   - Unreal Engine's Runtime Virtual Texturing with landscape splines;
   - Battlefield-style decal baking.
5. **The third cause is the missing near field:** surface detail, ground clutter, grass, and
   level of detail that would make them affordable.

---

## 3. Research findings

Licences were read from the GitHub API or npm on 2026-10-13. **[LIB]** marks something that can
be adopted directly, **[TECH]** a technique to reimplement.

### 3.1 Commercial engines

- **Unreal Engine Landscape** ([technical guide](https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-technical-guide-in-unreal-engine)).
  - **Structure:** equal square components of 1 or 2×2 sections, each up to 256² vertices. A
    section is both the draw call and the unit of level of detail, and each level is a mip of the
    heightmap texture.
  - **Heights** are 16-bit, scaled per landscape.
  - **Landscape splines** deform the heightmap in the editor (baked): width, falloff and
    raise/lower. They render into **Runtime Virtual Textures**, so roads blend into the ground
    material and suppress grass.
  - **Holes** come from a visibility layer.
  - **Nanite Landscape** builds a Nanite representation alongside the normal data; both stay
    resident.
  - **Lesson [TECH]:** bake the road deformation into the authoritative heights, and blend
    roads in the material, not as overlaid meshes.
- **Unity Terrain** ([TerrainData](https://docs.unity3d.com/ScriptReference/TerrainData.html)).
  - Heightmaps are 2ⁿ+1 up to 4097; larger worlds tile several terrains.
  - A hole mask one texel smaller than the heightmap; physics respects it.
  - `drawInstanced` samples the heights in the vertex shader.
  - RGBA splatmaps, 4 layers each.
  - Road tools (Splines package, EasyRoads3D) generate a road mesh and conform the heightmap under
    it with a falloff band (**unverified** detail).
- **Far Cry 5** (Jeremy Moore, GDC 2018, [vault](https://gdcvault.com/play/1025480/Terrain-Rendering-in-Far-Cry)).
  A GPU pipeline for the heightfield's level of detail, culling and stitching. Procedural cliff
  geometry is separate from the heightfield. **[TECH]**
- **Ghost Recon Wildlands** (GDC 2017, [vault](https://gdcvault.com/play/1024029/)). They settled
  on **50 cm heightmap precision** for a ground-level shooter, with tessellation on top. Roads and
  bridges were generated in Houdini (secondary source). A useful external calibration for the
  0.5 m simulation lattice recommended here.
- **Battlefield 3** (Widmark, GDC 2012,
  [PDF](https://media.contentapi.ea.com/content/dam/eacom/frostbite/files/gdc12-terrain-in-battlefield3.pdf)).
  Quadtree terrain, and **procedural virtual texturing**: decals and roads are composited into a
  cached virtual texture around the camera, with updates prioritised and throttled. **[TECH]**:
  the model for the material cache in §5.4.
- **Horizon Zero Dawn** (van Muijden, GDC 2017,
  [PDF](https://www.guerrilla-games.com/media/News/Files/GDC2017_VanMuijden_GPUBasedProceduralPlacementInHorizonZeroDawn.pdf)).
  GPU placement that is explicitly "data driven, deterministic and locally stable". **[TECH]**
  for vegetation and clutter.

### 3.2 Geospatial

- **Cesium.**
  - [quantized-mesh](https://github.com/CesiumGS/quantized-mesh): TMS quadtree tiles of quantized
    16-bit vertices, with edge-index lists for **skirts**, a water mask and normal extensions.
  - 3D Tiles 1.1 (OGC Community Standard): implicit tiling, and refinement by geometric error
    projected to screen-space error (16 px by default in CesiumJS).
  - **Lesson:** CesiumJS clamps ground features against whichever level of detail is loaded, so
    the result depends on the view. **It is not a deterministic simulation reference.**
    `sampleTerrainMostDetailed` exists for exact sampling.
  - **Libraries [LIB]:** `cesium` (Apache-2.0), cesium-native (Apache-2.0).
- **One World Terrain / OGC CDB (military).**
  - OWT ([Cesium](https://cesium.com/industries/mission-support/owt/)) is a 3D Tiles extension.
  - [OGC CDB](https://docs.ogc.org/is/15-113r6/15-113r6.html) is a tiled, levelled store designed
    so that every simulator **correlates** on the same source tiles.
  - **Principle adopted here:** the simulation must never query a render level of detail. It uses
    the finest canonical surface, so changing the level of detail cannot change outcomes.
- **Arma / Real Virtuality** (BI community wiki, [terrain problems](https://community.bistudio.com/wiki/Arma_3:_Common_Terrain_Creation_Problems)).
  - A regular height grid (for example 4096² at 10 m), with 1 m/px satellite and mask imagery.
  - **Roads are objects** from shapefiles. Authors flatten the heightmap separately.
  - Models carry **separate geometry, fire and view LODs** for collision, ballistics and line of
    sight. That decouples simulation geometry from what is drawn, which is the same split as
    "structures are their own simulated surfaces" here.
- **VBS / Blue IG** ingests 3D Tiles and offers collision, height-above-terrain and laser
  rangefinder queries; its internals are **unverified**. Steel Beasts and OneSAF: **unverified**.

### 3.3 Level-of-detail algorithms (all [TECH])

| Algorithm                                                                | Fit for WebGL2    | Notes                                                                                                                                                                                                        |
| ------------------------------------------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **CDLOD** (Strugar 2009; [code](https://github.com/fstrugar/CDLOD), MIT) | **best**          | Quadtree selected by distance. One grid mesh instanced per node. Vertices morph in the shader, so no popping and no stitching. Heights come from vertex texture fetch, which WebGL2 guarantees (≥ 16 units). |
| Geometry clipmaps (Losasso & Hoppe 2004; GPU Gems 2 ch. 2)               | good              | Nested rings around the camera. Very cheap and well suited to one camera, but awkward for a free tactical view at 5 km, and updates rings toroidally.                                                        |
| Chunked LOD (Ulrich 2002)                                                | fair              | Precomputed meshes per chunk with skirts. Good for static triangulated meshes (Martini/Delatin tiles).                                                                                                       |
| ROAM                                                                     | no                | Split and merge on the CPU; obsolete.                                                                                                                                                                        |
| Hardware tessellation                                                    | **not available** | Neither WebGL2 nor WebGPU has tessellation, geometry or mesh shaders. Detail comes from finer pre-built grids.                                                                                               |

### 3.4 Web and Three.js

- **three** r186 (MIT):
  - `WebGPURenderer` (`three/webgpu`) falls back to WebGL2, and TSL compiles to WGSL and GLSL.
    Whether it is production-stable is **unverified**.
  - `BatchedMesh` uses `WEBGL_multi_draw`.
  - WebGPU multi-draw-indirect is still behind a flag (Chrome 131 blog); plain `drawIndirect` is
    core.
- **Mesh builders [LIB]:** `@mapbox/martini` (ISC) builds right-triangulated irregular networks
  from 2ⁿ+1 grids; `delatin` (ISC) builds greedy Delaunay networks. Useful for far-field tiles, or
  for a 2D/overview mesh.
- **Constrained triangulation [LIB]:**
  - `@kninnug/constrainautor` 4.1.0 (ISC, maintained) on `delaunator` 5.1 (ISC) is the best fit.
  - `poly2tri` (BSD-3) and `cdt2d` (MIT, inactive since 2019).
  - **Avoid Shewchuk's Triangle**: it cannot be included in commercial products without a
    licence.
- **Terrain viewers:** `geo-three` (MIT; quadtree tiles with height providers),
  `3d-tiles-renderer` (Apache-2.0; 3D Tiles and quantized-mesh for three.js), `three-geo` (MIT),
  `THREE.Terrain` (MIT), iTowns, MapLibre and deck.gl.
  - **None of them can render a surface they did not generate, or keep it exactly equal to a
    simulation's surface.** This confirms the 2026-10-11 conclusion: write the terrain renderer
    ourselves on three.js.
  - `3d-tiles-renderer` is a candidate for a far-field backdrop beyond the battlefield, which is
    not simulated.
- **Noise [LIB]:** `fastnoise-lite` (MIT) and `simplex-noise` (MIT).
  - Both use floating-point arithmetic, and some paths use `Math` transcendental functions.
    Cross-engine bit equality is **not guaranteed** (see §10).
  - **Recommendation:** write a small integer-hash noise in-house (about 150 lines). It only
    needs `+ − × ÷` and `Math.floor`, which IEEE 754 makes exact.

### 3.5 Synthesis and erosion

- **Erosion:**
  - Lague, Hydraulic-Erosion (MIT): droplet erosion on the CPU, deterministic with a seeded RNG.
  - `dandrino/terrain-erosion-3-ways` (MIT, Python).
  - Mei et al. 2007: GPU pipe-model erosion. Not bit-deterministic across GPU vendors.
- **Surveys and papers:** Galin et al. "A Review of Digital Terrain Modeling" (EG 2019 STAR);
  Guérin et al. 2016 and 2017; Cordonnier et al. 2016.
- **Assessment:** erosion and learned amplification invent landforms. On real terrain they
  would move valleys and ridges that a soldier on the ground would recognise, and erosion would
  have to run over the whole battlefield before anything could be sampled.
- **Recommendation:** use **no global erosion**. Small-scale relief should be band-limited noise
  (wavelengths 2–30 m, amplitude 0.1–1 m, shaped by land use and suppressed near constraints)
  that cannot shift the DEM's own shape. Erosion-like effects (rills, gullies) can come later as
  local, deterministic stamps.

### 3.6 Roads and terrain (all [TECH])

- Galin et al. "Procedural Generation of Roads" (CGF 2010,
  [PDF](https://perso.liris.cnrs.fr/egalin/Articles/2010-roads.pdf)) carves the terrain along a
  path and places parametric bridge and tunnel models.
- The standard cut-and-fill model is the signed distance to the centreline:
  - inside the half-width, the road's own profile;
  - over the shoulder and side slope, a slope-clamped blend back to the ground (cut where the
    ground is above the road, fill where it is below).

  This is what `grading.ts` already computes, but **evaluated at lattice nodes rather than as a
  function**.

### 3.7 Distance fields and voxels

- **Transvoxel** (Lengyel; [tables](https://github.com/EricLengyel/Transvoxel), MIT) gives
  seamless level-of-detail stitching for marching cubes. Godot Voxel Tools (MIT) uses it.
- **Dual contouring** and **surface nets** are the other meshing options.
- **Engine practice:** keep a heightfield for the bulk of the terrain, punch holes in it, and
  insert local meshes for cliffs, caves, tunnels and bridges. Full voxel terrain is kept for
  destructible or cave-heavy worlds.

### 3.8 Surface detail (all [TECH])

- **Height-based blending** ([Mishkinis](https://www.gamedeveloper.com/programming/advanced-terrain-texture-splatting)):
  the layer whose height plus weight is greatest wins, within a narrow band. Gravel shows between
  cobbles and grass grows in cracks.
- **Histogram-preserving stochastic tiling** (Heitz & Neyret, HPG 2018) removes repetition for
  about 3 texture fetches.
- **Triplanar mapping:** three times the samples, so use it only above a slope threshold.
- **Parallax occlusion mapping:** 8–32 dependent fetches per pixel, so only for the near field,
  fading out within tens of metres.
- **Detail normals:** combined with reoriented normal mapping (RNM) or UDN blending.
- **Limits:**
  - WebGL2 guarantees 256 array layers and 2048 px textures; real devices typically have
    4096–16384.
  - WebGPU's defaults are 8192 px and 256 layers.
  - **Neither has sparse textures, so a virtual texture must be done in software:** an
    indirection texture plus a page cache.

### 3.9 Physics and determinism

- **Rapier:**
  - Cross-platform determinism needs the `enhanced-determinism` build
    (`@dimforge/rapier3d-deterministic`, Apache-2.0).
  - `dimforge/rapier.js` was archived on 2026-07-12; the bindings moved into `dimforge/rapier`.
- **Jolt** (MIT): deterministic across platforms with `CROSS_PLATFORM_DETERMINISTIC`. Whether the
  npm build has it is **unverified**.
- **Recommendation:** do not let line of sight, height or navigation depend on a physics engine.
  The exact tracer approach of ADR 0020 already gives deterministic, testable answers. A physics
  engine, if one is ever needed for vehicles or ragdolls, should collide against tiles generated
  from the same surface.

---

## 4. Architecture comparison

Alternatives (the brief's 1–4, plus the variant recommended here):

- **A1. Enhanced DEM heightfield.** Today's model, drawn with level of detail and finer
  refinement, with procedural detail added only in rendering.
- **A2. Constrained triangulation.** A TIN built from DEM points and OSM edges (roads, pads,
  shores) with a constrained Delaunay library, with procedural points added. Simulation and
  render share the triangles.
- **A3. Heightfield plus local volumes.** A1 or A4, plus local volumetric or distance-field
  regions meshed with Transvoxel or surface nets for banks, cuttings and bridges.
- **A4. Chunked procedural terrain.** Tiles at several resolutions generated by a procedural
  pipeline, with surface detail drawn independently.
- **A4★. Constraint-based terrain field (recommended).** A4, with:
  - an analytic field that is the single source;
  - a canonical simulation lattice;
  - level of detail that only reads that lattice;
  - a material cache around the camera;
  - structures as separate simulated surfaces.

Scores run from 1 (poor) to 5 (excellent); they are judgements, explained below the table.

| Criterion                                     | A1                | A2                                               | A3  | A4 (loose) | **A4★**                                     |
| --------------------------------------------- | ----------------- | ------------------------------------------------ | --- | ---------- | ------------------------------------------- |
| Ground-level visual quality                   | 2                 | 3                                                | 4   | 4          | **4–5**                                     |
| Geographic accuracy (follows the DEM and OSM) | 4                 | **5**                                            | 4   | 3          | 4–5                                         |
| Three.js compatibility                        | **5**             | 4                                                | 3   | 4          | 4                                           |
| WebGL2 now, WebGPU later                      | **5**             | 4                                                | 3   | 4          | 4                                           |
| CPU and GPU performance                       | 3                 | 2                                                | 1   | 4          | **4**                                       |
| Memory                                        | 3                 | 2                                                | 1   | 4          | **4** (lazy tiles)                          |
| Determinism                                   | **5**             | 3 (robust constrained triangulation is delicate) | 2   | 3          | **4** (needs disciplined arithmetic)        |
| Runtime generation cost                       | 4                 | 2                                                | 1   | 3          | 3                                           |
| Simulation query speed                        | 4                 | 2 (point location, irregular tracer)             | 1   | 3          | **4** (regular lattice and min/max pyramid) |
| Ease of integrating OSM features              | 2 (lattice-bound) | 3 (edge constraints, robustness)                 | 3   | 3          | **4** (distance-field cross-sections)       |
| 5 × 5 km                                      | 4                 | 3                                                | 2   | 4          | **4**                                       |
| Larger areas                                  | 2                 | 2                                                | 1   | 4          | **4**                                       |
| Implementation complexity (5 = simple)        | **4**             | 2                                                | 1   | 3          | 2–3                                         |
| Migration risk (5 = low)                      | **5**             | 2                                                | 1   | 3          | 3 (staged)                                  |

**Ranking and reasoning:**

1. **A4★, the constraint-based terrain field.** The only option that removes the lattice from
   feature shapes and the separate draped meshes, while keeping a regular, fast, exactly traceable
   simulation surface.
   - It turns today's grading rules into functions: the slopes, pads and water rules of ADRs 0032
     and 0040 are kept, as functions instead of node bounds.
   - It gives level of detail and streaming a natural unit, the tile.
   - Its weaknesses are generation cost, the memory of a 0.5 m lattice, and arithmetic
     discipline. All three can be measured in the prototype.
2. **A1, the enhanced heightfield.** Cheapest and safest, and its renderer (CDLOD over
   tiles) is exactly stage 3 of the A4★ migration, so the work is not lost. Alone, it cannot fix
   lattice-bound roads, pads or banks, and render-only detail would contradict the simulation
   beyond a few centimetres.
3. **A2, the constrained triangulation.** Exact edges with few triangles, which suits flat
   roads. Its costs:
   - Every simulation query becomes point location in an irregular mesh, and the exact tracer
     must be rewritten for arbitrary triangles.
   - Level of detail needs per-tile simplification with crack handling.
   - Procedural relief fits a TIN badly.
   - Robust constrained Delaunay with Amsterdam's 53 k buildings and 15.6 k roads is a large
     robustness and determinism risk.

   A4★ gets the same edge quality from distance fields evaluated at the sample position, and
   from the material cache.

4. **A3, the heightfield with volumes.** Overhangs, caves and tunnels are rare in the
   battlefields Ambush! models, and bridges are better as structures (§5.6). Voxel surfaces turn
   `heightAt` into a ray search and line of sight into volume traversal; they multiply memory and
   need Transvoxel-class seams. Reserve local meshes, not volumes, for the rare cliff or culvert.

A4 without the ★ refinements ("procedural chunks, detail independent") risks exactly what the
brief forbids: rendered geometry the simulation does not know. The difference is the contract in
§5.2.

---

## 5. Recommended architecture

### 5.1 Layers

```
Layer A  Sources (unchanged)         battlefield package: raw DEM grid, OSM/Overture features, georef
            │  (import, IndexedDB, coordinate frames as today; ADRs 0006 and 0014)
Layer B  Terrain field (src/sim)     TerrainFieldSpec = compile(package, modelVersion, seed)
            │   base(x,y): cleaned DEM, C¹ interpolation
            │   stamps: roads, pads, water, banks, ditches, embankments (distance-field cross-sections)
            │   relief(x,y): seeded, land-use shaped, constraint-suppressed
            ▼
Layer D  Simulation surface (src/sim)  SimSurface: 0.5 m lattice in 64 m tiles, lazy, cached,
            │   min/max pyramid; heightAt, traceSight, viewshed, navigation inputs;
            │   structures: bridge decks and underpasses as extra surfaces
            ▼
Layer C  Rendering (src/view3d)      CDLOD over SimSurface tiles; material cache (roads, edges,
                                     land use); surface detail ≤ tolerance; clutter and vegetation
2D view (src/view2d)                 hillshade, contours and spot heights from SimSurface tiles
```

The arrows only go downward. Rendering may add detail but never moves the ground by more than
the stated tolerance. The 2D view and the 3D view read the same simulation surface.

### 5.2 The contract: one world, with explicit tolerances

1. **The simulation surface is authoritative.** It is piecewise-linear on a regular lattice of
   spacing _s_ (0.5 m target, 1 m fallback, chosen in the prototype), split SW–NE like today.
   Every simulation query (height, line of sight, viewshed, placement, navigation and later
   slope cost) uses it, never a render level of detail. This is the correlation principle of
   OGC CDB and One World Terrain.
2. **Gameplay-significant detail is in the simulation surface.** Anything that can hide a prone
   soldier, change a line of fire or shape movement is generated by the field and sampled into
   the lattice: ditches, embankments, cuttings, berms, kerb-height steps of 10 cm or more, banks
   and hummocks. A prone soldier's silhouette is about 0.3–0.4 m (**assumed**).
3. **Render-only detail is bounded:** |rendered geometry − simulation surface| ≤ ε_geom = 3 cm
   anywhere the finest render level is drawn. Detail finer than the lattice lives in normal maps,
   parallax and instanced clutter (grass, pebbles, leaf litter). It can conceal visually, but it
   is never a sight obstruction in the simulation.
   - **Open question:** clutter concealment could be added to the simulation later as a
     concealment value, like vegetation's `seeThroughMeters` today, but not as geometry.
4. **Level-of-detail error is a render-only, distance-bounded effect.** Coarser render levels
   may differ from the simulation surface by their geometric error (target ≤ 2 px on screen).
   Units are drawn at their simulated height. Where a coarse level would bury or float a distant
   unit marker, the marker is snapped to the drawn surface in the shader, which is display only.
5. **Determinism:** the field is a pure function of
   (package id, `TERRAIN_FIELD_VERSION`, parameters, seed).
   - It uses only `+ − × ÷ Math.sqrt Math.floor Math.abs Math.min Math.max` and integer
     hashing, all exact under IEEE 754.
   - It uses **no** `Math.sin`, `cos`, `exp`, `pow` or `atan2`, whose results the ECMAScript
     standard leaves to each implementation.
   - The arithmetic is float64, with a fixed order of operations (no reassociation through
     `reduce` over unordered collections).
   - Golden tile hashes are checked in Node and in Chrome, Firefox and Edge.

### 5.3 Layer B: the terrain field

- **Base.** The cleaned DEM (`dem-clean-v1`), interpolated with a monotone C¹ scheme, for example
  bicubic Catmull–Rom with an overshoot clamp. Bilinear interpolation shows 10 m creases in its
  slope at ground level.
  - This changes `heightAt` everywhere by at most a few decimetres on curved ground (**assumed**;
    to be measured). That is why it is a new terrain model and not an edit to the current one.
- **Stamps.** Each feature becomes a cross-section function of the signed distance d (and of
  position along the feature):
  - **Road:** carriageway, crown and camber; shoulder; optional kerb; ditch; then fill or cut
    side slope back to the base. Today's `FILL_SLOPE` and `CUT_SLOPE` are kept, and so are the
    junction pinning and profile smoothing in `grading.ts`, run once per road chain to give the
    profile along it.
  - **Building:** pad level (the median ground, as today), apron, then side slopes. The building
    gets a plinth mesh down to the pad, so it never floats.
  - **Water:** level, freeboard and bed profile per class (ADR 0040), with banks per class.
    Quays become stamps that hold a vertical step; the step is drawn as a wall structure.
  - **Railways, dykes and levees** later, as further cross-sections.
- **Composition:** stamps are applied in a fixed priority order, the same as today's:
  1. water bed;
  2. road carriageway;
  3. building pad;
  4. slopes, combined by min and max, settling halfway where cut and fill conflict.

  Conflicts like those measured in ADR 0046 are then **resolved in the field, by rule**: a pad
  inside water yields to the water, and a building in water gets a pile or plinth structure.
  Today's grading leaves them halfway.

- **Relief.** Two or three octaves of integer-hash gradient noise, 2–30 m wavelengths and
  0.1–1 m amplitude, shaped by land use:
  - fields: furrows, along the existing furrow direction in `ground-map`;
  - woods: hummocks and root mounds;
  - heath: tussocks;
  - urban, roads, pads and water: none.

  It fades to zero within each stamp's reach, so constraints stay exact.

- **Speed:** stamps are indexed per 64 m tile (the `BUCKET_M` idea of ADR 0020). Evaluating one
  sample touches only the stamps that reach that tile.

### 5.4 Layer C: rendering

- **Geometry (CDLOD):**
  - One 64 × 64-quad grid patch, instanced per selected quadtree node, in one draw call per
    level, or a single instanced draw.
  - Heights come from a `DataArrayTexture` atlas of simulation tiles; the vertex shader fetches
    them. Levels morph in the vertex shader, and skirts remain as a fallback.
  - Suggested levels and ranges at a 1.7 m eye height on a 1080p screen. One pixel at distance
    d covers about 0.73 mm × d across, and about d² × 0.43 mm along the ground:

    | Level | Spacing                                | Morph range                       | Purpose                                  |
    | ----- | -------------------------------------- | --------------------------------- | ---------------------------------------- |
    | 0     | _s_ (0.5 m), or 0.25 m with detail ≤ ε | 0–32 m                            | feet to near field: kerbs, ditches, ruts |
    | 1     | 1 m                                    | –64 m                             |                                          |
    | 2     | 2 m                                    | –128 m                            |                                          |
    | 3     | 4 m                                    | –256 m                            |                                          |
    | 4     | 8 m                                    | –512 m                            |                                          |
    | 5     | 16 m                                   | –1 km                             |                                          |
    | 6     | 32 m                                   | –2 km                             |                                          |
    | 7     | 64 m                                   | beyond, and the tactical overview |                                          |

    With a 64 m node and these ranges, about 0.5–0.8 M vertices are drawn per frame before
    frustum culling (**assumed**, ring arithmetic). Today Amsterdam draws 24.75 M triangles,
    1.6 GB of which is geometry. **The near field is cheap; the cost moves into materials,
    clutter and vegetation.**
- **Material cache (a software virtual texture, after Battlefield 3):**
  - A small stack of camera-centred material textures:
    - 2.5 cm/texel over 50 m;
    - 10 cm/texel over 200 m;
    - 50 cm/texel over 1 km;
    - the existing 3.9 m weight map beyond.
  - Each holds material ids and weights, a wetness term and a height-blend parameter.
  - They are rendered (or composited in workers) from the same stamps: the road surface, its
    edge wear and gravel shoulder; verges, kerbs and markings (ADR 0037); land-use boundaries;
    tracks and paths.
  - Updated toroidally as the camera moves, with a fixed budget per frame.
  - **This replaces draped road, path and verge meshes in the ground**, which removes the
    6 cm-offset seams and z-fighting entirely. Bridge decks stay meshes.
- **Surface shading** (the existing `MeshStandardMaterial` extension, or TSL nodes under
  WebGPU):
  - PBR texture arrays at 1024–2048 px for the near layers, about 1 mm/texel at the feet;
  - stochastic tiling (Heitz–Neyret);
  - height-based blending;
  - detail normals;
  - triplanar mapping above about 35° slope;
  - parallax occlusion mapping for gravel, cobbles and mud within about 15 m.
- **Clutter and grass:** GPU-instanced grass cards or blades and pebbles in 8–16 m cells within
  about 30–60 m. Placement is deterministic per cell, from the field's land use and the material
  cache, and excludes roads, pads and water by the same stamps. They fade with distance, and
  wind animation is display only.
- **The camera:** add a ground-level mode (eye at the simulation surface + 1.7 m, near plane
  5–10 cm) next to the tactical orbit camera. This is display only.

### 5.5 Layer D: the simulation surface

```ts
// src/sim/terrain/ — no Three.js, no DOM; usable in workers and Node.
export interface TerrainSurface {
  readonly modelId: string; // e.g. 'field-v1+s0.5'
  readonly fingerprint: string; // hash of the inputs + modelId, plus golden tile hashes
  readonly bounds: Bounds;
  readonly latticeM: number; // s
  heightAt(x: number, y: number): number; // ground (layer 0); throws off the terrain
  surfacesAt(x: number, y: number): readonly SurfaceLayer[]; // ground + decks/underpasses, sorted by z
  traceSight(a: Vec3, b: Vec3): SightLineHit | null; // exact on the lattice + features + structures
  tile(key: TileKey): Promise<HeightTile>; // Int32 cm or Float32, (64/s + 1)² samples, plus min/max
  pyramid(key: TileKey, level: number): MinMaxTile;
}
export interface TerrainField {
  // Layer B; sampled only through TerrainSurface
  readonly spec: TerrainFieldSpec;
  sample(x: number, y: number): number; // continuous; used to build tiles
  materialAt(x: number, y: number): MaterialSample; // for the material cache, 2D tints and clutter
}
```

- **Tiles:** 64 m (129² samples at 0.5 m). Generated lazily in workers from the field (pure,
  so any worker can make any tile and get the same bytes). Kept in an LRU cache, and optionally
  persisted in IndexedDB keyed by (package id, `modelId`, tile).
  - The whole battlefield at 0.5 m is 100 M samples, about 400 MB as Int32 or Float32. It is
    **never held resident in full**.
  - Line of sight and viewsheds touch only the tiles along their rays: a 600 m firing arc is
    about 30–60 tiles.
- **Tracing:** today's exact cut-sequence tracer, generalised to the lattice spacing, with a
  **min/max pyramid** per tile so whole tiles and sub-blocks are rejected when the ray passes
  above their maximum.
  - Equality with a reference tracer stays a test, as in ADR 0020.
- **Structures as surfaces:** bridge decks (ADR 0043), plus underpasses and culverts as
  `SurfaceLayer`s.
  - A unit has a layer index, either part of its state or derived deterministically from its path.
  - `surfaceHeightAt` generalises to `surfacesAt` plus the unit's layer.
  - This is what lets one unit cross a bridge while another passes under it. It needs a small,
    tested change to the simulation state (stage 6).
- **Navigation:** unchanged at first. It reads obstacles, as today. Slope and ditch costs can
  then be added deliberately, as a separate, justified behaviour change.
- **2D view:** the hillshade and contours come from the tiles at 2–5 m. The 2D map then shows
  the same ground the simulation uses; today it ignores the refinement.

### 5.6 Special features

| Feature      | In the field (simulation)                                                                                                                                                     | In rendering                                                                                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Buildings    | Pad stamp at the median ground, with apron and slopes. A pad in water yields to the water.                                                                                    | Plinth mesh from the pad down to the lowest ground minus 0.3 m; dirt and damp band in the material cache; clutter at the base. Never buried: the plinth always covers the pad's edge. |
| Roads        | Carriageway with crown, shoulder, kerb, ditch, cut or fill slope, as one continuous cross-section; junctions and profile as in today's grading.                               | Surface, edges, markings and wear in the material cache. Kerbs higher than ε are part of the field; tiny kerbs are normal-mapped. No separate draped mesh.                            |
| Bridges      | Decks and abutments are **structures**. The ground under the deck is the natural ground or the water bed, never filled. Abutments are stamps where the deck meets the ground. | Deck, piers and railings as meshes (ADRs 0041 and 0044). A unit under the deck is on layer 0, a unit on it on the deck's layer.                                                       |
| Waterways    | Level, bed and banks per class as a stamp; shores at sub-lattice precision because the stamp is evaluated at each sample, not snapped to a coarse lattice.                    | Opaque water (ADR 0046). Shore wetness, shallows and bank materials in the material cache. Quays as structures. The ADR 0046 shader cut becomes unnecessary.                          |
| Vegetation   | Vegetation areas as today: line-of-sight obscuration. Optional root mounds and hummocks in the relief.                                                                        | Trees placed on the simulation surface. Clutter and grass in the near field, excluded by stamps.                                                                                      |
| Steep slopes | Base interpolation and slopes as generated. Cliffs higher than the lattice can resolve become **cliff structures**, like Far Cry 5 (rare here).                               | Triplanar rock above about 35°, and rock clutter at the slope's foot.                                                                                                                 |

---

## 6. Module boundaries and interfaces

```
src/geo, src/acquire     unchanged: package, frames, IndexedDB
src/sim/terrain/         NEW home of the authoritative ground
  field/                 spec compile, base interpolation, stamps, relief, int-hash noise
  surface/               TerrainSurface, tiles, LRU, min/max pyramid, tracer, structures
  legacy/                adapter: the current TerrainDataset model behind TerrainSurface
src/sim/*                consumers depend on TerrainSurface only (heightAt, traceSight, …)
src/view3d/terrain/      NEW: CDLOD renderer, tile texture atlas, material cache, clutter
src/view3d/*             features read TerrainSurface / TerrainField; no raw arrays
src/view2d/*             hillshade, contours and spot heights from TerrainSurface tiles
```

Rules:

1. `src/sim/terrain` imports nothing from `view*` or `three`, which keeps ADR 0001's layering.
2. Raw `heightfield.elevations` and `refinement` reads are confined to `legacy/`, the importer and
   the field compiler. The list in §1.2 is the work list for stage 1.
3. Every per-terrain cache stays keyed by the frozen terrain object, as with today's WeakMaps.
4. Tiles cross worker boundaries as transferable `ArrayBuffer`s.
   - A `SharedArrayBuffer` needs cross-origin isolation (COOP/COEP headers). GitHub Pages cannot
     set them (**assumed**), and a service-worker shim would be required, so it is not assumed
     here.

---

## 7. Performance strategy

| Budget (initial, to be validated)                                     | Target                                                                                                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Frame time, tactical and 1.7 m cameras                                | ≤ 16.7 ms p95 at 1080p on a mid-range gaming GPU (RTX 3060 class, **assumed**); ≤ 33 ms on the AMD 880M integrated GPU available here |
| Terrain draw calls                                                    | ≤ 10 (instanced CDLOD) + ≤ 20 clutter and grass                                                                                       |
| Terrain vertices drawn                                                | ≤ 1 M                                                                                                                                 |
| GPU memory, terrain (height atlas + material cache + material arrays) | ≤ 256 MB                                                                                                                              |
| Simulation tile cache per worker                                      | ≤ 64 MB (about 250 tiles at 0.5 m)                                                                                                    |
| Field generation                                                      | ≤ 5 ms per 64 m tile per worker; the area around the camera and the units ready in ≤ 2 s                                              |
| `heightAt`                                                            | ≥ 5 M/s warm (today 6–12.5 M/s)                                                                                                       |
| 300 m sight line                                                      | ≤ 100 µs median on Grafenwöhr-like terrain (today 63 µs), and no slower than today on Amsterdam                                       |
| Viewshed in the firing arc (4 m cells, 600 m)                         | ≤ 2× today's ADR 0042 times                                                                                                           |

Techniques:

- Quadtree selection on the main thread is cheap. Tile generation, material cache compositing
  and clutter placement run in workers.
- Tiles upload to a fixed atlas with an LRU policy and a fixed upload budget per frame.
- Material cache updates are toroidal and spread over several frames.
- Geometry stays a handful of shared instanced patches. There is no per-battlefield
  1.6 GB mesh any more: the ADR 0045 memory pressure goes away for the ground.
- Streaming follows the camera and the units. Gameplay never waits for a render tile: the
  simulation requests its own tiles synchronously from its worker's cache, or generates them
  inline.
- The min/max pyramid accelerates line of sight, viewsheds, picking and camera ground
  clearance.
- **Continuous first-person movement over larger areas:** the same quadtree and tile keys extend
  beyond 5 km. A floating origin, recentred every few km, keeps float32 GPU precision (today's
  absolute float32 positions at 2.5 km are fine, at about 0.25 mm). The simulation stays float64
  in the local UTM frame. Areas larger than one UTM zone are out of scope.

---

## 8. Prototype specification

**Goal:** prove or refute A4★ on one real 1 km × 1 km area before any commitment, without
touching the game.

- **Where it lives:** a lab page (`#terrain-lab`) and `src/sim/terrain-lab` and
  `src/view3d/terrain-lab`, imported by nothing else. Delete it or promote it after review.
- **Area:** one window of a recorded package containing:
  - a road through uneven ground;
  - a building on a slope;
  - a bridge over a waterway;
  - a natural shore;
  - woods;
  - open ground.

  Candidates are around Grafenwöhr's river (373, 248), whose screenshots show houses, a river,
  roads and woods, or Quantico's creek (502, 803). A small script should scan a package for the
  1 km window that satisfies all six; that this window exists is **unverified**.

- **Built:**
  1. The field compiler (base, road / pad / water / bank stamps, relief).
  2. 0.5 m tiles with a min/max pyramid.
  3. `heightAt` and an exact tracer over them.
  4. A CDLOD renderer.
  5. A 2.5 cm and 10 cm material cache with road and verge compositing.
  6. Height-blended, stochastic-tiled PBR ground.
  7. Grass and pebble clutter.
  8. A ground-level camera.
- **Not built:** viewsheds over the full battlefield, navigation changes, layered bridge surfaces
  (only drawn), replay.

**Benchmarks and pass marks:**

| Measure         | How                                                                                                                                                                                                                                   | Pass                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Visual quality  | Paired screenshots, current renderer against the lab, with identical cameras: 12 at 1.7 m and 4 tactical. Checklist reviewed by you: no grid facets, roads blend, buildings seated, banks natural, no visible repetition within 50 m. | Clearly better at 1.7 m on all six features, and no worse tactically |
| Mesh density    | Vertices drawn per frame, and the spacing of the finest level                                                                                                                                                                         | ≤ 1 M, and s ≤ 0.5 m within 32 m                                     |
| Draw calls      | `renderer.info`                                                                                                                                                                                                                       | ≤ 30 for the terrain, material and clutter                           |
| Frame time      | p50 and p95 over a 60 s scripted walk and a 60 s orbit, in Chrome on the 880M (and on a discrete GPU if available)                                                                                                                    | ≤ 33 ms p95 on the 880M                                              |
| Memory          | GPU estimate (textures + buffers), JS heap, simulation tile cache                                                                                                                                                                     | ≤ 256 MB GPU; tile cache ≤ 64 MB                                     |
| Generation      | Time per tile per worker, and time to first frame for the 1 km²                                                                                                                                                                       | ≤ 5 ms per tile; ≤ 3 s                                               |
| Queries         | `heightAt` M/s; 300 m sight line µs; 600 m arc viewshed ms, using this report's harness                                                                                                                                               | Budgets in §7                                                        |
| Consistency     | Max \|level-0 vertex − `heightAt`\| (should be 0); max \|render − simulation\| within 32 m including detail; a unit's feet against the drawn ground                                                                                   | 0; ≤ 3 cm; ≤ 3 cm                                                    |
| Determinism     | Tile hashes for the whole 1 km², 3 runs each in Node, Chrome, Firefox and Edge                                                                                                                                                        | Identical                                                            |
| Gameplay effect | Sight lines across the window on the current surface against the lab surface: share changed, and an inspection of each change (a ditch now hides a prone soldier: intended; random noise blocking: not)                               | Every change attributable to a stamp or to relief of at least 0.3 m  |

**Comparison method:** the same package, the same cameras (the existing `cams-*.txt` format and
`ambushSetView`), and the same Chrome flags. The current renderer runs in the game; the lab runs
on its page with an identical camera API. Both report `renderer.info` and frame times through the
same harness.

---

## 9. Migration roadmap

Each stage ships on its own, keeps `npm run check` green and keeps the 2D map working.

1. **Interfaces.** Introduce `TerrainSurface`, with the current model behind `legacy/`, and move
   every raw-array consumer (§1.2) onto it.
   - **No behaviour change.** The existing exact-equality tests and the determinism test prove it.
2. **Prototype.** The lab, as in §8, then a decision record (ADR) to go or not.
3. **CDLOD for today's surface.** Generate tiles from the current authoritative surface and draw
   them with CDLOD, replacing the single terrain mesh. Draped features stay as they are.
   - Same ground, lower memory, and the ground-level camera available.
   - The display only changes because coarser levels are drawn far away.
4. **Material and detail.** The material cache, roads and verges in the ground material, PBR
   detail, clutter and grass. Still on today's surface.
   - Draped roads remain where the cache does not reach, until stage 5.
5. **The field as the authoritative terrain** (`TERRAIN_MODEL = field-v1+s0.5`).
   - The field and tiles replace grading's node bounds. The tracer runs on tiles with pyramids.
   - Viewshed workers read tiles. The 2D map uses tiles.
   - Scenarios on the old model get today's terrain-model notice (`main.ts:88`). Old recordings
     replay on their own frozen terrain, as now.
   - Behaviour changes are deliberate, listed and tested: heights move by the base interpolation
     and the relief; line of sight changes where ditches and embankments now exist.
6. **Layers, streaming and scale.** `surfacesAt` with unit layers (bridges with units over and
   under), a floating origin and streaming beyond 5 km. Optionally, WebGPU compute for tile and
   material generation.

---

## 10. Risks and unresolved questions

| #   | Risk or question                                                                                    | Why it matters                                                                                                               | How to settle it                                                                                                                                                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Line of sight on a 0.5 m lattice:** about 20× the crossings of a 10 m lattice (4× of a 2.5 m one) | Combat and viewsheds call it heavily: 437 µs today on Amsterdam                                                              | Prototype: min/max pyramid; measure against §7; fall back to 1 m                                                                                                                                                                                                                                                           |
| 2   | **Memory and worker copies**                                                                        | One graded terrain copy is 209–279 MB today, and each viewshed worker holds one                                              | Lazy tiles per worker; measure; consider a service-worker shim for COOP/COEP to share memory                                                                                                                                                                                                                               |
| 3   | **Cross-engine bit equality**                                                                       | Fingerprints and replays assume identical heights. `Math.sin`, `exp` and others are not guaranteed identical across engines. | Restricted arithmetic in the field; golden tile hashes in CI and in three browsers. Note: `combat.ts`, `environment.ts`, `geometry.ts`, `navigation.ts` and `viewshed.ts` already use such functions (counted with grep). Whether that affects cross-browser replay today is **unverified** and worth checking separately. |
| 4   | Field generation cost on Amsterdam (68 % of cells constrained, 69 k features)                       | Lazy generation must keep up with the camera and the units                                                                   | Per-tile stamp index; measure stamp evaluations per sample on Amsterdam                                                                                                                                                                                                                                                    |
| 5   | Relief that changes gameplay unintentionally                                                        | Random hummocks blocking sight lines would feel arbitrary                                                                    | Amplitude limits per land use; the "gameplay effect" benchmark; parameters in the model version                                                                                                                                                                                                                            |
| 6   | Material cache cost and quality on integrated GPUs                                                  | Its reads and per-frame compositing are the new cost centre                                                                  | Prototype frame times on the 880M; quality tiers (low quality keeps today's shader)                                                                                                                                                                                                                                        |
| 7   | The C¹ base changes heights by decimetres from today                                                | Existing scenarios' positions and routes may become invalid                                                                  | A new terrain model id; validation of saved scenarios with `pointProblem` on load                                                                                                                                                                                                                                          |
| 8   | Layered surfaces in the simulation state                                                            | Units under bridges need a layer                                                                                             | Stage 6, with its own ADR and determinism tests                                                                                                                                                                                                                                                                            |
| 9   | Lidar import (AHN, UK, 3DEP 1 m)                                                                    | Real metre-scale relief where it exists would beat procedural relief                                                         | Separate importer work; the field's base accepts any grid                                                                                                                                                                                                                                                                  |
| 10  | WebGPU and TSL readiness in three r186                                                              | Compute would speed up generation                                                                                            | WebGL2 first; WebGPU behind a flag in stage 6                                                                                                                                                                                                                                                                              |
| 11  | Draw distance and the tactical view at 5 km on 64 m nodes                                           | The overview must stay at least as good as today                                                                             | CDLOD's coarsest levels; compare overview screenshots in stage 3                                                                                                                                                                                                                                                           |
| 12  | Clutter as concealment                                                                              | Visual grass hides a prone soldier, but the simulation would not know                                                        | Deliberately display only at first; a concealment value later (§5.2)                                                                                                                                                                                                                                                       |

**What this investigation did not do:** it implemented nothing, ran no prototype, and measured no
GPU frame times for the proposed renderer. The vertex counts in §5.4 and the budgets in §7 are
estimates to be validated in the prototype.
