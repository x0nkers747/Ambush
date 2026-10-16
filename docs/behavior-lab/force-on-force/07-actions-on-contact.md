# Actions on contact (force-on-force model v2.1)

Every order now says what the squad does when it makes contact while carrying
the order out. The player chooses this per order: in planning, with the **On
contact** drop-down beside each order's kind; in combat, with the **On
contact** drop-down under the order tools, applied to the orders given next.
The same version fixes four faults that made a meeting in woods last about
twenty minutes with almost no fire (§3).

## 1. The four actions on contact

| Choice (UI)  | `ActionsOn` | On contact the squad…                                                                                                                                                                                                                                                                      |
| ------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Continue** | `continue`  | halts and fights from where it is. When it has had nothing to engage for `pressOnSeconds` (45 s: no aimed fire since contact, and it is not suppressed), it presses on toward its waypoint for 45 s, firing on the move at anything it sees, and does not halt again for the same contact. |
| **Attack**   | `attack`    | shifts into its extended line (the squad's `line`, the fire team's `skirmishers`) and assaults the enemy by bounding elements; afterwards it carries on with its plan, or withdraws when spent.                                                                                            |
| **Hold**     | `hold`      | halts, fights whatever it can see from there and waits indefinitely. Its order stays active; it moves only on a new order (or breaks contact if it becomes spent).                                                                                                                         |
| **Avoid**    | `withdraw`  | falls back a short way from where it is at once, at any range it sees the enemy, then holds. It does not fire unless it has been fired upon in the last 60 s.                                                                                                                              |

By default each order kind has its own: a Move continues, an Attack attacks, a
Withdraw avoids. Changing an order's kind changes its actions on contact only
if they were still the old kind's default. A three-man element has no line
formation, so it assaults in the formation it is in.

The choice is stored on the order (`PlannedOrder.actionsOn`, `OrderSpec.actionsOn`,
`FofOrder.actionsOn`). When an order starts, it becomes the force's
`actionsOn`. A saved scenario carries it as the order's optional `actionsOn`;
older scenarios without it read their kind's default.

## 2. Where it lives

- `src/sim/fof/types.ts`: `ActionsOn`, plus the force state `contactAt`, `lastAimedFireAt`
  and `pressOnUntil`, and the soldier's `postureAt`.
- `src/sim/fof/force.ts`: the phase decisions; `pressingOn`, `nothingToEngage` and `postureToSee`.
- `src/sim/fof/fire.ts`: fire on the move while pressing on, and the avoid force's hold-fire rule.
- `src/sim/fof/lifecycle.ts`: the spent-withdrawal check that no longer flip-flops.
- `src/exercise/forces/forces.ts`: `assaultFormationId` and the squad's `assaultFormation`.
- `src/exercise/battle/scenario.ts`: `defaultActionsOn`, `actionsOnOf`, `setOrderActionsOn`,
  the labels and the parsing.
- Configuration: `force.pressOnSeconds` in `src/exercise/forces/fof-v2.json` (version 2.1.0).

## 3. The four fixes

The investigation was scenario 1 at Quantico. One BLUEFOR and one OPFOR squad
move toward each other through woods, and contact comes about 230 m apart from
glimpses through the trees. Sampled every 30 s, no soldier on either side had a
sight line to an enemy. Both squads lay prone where they had halted and fired
0–6 bursts a minute, and the fight took about twenty minutes to resolve.

1. **No more flip-flop between withdrawing and holding.** A squad that had
   withdrawn spent and then held was immediately found spent again and told to
   withdraw, every decision (10 times a second). Now a holding squad that has
   been clear for `withdrawnClearSeconds` (no contact, no incoming fire) is not
   sent back.
2. **Halt where they can see.** Halted soldiers no longer all lie prone. Every
   3 s each soldier tries prone and then kneeling. He takes the lowest posture
   from which he can see one of the three nearest contacts his force knows of,
   checked to a point 0.6 m above their ground. If neither posture sees, he stays
   prone in cover. A leader is never lower than kneeling. Soldiers who are pinned
   still go prone.
3. **Press on when nothing can be engaged.** This is _Continue_ in §1. Before,
   a squad that could not see the enemy halted until the contact went stale, and
   then halted again at the next glimpse.
4. **Contact is lost only when real sightings stop.** `lastContactAt` is now
   the most recent sighting of a confirmed track. Before, it was refreshed every
   decision while any track was held, so contact never aged out.

## 4. Effect on scenario 1

These are headless runs of the saved scenario 1 (seed 1) at Quantico, with
BLUEFOR's actions on contact varied and OPFOR on Continue.

| BLUEFOR      | What happens                                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| (before)     | Both halt prone and trade occasional bursts; resolved after about 20 min.                                                    |
| **Continue** | Cycles of contact, halt and pressing on (BLUEFOR presses on at 503 s); OPFOR is combat-ineffective at about 878 s (14½ min). |
| **Attack**   | Assaults 7 s after contact in line and closes from 235 m to 123 m; withdraws when spent.                                     |
| **Hold**     | Halts at contact and stays there, firing when it sees the enemy.                                                             |
| **Avoid**    | Falls back at once, falls back again as OPFOR comes on, then holds; it does not fire first.                                  |

## 5. Tests

- `src/exercise/battle/actions-on-contact.test.ts`: two squads meet in synthetic woods
  (seeds 1–3, 900 s). The tests check that:
  - **Hold** never moves on or assaults after contact, and its order stays active;
  - **Avoid** first withdraws, fires only after being fired upon, and never moves forward again;
  - **Attack** assaults, in at least two seeds, with a line formation;
  - **Continue** presses on and does not halt again within 45 s;
  - no squad makes five phase changes within 2 s.

  They also check the scenario edits (defaults, kind changes, saving, older
  files, unknown values refused).

- `src/sim/fof/posture.test.ts`: `postureToSee` behind a 0.7 m bank and a 3 m wall.
