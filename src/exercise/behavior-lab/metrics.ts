import {
  behaviorDiagnostics,
  flattenFormation,
  type FormationNode,
  type SimEvent,
  type Simulation,
} from '#sim';

// Behavior Lab metrics (docs/behavior-lab/05 §3): measured from the
// simulation's state and its diagnostics, tick by tick, never from what a
// renderer drew.

export interface LabMetrics {
  /**
   * Formation error (m) over every Marine and tick while moving, once he
   * has fallen in (not while making for his slot after the order, nor settling).
   */
  readonly meanError: number;
  readonly maxError: number;
  readonly p95Error: number;
  /** The same, excluding the 10 s after each disturbance and the disturbed Marine while disturbed. */
  readonly steadyMeanError: number;
  readonly steadyMaxError: number;
  /** Largest error of the Marines who were never disturbed (m), while moving. */
  readonly othersMaxError: number;
  /**
   * After each disturbance ended: seconds until the Marine was back within
   * half an interval of his slot (and stayed 5 s); the longest, or null if
   * one never recovered. 0 when there was no disturbance.
   */
  readonly recoverySeconds: number | null;
  /** Elements' spread ÷ their template's spread, mean and worst (1: as designed). */
  readonly cohesionMean: number;
  readonly cohesionWorst: number;
  /** Fastest Marine (m/s), and fastest as a multiple of pace. */
  readonly maxSpeed: number;
  readonly maxSpeedRatio: number;
  /** Anchor speed (m/s) while moving: lowest and mean. */
  readonly anchorMinSpeed: number;
  readonly anchorMeanSpeed: number;
  /** Marine-seconds spent catching up. */
  readonly catchUpSeconds: number;
  /**
   * Speed reversals per Marine per minute while moving (oscillation): the
   * speed rising then falling (or the reverse) by more than 0.2 m/s² for at
   * least 0.5 s each way. Starting, stopping and settling are not counted.
   */
  readonly reversalsPerMinute: number;
  readonly worstReversalsPerMinute: number;
  /** Sideways speed (velocity across facing, m/s): mean and largest. */
  readonly meanSlip: number;
  readonly maxSlip: number;
  /** Distance walked per Marine (m): mean and longest; and the route's length. */
  readonly meanDistance: number;
  readonly maxDistance: number;
  readonly routeLength: number;
  /** Seconds from the first order to the last task's end, and how it ended. */
  readonly completionSeconds: number | null;
  readonly outcome: string | null;
  /** Times two soldiers came closer than 0.6 m (each approach counted once). */
  readonly collisions: number;
  /** Marines ever stuck or straggling. */
  readonly stuck: number;
  readonly straggling: number;
  /** Longest stop of the anchor between the first move and the final arrival (s). */
  readonly longestStop: number;
  /** Seconds from the first order until every Marine had fallen in (null: some never did). */
  readonly joinSeconds: number | null;
  /** Seconds of simulation measured. */
  readonly seconds: number;
}

/** A per-second sample for graphs. */
export interface LabSample {
  readonly t: number;
  readonly meanError: number;
  readonly maxError: number;
  readonly anchorSpeed: number;
  readonly worstLag: number;
  readonly speeds: readonly number[];
  readonly cohesion: number;
}

const CONTACT_M = 0.6;
const REVERSAL_ACCEL = 0.2;
const REVERSAL_HOLD_S = 0.5;
const DISTURBANCE_SETTLE_S = 10;

export interface MetricsRecorder {
  /** Call after every tick, with that tick's events. */
  sample(events: readonly SimEvent[]): void;
  result(): LabMetrics;
  readonly samples: readonly LabSample[];
}

