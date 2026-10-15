# Force-on-Force Lab: implementation journal

## F1: architecture and detection (2026-10-14) — `320cc73`

**Built.**

- **Kernel module `src/sim/fof`:**
  - configuration and validation (`config.ts`);
  - setup (`setup.ts`);
  - state (`types.ts`);
  - the detection model (`detection.ts`);
  - the system (`system.ts`), with decisions on a 10 Hz grid;
  - the force state machine (`force.ts`), which in F1 only labels moving, possible
    contact and contact.
- **Scenario and world:** `fof` in both, plus `SimState.fof`.
- **Events:** `contactObserved` and `forcePhaseChanged` are emitted. Three more are
  declared for F2–F3: `fofFire`, `suppressionChanged`, `fofEnded`.
- **Exercise layer `src/exercise/force-on-force`:**
  - the configuration file `fof-v1.json`;
  - the run builder (two squads, any lab organization, open / wooded / urban ground);
  - the seeded woodland generator.

**Decisions.**

- **Separate from combat v1** ([01 §2](01-inspection.md)): the game's ambush model is
  one-sided by design.
- **Pair thresholds:** each observer–target pair can detect only while `P∞` exceeds its
  threshold ([02 §2.2](02-detection-research.md)). Treating `P∞` as a rate made
  everyone detect at the observation limit.
- **Recalibration:** a 3′ search cycle; open contrast 0.25.

**Validation.**

- **New tests (19):**
  - unit tests of the detection parts (`src/sim/fof/detection.test.ts`): the TTPF;
    cycles by range, posture, movement and fire; field of regard; building and low-wall
    occlusion; vegetation transmission; confidence and hysteresis;
  - scenario tests (`detection.test.ts`): possible → confirmed → identified at falling
    ranges; consistent level reports; no self-tracking; a tall building hides
    everything; isolation from the game engagement; repeat and seed sensitivity;
    bit-identity at 10, 30, 60 and 120 Hz; snapshot / restore during movement and after
    detection.
- **Cost:** about 10 ms of CPU per simulated second for two squads, open or urban.

## F2: contact and engagement (2026-10-14) — `ef4f1bb`

**Built** ([03 §2–6](03-model.md)):

- **Organizational states:** moving, possible contact, contact, engaged, holding, at
  objective.
- **Halting:** a halt cancels the unit task and keeps the mission; resuming re-issues it.
- **Soldier reactions:** reaction delays, posture, facing, and holding pinned soldiers.
- **Fire:** aimed and area bursts; resolution, ammunition, cadence.
- **Suppression** with hysteresis.
- **Casualties** through the soldier's own status.
- **Effectiveness.**
- **Outside orders:** an outside unit order to a force in contact is rejected
  (`unitInContact`).

**Decisions found by running it.**

- **Re-halting.** A force halted afresh for every new possible contact, stopping every
  30 s on its way in. It now halts again only after `reobserveSeconds` (120 s).
- **Fire deadlock.** Fire at detected contacts only once hostile intent was
  established deadlocked: squads met at 300 m before either had identified anyone, and
  prone soldiers are rarely identified. The default rules of engagement are now
  "confirmed contacts" (the lab has no third party); `identified` remains as an option.
- **Engagement range** of 300 m: forces meeting farther off observe and carry on.

**Validation.** Ten new tests (`engagement.test.ts`):

- halting, contact before engagement, both sides firing;
- tasks cancelled while halted;
- posture in contact;
- bursts only from active soldiers, rounds accounted exactly, ammunition never negative;
- each casualty once, caused by a hit, never moving again, tracks on him closed;
- suppression reports consistent, effectiveness ≤ strength;
- outside orders rejected in contact;
- a force fired on from behind (unseen) halts with reason "under fire" and fires back;
- bit-identical at 30 and 120 Hz into the firefight;
- snapshot / restore during the engagement.

