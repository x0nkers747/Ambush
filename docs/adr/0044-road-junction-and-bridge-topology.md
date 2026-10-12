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

| Setting        | Value                                                          |
| -------------- | -------------------------------------------------------------- |
| Centre         | 52.3702, 4.8952 (Dam / Grachtengordel)                         |
| Size           | 5 km × 5 km, the app's default request (`battlefieldRequest`)  |
| Elevation      | Terrarium tiles (AWS open data), as the app downloads them     |
| Features       | One Overpass query, as the app makes it (`planBattlefield`)    |
| Buildings      | From OpenStreetMap (Overture was not used for the recording)   |
| Import         | `buildBattlefield`, then `authoritativeGround`, as the app      |

It is reproducible with

```
npx tsx tools/record-battlefield.ts amsterdam <out-dir>
```

The tool downloads the elevation tiles and the Overpass response once, then builds the battlefield
package with the app's importer. The raw inputs are about 90 MB of Overpass JSON plus the tiles,
so they are not committed. Only the recorder is (`RECORDED_SITES.amsterdam`).

The recording contains:

- 16,598 roads, 991 of them mapped as bridges;
- 53,568 buildings, 541 water areas and 935 waterways.

Grading takes 62 s in Node. In the browser (SwiftShader, low quality), opening the battlefield
takes 59 s, and the first 3D frame appears after 81 s.

### Defects observed (before)

The screenshots were taken in the browser from ten fixed cameras. They are kept in
[`docs/research/road-junctions-bridges`](../research/road-junctions-bridges/).

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
  decks keep their authoritative heights: the defect is in the elevation data (R4), and it is
  reported as a limitation.

### Mesh hygiene

- Collinear vertices are removed from the cut pieces.
- The draper drops triangles thinner than 0.5 mm (twice the area over the longest edge < 5e-4 m).
  These collapse to zero area at float32 precision.

### Diagnostics (`geometry-diagnostics.ts`)

`diagnoseGeometry(terrain)` builds the roads and bridges as the 3D view does. It returns warnings
that name the features, where they are (map metres and, with a georeference, degrees), the kind
and the reason. Each warning is classified as unexpected (a defect) or a limitation of the data:

| Kind                 | Severity    | What it is                                                         |
| -------------------- | ----------- | ------------------------------------------------------------------ |
| `roadOverlap`        | unexpected  | two road layers covering a spot at the same height                 |
| `duplicateDeck`      | unexpected  | overlapping decks at similar heights drawn as separate structures  |
| `barrierOnRoad`      | unexpected  | a barrier on another road's surface or on another deck of its own  |
| `pierOnRoad`         | unexpected  | a pier standing on a road surface                                  |
| `deckStep`           | unexpected  | a deck end more than 15 cm from the road it meets                  |
| `invalidVertex`      | unexpected  | a non-finite position                                              |
| `degenerateTriangle` | unexpected  | a zero-area triangle                                               |
| `lowDeck`            | limitation  | a deck less than 10 cm above the water under it                    |

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
- `GEOMETRY_VERSION` 5 and `MARKING_VERSION` 2 invalidate cached feature geometry.
- `GRADING_VERSION` and the scenario versions are unchanged, because the simulation's inputs are.

### Simulation isolation

A test builds the feature geometry on a shared terrain. It checks that the road network, a path
plan, a road-following path plan, a line of sight and the ground and surface heights are identical
before and after (`bridge-complexes.test.ts`). The planning stays in `sim/bridges.ts`.
Coordination only reads the plan.

## Measurements

<!-- MEASUREMENTS -->

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
- **Remaining deck steps.** The remaining `deckStep` warnings are where several decks of a structure
  end at different places along a sloping bank, so that one height across cannot meet every road.
  They are mostly under 0.5 m.
- **Roads under a deck are lifted with it.** Lifting is by footprint, not by level (ADR 0041), so
  a road passing under a bridge, within its footprint, is drawn on the deck there. The surface and
  barriers know the levels; the lifting does not yet.
- **No lane-level geometry.** Junctions have no turn lanes, islands or kerbs, and roundabout centres
  are bare ground. Markings stop at junctions rather than being drawn through them as guide lines.
- **Cost.** Building the road surface costs more than before: about 2–3 s more on Quantico and
  Grafenwöhr, in the feature worker, off the main thread.
