# ADR 0038: Terrain materials and surface realism

- Status: Accepted
- Date: 2026-10-11
- Builds on ADR 0029 (the 3D view), ADR 0030 (land cover, whose ground colours become the
  fallback), ADR 0031 (vegetation and the generation worker), ADR 0032 (the authoritative graded
  terrain and its refined tiles) and ADR 0035 (texture arrays for buildings). Implements §7
  ("Ground materials") of `docs/3d-visual-realism-research.md`.

## Context

The terrain was coloured, not textured. `landCoverTints` gave each 10 m heightfield sample a muted
colour from its land cover, with ±4% noise, and the mesh interpolated it. From above it was a soft
blur of greens and browns. Up close it was a flat colour with no texel detail, with no grass, soil,
litter or gravel. The colour also depended on the tessellation: refined 2.5 m tiles interpolated
their corners' tints, so the look changed where the mesh did.

The ground covers most of every view. It needs to:

- read as real surfaces (grass, forest floor, fields, bare ground) at every camera distance from
  about 20 m to 3 km;
- show no repetition from altitude, and no shimmer or seams;
- keep man-made edges such as fields and settlements crisp, but let woods fade into meadows;
- integrate the roads and the graded earthworks; and
- stay display only. The terrain mesh is the simulated ground (ADR 0032), so no vertex may move.
  The simulation's land cover, line of sight, movement, grading and After Action Review must not
  change.

## Decision

### 1. Architecture: a baked ground map and an extended standard material

The mesh, its vertices, normals and triangles are unchanged. Two new parts are added.

- **The ground map** (`ground-map.ts`, pure and deterministic) is a raster in battlefield metres.
  - For every point it gives the weights of eight **ground layers** and four surface parameters:
    wetness, dryness, furrow direction and furrow strength.
  - The point spacing is 2.5 m, or as fine as 1,280 points a side allows: 3.9 m for a 5 km
    battlefield.
  - It is baked in its own Web Worker (`generation.ts`: `Generator.ground`), alongside the feature
    and vegetation worker, so it neither waits for that work nor delays it.
  - It is transferred as three RGBA8 arrays: weights 0–3, weights 4–7 and the parameters.
- **The terrain material** (`ground-material.ts`) is three's `MeshStandardMaterial`, extended
  through `onBeforeCompile` with `customProgramCacheKey`. The sun, sky light, shadows, fog and tone
  mapping therefore stay exactly as for every other object. In the fragment shader it:
  1. reads the map at the fragment's map position (a world-space varying, not a UV);
  2. samples each layer with weight above 2% from a `DataArrayTexture` of eight 512 px colour maps
     and one of eight 256 px normal maps;
  3. blends the layers;
  4. sets albedo, roughness and the shading normal.

**Alternatives considered:**

- **Per-vertex weights** (as the colours were). These are tied to the tessellation: they cause
  seams and changing looks at refined tiles, and are 10 m coarse.
- **A `ShaderMaterial`.** It would have meant re-implementing three's lighting, shadows and fog.
- **An index map with manual bilinear blending.** It needs four lookups and up to four materials
  per pixel.
- **TSL or node materials.** These would require WebGPU-era rewrites (research §7).

Splatting with weight textures, plus texture arrays, is the common, well-understood choice. A
second set of four weights would cost one more texture read.

Until the map arrives, `groundOn` is 0 and the terrain shows the previous land-cover vertex colours
unchanged, so the first 3D frame is no slower to appear. Until the texture files load, or if they
cannot load, each layer is its plain colour (one-texel placeholder arrays), so nothing looks broken.

### 2. Surface types: only what the data supports

The map comes from `rasterizeLandCover`, the same classification the vertex colours used, now
generalised to any grid. It returns the class and the area that set each point. The rules for
which area wins are unchanged: largest first, vegetation over land use, water over both.

