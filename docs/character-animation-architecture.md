# Character animation architecture: proposal

- Status: **proposal for review** (nothing implemented). Companion documents:
  [research](character-animation-research.md),
  [asset evaluation](character-asset-evaluation.md),
  [roadmap](character-animation-roadmap.md).
- Date: 2026-10-13. Repository state: `main` at `634fa72`.
- Scope: animated 3D soldiers for AI-controlled units now, a first-person player-controlled soldier
  later, sharing one character system, with the simulation authoritative and replays exact.

---

## 1. Where it integrates in the existing code

| Concern           | Existing code                                                                                                  | Role in the design                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Layers            | ADR 0001; `tools/boundaries.test.ts`                                                                           | Simulation features in `src/sim`; character rendering and animation in `src/view3d/characters/`; input in `src/app`.  |
| Tick and time     | `src/sim/simulation.ts` (`timeSeconds = tick / rate`), `src/exercise/runner.ts` (fixed step, unused `alpha`)   | The pose is sampled at `(tick + alpha) / rate`. `Exercise` must expose `alpha` and the previous tick's soldier state. |
| Soldier state     | `src/sim/state.ts:97` `Soldier`; `:29` `Posture`; `:36` `SoldierStatus`; `:185` `Combatant`                    | Extended with optional fields (§4), absent by default so existing state hashes are unchanged.                         |
| Commands          | `src/sim/commands.ts` (`SetOrders`, `SetEngagementArea`, `BeginEngagement`)                                    | New commands for posture, speed class, aim and player intent (§4.2).                                                  |
| Movement          | `src/sim/movement.ts:103-202`, `world.ts` `MovementParams`                                                     | Becomes a character motor with speed classes, acceleration and posture-dependent speeds (§4.3).                       |
| Combat and events | `src/sim/combat.ts` (`fire`, `react`, `selectTarget`), `src/sim/events.ts` (`ShotFiredEvent` with `atSeconds`) | Fire, recoil, hit and casualty animation are driven by events; aim from a new aim state.                              |
| Line of sight     | `src/sim/los.ts:18-20` fixed 1.7 m / 1.5 m; `LosOptions` accepts heights                                       | Posture-dependent eye and target heights (a combat-model change, §4.4).                                               |
| Weapons           | `src/exercise/weapon-display.ts`, `src/exercise/combat/combat-v1.json`                                         | Weapon profiles gain handling data (§6).                                                                              |
| Review            | `src/exercise/replay.ts` (`createStateRecorder`, `frameAt`), `Exercise.replayAt`                               | Records new state automatically; `frameAt` gains a fractional variant for interpolation.                              |
| 3D soldiers       | `src/view3d/markers.ts`, `unit-markers.ts`; created at `view.ts:291`, updated at `view.ts:727`                 | Replaced by the character layer; markers remain the far level of detail and the selection ring.                       |
| Camera            | `src/view3d/tactical-camera.ts:20-29` `CameraMode`                                                             | Follow, eye-level and first-person modes (§8).                                                                        |
| Quality           | `src/view3d/quality.ts` `QualityPreset`                                                                        | Gains a `characters` block (§10).                                                                                     |
| Browser hooks     | `ambushDebug`, `ambushState`                                                                                   | Character counts, timings and pose checks for automated tests.                                                        |

---

## 2. Principles

1. **The simulation decides; the character shows.** Position, facing, posture, speed, aim
   direction, weapon state, shots and casualties are simulation state or events. The character layer
   reads them and never writes back. Nothing a pose computes (bone positions, muzzle position,
   animation timing) changes a combat result.
2. **Pose = f(recorded state, simulation time).** Every animation input is either in the recorded
   state, derived from it, or an event time. There is no animation state that must be saved: the
   review can rebuild any pose at any time, forwards or backwards.
3. **One character system for AI and player.** Both issue the same simulation commands (intents);
   the same motor moves both; the same animator draws both. First person is a camera and a rendering
   mode, not a separate character.
