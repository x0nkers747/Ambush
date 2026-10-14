# Character asset evaluation: soldier models, animations and weapons

- Status: research (no assets added to Ambush!). Companion documents:
  [research](character-animation-research.md),
  [architecture](character-animation-architecture.md),
  [roadmap](character-animation-roadmap.md).
- Date: 2026-10-13.
- Method: web search of the sources the brief lists and others found on the way; licence text read
  at its source; candidates downloaded where possible without a login and inspected
  (`@gltf-transform/cli inspect`, a small glTF parser, FBX2glTF 0.9.7; Blender is not installed on the
  research machine). Sketchfab downloads need a login, so Sketchfab figures are from Sketchfab's own
  model metadata API. Downloads stayed in a temporary research folder and are **not** in the
  repository.
- Labels: **VERIFIED** (file inspected), **STATED** (author, vendor or site metadata), **ESTIMATED**
  (judgement). Licence readings are not legal advice; confirm before shipping.

---

## 1. The licensing situation that decides everything

1. **The Ambush! repository is public** (`github.com/x0nkers747/Ambush`, `private: false`, read from
   the GitHub API) **and the site is deployed to GitHub Pages.** Everything committed is a
   stand-alone public download of the raw files.
2. A web game also sends every model and clip to the browser, where developer tools can extract it.
   Licences that forbid "extraction" or "stand-alone" distribution must be read with both facts in
   mind.
3. Consequences:
   - **CC0, MIT, CC BY** assets are safe both in the repository and in the shipped site (CC BY and
     MIT need attribution or a notice, which the repository already does for textures in
     `CREDITS.md` files).
   - **Mixamo** (Adobe): embedding in a game is allowed; distributing the raw files "on a stand-alone
     basis" is not (Adobe General Terms §3.6); any AI/ML use is forbidden (Mixamo Additional Terms
     §1). **Mixamo-derived files must not be committed to the public repository.** They could be
     shipped only from a private asset store merged into the build, and that reading of "in connection
     with your End Use" for a browser app should be confirmed.
   - **Store EULAs**: Unity Asset Store (§2.2.1(b), "as incorporated and embedded") is the most
     web-friendly commercial licence found; MoCap Online's "binary-only", "cannot be extracted",
     "single computer" wording, and Reallusion's "must not be available for public download", conflict
     with browser delivery without written clarification. Epic's samples (GASP, Lyra) are licensed for
     Unreal Engine products only.
4. **Excluded outright:** non-commercial datasets (Ubisoft LaFAN1 CC BY-NC-ND, Bandai Namco CC BY-NC,
   AMASS, Human3.6M, SFU); Adobe Fuse characters relabelled as CC BY on Sketchfab; models ripped from
   commercial games.

---

## 2. Soldier models

### 2.1 Ranked shortlist

| Rank | Asset                                                                    | Licence                                                  | Triangles                                               | Rig                                                            | Animations                                      | Verdict                                                                                       |
| ---- | ------------------------------------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1    | **Microsoft Rocketbox `Military_Male_01..06`, `Military_Female_01..02`** | **MIT** (VERIFIED)                                       | ~15k (Male_01/03/04), ~7.4k (cap-only 05/06) (VERIFIED) | 80-joint 3ds Max Biped, full fingers, 28 face bones (VERIFIED) | none for locomotion or combat (VERIFIED)        | **Start here.** The only realistic, rigged soldier with a clean permissive licence.           |
| 2a   | jeandiz, _S.W.A.T. Operator – 4k Followers Special Remaster_             | CC BY 4.0 (STATED) + credit each part author             | 71,818 (STATED)                                         | rigged, probably Mixamo-style (ESTIMATED)                      | 1                                               | Best-looking; heavy; police/SOF look, KRISS SMG.                                              |
| 2b   | buh-late, _City Soldier_ / _Polish soldier_                              | CC BY (STATED)                                           | 44k / 123k (STATED)                                     | rigged (STATED)                                                | 1                                               | Modular gear (backpack, knee pads) in _City Soldier_; Eastern European kit.                   |
| 3    | Quaternius _SWAT_ / _Soldier_                                            | CC0 (pack page; Poly Pizza lists _Soldier_ as CC BY 3.0) | 7,752 / 7,900 (VERIFIED)                                | 62 joints with fingers (VERIFIED)                              | 24 incl. Gun_Shoot, Run_Shoot, Death (VERIFIED) | Stylised low-poly. Fallback, or far level of detail.                                          |
| —    | britdawgmasterfunk _Military Character Kit 1.1_ (gear)                   | CC0 (author; Sketchfab field shows CC BY)                | 1.43M faces (kitbash parts)                             | not rigged                                                     | —                                               | The free source of modern kit (helmets, plate carriers, pouches, packs) to upgrade Rocketbox. |

