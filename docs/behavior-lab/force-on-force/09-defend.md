# Defend (force-on-force model v2.6)

A **Defend** order sends a squad, fire team or element to a defensive position.
There it deploys across its sector, the arc it defends toward (up to all round),
lies prone and digs in. The longer it stays undisturbed, the deeper it digs:
from lying in the open, through shell scrapes and fighting pits, to standing in
a trench after 30 minutes. The deeper it is dug in, the harder its soldiers are
to hit, to see and to suppress. It fights from the position and never moves on:
it waits for new orders.

## 1. Giving the order

**Planning** (Scenario Setup for OPFOR, BLUEFOR Planning for BLUEFOR):

1. Select the squad and press **Defend** (**D**).
2. Click the defensive position. This adds the order and arms the direction tool.
3. Click in the direction it defends toward. The sector is a 90° wedge that way.
4. Drag the small square on the wedge's edge to widen or narrow it, from 20° up
   to all round. Within 10° of all round it becomes all round.

**Set direction** (**K**) sets the direction again. It is shown with the Defend
tool, or with a defend order selected.

The order's row in the squad panel shows the facing and the arc, and a
**prepared** choice: how long the position was prepared before the battle, 0 to
30 minutes. The squad starts that far dug in when it occupies the position. So a
defence set up in Scenario Setup can start partly or fully dug in.

