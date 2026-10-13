// The terrain lab (docs/ground-level-terrain-architecture-research.md, stage 2):
// an isolated prototype page at #terrain-lab. Nothing in the game imports it;
// the app's composition root loads it only for that address.
export {
  startTerrainLab,
  type LabBattlefield,
  type LabBattlefieldSummary,
  type LabSource,
  type TerrainLabHandle,
} from './lab';
