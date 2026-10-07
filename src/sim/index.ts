// Public API of the simulation layer. Other layers import only from here (`#sim`).
export {
  DEFAULT_TICK_RATE_HZ,
  MAX_TICK_RATE_HZ,
  MIN_TICK_RATE_HZ,
  validateSimConfig,
  type SimConfig,
} from './config';
export { createSimulation, type Simulation } from './simulation';
