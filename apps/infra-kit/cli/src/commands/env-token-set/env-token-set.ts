import confirm from '@inquirer/confirm'
import input from '@inquirer/input'
import password from '@inquirer/password'
import select from '@inquirer/select'
import fs from 'node:fs/promises'
import process from 'node:process'
import { $ } from 'zx'

import { assertTokenScope, buildDopplerChildEnv, parseDopplerSecretsJson } from 'src/commands/env-load'
import { classifyDopplerAuthFailure, classifyDopplerFailure, getDopplerProject } from 'src/integrations/doppler'
import { agentMode, isHeadless } from 'src/lib/agent-mode'
import { assertNever } from 'src/lib/assert-never'
import { commandEcho } from 'src/lib/command-echo'
import { getTokenStorePath, readTokenStore, setTokens } from 'src/lib/env-tokens'
import { extractStderr } from 'src/lib/errors/operation-error'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { logger } from 'src/lib/logger'
import { tildify } from 'src/lib/path-display'
import { listProjectEnvs } from 'src/lib/project-envs'
import { withEscape } from 'src/lib/prompts/escapable-context'
import { redactToken } from 'src/lib/redact'
import { textContent } from 'src/types'

export interface EnvTokenSetArgs {
  /** Environment = Doppler config the token must be scoped to. Omitted → picker (TTY) or `argument_required`. */
  env?: string
  /**
   * Read the token from stdin instead of prompting. Implied whenever stdin is not a TTY
   * (`op read … | infra-kit env-token-set dev`); the flag only makes it explicit.
   */
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

