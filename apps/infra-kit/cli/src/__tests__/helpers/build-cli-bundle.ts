import * as esbuild from 'esbuild'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { buildOptions } from '../../../scripts/build.js'

/**
 * `buildOptions` builds every `src/entry/*.ts`, not just `mcp.ts` — `cli.js` included — so this
 * lives outside `src/mcp` and is named for what it actually builds.
 */

const CLI_ROOT = resolve(__dirname, '../../..')

/**
 * Env switches every spawned CLI/MCP process needs: no `$HOME` seeding, no self-update, no location
 * warning. Without these a test run mutates the developer's real `~/.infra-kit`.
 */
export const KILL_SWITCHES = {
  INFRA_KIT_NO_SEED: '1',
  INFRA_KIT_NO_AUTO_UPDATE: '1',
  INFRA_KIT_NO_LOCATION_WARN: '1',
} as const

/**
 * Builds the real bundle from the EXPORTED `buildOptions` and returns the path to `mcp.js`.
 *
 * Two invariants live here:
 *  1. Never read a checked-out `dist/`. `dist` is gitignored, `qa` has no build step, and turbo's
 *     `test` depends on `^build` (dependencies, not self) — so a committed `dist/` would make every
 *     assertion downstream vacuous.
 *  2. Output MUST land under this package's `node_modules/.cache`, never `os.tmpdir()`.
 *     `buildOptions` leaves dependencies external, so the bundle only resolves them by walking up
 *     to a `node_modules` that exists ABOVE it. Built into tmpdir it dies on ERR_MODULE_NOT_FOUND
 *     before running a single line.
 *
 * Push the returned `outDir` onto the caller's cleanup list.
 */
export const buildCliBundle = async (
  prefix: string,
  plugins: esbuild.Plugin[] = [],
): Promise<{ outDir: string; mcpPath: string }> => {
  const cache = resolve(CLI_ROOT, 'node_modules', '.cache')

  mkdirSync(cache, { recursive: true })

  const outDir = mkdtempSync(join(cache, prefix))

  await esbuild.build({
    ...buildOptions,
    outdir: outDir,
    plugins: [...(buildOptions.plugins ?? []), ...plugins],
  })

  return { outDir, mcpPath: join(outDir, 'mcp.js') }
}
