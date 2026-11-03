import select from '@inquirer/select'
import { readRepoIdentity } from '@slip-stream-kit/config/internal'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { z } from 'zod'

import { createEnvLoadFormProvider } from 'src/commands/env-load/env-load-form'
import { INFRA_KIT_ENV_TOKEN_VAR, downloadDopplerSecrets, getDopplerProject } from 'src/integrations/doppler'
import { agentMode, isAgentMode, isHeadless } from 'src/lib/agent-mode'
import { commandEcho } from 'src/lib/command-echo'
import {
  ENV_LOAD_FILE,
  ENV_LOAD_ROOT_FILE,
  INFRA_KIT_ENV_CONFIG_VAR,
  INFRA_KIT_ENV_LOADED_AT_VAR,
  INFRA_KIT_ENV_PROJECT_ROOT_VAR,
  INFRA_KIT_ENV_PROJECT_VAR,
  INFRA_KIT_ENV_VAR,
  INFRA_KIT_SESSION_VAR,
  WORKTREES_DIR_SUFFIX,
  atomicWriteFileSync,
  getSessionCacheDir,
} from 'src/lib/constants'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { getProjectRoot } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
import { listProjectEnvNames, readDefaultEnv } from 'src/lib/project-envs'
import { withEscape } from 'src/lib/prompts/escapable-context'
import { refuseMissingArguments } from 'src/lib/prompts/refuse-missing-arguments'
import { defineMcpTool, textContent } from 'src/types'

interface EnvLoadArgs {
  config?: string
}

interface WriteEnvLoadFileArgs {
  /** Resolved Doppler config / environment name (no interactive picker here). */
  config: string
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
}

/**
 * Secret names that must NEVER be written into the sourced file. A Doppler project can hold a secret
 * called `DOPPLER_TOKEN` (or `INFRA_KIT_ENV_TOKEN`), and `env-load.sh` is sourced into EVERY shell —
 * exporting one would hand a live credential to every child process forever, and (per SPIKE-0 Q5) an
 * exported `DOPPLER_TOKEN` would then hijack the next download's auth.
 *
 * `DOPPLER_CONFIG` / `DOPPLER_PROJECT` are deliberately NOT filtered: they are not credentials, they
 * are the scope evidence {@link assertTokenScope} and `doctor` read back.
 */
const CREDENTIAL_SECRET_KEYS = new Set<string>(['DOPPLER_TOKEN', INFRA_KIT_ENV_TOKEN_VAR])

/** Warn at most once per process: a project carrying a token secret would otherwise warn on every load. */
let credentialFilterWarned = false

/**
 * Tell the user we dropped a credential-bearing secret from their shell env — silently swallowing a
 * key they can see in the Doppler dashboard would read as a bug. Names the KEY only, never the value.
 */
const warnFilteredCredentialKeys = (keys: string[]): void => {
  if (keys.length === 0 || credentialFilterWarned) return

  credentialFilterWarned = true

  logger.warn(
    `infra-kit: not exporting ${keys.join(', ')} from Doppler into your shell — ` +
      'a service token must not be sourced into every process.',
  )
}

/**
 * Build the dotenv-format shell lines for env-load.sh. Pure apart from the one-shot credential
 * warning, so callers can assert the exact file contents. `set -a`/`set +a` auto-export every
 * assignment when the file is sourced.
 */
export const buildEnvLoadFileLines = ({
  pairs,
  config,
  project,
  projectRoot,
  loadedAt,
}: EnvLoadFileLinesArgs): string[] => {
  const emitted = pairs.filter(([key]) => {
    return !CREDENTIAL_SECRET_KEYS.has(key)
  })

  warnFilteredCredentialKeys(
    pairs
      .filter(([key]) => {
        return CREDENTIAL_SECRET_KEYS.has(key)
      })
      .map(([key]) => {
        return key
      }),
  )

  return [
    'set -a',
    ...emitted.map(([key, value]) => {
      return `${key}=${shellSingleQuote(value)}`
    }),
    // Purpose-named env-name handle for non-shell tooling (e.g. infra-kit/vite's
    // `<env>` proxy interpolation). Single-quoted like every sourced value.
    `${INFRA_KIT_ENV_VAR}=${shellSingleQuote(config)}`,
    `${INFRA_KIT_ENV_CONFIG_VAR}=${shellSingleQuote(config)}`,
    `${INFRA_KIT_ENV_PROJECT_VAR}=${shellSingleQuote(project)}`,
    `${INFRA_KIT_ENV_PROJECT_ROOT_VAR}=${shellSingleQuote(projectRoot)}`,
    `${INFRA_KIT_ENV_LOADED_AT_VAR}=${shellSingleQuote(loadedAt)}`,
    'set +a',
  ]
}

