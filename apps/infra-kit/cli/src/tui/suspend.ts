import process from 'node:process'

/**
 * Ctrl-Z at the palette, from the process side. React-free on purpose: the palette is pure
 * presentation and must not reach for `node:process`, and this half is worth unit-testing with plain
 * vitest (inject `kill`, assert the signal) rather than through an Ink frame.
 *
 * It lives under `src/tui/` rather than `src/lib/session/` because `boot.tsx` is its only caller and
 * the whole `src/tui/**` tree is the lazily-imported Ink chunk — the session layer never imports it,
 * and parking it there would drag it into the eager CLI chunk for nothing.
 */

/** Seams for the stop. Production passes nothing; tests inject fakes and assert the signal. */
export interface SuspendDeps {
  platform?: NodeJS.Platform
  kill?: (pid: number, signal: NodeJS.Signals) => void
}

/**
 * Stop the foreground PROCESS GROUP so the user's shell reclaims the tty and prints a prompt.
 * Returns when the job is resumed (`fg` → SIGCONT): the kill halts JS synchronously, and execution
 * continues at the next statement — so there is no SIGCONT handler and nothing to re-arm.
 *
 * **pid 0 is the whole process group, and that is load-bearing.** Under `pnpm exec infra-kit`, pnpm's
 * node wrapper shares our pgid and the interactive shell only ever waits on PNPM — we are a
 * grandchild it never reaps. Stopping only ourselves would leave pnpm blocked in `waitpid`, so the
 * job never reads as stopped, the shell never reclaims the tty, and the terminal wedges with no
 * prompt and no way back. Stopping the group suspends the job as a unit, exactly as the tty's own
 * Ctrl-Z would; on direct-bin invocation it degenerates to a self-stop, so this is one code path.
 *
 * Only ever called from inside Ink's `suspendTerminal`, which has already erased the frame, restored
 * the cursor and dropped raw mode by the time we get here.
 *
 * `bg` is NOT supported: on resume Ink re-arms raw mode, and a `tcsetattr` from a background process
 * group raises SIGTTOU, which stops the job again. Same as vim. Use `fg`.
 *
 * @example
 * const stopped: number[] = []
 * suspendForeground({ platform: 'darwin', kill: (pid) => stopped.push(pid) })
 * stopped // => [0]  (the process group, not process.pid)
 */
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

  // No cursor/newline work here, deliberately: Ink's `beginSuspend` has already erased its frame and
  // left the cursor at column 0, so the shell's "suspended" line lands on a clean row. Writing a
  // newline first only opens a gratuitous blank gap above it (verified on a real pty).
  try {
    kill(0, 'SIGSTOP')
  } catch {
    // A stop we could not perform must degrade to a no-op, never to a crash: we are called mid
    // terminal-restore, and throwing here would take the session down with the tty half-handed-back.
  }
}
