import {
  TRAINEE_SIDE,
  type CommitResult,
  type DeploymentStatus,
  type EngagementResult,
  type Exercise,
  type ExerciseEvent,
  type RosterUnit,
} from '#exercise';
import type { Session } from '#session';
import { soldierId, type EngagementEndReason, type SimEvent, type SoldierId } from '#sim';
import { formatBearing, type TacticalMap } from '#view2d';
import { STATUS_LABELS } from './roster';
import { escapeHtml } from './shell';

// The exercise in stages 3–5 (docs/adr/0009, docs/adr/0019, docs/adr/0025):
// executing the BLUEFOR plan, the OPFOR approach and the ambush, and what the
// side panel says about them. The exercise itself decides what is allowed;
// this module only reads it and calls its actions. The exercise can be
// replaced (a restart), so it is always read through `exercise()`.

/** Whole minutes and seconds, `mm:ss`. */
export function minutesSeconds(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}

/** Minutes and seconds to a tenth, `mm:ss.s`. */
export function clock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${(seconds - minutes * 60).toFixed(1).padStart(4, '0')}`;
}

const END_REASONS: Readonly<Record<EngagementEndReason, string>> = {
  allOpforIncapacitated: 'all OPFOR incapacitated',
  opforEscaped: 'every remaining OPFOR soldier escaped',
  allBluforIncapacitated: 'all BLUEFOR incapacitated',
  noCombatCapable: 'nobody left able to fire',
  timeLimit: 'time limit reached',
};

/** Status counts, e.g. "12 at the ORP". */
const COUNT_LABELS: Readonly<Record<DeploymentStatus, string>> = {
  atOrp: 'at the ORP',
  destinationAssigned: 'with a destination',
  moving: 'moving',
  inPosition: 'in position',
  holding: 'holding',
};

export interface ExerciseStageOptions {
  readonly exercise: () => Exercise;
  readonly session: () => Session;
  readonly map: TacticalMap;
}

export interface ExerciseStage {
  /** Whether the simulation is running (not paused, in a phase that runs). */
  isRunning(): boolean;
  canResume(): boolean;
  execute(): void;
  pause(): void;
  resume(): void;
  startOpfor(): void;
  triggerAmbush(): void;
  /** The exercise's phase in words, e.g. "BLUEFOR occupation". */
  phaseLabel(): string;
  /** Problems from the last refused action (Execute, Resume, START OPFOR, TRIGGER AMBUSH). */
  readonly problems: readonly string[];
  /** Adds the frame's simulation events and new milestones to the event log. */
  collect(events: readonly SimEvent[]): void;
  /** Starts the log again (a new exercise). */
  resetLog(): void;
  eventsHtml(): string;
  /**
   * In the After Action Review: the event log as it read live at the replay's
   * moment, from the trigger on (empty at T+0).
   */
  replayEventsHtml(): string;
  soldierName(id: string): string;
  bluforHtml(): string;
  opforHtml(): string;
  engagementHtml(): string;
  selectionHtml(editing: boolean): string;
  visibilityHtml(): string;
  /** The map banner for a stage, or `null`. */
  bannerHtml(stage: 'bluefor' | 'combat'): string | null;
  /** Wires the selection panel's buttons (clear destination, default facing, …). */
  wireSelection(element: HTMLElement): void;
}

export function createExerciseStage(o: ExerciseStageOptions): ExerciseStage {
  const ex = o.exercise;
  let problems: string[] = [];
  const eventLog: string[] = [];
  let timelineSeen = 0;
  let logged: Exercise | null = null;

  const soldierName = (id: string): string => {
    const member = ex().rosterMember(soldierId(id));
    return member ? `${member.slot.label} (${id})` : id;
  };

  const report = (result: CommitResult) => {
    problems = result.ok
      ? []
      : result.problems.map((p) => `${soldierName(p.soldierId)}: ${p.problem}`);
  };

  const isRunning = () => {
    const e = ex();
    return (
      !e.paused &&
      (e.phase === 'bluforOccupation' || e.phase === 'opforApproach' || e.phase === 'engagement')
    );
  };
  const canResume = () => {
    const e = ex();
    return e.paused || (e.phase === 'bluforReady' && e.hasUncommittedChanges);
  };

  /** One log line for a simulation event; `e` is the exercise as it was just after it. */
  const describeEvent = (event: SimEvent, e: Exercise = ex()): string | undefined => {
    switch (event.type) {
      case 'waypointReached': {
        const waypoint = e.simulation.state.soldiers
          .find((s) => s.id === event.soldierId)
          ?.orders?.orders.waypoints.find((w) => w.id === event.waypointId);
        const where = waypoint ? ` at E ${waypoint.x.toFixed(0)} N ${waypoint.y.toFixed(0)}` : '';
        const what = e.isPlannable(event.soldierId) ? 'destination' : 'route point';
        return `${clock(event.atSeconds)}  ${soldierName(event.soldierId)} reached ${what}${where}`;
      }
      case 'soldierInPosition':
        return `${clock(event.atSeconds)}  ${soldierName(event.soldierId)} in position`;
      case 'commandRejected':
        return `${clock(event.tick / e.simulation.config.tickRateHz)}  Command rejected (${event.reason})`;
      case 'opforReacted':
        return `${clock(event.atSeconds)}  ${soldierName(event.soldierId)} ${
          event.reaction === 'flee'
            ? event.fleeBlocked
              ? 'tried to flee, found no way out, went prone'
              : 'flees'
            : 'drops prone and returns fire'
        }`;
      case 'soldierIncapacitated':
        return `${clock(event.atSeconds)}  ${soldierName(event.soldierId)} INCAPACITATED by ${soldierName(event.byId)}`;
      case 'soldierEscaped':
        return `${clock(event.atSeconds)}  ${soldierName(event.soldierId)} escaped`;
      case 'ordersChanged':
      case 'engagementAreaChanged':
      case 'engagementAreaEntered':
      case 'engagementStarted':
      case 'engagementEnded':
        // Covered by the exercise's own milestones.
        return undefined;
      case 'shotFired':
        // Too many for the log; counted in the engagement panel and drawn on the map.
        return undefined;
      case 'unitOrdered':
      case 'unitPhaseChanged':
      case 'unitTaskEnded':
      case 'memberReleased':
        // Unit orders (docs/behavior-lab) are not given in the exercise.
        return undefined;
      case 'contactObserved':
      case 'forcePhaseChanged':
      case 'orderChanged':
      case 'fofFire':
      case 'suppressionChanged':
      case 'fofEnded':
        // Force-on-force runs only in its lab (docs/behavior-lab/force-on-force).
        return undefined;
    }
  };

  const describeMilestone = (event: ExerciseEvent): string => {
    const at = clock(event.timeSeconds);
    switch (event.type) {
      case 'planCommitted': {
        const { revision } = event;
        const changed = revision.changedSoldierIds.length;
        return `${at}  Plan revision ${String(revision.revision)} committed (${String(changed)} Marine${changed === 1 ? '' : 's'} re-tasked)`;
      }
      case 'paused':
        return `${at}  Paused`;
      case 'resumed':
        return `${at}  Resumed`;
      case 'bluforInPosition':
        return `${at}  BLUEFOR in position`;
      case 'opforStarted':
        return `${at}  START OPFOR: OPFOR approach begins`;
      case 'killZoneEntered':
        return `${at}  ${soldierName(event.soldierId)} entered the kill zone`;
      case 'killZoneLeft':
        return `${at}  ${soldierName(event.soldierId)} left the kill zone`;
      case 'ambushTriggered': {
        const { trigger } = event;
        return `${clock(trigger.atSeconds)}  AMBUSH TRIGGERED${trigger.whilePaused ? ' (while paused; begins on resume)' : ''}: ${String(trigger.opforInKillZone)} of ${String(trigger.opforTotal)} OPFOR in the kill zone`;
      }
      case 'engagementEnded':
        return `${at}  ENGAGEMENT ENDED: ${END_REASONS[event.result.endReason ?? 'timeLimit']}`;
    }
  };

  /** Walked length of a planned route, metres. */
  const routeLength = (id: SoldierId): number => {
    const route = ex().displayedRoute(id);
    const leg = route?.legs[0];
    if (!route || !leg) return 0;
    const points = [route.start, ...(leg.turns ?? []), leg.to];
    return points
      .slice(1)
      .reduce(
        (sum, p, k) => sum + Math.hypot(p.x - (points[k]?.x ?? p.x), p.y - (points[k]?.y ?? p.y)),
        0,
      );
  };

  const unitName = (templateUnitId: string): string => {
    const find = (node: RosterUnit): string | undefined =>
      node.unit.id === templateUnitId ? node.unit.name : node.children.map(find).find(Boolean);
    return find(ex().roster) ?? templateUnitId;
  };

  const lockedNote = (editing: boolean) =>
    editing
      ? '<p class="muted">Pause to change positions; they can be changed while occupation is paused or once BLUEFOR is in position.</p>'
      : '';

  /** The selected squad or fire team: its Marines and its formation. */
  const teamHtml = (unitId: string, editing: boolean): string => {
    const e = ex();
    const team = e.formationGroups.find((t) => t.unitId === unitId);
    if (!team) return '';
    const editable = editing && e.canEditPlans;
    const formation = e.formation(unitId);
    const linked = new Set(formation?.linked ?? []);
    const rows = team.memberIds
      .map((id, i) => {
        const member = e.rosterMember(id);
        const status = e.deploymentStatus(id) ?? 'atOrp';
        const own = formation && !linked.has(id) ? ' · own orders' : '';
        return `<li>${String(i + 1)}. ${escapeHtml(member?.slot.label ?? id)} (${escapeHtml(id)}) · ${STATUS_LABELS[status]}${own}</li>`;
      })
      .join('');
    const detached = team.memberIds.filter((id) => formation && !linked.has(id));
    const formationText = formation
      ? `<p>Line, ${String(formation.spacingM)} m apart · centre E ${formation.centre.x.toFixed(0)} N ${formation.centre.y.toFixed(0)} · facing ${formatBearing(formation.azimuth)}</p>
       <p class="muted">${
         detached.length === 0
           ? `Moving or turning the formation moves all ${String(linked.size)} Marines.`
           : `Moving or turning the formation moves ${String(linked.size)} of ${String(team.memberIds.length)} Marines; ${detached.map((id) => escapeHtml(e.rosterMember(id)?.slot.label ?? id)).join(', ')} keep${detached.length === 1 ? 's' : ''} their own orders.`
       }</p>`
      : `<p class="muted">${editable && o.session().tool === 'deploy' ? `Click the map to place the ${escapeHtml(team.name)} in a line centred there, slot 1 on the left.` : 'No formation.'}</p>`;
    const buttons = editable
      ? `<p class="buttons"><button data-action="clear-formation" title="Delete the formation" ${formation ? '' : 'disabled'}>Reset</button></p>`
      : lockedNote(editing);
    return `
    <div class="soldier-title">${escapeHtml(team.name)}</div>
    <div class="muted">${String(team.memberIds.length)} Marines, in formation slot order (left to right, facing the way the formation faces)</div>
    <ol class="team-members">${rows}</ol>
    <h3>Formation</h3>
    ${formationText}
    ${buttons}`;
  };

  const selectionHtml = (editing: boolean): string => {
    const e = ex();
    const session = o.session();
    if (session.selectedFireTeamId !== null) return teamHtml(session.selectedFireTeamId, editing);
    const id = session.selectedSoldierId;
    // Nothing selected: the hint above the roster says what to do (SELECT_HINT).
    if (id === null) return '';
    const soldier = e.simulation.state.soldiers.find((s) => s.id === id);
    const plan = e.displayedPlan(id);
    const member = e.rosterMember(id);
    const facing = e.displayedFacing(id);
    if (!soldier || !plan || !member || !facing) return '';
    const editable = editing && e.canEditPlans;
    const route = e.displayedRoute(id);
    const problem = route?.legs[0]?.problem;
    const status = e.deploymentStatus(id) ?? 'atOrp';
    const d = plan.destination;
    const length = routeLength(id);
    const speed = e.simulation.world.movement.speed;
    const detour = (route?.legs[0]?.turns?.length ?? 0) > 0 ? ' · bends round buildings' : '';
    const destination = d
      ? `<p>E ${d.east.toFixed(0)} · N ${d.north.toFixed(0)}</p>
       <p class="muted">${
         length < 0.5
           ? 'The Marine is there.'
           : `${length.toFixed(0)} m from where the Marine stands · about ${clock(length / speed)} at ${String(speed)} m/s${detour}`
       }</p>
       ${problem ? `<p class="alert">The destination is ${escapeHtml(problem)}.</p>` : ''}`
      : `<p class="muted">None: stays where they are.${editable && session.tool === 'deploy' ? ' Click the map to set one.' : ''}</p>`;
    const buttons = editable
      ? `<p class="buttons"><button data-action="reset-plan" title="Back to the last executed plan">Reset</button></p>`
      : lockedNote(editing);
    return `
    <div class="soldier-title">${escapeHtml(member.slot.label)} · ${escapeHtml(member.role.name)}</div>
    <div class="muted">${escapeHtml(id)} · ${escapeHtml(unitName(member.slot.unitId))}${member.leads ? ' · leader' : ''} · ${STATUS_LABELS[status]}</div>
    <h3>Destination</h3>
    ${destination}
    <h3>Facing <span class="facing">${formatBearing(facing.azimuth)}</span></h3>
    <div class="muted">${facing.explicit ? 'Set by you.' : d ? 'Default: the direction of arrival. Drag the yellow handle to choose one.' : 'Default: the current facing.'}</div>
    ${buttons}`;
  };

  const visibilityHtml = (): string => {
    const e = ex();
    const session = o.session();
    if (!session.showVisibility) return '';
    const id = session.selectedSoldierId;
    const view = o.map.visibility;
    const team = e.formationGroups.find((t) => t.unitId === session.selectedFireTeamId);
    if ((id === null && !team) || !view)
      return '<p class="muted">Select a Marine, a fire team or the squad to see the visible area in their firing arcs.</p>';
    if (view.failed) {
      return '<p class="alert">Visibility cannot be calculated in this browser (its background workers failed).</p>';
    }
    // The viewshed shown may still be the previous one while the new one is computed.
    const shown = view.viewshed;
    const current =
      shown !== null && shown.observer.x === view.observer.x && shown.observer.y === view.observer.y
        ? shown
        : null;
    // Kill-zone coverage only from a complete viewshed: a preview's rows between are copies.
    const coverage =
      e.killZone && current && !view.preview ? e.killZoneCoverage(current) : undefined;
    return `${view.pending ? '<p class="muted">Calculating…</p>' : ''}${
      coverage
        ? `<p><b>Kill zone visible in the firing arcs: ${coverage.percent.toFixed(0)}%</b></p>`
        : ''
    }`;
  };

  const bluforHtml = (): string => {
    const e = ex();
    const trainee = e.simulation.state.soldiers.filter((s) => s.side === TRAINEE_SIDE);
    const counts = new Map<DeploymentStatus, number>();
    for (const s of trainee) {
      const status = e.deploymentStatus(s.id) ?? 'atOrp';
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    const parts = (Object.keys(STATUS_LABELS) as DeploymentStatus[])
      .filter((k) => (counts.get(k) ?? 0) > 0)
      .map((k) => `${String(counts.get(k))} ${COUNT_LABELS[k]}`);
    const moving = counts.get('moving') ?? 0;
    const cls =
      e.phase !== 'bluforPlanning' && moving > 0 ? 'warn' : e.phase === 'bluforReady' ? 'ok' : '';
    return `<span class="${cls}">${parts.join(' · ')}</span>`;
  };

  const opforHtml = (): string => {
    const e = ex();
    const result = e.engagementResult;
    if (result)
      return `<span class="alert">${String(result.sides.OPFOR.incapacitated)} incapacitated · ${String(
        result.sides.OPFOR.escaped,
      )} escaped · ${String(result.sides.OPFOR.survivingNotEscaped)} still in the fight</span>`;
    if (e.trigger)
      return `<span class="alert">Ambushed: ${String(e.trigger.opforInKillZone)} of ${String(e.trigger.opforTotal)} in the kill zone</span>`;
    if (e.opforStart)
      return e.paused
        ? '<span class="warn">Approach paused</span>'
        : '<span class="warn">Moving along the scenario route</span>';
    return 'Waiting (not started)';
  };

  const engagementHtml = (): string => {
    const e = ex();
    const result: EngagementResult | null = e.engagementResult;
    if (!result) return '';
    const { BLUEFOR: blue, OPFOR: red } = result.sides;
    const running = result.endSeconds === null;
    const elapsed = (result.endSeconds ?? e.simulation.timeSeconds) - result.startSeconds;
    const row = (label: string, b: string | number, r: string | number) =>
      `<tr><th>${label}</th><td>${String(b)}</td><td>${String(r)}</td></tr>`;
    const outcome = (s: EngagementResult['soldiers'][number]) =>
      s.outcome === 'incapacitated'
        ? 'incapacitated'
        : s.outcome === 'escaped'
          ? 'escaped'
          : s.reaction === 'flee' && !s.fleeBlocked
            ? 'fleeing'
            : 'active';
    const soldiers = result.soldiers
      .filter((s) => s.stats.shotsFired > 0 || s.stats.timesHit > 0 || s.side === 'OPFOR')
      .map(
        (s) =>
          `<tr data-side="${s.side}"><th>${escapeHtml(soldierName(s.soldierId))}</th><td>${String(
            s.stats.shotsFired,
          )}</td><td>${String(s.stats.hits)}</td><td>${String(s.stats.incapacitations)}</td><td>${outcome(s)}${
            s.reaction
              ? ` <span class="muted">(${s.fleeBlocked ? 'flee blocked' : s.reaction})</span>`
              : ''
          }</td></tr>`,
      )
      .join('');
    return `<p>${running ? `In progress: T+ ${elapsed.toFixed(1)} s of at most ${String(e.combatConfig.engagement.maxDurationSeconds)} s` : `<b>Ended:</b> ${END_REASONS[result.endReason ?? 'timeLimit']} after ${elapsed.toFixed(1)} s`}</p>
    <table class="engagement-table">
      <tr><th></th><td>BLUEFOR</td><td>OPFOR</td></tr>
      ${row('Strength', blue.startingStrength, red.startingStrength)}
      ${row('Incapacitated', blue.incapacitated, red.incapacitated)}
      ${row('Escaped', '–', red.escaped)}
      ${row('Still in the fight', blue.survivingNotEscaped, red.survivingNotEscaped)}
      ${row('Shots fired', blue.shotsFired, red.shotsFired)}
      ${row('Hits', blue.hits, red.hits)}
      ${row('Enemies incapacitated', blue.incapacitations, red.incapacitations)}
    </table>
    <details class="sub"><summary>By soldier</summary>
    <table class="engagement-table soldiers">
      <tr><th>Soldier</th><td>Shots</td><td>Hits</td><td>Inc.</td><td>Status</td></tr>${soldiers}
    </table></details>
    <p class="muted">Seed ${String(result.seed)} · ${escapeHtml(result.combatConfig.id)} ${escapeHtml(
      result.combatConfig.version,
    )} · ${String(result.tickRateHz)} Hz</p>`;
  };

  const bannerHtml = (stage: 'bluefor' | 'combat'): string | null => {
    const e = ex();
    const trigger = e.trigger;
    const result = e.engagementResult;
    if (e.phase === 'engagementComplete' && result) {
      const { BLUEFOR: blue, OPFOR: red } = result.sides;
      return `<div class="banner-title">ENGAGEMENT COMPLETE</div>
      <div>${END_REASONS[result.endReason ?? 'timeLimit']} after ${(result.durationSeconds ?? 0).toFixed(1)} s ·
      OPFOR: ${String(red.incapacitated)} of ${String(red.startingStrength)} incapacitated, ${String(red.escaped)} escaped ·
      BLUEFOR: ${String(blue.incapacitated)} of ${String(blue.startingStrength)} incapacitated</div>`;
    }
    if (trigger) {
      const queued = e.triggerState === 'queued';
      return `<div class="banner-title">${queued ? 'AMBUSH QUEUED' : 'AMBUSH TRIGGERED'}</div>
      <div>T+ ${clock(trigger.atSeconds)} · approach ${minutesSeconds(trigger.approachSeconds)} ·
      ${String(trigger.opforInKillZone)} of ${String(trigger.opforTotal)} OPFOR in the kill zone</div>
      <div class="muted">${queued ? (e.paused ? 'Fire opens when you resume.' : 'Fire opens now.') : 'Engagement in progress.'}</div>`;
    }
    if (e.phase === 'bluforReady' && !e.hasUncommittedChanges) {
      return `<div class="banner-title ready">BLUEFOR IN POSITION</div>
      <div>${
        stage === 'bluefor'
          ? 'Check the positions and the kill zone, then continue to OPFOR &amp; Combat.'
          : 'Press <b>Start OPFOR</b> when the ambush is ready.'
      }</div>`;
    }
    return null;
  };

  return {
    isRunning,
    canResume,
    execute() {
      if (ex().phase === 'bluforPlanning') report(ex().execute());
    },
    pause() {
      if (isRunning()) ex().pause();
    },
    resume() {
      if (canResume()) report(ex().resume());
    },
    startOpfor() {
      const result = ex().startOpfor();
      problems = result.ok ? [] : [...result.problems];
    },
    // No confirmation: an ambush is sprung at the moment the trainee chooses.
    triggerAmbush() {
      if (ex().triggerState !== 'available') return;
      const result = ex().triggerAmbush();
      problems = result.ok ? [] : [result.problem];
    },
    phaseLabel() {
      const e = ex();
      switch (e.phase) {
        case 'bluforPlanning':
          return 'Not started: planning';
        case 'bluforOccupation':
          return e.paused ? 'Occupation paused' : 'BLUEFOR moving into position';
        case 'bluforReady':
          return 'BLUEFOR in position';
        case 'opforApproach':
          return e.paused ? 'OPFOR approach paused' : 'OPFOR approaching';
        case 'engagement':
          return e.paused ? 'Engagement paused' : 'Engagement in progress';
        case 'engagementComplete':
          return 'Engagement complete';
      }
    },
    get problems() {
      return problems;
    },
    collect(events) {
      const e = ex();
      if (logged !== e) {
        // A new exercise: its timeline starts again.
        logged = e;
        timelineSeen = 0;
      }
      for (const event of events) {
        const line = describeEvent(event);
        if (line) eventLog.unshift(line);
      }
      for (const milestone of e.timeline.slice(timelineSeen))
        eventLog.unshift(describeMilestone(milestone));
      timelineSeen = e.timeline.length;
      eventLog.length = Math.min(eventLog.length, 60);
    },
    resetLog() {
      eventLog.length = 0;
      problems = [];
    },
    replayEventsHtml() {
      const view = ex();
      const recording = view.recording;
      const now = view.simulation.tick;
      const first = recording?.triggerTick ?? now;
      if (!recording || now <= first) return '<li class="muted">Nothing yet.</li>';
      // As the live log was written: the trigger, then each tick's events, each
      // described with the state just after it, and the milestones stamped then.
      const lines: string[] = [];
      // From the trigger itself on: a milestone of the trigger tick may be from before it.
      const triggered = view.timeline.findIndex((m) => m.type === 'ambushTriggered');
      const milestones = triggered < 0 ? [] : view.timeline.slice(triggered);
      for (const m of milestones) if (m.tick === first) lines.push(describeMilestone(m));
      let next = 0;
      for (let tick = first; tick < now; tick += 1) {
        const after = view.replayAt(tick - first + 1);
        while (next < recording.events.length && (recording.events[next]?.tick ?? now) <= tick) {
          const event = recording.events[next];
          next += 1;
          const line = event?.tick === tick ? describeEvent(event, after) : undefined;
          if (line) lines.push(line);
        }
        for (const m of milestones) if (m.tick === tick + 1) lines.push(describeMilestone(m));
      }
      return (
        lines
          .reverse()
          .slice(0, 30)
          .map((line) => `<li>${escapeHtml(line)}</li>`)
          .join('') || '<li class="muted">Nothing yet.</li>'
      );
    },
    eventsHtml() {
      return (
        eventLog
          .slice(0, 30)
          .map((line) => `<li>${escapeHtml(line)}</li>`)
          .join('') || '<li class="muted">Nothing yet.</li>'
      );
    },
    soldierName,
    bluforHtml,
    opforHtml,
    engagementHtml,
    selectionHtml,
    visibilityHtml,
    bannerHtml,
    wireSelection(element) {
      element.addEventListener('click', (event) => {
        const e = ex();
        const session = o.session();
        const action =
          event.target instanceof HTMLElement ? event.target.dataset['action'] : undefined;
        const team = session.selectedFireTeamId;
        if (team !== null && action === 'clear-formation' && e.formation(team)) {
          e.clearFormation(team);
          return;
        }
        const id = session.selectedSoldierId;
        if (id === null || action === undefined || !e.canEditPlans) return;
        if (action === 'reset-plan') e.resetPlan(id);
      });
    },
  };
}

export const REPLAY_HELP = `<h3>Replay (After Action Review)</h3>
<dl class="help">
  <dt>Play / Space</dt><dd>Play or pause, from the moment the ambush was triggered</dd>
  <dt>Timeline</dt><dd>Drag to any moment, forward or back</dd>
  <dt>1 s buttons / ← →</dt><dd>Step back or forward one second</dd>
  <dt>⏮ ⏭ / Home End</dt><dd>Jump to the start or the end</dd>
  <dt>Speed</dt><dd>0.25× to 4×; the outcome is the same at any speed</dd>
  <dt>Blue symbol</dt><dd>Select a Marine to see what they were doing at that moment</dd>
