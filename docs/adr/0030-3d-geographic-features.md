# ADR 0030: Geographic features in the 3D view

- Status: Accepted (its buildings are superseded by ADR 0035: procedural roofs, textures, windows and doors)
- Date: 2026-10-11
- Implements milestone 2 (phase 2, "draped features") of `docs/3d-terrain-architecture-research.md`.
  Builds on ADR 0029 (the 3D view), ADR 0011 and ADR 0014 (environment features), ADR 0006 and
  ADR 0008 (one terrain triangulation).

## Context

Milestone 1 showed the simulated ground and the soldiers. The 3D view now has to show the
battlefield's geography: roads and tracks, buildings, water and land cover. It must stay exactly
the ground the simulation uses, with roads that neither float nor sink and are continuous through
every junction, and with buildings as tall as line of sight takes them to be. It must also stay
cheap to draw and deterministic.

### What the data holds

The 3D view can only show what the import keeps (`src/sim/environment.ts`, `src/geo/osm.ts`):

- **Roads:** a centreline, one of five classes (`path`, `track`, `unpaved`, `paved`, `major`) and a
  width (the `width` tag, else a default per class).
  - Surface, lanes, `tracktype`, bridges, tunnels and layers are not kept, so every road lies on
    the ground and styling goes by class and width alone.
- **Buildings:** an outer ring and a height only.
  - Courtyards (inner rings) are dropped at import with a warning, so holes cannot be shown.
  - The importer has already chosen the height: the `height` tag, else `building:levels` × 3 m,
    else Overture's height or floors, else 6 m. Defaults are marked in `source.estimated`.
  - In the recorded battlefields nearly every height is a default: all 1,273 buildings at
    Quantico and 3,566 of 3,567 at Grafenwöhr.
  - No roof shape is kept.
- **Water:** areas (`water` or `wetland`, with islands as holes; the sea comes from coastlines)
  and waterways (centreline, kind and width).
- **Land use:** ten kinds. **Vegetation:** woodland, tree lines and scrub.
- **The demo** (terrain format 2) has roads, buildings and vegetation, but no water, waterways or
  land use.

## Decision

### Pure generators, one mesh per material

The generators are pure functions of the terrain. They use no scene, and of Three.js only its maths
(`ShapeUtils`, whose earcut triangulates polygons). Each lives in its own module:

| Module                 | Builds                                                          |
| ---------------------- | --------------------------------------------------------------- |
| `drape.ts`             | Lays any flat shape on the ground exactly                       |
| `line-network.ts`      | Continuous ribbons for a network of lines: roads and waterways  |
| `road-geometry.ts`     | The road layers and their styles                                |
| `building-geometry.ts` | Extruded buildings                                              |
| `water-geometry.ts`    | Open water and waterways                                        |
| `landcover.ts`         | The terrain's vertex colours from land cover                    |
| `hash.ts`              | Stable hashes for colour variation                              |
| `geo-features.ts`      | The scene meshes: one mesh and one material per kind of surface |

- **Draw calls.** `geo-features.ts` adds up to eight meshes, whatever the number of features: five
  road classes plus a verge, water, and buildings. Quantico and Grafenwöhr draw in 12 calls in all.
- **Built once.** The meshes are built with the terrain mesh, the first time a terrain is shown,
  and disposed with it. Nothing is rebuilt per frame or when switching between 2D and 3D.
- **Version.** `GEOMETRY_VERSION` is there to key a geometry cache, which is not built yet.

### Draping: exactly on the ground

`createDraper` cuts any shape along the terrain's own triangles:

1. It clips the shape to each 10 m column, then each cell, then each half of the cell's
   south-west to north-east diagonal.
2. Every piece then lies inside one terrain triangle, where the ground is a plane.
3. Each corner takes that plane's height, computed exactly as `heightAt` computes it, plus a
   small offset.

The result:

- **The whole piece lies on the drawn and simulated surface,** not just its corners. A road can
  neither float over a crest nor sink into a hollow, on any slope.
- **Normals** are the terrain's own normals, interpolated, so a road is lit like the ground under
  it.
- **The cost** is proportional to the cells a shape covers.

Tests check that every vertex, and random interior points of every triangle, lie at `heightAt`
plus the offset to 1 cm, over rough ground with a 40 m cliff. They also check that the draped area
equals the shape's area, that shapes are cut at the battlefield's edge, that holes stay open, and
that every triangle faces up.

### Roads: a union of simple pieces

OpenStreetMap cuts one road into many ways, which meet in junctions of every shape. Each way is not
offset into a ribbon of its own: ribbons fold over on tight bends and leave wedges or overlaps where
ways meet. Instead, `drapeNetwork` draws each style as the union of convex pieces:

- **Segments.** A rectangle for every segment of every centreline.
- **Bends and joins.** Where exactly two segments of the same style and width meet (a bend, or one
  way continuing another), a fan fills the gap on the outside of the bend. The edge stays
  continuous and round.
- **Junctions.** At a junction, or where the width or class changes, a disc as wide as the widest
  line of that style. It fills the corners whatever the angles: T-junctions, crossroads, Y-forks,
  shallow and curved junctions, mixed widths.
- **Free ends** are cut square.

Nodes are matched to the millimetre, and ways are processed in order of id, so the result does not
depend on load order. Pieces of one style overlap only where they are coplanar, with the same
colour and normal, so the overlap cannot show.

**Layers.** From lowest to highest: verge, path, track, unpaved, paved, major. Each is one mesh with
its own material, raised by a small offset (4–9 cm) and a growing `polygonOffset`. Where classes
meet, the higher one is on top at any distance.

**Verge.** Paved and major roads have a 0.6 m verge on each side, drawn as a network of its own,
like the casing on the 2D map.

**Colours.** Muted asphalt for paved roads, and earth and gravel tones for unpaved roads, tracks
and paths.

Centrelines are used exactly as imported, unsmoothed, so the 3D roads match the 2D map.

Continuity tests sample a dense grid round each case:

- **Coverage.** Every point within 95 % of a road's half-width must be covered. Nothing beyond
  106 % may be, except near junctions and free ends.
- **Cases:** straight roads, a 166° bend, a hairpin, a curve tighter than the road is wide, ways
  continuing each other, a T, crossroads, a T whose main road bends at the junction, an 8° fork, a
  curved side road, and mixed widths.
- **The tests can fail.** With the fans or the discs removed, they fail.

### Buildings: line of sight's height, walls to the ground

- **Roof.** The flat roof is exactly at `buildingRoofElevations`: the lowest ground at the
  footprint's corners, plus the height. This is where line of sight finds it, so what you see
  blocks what the simulation blocks. A test checks this to 1 cm.
- **Walls.** They run from 0.5 m below the lowest ground anywhere along the footprint's edges
  (sampled every 0.5 m), so they meet the ground everywhere with no gap. The ground is never
  changed.
- **Plinth.** The bottom 0.5 m above the lowest corner is darker.
- **Roof shape.** Footprints are triangulated with earcut, with any winding. Roofs are flat: the
  data has no roof shapes, and pitched roofs (optional in the brief) are left out.
- **Colours.** A wall colour and a roof colour from small muted palettes, with ±5 % variation,
  picked by a hash of the building's id. The same building always looks the same.
- **One mesh.** All buildings form one mesh with vertex colours.

**The one discrepancy is on slopes, and it is the simulation's.** On sloping ground a building's
uphill walls are shorter than its height, and on very steep ground its uphill corners can stand
above its roof. The view shows this rather than raising the roof, because a taller drawn building
would hide ground that the simulation can see over. Such buildings are counted: 4 at Quantico and
4 at Grafenwöhr.

### Water: draped, level-lit, slightly transparent

