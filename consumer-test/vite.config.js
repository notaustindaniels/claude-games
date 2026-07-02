import { defineConfig } from 'vite';

export default defineConfig({
  // Keep openocean un-prebundled so Vite resolves its module worker
  // (new URL('./sim-worker.js', import.meta.url)) from source.
  optimizeDeps: { exclude: ['openocean'] },
  // The file: install of openocean must share the SAME three instance as the
  // app (two copies break TSL's node-stack context).
  resolve: { dedupe: ['three'] },
  build: { target: 'esnext' },
});
