# Combat configuration reference

Every balance parameter of combat v1 ([ADR 0019](adr/0019-probabilistic-engagements.md)) lives in
one JSON file, [`src/exercise/combat/combat-v1.json`](../src/exercise/combat/combat-v1.json). The
simulation reads these values and nothing else: no combat number is written into the code. The file
is checked by `validateCombatConfig` (`src/sim/combat-config.ts`) when it is loaded, and an exercise
can be given another configuration (`createExercise({ combat })`).

**The defaults are illustrative gameplay placeholders, not validated empirical combat data.** To
calibrate them, edit the JSON and raise its `version`. Code changes are not needed.

## Identity

| Field           | Meaning                                                                  | Valid                              | Default                  |
| --------------- | ------------------------------------------------------------------------ | ---------------------------------- | ------------------------ |
| `schema`        | Kind of document                                                         | exactly `"ambush.combat-config"`   | `"ambush.combat-config"` |
| `schemaVersion` | Version of this format                                                   | `1`                                | `1`                      |
| `id`            | Identifies the configuration; recorded with every engagement result      | lower-case words joined by `-`/`.` | `"ambush-combat-v1"`     |
| `version`       | Version of the content (semantic); recorded with every engagement result | `x.y.z`                            | `"1.0.0"`                |
| `name`, `notes` | Description                                                              | non-empty text                     | (see file)               |

Each engagement result also records the configuration's content fingerprint, so two results can be
told apart even if someone forgets to raise the `version`.

Validation refuses unknown fields and missing fields, so a misspelt parameter can never silently
fall back to a default.

## Weapons (`weapons[]`)

One entry per weapon profile reference used by organization templates and OPFOR forces. Which
weapon a soldier fires is not set here. It is the primary weapon of the soldier's resolved loadout
(`primaryWeapon` in `src/exercise/weapon-display.ts`): the first weapon classed `primary` in the
weapon identity table. The same rule draws the planning map's engagement wedge.

| Field                            | Meaning                                                                          | Unit   | Valid                                  |
| -------------------------------- | -------------------------------------------------------------------------------- | ------ | -------------------------------------- |
| `weaponProfileRef`               | The reference, spelled exactly as in the templates                               | –      | unique                                 |
| `hitProbabilityByRange`          | Control points `{ rangeM, probability }`: chance one shot hits a standing target | m, 0–1 | first at 0 m; ranges strictly increase |
| `maxEngagementRangeM`            | Range beyond which the weapon is never fired; also the wedge's radius            | m      | > 0 and ≥ the last control point       |
| `incapacitationProbabilityOnHit` | Chance a hit incapacitates                                                       | 0–1    | 0–1                                    |
| `secondsBetweenShots`            | Time from one firing opportunity to the next                                     | s      | > 0                                    |

**Interpolation.** Between two control points, linear in range. At a control point, exactly its
probability. From the last control point out to `maxEngagementRangeM`, the last point's probability.
Beyond `maxEngagementRangeM`, no shot is taken at all: the target is not a valid target.

A **shot** is one firing opportunity, such as an aimed shot or a short burst, not a bullet.

Defaults:

| Range                   | `m16-rifle` (M16A2) | `squad-automatic-weapon` (M249) | `ak-assault-rifle` (OPFOR) |
| ----------------------- | ------------------- | ------------------------------- | -------------------------- |
| 0 m                     | 0.75                | 0.60                            | 0.70                       |
| 50 m                    | 0.65                | 0.50                            | 0.55                       |
| 100 m                   | 0.45                | 0.35                            | 0.35                       |
| 200 m                   | 0.20                | 0.18                            | 0.15                       |
| 300 m                   | 0.10                | 0.10                            | 0.06                       |
| 400 m                   | (0.06)              | (0.07)                          | 0.02                       |
| 500 m                   | 0.02                | 0.04                            | –                          |
| 600 m                   | –                   | 0.02                            | –                          |
| Max range               | 550 m               | 600 m                           | 400 m                      |
| P(incapacitated \| hit) | 0.60                | 0.55                            | 0.60                       |
| Seconds between shots   | 1.5                 | 0.75                            | 1.5                        |

