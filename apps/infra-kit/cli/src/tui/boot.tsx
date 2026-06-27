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

    waitUntilExit()
      .then(() => {
        resolve(selected)
      })
      .catch(() => {
        resolve(null)
      })
  })
}
