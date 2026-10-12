# ADR 0044: Road junctions, grade separation and bridge structures

- Status: Accepted
- Date: 2026-10-12
- Extends ADR 0030 (3D geographic features), ADR 0037 (road markings) and ADR 0041 (procedural
  road bridges). Keeps ADR 0032 (authoritative graded terrain) and ADR 0043 (bridge navigation):
  the simulation is unchanged.

## Context

The 3D roads and bridges were tuned on rural and small-town battlefields (Quantico, Grafenwöhr,
Woolgoolga, Bled). A dense city shows defects those battlefields hide. To find them on real data,
central Amsterdam was imported through the normal pipeline and recorded for regression testing.

### The Amsterdam battlefield

| Setting   | Value                                                         |
| --------- | ------------------------------------------------------------- |
| Centre    | 52.3702, 4.8952 (Dam / Grachtengordel)                        |
| Size      | 5 km × 5 km, the app's default request (`battlefieldRequest`) |
| Elevation | Terrarium tiles (AWS open data), as the app downloads them    |
| Features  | One Overpass query, as the app makes it (`planBattlefield`)   |
| Buildings | From OpenStreetMap (Overture was not used for the recording)  |
| Import    | `buildBattlefield`, then `authoritativeGround`, as the app    |

It is reproducible with

```
npx tsx tools/record-battlefield.ts amsterdam <out-dir>
```

The tool downloads the elevation tiles and the Overpass response once, then builds the battlefield
package with the app's importer. The raw inputs are about 90 MB of Overpass JSON plus the tiles,
so they are not committed. Only the recorder is (`RECORDED_SITES.amsterdam`).

The first recording contained:

- 16,598 roads, 991 of them mapped as bridges;
- 53,568 buildings, 541 water areas and 935 waterways.

Grading takes 62 s in Node. In the browser (SwiftShader, low quality), opening the battlefield
takes 59 s, and the first 3D frame appears after 81 s.

OpenStreetMap changes, and Overpass mirrors lag one another, so a recording is a snapshot. The
validation below used a second recording, made on 2026-10-12 (served by
`overpass.private.coffee`): 15,646 roads (954 mapped as bridges), 53,377 buildings, 528 water areas
and 931 waterways. Both the "before" (main) and "after" screenshots were taken from it, so each pair
differs only in the code.

### Defects observed (before)

The screenshots were taken in the browser from ten fixed cameras. They are kept in
[`docs/research/road-junctions-bridges`](../research/road-junctions-bridges/), with the "after"
screenshots from the same cameras. The cameras (`ambushSetView` on the 3D canvas: target x and y
in map metres, distance in metres, pitch below the horizon and heading clockwise from north, in
degrees) are:

| View                | Target     | Distance | Pitch | Heading |
| ------------------- | ---------- | -------- | ----- | ------- |
| v1-dense-junction   | 29, 15     | 110      | 55    | 20      |
| v2-minor-major      | 662, −133  | 90       | 55    | 0       |
| v3-acute            | −188, −46  | 90       | 55    | 0       |
| v4-five-way         | −463, 330  | 100      | 55    | 0       |
| v5-bridge-cluster   | 722, 477   | 220      | 55    | 0       |
| v6-parallel-bridges | 636, 926   | 140      | 50    | 0       |
| v7-bridge-cycleway  | 1290, 92   | 110      | 50    | 30      |
| v8-canal-road       | 505, 706   | 160      | 40    | 0       |
| v9-barrier-low      | 634, −1258 | 45       | 18    | 90      |
| v10-overview        | 0, 0       | 2600     | 62    | 0       |

1. **Junction overlap and z-fighting.** At every junction, each way drew its own rectangles,
   bend fans and junction disc. The overlapping pieces of different classes were separated only by
   the per-class height offsets (verge 4 cm, path 5, track 6, unpaved 7, paved 8, major 9). From any
   distance they flickered, and a narrow road's square end showed through the wider road it joined
   (v1, v2, v4).
2. **Minor road strips through major roads.** A side road's rectangle ran to its node on the major
   road's centreline: a strip of paved surface lay across half of the major road (v2).
3. **Acute junctions.** The narrow wedge between two ways meeting at a small angle was covered by
   both, twice, with a jagged edge (v3).
4. **Duplicated bridges.** In Amsterdam a carriageway, its cycle tracks and footways are often
   mapped as separate parallel ways, each tagged `bridge=yes`. Each got its own deck, slab, parapets
   and piers, at slightly different heights. Parapets stood in the middle of the bridge, between the
   carriageway and the cycle track, and slabs poked through one another (v5, v6, v7).
