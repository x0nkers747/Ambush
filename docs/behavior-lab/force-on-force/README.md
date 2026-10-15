# Force-on-Force Lab

An experimental constructive simulation: two organizations (BLUEFOR and OPFOR) move on
their own orders with the Behavior Lab's formation movement, look for each other, and
fight when they meet. Their contact behaviour, fire, suppression and casualties
end in an explicit, reproducible outcome. It is a research capability, not a game
feature: the game never runs it.

- [01 Inspection: what exists and what is reused](01-inspection.md)
- [02 Human visual detection: evidence and the model](02-detection-research.md)
- [03 The model: contact, fire, suppression, outcomes](03-model.md)
- [04 Experiments, sweeps, determinism and performance](04-experiments.md)
- [05 The lab page](05-lab.md)
- [Implementation journal](journal.md)

Open it: `npm run dev`, then http://localhost:5173/#force-on-force, and press **Run the default demonstration**.

Code: `src/sim/fof` (kernel), `src/exercise/force-on-force` (runs, experiments, metrics).
