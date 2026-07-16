import password from '@inquirer/password'
import process from 'node:process'
import { $ } from 'zx'

import { assertTokenScope, buildDopplerChildEnv, parseDopplerSecretsJson } from 'src/commands/env-load'
import { classifyDopplerAuthFailure, classifyDopplerFailure, getDopplerProject } from 'src/integrations/doppler'
import { commandEcho } from 'src/lib/command-echo'
import { getTokenStorePath, setToken } from 'src/lib/env-tokens'
import { extractStderr } from 'src/lib/errors/operation-error'
import { logger } from 'src/lib/logger'
import { tildify } from 'src/lib/path-display'
import { withEscape } from 'src/lib/prompts/escapable-context'
import { redactToken } from 'src/lib/redact'
import { purgeRepoWarmCaches } from 'src/lib/warm-cache'
import { textContent } from 'src/types'

export interface EnvTokenSetArgs {
  /** Environment = Doppler config the token must be scoped to. */
  env: string
  /** Read the token from stdin (`… | infra-kit env-token-set dev --stdin`) instead of prompting. */
  stdin?: boolean
  /** Read the token from the named environment variable (never from argv). */
  fromEnv?: string
  /** Write even when the token's scope could NOT be verified. Never overrides a real mismatch. */
  force?: boolean
}

/** Where the token came in from. Reported back so a scripted run can prove which channel it used. */
type TokenInputSource = 'prompt' | 'stdin' | 'env'

/**
 * There is deliberately NO `--token <value>` flag, and there must never be one.
 *
 * argv is world-visible: `ps -ef` shows it to every user on the box, it lands in the shell history
 * file, and `commandEcho` prints option VALUES back to the terminal as the replayable "📟 Equivalent
 * command". A flag would put a live credential into all three. The three channels below all keep the
 * token out of argv: a masked prompt, stdin, or an env var named (not valued) on the command line.
 */
const readCandidateToken = async ({
  stdin,
  fromEnv,
}: Pick<EnvTokenSetArgs, 'stdin' | 'fromEnv'>): Promise<{
  token: string
  source: TokenInputSource
}> => {
  if (stdin) return { token: await readStdin(), source: 'stdin' }

  if (fromEnv) {
    const token = process.env[fromEnv]

    if (!token) throw new Error(`${fromEnv} is not set (or is empty) — nothing to store.`)

    return { token, source: 'env' }
  }

  commandEcho.setInteractive()

  // Esc abandons a half-typed credential (withEscape → AbortPromptError → exit 0, nothing written).
  // The typed value never reaches the output either way: `mask: true` renders one `*` per keystroke, so
  // the transcript holds asterisks, not the token. (The masked line itself SURVIVES the abort — this
  // context sets no `clearPromptOnDone` — but it carries no secret.)
  const token = await withEscape(
    (context) => {
      return password({ message: 'Paste the Doppler service token (input is hidden)', mask: true }, context)
    },
    // stderr, like env-load's picker: some env commands are invoked inside `$(…)` by the shell
    // wrapper, which captures stdout. A prompt rendered to stdout would be swallowed there — the user
    // would face a blank, silent terminal and type a credential into the void.
    { output: process.stderr },
  )

  return { token: token.trim(), source: 'prompt' }
}

/** Drain stdin. `--stdin` is the CI / password-manager channel: `op read … | infra-kit env-token-set dev --stdin`. */
const readStdin = async (): Promise<string> => {
  const chunks: string[] = []

  process.stdin.setEncoding('utf8')

  for await (const chunk of process.stdin) {
    chunks.push(chunk as string)
  }

  return chunks.join('').trim()
}

/** The payload key carrying the token's scope (SPIKE-0 Q2 — the CONFIG, never DOPPLER_ENVIRONMENT). */
const DOPPLER_CONFIG_KEY = 'DOPPLER_CONFIG'

/** Same bound as the env-load download: a hung probe must not hold an interactive prompt hostage. */
const PROBE_TIMEOUT_MS = 30_000

/**
 * Exercise the candidate token against the real config, exactly as `env-load` will: same
 * `secrets download`, same child env (token by ENV, never argv — {@link buildDopplerChildEnv}).
 *
 * This is the check that catches the likeliest real-world mistake, a human pasting the `arthur` token
 * into `env-token-set dev`: Doppler itself refuses a cross-config download (SPIKE-0 Q1, exit 1
 * "does not have access to requested config"), so a mis-scoped token can never be written.
 */
const probeToken = async (token: string, project: string, env: string): Promise<Array<[string, string]>> => {
  const prevQuiet = $.quiet

  $.quiet = true

  let stdout: string

  try {
    const result = await $({
      env: buildDopplerChildEnv(token),
    })`doppler secrets download --no-file --format json --project ${project} --config ${env}`.timeout(PROBE_TIMEOUT_MS)

    stdout = result.stdout
  } catch (error: unknown) {
    throw translateProbeFailure(error, env)
  } finally {
    $.quiet = prevQuiet
  }

  return parseDopplerSecretsJson(stdout)
}

