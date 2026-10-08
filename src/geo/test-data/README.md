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
