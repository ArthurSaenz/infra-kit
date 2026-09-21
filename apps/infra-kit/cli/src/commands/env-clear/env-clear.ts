import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

import {
  ENV_CLEAR_FILE,
  ENV_LOAD_FILE,
  INFRA_KIT_ENV_CONFIG_VAR,
  INFRA_KIT_ENV_LOADED_AT_VAR,
  INFRA_KIT_ENV_PROJECT_ROOT_VAR,
  INFRA_KIT_ENV_PROJECT_VAR,
  INFRA_KIT_ENV_VAR,
  atomicWriteFileSync,
  getSessionCacheDir,
  parseVarNamesFromEnvFile,
} from 'src/lib/constants'
import { defineMcpTool, textContent } from 'src/types'

/**
 * Build the lines for env-clear.sh: `unset` every loaded var plus the session
 * metadata (config/project/loadedAt). Pure for testability.
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
  ]
}

/**
 * Clear loaded env vars. Returns the path of a file that must be sourced to apply; the CLI action
 * prints it and the env-clear shell alias sources it (see `lib/program`). Throws when no env is
 * loaded — a clear needs something to clear.
 */
export const envClear = async () => {
  const cacheDir = getSessionCacheDir()
  const envLoadPath = path.join(cacheDir, ENV_LOAD_FILE)

  if (!fs.existsSync(envLoadPath)) {
    throw new Error('No loaded environment found. Run `env-load` first.')
  }

  const varNames = parseVarNamesFromEnvFile(envLoadPath)

  const unsetLines = buildEnvClearLines(varNames)

  const clearFilePath = path.resolve(cacheDir, ENV_CLEAR_FILE)

  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 })

  atomicWriteFileSync(clearFilePath, `${unsetLines.join('\n')}\n`, 0o600)

  // Remove env load file so the next env-clear call correctly reports "no env loaded".
  // `force` so concurrent clears don't throw ENOENT when another already removed it.
  fs.rmSync(envLoadPath, { force: true })

  const structuredContent = {
    filePath: clearFilePath,
    variableCount: varNames.length,
    unsetStatements: unsetLines,
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
    'Generate a shell script that unsets every env var previously loaded by env-load for this session, plus the infra-kit session metadata vars. Does NOT mutate the calling process — returns the path to a script that must be sourced ("source <filePath>") for the vars to go away. The infra-kit shell wrapper auto-sources; direct callers must handle sourcing themselves or surface filePath to the user. Errors if no env is currently loaded.',
  requiresHumanConfirm: true,
  inputSchema: {
    confirm: z
      .boolean()
      .optional()
      .describe('Set true to execute; omit for a dry-run gate that echoes the resolved action.'),
  },
  outputSchema: {
    filePath: z.string().describe('Path to the file that must be sourced to apply'),
    variableCount: z.number().describe('Number of variables cleared'),
    unsetStatements: z.array(z.string()).describe('Unset statements generated'),
  },
  handler: () => {
    return envClear()
  },
})
