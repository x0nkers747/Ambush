import {
  nextBlocker,
  nextStage,
  previousBlocker,
  previousStage,
  STAGE_NAMES,
  stageNumber,
  WORKFLOW_STAGES,
  type WorkflowFacts,
  type WorkflowStage,
} from './workflow';

// The application shell shared by every stage (docs/adr/0025): the compact
// workflow header with Previous and Next, short messages over the map, and a
// narrowly scoped confirmation for actions that discard work.

export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);

/** The header's markup; `context` is a short label such as the battlefield's name. */
export function headerHtml(context = ''): string {
  return `<header class="wf-header">
    <span class="wf-brand">AMBUSH!</span>
    <nav class="wf-nav" aria-label="Workflow">
      <button class="wf-arrow" data-ui="wf-prev" aria-describedby="wf-prev-reason">‹</button>
      <div class="wf-stage" aria-live="polite">
        <span class="wf-name" data-ui="wf-name"></span>
        <span class="wf-count" data-ui="wf-count"></span>
      </div>
      <button class="wf-arrow" data-ui="wf-next" aria-describedby="wf-next-reason">›</button>
      <span class="sr-only" id="wf-prev-reason" data-ui="wf-prev-reason"></span>
      <span class="sr-only" id="wf-next-reason" data-ui="wf-next-reason"></span>
    </nav>
    <span class="wf-context" data-ui="wf-context" title="${escapeHtml(context)}">${escapeHtml(context)}</span>
  </header>`;
}

export interface WorkflowHeader {
  /** Shows a stage and what blocks leaving it; call whenever either may have changed. */
  update(stage: WorkflowStage, facts: WorkflowFacts): void;
}

/**
 * Wires the header's arrows. A blocked arrow stays focusable
 * (`aria-disabled`), so its reason is available as a tooltip and to screen
 * readers; pressing it shows the reason instead of moving.
 */
export function wireHeader(
  root: HTMLElement,
  o: {
    readonly go: (stage: WorkflowStage) => void;
    readonly blocked: (reason: string) => void;
  },
): WorkflowHeader {
  const el = (name: string) => {
    const e = root.querySelector<HTMLElement>(`[data-ui="${name}"]`);
    if (!e) throw new Error(`Missing UI element ${name}`);
    return e;
  };
  let current: WorkflowStage = WORKFLOW_STAGES[0] ?? 'terrain';
  let reasons: { prev: string | null; next: string | null } = { prev: null, next: null };
  const arrow = (which: 'prev' | 'next') => {
    const reason = reasons[which];
    const target = which === 'prev' ? previousStage(current) : nextStage(current);
    if (reason !== null || target === null) {
      o.blocked(reason ?? '');
      return;
    }
    o.go(target);
  };
  el('wf-prev').addEventListener('click', () => {
    arrow('prev');
  });
  el('wf-next').addEventListener('click', () => {
    arrow('next');
  });
  const show = (which: 'prev' | 'next', target: WorkflowStage | null, reason: string | null) => {
    const button = el(`wf-${which}`);
    const verb = which === 'prev' ? 'Previous' : 'Next';
    const label = target ? `${verb}: ${STAGE_NAMES[target]}` : verb;
    const text = reason === null ? label : `${label}. ${reason}`;
    if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
    if (button.title !== text) button.title = text;
    const disabled = String(reason !== null);
    if (button.getAttribute('aria-disabled') !== disabled)
      button.setAttribute('aria-disabled', disabled);
    const reasonEl = el(`wf-${which}-reason`);
    if (reasonEl.textContent !== (reason ?? '')) reasonEl.textContent = reason ?? '';
  };
  return {
    update(stage, facts) {
      current = stage;
      reasons = { prev: previousBlocker(stage), next: nextBlocker(stage, facts) };
      const name = STAGE_NAMES[stage];
      if (el('wf-name').textContent !== name) el('wf-name').textContent = name;
      const count = `${String(stageNumber(stage))} / ${String(WORKFLOW_STAGES.length)}`;
      if (el('wf-count').textContent !== count) el('wf-count').textContent = count;
      show('prev', previousStage(stage), reasons.prev);
      show('next', nextStage(stage), reasons.next);
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
