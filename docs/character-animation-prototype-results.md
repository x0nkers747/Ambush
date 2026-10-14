# Character animation prototype: results

- Status: **prototype findings** (nothing in the game changed). Prototype:
  [`prototypes/character-animation/`](../prototypes/character-animation/) — run `npm install`,
  `npm run assets`, `npm run dev`. Companion documents:
  [framework evaluation](character-animation-framework-evaluation.md),
  [recommended architecture](character-animation-recommended-architecture.md),
  [revised roadmap](character-animation-revised-roadmap.md).
- Date: 2026-10-14. Screenshots: [`docs/research/character-animation/`](research/character-animation/).
- Machine: AMD Ryzen AI 9 365, **AMD Radeon 880M integrated GPU** (the one Chrome uses; the
  laptop's RTX 5070 is not exposed to Chrome), Windows 11, Chrome 155.0.8059.40 (Playwright,
  headed for benchmarks), window 1600×900, canvas about 1000×860, device pixel ratio 1.
- Labels: **[measured]** in the prototype, **[observed]** by looking at it (screenshots linked),
  **[estimate]**.

---

## 1. What was built

One page, one scene, one 30 Hz deterministic mini-simulation (`src/sim.ts`, the same shape as
Ambush!'s: plain data, commands stamped with ticks, a recorded frame per tick, plus the proposal's
posture/carry/aim/shot/reload state), two runtimes fed the same input, and shared
post-processing (weapon hold, IK, aim) so that visual differences come from the runtimes alone.

| Runtime                | What it is                                                                                                                                                       | Custom code it needed                                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **A. three.js native** | `AnimationMixer` with one action per clip and layer; weights and times computed from the pose input; `mixer.update(0)`                                           | 194 lines animator + 162 locomotion weights + 67 gait clock + 61 masks                                                                     |
| **B. animouse 0.8.0**  | `AnimationMachine` + `FreeformBlendTree` (2D standing locomotion) + `LinearBlendTree` (kneeling) + `ClipState`s, events from input changes, `machine.update(dt)` | 299 lines, including three workarounds (second machine on a stub mixer for the upper body; guarded `setBlend`; rebuild-and-replay on seek) |

Not prototyped, with the evidence in the [evaluation](character-animation-framework-evaluation.md):
PlayCanvas's anim system (engine-bound, clock-driven transitions), ozz-animation (no bindings).
InstancedMesh2 was prototyped as a renderer (§6).

The **test sequence** (47 s): idle; slow walk 0.9 m/s; walk 1.5; run 3.4; sprint 5.6; stop;
turn 90° in place; raise to ready, then aim; strafe left and walk backward while aiming; fire 3
shots; kneel; fire; go prone; crawl 0.4 m/s; aim and fire prone; stand; diagonal walk aiming
8° down; reload; aim; rapid fire; incapacitated.

## 2. Assets actually used

See [`ASSETS.md`](../prototypes/character-animation/ASSETS.md) for authors, URLs and licences.

| Character                                     | Rig              | Clips                                                              | Look                                                                               |
| --------------------------------------------- | ---------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Microsoft Rocketbox `Military_Male_01` (MIT)  | 80-bone Biped    | all retargeted: 18 from Mesh2Motion/UAL (CC0), 7 from KayKit (CC0) | Realistic 2010s game soldier (ACU, helmet, IOTV); the best openly licensed soldier |
| Mesh2Motion mannequin (CC0)                   | 66-bone UE-style | UAL native, KayKit retargeted                                      | Neutral mannequin; reference for "no retargeting"                                  |
| Quaternius Soldier (CC BY 3.0 per Poly Pizza) | 62-bone          | own 24 clips                                                       | Stylised; its "gun" clips are **one-handed pistol poses**                          |
| KayKit mannequin (CC0)                        | 23-bone          | KayKit native                                                      | Chibi; the source of the only open two-handed rifle clips                          |

Weapon: "Assault Rifle West" (CC0, AR-15 pattern) scaled to an M16A2's 1.0 m. M249: a labelled
box placeholder.

## 3. Retargeting

- **Rest-aligned world-delta retargeting** (`src/retarget.ts`, 251 lines): limb directions after
  retargeting match the source within 0.01 in every component [measured: `limbDirs` hook] for UAL →
  Rocketbox and KayKit → Rocketbox/mannequin. Locomotion, crouch and crawl look right on Rocketbox
  [observed].
- **Proportions break contact poses.** KayKit's rifle aim retargets _exactly_ (same directions),
  but on realistic proportions the hands end up 30–40 cm apart and away from any rifle [observed:
  `kaykit-aim-retarget.jpg`]. Its shoot clip twists a realistic torso sideways. Conclusion: clips
  from a differently proportioned rig give body motion, not hand contacts — **hands must come from
  weapon-anchored IK**.
