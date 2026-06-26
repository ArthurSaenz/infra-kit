import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { writeEnvLoadFile } from 'src/commands/env-load'
import {
  ENV_CLEAR_FILE,
  ENV_LOAD_FILE,
  INFRA_KIT_ENV_AUTOLOADED_VAR,
  INFRA_KIT_ENV_CLEARED_VAR,
  INFRA_KIT_ENV_CONFIG_VAR,
  INFRA_KIT_ENV_PROJECT_VAR,
  INFRA_KIT_SESSION_VAR,
  getSessionCacheDir,
} from 'src/lib/constants'
import type { EnvAutoLoadConfig } from 'src/lib/infra-kit-config'
import { getInfraKitConfig } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'

/** Which moment a concrete callsite represents. Matches the config `trigger`. */
export type AutoLoadTrigger = EnvAutoLoadConfig['trigger']

/** Per-session flag file that de-dups the auto-load warning (misconfig or failure). */
const WARN_SENTINEL_FILE = 'autoload-warn.flag'

/** Per-session marker recording the last auto-load failure (mtime = when). */
const FAIL_SENTINEL_FILE = 'autoload-fail.flag'

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
 *  - `envAutoLoad.config` is not one of `environments` — warns once per session, then disables.
 *
 * Validation lives here (not in the schema) so a typo only disables this optional
 * feature instead of throwing inside the merged-config parse and breaking every command.
 * Resolves the Doppler project from the SAME config read (no second getInfraKitConfig),
 * so the skip path stays cheap.
 *
 * `canWarn` gates the misconfig warning: the shell-startup callsite runs backgrounded
 * with stderr discarded, so warning there is invisible AND would write the dedup flag,
 * poisoning the only channel (cli-invocation / interactive) that can actually surface
 * it. So shell-startup passes `false`; interactive callsites pass `true`.
 */
export const resolveEnvAutoLoad = async (canWarn = true): Promise<ResolvedEnvAutoLoad | null> => {
  let config

  try {
    config = await getInfraKitConfig()
  } catch {
    return null
  }

  const autoLoad = config.envAutoLoad

  if (!autoLoad) return null

  if (!config.environments.includes(autoLoad.config)) {
    if (canWarn) {
      warnOnce(
        `infra-kit: envAutoLoad.config "${autoLoad.config}" is not one of environments [${config.environments.join(
          ', ',
        )}] — env auto-load disabled.`,
      )
    }

    return null
  }

  return {
    trigger: autoLoad.trigger,
    config: autoLoad.config,
    project: config.envManagement.config.name,
  }
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
  const { trigger, expectedTrigger, targetConfig, targetProject, env } = input

  if (trigger !== expectedTrigger) return 'skip'

  if (!env.session) return 'skip'

  if (env.cleared) return 'skip'

  // Manual load present (a config is loaded but it wasn't auto-loaded) — leave it.
  if (env.currentConfig && !env.autoLoadedMarker) return 'skip'

  // Our own auto-load already matches the target config+project — nothing to do.
  if (env.autoLoadedMarker && env.currentConfig === targetConfig && env.currentProject === targetProject) {
    return 'skip'
  }

  return 'load'
}

export interface RunEnvAutoLoadArgs {
  expectedTrigger: AutoLoadTrigger
}

/**
 * Resolve config, evaluate the guards, and (if it should) produce env-load.sh with
 * the auto-load marker. Returns the written file path, or `null` when auto-load was
 * skipped or failed. NEVER throws. Transient failures (Doppler offline / not
 * authenticated / network) record a backoff marker so they aren't re-probed on every
 * command, and are surfaced once per session on the interactive (cli-invocation)
 * channel. No producer-side lock — a rare cold-shell double-fetch is tolerated (the
 * second write is atomic and idempotent).
 */
export const runEnvAutoLoad = async ({ expectedTrigger }: RunEnvAutoLoadArgs): Promise<string | null> => {
  // Only the cli-invocation / interactive callsite reaches a TTY; the shell-startup
  // spawn discards stderr, so warning there is invisible and would poison the dedup.
  const canWarn = expectedTrigger === 'cli-invocation'

  try {
    const resolved = await resolveEnvAutoLoad(canWarn)

    if (!resolved) return null

    const decision = decideAutoLoad({
      trigger: resolved.trigger,
      expectedTrigger,
      targetConfig: resolved.config,
      targetProject: resolved.project,
      env: readAutoLoadEnvSnapshot(),
    })

    if (decision === 'skip') return null

    // Disk-level clear signal: a clear that hasn't yet been sourced into this
    // process's env still suppresses auto-load (clear file newer than load file).
    if (isClearedOnDisk()) return null

    // Back off after a recent failure so a down/unauthenticated Doppler isn't
    // re-probed on every command in the same session.
    if (recentlyFailed()) return null

    const result = await writeEnvLoadFile({ config: resolved.config, autoLoaded: true })

    clearFailure()

    return result.filePath
  } catch (error) {
    const reason = (error as Error).message

    recordFailure()

    // Surface the failure once per session on the interactive channel; stay silent
    // (debug only) on the backgrounded shell-startup path.
    if (canWarn) {
      warnOnce(`infra-kit: env auto-load failed — ${reason} (will retry later)`)
    } else {
      logger.debug(`env auto-load skipped: ${reason}`)
    }

    return null
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
const warnOnce = (message: string): void => {
  try {
    const dir = getSessionCacheDir()
    const flagPath = path.join(dir, WARN_SENTINEL_FILE)

    if (fs.existsSync(flagPath)) return

    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(flagPath, '', { mode: 0o600 })
  } catch {
    // No session cache dir (e.g. INFRA_KIT_SESSION unset) — warn without de-dup.
  }

  logger.warn(message)
}
