import { describe, expect, it } from 'vitest'

import { buildProgram } from 'src/lib/program'

import { MENU_GROUPS, getMenuGroupEntries } from '../command-catalog'
import { buildPaletteItems, resolveLeaf } from '../palette'

/**
 * The palette as the user actually sees it, built from the real Commander program. This is the assertion
 * that the three previously-hardcoded group lists in `entry/cli.ts` could not make: it walks the SAME
 * function production calls, so a group that is declared but unreachable — or a command that lost its
 * Commander registration — fails here rather than silently vanishing from the menu.
 */
const palette = () => {
  return buildPaletteItems(buildProgram().commands)
}

/** The rendered shape: group headers in order, each followed by its commands. */
const groupedNames = (): [string, string[]][] => {
  const groups: [string, string[]][] = []

  for (const item of palette()) {
    const last = groups.at(-1)

    if (last && last[0] === item.group) {
      last[1].push(item.name)
    } else {
      groups.push([item.group, [item.name]])
    }
  }

  return groups
}

describe('command palette', () => {
  // Every row is labelled with the command's GROUPED path — the exact argv the pick dispatches. The
  // palette used to label these `release-create` / `vendor-check` while running `release create`, i.e. it
  // taught a name the CLI now does not accept. A regression to the flat labels fails right here.
  it('renders seven honest groups, labelled with the grouped path it actually runs', () => {
    expect(groupedNames()).toEqual([
      ['Develop', ['dev', 'dev-status']],
      [
        'Release Management',
        [
          'release merge-dev',
          'release list',
          'release create',
          'release desc-edit',
          'release deploy-all',
          'release deploy-selected',
          'release deliver',
        ],
      ],
      ['Worktrees', ['worktrees add', 'worktrees list', 'reopen', 'worktrees remove', 'worktrees sync']],
      ['Environment', ['env-status', 'env-list', 'env-load', 'env-clear', 'env-token-list']],
      ['Configuration', ['config-get', 'config path', 'config edit']],
      ['Vendor', ['vendor check', 'vendor config']],
      ['Setup & Diagnostics', ['init', 'doctor', 'audit', 'version']],
    ])
  })

  // The row label must be argv, verbatim: `entry/cli.ts` splits it on spaces and hands the tokens to
  // Commander. A label carrying anything Commander would not parse (a flat `release-create`, a stray
  // separator) makes the pick fail at dispatch, which no snapshot of the label alone would catch.
  it('labels every row with tokens Commander can parse back into a command', () => {
    for (const item of palette()) {
      const leaf = resolveLeaf(buildProgram().commands, item.name.split(' '))

      expect(leaf, `"${item.name}" does not resolve back to a Commander leaf`).toBeDefined()
      expect(leaf!.commands, `"${item.name}" is a group, not a runnable leaf`).toHaveLength(0)
    }
  })

  // `dev` was previously the ONLY command missing from the menu, hidden behind a rationale that described
  // the long-dead in-process Inquirer menu. It is the command most people open the menu for.
  it('includes the dev server as the very first row', () => {
    const first = palette()[0]

    expect(first?.name).toBe('dev')
    expect(first?.group).toBe('Develop')
    expect(first?.description).toBeTruthy()
  })

  // A blank description renders an aligned row with an empty right column — it means a command was
  // registered in Commander without `.description()`, which only shows up in the menu.
  it('gives every row a non-empty description (the palette renders it as the right column)', () => {
    for (const item of palette()) {
      expect(item.description, `"${item.name}" has no description`).not.toBe('')
    }
  })

  it('never renders the same command twice', () => {
    const names = palette().map((item) => {
      return item.name
    })

    expect(names).toHaveLength(new Set(names).size)
  })

  // The builder SKIPS a catalog name with no matching Commander command, so asserting over its OUTPUT
  // would be a tautology — every emitted row is registered by construction. The real risk is a silent
  // DROP, so assert over the INPUT: every menu-eligible catalog name must survive into the palette.
  it('drops nothing: every menu-eligible catalog name reaches the palette', () => {
    const emitted = new Set(
      palette().map((item) => {
        return item.name
      }),
    )

    for (const { key, label } of MENU_GROUPS) {
      for (const entry of getMenuGroupEntries(key)) {
        const name = entry.groupPath.join(' ')

        expect(emitted.has(name), `"${name}" (${label}) was dropped from the palette`).toBe(true)
      }
    }
  })
})
