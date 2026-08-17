import process from 'node:process'

import { exitCodeForSignal } from 'src/dev/signal-shutdown'
import { logger } from 'src/lib/logger'

/**
 * Resources a run has acquired that must be released even when the process is
 * terminated rather than unwound.
 *
 * The scratch worktree is the motivating case: it is created before the operator
 * is prompted and removed in a `finally`, and a `finally` does not run when Node
 * takes the default action for SIGINT. A leaked registration is not cosmetic —
 * the next run's `worktree add` fails with `is a missing but already registered
 * worktree`, so the command stays broken on that machine until someone knows to
 * run `git worktree prune`.
 */
const pending = new Set<() => Promise<void>>()

/** Register a release action for the duration of a run. Returns its unregister. */
export const registerRunCleanup = (release: () => Promise<void>): (() => void) => {
  pending.add(release)

  return (): void => {
    pending.delete(release)
  }
}

/** Run every pending release, swallowing failures — this executes on the way out. */
const releaseAll = async (): Promise<void> => {
  for (const release of [...pending]) {
    try {
      await release()
    } catch (error) {
      logger.warn({ error, msg: 'cleanup failed during shutdown' })
    }
  }

  pending.clear()
}

const GUARDED_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']

export interface RunCleanupDeps {
  register?: (signal: NodeJS.Signals, handler: () => void) => void
  unregister?: (signal: NodeJS.Signals, handler: () => void) => void
  exit?: (code: number) => void
}

/**
 * Run `fn` with a SIGINT/SIGTERM guard that releases registered resources and
 * exits `128 + signo`, then always detaches the guard.
 *
 * **Install this on the CLI path ONLY.** The precedent it copies
 * (`installBootSignalGuard`) lives at an entry point, which owns the process.
 * `ghMergeDev` does not: it is also the MCP tool handler running inside a
 * long-lived server, where a per-invocation handler calling `process.exit(130)`
 * would preempt the host's shutdown semantics and, on a stray signal, take the
 * whole server down mid-session. Under MCP nothing is installed and ordinary
 * unwinding suffices, because neither non-unwinding exit exists there — the
 * boundary always injects `confirmedCommand: true`, so the decline branch is
 * unreachable, and the server owns signal handling.
 *
 * `exit` is injectable purely as a test seam, so a unit test can assert 130/143
 * without killing the runner. It is not a second production mode.
 */
export const withRunCleanup = async <T>(fn: () => Promise<T>, deps: RunCleanupDeps = {}): Promise<T> => {
  const {
    register = (signal, handler): void => {
      process.on(signal, handler)
    },
    unregister = (signal, handler): void => {
      process.off(signal, handler)
    },
    exit = (code: number): void => {
      process.exit(code)
    },
  } = deps

  const handlers = new Map<NodeJS.Signals, () => void>()

  for (const signal of GUARDED_SIGNALS) {
    const handler = (): void => {
      void releaseAll().then(() => {
        exit(exitCodeForSignal(signal))
      })
    }

    handlers.set(signal, handler)
    register(signal, handler)
  }

  try {
    return await fn()
  } finally {
    for (const [signal, handler] of handlers) {
      unregister(signal, handler)
    }
  }
}
