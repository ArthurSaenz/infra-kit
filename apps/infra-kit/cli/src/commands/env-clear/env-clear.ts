import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { z } from 'zod'

import {
  ENV_CLEAR_FILE,
  ENV_LOAD_FILE,
  INFRA_KIT_ENV_AUTOLOADED_VAR,
  INFRA_KIT_ENV_CLEARED_VAR,
  INFRA_KIT_ENV_CONFIG_VAR,
  INFRA_KIT_ENV_LOADED_AT_VAR,
  INFRA_KIT_ENV_PROJECT_ROOT_VAR,
  INFRA_KIT_ENV_PROJECT_VAR,
  INFRA_KIT_ENV_VAR,
  atomicWriteFileSync,
  getSessionCacheDir,
  parseVarNamesFromEnvFile,
} from 'src/lib/constants'
import { getProjectRoot } from 'src/lib/git-utils'
import { canonicalizeProjectRoot, invalidateProjectWarmCache } from 'src/lib/warm-cache'
import { defineMcpTool, textContent } from 'src/types'

export interface EnvClearArgs {
  /**
   * Also invalidate this project's WARM cache. `false` (default) writes a transient
   * clear-marker so the next shell skips warm-source once; `true` deletes the warm
   * dir outright (durable — warm won't resume until the next auto-load rewrites it).
   */
  purge?: boolean
}

/**
 * Invalidate the current project's warm cache alongside the session clear, so a
 * NEW shell doesn't warm-load what the user just cleared. Resolves the project root
 * itself (git top-level, realpath'd) to match the warm key; a non-git project never
 * had a warm file, so it is a no-op. Best-effort — never blocks the session clear.
 */
const clearProjectWarmCache = async (purge: boolean): Promise<void> => {
  let projectRoot = ''

  try {
    projectRoot = await getProjectRoot()
  } catch {
    return // non-git: no warm cache to invalidate
  }

  const canon = canonicalizeProjectRoot(projectRoot)

  if (canon) invalidateProjectWarmCache(canon, purge)
}

/**
 * Build the lines for env-clear.sh: `unset` every loaded var plus the session
 * metadata (config/project/loadedAt) and the auto-load marker, then EXPORT the
 * clear sentinel so cli-invocation auto-load stays suppressed in this shell until
 * an explicit `env-load` (which unsets it) or a new shell. Pure for testability.
 */
export const buildEnvClearLines = (varNames: string[]): string[] => {
  return [
    ...varNames.map((v) => {
      return `unset ${v}`
    }),
    `unset ${INFRA_KIT_ENV_VAR}`,
    `unset ${INFRA_KIT_ENV_CONFIG_VAR}`,
    `unset ${INFRA_KIT_ENV_PROJECT_VAR}`,
    `unset ${INFRA_KIT_ENV_PROJECT_ROOT_VAR}`,
    `unset ${INFRA_KIT_ENV_LOADED_AT_VAR}`,
    `unset ${INFRA_KIT_ENV_AUTOLOADED_VAR}`,
    `export ${INFRA_KIT_ENV_CLEARED_VAR}='1'`,
  ]
}

/**
 * Clear loaded env vars. Prints a file path to stdout that must be sourced to apply.
 * The env-clear shell alias does this automatically. Also invalidates the project's
 * WARM cache so a new shell doesn't re-load what was just cleared. Throws when no env
 * is loaded AND `--purge` was not passed (a bare clear needs something to clear; a
 * purge is a standalone warm-cache wipe that works regardless of session state).
 */
export const envClear = async ({ purge = false }: EnvClearArgs = {}) => {
  const cacheDir = getSessionCacheDir()
  const envLoadPath = path.join(cacheDir, ENV_LOAD_FILE)
  const hasLoadedEnv = fs.existsSync(envLoadPath)

  if (!hasLoadedEnv && !purge) {
    throw new Error('No loaded environment found. Run `env-load` first.')
  }

  // Warm invalidation is independent of the current session's load state.
  await clearProjectWarmCache(purge)

  const varNames = hasLoadedEnv ? parseVarNamesFromEnvFile(envLoadPath) : []

  const unsetLines = buildEnvClearLines(varNames)

  const clearFilePath = path.resolve(cacheDir, ENV_CLEAR_FILE)

  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 })

  atomicWriteFileSync(clearFilePath, `${unsetLines.join('\n')}\n`, 0o600)

  // REQUIRED
  process.stdout.write(`${clearFilePath}\n`)

  // Remove env load file so the next env-clear call correctly reports "no env loaded".
  // `force` so concurrent clears don't throw ENOENT when another already removed it.
  if (hasLoadedEnv) fs.rmSync(envLoadPath, { force: true })

  const structuredContent = {
    filePath: clearFilePath,
    variableCount: varNames.length,
    unsetStatements: unsetLines,
    purged: purge,
  }

  return {
    content: textContent(JSON.stringify(structuredContent, null, 2)),
    structuredContent,
  }
}

// MCP Tool Registration
export const envClearMcpTool = defineMcpTool({
  name: 'env-clear',
  description:
    'Generate a shell script that unsets every env var previously loaded by env-load for this session, plus the infra-kit session metadata vars. Does NOT mutate the calling process. When `infra-kit init` has installed the zsh shell integration, the user\'s terminal auto-sources the unset script on its next prompt (precmd hook) — so calling this via MCP will clear the vars in the shell that launched Claude Code automatically. Other callers must source "<filePath>" themselves or surface it to the user. Errors if no env is currently loaded.',
  inputSchema: {},
  outputSchema: {
    filePath: z.string().describe('Path to the file that must be sourced to apply'),
    variableCount: z.number().describe('Number of variables cleared'),
    unsetStatements: z.array(z.string()).describe('Unset statements generated'),
    purged: z.boolean().describe('Whether the project warm cache was purged outright'),
  },
  handler: () => {
    return envClear()
  },
})
