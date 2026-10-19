import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import mdx from 'fumadocs-mdx/vite'
import { nitro } from 'nitro/vite'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { defineConfig } from 'vite'

import { createDocsAggregation } from './src/lib/docs-aggregation'

const { repoRoot, appContentRel, getAllDocUrls } = createDocsAggregation({ appDir: import.meta.dirname })

const require = createRequire(import.meta.url)
const tslibEs6 = require.resolve('tslib/tslib.es6.js')

// With pnpm `enableGlobalVirtualStore`, deps resolve to the global store OUTSIDE the repo.
// TanStack Start's SSR dev runner serves nitro/react-start entries via /@fs/, which Vite
// blocks unless the store root is on server.fs.allow. Derive it from a real dep's path.
const nitroReal = realpathSync(path.resolve(import.meta.dirname, 'node_modules/nitro'))
const storeIdx = nitroReal.indexOf(`${path.sep}store${path.sep}`)
const pnpmStoreRoot = storeIdx >= 0 ? nitroReal.slice(0, storeIdx + `${path.sep}store`.length) : path.dirname(nitroReal)

export default defineConfig(async () => {
  // Seed every aggregated doc URL so prerendering is deterministic even if a page
  // is not reachable by link crawling.
  const docUrls = await getAllDocUrls()
  const pages = [
    { path: '/' },
    { path: '/docs' },
    ...docUrls.map((path) => {
      return { path }
    }),
    // Static Orama search index — emit at the raw path (no /index.html) so the
    // static client can fetch /api/search and parse the JSON.
    { path: '/api/search', prerender: { enabled: true, outputPath: '/api/search' } },
  ]

  return {
    // Expose the app's content-rel to the runtime loader (source.ts) without it importing
    // the node:fs aggregation module.
    define: {
      'import.meta.env.VITE_DOCS_CONTENT_REL': JSON.stringify(appContentRel),
    },
    server: {
      port: 3030,
      fs: { allow: [repoRoot, pnpmStoreRoot] },
    },
    plugins: [
      mdx(),
      tailwindcss(),
      tanstackStart({
        // Static-only output: SPA shell + prerendered pages, no running server required.
        spa: { enabled: true },
        prerender: { enabled: true, crawlLinks: true },
        pages,
      }),
      react(),
      // Nitro emits the static client (.output/public) that is uploaded to S3.
      nitro(),
    ],
    resolve: {
      tsconfigPaths: true,
      // Force the ESM build of tslib; the CJS default breaks prerender with
      // "Cannot destructure property '__extends'".
      alias: {
        tslib: tslibEs6,
      },
    },
  }
})
