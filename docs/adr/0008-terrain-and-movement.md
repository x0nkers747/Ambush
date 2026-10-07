# ADR 0008: Terrain heightfield and waypoint movement

- Status: Accepted
- Date: 2026-10-07 (decisions 1–3 below confirmed at Phase 2 approval)

## Context

Phase 2 makes individual soldiers execute waypoint orders over synthetic terrain,
deterministically and independently of the tick rate (ADR 0003). This ADR makes
the runtime terrain format of ADR 0006 concrete, and defines the movement model.

## Decision

### Approved decisions

1. **Heading does not steer the path.** Soldiers follow deterministic,
   straight segments between waypoints; their facing turns toward the
   direction of travel at the maximum turn rate. After a sharp change of
   direction a soldier may briefly move somewhat sideways. This is accepted.
2. **Movement settings are scenario-wide defaults.** Speed and turn rate are
   fixed scenario data shared by all soldiers. They are the defaults of the
   current simplified movement model, not an architectural commitment: movement
   characteristics may become per-soldier (role, load, posture, …) later if
   needed.
3. **Terrain belongs to the immutable context, not to `SimState`.** Terrain and
   movement settings form the simulation's `SimWorld`. They are never part of
   simulation state and never copied into snapshots.

### Snapshot and world compatibility

A snapshot is only meaningful in the world it was taken in, so it carries the
world's **content fingerprint**: `fingerprintWorld`, the 64-bit FNV-1a hash of
the canonical encoding of `SimWorld` (terrain, including georeference and every
elevation, and movement settings), the same encoding as the state hash
(ADR 0007). It is computed once when the simulation is created. `restore`
throws a `RangeError` if the snapshot's fingerprint (or tick rate) differs from
the simulation's.

The fingerprint covers exactly the immutable inputs that affect results after
a restore. The scenario id, seed and initial soldiers and units are not
included: the restored state replaces them. Anything later added to `SimWorld`
is covered automatically. This is a guard against mistakes, not an asset
versioning scheme.

### Terrain

`TerrainDataset` is immutable reference data. It is held in the simulation's
`SimWorld` (deep-frozen) and is never part of `SimState` or snapshots. A
scenario supplies it.

- `formatVersion: 1`, `georef: GeoReference | null` (`null` for synthetic
  terrain), and a `heightfield`. Features (roads, buildings, vegetation) from
  ADR 0006 are added when something uses them.
- **Heightfield layout.** `columns × rows` elevation samples (each ≥ 2), spaced
  `cellSize` metres apart, starting at `(originX, originY)`. Sample
  `(col, row)` is at `(originX + col·cellSize, originY + row·cellSize)` and its
  elevation is `elevations[row·columns + col]`. Rows run south to north and
  columns west to east.
- **Triangulation.** Each cell is split along its **south-west to north-east
  diagonal** into triangles `(SW, SE, NE)` and `(SW, NE, NW)`, counter-clockwise
  seen from above. `heightAt(x, y)` interpolates linearly on these triangles.
  `terrainTriangleIndices` emits the same triangles as sample indices; a
  rendered terrain mesh must use it, so that what is drawn matches what is
  simulated. A test checks that the two agree.
- **Boundaries.** The terrain covers its sample rectangle, edges included.
  `heightAt` throws a `RangeError` outside it and never extrapolates;
  `isOnTerrain` tests a point. Scenarios with soldiers off the terrain are
  rejected. Orders with a waypoint off the terrain are rejected when applied
  (`commandRejected`, reason `waypointOffTerrain`). The terrain is a rectangle
  and legs are straight, so a soldier can never leave it.
- **Synthetic terrain.** `createSyntheticTerrain(grid, elevationFunction)` samples
  a function, with `flatElevation`, `slopeElevation` and `ridgeElevation`
  helpers. It is meant for tests and the first vertical slice; it is not a
  procedural terrain generator.

### Orders

`Orders` are the trainee's intent and are never modified by the simulation:
`waypoints` (zero or more, each `{ id, x, y }` with a stable, unique id; no Z)
and `finalFacing` (an azimuth). The simulation tracks execution separately in
`ActiveOrders`: the given `orders`, `nextWaypointIndex` and `behavior`.

Final posture is deliberately not part of orders yet; its interaction model is
undecided.

### Behavior state machine

```
idle (orders = null) ──setOrders──▶ moving ──last waypoint──▶ facing ──aligned──▶ inPosition
                                   (no waypoints: start in facing)
any state ──setOrders──▶ moving / facing      any state ──setOrders(null)──▶ idle
```

New orders start from the soldier's current position and facing. Clearing
orders stops the soldier where it is.

### Movement algorithm

Each tick, `moveSoldiers` gives every soldier `dt` seconds of simulation time:

1. **Moving.** Travel in a straight line toward the next waypoint at
   `movement.speed`, a horizontal ground speed in m/s. If the waypoint is
   reachable with the time left in the tick, the soldier is placed exactly on
   it, only the time the leg needed is consumed, a `waypointReached` event is
   emitted with the exact arrival time `atSeconds`, and the rest of the tick
   continues with the next waypoint. Any number of waypoints can be reached in
   one tick, and none is overshot. A waypoint at the soldier's position is
   reached immediately.
2. **Heading** turns toward the current leg's direction at up to
   `movement.maxTurnRate` rad/s, using the shorter way (an exact reversal turns
   clockwise). Heading follows the path but does not steer it: positions depend
   only on waypoints and time, so a sharp corner does not make a soldier orbit
   a waypoint, and the path cannot vary with the tick length.
3. **Facing.** After the last waypoint, the rest of the time turns the soldier
   toward `finalFacing`. When it is reached (exactly, by clamping), the soldier is
   `inPosition` and a `soldierInPosition` event records the exact time.
4. **Z** is always `heightAt(x, y)`.

A completion tolerance of 1e-9 s absorbs rounding so that an arrival falling on
a tick boundary is not left a few ulps short at some tick rates.

Within a tick, soldiers move one after another in scenario order. Movement
does not interact between soldiers, so the order does not affect the result.

**Tick-rate independence.** In exact arithmetic the result does not depend on
the tick rate, because the leg is constant and every arrival splits the tick.
In practice, runs at 10, 20, 30, 60 and 120 Hz agree to within 5e-11 m,
5e-11 rad and 3e-11 s over a 240 s test script. The test tolerances are 1e-6 m,
1e-6 rad and 1e-6 s.

**Parameters.** `MovementParams { speed, maxTurnRate }` in SI units, given by the
scenario and shared by all soldiers (decision 2).

### Deferred

- **Slope-dependent speed.** Any slope model (Tobler's hiking function,
  Naismith's rule, a speed table) is a calibration choice, not a fact. Speed
  that varies continuously along a leg would also replace the exact
  piecewise-linear timing with a numerical integration that depends on the
  step size. A slope model needs agreed parameters and a per-triangle analytic
  solution, and is deferred until it is wanted.
- **Separation and collision avoidance.** Soldiers may overlap. Nothing
  requires avoidance yet.
- **Pathfinding.** There are no obstacles; legs are straight. The seam: `Orders`
  (intent) are separate from `ActiveOrders` (execution). A navigator would add
  a computed route per leg to `ActiveOrders` and replace only how a leg is
  travelled, without changing the waypoint format.

## Consequences

- The 3D view must build its terrain mesh from `terrainTriangleIndices`.
- `atSeconds` on movement events gives the AAR exact, tick-rate-independent
  times.
- Any future system that changes speed continuously must keep tick-rate
  independence; the tick-rate test will fail if it does not.