4. **Durations that matter are data in the simulation.** "Prone takes 1.2 s", "a reload takes 2.6 s",
   "the weapon is raised after 0.3 s" are simulation parameters per weapon and posture; clips are
   time-warped to match them, never the reverse.
5. **Scale is designed in.** Levels of detail for animation, skeleton, mesh and shadows from the
   first version; shared resources; a budget per quality preset.

---

## 3. Data flow

```
           AI (sim systems)            Player input (app, sampled per frame)
                 │                                   │ quantised to ticks
                 ▼                                   ▼
        ┌──────────────────── Commands (stamped with a tick) ────────────────────┐
        │  SetOrders · SetPosture · SetSpeedClass · AimAt · Fire · Reload · Move   │
        └───────────────────────────────────┬─────────────────────────────────────┘
                                            ▼
  src/sim   ┌─────────────── stepState (fixed 30 Hz) ───────────────┐
            │ applyCommands → characterMotor (speed, accel, posture) │
            │ → movement/navigation → engagement → combat (aim, fire,│
            │   reload, casualties) → events (atSeconds)             │
            └───────────────┬───────────────────────────────────────┘
                            │ SimState (plain data, recorded per tick) + events
                            ▼
  src/exercise   Exercise: live or replayAt(frame); exposes previous + current
                 state, alpha (live) or fractional time (review)
                            │ read-only
                            ▼
  src/view3d/characters
     CharacterPoseInput (adapter, pure, testable in node)
        → per soldier: interpolated root, locomotion vector, posture + transition,
          aim, weapon state, recent events, cosmetic seed
     CharacterAnimator (per soldier, pure function of the input + time)
        → layer graph (locomotion · posture · upper body · additive · IK)
        → bone pose
     CharacterRenderer (skinned meshes, LOD, weapons, muzzle flashes, tracers)
                            │
                            ▼
                     WebGL renderer, camera modes (tactical, follow, first person)
```

Five separate things, five owners:

| Concept            | Owner                                         | Example                                                                                       |
| ------------------ | --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| AI intention       | sim systems (AI) / player input               | "move to X at a rush, prone on arrival, aim at EN-2"                                          |
| Simulation state   | `src/sim`                                     | posture `prone` since 12.40 s; speed class `rush`; aim azimuth 1.31 rad; ammunition 27        |
| Character movement | `src/sim` character motor                     | speed ramps 0 → 3.5 m/s over 0.6 s; posture change blocks movement for 1.2 s                  |
| Animation state    | `src/view3d` animator (derived, never stored) | lower body `run_fwd` blended 70/30 with `run_left`; upper body `aim`; recoil spring at 0.08 s |
| Rendered pose      | `src/view3d` renderer                         | bone matrices, IK-corrected feet and hands                                                    |

---

## 4. Simulation additions

All new fields are **optional and absent by default** (the `engagement?` pattern), so states without
them encode and hash exactly as today; determinism tests gain cases for the new features.

### 4.1 State

```ts
// src/sim/state.ts (proposed additions)

/** How a soldier moves when moving. */
export type SpeedClass = 'crawl' | 'slow' | 'walk' | 'rush' | 'sprint';

export interface Soldier {
  // … existing fields: id, side, unitId, position, azimuth, posture, status, orders
  /** Posture change in progress: the soldier is between `from` and `posture` until `untilSeconds`. */
  postureChange?: {
    readonly from: Posture;
    readonly startedSeconds: number;
    readonly untilSeconds: number;
  };
  /** Current ground velocity (m/s, map axes); absent when still. Drives locomotion blending. */
  velocity?: Vec2;
  /** Requested speed class (from orders or player intent). */
  speedClass?: SpeedClass;
  /** Distance travelled (m), for a gait phase that is continuous across speeds and seeks. */
  odometerM?: number;
  /** Where the weapon points: azimuth and pitch (radians); absent = along `azimuth`, level. */
  aim?: { readonly azimuth: number; readonly pitch: number; readonly targetId?: SoldierId };
  /** The weapon in hand and its state. */
  weapon?: WeaponState;
}

export interface WeaponState {
  readonly profileRef: WeaponProfileRef; // 'm16-rifle' | 'squad-automatic-weapon' | …
  readonly carry: 'lowered' | 'ready' | 'aimed'; // drives raise/lower and aim layers
  /** Rounds in the weapon and spare magazines/belts (when ammunition is modelled). */
  readonly rounds?: number;
  readonly spare?: number;
  /** A timed action in progress (reload, raise, lower, switch), with its window. */
  readonly action?: {
    readonly kind: 'reload' | 'raise' | 'lower' | 'switch';
    readonly startedSeconds: number;
    readonly untilSeconds: number;
  };
}

/** Casualty detail (extends 'active' | 'incapacitated' if and when the combat model needs it). */
export type SoldierStatus = 'active' | 'incapacitated'; // + 'wounded' | 'killed' later
```

