import { openInfo } from './info';
import {
  nextStage,
  previousBlocker,
  previousStage,
  STAGE_LABELS,
  STAGE_NAMES,
  stageBlocker,
  stageNumber,
  WORKFLOW_STAGES,
  type WorkflowRules,
  type WorkflowStage,
} from './workflow';

// The application shell shared by every stage (docs/adr/0025): the workflow
// header with Previous, the five stage segments and Next, and beside them
// INFO (the Info window, `info.ts`); short messages over the map, and a
// narrowly scoped confirmation for actions that discard work.

export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);

/** A bin, drawn in `currentColor`, for the `trash-btn` buttons (saved battlefields). */
export const TRASH_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5"/></svg>`;

/** Each stage's segment icon (24 × 24, drawn in `currentColor`). */
const STAGE_ICONS: Readonly<Record<WorkflowStage, string>> = {
  terrain: `<path d="M2 20 9.5 6 17 20Z M13.2 12.2 16 8.5 22 20H17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>`,
  scenario: `<path d="M3 6 9 4l6 2 6-2v14l-6 2-6-2-6 2Z M9 4v14 M15 6v14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>`,
  // Planning: a route of waypoints, ending in an arrow (the plan's orders).
  bluefor: `<g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="18.5" r="2.2"/><path d="M6.8 16.8 11 12.5 14 14 19.5 7.5" stroke-dasharray="2.2 2.2"/><path d="M15.2 7.2h4.6v4.6"/></g>`,
  // Sim: play, in a circle (the battle runs).
  combat: `<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 8.2v7.6L16 12Z" fill="currentColor"/>`,
  aar: `<path d="M4 3v17h17" fill="none" stroke="currentColor" stroke-width="1.6"/><g fill="currentColor"><rect x="7" y="13" width="2.4" height="6"/><rect x="11" y="9" width="2.4" height="10"/><rect x="15" y="5" width="2.4" height="14"/><rect x="19" y="10" width="1.6" height="9"/></g>`,
};

/** INFO's icon: a question mark in a circle. */
const INFO_ICON = `<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M9.4 9.4a2.7 2.7 0 1 1 3.9 2.4c-.8.4-1.3 1-1.3 1.9v.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="12" cy="17.3" r="1.1" fill="currentColor"/>`;

/** The header's markup; `context` is a short label such as the battlefield's name. */
export function headerHtml(context = ''): string {
  const steps = WORKFLOW_STAGES.map(
    (stage) => `<li class="wf-step" data-step="${stage}">
        <button class="wf-step-btn" data-ui="wf-step-${stage}" aria-describedby="wf-step-${stage}-reason">
          <svg class="wf-icon" viewBox="0 0 24 24" aria-hidden="true">${STAGE_ICONS[stage]}</svg>
          <span class="wf-label">${escapeHtml(STAGE_LABELS[stage])}</span>
        </button>
        <span class="sr-only" id="wf-step-${stage}-reason" data-ui="wf-step-${stage}-reason"></span>
      </li>`,
  ).join('');
  return `<header class="wf-header">
    <span class="wf-brand">AMBUSH!</span>
    <div class="wf-centre">
    <nav class="wf-nav" aria-label="Workflow">
      <button class="wf-arrow" data-ui="wf-prev" aria-describedby="wf-prev-reason">‹</button>
      <ol class="wf-steps">${steps}</ol>
      <button class="wf-arrow" data-ui="wf-next" aria-describedby="wf-next-reason">›</button>
      <span class="sr-only" id="wf-prev-reason" data-ui="wf-prev-reason"></span>
      <span class="sr-only" id="wf-next-reason" data-ui="wf-next-reason"></span>
      <span class="sr-only" aria-live="polite" data-ui="wf-announce"></span>
    </nav>
    <div class="wf-info-box">
      <button class="wf-step-btn wf-info" data-ui="wf-info" title="About Ambush!" aria-label="About Ambush!">
        <svg class="wf-icon" viewBox="0 0 24 24" aria-hidden="true">${INFO_ICON}</svg>
        <span class="wf-label">Info</span>
      </button>
    </div>
    </div>
    <span class="wf-context" data-ui="wf-context" title="${escapeHtml(context)}">${escapeHtml(context)}</span>
  </header>`;
}

export interface WorkflowHeader {
  /** Shows a stage and what blocks leaving it; call whenever either may have changed. */
  update(stage: WorkflowStage, rules: WorkflowRules): void;
}

/**
 * Wires the header's arrows and stage segments. A blocked control stays
 * focusable (`aria-disabled`), so its reason is available as a tooltip and to
 * screen readers; pressing it shows the reason instead of moving. `update`
 * runs every frame, so it touches the DOM only when something changed.
 */
