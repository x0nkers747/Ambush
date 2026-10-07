# ADR 0003: Fixed timestep with a configurable tick rate

- Status: Accepted
- Date: 2026-10-07

## Decision

- The simulation advances in **fixed ticks**. The tick rate is configuration
  (`SimConfig.tickRateHz`), not an architectural constant. The production value
  will be chosen by measurement; `DEFAULT_TICK_RATE_HZ` is provisional.
- **Simulation time is derived**: `time = tick / tickRateHz`. It is never
  accumulated and never read from a wall clock.
- System rates and durations are expressed in **seconds** and converted using
  the tick duration, so behavior does not depend on the tick rate. Tests run at
  several tick rates.
- The tick rate is recorded with every exercise (ADR 0005).
- The `exercise` layer's fixed-step runner converts caller-supplied real-time
  deltas into whole ticks. It carries the remainder (exposed as the interpolation
  `alpha`), applies a time scale, supports pause, and caps ticks per call to avoid
  a spiral of death; excess time is dropped and reported. It never reads a clock.
- The browser app pauses on `visibilitychange` (hidden tab) and discards the gap
  on return. Headless tools call the runner with an unbounded tick cap.
- `sim` and `exercise` may not use `Date`, `performance`, timers or
  `requestAnimationFrame` (lint-enforced, ADR 0001).

## Consequences

- Behavior is identical in the browser, in Node and in tests; faster-than-real-time
  execution is just a loop.
- Views interpolate between the previous and current tick using `alpha`.
