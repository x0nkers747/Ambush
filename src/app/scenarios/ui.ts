import { escapeHtml, TRASH_ICON } from '../shell';
import { nameProblem, SCENARIO_FILE_EXTENSION } from './document';
import type { LibraryEntry } from './library';

// The scenario dialogs (docs/scenarios.md): modal panels over the page, in
// the game's style. Each resolves a promise with the user's answer (`null`
// when cancelled: Cancel, Escape or a click outside). They know nothing of
// storage or battlefields; `manager.ts` decides what to ask.

export interface Choice<T extends string> {
  readonly id: T;
  readonly label: string;
  readonly kind?: 'primary' | 'danger';
}

/** The dialogs the scenario manager uses (replaced by fakes in tests). */
export interface ScenarioDialogs {
  /** A message and buttons; the id of the one chosen, or `null`. */
  choose<T extends string>(o: {
    readonly title: string;
    readonly message: string;
    readonly choices: readonly Choice<T>[];
  }): Promise<T | null>;
  /** A name, checked (`nameProblem`); or `null`. */
  askName(o: {
    readonly title: string;
    readonly message?: string;
    readonly value: string;
    readonly action: string;
  }): Promise<string | null>;
  /** A task under way, which can be cancelled. */
  progress(o: { readonly title: string; readonly message: string }): ProgressDialog;
  /** A short message (the page's toast). */
  notify(message: string): void;
}

export interface ProgressDialog {
  /** Aborted when the user cancels. */
  readonly signal: AbortSignal;
  update(message: string): void;
  /** Shows a failure; resolves `true` to try again (offered when `retry`), `false` to give up. */
  failed(message: string, retry: boolean): Promise<boolean>;
  close(): void;
}

let openCount = 0;

/** A modal panel over the page; `close` removes it. Escape and the backdrop cancel. */
function modal(title: string, onCancel: () => void, wide = false) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const id = `modal-title-${String((openCount += 1))}`;
  backdrop.innerHTML = `<div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="${id}">
      <h2 id="${id}">${escapeHtml(title)}</h2>
      <div class="modal-body"></div>
    </div>`;
  const panel = backdrop.querySelector<HTMLElement>('.modal');
  const body = backdrop.querySelector<HTMLElement>('.modal-body');
  if (!panel || !body) throw new Error('Missing modal parts');
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };
  backdrop.addEventListener('keydown', onKey);
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) onCancel();
  });
  document.body.append(backdrop);
  return {
    backdrop,
    panel,
    body,
    close() {
      backdrop.remove();
      previous?.focus();
    },
  };
}

const button = (label: string, data: string, kind?: string) =>
  `<button data-choice="${escapeHtml(data)}"${kind ? ` class="${kind === 'primary' ? 'primary-btn' : 'danger-solid'}"` : ''}>${escapeHtml(label)}</button>`;

export function choose<T extends string>(o: {
  readonly title: string;
  readonly message: string;
  readonly choices: readonly Choice<T>[];
}): Promise<T | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: T | null) => {
      if (done) return;
      done = true;
      m.close();
      resolve(value);
    };
    const m = modal(o.title, () => {
      finish(null);
    });
    m.body.innerHTML = `<p>${escapeHtml(o.message)}</p>
      <div class="modal-buttons">${o.choices.map((c) => button(c.label, c.id, c.kind)).join('')}${button('Cancel', '')}</div>`;
    m.body.addEventListener('click', (event) => {
      const b = (event.target as HTMLElement).closest<HTMLElement>('[data-choice]');
      if (!b) return;
      const id = b.dataset['choice'] ?? '';
      finish(id === '' ? null : (o.choices.find((c) => c.id === id)?.id ?? null));
    });
    m.body.querySelector<HTMLButtonElement>('[data-choice]')?.focus();
  });
}

export function askName(o: {
  readonly title: string;
  readonly message?: string;
  readonly value: string;
  readonly action: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      m.close();
      resolve(value);
    };
    const m = modal(o.title, () => {
      finish(null);
    });
    m.body.innerHTML = `${o.message ? `<p>${escapeHtml(o.message)}</p>` : ''}
      <form class="modal-form">
        <label>Name <input data-ui="name" maxlength="80" autocomplete="off" value="${escapeHtml(o.value)}"></label>
        <p class="reason warn" data-ui="problem" hidden></p>
        <div class="modal-buttons"><button type="submit" class="primary-btn">${escapeHtml(o.action)}</button>
        <button type="button" data-choice="">Cancel</button></div>
      </form>`;
    const input = m.body.querySelector<HTMLInputElement>('[data-ui="name"]');
    const problem = m.body.querySelector<HTMLElement>('[data-ui="problem"]');
    m.body.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = input?.value ?? '';
      const why = nameProblem(value);
      if (why && problem) {
        problem.textContent = why;
        problem.hidden = false;
        input?.focus();
        return;
      }
      finish(value);
    });
    m.body.querySelector('[data-choice=""]')?.addEventListener('click', () => {
      finish(null);
    });
    input?.focus();
    input?.select();
  });
}

