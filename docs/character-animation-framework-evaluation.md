# Character animation: framework evaluation

- Status: **evaluation complete; recommendation for review**. Date: 2026-10-14.
- Question: should Ambush! adopt an existing animation library instead of the custom layer the
  [earlier research](character-animation-research.md) proposed?
- Method: candidate research (GitHub and npm data read on 2026-10-14; source code read), then a
  working browser prototype ([`prototypes/character-animation/`](../prototypes/character-animation/))
  with identical characters, clips, weapon, lighting, camera and simulated movement for each
  runtime, measured for determinism, foot sliding, hand placement and performance. Details and
  numbers: [prototype results](character-animation-prototype-results.md). Architecture:
  [recommended architecture](character-animation-recommended-architecture.md). Plan:
  [revised roadmap](character-animation-revised-roadmap.md).
- Labels: **[measured]** in the prototype, **[verified]** in source or registry data,
  **[estimate]** or **[opinion]**. Licence readings are not legal advice.

---

## 1. Answer

**Adopt three.js's built-in animation system as the runtime, used as a sampler at explicit times,
with a thin Ambush!-specific pose layer — and do not adopt a third-party animation framework.**
This is the "reuse first" answer: three.js does the sampling, blending, slerping and skinning;
nothing on the market does the part Ambush! needs (poses that are a pure function of recorded
simulation state), and the libraries that offer state machines fail replay. Add
`@three.ez/instanced-mesh` later for crowds.

The previous recommendation's direction holds, but its scope shrinks: no "framework" (no generic
state machine or blend-tree classes); about 500 lines of pose policy and about 600 lines of rifle
handling and IK [measured in the prototype], plus offline retargeting.

## 2. Ambush! constraints that decide the selection

From the repository (see the earlier research §2 for file references):

1. **Exact replay.** The after-action review records a state frame per tick and scrubs freely
   (forward, backward, 0.25–4×), live play runs 1–16×. A pose must be reproducible from recorded
   state and time — any runtime that integrates frame time fails this (measured: §4).
2. **Layering rules.** `src/sim` and `src/exercise` may not import three.js or read clocks
   (ADR 0001, lint-enforced). Animation lives in `src/view3d`; it may read, never write, simulation
   state.
3. **Rendering stack.** three.js r186 `WebGLRenderer` (WebGL 2), Vite, TypeScript strict; budgets of
   ≤ 300 draw calls and ≤ 600 MB GPU memory (ADRs 0030/0031). No engine migration.
4. **Public repository and GitHub Pages deployment.** Code and assets must be redistributable.
5. **Today's scenarios have 16 soldiers;** the target is smooth close-up soldiers first, crowds
   later.

## 3. Candidates

### 3.1 Maintenance and licensing [verified 2026-10-14]

| Candidate                           | Licence                | Latest                     | Activity                                                      | three peer                        | Types | Size (min / gzip)                               | Status                                               |
| ----------------------------------- | ---------------------- | -------------------------- | ------------------------------------------------------------- | --------------------------------- | ----- | ----------------------------------------------- | ---------------------------------------------------- |
| three.js r186 animation (core)      | MIT                    | 0.186.1 (2026-09-24)       | monthly releases                                              | —                                 | yes   | 0 added                                         | Mature, actively maintained                          |
| animouse                            | MIT                    | 0.8.0 (npm, 2026-01-16)    | last commit 2026-01-31, none since; 1 star; 15 downloads/week | `>=0.157 <0.180` (excludes 0.186) | yes   | 22.5 KB / 7.0 KB (+ eventail 1 KB)              | Experimental, one developer, dormant                 |
| ozz-animation                       | MIT                    | 0.17.0 (2026-08-01)        | active; 2,966 stars                                           | n/a (C++17)                       | n/a   | WASM samples 0.4–3.1 MB (with sample framework) | Mature-stable; **no JavaScript/WASM bindings exist** |
| PlayCanvas engine animation         | MIT                    | 2.23.2 (2026-10-09)        | very active; 17k stars                                        | none                              | yes   | engine 2.55 MB min                              | Actively maintained; engine-bound                    |
| `@three.ez/instanced-mesh`          | MIT                    | 0.3.16 (npm 2026-07-26)    | last commit 2026-10-06; 452 stars; 7.6k downloads/week        | `>=0.159` (master: `>=0.186`)     | yes   | 74 KB / 19 KB (+ bvh.js 5.5 KB)                 | Actively maintained                                  |
| `@pixiv/three-vrm`                  | MIT                    | 3.5.5                      | active                                                        | `>=0.137`                         | yes   | —                                               | Active; needs VRM models                             |
| THREE.IK / fullik / closed-chain-ik | MIT / MIT / Apache-2.0 | 2018 / none / 0.0.3 on npm | abandoned / dormant / active repo, stale npm                  |                                   |       |                                                 | Not suitable                                         |