5. **Barriers across road entrances.** Parapets ran the full length of each deck. Where a quay road
   joined the bridge at its end (the usual canal-bridge layout), the parapet stood across the
   quay's entrance (v8, v9).
6. **Decks under water.** On 292 of Amsterdam's 787 bridges, the deck (pinned to its roads at the
   bank) sits below the canal's water level. The Terrarium DEM and the canal levels leave no room, and
   the water sheet was drawn over the deck (v9).
7. **Roads lifted onto the wrong deck.** Where two decks overlap at different heights, road
   triangles took the height of the nearest deck, so part of a road jumped up or down (v6).

### Root causes

- **R1: geometry, not topology, decided joins.** The surface was built per way, with no knowledge of
  the ways meeting it. Overlap was "resolved" only by height offsets (R5).
- **R2: barriers ignored the roads.** Barriers followed each deck's edges, with no knowledge of the
  roads joining the deck or of the other decks of the same structure.
- **R3: one deck, one structure.** `planBridges` (in the simulation since ADR 0043) plans a deck
  per way, which is right for navigation. The renderer drew each planned deck as its own structure.
- **R4: elevation data.** The low decks come from the DEM and the water levels of ADR 0040,
  which are authoritative. They are not a rendering bug, but the renderer drew water over them.
- **R5: per-class height offsets.** These made overlapping surfaces fight in depth, instead of one
  surface being drawn.

A survey of the old geometry on Amsterdam found:

- 153,681 overlaps between road surface pieces of different classes;
- 389 pairs of overlapping bridge decks drawn as separate structures (437 bridges).

## Decision

All of this is in the 3D view (`view3d`) and is display-only. Road heights, grading, the bridge
plan, the road network, path planning, movement, line of sight and the AAR are unchanged. No
battlefield gets its own fixes: everything is generic and driven by OSM topology.

### One road surface (`road-surface.ts`, `planar.ts`)

- **Disjoint pieces.** The surface is still built from convex pieces (ADR 0030):
  - a rectangle per segment;
  - a fan on the outside of each bend;
  - a junction disc where ways meet.

  The pieces are now placed in priority order, and each is cut by what was placed before it
  (`convexMinus`, exact convex polygon subtraction, with a 16 m bucket index, `Occupancy`).

  The order is:
  1. class (`CLASS_PRIORITY`: major, paved, unpaved, track, path);
  2. width, wider first;
  3. id.

  So every point of the network is covered by exactly one surface: the most important road's. A side
  road stops at the edge of the road it joins. A junction is one surface, whatever the angles, widths
  or number of arms. This covers T and four-way junctions, five-way junctions, offset junctions,
  acute angles, split ways and changes of width.

- **Same class, no cut.** Pieces of the same class are in one mesh at one height, so they need no
  cutting. Leaving them uncut keeps the triangle count close to before: cutting everything added 25%.
- **Fillets.** Where vehicle roads meet at 35°–150°, each corner gets a small fillet in the lesser
  road's style. Its radius is the smaller of 2.5 m and 0.75 × the narrower half width.
- **Roundabouts.** A roundabout is a closed ring of ways. It stays a ring with an unpaved centre,
  and its arms join it like any junction.
- **One height.** Every road layer is drawn at `ROAD_OFFSET_M` = 6 cm above the graded ground.
  Since nothing overlaps on one level, the per-class offsets (4–9 cm) are no longer needed (R5).
  This is a display offset; the graded ground is unchanged.
- **Verges and driveways** are bands outside their road, drawn as two strips per segment and a ring
  on each bend. They give way (`yields`) to every road surface, on any level, so a verge never
  covers the road beside it or under a bridge. Driveways and inferred paths (ADR 0036) use the same
  surface code, after the roads.

### Grade separation by topology

- **Levels.** A way's level comes from its bridge or tunnel tag and its `layer` (`roadLevel`).
- **When ways cut each other.** Two ways cut each other only:
  - when they are on the same level; or
  - when they share a node, matched to the millimetre (a bridge meeting its approach road).
- **What stays whole.** An overpass and the road under it both stay whole: there is no junction
  disc, no fillet and no cut. Two ways crossing on one level without a shared node are not a
  junction either (no disc, no fillets), but on one level only one surface can be seen, so the more
  important one is drawn.
- **Tunnels.** Tunnels are not drawn on the surface (`onSurface`), except culverts, which carry the
  road over a pipe.