| Land cover (OSM)                                           | Ground                                                                                                                                                                                                                                                                                                                                                                                                                               | Edges   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| none (no data)                                             | grass 0.55 and rough grass 0.45, slightly dry, with worn patches                                                                                                                                                                                                                                                                                                                                                                     | natural |
| meadow (meadow, grass, grassland, village green)           | grass 0.6 and rough grass 0.4                                                                                                                                                                                                                                                                                                                                                                                                        | natural |
| military                                                   | rough grass and grass, with worn earth patches                                                                                                                                                                                                                                                                                                                                                                                       | natural |
| woodland (wood, forest)                                    | **litter of the stand above it**: needle litter where `coniferShareAt` (the same noise that places the conifers, ADR 0031) is high, leaf litter where it is low, plus darker earth and patches of green undergrowth                                                                                                                                                                                                                  | natural |
| tree line                                                  | leaf litter and grass                                                                                                                                                                                                                                                                                                                                                                                                                | natural |
| scrub (scrub, heath)                                       | sparse grass over soil: rough grass 0.5, grass 0.25, earth 0.25                                                                                                                                                                                                                                                                                                                                                                      | natural |
| wetland                                                    | damp earth and grass (wetness 0.7)                                                                                                                                                                                                                                                                                                                                                                                                   | natural |
| water (bed under the water surface)                        | wet earth                                                                                                                                                                                                                                                                                                                                                                                                                            | natural |
| farmland (farmland, farmyard)                              | per field, from a hash of its id, since OSM does not record field state: **ploughed** soil (30%), **tilled** soil (20%), **stubble** (dry rough grass, 25%) or **pasture** (25%). Furrows and harvest swaths run along the field's long axis (its second moments). No crops are invented. Farmland under 0.4 ha is a **farmyard** (the importer files `landuse=farmyard` under farmland): earth, gravel and rough grass, no furrows. | sharp   |
| orchard, residential, cemetery, recreation                 | maintained grass                                                                                                                                                                                                                                                                                                                                                                                                                     | sharp   |
| commercial, industrial (including quarry and railway land) | gravel, bare earth and dry rough grass                                                                                                                                                                                                                                                                                                                                                                                               | sharp   |
| other (brownfield, construction, religious)                | rough grass, earth and gravel                                                                                                                                                                                                                                                                                                                                                                                                        | sharp   |

Within an area each layer's share drifts with slow noise (±55% over about 46 m) and dryness drifts
over about 120 m, so a meadow has greener and drier patches.

**Brief categories the data cannot support are not invented:**

- **Sand and exposed rock** are not imported (no `natural=sand` or `bare_rock`). Rock appears only
  on cliffs.
- **Moss** is not a separate layer. It shows in the leaf-litter texture's green patches and in the
  undergrowth share.
- **Short versus meadow grass** is the grass and rough-grass mix.

The layer list (`GROUND_LAYERS`) and recipes are tables. A new layer is one texture pair and one
table entry, up to eight layers per texture pair.

### 3. Texture library

All eight texture pairs are CC0 1.0. Sources and changes are in `src/view3d/textures/CREDITS.md`.

| Layer         | Source                      | Tile (m) | Roughness |
| ------------- | --------------------------- | -------- | --------- |
| grass         | ambientCG Grass004          | 2.2      | 0.95      |
| rough grass   | Poly Haven leafy_grass      | 2.4      | 0.95      |
| leaf litter   | Poly Haven forest_leaves_02 | 2.8      | 0.92      |
| needle litter | ambientCG Ground077         | 2.0      | 0.92      |
| field soil    | Poly Haven farm_soil        | 2.4      | 0.97      |
| bare earth    | Poly Haven brown_mud_02     | 2.2      | 0.95      |
| gravel        | Poly Haven gravel_ground_01 | 2.6      | 0.90      |
| rock          | Poly Haven rock_ground      | 2.6      | 0.85      |

- **Format and size.** Colour maps are 512 px JPEG; normal maps (OpenGL convention) are 256 px
  JPEG. Together they are 774 KB to download.
- **Flattening.** Each colour map had its broad brightness and colour gradients flattened offline,
  which hides repeats.
- **Colour.** The shader multiplies each layer by a tint that brings the texture's measured average
  colour to the layer's target colour (`GROUND_LOOK`). Colour is therefore controlled in one table
  and stays muted, while the detail stays photographic.
- **Normals and roughness.** Normal maps add relief near the camera. Roughness is per layer, between
  0.85 and 0.97, with no roughness maps: the ground is never glossy.

### 4. Blending and transitions

- **Natural edges** are those between natural classes: wood, meadow, scrub, wetland, water and
  unclassified ground. Two steps soften them:
  1. the class is looked up at a noise-displaced point (±1.6 points over about 28 m), so the edge
     wanders;
  2. the weights are blurred 3 × 3, over natural neighbours only.
     The result is an irregular transition about 8–12 m wide.
- **Man-made edges** are anything involving a field, settlement, yard, cemetery or other land use.
  These get no displacement or blur, so they stay at the map's resolution, and the furrow
  parameters never leak across them.
