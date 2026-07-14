/**
 * Auth-class failure policy for env auto-load: classification + message, both pure
 * (no I/O) so they are unit-testable without Doppler or a shell. The marker's disk
 * I/O lives next to the other session-cache helpers in `env-autoload.ts`.
 *
 * WHY this is a separate concern from the transient failure marker: under the
 * token-only Doppler model a user with no (or a revoked/mis-scoped) service token
 * silently stops getting env vars in new shells. The shell-startup spawn is
 * backgrounded with stderr discarded, so that failure has NO channel of its own —
 * the sticky marker written here is what carries it to the next interactive
 * command. A 30s backoff marker would expire long before the user runs one.
 */
/**
 * Decide whether a caught failure is an AUTH-class failure — durable and the user's to
 * fix (no token minted, a bad/revoked/mis-scoped token, an unreadable token store) —
 * rather than a transient one (network, timeout, Doppler down).
 *
 * Takes the ERROR, not its text. env-autoload catches what `env-load` THREW, and by
 * then `translateDopplerDownloadError` has already replaced Doppler's raw stderr with
 * a human-facing message — so the raw markers this used to grep for were never there.
 * That is exactly how a revoked token shipped silent with green tests on both sides.
 * The classification now rides ON the error (`EnvAuthError`).
 *
 * Injected as `isAuthFailure` into `runEnvAutoLoad` so the auto-load policy stays
 * testable without a Doppler in the loop; the DEFAULT is `isEnvAuthFailure`, the type
 * guard from `lib/errors/env-auth-error`.
 *
 * That default is deliberately WIDER than `isDopplerAuthError`. Narrowing it back to
 * "Doppler refused us" re-opens the bug in its second form: a MISSING token (the
 * migration case — the user upgraded and never minted one) never reaches Doppler at
 * all, and a CORRUPT store never reaches the resolver, so neither would be auth-class,
 * neither would write the sticky marker, and both would go silent forever.
 */
export type AuthFailureClassifier = (error: unknown) => boolean

/** The sticky auth-failure marker's on-disk shape (`autoload-auth-fail.json`). */
export interface AuthFailureMarker {
  /** The env / Doppler config name the failed auto-load targeted. */
  config: string
  /** The raw failure text. Debug-only — NEVER rendered into the user-facing warning. */
  reason: string
  /** Unix ms the failure was recorded. Informational: the marker never expires. */
  at: number
}

/**
 * Narrow arbitrary parsed JSON to an {@link AuthFailureMarker}. A hand-corrupted or
 * truncated marker must degrade to "no marker", never to a thrown error on the hot
 * path of every command.
 *
 * @example
 * parseAuthFailureMarker({ config: 'dev', reason: 'Invalid Auth token', at: 1 })  // => the marker
 * parseAuthFailureMarker({ config: 'dev' })                                       // => null
 */
export const parseAuthFailureMarker = (value: unknown): AuthFailureMarker | null => {
  if (typeof value !== 'object' || value === null) return null

  const { config, reason, at } = value as Partial<AuthFailureMarker>

  if (typeof config !== 'string' || config.length === 0) return null

  if (typeof reason !== 'string') return null

  if (typeof at !== 'number' || !Number.isFinite(at)) return null

  return { config, reason, at }
}

/**
 * The one-line, actionable warning for a sticky auth failure. Names the env, states
 * that the token is missing/invalid/unreadable, gives the exact fix command, and points
 * at the Doppler dashboard page a replacement token is minted on.
 *
 * "MISSING, INVALID, OR UNREADABLE" spans the whole auth class on purpose. It covers the
 * three durable failures that all land here and all share this one entry point:
 *  - missing   — no token minted for this env (the MIGRATION case: upgraded, never ran env-token-set);
 *  - invalid   — Doppler refused it (revoked, garbage, or scoped to another config);
 *  - unreadable — the token STORE is corrupt JSON, or belongs to a same-named foreign repo.
 * The last of these is neither invalid nor missing, and calling it either would misdescribe the
 * user's machine. `env-token-set` is still the right first move for all three — it is where a
 * broken store surfaces its own, more specific "fix or delete the file" refusal.
 *
 * Deliberately does NOT interpolate the marker's `reason`: the warning is the one
 * thing guaranteed to reach a human, and no token value may ever be printed. The
 * reason goes to `logger.debug` instead.
 *
 * The fix command is written in a BACKTICK code span, which is the repo convention
 * for naming a command to a human AND the anchor `program.test.ts` scans to prove
 * every command we print is a command we accept. Written without backticks it would
 * be invisible to that guard and free to rot.
 *
 * (Which is also why this @example names the command as `infra-kit env-token-set <env>`
 * rather than with a literal arg: to that scan an `<env>` placeholder ends the command,
 * but a literal `dev` is indistinguishable from a subcommand and reads as a dead one.)
 *
 * @example
 * buildAuthFailureWarning('dev')
 * // => 'infra-kit: Doppler token for env "dev" is missing, invalid, or unreadable — env
 * //     auto-load is not running. Fix: run `infra-kit env-token-set <env>` (mint one at
 * //     https://dashboard.doppler.com under this config's Access tab)', with <env> = dev
 */
export const buildAuthFailureWarning = (config: string): string => {
  return (
    `infra-kit: Doppler token for env "${config}" is missing, invalid, or unreadable — env auto-load is not running. ` +
    `Fix: run \`infra-kit env-token-set ${config}\` (mint one at https://dashboard.doppler.com under this config's Access tab).`
  )
}