One run (open, seed 1): contact at 300 m at T+451 s; 1,564 bursts and 15 casualties
over the next 7.5 min. About 5–6 ms of CPU per simulated second.

## F3: engagement completion (2026-10-14) — `d19a690`

**Built** ([03 §7](03-model.md)):

- withdrawal (away from the known threat, through the movement engine), withdrawn, and
  combat ineffective;
- the adjudicator: decisive, adjudicated and invalid outcomes, in a stated order;
- stalemate windows on lasting effectiveness;
- mutual disengagement;
- ammunition exhaustion;
- the time limit, and no contact;
- invariant checks.

**Found by running it.**

- **First-shot bias.** Soldier order gave BLUEFOR the first shot within a decision.
  Fire within a decision is now simultaneous.
- **Stalemate window.** The window compared effectiveness including suppression, which
  fluctuates. It now compares lasting effectiveness.
- **Zero-hit configurations** end in withdrawal or ineffectiveness, not stalemate:
  suppression alone breaks a force, and running dry makes it ineffective. These are
  correct consequences of the model. The stalemate experiments switch those exits off
  explicitly.

**Validation.** Eleven new tests (`lifecycle.test.ts`). Each ended run is checked for:

- an outcome before the time limit;
- a stated reason;
- the basis matching the outcome;
- real casualty counts;
- one `fofEnded` event;
- no fire or observation afterwards.

The cases covered:

- open, wooded and urban, two seeds each;
- ineffectiveness, then no fire;
- withdrawal through a unit order, without fire while withdrawing;
- a no-hit stalemate;
- ammunition exhausted;
- the time limit with the advantage rule;
- no contact;
- mutual disengagement;
- a corrupted state ending as `invalid`.

**Trial outcomes** (head-on squads, default parameters):

| Terrain | Seeds | Victories            | Withdrawals        | Mutual disengagement | Stalemate | Time limit |
| ------- | ----: | -------------------- | ------------------ | -------------------- | --------- | ---------- |
| Open    |    30 | 17 BLUEFOR, 13 OPFOR | —                  | —                    | —         | —          |
| Wooded  |    20 | 3 BLUEFOR, 3 OPFOR   | 4 BLUEFOR, 8 OPFOR | 1                    | 1         | —          |
| Urban   |    12 | 4 BLUEFOR, 1 OPFOR   | 2 BLUEFOR, 2 OPFOR | 1                    | 1         | 1          |

## F4: the visual lab (2026-10-14) — `95cca8d`

**Built** ([05](05-lab.md)): the page at `#force-on-force` (`src/view3d/force-on-force`),
with:

- a session: the head run, keyframes and scrubbing, the motion and combat logs for the
  characters, events, per-second hashes, replay verification, save and load;
