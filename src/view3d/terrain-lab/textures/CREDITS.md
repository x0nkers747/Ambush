# Terrain-lab textures: sources and licences

Every texture here is CC0 1.0 (public domain dedication) from ambientCG. None needs
attribution, and all may be redistributed and modified. Each was downloaded at 2K (JPG) and
resized to 1024 × 1024 px with a Lanczos filter. No colour or brightness edits were made.

Each material has three files:

- `<name>-albedo.jpg`: the source's `Color` map (sRGB), JPEG quality 85.
- `<name>-normal.jpg`: the source's `NormalGL` map (OpenGL convention), JPEG quality 90.
- `<name>-hra.jpg`: linear data packed into channels, JPEG quality 90. R = height
  (`Displacement`, stretched to the full 0–255 range), G = `Roughness`, B = `AmbientOcclusion`.

"Size (m)" is the real-world width of one tile of the texture. Figures come from ambientCG's
asset data where it gives them; "est." marks our estimates.

| Files           | Layer          | Source                        | Size (m) | Licence | Changes                  |
| --------------- | -------------- | ----------------------------- | -------- | ------- | ------------------------ |
| `asphalt-*.jpg` | worn asphalt   | ambientCG, Asphalt031         | 2.0 est. | CC0 1.0 | resized; channels packed |
| `gravel-*.jpg`  | gravel         | ambientCG, Gravel033          | 2.0      | CC0 1.0 | resized; channels packed |
| `soil-*.jpg`    | bare soil      | ambientCG, Ground103          | 2.0 est. | CC0 1.0 | resized; channels packed |
| `grass-*.jpg`   | grass          | ambientCG, Grass004           | 1.4      | CC0 1.0 | resized; channels packed |
| `mud-*.jpg`     | mud            | ambientCG, Ground051          | 2.0      | CC0 1.0 | resized; channels packed |
| `rock-*.jpg`    | rock           | ambientCG, Rock044            | 1.15     | CC0 1.0 | resized; channels packed |
| `sand-*.jpg`    | sand           | ambientCG, Ground054          | 3.5      | CC0 1.0 | resized; channels packed |
| `litter-*.jpg`  | forest litter  | ambientCG, ScatteredLeaves009 | 1.7      | CC0 1.0 | resized; channels packed |
| `paving-*.jpg`  | concrete slabs | ambientCG, PavingStones112    | 2.5 est. | CC0 1.0 | resized; channels packed |

"Channels packed" means the height map was stretched to the full range and the
height, roughness and AO maps were combined into `-hra.jpg`.

- ambientCG: <https://ambientcg.com>. Licence: <https://docs.ambientcg.com/license/>.
