# ADR 0035: Procedural buildings and richer OSM building data

- Status: Accepted
- Date: 2026-10-11
- Implements visual milestone A of `docs/3d-visual-realism-research.md` (there called ADR 0034).
  Builds on ADR 0030 (geographic features in the 3D view), ADR 0014 and ADR 0023 (OSM and
  Overture buildings), ADR 0031 (the generation worker) and ADR 0032 (the authoritative graded
  terrain, whose building heights and pads this leaves unchanged).

## Context

The 3D view drew every building as its footprint extruded to a flat, untextured roof in one of a
few muted colours. The research (`docs/3d-visual-realism-research.md`) found that buildings were
the largest single gap in realism at the distances a trainee looks from. It also found that the
sources say little about how buildings look. Of 3,609 buildings at the two recorded battlefields,
4 have a roof tag, and every height is the importer's 6 m default. A convincing look therefore has
to come mostly from defaults: plausible for the building's kind and region, varied, and
deterministic.

Constraints from the brief:

- The simulation's buildings stay exactly as they are: footprint, height, the line-of-sight
  reference roof, grading pads, movement collision, and saved results.
- Nothing new is inferred: no paths, driveways, fences or streetlights. Terrain stays unchanged.
- Assets are CC0 or original only. No GPL code or assets.

## Decision

### 1. Richer import, kept as display metadata (`src/geo/building-tags.ts`; importer 1.3.0)

Each `Building` gains an optional `appearance` (`BuildingAppearance` in `src/sim/environment.ts`).
It holds what the source says about the building's look:

| Field                             | OSM tag                                          | Overture property                      |
| --------------------------------- | ------------------------------------------------ | -------------------------------------- |
| `kind`                            | `building` (not `yes`)                           | `class`, else `subtype`                |
| `part`                            | `building:part`                                  | —                                      |
| `use`                             | `amenity`, `shop` or `military`                  | —                                      |
| `levels`, `levelsUnderground`     | `building:levels`, `building:levels:underground` | `num_floors`, `num_floors_underground` |
| `heightMeters`, `minHeightMeters` | `height`, `min_height`                           | `height`, `min_height`                 |
| `roofShape`                       | `roof:shape`                                     | `roof_shape`                           |
| `roofHeightMeters`                | `roof:height`                                    | `roof_height`                          |
| `roofLevels`                      | `roof:levels`                                    | —                                      |
| `roofAngleDegrees`                | `roof:angle`                                     | —                                      |
| `roofOrientation`                 | `roof:orientation`                               | `roof_orientation`                     |
| `roofDirectionDegrees`            | `roof:direction`                                 | `roof_direction` + 90°                 |
| `roofMaterial`, `wallMaterial`    | `roof:material`, `building:material`             | `roof_material`, `facade_material`     |
| `roofColour`, `wallColour`        | `roof:colour`, `building:colour`                 | `roof_color`, `facade_color`           |
| `country`                         | `addr:country`                                   | —                                      |

Overture's `roof_direction` is the ridge bearing, so 90° is added to get the bearing the roof
faces, as OSM's `roof:direction` gives it.

Every value is checked. A malformed value, or one that contradicts another, is left out, never
guessed, and the view then falls back to its defaults:

- Lengths are read in metres or feet (`12`, `12,5 m`, `30'`, `30 ft`).
- Storeys must be whole or half numbers from 0 to 200.
- Colours are read as `#rgb`, `#rrggbb`, bare `rrggbb` or a known name, and stored as `#rrggbb`.
- Bearings are read as degrees or compass points.
- Shapes and materials are mapped onto small vocabularies; anything else is dropped.
- These are dropped as contradictions: a `min_height` at or above the height; a `roof:height` at
  or above the height, or above 60 m; a roof angle outside 0–80°; a country that is not two
  letters.
- `appearance` is absent when nothing usable is given, so most buildings carry nothing new.

What is explicit and what is a default stays distinguishable. `appearance.heightMeters` is set
only when the source gave a height. The simulated `heightMeters` is still chosen exactly as before
(the `height` tag; else storeys × 3 m; else Overture's height or floors; else 6 m), and
`source.estimated` still says when it was estimated. **No imported value changes the simulated
height, footprint, LOS reference, grading or collision.** A `roof:height` or `min_height` that
would change the geometry is kept as metadata only. A test imports tagged buildings and checks
that the simulated heights are unchanged (`src/geo/building-tags.test.ts`).

Roads gain optional `highway` and `service` fields (for example `service`/`driveway`). They keep
mapped driveways recognisable for the view, as entrance targets. `roadClass` and width are
unchanged, so grading and the simulation treat driveways exactly as before. No driveway or path
is inferred.

The terrain's metadata gains an optional `architecture` (`north-american`, `central-european`,
`generic`) that overrides the regional style. It is display-only.

