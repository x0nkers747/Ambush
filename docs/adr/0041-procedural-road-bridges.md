# ADR 0041: Procedural road bridges

- Status: Partly superseded by ADR 0049: bridges are planned as here, but their deck heights come from the terrain field, and the 3D view draws the field's decks
- Date: 2026-10-12
- Builds on ADR 0030 (draped roads), ADR 0032 (the authoritative graded terrain), ADR 0036
  (decoration), ADR 0037 (road markings) and ADR 0040 (levelled water and shores).

## Context

Since ADR 0040, water lies at its own level, with a bed below it. Roads are draped on the graded
ground, so a road crossing a river was drawn on the river's bed, under the water. The exception
was a road mapped `bridge=*` over levelled water: ADR 0040 graded a deck-high strip of ground
under it, so it stood just above the water as a causeway.

What the data offers:

- **Roads** (`Road`): a class, a width and a centreline.
  - ADR 0040 added `bridge`.
  - This milestone keeps the rest of the crossing tags: `bridge=*` (yes, viaduct, movable, …),
    `tunnel=*`, `ford=*`, `layer` and `bridge:structure`.
  - These are imported as `Road.crossing` (`IMPORTER_VERSION` 1.8.0). They are display only: the
    simulation never reads them.
- **Water**: areas (lakes, river areas, the sea) and waterways with widths.
  - Untagged widths are the importer's defaults: river 12 m, canal 8 m, stream 2 m, drain 1.5 m,
    ditch 1 m.
- **The recorded battlefields map their bridges well.** Every crossing of water found by inference
  is also a mapped bridge way:

  | Site       | Mapped bridge ways | Of them over water | Inferred with the tags removed |
  | ---------- | ------------------ | ------------------ | ------------------------------ |
  | Woolgoolga | 21                 | 13                 | 1                              |
  | Bled       | 27                 | 8                  | 6                              |
  | Quantico   | 10                 | 2                  | 0                              |
  | Grafenwöhr | 15                 | 3                  | 2                              |

  Many mapped bridges cross roads, railways or creeks, not water.

## Decision

Bridges are decoration in the 3D view, built with the other feature geometry in the generation
worker (`view3d/bridges.ts`, called from `geo-features.ts`). (Since ADR 0043 the planning,
`planBridges`, is in the simulation layer, `sim/bridges.ts`, so that soldiers cross the same
bridges; the 3D view draws them unchanged.) Nothing in the simulation, the graded
ground, the road network or the water changes. Bridges are not obstacles, and picking does not hit
them.

### Crossings (`planBridges`)

1. **Roads.** Vehicle roads (classes major, paved, unpaved, track) are considered. Paths and
   footways are considered only where mapped as bridges.
   - Roads of one class are joined into chains where exactly two ways meet end to end. OSM splits a
     road at each bridge, so the bridge way and its approaches become one line.
2. **Over water.** Each chain is followed every metre. A point is over water:
   - inside an open-water area (any class); or
   - within half the width of a waterway at least **5 m** wide (`BRIDGE_MIN_WATERWAY_M`).
3. **The 5 m threshold** excludes creeks, drains and ditches (untagged 1–2 m) and keeps rivers and
   canals (untagged 12 m and 8 m). A stream tagged 5 m or wider counts. Narrower watercourses are
   not resolved on the 10 m DEM, and their draped ribbons lie under the road anyway.
4. **Areas.** A run over an area counts from 3 m (`MIN_CROSSING_M`), so a road clipping the corner
   of a pond is not bridged.
5. **Mapped bridges take precedence.** A way mapped `bridge=*` is a bridge over its whole length,
   over water or not: viaducts, overpasses, bridges over creeks. A way mapped as a tunnel or a ford
   is never bridged, and is reported (`skipped`). `tunnel=culvert` is a pipe under the road, so the
   road is ordinary.
6. **Merging.**
   - Runs closer than 25 m along a chain are one bridge: islands, rivers mapped as several polygons,
     several overlapping water features.
   - Each bridge is on one chain, so no deck overlaps another.