No other credible three.js animation controller, blend-tree or state-machine library was found for
2024–2026 (npm and GitHub searches); `@aura3d/animation` is tied to its own engine.

### 3.2 Capabilities [verified in source; measured where marked]

| Capability                       | three.js native                                             | animouse 0.8.0                                                                                                        | PlayCanvas anim                                                           | ozz-animation                                    |
| -------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------ |
| Clip sampling, weighted blending | yes                                                         | via three.js                                                                                                          | yes                                                                       | yes (SoA, SIMD)                                  |
| Explicit time / seek             | **yes** (`action.time`, `mixer.update(0)`) [measured exact] | **no** — `update(dt)` only; weights going 0→>0 reset `action.time = 0`                                                | active state only (`activeStateCurrentTime`); transitions advance by `dt` | yes (sampling job takes a ratio)                 |
| State machine, transitions       | no (we compute weights)                                     | event, automatic and data transitions; linear fades on its clock                                                      | yes, with exit times, interruption                                        | no                                               |
| 1D blend tree                    | weights are trivial (we compute them)                       | `LinearBlendTree`                                                                                                     | yes                                                                       | no (blend job: you compute weights)              |
| 2D blend tree                    | (we compute 4-way weights)                                  | `PolarBlendTree` (needs equal ring counts), `FreeformBlendTree` (**throws on 44 % of a locomotion space** [measured]) | 2D directional/Cartesian                                                  | no                                               |
| Phase sync of blended clips      | (we compute times from distance)                            | **no**                                                                                                                | sync via normalised time per state                                        | no (you pass ratios)                             |
| Layers, bone masks               | track-filtered clips (no masks)                             | **no** (needs a second machine on a stub mixer [measured workaround])                                                 | layers + masks                                                            | masks, layers                                    |
| Additive                         | `makeClipAdditive`                                          | no                                                                                                                    | yes                                                                       | yes                                              |
| IK                               | `CCDIKSolver` (target must be a bone)                       | no                                                                                                                    | no                                                                        | two-bone, aim                                    |
| Skinning                         | yes (GPU)                                                   | via three.js                                                                                                          | yes                                                                       | job outputs matrices; you skin                   |
| Works with three.js r186         | native                                                      | peer conflict, works with `legacy-peer-deps` [measured]                                                               | needs a custom `AnimBinder` onto `Object3D`s                              | needs bindings + matrix copy into three.js bones |

### 3.3 Integration results

- **three.js native — built and measured.** 194 + 162 + 67 + 61 lines (animator, locomotion
  weights, gait clock, masks). Exact replay; best foot planting; 46 µs per soldier per frame at 100
  soldiers for sampling and blending [measured].
- **animouse — built and measured.** Usable for a demo, but: install conflict with three 0.186;
  `FreeformBlendTree` throws for ordinary blend points (characterised in a test); no layers (second
  machine on a stub mixer); no phase sync (run/sprint feet slide 4–8× more); no seek (rebuild and
  replay 2 s after a jump, still 70° off). Its CPU cost is close to the native runtime's (4.93 vs
  4.58 ms of animation CPU at 100 soldiers, +8 % [measured]) — performance is not its problem. It
  needed **more** integration code than the native runtime (299 vs 194 lines).
- **PlayCanvas — not built.** Its animation runs on PlayCanvas `GraphNode`s through
  `DefaultAnimBinder`; driving three.js bones needs a custom binder and a PlayCanvas app or evaluator
  per soldier, i.e. a bridge comparable in size to the native solution, plus a 2.55 MB engine. Its
  controller's `update(dt)` accumulates `_currTransitionTime += dt` [verified in
  `anim-controller.js`], so mid-transition poses are not reconstructible by seeking — the same
  replay failure as animouse. Its data model (layers, masks, 1D/2D trees) is a good reference.
- **ozz-animation — not built (blocked).** No JavaScript/WASM binding exists (npm and GitHub
  searches); its emscripten CI builds only samples. Using it means emsdk in the toolchain, an
  embind wrapper over sampling/blending/local-to-model jobs, offline `gltf2ozz` conversion of every
  clip, and copying model-space matrices into three.js bones each frame [estimate: 1–2 weeks plus
  ongoing C++ maintenance]. The gain is capped: the prototype's per-soldier cost splits into
  sampling/blending and matrix/upload/draw work, and only the first would get faster; pose sharing
  and LOD already remove 90 % of animation CPU at 100+ soldiers [measured, results §6].
