/* eslint-disable sonarjs/no-os-command-from-path */
import * as esbuild from 'esbuild'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import packageJson from '../package.json' with { type: 'json' }

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const PKG_DIR = resolve(__dirname, '..')
const OUT_DIR = resolve(PKG_DIR, 'dist')
const ENTRY = resolve(PKG_DIR, 'src/index.ts')

/**
 * The exact esbuild options used by the real build. Exported so a test can rebuild with the same
 * configuration instead of hand-copying the flags (a copy would drift and silently guard nothing).
 *
 * Only the `eslint` peer is external: everything else — `@slip-stream-kit/config/package-type`
 * included — is inlined, which is what lets the published dist carry zero runtime dependencies.
 *
 * @type {import('esbuild').BuildOptions}
 */
export const buildOptions = {
  entryPoints: [ENTRY],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: OUT_DIR,
  sourcemap: true,
  minify: false,
  external: Object.keys(packageJson.peerDependencies ?? {}),
}

/**
 * Emit the public type declarations with tsc (esbuild does not generate them). Rooting tsc at the
 * single public entry (src/index.ts) walks only the reachable public surface via relative imports,
 * so test files are excluded without a separate build config. `--ignoreConfig` is required because
 * tsconfig.json is present alongside the input file. `--types node` is needed because some rules
 * import `node:` builtins (e.g. fs/path) and, with the config ignored, tsc would not otherwise load
 * `@types/node` to resolve those specifiers.
 *
 * @param {string} outDir
 */
export const emitDeclarations = (outDir) => {
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
      outDir,
      '--skipLibCheck',
      '--types',
      'node',
    ],
    { cwd: PKG_DIR, stdio: 'inherit' },
  )
}

// Importing this module (from a test) must not trigger a build.
const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  await esbuild.build(buildOptions)

  const bundlePath = resolve(OUT_DIR, 'index.js')
  const stat = fs.statSync(bundlePath)

  console.log('✅ Build was completed successfully: index.js -', +(stat.size / 1024).toPrecision(3), 'KB')

  emitDeclarations(OUT_DIR)

  console.log('✅ Type declarations emitted: dist/index.d.ts')
}
