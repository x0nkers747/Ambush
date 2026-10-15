import {
  confidenceAt,
  type DeepReadonly,
  type FofOutcome,
  type ForcePhase,
  type Side,
  type SimEvent,
  type SimState,
  type Simulation,
} from '#sim';

// Force-on-force metrics (docs/behavior-lab/force-on-force/04): what the lab
// shows and the experiments and sweeps report. Read from the simulation's
// state and events only, recorded as the run goes; recording changes nothing.

/** One side's picture and condition at a whole second. */
export interface FofSideSample {
  readonly phase: ForcePhase;
  readonly effectiveness: number;
  /** Active ÷ initial members. */
  readonly strength: number;
  readonly suppression: number;
  /** Rounds left ÷ basic load. */
  readonly ammunition: number;
  /** Its tracks by level. */
  readonly possible: number;
  readonly detected: number;
  readonly identified: number;
  readonly lost: number;
  /** Highest confidence among its current tracks (0 without any). */
  readonly confidence: number;
}

export interface FofSample {
  readonly seconds: number;
  readonly sides: Readonly<Record<Side, FofSideSample>>;
}

export interface FofSideMetrics {
  /** First possible contact, confirmed detection and identification: time (s) and range (m). */
  readonly firstPossible: { seconds: number; rangeM: number | null } | null;
  readonly firstDetected: { seconds: number; rangeM: number | null } | null;
  readonly firstIdentified: { seconds: number; rangeM: number | null } | null;
  readonly detectionAttempts: number;
  readonly glimpses: number;
  /** Tracks that went to lost, and lost tracks regained. */
  readonly contactsLost: number;
  readonly reacquisitions: number;
  readonly bursts: number;
  readonly rounds: number;
  readonly hits: number;
  readonly casualties: number;
  /** Soldier-seconds suppressed or pinned. */
  readonly suppressedSeconds: number;
  readonly effectiveness: number;
  /** Share of its soldiers who fired at least once. */
  readonly participation: number;
  readonly phase: ForcePhase;
}

export interface FofMetrics {
  readonly sides: Readonly<Record<Side, FofSideMetrics>>;
  /** First burst of either side, and how long from it to the end (or now). */
  readonly engagementStart: number | null;
  readonly engagementSeconds: number;
  readonly outcome: FofOutcome | null;
  /** Simulated seconds so far. */
  readonly seconds: number;
  /** Transitions the model refused or reported as invalid (always 0 in a healthy run). */
  readonly invalidTransitions: number;
}

export interface FofMetricsRecorder {
  sample(events: readonly SimEvent[]): void;
  readonly samples: readonly FofSample[];
  result(): FofMetrics;
}

const SIDES: readonly Side[] = ['BLUEFOR', 'OPFOR'];

/**
 * One state's sample: each side's condition and picture (`halfLife`: the
 * configuration's confidence half-life).
 */
export function sampleState(
  state: DeepReadonly<SimState>,
  seconds: number,
  halfLife: number,
): FofSample | null {
  const fof = state.fof;
  if (!fof) return null;
  const sides = {} as Record<Side, FofSideSample>;
  fof.forces.forEach((force, i) => {
    let active = 0;
    let rounds = 0;
    for (const m of fof.soldiers) {
      if (m.force !== i) continue;
      rounds += m.rounds;
      if (state.soldiers.find((s) => s.id === m.soldierId)?.status === 'active') active += 1;
    }
    const counts = { possible: 0, detected: 0, identified: 0, lost: 0 };
    let confidence = 0;
    for (const t of fof.tracks) {
      if (t.force !== i) continue;
      counts[t.level] += 1;
      if (t.level !== 'lost') confidence = Math.max(confidence, confidenceAt(t, seconds, halfLife));
    }
    sides[force.side] = {
      phase: force.phase,
      effectiveness: force.effectiveness,
      strength: force.memberIds.length > 0 ? active / force.memberIds.length : 0,
      suppression: force.meanSuppression,
      ammunition: force.initialRounds > 0 ? rounds / force.initialRounds : 0,
      ...counts,
      confidence,
    };
  });
  return { seconds, sides };
}

