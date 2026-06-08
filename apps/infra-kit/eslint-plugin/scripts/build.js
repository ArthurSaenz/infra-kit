/* eslint-disable sonarjs/no-os-command-from-path */
import * as esbuild from 'esbuild'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import packageJson from '../package.json' with { type: 'json' }

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const PKG_DIR = resolve(__dirname, '..')
const OUT_DIR = resolve(PKG_DIR, 'dist')
const ENTRY = resolve(PKG_DIR, 'src/index.ts')

// 1. Bundle the JavaScript with esbuild (fast, but cannot emit .d.ts files).
await esbuild.build({
  entryPoints: [ENTRY],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: OUT_DIR,
  sourcemap: true,
  minify: false,
  external: Object.keys(packageJson.peerDependencies ?? {}),
})

const bundlePath = resolve(OUT_DIR, 'index.js')
const stat = fs.statSync(bundlePath)

console.log('✅ Build was completed successfully: index.js -', +(stat.size / 1024).toPrecision(3), 'KB')

// 2. Emit the public type declarations with tsc (esbuild does not generate them).
//    Rooting tsc at the single public entry (src/index.ts) walks only the
//    reachable public surface via relative imports, so test files are excluded
//    without a separate build config. `--ignoreConfig` is required because
//    tsconfig.json is present alongside the input file.
execFileSync(
  'tsc',
  [
    'src/index.ts',
    '--ignoreConfig',
    '--declaration',
    '--emitDeclarationOnly',
    '--rootDir',
    'src',
    '--outDir',
    'dist',
    '--skipLibCheck',
  ],
  { cwd: PKG_DIR, stdio: 'inherit' },
)

console.log('✅ Type declarations emitted: dist/index.d.ts')
