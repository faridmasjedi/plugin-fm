import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base: the same build is served at /studio/ by the NomadSF app and from
// the browser extension. No inline scripts, so it also passes the extension CSP.
export default defineConfig({
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 5000 },
  server: { proxy: { '/api': 'http://127.0.0.1:7007' } },
});