- **Markings** (ADR 0037, `MARKING_VERSION` 2) apply the same levels:
  - a marking is cut where it crosses a road on its own level;
  - it is not cut where it crosses a road on another level, or one joined to it only through a
    bridge's end node;
  - tunnel roads get no markings.

  Markings continue through a junction on the major road, and stop at the major road's edge on
  the minor one.

### Bridge structures (`bridge-complexes.ts`, `bridges.ts`)

- **Structures.** Decks whose footprints touch within `TOUCH_M` (0.5 m), at heights within
  `SEPARATE_M` (1.5 m) where they meet, are one structure. This is a union-find over a bucket index.
  Decks crossing at clearly different heights stay separate: one passes over the other.
- **The spine.** A structure's spine is its widest deck, then its longest, then by id. The other
  decks are ranked by how much they overlap it.
- **One deck surface.**
  - The plan pins each deck to its road at its own ends (ADR 0041). Where another deck of the
    structure ends on the spine, that end pins the spine there too. Pins pass along the structure
    (`pinsOf`).
  - The spine is lowered to `pin.z + MAX_GRADE·|Δs|` near each pin, never below its centre's
    ground.
  - The other decks take the height of the deck they lie on, and ramp back to their own heights
    over `RAMP_M` (3 m) beyond its edge and near their own ends.

  So the structure is flat across, continuous, and every deck still meets its road at its ends.
  A point's height is that of the earliest-ranked deck containing it (`index.at`, allocation-free).

- **Structure drawn once.**
  - A multi-deck structure gets one shared slab.
  - Barriers run only on its outside: never along an edge that lies on another deck of the
    structure (`onOtherDeck`).
  - Piers within 4 m plus the pier's height are merged.
  - Abutments inside the structure are skipped.
- **Barriers stop at road entrances.** Barriers are runs (`BarrierRun`) that stop wherever a road
  joins the deck (`roadEntrances`). A road joins the deck when its surface is there, it is not
  carried by the structure, and it is on the deck's level or shares a node with one of the deck's
  roads. A road passing under the bridge does not stop the barrier.
- **Roads onto decks.** Road, marking and path triangles are lifted onto the deck that contains
  them, using the same index as the deck surface (R3). The test for being near a deck is now precise
  (corners, edge midpoints and the centroid), which also made lifting faster.
- **Water under low decks.** Under a deck less than `LOW_DECK_M` (0.1 m) above the water, the water
  surface is cut away (`cutUnderDecks`), so the deck is never drawn beneath a sheet of water. The
  test is against the water as drawn under the deck's edges and centre (`waterIndex`), not only
  the level under its centre line: near a bank the water surface rises (ADR 0040). The decks keep
  their authoritative heights: the defect is in the elevation data (R4), and it is reported as a
  limitation.

### Fixes from validation on Amsterdam

The first browser screenshots of this design showed defects the diagnostics did not catch. They
were found with a probe of the drawn meshes around each spot and fixed generically:

- **Roads under the terrain at deck ends (v9, v6).** A deck is flat across, at the ground under its
  centre line. Near its end on a sloping bank, or where a structure's decks were lowered to meet
  their roads, the deck is lower than the ground beside it, and lifting blended the road below the
  terrain: grass showed through the road (v9) and the bank poked through a bridge junction as dark
  spikes (v6). Main hid part of this under its 9 cm offset for major roads. Lifting now never puts
  a vertex below where it was draped (`liftOntoBridges`): it can only raise a road onto a deck.
- **Shared slabs following the road (v6).** A structure's slab took heights only at the corners of
  its cut pieces, so a piece spanning decks at different heights became a spike. Its triangles are
  now split where the structure's surface strays more than `SLAB_FLAT_M` (2 cm) from them, down to
  2 m edges like the road on it, and take their heights from the same index the road is lifted
  with, so the slab stays just under the road.