- A defend order without a direction blocks the scenario ("set the direction it
  defends toward").
- So does any order after a defence: the defence waits for new orders, so the
  order would never be reached.

**Combat:** select a squad of either side and press **Defend**. Click the
position, then the direction; the second click gives the order with a 90°
sector.

The scenario file stores the sector as `sector: { facingDeg, arcDeg }` and the
preparation as `preparedMinutes`. Only a defend order may have them.

## 2. What the squad does

| Phase                   | What it does                                                                                                                                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `moving`                | Goes to the position like a Move. Contact on the way is handled by the order's actions on contact (Continue by default).                                                                                                                             |
| `defending`, deploying  | At the position it deploys across its sector. An arc narrower than 120° is held from a line across it, 5 m between soldiers. A wider one is held from a ring round the position (8–30 m across), each soldier on his share of the arc.               |
| `defending`, digging in | Prone, each soldier facing his share of the arc, holding his fire. Its dig-in grows from when it is in place: full after `digInSeconds` (30 minutes).                                                                                                |
| in contact              | A confirmed enemy within engagement range, or fire on it, puts it in contact. Its actions on contact are Hold: it fights from the position and never moves on or assaults. Digging pauses. A spent squad still breaks contact and withdraws (500 m). |
| contact lost            | Straight back to `defending`, and to digging.                                                                                                                                                                                                        |

The order never ends by itself. Given another order, the squad loses its dig-in.
Its soldiers' fighting positions stay on the ground where they were dug.

The activity word shows the dig-in, for example "Defending 45%" on the map label
and in the roster. The reason says what that looks like (in shell scrapes, in
fighting pits, fully dug in).

## 3. Being dug in

While a squad holds its defence (deploying, digging, or fighting from it), its
dig-in `d` (0–1) scales four things for its soldiers, linearly from 1 in the open:

| Effect                                                         | Fully dug in                     |
| -------------------------------------------------------------- | -------------------------------- |
| Chance of being hit by aimed fire                              | × `dugInHitFactor` (0.35)        |
| Chance of being hit by area fire, and of a grenade's fragments | × 0.35                           |
| Detail an observer sees of him (detection)                     | × `dugInDetectionFactor` (0.5)   |
| Suppression fire puts on him                                   | × `dugInSuppressionFactor` (0.5) |

These come on top of posture. A prone soldier fully dug in is about a tenth as
likely to be hit as one standing in the open (0.3 × 0.35).

In the simulation the soldiers stay prone: a soldier standing in a trench about
1.2 m deep has his eyes and his head and shoulders about where a prone soldier's
are. In the 3D view he is drawn standing in his position (below).

## 4. In 3D

Each soldier's fighting position is recorded where he lies, with his facing and
the squad's dig-in (`FofForce.earthworks`). The 3D view draws it on the ground
(`view3d/earthworks.ts`), growing with the dig-in:

| Dig-in | Position                                                                          | The soldier                                          |
| ------ | --------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 0–50%  | A shell scrape, the length of a man lying prone, its spoil heaped in front        | Lying in it                                          |
| 50–99% | A fighting pit, a parapet of spoil in front                                       | Standing in it, sunk 0.55 m and deeper               |
| 100%   | A stretch of trench about 3 m long, a parapet in front and a lower parados behind | Standing in it, sunk 1.15 m: head and shoulders show |

The ground itself is not cut. The hole is a dark patch on it, soil-coloured in a
scrape and darker the deeper it is. A soldier standing in his position is drawn
lower, so the ground hides his legs. The positions stay after the squad leaves.

## 5. Configuration

These are in `force` of `src/exercise/forces/fof-v2.json` (version 2.6.0):

| Key                      | Value | Meaning                                                                            |
| ------------------------ | ----- | ---------------------------------------------------------------------------------- |
| `digInSeconds`           | 1800  | Undisturbed in its position this long, a squad is fully dug in.                    |
| `dugInHitFactor`         | 0.35  | Fully dug in, the chance of being hit (aimed and area fire) is multiplied by this. |
| `dugInDetectionFactor`   | 0.5   | Fully dug in, the detail an observer sees is multiplied by this.                   |
| `dugInSuppressionFactor` | 0.5   | Fully dug in, the suppression put on a soldier is multiplied by this.              |

## 6. Results

A 13-man squad defends a position on open ground, facing north. A 13-man squad
attacks it from 900 m away, arriving about 7 minutes later. Over 8 seeds, after
15 minutes:

| Defence                                               | Defenders lost (of 104) | Attackers lost (of 104) |
| ----------------------------------------------------- | ----------------------: | ----------------------: |
| Not prepared (about 18% dug in when the attack comes) |                      68 |                      36 |
| Prepared 15 minutes (50%)                             |                      37 |                      59 |
| Prepared 30 minutes (fully dug in)                    |                      50 |                      64 |

Dug in, a defence loses about half as many soldiers and costs the attacker
nearly twice as many. With 8 seeds, the difference between half and fully dug in
is within the noise.

## 7. Code and tests

- `src/sim/fof/defence.ts`:
  - `occupyDefence`, `resumeDefence`, `updateDefence` (digging and the earthworks);
  - `defenceFormation` (the line or the ring), `defenceAzimuth` (each soldier's share of the arc);
  - `effectiveDugIn`, `dugInFactor`.
- `src/sim/fof/force.ts`: the `defending` phase, arrival, back to the defence after contact, prone and facing.
- `src/sim/fof/fire.ts` and `system.ts`: the hit, area-fire, suppression and detection factors.
- `src/sim/fof/orders.ts`: starting a defence (its dig-in lost with a new order); a defence that cannot reach its position fails.
- `src/exercise/battle/scenario.ts`:
  - `PlannedSector`, `setDefendSector`, `resizeDefendArc`, `setDefendPrepared`, `sectorSpec`;
  - the parsing and the issues.
- The app:
  - `planner.ts`: the direction tool and the arc handle;
  - `map-editor.ts`: the wedge (`defenceSector`);
  - `combat.ts` and `combat-editor.ts`: two clicks in combat;
  - `status.ts`: "Defending 45%" and the earthworks;
  - `page.ts`: the tools, keys, panel and preparation.
- `src/view3d/earthworks.ts` (the positions) and `characters/layer.ts` (soldiers standing in them).
- Tests:
  - `src/exercise/battle/defend.test.ts`:
    - occupying, facing the sector and digging in, with every soldier's position recorded;
    - fully dug in, and a prepared start;
    - all round in a ring, facing outward;
    - fighting from the position without moving on, losing fewer soldiers dug in;
    - losing the dig-in with another order;
    - the sector, its handle, the preparation, saving, and the issues.
  - `src/view3d/earthworks.test.ts`: the positions' shapes and how deep a soldier stands.
  - `src/app/battle/planner.test.ts`, `status.test.ts`: the two clicks, the arc handle, "Defending 45%".
