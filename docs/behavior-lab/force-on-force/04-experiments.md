# Force-on-Force 04: experiments, sweeps, determinism and performance

- Status: done (F5; actions on contact added 2026-10-15)
- Date: 2026-10-14, updated 2026-10-15
- Part of: [Force-on-Force Lab](README.md)

**Everything below is measured output of an experimental simulation model.** It is not
a statement about real-world combat. The parameters were not tuned to favour either side;
the sides have the same organization and the same weapon categories. Where the
outcomes differ between the sides, that comes from chance, from the seeded terrain, and from
which force sees the other first.

## 1. Running them

| What                                                   | Command                                                                                             | Time                                             |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Unit and scenario tests (in `npm run check`)           | `npx vitest run src/sim/fof src/exercise/force-on-force src/view3d/force-on-force`                  | ~30 s                                            |
| The thirteen experiments, seeds 1–3                    | `AMBUSH_FOF_EXPERIMENTS=1 npx vitest run tools/fof-experiments.test.ts --silent=false`              | ~10 min                                          |
| A 50-seed sweep of one terrain                         | `AMBUSH_FOF_SWEEP=50 AMBUSH_FOF_TERRAIN=open npx vitest run tools/fof-sweep.test.ts --silent=false` | ~6 min each (run the three terrains in parallel) |
| The scalability test (N squads a side, both attacking) | `AMBUSH_FOF_SCALE=38 npx vitest run tools/fof-scale.test.ts --silent=false`                         | ~13 min at 38 squads (988 soldiers)              |

The experiment definitions are in `src/exercise/force-on-force/experiments.ts`; the lab
offers the same list.

## 2. The thirteen experiments (seeds 1–3, default configuration unless stated)

| #   | Experiment                                  | Setup                                                                                                     | What is checked (over the seeds)                                                                                                                             | Result                                                                                                                                                                                                                                     |
| --- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Approach in open terrain                    | Two squads in wedge, 1.4 km apart, each ordered to the other's start                                      | Both detect, an engagement happens, an outcome is reached                                                                                                    | ✓ mutual disengagement (933 s), BLUEFOR victory ×2 (822, 689 s)                                                                                                                                                                            |
| 2   | Contact at different observation distances  | The same, on open ground, under clear, urban-haze and restricted conditions                               | Confirmed detection farther in clear air than in restricted visibility, every seed                                                                           | ✓ e.g. seed 1: 668 m clear vs 242 m restricted                                                                                                                                                                                             |
| 3   | One squad detects the other first           | OPFOR kneeling and still in a line, facing BLUEFOR walking in upright                                     | The still force confirms first in most seeds                                                                                                                 | ✓ 3/3 (OPFOR first)                                                                                                                                                                                                                        |
| 4   | Simultaneous detection                      | Mirror-image squads, both moving                                                                          | First confirmed detections within 60 s of each other in most seeds                                                                                           | ✓ 2/3 (Δ 2 s, 51 s; 194 s in seed 3)                                                                                                                                                                                                       |
| 5   | Delayed detection in wooded terrain         | The approach on wooded and on open ground                                                                 | Confirmed detection later and closer in the woods, every seed                                                                                                | ✓ 3/3; outcomes in the woods: mutual disengagement, BLUEFOR withdrawal, stalemate                                                                                                                                                          |
| 6   | Temporary loss of contact                   | BLUEFOR still, watching; OPFOR walks across 450 m away (beyond engagement range) through woods            | Contacts lost and regained; no contact (engagement) at all                                                                                                   | ✓ 2/3 cycling (up to 38 lost, 26 regained); `noContact` ×3                                                                                                                                                                                 |
| 7   | Urban line-of-sight obstruction             | The approach through the urban district                                                                   | Under half of the looks that could detect have any sight line                                                                                                | ✓ every seed                                                                                                                                                                                                                               |
| 8   | One organization becomes combat ineffective | A squad (13) against a fire team (4)                                                                      | The fire team is broken in most seeds                                                                                                                        | ✓ 3/3 BLUEFOR victory                                                                                                                                                                                                                      |
| 9   | Ammunition exhaustion                       | Light load: rifles 40 rounds, automatic rifles 120                                                        | Most of the load fired, never below zero                                                                                                                     | ✓ outcomes: mutual disengagement ×3 (withdrawals for low ammunition)                                                                                                                                                                       |
| 10  | Engagement reaching a bounded stalemate     | Squads prone and still, 560 m apart, engage range 600 m (only the automatic rifles reach)                 | Adjudicated stalemate in most seeds, with the real casualties                                                                                                | ✓ 3/3 stalemate ("no hits" in the window)                                                                                                                                                                                                  |
| 11  | Both organizations disengage                | Cautious forces: withdraw below 0.97 effectiveness or when suppressed > 0.1 for 3 s                       | Mutual disengagement in most seeds                                                                                                                           | ✓ 3/3                                                                                                                                                                                                                                      |
| 12  | Replay and restoration during an engagement | The default approach                                                                                      | Snapshot 20 s into the firefight, restored and continued; replay from the commands; the same run at 120 Hz                                                   | ✓ all bit-identical; same outcome at the same moment at 30 and 120 Hz                                                                                                                                                                      |
| 13  | Actions on contact in the urban district    | The urban approach; BLUEFOR attack or withdraw against OPFOR continue, attack or withdraw (four variants) | Withdrawing forces break contact at once, never halting to fight first; attackers that halt in contact assault; only attackers assault; no rejected commands | ✓ every seed and variant. Attack vs continue: mutual disengagement, BLUEFOR withdrawal, OPFOR victory; withdraw vs continue: BLUEFOR withdrawal ×3; attack vs attack: 2 BLUEFOR, 1 OPFOR victories; attack vs withdraw: BLUEFOR victory ×3 |

