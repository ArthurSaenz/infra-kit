import select from '@inquirer/select'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { z } from 'zod'
import { $ } from 'zx'

import { validateDopplerCliAndAuth } from 'src/integrations/doppler'
import { getDopplerProject } from 'src/integrations/doppler/doppler-project'
import { commandEcho } from 'src/lib/command-echo'
import {
  ENV_LOAD_FILE,
  ENVs,
  INFRA_KIT_ENV_CONFIG_VAR,
  INFRA_KIT_ENV_LOADED_AT_VAR,
  INFRA_KIT_ENV_PROJECT_VAR,
  getSessionCacheDir,
} from 'src/lib/constants'
import type { ToolsExecutionResult } from 'src/types'

interface EnvLoadArgs {
  config?: string
}

/**
 * Load environment variables from Doppler for the given config
 */
export const envLoad = async (args: EnvLoadArgs): Promise<ToolsExecutionResult> => {
  await validateDopplerCliAndAuth()

  const { config } = args

  commandEcho.start('env-load')

  let selectedConfig = ''

  if (config) {
    selectedConfig = config
  } else {
    commandEcho.setInteractive()
    selectedConfig = await select(
      {
        message: 'Select environment config',
        choices: ENVs.map((env) => {
          return { name: env, value: env }
        }),
      },
      // Render to stderr so the prompt is visible when stdout is captured via $() in the shell function.
      // Only env-load and env-clear use the $() stdout-capture shell pattern.
      { output: process.stderr },
    )
  }

  commandEcho.addOption('--config', selectedConfig)

  const project = await getDopplerProject()

  $.quiet = true
  const result =
    await $`doppler secrets download --no-file --format env --project ${project} --config ${selectedConfig}`

  $.quiet = false
  const envContent = result.stdout.trim()

  // Build env file content in dotenv format
  const loadedAt = new Date().toISOString()
  const envFileLines = [
    'set -a',
    envContent,
    `${INFRA_KIT_ENV_CONFIG_VAR}=${selectedConfig}`,
    `${INFRA_KIT_ENV_PROJECT_VAR}=${project}`,
    `${INFRA_KIT_ENV_LOADED_AT_VAR}=${loadedAt}`,
    'set +a',
  ]

  // Write env file to cache
  const cacheDir = getSessionCacheDir()
  const envFilePath = path.resolve(cacheDir, ENV_LOAD_FILE)

  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(envFilePath, `${envFileLines.join('\n')}\n`)

  // REQUIRED
  process.stdout.write(`${envFilePath}\n`)

  const varCount = envContent.split('\n').filter((line) => {
    return line.includes('=')
  }).length

  const structuredContent = {
    filePath: envFilePath,
    variableCount: varCount,
    project,
    config: selectedConfig,
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
export const envLoadMcpTool = {
  name: 'env-load',
  description:
    'Download the env vars for a Doppler config and write them to a temporary shell script. Does NOT mutate the calling process — returns the path to a script that must be sourced ("source <filePath>") for the vars to take effect. The infra-kit shell wrapper auto-sources; direct MCP callers must handle sourcing themselves or surface filePath to the user. "config" is required when invoked via MCP (the CLI interactive picker is unreachable without a TTY).',
  inputSchema: {
    config: z
      .string()
      .describe('Doppler config / environment name to load (e.g. "dev", "arthur", "renana"). Required for MCP calls.'),
  },
  outputSchema: {
    filePath: z.string().describe('Path to the file that must be sourced to apply variables'),
    variableCount: z.number().describe('Number of variables loaded'),
    project: z.string().describe('Doppler project name'),
    config: z.string().describe('Doppler config name'),
  },
  handler: envLoad,
}
