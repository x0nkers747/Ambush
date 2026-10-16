# ADR 0049: The terrain field is the game's ground and its 3D terrain

- Status: Accepted
- Date: 2026-10-13
- Supersedes: the grading of [ADR 0032](0032-authoritative-graded-terrain.md) and of
  [ADR 0040](0040-water-grading-and-shorelines.md) (its water levels stay); the terrain mesh and
  ground material of [ADR 0038](0038-terrain-materials.md); the draped roads and bridge geometry of
  [ADR 0030](0030-3d-geographic-features.md), [ADR 0041](0041-procedural-road-bridges.md) and
  [ADR 0044](0044-road-junction-and-bridge-topology.md); the water mesh and shoreline of
  [ADR 0046](0046-water-visuals-and-shoreline-smoothing.md) (its material and profiles stay);
  and the terrain lab of [ADR 0047](0047-terrain-lab-prototype.md), whose prototype it adopts.

## Context

The terrain lab (ADR 0047) showed that a constraint-based terrain field, sampled into tiles and
drawn with CDLOD and per-pixel material fields, gives far better ground than the graded 2.5 m
mesh: roads level across and smoothed along, blended junctions, bridge decks the ground keeps
clear of, building pads, ditches and stream channels, paved towns (ADR 0048), and forests of
Quantico species with an understorey. It was reviewed on Quantico, Grafenwöhr and Amsterdam and
accepted. The simulation must stay on exactly the ground that is drawn: what units see, cross
and hide behind is what the trainee sees.

## Decision

1. **One field, two samplings.** The authoritative ground is the terrain field
   (`src/sim/terrain-field`, `TERRAIN_FIELD_VERSION`) compiled from the cleaned DEM
   (ADR 0033), the features and the water levels (ADR 0040).
   - The simulation samples it (`src/sim/ground.ts`, `gradeTerrain`): the 10 m grid takes the
     field's heights at its nodes, and every cell where the field departs from the grid's two
     triangles by more than `REFINE_TOLERANCE_M` (0.1 m) is refined to a **1 m lattice**
     (`TerrainRefinement`, factor 10). A refined cell's edges next to an unrefined cell are
     straightened, so the surface is continuous. Everything that used the graded ground uses
     this one: movement, line of sight, viewsheds, scenario checks, the 2D map and the camera.
   - The 3D view compiles the same field from the cleaned elevations the terrain keeps
     (`grading.baseElevations`) and draws it from 0.5 m tiles (`terrain-renderer.ts`). The two
     agree to within the tolerance; most of the battlefield, roads included, is exact.
2. **Refinement samples are a `Float32Array`.** 12–15 million samples on a 5 km battlefield
   would be about 120 MB as numbers and 60 MB as Float32. Plain data (ADR 0007) accepts
   `Float32Array`: it is cloned, frozen by convention, and encoded for fingerprints as its
   bytes. Validation allows Float32 rounding at refined cells' corners and edges.
3. **Built in parallel.** Sampling the field is about 30 s of work on one thread for a 5 km
   battlefield. The app cleans the DEM in one worker, then shares the grid rows out in bands
   to up to eight workers (`grading.worker.ts`), and assembles the result. The lattice does not
   depend on how the rows are shared out (tested). Quantico opens in about 7 s.
4. **Bridges.** The field lays a deck on every road mapped as a bridge. The terrain keeps those
   decks (`grading.decks`), and the simulation's bridges (ADR 0043) take their heights from
   them, so soldiers walk on the deck that is drawn. A crossing not mapped as a bridge is the
   road the field builds across the water.
5. **The 3D view.** `view.ts` draws the field's ground (CDLOD, hex-tiled PBR materials from the
   field's distances to road edges, shores and walls, land cover and wetness), its water,
   bridge decks, grass and clutter, and the game's buildings, road markings (lifted onto decks)
   and roadside details. Trees and shrubs are drawn as species of the Quantico area with an
   understorey under woods (`forest.ts`). The tactical camera, picking, markers, overlays and
   the visibility overlay are unchanged. Generation no longer drapes roads, paths and water,
   builds bridges or bakes a ground map.
6. **Quality.** Each quality preset sets the ground's finest-level reach (75 / 100 / 130 m for
   low / medium / high), where fine detail fades, and the grass (none on software renderers).
   There are no new settings.
7. **The model changes.** `TERRAIN_MODEL` becomes `dem-clean-v1+field-v5` (`field-v6` since woods' edges are blended, section 10). A scenario planned on
   the graded model is kept and checked, and the trainee told (as for ADR 0032). Replays are
   held in memory only, so none need converting.
8. **Removed.** The terrain lab page, its cameras, benchmark and comparison mode; the grading
   (`grading.ts`); the terrain mesh, ground map and ground material; the draped road surface,
   water mesh, shoreline, bridge geometry and bridge structures; geometry diagnostics; and the
   old vegetation renderer.
9. **Tree cover from imagery** (`tools/tree-cover.ts`) is kept. It classifies NAIP imagery for
   woods OpenStreetMap does not map. Its dormant hook in the app was replaced by tree cover from
   canopy heights ([ADR 0050](0050-tree-cover-from-canopy-heights.md)).
10. **Woods' edges are blended** (`field-v6`). The land cover is mapped on 2 m cells, so the
    forest floor met the grass in a hard, stepped line. Near a boundary between covers, a
    wood's litter, grass, soil and relief are averaged over about 3.5 m either side of a line
    wavering by up to 3 m, and the ground's shader breaks the band into patches a metre or two
    across. Field, town and paved edges stay as mapped. Fallen leaves (clutter) are leaf-shaped
    and as dark as the floor, no longer light rectangles; sun shadows fade out towards the edge
    of the square they are cast in; and far trees thin by their own distance, not their tile's.

## Consequences

- **Sight costs more.** On the 1 m lattice line of sight is about 2.8× slower, and viewsheds
  about 2.2× slower, than on the 2.5 m graded ground (Quantico: 0.5 ms a line; three 1 km
  viewsheds 1.9 s instead of 0.9 s). Viewsheds already run in workers.
- **Opening a battlefield** takes a few seconds more on few cores. Without workers (tests,
  Node), the ground is sampled on one thread.
- **The 3D view** needs WebGL 2 texture arrays, as before. It compiles the field on the main
  thread when a battlefield is first shown (0.1 s for Quantico, longer for a dense city).
- **Cross-engine determinism** is verified between Node and Chrome (both V8). Firefox and
  Safari are untested.
- The field's version is part of the terrain model: any change to it that moves the ground
  must bump `TERRAIN_FIELD_VERSION`.

## Amendment (2026-10-16): mapped beaches are sand

Mapped beaches (`natural=beach`, `sand`: land use `beach`, ADR 0040) had lost their sand in the
terrain field. Their cover's materials were a little grass and soil, and the shader shows bare soil
only in large noise patches. So a beach was drawn as blotches of dark soil and grass. It showed
badly on the long beach north of Coffs Harbour.

- **Sand weight.** The cover's look has a `sand` weight (1 on beaches), sampled as `FieldSample.sand`.
- **Surface flag.** The surface code's spare bit is set where the sand weight is at least ½
  (`SAND_FLAG`, 32).
- **Shader.** It blends the flag over the four samples around a point, with noise for a ragged
  edge a metre or two wide. Sand then replaces the cover's own materials there; roads, paving and
  the water's edge are still drawn over it.
