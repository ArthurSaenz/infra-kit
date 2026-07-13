import type { Command } from 'commander'

import { MENU_GROUPS, getMenuGroupCommands } from './command-catalog'

/**
 * The flat, grouped command list behind every no-arg surface: the Ink palette, the Inquirer fallback,
 * and the session shell. Membership and group ORDER come from the catalog's {@link MENU_GROUPS};
 * descriptions come from Commander, so there is exactly one source for each and no way to restate them
 * out of sync. (`entry/cli.ts` used to hardcode the group list three separate times.)
 */

/** One palette row: what to run, what it does, and which group header it sits under. */
export interface PaletteItem {
  name: string
  description: string
  group: string
}

/**
 * Build the palette rows from the registered top-level Commander commands, in MENU_GROUPS order.
 *
 * A catalog name with no matching Commander command is SKIPPED rather than rendered as a dead row the
 * user could pick and watch fail — the catalog test asserts every menu entry resolves to a real leaf, so
 * a skip here means that guard was bypassed, not that the row is legitimately absent.
 *
 * @example
 * buildPaletteItems(program.commands)[0] // => { name: 'dev', description: 'Run local dev servers…', group: 'Develop' }
 */
export const buildPaletteItems = (commands: readonly Command[]): PaletteItem[] => {
  const byName = new Map(
    commands.map((command) => {
      return [command.name(), command]
    }),
  )

  return MENU_GROUPS.flatMap(({ key, label }) => {
    return getMenuGroupCommands(key).flatMap((name) => {
      const command = byName.get(name)

      return command ? [{ name, description: command.description(), group: label }] : []
    })
  })
}
