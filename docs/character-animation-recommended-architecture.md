# Character animation: recommended architecture

- Status: **recommendation for review**. Supersedes the runtime parts of
  [character-animation-architecture.md](character-animation-architecture.md) (its simulation
  additions, §4, still stand). Evidence: [framework evaluation](character-animation-framework-evaluation.md),
  [prototype results](character-animation-prototype-results.md), prototype in
  [`prototypes/character-animation/`](../prototypes/character-animation/).
- Date: 2026-10-14.

---

## 1. Decision in one paragraph

Use **three.js's own animation system as the runtime**: `AnimationMixer`/`AnimationAction` as a
clip sampler driven at **explicit times computed from simulation state**. This is not a custom
animation engine: three.js samples, blends, slerps and skins. Ambush! adds a thin layer of about
500 lines of **pose policy** (which clips, at what weight and time, for a given soldier state)
plus about 600 lines of **procedural rifle handling** (weapon placement, two-bone IK, aim). Adopt
**`@three.ez/instanced-mesh`** later, only for crowds beyond about 50 visible soldiers. Do not adopt
animouse, PlayCanvas's animation system or ozz-animation. Do not write a general state-machine or
blend-tree framework: Ambush!'s states are few, known and data-driven by the simulation, and every
library state machine tested runs on its own clock, which breaks replay.

## 2. Libraries

| Library                                                                                                    | Decision                                          | Why (measured unless marked)                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| three.js r186 `AnimationMixer`, `AnimationAction`, `AnimationClip`, `KeyframeTrack`, `SkeletonUtils.clone` | **Adopt** (already a dependency)                  | Exact replay in all 9 determinism passes; 46 µs per soldier per frame for sampling + blending at 100 soldiers; no new bytes                                                                                                                           |
| three.js `CCDIKSolver`                                                                                     | **Reject for limbs**                              | Needs the target to be a skeleton bone (skeleton rebinding per soldier); no pole control; left hand 1.5–16 cm off the handguard where analytic two-bone IK reaches it exactly [measured]. Kept as a comparison option in the prototype                |
| `@three.ez/instanced-mesh` 0.3.16 (MIT)                                                                    | **Adopt later** (M4), for the far and crowd bands | 100 soldiers in 27 draw calls instead of 2,601; frame time 10.8 → 4.4 ms; ~24 KB gzipped with its BVH dependency. WebGL only; per-instance bones still cost CPU unless poses are shared                                                               |
| animouse 0.8.0 (MIT)                                                                                       | **Reject**                                        | Peer range excludes three 0.186; `FreeformBlendTree` throws on 44 % of a standard 2D locomotion space; no seek, no layers, no phase sync (run/sprint feet slide 4–8× more); replay errors up to 70° / 186 mm. Its CPU cost is fine (+8 % over native) |
| PlayCanvas animation (engine 2.23.2, MIT)                                                                  | **Reject**                                        | Engine-bound (binds to PlayCanvas `GraphNode`s; a three.js binder would have to be written); 2.55 MB engine; transitions advance by accumulated `dt` [verified in source]                                                                             |
| ozz-animation 0.17 (MIT, C++)                                                                              | **Reject** (revisit only if sampling dominates)   | No JavaScript/WASM bindings exist; needs emsdk, an embind wrapper and an offline `gltf2ozz` step; sampling is at most a quarter of per-soldier CPU, so the ceiling of the gain is small [estimate from measurements]                                  |
| `@pixiv/three-vrm`                                                                                         | **Do not adopt**; borrow its humanoid bone names  | Its humanoid/look-at need a VRM model                                                                                                                                                                                                                 |
| THREE.IK, fullik, closed-chain-ik                                                                          | **Reject**                                        | Abandoned, not on npm, or robotics-oriented                                                                                                                                                                                                           |

## 3. What is custom, exactly

| Part                                                                                     |     Lines in the prototype |            Production estimate | Why no library does it                                                                                             |
| ---------------------------------------------------------------------------------------- | -------------------------: | -----------------------------: | ------------------------------------------------------------------------------------------------------------------ |
| Pose input: interpolate two recorded ticks at a fractional time                          |      113 (`pose-input.ts`) |                           ~150 | Ambush!-specific state                                                                                             |
| Gait clock: locomotion phase from recorded distance (memoised per tick)                  |             67 (`gait.ts`) |                            ~80 | Must be a function of the recording for replay                                                                     |
| Locomotion weights: 1D speed chain per direction, 4-way directional blend, posture sets  |      162 (`locomotion.ts`) |                           ~200 | Weights must come from simulation state, not a clocked tree                                                        |
| Native animator: weights and times per action, upper/lower layers, death and fire blends | 194 (`runtimes/native.ts`) |                           ~300 | (as above)                                                                                                         |
| Layer masks by track filtering                                                           |        61 (`clip-bank.ts`) |                            ~60 | three.js has no bone masks                                                                                         |
| Weapon hold, spine aim, head look, recoil, reload hand path                              |      ~300 (`character.ts`) |                           ~500 | Ambush!-specific weapons and carries                                                                               |
| Two-bone IK, clavicle reach, foot IK                                                     |                  160 + ~80 |                           ~250 | CCDIKSolver unsuited (§2)                                                                                          |
| Retargeting (rest-aligned) and clip measurement                                          |                   251 + 82 | ~350, **offline** (build step) | `SkeletonUtils.retargetClip` turned the Rocketbox spine 90° and both arms to one side on these rigs (results §3.1) |
| **Total runtime (excluding offline tools)**                                              |                            |                     **~1,500** |                                                                                                                    |