/**
 * Turn a rejected probe into a refusal a human can act on. An auth-class failure is the whole point
 * of the probe, so it gets a message naming WHICH of the two diagnoses it is; anything else (network,
 * timeout, a wrong project name) is rethrown untouched so the user is not told their token is bad
 * when Doppler was simply unreachable.
 */
const translateProbeFailure = (error: unknown, env: string): Error => {
  const stderr = extractStderr(error) ?? (error instanceof Error ? error.message : String(error))

  if (classifyDopplerFailure(stderr) !== 'auth') {
    return error instanceof Error ? error : new Error(String(error))
  }

  const detail =
    classifyDopplerAuthFailure(stderr) === 'mis-scoped'
      ? `it is scoped to a DIFFERENT config (pasting another environment's token here is the mistake this check exists to catch).`
      : 'it is invalid or has been revoked.'

  return new Error(
    [
      `Doppler refused this token for config "${env}" — ${detail}`,
      'Nothing was written. Issue a service token scoped to that config and try again.',
    ].join('\n'),
  )
}

/**
 * The UNVERIFIABLE case: the download succeeded but the payload carries no `DOPPLER_CONFIG`, so we
 * cannot confirm what the token is scoped to.
 *
 * We FAIL CLOSED here, and fail OPEN in `env-load`'s `assertTokenScope` — deliberately, and the
 * asymmetry is the design. A human is watching THIS command: refusing costs them one `--force` and
 * they learn something. On the silent shell-startup autoload path nobody is watching, and failing
 * closed there would blank every developer's environment at once the day Doppler changes what it
 * injects.
 */
const buildUnverifiableScopeMessage = (env: string): string => {
  return [
    `Could not verify this token's scope: the Doppler payload for "${env}" carries no ${DOPPLER_CONFIG_KEY}.`,
    'Refusing to store a credential whose scope is unknown (a token for the wrong environment would load',
    'the wrong secrets into every shell).',
    'Re-run with --force if you are certain the token is scoped to this config.',
  ].join('\n')
}

/**
 * Store a Doppler service token for one environment, AFTER proving against Doppler that it is scoped
 * to that environment's config. The write is the last thing that happens; every refusal above leaves
 * `tokens.json` untouched.
 *
 * Not an MCP tool — see the comment on the catalog entry. The MCP boundary auto-confirms every call,
 * and an agent must never be one tool call away from writing a credential.
 */
export const envTokenSet = async ({ env, stdin, fromEnv, force }: EnvTokenSetArgs) => {
  // No declared-list check. Doppler is the authority on whether `env` is a real config, and it is
  // consulted three lines down: `probeToken` downloads with this token and `assertTokenScope` refuses a
  // payload belonging to any other config. A typo cannot survive that. A declared list, meanwhile, could
  // only ever be a stale local copy — and it was: it refused `prod_observability`, a config that exists
  // in Doppler and holds a live token, purely because nobody had added the name to infra-kit.json.
  const project = await getDopplerProject()

  const { token, source } = await readCandidateToken({ stdin, fromEnv })

  if (!token) throw new Error('No token provided — nothing was written.')

  const pairs = await probeToken(token, project, env)

  // Doppler already refused a cross-config download above; this catches the payload disagreeing with
  // the request anyway (defense in depth — reused verbatim from the env-load path).
  assertTokenScope(pairs, env)

  const scopeVerified = pairs.some(([key]) => {
    return key === DOPPLER_CONFIG_KEY
  })

  if (!scopeVerified && !force) throw new Error(buildUnverifiableScopeMessage(env))

  await setToken(env, token)

  // The warm cache is per-WORKTREE while the token store is per-REPO, so a rotation here would leave
  // sibling worktrees serving up to 2h of secrets fetched with the OLD token at the next shell prompt.
  const purged = await purgeRepoWarmCaches()

  const storePath = await getTokenStorePath()

  // The token is rendered ONLY through redactToken, and never interpolated into a message string —
  // pino's key-path `redact` cannot censor a string it did not structure (see lib/logger).
  logger.info(`Stored the "${env}" service token (${redactToken(token)}) in ${tildify(storePath)} (mode 0600).`)

  if (!scopeVerified) {
    logger.warn(`Scope was NOT verified (no ${DOPPLER_CONFIG_KEY} in the payload) — written because --force was given.`)
  }

  if (purged.length > 0) {
    logger.info(
      `Purged ${purged.length} warm cache(s) so the next shell cannot serve secrets fetched with an old token.`,
    )
  }

  const structuredContent = {
    env,
    source,
    redactedToken: redactToken(token),
    storePath,
    scopeVerified,
    warmCachesPurged: purged.length,
  }

  commandEcho.print()

  return {
    content: textContent(JSON.stringify(structuredContent, null, 2)),
    structuredContent,
  }
}