export function progress(o: { readonly title: string; readonly message: string }): ProgressDialog {
  const controller = new AbortController();
  let failure: ((retry: boolean) => void) | null = null;
  const m = modal(o.title, () => {
    if (failure) failure(false);
    else controller.abort();
  });
  const render = (message: string) => {
    m.body.innerHTML = `<p class="modal-progress" role="status">${escapeHtml(message)}</p>
      <div class="modal-buttons">${button('Cancel', 'cancel')}</div>`;
  };
  render(o.message);
  m.body.addEventListener('click', (event) => {
    const id = (event.target as HTMLElement).closest<HTMLElement>('[data-choice]')?.dataset[
      'choice'
    ];
    if (id === 'cancel') controller.abort();
    if (id === 'retry') failure?.(true);
    if (id === 'give-up') failure?.(false);
  });
  return {
    signal: controller.signal,
    update(message) {
      const p = m.body.querySelector('.modal-progress');
      if (p) p.textContent = message;
    },
    failed(message, retry) {
      m.body.innerHTML = `<p class="warn" role="alert">${escapeHtml(message)}</p>
        <div class="modal-buttons">${retry ? button('Try again', 'retry', 'primary') : ''}${button(retry ? 'Cancel' : 'Close', 'give-up')}</div>`;
      m.body.querySelector<HTMLButtonElement>('[data-choice]')?.focus();
      return new Promise<boolean>((resolve) => {
        failure = (again) => {
          failure = null;
          if (again) render('Trying again…');
          resolve(again);
        };
      });
    },
    close() {
      m.close();
    },
  };
}

/** The browser's dialogs. */
export function browserDialogs(notify: (message: string) => void): ScenarioDialogs {
  return { choose, askName, progress, notify };
}

/** Asks for a scenario file; its text, or `null` when none was chosen. */
export function pickScenarioFile(): Promise<{
  readonly name: string;
  readonly text: string;
} | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = `${SCENARIO_FILE_EXTENSION},.json,application/json`;
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      file.text().then(
        (text) => {
          resolve({ name: file.name, text });
        },
        () => {
          resolve({ name: file.name, text: '' });
        },
      );
    });
    input.addEventListener('cancel', () => {
      resolve(null);
    });
    input.click();
  });
}

/** Downloads `text` as a file. */
export function downloadText(name: string, text: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
  }, 1000);
}

// --- The library ---------------------------------------------------------------

export interface LibraryDialogActions {
  /** The saved scenarios, and the battlefields saved in this browser (by id). */
  list(): Promise<{
    readonly entries: readonly LibraryEntry[];
    readonly damaged: number;
    readonly savedBattlefields: ReadonlySet<string>;
  }>;
  load(id: string): void;
  import(): void;
  rename(id: string, name: string): Promise<void>;
  duplicate(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}

const when = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
};
const stageLabel = (stage: LibraryEntry['stage']) =>
  stage === 'bluefor' ? 'Planning' : 'Scenario Setup';

/**
 * The scenario library: saved scenarios, most recently modified first, each
 * with its battlefield, forces and time, to load, rename, duplicate or
 * delete; and Import. Closes when one is loaded or imported.
 */
