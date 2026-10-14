# Character animation research: animated 3D soldiers for Ambush!

- Status: research (no implementation). Companion documents:
  [architecture](character-animation-architecture.md),
  [asset evaluation](character-asset-evaluation.md),
  [roadmap](character-animation-roadmap.md).
- Date: 2026-10-13. Repository state: `main` at `634fa72`.
- Method: repository inspection; web research of current documentation, source code, GitHub
  repositories (stars, licences and last commits read from the GitHub API on 2026-10-13) and asset
  licences; downloads and file inspection of candidate assets (`@gltf-transform/cli`, FBX2glTF); and a
  skinned-character benchmark in Chrome on this machine's GPU (§9). Temporary experiments were run
  outside the repository and are not committed.

Evidence labels used throughout: **[verified]** (read in source, documentation or a downloaded
file), **[measured]** (benchmarked here), **[claim]** (an author's or vendor's statement not
reproduced), **[estimate]** and **[opinion]** (engineering judgement). Licence readings are not legal
advice.

---

## 1. Summary of findings

1. **The simulation can stay authoritative.** Ambush!'s state is plain data advanced at a fixed tick
   (30 Hz), with every random draw from a seeded generator kept in the state, and the after-action
   review records a full state frame per tick (§2). A character system that is a _pure function of
   recorded simulation state and simulation time_ is deterministic and replayable by construction,
   with no animation state of its own to save.
2. **Three.js r186 is a capable sampler, not an animation system.** It has clip sampling, weights,
   additive clips and skeletons, but no blend spaces, no state machine, no bone masks and no
   locomotion tooling (§3). Every serious three.js character project writes that layer itself; no
   maintained library exists to adopt (§4).
3. **Inverse kinematics should be hand-written.** Analytic two-bone IK (feet on terrain, left hand
   on the weapon) and a distributed spine/head aim are about 100–300 lines each, closed-form and
   deterministic. The general three.js IK libraries are abandoned, robotics-oriented or iterative
   (§5).
4. **The biggest visible quality gains are cheap ones** (§7): an aiming upper body over directional,
   speed-matched locomotion; good transitions; weapon-anchored hand IK; procedural recoil. Motion
   matching is not worth it for Ambush! (no JavaScript implementation, large data needs, tactical
   camera distances).
5. **Content is the hard part, not code** (asset evaluation). There is no openly licensed rifle
   animation library. Mixamo covers about 85–90 % of the infantry list for free, under terms that
   allow embedding in a game but forbid redistributing the raw files and any AI/ML use. **The Ambush!
   repository is public** (GitHub `x0nkers747/Ambush`, deployed to GitHub Pages), so Mixamo-derived
   files cannot be committed to it. Machine-gun (M249) handling, aim offsets and first-person arms
   exist in no library, free or paid.
6. **Performance is CPU-bound by skeleton evaluation, not by drawing** (§9, measured): the per-soldier
   cost is the mixer and the bone hierarchy, which animation level of detail and shared poses reduce
   directly.

---

## 2. What Ambush! has today (the integration constraints)

Full map with file references: section 1 of the [architecture](character-animation-architecture.md).
The facts that shape the design:

| Area              | Today                                                                                                                                                                                                                                                                                                                                                                                           | Consequence                                                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Layers (ADR 0001) | `sim` → `exercise` → `session` → `view2d`/`view3d` → `app`, enforced by `tsc -b` and lint. `sim`/`exercise` may not use clocks, `Math.random` or `three`.                                                                                                                                                                                                                                       | Animation lives in `view3d`. Anything that changes outcomes (posture, aim, reload, wounds, player input) lives in `sim` as plain data and commands.         |
| Tick              | 30 Hz fixed step (`src/sim/config.ts`), time = tick / rate, xoshiro128** RNG in `SimState.rng`. Live speeds 1/4/8/16× (`src/session/session.ts:6`); review 0.25–4×.                                                                                                                                                                                                                             | Animation is sampled from simulation time, so every speed and pause works the same way.                                                                     |
| Interpolation     | The runner computes `alpha` (`src/exercise/runner.ts:90`), but nothing reads it; review frames floor to whole ticks (`frameAt`, `src/exercise/replay.ts:42`). Soldiers visibly step at 30 Hz.                                                                                                                                                                                                   | A render-time interpolation input is the first prerequisite; it is view-only.                                                                               |
| Soldiers          | `Soldier { position, azimuth, posture, status, orders }` (`src/sim/state.ts:97`). `Posture` is standing, kneeling or prone; only OPFOR ever goes prone; nothing sets kneeling. `SoldierStatus` is active or incapacitated.                                                                                                                                                                      | Posture exists as data but has no transitions, no command and no effect on movement or line of sight.                                                       |
| Movement          | One speed for all (1.5 m/s, π/2 rad/s turn), OPFOR flee at 4.5 m/s; facing turns toward travel but does not steer. No acceleration.                                                                                                                                                                                                                                                             | Locomotion must follow the simulation's speeds; speed classes and acceleration are new simulation features if they are to matter.                           |
| Weapons           | Combat profiles for exactly three weapons (`src/exercise/combat/combat-v1.json`): `m16-rifle` (M16A2, 1.5 s between shots), `squad-automatic-weapon` (M249 SAW, 0.75 s) and `ak-assault-rifle` (OPFOR, 1.5 s). The M203, bayonet and combat knife are display-only (`src/exercise/weapon-display.ts`). A "shot" is one firing opportunity; there is no ammunition, reload, burst or dispersion. | The character design is built around rifle (M16A2, AK), automatic rifle (M249) and the M203 as an attachment, with knives as stowed gear.                   |
| Combat            | `ShotFiredEvent` with exact sub-tick `atSeconds`, shooter, target, hit, incapacitated (`src/sim/events.ts`). The shooter's azimuth snaps to the target. Line of sight uses fixed 1.7 m eye and 1.5 m target heights (`src/sim/los.ts:18-20`), ignoring posture.                                                                                                                                 | Firing, recoil and casualty animations are driven by events with exact times. Posture-dependent heights are a combat-model change, not an animation detail. |
| Review (AAR)      | A full `SimState` frame per tick from the trigger (ADR 0026), `Exercise.replayAt(frame)` returns a read-only view.                                                                                                                                                                                                                                                                              | Anything added to the simulation state is recorded and replayed automatically.                                                                              |
| 3D soldiers       | Cylinder/sphere/cone markers, about 5 draw calls each, no shadows, scaled to stay about 26 px tall (`src/view3d/markers.ts`).                                                                                                                                                                                                                                                                   | The character layer replaces `markers.ts` and keeps a marker as the far level of detail.                                                                    |
| Budgets           | ≤ 300 draw calls, ≤ 600 MB GPU memory (ADRs 0030/0031); Chrome's 4 GB heap cage shared with workers (ADR 0045).                                                                                                                                                                                                                                                                                 | Characters must share geometry, skeleton data and textures, and use levels of detail.                                                                       |
| Camera            | Orbit camera only; a `CameraMode` interface exists for follow, eye-level and free cameras (`src/view3d/tactical-camera.ts:20-29`).                                                                                                                                                                                                                                                              | First person is a new camera mode plus a player-controlled soldier.                                                                                         |

---

## 3. Three.js r186 animation capabilities

All **[verified]** against the r186 documentation and source (three@0.186.1, released 2026-09-24).

