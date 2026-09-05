import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { writeEnvLoadFile } from 'src/commands/env-load'
import { envTokenExists } from 'src/integrations/doppler/token-resolver'
import {
  ENV_CLEAR_FILE,
  ENV_LOAD_FILE,
  INFRA_KIT_ENV_AUTOLOADED_VAR,
  INFRA_KIT_ENV_CLEARED_VAR,
  INFRA_KIT_ENV_CONFIG_VAR,
  INFRA_KIT_ENV_PROJECT_VAR,
  INFRA_KIT_SESSION_VAR,
  atomicWriteFileSync,
  getSessionCacheDir,
} from 'src/lib/constants'
import { isEnvAuthFailure } from 'src/lib/errors/env-auth-error'
import type { EnvAutoLoadConfig } from 'src/lib/infra-kit-config'
import { getInfraKitConfig } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'

import type { AuthFailureClassifier, AuthFailureMarker } from './auth-failure'
import { buildAuthFailureWarning, parseAuthFailureMarker } from './auth-failure'

/** Which moment a concrete callsite represents. Matches the config `trigger`. */
export type AutoLoadTrigger = EnvAutoLoadConfig['trigger']

/** Per-session flag de-duping the transient-FAILURE warning (Doppler down/unauth). */
const WARN_FAIL_SENTINEL_FILE = 'autoload-warn-fail.flag'
/** Per-session flag de-duping the AUTH-FAILURE warning (bad/missing service token). */
const WARN_AUTH_FAIL_SENTINEL_FILE = 'autoload-warn-auth-fail.flag'

/** Per-session marker recording the last auto-load failure (mtime = when). */
const FAIL_SENTINEL_FILE = 'autoload-fail.flag'

/**
 * Per-session STICKY marker recording the last AUTH-class auto-load failure. Unlike
 * {@link FAIL_SENTINEL_FILE} it carries a payload and has NO expiry: a token failure
 * does not heal on a 30s timer, and the only human who can fix it may not run an
 * interactive command for hours.
 */
const AUTH_FAIL_MARKER_FILE = 'autoload-auth-fail.json'

/**
 * After a failed auto-load, suppress retries for this long so a down/unauthenticated
 * Doppler isn't re-probed on every cli-invocation. A new shell starts a fresh
 * session cache dir, so this only throttles within one session.
 */
const FAIL_BACKOFF_MS = 30_000

/** Resolved auto-load inputs: the chosen trigger + the env config and Doppler project to load. */
export interface ResolvedEnvAutoLoad {
  trigger: AutoLoadTrigger
  config: string
  project: string
}

/**
 * Read the resolved + validated env auto-load inputs, or `null` when auto-load
 * should not run. Returns `null` (never throws) when:
 *  - we're not inside an infra-kit project (getInfraKitConfig throws), or config is unreadable;
 *  - `envAutoLoad` is absent (feature off);
 *  - no service token resolves for `envAutoLoad.config` — warns once per session, then disables.
 *
 * `canWarn` gates the WARNING only, never the STICKY MARKER.
 */
