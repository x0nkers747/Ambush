# Animated soldiers in the 3D view

- Status: implemented (milestones M0 and M1 of the
  [revised roadmap](character-animation-revised-roadmap.md), with combat and the After Action
  Review). Decision record: [ADR 0052](adr/0052-animated-soldiers.md).
- Code: `src/view3d/characters/`, `src/exercise/motion-log.ts`; assets in `public/characters/`.
- Screenshots: [`docs/research/character-animation/production/`](research/character-animation/production/).

In the 3D view, every soldier (BLUEFOR and OPFOR) is the approved Microsoft Rocketbox soldier,
animated from the simulation's state. The 2D map keeps its symbols. Nothing about the
simulation changes: the animation reads recorded state and never writes any.

## 1. Data flow

```
sim (30 Hz ticks)  ──►  exercise: motion log (every tick)  ──►  view3d/characters
                         + combat log (shot and down times)      pose = f(logs, time)
                         + render time (between ticks)
```

1. **Motion log** (`exercise/motion-log.ts`). After every tick, the exercise records each
   soldier's position (x, y and the surface z it stands on), azimuth, posture, status and combat
   behaviour, from the exercise's first tick. It takes 35 bytes per soldier per tick, held in
   1,024-tick chunks. Its latest tick follows the state while plans are edited between ticks.
   Recording it never changes the simulation; a test checks the state hashes.
2. **Render time** (`Exercise.renderSeconds`). While the simulation runs, the view draws one
   tick behind it, plus the part of a tick the fixed-step runner has accumulated (its `alpha`).
   Positions are interpolated between two recorded ticks, so movement is smooth at any frame
   rate. This is roadmap milestone M0. In the After Action Review the clock is the replay time:
   fractional, not snapped to frames.