### 2.2 Microsoft Rocketbox military avatars (recommended start)

| Field                         | Finding                                                                                                                                                                                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Creator / source              | Microsoft (Rocketbox Studios library). https://github.com/microsoft/Microsoft-Rocketbox, `Assets/Avatars/Professions/Military_*`                                                                                                                                        |
| Download                      | e.g. `https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/master/Assets/Avatars/Professions/Military_Male_01/Export/Military_Male_01.fbx`; textures in `.../Textures/*.tga`. No login.                                                                      |
| Licence                       | MIT (repository `LICENSE.md`, GitHub SPDX MIT; README "12/2020: Updated license to MIT"). Commercial use, modification and redistribution allowed; keep the copyright notice. VERIFIED.                                                                                 |
| Redistribution / modification | Allowed. The textures carry a US flag and US Army unit and rank patches (trademark/insignia rather than copyright; repaint if wanted).                                                                                                                                  |
| Triangles                     | Male_01 15,387; Male_03 15,517; Male_04 14,907; Male_05 7,510; Male_06 7,386 (VERIFIED).                                                                                                                                                                                |
| Textures, materials           | 2048² body, head, helmet; 2048×1024 equipment; colour + normal + specular (specular/gloss workflow), TGA; 4–5 materials (VERIFIED).                                                                                                                                     |
| Skeleton                      | One skin, 80 joints, `Bip01 …` names: pelvis, 3 spine, neck, head, clavicles, arms, 15 finger bones per hand, legs, toes, 28 face bones (VERIFIED). The FBX references mid/low/ultra-low LOD meshes (49/42, 33, 23 bones) that are only in the `.max` sources (STATED). |
| Animations                    | None in the avatar files (VERIFIED). The repository's ~417 animations are civilian (idles, gestures, sitting, crouch, doors) — no walk, run, aim, fire, prone or death (VERIFIED file list).                                                                            |
| Retargeting                   | Standard Biped naming maps one-to-one to Mixamo/VRM/UE names.                                                                                                                                                                                                           |
| Formats                       | FBX (export), MAX (source), TGA.                                                                                                                                                                                                                                        |
| Three.js                      | Good after conversion: FBX → glTF in Blender, specular → metallic/roughness, TGA → KTX2/WebP at 1K, optionally merge materials (1 draw call), add a weapon socket on `Bip01 R Hand`.                                                                                    |
| Visual quality                | Late-2000s/2010s game art: convincing silhouette and kit (helmet, IOTV-style vest with pouches, gloves, knee pads, NVG mount on Male_04), softer than modern 4K PBR. ACU (UCP) camouflage is dated for a modern force.                                                  |
| Performance                   | ~15k triangles is fine for a squad; generate ~5k and ~1.5k levels of detail (meshoptimizer `simplify`) for distance (ESTIMATED). 2K textures ~10–15 MB per variant with KTX2 at 1K (ESTIMATED).                                                                         |
| Cleanup                       | Material conversion, texture compression, drop face bones for the game skeleton, build LODs, add a backpack (missing), optional repaint to OCP/MultiCam (or kept as-is for the 1991 MCWP squad era — see below).                                                        |
| Limitations                   | No backpack, no long gun, no combat animation, dated look, LODs locked in 3ds Max sources.                                                                                                                                                                              |

**Note on era.** Ambush!'s organisation template is the 1991 MCWP 3-11.2 rifle squad (M16A2, M249,
M203). Rocketbox's ACU uniform is US Army 2005–2019; neither OCP nor Marine MARPAT/woodland of 1991. Retexturing the uniform (woodland or MARPAT) is a texture-only change and is recommended for a
believable Marine squad.

### 2.3 Rejected or flagged models

