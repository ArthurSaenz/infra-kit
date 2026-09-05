import select from '@inquirer/select'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { z } from 'zod'
import { $ } from 'zx'

import {
  DopplerAuthError,
  INFRA_KIT_ENV_TOKEN_VAR,
  buildDopplerNotFoundMessage,
  classifyDopplerAuthFailure,
  classifyDopplerFailure,
  getDopplerProject,
  resolveEnvToken,
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
  INFRA_KIT_ENV_VAR,
  atomicWriteFileSync,
  getSessionCacheDir,
} from 'src/lib/constants'
import { extractStderr } from 'src/lib/errors/operation-error'
import { getProjectRoot } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
import { listProjectEnvNames } from 'src/lib/project-envs'
import { withEscape } from 'src/lib/prompts/escapable-context'
import { canonicalizeProjectRoot, evictStaleWarmCaches, shouldWriteWarm, writeWarmCache } from 'src/lib/warm-cache'
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
  /**
   * Canonical (realpath'd) project dir the SHELL passed via `--project-dir` on the
   * shell-startup auto-load spawn. Its presence (with `autoLoaded`) is what enables
   * the project-scoped WARM cache write; see {@link shouldWriteWarm}. Undefined for
   * manual loads and the cli-invocation trigger — those write no warm copy.
   */
  projectDir?: string
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

