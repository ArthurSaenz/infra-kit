import * as esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildOptions } from '../../../../scripts/build.js'
import type { ResourceKey } from '../resources'
import { SENTINELS } from './helpers/resource-sentinels'

const CLI_ROOT = path.resolve(import.meta.dirname, '../../../..')

/**
 * Proof that esbuild inlines `resources/**\/*.md` into the shipped bundle.
 *
 * This is the only guard on the highest-severity failure in this design, and it is
 * invisible to every other test in the package: they all run from `src/`, where a
 * refactor of `resources.ts` to a dynamic or computed import still resolves. In
 * `dist` that same refactor leaves the specifier unresolved and node throws
 * `ERR_UNKNOWN_FILE_EXTENSION` on a consumer's machine.
 */
describe('resources are inlined into the bundle', () => {
  it('emits every resource sentinel into the built output', async () => {
    // Build under `node_modules/.cache`, not the system tmpdir: externals resolve by
    // walking up to a `node_modules` above the bundle, which a `/var/folders` path has
    // nowhere to find. The existing MCP harness builds here for the same reason.
    const outdir = fs.mkdtempSync(path.join(CLI_ROOT, 'node_modules/.cache', 'resource-bundle-'))

    try {
      const started = Date.now()

      // The real exported options, not a hand-copied set of flags — a copy would drift
      // and the guard would then be verifying a build that is not the one we ship.
      await esbuild.build({ ...buildOptions, outdir })

      const elapsed = Date.now() - started

      // `splitting: true` puts shared modules in a `chunk-*.js`, not in `cli.js`, so
      // reading the entry alone would miss the text entirely.
      const emitted = fs
        .readdirSync(outdir)
        .filter((file) => {
          return file.endsWith('.js')
        })
        .map((file) => {
          return fs.readFileSync(path.join(outdir, file), 'utf8')
        })
        .join('\n')

      expect(emitted.length).toBeGreaterThan(0)

      for (const [key, sentinel] of Object.entries(SENTINELS) as [ResourceKey, string][]) {
        expect(emitted, `${key} was not inlined into the bundle`).toContain(sentinel)
      }

      // `resources/workflow/*.md` rides the same esbuild text loader and the same flat-static-import
      // rule, and is served over MCP rather than written into a consumer file — so a refactor that
      // leaves its specifier unresolved surfaces as an MCP server that cannot answer `resources/read`
      // for a procedure an agent was told to fetch. Asserted here, in the one lane that reads `dist`.
      expect(emitted, 'workflow/release-create was not inlined into the bundle').toContain(
        'mcp__infra-kit__release-create',
      )

      // Recorded rather than asserted: a full multi-entry esbuild build inside the unit
      // lane. If this creeps far past a few seconds, move the file to the opt-in
      // `qa:pty`-style lane rather than deleting the only guard on Scenario 1.
      expect(elapsed).toBeLessThan(60_000)
    } finally {
      fs.rmSync(outdir, { recursive: true, force: true })
    }
  })
})