- **Water over a road on a low bank (v6).** Where the elevation data puts a road on a bank below the
  water level beside it (between two bridges' ends, in v6), the water sheet was drawn over the road.
  The water is now cut away under road surface on the ground (`groundRoadHoles`): not on a bridge
  level, not on a deck, not a ford, and only where the water there is at most `BANK_DEPTH_M` (1 m)
  over the road. Deeper water over a road (a way through water with no bridge mapped) stays, as
  before.
- **Hidden roads in the diagnostics.** Two new checks report a road surface drawn below the ground
  (`roadBuried`) or below the water drawn over it (`roadUnderWater`), so this class of defect is
  found on any recorded battlefield.

### Mesh hygiene

- Collinear vertices are removed from the cut pieces.
- The draper drops triangles thinner than 0.5 mm (twice the area over the longest edge < 5e-4 m).
  These collapse to zero area at float32 precision.

### Diagnostics (`geometry-diagnostics.ts`)

`diagnoseGeometry(terrain)` builds the roads and bridges as the 3D view does. It returns warnings
that name the features, where they are (map metres and, with a georeference, degrees), the kind
and the reason. Each warning is classified as unexpected (a defect) or a limitation of the data:

| Kind                 | Severity   | What it is                                                         |
| -------------------- | ---------- | ------------------------------------------------------------------ |
| `roadOverlap`        | unexpected | two road layers covering a spot at the same height                 |
| `roadBuried`         | unexpected | a road surface drawn below the ground                              |
| `roadUnderWater`     | unexpected | water drawn over a road surface (a limitation where over 1 m deep) |
| `duplicateDeck`      | unexpected | overlapping decks at similar heights drawn as separate structures  |
| `barrierOnRoad`      | unexpected | a barrier on another road's surface or on another deck of its own  |
| `pierOnRoad`         | unexpected | a pier standing on a road surface                                  |
| `deckStep`           | unexpected | a deck end more than 15 cm from the road it meets                  |
| `invalidVertex`      | unexpected | a non-finite position                                              |
| `degenerateTriangle` | unexpected | a zero-area triangle                                               |
| `lowDeck`            | limitation | a deck less than 10 cm above the water under it                    |

Intended contacts are counted in `expected`, not reported. These are a road meeting a bridge at its
end, the decks of one structure, and a road under a bridge.

The diagnostics can be run on any recorded battlefield:

```
AMBUSH_DIAGNOSE=<package.json> [AMBUSH_DIAGNOSE_OUT=report.json] \
  [AMBUSH_DIAGNOSE_WITHIN=minX,minY,maxX,maxY] [AMBUSH_DIAGNOSE_CHECKS=roads,bridges,meshes] \
  npx vitest run src/view3d/diagnose.cli.test.ts
```

Without `AMBUSH_DIAGNOSE` this test is skipped.

### Determinism, caching, versions

- Everything is pure and deterministic. Roads are ordered by priority, then by id; decks by id.
  Tests check that reversing the input gives identical meshes and structures.
- `GEOMETRY_VERSION` 6 and `MARKING_VERSION` 2 invalidate cached feature geometry.
- `GRADING_VERSION` and the scenario versions are unchanged, because the simulation's inputs are.

### Simulation isolation

A test builds the feature geometry on a shared terrain. It checks that the road network, a path
plan, a road-following path plan, a line of sight and the ground and surface heights are identical
before and after (`bridge-complexes.test.ts`). The planning stays in `sim/bridges.ts`.
Coordination only reads the plan.

## Measurements

All on the second Amsterdam recording and on recordings of Quantico and Grafenwöhr made the same day
(`tools/record-battlefield.ts quantico|grafenwoehr`), on one machine (AMD Radeon 880M integrated
graphics, Windows 11).

**Diagnostics** (warnings by kind; limitations in brackets):

| Kind             | Amsterdam | Quantico | Grafenwöhr |
| ---------------- | --------- | -------- | ---------- |
| `roadOverlap`    | 453       | 0        | 8          |
| `roadBuried`     | 0         | 0        | 0          |
| `roadUnderWater` | 16 (89)   | 0        | 0          |
| `duplicateDeck`  | 0         | 0        | 0          |
| `barrierOnRoad`  | 0         | 0        | 0          |
| `pierOnRoad`     | 1         | 0        | 0          |
| `deckStep`       | 37        | 0        | 0          |
| mesh integrity   | 0         | 0        | 0          |
| `lowDeck`        | (373)     | (2)      | (1)        |

On Amsterdam, 129 structures of several decks (453 decks) are drawn as one. Of the 453 overlaps, 452
are within 30 m of a mapped bridge (388 within 15 m of a bridge end), as described under
Limitations. The 37 deck steps have a median of 0.25 m, 30 are under 0.5 m, and the largest is 1.0 m.
Grafenwöhr's 8 overlaps are paths meeting a road 5–15 m from a bridge end. An earlier build had
measured roadOverlap 467, lowDeck 272, pierOnRoad 1 and deckStep 264 (then 41), on the first
recording.

**Feature generation in Node** (`buildFeatures`; median of 5 runs, 2 on Amsterdam; seconds):

| Battlefield | Roads, main → this | Bridges, main → this | All features, main → this |
| ----------- | ------------------ | -------------------- | ------------------------- |
| Quantico    | 0.4 → 0.8          | 0.1 → 0.4            | 1.7 → 2.4                 |
| Grafenwöhr  | 0.5 → 1.0          | 0.2 → 0.2            | 1.4 → 2.1                 |
| Amsterdam   | 2.6 → 5.0          | 5.2 → 7.7            | 21.5 → 27.3               |

The bridge step includes lifting the roads, markings and paths onto the decks and cutting the water.

**Triangles** (millions, main → this):

| Battlefield | Roads       | Paths       | Markings    | Bridges     | Water       | Total         |
| ----------- | ----------- | ----------- | ----------- | ----------- | ----------- | ------------- |
| Quantico    | 1.02 → 1.09 | 0.04 → 0.03 | 0.04 → 0.04 | 0.01 → 0.01 | 0.46 → 0.46 | 1.70 → 1.76   |
| Grafenwöhr  | 1.31 → 1.49 | 0.07 → 0.06 | 0.05 → 0.05 | 0.01 → 0.01 | 0.02 → 0.02 | 1.75 → 1.92   |
| Amsterdam   | 7.03 → 6.55 | 0.51 → 0.34 | 0.23 → 0.22 | 0.96 → 0.79 | 1.33 → 1.34 | 15.09 → 14.26 |

Buildings (unchanged) are included in the totals: 0.14 M, 0.29 M and 5.02 M.

**In the browser** (Chromium, GPU, high quality; the feature worker's time):

| Battlefield | Feature worker, main → this | Roads       | Bridges     | 3D view ready, from page load |
| ----------- | --------------------------- | ----------- | ----------- | ----------------------------- |
| Quantico    | 1.8 → 2.5 s                 | 0.4 → 0.8 s | 0.1 → 0.4 s | 10.4 → 10.5 s                 |
| Grafenwöhr  | 1.5 → 2.1 s                 | 0.5 → 1.1 s | 0.2 → 0.2 s | 10.5 → 10.6 s                 |
| Amsterdam   | 24.8 → 29.0 s               | 3.1 → 5.1 s | 5.8 → 8.6 s | 55 → 58 s                     |

The 3D view shows the terrain while the worker runs; the feature worker is off the main thread.
Opening Amsterdam needs about 5.7 GB in the page's process on main and on this branch alike. In
Google Chrome (rather than Playwright's Chromium) the page's process sometimes crashed opening it,
on main as well.

## Limitations

- **Low decks.** A deck that the DEM and the water levels place below the water keeps its height:
  the water under it is cut away, so the deck shows at water level, not as a raised bridge. Raising
  it would change the authoritative surface that soldiers walk (ADR 0043). This is reported as
  `lowDeck`.
- **Same-class crossings without a node.** Two ways crossing on one level without a shared node
  (usually a mapping error, or a missing `layer`) are drawn as one surface with no junction or
  markings break. Ways of different classes there show the more important one.
- **Remaining overlaps.** The remaining `roadOverlap` warnings are between surfaces on different
  levels that share a node at a bridge's end, where the bridge's road continues past the deck
  edge. Most are paths and driveways meeting a road at a bridge.
- **Junctions on a bridge of decks at different heights.** Where ways mapped as bridges meet over
  water at clearly different heights (v6), the structure has steps between its decks, small slab
  fragments show at those steps, and a traffic island the ways enclose shows the water through it
  (nothing is mapped there).
- **Ways through water with no bridge mapped.** Footways, steps and service roads mapped through
  water (jetties, pontoons, quays the elevation data puts below the water) stay under water deeper
  than `BANK_DEPTH_M`, as on main: reported as `roadUnderWater` limitations (89 on Amsterdam). Where
  one road piece spans shallow and deep water it is not cut either (the 16 unexpected ones).
- **Remaining deck steps.** The remaining `deckStep` warnings are where several decks of a structure
  end at different places along a sloping bank, so that one height across cannot meet every road.
  They are mostly under 0.5 m.
- **Roads under a deck are lifted with it.** Lifting is by footprint, not by level (ADR 0041), so
  a road passing under a bridge, within its footprint, is drawn on the deck there. The surface and
  barriers know the levels; the lifting does not yet.
- **No lane-level geometry.** Junctions have no turn lanes, islands or kerbs, and roundabout centres
  are bare ground. Markings stop at junctions rather than being drawn through them as guide lines.
- **Cost.** Building the features costs more than before: about 0.7 s more on Quantico and
  Grafenwöhr and 6 s more on Amsterdam in Node (see Measurements), in the feature worker, off the
  main thread.