/** The payload key that carries the token's scope — the one {@link assertTokenScope} compares. */
const DOPPLER_CONFIG_KEY = 'DOPPLER_CONFIG'

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
 * warning, so callers can assert the exact marker behavior. `set -a`/`set +a` auto-export every
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
  projectDir,
}: WriteEnvLoadFileArgs): Promise<EnvLoadFileResult | null> => {
  const project = await getDopplerProject()
  const projectRoot = await resolveProjectRootSafe()

  const pairs = await downloadDopplerSecrets(project, config)

  const loadedAt = new Date().toISOString()
  const envFileLines = buildEnvLoadFileLines({ pairs, config, project, projectRoot, loadedAt, autoLoaded })
  const fileContents = `${envFileLines.join('\n')}\n`

  const cacheDir = getSessionCacheDir()
  const envFilePath = path.resolve(cacheDir, ENV_LOAD_FILE)

  // Re-check suppression immediately before the atomic write: a clear or a manual
  // load may have landed during the slow Doppler download (auto-load path only).
  if (beforeWrite && !beforeWrite()) return null

  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 })
  atomicWriteFileSync(envFilePath, fileContents, 0o600)

  // Project-scoped WARM copy: lets the NEXT shell source these vars instantly at
  // startup (pure zsh, no Doppler) before this session's fresh file lands. Gated so
  // it only fires for a shell-startup auto-load whose realpath'd git root matches the
  // dir the shell keyed on (see shouldWriteWarm). Each warm write also sweeps stale
  // warm dirs — we own the only cache reaper in the codebase.
  const canonicalProjectRoot = canonicalizeProjectRoot(projectRoot)

  if (shouldWriteWarm({ autoLoaded, projectDir, canonicalProjectRoot })) {
    writeWarmCache(projectDir!, fileContents)
    evictStaleWarmCaches()
  }

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

  let selectedConfig = ''

  if (config) {
    selectedConfig = config
  } else {
    // No auth pre-probe before the picker: under token-only auth there is no account
    // to validate, and the per-env token is only knowable AFTER a config is chosen.
    // A missing/rejected token surfaces from the download with an actionable message.
    //
    // The choices are every env this project has — workflow-declared and token-only alike (see
    // `lib/project-envs`). Deliberately NOT filtered to the envs we hold a token for: an env you cannot
    // yet load is exactly the one you need to SEE, so that picking it tells you to run
    // `infra-kit env-token-set <env>` rather than leaving you to wonder where it went.
    const envs = await listProjectEnvNames()

    commandEcho.setInteractive()
    selectedConfig = await withEscape(
      (context) => {
        return select(
          {
            message: 'Select environment config',
            choices: envs.map((env) => {
              return { name: env, value: env }
            }),
          },
          context,
        )
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

/**
 * Doppler env vars we refuse to inherit into the download child. SPIKE-0 Q5: an inherited
 * `DOPPLER_TOKEN` OVERRIDES everything else the CLI would use — and `env-load` itself exports a whole
 * Doppler project into the shell, so a project that happens to hold a secret named `DOPPLER_TOKEN`
 * would silently hijack the NEXT download. `DOPPLER_PROJECT` / `DOPPLER_CONFIG` are scrubbed for the
 * same reason: they are the payload's own scope evidence, and an inherited copy could shadow the
 * `--project` / `--config` we pass in argv.
 */
const INHERITED_DOPPLER_VARS = ['DOPPLER_TOKEN', 'DOPPLER_PROJECT', 'DOPPLER_CONFIG'] as const

/**
 * The child environment for `doppler secrets download`: the caller's env with the inherited Doppler
 * vars scrubbed and OUR resolved token set explicitly.
 *
 * The token travels by ENV, never by argv: `ps` shows argv to every user on the box, and
 * `commandEcho` prints option values back to the terminal. Pure (takes the base env) so the scrub is
 * unit-testable without touching `process.env`.
 *
 * @example
 * buildDopplerChildEnv('dp.st.x', { PATH: '/bin', DOPPLER_CONFIG: 'prod' })
 * // => { PATH: '/bin', DOPPLER_TOKEN: 'dp.st.x' }   (DOPPLER_CONFIG dropped)
 */
export const buildDopplerChildEnv = (token: string, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const childEnv: NodeJS.ProcessEnv = { ...baseEnv }

  for (const name of INHERITED_DOPPLER_VARS) {
    delete childEnv[name]
  }

  childEnv.DOPPLER_TOKEN = token

  return childEnv
}

const downloadDopplerSecrets = async (project: string, config: string): Promise<Array<[string, string]>> => {
  const { token } = await resolveEnvToken(config)

  const childEnv = buildDopplerChildEnv(token)

  const prevQuiet = $.quiet

  $.quiet = true
  try {
    let result

    try {
      result = await $({
        env: childEnv,
      })`doppler secrets download --no-file --format json --project ${project} --config ${config}`.timeout(
        DOPPLER_DOWNLOAD_TIMEOUT_MS,
      )
    } catch (error: unknown) {
      throw translateDopplerDownloadError(error, project, config)
    }

    assertDopplerOutputSize(result.stdout)

    const pairs = parseDopplerSecretsJson(result.stdout)

    assertTokenScope(pairs, config)

    return pairs
  } finally {
    $.quiet = prevQuiet
  }
}

/**
 * Defense in depth against a MIS-SCOPED token: the payload always carries `DOPPLER_CONFIG` as an
 * ordinary secret, and it echoes the `--config` we asked for (SPIKE-0 Q2 — it is the CONFIG, not
 * `DOPPLER_ENVIRONMENT`, which can differ: config `dev_personal` lives in environment `dev`).
 *
 * ABSENT ⇒ PROCEED, deliberately. The Doppler CLI already refuses a real mismatch on the wire
 * (SPIKE-0 Q1: exit 1, "does not have access to requested config"), so it — not this — is the
 * load-bearing guard. An absent `DOPPLER_CONFIG` therefore means Doppler changed what it injects,
 * and failing closed here would blank every developer's shell at once on the SILENT autoload path.
 *
 * @example
 * assertTokenScope([['DOPPLER_CONFIG', 'dev']], 'dev')   // ok
 * assertTokenScope([['FOO', 'bar']], 'dev')              // ok (absent ⇒ proceed)
 * assertTokenScope([['DOPPLER_CONFIG', 'prod']], 'dev')  // throws: token is scoped to "prod"
 */
export const assertTokenScope = (pairs: Array<[string, string]>, config: string): void => {
  const actual = pairs.find(([key]) => {
    return key === DOPPLER_CONFIG_KEY
  })?.[1]

  if (actual === undefined || actual === config) return

  // A DopplerAuthError, not a plain Error: this IS an auth failure, and only the auth CLASS reaches the
  // sticky marker that a shell-startup user ever sees. A plain Error here would be classified transient,
  // expire in 30s, and leave them silently loading another environment's secrets — the exact failure this
  // assert exists to catch. The message stays richer than the generic one: we know the token's real config.
  throw new DopplerAuthError(
    config,
    null,
    `Doppler returned secrets for config "${actual}" but "${config}" was requested — the service token for ` +
      `env "${config}" is scoped to the wrong config. Refusing to load another environment's secrets.\n` +
      `Fix: run \`infra-kit env-token-set ${config}\` with a token scoped to "${config}".`,
  )
}

/**
 * Turn a raw `doppler secrets download` failure into an actionable error. An AUTH-class failure (the
 * token is invalid, revoked, or mis-scoped) becomes a {@link DopplerAuthError} carrying the
 * env-token-set message; a recognized project/config not-found points at the exact infra-kit.json
 * field. Anything else — network, timeout — is rethrown untouched so it degrades to the existing
 * behavior, never worse.
 *
 * This is THE boundary where Doppler's raw stderr is read: the markers exist only here, and the
 * classification leaves as a TYPE (`DopplerAuthError`), never as prose for a downstream module to
 * re-parse. Exported so a seam test can drive the REAL error a caller sees.
 *
 * @example
 * translateDopplerDownloadError({ stderr: 'Doppler Error: Invalid Auth token' }, 'p', 'dev')
 * // => DopplerAuthError { authKind: 'revoked', message: '… `infra-kit env-token-set <env>` …' }
 * translateDopplerDownloadError(new Error('connect ETIMEDOUT'), 'p', 'dev')
 * // => the same Error, untouched
 */
// Why a type and not prose: `lib/env-autoload` used to text-match the raw Doppler markers on the
// error this function had already rewritten — they were long gone, so the sticky auth marker was
// never written and a revoked token went silent.
//
// The not-found message no longer lists the AVAILABLE names: `listDopplerProjects` /
// `listDopplerConfigs` require an ACCOUNT login, which token-only auth deleted, so that probe
// could only ever return `null` now. `buildDopplerNotFoundMessage` already treats `null` as
// "couldn't tell" and omits the suggestion line rather than misreporting "none exist".
export const translateDopplerDownloadError = (error: unknown, project: string, config: string): Error => {
  const stderr = extractStderr(error) ?? (error instanceof Error ? error.message : String(error))
  const kind = classifyDopplerFailure(stderr)

  if (kind === 'auth') return new DopplerAuthError(config, classifyDopplerAuthFailure(stderr))

  if (kind === 'unknown') return error instanceof Error ? error : new Error(String(error))

  return new Error(buildDopplerNotFoundMessage({ kind, project, config, available: null }))
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
