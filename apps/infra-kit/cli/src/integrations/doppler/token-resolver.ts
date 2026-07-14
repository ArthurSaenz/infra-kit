import process from 'node:process'

import { getTokenStorePath, readTokenStore } from 'src/lib/env-tokens'
import { EnvAuthError } from 'src/lib/errors/env-auth-error'
import { tildify } from 'src/lib/path-display'

/**
 * The ONE environment variable that carries a Doppler service token into infra-kit (the CI / agent
 * path: no home directory, no token store, no interactive `env-token-set`).
 *
 * Deliberately NOT named `DOPPLER_TOKEN`. That name is contaminated on both ends: a Doppler project
 * may itself hold a secret called `DOPPLER_TOKEN`, and `env-load` exports the WHOLE project into the
 * shell — so a `DOPPLER_TOKEN` in the environment cannot be trusted to be the token WE were handed
 * (SPIKE-0 Q5: an inherited `DOPPLER_TOKEN` silently overrides everything else the CLI would use).
 * A private name keeps the input channel ours.
 */
export const INFRA_KIT_ENV_TOKEN_VAR = 'INFRA_KIT_ENV_TOKEN'

/** Where a resolved token came from. Surfaced by `env-token-list`; never carries the token itself. */
export type EnvTokenSource = 'env' | 'store'

export interface ResolvedEnvToken {
  /** The Doppler service token. NEVER log, echo, or write this into a sourced file. */
  token: string
  source: EnvTokenSource
}

/**
 * Resolve the Doppler service token for one environment (= one Doppler config).
 *
 * Precedence, highest first:
 *  1. `INFRA_KIT_ENV_TOKEN` — the CI / agent channel. Checked BEFORE the store so a machine with no
 *     home config (or a deliberately corrupted one) still loads, and so nothing on that path can
 *     throw on a store it never needed.
 *  2. `envs[env]` from `~/.infra-kit/projects/<repo>/tokens.json` — the developer channel.
 *  3. Nothing ⇒ THROW an {@link EnvAuthError}. Token-only auth has no fallback: there is no
 *     `doppler login` account to degrade to, so a missing token is a hard, actionable stop rather than
 *     a mysterious empty env. The CLASS matters as much as the message — see the throw below.
 *
 * An EMPTY `INFRA_KIT_ENV_TOKEN` is a MISS, not an empty token: `export INFRA_KIT_ENV_TOKEN=` (or an
 * unset var expanded by a CI template) must fall through to the store, not authenticate as "".
 *
 * @example
 * await resolveEnvToken('dev') // => { token: 'dp.st.dev.xxxx', source: 'store' }
 * // with INFRA_KIT_ENV_TOKEN set => { token: <that value>, source: 'env' }
 * // with neither                 => throws 'No Doppler service token for env "dev". …'
 */
export const resolveEnvToken = async (env: string): Promise<ResolvedEnvToken> => {
  const fromEnv = process.env[INFRA_KIT_ENV_TOKEN_VAR]

  if (fromEnv) return { token: fromEnv, source: 'env' }

  const store = await readTokenStore()
  const fromStore = store?.envs[env]

  if (fromStore) return { token: fromStore, source: 'store' }

  // An EnvAuthError, not a plain Error: "no token" is the DURABLE, user-fixable auth failure — the
  // migration case, and the one case env auto-load's sticky marker exists to survive. A plain Error
  // here is classified TRANSIENT downstream, expires with the 30s backoff, and (on the backgrounded
  // shell-startup spawn, whose stderr is discarded) leaves the user with no channel at all: their env
  // silently stops loading and nothing ever says why. The class is what reaches them.
  throw new EnvAuthError(buildMissingTokenMessage(env, await getTokenStorePath()), env)
}

/**
 * Whether a token resolves for one env — the same precedence as {@link resolveEnvToken}, without
 * producing the token and without the refusal.
 *
 * For callers that must DECIDE rather than authenticate: env auto-load has to answer "is this env
 * usable?" at shell startup, and asking by catching {@link resolveEnvToken}'s throw would conflate two
 * very different failures — "no token for this env" (disable quietly, a typo'd `envAutoLoad.config`)
 * and "the store itself is broken" (surface loudly). This propagates the latter and reports the former
 * as a plain `false`.
 *
 * @example
 * await envTokenExists('dev')  // => true
 * await envTokenExists('typo') // => false
 * // corrupt store => throws EnvAuthError (deliberately — the caller must not swallow that)
 */
export const envTokenExists = async (env: string): Promise<boolean> => {
  if (process.env[INFRA_KIT_ENV_TOKEN_VAR]) return true

  const store = await readTokenStore()

  return Boolean(store?.envs[env])
}

/**
 * The no-token refusal. It is the first thing an un-migrated user sees at update time, so it must be
 * fixable without reading any docs: it names the env, where to mint a token, the exact command, where
 * the token lands (and that it is NOT the repo), and the CI escape hatch.
 *
 * The fix command is a BACKTICK code span — the repo convention for naming a command to a human, and
 * the anchor `program.test.ts` scans to prove every command we print is a command we accept.
 *
 * (The @example names the command as `infra-kit env-token-set <env>` rather than with a literal arg
 * for that scan's benefit: a `<env>` placeholder ENDS the command, but a literal `dev` is
 * indistinguishable from a subcommand and would be reported as a dead one.)
 *
 * @example
 * buildMissingTokenMessage('dev', '/Users/x/.infra-kit/projects/api/tokens.json')
 * // => 'No Doppler service token for env "dev". Mint one at https://dashboard.doppler.com … run `infra-kit env-token-set <env>` …'
 */
const buildMissingTokenMessage = (env: string, storePath: string): string => {
  return [
    `No Doppler service token for env "${env}".`,
    `Mint one at https://dashboard.doppler.com — this project → config "${env}" → Access tab → "Generate Service Token".`,
    `Fix: run \`infra-kit env-token-set ${env}\` and paste it.`,
    `It is stored in ${tildify(storePath)} (mode 0600, never in the repo).`,
    `CI / agents: set ${INFRA_KIT_ENV_TOKEN_VAR} instead — it takes precedence and needs no home config.`,
  ].join('\n')
}
