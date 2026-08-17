import * as esbuild from 'esbuild'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { buildOptions } from '../../../../scripts/build.js'

/**
 * Shared fixtures for the MCP protocol tests.
 *
 * This exists for ONE reason: the three things below each encode a non-obvious invariant that was
 * duplicated across `mcp-stdio.e2e.test.ts` and `mcp-confirm-gate-mutation.test.ts`. Duplicating a
 * subtle invariant is how one copy silently drifts and the guard it protects quietly stops working.
 * It is deliberately three small functions, not a harness framework — if a fourth consumer never
 * appears, this file should stay exactly this size.
 *
 * Not a `*.test.ts` file, so vitest's default `include` never collects it as an empty suite.
 */

const CLI_ROOT = resolve(__dirname, '../../../..')

/**
 * Env switches every spawned MCP server needs: no `$HOME` seeding, no self-update, no location
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
export const buildMcpBundle = async (
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

/**
 * A throwaway session cache for the confirm-gate tests, seeded so `env-clear` has something to
 * clear (it errors when nothing is loaded).
 *
 * `getSessionCacheDir()` is `<XDG_CACHE_HOME|~/.cache>/infra-kit/<INFRA_KIT_SESSION>`, so setting
 * both env vars redirects the ENTIRE session cache into a temp dir. That is what makes it safe for
 * the mutation build — where the gate is neutered and the gated tool GENUINELY EXECUTES — to run
 * against a real destructive tool.
 *
 * Note this redirects the session CACHE only. The pino log path is a hard-coded global and is NOT
 * sandboxable by this (see `LOG_FILE_PATH` in src/lib/logger).
 */
export const makeDisposableSession = (): { cacheHome: string; env: NodeJS.ProcessEnv; clearFile: string } => {
  const cacheHome = mkdtempSync(join(tmpdir(), 'mcp-session-'))
  const session = 'mcp-test'
  const sessionDir = join(cacheHome, 'infra-kit', session)

  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(join(sessionDir, 'env-load.sh'), 'export FOO=bar\n')

  return {
    cacheHome,
    env: { ...process.env, ...KILL_SWITCHES, XDG_CACHE_HOME: cacheHome, INFRA_KIT_SESSION: session },
    clearFile: join(sessionDir, 'env-clear.sh'),
  }
}
