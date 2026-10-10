import {
  FIRE_TEAM_ECHELON,
  type AmbushScenario,
  type DeploymentStatus,
  type Exercise,
  type RosterUnit,
} from '#exercise';
import { selectFireTeam, selectSoldier, type Session } from '#session';
import { soldierId, type SoldierId } from '#sim';
import { soldierIconSvg, symbolSvg, type TacticalMap } from '#view2d';
import { escapeHtml } from './shell';

// The squad roster (docs/adr/0013, docs/adr/0022), shown in every stage of a
// battlefield (docs/adr/0025): the unit hierarchy, role icons, each Marine's
// status, and selection of a Marine or a whole fire team, kept in step with
// the map.

export const STATUS_LABELS: Readonly<Record<DeploymentStatus, string>> = {
  atOrp: 'At ORP',
  destinationAssigned: 'Destination assigned',
  moving: 'Moving',
  inPosition: 'In position',
  holding: 'Holding (no destination)',
};

function rosterUnitHtml(
  exercise: Exercise,
  session: Session,
  node: RosterUnit,
  depth: number,
): string {
  const sidc = node.unit.symbology?.sidc;
  const icon = sidc
    ? `<span class="unit-symbol" aria-hidden="true">${symbolSvg(sidc, 11)}</span>`
    : '';
  const team = node.unit.echelon === FIRE_TEAM_ECHELON && node.members.length > 0;
  const teamSelected = team && session.selectedFireTeamId === node.unit.id;
  const inSelectedTeam = (id: SoldierId) =>
    exercise.fireTeamOf(id)?.unitId === session.selectedFireTeamId;
  const rows = node.members
    .map((m) => {
      const id = soldierId(m.soldierId);
      const status = exercise.deploymentStatus(id) ?? 'atOrp';
      const selected = session.selectedSoldierId === id || inSelectedTeam(id);
      const tip = `${m.role.name}${m.leads ? ` (leads ${node.unit.name})` : ''} · map label ${m.slot.label} · ${m.soldierId}`;
      const icon = soldierIconSvg({ role: m.icon, affiliation: 'friendly', facing: null }, 14);
      return `<button class="roster-row" data-soldier="${escapeHtml(m.soldierId)}" aria-pressed="${String(selected)}" title="${escapeHtml(tip)}">
        <span class="icon" aria-hidden="true">${icon}</span>
        <span class="abbr">${escapeHtml(m.role.abbreviation)}</span>
        <span class="role">${escapeHtml(m.role.name)}</span>
        <span class="sid">${escapeHtml(m.soldierId)}</span>
        <span class="st" data-status="${status}">${STATUS_LABELS[status]}</span>
      </button>`;
    })
    .join('');
  const children = node.children
    .map((c) => rosterUnitHtml(exercise, session, c, depth + 1))
    .join('');
  // A fire team's name selects the whole team (docs/adr/0022).
  const heading = team
    ? `<button class="roster-unit-name team" data-fire-team="${escapeHtml(node.unit.id)}" aria-pressed="${String(teamSelected)}" title="Select the whole ${escapeHtml(node.unit.name)}">${icon}${escapeHtml(node.unit.name)}</button>`
    : `<div class="roster-unit-name">${icon}${escapeHtml(node.unit.name)}</div>`;
  return `<div class="roster-unit${teamSelected ? ' team-selected' : ''}" style="--depth:${String(depth)}">
    ${heading}${rows}${children}</div>`;
}

/** Where the squad's organization comes from, e.g. "MCWP 3-11.2, 1991 (template 1.0.0)". */
export function rosterSource(scenario: AmbushScenario): string {
  const { source, version } = scenario.organization.template;
  return source.kind === 'doctrine'
    ? `${source.designation}, ${source.date} (template ${version})`
    : `synthetic (template ${version})`;
}

export function rosterHtml(exercise: Exercise, session: Session, source: string): string {
  return `${rosterUnitHtml(exercise, session, exercise.roster, 0)}<p class="muted roster-source">${escapeHtml(
    exercise.roster.unit.name,
  )} · ${escapeHtml(source)}</p>`;
}

/**
 * Roster clicks: a fire team's name selects the team, a row selects the
 * Marine; either is brought into view when it is off screen.
 */
export function wireRoster(
  element: HTMLElement,
  o: {
    readonly exercise: () => Exercise;
    readonly session: () => Session;
    readonly setSession: (session: Session) => void;
    readonly map: TacticalMap;
  },
): void {
  element.addEventListener('click', (event) => {
    const exercise = o.exercise();
    const target = event.target instanceof Element ? event.target : null;
    const heading = target?.closest('[data-fire-team]');
    const unitId = heading instanceof HTMLElement ? heading.dataset['fireTeam'] : undefined;
    if (unitId !== undefined) {
      o.setSession(selectFireTeam(o.session(), exercise, unitId));
      const team = exercise.fireTeams.find((t) => t.unitId === unitId);
      const points = team?.memberIds.flatMap((id) => exercise.observer(id)?.point ?? []) ?? [];
      if (points.length > 0 && !points.some((p) => o.map.isInView(p))) {
        o.map.centreOn({
          x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
          y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
        });
      }
      return;
    }
    const row = target?.closest('[data-soldier]');
    const id = row instanceof HTMLElement ? row.dataset['soldier'] : undefined;
    if (id === undefined) return;
    o.setSession(selectSoldier(o.session(), exercise, soldierId(id)));
    const soldier = exercise.simulation.state.soldiers.find((s) => s.id === id);
    if (soldier && !o.map.isInView(soldier.position)) o.map.centreOn(soldier.position);
  });
}
