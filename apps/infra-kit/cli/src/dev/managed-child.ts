/**
 * Shared supervision for the dev-server's long-lived, detached child processes
 * (`turbo watch build`, `turbo run dev`). Both are deep trees
 * (`sh → pnpm → node → turbo → …`) spawned `detached` so they form their own process
 * group; teardown signals the whole GROUP (`process.kill(-pid, …)`), not just the wrapper.
 *
 * Escalation: SIGTERM first, then — if the group is still alive after a grace window —
 * SIGKILL. FE dev servers (vite/vike/astro) run async teardown and can straggle on a
 * lone SIGTERM (orphaned port → next run's `EADDRINUSE`), so the SIGKILL fallback matters.
 */
import type { ChildProcess } from 'node:child_process'
import process from 'node:process'

/** Handle to a supervised child; `kill()` reaps its whole process group and resolves when gone. */
export interface ManagedChild {
  kill: () => Promise<void>
}

/** Default grace before escalating SIGTERM → SIGKILL on a stubborn process group. */
const DEFAULT_GRACE_MS = 2000

/** Is the process group led by `pid` still alive? (`kill(-pid, 0)` throws ESRCH when gone.) */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)

    return true
  } catch {
    return false
  }
}

/**
 * Wrap a detached child: `unref()` it (so it never keeps the loop alive) and return a
 * handle whose `kill()` sends a group SIGTERM, polls up to `graceMs` for the group to
 * exit, and SIGKILLs any survivor. Resolves once the group is gone (or was never spawned).
 */
export function superviseChild(child: ChildProcess, graceMs: number = DEFAULT_GRACE_MS): ManagedChild {
  // Don't keep the parent event loop alive on the child; the runner owns lifecycle via kill().
  child.unref()

  return {
    kill: async (): Promise<void> => {
      const pid = child.pid

      if (pid == null) return

      try {
        // Negative pid → the whole group (detached made the child a group leader).
        process.kill(-pid, 'SIGTERM')
      } catch {
        // Already exited (ESRCH) — nothing to reap.
        return
      }

      const deadline = Date.now() + graceMs

      while (Date.now() < deadline) {
        await new Promise((r) => {
          return setTimeout(r, 100)
        })
        if (!groupAlive(pid)) return
      }

      // Still alive after the grace window — force it.
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        // Raced to exit between the last poll and now — fine.
      }
    },
  }
}
