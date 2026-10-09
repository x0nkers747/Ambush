# ADR 0019: Combat v1, probabilistic two-sided engagements

- Status: Accepted; amended by ADR 0021 (the engagement begins when the trainee triggers it,
  at the start of the tick the request was made in, instead of after the first kill-zone entry)
- Date: 2026-10-09
- Builds on ADR 0003 (fixed time step), ADR 0004 (commands), ADR 0007 (simulation kernel, seeded
  random numbers), ADR 0010 (ambush flow and trigger), ADR 0011 (navigation and line of sight),
  ADR 0012 (organizations and loadouts) and ADR 0018 (the engagement wedge). Amends ADR 0018:
  weapon ranges now come from the combat configuration.

## Context

Until now an exercise ended, frozen, the moment an OPFOR soldier entered the kill zone
("AMBUSH TRIGGERED: combat begins here in a later phase"). Nothing fired:

- `SoldierStatus` had unused `wounded` and `killed` values, and nothing changed it.
- Posture was stored but had no effect.
- Weapons existed only as display profiles for the planning wedge.
- OPFOR soldiers carried no loadout.

The outcome of an ambush should depend on the trainee's planning: how far the Marines are from the
enemy, with which weapons, who can see the kill zone, how many take part, how the enemy reacts and
for how long. It should do so through chance, reproducibly, and with numbers that can be replaced
without touching code.

## Decision

### Where combat lives

Combat is a system of the simulation, run by the existing tick (`stepState`) after movement and
engagement-area monitoring. It is not a separate engine.

- **The exercise decides when.** At the end of the tick in which the trigger happens (unchanged,
  ADR 0010), the exercise submits a `beginEngagement` command for the next tick. Phases become:

  ```
  … opforApproach → engagement → engagementComplete
  ```

  `engagement` runs like the approach: it can be paused and resumed, and plays at any speed. The
  exercise freezes in `engagementComplete`.

- **The simulation decides what happens.** `beginEngagement` creates `SimState.engagement`: one
  combatant per soldier, in soldier order. That is the start of the engagement.
- **The world carries the model.** `SimWorld.combat` holds the validated configuration and the
  weapon each soldier fires. It is part of the world's fingerprint, so a snapshot cannot be
  restored under another combat model.
- **No change before the trigger.** A world or state without combat has no `combat` or
  `engagement` property at all. Hashes and fingerprints of everything before the trigger are
  therefore unchanged, and the pinned determinism tests pass as they were.
- **Plans are unaffected.** The scenario fingerprint, which saved plans are checked against, uses
  the terrain and movement only. A new combat configuration does not invalidate saved plans.

### Weapons

- **Which weapon.** Every soldier fires the primary weapon of his resolved loadout:
  - his slot's own loadout when it has one, otherwise his role's default (ADR 0012);
  - chosen by `primaryWeapon`, the rule the wedge already used: the first weapon classed
    `primary`, so a fire team leader fires his M16, never his M203 or bayonet.
- **No weapon.** An unknown weapon, or a primary weapon without a combat profile, gives no weapon.
  The soldier then never fires, and the wedge is not drawn. Nothing is guessed.
- **One rule.** The exercise resolves weapons once, for every soldier, into `SimWorld.combat.weapons`.
  The wedge and combat cannot disagree.
- **OPFOR.** OPFOR loadouts come from the scenario (`AmbushScenario.opforLoadouts`). The
  `patrol-3` force carries a generic `ak-assault-rifle`, added to the weapon identity table as a
  primary weapon. A scenario without OPFOR loadouts has unarmed OPFOR.
- **Identity and performance.** The weapon identity table (`weapon-display.ts`) keeps only each
  weapon's name and class. Its ranges are gone: performance is in the combat configuration.
- **The wedge.** Its radius is now the weapon's `maxEngagementRangeM`. That is 550 m and 600 m, the
  same as before, so the wedge looks the same.

### Configuration

