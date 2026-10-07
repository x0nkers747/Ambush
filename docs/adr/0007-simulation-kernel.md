# ADR 0007: Simulation kernel: state, commands, events, PRNG, snapshots and hashing

- Status: Accepted
- Date: 2026-10-07 (snapshot and seed decisions confirmed at Phase 1 approval)

## Context

ADR 0004 requires plain-data simulation state, commands as the only mutation
path, and a seeded PRNG. Phase 1 establishes the smallest kernel that later
phases (movement, perception, combat, recording) build on.

## Decision

**State** (`SimState`) is plain data: `tick`, `rng`, `units` and `soldiers`.
Collections are arrays in scenario order, so iteration is deterministic.
Soldiers are the only simulated entities. Organization units (`OrgUnit`) are
structure: an echelon label, a parent and a leader. Membership is recorded once,
on each soldier (`Soldier.unitId`, the immediate unit); a unit's members include
those of its descendant units. Echelons are labels only, so Army and Marine
structures differ only in scenario data.

**Scenario.** Human-authored, plain TypeScript data with string ids and
`azimuthDeg`. `createInitialState(scenario, seed)` validates it (unique ids,
known parents and units, no cycles, leaders inside their unit, one side per
organization tree, finite numbers) and converts it once.

**Commands** are plain, tick-stamped data. `Simulation.submit` copies a command
into a pending queue after checking its shape (an integer tick not in the past,
finite numbers); malformed commands throw. A command stamped with tick T is
applied at the start of tick T, before any system runs, in submission order
among commands for that tick. Whether it applies to the state is decided then;
if not, a `commandRejected` event records why. Phase 1 has one command,
`setOrders`.

**Events** are plain, tick-stamped data returned by `Simulation.step()` for the
tick just executed. There is no event bus. Events carry enough data to update a
reconstructed state (ADR 0005). Phase 1 events: `ordersChanged`,
`commandRejected`; Phase 2 adds `waypointReached` and `soldierInPosition`
(ADR 0008).

**Pipeline.** `stepState` is the whole pipeline: apply the tick's commands, run
systems in a fixed order (currently only movement, ADR 0008), then increment
`tick`. Systems are free functions that receive the tick duration in seconds.

**PRNG: xoshiro128\*\*, seeded through SplitMix32.** The state is four unsigned
32-bit integers stored in `SimState.rng`. We chose it because:

- it is a well-studied, published generator (Blackman & Vigna) that passes the
  standard statistical test batteries, with a period of 2^128 − 1;
- it needs only 32-bit integer arithmetic, which JavaScript performs exactly
  (`Math.imul`, `>>> 0`), so it does not need BigInt or depend on floating-point
  behavior;
- its state is four plain numbers, so it snapshots and hashes like everything else.

Mulberry32 (period 2^32) is too short for long runs. PCG32 needs 64-bit
multiplication, which is BigInt in JavaScript. A cryptographic generator is
unnecessary. SplitMix32 spreads adjacent seeds (0, 1, 2, …) into unrelated
states. Tests pin the reference output and seeded sequences, so an accidental
change to the generator is caught.

**Snapshots contain simulation state, not queued commands.**
`Simulation.snapshot()` returns `{ tickRateHz, state }`, a deep copy of the
complete mutable simulation state. Commands queued for future ticks are inputs,
not state, and are never part of a snapshot. `restore` replaces the state with a
copy and discards all pending commands; the caller resubmits them (a replay
resubmits them from the command log, ADR 0005). A future exercise save/resume
format, owned by the `exercise` layer, may store a snapshot _and_ the pending
commands side by side. Copies are made by a small plain-data cloner rather than
`structuredClone`, which is a host API not available in `sim`. The cloner
rejects anything that is not plain data.

**The seed is run configuration, not scenario content.** `SimConfig` holds the
tick rate and the PRNG seed. A scenario describes the starting situation; the
scenario plus the run configuration (`SimConfig`) defines one particular
simulation run. The same scenario can be run with different seeds, and both are
recorded with every exercise.

**State hash.** `hashSimState` is 64-bit FNV-1a over the UTF-16LE bytes of a
canonical encoding. The encoding:

- sorts object keys, so the order in which properties were created doesn't
  matter (`JSON.stringify` follows insertion order, and moves integer-like
  keys first);
- writes numbers in ECMAScript's specified shortest round-trip form, keeping
  `-0` distinct;
- rejects `NaN`, `Infinity`, `undefined` and non-plain objects instead of
  silently dropping or coercing them.

The hash is a test and regression tool, not a storage format and not
collision-resistant against adversaries.

## Consequences

- Determinism tests compare hashes across runs, seeds, snapshot/restore cycles
  and tick rates.
- Changing the state shape changes pinned hashes; those tests are updated
  deliberately.
- RNG draws must be tied to events (e.g. one per shot), not taken every tick,
  or results would depend on the tick rate.
