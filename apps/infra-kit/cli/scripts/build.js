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
const ENTRY_DIR = resolve(PKG_DIR, 'src/entry')

// 1. Bundle the JavaScript with esbuild (fast, but cannot emit .d.ts files).
const entryPoints = fs.readdirSync(ENTRY_DIR).map((file) => {
  return resolve(ENTRY_DIR, file)
})

await esbuild.build({
  entryPoints,
  bundle: true,
  platform: 'node',
  // target: 'node20',
  format: 'esm',
  outdir: OUT_DIR,
  sourcemap: true,
  minify: true,
  external: Object.keys(packageJson.dependencies),
})

for (const entryPoint of entryPoints) {
  const bundlePath = `${OUT_DIR}${entryPoint.replace(ENTRY_DIR, '').replace('.ts', '.js')}`

  const stat = fs.statSync(bundlePath)

  const fileName = bundlePath.split('/').pop()

  console.log('✅ Build was completed successfully: ', fileName, '-', +(stat.size / 1024 / 1024).toPrecision(3), 'MB')
}

// 2. Emit the public type declarations with tsc (esbuild does not generate them).
//    The library entry (src/entry/index.ts) only re-exports the package-config
//    API via relative imports, so tsc needs no project config — a direct CLI
//    call replaces the separate tsconfig.build.json. `--ignoreConfig` is
//    required because tsconfig.json is present alongside the input file.
execFileSync(
  'tsc',
  [
    'src/entry/index.ts',
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

console.log('✅ Type declarations emitted: dist/entry/index.d.ts')
