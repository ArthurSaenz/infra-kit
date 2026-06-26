import path from 'node:path'
import process from 'node:process'
import { z } from 'zod'

import {
  ENV_LOAD_FILE,
  INFRA_KIT_ENV_AUTOLOADED_VAR,
  INFRA_KIT_ENV_CLEARED_VAR,
  INFRA_KIT_ENV_CONFIG_VAR,
  INFRA_KIT_ENV_LOADED_AT_VAR,
  INFRA_KIT_ENV_PROJECT_VAR,
  INFRA_KIT_SESSION_VAR,
  getSessionCacheDir,
  parseVarNamesFromEnvFile,
} from 'src/lib/constants'
import { logger } from 'src/lib/logger'
import { defineMcpTool, textContent } from 'src/types'

/**
 * Report which env is currently loaded in the terminal session. Pure local
 * introspection: reads only `process.env` + the cached env-load.sh — it makes NO
 * Doppler call (use `doctor` for auth/CLI checks), so it works offline and never
 * hangs. Surfaces whether the env was auto-loaded vs manually loaded and whether a
 * clear is currently suppressing auto-load.
 */
export const envStatus = async () => {
  logger.info('Environment session status:')

  // Check session-loaded vars — getSessionCacheDir() throws if INFRA_KIT_SESSION is unset
  const cacheDir = getSessionCacheDir()

  const sessionId = process.env[INFRA_KIT_SESSION_VAR]!
  const envLoadPath = path.join(cacheDir, ENV_LOAD_FILE)

  let sessionLoadedCount = 0
  let sessionTotalCount = 0

  const sessionConfig = process.env[INFRA_KIT_ENV_CONFIG_VAR] ?? null
  const sessionProject = process.env[INFRA_KIT_ENV_PROJECT_VAR] ?? null
  const sessionLoadedAt = process.env[INFRA_KIT_ENV_LOADED_AT_VAR] ?? null
  const autoLoaded = process.env[INFRA_KIT_ENV_AUTOLOADED_VAR] === '1'
  const cleared = Boolean(process.env[INFRA_KIT_ENV_CLEARED_VAR])

  if (sessionConfig) {
    const varNames = parseVarNamesFromEnvFile(envLoadPath)

    if (varNames.length > 0) {
      sessionTotalCount = varNames.length
      sessionLoadedCount = varNames.filter((v) => {
        return v in process.env
      }).length
    }

    const loadedAtDisplay = sessionLoadedAt?.replace(/\.\d{3}Z$/, '') ?? null
    const origin = autoLoaded ? 'auto-loaded' : 'manually loaded'

    logger.info(
      `  ${sessionConfig}: ${sessionLoadedCount} of ${sessionTotalCount} vars loaded (${origin}, project: ${sessionProject}, loadedAt: ${loadedAtDisplay}, session: ${sessionId})\n`,
    )

    if (sessionTotalCount > 0 && sessionLoadedCount < sessionTotalCount) {
      const missing = sessionTotalCount - sessionLoadedCount

      logger.warn(
        `  ${missing} cached var(s) are not present in the current process — env-load needs to be re-sourced, or vars were unset manually.`,
      )
    }
  } else {
    const clearedNote = cleared ? ' (cleared — auto-load suppressed until a new shell or explicit env-load)' : ''

    logger.info(`  Session ${sessionId}: no env loaded${clearedNote}\n`)
  }

  const structuredContent = {
    sessionId,
    sessionLoadedCount,
    sessionTotalCount,
    sessionConfig,
    sessionProject,
    sessionLoadedAt,
    autoLoaded,
    cleared,
  }

  return {
    content: textContent(JSON.stringify(structuredContent, null, 2)),
    structuredContent,
  }
}

// MCP Tool Registration
export const envStatusMcpTool = defineMcpTool({
  name: 'env-status',
  description:
    'Report which Doppler project/config is currently loaded in the terminal session, when it was loaded, how many variables are cached, whether it was auto-loaded, and whether a clear is suppressing auto-load. Pure local introspection — makes NO Doppler call (use doctor for auth). Read-only — use env-load / env-clear to change the terminal session.',
  inputSchema: {},
  outputSchema: {
    sessionId: z.string().describe('Current terminal session ID'),
    sessionLoadedCount: z.number().describe('Number of cached vars active in the current session'),
    sessionTotalCount: z.number().describe('Total number of cached var names'),
    sessionConfig: z.string().nullable().describe('Doppler config name of the loaded session (environment name)'),
    sessionProject: z.string().nullable().describe('Doppler project name of the loaded session'),
    sessionLoadedAt: z.string().nullable().describe('ISO 8601 timestamp of when the env was loaded'),
    autoLoaded: z.boolean().describe('True when the loaded env was applied by env auto-load (not a manual env-load)'),
    cleared: z.boolean().describe('True when env-clear is currently suppressing auto-load in this shell'),
  },
  handler: envStatus,
})
