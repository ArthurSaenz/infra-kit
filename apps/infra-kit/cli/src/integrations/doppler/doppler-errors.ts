/**
 * Translate Doppler `secrets download` not-found failures into actionable,
 * point-at-the-fix guidance. Pure (no I/O) so the classification + message policy
 * is unit-testable without spawning the Doppler CLI — mirroring the pure-helper
 * pattern in `commands/env-load/env-load.ts`.
 *
 * Observed Doppler output on a not-found download (verified 2026-06-27, doppler
 * v3.76.0), exit 1, written to STDERR (stdout empty):
 *   Unable to download secrets
 *   Doppler Error: Could not find requested project 'name'
 *   Doppler Error: Could not find requested config 'name'
 * Only the "Doppler Error:" prefix is ANSI-colored; the "Could not find requested
 * ..." text is plain, so substring matching is color-safe. zx's
 * `ProcessOutput.message` also concatenates stdout+stderr, so the same markers are
 * matchable off `.message` when `.stderr` is unavailable.
 */
import { EnvAuthError } from 'src/lib/errors/env-auth-error'

/** Which kind of Doppler not-found a download failure represents (`unknown` = not a not-found error). */
export type DopplerNotFoundKind = 'project' | 'config' | 'unknown'

/**
 * Every class of `secrets download` failure we act on. `'auth'` is the token-only addition: the
 * service token is absent, revoked, garbage, or scoped to a DIFFERENT config. It is deliberately
 * distinct from the not-found kinds (the name is wrong) and from `'unknown'` (network, timeout,
 * Doppler down) — only `'auth'` is a durable, user-fixable state, and only `'auth'` earns the sticky
 * shell-startup marker (see `lib/env-autoload/auth-failure.ts`).
 */
export type DopplerFailureKind = 'auth' | DopplerNotFoundKind

const PROJECT_NOT_FOUND_MARKER = 'Could not find requested project'
const CONFIG_NOT_FOUND_MARKER = 'Could not find requested config'

/**
 * The REAL auth-class stderr markers, captured from a live Doppler CLI v3.76.0 (SPIKE-0 Q1/Q4):
 *   - `Invalid Auth token`                                       — revoked / garbage token
 *   - `This token does not have access to requested config 'x'`  — mis-scoped token
 * Both are plain (uncolored) text, so substring matching is ANSI-safe. The second one is the CLI
 * ENFORCING the token's scope for us — it is the primary mis-scope guard, not our payload assert.
 */
const INVALID_TOKEN_MARKER = 'Invalid Auth token'
const TOKEN_SCOPE_MARKER = 'does not have access to requested config'

/**
 * Classify a Doppler `secrets download` failure from its stderr/message text. The full lattice:
 * auth-class first (a mis-scoped token's message names a config but is NOT a not-found), then the
 * two not-found kinds, then `'unknown'` for everything else so the caller can rethrow the original
 * untouched (degrades to status quo, never worse).
 *
 * @example
 * classifyDopplerFailure('Doppler Error: Invalid Auth token')                            // => 'auth'
 * classifyDopplerFailure("This token does not have access to requested config 'dev'")    // => 'auth'
 * classifyDopplerFailure("Doppler Error: Could not find requested project 'x'")          // => 'project'
 * classifyDopplerFailure('connect ETIMEDOUT')                                            // => 'unknown'
 */
export const classifyDopplerFailure = (stderr: string): DopplerFailureKind => {
  if (stderr.includes(INVALID_TOKEN_MARKER) || stderr.includes(TOKEN_SCOPE_MARKER)) return 'auth'

  if (stderr.includes(PROJECT_NOT_FOUND_MARKER)) return 'project'

  if (stderr.includes(CONFIG_NOT_FOUND_MARKER)) return 'config'

  return 'unknown'
}

/**
 * The two auth-class failures, told apart. Both are `'auth'` to
 * {@link classifyDopplerFailure} — they share one fix (a new token) — but they are DIFFERENT
 * diagnoses, and `doctor` must not conflate them: "your token was revoked" sends a user to the
 * Doppler dashboard, "your token is scoped to the wrong config" sends them to re-issue it against
 * the right one.
 */
export type DopplerAuthKind = 'revoked' | 'mis-scoped'

