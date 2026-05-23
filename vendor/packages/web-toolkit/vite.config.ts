import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

// eslint-disable-next-line ts/ban-ts-comment
// @ts-ignore
import { peerDependencies } from './package.json'

export default defineConfig(() => {
  return {
    build: {
      target: 'esnext',
      lib: {
        entry: ['src/index.ts'],
        formats: ['es'],
        fileName: (format) => {
          return `index.${format}.js`
        },
        cssFileName: 'style',
      },
      rolldownOptions: {
        // Match subpath imports (e.g. react/jsx-runtime) so JSX transform output stays external
        external: (id: string) => {
          return Object.keys(peerDependencies).some((dep) => {
            return id === dep || id.startsWith(`${dep}/`)
          })
        },
      },
      sourcemap: true,
    },
    plugins: [react(), dts({ insertTypesEntry: true })],
  }
})
