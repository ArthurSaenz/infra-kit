import process from 'node:process'

/**
 * Ctrl-Z, from the process side, for both the palette and the post-run pause. React-free on purpose:
 * neither caller should have to reach for `node:process`, and this half is worth unit-testing with
 * plain vitest (inject `kill`, assert the signal) rather than through an Ink frame or a raw-stdin
 * harness.
 *
 * It lives under `src/lib/session/` rather than `src/tui/` because of layering, not lint: this module
 * now has two callers — `boot.tsx`'s palette and the session shell's post-run pause — and the pause
 * lives in the eagerly-imported `src/lib/session` chunk. That chunk must never statically depend on
 * `src/tui`, the lazily-imported Ink tree, even for a React-free leaf like this one; putting it here
 * keeps the dependency edge pointing the right way for both callers instead of making the eager
 * session code reach backward into the lazy TUI chunk for it.
 */

/** Seams for the stop. Production passes nothing; tests inject fakes and assert the signal. */
export interface SuspendDeps {
  platform?: NodeJS.Platform
  kill?: (pid: number, signal: NodeJS.Signals) => void
}

/**
 * Stop the foreground PROCESS GROUP (pid 0) so the user's shell reclaims the tty and prints a
 * prompt. Returns when the job is resumed (`fg` → SIGCONT): the kill halts JS synchronously and
 * execution continues at the next statement, so there is no SIGCONT handler and nothing to re-arm.
 *
 * Pure signal policy — it does no terminal work of its own, so every caller (the palette's Ctrl-Z
 * binding, the post-run pause's suspend path) owes it the same terminal state on entry: raw mode
 * already dropped, cursor visible, cursor at column 0, and resume via `fg` only.
 *
 * @example
 * const stopped: number[] = []
 * suspendForeground({ platform: 'darwin', kill: (pid) => stopped.push(pid) })
 * stopped // => [0]  (the process group, not process.pid)
 */
// pid 0 is the whole process group, and that is load-bearing. Under `pnpm exec infra-kit`, pnpm's
// node wrapper shares our pgid and the interactive shell only ever waits on PNPM — we are a
// grandchild it never reaps. Stopping only ourselves would leave pnpm blocked in `waitpid`, so the
// job never reads as stopped, the shell never reclaims the tty, and the terminal wedges with no
// prompt and no way back. Stopping the group suspends the job as a unit, exactly as the tty's own
// Ctrl-Z would; on direct-bin invocation it degenerates to a self-stop, so this is one code path.
//
// Why each caller precondition exists:
//  - A `tcsetattr` left armed across a `SIGSTOP` resumes into a terminal the shell (not us) is now
//    driving cooked-mode assumptions against.
//  - Nothing in this function shows or hides the cursor.
//  - It does no newline work of its own either: it relies on the caller having already erased its
//    frame and landed the cursor at the start of a clean row, so the "suspended" line the shell
//    prints lands there without a gratuitous blank gap above it (verified on a real pty).
//  - `bg` or a bare `kill -CONT` is NOT supported: whichever caller re-arms raw mode on resume
//    does a `tcsetattr` from what is then a background process group, which raises SIGTTOU and
//    stops the job again, silently. Same as vim.
export const suspendForeground = (deps: SuspendDeps = {}): void => {
  const platform = deps.platform ?? process.platform
  const kill =
    deps.kill ??
    ((pid: number, signal: NodeJS.Signals) => {
      process.kill(pid, signal)
    })

  // SIGSTOP does not exist on Windows: `process.kill` there goes to uv_kill, which fails with ENOSYS
  // and THROWS. That throw would surface inside an Ink input handler → the ErrorBoundary →
  // `handleExit(error)` → the session shell would silently QUIT. And Windows really does reach this
  // code: `sessionGateEnabled` (lib/session/run-session.ts) gates on TTYs only, with no platform
  // check, so Windows Terminal enters the palette like any other. Belt to boot.tsx's braces.
  if (platform === 'win32') {
    return
  }

  // No cursor/newline work here, deliberately — that is the caller's job (see the preconditions
  // above): by the time we get here the cursor is already at column 0 on a clean row, so the shell's
  // "suspended" line lands there without a gratuitous blank gap above it.
  try {
    kill(0, 'SIGSTOP')
  } catch {
    // A stop we could not perform must degrade to a no-op, never to a crash: we are called mid
    // terminal-restore, and throwing here would take the session down with the tty half-handed-back.
  }
}
