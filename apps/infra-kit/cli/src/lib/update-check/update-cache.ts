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

/** Refresh at most once a day. A background check is cheap, but not once per shell command. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface UpdateCache {
  /**
   * When the last check was ATTEMPTED — never "when it last succeeded". An offline user whose fetch
   * throws must still burn their 24h window, or every single command spawns another doomed child.
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

  const { lastCheckMs, latestVersion, updateCommand } = value as Partial<UpdateCache>

  return (
    typeof lastCheckMs === 'number' &&
    Number.isFinite(lastCheckMs) &&
    (latestVersion === null || typeof latestVersion === 'string') &&
    (updateCommand === null || isStringArray(updateCommand))
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
 * @example
 * isStale(null, 1_000) // => true
 * isStale({ lastCheckMs: 0, latestVersion: null }, CHECK_INTERVAL_MS + 1) // => true
 */
export const isStale = (cache: UpdateCache | null, nowMs: number): boolean => {
  if (!cache) return true

  const elapsed = nowMs - cache.lastCheckMs

  return elapsed >= CHECK_INTERVAL_MS || elapsed < 0
}
