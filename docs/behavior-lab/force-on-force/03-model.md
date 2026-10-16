# Force-on-Force 03: the model

- Status: F3 (contact, engagement, lifecycle and outcomes)
- Date: 2026-10-14
- Part of: [Force-on-Force Lab](README.md)

All values are in `src/exercise/forces/fof-v2.json`. They are **experimental,
illustrative parameters** for a constructive simulation prototype, not validated
lethality or behaviour data. Detection is described in [02](02-detection-research.md).

## 1. Architecture

- **One system, `updateForceOnForce`,** runs last in each tick (after movement and the
  game's combat). It does nothing unless the world has a force-on-force setup.
- **Decisions on a grid.** Decisions are taken on a fixed grid of simulation times
  (`decisionHz` 10: every 0.1 s), each at the end of the tick that reaches it.
  - On every tick rate whose ticks end on the grid (10, 30, 60, 120 Hz), runs are
    **bit-identical**.
  - Other rates are deterministic, but take decisions up to a tick late.
- **One decision, in order:**
  1. motion (each soldier's speed since the last decision);
  2. suppression recovery and thresholds;
  3. looks (detection draws);
  4. tracks age and change level;
  5. each force decides, and its soldiers carry it out;
  6. bursts due;
  7. effectiveness;
  8. (F3) adjudication.
- **One random-number stream.** Every random number comes from `SimState.rng`, in
  that order.
- **State** is plain data in `SimState.fof`: forces, members, tracks and pair
  thresholds. Events are plain facts:
  - `contactObserved`
  - `forcePhaseChanged`
  - `fofFire`
  - `suppressionChanged`
  - `soldierIncapacitated`
  - `fofEnded`
- **Forces and soldiers.** The organizational behaviour is per force. Soldiers carry it
  out: posture, facing, fire and movement. Movement is the Behavior Lab's unit tasks.
  No soldier has a planner of his own.

## 2. Organizational states

```
moving / atObjective ─ possible or distant contact ─▶ possibleContact   (halt, kneel, observe)
possibleContact ─ hold over, nothing within range ─▶ moving (alert)       (or atObjective)
any ─ confirmed contact within engageRangeM, or under fire ─▶ contact     (halt, go prone, engage)
contact ─ first burst fired ─▶ engaged
contact / engaged ─ no contact, no fire for contactLostSeconds ─▶ holding
holding ─ contact within range, or fire ─▶ contact
holding ─ resumeAfterSeconds, recovered ─▶ moving (its mission)
```

| Parameter                    | Value   | Meaning                                                                           |
| ---------------------------- | ------- | --------------------------------------------------------------------------------- |
| `possibleContactHoldSeconds` | 20 s    | How long a force halts to observe a possible or distant contact                   |
| `reobserveSeconds`           | 120 s   | After carrying on, how long before a new possible contact halts it again          |
| `engageRangeM`               | 300 m   | A confirmed contact this close puts the force in contact                          |
| `contactLostSeconds`         | 40 s    | No confirmed contact and no fire (either way) for this long: holding              |
| `resumeAfterSeconds`         | 20 s    | Holding this long, the force resumes its mission (if recovered, below)            |
| `resumeSuppression`          | 0.25    | Recovered: mean suppression worn off to this, and not spent (below)               |
| `reactionDelay`              | 0.4–2 s | Each soldier's own delay before taking up his posture and firing (drawn per halt) |

- **Recovered, or spent.** Effectiveness is strength × ammunition × leadership × (1 −
  0.5 × mean suppression). Only suppression wears off: casualties and lost leaders do
  not come back, so the first three, the _lasting effectiveness_, never rise again.
  A force has **recovered** from a fight when its mean suppression is down to
  `resumeSuppression` (0.25) and its lasting effectiveness is still at least
  `withdrawEffectiveness` (0.5). Below that it is **spent**: it holds until the player
  orders it on. (Until v2.4 a force resumed only at effectiveness 0.6. A force its
  losses had left between 0.5 and 0.6, such as 8 of 13 up with 2 of 4 leaders, 0.54,
  neither withdrew nor ever resumed: it held for good.) The same test decides when a
  force that broke contact on its own starts its next order.
- **Halting** keeps the force's movement order as its _mission_ and cancels its unit
  task (the movement engine's own cancel). **Resuming** re-issues the mission as a unit
  order, so the leader steps off and the others fall in (Behavior Lab "falling in").
- **A force under fire** halts in contact at once. It also gets a possible contact on
  the shooter (sound, impacts), so it turns toward him and looks there, even if it had
  seen nothing.
- **No outside orders in contact.** While a force is in contact (or withdrawing, or done),
  an outside unit order to it is rejected (`commandRejected: unitInContact`). Its
  contact behaviour is the only thing moving it, so no soldier is ever under two
  conflicting movement controls.
- **Not modelled:** cover-seeking, flanking, or choosing firing positions. The force
  fights where it halted, or (attacking) bounds straight at the enemy (§2.2).

### 2.1 Actions on contact

Each force is given what it does when it comes into contact (`actionsOn` in its setup;
the lab's **Actions on contact** list). "Contact" is the same for all three: a
confirmed contact within `engageRangeM`, or fire on the force. Possible and distant
contacts still halt it to observe, as above.

| Action               | On contact                                                                                                                                                                                                                  | Afterwards                                                                                                                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `continue` (default) | Halts, goes prone and returns fire where it is (the states above)                                                                                                                                                           | Contact lost: holds, then resumes its movement order. It may meet the enemy again further on                                                                                                                                                    |
| `attack`             | Halts and returns fire, as `continue`. After `assaultAfterSeconds` (8 s) to locate the enemy, it **assaults** where it believes the enemy is (the centre of its current confirmed contacts) **by fire and movement** (§2.2) | It follows the believed position as it moves. Within `assaultRetargetM` (30 m) of it, it halts and fights, and assaults again if the enemy is seen elsewhere. On the objective with no contact: holds, then resumes its original movement order |
| `withdraw`           | Breaks contact **at once**, without halting first: a movement order back to where it started (its start point in the setup)                                                                                                 | Withdrawn as below. With no way back it halts to fight, and tries again every 10 s                                                                                                                                                              |

```
attack:   contact ─ assaultAfterSeconds, enemy located, farther than assaultRetargetM ─▶ assaulting
          assaulting ─ within assaultRetargetM of the enemy (or no element can move) ─▶ contact
          assaulting ─ on the objective, no contact ─▶ holding ─▶ moving (original order)
withdraw: moving / atObjective / possibleContact / holding ─ contact ─▶ withdrawing (to its start)
```

- **Withdrawing soldiers fire on the move** at what they can see (× 0.3 accuracy while
  moving; standing, so easier to see and hit), keeping their last rounds.
- **Pinned soldiers** of a moving force are held where they are until they recover,
  as on any move.
- **The spent-force rules of §7 still apply.** An attack that loses half its
  effectiveness, or stays suppressed, breaks off and withdraws (an attacker away from
  the threat; a `withdraw` force back to its start). "Continue" is not "regardless of
  losses".
- **Outside orders** are rejected while a force is assaulting, as in contact.

### 2.2 Fire and movement

An attacking force assaults by **bounding**: one element moves while the rest of the
force stays down and fires (the base of fire); then the next element moves, in turn.

- **Elements.**
  - A force with two or more subordinate units (a squad): each fire team is an
    element, ordered as itself (the movement engine plans a unit's route from its
    leader, so the team's route starts from its team leader). The squad leader is
    the last element of the rotation, and bounds on his own.
  - A force without subordinate units (a fire team, a 3-Marine element): its
    soldiers in two halves, in formation order, the leader with the first.
  - A single soldier: no fire and movement; he moves alone.
- **A bound.**
  - The next element rushes up to `boundLengthM` (40 m) at `boundPaceMps` (3 m/s)
    toward where the force believes the enemy is, to a **firing position** (below).
    It never goes closer than half of `assaultRetargetM`. It moves in its own part of
    the force's formation, through the movement engine.
  - Bounding soldiers do not fire. They are standing and moving, so easier to see
    and hit.
  - Everyone else is halted in contact: down, facing the enemy, firing aimed or
    area fire at what the force knows.
  - The bound ends when the element reaches its destination (a soldier pinned on the
    way goes down where he is), or, held up, after twice its expected time plus 5 s.
    Its soldiers then go down and, after their reaction delays, fire.
  - The next element bounds once the last has been down `boundRestSeconds` (6 s),
    so that its fire is established.
- **Firing positions.** The element that bounds becomes part of the base of fire, so
  it bounds to a spot it can shoot from.
  - **Candidates:** points at the whole, ¾ and ½ of the bound length, straight at the
    enemy and every 20° up to `boundSearchDegrees` (60°) either side, each moved to
    the nearest reachable ground.
  - **Score:** from three points across the element's front (±7 m), prone (eye at
    0.3 m), the enemy positions the force knows of (its current confirmed contacts:
    its picture, not the truth) with a clear sight line through buildings and terrain,
    each weighted by the light through vegetation.
  - **Choice:** of the candidates seeing at least ¾ as much as the best, the one
    farthest toward the enemy, then the straightest. With no sight from anywhere, that
    is the straight, whole bound.
  - `boundSearchDegrees` 0 turns this off: straight bounds.
- **Which element bounds next.** In turn, from the last; but an element none of whose
  soldiers sees a known enemy from where it lies goes first, since it adds nothing to
  the base of fire there. No element bounds twice in a row unless it is the only one.
- **An element that cannot move** (all of it down, already close, or no way) is
  skipped for the next. If none can, the force halts and fights where it is.
- **Not modelled:**
  - cover (a firing position is chosen for sight, not protection);
  - flanking beyond the 60° search, individual rushes within a team, and assaulting
    through the position.
- **What it changes** (seeds 1–5, [the journal](journal.md)):
  - In town, the base of fire has a sight line to an enemy about twice as often as
    with straight bounds.
  - Against a halted, prone defender, the attack still usually fails in the open, but
    it inflicts real casualties.
  - Attacking a withdrawing force wins every seed.

## 3. Soldiers

- **Taking up the halt.** After his reaction delay, each soldier takes the posture of
  his force's state:
  - kneeling to observe a possible contact;
  - prone in contact;
  - leaders kneel (to see and command).

  He then faces the nearest contact his force knows of.

- **Pinned.** A pinned soldier goes prone. In a moving force he is held where he is
  (the movement engine's `hold`) until he recovers.
- **Individual variation.** Soldiers differ by their drawn reaction delays and cadence,
  by role (leaders kneel and fire half as often; automatic riflemen fire longer bursts
  with more suppression), and by the suppression and exposure each has. There are no
  personalities.

## 4. Fire

A soldier fires when his force is in contact (or engaged, or holding), he has reacted,
is not pinned, and has rounds. A **burst** is one fire event:

1. **Aimed fire.** The nearest engageable contact of his force that he can see
   (sight lines at three heights on the target) and that is within his weapon's range.
2. **Area fire.** Otherwise, the last known position of an engageable contact seen
   within `areaFireMemorySeconds` (20 s), if that point is in his sight and in range.
   Rounds land there: the nearest enemy within the weapon's suppression radius of it
   may be hit (× `areaFireHitFactor` 0.15), and everyone near it is suppressed.
3. Otherwise he looks again in 1 s.

**Rules of engagement** (`engageLevel`):

- `detected` (default): any confirmed contact. In the lab only the two forces are on the
  ground; requiring identification left squads at 300 m unable to fire, since prone
  soldiers are hardly ever identified there.
- `identified`: identified contacts only.

**Resolution:**

- p(round) = curve(range) × posture multiplier (standing 1, kneeling 0.6, prone 0.3) ×
  exposure (share in sight × light through vegetation) × (1 − 0.8 × shooter's
  suppression) × (moving shooter 0.3).
- p(burst hits) = 1 − (1 − p(round))^rounds. **One draw.** On a hit, **one draw** for
  incapacitation (0.5).
- **The burst uses `min(rounds left, rounds per burst)`.** Ammunition never goes
  negative.
- **The next burst:** cadence × U(0.8, 1.25), ÷ 0.5 for leaders, × 2 suppressed,
  × 2 area fire.

| Weapon          | Rounds/burst | Every | Basic load | Hit p (round, standing) by range                     |   Max | Suppression / radius |
| --------------- | -----------: | ----: | ---------: | ---------------------------------------------------- | ----: | -------------------- |
| Rifle           |            2 |   3 s |        210 | 0.5 @0, 0.15 @100, 0.06 @200, 0.03 @300, 0.006 @550  | 550 m | 0.12 / 4 m           |
| Automatic rifle |            5 |   4 s |        600 | 0.4 @0, 0.12 @100, 0.05 @200, 0.025 @300, 0.004 @800 | 800 m | 0.30 / 8 m           |

- **Which weapon.** Each soldier's category is his template primary weapon: SAW gives
  automatic rifle, rifles give rifle. OPFOR uses the same categories (it is drawn with
  AKs), so neither side has better weapons.
- **Provenance.** The game's combat-v1 curves were written for its ambush and are
  documented as gameplay placeholders. These are separate, lower curves, equally
  illustrative ([01 §2](01-inspection.md)).

**Casualties.** An incapacitating hit sets the soldier's `status` to
`incapacitated` (the soldier model's own state) and emits `soldierIncapacitated`. From
then on he:

- is released from any unit task;
- never moves, fires, looks or is a target again;
- has his force's tracks on him closed.

Each soldier falls at most once.

## 5. Suppression

- Each burst adds suppression to the soldier aimed at (weapon's value). Soldiers
  within its radius of the impact get it fading to 0 at the edge, whether it hits or
  not. Prone soldiers take 0.6 of it.
- Suppression halves every 6 s.
- **Levels, with hysteresis:**
  - _suppressed_ from 0.4 until below 0.25;
  - _pinned_ from 0.75 until below 0.55.
- **Effects:**
  - suppressed: half the rate of fire and worse aim;
  - pinned: no fire, prone, and held if on the move.
- The force's mean suppression lowers its effectiveness.

## 6. Effectiveness

`effectiveness = strength × (1 − 0.5 × mean suppression) × ammunition × leadership`

- **strength:** active ÷ initial members.
- **ammunition:** rounds left ÷ basic load, divided by 0.25 and capped at 1, so it
  falls linearly below a quarter.
- **leadership:** 0.75 + 0.25 × (share of leaders still up).

It is tracked separately from strength: a force with most of its soldiers, pinned and
low on ammunition, can be combat ineffective.

## 7. Lifecycle and outcomes

**Withdrawal.** A force in contact (or engaged, or holding) withdraws when any of
these hold:

- effectiveness is below 0.5;
- mean suppression has stayed at 0.55 or above for 45 s;
- ammunition is below 15 % of the basic load.

Broken by the fight like this, it is ordered `brokenWithdrawDistanceM` (500 m) away
from the threat it knows of, out of the reach of the enemy that broke it. (Avoiding
contact, actions on contact `withdraw`, it goes `withdrawDistanceM`, 250 m, or back to
its start in the lab.) It moves through the movement
engine, in its formation. It takes the first heading of 0°, ±30°, ±60°, ±90° from
straight away that has reachable ground. While withdrawing, its soldiers fire on the move at what they can see (× 0.3 accuracy
on the move). They keep their last rounds: no fire below the withdrawal share of their
load. A pinned soldier is held until he recovers.

It has **withdrawn** (terminal) when either:

- it arrives;
- for 30 s it has had no confirmed contact and has not been fired on.

In a battle (no experiment to end) it holds instead. A broken force holds only once it
arrives, 500 m back. Until v2.5 it held once clear of the enemy for 30 s, often only
about 250 m off, where an enemy carrying on with its mission ran into it again and
finished it off. A force avoiding contact still holds once clear.

**Combat ineffective** (terminal): effectiveness below 0.3, or no soldier left. The
force stops, its plan fails, its soldiers stay prone, and it fires no more. In a
battle the player may still order it on, while it has soldiers left. It then carries
out its orders as before, but it stays combat ineffective (`combatIneffective`:
counted so, and never made ineffective again for its effectiveness). Spent, it breaks
contact when it meets the enemy.

**Adjudication**, checked after every decision in this order (the first that holds
ends the experiment):

| #   | Condition                                                                                                                                                                                 | Outcome                                                | Basis                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------- |
| 1   | An invariant broken: negative or fractional rounds, suppression out of [0, 1], a casualty with a burst due, non-finite effectiveness, a halted force with a movement task                 | `invalid` (naming it)                                  | invalid                |
| 2   | Both forces combat ineffective                                                                                                                                                            | `mutualIneffective`                                    | decisive               |
| 3   | One force combat ineffective                                                                                                                                                              | the other side's `…Victory`                            | decisive               |
| 4   | Both withdrawn, or one withdrawn while the other is still withdrawing / one withdrawn                                                                                                     | `mutualDisengagement` / `…Withdrawal`                  | decisive               |
| 4b  | Never in contact, and both done moving (at their objectives) for `disengagementSeconds`                                                                                                   | `noContact`                                            | decisive               |
| 5   | After contact, neither in contact nor firing, no confirmed contact and no fire either way for `disengagementSeconds` (120 s)                                                              | `mutualDisengagement`                                  | decisive               |
| 6   | After contact, both below 5 % of their ammunition                                                                                                                                         | `stalemate` (ammunition exhausted)                     | adjudicated            |
| 7   | Over a 240 s window of contact: no casualties, lasting effectiveness unchanged (< 0.05), and either both forces suppressed (mean ≥ 0.45), no hits, or contact lost and regained ≥ 4 times | `stalemate`                                            | adjudicated            |
| 8   | The maximum duration (1800 s)                                                                                                                                                             | `timeLimit`, or `noContact` if there never was contact | adjudicated / decisive |

- **Stalemate is never "no casualties" alone** (rule 7 needs one of the other
  conditions too).
- **Lasting effectiveness** is strength × ammunition × leadership, without suppression.
  Suppression comes and goes from moment to moment; with it in the measure, the window
  never found "no change".
- **Adjudicated outcomes** record an **advantage**: the side whose effectiveness leads
  by at least 0.15, or none. No hit, casualty or effectiveness change is invented to
  decide an experiment.
- **The outcome record** holds the real casualty counts and both effectivenesses.
  After it, nothing fires and nothing is observed.
- **The forces carry on after the outcome.** A force still in the field resumes its
  original movement order (an attacker goes back to the waypoint it had before
  contact). A withdrawing force goes on to its withdrawal point (or start). A combat
  ineffective force stays down. The lab plays on until they have stopped (at most
  600 s after the outcome); headless runs, the experiments and the sweeps stop at the
  outcome.
- **Bounded.** Every run ends by rule 8 at the latest. Rule 1 turns any broken
  invariant into an explicit, named end, not a hang.

**Fire within a decision is simultaneous.** Bursts are resolved in soldier order, but
their suppression and casualties are applied after all of them, so the order
soldiers are listed in gives no side the first shot. Before this, BLUEFOR (listed first)
won 5 of 6 open-ground runs. After it, over 30 seeds: 17 BLUEFOR victories and 13 OPFOR
(chance level); the first burst came from each side 15 times.

**Refinements found while building the experiments (F4).**

- **No fire while breaking contact was unrealistic.** A withdrawing force that did not
  fire let its opponent fire on it unanswered. With cautious forces, the first to
  withdraw was destroyed in 3 of 3 seeds (8–0). Withdrawing soldiers now fire on the
  move, keeping their last rounds.
- **The first force to finish withdrawing ended the run as a one-sided withdrawal** even
  while the other was still pulling back. Rule 4 now makes that a mutual disengagement.
- **Observation-only runs ran to the time limit.** Rule 4b now ends them once both
  forces have finished moving without ever coming into contact.