7. **Ends.** An inferred bridge reaches 4 m onto dry land beyond the water (`APPROACH_M`). A
   crossing whose road ends in the water (a slipway, or a ferry approach) is skipped and reported,
   unless it runs off the battlefield's edge.

### The deck

The deck's top is the road surface. It is sampled every metre along the road's own centreline, so
curved and diagonal bridges follow the road, not the shortest line between the banks.

- **At its ends** it is the road's height on the graded ground, exactly. The bridge continues the
  road.
- **Over water** it stands at least 0.9 m above the water (`CLEARANCE_M`; 0.5 m for footbridges).
  The water is its level from ADR 0040, or the draped water on the ground.
- **A mapped bridge** never dips below the straight line between its ends, so a viaduct spans the
  dip it crosses.
- **Grade.** The deck rises and falls at most 8% (`MAX_GRADE`). It is the grade-limited envelope of
  those needs, capped by what the grade allows from each end, then lightly smoothed.
- **Low banks.** Where the banks are too low for that, the approaches are extended up to 14 m
  further onto land. If that is still not enough, the deck is as high as the grade allows, a low
  bridge, and the crossing is flagged `lowClearance`. Within 3 m of its ends a deck meets the road
  whatever the water there.
- **The road's real elevation**, the graded ground and the water are never raised or changed.

### The road on the deck: no second road surface

The road is not drawn twice. The road layers, verges, markings and paths are draped as before.
Then `liftOntoBridges` raises every vertex within a bridge's footprint onto the deck, keeping its
height above the ground:

- **Blending.** Over the first and last 2 m (`END_BLEND_M`) the surface blends from following the
  ground (lifted by the deck's lift on the centreline) to flat across the deck. Junctions at the
  ends join seamlessly.
- **Splitting.** Triangles near a bridge are split to 2 m first, so the surface follows the deck's
  profile and not long chords across the river. Everything else is copied unchanged.
- **Markings** are the same pieces from the ADR 0037 pipeline, lifted the same way. Centrelines,
  lane lines and edge lines continue, the dash rhythm is not reset, and they keep their small offset
  above the road. There is no separate bridge marking generator.
- **Untouched data.** The road network and the draped geometry's inputs are untouched; the lifted
  meshes are copies.

### The structure (`bridgeGeometry`)

The structure is one vertex-coloured mesh with one material: concrete greys and steel. It is one
extra draw call, and casts and receives shadows. Where the deck stands clear (over water, or lifted
more than 15 cm), plus 2 m onto each bank, it has:

- **a deck slab** under the road surface, as wide as the carriageway, verges and margin, with
  visible thickness and a darker underside;
- **barriers** along both edges, by style;
- **abutments**: a wall at each end from the slab down into the bank;
- **piers** between the banks, evenly spaced, from the slab into the bed, when the span over water
  (or high over a dip) is longer than the style's `maxSpan`. Short spans are slabs with no piers.

| Style   | Chosen for                                              | Slab  | Margin | Barrier                            | Longest span       |
| ------- | ------------------------------------------------------- | ----- | ------ | ---------------------------------- | ------------------ |
| `rural` | unpaved and tracks; paved roads outside built-up places | 0.7 m | 0.9 m  | steel guardrail on posts every 2 m | 22 m               |
| `urban` | paved roads in built-up places                          | 0.8 m | 1.4 m  | concrete parapet, 0.85 m high      | 25 m               |
| `major` | major roads                                             | 1.2 m | 1.2 m  | concrete parapet                   | 32 m, twin columns |
| `foot`  | paths mapped as bridges                                 | 0.4 m | 0.3 m  | railing with posts every 2 m       | 18 m               |

- **Built-up** means at least 8 buildings within about 75 m, the same measure as the road markings.
- **No battlefield is named.** Styles depend on class and setting only.

### Water and shores

- The water keeps its level and stays visible beside and under the deck.
- The shore materials of ADR 0040 are untouched. Beaches never show on the deck, because the deck
  is above them.
- Abutments and piers reach into the ground, so nothing floats.

### Determinism, caching, versions

- **Determinism.** Roads, water and bridges are taken in order of id, with no randomness. Feature
  order does not change the result (tested).
- **Caching.** Bridges are part of the feature geometry, built once per terrain in the worker, and
  not rebuilt when switching between 2D and 3D.
- **Versions.** `BRIDGE_VERSION` is 1, and `GEOMETRY_VERSION` is 4.

### The ground under bridges (`GRADING_VERSION` 3)

ADR 0040's stand-in deck, a strip of ground at the water's level plus 0.3 m under roads mapped as
bridges, is removed now that bridges are drawn. It showed as solid ground under the bridge instead of
open water. The ground under a road over water is the bed, like any other water.

- It is a change to the authoritative ground, so `GRADING_VERSION` is 3. The terrain model becomes
  `dem-clean-v1+graded-v3`, and scenarios planned on version 2 notice it, as for ADR 0032.
- The simulation is otherwise unaffected. Soldiers could never stand on that strip (water areas are
  impassable), and line of sight across water is unchanged (it is flat, below any eye).

### Simulation isolation

- The simulation never imports the 3D view (enforced by `tools/boundaries.test.ts`).
- `Road.crossing` is display data.
- A test builds the feature geometry from a deep-frozen terrain and checks:
  - that the terrain is unchanged;
  - that line of sight is identical;
  - that picking still finds the water or the ground under the deck, not the deck.
- Movement, viewsheds and the AAR read the same terrain as before, so they are unaffected.

## Measurements

Node, on the recorded battlefields re-imported with the 1.8.0 importer. A browser sweep was running
at the same time, so these are upper bounds.

| Site       | Bridges (mapped / inferred) | Piers | Low clearance | Planning | All bridge work | Triangles |
| ---------- | --------------------------- | ----- | ------------- | -------- | --------------- | --------- |
| Woolgoolga | 21 (21 / 0)                 | 3     | 9             | 128 ms   | 0.40 s          | 23,474    |
| Bled       | 26 (26 / 0)                 | 7     | 3             | 157 ms   | 0.50 s          | 18,660    |
| Quantico   | 10 (10 / 0)                 | 0     | 2             | 107 ms   | 0.28 s          | 7,100     |
| Grafenwöhr | 15 (15 / 0)                 | 0     | 1             | 165 ms   | 0.42 s          | 5,792     |

- **"All bridge work"** is planning, structure and lifting the road layers, markings and paths. The
  lifting first rejects triangles by a 20 m bucket index and copies the untouched ones in runs. It
  went from 1–4 s in a first version to about 0.3–0.5 s.
- **Triangles.** Bridges add 5–24 thousand, against 0.8–1.4 million road triangles. They add one
  draw call.
- **Memory.** Under 1 MB of vertex data per battlefield.

## Limitations

- **Units on bridges are drawn on the ground.** The simulation has no bridges: soldiers cannot enter
  water areas, and where a levelled channel is crossable (a river mapped only as a line), a soldier
  walks through it on the ground. Their markers are not lifted onto the deck. _Superseded by ADR
  0043:_ the bridges are planned in the simulation (`sim/bridges.ts`), soldiers cross those over
  water, and stand and are drawn on their decks.
- **Low clearance.** Where the banks are lower than the water's level plus the clearance, or the
  10 m DEM rises above the deck in a narrow creek valley, the deck can sit close to the water or
  dip into the ground. These are counted as `lowClearance`: Woolgoolga's mangrove footbridges, for
  example.
- **Roads crossing under a bridge** within its footprint (an underpass next to an abutment) are
  lifted with it.
  Still so after ADR 0044, which lifts roads onto the one surface of a bridge structure and stops
  barriers where roads join it, but does not yet keep a road under the deck on the ground.
- **No movable, arch or suspension designs.** `bridge=movable` and `bridge:structure` are kept but
  drawn as ordinary beam bridges. `layer` is kept, and since ADR 0044 decides which roads meet at a junction.
- **Mapped bridges over dry land** are drawn at their road's height, spanning the straight line
  between their ends. They get piers only where they stand more than 2 m above the ground.