</dl>
<p class="muted">The replay shows exactly what was recorded during the engagement; nothing is
simulated again. Try again goes back to BLUEFOR planning with your plan as it was
executed, ready to change and run again.</p>`;

/** Shown above the roster in BLUEFOR planning while nothing is selected. */
export const SELECT_HINT =
  'Select a Marine, a fire team or the squad in the roster, or click a blue symbol on the map.';

export const PLANNING_HELP = `<h3>Positions</h3>
<dl class="help">
  <dt>Roster / symbol</dt><dd>Select a Marine</dd>
  <dt>Double-click in roster</dt><dd>Select and centre the map on the Marine, fire team or squad</dd>
  <dt>Click map</dt><dd>Set the Marine's destination (click again to move it)</dd>
  <dt>Drag destination</dt><dd>Move it</dd>
  <dt>Drag yellow handle</dt><dd>Set the facing (kept when the destination moves)</dd>
  <dt>Right-click destination</dt><dd>Clear it</dd>
  <dt>Backspace / Del</dt><dd>Clear the destination</dd>
</dl>
<h3>Squad and fire teams</h3>
<dl class="help">
  <dt>Squad or fire-team name</dt><dd>Select all of it (in the roster)</dd>
  <dt>Click map</dt><dd>Place the team in a line centred there, 10 m apart</dd>
  <dt>Drag the diamond</dt><dd>Move the formation</dd>
  <dt>Drag yellow handle</dt><dd>Turn the formation round its centre</dd>
  <dt>Right-click diamond / Del</dt><dd>Delete the formation</dd>
