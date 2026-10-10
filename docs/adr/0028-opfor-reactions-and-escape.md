# ADR 0028: OPFOR reactions under fire, and escape by distance run

- Status: Accepted
- Date: 2026-10-10
- Amends ADR 0019 (its "OPFOR reactions" and "Escape" rules). Combat configuration 1.1.0.

## Context

Under ADR 0019 each OPFOR soldier's reaction was drawn when the ambush was sprung, prone (60 %) or
flee (40 %), whether or not anyone was shooting at it. A fleeing soldier escaped only once 300 m
from every Marine and out of every armed Marine's range or sight. In an ambush where the Marines
never fired (all placed where they could not see the road), most of the patrol dropped prone and
lay there unthreatened until the time limit, and the few that ran were rarely counted as escaped:
at 4.5 m/s, 300 m and out of sight seldom happened within 60 s. The AAR then showed one escape and
a patrol that "just stood there".

The intended behaviour: once the engagement starts, an OPFOR soldier that is **taking fire** either
runs away from BLUEFOR or goes prone and stays in place; one that is **not taking fire** runs. A
soldier that gets some distance away (50 m) has escaped.

## Decision

- **Under fire** means at least one shot has been fired at the soldier (hit or miss) before its
  reaction comes due (`Combatant.underFire`).
- **The reaction**, when its delay has passed (unchanged: 0.5–2 s after the trigger):
  - not under fire: **flee**;
  - under fire: the reaction drawn for it at the start with `reactionProbabilities` (prone 0.6,
    flee 0.4), kept as `Combatant.reactionIfUnderFire`.

  The draw still happens for every OPFOR soldier when the engagement begins, in soldier order, so
  the random sequence does not depend on who is shot at first. `Combatant.reaction` is now the
  reaction the soldier actually had, `null` until it reacts.

- **Prone** and **flee** themselves are unchanged: a prone soldier stays where it is and returns
  fire; a fleeing one runs away from the centroid of the active Marines at 4.5 m/s along a walkable
  route (or drops prone if there is none). The reaction is made once: a soldier already running
  that then comes under fire keeps running.
- **Escape**: a fleeing soldier escapes at the end of the tick in which it is at least
  `escapeDistanceM` (now **50 m**, straight line) from where it started running
  (`Combatant.fleeFrom`), or when it reaches its flee destination. Being still in sight or in range
  no longer prevents it; it is still a target, and can be hit, until then.
- **End**: "nobody can fire any more" (`noCombatCapable`) waits while any soldier is still
  fleeing, so a patrol running from Marines who cannot fire gets to escape rather than being left
  "surviving, not escaped".

## Consequences

- An ambush that does not open fire lets the whole patrol get away, visibly running in the replay,
  ending in `opforEscaped` within about 15 s. Containment then scores 0 (ADR 0027).
- Soldiers shot at before they react are the only ones that can go prone, so opening fire early
  and accurately matters more.
- 50 m at 4.5 m/s is about 11 s of running: the Marines get that long to engage a runner they can
  see.
- The combat configuration is now version 1.1.0: engagements under 1.0.0 are not reproduced by
  it (the result records the configuration's version and fingerprint, ADR 0019).
- Unchanged limitations: OPFOR do not perceive the trigger any differently from a shot elsewhere,
  shots at a comrade do not count as being under fire, and runners do not seek cover.

## Verification

- `src/sim/combat.test.ts`: soldiers not shot at flee even when they drew prone, and an unopposed
  patrol escapes; a shot at a soldier (a miss) makes it take its drawn reaction while its unshot
  comrade runs; escape at 50 m from where it started (exact tick), still in range and in sight; a
  destination nearer than 50 m is an escape.
- `src/exercise/combat.test.ts`: on the demo, with Marines unable to fire, all three patrol members
  run, end at least 45 m from where they were, and escape in under 15 s (`opforEscaped`).