/**
 * Project root (git top-level) the loaded env belongs to. Returns '' when this isn't
 * a git checkout so a non-git infra-kit project still loads instead of the whole
 * load breaking on `git rev-parse` throwing.
 */
const resolveProjectRootSafe = async (): Promise<string> => {
  try {
    return await getProjectRoot()
  } catch {
    return ''
  }
}

/**
 * The directories the loaded env applies in ({@link ENV_LOAD_ROOT_FILE}): the repo's own directory (the
 * same `readRepoIdentity` that names the dev alias's `<repo>`) and its `-worktrees` container, so every
 * worktree of the repo shares one load, plus the loading worktree itself in case it lives elsewhere.
 * Outside git, just `cwd`.
 */
export const resolveEnvLoadRoots = (projectRoot: string, cwd = process.cwd()): string[] => {
  if (projectRoot === '') return [path.resolve(cwd)]

  const repoRoot = readRepoIdentity(projectRoot).root ?? projectRoot

  return [...new Set([repoRoot, `${repoRoot}${WORKTREES_DIR_SUFFIX}`, projectRoot])]
}

/**
 * Download Doppler secrets for a resolved config and atomically write env-load.sh
 * to the session cache dir. Does NOT print to stdout — the path line belongs to the
 * CLI action in `entry/program`.
 */
export const writeEnvLoadFile = async ({ config }: WriteEnvLoadFileArgs): Promise<EnvLoadFileResult> => {
  const project = await getDopplerProject()
  const projectRoot = await resolveProjectRootSafe()

  const pairs = await downloadDopplerSecrets(project, config)

  const loadedAt = new Date().toISOString()
  const envFileLines = buildEnvLoadFileLines({ pairs, config, project, projectRoot, loadedAt })
  const fileContents = `${envFileLines.join('\n')}\n`

  const cacheDir = getSessionCacheDir()
  const envFilePath = path.resolve(cacheDir, ENV_LOAD_FILE)

  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 })
  // The scope lands first: a shell reading between the two writes then never sees the new env unscoped.
  const roots = resolveEnvLoadRoots(projectRoot)

  atomicWriteFileSync(path.resolve(cacheDir, ENV_LOAD_ROOT_FILE), `${roots.join('\n')}\n`, 0o600)
  atomicWriteFileSync(envFilePath, fileContents, 0o600)

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
// ONE provider instance for the tool definition (`envLoadMcpTool.formProvider`) and the agent-mode
// refusal below, so the rows an agent is handed as `choices` are the form the schema describes.
const envLoadForm = createEnvLoadFormProvider()

export const envLoad = async (args: EnvLoadArgs) => {
  const { config } = args
  const defaultEnv = config ? null : await readDefaultEnv()

  // A configured `defaultEnv` IS the choice an agent would otherwise be refused for: the human made it
  // ahead of time, in their own config. A terminal still gets the picker, opened on that default.
  if (!config && defaultEnv && isHeadless()) {
    return loadSelectedConfig(defaultEnv, 'default')
  }

  // Before the picker: an agent / `--json` run without `config` gets the form's env list as `choices`.
  await refuseMissingArguments({ provider: envLoadForm, params: args, operation: 'env-load', argument: 'config' })

  if (config) {
    return loadSelectedConfig(config, 'argument')
  }

  // No auth pre-probe before the picker: under token-only auth there is no account
  // to validate, and the per-env token is only knowable AFTER a config is chosen.
  // A missing/rejected token surfaces from the download with an actionable message.
  //
  // The choices are every env this project has — workflow-declared and token-only alike (see
  // `lib/project-envs`). Deliberately NOT filtered to the envs we hold a token for: an env you cannot
  // yet load is exactly the one you need to SEE, so that picking it tells you to run
  // `infra-kit env-token-set <env>` rather than leaving you to wonder where it went.
  //
  // An agent that omits `config` is refused with `choices` by `refuseMissingArguments` above; landing
  // here headless means the provider judged the arguments unformable, and the refusal has to name the
  // source.
  if (isAgentMode()) {
    throw new StructuredRefusalError(
      { status: 'argument_required', argument: 'config', agentMode: agentMode.source },
      2,
      {
        operation: 'env-load',
        remediation: 'call env-list, ask the human which environment, and re-call env-load with "config"',
      },
    )
  }

  const envs = await listProjectEnvNames()

  commandEcho.setInteractive()
  const selectedConfig = await withEscape(
    (context) => {
      return select(
        {
          message: 'Select environment config',
          choices: buildPickerChoices(envs, defaultEnv),
          ...(defaultEnv ? { default: defaultEnv } : {}),
        },
        context,
      )
    },
    // Render to stderr so the prompt is visible when stdout is captured via $() in the shell function.
    // Only env-load and env-clear use the $() stdout-capture shell pattern.
    { output: process.stderr, whenHeadless: 'refuse' },
  )

  return loadSelectedConfig(selectedConfig, 'picker')
}

