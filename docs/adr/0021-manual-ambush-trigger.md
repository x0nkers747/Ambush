# ADR 0021: The trainee triggers the ambush

- Status: Accepted
- Date: 2026-10-09
- Amends ADR 0010 (the trigger) and ADR 0019 (when the engagement begins). Builds on ADR 0004
  (commands) and ADR 0019 (combat v1, nearest-target selection).

## Context

Until now the first OPFOR soldier to enter the kill zone sprang the ambush. At the end of that
tick the exercise (`afterTick` in `src/exercise/exercise.ts`) recorded the entry as the trigger
and submitted `beginEngagement` for the next tick. The trainee had no say: a patrol that
entered the kill zone one man at a time was always engaged when its leader stepped in, however
the trainee had planned to catch it.

Springing an ambush is the leader's decision. It is usually made by opening fire when as much of
the enemy as possible is in the kill zone.

## Decision

### Entering the kill zone no longer starts combat

During the approach OPFOR walks its route through, and past, the kill zone. The kill zone stays
on the map and the simulation still reports `engagementAreaEntered` (ADR 0010). The exercise
also records `killZoneEntered` and `killZoneLeft` milestones whenever an active OPFOR soldier
comes into or leaves the kill zone, for the event log and the AAR. They are compared at the end
of each tick, so a soldier who crosses a corner within one tick is not reported.

### TRIGGER AMBUSH

`Exercise.triggerAmbush()` is the only way to begin an engagement.

- **When.** From START OPFOR until the engagement begins. Nobody needs to be in the kill zone or
  in sight of a Marine. It is refused before the approach, after a trigger, and once the
  engagement has begun.
- **How.** It submits the existing `beginEngagement` command (ADR 0019) for the current tick
  (`sim.tick`). There is no second way to start combat. The exercise only ever steps whole ticks
  and is frozen while paused, so the simulation is always at the start of `sim.tick` when the
  trainee acts; the engagement begins there, at `tick / tickRateHz`. When the exercise is
  running, that is the next tick it steps. When it is paused, the command waits in the
  simulation's queue and the engagement begins with the first tick after Resume.
- **States** (`Exercise.triggerState`):
  - `unavailable`: before the OPFOR approach;
  - `available`: during the approach, not yet triggered;
  - `queued`: triggered, the engagement not yet begun (the next tick, or on Resume);
  - `triggered`: the engagement has begun or ended.
- **Phases.** The phase becomes `engagement` when the simulation reports `engagementStarted`,
  not when the trainee presses the button. Nothing pauses automatically.
- **Duplicates.** A second request is refused by the exercise. The simulation would refuse a
  second `beginEngagement` anyway (`engagementAlreadyBegun`).

### What is recorded

`AmbushTrigger`, immutable, is recorded when the trainee triggers, with an `ambushTriggered`
milestone. It is also part of `EngagementResult`. It holds:

- `tick` and `atSeconds`: when the engagement begins;
- `approachSeconds`: time since START OPFOR;
- `whilePaused`;
- `killZoneId`;
- `opforInKillZone` and `opforTotal`;
- `opforPositions`: every OPFOR soldier's position, and whether it counted as in the kill zone.

It replaces the old record of the entering soldier and the entry point. The map marks the OPFOR
positions at the trigger: two rings for soldiers in the kill zone, a dashed ring for the rest.

### Kill-zone occupancy

`Exercise.killZoneOccupancy()` returns `{ inside, total }`, or `null` without a valid kill zone.

- `inside` counts OPFOR soldiers that are active (not incapacitated) and have not escaped, whose
  position is in the kill zone. The boundary counts as inside, as with entry (`pointInPolygon`,
  ADR 0010).
- The polygon is the one sent to the simulation at START OPFOR, or the one being drawn before
  then.
- `total` is every OPFOR soldier of the scenario, from scenario data.

It is information only and never gates the trigger. `Exercise.approachSeconds` is the time since
START OPFOR, frozen at the trigger.

### The UI

Next to the execution controls:

- **TRIGGER AMBUSH:** a large red button. It is disabled before the approach. While queued it
  reads "AMBUSH QUEUED", with "Queued: begins on resume" (or "begins now") beside it in a live
  region. Once the engagement begins it is replaced by "ENGAGEMENT IN PROGRESS", then
  "ENGAGEMENT COMPLETE". There is no confirmation dialog and no keyboard shortcut, so that the
  ambush cannot be sprung by a stray key. The button itself is reachable by keyboard.
- **OPFOR IN KILL ZONE: n / total**, red while anyone is inside.
- **APPROACH TIME: mm:ss**.

The header now wraps onto a second line on narrow screens.

### Targeting is unchanged

Nearest-target selection (ADR 0019, `selectTarget` in `src/sim/combat.ts`) already met every
requirement, and was verified, not changed. At every firing opportunity it chooses, from current
positions, the nearest enemy that:

- is active and has not escaped;
- is within the weapon's maximum engagement range;
- is in clear line of sight.

Ties go to soldier order. Several Marines may engage the same target. A Marine with no target
looks again after `targetRecheckSeconds`. OPFOR uses the same rule.

## Determinism

The trigger is a tick-stamped command like any other (ADR 0004).

- **Same tick and seed, same engagement.** The same trigger tick and seed give the same
  engagement, whether it was requested running or while paused, and whatever the playback speed:
  1×, 4×, 8× and 16× give identical hashes, results and combat logs. A different trigger tick
  gives a different engagement.
- **Snapshots** (ADR 0007):
  - Pending commands are input, not state, so a snapshot taken before the trigger holds no
    trigger; the command is resubmitted with the command log.
  - A snapshot taken after the engagement began holds the engagement.
  - Both reproduce the original exactly.

## Consequences

- **Tests.** Tests that encoded the automatic trigger were changed to have the trainee trigger,
  usually once the first or second patrol member is in the kill zone. Each such change is
  explained where it is made. The engagement now begins with the trigger's own tick, not the
  tick after.
- **No save of an exercise in progress.** No in-progress exercise can be saved, so a queued
  trigger lives only in the simulation's command queue and the exercise's record of it.
- **The patrol walks on.** A patrol that is never ambushed walks to the end of its route and
  stands there; the approach goes on until the trainee triggers or leaves.
- **Exits are approximate.** Kill-zone entry and exit milestones fall at tick ends. The exact
  entry time is still in the simulation's `engagementAreaEntered` events.
