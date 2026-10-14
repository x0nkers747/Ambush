# Character animation roadmap

- Status: **superseded** by the [revised roadmap](character-animation-revised-roadmap.md) (2026-10-14),
  after the [framework evaluation](character-animation-framework-evaluation.md) and its prototype.
  Kept for the record. Companion documents:
  [research](character-animation-research.md),
  [architecture](character-animation-architecture.md),
  [asset evaluation](character-asset-evaluation.md).
- Date: 2026-10-13.
- Effort is in **engineer-weeks for one experienced TypeScript/three.js engineer** working in this
  repository [estimate]; asset work (Blender retargeting, commissions) is listed separately. Every
  phase ends with `npm run check` passing and a browser check on a real GPU in Chrome.

The brief's phases are reordered in three ways, each for a reason found in the research:

- **Foundations first (phase 0):** render interpolation and a fractional review time are missing
  today (soldiers step at 30 Hz), and the asset pipeline and licensing decision gate everything.
- **Simulation integration early:** the earliest convincing milestone needs soldiers moving through a
  real battlefield, so a first integration comes in phase 2, not phase 6.
- **Levels of detail are built in from phase 1:** performance work is not left to the end.

---

## Decision gate (before phase 0)

Approval needed for (see the summary at the end):

1. Asset licensing policy for a public repository (Mixamo or not, where non-public assets live).
2. Budget for commercial animation/model packs and commissions (M249, first-person arms, soldier
   model upgrade).
3. The simulation changes that alter combat outcomes (posture-dependent line of sight, aim and firing
   arcs, ammunition and reloads, speed classes and acceleration).
4. The canonical skeleton (VRM-humanoid naming) and the visual era of the squad (1991 Marine
   woodland/MARPAT vs modern).

---

## Phase 0: Foundations (2 weeks)

- **Objective:** smooth motion and a working asset pipeline before any character.
- **Dependencies:** decision gate.
- **Deliverables:**
  - `Exercise` exposes the runner's `alpha` and the previous tick's soldier state; the review gains
    `frameAtFraction` and interpolated frames.
  - Today's markers interpolate (immediate visible improvement: no 30 Hz stepping).
  - Asset pipeline: Blender (free) retarget scripts to a VRM-named canonical skeleton, gltf-transform
    build step (resample, prune, quantise, meshopt, KTX2), per-clip metadata extraction (root speed,
    foot contacts, durations) as JSON.
  - Asset storage per the licensing decision (CC0/MIT/CC BY in the repository with `CREDITS.md`;
    anything else outside it).
- **Architectural changes:** `src/exercise` (alpha, previous state), `src/exercise/replay.ts`,
  `src/view3d/unit-markers.ts`; new `tools/assets/` scripts.
- **Assets:** Rocketbox Military_Male_01 (MIT), Quaternius UAL / Mesh2Motion clips (CC0).
- **Risks:** Blender scripting time; specular→PBR material conversion quality.
- **Acceptance:** markers move smoothly at 1×–16× and in the review at 0.25×; at α = 0 marker feet
  equal simulation positions within 1 cm; state hashes unchanged; one retargeted test clip plays on the
  canonical skeleton.
- **Tests:** node tests for interpolation endpoints and fractional review frames; determinism tests
  unchanged.
- **Visual result:** today's soldiers, gliding smoothly instead of stepping.

## Phase 1: Asset proof of concept (2 weeks)

- **Objective:** a convincing rigged soldier with idle, walk, run and sprint in a standalone test
  page, with levels of detail from the start.
- **Dependencies:** phase 0.
- **Deliverables:** a development page (like `symbols.html`) loading the soldier GLB, M16A2 model on a
  hand socket, 1D speed blend (idle → walk → run → sprint) driven by a slider, speed matching from clip
  metadata, gait phase from a simulated odometer; three mesh LODs; a benchmark mode (N soldiers) that
  reports mixer, render and GPU times.
- **Architectural changes:** `src/view3d/characters/` (asset manager, rig instance, minimal
  animator); no change to the game yet.
- **Assets:** Rocketbox (retextured if decided), CC0 locomotion clips, TastyTony M16A4 (CC BY) as
  stand-in for the M16A2.
- **Effort:** 2 weeks (+ 2–4 days of Blender asset work).
- **Risks:** retarget quality (twisted limbs); material look.
- **Acceptance:** no visible foot sliding across the speed range on flat ground; 100 fully animated
  soldiers at 60 fps on the reference machine's integrated GPU (the stand-in model did this in 5.7 ms
  per frame; research §9).