- **Height blending** in the shader. Each layer's height is its texture's brightness relative to
  its average. A layer shows where its weight plus height is near the top, so grass clumps over
  soil instead of a uniform cross-fade, and transitions are crisp but organic.
  - The blending depth widens with distance (from 150 m to 700 m), so far away the blend is plain
    weights and the colour does not shift with zoom.
  - Weights below 2% are skipped.
  - Every point's weights sum to exactly 255, so filtering never produces invalid inputs.

### 5. Multi-scale texturing and tiling

For each active layer:

- **Close (detail).** Two "virtual tilings" are blended: Inigo Quilez's technique. Each tiling is
  offset and rotated by an index from slow noise. The blend favours the brighter sample at the seam,
  so repeats and grid alignment disappear. All sampling uses `textureGrad`, with derivatives taken
  once outside any branch.
- **Medium (coherent patterns).** A third sample of the same texture at about five times the scale,
  rotated differently, modulates the detail's brightness (±50% weight). It breaks repetition at
  10–20 m.
- **Far (broad patterns, low noise).** Two samples of a generated tileable noise texture, at 347 m
  and 1,733 m, vary brightness (±7%) and hue slightly.
- **Shimmer.** Mipmaps, anisotropic filtering (8×) and explicit gradients reduce distant ground to
  the layers' average colours, varied only by the broad patterns. The weight and parameter maps are
  mipmapped too.
- **Furrows** (0.75 m) and **swaths** (6 m) fade out before they would alias: their screen-space
  frequency is measured from the derivatives.
- **Normal maps** fade out between 120 m and 260 m and are skipped beyond.

### 6. World-space mapping

The vertex shader passes the fragment's battlefield position (x, y in metres). Every lookup is a
function of that position only: the map, the textures at their real tile size, and the noise.
Consequences:

- there are no seams at refined tiles or at the terrain's edges;
- nothing slides as the camera moves;
- nothing depends on the triangulation;
- 2D/3D switches, reloads and re-imports give the same look, because the map is a pure function of
  the terrain.

The map's transform puts each map point at the centre of its texel. A test checks this.

### 7. Slopes, earthworks and roads