/** How `env-load` arrived at its config: `-c`, the configured `defaultEnv`, or the terminal picker. */
type ConfigSource = 'argument' | 'default' | 'picker'

/**
 * The picker rows, with the configured default marked — and prepended when the env list does not know
 * it, because that list is local and may be incomplete, and a default the picker cannot show would
 * leave the cursor nowhere.
 *
 * @example
 * buildPickerChoices(['dev', 'stage'], 'roman')
 * // => [{ name: 'roman (default)', value: 'roman' }, { name: 'dev', value: 'dev' }, { name: 'stage', value: 'stage' }]
 */
export const buildPickerChoices = (
  envs: string[],
  defaultEnv: string | null,
): Array<{ name: string; value: string }> => {
  const names = defaultEnv && !envs.includes(defaultEnv) ? [defaultEnv, ...envs] : envs

  return names.map((env) => {
    return { name: env === defaultEnv ? `${env} (default)` : env, value: env }
  })
}

const loadSelectedConfig = async (selectedConfig: string, configSource: ConfigSource) => {
  commandEcho.addOption('--config', selectedConfig)

  const result = await writeEnvLoadFile({ config: selectedConfig })

  // The path the zsh wrapper captures is printed by the CLI action in `entry/program`, not here: the
  // handler's stdout stays empty so a `--json` caller gets exactly one document; `emitSourcePath` in
  // `entry/program` owns the path line and its ordering. Logs go to stderr for the same reason.
  commandEcho.print()

  const structuredContent = {
    filePath: result.filePath,
    variableCount: result.variableCount,
    project: result.project,
    config: result.config,
    configSource,
    // The terminal session the file was written FOR. A Bash-driven agent inherits the session id but
    // never sees the shell that sources the file; naming it here is how it can tell which terminal
    // just got the variables (and notice when there was none).
    sessionId: process.env[INFRA_KIT_SESSION_VAR] ?? null,
  }

  return {
    content: textContent(JSON.stringify(structuredContent, null, 2)),
    structuredContent,
  }
}

export const shellSingleQuote = (value: string): string => {
  const escaped = value.replaceAll("'", "'\\''")

  return `'${escaped}'`
}

// MCP Tool Registration
export const envLoadMcpTool = defineMcpTool({
  name: 'env-load',
  description:
    'Download the env vars for a Doppler config and write them to a temporary shell script. Does NOT mutate the calling process — returns the path to a script that must be sourced ("source <filePath>") for the vars to take effect. The infra-kit shell wrapper auto-sources; direct MCP callers must handle sourcing themselves or surface filePath to the user. This server picks the file up on its next tool call, so a tool that needs the variables can be called right after. Omit "config" and this server offers the human a form listing every environment env-list knows, token-less ones marked; a client that cannot render one gets a refusal naming the missing field — call env-list and ask the human, never guess. When the project config sets "defaultEnv", omitting "config" headless loads that environment instead of refusing, and "configSource" reports "default".',
  inputSchema: {
    config: z
      .string()
      .optional()
      .describe(
        'Doppler config / environment name to load (e.g. "dev", "arthur"). Omit it to load the configured "defaultEnv", or, with none set, to have the human choose from a form.',
      ),
  },
  formProvider: envLoadForm,
  outputSchema: {
    filePath: z.string().describe('Path to the file that must be sourced to apply variables'),
    variableCount: z.number().describe('Number of variables loaded'),
    project: z.string().describe('Doppler project name'),
    config: z.string().describe('Doppler config name'),
    configSource: z
      .enum(['argument', 'default', 'picker'])
      .describe('How the config was chosen: passed as "config", the configured "defaultEnv", or the terminal picker'),
    sessionId: z
      .string()
      .nullable()
      .describe('The INFRA_KIT_SESSION the file was written for; null when the process had no session'),
  },
  handler: envLoad,
})