3. **Pose input** (`characters/motion.ts`, `SoldierMotion`). This is a pure function of
   (motion log, combat log, time):
   - **Position and facing:** interpolated between the two ticks around the time; exact at whole
     ticks.
   - **Speed and direction of travel:** from the distance covered over the last 0.3 s. The
     simulation changes speed at once; the short window gives a start and a stop. The window
     only looks back, so live and the review see the same.
   - **Posture:** from the simulation. The tick where it changed starts a visual transition
     (0.6 to 1.7 s; the simulation's change is instant).
   - **Weapon carry:**
     - aimed while engaging, or for 4 s after a shot;
     - lowered (patrol) on the move;
     - ready otherwise.
   - **Shots and incapacitation:** their exact times, from the combat log.
4. **Animator** (`characters/animator.ts`). three.js's own `AnimationMixer`, used as a sampler.
   Each clip's weight and time are computed from the pose input, then `mixer.update(0)` samples
   them. It never accumulates frame time. It blends:
   - locomotion: speed and direction blend space, crossfaded between postures;
   - the upper-body layer (the idle clip's calm upper body under the procedural hold);
   - the incapacitation (from the moment of the hit, the ragdoll: below).
5. **Procedural layer** (`characters/character.ts`, `hands.ts`, `ik.ts`), as approved in the
   prototype:
   - feet on the ground (foot IK);
   - torso blade and aim;
   - the weapon at the shoulder, with both hands on it (palm solved to measured grip sockets,
     fingers closed round them);
   - the head to the sights: aiming, the sight line goes through the right eye;
   - recoil and muzzle flash, from the shot times;
   - the weapon dropped when down.
6. **Layer** (`characters/layer.ts`). One character per soldier the map shows. Each soldier has
   a small team indicator over the head and a ring on the ground when selected.

## 2. State to animation

| Simulation                                     | Animation                                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Standing still                                 | `idle` (each soldier starts it at a different point: a hash of his id)                                                                           |
| Moving (any speed)                             | Continuous blend `idle` → `walk` (0.74 m/s measured) → `run` (4.4) → `sprint` (6.5), by speed; the game's 1.5 m/s pace is 79 % walk, 21 % run    |
| Moving sideways or backward relative to facing | `walkLeft`, `walkRight`, `walkBack` by the angle between facing and travel (the simulation turns at a limited rate, so this happens after turns) |
| Turning on the spot                            | Steps from the walk clip (0.25 m of "travel" per radian)                                                                                         |
| Kneeling, kneeling and moving                  | `kneelIdle`, `kneelWalk`                                                                                                                         |
| Prone, prone and moving                        | Procedural prone pose (on the stomach, head to the sights), procedural low crawl                                                                 |
| Posture change                                 | Timed crossfade between the postures' blends (no transition clips are licensed)                                                                  |
| Engaging, or fired in the last 4 s             | Aimed: butt in the shoulder, sight line through the right eye, cheek on the stock                                                                |
| Moving otherwise                               | Patrol carry, weapon across the body                                                                                                             |
| A shot (combat log, exact time)                | Recoil (closed-form decay), muzzle flash for 45 ms                                                                                               |
| Incapacitated (combat log or status)           | Weapon dropped; the body falls as a ragdoll from its pose at the hit, pushed away from the shooter, onto the ground (`ragdoll.ts`)               |

The gait phase advances by the distance covered divided by the blend's cycle distance, tick by
tick (`gait.ts`, memoised), so the feet keep pace with the ground at any speed. The simulation's
speed is never changed to suit a clip.

## 3. Weapons

| Simulation weapon (`combatWeapons`) | Model                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| `m16-rifle`                         | "Assault Rifle West" (CC0, AR-15 pattern), scaled to 1.0 m                        |
| `squad-automatic-weapon`            | **Placeholder** M249 built from boxes, with its own sockets; the rifle's handling |
| `ak-assault-rifle`                  | Quaternius AK (CC0), scaled to 0.88 m                                             |
| anything else                       | no weapon drawn                                                                   |

Each model has sockets in the weapon frame (`weapons.ts`), measured from side views: butt,
pistol grip, handguard, eye (behind the rear sight) and muzzle. Shots stay on the 2D overlay
(tracer lines). The muzzle flash is drawn at the posed muzzle.

## 4. Terrain and bridges

The root stands on the recorded `z`: the surface the simulation has the soldier on. On a bridge
that is the deck, interpolated along the deck by the movement code. Foot IK samples
`surfaceHeightAt` (deck over water, else the terrain) under each foot. It lowers the pelvis by
the lower foot's offset (at most 0.45 m), bends the legs to the ground, and tilts the feet to
the slope. Off the terrain's edge, the clip's feet are kept. None of this feeds back into the
simulation.

## 5. Exact replay

A pose is a function of (motion log, combat log, time, clips). Live and the review use the same
logs and the same code, so the review reproduces live play exactly.

Measured, with soldier poses compared on every number: root, all 81 bones, the weapon's matrix,
every playing clip's weight and time.

- **Node (`characters/replay.test.ts`, a real exercise).** The reference is live poses taken
  while the exercise ran, at irregular frame times. Reconstructing them on fresh soldiers in
  reverse order gives **difference 0** (bit for bit). The following also give difference 0 at
  moments covering movement, shots, recoil and incapacitation:
  - 60 and 144 Hz;
  - irregular frames;
  - 0.25× and 16×;
  - seeks forward, backward and shuffled;
  - repeated seeks.
- **Browser (the AAR of a played ambush, 16 soldiers, 20 timeline points).** The following all
  give a worst difference of 0:
  - seeks forward, backward and shuffled;
  - after 0.25× playback;
  - after 4× playback paused midway;
  - a 1 s step against frame 30;
  - after a 2D/3D switch.

Two three.js details had to be handled for exactness (both in `animator.ts`):

- **Write skipping.** `PropertyMixer` skips writing a value equal to the previous update's.
  This was already handled in the prototype: the sampled pose is saved and restored around
  post-processing.
- **Stale accumulators.** `PropertyMixer` blends a property with no weight toward its original
  value from a stale accumulator (two updates old). `Quaternion.slerpFlat` then renormalises or
  not depending on that stale value, which showed as 5 × 10⁻⁸ on a face bone after seeking
  backward. Before each update, the accumulator is reset to the original value.

**Aftermath.** When the timeline has ended, the view lets the soldiers' animation run on for
up to 3 s, so a fall under way finishes. Positions stay at the last tick. The timeline ends
when the engagement is complete (the simulation stops a few hundredths of a second after the
last casualty), or when the review is at its end. This is the only use of real time, and it
applies past the end of the recorded timeline only.

**Ragdoll** (`ragdoll.ts`). An incapacitated soldier falls as a ragdoll:

- **The body:** 18 points (pelvis, hips, chest, shoulders, head, elbows, wrists, knees, ankles,
  toes) joined by fixed-length bones, with a rigid torso and simple joint limits (no folding
  flat, no splits).
- **The start:** his pose at the moment of the hit, and his velocity just before it. The shot
  pushes the upper body away from the shooter, and the feet slightly the other way, so the body
  topples rather than folding in place.
- **The fall:** gravity, onto `surfaceHeightAt` under each point (each point keeps its radius
  above it), with friction. The bones are posed from the points.
- **Determinism:** a fixed step (1/120 s) for 3 s from the hit, every step memoised. The body at
  a time is the same however the time is reached: the replay tests are exact through falls.

**Shadows** (`shadow.ts`). The sun's shadow had a depth bias of a fixed fraction of the
shadow camera's depth range, which is several kilometres: over 2 m along the light. The ground
lost the shadow of whatever stood within about 1.5 m of it, so soldiers' (and poles' and
buildings') shadows came loose from their bases. The bias is now 8 cm, converted for the depth
range each frame, with no speckling. The 0.4 m normal bias stays, against terrain
self-shadowing; it cuts the lowest 0.4 m of a shadow, so soldiers are drawn into the shadow map
0.4 m higher, which puts their shadows at their feet.

## 6. Assets

- `public/characters/` (3.8 MB, licences in its README):
  - the Rocketbox FBX and four 1024² colour and normal maps;
  - `clips.json` (12 clips, 0.66 MB);
  - two rifle models.
- Loaded once, when the 3D view opens (about 0.7 to 1 s). Every soldier is a
  `SkeletonUtils.clone` sharing geometry, materials and textures.
- OPFOR wear the same model in a khaki-tinted uniform (`load.ts`, `OPFOR_TINT`); face and skin
  are unchanged.
- Team indicators (blue BLUEFOR, red OPFOR, grey down, yellow selected) keep a constant size on
  screen and show through trees and buildings. The old figures are no longer drawn; destination
  pins stay.

## 7. Performance

All figures are on a Radeon 880M (integrated GPU) in the Quantico town battlefield, with
buildings and trees. The camera is 40 m away, Chrome is uncapped (vsync off), and the crowd is
from `ambushBenchCharacters`, walking and running.

| Soldiers            | Frame time | Frames per second | Posing CPU | Draw calls |
| ------------------- | ---------: | ----------------: | ---------: | ---------: |
| 0                   |    12.7 ms |                79 |          — |        114 |
| 16 (squad + patrol) |    13.3 ms |                76 |     3.4 ms |        730 |
| 25                  |    14.8 ms |                68 |     5.1 ms |      1,079 |
| 50                  |    20.6 ms |                48 |    10.1 ms |      2,038 |

- **Per soldier:** about 200 µs to pose in the browser (74 µs for the pose alone in node), and
  about 38 draw calls. Those are the model's 13 material groups and the rifle's parts, each
  drawn twice with shadows.
- **Memory:** about 4 MB of assets, plus the motion log (35 bytes per soldier per tick).
- **Culling:** soldiers outside the view are not posed. A soldier under 14 px tall is posed
  every 4th frame; his pose is still a function of time.
- **Prepared, not built:** pose sharing and skinned instancing (`@three.ez/instanced-mesh`),
  per the recommended architecture. The layer's interface would not change.

## 8. How to

**Add an animation.**

1. In the prototype, map the clip to a slot in `prototypes/character-animation/src/assets.ts`.
2. Add the slot to `BAKED_SLOTS` (`src/bake.ts`) and to `ClipSlot` (`src/view3d/characters/rig.ts`).
3. Re-bake:
   - `npm run assets` (once);
   - `npm run dev`;
   - `PLAYWRIGHT=… npm run bake`.
4. Use the slot in the animator.

**Add a soldier model.**

1. Map its skeleton in `RIG_BONES` (`rig.ts`).
2. Load it in `load.ts` (it must be about 1.8 m tall, as the clips were baked).
3. Bake clips retargeted to it in the prototype (`fill(…, target)`).

The hands are measured from any five-fingered rig (`hands.ts`). Sighting needs eye bones (the
`sighting` flag).

**Turn the soldiers off.** Use `?characters=off` in the address, or `characters: false` in
`createBattlefieldView3d`. The old markers are drawn instead.

## 9. Known limitations

- **The review starts at TRIGGER AMBUSH.** It covers the engagement only, which in this combat
  model often lasts a few seconds.
- **No transition clips.** Posture changes and the start of a fall are crossfades: no openly
  licensed transition clips exist.
- **No aim target in the simulation.** Aim follows the facing, and the pitch is level.
- **No reloads.** No reload is simulated, so none is shown.
- **The M249 is a placeholder.** The squad automatic weapon is boxes with rifle handling.
- **Walk blend.** The walk clip's measured speed (0.74 m/s on this rig) is below the game's
  1.5 m/s pace, so walking blends in 21 % of the jog. The feet stay synchronised through the
  gait phase.
- **Draw calls.** About 38 draw calls per soldier. Above about 50 soldiers on this GPU, frame
  rate drops below 60; instancing is the next step.
