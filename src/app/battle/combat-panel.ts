import { ORDER_LABELS } from '#exercise/battle';
import { ORDER_KINDS, type Side } from '#sim';
import { escapeHtml } from '../shell';
import {
  COMBAT_SPEEDS,
  describeOrder,
  PHASE_LABELS,
  type Combat,
  type CombatSummary,
  type SquadStatus,
} from './combat';
import type { BattleDisplay, CombatUi } from './combat-editor';
import type { TimedEvent } from './session';

// The Combat stage's side panel (docs/constructive-simulation/04): the clock
// and its controls, the order tools, the selected squad's state and orders,
// the roster by force with each squad's state, and the battle's events in
// words; and the After-Action Review's summary. Plain HTML from the combat's
// state; the page wires the buttons (`data-cact`, `data-ctool`, `data-cmode`,
// `data-speed`, `data-squad`).

const sideClass = (side: Side) => (side === 'BLUEFOR' ? 'blue' : 'red');

/** "T+ 02:05.3" */
export function clockText(seconds: number): string {
  const s = Math.max(0, seconds);
  const minutes = Math.floor(s / 60);
  const rest = s - minutes * 60;
  return `T+ ${String(minutes).padStart(2, '0')}:${rest.toFixed(1).padStart(4, '0')}`;
}

export function combatToolsHtml(c: Combat, ui: CombatUi): string {
  const speeds = COMBAT_SPEEDS.map(
    (s) =>
      `<button class="small" data-speed="${String(s)}" aria-pressed="${String(c.speed === s)}">${s === 0.5 ? '½' : String(s)}×</button>`,
  ).join('');
  const tool = (kind: (typeof ORDER_KINDS)[number] | null, label: string, key: string) =>
    `<button class="tool${kind ? ` order-${kind}` : ''}" data-ctool="${kind ?? 'select'}" aria-pressed="${String(ui.tool === kind)}" title="${label} (${key})">${label}</button>`;
  return `<div class="combat-clock">
      <span class="clock" data-ui="combat-clock"></span>
      <button class="action" data-cact="play" title="Play or pause (Space)">${c.playing ? 'Pause' : 'Play'}</button>
      <button class="small danger" data-cact="end" title="End the battle: it never ends by itself">End combat</button>
    </div>
    <div class="speed" role="group" aria-label="Simulation speed">${speeds}</div>
    <h3>Orders, to either side</h3>
    <div class="tool-grid order-tools" role="group" aria-label="Orders">
      ${ORDER_KINDS.map((k) => tool(k, ORDER_LABELS[k], k[0]?.toUpperCase() ?? '')).join('')}
      ${tool(null, 'Select', 'S')}
    </div>
    <div class="tool-row mode-row" role="group" aria-label="How a new order is given">
      <button class="small" data-cmode="replace" aria-pressed="${String(!ui.append)}" title="A new order replaces the squad's orders">Replace plan</button>
      <button class="small" data-cmode="append" aria-pressed="${String(ui.append)}" title="A new order follows the squad's pending orders">Append</button>
      <button class="small" data-cact="hold" title="Clear the selected squad's orders: it holds where it is (H)"${ui.selected === null ? ' disabled' : ''}>Hold</button>
    </div>`;
}

export function combatHint(c: Combat, ui: CombatUi): string {
  if (c.ended) return 'The battle has ended.';
  // The worker first prepares the battlefield (its navigation, sight lines): a moment.
  if (c.playing && c.session.tick === 0) return 'Starting the battle…';
  const lagging =
    c.playing && c.achievedSpeed >= 0.5 && c.achievedSpeed < 0.8 * c.speed
      ? `Running at ${c.achievedSpeed.toFixed(0)}×: the battle is slower to simulate than ${String(c.speed)}× here. `
      : '';
  return lagging + hintFor(c, ui);
}

