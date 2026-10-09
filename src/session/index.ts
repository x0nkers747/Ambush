// Public API of the session/UI-state layer (`#session`): selection and time
// scale. Never recorded.
export {
  clearSelection,
  createSession,
  selectFireTeam,
  selectSoldier,
  setShowVisibility,
  setTimeScale,
  stepTimeScale,
  setTool,
  TIME_SCALES,
  type MapTool,
  type Session,
  type TimeScale,
} from './session';
