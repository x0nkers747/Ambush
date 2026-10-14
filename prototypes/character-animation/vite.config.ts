import { defineConfig } from 'vite';

// The prototype is its own Vite app (`npm run dev` here). It has no copy of
// three.js: `three` resolves to the repository's node_modules, so the
// prototype runs exactly the game's version.
export default defineConfig({
  base: './',
  resolve: { dedupe: ['three'] },
  server: { port: 5199, strictPort: true },
  build: { chunkSizeWarningLimit: 4000 },
});