- two-sided controls;
- perspectives (observer, or each side's own picture);
- nine overlays;
- force panels, an inspector, the event timeline, metrics and a graph;
- an outcome banner;
- woods drawn over the vegetation areas.

The exercise layer gained:

- `metrics.ts` (detection, engagement and quality metrics, per-second samples);
- `experiments.ts` (the default demonstration and 12 experiments);
- replayable runs.

The page is isolated from the game: loaded lazily only at its address, checked by
`force-on-force-isolation.test.ts`.

**Model refinements found while building the experiments** ([03 §7](03-model.md)):

- fire on the move while withdrawing, keeping the last rounds;
- one withdrawn while the other withdraws is mutual disengagement;
- `noContact` once both have finished moving without contact.

**Validation.**

- Session tests: replay through an engagement, saved and loaded, with every second's
  hash matching; the characters get every burst and casualty; scrubbing back during the
  firefight; refusing a foreign file.
- The isolation test.
- Browser: the default demonstration, and wooded and urban runs ([05](05-lab.md)); replay
  verified over 793 s with no mismatch; 57 fps at 32×.

## F5: scenario suite and hardening (2026-10-14) — `b5661a2`

**Built** ([04](04-experiments.md)):

- the twelve experiments, automated over seeds 1–3, each checking its own property
  (`tools/fof-experiments.test.ts`, opt-in);
- the 50-seed sweep per terrain, with distributions, determinism re-runs, invariant and
  rejected-command counts, CPU, ticks per second and heap (`tools/fof-sweep.test.ts`,
  opt-in);
- the sweep runner and summary (`sweep.ts`);
- a fast check that every experiment builds and runs (`experiments.test.ts`, in the
  regular suite).

**Found by the sweeps.**

- **Repeated withdrawal attempts in town.** A force in town tried to withdraw every
  decision (25,424 refused orders in one run). Its withdrawal point was chosen in a
  member's navigation area, but the movement engine plans from the force's centre, which
  stood in another.
  - Withdrawal points are now chosen in the centre's area.
  - A failed attempt waits 10 s before the next.
  - The force's own refused attempts are no longer reported as rejected commands.
  - Sweeps and lifecycle tests now require zero rejected commands.
- **Cross-engine determinism.** Node and Chrome differ in the last bit of the movement
  engine's trigonometry. Bit-identity is documented as holding within one JavaScript
  engine build only ([04 §4](04-experiments.md)).

**Validation.**

- **The experiments:** all twelve pass.
- **The sweeps** (150 runs):
  - all ended by a stated rule;
  - 0 invalid, 0 invariant failures, 0 rejected commands;
  - 15 of 15 determinism re-runs identical.
- **The full repository check** passes.

## Actions on contact (2026-10-15)

**Asked for.** In the urban approach, the squads engaged, took losses, then walked on
toward their waypoints, met again and engaged again, over and over. Each force now has
**actions on contact**, chosen per side in the lab ([03 §2.1](03-model.md)):

- **attack:** halt and return fire, then (after 8 s) assault where it believes the enemy
  is, in formation, firing on the move. Once contact is gone, back to its original
  waypoint.
- **withdraw:** break contact at once and go back to its start.
- **continue:** the behaviour so far (and the default).

**Built.**

- **Kernel** (`src/sim/fof`):
  - `actionsOn` and `start` on each force's setup;
  - a new force phase, `assaulting`, with its objective;
  - the assault (start, follow the believed position, close, arrive);
  - withdrawal to the start;
  - fire on the move while assaulting.
- **The forces carry on after the outcome.** Survivors resume their original movement
  orders and withdrawing forces go on. The lab plays on until they stop (`settled`).
- **The lab:**
  - an **Actions on contact** list per side;
  - a dashed arrow to an assault's objective;
  - experiment 13 (four variants in town).
- **Configuration:** `force.assaultAfterSeconds` (8 s) and `force.assaultRetargetM`
  (30 m), both experimental.

**Found and fixed: withdrawal orders went at the wrong heading.** The force checked
that a movement order had taken by counting the movement engine's tasks. Issuing an
order prunes finished tasks, so the count could fall even though the order had
succeeded. The force then took the order as refused and issued it again at the next
heading (±30°, …). The check is now whether the force has a running task. This changes
some withdrawals, and so some outcomes of the default runs. The F5 sweeps were re-run
([04 §3](04-experiments.md)):

- detection figures are identical;
- open-ground outcomes moved from 25/21/4 to 24/20/3 plus 3 withdrawals.

One lifecycle test that needed a combat-ineffective outcome on seed 1 (now a mutual
disengagement) takes the first of seeds 1–4 that ends in one.

**Validation.**

- **New tests** (`actions-on.test.ts`):
  - an attack returns fire first, then assaults, closes and fires on the move (open
    and urban);
  - the winner of an attack goes back to its original order and reaches it, with no
    fire after the outcome;
  - a withdrawal goes at once, to the start;
  - `continue` is the default and never assaults;
  - repeats are bit-identical, with the same outcome at 30 and 120 Hz;
  - an unknown action is rejected.
- **The thirteen experiments** all pass.
- **The sweeps** (150 runs): all ended by a rule, with 0 invalid, 0 invariant failures
  and 0 rejected commands; 15/15 re-runs were identical.
- **In Chrome** (experiment 13, seed 1): BLUEFOR assaulted (seen at 10:39, arrow drawn), was
  broken in the street (OPFOR victory at 12:47.7), and OPFOR then walked on to its
  waypoint. Play stopped once it arrived. With the list set to withdraw, BLUEFOR broke
  contact at 10:23 and withdrew (BLUEFOR withdrawal at 12:14.6).

**What the runs show (not tuned).** An attack is costly:

- It walks upright and in formation at a halted, prone enemy, firing at × 0.3 accuracy
  on the move.
- Against `continue`, the attacker lost in 3/3 urban seeds, and in 3/3 open seeds of a
  probe.
- Attack against attack is even.
- Withdrawing in the open under fire from 300 m was destroyed in 3/3 probe seeds. In
  town, streets break sight lines and it got away (3/3).

Fire and movement (one element suppressing while another moves) would change this
most; it is not modelled.

## Fire and movement (2026-10-15)

**Asked for.** The attack walked the whole squad at the enemy, upright and in
formation, firing on the move. It now attacks by fire and movement
([03 §2.2](03-model.md)).

**How it works.**

- One fire team, with the squad leader, rushes 40 m at 3 m/s toward the believed enemy
  position, not firing. (Since revised: the squad leader bounds on his own; see the
  next entry.)
- The other teams stay down and fire, as the base of fire.
- 6 s after a team is down and firing, the next team bounds, in turn.
- A fire team or element without subordinate units bounds in two halves.
- Each bound is a movement-engine order to the squad with a reduced formation: the
  squad leader's slot and one team's subtree. The other Marines have no task and stay
  where they are.

**Built.**

- **Configuration:** `boundLengthM`, `boundPaceMps`, `boundRestSeconds` (experimental).
- **Force state:** `bounding`, `boundUnit`, `boundElement`, `boundSince` on the force.
- **The lab:** the force label names the bounding team, and the inspector says whether
  a soldier is bounding or in the base of fire.
- **Assaulting soldiers** no longer fire on the move; withdrawing ones still do.

**Validation.**

- **New tests:**
  - one team (with the squad leader) bounds at a time, by different teams in turn;
  - bounding soldiers never fire, while the base of fire does;
  - the rushes are faster than a walk (open and urban);
  - a fire team bounds in halves of at most two.
- **The force-on-force suite** passes.
- **Experiment 13** passes.
- **The default (`continue`) runs are unchanged.** Open and urban seeds 1–3 give
  bit-identical simulation states and outcomes before and after, so the F5 sweeps
  stand.
- **In Chrome** (experiment 13, seed 1): B-FT1 bounded first, then B-FT2. The label
  showed the bounding team, and the other teams stayed prone behind.

**Seeds 1–5 compared** (BLUEFOR attacks; outcomes, not tuned):

| Against          | Open                                 | Wooded                                  | Urban                                              |
| ---------------- | ------------------------------------ | --------------------------------------- | -------------------------------------------------- |
| OPFOR `continue` | BLUEFOR 1 victory, OPFOR 4 victories | OPFOR 4 victories, 1 BLUEFOR withdrawal | OPFOR 2 victories, 1 mutual, 2 BLUEFOR withdrawals |
| OPFOR `attack`   | BLUEFOR 3, OPFOR 2                   | BLUEFOR 3, OPFOR 2                      | BLUEFOR 3, OPFOR 2                                 |
| OPFOR `withdraw` | BLUEFOR 5                            | BLUEFOR 5                               | BLUEFOR 5                                          |

- **Compared with the walk-in assault:**
  - against a halted defender, the attacker now inflicts 2–8 casualties (before, 0–3);
  - in town, the attack no longer always breaks.
- **Against a prone defender in the open, the attack still usually fails.** It has 300 m
  of open ground to cross, bounding at the enemy's front with no cover.

**Limitations.**

- The base of fire does not choose a position. In town it is often out of sight behind
  a building, with only area fire or none.
- There is no flanking, and no individual rushes within a team.
- The force does not assault through; it closes to 30 m and fights.

## Firing positions for the base of fire (2026-10-15)

**Asked for.** In town the base of fire often lay behind a building with no sight of the
enemy. A bounding element now goes to a **firing position**, and an element that sees
nothing from where it lies bounds first ([03 §2.2](03-model.md)).

**Built.**

- **The firing position.** Each bound ends where the element sees most of what its force
  knows of the enemy:
  - 3 distances × 7 headings (±60° in 20° steps), each moved to the nearest reachable
    ground;
  - scored from three points across the element's front, prone, through buildings,
    terrain and vegetation;
  - of the points seeing at least ¾ as much as the best, the farthest forward.
- **Bound order.** An element that sees nothing from where it lies goes next (never twice
  running).
- **Configuration:** `force.boundSearchDegrees` (60°; 0: straight bounds).

**Two defects of the first fire-and-movement version, found while measuring and fixed.**

- **Routes started from the squad leader.** The squad leader moved with every bound, and
  the movement engine plans a unit's route from its leader. A team bounding from behind
  him got a route from his position (13 m), so it hardly moved.
  - Teams are now ordered as themselves, so the route starts from the team leader.
  - The squad leader is the last element of the rotation.
- **Bounds hit their time limit.** A bound waited for the movement task to settle, which
  waits for every soldier to reach his slot. A soldier pinned on the way never does. The
  bound now ends when the element reaches its destination.

**Measured** (seeds 1–5, BLUEFOR attacking; base of fire = soldiers of the assaulting
force who are down and have reacted, sampled each second; sight = a clear prone sight
line to any active enemy, the truth):

| Terrain, OPFOR does | Base of fire seeing an enemy, straight → firing positions | Outcomes with firing positions                                      | Casualties B / O over 5 seeds, straight → firing positions |
| ------------------- | --------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------- |
| Urban, continue     | 21 % → 40 %                                               | 1 BLUEFOR victory, 1 OPFOR victory, 2 BLUEFOR withdrawals, 1 mutual | 39 / 8 → 29 / 24                                           |
| Urban, attack       | 35 % → 51 %                                               | 3 BLUEFOR, 1 OPFOR victory, 1 mutual                                | 27 / 36 → 19 / 34                                          |
| Wooded, continue    | 78 % → 89 %                                               | 4 OPFOR victories, 1 OPFOR withdrawal                               | 36 / 16 → 34 / 15                                          |
| Wooded, attack      | 75 % → 97 %                                               | 3 BLUEFOR, 1 OPFOR victory, 1 mutual                                | 25 / 27 → 27 / 35                                          |
| Open, continue      | 100 % → 100 %                                             | 3 OPFOR, 1 BLUEFOR victory, 1 mutual                                | 38 / 23 → 34 / 24                                          |
| Open, attack        | 100 % → 100 %                                             | BLUEFOR victory ×5                                                  | 17 / 35 → 15 / 42                                          |

- **What remains.** In some urban seeds the enemy is prone behind a block, with no
  reachable spot within a bound that sees him. The attacker then advances on his last
  known position blind, and the halted defender, who can see it, usually wins.
- **Validation:**
  - a new test shows that, over urban seeds 1–4, the base of fire sees an enemy more
    often with firing positions than with straight bounds;
  - the force-on-force suite passes;
  - the default (`continue`) runs are untouched (only attacking forces bound).

## Scalability test: 988 soldiers (2026-10-15)

**Asked for.** A scalability test with about 1,000 soldiers in the most demanding
behaviour: both forces attacking by fire and movement.

**Built.**

- **`count` in a force's run spec:** N copies of the organization under one parent unit,
  in a block. Soldier ids and slot ids are numbered by copy. A single copy is exactly
  the run as before (identical states).
- **`tools/fof-scale.test.ts`** (opt-in): N squads a side, 1 km apart, both attacking.
  It reports CPU per simulated second every 30 s, before and after contact, the worst
  tick, bounds, refused orders and the outcome.
- **`scale.test.ts`:** the copies build correctly, and two squads a side attack a squad
  at a time with no refused orders.

**Results** ([04 §5.1](04-experiments.md)):

- **988 soldiers:** the whole 813 s battle in 734 s of CPU, about real time. Before
  contact it runs at 1.8× real time; the worst tick is 0.5 s.
- **494 soldiers:** about 3.5× faster than real time.
- **Everything held at full size:** no refused orders, no invalid states, 29 bounds, an
  outcome by rule.

**Found by profiling: detection is the cost.** At 208 soldiers, 91 % of the time was
sight lines traced for looks that could not have detected anyway. P∞ was tested
against the pair's threshold only after tracing.

- A look now tests the best case first and traces only if it could detect.
- This is exact: the runs are identical, since no random number is drawn below the
  threshold.
- It is 5× faster before contact. One diagnostic count, `visibleAttempts`, is now taken
  among the looks that could detect (`tracedAttempts`).

At 988 soldiers, detection is still 85 % of the time. The next steps for larger forces
are in 04 §5.1.

**In the lab:** experiment 14, at `#force-on-force?experiment=scale`.

- In Chrome it draws at about 4 fps and plays at about 0.4–0.5× real time.
- Rendering about 1,000 animated soldiers, not the simulation, is the limit.
- The page now steps at most 40 ms a frame (it froze before), and keyframes are spaced
  by size.
- **`&soldiers=dots`** (temporary) draws dots instead of characters. That isolates the
  behaviours' cost: 0.65–2.8× real time at 6–14 fps, slowest just before contact.

## Known limitations

**Detection.**

- The eye-model values are experimental ([02 §6](02-detection-research.md)).
- There is no reporting delay inside a force, and no localisation error.
- There is no night or sensor model.
- Identification needs recognition-level cycles. In this lab it is informational: forces
  engage confirmed contacts (the rules can require identification).

**Behaviour.**

- A force fights where it halts, or (attacking) bounds toward the enemy, to firing
  positions chosen for sight, not cover. There is no cover-seeking or flanking.
- A withdrawal is one 250 m move away from the known threat. In town it can fail (no
  reachable point); the force then fights on and retries.
- One force per side; the adjudicator assumes two.

**Fire.**

- One burst is one draw.
- There are no grenades or other area weapons beyond area fire at last known positions.
- Hit curves and loads are illustrative.

**Determinism.** It is bit-identical only within one JavaScript engine build.

**View.**

- Woods are simple instanced trees: the game's forest renderer needs its terrain-field
  pipeline.
- Organizational panels are omniscient (labelled so); only the 3D view and its overlays
  follow the chosen perspective.

## Recommendations for the next iteration

1. **Calibrate detection against data.** Field detection trials, or published ranges for
   personnel at known contrast. Replace the experimental eye values, and add a reporting
   delay and localisation error.
2. **Model cover in the halt.** Each soldier takes the nearest covered position within a
   few metres (the clearance field and sight lines already exist). This is the next
   largest effect on outcomes, and it is defensive, not offensive optimisation.
3. **Make detection deterministic across engines.** Use correctly rounded (or table)
   trigonometry in the movement engine's facing, so recordings replay anywhere.
4. **Add a platoon scale** (three squads, several engagements). The decision cost is
   per soldier pair: measure it, and add a spatial index for looks.
5. **Run sensitivity sweeps over the experimental parameters** (contrast, engage range,
   suppression), reporting how outcome frequencies move rather than tuning them.