`odometerM` is advanced by the movement system from the exact path length it already computes
(`PathSegment[]`), so it costs one addition per moving soldier per tick.

### 4.2 Commands and events

```ts
// src/sim/commands.ts (proposed)
export interface SetPostureCommand {
  kind: 'setPosture';
  tick: number;
  soldierId: SoldierId;
  posture: Posture;
}
export interface SetSpeedClassCommand {
  kind: 'setSpeedClass';
  tick: number;
  soldierId: SoldierId;
  speedClass: SpeedClass;
}
export interface AimCommand {
  kind: 'aim';
  tick: number;
  soldierId: SoldierId;
  aim: { azimuth: number; pitch: number } | { targetId: SoldierId } | null;
}
export interface FireCommand {
  kind: 'fire';
  tick: number;
  soldierId: SoldierId;
  trigger: 'press' | 'release';
}
export interface ReloadCommand {
  kind: 'reload';
  tick: number;
  soldierId: SoldierId;
}
/** Player locomotion: a desired direction (map axes, unit or zero) and facing, held until changed. */
export interface MoveIntentCommand {
  kind: 'moveIntent';
  tick: number;
  soldierId: SoldierId;
  direction: Vec2;
  facing: number;
  speedClass: SpeedClass;
}

// src/sim/events.ts (proposed)
// postureChanged { atSeconds, soldierId, from, to, untilSeconds }
// weaponActionStarted { atSeconds, soldierId, kind, untilSeconds }
// existing: shotFired { atSeconds, shooterId, targetId, … } (+ rounds, muzzle info later)
// existing: soldierIncapacitated { atSeconds, soldierId, … } (+ hit direction for death choice)
```

Player input enters the simulation **only** through these commands, stamped with the tick at which
they apply. The command stream is the determinism record: replaying it reproduces the game
(`src/sim/determinism.test.ts` pattern).

### 4.3 Character motor (simulation)

The existing movement system becomes a motor with:

- **speed per speed class and posture** (`MovementParams` gains a table, e.g. standing walk 1.5 m/s,
  rush 3.5, sprint 5.5; kneeling/crouched 1.0; crawl 0.4 — values are design data);
- **acceleration and deceleration** limits, so starts and stops have length (needed for convincing
  starts/stops and for distance matching);
- **posture changes** that take time and block movement (`postureChange`), with durations per
  from→to pair as data;
- **turning**: the current facing rate limit stays; while aiming, travel direction and facing are
  independent (strafing and backing up become real behaviours rather than artefacts).

### 4.4 Combat-model changes that animation makes visible

These change outcomes and need their own design approval; the character system works without them,
but would then show things the simulation ignores.

- **Posture-dependent line-of-sight heights** (standing 1.7/1.5 m, kneeling ~1.1/0.9, prone
  ~0.35/0.3), passed through the existing `LosOptions`.
- **Aim and firing arc**: a shooter must face (within limits) before firing; time to aim and to switch
  targets.
- **Ammunition and reloads** per weapon (magazines for the M16 and AK, belt or magazine for the M249),
  durations as data.
- **Bursts**: rounds per firing opportunity for the M249, so the animation and tracers match.

---

## 5. Character layer modules (`src/view3d/characters/`)

