import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Popup page + background service worker. The Studio itself is the @nomadsf/ui build,
// copied into dist/app by scripts/package.mjs.
const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: { popup: resolve(here, 'popup.html'), background: resolve(here, 'src/background.ts') },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});
