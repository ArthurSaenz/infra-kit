import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { KILL_SWITCHES } from 'src/__tests__/helpers/build-cli-bundle'

export { buildCliBundle as buildMcpBundle, KILL_SWITCHES } from 'src/__tests__/helpers/build-cli-bundle'

/**
 * Shared fixtures for the MCP protocol tests.
 *
 * `KILL_SWITCHES` and the bundle builder moved to `src/__tests__/helpers/build-cli-bundle` (they
 * were never MCP-specific) and are re-exported here so the rest of this directory's imports stay
 * unchanged. `makeDisposableSession` below is the one fixture that IS MCP-specific.
 *
 * Not a `*.test.ts` file, so vitest's default `include` never collects it as an empty suite.
 */

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
