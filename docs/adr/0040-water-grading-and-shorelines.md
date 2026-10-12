# ADR 0040: Water surface flattening, shorelines and beaches

- Status: Accepted
- Date: 2026-10-12
- Builds on ADR 0014 (real-world terrain import), ADR 0030 (geographic features in the 3D view),
  ADR 0032 (one authoritative, graded terrain), ADR 0033 (DEM quality validation) and ADR 0038
  (terrain materials). Amends ADR 0030 (water is no longer always draped) and ADR 0032 (grading now
  levels water; `GRADING_VERSION` 2).

## Context

Lakes, rivers and the sea were not flat in 3D. Two causes combined.

1. **The renderer draped water on the ground.** `water-geometry.ts` cut every water polygon and
   waterway along the terrain's triangles and laid it 3 cm above the ground (ADR 0030). The water
   therefore took every bump of the ground under it. Its normals were forced up, which hid the
   problem in the lighting but not in the shape.
2. **The ground under the water is not a water surface.** Grading (ADR 0032) only marked water as
   "do not grade here". Nothing levelled it, nothing gave it a bed, and nothing made the shores meet
   a level. The DEM rarely models water as flat:
   - At 10 m it mixes the banks into the water.
   - It holds the noise of whatever survey made it.
   - In the sea it is bathymetry, or a flat 0 m.

Measured on the cleaned DEM inside each water polygon (5 m sampling):

| Site       | Water body                       | Inside: min – max (m) | Range (m) |
| ---------- | -------------------------------- | --------------------- | --------- |
| Quantico   | Potomac (`water=river`, 1063 ha) | −2.91 – 17.68         | 20.58     |
| Quantico   | Quantico Creek (141 ha)          | −2.11 – 17.68         | 19.79     |
| Quantico   | pond (`water=pond`, 77 ha)       | −3.23 – 16.49         | 19.72     |
| Grafenwöhr | Grünhundweiher (5.8 ha)          | 415.67 – 432.55       | 16.88     |
| Grafenwöhr | Dickhäutersee (4.2 ha)           | 416.77 – 422.48       | 5.72      |
| Grafenwöhr | pond w206162756 (1.3 ha)         | 415.02 – 424.68       | 9.66      |
| Grafenwöhr | small ponds (0.01–1.5 ha)        | 0.06 – 3.6 per pond   |           |

The import also kept no class for water areas, so a lake, a river and the sea could not be treated
differently.

## Decision

Water is levelled into the one authoritative terrain, as part of grading. The pipeline stays as it
was (ADR 0032 and ADR 0033):

**source DEM → validation and repair → grading (roads, buildings and now water) → authoritative
graded terrain → 2D map, 3D view, simulation**

There is still one terrain model. The source DEM is never changed. The water's levels are stored
with the graded terrain (`TerrainGrading.water`), so the 3D water, the shore materials, picking and
everything else read the same levels as the grading that made the ground.

### 1. Classification (`WaterArea.waterClass`)

The importer now keeps each water area's class from its tags (`waterClassOf` in `geo/osm.ts`).

| Class       | OSM tags                                                | Flow     |
| ----------- | ------------------------------------------------------- | -------- |
| `sea`       | built from `natural=coastline` (coastline.ts)           | standing |
| `lake`      | `water=lake`, `lagoon`, `oxbow`                         | standing |
| `reservoir` | `water=reservoir`, `landuse=reservoir`                  | standing |
| `pond`      | `water=pond`, `fishpond`, `reflecting_pool`             | standing |
| `basin`     | `landuse=basin`, `water=basin`, `wastewater`, `moat`, … | standing |
| `river`     | `waterway=riverbank`, `water=river`, `stream`, `rapids` | flowing  |
| `canal`     | `water=canal`, `lock`, `ditch`, `drain`                 | flowing  |
| `other`     | `natural=water` and nothing more                        | standing |

- **Never by size.** Size only decides eligibility (below).
- **Older packages** have no class. `classifyWater` infers one:
  - `sea` from the coastline source;
  - `river` or `canal` when a river or canal centreline runs through the area;
  - otherwise `other`.
  - For example, Quantico's recorded 77 ha `water=pond` has a river running through it, so it is
    inferred as a river.
- **Waterways** keep their kind and width as before. A river or canal line with no `width` tag is
  levelled at 8 m (`UNTAGGED_CHANNEL_WIDTH_M`), not at the importer's 12 m display default: an
  unmeasured river is never cut wider than it is likely to be.