- **Tests:** asset metadata tests in node (root speeds, loop seams, skeleton names); browser
  benchmark recorded in the ADR.
- **Visual result:** a soldier walking, running and sprinting convincingly on a test plane.

## Phase 2: First battlefield integration (2–3 weeks) — **earliest convincing milestone**

- **Objective:** animated soldiers replacing markers in the real 3D view, following the existing
  simulation (one speed, orders, OPFOR prone/flee, shots, casualties).
- **Dependencies:** phases 0–1.
- **Deliverables:** `CharacterPoseInput` adapter; character renderer in place of `markers.ts` (markers
  kept as far LOD and for selection); locomotion from simulation velocity and odometer (derived in the
  view until the simulation provides them); OPFOR going prone with a transition clip timed to a fixed
  window; shots trigger a fire clip/recoil at `ShotFiredEvent.atSeconds`; incapacitation plays a death
  clip; tracers and muzzle flashes in 3D from shot events (replacing the 2D overlay lines in 3D).
- **Architectural changes:** `view.ts` (create/update/dispose characters), `quality.ts`
  (`characters` block), `ambushDebug` character stats.
- **Effort:** 2–3 weeks.
- **Risks:** facing snaps when firing (the simulation snaps azimuth; smooth in the view); constant
  speed starts/stops look abrupt until phase 4.
- **Acceptance:** the five-stage workflow at Quantico shows animated Marines occupying positions and
  an animated OPFOR patrol; AAR replay shows the same poses as live at any scrub position (pixel
  comparison at chosen times); no change to any state hash.
- **Tests:** node tests of the pose input against recorded frames; browser checks comparing live and
  review captures at the same simulation times.
- **Visual result:** **a squad of animated soldiers walking through an actual Ambush! battlefield and
  an ambush playing out with firing and casualties** — the convincing milestone, after about 6–7 weeks.

## Phase 3: Complete locomotion (3 weeks)

- **Objective:** directional movement, transitions and turning.
- **Dependencies:** phase 2.
- **Deliverables:** 2D blend spaces (8 directions) per posture; turning in place (authored turns +
  foot shuffle); upper/lower body split with aim layer following simulation azimuth/aim; closed-form
  inertialized transitions; orientation warping.
- **Effort:** 3 weeks.
- **Risks:** blend-space tuning; transition artefacts at 16×.
- **Acceptance:** soldiers backing up or strafing while facing a threat look correct; no pops on
  transitions in live or review; scrubbing backward reproduces forward poses exactly.
- **Tests:** blend weight unit tests (sum to 1, continuity); seek-equivalence tests in node (pose at
  time t computed directly equals pose reached by playback).
- **Visual result:** natural directional movement and turns.

## Phase 4: Simulation motor and posture system (3–4 weeks)

- **Objective:** speed classes, acceleration, posture commands and transitions in the simulation, and
  their animation.
- **Dependencies:** phase 3; approval of the simulation changes.
- **Deliverables:** `SpeedClass`, `velocity`, `odometerM`, `postureChange` state; `SetPosture`,
  `SetSpeedClass` commands; motor acceleration/deceleration; posture-dependent speeds and line-of-sight
  heights (behind a combat-config version bump); BLUEFOR planning UI for posture and speed per order;
  animation of kneel/crouch, prone, crawl and all transitions, distance-matched starts and stops.
- **Architectural changes:** `src/sim` (state, commands, movement, los parameters), `combat-v1.json`
  → v2 (heights, posture speeds), planning UI in `src/app`.
- **Effort:** 3–4 weeks.
- **Risks:** combat balance changes; hash and test updates; UI design for posture orders.
- **Acceptance:** determinism tests at 1×/4×/8×/16×, pause/resume and snapshot pass with the new state;
  a Marine ordered to rush then go prone does so with correct timing in live and review.
- **Tests:** simulation unit tests for the motor and posture timings; hash tests extended; browser
  checks of transitions.
- **Visual result:** soldiers kneeling, going prone, crawling and rushing as ordered.

## Phase 5: Weapons (3–4 weeks + external content)

- **Objective:** weapon-aware upper body for the M16A2 (rifle class, also the AK) and the M249
  (automatic-rifle class), with aiming, firing, reloading.
- **Dependencies:** phases 3–4; asset decisions; ammunition/reload simulation if approved.
- **Deliverables:** `WeaponHandling` profiles with sockets; weapon attachment; left-hand and barrel
  IK; aim IK distributing over the spine; carry/ready/aimed states; fire with procedural recoil per
  weapon (M249 bursts); reloads timed to simulation windows; M249 bipod prone pose; M203 as an
  attachment; muzzle-accurate flashes and tracers; raise/lower and weapon switching.