// Validation lives here (not in the schema) so a typo only disables this optional feature instead
// of throwing inside the merged-config parse and breaking every command. The Doppler project is
// resolved from the SAME config read (no second getInfraKitConfig), so the skip path stays cheap.
//
// Why the marker is written even when we cannot warn: the shell-startup callsite runs backgrounded
// with stderr discarded, so warning there is invisible — but a missing token is one of the three
// durable auth-class failures buildAuthFailureWarning documents (alongside a revoked/mis-scoped
// token and a corrupt store), so it is recorded unconditionally and replayed by
// surfaceStickyAuthFailure on the next interactive command, the channel that actually reaches the
// user. Skipping the record here would strand the migration case (upgraded, never minted a token)
// with no channel at all.
export const resolveEnvAutoLoad = async (canWarn = true): Promise<ResolvedEnvAutoLoad | null> => {
  let config

  try {
    config = await getInfraKitConfig()
  } catch {
    return null
  }

  const autoLoad = config.envAutoLoad

  if (!autoLoad) return null

  const resolved = {
    trigger: autoLoad.trigger,
    config: autoLoad.config,
    project: config.envManagement.config.name,
  }

  // The authority for "is this env usable?" is the token store, not a declared list — a name we hold no
  // token for cannot be loaded no matter who declared it. Checking it HERE (a local file read) keeps a
  // typo'd `envAutoLoad.config` from spawning a doomed Doppler download at every single shell open.
  try {
    if (await envTokenExists(autoLoad.config)) return resolved
  } catch {
    // The store itself is broken — a different failure entirely, and NOT one to disable quietly on.
    // Proceed so the loader hits `resolveEnvToken`'s EnvAuthError and the sticky auth-failure marker
    // surfaces it on the next channel that can actually be seen.
    return resolved
  }

  // No token minted for this env — the MIGRATION case (upgraded, never ran
  // `env-token-set`). Record it via the SAME sticky-marker mechanism a thrown auth
  // failure uses, unconditionally, so the backgrounded shell-startup spawn's silent
  // disable is not lost — the next interactive command's `surfaceStickyAuthFailure()`
  // replay is what actually reaches the user.
  recordAuthFailure({
    config: autoLoad.config,
    reason: `No Doppler service token for env "${autoLoad.config}"`,
    at: Date.now(),
  })

  if (canWarn) {
    warnOnce(buildAuthFailureWarning(autoLoad.config), WARN_AUTH_FAIL_SENTINEL_FILE)
  }

  return null
}

/** The env-var snapshot the freshness/suppression guards read. */
export interface AutoLoadEnvSnapshot {
  session?: string
  cleared?: string
  currentConfig?: string
  currentProject?: string
  autoLoadedMarker?: string
}

export interface AutoLoadDecisionInput {
  /** The configured trigger. */
  trigger: AutoLoadTrigger
  /** Which trigger this callsite represents. */
  expectedTrigger: AutoLoadTrigger
  targetConfig: string
  targetProject: string
  env: AutoLoadEnvSnapshot
  /**
   * Bypass ONLY the "already auto-loaded, same config+project" no-op skip, forcing
   * a fresh Doppler fetch. The shell-startup refresh sets this: after a WARM source
   * the shell has already exported INFRA_KIT_ENV_AUTOLOADED + the same config, which
   * the child process inherits — without `force` the refresh would self-skip and the
   * warm (possibly rotated) secrets would never be replaced this session. Does NOT
   * relax the clear/manual-load guards.
   */
  force?: boolean
}

export type AutoLoadDecision = 'load' | 'skip'

/**
 * Pure decision: should this callsite (auto-)load env right now? Encodes the full
 * guard matrix so it is exhaustively unit-testable without Doppler or a shell:
 *  - the configured trigger must match this callsite;
 *  - a session must exist (the cache dir is session-scoped);
 *  - an explicit clear suppresses auto-load (M2);
 *  - a MANUAL load (config set, no auto marker) is never clobbered (C1);
 *  - an auto-load already fresh for the same config AND project is a no-op
 *    (project-aware so two same-named configs across different-repo worktrees
 *    sharing one session don't leak each other's secrets).
 */
export const decideAutoLoad = (input: AutoLoadDecisionInput): AutoLoadDecision => {
  const { trigger, expectedTrigger, targetConfig, targetProject, env, force } = input

  if (trigger !== expectedTrigger) return 'skip'

  if (!env.session) return 'skip'

  if (env.cleared) return 'skip'

  // Manual load present (a config is loaded but it wasn't auto-loaded) — leave it.
  if (env.currentConfig && !env.autoLoadedMarker) return 'skip'

  // Our own auto-load already matches the target config+project — normally a no-op,
  // but `force` (the shell-startup warm refresh) must re-fetch: the shell just warm
  // -sourced these same markers, so skipping here would strand stale secrets.
  if (!force && env.autoLoadedMarker && env.currentConfig === targetConfig && env.currentProject === targetProject) {
    return 'skip'
  }

  return 'load'
}