- **Bridges.** `bridge=*` on roads is now kept (`Road.bridge`). `IMPORTER_VERSION` is 1.7.0.

### 2. Eligibility (`WATER_RULES`, `RIVER_MIN_WIDTH_M`)

| Class               | Levelled when | Bed depth |
| ------------------- | ------------- | --------- |
| sea                 | always        | 2.5 m     |
| lake, reservoir     | ≥ 100 m²      | 1.8 m     |
| pond, `other`       | ≥ 250 m²      | 1.0 m     |
| basin               | ≥ 250 m²      | 0.8 m     |
| river, canal (area) | always        | 1.5 m     |
| river, canal (line) | ≥ 8 m wide    | 1.2 m     |

- **The 8 m channel threshold.** The 2.5 m lattice needs about three nodes across a channel to give
  it a level surface, sloping banks and a bed. That rules out streams (2 m), drains (1.5 m) and
  ditches (1 m), which keep the ground as it is, as before.
- **Explicit widths win.** A stream tagged 10 m wide is levelled.

### 3. Standing water: one level

- **Lakes, reservoirs, ponds and basins** take the median of the cleaned DEM along their shoreline,
  sampled every 2.5 m. The shoreline excludes edges on the battlefield's edge and edges shared with
  other water (below).
- **Implausible levels are rejected.** The body is then left draped, as before, with a reason in
  `WaterBodyLevel.note`:
  - when 10% of the ground inside stands more than 3 m above the level (`MAX_INTERIOR_CUT_M`): the
    DEM does not hold this water;
  - when a fifth of the shore lies more than 2.5 m below it (`MAX_BANK_FILL_M`): levelling would
    raise long stretches of bank, typically a farm dam on a slope.
  - Grafenwöhr rejects 2 of 46 bodies this way and 3 as too small. Woolgoolga rejects 4 farm dams and
    1 sliver.
- **The sea is at 0 m.** Terrain Tiles' heights are orthometric (mean sea level: EGM96, NAVD88 and
  similar).
  - The datum is checked against the data's own sea, offshore. That is the sea floor or a flat 0 m,
    so its median is at or below 0.
  - The shore is not the test: it mixes in beaches and cliffs, and at Woolgoolga its median is
    3.4 m.
  - Only if the offshore median stands more than 3 m above 0 is the datum taken to differ. The sea
    is then levelled at that median, with a note.
- **Disconnected bodies** are levelled separately, each from its own shore.

### 4. Rivers: level across, falling downstream

River and canal waterways are joined into chains: a way ending exactly where one other way starts
continues it, as OSM draws waterways in the direction they flow. Each chain is sampled every 5 m.
Its profile is then built in steps:

1. **Spikes** are filtered: a moving median over 45 m.
2. **Direction.**
   - The chain is fitted never to rise downstream: a weighted isotonic regression (pool adjacent
     violators).
   - It is smoothed: a symmetric moving average over 65 m, which keeps a monotone sequence monotone.
   - A last running minimum guarantees no rise at all.
   - The fit is in the drawn direction only when the DEM agrees. If the chain's last samples stand
     more than 1.5 m (or 0.2% of its length) above its first, the direction is not trusted. The
     profile is then only filtered and smoothed. **No flow direction is invented.**
3. **Pins.**
   - Where a river runs in levelled standing water, its samples are that water's level: lake inlets
     and outlets, and rivers entering the sea.
   - Where a chain's end lies on a river already levelled, the end takes that river's level.
   - Rivers are levelled widest first, then longest, then by id, so tributaries meet main rivers.
   - Corrections between pins are linear and fade out over 40 m beyond the outermost.
4. **Real gradients stay.** The smoothing window is short, so a river falling 5 m per km keeps its
   fall. At Bled the Sava Bohinjka falls 446.4 → 422.5 m over 4.7 km.

The level at any point is the level at the nearest point of the nearest centreline, so it is level
across each section.

- **River areas** (`waterway=riverbank`, `water=river`) take their levels from the rivers in them,
  or from a river within 150 m (side channels, rivers mapped as several polygons). One with no
  river near it is levelled as standing water.
- **A river mapped only as a line** at least 8 m wide is levelled as a channel of that width, where
  it does not run in a mapped water area.

### 5. Grading: bed, shore, banks