  // `gh secret set` semantics: a pipe IS the input, no flag needed. An EMPTY pipe is not an answer —
  // the Bash tool's stdin sits at EOF, and inquirer on an EOF stdin cancels silently with exit 0. A
  // headless run falls through to the prompt below for its structured `argument_required`; a human
  // gets told what to pipe.
  if (!process.stdin.isTTY) {
    const piped = await readStdin()

    if (piped) return { token: piped, source: 'stdin' }

    if (!isHeadless()) {
      throw new Error(
        'stdin is not a terminal and carried no token — pipe one in (`op read … | infra-kit env-token-set <env>`) or pass --from-env <VAR>.',
      )
    }
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
    //
    // Headless (`--agent`/`--json`): refuse and name `stdin` — an agent has a real exit in `--stdin`
    // (or `--from-env`), and a masked prompt into a stream nobody is typing at would hang forever.
    { output: process.stderr, whenHeadless: { refuse: 'stdin' } },
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
 * they learn something. `env-load` has no such escape hatch, and failing closed there would blank
 * every developer's environment at once the day Doppler changes what it injects.
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
 * Prove a candidate token against Doppler and return whether its scope was VERIFIED (vs accepted
 * under `--force`). Throws on every refusal, so a caller that reaches its write has a usable token.
 */
const verifyToken = async (token: string, project: string, env: string, force?: boolean): Promise<boolean> => {
  const pairs = await probeToken(token, project, env)

  // Doppler already refused a cross-config download above; this catches the payload disagreeing with
  // the request anyway (defense in depth — reused verbatim from the env-load path).
  assertTokenScope(pairs, env)

  const scopeVerified = pairs.some(([key]) => {
    return key === DOPPLER_CONFIG_KEY
  })

  if (!scopeVerified && !force) throw new Error(buildUnverifiableScopeMessage(env))

  return scopeVerified
}

/** What a write did to one env's slot in `tokens.json`. `kept` = the human declined the replace. */
export type TokenWriteStatus = 'stored' | 'replaced' | 'unchanged' | 'kept'

/** A select value no Doppler config name can collide with. */
const NEW_ENV_CHOICE = '\0new-env'

/**
 * Ask which environment the token is for: every env the project knows (workflow-declared first, then
 * token-only), each marked with whether a token is already stored, plus a free-text "new env" row.
 * A new name needs no registration anywhere — the probe against Doppler is what decides it is real.
 */
const pickTokenEnv = async (): Promise<string> => {
  // A piped stdin carries the TOKEN, so it cannot also answer a picker.
  if (isHeadless() || !process.stdin.isTTY) {
    throw new StructuredRefusalError({ status: 'argument_required', argument: 'env', agentMode: agentMode.source }, 2, {
      operation: 'env-token-set',
      remediation: 'pass the environment as the positional argument on the re-run: `infra-kit env-token-set <env>`',
      stderrExcerpt: '<env> was not given and there is no terminal to pick it in',
    })
  }

  const [envs, store] = await Promise.all([listProjectEnvs(), readTokenStore()])
  const width = Math.max(
    0,
    ...envs.map(({ env }) => {
      return env.length
    }),
  )

  commandEcho.setInteractive()

  const picked = await withEscape(
    (context) => {
      return select(
        {
          message: 'Which environment is the token for?',
          choices: [
            ...envs.map(({ env }) => {
              return { name: `${env.padEnd(width)}  ${store?.envs[env] ? 'set — replace' : 'not set'}`, value: env }
            }),
            { name: '+ new env…', value: NEW_ENV_CHOICE },
          ],
        },
        context,
      )
    },
    { output: process.stderr, whenHeadless: 'refuse' },
  )

  if (picked !== NEW_ENV_CHOICE) return picked

  const typed = await withEscape(
    (context) => {
      return input(
        {
          message: 'Doppler config name',
          validate: (value) => {
            return /^\S+$/.test(value.trim()) || 'Enter a config name without spaces'
          },
        },
        context,
      )
    },
    { output: process.stderr, whenHeadless: 'refuse' },
  )

  return typed.trim()
}

/** Only ever reached with a human at the prompt — piped and env-var tokens replace without asking. */
const confirmReplace = async (env: string, previous: string, next: string): Promise<boolean> => {
  return withEscape(
    (context) => {
      return confirm(
        { message: `Replace the "${env}" token ${redactToken(previous)} with ${redactToken(next)}?`, default: true },
        context,
      )
    },
    { output: process.stderr, whenHeadless: 'refuse' },
  )
}

const describeWrite = (env: string, status: TokenWriteStatus, token: string, previous: string | undefined): string => {
  switch (status) {
    case 'stored':
      return `Stored the "${env}" service token (${redactToken(token)})`
    case 'replaced':
      return `Replaced the "${env}" service token ${redactToken(previous ?? '')} → ${redactToken(token)}`
    case 'unchanged':
      return `The "${env}" service token is already ${redactToken(token)} — nothing to write`
    case 'kept':
      return `Kept the existing "${env}" service token ${redactToken(previous ?? '')} — nothing was written`
    default:
      return assertNever(status)
  }
}

/**
 * Store a Doppler service token for one environment, AFTER proving against Doppler that it is scoped
 * to that environment's config. The write is the last thing that happens; every refusal above leaves
 * `tokens.json` untouched.
 *
 * No confirm step under --agent (LOW_RISK_MUTATING_ALLOWLIST): the guard is the host's permission
 * prompt on the argv plus the two scope checks below — Doppler refusing the download for a mis-scoped
 * token, and the payload having to name this config. `--force` skips neither: it only accepts an
 * UNVERIFIABLE scope, never a wrong one. A human who typed the token at the prompt is asked before an
 * existing one is replaced; a piped or env-var token replaces silently, as `gh secret set` does.
 */
export const envTokenSet = async ({ env: givenEnv, stdin, fromEnv, force }: EnvTokenSetArgs) => {
  // No declared-list check. Doppler is the authority on whether `env` is a real config, and it is
  // consulted by `verifyToken`: `probeToken` downloads with this token and `assertTokenScope` refuses a
  // payload belonging to any other config. A typo cannot survive that. A declared list, meanwhile, could
  // only ever be a stale local copy — and it was: it refused `prod_observability`, a config that exists
  // in Doppler and holds a live token, purely because nobody had added the name to infra-kit.json.
  const project = await getDopplerProject()

  const env = givenEnv ?? (await pickTokenEnv())

  const { token, source } = await readCandidateToken({ stdin, fromEnv })

  if (!token) throw new Error('No token provided — nothing was written.')

  const scopeVerified = await verifyToken(token, project, env, force)

  const previous = (await readTokenStore())?.envs[env]

  let status: TokenWriteStatus

  if (previous === token) {
    status = 'unchanged'
  } else if (previous !== undefined && source === 'prompt' && !(await confirmReplace(env, previous, token))) {
    status = 'kept'
  } else {
    await setTokens({ [env]: token })
    status = previous === undefined ? 'stored' : 'replaced'
  }

  const storePath = await getTokenStorePath()

  // The token is rendered ONLY through redactToken, and never interpolated into a message string —
  // pino's key-path `redact` cannot censor a string it did not structure (see lib/logger).
  logger.info(`${describeWrite(env, status, token, previous)} in ${tildify(storePath)} (mode 0600).`)

  if (!scopeVerified) {
    logger.warn(
      `Scope was NOT verified (no ${DOPPLER_CONFIG_KEY} in the payload) — accepted because --force was given.`,
    )
  }

  const structuredContent = {
    env,
    status,
    source,
    redactedToken: redactToken(token),
    previousRedactedToken: previous === undefined ? null : redactToken(previous),
    storePath,
    scopeVerified,
  }

  commandEcho.print()

  return {
    content: textContent(JSON.stringify(structuredContent, null, 2)),
    structuredContent,
  }
}

export interface EnvTokenSetFromFileArgs {
  /** Path of a `<env>=<token>` file (blank lines and `#` comments allowed). */
  fromFile: string
  /** As on {@link EnvTokenSetArgs.force}, applied to every entry. */
  force?: boolean
}

interface TokenFileEntry {
  env: string
  token: string
}

const unquote = (value: string): string => {
  return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value
}

/**
 * Parse a `.env`-shaped token file. Refusals name the LINE, never its content — the right-hand side
 * is a live credential.
 *
 * @example
 * parseTokenFile('# team tokens\ndev=dp.st.dev.x\narthur="dp.st.arthur.y"\n')
 * // => [{ env: 'dev', token: 'dp.st.dev.x' }, { env: 'arthur', token: 'dp.st.arthur.y' }]
 */
export const parseTokenFile = (raw: string): TokenFileEntry[] => {
  const entries = raw.split(/\r?\n/).flatMap((line, index) => {
    const trimmed = line.trim()

    if (trimmed === '' || trimmed.startsWith('#')) return []

    const separator = trimmed.indexOf('=')
    const env = separator > 0 ? trimmed.slice(0, separator).trim() : ''
    const token = separator > 0 ? unquote(trimmed.slice(separator + 1).trim()) : ''

    if (!/^\S+$/.test(env) || token === '') {
      throw new Error(`Token file line ${index + 1} is not \`<env>=<token>\` — nothing was written.`)
    }

    return [{ env, token }]
  })

  if (entries.length === 0) throw new Error('The token file holds no `<env>=<token>` lines — nothing was written.')

  const seen = new Set<string>()

  for (const { env } of entries) {
    if (seen.has(env)) throw new Error(`"${env}" appears twice in the token file — nothing was written.`)

    seen.add(env)
  }

  return entries
}

/** One row of a bulk import. `failed` rows carry the refusal's first line, never the token. */
export interface TokenImportRow {
  env: string
  status: Exclude<TokenWriteStatus, 'kept'> | 'failed'
  redactedToken: string
  scopeVerified: boolean
  error?: string
}

const firstLine = (error: unknown): string => {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? ''
}

const writeStatusFor = (previous: string | undefined, token: string): 'stored' | 'replaced' | 'unchanged' => {
  if (previous === undefined) return 'stored'

  return previous === token ? 'unchanged' : 'replaced'
}

const importOne = async (
  entry: TokenFileEntry,
  project: string,
  previous: string | undefined,
  force?: boolean,
): Promise<TokenImportRow> => {
  const redactedToken = redactToken(entry.token)

  try {
    const scopeVerified = await verifyToken(entry.token, project, entry.env, force)

    return { env: entry.env, status: writeStatusFor(previous, entry.token), redactedToken, scopeVerified }
  } catch (error) {
    return { env: entry.env, status: 'failed', redactedToken, scopeVerified: false, error: firstLine(error) }
  }
}

/**
 * Import several tokens from a file — the `gh secret set -f .env` shape. Each entry is proved against
 * Doppler on its own; the ones that pass are written together in one store write, the ones that fail
 * are reported and leave their slot untouched, and any failure sets exit code 1.
 */
export const envTokenSetFromFile = async ({ fromFile, force }: EnvTokenSetFromFileArgs) => {
  const project = await getDopplerProject()
  const entries = parseTokenFile(await fs.readFile(fromFile, 'utf8'))
  const store = await readTokenStore()

  const rows = await Promise.all(
    entries.map((entry) => {
      return importOne(entry, project, store?.envs[entry.env], force)
    }),
  )

  const accepted = Object.fromEntries(
    entries
      .filter((_, index) => {
        return rows[index]?.status === 'stored' || rows[index]?.status === 'replaced'
      })
      .map(({ env, token }) => {
        return [env, token]
      }),
  )

  if (Object.keys(accepted).length > 0) await setTokens(accepted)

  const storePath = await getTokenStorePath()
  const width = Math.max(
    ...rows.map(({ env }) => {
      return env.length
    }),
  )

  logger.info(`Token import from ${tildify(fromFile)} → ${tildify(storePath)}:`)

  for (const row of rows) {
    const detail = row.error ? `  ${row.error}` : ''

    logger.info(`  ${row.env.padEnd(width)}  ${row.status.padEnd(9)}  ${row.redactedToken}${detail}`)
  }

  logger.warn(`${tildify(fromFile)} still holds live tokens in plain text — delete it.`)

  const failedCount = rows.filter((row) => {
    return row.status === 'failed'
  }).length

  if (failedCount > 0) process.exitCode = 1

  const structuredContent = { storePath, rows, failedCount }

  return {
    content: textContent(JSON.stringify(structuredContent, null, 2)),
    structuredContent,
  }
}
