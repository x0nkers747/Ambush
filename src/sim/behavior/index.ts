// Unit tasks and formation movement (docs/behavior-lab/03): the public surface,
// re-exported from #sim.
export {
  behaviorDiagnostics,
  type AgentDiagnostics,
  type BehaviorDiagnostics,
  type TaskDiagnostics,
} from './diagnostics';
export { flattenFormation, validateFormationSpec, type FlatFormation } from './formation-spec';
export {
  validateDisturbance,
  validateUnitOrder,
  type DisturbAgentCommand,
  type OrderUnitCommand,
  type OrderUnitRejection,
} from './orders';
export { smoothNoise } from './noise';
export { DEFAULT_BEHAVIOR_PARAMS, validateBehaviorParams, type BehaviorParams } from './params';
export { buildGroupRoute, routeAt, routePoint, type RoutePoint } from './route';
export { slotTarget, slotTargetAt, taskFrame, type SlotTarget, type TaskFrame } from './slots';
export { behaviorParams, substeps, type Desire, type TaskPace } from './system';
export type {
  AgentOverride,
  AgentState,
  BehaviorState,
  FormationNode,
  FormationSlot,
  FormationSpec,
  GroupRoute,
  TaskOutcome,
  TaskPhase,
  UnitOrder,
  UnitTask,
} from './types';
