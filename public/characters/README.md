# Soldier models and clips

Shipped with the game and loaded by the 3D view (`src/view3d/characters/load.ts`). Every file here
is openly licensed for redistribution.

| File                                                    | What                                                   | Source                                                                                                                       | Licence                                   |
| ------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `rocketbox/Military_Male_01.fbx`, `rocketbox/*.jpg`     | The soldier (model, colour and normal maps)            | [Microsoft Rocketbox](https://github.com/microsoft/Microsoft-Rocketbox) `Professions/Military_Male_01` (textures 2048² TGA → 1024² JPEG) | MIT (`rocketbox/LICENSE.md`)              |
| `rocketbox/clips.json`                                  | The soldier's animation clips, baked                   | Retargeted from [Mesh2Motion](https://github.com/Mesh2Motion/mesh2motion-app) animation libraries; prone and low crawl procedural | CC0 (Mesh2Motion); procedural: this project |
| `weapons/rifle-west.glb`                                | M16A2 stand-in ("Assault Rifle West", AR-15 pattern)    | Pichuliru, via [Poly Pizza](https://poly.pizza)                                                                              | CC0                                       |
| `weapons/ak.glb`                                        | OPFOR AK-pattern rifle                                  | Quaternius, via Mesh2Motion `static/props/AK.glb`                                                                            | CC0                                       |

The M249 SAW has no openly licensed model: it is a placeholder built from boxes in code
(`weapons.ts`).

`clips.json` is written by the comparison prototype's bake tool from the approved prototype's
clips (`prototypes/character-animation`, `npm run assets`, `npm run dev`, then `npm run bake`),
which also copies the other files here. See `docs/character-animation.md`.
