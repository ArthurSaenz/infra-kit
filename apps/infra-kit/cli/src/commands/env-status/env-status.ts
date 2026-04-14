import path from 'node:path'
import process from 'node:process'
import { z } from 'zod'

import { validateDopplerCliAndAuth } from 'src/integrations/doppler'
import {
  ENV_LOAD_FILE,
  INFRA_KIT_ENV_CONFIG_VAR,
  INFRA_KIT_ENV_LOADED_AT_VAR,
  INFRA_KIT_ENV_PROJECT_VAR,
  INFRA_KIT_SESSION_VAR,
  getSessionCacheDir,
  parseVarNamesFromEnvFile,
} from 'src/lib/constants'
import { logger } from 'src/lib/logger'
import type { ToolsExecutionResult } from 'src/types'

/**
 * Show Doppler authentication status and detected project info
 */
export const envStatus = async (): Promise<ToolsExecutionResult> => {
  await validateDopplerCliAndAuth()

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

  if (sessionConfig) {
    const varNames = parseVarNamesFromEnvFile(envLoadPath)

    if (varNames.length > 0) {
      sessionTotalCount = varNames.length
      sessionLoadedCount = varNames.filter((v) => {
        return v in process.env
      }).length
    }

    const loadedAtDisplay = sessionLoadedAt?.replace(/\.\d{3}Z$/, '') ?? null

    logger.info(
      `  ${sessionConfig}: ${sessionLoadedCount} of ${sessionTotalCount} vars loaded (project: ${sessionProject}, loadedAt: ${loadedAtDisplay}, session: ${sessionId})\n`,
    )
  } else {
    logger.info(`  Session ${sessionId}: no env loaded\n`)
  }

  const structuredContent = {
    sessionId,
    sessionLoadedCount,
    sessionTotalCount,
    sessionConfig,
    sessionProject,
    sessionLoadedAt,
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
  }
}

// MCP Tool Registration
export const envStatusMcpTool = {
  name: 'env-status',
  description:
    'Report which Doppler project/config is currently loaded in the terminal session, when it was loaded, and how many variables are cached. Read-only — use env-load / env-clear to change the terminal session.',
  inputSchema: {},
  outputSchema: {
    sessionId: z.string().describe('Current terminal session ID'),
    sessionLoadedCount: z.number().describe('Number of cached vars active in the current session'),
    sessionTotalCount: z.number().describe('Total number of cached var names'),
    sessionConfig: z.string().nullable().describe('Doppler config name of the loaded session (environment name)'),
    sessionProject: z.string().nullable().describe('Doppler project name of the loaded session'),
    sessionLoadedAt: z.string().nullable().describe('ISO 8601 timestamp of when the env was loaded'),
  },
  handler: envStatus,
}