- **Lying and crawling** need ground contact after retargeting (thicker or thinner bodies float or
  sink): the retargeter keeps the lowest joint at its rest height for those clips only (locomotion
  keeps its flight phase).
- three.js `SkeletonUtils.retargetClip` is offered as an option (`inspect.html?retarget=three`);
  see §3.1 for the result.

### 3.1 `SkeletonUtils.retargetClip`

With the options its documentation describes (`names` as the target→source bone map, `hip`), on
the UAL walk → Rocketbox [measured: `limbDirs`, observed: `retarget-three-vs-rest.jpg`]:

- the spine points forward (direction (0.17, −0.27, 0.95) instead of up): the soldier lies on its
  side, out of frame;
- both upper arms point to the same side ((−0.95, 0.27, 0.15) and (−0.97, −0.25, −0.06));
- no hips translation track is produced.

It matches source and target bones' world orientations, which only works when both rigs share
bone axes and rest poses; Biped and UE-style rigs do not. Per-bone `localOffsets` might be tuned to
fix it, but that is manual work per rig pair. The rest-aligned method needs no tuning (directions
match within 0.01). Either way, retargeting belongs in an offline build step, not at load time
(here it is part of the 0.6 s asset load from a local server, which also measures every clip).

## 4. Weapon handling and IK

| Check (Rocketbox, M16 stand-in, native runtime)                | Result                                                                                                |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Right hand to grip, all carries and postures                   | 0 cm miss at 18 sampled times [measured: `holdReport`]                                                |
| Left hand to handguard, standing/kneeling, lowered/ready/aimed | 0 cm [measured]                                                                                       |
| Left hand to handguard, prone                                  | 4–6 cm (shoulder geometry on the ground) [measured]                                                   |
| Left hand during reload                                        | follows the magwell → pouch → magwell path (procedural) [observed]                                    |
| Rifle upper body from KayKit clips instead                     | left hand misses 3–23 cm while moving or firing; torso twisted by the shoot clip [measured, observed] |

What made the hold work [observed, `aim-*.jpg`]: placing the rifle from the shoulder pocket and
aim direction; **blading the torso** (left shoulder forward, 45° when aimed); a small **clavicle
reach** before the arm IK; turning the head back along the aim with a cheek-weld tilt. three.js has
no bone look-at (Object3D.lookAt assumes +Z forward); the head look is 12 lines.

**CCDIKSolver** (three.js addon) for the arms, same targets and order [measured: `holdReport`,
observed: `ik-ccd.jpg`]: right hand 0–0.1 cm; left hand **1.5–16 cm** off the handguard
(standing 1.5–7.6 cm, kneeling 8.2 cm, prone 15.8 cm) where the analytic two-bone solver reaches it
exactly. It also needs the target to be a bone of the skeleton, so each soldier's skeleton is
rebuilt with two extra bones, and it has no pole vector to keep the elbows down.

**M249**: the placeholder uses the same hold with its own sockets and stronger recoil; there is no
M249-specific handling to show without clips (belt, box, bipod, reload).

**Foot IK** on the uneven ground (15° ramp, bumps): the pelvis drops by the lower foot's offset and
both legs reach the ground; feet tilt to the slope [observed, `slope-*.jpg`].

## 5. Deterministic replay [measured]

