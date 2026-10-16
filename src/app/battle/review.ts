import { createBattle, type Battle } from '#exercise/battle';
import type { Side, TerrainDataset } from '#sim';
import { createLocalDriver, type DriverFactory } from './driver';
import type { BattleRecording, BattleRun } from './session';
import {
  squadStatus,
  squadStatuses,
  summarize,
  vehicleStatuses,
  type BattleSummary,
  type SquadStatus,
  type VehicleStatus,
} from './status';

// The After-Action Review (docs/constructive-simulation/05): the whole
// battle, replayed from tick 0 by re-simulation, from its recording (the
// spec, every command with its origin, and a state hash for every second).
// Nothing is taken on trust from the live run: the replay steps the real
// simulation again with the recorded commands, and each second's state hash
// is checked against the recording's as it is reached.
//
// The review shows the battle at a moment (the playhead): the soldiers from
// the replay's motion log, the squads' states from a second battle (the
// view) brought to that tick, from the replay's nearest keyframe before it
// and stepped on from there. The timeline's markers (contact, casualties,
// squads combat ineffective or withdrawn, the user's orders) come from the
// replay's events and the recording's commands.

export const REVIEW_SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16] as const;
export type ReviewSpeed = (typeof REVIEW_SPEEDS)[number];

/** How long a frame may re-simulate (ms; the replay, and the view when seeking). */
export const REVIEW_BUDGET_MS = 30;

export interface Verification {
  /** Seconds whose hash was compared. */
  readonly checked: number;
  readonly mismatches: number;
  /** The first second whose hash differed, or `null`. */
  readonly firstMismatch: number | null;
  /** The replay has reached the end of the recording. */
  readonly complete: boolean;
}

export type MarkerKind = 'contact' | 'casualty' | 'order' | 'ineffective' | 'withdrawn';

/** A moment on the timeline. */
export interface ReviewMarker {
  readonly seconds: number;
  readonly kind: MarkerKind;
  readonly side: Side;
  /** The squad it is about. */
  readonly squadId: string;
  readonly text: string;
}

/** A squad's phase over the battle. */
export interface PhaseChange {
  readonly seconds: number;
  readonly phase: string;
  readonly reason: string;
}

export interface Review {
  readonly recording: BattleRecording;
  /** The re-simulation from tick 0 (here, or in the worker). */
  readonly replay: BattleRun;
  readonly endSeconds: number;
  /** How far the replay has got. */
  readonly replayedSeconds: number;
  readonly verification: Verification;
  /** The playhead (simulation seconds). */
  readonly seconds: number;
  readonly playing: boolean;
  readonly speed: ReviewSpeed;
  play(): void;
  pause(): void;
  setSpeed(speed: ReviewSpeed): void;
  /** Moves the playhead (within what has been replayed). */
  seek(seconds: number): void;
  /** The page's frame: re-simulates on, and moves the playhead while playing. */
  frame(dtSeconds: number, budgetMs?: number): void;
  /** The battle at the playhead's tick (the view). */
  readonly view: Battle;
  squads(): readonly SquadStatus[];
  squad(id: string | null): SquadStatus | undefined;
  /** The vehicles at the playhead (docs/vehicles.md). */
  vehicles(): readonly VehicleStatus[];
  /** The timeline's markers so far, in time order. */
  markers(): readonly ReviewMarker[];
  /** A squad's phases up to the playhead. */
  phases(squadId: string): readonly PhaseChange[];
  /** The battle's results at its end (once replayed), else at the playhead. */
  summary(): BattleSummary;
  /** Stops the replay (its worker's battle). */
  dispose(): void;
}

export interface ReviewOptions {
  readonly terrain: TerrainDataset;
  readonly recording: BattleRecording;
  /** How long a frame may re-simulate (ms; default `REVIEW_BUDGET_MS`). */
  readonly budgetMs?: number;
  /** Where the replay is simulated (default: here). */
  readonly driver?: DriverFactory;
}