export function wireHeader(
  root: HTMLElement,
  o: {
    readonly go: (stage: WorkflowStage) => void;
    readonly blocked: (reason: string) => void;
    /**
     * Pauses a battle being fought or replayed while the Info window is open;
     * returns how to resume it when it closes (`null`: nothing was running).
     */
    readonly pause?: () => (() => void) | null;
  },
): WorkflowHeader {
  const el = (name: string) => {
    const e = root.querySelector<HTMLElement>(`[data-ui="${name}"]`);
    if (!e) throw new Error(`Missing UI element ${name}`);
    return e;
  };
  let current: WorkflowStage = WORKFLOW_STAGES[0] ?? 'terrain';
  let facts: WorkflowRules | null = null;
  const goTo = (target: WorkflowStage | null, reason: string | null) => {
    if (reason !== null || target === null) {
      o.blocked(reason ?? '');
      return;
    }
    o.go(target);
  };
  el('wf-info').addEventListener('click', () => {
    const resume = o.pause?.() ?? null;
    openInfo(() => resume?.());
  });
  el('wf-prev').addEventListener('click', () => {
    goTo(previousStage(current), facts ? previousBlocker(current, facts) : null);
  });
  el('wf-next').addEventListener('click', () => {
    goTo(nextStage(current), facts ? facts.next(current) : null);
  });
  for (const stage of WORKFLOW_STAGES) {
    el(`wf-step-${stage}`).addEventListener('click', () => {
      if (stage === current || !facts) return;
      goTo(stage, stageBlocker(current, stage, facts));
    });
  }
  const set = (e: HTMLElement, attribute: string, value: string | null) => {
    if (e.getAttribute(attribute) === value) return;
    if (value === null) e.removeAttribute(attribute);
    else e.setAttribute(attribute, value);
  };
  const setText = (e: HTMLElement, text: string) => {
    if (e.textContent !== text) e.textContent = text;
  };
  const show = (name: string, label: string, reason: string | null) => {
    const button = el(name);
    set(button, 'aria-label', label);
    set(button, 'title', reason === null ? label : `${label}. ${reason}`);
    set(button, 'aria-disabled', String(reason !== null));
    setText(el(`${name}-reason`), reason ?? '');
  };
  const total = String(WORKFLOW_STAGES.length);
  return {
    update(stage, f) {
      current = stage;
      facts = f;
      const next = f.next(stage);
      const prevTarget = previousStage(stage);
      const nextTarget = nextStage(stage);
      show(
        'wf-prev',
        prevTarget ? `Previous: ${STAGE_NAMES[prevTarget]}` : 'Previous',
        previousBlocker(stage, f),
      );
      show('wf-next', nextTarget ? `Next: ${STAGE_NAMES[nextTarget]}` : 'Next', next);
      for (const s of WORKFLOW_STAGES) {
        const name = `wf-step-${s}`;
        const position = `stage ${String(stageNumber(s))} of ${total}`;
        if (s === stage) {
          show(name, `${STAGE_NAMES[s]}, ${position}, current`, null);
          set(el(name), 'aria-current', 'step');
        } else {
          // The next stage's reason is Next's, already computed.
          const reason = s === nextTarget ? next : stageBlocker(stage, s, f);
          show(name, `${STAGE_NAMES[s]}, ${position}`, reason);
          set(el(name), 'aria-current', null);
        }
      }
      setText(
        el('wf-announce'),
        `${STAGE_NAMES[stage]}, stage ${String(stageNumber(stage))} of ${total}`,
      );
    },
  };
}

/** Short messages shown over the map or page, e.g. why an edit was refused. */
export function createToast(element: HTMLElement): (message: string) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (message) => {
    element.textContent = message;
    element.hidden = message === '';
    clearTimeout(timer);
    timer = setTimeout(() => {
      element.hidden = true;
    }, 4500);
  };
}

/**
 * A confirmation for an action that discards work (leaving a battlefield,
 * restarting the exercise): the message, the action and Cancel. Never used for
 * routine navigation. Escape or Cancel closes it.
 */
export function createConfirm(
  element: HTMLElement,
): (o: {
  readonly message: string;
  readonly action: string;
  readonly onConfirm: () => void;
}) => void {
  element.setAttribute('role', 'alertdialog');
  element.setAttribute('aria-modal', 'false');
  let confirm: (() => void) | null = null;
  const close = () => {
    element.hidden = true;
    confirm = null;
  };
  element.addEventListener('click', (event) => {
    const action = (event.target as HTMLElement).closest<HTMLElement>('[data-confirm]')?.dataset[
      'confirm'
    ];
    if (action === 'yes') {
      const run = confirm;
      close();
      run?.();
    } else if (action === 'no') close();
  });
  element.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  });
  return ({ message, action, onConfirm }) => {
    confirm = onConfirm;
    element.innerHTML = `<p>${escapeHtml(message)}</p>
      <div class="confirm-buttons"><button class="danger-solid" data-confirm="yes">${escapeHtml(action)}</button>
      <button data-confirm="no">Cancel</button></div>`;
    element.hidden = false;
    element.querySelector<HTMLButtonElement>('[data-confirm="no"]')?.focus();
  };
}

/** Sets an element's HTML only when it changed (panels are refreshed every frame). */
export function htmlSetter(): (element: HTMLElement, html: string) => void {
  const cache = new WeakMap<HTMLElement, string>();
  return (element, html) => {
    if (cache.get(element) === html) return;
    element.innerHTML = html;
    cache.set(element, html);
  };
}
