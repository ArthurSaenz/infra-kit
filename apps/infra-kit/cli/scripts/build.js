import * as esbuild from 'esbuild'
import fs from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import packageJson from '../package.json' with { type: 'json' }

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const OUT_DIR = resolve(__dirname, '../dist')
const ENTRY_DIR = resolve(__dirname, '../src/entry')

const entryPoints = fs.readdirSync(ENTRY_DIR).map((file) => resolve(ENTRY_DIR, file))

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
