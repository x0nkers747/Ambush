# ADR 0043: Bridge crossing and OPFOR road following

- Status: Accepted
- Date: 2026-10-12
- Extends ADR 0011 (path planning), ADR 0014 (water is impassable) and ADR 0041 (bridges). Keeps
  ADR 0006 (immutable terrain), ADR 0008 (movement) and ADR 0039 (one game state for 2D and 3D).

## Context

**Path planning (ADR 0011).**

- Orders are planned when they are given (`setOrders`, `planPath`). A leg is either a straight
  line, if it is clear of buildings and out of water, or A\* on a 2 m grid with water and buildings
  blocked, followed by string pulling.
- The turn points are kept in `ActiveOrders.legPaths`. Movement walks them at constant speed, with
  z from `heightAt`.
- Connected areas of the grid rule out unreachable goals at once.
- The exercise's route display and scenario validation call the same `planPath`. The AAR replays
  recorded frames.

**What was missing.**

- **Bridges.** Bridges were decoration in the 3D view (ADR 0041). Since `GRADING_VERSION` 3, the
  ground under a bridge is the riverbed. A river mapped as an area therefore split the battlefield
  into areas no soldier could cross, although a bridge was drawn across it.
- **Roads.** OPFOR patrols walked straight between their waypoints, cutting across fields where a
  patrol would follow the road it was on.

