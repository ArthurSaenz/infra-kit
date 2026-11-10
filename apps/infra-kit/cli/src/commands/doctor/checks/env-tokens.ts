import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { INFRA_KIT_ENV_TOKEN_VAR, resolveEnvToken } from 'src/integrations/doppler'
import type { EnvTokenSource, ResolvedEnvToken } from 'src/integrations/doppler'
import { getTokenStorePath, readTokenStore } from 'src/lib/env-tokens'
import type { TokenStore } from 'src/lib/env-tokens'
import { tildify } from 'src/lib/path-display'
import { listProjectEnvNames } from 'src/lib/project-envs'

import type { CheckResult } from '../check-result'
import type { DoctorConfig } from '../doctor-config'

/** Every seam the three token checks touch — the store, the resolver, Doppler, and the file modes. */
export interface EnvTokenCheckDeps {
  /** Reads `tokens.json`. THROWS on a corrupt store (bad JSON / bad shape) — that throw is the diagnosis. */
  readStore?: () => Promise<TokenStore | null>
  /** Resolves one env's token (`INFRA_KIT_ENV_TOKEN` → store → throw). */
  resolveToken?: (env: string) => Promise<ResolvedEnvToken>
  storePath?: () => Promise<string>
  /** `null` = the path does not exist. */
  statPath?: (target: string) => fs.Stats | null
  chmodPath?: (target: string, mode: number) => void
  /**
   * Reads `INFRA_KIT_ENV_TOKEN` — the CI / agent channel. A SEAM rather than a direct `process.env`
   * read so the store checks are deterministic under test: a developer whose shell has sourced an
   * `env-load` file would otherwise run the suite with the variable set and silently exercise the
   * skip branch instead of the one under assertion.
   */
  readEnvToken?: () => string | undefined
}

/** `tokens.json` holds live credentials: owner-only, and owner-only traversal to reach it. */
const TOKEN_FILE_MODE = 0o600
const TOKEN_DIR_MODE = 0o700

/** One env's token as doctor sees it: WHERE it came from, never WHAT it is. */
interface EnvTokenEntry {
  env: string
  /** `null` = no token resolves for this env. */
  source: EnvTokenSource | null
}

/**
 * `env <name>: token (store)` / `env <name>: no token`, for every configured environment. The source
 * ONLY — a doctor line is printed to a terminal, pasted into a bug report, and returned under `--json`,
 * so the one thing it can never carry is the token itself.
 *
 * @example
 * describeEntries([{ env: 'dev', source: 'store' }, { env: 'prod', source: null }])
 * // => 'dev: token (store), prod: no token'
 * describeEntries([])
 * // => 'no envs declared'
 */
const describeEntries = (entries: EnvTokenEntry[]): string => {
  // A repo with no workflow envs and no stored tokens is a valid state, not a missing message.
  if (entries.length === 0) return 'no envs declared'

  return entries
    .map((entry) => {
      const held = entry.source === null ? 'no token' : `token (${entry.source})`

      return `${entry.env}: ${held}`
    })
    .join(', ')
}

/** Resolve each env's token to a SOURCE, collapsing "no token" (a throw) into `source: null`. */
const resolveEntries = async (
  environments: string[],
  resolveToken: NonNullable<EnvTokenCheckDeps['resolveToken']>,
): Promise<EnvTokenEntry[]> => {
  return Promise.all(
    environments.map(async (env): Promise<EnvTokenEntry> => {
      try {
        const { source } = await resolveToken(env)

        return { env, source }
      } catch {
        return { env, source: null }
      }
    }),
  )
}

/**
 * Which envs have a service token? A listing, never a verdict: no env is load-bearing now that
 * `env-load -c <config>` is explicit, and a developer legitimately holds a `dev` token and no `prod`
 * one — a doctor that failed on that would train everyone to ignore it. A store that holds NOTHING is
 * {@link checkTokenStorePresent}'s failure; a store that cannot be parsed is the one FAIL here.
 *
 * @example
 * await checkEnvTokensConfigured({ config, error: null })
 * // => { name: 'env tokens configured', status: 'pass', message: 'dev: token (store), prod: no token' }
 */
