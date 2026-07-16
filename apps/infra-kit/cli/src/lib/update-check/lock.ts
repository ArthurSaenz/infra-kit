/**
 * Single-flight lock for the background update worker.
 *
 * Without it, N shells starting at once all read the same stale cache and each spawns a worker — and
 * once a newer version exists, each of those runs `npm install -g` concurrently, over the same global
 * directory. (Measured: five concurrent `ik` invocations spawn five workers.) The throttle in the cache
 * cannot prevent this: it is only written AFTER the fetch returns, long after the other workers launched.
 *
 * `openSync(path, 'wx')` is the primitive — an atomic create-if-absent, so exactly one worker wins even
 * if all of them call it in the same millisecond.
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { getCacheRoot } from 'src/lib/constants'

export const LOCK_FILE_NAME = 'update-check.lock'

/**
 * A lock older than this is assumed to belong to a worker that was killed before it could clean up.
 *
 * Must exceed the worker's ENTIRE critical section, and the install is part of it: the lock is held across
 * `fetch` (≤2.5s) + the parent wait (≤5min) + `npm install -g`, which has no bound at all — a cold cache on
 * a slow link can run for many minutes. The previous 10 minutes was budgeted from the wait and the fetch
 * alone, silently omitting the very operation the lock exists to serialise. A slow enough install therefore
 * had its own LIVE lock reaped as stale by the next worker, which then ran a second concurrent
 * `npm install -g` over the same global directory — precisely the pile-up described above.
 *
 * The throttle, not this timeout, is now the primary guard: `runUpdateCheck` stamps `lastCheckMs` BEFORE
 * the wait and the install, so concurrent shells stop spawning workers at all. This value only has to
 * outlive a plausible install, and is deliberately generous — the cost of being too large is that a worker
 * killed mid-install delays the next attempt, which the throttle would delay anyway.
 */
export const LOCK_STALE_MS = 30 * 60 * 1000

export const lockFilePath = (): string => {
  return path.join(getCacheRoot(), LOCK_FILE_NAME)
}

export interface LockDeps {
  nowMs?: number
  lockPath?: string
}

/** Delete a lock whose mtime predates the staleness window. Best-effort: losing the race is harmless. */
const reapIfStale = (lockPath: string, nowMs: number): void => {
  try {
    if (nowMs - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) fs.rmSync(lockPath, { force: true })
  } catch {
    // Vanished under us — another worker reaped it. Nothing to do.
  }
}

/**
 * Take the lock, or return null when another worker already holds it.
 *
 * Returns a release function rather than a boolean so the caller cannot forget which path releases:
 * there is exactly one handle, and it is the only thing that can unlink the file.
 *
 * @example
 * const release = acquireUpdateLock()
 * if (!release) return 'already-running'
 * try { ... } finally { release() }
 */
export const acquireUpdateLock = (deps: LockDeps = {}): (() => void) | null => {
  const nowMs = deps.nowMs ?? Date.now()
  const lockPath = deps.lockPath ?? lockFilePath()

  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  } catch {
    return null
  }

  const open = (): number | null => {
    try {
      // 'wx' fails with EEXIST if the file is already there: an atomic test-and-set.
      return fs.openSync(lockPath, 'wx', 0o600)
    } catch {
      return null
    }
  }

  let fd = open()

  if (fd === null) {
    reapIfStale(lockPath, nowMs)
    // One retry only. If a live worker holds the lock, we are the loser and must simply stand down.
    fd = open()
  }

  if (fd === null) return null

  try {
    fs.writeFileSync(fd, String(process.pid))
  } catch {
    // The pid is a debugging aid, not part of the protocol; the lock is held either way.
  }

  return () => {
    try {
      fs.closeSync(fd)
    } catch {
      // Already closed.
    }

    try {
      fs.rmSync(lockPath, { force: true })
    } catch {
      // Already gone; a later worker will reap it via LOCK_STALE_MS regardless.
    }
  }
}
