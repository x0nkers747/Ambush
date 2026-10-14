// Screenshots of the comparison page (the Screenshot button). With the dev
// server they are saved in screenshots/ (vite.config.ts) with their notes
// beside them as JSON; otherwise the picture is downloaded.

const ENDPOINT = '/__proto/screenshot';

/** A file name: the character, the playback time and the local date and time. */
export function screenshotName(character: string, time: number, when: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${String(when.getFullYear())}${pad(when.getMonth() + 1)}${pad(when.getDate())}-${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
  return `${character}-t${time.toFixed(2)}-${stamp}`.replace(/[^\w.-]+/g, '-');
}

/**
 * Saves `canvas` as a JPEG named `name`, with `notes`. Resolves to where it
 * was saved (a path under the prototype), or null when it was downloaded.
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