export const checkEnvTokensConfigured = async (
  read: DoctorConfig,
  deps: EnvTokenCheckDeps = {},
): Promise<CheckResult> => {
  const name = 'env tokens configured'
  const readStore = deps.readStore ?? readTokenStore
  const resolveToken = deps.resolveToken ?? resolveEnvToken

  if (!read.config) {
    return { name, status: 'skip', message: 'infra-kit config could not be read (see config check)' }
  }

  // A corrupt store throws for EVERY env, which would otherwise render as "no token anywhere" — the
  // same symptom as a fresh machine, with a completely different fix. Surface the store's own
  // (actionable) error instead, and let the remaining checks still run.
  //
  // There is no longer a "store belongs to another repo" case to report here: the store carries no
  // `repoRoot` (see `lib/env-tokens`), so a hand-written store loads and a basename collision between
  // two checkouts is an accepted risk, not a diagnosis. Do not add a branch back for it.
  try {
    await readStore()
  } catch (err) {
    return { name, status: 'fail', message: `Token store unreadable — ${(err as Error).message}` }
  }

  // The env universe is the union of what the workflows declare and what we hold tokens for — see
  // `lib/project-envs`. It replaces `config.environments`, which was a hand-maintained third copy.
  const entries = await resolveEntries(await listProjectEnvNames(), resolveToken)

  return { name, status: 'pass', message: describeEntries(entries) }
}

/** The live `INFRA_KIT_ENV_TOKEN`, or `undefined`. An EMPTY value is a MISS — the resolver's rule. */
const defaultReadEnvToken = (): string | undefined => {
  return process.env[INFRA_KIT_ENV_TOKEN_VAR] || undefined
}

/**
 * Does this project HOLD any Doppler service token at all?
 *
 * The FIRST question in this section, and the only one that is repo-shaped rather than env-shaped.
 * Fails when `~/.infra-kit/projects/<repo>/tokens.json` is missing OR holds zero envs. Two states
 * are deliberately NOT failures: `INFRA_KIT_ENV_TOKEN` set (the CI / agent channel takes
 * precedence over the store and needs no home config — see {@link INFRA_KIT_ENV_TOKEN_VAR}), and a
 * store that THROWS (`env tokens configured` already reports that one). Both are a `skip`, not a
 * pass: in neither case was the store's content looked at.
 *
 * @example
 * await checkTokenStorePresent()
 * // => { name: 'tokens.json present', status: 'fail', message: 'No token store at ~/.infra-kit/projects/api/tokens.json …' }
 */
// Every project this CLI drives authenticates through that store, so a checkout without one cannot
// load an env, deploy, or read a secret. `env tokens configured` only LISTS sources and never fails
// on a missing token, so without this check an empty machine would read as green — on exactly the
// machine that needed the report most.
//
// An EMPTY store fails alongside a missing one: `env-token-set` never writes `{ envs: {} }`, so a
// store with no envs is a hand-edit or an `env-token-remove` of the last token — functionally the
// same as no file, and it must not read as "present, therefore fine".
//
// Failing on `INFRA_KIT_ENV_TOKEN` would redden every CI run; repeating the throwing-store failure
// here would double-count one problem.
export const checkTokenStorePresent = async (deps: EnvTokenCheckDeps = {}): Promise<CheckResult> => {
  const name = 'tokens.json present'
  const readStore = deps.readStore ?? readTokenStore
  const storePath = deps.storePath ?? getTokenStorePath
  const readEnvToken = deps.readEnvToken ?? defaultReadEnvToken

  if (readEnvToken()) {
    return {
      name,
      status: 'skip',
      message: `${INFRA_KIT_ENV_TOKEN_VAR} is set; that channel takes precedence over the store`,
    }
  }

  // Display only — every message below is read by a human, and nothing here touches the path again.
  let displayPath: string

  try {
    displayPath = tildify(await storePath())
  } catch {
    return { name, status: 'skip', message: 'the token store path could not be resolved' }
  }

  let store: TokenStore | null

  try {
    store = await readStore()
  } catch {
    return { name, status: 'skip', message: `The store at ${displayPath} is unreadable (see env tokens configured)` }
  }

  const envs = store === null ? [] : Object.keys(store.envs)

  if (envs.length === 0) {
    const state = store === null ? `No token store at ${displayPath}` : `${displayPath} holds no tokens`

    return {
      name,
      status: 'fail',
      message:
        `${state} — every project needs one to authenticate. ` +
        `Fix: run \`infra-kit env-token-set <env>\`. CI / agents: set ${INFRA_KIT_ENV_TOKEN_VAR} instead.`,
    }
  }

  return { name, status: 'pass', message: `${displayPath} holds ${envs.length} token(s): ${envs.join(', ')}` }
}