| Feature                    | API                                                                                                                                                                        | Use for Ambush!                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Clip sampling and blending | `AnimationMixer`, `AnimationAction` (`weight`, `setEffectiveWeight`, `timeScale`, `time`, `loop`, `clampWhenFinished`), `PropertyMixer` accumulation with quaternion slerp | The sampler under a custom graph.                                                                                                                                                                                                                                                                                                                                                                            |
| Explicit time              | `mixer.setTime(t)`; `action.time` set directly, then `mixer.update(0)`                                                                                                     | Sampling from simulation time: the property that makes poses reproducible.                                                                                                                                                                                                                                                                                                                                   |
| Crossfades                 | `fadeIn/Out`, `crossFadeTo/From(…, warp)`, `syncWith`                                                                                                                      | **Not for authoritative timing**: they schedule on the mixer's own clock. Compute weights from simulation time instead.                                                                                                                                                                                                                                                                                      |
| Additive                   | `AnimationUtils.makeClipAdditive`, `AdditiveAnimationBlendMode`                                                                                                            | Aim offsets, recoil, breathing, flinches over locomotion.                                                                                                                                                                                                                                                                                                                                                    |
| Sub-clips                  | `AnimationUtils.subclip`                                                                                                                                                   | Splitting mocap takes into start/loop/stop.                                                                                                                                                                                                                                                                                                                                                                  |
| Skeleton clone             | `SkeletonUtils.clone` (shares geometry and material)                                                                                                                       | Spawning soldiers from one loaded model.                                                                                                                                                                                                                                                                                                                                                                     |
| Retargeting                | `SkeletonUtils.retarget/retargetClip`                                                                                                                                      | Prototyping only: forum threads report twisted limbs with Mixamo rigs ([1](https://discourse.threejs.org/t/fixing-skeletonutils-retarget-and-retargetclip-functions/65149), [2](https://discourse.threejs.org/t/retargetclip-twists-character/73410), [3](https://discourse.threejs.org/t/skeletonutils-retarget-doesnt-work-with-mixamorig-skeleton-inverted-feet-backward-hands/54892)). Retarget offline. |
| IK                         | `CCDIKSolver` (addons; target must be a bone)                                                                                                                              | Long chains only; analytic IK is better for limbs.                                                                                                                                                                                                                                                                                                                                                           |
| glTF                       | Skins (4 influences), morph targets, `KHR_animation_pointer`                                                                                                               | glTF/GLB is the delivery format.                                                                                                                                                                                                                                                                                                                                                                             |
| Missing                    | **No bone masks, no blend spaces, no state machine, no root-motion extraction, no foot-contact data, no instanced skinning in core; `BatchedMesh` has no skinning.**       | Written by us (§4) or taken from one library (§9).                                                                                                                                                                                                                                                                                                                                                           |

**Cost model [verified in source].** Per frame and per soldier: one interpolant per track of every
active action (binary search, lerp or slerp), accumulation per bone, `updateMatrixWorld` over the
bone hierarchy, then `Skeleton.update()` once per skeleton (bone world × inverse bind → a bone
texture). Skinning itself is in the vertex shader. A 65-bone rig with 3 channels per bone and 4
active actions is roughly 780 interpolations per soldier per frame.

**Bone masking [verified absent].** The standard workaround is track filtering: copy a clip keeping
only the tracks of a bone set (for example spine and arms for an upper-body aim layer). Graded
masks are approximated with two or three filtered copies at different weights, or by blending two
sampled poses per bone ourselves.

**Relevant r186 examples:** `webgl_animation_skinning_blending`,
`webgl_animation_skinning_additive_blending`, `webgl_animation_skinning_ik`,
`webgl_animation_walk`, `misc_animation_groups`, `webgpu_skinning_instancing_individual` (one mixer,
`setTime` per instance, compute skinning; **WebGPU only**, no WebGL2 fallback).

---

## 4. Animation graphs, blend spaces and runtimes

| Name                                                                                                             | Licence                    | Activity (2026-10-13)                              | Verdict                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| three.js built-ins                                                                                               | MIT                        | r186, Sep 2026                                     | Foundation (sampler).                                                                                                                                                                                      |
| [animouse](https://github.com/jango-git/animouse)                                                                | MIT                        | last commit 2026-01-31, 1 star, ~15 downloads/week | Immature; reference only. Has a state machine, 1D and 2D (polar, Delaunay) blend trees.                                                                                                                    |
| [Animagica](https://discourse.threejs.org/t/animagica-animation-blueprint-editor-and-runtime-for-three-js/69136) | unknown                    | 2024 forum post, "work in progress"                | Not adoptable.                                                                                                                                                                                             |
| pmndrs drei `useAnimations`                                                                                      | MIT                        | active                                             | React-only wrapper; not a blend tree.                                                                                                                                                                      |
| [PlayCanvas anim state graph](https://developer.playcanvas.com/user-manual/animation/)                           | MIT                        | active                                             | Engine-bound; **a good data model to copy** (layers, masks, 1D/2D blend trees, transitions).                                                                                                               |
| Babylon.js animation groups, baked vertex animation                                                              | Apache-2.0                 | active                                             | Engine-bound; comparison only.                                                                                                                                                                             |
| [ozz-animation](https://github.com/guillaumeblanc/ozz-animation) (C++)                                           | MIT                        | v0.17.0, 2026-08                                   | Production-grade sampling, blending, masks, two-bone and aim IK, compression; CI builds WebAssembly but **no JavaScript bindings exist**. A fallback if JavaScript pose evaluation becomes the bottleneck. |
| Unreal Animation Blueprints / Lyra, Unity Mecanim, Godot AnimationTree                                           | engine EULAs / MIT (Godot) | active                                             | Design references for layered graphs (Lyra's linked anim layers per weapon, state aliases, layered blend per bone).                                                                                        |

**Conclusion [opinion].** A custom TypeScript layer of roughly 1,000–2,000 lines (layered state
machine, 1D/2D blend spaces producing weights, track-filtered masks, additive layers, transitions
computed from simulation time) is the practical path, and the only one that guarantees weights are
reproducible from recorded state.

---

## 5. Inverse kinematics and procedural control

| Option                                                                | Licence / status            | Verdict                                                                                                                                                                                                        |
| --------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hand-written analytic two-bone IK (law of cosines with a pole vector) | ours                        | **Recommended** for legs (foot planting) and arms (left hand on the handguard, right hand on the grip). Closed form, deterministic, cheap.                                                                     |
| Hand-written aim / look-at                                            | ours                        | **Recommended**: yaw and pitch distributed over pelvis, spine_01–03, neck and head with per-bone fractions and limits, on top of an additive aim-offset pose where available.                                  |
| three.js `CCDIKSolver`                                                | MIT, ships with r186        | Spines, tails; iterative, worse than analytic for limbs.                                                                                                                                                       |
| [THREE.IK](https://github.com/jsantell/THREE.IK)                      | MIT, last commit 2021-10-28 | Abandoned. Do not use.                                                                                                                                                                                         |
| [fullik](https://github.com/lo-th/fullik)                             | MIT, last commit 2025-05    | FABRIK; slow-moving. Not needed.                                                                                                                                                                               |
| [closed-chain-ik-js](https://github.com/gkjohnson/closed-chain-ik-js) | Apache-2.0, active          | Robotics solver; heavier than humanoid limbs need.                                                                                                                                                             |
| [@pixiv/three-vrm](https://github.com/pixiv/three-vrm)                | MIT, active (2026-09)       | **Use its humanoid bone list and normalised rest pose as our canonical skeleton naming** ([VRM humanoid](https://vrm.dev/en/vrm1/humanoid/)); its spring bones suit straps and slings. Do not ship .vrm files. |

**Techniques, all practical in three.js with custom code:**

- **Foot placement and slope adaptation:** sample the authoritative ground (`surfaceHeightAt`)
  under each planted foot (contact from per-clip foot-contact curves computed at build time), lower
  the pelvis by the larger offset, two-bone IK each ankle to its ground point, tilt the foot to the
  ground normal (finite differences of the height function), fade with speed. No raycasting needed:
  the ground is a height function.
- **Hand placement and weapon grip:** the weapon is parented to a weapon bone driven by the right
  hand; the left hand reaches a socket on the weapon (handguard for the M16 and AK, the M249's
  forward grip or handguard) by two-bone IK. One animation set then serves weapons of different
  length.
- **Spine aim and rifle alignment:** the aim layer rotates the spine chain so the weapon's sight
  line (a socket on the weapon) points along the simulation's aim direction; a final correction
  rotates the right hand so the barrel is exactly on target (muzzle direction is then correct for
  tracers).
- **Procedural lean, recoil and sway:** damped springs on the spine and weapon bone, excited by
  `ShotFiredEvent` times; deterministic because they are evaluated in closed form from the time
  since the event, not integrated per frame.
- **Kneeling and prone:** authored transitions (there is no good procedural substitute for getting
  down); prone aiming uses the prone clip plus a limited yaw (the body rotates on the ground beyond
  about ±30°) and elbow-pivot pitch.
- **Obstacles and cover:** out of scope for a first version; the simulation has no cover concept
  (ADR 0019).

---

## 6. Locomotion, transitions and foot sliding

| Technique                                                                           | Source                                                                                                                                                                                | Verdict for Ambush!                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In-place clips, simulation-driven displacement                                      | [Holden, code vs data-driven displacement](https://theorangeduck.com/page/code-vs-data-driven-displacement)                                                                           | **Required**: the deterministic simulation owns position.                                                                                                                                                            |
| Speed matching (play rate = simulation speed / clip root speed, clamped ~0.75–1.25) | standard                                                                                                                                                                              | Required; root speed extracted per clip at build time.                                                                                                                                                               |
| Directional blend space (forward, back, strafes, diagonals)                         | Lyra, PlayCanvas                                                                                                                                                                      | Required; strafing and walking backward happen whenever a soldier faces a threat while moving.                                                                                                                       |
| Distance matching for starts and stops                                              | [UE distance matching](https://dev.epicgames.com/documentation/en-us/unreal-engine/distance-matching-in-unreal-engine)                                                                | Valuable; needs start/stop clips with distance curves and simulation acceleration.                                                                                                                                   |
| Stride warping, orientation warping                                                 | [UE animation warping](https://dev.epicgames.com/documentation/en-us/unreal-engine/animation-warping-in-unreal-engine)                                                                | Orientation warping (legs toward travel, torso toward aim) is high value for a shooter; stride warping later.                                                                                                        |
| Inertialization                                                                     | Bollo, [GDC 2018](https://gdcvault.com/play/1025165/Inertialization-High-Performance-Animation-Transitions); [Holden](https://theorangeduck.com/page/spring-roll-call)                | High value and cheap; must be reconstructed from the transition's start time on seek (§8).                                                                                                                           |
| Motion matching                                                                     | Clavet, [GDC 2016](https://gdcvault.com/play/1022985/Motion-Matching-and-The-Road); UE Pose Search; [Learned motion matching](https://theorangeduck.com/page/learned-motion-matching) | **Not for Ambush!** No JavaScript implementation (none found), needs minutes of dense unstructured mocap (unavailable under usable licences; Mixamo forbids ML use), and tactical camera distances do not reward it. |
| Procedural locomotion                                                               | Rosen, [GDC 2014](https://www.gdcvault.com/play/1020583/)                                                                                                                             | Inspiration for lean, sway and recovery layers, not a replacement for mocap.                                                                                                                                         |

**Foot sliding** comes from three causes, each with a fix: playback speed not matching ground speed
(speed matching), direction not matching travel (directional blending plus orientation warping), and
feet not on the ground on slopes (foot IK). Ambush! adds a fourth: its soldiers move at constant
speed with instant starts and stops; starts and stops look right only if the simulation gains
acceleration (§ architecture, `CharacterMotor`).

---

## 7. What makes modern shooter animation convincing

Sources: [Lyra animation documentation](https://dev.epicgames.com/documentation/en-us/unreal-engine/animation-in-lyra-sample-game-in-unreal-engine);
[adapting Lyra animation](https://www.unrealengine.com/tech-blog/adapting-lyra-animation-to-your-ue5-game);
GDC talks by Duffin ([first-person animation](https://gdcvault.com/play/1017633/)), Helsby
([Destiny first person](https://gdcvault.com/play/1022297/)), DICE ([Mirror's Edge](https://gdcvault.com/play/1012171/)),
Bollo, Clavet and Rosen (above). The talks' full slides are behind the GDC Vault login; the
ranking below is **[opinion]** informed by their abstracts and Lyra's documented architecture.

| Rank | Technique                                                              | Visible gain                    | Cost                           |
| ---- | ---------------------------------------------------------------------- | ------------------------------- | ------------------------------ |
| 1    | Upper/lower body split: aiming upper body over locomotion, aim offsets | Very high                       | Low                            |
| 2    | 8-direction, speed-matched locomotion (2D blend space)                 | Very high                       | Low–medium                     |
| 3    | Well-timed or inertialized transitions per state pair                  | High                            | Low                            |
| 4    | Weapon as a separate prop with left-hand IK                            | High (close and first person)   | Low                            |
| 5    | Procedural recoil, breathing, flinch (additive springs)                | High                            | Low                            |
| 6    | Stance set with authored transitions (stand/kneel/prone, crawl)        | High for a tactical game        | Medium (content)               |
| 7    | Starts, stops and turns in place with distance matching                | Medium–high                     | Medium                         |
| 8    | Foot IK and pelvis adjustment on slopes                                | Medium (high close up on hills) | Medium                         |
| 9    | Orientation warping (legs to travel, torso to aim)                     | Medium                          | Medium                         |
| 10   | Secondary motion (straps, gear), head look-at                          | Low–medium                      | Low                            |
| 11   | Varied deaths, physical hit reactions                                  | High drama                      | High (keyframed variety first) |
| 12   | Motion matching                                                        | Very high close up              | Very high                      |

**First person** ([Duffin](https://gdcvault.com/play/1017633/), [Helsby](https://gdcvault.com/play/1022297/)): the arms,
weapon and camera are the most-watched motion in a shooter; studios use a dedicated first-person arms
rig with procedural sway, bob, recoil and aim-down-sights offsets, with the full body rendered for
shadows and other players (§ architecture, first person).

---

## 8. Determinism, replay and simulation speed

- **Principle (standard practice in lockstep games, e.g.
  [Fiedler, Deterministic Lockstep](https://gafferongames.com/post/deterministic_lockstep/);
  [1500 Archers on a 28.8](https://www.gamedeveloper.com/programming/1500-archers-on-a-28-8-network-programming-in-age-of-empires-and-beyond)):**
  only the simulation is synchronised and authoritative; the pose is cosmetic and never feeds back.
- **Fixed step plus interpolation ([Fix Your Timestep!](https://gafferongames.com/post/fix_your_timestep/)):**
  render between the previous and current tick at `alpha`. Animation time for each layer is
  `(tick + alpha) / rate − layerEntrySeconds`, never an accumulated render delta.
- **Everything a pose needs must be recoverable from recorded state and event times:** posture and
  the time the posture change started, distance travelled (locomotion phase), aim direction, the
  last shot times, the casualty time. Ambush! records full state per tick, so the review can rebuild
  any pose at any time, including when scrubbing backward.
- **History-dependent effects** (inertialization offsets, spring recoil) are evaluated in closed form
  from the start time of the transition or event, so a seek reconstructs them exactly. Where a
  transition's source pose is needed, the source state is itself recoverable from the recorded frames
  at the transition's start.
- **Speeds 1×–16× and review speeds 0.25–4×:** poses are sampled at simulation time, so higher speeds
  simply sample further apart (at 16× and 60 fps, about 0.27 s of simulation per frame, faster than a
  gait cycle can be seen; it looks right if the gait phase is distance-based, and the camera usually
  is far away). Pause freezes the pose exactly; idle breathing may continue on a cosmetic clock.
- **Gameplay-relevant animation** (time to go prone, time to raise a weapon, reload duration, muzzle
  height) belongs in simulation data tables, never in evaluated poses. Hit detection uses simulation
  geometry (points and heights per posture), not skinned bones.

**Assessment.** Deterministic _pose evaluation_ is not required; deterministic _state and event
playback with pose reconstruction_ is sufficient, provided every input to the pose is in recorded
state or derived from it. Cosmetic variation (gait offsets, idle choice) is seeded by a hash of the
soldier's id, never `Math.random`, so live and replay look identical.

---

## 9. Performance: many skinned soldiers in the browser

### 9.1 Facts and options

- **Core r186 has no instanced skinning** [verified]; `BatchedMesh` has no skinning [verified]; each
  `SkinnedMesh` is a draw call per material plus one per shadow-casting light.
- **[@three.ez/instanced-mesh](https://github.com/agargaro/instanced-mesh) (InstancedMesh2):** MIT,
  v0.3.16, last commit 2026-10-06, 452 stars, **peer `three >=0.186.0`** [verified]. Per-instance
  skinning (`initSkeleton`, `setBonesAt`), per-instance frustum culling, LOD, shadow LOD, BVH
  raycasting. Author's demo claims 3,000 skinned instances with distance-throttled animation [claim,
  no hardware or fps stated].
- **WebGPU compute skinning** (`webgpu_skinning_instancing_individual`, r186): individual poses per
  instance from one mixer; requires native WebGPU [verified]; a later path.
- **Vertex animation textures and impostors:** one draw call for thousands; no blending, aiming or IK;
  for distant crowds only.
- **Forum evidence [claim]:** about 200 skinned meshes before falling below 60 fps on a 2015 laptop
  CPU ([thread](https://discourse.threejs.org/t/optimization-of-large-amounts-100-1000-of-skinned-meshes-cpu-bottlenecks/58196)),
  with about 75 % of CPU time in `AnimationMixer.update`, `updateMatrixWorld` and `projectObject`;
  1,000 at 60 fps by sharing one skeleton per animation state.

### 9.2 Benchmark on this machine [measured]

**Setup.** Chrome 155 (headed, launched by Playwright), three@0.186.1 `WebGLRenderer`, 1600×900,
pixel ratio 1, MSAA, ACES tone mapping. **GPU actually used: the integrated AMD Radeon 880M**
(ANGLE/Direct3D 11); the laptop's NVIDIA RTX 5070 was not exposed to Chrome. CPU: AMD Ryzen AI 9 365.
GPU times from `EXT_disjoint_timer_query_webgl2`. Test asset: three.js's `Soldier.glb` (a Mixamo
character, used only as a private measurement stand-in): 11,376 triangles in 2 skinned meshes, 49-bone
body skeleton, 1K textures, Walk clip. Each configuration ran 2 s warm-up + 5 s measured in a fresh
page. "Uncapped" disables vsync, so frame time is throughput.

Variants: **V1** a mixer per soldier, every frame, no shadows; **V2** V1 with a 2048² shadow map;
**V3** the farther half updates its mixer every 4th frame (animation LOD); **V4** 8 animated
skeletons shared by all soldiers (a ceiling for pose sharing, not a drop-in technique).

Uncapped frame time (ms; 16.7 ms = 60 fps):

| Soldiers |   V1 | V2 (shadows) | V3 (anim LOD) | V4 (shared poses) | GPU, V1 | GPU, V2 | Draw calls, V1 |
| -------: | ---: | -----------: | ------------: | ----------------: | ------: | ------: | -------------: |
|        1 |  0.6 |          0.6 |           0.6 |               0.7 |     0.2 |     0.4 |              3 |
|       10 |  0.8 |          0.8 |           0.8 |               0.7 |     0.3 |     0.6 |             21 |
|       25 |  1.0 |          1.5 |           1.1 |               1.0 |     0.6 |     0.9 |             51 |
|       50 |  2.2 |          2.9 |           2.0 |               1.1 |     0.9 |     1.3 |            101 |
|      100 |  5.7 |          6.4 |           5.4 |               1.5 |     1.9 |     2.7 |            201 |
|      250 | 18.5 |         25.5 |          20.3 |               2.5 |     3.1 |     9.1 |            501 |
|      500 | 42.1 |         49.3 |          33.2 |               4.3 |     5.1 |    19.0 |          1,001 |

Per-soldier CPU cost (V1 at 500, matrix update timed separately): **mixer ~25 µs** (~35 µs with a
two-clip blend), **bone hierarchy matrices ~20 µs**, **skeleton update, bone-texture upload and draw
submission ~39 µs** — about **84 µs per fully animated soldier**, so about 200 fill a 60 Hz frame on
this CPU before any game work. With vsync on, V1 and V2 hold 60 fps up to 100 soldiers and miss frames
at 250; V3 just holds 250; V4 holds 500 with 3.1 ms CPU at the 95th percentile.

Loading: GLB parse 33–36 ms; one `SkeletonUtils.clone` + mixer ~0.33 ms; the first frame after
building the crowd costs ~1.7 ms per soldier (shader compile and uploads; 0.8–0.9 s at 500), which
argues for building characters progressively, as the vegetation already is.

### 9.3 Conclusions from the measurements

1. **CPU-bound, not GPU-bound.** Without shadows the integrated GPU drew 5.7 M skinned triangles in
   1,001 draw calls in ~5 ms; frame time tracked CPU time exactly. A discrete GPU would not change the
   limits.
2. **Throttling the mixer alone is not enough** (V3: −35 % mixer time) because matrix updates and
   skeleton uploads stay per soldier per frame; **sharing or caching poses** (V4) removes almost all of
   it, leaving ~7 µs per soldier of draw submission, which instanced skinning removes in turn.
3. **Shadows from hundreds of skinned soldiers cost the GPU** (19 ms at 500 on this GPU): shadow
   casting only for the near band.
4. **Realistic targets** (to be confirmed with the real asset, which has more bones and a different
   mesh count): full-detail animation for ~25–50 near soldiers; ~100–250 visible soldiers at 60 fps on
   an integrated GPU with animation LOD, pose sharing for distant bands and near-only shadows; 500+ with
   instanced skinning and impostors beyond a few hundred metres. Ambush!'s current scenarios have 16.
5. **Caveats:** one run per configuration (±10 % variation), an empty scene (no terrain, vegetation or
   game logic), one model, integrated GPU only, crowd covering fewer pixels as it grows. The benchmark
   page and runner are reproducible from the research folder (`node run.mjs --uncapped`) and would be
   committed as a repeatable browser check in roadmap phase 7.