</dl>
<p class="muted">A formation gives each Marine an ordinary destination and facing. Select a single
Marine to adjust that Marine alone: from then on, moving or turning the formation leaves that
Marine where you put them. One destination and one facing per Marine. Paths are planned
automatically round buildings. Without a chosen facing a Marine faces the way it arrives (dashed
arrow). Marines without a destination stay put and never hold up readiness. Destinations cannot be
placed in or against a building.</p>
<h3>Kill zone (K)</h3>
<dl class="help">
  <dt>K</dt><dd>Switch between editing positions and the kill zone</dd>
  <dt>Click map</dt><dd>Add a corner after the last one</dd>
  <dt>Click a side</dt><dd>Insert a corner into that side</dd>
  <dt>Drag corner</dt><dd>Move it (it cannot cross itself)</dd>
  <dt>Right-click corner</dt><dd>Delete it</dd>
</dl>
<h3>Visibility (V)</h3>
<p class="muted">Green is the ground a standing Marine at the destination (or where they stand, if
they have none) can see a standing person on. Terrain, buildings and vegetation block the view.
Select a fire team to see what any of its Marines can see; drag a destination to compare
positions.</p>
<h3>3D view</h3>
<p class="muted">Every click and drag above works on the 3D ground too, with the same results.
Drag empty ground to pan, right-drag to orbit, use the wheel to zoom and double-click to focus.</p>`;

export const TIME_HELP = `<h3>Map and time</h3>
<dl class="help">
  <dt>Drag map</dt><dd>Pan (left or middle button)</dd>
  <dt>Wheel</dt><dd>Zoom at the cursor</dd>
  <dt>F</dt><dd>Fit the map</dd>
  <dt>Space</dt><dd>Pause / Resume</dd>
  <dt>1 · 4 · 8</dt><dd>Time scale 1× · 4× · 8×</dd>
  <dt>+ / −</dt><dd>Faster / slower (1× · 4× · 8× · 16×)</dd>
  <dt>Esc</dt><dd>Clear selection</dd>
</dl>
<h3>Symbols</h3>
<p class="muted">Each soldier is an Ambush! role icon (not APP-6): a circle coloured by side (blue
friendly, red enemy) with the role inside and a triangle pointing the way the soldier faces. Where
symbols would overlap, soldiers are shown as small dots at their true positions, with a "+n" badge
for those hidden; zoom in, use the roster, or click a cluster again to step through it. The dashed
outline is the ORP, where the squad starts; the dashed dark-red line is the OPFOR route.</p>`;

export const COMBAT_HELP = `<p class="muted">After <b>Start OPFOR</b> the patrol walks its route;
entering or leaving the kill zone never opens fire. Press <b>Trigger Ambush</b> when you choose:
BLUEFOR opens fire at that moment. It works at any point of the approach, also while paused (fire
then opens when you resume). <b>OPFOR in kill zone</b> counts the active patrol members inside the
zone; it is information only.</p>`;
