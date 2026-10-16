// The loading overlay: whenever the page cannot take input because something
// is loading (a battlefield's terrain prepared, the 3D view, a battle starting
// or ending, a download), a progress bar in the middle of the screen says
// what, and how far it has got. It covers the page and takes every click and
// key while it is up (the page is made `inert`), so nothing is done half-way.
// Tasks are counted: the overlay stays while any is running and shows the
// latest. A task's progress is a fraction (0–1), or `null` when it cannot be
// told (the bar then moves to and fro). Brief tasks show nothing: the overlay
// appears only after `SHOW_AFTER_MS`, though input is held from the start;
// work that holds the main thread shows it at once (`immediate`) and waits
// for it to be drawn (`painted`).

export interface BusyTask {
  /** Its progress (0–1, or `null`: unknown) and, if given, a new label. */
  update(progress: number | null, label?: string): void;
  /** It is over (an error too): the overlay goes when no task is left. */
  done(): void;
}

/** A task shorter than this shows no overlay (ms). */
const SHOW_AFTER_MS = 250;

const CSS = `
.busy-overlay { position: fixed; inset: 0; z-index: 2000; display: grid; place-items: center;
  background: rgba(8, 10, 12, 0.55); backdrop-filter: blur(1.5px); cursor: progress; }
.busy-overlay[hidden] { display: none; }
.busy-card { min-width: 340px; max-width: min(520px, 90vw); padding: 18px 22px 20px;
  border-radius: 10px; background: #1b1f24; border: 1px solid #3a424c;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5); color: #e3e7ea;
  font: 14px system-ui, "Segoe UI", sans-serif; }
.busy-label { margin: 0 0 12px; font-weight: 600; }
.busy-track { position: relative; height: 10px; border-radius: 5px; overflow: hidden;
  background: #2b3138; }
.busy-fill { position: absolute; inset: 0 auto 0 0; width: 0; border-radius: 5px;
  background: linear-gradient(90deg, #3f8fe0, #6fb3ff); transition: width 0.25s ease-out; }
.busy-track.indeterminate .busy-fill { width: 35%; transition: none;
  animation: busy-sweep 1.2s ease-in-out infinite alternate; }
@keyframes busy-sweep { from { left: 0; } to { left: 65%; } }
.busy-percent { margin: 8px 0 0; color: #9aa6b1; font-size: 12px; text-align: right;
  font-variant-numeric: tabular-nums; min-height: 1em; }
`;

interface Entry {
  label: string;
  progress: number | null;
}

let overlay: HTMLElement | null = null;
const tasks: Entry[] = [];
let showTimer: ReturnType<typeof setTimeout> | null = null;

let styled = false;

/** The progress bar's styles, once (dialogs with a bar use them too). */
export function ensureBusyStyles(): void {
  if (styled) return;
  styled = true;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
}

/** A progress bar's HTML: unknown progress (`null`) moves to and fro. */
export function progressBarHtml(progress: number | null): string {
  ensureBusyStyles();
  const p = progress === null ? null : Math.max(0, Math.min(1, progress));
  return `<div class="busy-track${p === null ? ' indeterminate' : ''}" role="progressbar" aria-valuemin="0" aria-valuemax="100"${p === null ? '' : ` aria-valuenow="${String(Math.round(p * 100))}"`}><div class="busy-fill"${p === null ? '' : ` style="width: ${(p * 100).toFixed(1)}%"`}></div></div>`;
}

function element(): HTMLElement {
  if (overlay) return overlay;
  ensureBusyStyles();
  overlay = document.createElement('div');
  overlay.className = 'busy-overlay';
  overlay.hidden = true;
  overlay.setAttribute('role', 'alertdialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-live', 'polite');
  overlay.innerHTML = `<div class="busy-card">
      <p class="busy-label"></p>
      <div class="busy-track" role="progressbar" aria-valuemin="0" aria-valuemax="100"><div class="busy-fill"></div></div>
      <p class="busy-percent"></p>
    </div>`;
  // Nothing beneath is reached while it is up.
  const swallow = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  for (const type of ['mousedown', 'click', 'dblclick', 'wheel', 'contextmenu', 'touchstart'])
    overlay.addEventListener(type, swallow, { passive: false });
  document.body.append(overlay);
  return overlay;
}

/** The page under the overlay: everything else in the document's body. */
function setInert(on: boolean): void {
  for (const child of Array.from(document.body.children)) {
    if (child === overlay || !(child instanceof HTMLElement)) continue;
    if (on) child.setAttribute('inert', '');
    else child.removeAttribute('inert');
  }
}

function render(): void {
  const el = element();
  const top = tasks[tasks.length - 1];
  if (!top) return;
  const label = el.querySelector<HTMLElement>('.busy-label');
  const track = el.querySelector<HTMLElement>('.busy-track');
  const fill = el.querySelector<HTMLElement>('.busy-fill');
  const percent = el.querySelector<HTMLElement>('.busy-percent');
  if (!label || !track || !fill || !percent) return;
  label.textContent = top.label;
  el.setAttribute('aria-label', top.label);
  if (top.progress === null) {
    track.classList.add('indeterminate');
    track.removeAttribute('aria-valuenow');
    fill.style.width = '';
    percent.textContent = '';
  } else {
    const p = Math.max(0, Math.min(1, top.progress));
    track.classList.remove('indeterminate');
    track.setAttribute('aria-valuenow', String(Math.round(p * 100)));
    fill.style.width = `${(p * 100).toFixed(1)}%`;
    percent.textContent = `${String(Math.round(p * 100))}%`;
  }
}

/**
 * Starts a blocking task: input is held at once, and the progress bar shows
 * after a moment if it is still running. Call `done` when it is over.
 */
export function busy(
  label: string,
  progress: number | null = null,
  options: { readonly immediate?: boolean } = {},
): BusyTask {
  if (typeof document === 'undefined') return { update: () => undefined, done: () => undefined };
  const entry: Entry = { label, progress };
  tasks.push(entry);
  const el = element();
  if (tasks.length === 1) {
    setInert(true);
    // Keys go nowhere beneath while it is up.
    el.tabIndex = -1;
    el.focus({ preventScroll: true });
    if (options.immediate) el.hidden = false;
    else
      showTimer = setTimeout(() => {
        showTimer = null;
        if (tasks.length > 0) el.hidden = false;
      }, SHOW_AFTER_MS);
  } else if (options.immediate) el.hidden = false;
  render();
  let over = false;
  return {
    update(next, nextLabel) {
      if (over) return;
      entry.progress = next;
      if (nextLabel !== undefined) entry.label = nextLabel;
      render();
    },
    done() {
      if (over) return;
      over = true;
      tasks.splice(tasks.indexOf(entry), 1);
      if (tasks.length > 0) {
        render();
        return;
      }
      if (showTimer !== null) clearTimeout(showTimer);
      showTimer = null;
      el.hidden = true;
      setInert(false);
    },
  };
}

/** Runs `work` as a blocking task (`busy`), over when it settles. */
export async function whileBusy<T>(
  label: string,
  work: (task: BusyTask) => Promise<T>,
): Promise<T> {
  const task = busy(label);
  try {
    return await work(task);
  } finally {
    task.done();
  }
}

/**
 * Resolves once the browser has drawn a frame: work that holds the main
 * thread (building the 3D view) waits for it, so the overlay is on screen
 * first.
 */
export function painted(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  });
}

/** Whether a blocking task is running (for checks in the browser and tests). */
export function isBusy(): boolean {
  return tasks.length > 0;
}
