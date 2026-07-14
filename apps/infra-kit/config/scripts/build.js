/* eslint-disable sonarjs/no-os-command-from-path */
import * as esbuild from 'esbuild'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import packageJson from '../package.json' with { type: 'json' }

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const PKG_DIR = resolve(__dirname, '..')
const OUT_DIR = resolve(PKG_DIR, 'dist')
const ENTRY_DIR = resolve(PKG_DIR, 'src/entry')

const entryPoints = fs
  .readdirSync(ENTRY_DIR)
  .filter((file) => {
    return file.endsWith('.ts')
  })
  .map((file) => {
    return resolve(ENTRY_DIR, file)
  })

/**
 * The exact esbuild options used by the real build. Exported so a test can rebuild with the same
 * configuration instead of hand-copying the flags (a copy would drift and silently guard nothing).
 *
 * No `splitting` and no `bin`: this package is a pure library. `zod` is the ONLY runtime dependency
 * and is externalized, so an install of this package pulls in zod and nothing else — that is the
 * whole point of the package existing (see readme.md).
 *
 * @type {import('esbuild').BuildOptions}
 */
export const buildOptions = {
  entryPoints,
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: OUT_DIR,
  sourcemap: true,
  minify: false,
  external: Object.keys(packageJson.dependencies),
}

// Importing this module (from a test) must not trigger a build.
const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  await esbuild.build(buildOptions)

  for (const entryPoint of entryPoints) {
    const bundlePath = `${OUT_DIR}${entryPoint.replace(ENTRY_DIR, '').replace('.ts', '.js')}`
    const stat = fs.statSync(bundlePath)

    console.log('✅ Bundled:', bundlePath.split('/').pop(), '-', +(stat.size / 1024).toPrecision(3), 'KB')
  }

  // Emit the public type declarations with tsc (esbuild does not generate them). Rooting tsc at the
  // entry files walks only the reachable public surface via relative imports, so tests are excluded
  // without a separate build config. `--ignoreConfig` is required because tsconfig.json sits beside
  // the inputs.
  execFileSync(
    'tsc',
    [
      ...entryPoints.map((entry) => {
        return entry.replace(`${PKG_DIR}/`, '')
      }),
      '--ignoreConfig',
      '--declaration',
      '--emitDeclarationOnly',
      '--rootDir',
      'src',
      '--outDir',
      'dist',
      '--module',
      'esnext',
      '--moduleResolution',
      'bundler',
      '--target',
      'esnext',
      '--strict',
      '--skipLibCheck',
      '--types',
      'node',
    ],
    { cwd: PKG_DIR, stdio: 'inherit' },
  )

  // `--skipLibCheck` degrades an unresolved import into `any` rather than erroring, so a broken
  // declaration emit ships a public surface typed `any` and every downstream `tsc` goes quietly
  // green. Assert the real named types are present instead of trusting the exit code.
  const declarationGuards = [
    { file: 'dist/entry/index.d.ts', expected: ['defineConfig', 'InfraKitPackageConfig', 'defineVendorConfig'] },
    { file: 'dist/entry/vite.d.ts', expected: ['infraKitDev', 'InfraKitViteProxy'] },
    { file: 'dist/entry/internal.d.ts', expected: ['packageConfigSchema', 'slugifyHostLabel'] },
  ]

  for (const { file, expected } of declarationGuards) {
    const declaration = fs.readFileSync(resolve(PKG_DIR, file), 'utf-8')
    const missing = expected.filter((name) => {
      return !declaration.includes(name)
    })

    if (missing.length > 0) {
      throw new Error(`${file} is missing the public types [${missing.join(', ')}] — the declaration emit is broken.`)
    }
  }

  console.log('✅ Type declarations emitted and verified non-empty')
}
