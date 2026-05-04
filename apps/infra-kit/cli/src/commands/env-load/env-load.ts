import select from '@inquirer/select'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { z } from 'zod/v4'
import { $ } from 'zx'

import { validateDopplerCliAndAuth } from 'src/integrations/doppler'
import { getDopplerProject } from 'src/integrations/doppler/doppler-project'
import { commandEcho } from 'src/lib/command-echo'
import {
  ENV_LOAD_FILE,
  ENV_VAR_LINE_PATTERN,
  INFRA_KIT_ENV_CONFIG_VAR,
  INFRA_KIT_ENV_LOADED_AT_VAR,
  INFRA_KIT_ENV_PROJECT_VAR,
  atomicWriteFileSync,
  getSessionCacheDir,
} from 'src/lib/constants'
import { getInfraKitConfig } from 'src/lib/infra-kit-config'
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
    const { environments } = await getInfraKitConfig()

    commandEcho.setInteractive()
    selectedConfig = await select(
      {
        message: 'Select environment config',
        choices: environments.map((env) => {
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

  const envContent = await downloadDopplerSecrets(project, selectedConfig)

  assertValidEnvContent(envContent)

  // Build env file content in dotenv format
  const loadedAt = new Date().toISOString()
  const envFileLines = [
    'set -a',
    envContent,
    `${INFRA_KIT_ENV_CONFIG_VAR}=${shellSingleQuote(selectedConfig)}`,
    `${INFRA_KIT_ENV_PROJECT_VAR}=${shellSingleQuote(project)}`,
    `${INFRA_KIT_ENV_LOADED_AT_VAR}=${shellSingleQuote(loadedAt)}`,
    'set +a',
  ]

  const cacheDir = getSessionCacheDir()
  const envFilePath = path.resolve(cacheDir, ENV_LOAD_FILE)

  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 })
  atomicWriteFileSync(envFilePath, `${envFileLines.join('\n')}\n`, 0o600)

  // REQUIRED
  process.stdout.write(`${envFilePath}\n`)

  // Logs to stderr (pino → pretty-print), so it doesn't pollute the captured
  // file path that the shell wrapper reads from stdout.
  commandEcho.print()

  const varCount = countEnvVarLines(envContent)

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

/**
 * Cap the Doppler stdout we're willing to accept. A well-formed env bundle is
 * O(10 KB); megabytes would indicate a service regression or the wrong stream
 * being captured, and we don't want to write that to disk or source it.
 */
export const DOPPLER_MAX_OUTPUT_BYTES = 1024 * 1024

/**
 * Hard upper bound for the Doppler subprocess. Well under zx's default so a
 * hung call surfaces quickly instead of blocking an interactive shell or an
 * MCP tool handler.
 */
const DOPPLER_DOWNLOAD_TIMEOUT_MS = 30_000

const downloadDopplerSecrets = async (project: string, config: string): Promise<string> => {
  const prevQuiet = $.quiet

  $.quiet = true
  try {
    const result =
      await $`doppler secrets download --no-file --format env --project ${project} --config ${config}`.timeout(
        DOPPLER_DOWNLOAD_TIMEOUT_MS,
      )

    assertDopplerOutputSize(result.stdout)

    return result.stdout.trim()
  } finally {
    $.quiet = prevQuiet
  }
}

export const assertDopplerOutputSize = (stdout: string): void => {
  const bytes = Buffer.byteLength(stdout, 'utf-8')

  if (bytes > DOPPLER_MAX_OUTPUT_BYTES) {
    throw new Error(
      `doppler returned unexpectedly large output (${bytes} bytes > ${DOPPLER_MAX_OUTPUT_BYTES}) — refusing to write to disk`,
    )
  }
}

const countEnvVarLines = (content: string): number => {
  return content.split('\n').filter((line) => {
    return ENV_VAR_LINE_PATTERN.test(line)
  }).length
}

const SHELL_DIRECTIVE_LINES = new Set(['set -a', 'set +a'])

export const shellSingleQuote = (value: string): string => {
  const escaped = value.replaceAll("'", "'\\''")

  return `'${escaped}'`
}

/**
 * Guard against Doppler returning non-env output (auth warnings on stdout,
 * partial downloads, HTML error pages, etc.). Every non-blank, non-directive
 * line must match KEY=VALUE — skipping directives keeps future format tweaks
 * cheap without loosening the check.
 */
export const assertValidEnvContent = (content: string): void => {
  if (content.trim().length === 0) {
    throw new Error('doppler returned empty output for env-load')
  }

  for (const line of content.split('\n')) {
    const trimmed = line.trim()

    if (trimmed.length === 0 || SHELL_DIRECTIVE_LINES.has(trimmed)) continue

    if (!ENV_VAR_LINE_PATTERN.test(trimmed)) {
      throw new Error(
        `doppler returned unexpected output for env-load (expected KEY=value lines, got: ${JSON.stringify(trimmed.slice(0, 80))})`,
      )
    }
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
