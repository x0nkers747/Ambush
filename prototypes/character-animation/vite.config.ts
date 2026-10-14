import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// Development only: the page's Screenshot button POSTs here, and the picture
// and its notes (settings, time, camera, animation state, the user's note)
// are saved in screenshots/ (git-ignored), where they can be read back when
// discussing what they show. Without the dev server the picture is
// downloaded instead (src/screenshot.ts).

const SCREENSHOT_ENDPOINT = '/__proto/screenshot';
/** Largest request accepted, bytes. */
const MAX_BYTES = 40 * 1024 * 1024;

interface Body {
  readonly name?: unknown;
  readonly image?: unknown;
  readonly notes?: unknown;
}

/** A file name from `name`: letters, digits, dots, dashes and underscores only. */
function safeName(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 120);
  return s || 'screenshot';
}

function screenshotEndpoint(root: string): Plugin {
  const folder = resolve(root, 'screenshots');
  return {
    name: 'proto-screenshot-endpoint',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(SCREENSHOT_ENDPOINT, (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer) => {
          size += c.length;
          if (size <= MAX_BYTES) chunks.push(c);
        });
        req.on('end', () => {
          try {
            if (size > MAX_BYTES) throw new Error('too large');
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body;
            const image = typeof body.image === 'string' ? body.image : '';
            const match = /^data:image\/(jpeg|png);base64,(.+)$/.exec(image);
            if (!match?.[2]) throw new Error('no image');
            const ext = match[1] === 'png' ? 'png' : 'jpg';
            const name = safeName(typeof body.name === 'string' ? body.name : '');
            mkdirSync(folder, { recursive: true });
            writeFileSync(join(folder, `${name}.${ext}`), Buffer.from(match[2], 'base64'));
            if (body.notes !== undefined)
              writeFileSync(
                join(folder, `${name}.json`),
                `${JSON.stringify(body.notes, null, 2)}\n`,
              );
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ file: `screenshots/${name}.${ext}` }));
          } catch (error: unknown) {
            res.statusCode = 400;
            res.end(error instanceof Error ? error.message : 'bad request');
          }
        });
      });
    },
  };
}

// The prototype is its own Vite app (`npm run dev` here). It has no copy of
// three.js: `three` resolves to the repository's node_modules, so the
// prototype runs exactly the game's version.
export default defineConfig({
  base: './',
  resolve: { dedupe: ['three'] },
  plugins: [screenshotEndpoint(import.meta.dirname)],
  server: { port: 5199, strictPort: true },
  build: { chunkSizeWarningLimit: 4000 },
});
