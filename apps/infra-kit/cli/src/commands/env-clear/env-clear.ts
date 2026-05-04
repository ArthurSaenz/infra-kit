import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { z } from 'zod/v4'

import {
  ENV_CLEAR_FILE,
  ENV_LOAD_FILE,
  INFRA_KIT_ENV_CONFIG_VAR,
  INFRA_KIT_ENV_LOADED_AT_VAR,
  INFRA_KIT_ENV_PROJECT_VAR,
  atomicWriteFileSync,
  getSessionCacheDir,
  parseVarNamesFromEnvFile,
} from 'src/lib/constants'
import type { ToolsExecutionResult } from 'src/types'

/**
 * Clear loaded env vars. Prints a file path to stdout that must be sourced to apply.
 * The env-clear shell alias does this automatically. Throws when no env is loaded
 * so CLI callers exit non-zero and MCP callers receive a structured tool error.
 */
export const envClear = async (): Promise<ToolsExecutionResult> => {
  const cacheDir = getSessionCacheDir()
  const envLoadPath = path.join(cacheDir, ENV_LOAD_FILE)

  if (!fs.existsSync(envLoadPath)) {
    throw new Error('No loaded environment found. Run `env-load` first.')
  }

  const varNames = parseVarNamesFromEnvFile(envLoadPath)

  const unsetLines = [
    ...varNames.map((v) => {
      return `unset ${v}`
    }),
    `unset ${INFRA_KIT_ENV_CONFIG_VAR}`,
    `unset ${INFRA_KIT_ENV_PROJECT_VAR}`,
    `unset ${INFRA_KIT_ENV_LOADED_AT_VAR}`,
  ]

  const clearFilePath = path.resolve(cacheDir, ENV_CLEAR_FILE)

  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 })

  atomicWriteFileSync(clearFilePath, `${unsetLines.join('\n')}\n`, 0o600)

  // REQUIRED
  process.stdout.write(`${clearFilePath}\n`)

  // Remove env load file so the next env-clear call correctly reports "no env loaded".
  fs.unlinkSync(envLoadPath)

  const structuredContent = {
    filePath: clearFilePath,
    variableCount: varNames.length,
    unsetStatements: unsetLines,
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
export const envClearMcpTool = {
  name: 'env-clear',
  description:
    'Generate a shell script that unsets every env var previously loaded by env-load for this session, plus the infra-kit session metadata vars. Does NOT mutate the calling process. When `infra-kit init` has installed the zsh shell integration, the user\'s terminal auto-sources the unset script on its next prompt (precmd hook) — so calling this via MCP will clear the vars in the shell that launched Claude Code automatically. Other callers must source "<filePath>" themselves or surface it to the user. Errors if no env is currently loaded.',
  inputSchema: {},
  outputSchema: {
    filePath: z.string().describe('Path to the file that must be sourced to apply'),
    variableCount: z.number().describe('Number of variables cleared'),
    unsetStatements: z.array(z.string()).describe('Unset statements generated'),
  },
  handler: envClear,
}
