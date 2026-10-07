# ADR 0003: Fixed timestep with a configurable tick rate

- Status: Accepted (catch-up budget revised 2026-10-07, see below)
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
  `alpha`), applies a time scale, supports pause, and limits catch-up per call to
  avoid a spiral of death; excess time is dropped and reported
  (`droppedSeconds`). It never reads a clock.
- The browser app pauses on `visibilitychange` (hidden tab) and discards the gap
  on return. Headless tools call the runner with an unbounded catch-up budget.
- `sim` and `exercise` may not use `Date`, `performance`, timers or
  `requestAnimationFrame` (lint-enforced, ADR 0001).

### Catch-up budget

Each `advance` call may step at most the ticks that **100 ms of real time** is
worth at the current time scale and tick rate:

```
maxTicks = max(1, ceil(maxCatchUpSeconds × timeScale × tickRateHz − ε))
```

With `maxCatchUpSeconds = 0.1` at 30 Hz, that is 3 ticks at 1×, 24 at 8× and 48
at 16×. Rounding up (with ε = 1e-9 absorbing floating-point noise) means a frame
of exactly the budget never drops time. Only whole ticks beyond the budget are
dropped; the fraction of a tick carries over as usual. A stall of seconds (a
blocked main thread, a debugger break) simulates 100 ms worth and drops the
rest, reported in `droppedSeconds`.

**Why the fixed cap of 10 ticks was replaced.** A fixed tick count means a
different amount of real time at each time scale and tick rate. At 30 Hz and 16×,
10 ticks are only 20.8 ms of real time: every missed 60 Hz display refresh (a
33 ms frame, which browsers produce routinely) dropped simulation time. In
Chrome and Edge, 16× achieved only 14.1–14.5× (10–12% of simulation time
dropped). A budget in real time gives every speed the same tolerance: ordinary
frames and missed refreshes never drop time, while genuine stalls are still cut
short. Dropping time does not affect determinism; it only means that stretch of
real time was not simulated.

## Consequences

- Behavior is identical in the browser, in Node and in tests; faster-than-real-time
  execution is just a loop.
- Views interpolate between the previous and current tick using `alpha`.