- **Effort:** 3–4 weeks engineering; M249 reload and prone clips commissioned or captured in parallel
  (2–6 weeks lead time, external).
- **Risks:** grip pose quality with different weapon geometry; content lead time.
- **Acceptance:** muzzle direction within 1° of the simulation's aim when firing; hands on the weapon
  within 1 cm in all postures; M249 visibly different in carry, fire and reload from the M16A2.
- **Tests:** socket and IK unit tests (two-bone solver reaches reachable targets, respects poles);
  browser captures per weapon and posture.
- **Visual result:** soldiers aiming, firing and reloading their actual weapons.

## Phase 6: Terrain adaptation (2 weeks)

- **Objective:** feet on the ground on slopes, roads, bridges and uneven ground.
- **Dependencies:** phase 3.
- **Deliverables:** foot IK on the simulation's height function, pelvis adjustment, foot tilt to the
  ground normal, foot locking while planted, slope lean, prone body alignment.
- **Effort:** 2 weeks.
- **Risks:** IK cost at scale (limited to near LODs); knee popping (soft IK).
- **Acceptance:** on Quantico's slopes and bridges, no visible floating or sinking feet within 30 m.
- **Tests:** IK unit tests; browser captures on a slope and a bridge.
- **Visual result:** grounded soldiers on hillsides.

## Phase 7: Performance and scaling (3 weeks)

- **Objective:** hundreds of soldiers within budget.
- **Dependencies:** phases 2–6.
- **Deliverables:** animation/skeleton/mesh LOD bands per preset; update throttling on simulation time;
  pose sharing for distant soldiers; InstancedMesh2 skinning for far bands; impostors beyond; shadow
  LOD; budgets enforced; benchmark scenes of 25–500 soldiers committed as a repeatable browser check.
- **Effort:** 3 weeks.
- **Risks:** library maturity (InstancedMesh2 is single-maintainer); visible LOD pops.
- **Acceptance:** on the reference machine's integrated GPU (research report §9: ~84 µs CPU per fully
  animated soldier, CPU-bound), 250 visible soldiers at 60 fps with up to 50 at full detail and
  near-only shadows; 500 with instanced far bands.
- **Tests:** committed benchmark script with recorded results per release.
- **Visual result:** platoon- to company-scale scenes at full frame rate.

## Phase 8: First-person player control (6–8 weeks + external content)

- **Objective:** a player controls one soldier in first person; the same soldier is AI-driven when not.
- **Dependencies:** phases 4–6; first-person arm assets.
- **Deliverables:** `MoveIntent`, `Aim`, `Fire`, `Reload` commands; app input module (pointer lock,
  keys); first-person camera mode; first-person arms/weapon rig and pass; aim-down-sights; recoil, sway
  and bob; camera prediction reconciled to the simulation each tick; hand-over between AI and player
  control; terrain collision through the simulation motor.
- **Effort:** 6–8 weeks engineering; first-person arm animation set (commissioned, external).
- **Risks:** 30 Hz input latency (option: raise the tick rate); camera comfort; first-person framing
  quality.
- **Acceptance:** a player can move, change posture, aim and fire in first person; the AAR replays the
  player's actions exactly (from the command stream); outcomes identical on replay.
- **Tests:** command-stream replay tests; browser tests of input-to-command mapping.
- **Visual result:** first-person play inside the Ambush! battlefield.

## Phase 9: Polish (4+ weeks, ongoing)

- Distance-matched starts/stops refinement, stride warping, varied deaths and hit reactions,
  secondary motion (straps, gear), head look-at, idle variety, wounded locomotion if the combat model
  adds wounds, uniform and kit variety.

---

## Totals

| Phases                                    | Engineering (weeks)                                          | Calendar note                              |
| ----------------------------------------- | ------------------------------------------------------------ | ------------------------------------------ |
| 0–2 (to the convincing milestone)         | 6–7                                                          |                                            |
| 3–7 (complete AI-soldier system at scale) | 14–16                                                        | external M249 content in parallel          |
| 8 (first person)                          | 6–8                                                          | first-person arms commissioned in parallel |
| 9 (polish)                                | 4+                                                           | ongoing                                    |
| **Total**                                 | **about 30–35 engineer-weeks (7–9 months for one engineer)** | plus external content lead times and costs |

These are estimates without a prototype; phase 1's measurements should recalibrate them.
