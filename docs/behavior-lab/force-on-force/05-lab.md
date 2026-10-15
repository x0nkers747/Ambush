# Force-on-Force 05: the lab page

- Status: done (F4)
- Date: 2026-10-14
- Part of: [Force-on-Force Lab](README.md)

**Open it.** Run `npm run dev`, then go to http://localhost:5173/#force-on-force.

- **One-click demonstration:** press **Run the default demonstration**. Two squads meet
  in the open, played at 8×; it takes about 1.5 min of real time.
- **Starting on an experiment:** `#force-on-force?experiment=wooded-delay&seed=3` opens
  that experiment and seed.

The page is loaded only at that address. It reuses the Behavior Lab's scene (the game's
renderer settings, sun and tactical camera), its urban district, and the game's animated
character layer:

- soldiers aim, fire (bursts are the characters' shots), go prone and fall (casualties);
- woods are drawn as simple instanced trees over the vegetation areas the simulation
  uses (display only).

## Controls

| Where  | Control                       | Effect                                                                                                                                                                                                                                        |
| ------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header | Play / Step / Reset, ½×–32×   | Steps the real kernel; nothing advances outside the simulation                                                                                                                                                                                |
| Header | Terrain, Conditions           | Open / wooded / urban ground (seeded); observation conditions (default: as the terrain; or clear, urban haze, restricted)                                                                                                                     |
| Header | View as                       | **Observer** (omniscient: true positions) or **BLUEFOR's / OPFOR's picture**: its own soldiers and only the enemies it has confirmed; contacts at last known positions                                                                        |
| Header | Seed, Tick rate               | A new run                                                                                                                                                                                                                                     |
| Left   | Experiment                    | The default demonstration and the 12 experiments                                                                                                                                                                                              |
| Left   | BLUEFOR / OPFOR               | Organization (squad, fire team, element), formation, starting posture; **Set start** and **Set destination** (click the ground); **Stay** (no movement order). During a run, a destination is an order, refused while the force is in contact |
| Left   | Rules and combat              | Rules of engagement, engage range, lethality × 0.5/1/2, suppression × 0.5/1/2, time limit: a modified configuration, recorded with the run                                                                                                    |
| Left   | Replay & verify / Save / Load | Re-simulates the run from its commands, checking the state hash every second; saves or loads the run as JSON (spec, configuration, commands, hashes)                                                                                          |
| Right  | Organizations                 | Each force: state and why; effectiveness; active, suppressed and pinned soldiers; ammunition; contacts by level; first possible, confirmed and identified contact; bursts and hits                                                            |
| Right  | Events                        | The chronological timeline (click an entry to go there)                                                                                                                                                                                       |
| Right  | Inspector                     | The selected soldier: status, posture, weapon and rounds, suppression, fire, what the enemy knows of him, and why he is doing what he does                                                                                                    |
| Footer | Timeline, graph               | Scrub back (re-simulated from keyframes); per side: effectiveness (solid), mean suppression (dashed), highest detection confidence (dotted)                                                                                                   |
| Footer | Metrics                       | Detection, engagement and quality metrics; the outcome; simulation CPU per tick                                                                                                                                                               |
| View   | Outcome banner                | The outcome, its basis and reason, casualties and effectiveness, once reached                                                                                                                                                                 |

## Overlays

| Overlay                      | Shows                                                                                                                           | Information        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Starts, destinations, orders | Markers and the forces' current routes (dashed)                                                                                 | each side its own  |
| Geometric visibility         | Sight lines from the selected soldier (or the leaders) to every enemy in range: green by share in sight, grey dashed if blocked | **observer truth** |
| Detection confidence         | A bar under each track's last known position                                                                                    | the side's picture |
| Known contacts               | Tracks at their last known positions: `?` possible, `!` detected, `✕` identified, `○` lost                                      | the side's picture |
| Organizational state         | Each force's state, effectiveness, strength and suppression over its centre                                                     | each side its own  |
| Engagement (fire)            | Tracers from shooter to aim point for 0.8 s: aimed solid, area dashed, hits white                                               | each side its own  |
| Suppression                  | Rings: faint while recovering, yellow suppressed, red pinned                                                                    | each side its own  |
| Casualty status              | A red cross on each casualty                                                                                                    | each side its own  |
| Simulation events            | Pulses where a contact is confirmed, a soldier falls or is pinned                                                               | each side its own  |

## The event timeline

Every line comes from a recorded simulation event, or (effectiveness milestones) from
the state sampled each second. It shows:

- each side beginning movement;
- its first possible, confirmed and identified contact (who saw whom, from how far);
- every change of a force's state, with the reason;
- the first burst of each side, and the first fire each receives;
- every casualty;
- the first soldier pinned on each side;
- effectiveness falling below 75 % and 50 %;
- refused orders;
- the end, with its basis and reason.

## Browser validation (2026-10-14, Chrome, 1600 × 950)

- **Default demonstration (seed 1):**
  - contact at T+451.9 s, at 300 m;
  - BLUEFOR victory at 792.5 s (OPFOR combat ineffective; casualties 5 / 9);
  - **Replay & verify:** 793 s checked, 0 mismatches;
  - 57 fps at 32×;
  - simulation 0.06 ms per tick on average (p95 0.2 ms).
- **Wooded (seed 1):** contact at about 400–430 m through the woods; mutual
  disengagement at 799.5 s.
- **Urban (seed 1):** contact at 124–160 m along the streets; OPFOR victory at 1177.3 s;
  0.17 ms per tick (p95 0.4 ms).
- **No console errors** apart from one 404 for a resource the Behavior Lab page also
  requests.
- **Needs your visual review:** the soldiers' contact postures and firing animation at
  close range, and whether the overlays are readable at your usual zoom.
