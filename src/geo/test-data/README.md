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