Water constraints join the existing constraint system on the 2.5 m lattice. They are bounds that
combine by maximum and minimum, settled in a fixed order, so the result does not depend on feature
order. At each lattice node, `water.at(x, y)` gives the water it is in or beside, the level, and
the distance `d` to the nearest shore:

| Where                                       | Constraint                                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| In water, `d` < 3.54 m (a lattice diagonal) | ground = level + 0.05 m (the waterline)                                                               |
| In water, beyond                            | ground ≤ level − min(depth, 0.1 + 0.25 (d − 3.54)): a bed shelving at 1 in 4; deeper bathymetry stays |
| On land, `d` < 8 m                          | level + 0.05 + 0.04 d ≤ ground ≤ level + 0.05 + 1.5 d, fading out over the last 3 m                   |
| Under a bridge over levelled water          | ground ≥ level + 0.3 m: a deck                                                                        |
| Under a building standing in the water      | nothing: the ground is left as it is                                                                  |

What the rules guarantee:

- **No land beside the water is lower than the water.** Every lattice triangle the shoreline
  crosses has its corners at or above the level: within a diagonal inside, nodes are at the level;
  outside, they are at least at the level. A horizontal sheet clipped to the polygon can therefore
  neither float over a dip nor leave a gap.
- **No vertical walls.** A bank rises at most 1.5 in 1 from the waterline, so a steep shore comes
  down to the water and a cliff beyond 8 m is untouched.
- **No broad flattening.** Banks are shaped within 8 m of the shore. Beyond that the ground is the
  source, sample for sample.

**Shorelines.**

- A water area's edge is a shore unless:
  - it lies on the battlefield's edge (the water goes on beyond it); or
  - the other side of it is other levelled water: two river polygons meeting across a river, or a
    river entering a lake.
- That handles map edges, islands (holes), peninsulas, bays, inlets, estuaries and multipart areas
  without special cases.
- Coastline topology (winding, clipping, islands, a coastline that ends inside the battlefield)
  stays as in ADR 0014: the land is never filled, and broken data gives no sea.

**Precedence.**

- In water, the water rules alone apply (roads and buildings were never graded in water).
- A road's level part and a building's pad keep their level. No bank constraint applies there, so a
  waterfront road or foundation is never cut down or buried.
- Bank constraints combine with road and building side slopes by max and min.
- Decks are only for roads mapped as bridges. On terrain imported before bridges were kept, they
  are for built roads (major, paved, unpaved). A footpath mapped along a beach inside the sea (as at
  Woolgoolga) lies on the bed instead of standing out of the sea as a causeway.

**Deep water is not refined.**

- A cell whose centre is in the water at least the full bed depth plus half a cell diagonal from any
  shore, road or building is lowered on the 10 m grid itself: its corners become min(source, level −
  depth).
- Every point of such a cell is that far from any shore, so a lattice block sharing its corners
  computes the same value there. A refined cell next to it gets its edge straightened (each sample
  within 5 cm of the line).
- Grading also no longer refines a changed cell whose graded ground its corners alone hold to 5 cm
  (`coarseHolds`): a pad covering a whole cell, or a level stretch of road.
- Results:
  - Quantico lowers 125,236 deep cells this way, and Woolgoolga 102,431; refining them would have
    added about 3 million samples.
  - Refined cells change:

    | Site       | Before | After  |
    | ---------- | ------ | ------ |
    | Quantico   | 33,877 | 35,129 |
    | Grafenwöhr | 51,395 | 48,932 |
    | Woolgoolga | 21,624 | 26,309 |
    | Bled       | 44,091 | 49,125 |

**Versioning.**

- `GRADING_VERSION` is 2 and `WATER_GRADING_VERSION` is 1. The terrain model is now
  `dem-clean-v1+graded-v2`, so the in-memory authoritative-terrain cache (keyed by battlefield and
  terrain model) prepares the ground again.
- Scenarios record the model they were planned on (ADR 0032). One planned on `graded-v1` is noticed
  and updated on opening, as before. Its positions still stand, because soldiers cannot be in open
  water.
- Stored packages and saves are untouched: grading happens on opening and is never stored.
- A terrain already graded by version 1 is returned unchanged by `gradeTerrain`, and has no water
  levels, so `waterLevelAt` is `null` and the view drapes its water as before.

### 6. The 3D water

`water-geometry.ts`:

- **Levelled standing water** is one horizontal sheet at its level, triangulated from the polygon
  with its islands open.
