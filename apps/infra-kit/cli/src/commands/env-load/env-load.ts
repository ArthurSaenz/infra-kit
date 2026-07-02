import select from '@inquirer/select'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { z } from 'zod'
import { $ } from 'zx'

import {
  buildDopplerNotFoundMessage,
  classifyDopplerDownloadError,
  getDopplerProject,
  listDopplerConfigs,
  listDopplerProjects,
  validateDopplerCliAndAuth,
} from 'src/integrations/doppler'
import { commandEcho } from 'src/lib/command-echo'
import {
  ENV_LOAD_FILE,
  INFRA_KIT_ENV_AUTOLOADED_VAR,
  INFRA_KIT_ENV_CLEARED_VAR,
  INFRA_KIT_ENV_CONFIG_VAR,
  INFRA_KIT_ENV_LOADED_AT_VAR,
  INFRA_KIT_ENV_PROJECT_ROOT_VAR,
  INFRA_KIT_ENV_PROJECT_VAR,
  atomicWriteFileSync,
  getSessionCacheDir,
} from 'src/lib/constants'
import { extractStderr } from 'src/lib/errors/operation-error'
import { getProjectRoot } from 'src/lib/git-utils'
import { getInfraKitConfig } from 'src/lib/infra-kit-config'
import { defineMcpTool, textContent } from 'src/types'

interface EnvLoadArgs {
  config?: string
}

interface WriteEnvLoadFileArgs {
  /** Resolved Doppler config / environment name (no interactive picker here). */
  config: string
  /**
   * Marks the produced file as auto-loaded. `true` writes the
   * INFRA_KIT_ENV_AUTOLOADED marker; `false` (a manual load) instead unsets the
   * marker and lifts any clear suppression so a deliberate load wins.
   */
  autoLoaded?: boolean
  /**
   * Auto-load only: re-checked AFTER the Doppler download, immediately before the
   * atomic write. Return false to abort (a clear or a manual load landed during the
   * slow download). Manual loads omit it and always write.
   */
  beforeWrite?: () => boolean
}

export interface EnvLoadFileResult {
  filePath: string
  variableCount: number
  project: string
  config: string
}

interface EnvLoadFileLinesArgs {
  pairs: Array<[string, string]>
  config: string
  project: string
  projectRoot: string
  loadedAt: string
  autoLoaded: boolean
}

/**
 * The auto-load marker lines appended to env-load.sh. Pure so the marker policy
 * is unit-testable without touching Doppler or the filesystem.
 *
 * @example
 * buildAutoLoadMarkerLines(true)  // => ["INFRA_KIT_ENV_AUTOLOADED='1'"]
 * buildAutoLoadMarkerLines(false) // => ['unset INFRA_KIT_ENV_AUTOLOADED', 'unset INFRA_KIT_ENV_CLEARED']
 */
const buildAutoLoadMarkerLines = (autoLoaded: boolean): string[] => {
  if (autoLoaded) {
    return [`${INFRA_KIT_ENV_AUTOLOADED_VAR}=${shellSingleQuote('1')}`]
  }

  // Manual load: drop any auto marker so auto-load never re-clobbers a deliberate
  // choice, and lift a prior clear suppression so the manual load takes effect.
  return [`unset ${INFRA_KIT_ENV_AUTOLOADED_VAR}`, `unset ${INFRA_KIT_ENV_CLEARED_VAR}`]
}

/**
 * Build the dotenv-format shell lines for env-load.sh. Pure (no I/O) so callers
 * can assert the exact marker behavior. `set -a`/`set +a` auto-export every
 * assignment when the file is sourced.
 */
export const buildEnvLoadFileLines = ({
  pairs,
  config,
  project,
  projectRoot,
  loadedAt,
  autoLoaded,
}: EnvLoadFileLinesArgs): string[] => {
  return [
    'set -a',
    ...pairs.map(([key, value]) => {
      return `${key}=${shellSingleQuote(value)}`
    }),
    `${INFRA_KIT_ENV_CONFIG_VAR}=${shellSingleQuote(config)}`,
    `${INFRA_KIT_ENV_PROJECT_VAR}=${shellSingleQuote(project)}`,
    `${INFRA_KIT_ENV_PROJECT_ROOT_VAR}=${shellSingleQuote(projectRoot)}`,
    `${INFRA_KIT_ENV_LOADED_AT_VAR}=${shellSingleQuote(loadedAt)}`,
    ...buildAutoLoadMarkerLines(autoLoaded),
    'set +a',
  ]
}

/**
 * Project root (git top-level) the loaded env belongs to, for the cross-project
 * shell gate. Returns '' when this isn't a git checkout so a non-git infra-kit
 * project still loads — the shell gate then fails open (spawns rather than skips)
 * instead of breaking the whole load on `git rev-parse` throwing.
 */
const resolveProjectRootSafe = async (): Promise<string> => {
  try {
    return await getProjectRoot()
  } catch {
    return ''
  }
}

/**
 * Download Doppler secrets for a resolved config and atomically write env-load.sh
 * to the session cache dir. Does NOT print to stdout — shared by the CLI/MCP
 * `envLoad` entry (which prints the path) and the auto-load path (which lets the
 * shell precmd hook source the file).
 */
