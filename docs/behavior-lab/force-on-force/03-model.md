# Force-on-Force 03: the model

- Status: F2 (contact and engagement); F3 adds the lifecycle and outcomes (§7)
- Date: 2026-10-14
- Part of: [Force-on-Force Lab](README.md)

All values are in `src/exercise/force-on-force/fof-v1.json`. They are **experimental,
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
holding ─ resumeAfterSeconds, effective enough ─▶ moving (its mission)
```

| Parameter                    | Value   | Meaning                                                                           |
| ---------------------------- | ------- | --------------------------------------------------------------------------------- |
| `possibleContactHoldSeconds` | 20 s    | How long a force halts to observe a possible or distant contact                   |
| `reobserveSeconds`           | 120 s   | After carrying on, how long before a new possible contact halts it again          |
| `engageRangeM`               | 300 m   | A confirmed contact this close puts the force in contact                          |
| `contactLostSeconds`         | 40 s    | No confirmed contact and no fire (either way) for this long: holding              |
| `resumeAfterSeconds`         | 20 s    | Holding this long, the force resumes its mission (if effectiveness ≥ 0.6)         |
| `reactionDelay`              | 0.4–2 s | Each soldier's own delay before taking up his posture and firing (drawn per halt) |

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
- **Not modelled:** cover-seeking, flanking, pursuit, bounding, or choosing firing
  positions. The force fights where it halted.

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

(F3.)