/**
 * Split an auth-class failure into its two diagnoses, or `null` when the text is not auth-class at
 * all (network, timeout, not-found) — the caller must not read `null` as "the token is fine", only
 * as "this failure says nothing about the token".
 *
 * @example
 * classifyDopplerAuthFailure("This token does not have access to requested config 'dev'") // => 'mis-scoped'
 * classifyDopplerAuthFailure('Doppler Error: Invalid Auth token')                         // => 'revoked'
 * classifyDopplerAuthFailure('connect ETIMEDOUT')                                         // => null
 */
export const classifyDopplerAuthFailure = (stderr: string): DopplerAuthKind | null => {
  if (stderr.includes(TOKEN_SCOPE_MARKER)) return 'mis-scoped'

  if (stderr.includes(INVALID_TOKEN_MARKER)) return 'revoked'

  return null
}

/**
 * Is this failure text an auth-class Doppler failure (bad / absent / mis-scoped service token)
 * rather than a transient one (network, timeout, Doppler down)? The single source of truth for that
 * question — `lib/env-autoload/auth-failure.ts` delegates its `isAuthFailure` default here.
 *
 * @example
 * isDopplerAuthFailure('Doppler Error: Invalid Auth token') // => true
 * isDopplerAuthFailure('network unreachable')               // => false
 */
export const isDopplerAuthFailure = (stderr: string): boolean => {
  return classifyDopplerFailure(stderr) === 'auth'
}

/**
 * Classify a Doppler download failure into the NOT-FOUND lattice only. Auth-class failures collapse
 * to `'unknown'` here on purpose: this predicate's whole contract is "is this a wrong-NAME error",
 * and its callers enrich with project/config listings that an auth failure must never trigger. Use
 * {@link classifyDopplerFailure} when you need the full lattice.
 *
 * @example
 * classifyDopplerDownloadError("Doppler Error: Could not find requested project 'x'") // => 'project'
 * classifyDopplerDownloadError("Doppler Error: Could not find requested config 'dev'") // => 'config'
 * classifyDopplerDownloadError('Doppler Error: Invalid Auth token')                    // => 'unknown'
 */
export const classifyDopplerDownloadError = (stderr: string): DopplerNotFoundKind => {
  const kind = classifyDopplerFailure(stderr)

  return kind === 'auth' ? 'unknown' : kind
}

/**
 * The actionable body for an auth-class download failure: Doppler REFUSED the token we sent, so the
 * fix is always a new token for this env — never `doppler login` (account auth no longer exists).
 *
 * Deliberately does not interpolate the raw stderr: this message is user-facing, and the one rule a
 * credential path cannot bend is that nothing token-adjacent gets rendered by accident.
 *
 * @example
 * buildDopplerAuthFailureMessage('dev')
 * // => 'Doppler rejected the service token for env "dev" … run `infra-kit env-token-set <env>` …'
 */
export const buildDopplerAuthFailureMessage = (env: string): string => {
  return [
    `Doppler rejected the service token for env "${env}" — it is invalid, revoked, or scoped to a different config.`,
    `Fix: run \`infra-kit env-token-set ${env}\` with a token scoped to that config.`,
    'CI / agents: set INFRA_KIT_ENV_TOKEN to a token scoped to that config.',
  ].join('\n')
}

/**
 * An auth-class `secrets download` failure, as a TYPE rather than a string. This is the error
 * `env-load`'s `translateDopplerDownloadError` throws for the auth class, and it is what every
 * DOWNSTREAM consumer classifies on.
 *
 * WHY a class and not "match the message": the moment the raw Doppler stderr is translated into a
 * human-facing message the markers it was classified by are GONE. A consumer that re-derives the
 * class by re-parsing that message is coupled to prose owned by another module — and the coupling is
 * SILENT: reword the message and the auth channel simply stops firing, with every unit test on both
 * sides still green (exactly the defect this type exists to make impossible). The classification now
 * travels WITH the error.
 *
 * It is the DOPPLER-REFUSED-US subset of {@link EnvAuthError}, the durable/user-fixable env-auth class:
 * a missing token never reaches Doppler, and a corrupt token store never reaches the resolver, yet all
 * three are equally durable and equally the user's to fix. Downstream policy (the sticky auth marker)
 * therefore classifies on `isEnvAuthFailure`; `isDopplerAuthError` remains for the callers who
 * genuinely mean "the token was SENT and Doppler rejected it".
 *
 * The message is unchanged — {@link buildDopplerAuthFailureMessage} still renders it — so a human who
 * only ever sees `error.message` sees precisely what they saw before.
 *
 * (The @example names the command as `infra-kit env-token-set <env>` rather than with a literal arg
 * for `program.test.ts`'s benefit: to that scan an `<env>` placeholder ENDS the command, but a literal
 * `dev` is indistinguishable from a subcommand and would be reported as a dead one.)
 *
 * @example
 * throw new DopplerAuthError('dev', 'revoked')
 * // message: 'Doppler rejected the service token for env "dev" … `infra-kit env-token-set <env>` …'
 */