Pose (every bone's local rotation and position after IK, plus the weapon) at 15 times of the test
sequence, reached ten ways, compared with continuous 60 Hz playback. Rocketbox, M16, both
runtimes, a fresh soldier per pass. Tolerances: **exact** ≤ 0.01° and 0.1 mm; **visual** ≤ 1° and
5 mm. Raw data: [`results/determinism-2026-10-14.json`](../prototypes/character-animation/results/determinism-2026-10-14.json).

| Pass                                          | A. three.js native        | B. animouse                                                  |
| --------------------------------------------- | ------------------------- | ------------------------------------------------------------ |
| Continuous 144 Hz                             | 0.0000° / 0.00 mm — exact | 3.37° / 10.3 mm — fail                                       |
| Continuous, irregular frame times (4–37 ms)   | exact                     | 5.05° / 9.3 mm — fail                                        |
| Slow motion 0.25×                             | exact                     | 4.06° / 11.6 mm — fail                                       |
| Fast forward 16×                              | exact                     | 48.3° / 108.6 mm — fail                                      |
| Seek forward (ascending times)                | exact                     | 70.1° / 186.4 mm — fail (with 2 s of replay after each seek) |
| Seek backward                                 | exact                     | 70.1° / 186.4 mm — fail                                      |
| Seek shuffled                                 | exact                     | 70.1° / 186.4 mm — fail                                      |
| Repeat on a fresh animator (same 60 Hz steps) | exact                     | exact (0.0000°)                                              |
| 3D hidden for 6 s, then resumed               | exact                     | 4.67° / 13.1 mm — fail                                       |

Two three.js behaviours had to be handled to get the native row exact (both are now rules in the
architecture):

1. **`PropertyMixer` skips writing a property whose new value equals the value it wrote last
   frame.** Anything that edits mixer-driven bones afterwards (IK, aim) persists into the next
   frame and accumulates. Fix: save the sampled pose after `mixer.update` and restore it before the
   next update (`saveClipPose`/`restoreClipPose`). Before the fix, seeks differed by up to 72°.
2. **A mixer records each property's "original state" when first bound** and blends it in wherever
   weights sum to less than 1, so bind on the rest pose (`applyRestPose`).

Also: compare quaternions normalised — clip quaternions are not exactly unit length, and
`angleTo(q, q)` returned 0.049° for identical non-unit quaternions.

animouse is repeatable for an identical sequence of frame times but not across frame rates, speeds
or seeks: its transitions and blend weights integrate `dt`, a newly weighted clip restarts at time
0 (losing foot phase), and it has no way to set a state's time. Replaying 2 s of history after a
seek does not recover the pose.

## 6. Performance [measured]

### 6.1 Method

- `tools/bench.mjs` drives the page in headed Chrome 155 (Playwright) with **vsync off** (frame time
  = throughput) and, for the representative scene, again with **vsync on** (does it hold 60 fps?).
  At least 1.5 s and 30 frames of warm-up (plus an unrecorded warm-up run per page, for shader
  compilation and texture uploads), then 4 s measured.
- N Rocketbox soldiers (15,387 triangles, 80 bones, **13 draw groups**) on a 2 m grid, each playing
  the test sequence at a different time offset; camera at a tactical oblique view over the block;
  2048² sun shadow map.
- **Minimal scene:** flat ground, soldiers only, no weapons. **Representative scene:** uneven
  ground with 2,400 of the game's own trees (`src/view3d/tree-models.ts` geometry and the foliage
  atlas, used read-only), shadows and fog; soldiers carry the rifle with hold, hand IK, spine aim and
  foot IK where the mode supports it.
- Per frame: animation CPU (animators + post-processing), render CPU (`renderer.render`), GPU
  (`EXT_disjoint_timer_query_webgl2`), draw calls and triangles (`renderer.info`).
- Raw data: [`results/bench-2026-10-14.json`](../prototypes/character-animation/results/bench-2026-10-14.json)
  and [`.md`](../prototypes/character-animation/results/bench-2026-10-14.md) (vsync off);
  [`bench-2026-10-14-vsync.md`](../prototypes/character-animation/results/bench-2026-10-14-vsync.md) (vsync on).
  The animouse group was re-run after fixing a benchmark bug (a fixed 1/60 s step made every frame
  look like a seek to animouse, so the first numbers were ten times too high).

### 6.2 Minimal scene, vsync off — frame mean / p95 ms; animation CPU ms

| Mode                                                   |                10 |                25 |                50 |                 100 |                  250 |
| ------------------------------------------------------ | ----------------: | ----------------: | ----------------: | ------------------: | -------------------: |
| A native, mixer per soldier                            | 1.10 / 1.60; 0.37 | 2.30 / 2.80; 0.89 | 4.90 / 5.80; 2.24 | 10.78 / 11.50; 4.58 | 32.05 / 49.30; 12.08 |
| A + animation LOD (every 2nd/4th frame beyond 20/50 m) | 1.15 / 1.60; 0.40 | 2.30 / 2.60; 0.82 | 4.20 / 4.70; 1.13 | 10.41 / 11.10; 2.77 |  22.50 / 24.20; 4.48 |
| A + 8 shared pose slots                                | 1.00 / 1.40; 0.36 | 1.54 / 2.10; 0.40 | 2.29 / 3.30; 0.41 |   4.16 / 4.90; 0.46 |   9.15 / 23.30; 0.51 |
| B animouse, machine per soldier                        | 1.10 / 1.50; 0.36 | 2.11 / 2.40; 0.83 | 4.62 / 5.10; 2.16 | 11.05 / 11.80; 4.93 | 32.06 / 33.60; 13.31 |
| E InstancedMesh2, pose per instance                    | 1.22 / 1.50; 0.27 | 1.92 / 3.10; 0.65 | 2.64 / 3.20; 1.40 |   4.41 / 5.20; 3.58 |   9.93 / 11.40; 9.04 |
| E + 8 shared pose slots                                | 1.26 / 1.70; 0.33 | 1.75 / 2.20; 0.42 | 2.61 / 3.00; 0.51 |   4.41 / 5.40; 0.77 |   9.68 / 10.80; 1.25 |

