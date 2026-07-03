import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
export default defineConfig({
  root: here,
  base: './',
  build: { outDir: path.join(here, '..', 'dist-consumer'), emptyOutDir: true },
  server: { fs: { allow: [path.join(here, '..')] } },
})