export interface RunEnvAutoLoadArgs {
  expectedTrigger: AutoLoadTrigger
  /**
   * Canonical (realpath'd) project dir, forwarded to `writeEnvLoadFile` to enable
   * the project-scoped WARM cache. Only the shell-startup spawn passes it (via
   * `--project-dir`); the cli-invocation trigger omits it, so warm is a
   * shell-startup-only optimization.
   */
  projectDir?: string
  /**
   * Force a fresh fetch past the "already auto-loaded, same config" no-op skip. The
   * shell-startup refresh sets this so a preceding WARM source (which exports the
   * same markers the child inherits) is always replaced by fresh secrets. See
   * {@link decideAutoLoad}. The cli-invocation trigger leaves it false.
   */
  force?: boolean
  /**
   * Auth-class predicate over the CAUGHT ERROR (not its text), injected so the
   * auto-load policy is testable without a Doppler in the loop. Defaults to
   * `isEnvAuthFailure` — the type guard for EVERY durable, user-fixable env-auth
   * failure, not just the ones Doppler itself rejected.
   *
   * It was `isDopplerAuthError` and that was too NARROW: a missing token never
   * reaches Doppler, and a corrupt token store never reaches the resolver, so both
   * fell through to "transient", expired with the 30s backoff, and went silent —
   * the missing-token one being exactly the migration case this whole feature exists
   * to survive. See `./auth-failure.ts` for why classifying by message text was the
   * first version of this same bug.
   */
  isAuthFailure?: AuthFailureClassifier
}

/**
 * Resolve config, evaluate the guards, and (if it should) produce env-load.sh with
 * the auto-load marker. Returns the written file path, or `null` when auto-load was
 * skipped or failed. NEVER throws. Transient failures (Doppler offline / network)
 * record a 30s backoff marker so they aren't re-probed on every command, and are
 * surfaced once per session on the interactive (cli-invocation) channel. AUTH-class
 * failures (invalid / missing / mis-scoped service token) additionally record a
 * STICKY marker that is replayed by {@link surfaceStickyAuthFailure} below. No
 * producer-side lock — a rare cold-shell double-fetch is tolerated (the second write
 * is atomic and idempotent).
 */
export const runEnvAutoLoad = async ({
  expectedTrigger,
  projectDir,
  force,
  isAuthFailure = isEnvAuthFailure,
}: RunEnvAutoLoadArgs): Promise<string | null> => {
  // Only the cli-invocation / interactive callsite reaches a TTY; the shell-startup
  // spawn discards stderr, so warning there is invisible and would poison the dedup.
  const canWarn = expectedTrigger === 'cli-invocation'

  // BEFORE any gating. A shell-startup user's token failure is recorded by the
  // backgrounded spawn (stderr → /dev/null) and would otherwise NEVER surface:
  // decideAutoLoad skips this callsite on the trigger mismatch, and the callsite
  // that DID fail cannot warn. This replay is the only channel that reaches them.
  if (canWarn) {
    surfaceStickyAuthFailure()
  }

  let resolved: ResolvedEnvAutoLoad | null = null

  try {
    resolved = await resolveEnvAutoLoad(canWarn)

    if (!resolved) return null

    const decision = decideAutoLoad({
      trigger: resolved.trigger,
      expectedTrigger,
      targetConfig: resolved.config,
      targetProject: resolved.project,
      env: readAutoLoadEnvSnapshot(),
      force,
    })

    if (decision === 'skip') return null

    // Disk-level clear signal: a clear that hasn't yet been sourced into this
    // process's env still suppresses auto-load (clear file newer than load file).
    if (isClearedOnDisk()) return null

    // Back off after a recent failure so a down/unauthenticated Doppler isn't
    // re-probed on every command in the same session.
    if (recentlyFailed()) return null

    const preWriteMtime = readLoadFileMtime()
    const result = await writeEnvLoadFile({
      config: resolved.config,
      autoLoaded: true,
      projectDir,
      // Re-check after the slow Doppler download: abort if a clear or a manual load
      // landed meanwhile, so a backgrounded auto-load never clobbers a deliberate action.
      beforeWrite: () => {
        return !isClearedOnDisk() && !manualLoadLandedSince(preWriteMtime)
      },
    })

    if (!result) return null

    clearFailure()
    clearAuthFailure()

    return result.filePath
  } catch (error) {
    const reason = (error as Error).message

    // Classify the ERROR, not its message: by the time it lands here `env-load` has
    // already translated Doppler's stderr into human prose, so the raw markers are gone.
    const authFailed = isAuthFailure(error)

    recordFailure()

    // The token failure outlives the 30s backoff window AND this process: persist it
    // so the next interactive command can tell the user why their shell went quiet.
    if (authFailed && resolved) {
      recordAuthFailure({ config: resolved.config, reason, at: Date.now() })
    }

    // Surface the failure once per session on the interactive channel; stay silent
    // (debug only) on the backgrounded shell-startup path. The auth-class message is
    // reason-free by design — no token value may ever be printed.
    if (canWarn && authFailed && resolved) {
      warnOnce(buildAuthFailureWarning(resolved.config), WARN_AUTH_FAIL_SENTINEL_FILE)
      logger.debug(`env auto-load auth failure: ${reason}`)
    } else if (canWarn) {
      warnOnce(`infra-kit: env auto-load failed — ${reason} (will retry later)`, WARN_FAIL_SENTINEL_FILE)
    } else {
      logger.debug(`env auto-load skipped: ${reason}`)
    }

    return null
  }
}