The previous proposal estimated 1,000–2,000 lines for a "custom framework"; the prototype shows
the real figure sits at the low end and, more importantly, that most of it is **Ambush!-specific
policy and weapon handling**, which no library provides, not engine machinery.

## 4. Boundaries

```
src/sim (unchanged by this work; later: posture/carry/aim state per the earlier proposal §4)
   │ SimState frames (recorded per tick) + events
   ▼
src/exercise   frames + fractional time (render interpolation, phase 0)
   ▼
src/view3d/characters/
   pose-input.ts      PoseInput = f(frames, t)            pure, node-testable
   gait.ts            phase = f(frames, t)                pure, memoised
   locomotion.ts      weights = f(PoseInput, clip metrics) pure
   animator.ts        mixer actions ← weights/times; mixer.update(0)
   hold.ts, ik.ts     weapon + hands + aim + feet          after the mixer
   renderer.ts        skinned meshes, LOD bands, instancing (later)
```

Rules:

1. **Nothing in `src/view3d/characters` reads a clock or accumulates frame time.** Every input is
   the recording and the simulation time. (The prototype's native runtime ignores `dt` entirely.)
2. **The animator never writes simulation state**; IK and poses never affect combat.
3. **Bind every mixer on the rest pose** and **restore the sampled pose before each update** (two
   three.js behaviours found by the determinism test, results §5).
4. **Masks are canonical bone sets**, never "a bone's subtree" (Biped parents the thighs to the
   spine).
5. Durations that matter (posture changes, raise/lower, reload) are **simulation data**; clips are
   time-warped to them.

## 5. Deterministic replay strategy

- Pose = f(recorded frames, t). Measured: identical bone transforms (0.0000°, 0.00 mm) at 15 times
  across continuous playback at 60 Hz, 144 Hz and irregular frame times, 0.25× and 16×, seeks
  forward, backward and shuffled, a fresh animator, and the 3D view hidden then shown.
- History that a pose needs is **reconstructed from the recording**: locomotion phase (distance
  integrated over ticks, memoised), posture-change start and end, carry-change start, last shot
  time, reload start, incapacitation time. All are fields of the recorded state (the proposal's §4
  additions) — no animation state is saved.
- Transitions are crossfades whose weight is a function of the simulation's change window
  (`postureT`, `carryT`), not of a mixer clock. Inertialization, if added, must be evaluated in
  closed form from the change's start time and the recorded source state.
- Cosmetic variety (idle offsets) comes from a hash of the soldier id.
- Gameplay never reads a pose: muzzle position, eye height and hit volumes stay simulation data.

## 6. Weapon animation architecture

- **Weapon profile** (data): sockets in a normalised weapon frame (grip origin, butt, support hand,
  muzzle, sight height), recoil kick and rise, hold offsets per carry. The prototype's M16 and M249
  placeholder differ only in this data.
- **Hold**: the weapon is placed from the body (shoulder pocket and aim direction for aimed and
  ready; a hip anchor for the patrol carry), carries are blended over the simulation's carry window,
  the torso is bladed and the spine pitched with the aim, then **the hands are IK'd to the weapon's
  sockets** (clavicle reach first). Measured: both hands within 0 cm of their sockets standing and
  kneeling; 4–6 cm prone.
- **Clips supply the body, not the hands.** With the available CC0 clips, a procedural hold over the
  idle upper body looks better than the retargeted rifle clips (results §4). With a proper rifle
  clip set (purchased or captured), the same IK corrects the hands of whatever the clip does.
- **M249**: same system, own profile (heavier recoil, support hand on the receiver/handguard, bipod
  node); its reload and bipod deployment need clips that do not exist under open licences.
- **First person** (later): the same weapon frame and sockets drive a first-person arms rig; the
  camera attaches to the head bone's aim frame; the full body still renders for shadows. Nothing in
  this architecture blocks it; the weapon-anchored hold is what first-person rigs use.

## 7. Terrain adaptation

- Foot IK on the authoritative height function: pelvis lowered by the lower foot's offset, two-bone
  IK per leg, foot tilted to the finite-difference normal. Works in the prototype on a 15° ramp and
  bumps; on bridges, the same height query as `surfaceHeightAt`.
- Prone and crawl stay on the clip's pose (no IK) in the first version.

## 8. LOD and performance strategy (measured on an integrated Radeon 880M, results §6)

| Band | Distance | Animation                                                                              | Rendering                                          |
| ---- | -------- | -------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Near | < 30 m   | full: native animator + hold + IK every frame                                          | skinned mesh, shadows                              |
| Mid  | 30–80 m  | native animator every 2nd–4th frame (free: the pose is a function of time), no foot IK | skinned mesh, no shadow casting                    |
| Far  | > 80 m   | 8–16 shared pose slots per character type                                              | InstancedMesh2 (one draw call per type) or markers |

- Merge the Rocketbox model's 13 draw groups into 1–2 materials (13 → 2 draw calls per soldier
  plus shadows).
- Build characters progressively (first-frame cost per soldier, results §6).
- Ambush!'s scenarios have 16 soldiers today; the near band alone covers them.

## 9. What this does not decide

Asset licensing and budget (rifle clip set, prone set, M249, first-person arms) remain the
decisions in the [revised roadmap](character-animation-revised-roadmap.md) gate.