Draw calls at 100 soldiers: 2,601 in every per-soldier mode (13 groups × colour and shadow passes),
**27** instanced. GPU time at 100: 4.4 ms (A), 3.5 ms (shared), 3.7 ms (instanced); at 250 the
integrated GPU (8.4–12.6 ms) becomes the limit for the shared and instanced modes.

### 6.3 Representative scene (2,400 trees, shadows, uneven ground)

Vsync off — frame mean / p95 ms (animation CPU ms):

| Mode                               |                 10 |                 25 |                   50 |                   100 |                   250 |
| ---------------------------------- | -----------------: | -----------------: | -------------------: | --------------------: | --------------------: |
| A native + rifle + hold/IK/foot IK | 3.00 / 3.40 (1.64) | 6.76 / 7.30 (4.02) | 15.34 / 16.20 (8.50) | 31.65 / 32.90 (16.13) | 78.05 / 80.30 (38.95) |
| A + animation LOD + rifle/IK       | 2.85 / 3.30 (1.58) | 6.84 / 7.50 (3.68) | 11.44 / 12.20 (4.87) |  23.63 / 25.40 (8.72) | 55.69 / 57.50 (17.55) |
| A + 8 shared poses (no weapons)    | 1.68 / 2.90 (0.49) | 2.06 / 4.10 (0.46) |   2.99 / 5.40 (0.47) |   4.67 / 16.50 (0.46) |   9.91 / 23.20 (0.49) |
| E InstancedMesh2 (no weapons)      | 2.01 / 2.50 (0.31) | 2.56 / 3.00 (0.69) |   3.55 / 4.10 (1.49) |    5.63 / 7.00 (3.07) |  10.83 / 12.20 (8.98) |

Vsync on — does it hold 60 fps (mean 16.7 ms, p95 ≤ 18 ms)?

| Mode                | 25                 | 50                     | 100                | 250                    |
| ------------------- | ------------------ | ---------------------- | ------------------ | ---------------------- |
| A native + rifle/IK | yes (16.66 / 17.3) | **yes (16.66 / 17.0)** | no (30.6 / 33.4)   | no (76.6 / 83.4)       |
| A + LOD + rifle/IK  | yes (16.66 / 17.2) | yes (16.66 / 17.0)     | no (23.8 / 33.5)   | no (55.5 / 66.7)       |
| A + 8 shared poses  | yes (16.66 / 17.2) | yes (16.66 / 17.9)     | yes (16.66 / 17.1) | **yes (16.66 / 17.0)** |
| E InstancedMesh2    | yes (16.66 / 17.8) | yes (16.66 / 17.7)     | yes (16.66 / 17.3) | **yes (16.67 / 17.4)** |

### 6.4 Where the time goes (100 soldiers)

| Cost per soldier per frame                                             |  µs |
| ---------------------------------------------------------------------- | --: |
| Sampling and blending, native mixer (two layers)                       |  46 |
| Same, animouse                                                         |  49 |
| Prototype hold + IK + aim (allocating, recursive world-matrix updates) |  85 |
| Render CPU, 13 draw groups × 2 passes (minimal scene)                  |  60 |
| Render CPU with a rifle (its own groups × 2 passes)                    | 141 |
| InstancedMesh2 pose + `setBonesAt` (80 bones)                          |  36 |

- The animation runtime is not the bottleneck; draw submission is (13 draw groups per soldier,
  more with a rifle). Merging materials and instancing far soldiers give the largest gains.
- Animation LOD halves animation CPU at 100+ soldiers and costs nothing in correctness: a skipped
  frame needs no catching up when the pose is a function of time.
- First frame after creating soldiers (shader compilation, uploads): about 9 ms per soldier
  (906 ms for 100); InstancedMesh2 5 ms in total. Build characters progressively.
- Creating a soldier (clone + animator): 0.5 ms; with the prototype's rifle and IK set-up: 4 ms.
  A seek costs 0.35–0.4 ms per soldier for the native runtime (one evaluation) and 0.55 ms for
  animouse (rebuild + 2 s replay). JS heap readings were dominated by garbage collection and are
  not reported per soldier.

## 7. Foot sliding [measured]

