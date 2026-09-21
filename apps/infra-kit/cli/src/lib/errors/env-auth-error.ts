/**
 * The DURABLE, USER-FIXABLE env-auth failure — as a TYPE rather than a string.
 *
 * Throw this (or a subclass) — never a plain `Error` — for anything a user must fix before
 * env-load can work: no token minted, a corrupt token store, a foreign token store.
 * `DopplerAuthError extends EnvAuthError` for the subset that is specifically "Doppler refused the
 * token we sent".
 *
 * @example
 * // no token minted for this env (integrations/doppler/token-resolver.ts)
 * throw new EnvAuthError(buildMissingTokenMessage('dev', storePath), 'dev')
 * @example
 * // the token store itself is unusable — no single env is at fault, so `env` stays null
 * throw new EnvAuthError(`Invalid JSON in the token store at ${storePath} …`)
 */
// WHY THIS EXISTS (and why it is deliberately NOT a Doppler type): every consumer of the auth
// channel needs to classify a failure by its CLASS, not by re-deriving the answer from a message
// some other module owns — and it has to be throwable from EVERY module that can produce the
// class. `lib/env-tokens` (the store) is a layer BELOW `integrations/doppler`, so a Doppler-owned
// base type could not be thrown there without a layering inversion and an import cycle. Hence a
// neutral base here in `lib/errors`.
export class EnvAuthError extends Error {
  /**
   * The env (= Doppler config) whose token is at fault, or `null` when the failure is not attributable
   * to ONE env (a corrupt or foreign token store breaks every env at once). `null` is honest: do NOT
   * invent an env to fill it — the consumer names the env it was TRYING to load, which it already
   * knows.
   */
  readonly env: string | null

  constructor(message: string, env: string | null = null) {
    super(message)
    this.name = 'EnvAuthError'
    this.env = env
  }
}

/**
 * The TYPE GUARD every consumer of the auth channel classifies on — the single question "is this a
 * durable, user-fixable env-auth failure?", answered by the error's CLASS and never by its text.
 *
 * Deliberately WIDER than `isDopplerAuthError`: that one means "Doppler refused us", which is only
 * one of the durable failures — a missing token never reaches Doppler at all, and a corrupt store
 * never reaches the resolver.
 *
 * @example
 * isEnvAuthFailure(new EnvAuthError('No Doppler service token for env "dev".', 'dev')) // => true
 * isEnvAuthFailure(new DopplerAuthError('dev', 'revoked'))                             // => true (subclass)
 * isEnvAuthFailure(new Error('connect ETIMEDOUT'))                                     // => false (transient)
 */
export const isEnvAuthFailure = (error: unknown): error is EnvAuthError => {
  return error instanceof EnvAuthError
}