All balance values are in one versioned JSON file, `src/exercise/combat/combat-v1.json`, checked by
`validateCombatConfig` (schema `ambush.combat-config`, version 1). It refuses unknown and missing
fields. [docs/combat-configuration.md](../combat-configuration.md) documents every parameter, its
unit, valid range and default. The numbers are placeholders for gameplay, not empirical data.

- **Hit probability by range.** Control points, starting at 0 m with strictly increasing ranges.
  - Between points, the probability is interpolated linearly.
  - From the last point out to `maxEngagementRangeM`, it is held at the last point's value.
  - Beyond `maxEngagementRangeM`, the weapon is never fired.
- **A shot** is one firing opportunity, such as an aimed shot or a short burst, every
  `secondsBetweenShots`. It is resolved in two stages:
  1. **Hit**, with probability `curve(range) × postureHitMultipliers[target posture]`. The default
     prone multiplier is 0.5.
  2. **Incapacitation** on a hit, with probability `incapacitationProbabilityOnHit`.

  Hits and incapacitations are counted separately.

- **Statuses** are `active` and `incapacitated`. An incapacitated soldier:
  - has its orders cleared, and never moves, fires, reacts or escapes again;
  - is no longer a target;
  - stays on the map, faded and crossed out.

### Firing

- **Valid targets.** A shooter's valid targets are active enemies that have not escaped, within its
  weapon's maximum engagement range (horizontal distance), with a clear line of sight. The line of
  sight is the existing `lineOfSight`, with standing eye and target heights: posture changes the hit
  chance, not visibility. There is no cover, concealment or suppression.
- **Target selection.** The configured policy is `nearest`: the closest valid target, by soldier
  order on a tie. Incapacitated soldiers are never valid, so nobody keeps firing at the fallen.
- **No firing sectors.** Facing does not restrict fire, and the 35° wedge is not a firing sector. A
  soldier fires at any valid target whichever way he faces, and turns instantly to face it.
  - During the engagement the wedge therefore points at the soldier's last target.
  - It stays a planning aid: its radius is exactly the weapon's firing range, but its angle means
    nothing to combat.
- **BLUEFOR timing.** Each armed Marine gets a first firing opportunity at a random delay of 0–1 s
  after the engagement starts, then one every `secondsBetweenShots`.
- **No target.** A shooter without a valid target looks again every `targetRecheckSeconds`. No shot
  is counted.

### OPFOR reactions

When the engagement starts, each OPFOR soldier, in soldier order, independently draws:

- its reaction: prone with probability 0.6, flee with 0.4;
- a reaction delay, uniform in 0.5–2 s.

Until it reacts, it carries on as before (for example, walking its route). It does not fire, and it
can be hit.

- **Prone.** It stops, drops prone (posture `prone`), and faces the centroid of the active
  Marines. After `returnFireDelaySeconds` (1 s) it fires with its own weapon. It uses the same
  resolution, curve, cadence, line of sight and target policy as BLUEFOR.
- **Flee.** It runs `fleeDistanceM` (600 m) away from the centroid of the active Marines, at
  `fleeSpeedMps` (4.5 m/s, a speed carried on its orders).
  - **Direction.** It tries straight away first, then 30°, 60° and 90° to either side, and takes
    the first direction whose destination is open ground it can walk to (`planPath`). Destinations
    are cut short at the map's edge.
  - **Path.** It follows the planned path round buildings and water, like any order. It does not
    fire while fleeing, and it remains a target.
- **No way out.** If no direction has a walkable route, it drops prone and returns fire instead,
  recorded as `fleeBlocked`.
- **Escape.** It escapes at the end of a tick when it is at least `escapeDistanceM` (300 m) from
  every active Marine and no armed Marine could engage it: out of that Marine's weapon range or out
  of his sight. Reaching its flee destination also counts.
  - An escaped soldier stops, leaves the engagement, is no longer a target, and stays on the map
    marked ESCAPED.
  - Distance alone does not count: a soldier still in view and in range has not escaped.

### Timing

Combat works in simulation seconds, never in frames.

- **Order of events.** Each tick resolves every reaction and firing opportunity due before the end
  of the tick, one at a time in order of exact time. Simultaneous ones are resolved reactions first,
  then in soldier order.
