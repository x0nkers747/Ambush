# ADR 0037: Road markings, and no overhead wires

- Status: Accepted
- Date: 2026-10-11
- Builds on ADR 0030 (roads draped as continuous ribbons), ADR 0032 (the authoritative graded
  terrain) and ADR 0036 (environmental detail), whose overhead wires it removes.

## Context

ADR 0036 left two problems.

**Wires.** The overhead wires it drew between poles and pylons (one-pixel lines with sag) read
poorly. Up close they were thin, at a distance they aliased into hard dark strokes across the view,
and they added clutter to the views a trainee uses most.

**Bare roads.** The roads themselves were uniform grey ribbons, with no paint on them. Real roads
are marked according to their class, lanes, width and the country's conventions:

- In North America, yellow lines separate opposing traffic and white lines everything else.
- In Germany, all markings are white, with dashes much longer outside towns than inside.
- Residential streets, service roads and tracks are mostly left bare.

Markings have to look like part of the road surface. They must follow its curves, its junctions
and the graded ground, and must never drift from the drawn ribbon.

Both changes are visual only. Road geometry and widths, grading, movement, line of sight,
ballistics and the After Action Review are unchanged.

## Decision

### 1. Overhead wires removed

The wire generation is removed:

- the catenary spans and their clearance checks;
- the attachment points;
- the wire buffers (`WireSegments`, `wirePositions`);
- the `LineSegments` mesh and its material;
- the statistics fields;
- the wire tests.

