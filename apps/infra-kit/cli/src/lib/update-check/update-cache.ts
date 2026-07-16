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

/**
 * The ONE re-check window, whatever the last outcome was. A background check is cheap — one detached
 * child and a single registry fetch bounded by `FETCH_TIMEOUT_MS` — but not once per shell command,
 * which is the storm this throttle exists to stop.
 *
 * There is deliberately no shorter "retry after a transient failure" window. One used to exist because
 * this interval was 24h, and burning a whole day on a single network blip locked out exactly the
 * publisher pushing a release mid-window. At 20 minutes that gap is gone: a blip costs one window, so
 * a second window buys nothing and cannot pay for what it costs (below).
 *
 * MUST stay above a full worker cycle: `runUpdateCheck` stamps `lastCheckMs` BEFORE waiting up to
 * `PARENT_WAIT_TIMEOUT_MS` (5min) for the parent to exit and THEN installing. Go below that and the
 * cache reads stale while the first worker is still legitimately working, so the next shell spawns a
 * worker that dies on the live single-flight lock and returns WITHOUT writing — leaving the cache stale
 * for every command until `LOCK_STALE_MS` (30min) reaps the lock. That is the per-command spawn storm
 * this throttle exists to prevent, and it is why a 5-minute retry window is not an option.
 */
export const CHECK_INTERVAL_MS = 20 * 60 * 1000

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
   * cache written before this field existed.
   *
   * Diagnostic ONLY — nothing branches on it, {@link isStale} included. It earns its keep by being the
   * one thing that makes this file legible: a successful `installed` and a failed `fetch-failed` both
   * write a byte-identical `{latestVersion:null, updateCommand:null}`, so without this the cache cannot
   * say which happened, and a silent auto-update leaves no other trace of what it did.
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
 * The window does NOT depend on `outcome`: every last outcome, transient or settled, is re-checked
 * after {@link CHECK_INTERVAL_MS}. See that constant for why a shorter transient-failure window is not
 * worth its cost here.
 *
 * @example
 * isStale(null, 1_000) // => true
 * isStale({ lastCheckMs: 0, latestVersion: null, updateCommand: null }, CHECK_INTERVAL_MS + 1) // => true
 */
export const isStale = (cache: UpdateCache | null, nowMs: number): boolean => {
  if (!cache) return true

  const elapsed = nowMs - cache.lastCheckMs

  if (elapsed < 0) return true

  return elapsed >= CHECK_INTERVAL_MS
}
