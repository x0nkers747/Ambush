import type { EngagementAreaEnteredEvent, SimEvent } from './events';
import type { PathSegment, TickTime } from './movement';
import { segmentPolygonEntries } from './polygon';
import type { SimState } from './state';

// Engagement-area monitoring system (docs/adr/0010). Runs after movement and
// tests every straight piece each soldier travelled during the tick, so an
// entry is found exactly even when a soldier crosses an area between the
// tick's start and end positions. Entry means passing from outside onto the
// area's boundary; a soldier inside an area when it is set has not entered it.

export function monitorEngagementAreas(
  state: SimState,
  path: readonly PathSegment[],
  time: TickTime,
  events: SimEvent[],
): void {
  if (state.engagementAreas.length === 0) return;
  const order = new Map(state.soldiers.map((s, i) => [s.id, i]));
  const sideOf = new Map(state.soldiers.map((s) => [s.id, s.side]));

  const entries: EngagementAreaEnteredEvent[] = [];
  for (const area of state.engagementAreas) {
    for (const segment of path) {
      if (sideOf.get(segment.soldierId) !== area.monitoredSide) continue;
      const { from, to, startSeconds, endSeconds } = segment;
      for (const s of segmentPolygonEntries(from, to, area.vertices)) {
        entries.push({
          type: 'engagementAreaEntered',
          tick: time.tick,
          areaId: area.id,
          soldierId: segment.soldierId,
          // Speed is constant along a segment, so time is linear in distance.
          atSeconds: startSeconds + s * (endSeconds - startSeconds),
          point: { x: from.x + s * (to.x - from.x), y: from.y + s * (to.y - from.y) },
        });
      }
    }
  }
  // Report in the order entries happened; simultaneous ones in soldier order.
  entries.sort(
    (a, b) =>
      a.atSeconds - b.atSeconds || (order.get(a.soldierId) ?? 0) - (order.get(b.soldierId) ?? 0),
  );
  events.push(...entries);
}
