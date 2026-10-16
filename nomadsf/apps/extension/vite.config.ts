import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Popup page + background service worker. The Studio itself is the @nomadsf/ui build,
// copied into dist/app by scripts/package.mjs.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: { popup: resolve(__dirname, 'popup.html'), background: resolve(__dirname, 'src/background.ts') },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});
