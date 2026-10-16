# Ambush (force-on-force model v2.3)

An **Ambush** order works differently from the other orders. The squad, fire
team or element goes to an ambush position and lies in wait there, concealed,
watching a kill zone. Nobody presses a trigger button: it opens fire on its
own when the enemy is in the kill zone. Then it fights as in any contact until
the enemy is down, and waits in place for new orders.

## 1. Giving the order

**Planning** (either side's squads):

1. Select the squad and press **Ambush**.
2. Click the ambush position. This adds the order and arms the kill-zone tool,
   so the next click sets the kill zone ("Click again to set killzone" shows at
   the bottom of the map).
3. Click the kill zone's centre. The zone is a 50 m × 50 m square turned to face
   the ambush position (one side toward it).
4. Resize the zone by dragging its corners. The opposite corner stays put and
   the zone keeps its facing; each side is 5–1000 m. Drag the circle at its
   centre to move it: its size is kept, and it turns to face the ambush
   position again. Its label is just under that circle.

Moving the ambush position turns the zone to face it again.

**Set kill zone**, under the order's drop-downs in the squad panel, arms that
click again. An ambush order
without a kill zone blocks the scenario ("set its kill zone"). So does any
order after an ambush, because the ambush waits for new orders and would never
reach it.

**Combat:** select a squad of either side and press **Ambush**. Click the
ambush position, then the kill zone; the second click gives the order with a
50 m square zone. Until then the position is shown on the map, and Esc starts
again. The Set kill zone button is shown only with the Ambush tool, and is
pressed while it waits for the kill-zone click. Kill zones of active, pending
and queued ambush orders are drawn on the map, in planning, combat and the
After-Action Review.

The scenario file stores the kill zone as
`killZone: { centre: {east, north}, widthM, depthM, facingDeg }`. Only an
ambush order may have one.

## 2. What the squad does

| Phase                     | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `moving`                  | Goes to the position like a Move. Contact on the way is handled by the order's actions on contact (Continue by default).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `inAmbush`, deploying     | At the position it shakes out into its extended line (squad: line; fire team: skirmishers), facing the kill zone. The line is closed up to be no wider than the zone, to at least 60 % of its normal intervals, so its ends do not stick out toward the enemy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `inAmbush`, lying in wait | Prone, facing the kill zone, holding its fire and not halting for what it sees. It is **concealed**: the enemy cannot detect its soldiers beyond `concealmentRangeM` (100 m). Within that range, camouflaged and still, they show only `concealedDetectionFactor` (0.3) of the resolvable detail a prone soldier would.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| sprung → `contact`        | Every ambusher fires at once, with no reaction delay. It knows the enemy soldiers in the kill zone, because it watched them walk in. The enemy squad caught in the zone is **surprised**: its soldiers react `ambushSurpriseSeconds` (4 s) later than usual, still standing and not yet firing back. The ambushers fire **steady**: from prepared prone positions, without the stress of being fired upon, each round of their aimed fire hits `ambushAccuracyFactor` (3) times as often (at most 0.95). This lasts until they are first fired upon, or at most `ambushAccuracySeconds` (15 s). The ambushers also fire by **sectors**: each takes the enemy at his own place across the kill zone (§2.1), so fire spreads over the enemy instead of every man firing at the nearest. Their actions on contact become Hold, so they fight from the position. |
| afterwards                | Contact lost, it holds. The order stays active until the player gives another, so the squad waits there. As in any fight, a squad that is spent (effectiveness, suppression or ammunition) still breaks contact.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

### 2.1 Sectors of fire

While a squad fights the ambush it sprang (its ambush order still active), each
ambusher has a sector, as an ambush line is assigned sectors of fire:

- The ambushers are ranked across the kill zone's width, and so are the enemy
  soldiers they know of and could fire at (in range).
- The ambusher at rank _i_ of _n_ takes the target at the same share of the
  _m_ targets, (_i_ + ½)·_m_/_n_ − ½.
- If he cannot see that target, he takes the next nearest in that order, then
  by range.

Out of an ambush, every soldier fires at the nearest enemy he can see, as
before.

### When it opens fire

All checks run every decision (10 Hz), on where the enemy actually is, since
the ambushers are watching their kill zone. The ambush is sprung when the first
of these happens:

1. **The enemy is in the kill zone:** at least `ambushTriggerShare` (two-thirds)
   of one enemy squad's active soldiers are inside the rectangle.
2. **The enemy is getting through:** a soldier who was in the zone at the last
   decision has left it, still standing. This stops a squad that never has
   two-thirds inside at once (a long column, or a quick crossing) from walking
   through.
3. **Compromised:** the ambushers have been fired upon, or an enemy squad has
   a confirmed contact on one of them that it saw after they occupied the
   position. Sightings from before they lay down (seen moving in from far off)
   do not count. A compromised ambush does not surprise the enemy.

The reason is recorded in the phase change, for example "ambush sprung: Enemy
squad 1 in the kill zone". It shows in the squad panel and the After-Action
Review.

## 3. Configuration

These are in `force` of `src/exercise/forces/fof-v2.json` (version 2.3.0):

| Key                        | Value | Meaning                                                                                  |
| -------------------------- | ----- | ---------------------------------------------------------------------------------------- |
| `concealmentRangeM`        | 100   | A concealed ambusher cannot be detected beyond this.                                     |
| `concealedDetectionFactor` | 0.3   | Within it, his resolvable cycles are multiplied by this (camouflage and stillness).      |
| `ambushTriggerShare`       | 0.67  | The share of one enemy squad's active soldiers in the kill zone that springs the ambush. |
| `ambushSurpriseSeconds`    | 4     | How much later a squad caught in the kill zone reacts.                                   |
| `ambushAccuracyFactor`     | 3     | Steady fire: the multiplier on the ambushers' per-round hit probability (at most 0.95).  |
| `ambushAccuracySeconds`    | 15    | Steady fire ends after this at the latest; it ends sooner when they are fired upon.      |

## 4. Why the camouflage factor, the surprise and the steady fire

With concealment alone (no detection beyond 100 m, normal detection within it),
an unalerted patrol spotted a prone ambusher 15 m inside a wood in 1–2 s at
about 75 m. That happened every time before it reached a kill zone 70 m off.
Even an ambush sprung on the enemy in the zone gave only one volley's
advantage: the enemy went to ground, knew where the fire came from, and the
fight was even.

The comparison below uses the test ground: a wood edge 55 m from the route, a
13-man squad 70 m off the route against a 13-man squad walking down it, over 10
seeds.

| BLUEFOR                                            | BLUEFOR wins | OPFOR wins | Casualties B / O | Sprung on the kill zone |
| -------------------------------------------------- | ------------ | ---------- | ---------------- | ----------------------- |
| Halted there on a Move (Hold), not concealed       | 1            | 3          | 59 / 20          | —                       |
| Ambush, no surprise                                | 4            | 5          | 80 / 72          | 10 of 10                |
| **Ambush, 4 s surprise (default)**                 | **6**        | **2**      | **51 / 93**      | 10 of 10                |
| Ambush, 8 s surprise                               | 7            | 2          | 42 / 101         | 10 of 10                |
| Ambush, 4 s surprise, steady fire ×2               | 9            | 1          | 18 / 123         | 10 of 10                |
| **Ambush, 4 s surprise, steady fire ×3 (default)** | **9**        | **1**      | **23 / 118**     | 10 of 10                |
| Ambush, 4 s surprise, steady fire ×4               | 10           | 0          | 15 / 130         | 10 of 10                |

Steady fire was added because the ordinary hit-probability curves include
the stress of combat. An ambusher has little: he has chosen his position, lies
prone with his weapon steady, and nobody is firing at him yet. These are the
OPFOR soldiers down (of 130, over the 10 ambushes) within 5, 10 and 30 s of the
spring; OPFOR's first return fire comes 4.6 s after it on average:

| Steady fire      | Down by 5 s | By 10 s | By 30 s |
| ---------------- | ----------- | ------- | ------- |
| None (×1)        | 24          | 37      | 68      |
| **×3 (default)** | **54**      | **69**  | **93**  |

At 70 m a standing target's rifle hit probability per round goes from about
22 % to about 66 %, so a 2–3-round burst incapacitates him about 45 % of the
time instead of 17 %.

Without the camouflage factor (1.0), every ambush was compromised before the
enemy reached the kill zone.

Without sectors, every ambusher fired at the nearest enemy he could see, so
the opening volley went at about 2 of the enemy. With sectors (§2.1) it goes
at about 13, one per ambusher:

| Steady fire, with sectors | Opening volley's targets | Down by 5 / 10 / 30 s (of 130) | Ambush wins  | Casualties B / O |
| ------------------------- | ------------------------ | ------------------------------ | ------------ | ---------------- |
| ×3, without sectors       | 2.0                      | 54 / 69 / 93                   | 9 of 10      | 23 / 118         |
| ×1 (none)                 | 12.7                     | 30 / 41 / 86                   | 8 of 10      | 32 / 111         |
| ×2                        | 12.8                     | 60 / 74 / 109                  | 10 of 10     | 6 / 130          |
| **×3 (default)**          | **12.7**                 | **62 / 84 / 118**              | **10 of 10** | **1 / 130**      |

A well-sited ambush with surprise, steady fire and sectors now destroys a
squad caught in its kill zone, at almost no cost. A compromised ambush gets no
surprise and no steady fire (sectors still apply), and an enemy that halts
short of the kill zone does not spring it. Results not counted as wins above
are not decisive (both squads hold, or one breaks contact).

## 5. Code and tests

- `src/sim/fof/ambush.ts`:
  - `occupyAmbush`, `updateAmbush` and the trigger, `springAmbush`;
  - `inKillZone`, `killZoneCorners`, and `fittedTo` (closes up the line).
- `src/sim/fof/system.ts`: concealment in detection.
- `src/sim/fof/force.ts`:
  - the `inAmbush` phase and arrival;
  - lying in wait;
  - surprise in the reaction delays;
  - fire on an ambush springs it, and ends its steady fire.
- `src/sim/fof/fire.ts`: steady fire (`ambushSteadiness`), and sectors of fire in target choice.
- `src/sim/fof/ambush.ts`: `ambushSectors`.
- `src/exercise/battle/scenario.ts`: `PlannedKillZone`, `setKillZone`,
  `resizeKillZone`, `defaultKillZone`, `killZoneSpec`, the parsing and the issues.
- The app:
  - `planner.ts`: the kill-zone tool;
  - `map-editor.ts`: drawing and corner drags;
  - `combat-editor.ts`: two clicks;
  - `combat-panel.ts` and `page.ts`: the buttons, keys and hints.
- Tests:
  - `src/exercise/battle/ambush.test.ts`:
    - it occupies, lies in wait and springs on the enemy in the zone, firing
      first, and the enemy returns fire only after the surprise;
    - steady fire from the spring until fired upon, and the enemy falling fast in
      the first 5 s;
    - the opening volley spread over the enemy (sectors);
    - never seen beyond 100 m while concealed, against far sightings of an
      unconcealed squad;
    - it fights from the position and waits;
    - the kill zone: default, facing, corner resizing, saving and checks.
  - `src/app/battle/combat.test.ts`: an ambush given in combat takes its kill zone.
