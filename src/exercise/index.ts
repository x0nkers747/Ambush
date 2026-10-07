// Public API of the exercise layer. Other layers import only from here (`#exercise`).
export {
  validateOpforRoutes,
  type AmbushScenario,
  type OpforRoute,
  type ScenarioRouteWaypoint,
} from './ambush-scenario';
export { DEMO_SCENARIO } from './demo-scenario';
export {
  createExercise,
  ENEMY_SIDE,
  ExerciseError,
  TRAINEE_SIDE,
  type AmbushTrigger,
  type CommitResult,
  type Exercise,
  type ExerciseEvent,
  type ExerciseOptions,
  type KillZoneVisibility,
  type ExercisePhase,
  type OpforStart,
  type PlanRevision,
  type StartOpforResult,
} from './exercise';
export {
  killZoneProblems,
  killZoneSamplePoints,
  polygonCentroid,
  MIN_KILL_ZONE_AREA_M2,
  MIN_VERTEX_SPACING_M,
  type KillZone,
} from './kill-zone';
export { remainingPlan, samePlan, validatePlan, type SoldierPlan } from './plan';
export {
  createPathCache,
  describePathProblem,
  planRoute,
  type PlannedLeg,
  type PlannedRoute,
} from './routes';
export {
  createFixedStepRunner,
  DEFAULT_MAX_CATCH_UP_SECONDS,
  maxTicksPerAdvance,
  type FixedStepRunner,
  type FixedStepRunnerOptions,
  type Steppable,
} from './runner';
