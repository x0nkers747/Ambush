// Screenshots of the map (the Screenshot button). In development the dev
// server saves them in assets/reference/ (vite.config.ts), with their notes
// (battlefield, view, camera) beside them as JSON; elsewhere the picture is
// downloaded.

const ENDPOINT = '/__ambush/screenshot';

/** A file name: the battlefield's first word, the view, and the local date and time. */
export function screenshotName(battlefield: string, view: '2d' | '3d', when: Date): string {
  const word = battlefield.split(',')[0]?.trim().toLowerCase() ?? '';
  const first = word === '' ? 'battlefield' : word;
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${String(when.getFullYear())}${pad(when.getMonth() + 1)}${pad(when.getDate())}-${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
  return `${first}-${view}-${stamp}`.replace(/[^\w.-]+/g, '-');
}

/**
 * Saves `canvas` as a JPEG named `name`, with `notes`. Resolves to where it
 * was saved (a path under the project), or null when it was downloaded.
 */
export async function saveScreenshot(
  canvas: HTMLCanvasElement,
  name: string,
  notes: unknown,
): Promise<string | null> {
  const image = canvas.toDataURL('image/jpeg', 0.92);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, image, notes }),
    });
    if (res.ok) {
      const saved = (await res.json()) as { file?: unknown };
      if (typeof saved.file === 'string') return saved.file;
    }
  } catch {
    // No dev server: downloaded below.
  }
  const a = document.createElement('a');
  a.href = image;
  a.download = `${name}.jpg`;
  a.click();
  return null;
}