| Module                                                           | Responsibility                                                                                                                                                                                                       |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `character-assets.ts` (CharacterAssetManager)                    | Lazy-load GLBs (characters, weapons, clips) once per page; keep one skeleton template and one clip library; KTX2/meshopt decoding; disposal.                                                                         |
| `pose-input.ts` (CharacterPoseInput)                             | **Pure adapter** from `Exercise` (live or replay frame) to per-soldier `CharacterFrame` (below): interpolation, derived locomotion vector, posture blend, recent events. Unit-tested in node like `unit-markers.ts`. |
| `animator.ts` (CharacterAnimator)                                | Evaluates the layer graph for one soldier at one time: locomotion blend space, posture transitions, upper-body weapon layer, additive layers, then IK. Pure function of `CharacterFrame` and clip data.              |
| `blend-space.ts`, `graph.ts`                                     | 1D/2D blend spaces (weights from speed and direction), layer and mask definitions, transitions with closed-form inertialization.                                                                                     |
| `ik.ts` (FootIK, HandIK, AimIK)                                  | Analytic two-bone IK, spine/head aim distribution, foot-to-ground with pelvis offset.                                                                                                                                |
| `weapons.ts` (WeaponAttachmentSystem, WeaponAnimationController) | Weapon models, sockets, grip poses, recoil springs, muzzle flash and tracer origins.                                                                                                                                 |
| `character-renderer.ts` (CharacterRenderer)                      | Skinned meshes per LOD, shared materials, instancing for distant soldiers, shadows per LOD, selection and status rings; replaces `markers.ts` as the soldiers' renderer.                                             |
| `lod.ts` (CharacterLODManager)                                   | Chooses mesh, skeleton and update rate per soldier per frame from distance, screen size and budget.                                                                                                                  |
| `first-person.ts` (FirstPersonView)                              | First-person arms/weapon rendering, camera bob/sway/recoil, aim-down-sights; reads the same `CharacterFrame`.                                                                                                        |

App side (`src/app`): `player-input.ts` (pointer lock, keys, mouse → `MoveIntent`, `Aim`, `Fire`,
`SetPosture`, `Reload` commands each tick). Simulation side: the motor and new commands (§4).

### 5.1 The pose input

```ts
/** Everything the animator needs for one soldier at one render time. Plain data. */
export interface CharacterFrame {
  readonly id: SoldierId;
  readonly seed: number; // hash of the id: cosmetic variation
  readonly timeSeconds: number; // simulation time being drawn ((tick + alpha) / rate)
  readonly root: { x: number; y: number; z: number; azimuth: number }; // interpolated between ticks
  readonly velocity: { x: number; y: number }; // map axes, m/s (interpolated)
  readonly odometerM: number; // gait phase source
  readonly posture: Posture;
  readonly postureChange: { from: Posture; startedSeconds: number; untilSeconds: number } | null;
  readonly aim: { azimuth: number; pitch: number } | null;
  readonly weapon: {
    profileRef: WeaponProfileRef;
    carry: 'lowered' | 'ready' | 'aimed';
    action: {
      kind: 'reload' | 'raise' | 'lower' | 'switch';
      startedSeconds: number;
      untilSeconds: number;
    } | null;
  } | null;
  readonly shots: readonly { atSeconds: number; targetId: SoldierId | null }[]; // last ~1 s
  readonly casualty: { atSeconds: number; fromAzimuth: number | null } | null;
  readonly status: SoldierStatus;
  readonly selected: boolean;
}
```

Every field comes from `SimState` frames and the combat log; at α = 0 (or a whole review frame) the
root equals the simulation position exactly (testable to the centimetre, as markers are today).

### 5.2 The animator

```ts
export interface CharacterAnimator {
  /** Pose for one soldier at `frame.timeSeconds`. Writes bone local transforms; no hidden state. */
  evaluate(frame: CharacterFrame, rig: RigInstance, lod: AnimationLod): void;
}

export interface AnimationLod {
  readonly layers: 'full' | 'noIk' | 'baseOnly'; // drop IK and additive layers with distance
  readonly bones: 'full' | 'reduced'; // fingers and twist bones off when far
}
```

