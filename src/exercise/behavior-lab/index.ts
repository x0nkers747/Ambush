// The Behavior Lab's headless side (docs/behavior-lab/04): runs, scenarios,
// metrics and acceptance. Its own entry point (#exercise/behavior-lab), not
// re-exported from #exercise, so the game never loads it.
export { acceptanceFailures } from './acceptance';
export { createMetrics, type LabMetrics, type LabSample, type MetricsRecorder } from './metrics';
export {
  createLabRun,
  LAB_ORGANIZATIONS,
  labTerrain,
  secondHashes,
  type LabDisturbance,
  type LabOrganization,
  type LabRun,
  type LabRunSpec,
} from './run';
export {
  DEFAULT_FORMATION,
  LAB_SCENARIOS,
  runScenario,
  scenarioSpec,
  type LabScenario,
  type LabScenarioId,
  type ScenarioOptions,
  type ScenarioResult,
} from './scenarios';
export {
  buildFormationSpec,
  FORMATION_TEMPLATES,
  formationsFor,
  formationTemplate,
  type FormationTemplate,
} from '../formations/formations';