**Roads in the data.** Roads are OSM ways, imported with their geometry (split only at the
battlefield's edge, not simplified). Two ways that share an OSM node therefore have exactly the
same coordinates there. `Road.crossing` keeps the bridge, tunnel, ford and `layer` tags.

## Decision

All navigation data is in the simulation layer and is built once per terrain: it is pure and
cached by terrain object. The 2D map, the 3D view, the live simulation and the replay therefore
use the same bridges, roads and routes. Nothing is computed per frame, and nothing depends on the
renderer.

### Bridges (`sim/bridges.ts`, `sim/bridge-navigation.ts`)

- **One plan.** `planBridges` (ADR 0041) moves unchanged from `view3d/bridges.ts` to
  `sim/bridges.ts`, and the 3D view imports it from `#sim`. The 3D view draws the bridges soldiers
  cross: the same plan, from the same terrain.
- **`NavBridge`.** Each bridge over water (any sample `wet`) carries:
  - its id and the roads it carries;
  - its walked centreline. This is the plan's 1 m samples, reduced by Douglas–Peucker to the
    points needed to stay within 0.1 m of the line and 0.05 m of the deck's height, each with the
    deck's height `z`;
  - its length and its half width;
  - whether each sample is over impassable water (an open-water area).
- **The surface (`surfaceHeightAt`).** The surface is a bridge's deck over impassable water, and
  `heightAt` everywhere else. A soldier can only be over impassable water on a deck.
  - Over a watercourse that soldiers may wade (a river mapped only as a line), the ground stays the
    surface, as before. A soldier fording beside the bridge is not lifted onto it.
- **Crossable bridges (`navigation.ts`).** A bridge over impassable water is crossable when both of
  its end points:
  - stand on open ground (on the battlefield, not in water, clear of buildings); and
  - are joined to a free grid cell by a straight walkable line (`connect`).

  Otherwise it is reported (`bridgeCrossings(terrain).rejected`, with the reason) and never used.
  A pier mapped as a bridge into a lake, or a bridge running off the battlefield's edge, is never
  crossed.

- **Standing on a deck.** `pointProblem` lets a soldier stand on a crossable bridge's deck over
  water. A waypoint or a nudged formation slot may be there.

### Bridges in path planning

- **Links.** Each crossable bridge is a link in the A\* search from the grid cell at one end to the
  cell at the other.
  - Its cost is the deck's length, but never less than the octile distance between the two cells,
    so the heuristic stays admissible.
  - The connected areas of the grid are joined across links (union–find on the area labels, once
    per terrain). A goal on the far side of a river is reachable, and A\* finds a bridge however far
    it is from the straight line.
  - The grid itself is unchanged: water stays blocked, and nothing else crosses it.
- **The route.** A route through a link is:
  - the land before it, string-pulled as before, ending at the bridge's entrance;
  - the deck's centreline points, entrance to exit, each with the deck's height, left as they are
    (no string pulling over water);
  - the land after it, string-pulled.
- **From or to a deck.** A path from a point on a deck goes along the deck to whichever end gives
  the shorter path. A path to a point on a deck arrives the same way. Two points on one deck are
  joined along it. This covers a soldier caught on a bridge by new orders (a reaction, ADR 0028).
- **Unchanged.** A straight walkable line is still taken as it is. Without bridges, every path is
  exactly as before.

### The road network (`sim/road-network.ts`)

- **Nodes.** There is a node at every vertex of every road. Occurrences at the same coordinates (to
  the millimetre) are the same node where they are on the same level, or where either is the end of
  its way.
  - A way's level is bridge or tunnel, and its `layer`.
  - A bridge therefore meets its approach roads at its ends. A road passing under it stays apart,
    even if the data shares a node in the middle of both.
  - Roads that cross without a shared node are never joined.
- **Edges.**
  - Each pair of consecutive vertices is an edge, with its length taken from the geometry and its
    road (its class and width).
  - An edge must be walkable (`isSegmentWalkable`: clear of buildings, out of water).
  - An edge that runs along a bridge's deck is kept instead, carrying the deck's centreline points
    and heights. Such an edge must be within 0.3 m of the bridge's centreline at both ends and in
    the middle, on a road the bridge carries. The bridge must be crossable, or over a watercourse.
  - Each bridge's end points are inserted into its roads as vertices, so that the deck edges start
    and end there.
  - Edges over impassable water with no crossable bridge (a ford across a lake, a broken mapping)
    are left out (`blockedEdges`).
- **Parts.** The network's connected parts, its incidence lists and an edge bucket index are built
  with it.

### Road following

- **The flag.** `Orders.followRoads` is optional and serializable.
  - The exercise sets it on OPFOR route orders. Its route display uses it (`opforPathFor`), and so
    does scenario validation (`legProblem`, the patrol's file positions). What the trainee is shown
    is what OPFOR walks.
  - BLUEFOR orders and OPFOR reactions (ADR 0028) do not follow roads. Their behaviour is
    unchanged.
- **`planPath(…, { followRoads: true })` (`planRoadPath`):**
  1. **Is the destination on a road?** It is if it lies within half a road's width plus 2 m
     (`ROAD_REACH_M`) of that road's centreline (the nearest such edge, ties to the lowest). If it
     is not, the path is planned off road exactly as before.
  2. **Where to join.** If the soldier stands on a road in the same connected part, the route
     joins there. Otherwise it is the nearest point of that part's roads the soldier can walk to:
     of the 3 nearest edges, the one with the shortest off-road walk, then the shorter road route.
     The walk there is an ordinary off-road path, and may cross a bridge.
  3. **Along the roads.** Dijkstra from the destination's point gives the shortest distance along
     the roads, with ties going to the lower node. The route follows every road vertex, and every
     deck point with its height, to the destination's point. It then walks off road to the
     destination itself.
  4. **No road to join.** If no road reaching the destination can be joined, the path is planned
     off road. If that fails too, the destination is reported unreachable. Nothing crosses water
     that is not bridged.
- **Waypoints.** Each waypoint is planned this way in turn. The generated points are turn points,
  never waypoints: `waypointReached` still reports only the trainee's or scenario's waypoints, in
  order.

### Movement and height

- **Surface height.** A soldier's z is the surface (`surfaceHeightAt`). Between two consecutive
  route points that both carry a deck height, it follows the deck's profile between them. A soldier
  crossing a bridge therefore stays on the deck over its dry approaches too, and rises and falls
  with it.
- **Unchanged rules.** Speed, timing (each tick split at every arrival) and facing are unchanged.
- **Line of sight and viewsheds.**
  - `lineOfSight` stands its observer and its target on the surface.
  - A viewshed stands its observer on the surface.
  - A viewshed's cells stay on the ground.
  - Away from bridges, all of these are exactly as before.
- **3D markers.** Soldiers are drawn at their simulated position, deck included, so ADR 0041's "units
  on bridges are drawn on the ground" no longer holds. Destination markers use `surfaceHeightAt`.

### Determinism, caching, versions

- **Determinism.**
  - Everything is pure and runs in a fixed order: roads by id, bridges by id, ties broken by index.
  - The same orders on the same terrain give the same legs and the same positions on every tick,
    on every run (tested).
  - The AAR records positions, so the replay shows exactly what happened.
- **Caching.**
  - The bridge surfaces, the crossable bridges and their links, and the road network are each built
    once per terrain.
  - Paths are remembered as before (`PATH_CACHE_SIZE`), with road and off-road paths kept apart.
- **Versions.** The terrain and its grading are unchanged, so `GRADING_VERSION` stays as it is.
  The bridges' rules are unchanged (`BRIDGE_VERSION` 1). Scenarios need no migration.
  - Routes on battlefields with roads or bridges change: OPFOR follows roads, and anyone may cross
    a bridge. That is the point of this decision.

## Measurements

Node, the recorded battlefields (importer 1.8, graded). Each structure is built once per terrain.

| Site       | Crossable bridges (rejected) | Bridges and grid | Road network | Nodes / edges (left out) | Road route: avg / max |
| ---------- | ---------------------------- | ---------------- | ------------ | ------------------------ | --------------------- |
| Woolgoolga | 8 (0)                        | 223 ms           | 118 ms       | 4,542 / 4,771 (102)      | 16 / 28 ms            |
| Bled       | 7 (0)                        | 336 ms           | 262 ms       | 15,556 / 15,917 (230)    | 60 / 98 ms            |
| Quantico   | 0 (2: they run off the edge) | 278 ms           | 213 ms       | 6,159 / 6,600 (41)       | 23 / 29 ms            |
| Grafenwöhr | 1 (0)                        | 256 ms           | 73 ms        | 6,377 / 6,886 (52)       | 33 / 58 ms            |

- **"Bridges and grid"** is the first use: planning the bridges, the navigation grid it needs
  anyway, and the links.
- **Road routes.** 30 routes between road nodes of the largest part, all found. On average they
  are 1.4–1.6 times the straight distance.
- **Bridges used.** Off-road paths from 30 m before each crossable bridge to 30 m past it use the
  bridge at Woolgoolga (8 of 8) and Bled (7 of 7). The one at Grafenwöhr is over a pond, and
  walking round it is shorter.

## Limitations

- **A path through the grid crosses a bridge on its centreline.** It does not keep to a lane, and
  soldiers in file share the line.
- **Under a bridge's dry approach.** Over land, a soldier walking past under a bridge's approach
  stays on the ground. Only the route points of a crossing carry the deck's height there.
- **Deck height when re-planned on a bridge.** A soldier given new orders while on a deck over dry
  land (part of a long viaduct) is on the ground's height for the first step, until the next deck
  point.
- **A destination near a road counts as on it.** Within half the road's width plus 2 m, the patrol
  follows the roads to it even when the road route is much longer than walking. There is no
  tactical choice of route.
- **Overlapping ways.** Two ways mapped on top of each other without shared nodes are two roads.
- **Unbridged gaps in the network.** Roads through buildings (covered passages) or across water
  with no crossable bridge break the network there. A patrol then joins the destination's road
  off road, from the nearest point it can reach.
