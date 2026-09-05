import { render } from 'ink'
import process from 'node:process'
import type { ReactElement } from 'react'

import { stdinReaderCount } from 'src/lib/prompts/stdin-ref'
import type { BranchPickerItem } from 'src/lib/prompts/types'
import { suspendForeground } from 'src/lib/session/suspend-foreground'

import { safeStderr } from './safe-stderr'
import { BranchMultiPicker } from './screens/branch-multi-picker'
import { BranchPicker } from './screens/branch-picker'
import { CommandPalette } from './screens/command-palette'
import type { PaletteItem } from './types'

/**
 * Entry point for the Ink TUI. This module (and everything under `src/tui/`) is
 * the ONLY place allowed to import `ink`/`react`; it is reached exclusively via a
 * dynamic `await import('src/tui/boot')` from the TTY branch of entry/cli.ts, so
 * React never loads on the MCP / `--json` / non-TTY paths. Build splitting keeps
 * it in a separate lazy chunk (see scripts/build.js).
 */

/**
 * Render an Ink element to stderr and resolve once it tears down. Frames are
 * written to stderr so stdout stays clean for the command that runs afterwards
 * (mirrors the previous Inquirer menu).
 *
 * STDIN — Ink is self-balancing (it refs when it arms raw mode, unrefs on teardown), so the common
 * paths need nothing from here. The re-assert below is CONDITIONAL on the reader counter and is a
 * net for the one case Ink cannot see: an Ink screen rendered INSIDE a `withEscape` callback, whose
 * teardown would unref the handle the outer prompt is still reading from and kill it with exit 13.
 * See lib/prompts/stdin-ref.
 */
// Where the balance comes from: ink/build/components/App.js:225 (`ref` on raw mode) and :137
// (`unref` on teardown). A later Ink render refs itself again on mount, and an `@inquirer/*`
// prompt — which refs nothing on its own — gets its ref from `withEscape`. The re-assert is a net
// for a boundary nothing structurally enforces, not the mechanism that keeps prompts alive.
//
// It replaces an UNCONDITIONAL `process.stdin.ref()`, whose stated premise — "an idle ref'd stdin
// does not block exit" — is simply false: a ref'd tty ReadStream holds the event loop open whether
// or not anything is listening to it. That re-ref bought the next prompt its handle and cost the
// session shell its exit, so every quit key in the palette tore the frame down correctly and then
// hung forever.
const renderToStderr = async (element: ReactElement): Promise<void> => {
  const stdout = safeStderr()
  const { waitUntilExit } = render(element, {
    stdout,
    // Ink's default is `exitOnCtrlC: true`, which intercepts the 0x03 byte in its own App and calls
    // `handleExit()` BEFORE it ever reaches `useInput`. That makes every screen's own ctrl+c branch
    // dead code, and — worse — it tears down on the CURRENT frame, so `log.done()` freezes the drawn
    // command list into the scrollback instead of erasing it (Esc, which goes through the screens'
    // own quit path, erases correctly; Ctrl-C left a corpse). Every screen rendered here already
    // handles ctrl+c itself, so hand them the key.
    exitOnCtrlC: false,
    // Ink's default is `!isInCi && stdout.isTTY`. We drop the isInCi term: a developer with CI
    // exported in their shell would otherwise get a NON-interactive Ink on a real terminal, and Ink
    // skips ALL terminal management in that mode — `beginSuspend` returns before it can drop raw mode
    // or erase the frame, and `endSuspend` never redraws. Ctrl-Z would hand the shell a raw-mode tty
    // with a stranded frame and a hidden cursor, and `fg` would come back to nothing. Whether we own
    // the terminal is a question about the tty, and only about the tty.
    interactive: Boolean(stdout.isTTY),
  })

  try {
    await waitUntilExit()
  } catch {
    // Swallow a teardown rejection: the caller reports cancellation via its own
    // captured sentinel (which stays at its initial value), not via a throw.
  } finally {
    if (stdinReaderCount() > 0) {
      process.stdin.ref()
    } else {
      // STOP READING, not just "stop holding the loop open". `unref()` answers "may node exit?", not
      // "is anyone still consuming this fd?" — and Ink's teardown only drops its `readable` listener
      // and unrefs (App.js:136-137). The session shell then spawns the next command with
      // `stdio: 'inherit'`, so parent and child hold the SAME tty and each keystroke goes to exactly
      // one of them. Left unpaused, the parent wins often enough to eat the user's Esc; the child then
      // never cancels, `waitForExit` never resolves, and `childOwnsSigint` (lib/session/run-session)
      // swallows every Ctrl-C that follows. That is the "Esc worked, then nothing does" wedge.
      //
      // WHY `pause()` REACHES libuv AT ALL — it looks inert, and on a generic stream it is. The chain:
      //   1. `Readable.prototype.pause()` (node internal/streams/readable.js) emits `'pause'` ONLY IF
      //      `readableFlowing !== false`.
      //   2. `process.stdin` — and ONLY `process.stdin`, ONLY on the main thread — carries a `'pause'`
      //      listener installed by node's bootstrap (internal/bootstrap/switches/is_main_thread.js:263).
      //   3. That listener defers to `onpause` (:267), which calls `stdin._handle.readStop()` (:273).
      // `net.Socket.prototype.pause` never calls `readStop` itself (it does so only under `kBuffer`,
      // which is unset here), so a harness built on a CONSTRUCTED `tty.ReadStream`, or run in a worker
      // thread, measures a stream with ZERO `'pause'` listeners and correctly reports no effect. That
      // is a false negative about a different object, not evidence against this line.
      //
      // THE PRECONDITION, AND WHY THIS CALL SITE MEETS IT — Ink reads via a `readable` listener
      // (App.js:206, removed at :126), where `readableFlowing === false`, which would fail step 1 and
      // make this a silent no-op. It does not, because `removeListener('readable')` schedules
      // `updateReadableListening` on the NEXTTICK queue (clearing flowing to `null`), while this
      // `finally` runs in the PROMISE MICROTASK behind `await waitUntilExit()` above — and node drains
      // nextTick before microtasks. Ink resolves no earlier than it detaches (App.js:126 <- unmount
      // ink.js:300 <- resolveExitPromise ink.js:580). Measured on a pty: synchronous call => 0 `'pause'`
      // events, 0 readStops; behind the await => 1 and 1, flowing `null`, 3/3.
      //
      // SO: KEEP THIS BEHIND THE `await`. Making it synchronous silently disarms it with every test
      // still green — which is what src/tui/__tests__/stdin-pause-semantics.test.ts exists to catch.
      // Deferring it by a tick is NOT a hardening: `readStop` already lands after the `spawn` in
      // run-session.ts (pause -> spawn -> readStop) and deferring only widens that window. Verified
      // against ink 7.1.0; if Ink ever resolves before detaching, this reverts to a no-op.
      process.stdin.pause()
    }
  }
}

