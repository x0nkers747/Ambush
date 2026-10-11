# Geographic test fixtures

Recorded Overpass API responses (`[out:json]`, `out geom`) for two 1 km battlefields, used by the
OSM importer tests (docs/adr/0014):

| File                           | Centre                                  | Recorded                    |
| ------------------------------ | --------------------------------------- | --------------------------- |
| `quantico-va.overpass.json`    | 38.5223° N, 77.2934° W (Quantico, VA)   | 2026-10-08, overpass-api.de |
| `grafenwoehr-de.overpass.json` | 49.7170° N, 11.9060° E (Grafenwöhr, DE) | 2026-10-08, overpass-api.de |

The query covered the battlefield plus a 100 m margin. To keep the files small, geometry more than
2 km from the centre was simplified (Douglas–Peucker, 20 m tolerance; first and last points kept so
rings still close). Geometry within 2 km, and so everything that reaches the battlefield, is
unchanged.

Map data © OpenStreetMap contributors, available under the Open Database License (ODbL):
https://www.openstreetmap.org/copyright

## Overture Maps building tiles

`quantico-va.overture-buildings.json` holds two neighbouring tiles of Overture Maps' `buildings`
vector tiles (release 2026-09-23.1, zoom 14, columns 4674 and 4675, row 6288, near Quantico, VA), as
read from the PMTiles archive and decompressed, base64-encoded. Six buildings cross the seam between
them. Used by the Overture importer tests (docs/adr/0023).

Building data from Overture Maps Foundation (overturemaps.org), available under the Open Database
License (ODbL); it includes data © OpenStreetMap contributors (ODbL) and Global ML Building
Footprints, licensed by Microsoft under the ODbL.

## Quantico DEM excerpt

`quantico-va.dem-excerpt.json` holds raw elevations round a known fault in the source data, for the
DEM quality tests (docs/adr/0033):

- `grid`: 61 × 81 samples (columns 243–303, rows 344–424; x −70 to 530 m, y 940 to 1740 m) of the
  10 m grid of the recorded 5 km Quantico battlefield (centre 38.5223° N, 77.2934° W), in
  centimetres, as resampled by importer 1.1 from AWS Terrain Tiles at zoom 15. It includes the
  sample at (230, 1240) recorded as −782.48 m and the one at (80, 1630) recorded as −148.95 m.
- `tile`: 24 × 24 pixels (from pixel 190, 170) of Terrarium tile 15/9348/12577, decoded, in metres.
  The tile was last modified on 2017-11-12 and lists NED 1/9 arc-second (Virginia 2011, Washington
  DC 2008), NED 1/3 arc-second, SRTM and GMTED as its sources. Pixel (202, 180) decodes to −1061.59
  m and the one below it to −397.7 m, among pixels of 13–23 m.

Elevation data courtesy of the U.S. Geological Survey; Terrain Tiles (Mapzen / Linux Foundation),
AWS Open Data.