Layers, evaluated in order:

1. **Locomotion (lower body and base)**: 2D blend space over local velocity (forward/strafe) per
   posture (standing, crouched, prone crawl); gait phase = `odometerM / strideLength(clip)` modulo 1,
   so it is continuous, speed-matched and seekable; starts and stops from the motor's acceleration.
2. **Posture transitions**: when `postureChange` is active, the transition clip sampled at
   `(t − startedSeconds) / (untilSeconds − startedSeconds)` (time-warped to the simulation duration),
   blended in and out over fixed windows.
3. **Upper body (weapon layer, masked to spine and arms)**: carry pose per weapon and posture
   (lowered, ready, aimed); weapon actions (reload, raise, lower, switch) sampled over their
   simulation windows.
4. **Additive**: aim offset (yaw/pitch relative to the body), breathing (cosmetic clock), recoil
   springs (closed-form from `shots[].atSeconds`), hit flinch.
5. **IK and corrections**: spine/head aim distribution to `aim`; right hand corrects the barrel onto
   the aim line; left hand to the weapon's support socket; feet to the ground, pelvis offset; foot
   lock while planted.
6. **Casualty**: from `casualty.atSeconds`, a death or collapse clip chosen deterministically from
   posture, hit direction and seed; after it ends, the final pose (lying) is held.

Transitions use **closed-form inertialization**: the offset at the transition start is computed from
the outgoing state's pose _at the transition time_ (both states are recoverable from recorded frames),
then decayed by a fixed curve of `t − transitionStart`. A seek evaluates the same expression, so the
review is exact.

---

## 6. Weapon-aware animation

### 6.1 Approaches compared

| Approach                                                       | Quality                                                                    | Scalability                                     | Assets                                     | Runtime                  | Complexity                  |
| -------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------ | ------------------------ | --------------------------- |
| A. Complete animation set per weapon                           | Highest per weapon                                                         | Poor: every new weapon multiplies the whole set | Very high (hundreds of clips × weapons)    | Same                     | Low code, very high content |
| B. Shared set + weapon-specific IK only                        | Good for similar weapons; weak for the M249 (hands, weight, stance differ) | Good                                            | Low                                        | IK per frame             | Medium                      |
| C. Shared locomotion + weapon-specific upper-body layer        | Very good                                                                  | Good: only the upper body varies                | Medium (upper-body clips per weapon class) | Masked layer per soldier | Medium                      |
| **D. Hybrid: C + weapon profiles + IK + per-weapon overrides** | **Very good to excellent**                                                 | **Good**                                        | **Medium**                                 | Same as C                | Medium–high                 |

**Recommendation: D.** Locomotion and posture transitions are shared by everyone. Each **weapon class**
(rifle: M16A2 and AK; automatic rifle: M249) has its own upper-body set (carry poses, aim poses,
fire, reload, raise/lower). Each **weapon profile** adds data: grip and support sockets, stock
position, sight line, length, weight (sway and recoil response), recoil curve, bipod. Left-hand and
barrel IK absorb geometric differences between weapons of a class, so the AK reuses the rifle set.
Individual clips can be overridden per weapon where needed (the M249 reload).

```ts
/** Handling data per weapon profile (alongside the combat profile). */
export interface WeaponHandling {
  readonly profileRef: WeaponProfileRef; // 'm16-rifle', 'squad-automatic-weapon', 'ak-assault-rifle'
  readonly animClass: 'rifle' | 'automaticRifle';
  readonly model: string; // asset id
  readonly sockets: {
    // in the weapon model's space
    readonly grip: Transform;
    readonly support: Transform;
    readonly stock: Transform;
    readonly sight: Transform;
    readonly muzzle: Transform;
    readonly ejection?: Transform;
    readonly bipod?: Transform;
  };
  readonly massKg: number; // sway and recoil response
  readonly recoil: { kickRad: number; recoverSeconds: number; spread: number };
  readonly overrides?: Partial<Record<'reload' | 'fire' | 'proneAim', string>>; // clip ids
  readonly attachments?: readonly { ref: 'm203-grenade-launcher'; socket: Transform }[];
}
```

