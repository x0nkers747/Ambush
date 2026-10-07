# ADR 0002: Coordinates, units and azimuth

- Status: Accepted
- Date: 2026-10-07

## Decision

**Simulation frame.** Right-handed, metres: **X = East, Y = North (grid north),
Z = Up** (elevation in metres above the terrain dataset's vertical datum). The
2D tactical map is the XY plane. ADR 0006 describes how this frame relates to
geographic coordinates.

**Units.** SI inside the simulation: metres, seconds, radians, metres per second.
Where human-authored data uses other units, the unit is part of the field name
(for example `facingDeg`) and is converted once at load.

**Azimuth.** All headings and facings are an `Azimuth`: radians measured
**clockwise from grid north (+Y)**, normalized to `[0, 2π)`.

- Direction vector of azimuth `a`: `(sin a, cos a)`.
- Azimuth of vector `(dx, dy)`: `atan2(dx, dy)`, normalized.
- 90° is East, matching military bearings.

Display units (degrees, mils) and north references (grid, true, magnetic) are
presentation concerns.

**Rendering boundary.** Only `view3d` knows Three.js's Y-up frame. Position
`(x, y, z)` maps to Three.js `(x, z, -y)`, and azimuth maps to a Three.js yaw.
Both conversions live in a single `view3d` module and are unit-tested.

## Consequences

- Simulation code never contains Three.js axis conventions.
- Scenario data and debug output read naturally to military users.
