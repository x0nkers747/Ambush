# Constructive simulation 02: orders and plans

- Status: implemented (Milestone A, 2026-10-15)
- Part of: [Constructive simulation](README.md)
- Code: `src/sim/fof/orders.ts`, `types.ts`, `setup.ts`, `lifecycle.ts`;
  `src/exercise/battle`

## 1. Squads are forces

A battle's squads are the forces of the force-on-force model
(`docs/behavior-lab/force-on-force`), and there may be any number of them.
The squads of the other side are the enemy: detection thresholds, targeting,
area fire and suppression all go by side. Squads of the same side never
engage each other. Each squad keeps its own picture of the enemy, which is
what its own soldiers have seen. No squad acts on what it could not know.

`FofSetup.termination` selects one of two regimes:

| Regime                 | Used by            | Forces                   | End                                                            |
| ---------------------- | ------------------ | ------------------------ | -------------------------------------------------------------- |
| `experiment` (default) | Force-on-Force Lab | Exactly two, opposed     | Adjudicated (outcome, `fofEnded`)                              |
| `manual`               | Battles            | One or more, either side | None: the player ends combat. Only the invariants are checked. |

The lab is unchanged by the generalization. Its runs were verified to be
bit-identical (state hashes) before and after it.

## 2. Orders

An order states the commander's intent. The squad's phase (`ForcePhase`) is
what the squad is doing about that order right now.

| Kind       | Meaning                         | Actions on contact while active                  |
| ---------- | ------------------------------- | ------------------------------------------------ |
| `move`     | Go to the destination           | `continue`: halt to fight, then carry on         |
| `attack`   | Take the objective and clear it | `attack`: assault, with fire and movement        |
| `withdraw` | Fall back to the destination    | Does not halt to fight (the `withdrawing` phase) |

Every order (`FofOrder`) records:

- its id (`<unitId>#<sequence>`);
- its kind and destination;
- its source (`scenario` or `player`);
- the tick it was issued;
- when it was issued, activated and ended (simulation seconds);
- its status and the reason for that status.

Destinations are snapped into the squad's navigable area.

## 3. Lifecycle

```
pending ─ its turn, the squad able ─▶ active
active move     ─ atObjective within arrivalRadiusM (40 m) ─▶ completed
                ─ atObjective farther away (no way closer) ─▶ failed
active attack   ─ on the objective, no confirmed enemy within engageRangeM
                  for attackClearSeconds (20 s) ─▶ completed
                ─ attackTimeoutSeconds (1800 s) since activation ─▶ failed
active withdraw ─ arrival ─▶ completed
active          ─ no route to the destination ─▶ failed
active, pending ─ the squad combat ineffective ─▶ failed (the whole plan)
active          ─ the squad spent, breaking contact on its own ─▶ failed;
                  the next orders wait until it has recovered (its
                  suppression worn off, and not spent: force-on-force
                  03 §4), or until the player gives an order
active, pending ─ replaced by the player ─▶ superseded (canceled if the
                  replacement is empty)
```

Each change of status emits an `orderChanged` event with these fields:
`unitId`, `side`, `orderId`, `kind`, `from`, `to`, `reason`.

When contact interrupts an order, the squad's own behaviour takes over. It
halts, returns fire, assaults or breaks contact. Once the contact is over,
it resumes the active order.

A player's order to a squad holding after contact is carried out at once,
even when the squad is spent or still recovering. A planned order waits until
the squad resumes on its own (recovered, force-on-force 03 §4), so a spent
squad never starts one.

A squad with no pending order holds where it is. A squad with no plan at all
holds from the start.

## 4. The `orderSquad` command

```ts
{ type: 'orderSquad', tick, unitId, mode: 'replace' | 'pending' | 'append', orders: OrderSpec[] }
```

- The command is applied at a tick boundary. Commands for the same tick are
  applied in the order they were submitted, so a run is reproducible from
  its command log.
- `replace` supersedes the active order and every pending order, and the new
  orders follow. `replace` with an empty list cancels them, and the squad
  holds.
- `pending` supersedes only the pending orders: the active order goes on
  (it is not restarted), and the new orders follow it. Combat uses it for a
  plan edited after its active order.
- `append` adds the new orders after the pending ones. A squad that is
  holding starts on them.
- A command with a malformed shape is refused with a `RangeError` (from
  `validateOrderSquad`).
- These commands are rejected, with a `commandRejected` event:
  - `noForceModel`: the world has no force-on-force setup;
  - `unknownUnit`: the unit is not a squad of the battle;
  - `unitIneffective`: the squad is combat ineffective with nobody left. A
    combat-ineffective squad with soldiers left takes the order: it is
    taken on again (`ineffective` ─▶ `atObjective`, "combat ineffective,
    ordered on") and stays counted as ineffective;
  - `destinationOffTerrain`: a destination is off the terrain.

## 5. The battle builder

`createBattle(spec, terrain, replay?)` (`#exercise/battle`) builds a battle
from a `BattleSpec`, which is plain data:

- squads, each with an id, name, side, organization, formation, position,
  facing, posture and plan;
- the seed and tick rate;
- the visibility;
- the model's configuration;
- the movement integration rate.

Ids follow these patterns:

- a squad's units are `<id>-SQD`, or `-FT` or `-TM` for smaller
  organizations;
- its soldiers are `<id>-01` and so on.

The battle records every command it is given, with its origin. Passing that
record back as `replay` reproduces the run exactly. Tests check three ways
of getting the same state hash:

- running twice;
- replaying from the command log;
- restoring from a snapshot.

`orderSquad(battle, squadId, mode, orders)` builds the command for the
current tick.

## 6. Known behaviour

- An attacking squad pursues enemies it still sees as active, including
  squads that are combat ineffective but have not been destroyed. In the
  3v3 reference this can keep an assault going for a long time; the
  `attackTimeoutSeconds` limit bounds it.
- A move's destination that cannot be reached exactly fails the order on
  arrival, rather than counting as completed.
