# Force-on-Force Lab: implementation journal

## F1: architecture and detection (2026-10-14)

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
