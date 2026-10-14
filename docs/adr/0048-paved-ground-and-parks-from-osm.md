# ADR 0048: Paved ground and parks from OpenStreetMap

- Status: Accepted
- Date: 2026-10-13
- Importer version: 1.9.0

## Context

Towns were drawn as grass. The importer kept only `landuse=*` and some `natural=*` areas, so
a city block was just `landuse=residential`. Nothing said which ground was paved and which was
green, and parks mapped as `leisure=park` were not imported at all. OpenStreetMap records this
in detail, especially in the Netherlands:

- **Hard ground:** car parks, squares, pedestrian areas, and `area:highway=*` (the outlines of
  carriageways and footways).
- **Green ground:** parks, gardens, playgrounds, pitches, and `landcover=grass`.
- **Surface:** `surface=*` on any of these.

## Decision

- **The query** also asks for:
  - `leisure` parks, gardens, playgrounds, commons, dog parks, golf courses and pitches;
  - `amenity=parking`;
  - `place=square`;
  - `highway=pedestrian` multipolygons;
  - `area:highway=*`;
  - `landcover=grass`.
- **A new land use, `paved`,** covers car parks, squares, pedestrian areas (`highway=pedestrian`
  with `area=yes`) and `area:highway=*` outlines:
  - with a grass surface (`grass`, `grass_paver`), or as `area:highway=verge` or
    `traffic_island`, they are `meadow` instead;
  - buildings are never ground: a multi-storey car park stays a building, whichever source
    gives the buildings.
- **Green leisure areas** (parks, gardens, playgrounds, commons, dog parks, golf courses) are
  `recreation`. Pitches are `paved` when their surface is hard (asphalt, concrete, clay,
  tartan…), otherwise `recreation`. `landcover=grass` is `meadow`.
- **Precedence:** `paved` areas are drawn over the land use they lie in. The game's ground and
  land-cover colours paint smaller areas over larger ones; the terrain field (ADR 0049) paints
  `paved` over towns and lawns.
- **Display only.** `paved` gets a 2D map tint and the 3D ground's paving. The simulation does
  not use land use.

## Consequences

- **Old battlefields** keep their land use as imported. Battlefields generated or re-downloaded
  with importer 1.9.0 get the new areas; reprocessing stored sources does not, because the
  stored Overpass response lacks the new tags.
- **Download size.** Overpass responses for dense cities grow. Amsterdam's `area:highway` and
  leisure areas add many small polygons.
- **The 3D ground** (the terrain field, ADR 0049; prototyped in the terrain lab, ADR 0047) draws
  towns as mostly paved:
  - paving within 9 m of a road edge (pavements, forecourts);
  - paths and patios within 3 m of buildings;
  - gardens, lawns and open ground green behind the frontage;
  - mapped hard ground as paving;
  - parks, lawns and grass as grass.
- **Exact outlines** (2026-10-13). Mapped hard ground is drawn to its outline, not to the land
  cover's 2 m cells (whose edges showed as steps): the field gives each ground sample its signed
  distance to the nearest mapped paved area (`terrain-field/paved.ts`), and off the carriageways
  the nearer of that and the road edge is stored in the road edge channel, with surface code 6
  (`PAVED_AREA_SURFACE`): paving with no shoulder or verge. Footways, pedestrian ways, steps and
  corridors without a surface tag are paved everywhere (crossings showed as dirt outside towns);
  a `highway=path` stays dirt outside towns, and cycleways are asphalt.