| Model                                       | Reason                                                                                                                                                                                                                |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| three.js `examples/models/gltf/Soldier.glb` | VERIFIED Mixamo "Vanguard" (49 `mixamorig:` joints; Idle, Run, Walk, TPose; 11,376 triangles); the example credits mixamo.com. **Adobe terms, not MIT.** Sci-fi visor trooper. Reference and benchmark stand-in only. |
| doctortex soldiers (CC BY label)            | Texture names `*_Packed0_*` and look match Adobe Fuse/Mixamo exports (ESTIMATED, high confidence): not the uploader's to relicense. Avoid.                                                                            |
| DenisAlbu mid-poly soldier (CC BY-SA)       | Author states "made with Fuse"; ShareAlike. Avoid.                                                                                                                                                                    |
| 42manako KSK / Azov soldiers                | Descriptions admit rips from commercial games. Avoid.                                                                                                                                                                 |
| CoD, Halo, Black Mesa, CS2 uploads          | Game rips / derivative IP. Avoid.                                                                                                                                                                                     |
| Andywoodhead infantry                       | Napoleonic era.                                                                                                                                                                                                       |
| MakeHuman                                   | Base body only (CC0 export); community clothing mostly CC BY; no uniform.                                                                                                                                             |
| BlenderKit "Royalty Free"                   | FAQ: assets "shouldn't be directly extractable" from distributed games. Only its CC0 items are usable.                                                                                                                |
| Unreal/Epic samples (Paragon, Lyra)         | Unreal-only licences.                                                                                                                                                                                                 |
| Kenney, OpenGameArt                         | No realistic modern infantry.                                                                                                                                                                                         |

### 2.4 Commercial options (indicative, STATED)

| Option                                           | Price                                                                               | Licence notes                                                            | Fit                                                                                                |
| ------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Synty POLYGON Military                           | $299.99 list ($149.99 on sale)                                                      | "not limited by game engine"; no anti-extraction clause found            | Stylised low-poly; 23 characters; no animations.                                                   |
| CGTrader rigged modern infantry / special forces | $10–39                                                                              | CGTrader Royalty-Free; check "not extractable" wording and AI-generation | 10–20k polygons, PBR; quality unverified.                                                          |
| 3DMilitaryAssets _Western Special Operations V3_ | $159.95 commercial                                                                  | own EULA                                                                 | 180k triangles, Mixamo-rigged, MultiCam, role variants incl. SAW gunner; needs heavy optimisation. |
| Fab marketplace (Standard licence)               | varies                                                                              | "any game engine" (Epic-owned content may still be UE-only)              | Many UE-skeleton soldier packs.                                                                    |
| Commissioned soldier                             | ESTIMATED $1,500–5,000 per realistic game-ready soldier with LODs and gear variants | work for hire                                                            | Best control; 3–6 weeks.                                                                           |

---

## 3. Animation libraries

### 3.1 Summary

| Source                                               | Licence                                                                                                              | Rifle handling                                                             | Prone / crawl                                   | Quality                         | Verdict                                                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Mixamo** (Adobe)                                   | Embed in games OK; no stand-alone redistribution of raw files; no AI/ML use; free with Adobe ID                      | ~230 rifle clips (catalogue, names only; VERIFIED list in research folder) | Full prone set incl. crawl, turns, fire, reload | B (cleaned 2010s optical mocap) | **Best coverage, but cannot live in the public repository.**                                        |
| Quaternius Universal Animation Library / Mesh2Motion | **CC0** (art), MIT (Mesh2Motion code) (VERIFIED)                                                                     | none (pistol only)                                                         | Crouch idle/walk, crawl; no prone               | C (stylised hand-keyed)         | Free filler: locomotion, crouch, crawl, hits, deaths, turns.                                        |
| CMU Graphics Lab mocap                               | "free for all uses… may include in commercially-sold products, but you may not resell this data directly" (VERIFIED) | none useful                                                                | crawl, sneak, crouch walk                       | C (raw 120 Hz, heavy cleanup)   | Reference and base layers only.                                                                     |
| 100STYLE                                             | CC BY 4.0 (VERIFIED)                                                                                                 | none                                                                       | crouched/"Swat" styles                          | C (raw)                         | Locomotion styles with attribution.                                                                 |
| LaFAN1, Bandai Namco, AMASS, SFU, Human3.6M          | non-commercial                                                                                                       | (LaFAN1 has aiming and ground work)                                        | —                                               | A–B                             | **Excluded.**                                                                                       |
| Epic GASP / Lyra                                     | Unreal-only                                                                                                          | yes                                                                        | —                                               | A                               | **Excluded.**                                                                                       |
| Kubold _Rifle Animset Pro_ + _Crouch & Prone_        | Unity Asset Store EULA; ~$15–25                                                                                      | yes                                                                        | yes                                             | B (mocap, STATED)               | Best web-friendly paid supplement.                                                                  |
| Kevin Iglesias _Human Soldier Animations_            | itch "Single Entity" (text not obtained); $30                                                                        | assault rifle, handgun, rifle, bazooka                                     | prone crawl fwd/back                            | likely keyframed                | Read its licence before buying.                                                                     |
| MoCap Online _Rifle Pro_                             | $149.99; "binary-only", "cannot be extracted", "single computer"                                                     | 390 clips incl. 48 aim offsets                                             | prone transitions                               | B+ (STATED)                     | Best-sounding firearm mocap; licence conflicts with browser delivery without written clarification. |
| Reallusion / ActorCore rifle packs                   | content "must not be available for public download"; mass-distribution registration                                  | yes                                                                        | yes                                             | B                               | Risky for a web app.                                                                                |