- **What is drawn.** Open water areas (islands left open) and waterway ribbons (`drapeNetwork`,
  with the waterway's width), in one mesh.
- **Draped, not level.** Water is draped, not drawn as a level sheet. Elevation data rarely models a
  water surface exactly flat: a level sheet would cut into banks or float above the ground wherever
  it does not. On imported ground, which is flat over water, the two look alike.
- **Level-lit.** Water is lit with an upward normal. Bumps in the elevation data under it (at
  Quantico's shoreline, for example) then do not catch the sun as streaks.
- **Look.** Muted blue-grey, 80 % opaque.
- **Overlaps.** A stencil test lets each pixel take water once, so overlaps (a river's line over
  its area, or its own bends) are not darker. The renderer now asks for a stencil buffer.
- **Wetland** is marshy ground, not open water: it is a land-cover colour.

### Land cover: terrain colours only

`landCoverTints` gives every terrain vertex a colour. Vertices never move: a test checks that the
terrain mesh's positions and indices are identical with and without land cover. The terrain
therefore still matches `heightAt` to 1 cm.

- **Classes.** Land use (10 kinds), vegetation (woodland, tree line, scrub), wetland and water beds,
  each a muted colour.
- **Painting order.** Larger areas first, so a meadow inside a village shows. Vegetation is painted
  over land use, and water over both.
- **Fine grid.** Areas are rasterised by scanline (even–odd, holes included) on a grid four times
  finer than the heightfield. Each vertex takes the mean colour within half a cell of it, so the
  edges of woods and fields are soft rather than stepped along the 10 m grid.
- **Relief and variation.** A fifth of the elevation tint shows through, so relief still reads.
  Fixed variation (±4 % per sample and ±6 % in patches of about 70 m) breaks up large areas.
- **Fallback.** Where there is no land cover, or none in the data at all (the demo outside its
  woods), the ground keeps the elevation tints, as in milestone 1.

### Determinism

The only variation is from FNV-1a hashes of feature ids and from integer hashes of grid positions:
no random numbers, no time. Every generator processes features in order of id (land cover by area,
then id). Tests check that shuffled inputs give identical buffers.

## Consequences

### Measured

Headless Chromium, software WebGL (SwiftShader); generation on the main thread.

| Battlefield                    | Draw calls | Triangles | Geometry | Terrain + land cover | Roads     | Water     | Buildings | First 3D frame |
| ------------------------------ | ---------- | --------- | -------- | -------------------- | --------- | --------- | --------- | -------------- |
| Demo                           | 55         | 48 k      | 1.5 MiB  | 48 ms                | 8 ms      | –         | 2 ms      | 2.3 s          |
| Quantico (5 km, 1,273 bldgs)   | 12         | 1.17 M    | 62 MiB   | 0.33 s               | 0.3–0.8 s | 0.4–0.6 s | 0.1–0.2 s | 1.9–2.4 s      |
| Grafenwöhr (5 km, 3,567 bldgs) | 12         | 0.97 M    | 49 MiB   | 0.31 s               | 0.9 s     | 0.05 s    | 0.1 s     | 1.9 s          |

Notes on the table:

- **Demo draw calls.** The demo's 55 calls are mostly its soldiers (three each, as in milestone 1).
- **Triangles.** Quantico's include 367 k triangles of water: the Potomac covers about half the
  battlefield at terrain resolution.
- **Within the limits.** About 300 draw calls and 600 MB of GPU memory.
- **Frame rate.** Software rendering gives about 2 fps on the real battlefields. Frame rates on real
  GPUs are still unmeasured.

### Verified in the browser

On the demo, Quantico and Grafenwöhr, from the default view, oblique and low views, and close-ups
of junctions, tracks, buildings, waterways, open water and shores:

- roads are continuous through every junction seen, and lie on the ground on slopes;
- buildings stand on the ground, with no gaps under their walls;
- shores and ponds show no streaks.

Milestone 1's checks still pass at 1600 × 1000 and 1280 × 720:

- markers within 1 cm of their soldiers;
- camera, simulation and replay are preserved across switches;
- disposal on leaving.

On the real battlefields, ten switches between 2D and 3D change no geometry, texture or byte
count. The terrain is built once.

### Other changes

- `terrain-mesh.ts`: `terrainNormals` was split out, so the draper uses the terrain's normals.
- `tactical-camera.ts`: a `setPose` method.
- `view.ts`: the debug hooks `ambushSetView` and the extended `ambushDebug`, which reports feature
  statistics, build times, geometry bytes and terrain builds.
- No new dependencies. The main bundle is unchanged; the `view3d` chunk grew by 19 kB.

### Limitations

- **Missing tags.** No bridges or tunnels (roads drape across valleys, as the simulation assumes),
  no road surfaces or lanes, no courtyards, no roof shapes. All need the import to keep more tags.
- **Main thread.** Generation runs on the main thread, about 1–1.5 s on a 5 km battlefield. The
  generators are pure, ready for a worker and for the cache that `GEOMETRY_VERSION` anticipates.
- **Land cover resolution.** Land cover is resolved at 2.5 m, then blended at 10 m vertices. Tree
  lines and hedges narrower than a cell barely show; trees come with vegetation in a later
  milestone.
- **Water cost.** Large water areas are as finely triangulated as the terrain under them.
- **Elevation data.** Water follows what the elevation data says, so a wrong DEM shows: Quantico's
  −782 m samples (ADR 0029) and bumps along its shore.

### Deviations from the research architecture

- **Workers and cache.** No worker and no IndexedDB cache yet; both were planned for this phase.
  Generation is fast enough on the main thread for now (under the planned 2.5 s worker budget).
- **Triangulation.** earcut is used through Three.js's `ShapeUtils` rather than added as a
  dependency.
- **Land cover.** Vertex colours, not a splat-mask texture with ground materials. This means no
  textures, one draw call and no shader work. Texture detail is left for later.
- **Roads.** Rectangles, bend fans and junction discs replace offset ribbons with junction polygons.
  The result is simpler and robust for every junction shape.
- **Module layout.** The generators sit directly in `src/view3d/`, not in `src/view3d/generate/`.
- **Wetland** is drawn as ground colour only, without reeds.
