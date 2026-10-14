# Soldier models and clips

Shipped with the game and loaded by the 3D view (`src/view3d/characters/load.ts`). Every file here
is openly licensed for redistribution.

| File                                                    | What                                                   | Source                                                                                                                       | Licence                                   |
| ------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `rocketbox/Military_Male_01.fbx`, `rocketbox/*.jpg`     | The soldier (model, colour and normal maps)            | [Microsoft Rocketbox](https://github.com/microsoft/Microsoft-Rocketbox) `Professions/Military_Male_01` (textures 2048² TGA → 1024² JPEG) | MIT (`rocketbox/LICENSE.md`)              |
| `rocketbox/clips.json`                                  | The soldier's animation clips, baked                   | Retargeted from [Mesh2Motion](https://github.com/Mesh2Motion/mesh2motion-app) animation libraries; prone and low crawl procedural | CC0 (Mesh2Motion); procedural: this project |
| `weapons/rifle-west.glb`                                | M16A2 stand-in ("Assault Rifle West", AR-15 pattern)    | Pichuliru, via [Poly Pizza](https://poly.pizza)                                                                              | CC0                                       |
| `weapons/ak47.glb` | OPFOR AK-47 ("Assault Rifle") | Zsky, via [Poly Pizza](https://poly.pizza/m/XGeBGFQxYg) | CC BY 3.0: credit "Assault Rifle" by Zsky, shown in the game's 3D view |

The M249 SAW has no openly licensed model: it is a placeholder built from boxes in code
(`weapons.ts`).

`clips.json` is written by the comparison prototype's bake tool from the approved prototype's
clips (`prototypes/character-animation`, `npm run assets`, `npm run dev`, then `npm run bake`),
which also copies the Rocketbox files and the M16 stand-in here (the AK-47 is kept here directly). See `docs/character-animation.md`.