### 3.2 Mixamo clip coverage (from the public catalogue; names only)

Present: rifle idles (relaxed, lowered, aiming); cautious walk, cover sneak; 8-direction walk, run
and sprint with rifle; crouch idle (and aiming), 8-direction crouch walk, crouch run; turns
45/90/135/180 standing and crouched; stand↔crouch, stand↔kneel, kneel idle, kneel↔aim; kneel↔prone,
crouch↔prone, prone↔stand; prone idle, prone fire, prone reload, prone forward and backward crawl
(with stops), prone turns, prone roll; rifle down↔aim, equip and put away (from back, side,
shoulder); fire standing, walking, running, crouched, prone, rapid fire; reloads standing, crouched,
walking, running, prone; hit reactions (several poses incl. prone and kneeling); injured pack (20);
15+ deaths; get-ups from back, stomach, knocked down, prone; grenade throws.

Absent: **any machine-gun or LMG clip** (query "machine gun": 0 results), belt or box reloads, bipod
work; **aim offsets** (up/down/left/right pose grid); first-person arms; a direct stand-to-prone drop.

### 3.3 Gap analysis against the required list

| Required                               | Best source                       | Gap                                                    |
| -------------------------------------- | --------------------------------- | ------------------------------------------------------ |
| Idle relaxed / alert / weapon ready    | Mixamo rifle idles                | No                                                     |
| Slow / cautious walk                   | Mixamo cautious walk, cover sneak | Partial (no 8-direction cautious set)                  |
| Walk fwd/back/lateral                  | Mixamo rifle 8-way                | No                                                     |
| Run, turning run                       | Mixamo rifle 8-way                | No                                                     |
| Sprint                                 | Mixamo sprint (8 dirs)            | No                                                     |
| Kneel / crouch enter, idle, exit, move | Mixamo                            | No                                                     |
| Prone enter, idle, exit                | Mixamo (via kneel/crouch)         | Partial: no direct drop to prone                       |
| Crawl fwd, back, turn                  | Mixamo prone crawl; CC0 UAL crawl | Partial: one speed, no roll left (mirror)              |
| Aim standing / crouched / prone        | Mixamo aiming idles               | **Partial: no aim offsets** → procedural spine/arm aim |
| Fire rifle / automatic                 | Mixamo fire clips                 | Partial → procedural recoil layer                      |
| **Fire machine gun (M249)**            | none anywhere                     | **Gap**                                                |
| Reload (weapon-specific)               | Mixamo generic magazine reload    | Partial; **M249 reload is a gap**                      |
| Raise, lower, equip, unequip           | Mixamo                            | No                                                     |
| Turn standing / prone                  | Mixamo                            | No                                                     |
| Hit reactions, incapacitation          | Mixamo, CC0 UAL                   | Partial: no full directional set                       |
| Deaths (several)                       | Mixamo 15+, CC0 UAL 4             | No                                                     |
| Get up                                 | Mixamo, CC0 UAL                   | No (unarmed; weapon pickup by IK)                      |
| First-person arms                      | none                              | **Gap**                                                |
| Strictly open-licensed rifle set       | none                              | **Gap**                                                |

### 3.4 Making our own (for the gaps)

