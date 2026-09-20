import * as esbuild from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildOptions } from '../../../../scripts/build.js'

/**
 * `dist/package-type.js` is what the eslint-plugin bundles into ITS published dist, which ships with
 * zero runtime dependencies. One `zod` (or any package) import reaching this entry — say through a
 * refactor that routes it via `internal` — would silently make the plugin's install pull in zod.
 *
 * Built fresh into a temp dir with the REAL build options and inspected through esbuild's metafile:
 * `dist/` is gitignored and never produced by `pnpm run qa`, and the metafile records the resolved
 * inputs, so a `require`, a lazy `import()` or a subpath specifier all show up where a regex over
 * import statements would need to know every spelling in advance.
 */
let outDir = ''
let metafile: esbuild.Metafile | undefined

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'config-package-type-dist-'))
  ;({ metafile } = await esbuild.build({ ...buildOptions, outdir: outDir, metafile: true }))
}, 60_000)

afterAll(() => {
  rmSync(outDir, { force: true, recursive: true })
})

describe('dist/package-type.js shape', () => {
  it('imports nothing but node: builtins and is built from src/ only', () => {
    expect(metafile, 'the build must have produced a metafile').toBeDefined()

    const outputs = metafile!.outputs
    const entryKey = Object.keys(outputs).find((key) => {
      return key.endsWith('/package-type.js')
    })

    expect(entryKey, 'package-type.js must be one of the built outputs').toBeDefined()

    const output = outputs[entryKey!]!

    expect(
      output.imports.filter((imported) => {
        return !imported.path.startsWith('node:')
      }),
      'a non-node: import in dist/package-type.js becomes a runtime dependency of the eslint-plugin bundle',
    ).toEqual([])

    expect(
      Object.keys(output.inputs).filter((input) => {
        return input.includes('node_modules/')
      }),
      'a node_modules input means a package was inlined into the entry the plugin bundles',
    ).toEqual([])
  })
})
