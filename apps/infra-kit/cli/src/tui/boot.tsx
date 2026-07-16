import { render } from 'ink'
import process from 'node:process'
import type { ReactElement } from 'react'

import { stdinReaderCount } from 'src/lib/prompts/stdin-ref'
import type { BranchPickerItem } from 'src/lib/prompts/types'

import { safeStderr } from './safe-stderr'
import { BranchMultiPicker } from './screens/branch-multi-picker'
import { BranchPicker } from './screens/branch-picker'
import { CommandPalette } from './screens/command-palette'
import { suspendForeground } from './suspend'
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
 * STDIN — Ink is self-balancing: it `ref()`s when it arms raw mode and `unref()`s when it
 * drops it on teardown (ink/build/components/App.js:225 / :137). A later Ink render refs
 * itself again on mount, and an `@inquirer/*` prompt — which refs nothing on its own — now
 * gets its ref from `withEscape` (lib/prompts/stdin-ref). So the common paths need nothing
 * from us here.
 *
 * The one thing Ink's `unref()` cannot know about is a reader that is ALREADY live: an Ink
 * screen rendered inside a `withEscape` callback would, on teardown, unref the handle the
 * outer prompt is still reading from and kill it with exit 13. Hence the re-assert below,
 * conditional on the counter. It is a net for a boundary nothing structurally enforces —
 * see lib/prompts/stdin-ref — not the mechanism that keeps prompts alive.
 *
 * It replaces an UNCONDITIONAL `process.stdin.ref()`, whose stated premise — "an idle
 * ref'd stdin does not block exit" — is simply false: a ref'd tty ReadStream holds the
 * event loop open whether or not anything is listening to it. That re-ref bought the next
 * prompt its handle and cost the session shell its exit, so every quit key in the palette
 * tore the frame down correctly and then hung forever.
 */
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
    if (stdinReaderCount() > 0) process.stdin.ref()
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
