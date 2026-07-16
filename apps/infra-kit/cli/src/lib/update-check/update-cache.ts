/**
 * The throttle + notice state for the auto-update check, at `$cacheRoot/update-check.json`.
 *
 * `getCacheRoot()` — NOT `getSessionCacheDir()`, which throws unless `INFRA_KIT_SESSION` is set. A user
 * who installed this CLI globally and never ran `infra-kit init` has no session, and the update check
 * must still work for exactly that person.
 */
import fs from 'node:fs'
import path from 'node:path'

import { atomicWriteFileSync, getCacheRoot } from 'src/lib/constants'

export const CACHE_FILE_NAME = 'update-check.json'

/** Refresh at most once a day after a SETTLED check. A background check is cheap, but not once per shell command. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

/**
 * The shorter re-check window after a TRANSIENT outcome (see {@link RETRYABLE_OUTCOMES}). A single
 * failed fetch used to burn the full 24h {@link CHECK_INTERVAL_MS}, so one network blip locked
 * auto-update out for a whole day — exactly the failure a publisher hits pushing a release mid-window.
 * An hour still stops the per-command spawn storm the throttle exists to prevent.
 */
export const RETRY_INTERVAL_MS = 60 * 60 * 1000

/**
 * Outcomes that did NOT reach a settled "checked, nothing left to do" state — a transient failure, or
 * an install we could not complete this cycle. They get the short {@link RETRY_INTERVAL_MS}; every
 * settled outcome (`up-to-date`, `installed`, `cannot-self-spawn`) keeps the 24h window.
 *
 * Most members mirror `UpdateCheckOutcome` in `run-update-check.ts` — keep the two in step — with two
 * deliberate mismatches: `installing` is a cache-ONLY mid-install checkpoint (not a union member), and
 * the union's `already-running` never reaches the cache (it returns before any write). This set has no
 * compile-time tie to the union (that would import-cycle), so a rename there fails silently HERE — the
 * membership guard test in `__tests__/update-cache.test.ts` is what catches that drift.
 *
 * ACCEPTED tradeoff: `install-failed` covers both a transient blip and a permanently broken setup (EACCES
 * on a root-owned global dir), so a broken install now retries hourly rather than daily. It is bounded —
 * single-flight lock, silent `stdio: 'ignore'`, and the manual command still surfaced via the notice — and
 * favouring fast recovery of the transient case is the point of this change.
 */
const RETRYABLE_OUTCOMES = new Set([
  'fetch-failed',
  'install-failed',
  'parent-still-running',
  'parent-unknown',
  'installing',
])

export interface UpdateCache {
  /**
   * When the last check was ATTEMPTED — never "when it last succeeded". An offline user whose fetch
   * throws must still burn their window, or every single command spawns another doomed child.
   */
  lastCheckMs: number
  /** Latest version seen on the registry, or null when the last attempt failed. */
  latestVersion: string | null
  /**
   * The command the USER must run, set only when the worker was not allowed to install for them
   * (Homebrew, or an install location it could not identify). Null means "handled, say nothing".
   *
   * The worker decides this, not the reader: identifying the owning package manager can cost an
   * `npm root -g` subprocess, and the CLI startup path must never pay for one. The background child
   * already pays it, so it writes the verdict down.
   */
  updateCommand: string[] | null
  /**
   * The last check's terminal outcome (`installed`, `fetch-failed`, `up-to-date`, …), or absent on a
   * cache written before this field existed. Two jobs: (1) it is the signal {@link isStale} uses to
   * pick the short retry window after a transient failure; (2) it is the ONLY thing that makes the file
   * legible — a successful `installed` and a failed `fetch-failed` both write a byte-identical
   * `{latestVersion:null, updateCommand:null}`, so without this the cache cannot say which happened.
   */
  outcome?: string | null
}

export const cacheFilePath = (): string => {
  return path.join(getCacheRoot(), CACHE_FILE_NAME)
}

const isStringArray = (value: unknown): value is string[] => {
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      return typeof entry === 'string'
    })
  )
}

const isUpdateCache = (value: unknown): value is UpdateCache => {
  if (typeof value !== 'object' || value === null) return false

  const { lastCheckMs, latestVersion, updateCommand, outcome } = value as Partial<UpdateCache>

  return (
    typeof lastCheckMs === 'number' &&
    Number.isFinite(lastCheckMs) &&
    (latestVersion === null || typeof latestVersion === 'string') &&
    (updateCommand === null || isStringArray(updateCommand)) &&
    (outcome === undefined || outcome === null || typeof outcome === 'string')
  )
}

/**
 * Read the cache, or null when it is missing/unreadable/corrupt. A null read means "stale" to every
 * caller, so a first run and a hand-mangled file behave identically: check again.
 *
 * @example
 * readUpdateCache() // => { lastCheckMs: 1770000000000, latestVersion: '0.1.131' } | null
 */
export const readUpdateCache = (
  readFile: (p: string) => string = (p) => {
    return fs.readFileSync(p, 'utf8')
  },
): UpdateCache | null => {
  try {
    const parsed: unknown = JSON.parse(readFile(cacheFilePath()))

    return isUpdateCache(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Persist the check result. Creates `$cacheRoot` first: `atomicWriteFileSync` writes a temp file
 * beside the target and renames, so it throws ENOENT on a machine that has never had a `~/.cache/infra-kit`.
 * Without this mkdir the write fails, `lastCheckMs` never lands, and the throttle degrades into a
 * detached-child spawn on every invocation.
 *
 * @example
 * writeUpdateCache({ lastCheckMs: Date.now(), latestVersion: '0.1.131' })
 */
export const writeUpdateCache = (cache: UpdateCache): void => {
  const root = getCacheRoot()

  fs.mkdirSync(root, { recursive: true })
  atomicWriteFileSync(path.join(root, CACHE_FILE_NAME), JSON.stringify(cache), 0o600)
}

/**
 * Has the throttle window elapsed? A missing cache is stale by definition (first run).
 *
 * A `lastCheckMs` in the future (clock skew, or a restored backup) also reads as stale rather than
 * locking the user out of updates until their clock catches up.
 *
 * The window is outcome-aware: a transient last outcome (see {@link RETRYABLE_OUTCOMES}) is re-checked
 * after {@link RETRY_INTERVAL_MS}, every settled outcome after {@link CHECK_INTERVAL_MS}. A cache with
 * no `outcome` (pre-`outcome` format, or a hand-written file) falls through to the 24h bucket — the
 * safe default that cannot turn into an every-hour spawn storm.
 *
 * @example
 * isStale(null, 1_000) // => true
 * isStale({ lastCheckMs: 0, latestVersion: null, updateCommand: null }, CHECK_INTERVAL_MS + 1) // => true
 */
export const isStale = (cache: UpdateCache | null, nowMs: number): boolean => {
  if (!cache) return true

  const elapsed = nowMs - cache.lastCheckMs

  if (elapsed < 0) return true

  const interval =
    cache.outcome != null && RETRYABLE_OUTCOMES.has(cache.outcome) ? RETRY_INTERVAL_MS : CHECK_INTERVAL_MS

  return elapsed >= interval
}
