# Force-on-Force 01: what exists, and what is reused

- Status: done (F1)
- Date: 2026-10-14
- Part of: [Force-on-Force Lab](README.md)

The code was taken as the authority over the earlier research documents
([Behavior Lab 01–07](../README.md)). They were written before the urban district,
falling in, and changing formation on the move existed. Their plan for interruptions
was "a reactive task pushed on a unit's stack" (03 §11), to be added "with the first
reactive behaviour"; this is that behaviour, done more simply (§3).

## 1. What the kernel already has

| Need                    | What exists                                                                                                                                                                                          | Used as                                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Soldiers                | `Soldier` (`state.ts`): side, unit, position, azimuth, `posture` (standing, kneeling, prone), `status` (active, incapacitated)                                                                       | As is. A casualty is `status: 'incapacitated'`; contact posture is `posture`. No second soldier model.                                                       |
| Organizations           | `OrgUnit` tree; templates and instancing (`#exercise` organization); the Behavior Lab's squad, fire team and element                                                                                 | As is. OPFOR uses the same templates as OPFOR side, with its own id prefix.                                                                                  |
| Movement                | Unit tasks (`orderUnit`): formation movement, falling in, obstacles (`src/sim/behavior`); releases incapacitated members by itself                                                                   | As is. The contact behaviour cancels a force's task (halt), and issues `orderUnit` itself to withdraw or resume. No second movement engine.                  |
| Holding a Marine        | `AgentOverride` `hold` (the lab's disturbance)                                                                                                                                                       | A pinned Marine in a moving force is held by it.                                                                                                             |
| Sight lines             | `lineOfSight` / `traceSightLine` (`los.ts`): terrain, buildings, vegetation (gradual obscuration); `sightLineTracer` (`sight-tracer.ts`), the fast tracer proven equal to the reference              | `sightLineTracer(terrain).blocked` for every look, at several heights on the target (partial cover). Vegetation's partial obscuration is computed on top.    |
| Random numbers          | `SimState.rng` (xoshiro128\*\*), drawn in a fixed order                                                                                                                                              | Every draw (thresholds, glimpses, identification, reactions, cadence, hits).                                                                                 |
| Combat                  | Combat v1 (`combat.ts`, ADR 0019): the game's ambush. BLUEFOR fires, OPFOR reacts by a drawn rule; hit curve by range × posture multiplier; incapacitation roll; `shotFired`, `soldierIncapacitated` | Reused in kind: the same curve shape (`RangeProbability`, `hitProbabilityAt`) and the same incapacitation transition and event. Not reused as a system (§2). |
| Commands, events, state | Commands are the only input; events are plain tick-stamped facts; state is plain data, hashed and snapshotted; `stepState` is the pipeline                                                           | One new system in the pipeline, after combat; new event types; `SimState.fof`, absent elsewhere.                                                             |
| Characters              | The 3D character layer poses soldiers from a motion log (posture, status, combat behaviour) and a combat log (`shotFired` for aiming and firing, `soldierIncapacitated` for falling)                 | As is: the lab hands it force-on-force bursts as shots, and casualties as they are.                                                                          |
| Lab infrastructure      | `LabRun` (spec, commands, origins), `createLabSession` (keyframes, replay with hash checks), metrics, the lab page, scene, city, overlays                                                            | Same patterns, and the scene, city and character layer as they are.                                                                                          |

## 2. Why combat v1 is not the engagement system

Combat v1 is the game's ambush. It is one-sided by design:

- BLUEFOR always engages from the start;
- OPFOR's reaction is drawn when the engagement begins;
- its end rules name the sides.

There is no detection in it: a target in sight and range is shot at. Making it
two-sided and detection-driven would change the game's combat, which must not change.
So the force-on-force model is its own system, `src/sim/fof`, with its own
configuration (`fof-v1.json`, separate from `combat-v1.json`). It shares the curve
form, the posture multiplier idea, the incapacitation transition
(`status: 'incapacitated'`, `soldierIncapacitated`), the random-number stream and the
event conventions.

Combat v1's numbers are documented as "illustrative gameplay placeholders, not validated
empirical combat data" (`combat-config.ts`, `docs/combat-configuration.md`). They
assume a hit rate for an ambush at close range, which is far too lethal for a firefight
between two squads that see each other at hundreds of metres. The force-on-force curves
are separate and lower; they are equally illustrative.

## 3. The smallest clean extension

- **Kernel.** One module, `src/sim/fof`:
  - configuration and validation;
  - setup (the two forces);
  - state types;
  - detection;
  - the force state machine;
  - fire and suppression;
  - adjudication.

  One system, `updateForceOnForce`, runs last in `stepState`. It does nothing unless
  the world has a force-on-force setup (`Scenario.fof`, `SimWorld.fof`). `SimState.fof`
  is absent otherwise, so every existing state hashes as before.

- **No new movement.** Contact behaviour uses the existing unit tasks:
  - halting cancels the force's task;
  - withdrawing and resuming issue `orderUnit` internally, at decision time.
- **No new soldier.** Posture, facing and status are the soldier's own fields.
- **Exercise layer.** `src/exercise/force-on-force`:
  - the configuration file;
  - the run builder (two organizations on open, wooded or urban ground);
  - the woodland generator;
  - experiments and metrics.

  It is its own entry point (`#exercise/force-on-force`), never loaded by the game.

- **View.** `src/view3d/force-on-force`, at `#force-on-force`, loaded lazily like the
  Behavior Lab, reusing its scene, city and the character layer.

## 4. What changes in shared code

| File                                  | Change                                                               | Effect on the game                                                                  |
| ------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `state.ts`, `world.ts`, `scenario.ts` | Optional `fof` in state, world and scenario; validation when present | None: absent in every game scenario (states and world fingerprints hash as before). |
| `step.ts`                             | `updateForceOnForce` after combat                                    | Returns at once without a setup.                                                    |
| `events.ts`                           | Five event types                                                     | The game's event log ignores them (`exercise-stage.ts`).                            |
| `commands.ts` (F2)                    | A unit order to a force in contact is rejected (`unitInContact`)     | Only when `SimState.fof` exists.                                                    |

The pinned determinism hashes (`determinism.test.ts`) and the whole test suite are
the regression check.
