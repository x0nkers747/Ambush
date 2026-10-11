# Building textures: sources and licences

Every texture here is CC0 1.0 (public domain dedication) or original to this project.
None needs attribution, and all may be redistributed and modified. They were downloaded
at 1K, then resized to 512 × 512 px and saved as JPEG. Some were also desaturated or
brightened so a vertex tint can colour them without making them too dark (docs/adr/0035).

| File                | Source                                    | Licence | Changes                       |
| ------------------- | ----------------------------------------- | ------- | ----------------------------- |
| `wall-plaster.jpg`  | ambientCG, Plaster002                     | CC0 1.0 | desaturated                   |
| `wall-brick.jpg`    | ambientCG, Bricks059                      | CC0 1.0 | none                          |
| `wall-siding.jpg`   | ambientCG, WoodSiding009                  | CC0 1.0 | desaturated                   |
| `wall-concrete.jpg` | ambientCG, Concrete034                    | CC0 1.0 | none                          |
| `wall-block.jpg`    | ambientCG, Bricks066                      | CC0 1.0 | desaturated                   |
| `wall-metal.jpg`    | Poly Haven, box_profile_metal_sheet       | CC0 1.0 | desaturated                   |
| `roof-clay.jpg`     | Poly Haven, roof_tiles                    | CC0 1.0 | none                          |
| `roof-tiles.jpg`    | Poly Haven, roof_tiles                    | CC0 1.0 | desaturated (concrete tiles)  |
| `roof-slate.jpg`    | ambientCG, RoofingTiles003                | CC0 1.0 | brightened (mean 0.33 → 0.50) |
| `roof-shingles.jpg` | Poly Haven, grey_roof_01                  | CC0 1.0 | desaturated                   |
| `roof-metal.jpg`    | Poly Haven, box_profile_metal_sheet       | CC0 1.0 | desaturated                   |
| `roof-gravel.jpg`   | ambientCG, Gravel023                      | CC0 1.0 | none                          |
| `openings.png`      | Original, drawn for Ambush! with a script | —       | —                             |

- ambientCG: <https://ambientcg.com>. Licence: <https://docs.ambientcg.com/license/>.
- Poly Haven: <https://polyhaven.com>. Licence: <https://polyhaven.com/license>.

`openings.png` is a 4 × 4 atlas of 256 px cells:

| Row | Cells                                                                                    |
| --- | ---------------------------------------------------------------------------------------- |
| 1   | casement window; casement with green shutters; casement with brown shutters; double-hung |
| 2   | double-hung with shutters; modern; strip glazing; attic                                  |
| 3   | wooden door; painted door; glazed door; shopfront                                        |
| 4   | garage door; roller door; barn door; plain window                                        |

The cell layout is in `building-style.ts` (`OPENING_CELLS`) and `facade.ts` (`CELL_BOX`).

No texture here comes from a project without a clear redistribution licence. Streets GL's
textures have none stated, so none were used. No GPL asset is included.
