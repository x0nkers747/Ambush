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

## F2: contact and engagement (2026-10-14)

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
