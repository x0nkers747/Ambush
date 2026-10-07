# ADR 0005: Recording-based replay and After Action Review

- Status: Accepted
- Date: 2026-10-07

## Context

Full replay and AAR are required: scrub backward and forward, inspect positions,
orders, detections, engagements and casualties at any time, and compare the
trainee's plan with what actually happened. Replays produced by re-simulating a
command log break whenever simulation code changes, and simulation code will
change constantly.

## Decision

The AAR plays back a **recording**; it does not re-simulate. An exercise
recording contains:

- a header: format version, build version, scenario id and content hash,
  tick rate, seed;
- a **pose track** sampled at a fixed recording rate that is independent of the
  tick rate;
- the **event log**: all domain and exercise events, tick-stamped;
- every committed **plan revision**;
- periodic **keyframes** (full simulation state snapshots), plus one at every
  pause and commit;
- the **command log**.

Views read through a frame source with two implementations, live simulation and
recording playback, so the 2D and 3D views work identically in the AAR. State at
an arbitrary time is reconstructed from the nearest keyframe plus events.
Re-simulating from a keyframe with the command log is available as a same-build
deep-inspection tool, not as the basis of the AAR.

Scoring is a pure function of the scenario and the recording, kept outside the
simulation.

## Consequences

- Old recordings remain viewable as the simulation evolves.
- Cross-engine floating-point determinism is not a product requirement.
- The exact binary format and recording rate are decided when implemented (Phase 6).
