# Ambush (force-on-force model v2.2)

An **Ambush** order works differently from the other orders. The squad, fire
team or element goes to an ambush position and lies in wait there, concealed,
watching a kill zone. Nobody presses a trigger button: it opens fire on its
own when the enemy is in the kill zone. Then it fights as in any contact until
the enemy is down, and waits in place for new orders.

## 1. Giving the order

**Planning** (Scenario Setup for OPFOR, BLUEFOR Planning for BLUEFOR):

1. Select the squad and press **Ambush** (**B**).
2. Click the ambush position. This adds the order and arms the kill-zone tool,
   so the next click sets the kill zone.
3. Click the kill zone's centre. The zone is a 50 m × 50 m square turned to face
   the ambush position (one side toward it).
4. Resize the zone by dragging its corners. The opposite corner stays put and
   the zone keeps its facing; each side is 5–1000 m.

Moving the ambush position turns the zone to face it again.

**Set kill zone** (**K**) sets the zone again. It is shown only while the
Ambush tool is selected, or while an ambush order is selected. An ambush order
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

| Phase                     | What it does                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `moving`                  | Goes to the position like a Move. Contact on the way is handled by the order's actions on contact (Continue by default).                                                                                                                                                                                                                                                             |
| `inAmbush`, deploying     | At the position it shakes out into its extended line (squad: line; fire team: skirmishers), facing the kill zone. The line is closed up to be no wider than the zone, to at least 60 % of its normal intervals, so its ends do not stick out toward the enemy.                                                                                                                       |
| `inAmbush`, lying in wait | Prone, facing the kill zone, holding its fire and not halting for what it sees. It is **concealed**: the enemy cannot detect its soldiers beyond `concealmentRangeM` (100 m). Within that range, camouflaged and still, they show only `concealedDetectionFactor` (0.3) of the resolvable detail a prone soldier would.                                                              |
| sprung → `contact`        | Every ambusher fires at once, with no reaction delay. It knows the enemy soldiers in the kill zone, because it watched them walk in. The enemy squad caught in the zone is **surprised**: its soldiers react `ambushSurpriseSeconds` (4 s) later than usual, still standing and not yet firing back. The ambushers' actions on contact become Hold, so they fight from the position. |
| afterwards                | Contact lost, it holds. The order stays active until the player gives another, so the squad waits there. As in any fight, a squad that is spent (effectiveness, suppression or ammunition) still breaks contact.                                                                                                                                                                     |

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

These are in `force` of `src/exercise/forces/fof-v2.json` (version 2.2.0):

| Key                        | Value | Meaning                                                                                  |
| -------------------------- | ----- | ---------------------------------------------------------------------------------------- |
| `concealmentRangeM`        | 100   | A concealed ambusher cannot be detected beyond this.                                     |
| `concealedDetectionFactor` | 0.3   | Within it, his resolvable cycles are multiplied by this (camouflage and stillness).      |
| `ambushTriggerShare`       | 0.67  | The share of one enemy squad's active soldiers in the kill zone that springs the ambush. |
| `ambushSurpriseSeconds`    | 4     | How much later a squad caught in the kill zone reacts.                                   |

## 4. Why the camouflage factor and the surprise

With concealment alone (no detection beyond 100 m, normal detection within it),
an unalerted patrol spotted a prone ambusher 15 m inside a wood in 1–2 s at
about 75 m. That happened every time before it reached a kill zone 70 m off.
Even an ambush sprung on the enemy in the zone gave only one volley's
advantage: the enemy went to ground, knew where the fire came from, and the
fight was even.

The comparison below uses the test ground: a wood edge 55 m from the route, a
13-man squad 70 m off the route against a 13-man squad walking down it, over 10
seeds.

| BLUEFOR                                      | BLUEFOR wins | OPFOR wins | Casualties B / O | Sprung on the kill zone |
| -------------------------------------------- | ------------ | ---------- | ---------------- | ----------------------- |
| Halted there on a Move (Hold), not concealed | 1            | 3          | 59 / 20          | —                       |
| Ambush, no surprise                          | 4            | 5          | 80 / 72          | 10 of 10                |
| **Ambush, 4 s surprise (default)**           | **6**        | **2**      | **51 / 93**      | 10 of 10                |
| Ambush, 8 s surprise                         | 7            | 2          | 42 / 101         | 10 of 10                |

Without the camouflage factor (1.0), every ambush was compromised before the
enemy reached the kill zone.

The other results are not decisive (both squads hold, or one breaks contact).
After the surprise, the fight is the model's ordinary one. Each soldier fires
at the nearest enemy he can see, so a volley is not distributed across the
kill zone. That, and lethality in general, belongs to the fire model, not to
the ambush.

## 5. Code and tests

- `src/sim/fof/ambush.ts`:
  - `occupyAmbush`, `updateAmbush` and the trigger, `springAmbush`;
  - `inKillZone`, `killZoneCorners`, and `fittedTo` (closes up the line).
- `src/sim/fof/system.ts`: concealment in detection.
- `src/sim/fof/force.ts`:
  - the `inAmbush` phase and arrival;
  - lying in wait;
  - surprise in the reaction delays;
  - fire on an ambush springs it.
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
    - never seen beyond 100 m while concealed, against far sightings of an
      unconcealed squad;
    - it fights from the position and waits;
    - the kill zone: default, facing, corner resizing, saving and checks.
  - `src/app/battle/combat.test.ts`: an ambush given in combat takes its kill zone.