Horizontal speed of the planted foot joint (ankle or toe within 2.5 cm of its rest height in two
consecutive frames; the slowest such joint), cm/s, over the test sequence at 60 Hz, standing
phases only. 0 = no sliding.

Raw data: [`results/foot-slide-2026-10-14.json`](../prototypes/character-animation/results/foot-slide-2026-10-14.json).

| Phase                        | Rocketbox, A native | Rocketbox, B animouse | Mannequin, A native | Mannequin, B animouse |
| ---------------------------- | ------------------: | --------------------: | ------------------: | --------------------: |
| Standing still               |                 4.3 |                   1.8 |                 5.4 |                   1.4 |
| Walk (0.9–1.5 m/s)           |                35.7 |                  37.2 |                29.2 |                  37.4 |
| Run (3.4 m/s)                |                27.6 |                  98.7 |                29.1 |                 146.0 |
| Sprint (5.6 m/s)             |                53.7 |                 418.8 |                71.3 |                 443.9 |
| Strafe / backward / diagonal |               145.5 |                 155.0 |               127.5 |                 144.4 |
| Turn in place                |               169.6 |                  68.9 |               111.4 |                  69.9 |

- Distance-based gait phase (native) keeps running and sprinting feet planted; animouse restarts
  clips at time 0 when they gain weight and plays each at its own rate, so the run/sprint blend
  loses foot phase (4–8× more sliding).
- Strafes and diagonals slide in both: the UAL strafe clips are slow (0.4–0.8 m/s measured) and the
  4-way blend mixes cycles of different lengths. Fix with proper 8-way clips and orientation
  warping (roadmap).
- Turning in place: the walk-stepping substitute pivots the feet (expected without turn clips).
- Before fixing the Biped mask (§8), Rocketbox ran with idle legs and slid 333–537 cm/s.

## 8. Defects and gotchas found

| #   | Where                | What                                                                                                                                                                                       | Status                                                                            |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| 1   | animouse 0.8.0       | `FreeformBlendTree.setBlend` throws "Invariant violation: no edge data found for outer vertex" for 2,830 of 6,440 points of a standard locomotion layout, including points inside the hull | Characterised in `test/animouse-freeform.test.ts`; worked around (retry off-axis) |
| 2   | animouse 0.8.0       | peer `three <0.180`                                                                                                                                                                        | `legacy-peer-deps` in the prototype                                               |
| 3   | animouse 0.8.0       | a clip gaining weight restarts at 0; no phase sync, no seek, no layers                                                                                                                     | Design limits                                                                     |
| 4   | three.js r186        | PropertyMixer write skipping + post-process edits accumulate                                                                                                                               | Restore the sampled pose                                                          |
| 5   | three.js r186        | original state captured at bind                                                                                                                                                            | Bind on rest                                                                      |
| 6   | Rocketbox (Biped)    | thighs parented to the spine; subtree masks include the legs                                                                                                                               | Canonical masks                                                                   |
| 7   | CC0 rifle clips      | KayKit proportions; shoot clip twists realistic torsos                                                                                                                                     | Procedural hold + IK                                                              |
| 8   | Quaternius Soldier   | "gun" clips are one-handed pistol poses                                                                                                                                                    | Not used as rifle clips                                                           |
| 9   | "Assault Rifle West" | is a skinned mesh: `Object3D.clone` renders it at the origin                                                                                                                               | `SkeletonUtils.clone`                                                             |
| 10  | Rocketbox            | 13 draw groups per soldier (×2 with shadows)                                                                                                                                               | Merge materials in the asset build                                                |
| 11  | animouse 0.8.0       | `new FreeformBlendTree` throws "All points are collinear" for a character with forward-only clips (Quaternius, KayKit)                                                                     | The page falls back to runtime A with a notice                                    |

## 9. Missing clips (not faked; placeholders labelled in the page)

Prone idle and stand↔kneel↔prone transitions on the stomach; one-knee kneel; realistic rifle
reload; M249 everything (handling, belt/box reload, bipod); 8-way rifle locomotion at walk and run;
turn-in-place without root rotation; hit reactions with a rifle. See the asset gap analysis in
[character-asset-evaluation.md](character-asset-evaluation.md) §3.3 — the conclusion stands: Mixamo
or a purchased rifle set covers most of these; nothing open does.

## 10. Known limitations of the prototype

- The post-processing allocates freely and updates world matrices per IK step: about
  0.12–0.16 ms per soldier [measured, §6]; production code would be several times faster.
- One soldier model per benchmark run (Rocketbox), one GPU (integrated), Windows only.
- The mini-simulation adds acceleration, posture windows and carry state that Ambush!'s simulation
  does not have yet (proposal §4); without them, starts, stops and posture changes would snap.
