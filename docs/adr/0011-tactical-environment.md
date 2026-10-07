# ADR 0011: Tactical environment, path planning and line of sight

- Status: Accepted
- Date: 2026-10-07

## Context

A planning problem with only a heightfield has few meaningful choices. Phase
3.6 adds roads, buildings and vegetation, routes around buildings, and a
line-of-sight query that the planning tools use now and combat will use later.
Today's environment is synthetic; later it will come from GIS sources (OSM,
DEM). Both must feed the same runtime representation.

## Decision

### Three representations

1. **Source/import data** (later): OSM extracts, DEM rasters, cadastral data.
   Never seen by the simulation.
2. **Normalized environment data:** `TerrainDataset` (ADR 0006), format
   version 2, holding:
   - the heightfield;
   - `features: { roads, buildings, vegetation }` in map metres.

   Immutable world data: deep-frozen, never in `SimState` or snapshots, and
   covered by the world fingerprint (ADR 0008).

3. **Runtime spatial queries:** `pointProblem`, `isSegmentWalkable` and
   `planPath` (`sim/navigation.ts`), and `lineOfSight` (`sim/los.ts`). The 2D
   renderer draws from (2) and never computes LOS itself.

The queries keep their spatial structures behind their interfaces:

- building bounds;
- the navigation grid, built once per terrain and cached by terrain object;
- prepared roof and canopy levels.

A spatial index can replace the linear scans later without changing callers.

### Features

| Feature          | Fields                                                                            | Effect now                                      |
| ---------------- | --------------------------------------------------------------------------------- | ----------------------------------------------- |
| `Road`           | id, `roadClass` (track, unpaved, paved), centreline (≥ 2 points), width           | Display only; movement is cross-country         |
| `Building`       | id, footprint (simple polygon), height                                            | Hard obstacle to movement and to LOS            |
| `VegetationArea` | id, kind (woodland, treeLine, scrub), boundary, canopy height, `seeThroughMeters` | Obscures LOS gradually; does not block movement |

Validation: ids are unique across all features, geometry is on the terrain,
polygons are simple, and sizes are positive.

**Building heights:** a building is its footprint extruded to a flat roof
`height` above the lowest ground at its corners.

### Future importer seam

An importer is an offline tool that writes a normalized `TerrainDataset`. The
runtime never parses source formats (ADR 0006).

- **DEM:** the bare-earth elevation raster, resampled into the heightfield.
- **OSM `highway=*`:** roads, with the class mapped from the highway type and
  the width taken from tags or class defaults.
- **OSM `building=*`:** footprints, with height from `height` or
  `building:levels` × a storey height, or a default.
- **OSM `landuse=forest`, `natural=wood`, `natural=scrub`, hedges and tree
  rows:** vegetation, with canopy height and see-through depth from kind
  defaults that can be overridden per scenario.
- **Every feature:** projected to the scenario's UTM zone and false origin;
  footprints simplified and repaired into simple polygons.

None of this exists yet.

### Path planning

The trainee's waypoints are intent. The legs between them are planned:

1. **Target check:** the destination must be on the terrain, outside every
   building, and at least `OBSTACLE_CLEARANCE_M` (0.75 m) from its walls.
   Otherwise the leg fails with that reason.
2. **Straight line:** if it keeps the clearance from every building, the leg
   is straight (no turns). On open terrain, behavior is exactly as before.
3. **A\* search** on a 2 m navigation grid:
   - eight neighbours, no cutting blocked corners, octile heuristic;
   - ties broken by lower f, then lower h, then lower cell index;
   - start and goal connect to the nearest free cell reachable in a straight
     line (ties: lowest index).

   A cell is blocked if its centre lies within the clearance plus half a cell
   diagonal of a building. That margin guarantees every grid step keeps the
   exact clearance.

4. **String-pulling:** from each kept node, jump to the farthest later node
   reachable by a straight walkable line. This removes grid zig-zags and never
   lengthens the path.

The result is the leg's **generated turn points**.

**When legs are planned:** when the simulation applies `setOrders`, it plans
every leg from where the soldier stands. It stores them in
`ActiveOrders.legPaths` with progress in `nextTurnIndex`, separate from the
trainee's `Orders`.

**Rejections:** an impossible leg rejects the command (`waypointBlocked`,
`waypointUnreachable`, `waypointOffTerrain`).

**Movement:** walks the turn points, then the waypoint. `waypointReached`
fires only for trainee waypoints, so generated geometry never appears as
trainee intent in events or plan revisions.

**Display and planning feedback:** the planning display calls the same
`planPath` (memoized), so the route shown is exactly the route that will be
walked. The exercise refuses a waypoint, with a trainee-facing reason, if it is:

- inside or against a building;
- off the map;
- unreachable from the previous point, or unable to continue to the next one.

It never moves a waypoint the trainee placed.

### Line of sight

`lineOfSight(terrain, from, to, options)`:

- runs from an observer's eye (default 1.7 m above the ground) to a target
  point (default 1.5 m, a standing person's upper body);
- returns `clear`, plus the first obstruction: its cause (terrain, building
  id, or vegetation id), the 3D point, and the horizontal distance.

It's exact rather than sampled. The sight line is cut wherever any of these
change along it:

- the ground's slope (crossings of terrain grid lines and of the SW–NE cell
  diagonals, ADR 0008);
- building membership (footprint edges);
- vegetation membership (vegetation boundary edges).

Each piece is cut again where the line crosses the ground, a roof or a canopy
top. On every part, all levels are linear.

**Obstruction rules:**

- **Terrain:** the ground rises above the sight line.
- **Building:** the sight line passes over its footprint below its roof. A line
  above the roof is clear.
- **Vegetation:** each metre of sight line inside an area and below its canopy
  adds `1 / seeThroughMeters` of obscuration, summed over all areas. The line
  is blocked where the total reaches 1. That area is reported (the one adding
  most at that point; lowest id on a tie). A line above the canopy is
  unaffected. This is a deliberately simple, deterministic stand-in for
  concealment; a richer transmission model can replace the accumulation step
  without changing the query.

Posture-specific heights are not modelled yet.

### Planning tools

- **CHECK LOS** (tool key L) looks from the selected BLUEFOR soldier's planned
  final position: the last waypoint of the plan. With no waypoints it uses the
  current position, and the UI says so. A click inspects the sight line to
  that point; the map shows:
  - the clear part in green, then the obstructed part in red;
  - an X at the first obstruction;
  - a label such as `BLOCKED — BUILDING B-2`.
- **LOS to kill zone** checks sight lines to deterministic sample points. These
  are every corner, the middle of every side, and the area centroid when it is
  inside the zone: 2n + 1 points for a convex n-gon, in corner order. It
  reports `LOS TO KILL ZONE: k / m sample points clear`.

These tools give information only. Nothing scores positions or recommends
them, and tactically poor positions remain possible; only physically
impossible movement is prevented.

## Consequences

- Combat (Phase 4) can call `lineOfSight` unchanged.
- Determinism:
  - all queries are pure functions of immutable data, with explicit
    tie-breaking;
  - planned paths are part of the simulation state and so of snapshots and
    hashes;
  - movement along turn points keeps the exact time splitting of ADR 0008, so
    tick-rate independence is unaffected.
- Performance on the demo map (800 m × 600 m, 8 buildings):
  - about 0.1 ms per sight line;
  - a few milliseconds for a path that needs A\*;
  - straight legs are near-instant.
