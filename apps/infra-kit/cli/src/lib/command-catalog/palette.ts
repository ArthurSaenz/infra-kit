import type { Command } from 'commander'

import { MENU_GROUPS, getMenuGroupEntries } from './command-catalog'

/**
 * The flat, grouped command list behind every no-arg surface: the Ink palette, the Inquirer fallback,
 * and the session shell. Membership and group ORDER come from the catalog's {@link MENU_GROUPS};
 * descriptions come from Commander, so there is exactly one source for each and no way to restate them
 * out of sync. (`entry/cli.ts` used to hardcode the group list three separate times.)
 */

/** One palette row: what to run, what it does, and which group header it sits under. */
export interface PaletteItem {
  /**
   * The command's canonical grouped path, space-joined (`release create`). It is BOTH the label the row
   * renders AND the argv every surface dispatches, so a row can no longer advertise one name and run
   * another — which is exactly what the old flat `release-create` label did.
   */
  name: string
  description: string
  group: string
}

/**
 * Resolve a catalog `groupPath` to its Commander leaf by walking the command tree one token at a time
 * (`['vendor','check']` → the `check` subcommand of `vendor`).
 *
 * A flat top-level lookup cannot reach a grouped leaf, and that limitation is the whole reason those
 * leaves used to need a hidden flat sibling (`vendor-check`) for the menu to find them. Walking the tree
 * removes the reason those aliases existed.
 *
 * @example
 * resolveLeaf(program.commands, ['vendor', 'check'])?.name() // => 'check'
 */
export const resolveLeaf = (roots: readonly Command[], groupPath: readonly string[]): Command | undefined => {
  let level: readonly Command[] = roots
  let found: Command | undefined

  for (const token of groupPath) {
    found = level.find((command) => {
      return command.name() === token
    })

    if (!found) return undefined

    level = found.commands
  }

  return found
}

/**
 * Build the palette rows from the registered Commander program, in MENU_GROUPS order.
 *
 * A catalog entry whose `groupPath` resolves to no Commander command is SKIPPED rather than rendered as
 * a dead row the user could pick and watch fail — the catalog test asserts every menu entry resolves to
 * a real leaf, so a skip here means that guard was bypassed, not that the row is legitimately absent.
 *
 * @example
 * buildPaletteItems(program.commands)[0] // => { name: 'dev', description: 'Run local dev servers…', group: 'Develop' }
 */
export const buildPaletteItems = (commands: readonly Command[]): PaletteItem[] => {
  return MENU_GROUPS.flatMap(({ key, label }) => {
    return getMenuGroupEntries(key).flatMap((entry) => {
      const command = resolveLeaf(commands, entry.groupPath)

      return command ? [{ name: entry.groupPath.join(' '), description: command.description(), group: label }] : []
    })
  })
}