- **Slopes.** These come from `heightAt` at the map points, using central differences over about
  4 m, so they are independent of the mesh.
  - Natural ground: bare earth from a slope of 0.6 (31°) to 0.95, then rock from 0.95 to 1.4 (55°).
  - Graded cells (the refinement's cells: cuttings, embankments and pad edges): earth and sparse
    grass from 0.35 to 0.7.
  - Water beds are left alone. Elevations are never changed.
- **Road shoulders.** Each road's worn shoulder is stamped into the weights:
  - gravel and earth beside paved and major roads, out to 1.3–1.6 m beyond the edge;
  - earth and gravel beside unpaved roads;
  - earth and grass beside tracks and paths.
    The stamp fades over one map point, with noise, and the strongest road wins at crossings. The
    road meshes, verges and markings are unchanged; the shoulder removes the hard contrast at their
    edges.

### 8. Lighting

The existing lighting is unchanged: the sun, hemisphere light, sky, fog, ACES tone mapping at
exposure 0.6, and the sRGB output. The textures are sRGB, and the tints are computed in linear
space. The layer colours were chosen against this lighting:

- grass is muted green (`#71864a`);
- litter is mid-brown, so forest floors are neither black nor saturated;
- damp ground darkens by up to 28% and its roughness drops toward 0.62.

### 9. Quality levels

The shader has three paths (`GroundPath`), one program each, shared by all terrains. Switching
quality level recompiles the terrain program.

- **full** (medium and high): everything above.
- **simple** (low, on a GPU, such as integrated graphics): one rotated sample per layer, with no
  broad sample and no normal maps. It keeps the map, height blending, furrows, wetness and macro
  noise.
- **flat** (low, on a software renderer such as SwiftShader or llvmpipe): each layer is its plain
  colour, with no texture-array reads at all. Only the map, the noise, furrow shading and wetness
  remain.
  - Measured in SwiftShader, even the simple path more than doubled the time per frame against the
    vertex-coloured baseline, from about 2.5–4 s to about 7 s.
  - A software renderer is a fallback, not a target, so it keeps the map's layout of the ground
    without the texture detail.

### 10. Determinism, versions and compatibility

- **Determinism.** Every variation comes from hashes of positions and feature ids. Noise lattices
  are hashed once per bake (`NoiseField`, the same values as `valueNoise`). There are no random
  numbers, and nothing depends on load order. Tests check byte-identical maps across runs and
  shuffled feature order.
- **Version.** `GROUND_MATERIAL_VERSION` (1) versions the look. It is independent of the importer,
  DEM-cleaning, grading, geometry and placement versions, and nothing in a battlefield file or
  scenario stores it.
- **Compatibility.** Old battlefields load without re-import: the map is baked from the terrain as
  loaded.

### 11. Separation from the simulation

The bake reads the terrain and never writes to it. The simulation never imports `view3d`, which
the existing boundary checks enforce.

Tests check that baking leaves the demo terrain and its graded terrain byte-identical as JSON, and
that grading, heights and 39 sight lines are identical afterwards. `display-attributes.test.ts`
(ADR 0037) still holds unchanged. Movement, ballistics, events and AAR read no view state.

## Results

Measured in headless Chromium with SwiftShader (software WebGL) on a 4-core container. No real GPU
was available, so these are worst-case numbers; on a GPU the medium and high paths are expected to
be well within budget (about 10–15 texture reads per pixel for a typical two- or three-layer mix).

| Measure                                          | Quantico (5 km)                     | Grafenwöhr (5 km) |
| ------------------------------------------------ | ----------------------------------- | ----------------- |
| Ground map                                       | 1,280 × 1,280 points at 3.9 m       | same              |
| Bake, Node (one core)                            | 1.3 s                               | 1.5 s             |
| Bake in the browser worker (SwiftShader, loaded) | 3.1 s                               | 1.9 s             |
| Ground map in use after the bake started         | 4.4 s (features and trees: 58 s)    | 2.9 s (65 s)      |
| Texture download (16 JPEG files, once per page)  | 774 KB                              | same              |
| GPU memory, ground textures and maps             | about 40 MB (26 MB of it the map)   | same              |
| Draw calls added                                 | 0 (same terrain mesh, one material) | 0                 |
| Triangles added                                  | 0                                   | 0                 |

- The first 3D frame shows the vertex colours and does not wait for the bake or the textures. The
  only first-frame cost is compiling the extended terrain program, which is one program per quality
  path.
- Software rendering, measured on Quantico in SwiftShader with steady frames:

  | Path                    | Wide view frame | Close view frame | Features and vegetation ready |
  | ----------------------- | --------------- | ---------------- | ----------------------------- |
  | Baseline (no textures)  | 2.2–5.6 s       | 1.7–3.6 s        | 21.6 s                        |
  | simple                  | 7.3–7.5 s       | 6.7–7.0 s        | 44.7 s                        |
  | flat (software default) | 4.6–5.2 s       | 2.6–5.2 s        | 34.4 s                        |

  The extra time before features and vegetation appear comes from the slower frames during their
  reveal, and from the bake worker sharing the CPU with the renderer. The first 3D frame is
  unchanged: 9.8 s before and 9.8–11.2 s after. No GPU timings were possible here.

The browser checks covered the demo, Quantico and Grafenwöhr. Views included wide overhead
(2.5 km), medium oblique (700 m), grassland (120 m), forest floors under broadleaf and conifer
stands (70 m), fields (200–260 m), a graded embankment and a cutting (110 m), road-to-terrain
transitions (80 m) and low altitude (25 m). The checks showed:

- **Tiling and seams.** There is no visible tiling or grid, and no seams at refined tiles.
- **Forest floors.** Broadleaf stands have brown litter, conifer stands rust-brown needles. They do
  not read as dark green.
- **Fields.** Stubble and ploughed fields show directional swaths and furrows from overhead.
- **Earthworks and shoulders.** Embankment and cutting faces are bare earth with sparse grass, and
  roads sit in worn shoulders without gaps.
- **Distance.** Distant ground stays calm.

All existing tests are unchanged and pass.

## Consequences and limitations

- **Map resolution.** At 3.9 m per point on a 5 km battlefield, a man-made edge is crisp but not
  survey-straight. Height blending makes it organic rather than blurred, but a field corner is
  slightly rounded at 25 m altitude. A larger cap would cost GPU memory quadratically.
- **Categories the data does not carry.** There is no sand, exposed bedrock, crop type, mowing
  state or field state. Field looks are hashed per field and labelled as appearance only.
- **Shorelines.** The natural softening lets a few metres of damp earth show at shores, which reads
  as a muddy margin. Rivers drawn as lines (waterways) do not wet their banks.
- **Grading magnitude is not used.** Graded slopes are found from the refinement's cells and the
  slope. The cut or fill depth is not available on the graded terrain.
- **No decorative ground meshes.** Small detail such as grass tufts and stones is in-shader only.
  The brief marked this low priority, and no meshes were added.
- **Lighting.** The lighting is unchanged. AgX or Neutral tone mapping and environment lighting
  (research §8) remain separate, larger decisions.
