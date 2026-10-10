import { defineConfig } from 'vite';

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

// `#sim`, `#exercise`, … resolve through the package.json "imports" field,
// which Vite, TypeScript and Node all understand natively.
export default defineConfig(({ command, isPreview }) => ({
  // `vite preview` serves the built site, so it uses the built site's base too.
  base: command === 'serve' && !isPreview ? '/' : productionBase(),
  build: {
    // milsymbol (APP-6 unit symbols, docs/adr/0012) is about 860 kB minified on its own.
    chunkSizeWarningLimit: 1200,
  },
}));