Mapped power lines are still imported (`powerLine` and `minorLine` in the terrain's `decor`), for
later use, and their supports are still drawn: mapped towers and poles, and a pylon or pole at
each vertex of a mapped line.

Inferred utility poles stay, as standalone objects. Their placement is unchanged; only the "run"
bookkeeping that existed for wires is gone. Streetlights, trees, fences, guard rails, paths,
driveways, signs and every other detail are unchanged. `DECOR_VERSION` is now 2.

Tests check that a battlefield's plan has no wires and its scene no line meshes, and that mapped
lines keep their supports.

### 2. Road attributes kept for display (`roadTraffic`; importer 1.5.0)

Roads gain an optional, display-only `traffic` (`RoadTraffic` in `src/sim/environment.ts`), read
from OSM tags. A value is kept only when it is tagged and valid:

| Field                                    | OSM tag                                    | Notes                                                                       |
| ---------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| `lanes`, `lanesForward`, `lanesBackward` | `lanes`, `lanes:forward`, `lanes:backward` | Whole numbers from 1 to 12.                                                 |
| `oneway`                                 | `oneway`                                   | `yes`, `reverse` (for `-1`) or `no`. Roundabouts are one-way.               |
| `surface`                                | `surface`                                  |                                                                             |
| `maxspeedKmh`                            | `maxspeed`                                 | km/h; mph converted; `DE:urban` and similar zones resolved; `none` dropped. |
| `lit`                                    | `lit`                                      |                                                                             |
| `overtaking`                             | `overtaking`                               | `yes`, `no`, `forward` or `backward`.                                       |
| `laneMarkings`                           | `lane_markings`                            |                                                                             |
| `junction`                               | `junction`                                 | `roundabout` or `circular`.                                                 |
| `divider`                                | `divider`                                  |                                                                             |
| `sidewalk`                               | `sidewalk`                                 |                                                                             |

`turn:lanes`, `placement` and `shoulder` are not kept: nothing draws them yet.

The road's class and width are unchanged. A tagged `width` was already the simulated width, and
the default width is still marked as estimated.

The recorded data shows these tags are common:

| Battlefield | Highway ways | `lanes` | `surface` | `oneway` | `maxspeed` | `lane_markings` |
| ----------- | ------------ | ------- | --------- | -------- | ---------- | --------------- |
| Quantico    | 1,009        | 178     | 364       | 146      | —          | 21              |
| Grafenwöhr  | 1,297        | 63      | 379       | 94       | 116        | 5               |

**Crossings.** Marked pedestrian crossings are imported as a new detail kind, `crossing`, from
`node["highway"="crossing"]`. A crossing is drawn as zebra bars when `crossing_ref=zebra`,
`crossing=zebra`, or `crossing:markings` is `zebra` or `ladder`. It is drawn as two transverse lines
for other marked crossings: `crossing=marked`, `uncontrolled` or `traffic_signals`, or
`crossing:markings` `yes`, `lines` or `dashes`. Unmarked crossings are dropped.

**Recorded crossings:**

- Quantico has 161 crossings: 126 marked, of which 25 are zebra or ladder.
- Grafenwöhr has 10, all untagged, so none are drawn.

**Compatibility.** Older battlefields have no `traffic` and no crossings. The classifier then falls
back on the road's class and width (see below), and nothing needs re-importing. The simulation
never reads `traffic`. `src/exercise/display-attributes.test.ts` gives every road of the demo
contradicting traffic attributes (six lanes, one-way, painted, 130 km/h) and still gets identical
grading, sight lines, events and state hash.

### 3. Which roads are painted (`markingSpec`)

The classifier decides from, in order:

1. explicit marking tags;
2. the road's class (`highway`);
3. its lanes and direction;
4. its width;
5. its surface;
6. the region;
7. a conservative default.

**Never painted:**

- roads tagged `lane_markings=no`;
- anything that is not paved (tracks, paths, unpaved roads, or an unpaved `surface`);
- roundabout rings (their approaches stop at them);
- service roads and driveways, whatever their width;
- footways and paths.

`lane_markings=yes` paints any paved road of at least 4 m.

**By class** (W is the road's width; the class defaults are 6 m for paved and 8 m for major roads):

| Class     | Highway values             | Painted                                                                                     | Edge lines                              |
| --------- | -------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------- |
| highway   | motorway, trunk            | always                                                                                      | always                                  |
| arterial  | primary, secondary         | always                                                                                      | when W ≥ 6.5 m                          |
| collector | tertiary                   | when W ≥ 5.5 m                                                                              | when W ≥ 6.5 m, outside built-up places |
| minor     | unclassified               | from 5.5 m in North America (6 m elsewhere); in central Europe only with `lanes` ≥ 2 tagged | no                                      |
| local     | residential, living_street | only if tagged `lane_markings=yes`, or with three or more lanes and W ≥ 9 m                 | no                                      |

Width alone never paints a road: a wide industrial driveway stays bare.

On older battlefields, which keep no road type, only main roads (class `major`) are painted.

**Lanes and direction.**

- **Two-way roads** have `lanes` lanes (default 2). Unless tagged forward/backward, they are split
  evenly, with forward lanes on the right of the way.
- **The line between opposing traffic** lies between the backward and forward lanes, so asymmetric
  lanes move it.
- **One-way roads** have `lanes` lanes, or 2 when at least 7 m wide, else 1. They get white dashed
  separators and no centreline.
- **Divided roads.** On a one-way carriageway of a highway or a multi-lane arterial, the left edge
  (against the median) takes the region's left-edge colour and the right edge is white.
  `oneway=-1` swaps the sides.
- **Physical median.** A two-way road tagged with one (`divider=barrier`, `grass_verge` or
  `rumble_strip`) gets edges and no centreline.

**Centre-line pattern, in order of precedence:**

1. **`divider`:** `solid_line`, `dashed_line` or `double_solid_line` is drawn as tagged.
2. **`overtaking`:**
   - `no` gives a double solid line in North America, a single solid line elsewhere;
   - `forward` or `backward` gives a solid-and-dashed pair, dashed on the side allowed to pass;
   - `yes` gives a dashed line.
3. **Four or more lanes, undivided:** a double solid line in North America, a single solid line
   elsewhere.
4. **Built-up places in North America** (except highways): a double solid yellow line.
5. **Otherwise:** a dashed line. On rural two-lane roads with unknown passing rules, this is the
   regional standard.

Lines never alternate by chance.

**Built-up** means at least six buildings within about 75 m of the way's middle.

### 4. Regional conventions (`MARKING_STYLES`)

|                                    | North America (MUTCD)           | Central Europe (German RMS)                                           | Generic fallback                             |
| ---------------------------------- | ------------------------------- | --------------------------------------------------------------------- | -------------------------------------------- |
| Centre line                        | yellow                          | white                                                                 | white                                        |
| Separators, right edges            | white                           | white                                                                 | white                                        |
| Left edge of a divided carriageway | yellow                          | white                                                                 | white                                        |
| Line width                         | 11 cm (4 in)                    | 12 cm ("Schmalstrich")                                                | 12 cm                                        |
| Edge width                         | 11 cm; 15 cm on highways        | 15 cm; 25 cm on motorways ("Breitstrich")                             | 12 cm; 20 cm on highways                     |
| Dash / gap                         | 3.05 m / 9.15 m (10 ft / 30 ft) | 3 m / 6 m in towns; 6 m / 12 m outside and on motorways ("Leitlinie") | 3/6 m in towns; 3/9 m rural; 6/12 m highways |
| Double line                        | 22 cm between line centres      | 24 cm (only where tagged)                                             | 24 cm                                        |
| Built-up two-way centre            | double solid                    | dashed                                                                | dashed                                       |
| Stop line                          | 45 cm                           | 50 cm ("Haltlinie")                                                   | 45 cm                                        |
| Zebra bar                          | 60 cm                           | 50 cm                                                                 | 50 cm                                        |

The region comes from the battlefield's metadata or the buildings' addresses, as in ADR 0035, never
from its name:

- `north-american` for the US and Canada;
- `central-european` for Germany and its neighbours, whose rules are close but not identical
  (Austria and Switzerland use the same colours and similar dashes);
- `generic` elsewhere.

Countries with yellow centrelines outside North America, or with different dash rhythms, need
their own entry.

**Paint colours** are muted, not glowing: a warm white (`#dedbd1`) and a traffic yellow
(`#c79b3a`). Each dash is a shade lighter or darker than the next, a cheap hint of wear.

### 5. Geometry (`planMarkings`, `roadMarkings`)

**Chains.**

- Ways are joined into chains where exactly two vehicle ways meet, end to end, with identical
  markings in the chain's direction.
- A way drawn the other way round is joined with its offsets mirrored, so an OSM road split into
  several ways, in either direction, is one chain.
- Chains stop at junctions (three or more ways), at dead ends, where the markings change (width,
  lanes, class) and on loops.

**Lines.**

- Every line is the chain's own centreline, the very points the road ribbon is drawn from, moved
  sideways along mitred normals.
- At a bend, the mitre keeps the offset constant. Its length is limited to twice the offset, so
  sharp corners cannot spike.
- Offset lines (edges, separators) are interrupted for a few metres around turns sharper than
  65°, rather than folding.
- On curves the lines follow every vertex. A test checks that a quarter circle's edge lines stay
  within 5 cm of their offset radius.

**Dashes.**

- Dashes are laid by distance along the chain, from its start, with one rhythm for the whole
  chain.
- The rhythm continues across OSM way boundaries and across junction gaps. A road split into three
  ways (one reversed) gets exactly the dashes of the same road as one way.
- Uneven vertex spacing changes nothing.

**Junction clipping.** A line is not painted where it would lie on another vehicle road's surface
plus 1 m. This happens at crossroads, side roads and roundabouts.

- **Side roads.** Where a side road ends on this road (a T-junction), only the side it arrives
  from is cut. The far edge line runs on, as on real roads.
- **Service roads and driveways** cut edge lines (at their mouths) but not centre lines or
  separators, so a row of driveways does not riddle a centreline.
- **Paths and footways** never cut paint.
- **Levels** (ADR 0044): only roads on the line's own level cut it. A road on a bridge or in a
  tunnel, or one joined only through a bridge's end node, does not; tunnel roads get no markings
  (`MARKING_VERSION` 2).
- **Fragments.** Dash fragments under half a dash, and solid pieces under 2 m, are left out, so no
  isolated scraps remain.

**Crossings and stop lines** come only from mapped data:

- **Mapped marked crossings** are drawn across the road's paved width and clear all of that road's
  lines within 3 m:
  - zebra crossings as 3 m bars along the road, alternating with gaps;
  - other crossings as two lines 3 m apart.
- **Mapped stop signs** (`highway=stop`, `DE:206`, `US:R1-1`) on a paved road get a stop line
  across the right half of the approach to the nearest junction within 40 m. Junctions include
  road ends on another road's side.
- Directional arrows and yield markings are not drawn: the data rarely supports them reliably (13
  `turn:lanes` ways at Quantico).

**Draping.**

- Each painted piece is split at the chain's points and draped by the road draper (ADR 0030). It
  is cut along the terrain's triangles, the refined ones included (ADR 0032), and sits 1.2 cm above
  its road's layer (major roads 9 cm, other paved roads 8 cm above the ground).
- It can neither float nor sink, nor disappear at refinement tiles. A test checks this on graded,
  refined, hilly terrain.
- A polygon offset (−1, −16) keeps it in front of the road ribbon at any distance, with no
  z-fighting. The ground and the road itself are never changed.

**Rendering.** All markings, crossings and stop lines form one mesh with vertex colours and one
`MeshStandardMaterial` (roughness 0.7, receives shadows): one draw call. There are no textures and
nothing per frame. `MARKING_VERSION` is 1, independent of the terrain, grading and simulation.
`GEOMETRY_VERSION` stays 3. The mesh's buffers are transferred from the worker with the rest, and
disposed with the feature layer.

## Results

**Recorded battlefields** (Node, one thread):

|                             | Quantico                            | Grafenwöhr                         |
| --------------------------- | ----------------------------------- | ---------------------------------- |
| Marked roads (of all roads) | 94 of 955                           | 78 of 1,211                        |
| Marked roads by class       | 38 arterial, 28 collector, 28 minor | 49 arterial, 27 collector, 2 minor |
| Chains                      | 73                                  | 60                                 |
| Centre line painted         | 5.5 km                              | 7.8 km                             |
| Separators painted          | 0.8 km                              | 0.4 km                             |
| Edge lines painted          | 14.3 km                             | 18.2 km                            |
| Crossings / stop lines      | 124 / 17                            | 0 / 2                              |
| Triangles                   | 41,867                              | 54,187                             |
| Generation                  | 0.28 s                              | 0.30 s                             |

In the browser (Chromium with SwiftShader, software WebGL, the low preset at 1600 × 1000). Before is
the previous commit (c2ce83a, with wires), after is this change. Same recorded data and cameras;
the opening overview camera:

|                                     | Quantico before | Quantico after | Grafenwöhr before | Grafenwöhr after |
| ----------------------------------- | --------------- | -------------- | ----------------- | ---------------- |
| Draw calls (overview)               | 17              | 17             | 18                | 18               |
| Triangles drawn (overview)          | 3.25 M          | 3.29 M         | 3.99 M            | 4.05 M           |
| Marking triangles                   | —               | 41,867         | —                 | 54,187           |
| Marking generation (worker)         | —               | 0.22 s         | —                 | 0.30 s           |
| Applying results on the main thread | 262 ms          | 253 ms         | 506 ms            | 417 ms           |
| Geometry buffers in the scene       | 206 MB          | 211 MB         | 269 MB            | 275 MB           |
| First 3D frame after opening        | 14.4 s          | 10.1 s         | 10.8 s            | 8.8 s            |

The demo battlefield has no road types (format 2 data), so it gets no markings and is unchanged:
94 draw calls, 75.8 k triangles.

- **Draw calls** do not change: the markings mesh replaces the wire mesh.
- **Triangles** grow by 1.3–1.4 %.
- **Generation time.** Marking generation takes 0.2–0.3 s in the generation worker.
- **Memory.** Geometry grows by about 5 MB.
- **First frame.** The first-frame times vary from run to run under the software renderer by more
  than any effect of this change. The first frame comes before features in any case.
- **Frame rate.** No real GPU was available, so frame rates were not compared.

Screenshots, before and after from identical cameras, are in `docs/research/road-markings/`. For
each battlefield they cover the road network from above, a residential street, a rural paved road,
a major road, a curve, a junction and a low view along a road. The demo battlefield is covered too.

## Consequences and limitations

- **Inferred patterns.** Where passing rules are not tagged (almost everywhere), the centre-line
  pattern is the regional default for the road's context, not the real one: dashed on rural
  roads, double solid yellow in North American towns. No-passing zones on rural curves are not
  inferred.
- **Lanes are equal width,** split from the road's total width. Turn lanes, bus lanes, cycle lanes
  and parking lanes are not drawn, nor are arrows, yield markings, chevrons, hatched areas or
  words.
- **Edge lines keep a fixed inset** from the road's edge. Shoulders are not modelled.
- **Junctions are clipped, not designed.** Lines stop short of other roads; there are no
  turning-lane tapers, painted islands or continued dashes across junctions.
- **Stop lines and crossings come from mapping.** Stop lines appear only at mapped stop signs, and
  crossings only where mapped and marked. Grafenwöhr's ten crossings are untagged and so are not
  drawn.
- **Regions are coarse.** Three styles cover the world: US and Canada, Germany and its neighbours,
  and a white fallback. The UK, Japan, Scandinavia and others differ in colours and rhythms that
  are not modelled.
- **No overhead wires are drawn.** Mapped lines remain in the data for a future, better rendering.