/**
 * Replay a previously-recorded STICKY auth failure onto the interactive channel,
 * once per session. Never throws: a missing, unreadable, or corrupt marker is simply
 * "no marker" — this runs on the hot path of EVERY command.
 *
 * Exported because WARNING IS NOT LOADING: `program.ts` excludes `version`, `doctor`,
 * `dev` and the env-* family from the cli-invocation auto-LOAD (priming Doppler env
 * there would be surprising), but those are precisely the commands a user whose shell
 * went quiet reaches for. Gating the replay behind that exclusion would leave a
 * `dev`-only user warned by nothing, forever. So program.ts calls this on EVERY
 * command; `runEnvAutoLoad` still calls it too (the `warnOnce` sentinel de-dups).
 *
 * @example
 * surfaceStickyAuthFailure() // warns once per session iff autoload-auth-fail.json exists
 */
export const surfaceStickyAuthFailure = (): void => {
  const marker = readAuthFailure()

  if (!marker) return

  warnOnce(buildAuthFailureWarning(marker.config), WARN_AUTH_FAIL_SENTINEL_FILE)
  logger.debug(`env auto-load auth failure (recorded ${new Date(marker.at).toISOString()}): ${marker.reason}`)
}

/** Read the sticky auth-failure marker, or null when absent/unreadable/corrupt. */
const readAuthFailure = (): AuthFailureMarker | null => {
  try {
    const raw = fs.readFileSync(path.join(getSessionCacheDir(), AUTH_FAIL_MARKER_FILE), 'utf-8')

    return parseAuthFailureMarker(JSON.parse(raw))
  } catch {
    return null
  }
}

/** Record a sticky auth failure. No expiry — only a successful load clears it. */
const recordAuthFailure = (marker: AuthFailureMarker): void => {
  try {
    const dir = getSessionCacheDir()

    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    atomicWriteFileSync(path.join(dir, AUTH_FAIL_MARKER_FILE), JSON.stringify(marker), 0o600)
  } catch {
    // No session cache dir — nothing to record against.
  }
}

/** Clear the sticky auth-failure marker after a successful load. */
const clearAuthFailure = (): void => {
  try {
    fs.rmSync(path.join(getSessionCacheDir(), AUTH_FAIL_MARKER_FILE), { force: true })
  } catch {
    // No session cache dir — nothing to clear.
  }
}