function hintFor(c: Combat, ui: CombatUi): string {
  const s = c.squad(ui.selected);
  if (ui.tool === null)
    return s
      ? `${s.name} selected: press M, A or W, then click the map to order it.`
      : 'Click a squad of either side to select it. Space plays or pauses.';
  if (!s) return 'Select a squad first (click it on the map or in the roster).';
  return `Click the map: ${s.name} gets a ${ORDER_LABELS[ui.tool]} order there, ${ui.append ? 'after its pending orders' : 'replacing its orders'} (Shift: ${ui.append ? 'replace' : 'append'} instead).${c.playing ? '' : ' It takes effect when play resumes.'}`;
}

const statusClass: Readonly<Record<string, string>> = {
  completed: 'ok',
  failed: 'alert',
  superseded: 'muted',
  canceled: 'muted',
  active: 'active',
  pending: '',
};

export function combatSquadHtml(s: SquadStatus | undefined): string {
  if (!s) return '<p class="muted">No squad selected. Click one on the map or in the roster.</p>';
  const history = s.orders
    .slice(-8)
    .map(
      (x) =>
        `<li class="${statusClass[x.status] ?? ''}"><span class="o-status">${x.status}</span> ${escapeHtml(describeOrder(x))}${x.reason ? `<span class="muted"> · ${escapeHtml(x.reason)}</span>` : ''}</li>`,
    )
    .join('');
  const queued = s.queued
    .map(
      (q) =>
        `<li class="queued"><span class="o-status">queued</span> ${q.mode === 'replace' ? (q.orders.length === 0 ? 'Hold (clear orders)' : 'Replace with: ') : 'Append: '}${q.orders.map((x) => escapeHtml(describeOrder(x))).join(', ')}</li>`,
    )
    .join('');
  return `<div class="squad-head ${sideClass(s.side)}">
      <span class="side-badge">${s.side}</span>
      <span class="squad-name">${escapeHtml(s.name)}</span>
    </div>
    <dl class="kv">
      <dt>State</dt><dd class="phase-${s.phase}">${PHASE_LABELS[s.phase]}</dd>
      <dt>Soldiers</dt><dd>${String(s.up)} of ${String(s.total)} active</dd>
      <dt>Effectiveness</dt><dd>${String(Math.round(s.effectiveness * 100))} %</dd>
      ${ammunitionHtml(s)}
      <dt>Order</dt><dd>${s.active ? escapeHtml(describeOrder(s.active)) : '<span class="muted">none: holding</span>'}</dd>
      <dt>Then</dt><dd>${s.pending.length === 0 ? '<span class="muted">nothing</span>' : s.pending.map((x) => escapeHtml(describeOrder(x))).join('; ')}</dd>
    </dl>
    <h3>Orders</h3>
    ${history || queued ? `<ol class="order-history">${history}${queued}</ol>` : '<p class="muted">None given.</p>'}
    <p class="buttons"><button class="small" data-cact="centre">Centre on map</button></p>`;
}

export function combatRosterHtml(c: { squads(): readonly SquadStatus[] }, ui: CombatUi): string {
  const squads = c.squads();
  return (['BLUEFOR', 'OPFOR'] as const)
    .map((side) => {
      const list = squads.filter((s) => s.side === side);
      const up = list.reduce((n, s) => n + s.up, 0);
      const total = list.reduce((n, s) => n + s.total, 0);
      const rows = list
        .map(
          (
            s,
          ) => `<button class="squad-row ${sideClass(side)}" data-squad="${s.id}" aria-pressed="${String(ui.selected === s.id)}">
            <span class="sq-id">${s.id}</span>
            <span class="sq-name">${escapeHtml(s.name)}</span>
            <span class="sq-org muted">${String(s.up)}/${String(s.total)}</span>
            <span class="sq-plan phase-${s.phase}">${PHASE_LABELS[s.phase]}</span>
          </button>`,
        )
        .join('');
      return `<div class="force ${sideClass(side)}">
        <h3>${side} <span class="muted">· ${String(up)} of ${String(total)} soldiers active</span></h3>
        ${rows}
      </div>`;
    })
    .join('');
}

/** What each weapon is called in the panels. */
export const WEAPON_LABELS: Readonly<Record<string, string>> = {
  rifle: 'Rifles',
  automaticRifle: 'M249 SAWs',
  grenadeLauncher: 'M203 grenades',
};