### 6.2 The M249 SAW

The M249 is heavier (about 7.5 kg empty, about 10 kg with a 200-round box, against about 4 kg for a loaded M16A2), longer, has a box or
belt, a bipod and a forward grip area that changes the left-hand position, and is fired in bursts.
In practice:

- **Carry and ready:** its own upper-body poses (lower muzzle, left hand under the handguard or on top
  of the receiver cover when carrying), slower raise and sway driven by `massKg`.
- **Standing/kneeling fire:** the rifle aim pose with a wider stance and a lower, heavier recoil spring
  firing at the burst rate; tracers every fourth round (data).
- **Prone:** bipod deployed (a bipod node animated open; a prone-specific aim pose with the stock on
  the shoulder and the left hand on the stock), aim yaw by rotating the body on the bipod pivot.
- **Reload:** a dedicated clip (feed cover open, belt or box change); **no library has one**: commission
  or capture (asset evaluation §3.3). Until then, a procedural fallback (weapon lowered, hands to the
  feed tray by IK, timed to the simulation's reload window).

The M203 is an attachment of the M16A2 (socket under the handguard); firing it would be a separate
upper-body action when the simulation models it (it does not today). Knives are stowed props on the
belt.

### 6.3 Muzzle, tracers and flashes

The muzzle socket's world position, taken from the posed weapon at the shot's exact `atSeconds`, is
where the flash and tracer start; the tracer ends at the target's chest height (or at the simulation's
impact point if modelled). This is cosmetic: the simulation's hit roll is independent of it. Both live
and review show the same flashes because the shot times are events.

---

## 7. Posture and locomotion design

- **Speeds:** stationary; slow (cautious, weapon raised); walk; rush (run); sprint (weapon at port
  arms, cannot fire). Each with its own acceleration and deceleration in the motor.
- **Directions:** 8-way blend spaces per posture; turning in place by authored turn clips above a
  threshold, by foot-shuffle IK below it; facing independent of travel when aiming.
- **Kneeling vs crouching:** keep **one simulation posture `kneeling`** (as today) with two
  _animation_ sub-states: kneeling when stationary (one knee down, stable aim) and crouched when moving
  (crouch walk). They differ visually but not in line of sight or exposure at Ambush!'s fidelity, and
  one posture keeps the combat model simple. Revisit if the simulation ever distinguishes them.
- **Prone:** prone idle, crawl (slow), prone turns (the body rotates on the ground; aim yaw limited to
  about ±30° before turning), prone aim with weapon-specific poses.
- **Interactions:** posture changes block movement for their duration; sprint cannot fire; aiming
  restricts speed to slow or walk; prone limits aim yaw; posture sets line-of-sight heights (§4.4) and
  the simulation's hit exposure (already multipliers 1/0.75/0.5).
- **Terrain:** root height is the simulation's `surfaceHeightAt` (bridges included); foot IK samples
  the same function under each planted foot; pelvis lowers by the larger foot offset; feet tilt to the
  ground normal; on slopes beyond ~25° the upper body leans into the slope (procedural). Prone soldiers
  align the whole body to the ground normal (pelvis and chest sampled). Water: soldiers do not enter
  it (navigation). Future fine terrain detail (sub-metre relief) is in the terrain field, so foot IK
  sees it automatically.

---

## 8. First and third person

**Recommendation: a hybrid.** The full-body character renders always (third person, shadows,
reflections, other viewers in a future multiplayer); in first person the player's own body hides its
head and neck (or shrinks the head bone) and a **separate first-person arms-and-weapon rig** draws in a
dedicated pass with its own field of view (no clipping into walls, stable framing). Both are driven by
the same `CharacterFrame`, so the arms and the shadow agree.

