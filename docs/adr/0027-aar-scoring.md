# ADR 0027: After Action Review scoring and recommendations

- Status: Accepted
- Date: 2026-10-10
- Builds on ADR 0026 (the AAR replay) and ADR 0019 (the engagement and its summary).

## Context

After the replay the trainee should see how well the ambush went, as a score out of 100 with a
letter grade, and what to do differently next time. The score must be deterministic, explainable
and computed from what the simulation actually recorded: a metric the simulation cannot measure is
reported as unavailable, never estimated.

## Decision

### One module, separate from the interface

`src/exercise/scoring.ts` exports `scoreEngagement(summary)`. It takes the completed engagement's
`EngagementSummary` (ADR 0019) and returns plain data: whether the assessment is complete, the
total (or `null`), and for each category its points, maximum, raw measurements, the units
concerned, the deductions explained in words, whether it could be evaluated (and why not), and
the recommendations. The same summary always gives the same score. `gradeOf` and `displayPoints`
format it; the interface only draws.

The score is computed from the **live exercise's** completed engagement, once per exercise, never
from a replay view (whose engagement result is the one as at its frame). Scrubbing, playing at any
speed or jumping to either end cannot change it; Try again starts a new exercise and so a new
score.

### The four categories

| Category           | Points | Formula                                                                                    |
| ------------------ | ------ | ------------------------------------------------------------------------------------------ |
| Fire participation | 20     | 20 × eligible Marines who fired ÷ eligible Marines                                         |
| BLUEFOR survival   | 30     | 30 × max(0, 1 − (wounded + 2 × killed) ÷ Marines)                                          |
| OPFOR containment  | 30     | 30 × (1 − OPFOR escaped ÷ OPFOR)                                                           |
| Fire efficiency    | 20     | 20 × clamp((20 − shots per enemy incapacitated) ÷ 19, 0, 1); 0 with no enemy incapacitated |

Points are kept unrounded; the interface shows one decimal and grades the total as shown
(A 90–100, B 80–89, C 70–79, D 60–69, F below 60).

### How the simulation's records are read

- **Eligible Marines** are those with a weapon. The simulation has no fire assignments, and every
  Marine is active when the engagement begins, so none is excused.
- **Casualties.** The only casualty state is _incapacitated_; there is no wounded / killed split.
  An incapacitated Marine counts as **killed** (×2). Wounded is always 0, shown as "not modelled".
- **Escape** is the simulation's own `escaped` outcome.
- **Ammunition.** Rounds are not modelled: a shot is one firing opportunity (an aimed shot or a
  short burst). Efficiency is measured in **shots per enemy incapacitated** and labelled as such,
  never as rounds.

A category the summary cannot support (no summary, an engagement that has not ended, no armed
Marine, no Marines or no OPFOR) is unavailable with its reason, and then the assessment is
**incomplete**: no total and no grade.

### Recommendations

Rule-based, at most one per rule, sorted by severity (high, medium, info), then by the points the
problem cost, then by id:

1. **Not every Marine fired** (medium): any eligible Marine fired no shot. Lists them.
2. **Friendly casualties** (high): any Marine incapacitated. Lists them.
3. **Enemy escaped** (high): any OPFOR escaped. Lists them.
4. **High fire expenditure** (medium): more than 10 shots per enemy incapacitated.
5. **No enemy casualties** (high): nobody incapacitated; replaces rule 4.
6. **Strong overall performance** (info): only when no other rule applies and fire efficiency
   scored at least 16 of 20.

Each carries its observation, the recommendation text, its measurements and the units concerned.

### The interface

Stage 5's side panel gains a **Score** section: the total out of 100 and the grade (or
"Incomplete assessment" naming what could not be evaluated), each category's points with a small
bar and its deductions, and the recommendations as expandable items. The replay controls and Try
again are unchanged.

## Consequences

- The score reflects the simulation's current limits: no wounded, no rounds, no assignments. When
  the simulation models them, the module's readings change, not the interface.
- Recording nothing extra was needed: the engagement summary already holds every count.

## Verification

`src/exercise/scoring.test.ts`: each formula at its edges (all / some / none fired; no casualties
to all killed; no / some / all escaped; 1, 10 and 20 or more shots per kill, and none
incapacitated), the total and grade boundaries, incomplete and missing summaries, determinism,
recommendation selection, deduplication and order, and on the demo exercise that the score is the
same at every replay frame and fresh after a new run.