/** The squad's rounds by weapon, and who is reloading or out (docs/behavior-lab/force-on-force/06). */
function ammunitionHtml(s: SquadStatus): string {
  const rows = s.ammunition
    .map(
      (a) =>
        `<dt>${escapeHtml(WEAPON_LABELS[a.weapon] ?? a.weapon)}</dt><dd>${(a.loaded + a.reserve).toLocaleString('en')} rd <span class="muted">(${a.loaded.toLocaleString('en')} loaded, ${String(a.carriers)} carrying)</span></dd>`,
    )
    .join('');
  const state = [
    s.reloading > 0 ? `${String(s.reloading)} reloading` : '',
    s.outOfAmmunition > 0
      ? `<span class="warn">${String(s.outOfAmmunition)} out of ammunition</span>`
      : '',
  ]
    .filter((x) => x !== '')
    .join(' · ');
  return `${rows}${state ? `<dt>Weapons</dt><dd>${state}</dd>` : ''}`;
}

/** An event in words, or `null` for one the log does not show. */
export function describeEvent(e: TimedEvent, names: ReadonlyMap<string, string>): string | null {
  const ev = e.event;
  const name = (unitId: string) => names.get(unitId) ?? unitId;
  switch (ev.type) {
    case 'orderChanged':
      return `${name(ev.unitId)}: ${ORDER_LABELS[ev.kind]} order ${ev.to}${ev.reason ? ` (${ev.reason})` : ''}`;
    case 'forcePhaseChanged':
      return `${name(ev.unitId)}: ${PHASE_LABELS[ev.to]}${ev.reason ? ` (${ev.reason})` : ''}`;
    case 'soldierIncapacitated':
      return `${ev.soldierId} hit by ${ev.byId}`;
    case 'fofGrenade':
      return `${ev.shooterId} fired a grenade (${String(Math.round(ev.rangeM))} m)${ev.incapacitated.length > 0 ? `: ${ev.incapacitated.join(', ')} down` : ''}`;
    case 'ammunitionExhausted':
      return `${ev.soldierId} is out of ${WEAPON_LABELS[ev.weapon]?.toLowerCase() ?? ev.weapon} ammunition`;
    case 'commandRejected':
      return `An order was refused (${ev.reason})`;
    default:
      return null;
  }
}

/** The events up to the time drawn, newest first; `seekable` rows seek the review there. */
export function combatEventsHtml(c: BattleDisplay, limit = 40, seekable = false): string {
  const names = new Map(c.battle.squads.map((s) => [s.unitId, s.name]));
  const lines: string[] = [];
  const events = c.events;
  for (let i = events.length - 1; i >= 0 && lines.length < limit; i -= 1) {
    const e = events[i];
    if (!e || e.seconds > c.renderSeconds) continue;
    const text = describeEvent(e, names);
    if (text)
      lines.push(
        `<li${seekable ? ` class="seek" data-seek="${String(e.seconds)}"` : ''}><span class="clock">${clockText(e.seconds)}</span> ${escapeHtml(text)}</li>`,
      );
  }
  return lines.length > 0 ? lines.join('') : '<li class="muted">Nothing yet.</li>';
}

export function aarSummaryHtml(summary: CombatSummary): string {
  const rows = summary.sides
    .map(
      (s) =>
        `<tr class="${sideClass(s.side)}"><th>${s.side}</th><td>${String(s.squads)}</td><td>${String(s.soldiers)}</td><td>${String(s.casualties)}</td><td>${String(s.ineffective)}</td></tr>`,
    )
    .join('');
  return `<p>The battle lasted <b>${clockText(summary.seconds)}</b>.</p>
    <table class="aar-table">
      <thead><tr><th></th><th>Squads</th><th>Soldiers</th><th title="Casualties: soldiers incapacitated">Hit</th><th title="Squads combat ineffective">Ineff.</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p>Orders: ${String(summary.orders.given)} given, ${String(summary.orders.completed)} completed, ${String(summary.orders.failed)} failed.</p>
`;
}
