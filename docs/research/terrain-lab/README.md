# Terrain lab: research output

The evidence for [`docs/terrain-lab-prototype-report.md`](../../terrain-lab-prototype-report.md),
captured on 2026-10-13:

- Chrome 155, AMD Radeon 880M (integrated GPU, Direct3D 11 through ANGLE);
- 1270 × 908 canvas, 60° vertical field of view;
- the same sun, sky and fog in both renderers.

Each pair was taken from one camera (position, heading and pitch), switching only the renderer:

- `lab-*.jpg`: the experimental terrain;
- `current-*.jpg`: the game's current 3D terrain and ground.

The current renderer stands on the game's graded ground, so its eye can differ from the lab's
by a few centimetres.

## Folders

| Folder         | What                                                                                                                                                                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grafenwoehr/` | All 12 views of the brief, both renderers: `road-along`, `road-verge`, `building-beside`, `building-slope`, `stream`, `shoreline`, `bridge-below`, `grassland`, `woods`, `steep-slope`, `tactical` (320 m), `overview` (6 km)                                           |
| `quantico/`    | `road-along`, `shoreline`, `bridge-below`, `stream`, `building-slope`, both renderers                                                                                                                                                                                   |
| `amsterdam/`   | `road-along`, `bridge-below`, `tactical`, both renderers. On dense battlefields the lab builds structures only around the 1 km test area                                                                                                                                |
| `debug/`       | `lod-*`: LOD levels (red = 0.5 m, then orange, yellow, green, blue, violet), lighter while morphing. `tiles-*`: tile boundaries. `wire-*`: wireframe. `relief0-*` / `relief2-*`: relief off and doubled (structures hidden). `spacing1-*`: the 1 m lattice in wireframe |
| `benchmarks/`  | Node benchmarks per battlefield (`grafenwoehr.json`, `quantico.json`, `amsterdam.json`, from `src/view3d/terrain-lab/bench.cli.test.ts`), browser frame times (`frames-grafenwoehr.json`), Node against Chrome tile hashes (`xbrowser-grafenwoehr.json`)                |

## Test areas

The centres of the 1 km test squares are in metres from the battlefield's centre:

- Grafenwöhr: 250, 750;
- Quantico: 0, 500;
- Amsterdam: 250, 1000.

The viewpoints are found from the data by `src/view3d/terrain-lab/presets.ts`. Their positions
are in the lab's viewpoint list (hover a button to see what each found).

## Reproducing

1. Run `npm run dev` and save the battlefield in the browser.
2. Open `#terrain-lab`, pick a viewpoint, and use _Capture pair_.
3. For the Node benchmarks:

   ```sh
   AMBUSH_TERRAIN_LAB=<package.json> AMBUSH_TERRAIN_LAB_AT=250,750 \
     npx vitest run src/view3d/terrain-lab/bench.cli.test.ts
   ```
