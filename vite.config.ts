import { defineConfig } from 'vite';

// `#sim`, `#exercise`, … resolve through the package.json "imports" field,
// which Vite, TypeScript and Node all understand natively.
export default defineConfig({
  build: {
    // milsymbol (military symbols, docs/adr/0012) is about 860 kB minified on its own.
    chunkSizeWarningLimit: 1200,
  },
});
