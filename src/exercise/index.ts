// Public API of the exercise layer. Other layers import only from here (`#exercise`).
export { DEMO_SCENARIO } from './demo-scenario';
export {
  createExercise,
  ExerciseError,
  TRAINEE_SIDE,
  type CommitResult,
  type Exercise,
  type ExerciseOptions,
  type ExercisePhase,
  type PlanRevision,
} from './exercise';
export { remainingPlan, samePlan, validatePlan, type SoldierPlan } from './plan';
export {
  createFixedStepRunner,
  type FixedStepRunner,
  type FixedStepRunnerOptions,
  type Steppable,
} from './runner';