/**
 * Render the command palette and resolve to the chosen command name, or `null`
 * if the user cancels. A Ctrl-Z suspends the job and resolves nothing — the same
 * palette redraws, filter and all, when the user brings it back with `fg`.
 */
export const runCommandPalette = async (items: PaletteItem[]): Promise<string | null> => {
  let selected: string | null = null

  await renderToStderr(
    <CommandPalette
      items={items}
      onSelect={(name) => {
        selected = name
      }}
      onCancel={() => {
        selected = null
      }}
      // This module is the platform authority: `undefined` tells the palette that suspending is
      // impossible here, so it neither binds Ctrl-Z nor advertises it in the footer. (`suspendForeground`
      // guards win32 again on its own — the palette itself must stay free of `process`.)
      onSuspend={
        process.platform === 'win32'
          ? undefined
          : () => {
              suspendForeground()
            }
      }
    />,
  )

  return selected
}

/**
 * Render the searchable single-select branch picker and resolve to the chosen
 * value, or `null` if the user cancels.
 */
export const runBranchPicker = async (items: BranchPickerItem[]): Promise<string | null> => {
  let selected: string | null = null

  await renderToStderr(
    <BranchPicker
      items={items}
      onSelect={(value) => {
        selected = value
      }}
      onCancel={() => {
        selected = null
      }}
    />,
  )

  return selected
}

/**
 * Render the searchable multi-select branch picker and resolve to the chosen
 * values, or `null` if the user cancels. The captured variable starts as `null`
 * and is only assigned an array in `onSubmit`, so a cancel is distinguishable
 * from an empty submit.
 */
export const runBranchMultiPicker = async (
  items: BranchPickerItem[],
  opts?: { required?: boolean; allowSelectAll?: boolean },
): Promise<string[] | null> => {
  let selected: string[] | null = null

  await renderToStderr(
    <BranchMultiPicker
      items={items}
      required={opts?.required}
      allowSelectAll={opts?.allowSelectAll}
      onSubmit={(values) => {
        selected = values
      }}
      onCancel={() => {
        selected = null
      }}
    />,
  )

  return selected
}