| Option                                      | Cost (STATED unless marked)                                                  | Notes                                                            |
| ------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Procedural (recoil, aim offsets, weapon IK) | engineering time only                                                        | Covers recoil and aim well; not reloads or posture changes.      |
| Rokoko Smartsuit Pro II (inertial)          | $1,995; $3,495 with gloves; Studio Plus ~$240/year                           | Own the captures; prone/crawl data is noisy for inertial suits.  |
| Move.ai (video mocap)                       | Standard $50/month (commercial allowed)                                      | Personal $15/month is non-commercial.                            |
| Cascadeur (keyframing and cleanup)          | Indie $96/year (revenue < $100k)                                             | Free tier is non-commercial.                                     |
| Optical studio day                          | e.g. AUD 3,295/day (WAAPA university lab) + actor, replica weapons, cleanup  | Uniform AAA-feeling set of 50–100 clips including LMG and prone. |
| Commissioned keyframe                       | ESTIMATED $50–300 per clip; first-person set per weapon in the low thousands | Full ownership by contract.                                      |

---

## 4. Weapon models

Built around the actual Ambush! roster (`src/exercise/weapon-display.ts`, `combat-v1.json`): M16A2
rifle, M249 SAW, M203 grenade launcher (under the M16), bayonet and combat knife (stowed gear), and
the OPFOR's AK-pattern rifle.

| Ambush! weapon                      | Best permissive source                                                          | Licence      | Triangles (STATED) | Notes                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------- | ------------ | ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| M16A2 (`m16-rifle`)                 | TastyTony _Low-Poly M16A4_ (closest family; A2 differs in sights and handguard) | CC BY        | 12,030             | 12 flat-colour materials, untextured; merge to one material. A dedicated M16A2 needs a small modelling job (ESTIMATED 1–2 days). |
| M203 (`m203-grenade-launcher`)      | TastyTony _M203 Standalone_                                                     | CC BY        | 4,698              | Mounts under the M16.                                                                                                            |
| M249 SAW (`squad-automatic-weapon`) | TastyTony _Low-Poly M249 SAW_                                                   | CC BY        | 12,281             | 15 materials; the model's bipod and box need separate nodes for animation.                                                       |
| AK-pattern (`ak-assault-rifle`)     | britdawgmasterfunk _Firearms Kit 1.0_ (AK parts)                                | CC0 (stated) | kitbash            | Assemble and decimate; or a CC BY AK on Sketchfab (to be selected).                                                              |
| Bayonet, combat knife               | (stowed; low priority)                                                          | —            | —                  | A sheath on the belt is enough.                                                                                                  |
| Far LOD                             | OpenGameArt _Low-Poly M4A1_                                                     | CC0          | 167                | Distant soldiers.                                                                                                                |

URLs: TastyTony M16A4 https://sketchfab.com/3d-models/low-poly-m16a4-496afafda8cf4db0b7564bc1e4756256,
M249 https://sketchfab.com/3d-models/low-poly-m249-saw-76011c365636451c90a8e3a46c2d8ca5,
M203 https://sketchfab.com/3d-models/m203-standalone-68d2428aca794cac87c969b94d76602e;
britdawgmasterfunk Firearms Kit https://sketchfab.com/3d-models/firearms-kit--10-cc0-386f0582c28d4dff96da967f42ba20f7;
OpenGameArt M4A1 https://opengameart.org/content/low-poly-m4a1.

Every weapon needs authored sockets (grip, support hand, stock/shoulder, sight line, muzzle, ejection,
bipod) — see the architecture's weapon profiles.

---

## 5. Recommended starting set

| Need                              | Prototype (public repository safe)                            | Release candidates (decision needed)                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Soldier body                      | Rocketbox Military_Male_01/03/04 (MIT), retextured            | Rocketbox + CC0 gear kitbash and new uniform texture (about a week of Blender work, ESTIMATED), or a commissioned/purchased model whose licence allows web delivery |
| Locomotion, crouch, crawl, deaths | Quaternius UAL / Mesh2Motion (CC0), retargeted                | Mixamo rifle set (private asset store) or a purchased rifle pack (Kubold)                                                                                           |
| Rifle handling                    | Procedural (aim layer, weapon IK, recoil) over CC0 locomotion | Mixamo or Kubold rifle clips                                                                                                                                        |
| M249 handling, M249 reload        | Rifle clips + per-weapon IK pose and procedural recoil        | Commissioned or captured clips                                                                                                                                      |
| First-person arms                 | Procedural arms posed by IK on the weapon                     | Commissioned first-person arm set                                                                                                                                   |
| Weapons                           | TastyTony M16/M203/M249 (CC BY), CC0 AK kitbash               | Same, or commissioned matching set                                                                                                                                  |

**Attribution** (CC BY, MIT) goes in a `CREDITS.md` beside the assets, as the repository already does
for ground and foliage textures.
