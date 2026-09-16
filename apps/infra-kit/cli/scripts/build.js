/* eslint-disable sonarjs/no-os-command-from-path */
import * as esbuild from 'esbuild'
import fs from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import packageJson from '../package.json' with { type: 'json' }

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const PKG_DIR = resolve(__dirname, '..')
const OUT_DIR = resolve(PKG_DIR, 'dist')
const ENTRY_DIR = resolve(PKG_DIR, 'src/entry')

// 1. Bundle the JavaScript with esbuild (fast, but cannot emit .d.ts files).
//    Only the `.ts` files are entries — `src/entry/__tests__/` is a directory and
//    esbuild cannot resolve one as an entry point.
const entryPoints = fs
  .readdirSync(ENTRY_DIR)
  .filter((file) => {
    return file.endsWith('.ts')
  })
  .map((file) => {
    return resolve(ENTRY_DIR, file)
  })

/**
 * The exact esbuild options used by the real build. Exported so a test can
 * rebuild with the same configuration instead of hand-copying the flags (a
 * copy would drift and silently guard nothing).
 *
 * @type {import('esbuild').BuildOptions}
 */
export const buildOptions = {
  entryPoints,
  bundle: true,
  platform: 'node',
  // target: 'node20',
  format: 'esm',
  outdir: OUT_DIR,
  sourcemap: true,
  minify: true,
  // `splitting` is required so the dynamically-imported Ink TUI (src/tui/*) lands
  // in a separate lazy chunk. Without it, the auto-injected `react/jsx-runtime`
  // import would be hoisted into the eager cli.js bundle and load React on
  // every invocation — breaking the "no React on machine paths" guarantee.
  splitting: true,
  // Automatic JSX runtime so .tsx needs no `import React`. Pairs with
  // tsconfig `"jsx": "react-jsx"`.
  jsx: 'automatic',
  // Inline `resources/**/*.md` as strings. Esbuild strips the `?raw` query before
  // resolving, so this `.md` entry is what serves `import body from './body.md?raw'`.
  //
  // The `?raw` spelling — not a bare `.md` — is deliberate and is the reason this
  // loader alone is not the whole wiring (see src/md.d.ts). Esbuild accepts both,
  // but vitest resolves through Vite, where `?raw` is the native raw-text query and
  // a bare `.md` import is an unknown asset type. Dropping the suffix would keep
  // this build green while the test suite failed to load a resource at all.
  loader: { '.md': 'text' },
  // Externalize every runtime dependency, plus the React JSX runtime subpaths.
  //
  // A package key DOES cover its own subpaths (`pkg` externalizes `pkg/sub` too), so the React
  // entries are NOT here to work around that — `react` is a dependency and is already covered. They
  // are here because
  // `jsx: 'automatic'` makes esbuild AUTO-INJECT `react/jsx-runtime` imports that were never
  // written in the source, and those injected specifiers have to be named explicitly.
  //
  // Note this list is derived from `dependencies`: a package imported by shipped source but
  // declared only in `devDependencies` is NOT externalized — esbuild silently INLINES it and the
  // build still succeeds. Guards U6/U7 in src/__tests__/dependency-guards.test.ts catch exactly that.
  external: [...Object.keys(packageJson.dependencies), 'react/jsx-runtime', 'react/jsx-dev-runtime'],
}

// Importing this module (from the dist-shebang guard) must not trigger a build.
const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  await esbuild.build(buildOptions)

  for (const entryPoint of entryPoints) {
    const bundlePath = `${OUT_DIR}${entryPoint.replace(ENTRY_DIR, '').replace('.ts', '.js')}`

    const stat = fs.statSync(bundlePath)

    const fileName = bundlePath.split('/').pop()

    console.log('✅ Build was completed successfully: ', fileName, '-', +(stat.size / 1024 / 1024).toPrecision(3), 'MB')
  }

  // No declaration emit. `infra-kit` publishes a `bin` and nothing importable — its package.json
  // carries no `main`/`types`/`exports` at all. The library surface consumers used to import from here
  // (`defineConfig`, `infraKitDev`) moved to `@slip-stream-kit/config`, which emits and verifies its
  // own .d.ts. Keeping a dead `tsc --emitDeclarationOnly` here would ship type declarations nothing can
  // reach, and its `--skipLibCheck` would quietly degrade them to `any` rather than failing.
}