**Compatibility.**

- All new fields are optional, so saved battlefields and scenarios load unchanged and draw with
  defaults.
- The importer version is now 1.3.0, so a battlefield imported again gets the richer data.
- The simulation ignores the new fields. A test runs the demo battlefield with every display field
  set, some contradicting the simulated heights (`src/exercise/display-attributes.test.ts`). It
  grades to identical elevations, gives identical LOS roofs and identical sight lines on 500 random
  lines, and runs to identical events and an identical state hash.

### 2. The procedural generator (`src/view3d/`)

All of it is pure and deterministic. It runs in the generation worker (ADR 0031) with the other
feature geometry, and its output is plain typed arrays.

| Module                  | Role                                                      |
| ----------------------- | --------------------------------------------------------- |
| `footprint-shape.ts`    | Classifies a footprint and covers it with rectangles.     |
| `building-style.ts`     | Region, category and style.                               |
| `roof-geometry.ts`      | Roof planning and roof geometry.                          |
| `facade.ts`             | Window and door layout.                                   |
| `surface-mesh.ts`       | Textured triangle buffers.                                |
| `building-geometry.ts`  | Puts the parts together and chooses entrances.            |
| `building-materials.ts` | The two materials and texture loading (main thread only). |

**Footprints.**

- The ring is cleaned: counter-clockwise, with near-duplicate corners (< 5 cm) and near-straight
  corners (< 4°) removed.
- The oriented minimum bounding rectangle (OMBR) is found by testing every edge direction.
- A footprint that fills at least 90 % of its OMBR is a **rectangle**.
- Otherwise, if every edge is within 12° of the OMBR's axes, it is **rectilinear**. It is then
  covered by at most 4 overlapping rectangles: greedily, on a grid of its own coordinates snapped
  at 0.6 m, each rectangle at least 2.5 m wide, with at most 20 corners and at most 2 % left
  uncovered.
- Everything else is **irregular**.
- Recorded battlefields:

  |            | Rectangle | Rectilinear | Irregular |
  | ---------- | --------- | ----------- | --------- |
  | Quantico   | 849       | 358         | 66        |
  | Grafenwöhr | 2,859     | 588         | 120       |

No straight-skeleton library is used. The maintained JavaScript ones embed CGAL, which is GPL.
The rectangle cover handles the L, T and U plans that make up most non-rectangular houses.

**Roofs** are flat, gabled, hipped or skillion (shed):

- **Rectangles** take the roof on their OMBR. The ridge runs along the long side, unless
  `roof:orientation` or `roof:direction` says otherwise.
- **Rectilinear plans** take a roof on each rectangle, all at one eaves height and one slope, so
  ridges and hips meet. Where rectangles overlap, the faces meet along valleys, found by the depth
  buffer. A narrower wing whose ridge runs into a wider part is cut back to that part's ridge line,
  and its end is left open beneath the wider roof. This avoids the stray gables a naive overlap
  would show.
- **Irregular plans** are roofed flat. So are skillions on anything but a rectangle (they become
  gables), buildings over 1,500 m² (except farm buildings), and any roof that would rise less than
  0.5 m.
- **Every face is a plane** through its eaves line at one slope:
  - Hips meet along the 45° lines from the corners.
  - Faces never fold, invert or leave gaps.
  - Planarity, upward normals and full coverage of the footprint are tested for every shape.
- **Overhangs** extend each eaves edge by 0.25–0.5 m, by style. A fascia board and a level soffit
  close them.
- **Gable ends** are triangles in the wall's material, textured continuously with the wall below.
- **Flat roofs** lie exactly at the reference. Larger ones get a 0.6 m parapet with a coping.

**Heights.** Line of sight treats a building as a block whose top is the reference roof: the lowest
ground at its corners plus `heightMeters`. A pitched roof keeps that as its mean height:

- The eaves sit half the roof's rise below the reference, and the ridge half its rise above.
- When the source gives both `height` and `roof:height`, the ridge is at the reference (OSM's
  meaning of `height`), and the eaves sit a roof height below it.
- The rise is capped so walls stand at least 2.4 m tall.

For a 6 m building, with the brief's example being about 4.5 m eaves and 7.5 m ridge:

| Battlefield                | Eaves (10th–90th percentile) | Median eaves | Ridge (10th–90th percentile) | Median ridge |
| -------------------------- | ---------------------------- | ------------ | ---------------------------- | ------------ |
| Quantico                   | 4.2–5.3 m                    | 4.75 m       | 6.8–7.8 m                    | 7.29 m       |
| Grafenwöhr (steeper roofs) | 3.4–5.0 m                    | 4.23 m       | 7.0–8.6 m                    | 7.81 m       |

**This is a deliberate discrepancy.** Line of sight sees a 6 m block. The view shows a pitched
roof up to about 1.8 m higher at the ridge and about 1.8 m lower at the eaves. The drawn volume is
roughly the simulated one, but a sight line grazing a ridge or an eaves can disagree with what is
drawn by that much. Making LOS follow the drawn roof would change simulation results, which this
milestone must not do. It is listed under limitations.

**Walls.**

- Walls run from 0.5 m below the lowest ground along the footprint's edges (sampled every 0.5 m)
  up to the roof, so a wall never ends short of the ground.
- A wall's top at each corner follows the roof surface there, clamped near the eaves. Walls
  therefore meet the roof with no gap and never poke through it.
- A skillion's walls follow its slope.
- A concrete plinth runs 0.5 m up from the lowest corner.
- Textures keep their real-world size on every surface:
  - Wall u is metres along the perimeter, and v is metres above the lowest corner, each divided by
    the material's tile size. For example, brick is 1.2 m and plaster 2 m.
  - Roof u runs along the eaves and v up the slope, using true slope length.
  - The tests check that u and v change by one tile per tile size of wall.

**Windows and doors** (`facade.ts`) are layout only. They are quads 4 cm in front of the wall,
textured from an atlas. They have no effect on LOS or movement.

- **Storeys:**
  - The count is `building:levels` when tagged; otherwise it is `floor(wall height ÷ storey height
    - 0.2)`.
  - The storey height comes from the style: 2.6 m (outbuildings) to 6 m (industrial).
  - Storeys are spread evenly from 0.15 m above the lowest corner to the eaves.
- **Columns:**
  - The windows keep 0.7 m from each corner.
  - They fill the space between at the style's module spacing (2.6–3.8 m).
  - A wall with room for only one window gets one, centred.
- **Clearances:**
  - A window's top keeps 0.3 m below the wall's top.
  - Its sill keeps 0.3 m above the ground just outside the wall, so a wall half-buried on a slope
    loses only the windows the ground would cover.
- **Doors:**
  - The entrance wall is the one facing the nearest vehicle road, driveways included (footways and
    paths are excluded).
  - It is scored by the distance from a point 2 m in front of each wall of 3 m or more to the
    nearest road within 60 m. Wall length breaks near-ties.
  - With no road within 60 m, the longest wall is chosen.
  - The door replaces the ground-floor window nearest the middle of that wall.
  - Some houses get a garage door at one end of the entrance wall. Outbuildings flagged as garages
    get one or two garage doors.
  - Commercial buildings get shopfronts, institutional ones glazed doors, industrial ones roller
    doors, and farm buildings barn doors.
- **Variants:**
  - Industrial buildings get bands of strip glazing.
  - A gable of 2.6 m or more on a house's outer wall gets an attic window, unless the ground has
    buried that gable.
- **Entrance metadata:** every door and garage door is exported as
  `{buildingId, x, y, z, nx, ny, kind}` in `FeatureGeometry.entrances` and the view's statistics.
  It is display metadata, for later use. The simulation does not read it.

### 3. Styles (`building-style.ts`)

**Region.** In order of precedence:

1. The terrain's `metadata.architecture`.
2. Otherwise, the country most buildings' `addr:country` gives, if at least three agree.
3. Otherwise, the continent the georeference's UTM zone and false northing put it in, at about 0.1°.
4. Otherwise, generic.

Recorded data resolves Quantico to North American and Grafenwöhr to central European. No style is
guessed from finer coordinates.

**Category.** From the building's kind or use when tagged. Otherwise, from size and land use:

- under 30 m² is an outbuilding;
- otherwise the land use round it decides;
- over 1,500 m² with no land use is industrial;
- otherwise residential.

Quantico has 957 residential and 262 military buildings, from the land use. Grafenwöhr has 2,594
residential and 675 military.

**Palettes.** Each region and category has weighted choices, picked by a hash of the building's id:

- **North American houses:** vinyl siding (60 %), brick (30 %) or render, in whites, greys,
  creams and pale blues and greens. Asphalt shingles (88 %) or metal. Gable roofs (70 %) or hip
  roofs at 22–32°. Double-hung windows, some with shutters. Painted doors in red, navy, green,
  black or white. A garage on houses of over 110 m², half the time.
- **Central European houses:** render in warm whites and creams (85 %), with some brick or block.
  Clay or concrete tiles, or a little slate. Gable (60 %) or hip roofs at 34–46°, with 0.5 m
  overhangs. Casement windows, some with green or brown shutters. Wooden or painted doors.
- **Military:** plain render or concrete; gable roofs at 28–34°. In North America, low metal or
  flat gravel roofs.
- **Commercial and institutional:** brick, concrete or render, with flat gravel roofs, or hip tile
  roofs on smaller central European ones. Large modern windows; shopfronts or glazed doors.
- **Industrial:** metal cladding, block or concrete. Flat roofs, or low (6–12°) metal gables. Strip
  windows and roller doors.
- **Agricultural:** board siding (barn red in North America), metal or render. Gable roofs, some
  skillion. Barn doors and no windows.
- **Outbuildings:** siding, metal or render. Small gable, skillion or flat roofs, and garage doors.

Tags override the defaults: roof shape, angle, materials and colours. Tag colours are brightened
if needed so no textured surface goes near-black: luma at least 0.5 for roofs and 0.55 for walls.
This avoids the dark roofs the research prototype had.

### 4. Materials and rendering (`building-materials.ts`, `geo-features.ts`)

**Two draw calls** cover every building:

1. Walls, roofs and trim in one mesh. It uses one `MeshStandardMaterial`, extended in
   `onBeforeCompile` to sample a `DataArrayTexture` of 12 layers (6 wall and 6 roof materials,
   512 px each). The layer is chosen per vertex (`surfaceLayer`, −1 for untextured trim), and the
   texture is multiplied by the vertex colour (the tint). It is front-sided, so back faces are
   culled and building interiors stay invisible, as before. Each roof face has an explicit
   underside in trim colour (seen under overhangs), and each parapet has an explicit inner face.
2. Windows and doors in one mesh, textured from the 1024 px openings atlas, with a small polygon
   offset.

Both cast and receive shadows like the old building mesh, except openings, which only receive
them. The scene gains one draw call over the old single building mesh.

**Loading.** Textures load in the background (fetch, `createImageBitmap`, then a canvas) and are
decoded once per page and shared by later battlefields. Until they arrive, each layer shows its
texture's average colour and the openings are hidden. Nothing looks broken while loading, and
nothing blocks the first frame. Where there is no DOM (tests), the placeholders stay.

**Disposal.** `dispose()` frees both meshes' buffers, both materials and every texture they own.

**Memory.** The array uses about 16.8 MB of GPU memory with mipmaps, and the atlas about 5.6 MB.
The downloads total about 0.6 MB (JPEG) plus 53 KB (PNG).

`GEOMETRY_VERSION` is now 2. `FeatureGeometry.buildings` is now textured surface data
(`uvs`, `layers`), plus `openings` and `entrances`. Every typed array is still listed for transfer.

### 5. Licences (`src/view3d/textures/CREDITS.md`)

- The 12 surface textures are CC0 1.0, from ambientCG and Poly Haven. Some were desaturated or
  brightened so that tints colour them.
- The openings atlas is original, drawn by a script for this project.
- No code was added.
- No texture comes from a project without a clear redistribution licence. Streets GL's textures
  state none and were not used. Nothing is GPL.

### 6. Determinism

- Every choice comes from a hash of the building's id (FNV-1a, then a mixing sequence) and from the
  building's own data. Nothing uses `Math.random` or the clock, and nothing depends on load order:
  buildings are processed in id order.
- The same battlefield looks the same after reload, a 2D/3D toggle, a fresh import, or in either
  thread.
- Tests check identical meshes, colours, layers, UVs and entrances for shuffled input and for
  repeated builds.

## Results

Geometry on the recorded battlefields (Node, single thread):

|            | Buildings | Wall/roof triangles  | Opening triangles | Generation |
| ---------- | --------- | -------------------- | ----------------- | ---------- |
| Quantico   | 1,273     | 75,756 (was 40,009)  | 65,032            | 372 ms     |
| Grafenwöhr | 3,567     | 164,557 (was 84,061) | 128,258           | 845 ms     |

In the browser (Chromium with SwiftShader, software WebGL, at the low quality preset, 1600 × 1000).
Before is the build of the previous commit; after is this change. Same recorded data and same
cameras:

