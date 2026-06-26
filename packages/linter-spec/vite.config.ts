import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

// Pure-data ESM library: a single entry, no runtime dependencies to externalize.
export default defineConfig(() => {
  return {
    build: {
      target: 'esnext',
      lib: {
        entry: ['src/index.ts'],
        formats: ['es'],
        fileName: (format) => { return `index.${format}.js` },
      },
      sourcemap: true,
    },
    plugins: [dts({ insertTypesEntry: true })],
  }
})