- **InstancedMesh2 — built as a renderer, measured.** Skinned instancing works with r186
  `WebGLRenderer` once the geometry is pre-transformed by the bind matrix (it skins without one).
  100 Rocketbox soldiers in 27 draw calls instead of 2,601 (render CPU 0.44 ms instead of 5.97 ms,
  frame 4.4 ms instead of 10.8 ms) [measured]. Per-instance bones still cost
  CPU unless poses are shared; skinning with its LOD feature is incomplete in 0.3.16 (`initSkeleton`
  returns early for LOD children [verified]); WebGL only.

## 4. Deterministic replay [measured]

Bone transforms at 15 times of a 47 s test sequence, reached by continuous playback at 60 Hz
(reference), 144 Hz, irregular frame times, 0.25×, 16×, seeks (ascending, descending, shuffled), a
fresh animator, and 3D hidden then resumed. Exact = ≤ 0.01° and ≤ 0.1 mm.

|                         | three.js native (explicit time) | animouse                             |
| ----------------------- | ------------------------------- | ------------------------------------ |
| Frame-rate independence | exact                           | 3.4–5.0° / 9–12 mm                   |
| 16× fast forward        | exact                           | 48.3° / 109 mm                       |
| Seek in any order       | exact                           | 70.1° / 186 mm (after replaying 2 s) |
| Same frame times again  | exact                           | exact                                |
| 3D hidden, then resumed | exact                           | 4.7° / 13 mm                         |

**Critical failure: animouse cannot provide AAR-consistent poses.** No amount of weighted score
offsets this.

## 5. Performance [measured]