|                                     | Quantico before | Quantico after   | Grafenwöhr before | Grafenwöhr after |
| ----------------------------------- | --------------- | ---------------- | ----------------- | ---------------- |
| Draw calls (overview)               | 12              | 13               | 12                | 13               |
| Triangles drawn (overview)          | 3.11 M          | 3.21 M           | 3.71 M            | 3.92 M           |
| Building + opening triangles        | 40 k            | 76 k + 64 k      | 84 k              | 165 k + 127 k    |
| Building generation (worker)        | 157 ms          | 455 ms           | 258 ms            | 806 ms           |
| All feature generation (worker)     | 2.56 s          | 2.79 s           | 3.01 s            | 3.15 s           |
| Applying results on the main thread | 246 ms          | 225 ms           | 373 ms            | 258 ms           |
| Shader compile                      | 6 ms            | 25 ms            | 26 ms             | 19 ms            |
| First 3D frame after opening        | 8.9 s           | 10.6 s           | 10.4 s            | 10.1 s           |
| Geometry buffers in the scene       | 186 MB          | 201 MB           | 228 MB            | 259 MB           |
| Textures                            | 1               | 3 (+ ~22 MB GPU) | 1                 | 3 (+ ~22 MB GPU) |

The demo battlefield goes from 93 to 94 draw calls and adds 0.5 k triangles.

- Building generation is about three times slower. It runs in the generation worker, off the
  main thread, and adds 0.2–0.3 s to the 19–24 s it takes the software renderer to
  show features and vegetation.
- Main-thread work and the first frame do not change beyond run-to-run noise. The first frame
  comes before features, and textures load after it.
- The draw-call count grows by one (openings). Triangles grow by 3–6 % of the scene.
- No real GPU was available in this environment, so frame rates were not compared. The software
  renderer's frame times are dominated by terrain and vegetation fill, not by these 140–290 k
  triangles, and they would not represent a GPU. On a GPU the added cost is two materials, one
  12-layer array texture, and the triangles above, comparable to one more vegetation tier.
- Nothing is rebuilt per frame. Disposal frees the meshes, the materials and the three textures.

Screenshots (before and after, identical cameras) are in `docs/research/procedural-buildings/`.

## Consequences and limitations

- **LOS vs. drawn roof.** LOS still sees a flat-topped block at the reference height, while the
  view draws a pitched roof with the same mean height. A sight line can pass over a drawn ridge
  that LOS treats as clear, or be blocked at a drawn eaves, by up to about half the roof's rise
  (typically 1.2–1.8 m). Closing this gap means changing LOS and so simulation results. It is a
  decision for a later milestone.
- **Most looks are defaults.** With almost no roof or material tags in the source data, roof
  shapes, pitches, materials and colours are plausible guesses for the region and kind, not facts
  about the real building. Tags win where present.
- **Irregular footprints** (about 4–5 %) are roofed flat. Hipped or gabled roofs on them would
  need a straight skeleton. The maintained libraries for that are GPL, and writing one was out of
  scope.
- **Rectilinear covers** snap to a 0.6 m grid. A wall up to about 0.6 m off its rectangle meets
  the roof at a slightly different height, which the per-corner wall tops absorb, so there is no
  visible gap. Rectangle edges inside a footprint get hidden overhang geometry inside the walls.
- **Windows are textures on quads**, with no depth. They are evenly spaced, not taken from real
  facades. Shops and houses on mixed streets are told apart only by tags and land use.
- **No courtyards.** The import keeps only outer rings (ADR 0011), so courtyard buildings are
  roofed as solid blocks.
- **Pitch vs. width.** Very wide pitched roofs keep a pitch of 22° or less, and ridges can still
  be high on wide rectangles. The rise cap keeps walls at least 2.4 m tall.
- **Texture repetition.** At wide views the 4 m shingle tile repeats visibly as a faint checker.
  A second, larger-scale variation (detail and macro textures) would hide it.
- **Undersides of overhangs** are untextured trim. From street level, in shade, they read as dark
  bands.
- **Openings on sloping walls** are placed per storey from the lowest corner. On a steep slope the
  uphill side may have no ground-floor windows, because the ground covers them.

## Deviations from the brief

- The research report numbered this ADR 0034. The brief asked for 0035, which is used here.
- Gambrel, mansard, half-hipped, pyramidal and saltbox tags are drawn as their nearest supported
  shape (gable or hip; pyramidal as hip, which gives a pyramid on a square). Dome, onion, round
  and sawtooth are drawn flat.