export const writeEnvLoadFile = async ({
  config,
  autoLoaded = false,
  beforeWrite,
}: WriteEnvLoadFileArgs): Promise<EnvLoadFileResult | null> => {
  await validateDopplerCliAndAuth()

  const project = await getDopplerProject()
  const projectRoot = await resolveProjectRootSafe()

  const pairs = await downloadDopplerSecrets(project, config)

  const loadedAt = new Date().toISOString()
  const envFileLines = buildEnvLoadFileLines({ pairs, config, project, projectRoot, loadedAt, autoLoaded })

  const cacheDir = getSessionCacheDir()
  const envFilePath = path.resolve(cacheDir, ENV_LOAD_FILE)

  // Re-check suppression immediately before the atomic write: a clear or a manual
  // load may have landed during the slow Doppler download (auto-load path only).
  if (beforeWrite && !beforeWrite()) return null

  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 })
  atomicWriteFileSync(envFilePath, `${envFileLines.join('\n')}\n`, 0o600)

  return {
    filePath: envFilePath,
    variableCount: pairs.length,
    project,
    config,
  }
}

/**
 * Load environment variables from Doppler for the given config
 */
export const envLoad = async (args: EnvLoadArgs) => {
  const { config } = args

  commandEcho.start('env-load')

  let selectedConfig = ''

  if (config) {
    selectedConfig = config
  } else {
    // Validate auth before the interactive picker so an unauthenticated user fails
    // fast instead of choosing an env first. writeEnvLoadFile re-checks (cheap) for
    // the non-interactive path where this branch is skipped.
    await validateDopplerCliAndAuth()

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

  // A manual load is authoritative: autoLoaded=false drops the auto marker.
  const result = await writeEnvLoadFile({ config: selectedConfig, autoLoaded: false })

  // A manual load passes no beforeWrite, so it always writes — this guards the
  // invariant (and narrows the nullable result) rather than handling a real path.
  if (!result) throw new Error('env-load: write was unexpectedly aborted')

  // REQUIRED
  process.stdout.write(`${result.filePath}\n`)

  // Logs to stderr (pino → pretty-print), so it doesn't pollute the captured
  // file path that the shell wrapper reads from stdout.
  commandEcho.print()

  const structuredContent = {
    filePath: result.filePath,
    variableCount: result.variableCount,
    project: result.project,
    config: result.config,
  }

  return {
    content: textContent(JSON.stringify(structuredContent, null, 2)),
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

const downloadDopplerSecrets = async (project: string, config: string): Promise<Array<[string, string]>> => {
  const prevQuiet = $.quiet

  $.quiet = true
  try {
    let result

    try {
      result =
        await $`doppler secrets download --no-file --format json --project ${project} --config ${config}`.timeout(
          DOPPLER_DOWNLOAD_TIMEOUT_MS,
        )
    } catch (error: unknown) {
      throw await translateDopplerDownloadError(error, project, config)
    }

    assertDopplerOutputSize(result.stdout)

    return parseDopplerSecretsJson(result.stdout)
  } finally {
    $.quiet = prevQuiet
  }
}

/**
 * Turn a raw `doppler secrets download` failure into an actionable error. A
 * recognized project/config not-found is enriched (on this error path only) with
 * the list of available names and rethrown as a clean `Error` pointing at the
 * exact infra-kit.json field. Anything else — auth, network, timeout — is
 * rethrown untouched so it degrades to the existing behavior, never worse.
 */
const translateDopplerDownloadError = async (error: unknown, project: string, config: string): Promise<Error> => {
  const stderr = extractStderr(error) ?? (error instanceof Error ? error.message : String(error))
  const kind = classifyDopplerDownloadError(stderr)

  if (kind === 'unknown') {
    return error instanceof Error ? error : new Error(String(error))
  }

  const available = kind === 'project' ? await listDopplerProjects() : await listDopplerConfigs(project)

  return new Error(buildDopplerNotFoundMessage({ kind, project, config, available }))
}

export const assertDopplerOutputSize = (stdout: string): void => {
  const bytes = Buffer.byteLength(stdout, 'utf-8')

  if (bytes > DOPPLER_MAX_OUTPUT_BYTES) {
    throw new Error(
      `doppler returned unexpectedly large output (${bytes} bytes > ${DOPPLER_MAX_OUTPUT_BYTES}) — refusing to write to disk`,
    )
  }
}

export const shellSingleQuote = (value: string): string => {
  const escaped = value.replaceAll("'", "'\\''")

  return `'${escaped}'`
}

/** A valid POSIX env-var name: a letter or underscore, then word characters. */
const ENV_VAR_NAME_PATTERN = /^[A-Z_]\w*$/i

/**
 * Parse the `doppler secrets download --format json` output (a flat
 * `{"KEY":"value"}` map) into ordered `[key, value]` pairs, validating the shape
 * and every name/value. Values are returned RAW — callers must single-quote them
 * before emitting shell (an unquoted `a$(cmd)b` would execute on `source`).
 *
 * @example
 * parseDopplerSecretsJson('{"FOO":"bar","BAZ":"a$(x)"}')
 * // => [['FOO', 'bar'], ['BAZ', 'a$(x)']]
 */
export const parseDopplerSecretsJson = (stdout: string): Array<[string, string]> => {
  let parsed: unknown

  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error(`doppler returned non-JSON output for env-load (got: ${JSON.stringify(stdout.slice(0, 80))})`)
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('doppler returned unexpected JSON shape for env-load (expected an object of KEY: value pairs)')
  }

  const pairs: Array<[string, string]> = []

  for (const [key, value] of Object.entries(parsed)) {
    if (!ENV_VAR_NAME_PATTERN.test(key)) {
      throw new Error(
        `doppler returned an invalid env var name for env-load (got: ${JSON.stringify(key.slice(0, 80))})`,
      )
    }

    if (typeof value !== 'string') {
      throw new TypeError(`doppler returned a non-string value for "${key}" (got ${typeof value})`)
    }

    pairs.push([key, value])
  }

  if (pairs.length === 0) {
    throw new Error('doppler returned empty output for env-load')
  }

  return pairs
}

// MCP Tool Registration
export const envLoadMcpTool = defineMcpTool({
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
})
