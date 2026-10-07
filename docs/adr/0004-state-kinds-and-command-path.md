# ADR 0004: Three kinds of state; commands are the only mutation path

- Status: Accepted
- Date: 2026-10-07

## Decision

**Three kinds of state, in three layers:**

| State      | Layer      | Examples                                                  | Recorded |
| ---------- | ---------- | --------------------------------------------------------- | -------- |
| Simulation | `sim`      | soldier poses, active orders and progress, contacts, RNG  | yes      |
| Plan       | `exercise` | draft plan, committed plan revisions                      | yes      |
| Session/UI | `session`  | selection, hover, time scale, layer toggles, camera focus | no       |

**Simulation state is plain data**: no classes with hidden state, no closures,
no Three.js or other host objects. It can be structurally cloned, serialized and
hashed. Immutable reference data (terrain, definitions) is kept separate from
mutable state.

**Commands are the only way to change simulation state.** Every change from the
trainee, scenario scripts or AI is a serializable command stamped with the tick
at which it applies. Views and UI never mutate simulation state; they read it
through read-only APIs. The trainee's draft plan becomes simulation input only
when it is committed (plan revision → commands).

**Determinism.** Given the same initial state, configuration, seed and command
log, the simulation produces the same result on the same build. Randomness comes
only from a seeded PRNG held in simulation state; `Math.random`, clocks and
timers are banned in `sim` (ADR 0001). Iteration order is deterministic.

## Consequences

- Replay, regression testing (state hashes) and headless scenario runs need no
  special support from individual systems.
- Determinism is an engineering tool; the AAR does not depend on it (ADR 0005).
