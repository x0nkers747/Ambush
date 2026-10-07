# ADR 0006: Terrain dataset and georeference

- Status: Accepted
- Date: 2026-10-07

## Context

Scenarios will eventually use real-world terrain of a few square kilometres,
imported from a DEM (elevation) and OpenStreetMap (roads, buildings, vegetation,
land use). Early phases use synthetic terrain.

## Decision

**Coordinate chain.** WGS84 → projected CRS (the UTM zone of the area's centre)
→ subtract a false origin near the map centre → simulation frame (ADR 0002).
Simulation +Y is therefore _grid north_, matching military maps and MGRS. Over a
few kilometres UTM distortion is negligible, and coordinates stay within a few
kilometres of the origin, so neither float64 simulation math nor float32 GPU
rendering needs a floating origin.

**The simulation never handles latitude/longitude.** A `GeoReference` (projected
CRS code, false-origin easting and northing, vertical datum) is metadata, and is
`null` for synthetic terrain. Geographic conversions (grid readouts, true and
magnetic north) belong to import tools and UI display.

**Runtime terrain format** (`TerrainDataset`), independent of its source: format
version, optional georeference, a regular **heightfield** in the local frame
(origin, cell size, columns, rows, elevations) and **features** (polylines and
polygons in local metres with normalized kinds such as track, road, building and
woodland).

- Terrain with tactical meaning is simulation data first; rendering derives from it.
- Simulation height sampling and the 3D terrain mesh use the **same
  triangulation**, so what the trainee sees matches what line of sight computes.
- A future offline import pipeline converts DEM and OSM data into this format.
  The DEM must be **bare-earth (DTM)**, not a surface model, because vegetation
  and buildings come from features. The runtime never parses GeoTIFF or OSM.

## Consequences

- Synthetic and imported terrain are indistinguishable to the simulation.
- A projection library is needed only by import and display code, and is added
  when that work begins.