export class DopplerAuthError extends EnvAuthError {
  /**
   * The env (= Doppler config) whose service token Doppler refused. Names the fix, carries no token.
   *
   * `declare` NARROWS the base's `string | null` (a Doppler refusal always names one env) without
   * re-declaring the field: under `useDefineForClassFields` a real re-declaration would `defineProperty`
   * it back to `undefined` AFTER `super()` had set it.
   */
  declare readonly env: string
  /**
   * Which of the two auth diagnoses the raw stderr indicated, or `null` when it was not stated
   * (e.g. the payload-scope assert, which never sees Doppler's stderr). Diagnostic only — every
   * auth kind shares one fix.
   */
  readonly authKind: DopplerAuthKind | null

  /**
   * `message` overrides the rendered text for a caller that knows MORE than the generic diagnosis —
   * the payload-scope assert can name the config the token actually belongs to, which Doppler's own
   * refusal cannot. It never changes the CLASS: every auth failure must remain type-detectable, or it
   * degrades to the transient 30s marker and the user is never told (the defect this type exists to
   * make impossible).
   */
  constructor(env: string, authKind: DopplerAuthKind | null = null, message?: string) {
    super(message ?? buildDopplerAuthFailureMessage(env), env)
    this.name = 'DopplerAuthError'
    this.authKind = authKind
  }
}

/**
 * The NARROW type guard: "we sent Doppler a token and Doppler refused it". Not text-matching — that
 * is how a caller asks "was this the token?" without re-parsing a rendered message.
 *
 * Use {@link isEnvAuthFailure} instead when the question is the POLICY one — "is this durable and the
 * user's to fix?" — because a missing token and a corrupt token store are both of those and neither is
 * a Doppler refusal. Classifying auto-load policy on THIS guard is precisely how the missing-token
 * (migration) case shipped silent.
 *
 * @example
 * isDopplerAuthError(new DopplerAuthError('dev'))                   // => true
 * isDopplerAuthError(new Error('Doppler Error: Invalid Auth token')) // => false (untranslated: not ours to claim)
 */
export const isDopplerAuthError = (error: unknown): error is DopplerAuthError => {
  return error instanceof DopplerAuthError
}

interface DopplerNotFoundMessageArgs {
  /** Whether the missing entity is the project or the config within it. */
  kind: 'project' | 'config'
  project: string
  config: string
  /**
   * Names to suggest. `null` = lookup failed/unavailable, `[]` = none exist; both
   * omit the suggestion line so a failed enrichment probe is never misreported as
   * a definitive "none available".
   */
  available?: string[] | null
}

/**
 * Build the actionable, multi-line error body for a Doppler not-found failure:
 * states what's missing, points at the exact infra-kit.json field, lists available
 * names when known, and gives a concrete fix.
 *
 * @example
 * buildDopplerNotFoundMessage({ kind: 'project', project: 'infra-kit', config: 'dev', available: ['nomadream'] })
 * // => 'Doppler project "infra-kit" not found (set in infra-kit.json → envManagement.config.name).\nAvailable projects: nomadream.\nFix: ...'
 */
export const buildDopplerNotFoundMessage = ({
  kind,
  project,
  config,
  available,
}: DopplerNotFoundMessageArgs): string => {
  const lines: string[] =
    kind === 'project'
      ? [`Doppler project "${project}" not found (set in infra-kit.json → envManagement.config.name).`]
      : [`Doppler config "${config}" not found in project "${project}".`]

  if (available && available.length > 0) {
    const label = kind === 'project' ? 'Available projects' : `Available configs in "${project}"`

    lines.push(`${label}: ${available.join(', ')}.`)
  }

  // The config half no longer points at a config file: there IS no declared env list any more. The name
  // came from a workflow, a token, or the `--config` flag, and the only place to fix a genuinely missing
  // one is Doppler itself.
  lines.push(
    kind === 'project'
      ? 'Fix: update envManagement.config.name to an existing project, or create it in Doppler.'
      : 'Fix: pass an existing config, or create it in Doppler.',
  )

  return lines.join('\n')
}
