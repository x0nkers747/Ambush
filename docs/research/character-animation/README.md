# Character animation prototype: screenshots

Captured on 2026-10-14 from [`prototypes/character-animation`](../../../prototypes/character-animation/)
(Chrome 155, integrated AMD Radeon 880M) for
[`docs/character-animation-prototype-results.md`](../../character-animation-prototype-results.md).
Soldier: Microsoft Rocketbox `Military_Male_01` (MIT) unless stated; clips from Mesh2Motion/UAL and
KayKit (CC0); rifle: "Assault Rifle West" (CC0) as the M16A2 stand-in.

| File                                        | What it shows                                                                                                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui-overview.jpg`                           | The comparison page: controls, both runtimes side by side (B animouse left, A three.js native right), performance, layer weights, simulation input, clip coverage                                 |
| `ab-walk-aim.jpg`                           | Both runtimes walking diagonally while aiming (t = 36.2 s)                                                                                                                                        |
| `ab-kneel-fire.jpg`                         | Both runtimes kneeling and firing (t = 22.45 s; UAL crouch, not a one-knee kneel)                                                                                                                 |
| `ab-crawl.jpg`                              | Both runtimes crawling prone (t = 28.4 s)                                                                                                                                                         |
| `aim-hold-front.jpg`, `aim-hold-side.jpg`   | Procedural aimed hold: rifle from the shoulder pocket, bladed torso, both hands by two-bone IK, head on the stock                                                                                 |
| `ik-ccd.jpg`                                | The same pose with three.js `CCDIKSolver` for the arms (left hand short of the handguard)                                                                                                         |
| `patrol-carry-walk.jpg`                     | Lowered (patrol) carry while walking                                                                                                                                                              |
| `reload.jpg`                                | Procedural reload: support hand at the pouch, weapon canted                                                                                                                                       |
| `incapacitated.jpg`                         | Death clip; weapon dropped beside the body                                                                                                                                                        |
| `m249-placeholder.jpg`                      | The labelled M249 placeholder in the same aimed hold                                                                                                                                              |
| `mannequin-run.jpg`                         | Mesh2Motion mannequin running (native UAL clip, no retargeting)                                                                                                                                   |
| `run-sequence-rocketbox-vs-mannequin.jpg`   | 0.1 s steps of the run: Rocketbox (retargeted, top) and mannequin (native, bottom)                                                                                                                |
| `slope-foot-ik.jpg`, `slope-no-foot-ik.jpg` | Uneven ground: foot IK on and off                                                                                                                                                                 |
| `kaykit-aim-retarget.jpg`                   | KayKit's `Ranged_2H_Aiming` on (left to right) Rocketbox, mannequin, Quaternius and its own chibi rig: exact limb directions, but on realistic proportions the hands do not meet                  |
| `retarget-three-vs-rest.jpg`                | Left half: `SkeletonUtils.retargetClip` (the Rocketbox soldier, first position, is missing: it lies on its side out of frame); right half: the rest-aligned retargeter. Top: walk; bottom: crouch |
| `sequence-1.jpg`, `sequence-2.jpg`          | The 47 s test sequence at 20 times, both runtimes side by side                                                                                                                                    |