export function createFofMetrics(sim: Simulation): FofMetricsRecorder {
  const rate = sim.config.tickRateHz;
  const halfLife = sim.world.fof?.config.detection.confidenceHalfLifeSeconds ?? 15;
  const samples: FofSample[] = [];
  const first = {
    possible: new Map<Side, { seconds: number; rangeM: number | null }>(),
    detected: new Map<Side, { seconds: number; rangeM: number | null }>(),
    identified: new Map<Side, { seconds: number; rangeM: number | null }>(),
  };
  const lost = new Map<Side, number>();
  const regained = new Map<Side, number>();
  const fired = new Set<string>();
  let engagementStart: number | null = null;
  let invalid = 0;

  const take = () => {
    if (sim.tick % rate !== 0) return;
    const s = sampleState(sim.state, sim.tick / rate, halfLife);
    if (s) samples.push(s);
  };
  take();

  return {
    samples,
    sample(events) {
      for (const e of events) {
        if (e.type === 'contactObserved') {
          for (const level of ['possible', 'detected', 'identified'] as const) {
            if (e.to === level && !first[level].has(e.side)) {
              first[level].set(e.side, { seconds: e.atSeconds, rangeM: e.rangeM });
            }
          }
          if (e.to === 'lost') lost.set(e.side, (lost.get(e.side) ?? 0) + 1);
          if (e.from === 'lost' && (e.to === 'detected' || e.to === 'identified')) {
            regained.set(e.side, (regained.get(e.side) ?? 0) + 1);
          }
        } else if (e.type === 'fofFire') {
          engagementStart ??= e.atSeconds;
          fired.add(e.shooterId);
        } else if (e.type === 'fofEnded' && e.outcome.basis === 'invalid') {
          invalid += 1;
        } else if (e.type === 'commandRejected' && e.reason !== 'unitInContact') {
          invalid += 1;
        }
      }
      take();
    },
    result() {
      const fof = sim.state.fof;
      const seconds = sim.tick / rate;
      const sides = {} as Record<Side, FofSideMetrics>;
      for (const side of SIDES) {
        const i = fof?.forces.findIndex((f) => f.side === side) ?? -1;
        const force = fof?.forces[i];
        const members = fof?.soldiers.filter((m) => m.force === i) ?? [];
        sides[side] = {
          firstPossible: first.possible.get(side) ?? null,
          firstDetected: first.detected.get(side) ?? null,
          firstIdentified: first.identified.get(side) ?? null,
          detectionAttempts: force?.stats.detectionAttempts ?? 0,
          glimpses: force?.stats.glimpses ?? 0,
          contactsLost: lost.get(side) ?? 0,
          reacquisitions: regained.get(side) ?? 0,
          bursts: force?.stats.bursts ?? 0,
          rounds: force?.stats.rounds ?? 0,
          hits: force?.stats.hits ?? 0,
          casualties: members.filter(
            (m) => sim.state.soldiers.find((s) => s.id === m.soldierId)?.status !== 'active',
          ).length,
          suppressedSeconds: members.reduce((sum, m) => sum + m.stats.suppressedSeconds, 0),
          effectiveness: force?.effectiveness ?? 0,
          participation:
            members.length > 0
              ? members.filter((m) => fired.has(m.soldierId)).length / members.length
              : 0,
          phase: force?.phase ?? 'moving',
        };
      }
      const outcome = fof?.outcome ?? null;
      const end = outcome?.atSeconds ?? seconds;
      return {
        sides,
        engagementStart,
        engagementSeconds: engagementStart === null ? 0 : Math.max(0, end - engagementStart),
        outcome,
        seconds,
        invalidTransitions: invalid,
      };
    },
  };
}
