import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Where the built site is served from (docs/GITHUB_PAGES_DEPLOYMENT.md).
 * `BASE_PATH` when set (e.g. "/" for a custom domain); otherwise, in GitHub
 * Actions, the repository's GitHub Pages path ("/<repository>/", from
 * `GITHUB_REPOSITORY`); otherwise "/". The dev server always serves "/";
 * `vite preview` serves the built site at its base.
 */
function productionBase(): string {
  const configured = process.env['BASE_PATH']?.trim();
  if (configured) return configured.endsWith('/') ? configured : `${configured}/`;
  const repository = process.env['GITHUB_REPOSITORY']?.split('/')[1];
  return repository ? `/${repository}/` : '/';
}

// Development only: the app's Screenshot button POSTs here, and the picture
// (and its notes, e.g. the camera) is saved in assets/reference/, where it
// can be found and compared later. The built site has no such endpoint and
// downloads the picture instead (src/app/screenshot.ts).

const SCREENSHOT_ENDPOINT = '/__ambush/screenshot';
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
  const folder = resolve(root, 'assets', 'reference');
  return {
    name: 'ambush-screenshot-endpoint',
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
            const file = join(folder, `${name}.${ext}`);
            writeFileSync(file, Buffer.from(match[2], 'base64'));
            if (body.notes !== undefined)
              writeFileSync(
                join(folder, `${name}.json`),
                `${JSON.stringify(body.notes, null, 2)}\n`,
              );
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ file: `assets/reference/${name}.${ext}` }));
          } catch (error: unknown) {
            res.statusCode = 400;
            res.end(error instanceof Error ? error.message : 'bad request');
          }
        });
      });
    },
  };
}

// `#sim`, `#exercise`, … resolve through the package.json "imports" field,
// which Vite, TypeScript and Node all understand natively.
export default defineConfig(({ command, isPreview }) => ({
  // `vite preview` serves the built site, so it uses the built site's base too.
  base: command === 'serve' && !isPreview ? '/' : productionBase(),
  plugins: [screenshotEndpoint(import.meta.dirname)],
  build: {
    // Three.js (the 3D view, loaded on first use) is about 790 kB minified on its own.
    chunkSizeWarningLimit: 1200,
  },
}));