Chrome 155, integrated Radeon 880M, 1600×900 window, vsync off; Rocketbox soldier (15,387
triangles, 80 bones, 13 draw groups), shadows on; full tables in the
[results §6](character-animation-prototype-results.md#6-performance-measured).

| Scene, mode (uncapped mean frame time)              | 25 soldiers |           100 soldiers | 250 soldiers |
| --------------------------------------------------- | ----------: | ---------------------: | -----------: |
| Minimal: three.js native, mixer per soldier         |      2.3 ms |                10.8 ms |      32.1 ms |
| Minimal: animouse                                   |      2.1 ms |                11.1 ms |      32.1 ms |
| Minimal: native + 8 shared poses                    |      1.5 ms |                 4.2 ms |       9.2 ms |
| Minimal: InstancedMesh2                             |      1.9 ms | 4.4 ms (27 draw calls) |       9.9 ms |
| Representative (2,400 trees): native + rifle + IK   |      6.8 ms |                31.7 ms |      78.1 ms |
| Representative: native + animation LOD + rifle + IK |      6.8 ms |                23.6 ms |      55.7 ms |
| Representative: native + 8 shared poses             |      2.1 ms |                 4.7 ms |       9.9 ms |
| Representative: InstancedMesh2                      |      2.6 ms |                 5.6 ms |      10.8 ms |

With vsync on in the representative scene, **50 fully animated riflemen with IK hold 60 fps** on
the integrated GPU; 100 do not (30.6 ms). With shared poses or InstancedMesh2, **250 hold 60 fps**.
Per soldier: sampling and blending 46 µs (native) and 49 µs (animouse) — equal in practice; the
prototype's hold and IK 85 µs (unoptimised); render submission 60 µs (141 µs with the rifle)
because the Rocketbox model has 13 draw groups. The animation runtime is not the bottleneck; draw
calls and per-soldier post-processing are.

## 6. Developer complexity

|                                                 | three.js native                                       | animouse                                              | PlayCanvas anim               | ozz                                         |
| ----------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------- | ----------------------------- | ------------------------------------------- |
| New dependencies                                | none                                                  | animouse + eventail, peer override                    | playcanvas (2.55 MB)          | emsdk toolchain, C++ wrapper, WASM artefact |
| Custom lines to reach the prototype's behaviour | ~480 (measured)                                       | ~300 + workarounds, and still no replay (measured)    | ~500 bridge [estimate]        | ~800 + C++ [estimate]                       |
| Adding a state (e.g. "rush")                    | a clip slot + a speed in the chain                    | a tree point or a state + transitions in two machines | graph asset edit + parameters | weights in our code                         |
| Adding a soldier model                          | rig bone map (22 names) + offline retarget            | same                                                  | same + binder paths           | same + gltf2ozz                             |
| Adding a weapon class                           | a weapon profile (sockets, recoil)                    | same                                                  | same                          | same                                        |
| Layered animation                               | track-filtered clips (canonical masks)                | not supported                                         | built in                      | built in                                    |
| Deterministic replay                            | inherent                                              | not achievable                                        | not for transitions           | inherent for sampling, our code for weights |
| Testing                                         | pose = f(state, t): node-testable and replay-testable | browser timing-dependent                              | engine in tests               | WASM in tests                               |

## 7. Comparison matrix

Scores 1–10. **M** = measured in the prototype, **E** = estimate (not prototyped), **S** =
subjective judgement. InstancedMesh2 is a rendering optimisation, not a controller, and is scored
separately.

| Criterion (weight)                          | three.js native |                             animouse |              PlayCanvas anim |             ozz-animation |
| ------------------------------------------- | --------------: | -----------------------------------: | ---------------------------: | ------------------------: |
| Animation quality and blending (20 %)       |        7 (M, S) |                                4 (M) |                        7 (E) |                     8 (E) |
| Ease of integration with three.js (15 %)    |          10 (M) |                                4 (M) |                        2 (E) |                     2 (E) |
| Layered animation and weapon support (15 %) |           7 (M) |                                2 (M) |                        9 (E) |                     8 (E) |
| Deterministic replay compatibility (15 %)   |          10 (M) |                                1 (M) |          3 (verified source) |                     8 (E) |
| Performance and scalability (10 %)          |           7 (M) |                                6 (M) |                        5 (E) |                     7 (E) |
| Maintainability and maturity (10 %)         |           9 (S) |                         2 (verified) |                 9 (verified) |              7 (verified) |
| Developer complexity (10 %)                 |           7 (M) |                                4 (M) |                        3 (E) |                     2 (E) |
| Licensing and deployment (5 %)              |              10 |                    9 (peer override) |                  7 (2.55 MB) |             6 (toolchain) |
| **Weighted score**                          |         **8.3** |                              **3.5** |                      **5.6** |                   **6.2** |
| Critical failure                            |            none | **determinism; crashes in 2D blend** | **transitions not seekable** | **no bindings (blocked)** |

InstancedMesh2 (as an add-on to the native runtime): performance 9 (M: 2,601 → 27 draw calls and
10.8 → 4.4 ms per frame at 100 soldiers), integration 7 (M: bind-matrix workaround; WebGL only; skinned LOD incomplete),
maintainability 7, licence 10. **Adopt for crowd bands.**

## 8. Assets: what produces the best result

[measured/observed in the prototype; see results §2–§4 and the asset table in
`prototypes/character-animation/ASSETS.md`]

- **Best soldier: Microsoft Rocketbox `Military_Male_01` (MIT)** with UAL/Mesh2Motion (CC0)
  locomotion, crouch and crawl retargeted offline. Realistic, redistributable, convincing at
  tactical and mid range [observed].
- **Rifle handling: procedural hold + IK over the idle upper body** beats the only open rifle clips
  (KayKit, chibi proportions) on realistic bodies.
- **Gaps that only purchased or captured clips close:** prone set on the stomach, one-knee kneel,
  rifle reload, M249 anything, 8-way rifle locomotion. Mixamo covers most of these but cannot live
  in the public repository (see the asset evaluation).

## 9. Final recommendation

1. **Which library?** three.js's own `AnimationMixer`/`AnimationAction` (explicit-time sampling),
   plus `@three.ez/instanced-mesh` for crowds later. Reject animouse, PlayCanvas animation and
   ozz-animation.
2. **How much custom code?** About 1,500 lines in production [estimate from the prototype's ~1,100
   runtime lines]: pose input and gait phase (~250), locomotion and layer weights (~500), weapon
   hold, aim and IK (~750); plus an offline retarget and clip-measurement build step (~350). No
   general-purpose engine.
3. **Convincing modern military animation without our own engine?** Yes — the prototype shows a
   realistic soldier walking, running, sprinting, strafing, aiming, firing, kneeling, crawling and
   falling, with both hands on the rifle, exact replay, on three.js alone. What limits quality now
   is **clips**, not code.
4. **Best assets?** Rocketbox (MIT) + UAL/Mesh2Motion (CC0) + procedural rifle hold; a purchased or
   captured rifle and prone clip set for release quality.
5. **Biggest remaining risk:** content — a web-redistributable rifle/prone/M249 clip set at
   realistic proportions (licence and budget), and retarget quality from whatever set is chosen.
6. **Next:** the vertical slice in the [revised roadmap](character-animation-revised-roadmap.md):
   render interpolation, then one squad of Rocketbox riflemen in the real 3D view driven by the
   real simulation, with the asset pipeline and the clip-licence decision in parallel.
