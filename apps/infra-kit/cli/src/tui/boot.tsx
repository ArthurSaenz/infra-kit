import { render } from 'ink'
import process from 'node:process'

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
 * Render the command palette and resolve to the chosen command name, or `null`
 * if the user cancels. Frames are written to stderr so stdout stays clean for
 * the command that runs afterwards (mirrors the previous Inquirer menu).
 */
export const runCommandPalette = async (items: PaletteItem[]): Promise<string | null> => {
  return new Promise((resolve) => {
    let selected: string | null = null

    const { waitUntilExit } = render(
      <CommandPalette
        items={items}
        onSelect={(name) => {
          selected = name
        }}
        onCancel={() => {
          selected = null
        }}
      />,
      { stdout: process.stderr as unknown as NodeJS.WriteStream },
    )

    // Ink `unref()`s process.stdin when it tears down raw mode on exit. That ref
    // is process-wide and never restored, so the next consumer of stdin — the
    // Inquirer prompt the selected command opens (e.g. the worktrees-remove
    // checkbox) — reads from an unref'd handle that no longer keeps the event
    // loop alive. Once the command's git/gh subprocesses settle, the loop drains
    // mid-prompt, Node flags entry/cli.ts's top-level await as unsettled, and the
    // process exits with code 13 (the prompt dies on arrival). Re-ref stdin so it
    // holds the loop while a prompt is reading; an idle ref'd stdin does not block
    // exit, so non-interactive follow-up commands still terminate normally.
    const restoreStdinRef = () => {
      process.stdin.ref()
    }

    waitUntilExit()
      .then(() => {
        restoreStdinRef()
        resolve(selected)
      })
      .catch(() => {
        restoreStdinRef()
        resolve(null)
      })
  })
}
