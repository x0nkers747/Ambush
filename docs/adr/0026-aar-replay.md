# ADR 0026: After Action Review replay (phase 1)

- Status: Accepted
- Date: 2026-10-10
- Fills in stage 5 of ADR 0025 (until now a placeholder). Scoring and analysis are not part of it.

## Context

After an engagement the trainee should be able to watch exactly what happened from the moment the
ambush was sprung, scrub backward and forward through it, then go back to planning, change the
plan and try again. The replay must show the original run, not a new one: no simulation rerun, no
new random numbers, no recalculated shots or detection. And it must use the existing tactical map,
not a second renderer.

## Decision

### The trigger is the start

The authoritative trigger is the trainee's **TRIGGER AMBUSH** (ADR 0021): it records an
`AmbushTrigger` and submits `beginEngagement` for the current tick, at whose start the simulation
then is. Replay time T+0 is that moment.

### Recording: the authoritative state at every tick

The exercise steps the simulation, so it records (`Exercise.recording`, `replay.ts`):

- **frame 0** at TRIGGER AMBUSH: the state at the start of the trigger tick, before the
  engagement begins;
- **one frame after every tick** from then on, until the engagement ends (the exercise stops
  stepping then, so the last frame is the final state).

A frame is a complete copy of the simulation state (positions, facings, postures, status, orders
and movement progress, every combatant's behaviour, reaction and counts, the engagement and its
end, the random generator's state). The parts the simulation never changes in place (a soldier's
orders and generated route, an engagement area) are copied once and shared by every frame until
they are replaced, so a frame costs little: the longest engagement (60 s at 30 Hz) is 1,801 frames.
The recording also keeps every simulation event from the trigger tick on (`events`). The shots
and their outcomes are the exercise's existing combat log, and the milestones its timeline: all
are stamped with the tick, so a frame shows exactly those that had happened by then (a tick's
events with the state after it). Nothing random is replayed from the seed: every outcome
is in the recorded states and events.

Recording happens in the step the simulation already takes; it adds a copy per tick
(about 0.04 ms) and changes nothing the simulation does.

### Replay views: the exercise as at a frame

`Exercise.replayAt(frame)` returns a read-only view of the exercise as it was at that frame. The
exercise's queries read the simulation state through one accessor (`simState()`), which in a view
returns the recorded frame's. So every existing query answers for that moment, from its existing
code: soldiers' statuses, routes, the engagement's result, the combat log, the timeline, the
phase. The trainee's plans are shown as they are. Every change (`setDestination`, `advance`,
`triggerAmbush` and the rest) is refused with an `ExerciseError`, and a view never steps the
simulation.

The tactical map, roster and panels draw a view exactly as they draw the live exercise: the same
`buildScene`, the same renderer, symbols, terrain and overlays. No second renderer, no second
simulation.

`frameAt(recording, seconds)` gives the frame for a replay time: the last one at or before it. The
same time always gives the same frame, whether reached by playing at any speed or by seeking
backward or forward.

### The interface

Stage 5 shows the map with, in the side panel's tools: the replay time and total duration, a
timeline scrubber, Restart, Step back / forward (1 s), Play / Pause, Jump to end, the playback speed
(0.25× to 4×), "Follow the selected Marine", and the selected Marine's state at that moment. It
opens at T+00:00, paused. Keys: Space plays or pauses, ← → step, Home / End jump. The map stays
interactive (pan, zoom, select); selecting does not interrupt playback. The floating simulation
panel is hidden in stage 5. The status shows the engagement result as at the replay's moment.

### Back to planning

**Return to Planning** (the stage's primary action) builds a new exercise with the plan as it was
executed (`carryPlans`: each Marine's destination and facing, the formations, the kill zone) and
opens BLUEFOR planning. Nobody is hurt or moved: the new exercise starts from the scenario.

Formations are carried in the order they were last placed (`Exercise.plannedFormations`, which,
unlike `formation`, also answers once the plan has been executed). Until now they were lost from
a restart after execution.

The three kinds of state stay apart:

- **plans** are the trainee's drafts and committed plans, carried into the new exercise;
- **simulation state** belongs to each exercise, so a new run starts clean;
- **the recording** belongs to the exercise that made it and is never changed: frames are copies,
  and a view refuses every change.

## Consequences

- A replay shows the run as it happened, including the simulation's current limitations.
- The recording lives in memory with its exercise. Return to Planning replaces the exercise, so
  the previous run's replay is no longer offered once the trainee is back in planning; the next
  run makes the next recording. Keeping earlier runs is left for later.
- Reloading the page loses the recording, as it loses the exercise (ADR 0025).
- The event log in stage 5 follows the replay: empty at T+0, then, at every moment, the lines the
  live log had gained since the trigger by then, in the same order and words. It is rebuilt from
  the recorded events and timeline, each event described with the state just after it
  (`replayEventsHtml`; `src/app/replay-log.test.ts` compares it with the live log at every tick).
- The same plan run again with the same seed (`?seed=N`, default 1) gives the same engagement.
- OPFOR soldiers cannot be selected (as in planning), so the per-soldier panel covers Marines.

## Verification

- `src/exercise/replay.test.ts`: the recording starts at the trigger with the state at that
  moment; every frame equals the live state of its tick and the last the final state; same-tick
  events are kept; views of a frame are identical however reached (forward, backward, repeated);
  playback speed does not change which frame a time shows; views never step the simulation or
  change its state, and refuse every change; plans are untouched.
- `src/app/replay-planning.test.ts`: back to planning gives the plan as executed (positions,
  formations, kill zone) in a fresh exercise with nobody hurt; a changed plan runs as a new
  simulation with its own recording, and the first run's recording is unchanged.
- `src/view2d/replay-scene.test.ts`: the map scene of a frame draws its soldiers and shows each
  shot from its recorded time for its display time only.