- **Consequences of the order.**
  - A soldier incapacitated earlier in that order does not fire later, even at the same instant.
  - A soldier may fire several times in one tick if its cadence is faster than the tick.
  - Shots are never skipped or duplicated, at any playback speed.
- **Random numbers.** All of them come from `SimState.rng`, in that order. `Math.random` is not
  used.
- **Positions.** Shots, reactions and escapes use positions at the end of the tick, after
  movement.
  - A tick (33 ms at 30 Hz) is therefore the resolution of where soldiers are, not of when they
    act.
  - With soldiers standing still, shot times and outcomes are identical at any tick rate (tested at
    10, 30 and 60 Hz).
- **End.** The engagement ends at the end of the first tick in which one of these holds, checked
  in this order:
  1. all OPFOR incapacitated;
  2. every OPFOR soldier not incapacitated has escaped;
  3. all BLUEFOR incapacitated;
  4. nobody on either side can fire any more (active, armed and not fleeing or escaped);
  5. `maxDurationSeconds` (60 s) has passed since the start.

  A lull in firing never ends it.

### Results and display

`summarizeEngagement` (sim) gives the facts from the state:

- start and end time, duration and end reason;
- per side:
  - starting strength;
  - incapacitated, escaped, and surviving but not escaped;
  - shots, hits, and enemies incapacitated;
- per soldier: weapon, reaction, outcome, and shot, hit, incapacitation and times-hit counts.

The exercise's `EngagementResult` adds what reproduces it:

- the seed and tick rate;
- the configuration's id, version and content fingerprint;
- the trigger.

`Exercise.combatLog` keeps every combat event in order (`engagementStarted`, `opforReacted`,
`shotFired`, `soldierIncapacitated`, `soldierEscaped`, `engagementEnded`), for the after-action
review. There is no score.

The app shows:

- **Phase label.** "Engagement" while it runs, "Engagement complete" after.
- **Results panel.** In the side panel, the results so far: totals by side, then each soldier who
  fired or was hit, and every OPFOR soldier.
- **Banner.** "ENGAGEMENT COMPLETE", with the reason and the totals.
- **Event log.** Reactions, incapacitations and escapes.
- **Map**, drawn in the tactical overlays (`drawOverlays`):
  - shots of the last 0.6 s as fading lines in the side's colour, ending in a dot on a hit;
  - incapacitated soldiers faded and crossed out;
  - PRONE, FLEEING and ESCAPED tags under the symbols.

  The cached geographic map (ADR 0017) is not involved. The viewshed and the wedge are unchanged.

The app takes the seed from `?seed=N` in the page address (default 1), so an engagement can be
repeated or varied. The time scales gain 4× (1×, 4×, 8×, 16×).

## Consequences

- **Planning decides the outcome.** Range, line of sight, the number of Marines in view, and the
  OPFOR's draws all change the outcome. Close, well-sited ambushes usually end in seconds with
  every OPFOR soldier incapacitated, sometimes with Marine casualties. Distant or poorly sited
  ones can run to the time limit with OPFOR still fighting, or let fleeing soldiers break contact.
- **Reproducible.** The same scenario, plans, configuration and seed give the same engagement:
  - at every playback speed, tested at 1×, 4×, 8× and 16×;
  - after pause and resume;
  - from a snapshot taken mid-engagement;
  - by replaying the commands.
- **Pinned outcomes changed.** Three tests asserted the old behaviour, that the exercise freezes in
  `ambushTriggered`. They now assert `engagement` and `engagementComplete`. The pinned hashes did
  not change.
- **Cost.** Each shot traces at most a few lines of sight, as does each escape check once a
  fleeing soldier is far enough. A 60 s engagement on a 5 km battlefield simulates in 0.1–2 s.
- **Limitations, by design:**
  - no cover, concealment, suppression, morale, wounds, armour, ammunition or weapon switching;
  - one target policy;
  - OPFOR do not coordinate;
  - prone soldiers see and are seen as if standing;
  - a fleeing soldier does not seek cover;
  - Marines hold their positions;
  - all OPFOR react to the trigger, whether or not they could perceive it.
