import { saveScreenshot } from './screenshot';

// The Feedback button on every page: a note and a picture of what is on
// screen, for reporting what one sees. In development the dev server saves
// both in assets/reference/ (screenshot.ts); elsewhere the picture is
// downloaded.
//
// The picture is every visible canvas (the 2D map, the 3D view and its
// overlay) drawn where it is on the page, with the note as a caption; HTML
// panels cannot be drawn without a library, so their text goes in the notes
// instead, with the page's address, the game's state (`ambushState`) and the
// 3D camera.

const css = `
.feedback-btn { position: fixed; right: 12px; bottom: 12px; z-index: 1000; padding: 6px 12px;
  border-radius: 6px; border: 1px solid #4a5563; background: #1f2630ee; color: #e6e9ee;
  font: 600 13px system-ui, sans-serif; cursor: pointer; box-shadow: 0 2px 8px #0008; }
.feedback-btn:hover { background: #2b3542; }
.feedback-box { position: fixed; right: 12px; bottom: 52px; z-index: 1000; width: 340px;
  padding: 10px; border-radius: 8px; border: 1px solid #4a5563; background: #1b2028f5;
  color: #e6e9ee; font: 13px system-ui, sans-serif; box-shadow: 0 4px 16px #000a; }
.feedback-box textarea { width: 100%; box-sizing: border-box; height: 70px; resize: vertical;
  background: #11151b; color: #e6e9ee; border: 1px solid #4a5563; border-radius: 4px;
  padding: 6px; font: inherit; }
.feedback-box .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px;
  align-items: center; }
.feedback-box .row span { flex: 1; color: #9aa4b2; font-size: 12px; }
.feedback-box button { padding: 4px 12px; border-radius: 4px; border: 1px solid #4a5563;
  background: #2b3542; color: #e6e9ee; cursor: pointer; font: inherit; }
.feedback-box button.save { background: #2f6fd0; border-color: #2f6fd0; }
`;

/** A file name: "feedback", the page's stage and the local date and time. */
export function feedbackName(stage: string, when: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${String(when.getFullYear())}${pad(when.getMonth() + 1)}${pad(when.getDate())}-${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
  return `feedback-${stage || 'page'}-${stamp}`.replace(/[^\w.-]+/g, '-');
}

type WithHooks = HTMLElement & {
  ambushState?: () => unknown;
};
type View3dCanvas = HTMLCanvasElement & {
  ambushCapture?: () => string;
  ambushDebug?: () => unknown;
};

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      resolve(img);
    };
    img.onerror = () => {
      reject(new Error('image'));
    };
    img.src = src;
  });

const visible = (c: HTMLCanvasElement) => {
  const r = c.getBoundingClientRect();
  const style = getComputedStyle(c);
  return (
    r.width > 0 &&
    r.height > 0 &&
    style.visibility !== 'hidden' &&
    style.display !== 'none' &&
    !c.closest('[hidden]')
  );
};

/** The page as a picture: its visible canvases where they are, and the note as a caption. */
async function picture(note: string): Promise<HTMLCanvasElement> {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.round(window.innerWidth * ratio);
  const caption = Math.round(28 * ratio);
  const out = document.createElement('canvas');
  out.width = width;
  out.height = Math.round(window.innerHeight * ratio) + caption;
  const g = out.getContext('2d');
  if (!g) return out;
  g.fillStyle = '#15191f';
  g.fillRect(0, 0, out.width, out.height);
  // 3D views first (their overlays and any 2D canvases go on top).
  const canvases = [...document.querySelectorAll('canvas')].filter(visible);
  canvases.sort(
    (a, b) => Number(b.classList.contains('view3d')) - Number(a.classList.contains('view3d')),
  );
  for (const c of canvases) {
    const r = c.getBoundingClientRect();
    try {
      // A WebGL view's drawing buffer is not kept: it draws a frame to copy.
      const capture = (c as View3dCanvas).ambushCapture;
      const source = capture ? await loadImage(capture()) : c;
      g.drawImage(source, r.left * ratio, r.top * ratio, r.width * ratio, r.height * ratio);
    } catch {
      // A canvas that cannot be read (tainted): left out.
    }
  }
  g.fillStyle = '#1f2630';
  g.fillRect(0, out.height - caption, out.width, caption);
  g.fillStyle = '#e6e9ee';
  g.font = `${String(Math.round(13 * ratio))}px system-ui, sans-serif`;
  g.textBaseline = 'middle';
  g.fillText(
    `${location.pathname}${location.search}${location.hash} — ${note || '(no note)'}`,
    10 * ratio,
    out.height - caption / 2,
    width - 20 * ratio,
  );
  return out;
}

/** What the page shows, for the notes: the game's state, the 3D camera, the page's text. */
function notesOf(note: string, when: Date) {
  const app = document.querySelector<WithHooks>('#app');
  const read = <T>(f: () => T): T | null => {
    try {
      return f();
    } catch {
      return null;
    }
  };
  const state = read(() => app?.ambushState?.() ?? null);
  const view3d = [...document.querySelectorAll<View3dCanvas>('canvas.view3d')].find(visible);
  const camera = read(() => {
    const d = view3d?.ambushDebug?.() as
      { target?: unknown; position?: unknown; characters?: unknown } | undefined;
    return d ? { target: d.target, position: d.position, characters: d.characters } : null;
  });
  return {
    note,
    takenAt: when.toISOString(),
    url: location.href,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    view: view3d ? '3d' : '2d',
    camera,
    state,
    pageText: document.body.innerText.slice(0, 20000),
  };
}

/** Puts the Feedback button on the page (once; it stays across pages). */
export function installFeedbackButton(): void {
  if (document.querySelector('.feedback-btn')) return;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
  const button = document.createElement('button');
  button.className = 'feedback-btn';
  button.type = 'button';
  button.textContent = '📷 Feedback';
  button.title = 'Save a screenshot of this page with a note';
  const box = document.createElement('div');
  box.className = 'feedback-box';
  box.hidden = true;
  box.innerHTML = `<textarea placeholder="What do you see? (Enter saves, Shift+Enter: new line)" aria-label="Feedback note"></textarea>
    <div class="row"><span></span><button type="button" class="cancel">Cancel</button><button type="button" class="save">Save</button></div>`;
  const text = box.querySelector('textarea');
  const status = box.querySelector('span');
  const save = box.querySelector<HTMLButtonElement>('.save');
  const cancel = box.querySelector<HTMLButtonElement>('.cancel');
  if (!text || !status || !save || !cancel) return;
  document.body.append(button, box);

  const close = () => {
    box.hidden = true;
  };
  const submit = async () => {
    const note = text.value.trim();
    status.textContent = 'Saving…';
    // The box and button are HTML, so they are not in the picture anyway.
    const when = new Date();
    const notes = notesOf(note, when);
    const stage =
      typeof notes.state === 'object' && notes.state !== null && 'stage' in notes.state
        ? String(notes.state.stage)
        : 'terrain';
    const file = await saveScreenshot(await picture(note), feedbackName(stage, when), notes);
    status.textContent = file ? `Saved ${file}` : 'Downloaded';
    text.value = '';
    setTimeout(close, 1500);
  };
  button.addEventListener('click', () => {
    box.hidden = !box.hidden;
    status.textContent = '';
    if (!box.hidden) text.focus();
  });
  cancel.addEventListener('click', close);
  save.addEventListener('click', () => {
    void submit();
  });
  text.addEventListener('keydown', (e) => {
    // Keys typed here are the note's, not the game's shortcuts.
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
    if (e.key === 'Escape') close();
  });
}