Values in parentheses are interpolated, not control points. The M16A2 and M249 maximum ranges are
the weapons' nominal point-target effective ranges (MCWP 3-11.2 para 1004a), which the wedge showed
before combat existed.

## Posture (`postureHitMultipliers`)

Multiplies the hit probability of every shot at a soldier in that posture. It applies to incoming
fire only, never to the shooter's accuracy.

| Field      | Valid | Default | Note                               |
| ---------- | ----- | ------- | ---------------------------------- |
| `standing` | 0–1   | 1       |                                    |
| `kneeling` | 0–1   | 0.75    | No v1 behaviour makes anyone kneel |
| `prone`    | 0–1   | 0.5     | OPFOR soldiers that drop prone     |

## OPFOR behaviour (`opfor`)

| Field                                 | Meaning                                                                                      | Unit | Valid         | Default   |
| ------------------------------------- | -------------------------------------------------------------------------------------------- | ---- | ------------- | --------- |
| `reactionProbabilities.prone`         | Chance a soldier drops prone and returns fire                                                | 0–1  | sums to 1     | 0.6       |
| `reactionProbabilities.flee`          | Chance a soldier flees                                                                       | 0–1  | with `prone`  | 0.4       |
| `reactionDelay.minSeconds/maxSeconds` | Each soldier's delay from the start of the engagement to its reaction, uniform in [min, max) | s    | 0 ≤ min ≤ max | 0.5 – 2.0 |
| `returnFireDelaySeconds`              | From dropping prone to the first return shot                                                 | s    | ≥ 0           | 1.0       |
| `fleeSpeedMps`                        | Running speed while fleeing                                                                  | m/s  | > 0, ≤ 15     | 4.5       |
| `fleeDistanceM`                       | How far from the threat a fleeing soldier heads                                              | m    | > 0           | 600       |
| `escapeDistanceM`                     | Minimum distance from every active enemy to count as escaped (see below)                     | m    | > 0           | 300       |

**Escape.** At the end of each tick, a fleeing soldier escapes when it is at least
`escapeDistanceM` from every active enemy and no active, armed enemy could engage it, because it is
beyond that enemy's weapon's maximum range or out of its line of sight. Reaching the flee
destination is also an escape.

## Engagement (`engagement`)

| Field                                        | Meaning                                                                    | Unit | Valid         | Default |
| -------------------------------------------- | -------------------------------------------------------------------------- | ---- | ------------- | ------- |
| `maxDurationSeconds`                         | The engagement ends at the latest this long after it starts                | s    | > 0           | 60      |
| `bluforFirstShotDelay.minSeconds/maxSeconds` | Each Marine's delay to his first firing opportunity, uniform in [min, max) | s    | 0 ≤ min ≤ max | 0 – 1   |
| `targetRecheckSeconds`                       | With no valid target, how long until a soldier looks again                 | s    | > 0           | 0.5     |
| `targetSelection.BLUEFOR` / `.OPFOR`         | Target-selection policy of each side                                       | –    | `"nearest"`   | nearest |

`nearest` takes the closest valid target by horizontal distance. On equal range it takes the one
first in scenario soldier order. A valid target is an active enemy that has not escaped, within the
weapon's maximum engagement range, with a clear line of sight.

**Random seed.** The seed is not part of this file. It is the simulation's seed (`SimConfig.seed`;
in the app, `?seed=N` in the page address, default 1), and it is recorded with every engagement
result.

**Early termination.** The end conditions are fixed rules, not parameters. They are checked at
the end of every tick, in this order:

1. all OPFOR incapacitated;
2. every OPFOR soldier not incapacitated has escaped;
3. all BLUEFOR incapacitated;
4. nobody on either side can still fire;
5. the time limit.
