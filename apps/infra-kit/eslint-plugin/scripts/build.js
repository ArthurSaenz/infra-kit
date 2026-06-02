import * as esbuild from 'esbuild'
import fs from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

import packageJson from '../package.json' with { type: 'json' }

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const ROOT_DIR = resolve(__dirname, '..')
const SRC_DIR = resolve(ROOT_DIR, 'src')
const OUT_DIR = resolve(ROOT_DIR, 'dist')
const ENTRY = resolve(SRC_DIR, 'index.ts')
const TSCONFIG = resolve(ROOT_DIR, 'tsconfig.json')

// 1. Bundle the runtime JS with esbuild.
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

// 2. Emit declarations from the single tsconfig.json, scoped to the public
// entry graph. Rooting the program at index.ts walks only the reachable
// public surface, so test files are excluded without a separate build config.
const configFile = ts.readConfigFile(TSCONFIG, ts.sys.readFile)

if (configFile.error) {
  throw new Error(ts.formatDiagnosticsWithColorAndContext([configFile.error], ts.sys))
}

const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, ROOT_DIR)
const program = ts.createProgram([ENTRY], {
  ...parsed.options,
  noEmit: false,
  declaration: true,
  emitDeclarationOnly: true,
  composite: false,
  incremental: false,
  tsBuildInfoFile: undefined,
  rootDir: SRC_DIR,
  outDir: OUT_DIR,
})

const emitResult = program.emit()
const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics)

if (diagnostics.length > 0) {
  throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, ts.sys))
}

const bundlePath = resolve(OUT_DIR, 'index.js')
const stat = fs.statSync(bundlePath)

console.log('✅ Build was completed successfully: index.js -', +(stat.size / 1024).toPrecision(3), 'KB')