| Option                      | Pros                                                                               | Cons                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| True full-body first person | One rig; body visible when looking down; consistent shadows                        | Hard to frame the weapon well; camera bob from the body is uncomfortable; weapon clips into walls |
| Separate arms + weapon      | Best weapon presentation (the industry norm); FOV control                          | Body shadow and arms can disagree unless both read the same state                                 |
| **Hybrid (recommended)**    | Industry practice (e.g. Destiny, Battlefield); shadows and legs from the full body | Two rigs to animate for the player's weapon set                                                   |

First-person features: eye at `surfaceHeightAt + eyeHeight(posture)` with posture-change easing;
mouse look (pointer lock) issuing `Aim` commands; WASD → `MoveIntent`; sprint, crouch/kneel, prone
keys → `SetSpeedClass`/`SetPosture`; aim-down-sights aligns the weapon's `sight` socket with the
camera; recoil kicks the camera and weapon (cosmetic springs) while the simulation's aim stays
authoritative; head bob and sway are cosmetic. The camera is a new `CameraMode`
(`tactical-camera.ts:20`), with the tactical camera's minimum distance and clearance limits not
applying.

**Responsiveness vs determinism.** The simulation runs at 30 Hz; input applies at the next tick (up to
33 ms latency, plus the frame). For first person, the view applies the latest _uncommitted_ aim and
look immediately (client-side prediction of the camera and arms only), then reconciles with the
simulation's aim at the next tick; since the simulation's aim is what decides shots, outcomes stay
deterministic. If 30 Hz proves too coarse for first-person feel, the tick rate can rise (the
simulation is tick-rate independent and tested at other rates).

---

## 9. AI-controlled animation

The AI never selects clips. It issues **intentions** that become commands or orders:

```ts
// Examples of AI intentions mapped to simulation commands
moveTo(soldier, position, { speed: 'rush', posture: 'standing', onArrival: { posture: 'prone', face: azimuth } })
  → SetOrders { waypoints: [position], finalFacing, speedClass: 'rush', arrivalPosture: 'prone' }
takeCover / goProne(soldier)          → SetPosture { posture: 'prone' }
engage(soldier, targetId)             → Aim { targetId } ; Fire { press } … (or the combat system's own loop)
reload(soldier)                       → Reload
becomeIncapacitated                   → combat system sets status, emits soldierIncapacitated
```

`MoveTo(position, speed=RUN, posture=STANDING)` produces, with no AI involvement: acceleration in the
motor, the run blend space at the motor's speed, directional blending if the soldier faces elsewhere,
a stop at the end, and the posture transition on arrival. Today's OPFOR reactions (prone or flee,
`combat.ts`) and BLUEFOR orders become the first users of these intentions.

---

## 10. Performance and levels of detail

| Distance (high preset, guide) | Mesh                                  | Skeleton                      | Animation                                                        | Shadows                 |
| ----------------------------- | ------------------------------------- | ----------------------------- | ---------------------------------------------------------------- | ----------------------- |
| < 30 m                        | full (~15k triangles)                 | full (fingers)                | every frame, all layers and IK                                   | yes                     |
| 30–120 m                      | ~5k triangles                         | reduced (no fingers, no face) | every frame, no foot IK, additive kept                           | yes (medium preset: no) |
| 120–400 m                     | ~1.5k triangles, instanced            | reduced                       | 10–15 Hz, base layers only, or a shared pose per animation state | no                      |
| > 400 m                       | impostor or the current marker figure | —                             | pose bucket (frame index)                                        | no                      |

Mechanisms: per-soldier frustum culling (no evaluation off-screen except for shots and casualties
timing, which are events); update-rate throttling that samples at simulation time (a lower rate
samples less often, never "advances less"); pose sharing for soldiers in the same state and phase
bucket; InstancedMesh2 skinning for the distant bands (MIT, three ≥ 0.186); one material per
character (atlased); shared clips and skeleton templates. Budgets per preset go in
`QualityPreset.characters` (`maxFullDetail`, band distances, shadow casters).

Measured (research report §9, integrated GPU): ~84 µs of CPU per fully animated soldier per frame
(mixer ~25, bone matrices ~20, skeleton upload and draw ~39), CPU-bound; shadows from hundreds of
skinned soldiers cost the GPU heavily; shared poses cut the per-soldier cost to ~7 µs. Hence the
bands above: full evaluation only near, shared poses and instancing far, shadows near only.

