// Public API of the exercise layer. Other layers import only from here (`#exercise`).
export {
  combatEventOf,
  type CombatEvent,
  type GrenadeImpactEvent,
  type HeavyShotEvent,
  type MissileArrivedEvent,
  type ShotFiredEvent,
  type VehicleStruckEvent,
} from './combat-events';
export { DEMO_TERRAIN } from './demo-terrain';
export {
  ARTICULATION_STRIDE,
  createMotionRecorder,
  emptyArticulation,
  emptyMotionSample,
  MAX_LOGGED_MOUNTS,
  motionMovers,
  readArticulation,
  writeArticulation,
  type ArticulationSample,
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