- **Levelled rivers** are cut along the terrain's cells as before, and each vertex is set to the
  profile's level there: flat across, falling downstream.
- **Channels** (rivers mapped as lines) are drawn as wide as they were levelled.
- **Watercourses** running in levelled water (a stream into a lake) take its level.
- **Water that was not levelled**, and narrow watercourses, are draped as before.

The material (`water-material.ts`) is three's `MeshStandardMaterial`:

- vertex colours per kind of water (sea, lake, pond, river, canal);
- roughness 0.3, opacity 0.84;
- small static ripples in the shading normal, four sine waves of 0.9–5.3 m, fading out between 40 m
  and 260 m.

There are no reflections, refraction or per-frame updates. It is still one draw call. The stencil
still lets each pixel take water once.

The 3D view's ground query for picking, overlays and the camera (`terrainGround`) is the water
surface over levelled water, not the bed. A click on a lake therefore picks where it is seen, and
routes or wedges drawn over water lie on it, as on the 2D map.

### 7. Shores and beaches (ground map, `GROUND_MATERIAL_VERSION` 2)

There are three new ground layers: **sand**, **shingle** and **mud**. They are CC0 Poly Haven
textures, prepared as in ADR 0038 and listed in `textures/CREDITS.md`. They live in a third weight
texture (layers 8–10), so the shader reads one more RGBA8 texture.

**Mapped data first.**

- The importer now reads `natural=beach`, `sand`, `shingle`, `bare_rock`, `scree` and `mud` into
  four land-use kinds: `beach`, `shingle`, `bareRock`, `mud`.
- A beach's `surface` (or `material`) of pebbles, gravel or shingle makes it shingle; rock makes it
  rock; mud or earth makes it mud.
- Mapped shores keep their own ground. No inferred band is laid over them, only the damp band.
- They are drawn on the 2D map in light sand and grey tints.

**Inferred shores** (`shores` in `ground-map.ts`). Along levelled water, within the band's width of
the shore:

| Water                | Band width | Damp band | Shore ground                                        | Bed           |
| -------------------- | ---------- | --------- | --------------------------------------------------- | ------------- |
| sea                  | 5–30 m     | 2.5–6 m   | sand; patches of sand and shingle                   | sand, shingle |
| lake, reservoir      | 2–12 m     | 1–2.5 m   | sand, earth, shingle; patches of shingle and gravel | mud, sand     |
| river, canal         | 1–6 m      | 0.6–1.5 m | shingle, sand, mud; patches of mud and earth        | shingle, mud  |
| pond, basin, `other` | 1–3 m      | 0.5–1.2 m | mud and earth                                       | mud           |

- **Variation.** The width varies along the shore with slow noise (55 m), and the mix with faster
  noise (18 m), so beaches widen and narrow naturally.
- **Slope.**
  - The band narrows to nothing between slopes of 0.2 and 0.55, so a steep shore has no broad sand.
  - From a slope of 0.45 to 0.9 the waterline becomes rock and shingle, 1.5–4 m wide: rocky shores
    and cliff feet.
- **Land cover** caps the width:
  - built-up land (residential 1.5 m, commercial and industrial 1 m), farmland 2 m, woods 3 m,
    wetland 2 m;
  - a developed waterfront keeps its own ground.
- **The damp band** is darker and smoother (the existing wetness parameter). Its width varies along
  the shore and its strength with the mix noise, so it is not a uniform stripe.
- **Under the water** the bed is the class's bed recipe, fully wet, seen through the water.
- **Bands never cross the water.** They are measured from the nearest shore on the land side, so a
  river's two banks each get their own, and overlapping bands take the nearest shore.
- **Roads win.** Road and track shoulders are applied after shores, so no beach runs across a road
  or a bridge.
- **Display only.** The simulation never reads the ground map.

### 8. What else uses it, and what does not change

- **2D map.**
  - Contours and hillshade come from the graded ground, so they now show the level shoreline. The
    bed is under the 2D map's water fill (90% opaque), as before.
  - `waterLevelAt(terrain, x, y)` is exported for any 2D use.
- **3D mesh, picking, line of sight, movement, viewsheds, the simulation.** All read the one graded
  surface, so they agree to the bit, as ADR 0032 guarantees.
  - **Line of sight.** A sight line between two points above a flat water surface cannot pass below
    it, so sight across water is unchanged by the bed. A line sampled to a point on the bed sees the
    bed (see Limitations).
  - **Movement.** Water areas remain impassable. A levelled river channel mapped only as a line is,
    as before, not an obstacle. Its ground is now a channel up to 1.2 m deep, so a soldier crossing
    it walks through the dip. This is a legitimate, local simulation change.