export function createReview(o: ReviewOptions): Review {
  const { recording, terrain } = o;
  const budget = o.budgetMs ?? REVIEW_BUDGET_MS;
  const spec = recording.spec;
  const rate = spec.tickRateHz;
  const replayCommands = { commands: recording.commands, origins: recording.origins };
  const driver = (o.driver ?? createLocalDriver(terrain))(spec, replayCommands);
  const replay = driver.run;
  const view = createBattle(spec, terrain, replayCommands);
  const squadOfUnit = new Map(replay.battle.squads.map((s) => [s.unitId, s]));
  const squadOfSoldier = new Map(
    replay.battle.squads.flatMap((s) => s.soldierIds.map((id) => [id, s])),
  );
  const endSeconds = recording.endTick / rate;

  let checked = 0;
  let mismatches = 0;
  let firstMismatch: number | null = null;
  let checkedTo = -1;
  let playhead = 0;
  let playing = false;
  let speed: ReviewSpeed = 1;
  let summaryAtEnd: BattleSummary | null = null;
  const markers: ReviewMarker[] = [];
  let markedEvents = 0;

  // The user's orders, from the recording.
  recording.commands.forEach((command, i) => {
    if (recording.origins[i] !== 'user' || command.type !== 'orderSquad') return;
    const squad = squadOfUnit.get(command.unitId);
    if (!squad) return;
    const what =
      command.orders.length === 0 ? 'hold' : command.orders.map((x) => x.kind).join(', then ');
    markers.push({
      seconds: command.tick / rate,
      kind: 'order',
      side: squad.side,
      squadId: squad.spec.id,
      text: `${squad.name}: ${command.mode === 'append' ? 'appended' : 'ordered'} ${what}`,
    });
  });

  /** Markers from the replay's events since the last call. */
  const markEvents = () => {
    const events = replay.events;
    for (; markedEvents < events.length; markedEvents += 1) {
      const e = events[markedEvents]?.event;
      if (!e) continue;
      if (e.type === 'soldierIncapacitated') {
        const squad = squadOfSoldier.get(e.soldierId);
        if (squad)
          markers.push({
            seconds: e.atSeconds,
            kind: 'casualty',
            side: squad.side,
            squadId: squad.spec.id,
            text: `${e.soldierId} (${squad.name}) hit by ${e.byId}`,
          });
      } else if (e.type === 'forcePhaseChanged') {
        const squad = squadOfUnit.get(e.unitId);
        if (!squad) continue;
        const kind: MarkerKind | null =
          e.to === 'contact'
            ? 'contact'
            : e.to === 'ineffective'
              ? 'ineffective'
              : e.to === 'withdrawn'
                ? 'withdrawn'
                : null;
        if (kind)
          markers.push({
            seconds: e.atSeconds,
            kind,
            side: squad.side,
            squadId: squad.spec.id,
            text: `${squad.name}: ${kind === 'contact' ? 'contact' : kind === 'ineffective' ? 'combat ineffective' : 'withdrawn'} (${e.reason})`,
          });
      }
    }
    markers.sort((a, b) => a.seconds - b.seconds);
  };

  /** Compares the replay's hashes with the recording's, up to where it has got. */
  const verify = () => {
    const upTo = Math.floor(replay.tick / rate);
    for (let second = checkedTo + 1; second <= upTo; second += 1) {
      const expected = recording.hashes[second];
      const got = replay.hashes[second];
      // Not here yet (the worker's next batch has it): checked then.
      if (got === undefined) break;
      checkedTo = second;
      if (typeof expected !== 'string') continue;
      checked += 1;
      if (got !== expected) {
        mismatches += 1;
        firstMismatch ??= second;
      }
    }
  };

  /** Brings the view to `tick`: on from where it is, or from the replay's last keyframe before it. */
  const positionView = (tick: number) => {
    const sim = view.sim;
    if (sim.tick === tick) return;
    let from = -1;
    for (const k of replay.keyframes.keys()) if (k <= tick && k > from) from = k;
    // Stepping on is quicker when the view is already between that keyframe and the tick.
    if (!(sim.tick < tick && sim.tick >= from)) {
      const snapshot = replay.keyframes.get(from);
      if (!snapshot) return;
      sim.restore(snapshot);
      for (const command of recording.commands) if (command.tick >= from) sim.submit(command);
    }
    while (sim.tick < tick) sim.step();
  };

  const advanceReplay = (budgetMs = budget) => {
    if (replay.tick < recording.endTick) driver.advance(recording.endTick, budgetMs);
    // What has come in since (stepped here, or posted by the worker).
    verify();
    markEvents();
    if (replay.tick >= recording.endTick && !summaryAtEnd) {
      // The end, as the view has it (brought there from the replay's keyframes).
      const at = playhead;
      positionView(recording.endTick);
      summaryAtEnd = summarize(squadStatuses(view, view.sim.state), endSeconds);
      positionView(Math.floor(at * rate));
    }
  };
  advanceReplay();

  const review: Review = {
    recording,
    replay,
    endSeconds,
    get replayedSeconds() {
      return replay.seconds;
    },
    get verification() {
      return { checked, mismatches, firstMismatch, complete: replay.tick >= recording.endTick };
    },
    get seconds() {
      return playhead;
    },
    get playing() {
      return playing;
    },
    get speed() {
      return speed;
    },
    play() {
      if (playhead >= endSeconds - 1e-9) playhead = 0;
      playing = true;
    },
    pause() {
      playing = false;
    },
    setSpeed(next) {
      speed = next;
    },
    seek(seconds) {
      playhead = Math.max(0, Math.min(seconds, replay.seconds, endSeconds));
      positionView(Math.floor(playhead * rate));
    },
    frame(dtSeconds, budgetMs) {
      advanceReplay(budgetMs);
      if (playing) {
        playhead += Math.max(0, Math.min(dtSeconds, 0.25)) * speed;
        if (playhead >= endSeconds) {
          playhead = endSeconds;
          playing = false;
        }
        // Not past the replay: playing waits for it.
        playhead = Math.min(playhead, replay.seconds);
      }
      positionView(Math.floor(playhead * rate));
    },
    view,
    squads: () => squadStatuses(view, view.sim.state),
    vehicles: () => vehicleStatuses(view.sim.state),
    squad: (id) => (id === null ? undefined : squadStatus(view, view.sim.state, id)),
    markers: () => markers,
    phases(squadId) {
      const squad = replay.battle.squads.find((s) => s.spec.id === squadId);
      if (!squad) return [];
      const out: PhaseChange[] = [];
      for (const e of replay.events) {
        if (e.seconds > playhead) break;
        const ev = e.event;
        if (ev.type === 'forcePhaseChanged' && ev.unitId === squad.unitId)
          out.push({ seconds: e.seconds, phase: ev.to, reason: ev.reason });
      }
      return out;
    },
    summary: () => summaryAtEnd ?? summarize(review.squads(), playhead),
    dispose: () => {
      driver.dispose();
    },
  };
  return review;
}
