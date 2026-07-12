import { render } from 'ink'
import process from 'node:process'
import type { ReactElement } from 'react'

import type { BranchPickerItem } from 'src/lib/prompts/types'

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
 * Ink `unref()`s process.stdin when it tears down raw mode on exit. That ref is
 * process-wide and never restored, so the next consumer of stdin — the Inquirer
 * prompt the selected command opens (e.g. the worktrees-remove checkbox), or a
 * SECOND Ink render in the same process (the bare-menu palette → picker hop) —
 * reads from an unref'd handle that no longer keeps the event loop alive. Once
 * the command's git/gh subprocesses settle, the loop drains mid-prompt, Node
 * flags entry/cli.ts's top-level await as unsettled, and the process exits with
 * code 13 (the prompt dies on arrival). Re-ref stdin on BOTH the resolve and the
 * reject path so it holds the loop while the next prompt is reading; an idle
 * ref'd stdin does not block exit, so non-interactive follow-up commands still
 * terminate normally. Every render must go through here so the re-ref is never
 * skipped.
 */
const renderToStderr = async (element: ReactElement): Promise<void> => {
  const { waitUntilExit } = render(element, {
    stdout: safeStderr(),
  })

  try {
    await waitUntilExit()
  } catch {
    // Swallow a teardown rejection: the caller reports cancellation via its own
    // captured sentinel (which stays at its initial value), not via a throw.
  } finally {
    process.stdin.ref()
  }
}

/**
 * Render the command palette and resolve to the chosen command name, or `null`
 * if the user cancels.
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
