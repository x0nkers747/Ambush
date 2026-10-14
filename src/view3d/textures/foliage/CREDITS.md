# Foliage textures: sources and licences

Every photograph here is CC0 1.0 (public domain dedication) from ambientCG. None needs
attribution, and all may be redistributed and modified. Each source was downloaded at 2K (JPG)
and prepared by `tools/foliage-textures.mjs` (docs/adr/0051).

## Leaves: `leaves.png`, `leaves.json`

One sprite sheet of single leaves (RGBA PNG; `leaves.json` gives each atlas cell's sprites as
`[x, y, width, height]`). Each leaf was cut out of its set by the set's `Opacity` map,
turned so that its stalk is at the left and its axis runs to the right, scaled to 160 px long,
and colour-matched (per leaf, a gain per channel) to the species' colour in
`foliage-atlas.ts` (`LOOKS`). Leaves whose colour was far from their set's typical colour
(blemished, autumn-coloured, stained) were left out.

| Atlas cell | Species (Quantico) | Source                | Leaves | Note                                  |
| ---------- | ------------------ | --------------------- | ------ | ------------------------------------- |
| `oakWhite` | white oak          | ambientCG, LeafSet016 | 6      | round-lobed oak                       |
| `oakRed`   | red oak            | ambientCG, LeafSet030 | 8      | pointed-lobed oak, autumn, recoloured |
| `maple`    | red maple          | ambientCG, LeafSet010 | 4      | maple                                 |
| `poplar`   | tulip poplar       | ambientCG, LeafSet029 | 7      | nearest lobed shape                   |
| `sweetgum` | sweetgum           | ambientCG, LeafSet021 | 8      | small maple-like; nearest star        |
| `beech`    | American beech     | ambientCG, LeafSet014 | 6      | serrate, beech-like                   |
| `hickory`  | hickory (leaflets) | ambientCG, LeafSet020 | 5      | narrow leaflets                       |
| `laurel`   | mountain laurel    | ambientCG, LeafSet022 | 4      | elliptic                              |
| `cedar`    | eastern red cedar  | ambientCG, LeafSet019 | 3      | conifer sprays                        |

Still drawn in the browser: pine needles, holly, ferns and dead twigs (no suitable CC0
photographs found).

## Barks: `bark-<kind>-albedo.jpg`, `bark-<kind>-normal.jpg`

The source's `Color` (sRGB, JPEG quality 88) and `NormalGL` (OpenGL convention, JPEG quality 92) maps, resized to 512 × 512 px. They tile.

| Files           | Atlas cell   | Source             | Note                      |
| --------------- | ------------ | ------------------ | ------------------------- |
| `bark-rough-*`  | `barkRough`  | ambientCG, Bark001 | grey, deeply furrowed     |
| `bark-smooth-*` | `barkSmooth` | ambientCG, Bark004 | light grey, smoother      |
| `bark-pine-*`   | `barkPine`   | ambientCG, Bark014 | reddish plates (fir/pine) |