Experiment 4 shows the spread there is: even with nothing to choose between the sides,
the first glimpse can come a minute or more apart, because the per-pair thresholds
and the draws differ.

## 3. Seed sweeps (50 seeds per terrain, 30 Hz, two 13-soldier squads)

The default approach (`open-approach`, `wooded-delay`, `urban-sight-lines`).
Distributions are p10 / p50 / p90. "Per side" measures pool both sides (100 values).

| Measure                                | Open              | Wooded            | Urban             |
| -------------------------------------- | ----------------- | ----------------- | ----------------- |
| Ended by a stated rule                 | 50/50             | 50/50             | 50/50             |
| Decisive / adjudicated / invalid       | 50 / 0 / 0        | 47 / 3 / 0        | 42 / 8 / 0        |
| BLUEFOR victory / OPFOR victory        | 24 / 20           | 7 / 11            | 7 / 9             |
| BLUEFOR / OPFOR withdrawal             | 2 / 1             | 8 / 18            | 6 / 10            |
| Mutual disengagement                   | 3                 | 3                 | 10                |
| Stalemate / time limit                 | 0 / 0             | 3 / 0             | 6 / 2             |
| First possible contact range (m)       | 870 / 1047 / 1151 | 93 / 421 / 644    | 99 / 584 / 723    |
| First confirmed detection range (m)    | 642 / 771 / 999   | 62 / 358 / 584    | 89 / 469 / 638    |
| First confirmed detection time (s)     | 164 / 249 / 300   | 303 / 392 / 477   | 319 / 444 / 695   |
| First identification range (m)         | 305 / 327 / 348   | 28 / 312 / 341    | 89 / 295 / 335    |
| Contacts lost per side                 | 4 / 8 / 16        | 4 / 13 / 34       | 4 / 9 / 23        |
| Engagement duration (s)                | 138 / 241 / 472   | 217 / 461 / 720   | 310 / 578 / 1109  |
| Rounds fired per side                  | 836 / 1502 / 2232 | 424 / 1522 / 2719 | 144 / 606 / 1484  |
| Casualties per side                    | 2 / 7 / 9         | 1 / 5 / 8         | 1 / 5 / 8         |
| Casualties per run (both sides)        | 10 / 12 / 14      | 6 / 9 / 12        | 7 / 10 / 12       |
| Experiment end (s)                     | 579 / 693 / 902   | 647 / 896 / 1163  | 847 / 1188 / 1722 |
| Invariant failures / rejected commands | 0 / 0             | 0 / 0             | 0 / 0             |
| Re-run of 5 seeds identical            | 5/5               | 5/5               | 5/5               |

Re-run on 2026-10-15 after a fix to withdrawal orders (see the journal): detection
figures are unchanged, outcomes after a withdrawal differ in some seeds. Both forces
use the default actions on contact (`continue`).

**Reading it.**

- **Open ground** is lethal and quick. Squads see each other near the 1.2 km
  observation limit, close to 300 m and fight it out. One side becomes combat ineffective
  (often while trying to withdraw under fire) in 46 of 50 runs.