/** Records metrics for the unit `unitId` of `sim` from now on. */
export function createMetrics(sim: Simulation, unitId: string): MetricsRecorder {
  const rate = sim.config.tickRateHz;
  const dt = 1 / rate;
  const errors: number[] = [];
  const steady: number[] = [];
  const cohesion: number[] = [];
  const samples: LabSample[] = [];
  let maxSpeed = 0;
  let maxRatio = 0;
  let anchorMin = Infinity;
  let anchorSum = 0;
  let anchorN = 0;
  let catchUp = 0;
  let slipSum = 0;
  let slipN = 0;
  let maxSlip = 0;
  let collisions = 0;
  const touching = new Set<string>();
  const stuck = new Set<string>();
  const straggling = new Set<string>();
  const distance = new Map<string, number>();
  const last = new Map<string, { x: number; y: number; v: number; sign: number; since: number }>();
  const reversals = new Map<string, number>();
  const disturbedUntil = new Map<string, number>();
  let quietUntil = -Infinity;
  let allJoinedAt: number | null = null;
  const everDisturbed = new Set<string>();
  const releasedAt = new Map<string, number>();
  const backSince = new Map<string, number>();
  const recoveries: number[] = [];
  let unrecovered = 0;
  let othersMax = 0;
  let firstOrder: number | null = null;
  let ended: number | null = null;
  let outcome: string | null = null;
  let movingSince: number | null = null;
  let stoppedSince: number | null = null;
  let longestStop = 0;
  let routeLength = 0;
  let measured = 0;
  let movingSeconds = 0;

  const templateSpread = new Map<string, number>();

  return {
    samples,
    sample(events) {
      const t = sim.timeSeconds;
      for (const e of events) {
        if (e.type === 'unitOrdered' && e.unitId === unitId) firstOrder ??= e.tick / rate;
        if (e.type === 'unitTaskEnded' && e.unitId === unitId && e.outcome !== 'superseded') {
          ended = e.atSeconds;
          outcome = e.outcome;
        }
      }
      const state = sim.state;
      const behavior = state.behavior;
      const task =
        behavior?.tasks.find((k) => k.unitId === unitId && k.outcome === null) ??
        behavior?.tasks.filter((k) => k.unitId === unitId).at(-1);
      if (!behavior || !task) return;
      routeLength = Math.max(routeLength, task.route.length);
      const diagnostics = behaviorDiagnostics(state, sim.world, t);
      const agents = diagnostics.agents.filter((a) => a.taskId === task.id);
      const moving = task.phase === 'moving';
      const soldiers = new Map(state.soldiers.map((s) => [s.id as string, s]));

      // Disturbances in effect, and the quiet period after them.
      const d = task.formation.interval;
      for (const a of agents) {
        if (a.override !== null) {
          disturbedUntil.set(a.soldierId, t + DISTURBANCE_SETTLE_S);
          quietUntil = t + DISTURBANCE_SETTLE_S;
          everDisturbed.add(a.soldierId);
          releasedAt.set(a.soldierId, Infinity);
          backSince.delete(a.soldierId);
        } else if (releasedAt.get(a.soldierId) === Infinity) {
          releasedAt.set(a.soldierId, t);
        }
        // Recovery: back within half an interval, and staying there 5 s.
        const released = releasedAt.get(a.soldierId);
        if (released !== undefined && released !== Infinity) {
          if (a.desire.error <= 0.5 * d) {
            const since = backSince.get(a.soldierId) ?? t;
            backSince.set(a.soldierId, since);
            if (t - since >= 5) {
              recoveries.push(since - released);
              releasedAt.delete(a.soldierId);
            }
          } else {
            backSince.delete(a.soldierId);
          }
        }
        if (a.stuck) stuck.add(a.soldierId);
        if (a.straggling) straggling.add(a.soldierId);
      }

      let tickErrorSum = 0;
      let tickErrorMax = 0;
      const speeds: number[] = [];
      for (const a of agents) {
        const soldier = soldiers.get(a.soldierId);
        if (!soldier) continue;
        speeds.push(a.speed);
        maxSpeed = Math.max(maxSpeed, a.speed);
        maxRatio = Math.max(maxRatio, a.speed / task.pace);
        if (a.desire.state === 'catchingUp') catchUp += dt;
        // Sideways speed: velocity across the facing.
        const agent = behavior.agents.find((g) => g.soldierId === a.soldierId);
        if (agent && a.speed > 0.05) {
          const slip = Math.abs(
            agent.vx * Math.cos(soldier.azimuth) - agent.vy * Math.sin(soldier.azimuth),
          );
          slipSum += slip;
          slipN += 1;
          maxSlip = Math.max(maxSlip, slip);
        }
        // Distance walked and speed reversals.
        const prev = last.get(a.soldierId);
        if (prev) {
          distance.set(
            a.soldierId,
            (distance.get(a.soldierId) ?? 0) +
              Math.hypot(soldier.position.x - prev.x, soldier.position.y - prev.y),
          );
          // Oscillation is measured on the move: starting, stopping and the
          // final settling are not reversals.
          const accel = (a.speed - prev.v) / dt;
          const sign = !moving ? 0 : accel > REVERSAL_ACCEL ? 1 : accel < -REVERSAL_ACCEL ? -1 : 0;
          if (!moving) {
            prev.sign = 0;
          } else if (sign !== 0 && sign !== prev.sign) {
            if (prev.sign !== 0 && t - prev.since >= REVERSAL_HOLD_S) {
              reversals.set(a.soldierId, (reversals.get(a.soldierId) ?? 0) + 1);
            }
            prev.sign = sign;
            prev.since = t;
          }
          prev.x = soldier.position.x;
          prev.y = soldier.position.y;
          prev.v = a.speed;
        } else {
          last.set(a.soldierId, {
            x: soldier.position.x,
            y: soldier.position.y,
            v: a.speed,
            sign: 0,
            since: t,
          });
        }
        if (moving && a.joined) {
          if (!everDisturbed.has(a.soldierId)) othersMax = Math.max(othersMax, a.desire.error);
          errors.push(a.desire.error);
          tickErrorSum += a.desire.error;
          tickErrorMax = Math.max(tickErrorMax, a.desire.error);
          if (t > quietUntil && (disturbedUntil.get(a.soldierId) ?? -Infinity) < t) {
            steady.push(a.desire.error);
          }
        }
      }

      if (allJoinedAt === null && agents.length > 0 && agents.every((a) => a.joined))
        allJoinedAt = t;
      // Contacts between any two soldiers (each approach once).
      const all = state.soldiers;
      for (let i = 0; i < all.length; i += 1) {
        for (let j = i + 1; j < all.length; j += 1) {
          const p = all[i]?.position;
          const q = all[j]?.position;
          if (!p || !q) continue;
          const key = `${String(i)}:${String(j)}`;
          if (Math.hypot(p.x - q.x, p.y - q.y) < CONTACT_M) {
            if (!touching.has(key)) collisions += 1;
            touching.add(key);
          } else {
            touching.delete(key);
          }
        }
      }

      // Cohesion: each element's spread against its template's.
      let cohesionTick = 0;
      let cohesionN = 0;
      const visit = (node: FormationNode) => {
        const ids = nodeSoldiers(node);
        const present = ids.map((id) => soldiers.get(id)).filter((s) => s !== undefined);
        if (ids.length >= 2 && present.length === ids.length) {
          let spread = templateSpread.get(node.unitId);
          if (spread === undefined) {
            spread = templateRms(node);
            templateSpread.set(node.unitId, spread);
          }
          const cx = present.reduce((s, p) => s + p.position.x, 0) / present.length;
          const cy = present.reduce((s, p) => s + p.position.y, 0) / present.length;
          const rms = Math.sqrt(
            present.reduce((s, p) => s + (p.position.x - cx) ** 2 + (p.position.y - cy) ** 2, 0) /
              present.length,
          );
          if (spread > 0) {
            cohesionTick += rms / spread;
            cohesionN += 1;
          }
        }
        node.children.forEach(visit);
      };
      if (moving) {
        visit(task.formation.root);
        if (cohesionN > 0) cohesion.push(cohesionTick / cohesionN);
      }

      // The anchor: speed while moving, and stops between the first move and arrival.
      if (moving) {
        movingSince ??= t;
        anchorMin = Math.min(anchorMin, task.anchorSpeed);
        anchorSum += task.anchorSpeed;
        anchorN += 1;
        if (task.anchorSpeed === 0) {
          stoppedSince ??= t;
          longestStop = Math.max(longestStop, t - stoppedSince);
        } else {
          stoppedSince = null;
        }
      }
      measured += dt;
      if (moving) movingSeconds += dt;

      if (sim.tick % rate === 0) {
        const pace = diagnostics.tasks.find((k) => k.taskId === task.id)?.pace;
        samples.push({
          t,
          meanError: agents.length > 0 ? tickErrorSum / agents.length : 0,
          maxError: tickErrorMax,
          anchorSpeed: task.anchorSpeed,
          worstLag: pace?.worstLag ?? 0,
          speeds,
          cohesion: cohesion.at(-1) ?? 1,
        });
      }
    },
    result() {
      const sorted = [...errors].sort((a, b) => a - b);
      const mean = (xs: number[]) =>
        xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
      const distances = [...distance.values()];
      const minutes = movingSeconds / 60;
      const perMarine = [...last.keys()].map(
        (id) => (reversals.get(id) ?? 0) / Math.max(minutes, 1e-9),
      );
      unrecovered = [...releasedAt.values()].length;
      return {
        othersMaxError: othersMax,
        recoverySeconds: unrecovered > 0 ? null : recoveries.reduce((m, v) => Math.max(m, v), 0),
        meanError: mean(errors),
        maxError: sorted.at(-1) ?? 0,
        p95Error: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
        steadyMeanError: mean(steady),
        steadyMaxError: steady.reduce((m, v) => Math.max(m, v), 0),
        cohesionMean: mean(cohesion),
        cohesionWorst: cohesion.reduce((m, v) => Math.max(m, v), 0),
        maxSpeed,
        maxSpeedRatio: maxRatio,
        anchorMinSpeed: anchorN > 0 ? anchorMin : 0,
        anchorMeanSpeed: anchorN > 0 ? anchorSum / anchorN : 0,
        catchUpSeconds: catchUp,
        reversalsPerMinute: mean(perMarine),
        worstReversalsPerMinute: perMarine.reduce((m, v) => Math.max(m, v), 0),
        meanSlip: slipN > 0 ? slipSum / slipN : 0,
        maxSlip,
        meanDistance: mean(distances),
        maxDistance: distances.reduce((m, v) => Math.max(m, v), 0),
        routeLength,
        completionSeconds: ended !== null && firstOrder !== null ? ended - firstOrder : null,
        outcome,
        collisions,
        stuck: stuck.size,
        straggling: straggling.size,
        longestStop,
        joinSeconds: allJoinedAt !== null && firstOrder !== null ? allJoinedAt - firstOrder : null,
        seconds: measured,
      };
    },
  };
}

function nodeSoldiers(node: FormationNode): string[] {
  return [...node.slots.map((s) => s.soldierId as string), ...node.children.flatMap(nodeSoldiers)];
}

/** RMS distance of a node's slots (its whole subtree) from their centre, as designed. */
function templateRms(node: FormationNode): number {
  const flat = flattenFormation({ root: { ...node, back: 0, right: 0 }, interval: 1 });
  const n = flat.back.length;
  const cb = flat.back.reduce((a, b) => a + b, 0) / n;
  const cr = flat.right.reduce((a, b) => a + b, 0) / n;
  let s = 0;
  for (let i = 0; i < n; i += 1)
    s += ((flat.back[i] ?? 0) - cb) ** 2 + ((flat.right[i] ?? 0) - cr) ** 2;
  return Math.sqrt(s / n);
}