---

## 11. Determinism and replay (summary)

- Simulation-authoritative: posture and its timing, speed, velocity, odometer, aim, weapon actions and
  ammunition, shots (with times), casualties (with times). All recorded per tick by the existing
  recorder.
- Visual-only, reconstructed: interpolation, gait phase, blend weights, transitions, IK, recoil and
  sway springs, muzzle flashes, death clip choice (seeded by soldier id and event data).
- **Seeking and rewinding:** evaluate the pose at the target time from the frame there and the
  transition/event start times it references; nothing is integrated across frames, so scrubbing
  backward gives exactly the pose forward playback gave.
- **Speeds:** 1×, 4×, 8×, 16× and pause sample simulation time; review speeds 0.25×–4× likewise, with
  fractional frames interpolated (new `frameAtFraction`).
- **Animation never changes combat results:** no gameplay code reads bones, clip lengths or render
  time. Lint already forbids `three` in `sim`/`exercise`; a test asserts identical state hashes with the
  character layer present or absent (it cannot reach the simulation by construction, but the test
  guards future regressions).

---

## 12. Alternative architectures and decision

| Option                              | Description                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Native three.js                  | `AnimationMixer` with its crossfades and `update(dt)`, `CCDIKSolver`, little custom code.                                                         |
| B. three.js + third-party framework | animouse (state machine/blend trees), THREE.IK/fullik, VRM tooling.                                                                               |
| **C. Custom hybrid**                | three.js as sampler and renderer; our layer graph, blend spaces, masks, closed-form transitions, analytic IK, LOD, all driven by simulation time. |
| D. Advanced procedural              | Motion matching / pose search, procedural locomotion, physics-based reactions.                                                                    |
| E. WASM runtime                     | ozz-animation compiled to WebAssembly with our own bindings; three.js only renders.                                                               |

Weighted decision matrix (scores 1–5, higher is better; weights sum to 100):

| Criterion                                    | Weight |       A |       B |       C |       D |       E |
| -------------------------------------------- | -----: | ------: | ------: | ------: | ------: | ------: |
| Visual quality                               |     15 |       2 |       3 |       4 |       5 |       4 |
| Development effort (inverse)                 |     10 |       5 |       3 |       3 |       1 |       2 |
| Runtime performance                          |     10 |       3 |       3 |       4 |       2 |       5 |
| Asset compatibility (glTF, retargeted clips) |      8 |       4 |       3 |       5 |       2 |       3 |
| Weapon handling                              |      8 |       2 |       3 |       5 |       4 |       4 |
| First-person responsiveness                  |      7 |       3 |       3 |       4 |       4 |       4 |
| AI compatibility                             |      7 |       3 |       3 |       5 |       3 |       4 |
| **Deterministic replay**                     |     12 |       2 |       2 |       5 |       2 |       4 |
| Scalability (hundreds)                       |      8 |       2 |       2 |       4 |       1 |       5 |
| Maintainability                              |      7 |       3 |       1 |       4 |       2 |       2 |
| Extensibility                                |      4 |       2 |       3 |       5 |       4 |       4 |
| Licensing risk (inverse)                     |      4 |       5 |       3 |       5 |       2 |       5 |
| **Weighted total (out of 500)**              |        | **289** | **266** | **433** | **272** | **380** |

(Each total is Σ weight × score.) **Recommendation: C, the custom hybrid**, keeping E as the
escape hatch if JavaScript pose evaluation becomes the bottleneck at the largest scales (its data
model, layers and IK are the same, so the switch would replace the sampler only), and adopting D's
cheap parts (inertialization, distance matching, orientation warping) without motion matching.

- A loses on determinism (built-in fades run on the mixer's clock) and on weapons/IK.
- B adds immature or abandoned dependencies without solving determinism.
- D is unaffordable in data and has no browser implementation.
- E is the fastest at scale but needs custom bindings, a build step and a second data format; worth it
  only if measurement demands it.