- **Vegetation** is unchanged: trees already kept out of open water and watercourses (ADR 0031).
  Shores add no vegetation rules.
- **AAR and replay** run on the terrain the exercise ran on. The model id makes a change of ground
  visible, as for ADR 0032.
- **Workers.** Grading, water included, runs in the terrain worker. The ground map, shores included,
  runs in the generation worker. Neither blocks the page.

## Verification

### Flatness on the graded terrain

Sampled inside each levelled body (up to about 4,000 points each):

- **Every standing body has exactly one level.** The range is 0.000 m at all 8 Woolgoolga, 13 Bled,
  41 Grafenwöhr and 5 Quantico levelled standing bodies. The source DEM inside them ranged up to
  12.3, 14.3, 16.0 and 2.8 m.
- **Every river profile never rises downstream.** The largest rise between neighbouring samples is
  0.0000 m in all 8 profiles, all trusted for direction.
- **Ground above the waterline inside a polygon** (more than 0.05 m above the level) is 4–7% of
  sampled points. Over 95% of those lie within 3 m of the shore, where lattice triangles straddle
  it. The rest (3–21 points per site) are under bridge decks and buildings standing in the water.

### Performance

Grading, in Node on the test machine (the worker in the browser is similar):

| Site       | Before    | After     | Levelled bodies | River profiles |
| ---------- | --------- | --------- | --------------- | -------------- |
| Quantico   | 2.4–2.6 s | 3.8 s     | 8               | 3              |
| Grafenwöhr | 3.2–3.5 s | 3.2–4.1 s | 41              | 1              |
| Woolgoolga | 1.1 s     | 1.9 s     | 9               | 1              |
| Bled       | 3.2 s     | 3.7 s     | 28              | 3              |

The river level lookup uses cached candidate lists per 40 m bucket, over a coarsened profile (every
fourth point, about 20 m). This took Quantico from 7.0 s to 3.8 s.

The browser figures (ground map bake, triangles, draw calls, memory, first frame) are in the
milestone's final report. SwiftShader timings there are not representative of a GPU.

### Tests

- **`sim/water-grading.test.ts`** (32 tests):
  - standing water: one exact level at the shoreline median; bed below the water; no land beside the
    water lower than it; no wall; unchanged beyond the banks; deep water on the coarse grid; valid,
    continuous refinement; mesh equals `heightAt`; independent of feature order; disconnected lakes;
    a DEM spike; a steep shore; an implausible body rejected; small and large ponds and reservoirs;
  - the sea: classified from its coastline; at 0 m; deeper floor kept; map edge not a shore; islands
    above the water; another datum detected;
  - rivers: monotone, no stairs, real fall kept; level across; streams excluded; untagged width;
    direction not invented; a tributary meets its river; a lake inlet; a river area;
  - bridge decks, buildings in water, clear sight across water, the new model id, PAVA and pins.
- **`view3d/water-geometry.test.ts`**: the flat sheet with its island open; no float or sink; the
  river on its profile; small ponds draped; colours; picking on the water surface.
- **`view3d/ground-map.test.ts`**: a sandy beach with a damp band; width and damp band varying; a
  cliff's rocky foot; a mapped shingle beach and a built waterfront kept; sand under the sea;
  determinism; the third weight texture.
- **`geo/osm.test.ts`**: water classes from tags; mapped beaches by `surface`.

## Limitations

- **Viewsheds over water.** The visibility overlay samples the ground, and over water that is the
  bed. Near a low observer's own shore, bed points can show as hidden behind the bank lip, where the
  water surface itself is visible. The bed is shallow (1 in 4 from the waterline, at most 1–2.5 m),
  so the effect is a few metres wide.
- **Overlapping water polygons** with different levels: the first by id gives the level, and a step
  can show where they overlap.
- **River levels between neighbouring profiles** (braided channels) come from the nearest
  centreline, so a small step can show halfway between two channels.
- **Tidal ranges and seasonal levels** are not modelled. The sea is mean sea level, and a lake is
  its mapped shoreline's level.
- **Dams.** A farm dam on a slope is usually rejected (its downhill shore is the dam wall, lower in
  a 10 m DEM) and stays draped.
- **No waves, foam or animated water.** The ripples are static.