/** `-rw-------` / `drwx------` — the permission bits of a path, or `null` when it does not exist. */
const modeOf = (target: string, statPath: NonNullable<EnvTokenCheckDeps['statPath']>): number | null => {
  const stats = statPath(target)

  return stats === null ? null : stats.mode & 0o777
}

/**
 * The token store is a credential file, so it must be 0600, reachable only through 0700 directories.
 * `writeTokenStore` sets all four every time it writes — so a violation here means something ELSE
 * touched them (an editor's save-and-rename, a `cp -r`, a synced dotfiles dir), which is exactly the
 * case a self-healing writer cannot fix on its own.
 *
 * A `skip` when the store does not exist: a machine with no tokens has nothing to protect, and CI
 * (`INFRA_KIT_ENV_TOKEN`) never writes one. Not a pass, because no mode was read.
 *
 * @example
 * await checkTokenStorePerms(false)
 * // => { name: 'tokens.json perms', status: 'fail', message: '~/.infra-kit/projects/api/tokens.json is 0644, expected 0600 …' }
 */
export const checkTokenStorePerms = async (fix: boolean, deps: EnvTokenCheckDeps = {}): Promise<CheckResult> => {
  const name = 'tokens.json perms'
  const storePath = deps.storePath ?? getTokenStorePath
  const statPath = deps.statPath ?? defaultStatPath
  const chmodPath = deps.chmodPath ?? fs.chmodSync

  let target: string

  try {
    target = await storePath()
  } catch {
    return { name, status: 'skip', message: 'the token store path could not be resolved' }
  }

  if (modeOf(target, statPath) === null) {
    return { name, status: 'skip', message: `No store to protect at ${tildify(target)} (see tokens.json present)` }
  }

  // Every directory on the way to the file, plus the file: a 0600 file inside a world-readable
  // directory chain is still a credential a `find` away.
  const projectDir = path.dirname(target)
  const projectsDir = path.dirname(projectDir)
  const userConfigDir = path.dirname(projectsDir)

  const audited: Array<{ target: string; expected: number; actual: number | null }> = [
    { target: userConfigDir, expected: TOKEN_DIR_MODE, actual: modeOf(userConfigDir, statPath) },
    { target: projectsDir, expected: TOKEN_DIR_MODE, actual: modeOf(projectsDir, statPath) },
    { target: projectDir, expected: TOKEN_DIR_MODE, actual: modeOf(projectDir, statPath) },
    { target, expected: TOKEN_FILE_MODE, actual: modeOf(target, statPath) },
  ]

  const loose = audited.filter((entry) => {
    return entry.actual !== null && entry.actual !== entry.expected
  })

  if (loose.length === 0) {
    return { name, status: 'pass', message: `${tildify(target)} is 0600 (0700 dirs)` }
  }

  const describe = loose
    .map((entry) => {
      return `${tildify(entry.target)} is ${formatMode(entry.actual!)}, expected ${formatMode(entry.expected)}`
    })
    .join('; ')

  if (!fix) {
    return {
      name,
      status: 'fail',
      message: `${describe}. Fix: run \`infra-kit setup --skip-tools\` or \`infra-kit doctor --fix\`.`,
    }
  }

  for (const entry of loose) {
    chmodPath(entry.target, entry.expected)
  }

  return { name, status: 'pass', message: `Tightened ${loose.length} path(s): ${describe}` }
}

/** `0600`, `0755` — a mode's permission bits in the form a user types at `chmod`. */
const formatMode = (mode: number): string => {
  return `0${mode.toString(8).padStart(3, '0')}`
}

/** `fs.statSync` with "does not exist" as a value rather than a throw. */
const defaultStatPath = (target: string): fs.Stats | null => {
  try {
    return fs.statSync(target)
  } catch {
    return null
  }
}