/** Snapshot the env vars the guards depend on. */
const readAutoLoadEnvSnapshot = (): AutoLoadEnvSnapshot => {
  return {
    session: process.env[INFRA_KIT_SESSION_VAR],
    cleared: process.env[INFRA_KIT_ENV_CLEARED_VAR],
    currentConfig: process.env[INFRA_KIT_ENV_CONFIG_VAR],
    currentProject: process.env[INFRA_KIT_ENV_PROJECT_VAR],
    autoLoadedMarker: process.env[INFRA_KIT_ENV_AUTOLOADED_VAR],
  }
}

/** mtime of the on-disk env-load.sh, or null if absent/unreadable. */
const readLoadFileMtime = (): number | null => {
  try {
    return fs.statSync(path.join(getSessionCacheDir(), ENV_LOAD_FILE)).mtimeMs
  } catch {
    return null
  }
}

/**
 * True when a MANUAL env-load landed on disk after `sinceMtime` (the file now
 * exists, is newer, and carries the manual-load `unset INFRA_KIT_ENV_AUTOLOADED`
 * line). Used to abort an in-flight auto-load so it never clobbers a deliberate load.
 */
const manualLoadLandedSince = (sinceMtime: number | null): boolean => {
  try {
    const p = path.join(getSessionCacheDir(), ENV_LOAD_FILE)

    if (!fs.existsSync(p)) return false

    const mtime = fs.statSync(p).mtimeMs

    if (sinceMtime !== null && mtime <= sinceMtime) return false

    // Anchor to a whole line so the marker can't match inside a single-quoted
    // secret value that happens to contain this literal text.
    const manualMarker = new RegExp(`^unset ${INFRA_KIT_ENV_AUTOLOADED_VAR}$`, 'm')

    return manualMarker.test(fs.readFileSync(p, 'utf-8'))
  } catch {
    return false
  }
}

/**
 * True when a clear is pending on disk: an env-clear.sh exists and is at least as
 * new as env-load.sh (or no load file remains). Belt-and-suspenders next to the
 * INFRA_KIT_ENV_CLEARED env guard for the window before the shell sources the clear.
 */
const isClearedOnDisk = (): boolean => {
  try {
    const dir = getSessionCacheDir()
    const clearPath = path.join(dir, ENV_CLEAR_FILE)

    if (!fs.existsSync(clearPath)) return false

    const loadPath = path.join(dir, ENV_LOAD_FILE)

    if (!fs.existsSync(loadPath)) return true

    return fs.statSync(clearPath).mtimeMs >= fs.statSync(loadPath).mtimeMs
  } catch {
    return false
  }
}

/** True when an auto-load failed within the backoff window (suppress retries). */
const recentlyFailed = (): boolean => {
  try {
    const flagPath = path.join(getSessionCacheDir(), FAIL_SENTINEL_FILE)

    if (!fs.existsSync(flagPath)) return false

    return Date.now() - fs.statSync(flagPath).mtimeMs < FAIL_BACKOFF_MS
  } catch {
    return false
  }
}

/** Record an auto-load failure (refreshes the backoff window). */
const recordFailure = (): void => {
  try {
    const dir = getSessionCacheDir()

    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(dir, FAIL_SENTINEL_FILE), '', { mode: 0o600 })
  } catch {
    // No session cache dir — nothing to back off against.
  }
}

/** Clear the failure marker after a successful load. */
const clearFailure = (): void => {
  try {
    fs.rmSync(path.join(getSessionCacheDir(), FAIL_SENTINEL_FILE), { force: true })
  } catch {
    // No session cache dir — nothing to clear.
  }
}

/**
 * Emit a warning at most once per shell session. Keyed on a flag file in the
 * session cache dir so a misconfigured `envAutoLoad.config` (or a repeated failure)
 * does not spam a warning on every cli-invocation. Falls back to a plain warn when
 * no session cache dir is available.
 */
const warnOnce = (message: string, sentinelFile: string): void => {
  try {
    const dir = getSessionCacheDir()
    const flagPath = path.join(dir, sentinelFile)

    if (fs.existsSync(flagPath)) return

    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(flagPath, '', { mode: 0o600 })
  } catch {
    // No session cache dir (e.g. INFRA_KIT_SESSION unset) — warn without de-dup.
  }

  logger.warn(message)
}
