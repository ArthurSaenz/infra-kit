import { Buffer } from 'node:buffer'
import process from 'node:process'
import { $ } from 'zx'

import { extractStderr } from 'src/lib/errors/operation-error'

import {
  DopplerAuthError,
  buildDopplerNotFoundMessage,
  classifyDopplerAuthFailure,
  classifyDopplerFailure,
} from './doppler-errors'
import { getDopplerProject } from './doppler-project'
import { resolveEnvToken } from './token-resolver'

/** The payload key that carries the token's scope — the one {@link assertTokenScope} compares. */
const DOPPLER_CONFIG_KEY = 'DOPPLER_CONFIG'

/**
 * Cap the Doppler stdout we're willing to accept. A well-formed env bundle is
 * O(10 KB); megabytes would indicate a service regression or the wrong stream
 * being captured, and we don't want to write that to disk or source it.
 */
export const DOPPLER_MAX_OUTPUT_BYTES = 1024 * 1024

/**
 * Hard upper bound for the Doppler subprocess. Well under zx's default so a
 * hung call surfaces quickly instead of blocking an interactive shell.
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

/**
 * One Doppler config's secrets, downloaded with the token stored for it — `env-load`'s own fetch, for a
 * caller that needs a few values of an env without loading the whole env into a shell.
 */
export const downloadEnvSecrets = async (config: string): Promise<Map<string, string>> => {
  return new Map(await downloadDopplerSecrets(await getDopplerProject(), config))
}

export const downloadDopplerSecrets = async (project: string, config: string): Promise<Array<[string, string]>> => {
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
 * and failing closed here would blank every developer's shell at once.
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

  // A DopplerAuthError, not a plain Error: this IS an auth failure, and callers classify by TYPE
  // (`isEnvAuthFailure`), so a plain Error would read as transient. The message stays richer than the
  // generic one: we know the token's real config.
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
// Why a type and not prose: a caller that text-matched the raw Doppler markers on the error this
// function had already rewritten found them long gone, and a revoked token went silent.
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
    // The length only, never an excerpt: output that fails to parse can still BE the secrets (a notice
    // printed ahead of the JSON), and this message reaches the terminal, `--json` and agent transcripts.
    throw new Error(`doppler returned non-JSON output for env-load (${stdout.length} characters)`)
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
