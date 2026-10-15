// Public API of the exercise layer. Other layers import only from here (`#exercise`).
export {
  combatEventOf,
  type CombatEvent,
  type GrenadeImpactEvent,
  type ShotFiredEvent,
} from './combat-events';
export { DEMO_TERRAIN } from './demo-terrain';
export {
  createMotionRecorder,
  emptyMotionSample,
  type MotionLog,
  type MotionRecorder,
  type MotionSample,
} from './motion-log';
export {
  instantiateOrganization,
  resolveSlot,
  rosterTree,
  validateOrganizationTemplate,
  type IndividualIcon,
  type Loadout,
  type OrganizationInstance,
  type OrganizationMember,
  type OrganizationTemplate,
  type ResolvedSlot,
  type RosterUnit,
  type TemplateRole,
  type TemplateSlot,
  type TemplateUnit,
  type TraineeOrganization,
} from './organization';
export {
  createFixedStepRunner,
  DEFAULT_MAX_CATCH_UP_SECONDS,
  maxTicksPerAdvance,
  type FixedStepRunner,
  type FixedStepRunnerOptions,
  type Steppable,
} from './runner';
export { USMC_RIFLE_SQUAD_TEMPLATE } from './squad';