- **Woods and town** cut detection to a few hundred metres (sometimes under 100 m), and
  lose and regain contact far more often. They spread the outcomes: withdrawals, mutual
  disengagement, adjudicated stalemates.
- **Side balance.** Victories plus the other side's withdrawals:
  - open: BLUEFOR 25, OPFOR 22;
  - wooded: BLUEFOR 25, OPFOR 19;
  - urban: BLUEFOR 17, OPFOR 15.

  None of these is distinguishable from chance at this sample size (wooded is the
  widest, p ≈ 0.45). Seeds move both forces through different woods and streets.

- **Earlier one-sidedness found and fixed.** During development, soldier order gave
  BLUEFOR the first shot within a decision, and cautious forces were destroyed while
  withdrawing without returning fire. Both were fixed in the model, not by tuning
  ([03 §7](03-model.md)).

## 4. Determinism: what is guaranteed

| Guarantee                                                                                                                               | Status                                                                                     | Evidence                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Same spec (scenario, organizations, orders, seed, configuration) and tick rate, same JavaScript engine build: the same run, bit for bit | **Holds**                                                                                  | Repeat tests; the sweeps re-run five seeds per terrain and compare final state hashes; replays check every second                       |
| Different seeds give different runs                                                                                                     | Holds                                                                                      | `detection.test.ts`                                                                                                                     |
| Snapshot and restore during movement, after detection, and during the engagement                                                        | Holds                                                                                      | `detection.test.ts`, `engagement.test.ts`, experiment 12                                                                                |
| Save, load and replay (re-simulation from the recorded commands, checking each second's hash)                                           | Holds                                                                                      | `session.test.ts`; in the browser, 793 s of the demonstration replayed with no mismatch                                                 |
| Tick rates whose ticks end on the 0.1 s decision grid and divide the movement engine's 120 Hz substeps                                  | **Bit-identical** at 10, 30, 60 and 120 Hz (tested); expected but untested at 20 and 40 Hz | 10, 30, 60 and 120 Hz through detection; 30 and 120 Hz through the firefight and to the same outcome at the same moment (experiment 12) |
| Other tick rates (1–240 Hz)                                                                                                             | Deterministic, not identical                                                               | Decisions are taken at the end of the first tick after each grid time; movement uses inexact substeps (ADR 0053)                        |
| The game's pinned state hashes                                                                                                          | Unchanged                                                                                  | `determinism.test.ts` and the whole suite. The force-on-force state is absent from every game state                                     |
| **Across JavaScript engines or engine versions**                                                                                        | **Not established**                                                                        | See below                                                                                                                               |

**Across engines.** Node 24 and Chrome (both V8, different builds) ran the demonstration
identically for 3 s.

- Then one soldier's facing differed in the last bit: `3.173241135390884` against
  `3.1732411353908843`.
- The cause is the movement engine's trigonometry (`Math.atan2` and kin). ECMAScript does
  not require it to be correctly rounded.
- The difference came and went: 81 of 793 per-second hashes differed. The run still
  reached the same outcome at the same tick.
- So a recording made in the browser replays exactly in that browser. It is not
  guaranteed to replay to the same hashes in Node, or in another browser.
- The game's own determinism has the same scope.

**Random numbers** all come from the simulation's own generator, drawn in a fixed order
on the decision grid. No draw depends on the frame rate, the playback speed, the wall
clock, or the order in which the page asks for things.

## 5. Performance

All figures are for two squads (26 agents, one engagement), headless in Node, on the
development machine, with three sweeps running in parallel.

| Terrain | Simulation CPU per simulated second (p10 / p50 / p90) | Ticks per CPU second at 30 Hz (p50) | Heap after 50 runs |
| ------- | ----------------------------------------------------- | ----------------------------------: | -----------------: |
| Open    | 9.4 / 11.0 / 12.7 ms                                  |             2,723 (≈ 90× real time) |              79 MB |
| Wooded  | 6.4 / 7.5 / 9.3 ms                                    |                      3,986 (≈ 130×) |              34 MB |
| Urban   | 8.9 / 11.3 / 16.5 ms                                  |                       2,666 (≈ 90×) |              45 MB |

- **The 2026-10-15 re-run,** sweeps one after another rather than in parallel: p50 5.6
  (open), 4.0 (wooded) and 6.6 ms (urban) per simulated second. The difference from the
  table is machine load, not the model.
- **In the browser:** about 0.06 ms per tick on average in the open (p95 0.2 ms) and
  0.17 ms in town (p95 0.4 ms), at 57 fps at 32×.
- **Where the cost goes:** looks. Each soldier looks every second at every enemy in range
  and in his field of regard, with three sight lines per look. They use the fast tracer
  that is proven equal to the reference.

### 5.1 Scalability: up to 988 soldiers, both forces attacking (2026-10-15)

`tools/fof-scale.test.ts` (opt-in) builds two forces of N rifle squads each
(`count` in the run spec: the copies under one parent unit, in a block of squads
60 m apart). The blocks start 1 km apart on open ground, each is ordered to the
other's start, and both attack on contact. With squads as its elements, a force
attacks by fire and movement one squad at a time. Open ground is the worst case for
detection, since everyone is in view.

The runs are headless in Node, one at a time, at 30 Hz, on the development machine.
This is the current code: sight lines that cannot detect are skipped, and a look's
sight lines are walked together (both below):

| Soldiers (squads a side) | CPU per simulated second, before contact | After contact | Worst tick | Whole run                                                     | Heap   |
| ------------------------ | ---------------------------------------: | ------------: | ---------: | ------------------------------------------------------------- | ------ |
| 52 (2)                   |                                     7 ms |          5 ms |      17 ms | 496 s simulated in 2.9 s (OPFOR victory)                      | 44 MB  |
| 208 (8)                  |                                    41 ms |         23 ms |      43 ms | 708 s simulated in 21 s (OPFOR victory)                       | 109 MB |
| 494 (19)                 |                                   153 ms |         73 ms |      75 ms | 983 s simulated in 92 s (BLUEFOR withdrawal)                  | 126 MB |
| 988 (38)                 |                                   484 ms |        266 ms |     222 ms | 813 s simulated in 268 s, 3× real time (mutual disengagement) | 110 MB |

- **Everything holds at full size.** Every run ended by a stated rule, with no refused
  movement orders and no broken invariants. Squads bounded in turn: 29 bounds at 988
  soldiers.
- **The cost is detection,** and it grows with the square of the soldiers. Each
  observer looks at every enemy in range once a second, and a look traces three sight
  lines.
  - At 988 soldiers before contact, before the shared walk: looking was 85 % of the time
    (sight lines alone 74 %), the movement engine 10 %, and the forces' decisions,
    bounding included, 2.5 %.
  - After contact the cost falls as casualties and lost contacts thin the pairs.
- **Real time.** At 30 Hz a tick has 33 ms.
  - At 988 soldiers the whole battle runs 3× faster than real time, and 2× before
    contact.
  - At 494, 11×; at 208, 34×.
- **The first measurements were higher, and partly inflated.** The first table (the
  same runs before both optimizations) gave 1.78 s per simulated second before contact
  at 988. That run shared the machine with other load. Measured again in the same
  conditions as the current code, the code with only the first optimization did
  680 ms. So the shared walk gives about 1.8× on top of it, not the 3.7× the two
  figures suggest.

**In the browser** (measured before the worker and the shared walk, below).
`#force-on-force?experiment=scale` (experiment 14) runs the 988-soldier battle in the
lab. In Chrome on the development machine the page drew at about 4 frames a second, and
the battle played at about 0.4–0.5× real time.

- Drawing is the limit, not the simulation. Rendering is 57 % of the time (the soldiers
  drawn one by one, and again for shadows), posing the soldiers 22 %, and the
  simulation 17 %.
- **Two lab changes for runs this large:**
  - The page steps the simulation for at most 40 ms a frame, so it keeps drawing.
    Before, at 32× a single frame took seconds.
  - Keyframes for scrubbing are taken every 5 s per 100 soldiers begun: every 50 s at 988.
- The motion log keeps every soldier's position at every tick, about 1 MB per
  simulated second at this size. A whole battle is about 1 GB in the page.

**The simulation alone in the browser** (before the worker and the shared walk):
`#force-on-force?experiment=scale&soldiers=dots`. `soldiers=dots` draws soldiers as
dots on the overlay instead of animated characters. It is temporary, until the
characters get levels of detail. In Chrome, playing at 32× (as fast as it goes):

| Simulated time                          | Simulated seconds per second | Frames per second | Heap       |
| --------------------------------------- | ---------------------------: | ----------------: | ---------- |
| 0–60 s (approach, far apart)            |                    1.4 – 2.8 |                14 | 200–340 MB |
| 60–230 s (closing, all in view)         |                   0.65 – 1.3 |            6 – 13 | 210–600 MB |
| 230–300 s (contact; bounding by squads) |                   0.75 – 1.0 |            7 – 10 | 460–730 MB |

The slowest stretch, just before contact, runs at 0.65× real time. Chrome's engine ran
it faster than Node did headless.

**Found and fixed: sight lines traced for nothing.** A pair can only detect while its
P∞ exceeds its threshold (drawn at the start). Every look traced its three sight
lines before that test, so most looks at long range traced for nothing. A look now
first computes P∞ for the best case: all of the target in view, nothing in the way.
Only if that clears the threshold does it trace.

- **Nothing in the run changes.** Below the threshold no random number is drawn. Open,
  wooded and urban seeds 1–2, default and attacking, gave identical states, outcomes,
  glimpses, bursts and hits before and after.
- **Speed:** 5× at 208 soldiers before contact (366 → 71 ms per simulated second).
  The 494-soldier run before contact went from 1.98 s to 0.35 s per simulated second.
- **One statistic changed.** `visibleAttempts` now counts, among the looks that could
  detect (`tracedAttempts`), those with a sight line. Experiment 7 checks that share,
  and gave the same outcomes as before.

**Done since: one walk for a look's sight lines.** A look's three sight lines (to
the target's feet, middle and head) share their map path. They cross the same grid
lines and buckets, and the same buildings and vegetation, at the same ground heights.
Only the heights differ.

- **`clearCount`** walks the path once, with one lane per height. Each lane checks
  each piece with exactly the operations `walk` uses for that line. A lane stops at its
  first obstruction; the walk stops when every lane has.
- **Exact.** A test of 4,000 random lines on rough ground with buildings and
  vegetation, at 1–4 heights, compares it with `blocked` and the reference
  `traceSightLine`. The force-on-force runs (open, wooded, urban, seeds 1–2, default
  and attacking) are bit-identical before and after.
- **Speed:** about 1.8× before contact at 988 soldiers (680 → 484 ms per simulated
  second over the first 120 s, both measured in the same conditions). Fire's exposure
  check uses it too.

**Done since: the simulation runs in a worker.** The lab runs its session in a Web
Worker (`sim.worker.ts`; `session-host.ts` on the worker side,
`worker-session.ts` on the page's).

- **The page never waits for the simulation.** It asks for ticks at the speed chosen
  and draws whatever the worker has posted: each tick's soldiers (packed into typed
  arrays, for the motion log), events, metrics, hashes, keyframes, and the state at
  most every 150 ms.
- **Scrubbing back** re-simulates on the page from the keyframes, as before.
- **Exact.** A test joins the two sides with a channel that copies messages as a
  worker does. It checks the same hashes, motion, events, samples, metrics and state as
  the in-page session, recording and replay with every hash checked, scrubbing, and
  branching.
- `&worker=0` in the address runs the session on the page as before.

**In Chrome with both** (988 soldiers, dots, 32×): 60 fps throughout. The battle plays
at 1.2–3.3× real time (never below real time; before, 0.65× at worst, at 6–14 fps).

**Next, if larger forces are wanted:**

- give looks a spatial index or a nearest-first budget (no longer exact: the order of
  draws changes);
- levels of detail for the characters (with characters, drawing is the limit).

## 6. Which parameters rest on research

**From the literature** ([02](02-detection-research.md)):

- the structure of detection: cycles across the target, the target transfer probability
  function, the exponential search-time law with an asymptote, and Koschmieder's haze law;
- the Johnson criteria (as N50 values applied outside their domain);
- the normal acuity scale.

**Experimental approximations:**

- every value applied to the naked eye (cycle angle, contrast and clutter, attention,
  movement and firing cues, confidence and hysteresis);
- all fire, suppression, effectiveness, contact-behaviour and termination values in
  `fof-v1.json`, including the actions-on-contact values `assaultAfterSeconds` (8 s)
  and `assaultRetargetM` (30 m), and the fire-and-movement values `boundLengthM`
  (40 m), `boundPaceMps` (3 m/s), `boundRestSeconds` (6 s) and `boundSearchDegrees`
  (60°).

The basic loads (210 rounds per rifle, 600 per automatic rifle) are of the order
commonly cited for a Marine rifleman and automatic rifleman, but are used here only as
illustrative quantities. None of these values is validated military data.
