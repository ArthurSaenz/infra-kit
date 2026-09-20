import * as esbuild from 'esbuild'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildOptions, emitDeclarations } from '../../scripts/build.js'

/**
 * The published plugin has NO runtime dependencies: `@slip-stream-kit/config` is a devDependency
 * whose `package-type` entry gets inlined at build time. If the bundle ever kept it as a bare
 * import, or the declaration emit ever referenced it, every consumer would need the config package
 * installed next to the plugin — and nothing else would fail to say so.
 *
 * Built fresh into a temp dir with the REAL build options: `dist/` is gitignored and never produced
 * by `pnpm run qa`, so reading it would guard nothing. The metafile records the resolved inputs and
 * imports, so a `require`, a lazy `import()` or a subpath specifier all show up where a regex over
 * import statements would need to know every spelling in advance.
 */
const CONFIG_PACKAGE = '@slip-stream-kit/config'

let outDir = ''
let metafile: esbuild.Metafile | undefined

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'eslint-plugin-dist-shape-'))
  ;({ metafile } = await esbuild.build({ ...buildOptions, outdir: outDir, metafile: true }))
  emitDeclarations(outDir)
}, 120_000)

afterAll(() => {
  rmSync(outDir, { force: true, recursive: true })
})

describe('dist/index.js shape', () => {
  it('imports nothing but node: builtins and the eslint peer', () => {
    expect(metafile, 'the build must have produced a metafile').toBeDefined()

    const outputs = metafile!.outputs
    const entryKey = Object.keys(outputs).find((key) => {
      return key.endsWith('/index.js')
    })

    expect(entryKey, 'index.js must be one of the built outputs').toBeDefined()

    const output = outputs[entryKey!]!

    expect(
      output.imports.filter((imported) => {
        return !imported.path.startsWith('node:') && imported.path !== 'eslint'
      }),
      `a bare import other than node:* / eslint in dist/index.js is a runtime dependency package.json does not declare — ${CONFIG_PACKAGE} in particular must be inlined, never imported`,
    ).toEqual([])
  })

  // The import-shape assertion above would also pass if the rule stopped using the config package
  // at all; this one proves the inference is really bundled in.
  it(`inlines detectPackageType from ${CONFIG_PACKAGE}`, () => {
    const bundle = readFileSync(join(outDir, 'index.js'), 'utf8')

    expect(bundle).toContain('detectPackageType')
    // The workspace link is realpath'd by esbuild, so the input is keyed by the config package's
    // dist path (`../config/dist/package-type.js`), not by its package name.
    expect(
      Object.keys(metafile!.inputs).some((input) => {
        return input.endsWith('/dist/package-type.js')
      }),
      `the metafile inputs must include the ${CONFIG_PACKAGE} package-type entry — the package-structure rule reads its inference from there`,
    ).toBe(true)
  })
})

describe('dist/index.d.ts shape', () => {
  it(`never references ${CONFIG_PACKAGE}`, () => {
    const declaration = readFileSync(join(outDir, 'index.d.ts'), 'utf8')

    expect(
      declaration.includes(CONFIG_PACKAGE),
      `a ${CONFIG_PACKAGE} specifier in dist/index.d.ts makes every consumer's tsc resolve a package the plugin does not ship — keep the public types local`,
    ).toBe(false)
  })
})
