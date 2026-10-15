import type { FofContext } from './system';
import { forceActive } from './system';
import type { FofForce, ForcePhase } from './types';

// Organizational contact behavior (docs/behavior-lab/force-on-force/03 §4).
// One small state machine per force, over its own picture (its tracks), never
// over the truth.

/** Each force's decision, in force order. */
export function updateForces(context: FofContext): void {
  context.fof.forces.forEach((force, i) => {
    if (!forceActive(force)) return;
    const best = bestLevel(context, i);
    if (best === 'confirmed') force.lastContactAt = context.t;
    if (force.phase === 'moving' || force.phase === 'atObjective') {
      if (best === 'confirmed') enter(context, force, 'contact', 'contact confirmed');
      else if (best === 'possible') enter(context, force, 'possibleContact', 'possible contact');
    } else if (force.phase === 'possibleContact') {
      if (best === 'confirmed') enter(context, force, 'contact', 'contact confirmed');
      else if (best === 'none') enter(context, force, 'moving', 'possible contact not confirmed');
    }
  });
}

/** The best current knowledge a force has: a confirmed current contact, a possible one, or none. */
export function bestLevel(context: FofContext, force: number): 'confirmed' | 'possible' | 'none' {
  let best: 'confirmed' | 'possible' | 'none' = 'none';
  for (const track of context.fof.tracks) {
    if (track.force !== force) continue;
    if (track.level === 'detected' || track.level === 'identified') return 'confirmed';
    if (track.level === 'possible') best = 'possible';
  }
  return best;
}

/** Moves a force to `to`, reporting why. */
export function enter(context: FofContext, force: FofForce, to: ForcePhase, reason: string): void {
  if (force.phase === to) return;
  const from = force.phase;
  force.phase = to;
  force.phaseSince = context.t;
  context.events.push({
    type: 'forcePhaseChanged',
    tick: context.tick,
    atSeconds: context.t,
    unitId: force.unitId,
    side: force.side,
    from,
    to,
    reason,
  });
}