export function openLibraryDialog(actions: LibraryDialogActions): { close(): void } {
  let closed = false;
  const m = modal(
    'Load scenario',
    () => {
      close();
    },
    true,
  );
  const close = () => {
    if (closed) return;
    closed = true;
    m.close();
  };
  m.body.innerHTML = `<div class="scn-head">
      <p class="muted">Saved in this browser. Loading opens the scenario's battlefield, generating it again if it is not saved here.</p>
      <button data-act="import" title="Load a scenario file (${SCENARIO_FILE_EXTENSION})">Import JSON…</button>
    </div>
    <ul class="scn-list" data-ui="scn-list"><li class="muted">Loading…</li></ul>
    <div class="modal-buttons"><button data-act="close">Close</button></div>`;
  const list = m.body.querySelector<HTMLElement>('[data-ui="scn-list"]');
  let entries: readonly LibraryEntry[] = [];
  let armed: string | null = null;
  let editing: string | null = null;

  const render = (saved: ReadonlySet<string>, damaged: number) => {
    if (!list) return;
    if (entries.length === 0) {
      list.innerHTML = `<li class="muted">No saved scenarios yet. Save one from Scenario Setup or Planning, or import a file.</li>${damaged > 0 ? `<li class="warn">${String(damaged)} saved scenario${damaged === 1 ? '' : 's'} could not be read.</li>` : ''}`;
      return;
    }
    list.innerHTML =
      entries
        .map((e) => {
          const id = escapeHtml(e.id);
          const name =
            editing === e.id
              ? `<form class="scn-rename" data-rename="${id}"><input value="${escapeHtml(e.name)}" maxlength="80" aria-label="New name"><button type="submit" class="small">Rename</button><button type="button" class="small" data-act="cancel-rename">Cancel</button></form>`
              : `<b class="scn-name">${escapeHtml(e.name)}</b>`;
          return `<li class="scn-row" data-id="${id}">
            <div class="scn-main">
              ${name}
              <span class="muted">${escapeHtml(e.terrainName)}${saved.has(e.battlefieldId) ? '' : ' · <span class="warn" title="This battlefield is not saved in this browser: loading generates it again">to be generated</span>'}</span>
              <span class="muted">${String(e.blufor)} BLUEFOR · ${String(e.opfor)} OPFOR squad${e.opfor === 1 ? '' : 's'} · ${escapeHtml(stageLabel(e.stage))} · ${escapeHtml(when(e.modifiedAt))}</span>
            </div>
            <div class="scn-actions">
              <button class="primary-btn small" data-act="load" data-id="${id}">Load</button>
              <button class="small" data-act="rename" data-id="${id}">Rename</button>
              <button class="small" data-act="duplicate" data-id="${id}">Duplicate</button>
              <button class="trash-btn" data-act="delete" data-id="${id}" ${armed === e.id ? 'data-confirm="yes" title="Click again to delete it"' : 'title="Delete"'} aria-label="Delete ${escapeHtml(e.name)}">${TRASH_ICON}</button>
            </div>
          </li>`;
        })
        .join('') +
      (damaged > 0
        ? `<li class="warn">${String(damaged)} saved scenario${damaged === 1 ? '' : 's'} could not be read.</li>`
        : '');
    if (editing) list.querySelector<HTMLInputElement>('.scn-rename input')?.select();
  };
  let savedFields: ReadonlySet<string> = new Set();
  let damagedCount = 0;
  const refresh = async () => {
    const r = await actions.list();
    entries = r.entries;
    savedFields = r.savedBattlefields;
    damagedCount = r.damaged;
    if (!closed) render(savedFields, damagedCount);
  };
  const problem = (error: unknown) => {
    if (list) {
      const li = document.createElement('li');
      li.className = 'warn';
      li.textContent = error instanceof Error ? error.message : String(error);
      list.prepend(li);
    }
  };
  m.body.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-act]');
    // Other clicks (the rename form's own buttons and fields) are theirs.
    if (!target) return;
    const act = target.dataset['act'];
    const id = target.dataset['id'] ?? '';
    const entry = entries.find((e) => e.id === id);
    if (act !== 'delete') armed = null;
    switch (act) {
      case 'close':
        close();
        return;
      case 'import':
        close();
        actions.import();
        return;
      case 'load':
        if (entry) {
          close();
          actions.load(entry.id);
        }
        return;
      case 'rename':
        editing = id;
        render(savedFields, damagedCount);
        return;
      case 'cancel-rename':
        editing = null;
        render(savedFields, damagedCount);
        return;
      case 'duplicate':
        if (entry) void actions.duplicate(entry.id).then(refresh, problem);
        return;
      case 'delete':
        if (!entry) return;
        if (armed !== entry.id) {
          armed = entry.id;
          render(savedFields, damagedCount);
          return;
        }
        armed = null;
        void actions.remove(entry.id).then(refresh, problem);
        return;
    }
    render(savedFields, damagedCount);
  });
  m.body.addEventListener('submit', (event) => {
    const form = (event.target as HTMLElement).closest<HTMLFormElement>('[data-rename]');
    if (!form) return;
    event.preventDefault();
    const id = form.dataset['rename'] ?? '';
    const value = form.querySelector('input')?.value ?? '';
    const why = nameProblem(value);
    if (why) {
      problem(new Error(why));
      return;
    }
    editing = null;
    void actions.rename(id, value).then(refresh, problem);
  });
  m.body.addEventListener('dblclick', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('.scn-row');
    if (!row || (event.target as HTMLElement).closest('button, form')) return;
    const id = row.dataset['id'] ?? '';
    if (!entries.some((e) => e.id === id)) return;
    close();
    actions.load(id);
  });
  void refresh().catch(problem);
  m.body.querySelector<HTMLButtonElement>('[data-act="import"]')?.focus();
  return { close };
}

/** A short message at the foot of the window, over whichever page is shown. */
export function windowToast(): (message: string) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (message) => {
    let element = document.querySelector<HTMLElement>('.toast.window-toast');
    if (!element) {
      element = document.createElement('div');
      element.className = 'toast window-toast';
      element.setAttribute('role', 'status');
      document.body.append(element);
    }
    const shown = element;
    shown.textContent = message;
    shown.hidden = message === '';
    clearTimeout(timer);
    timer = setTimeout(() => {
      shown.hidden = true;
    }, 4500);
  };
}
