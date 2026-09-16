import { describe, expect, it } from 'vitest'

import { LOW_RISK_MUTATING_ALLOWLIST, commandCatalog } from 'src/lib/command-catalog/command-catalog'
import type { CommandCatalogEntry } from 'src/lib/command-catalog/command-catalog'

/**
 * @fileoverview
 *
 * Mutation check for the fail-closed gate invariant, retargeted at the one tool that installs software.
 *
 * `command-catalog.test.ts` asserts that no mutating command is ungated. That assertion passes
 * today — but it would also pass if it silently stopped covering `setup`, which is the failure mode an
 * invariant expressed as "the offender list is empty" always has. Here the entry is mutated and the
 * SAME predicate is asserted to name it.
 *
 * The original plan's PM-3 mutation — flipping `mcpTool: null` to an object — is obsolete: under the
 * risk axis this tool is deliberately exposed, so there is no `null` to flip. This is its replacement,
 * and it guards the property that actually holds now.
 *
 * The list is a list, and stays one: it held `setup-dependency` before that command was folded into
 * `setup`, and the next command that can install software belongs in it beside `setup`.
 */

/**
 * The inline predicate from `command-catalog.test.ts`'s fail-closed test, applied to a given catalog.
 * Keyed on `mutating` alone: every command is one `Bash(infra-kit …)` away, so `mcpExposed` (historical
 * — "was listed on the retired server") would only carve mutating commands OUT of the invariant.
 */
const ungatedOffenders = (catalog: readonly CommandCatalogEntry[]): string[] => {
  return catalog
    .filter((entry) => {
      return entry.mutating && entry.mcpTool?.requiresHumanConfirm !== true
    })
    .map((entry) => {
      return entry.cliName
    })
    .filter((cliName) => {
      return !LOW_RISK_MUTATING_ALLOWLIST.includes(cliName)
    })
}

const INSTALLERS = ['setup']

/** A copy of the catalog with `requiresHumanConfirm` stripped from one entry's tool. */
const withGateRemoved = (cliName: string): CommandCatalogEntry[] => {
  return commandCatalog.map((entry) => {
    if (entry.cliName !== cliName || entry.mcpTool === null) return entry

    return { ...entry, mcpTool: { ...entry.mcpTool, requiresHumanConfirm: undefined } }
  })
}

describe('the fail-closed gate actually covers the installing tools', () => {
  it('finds no offender in the real catalog', () => {
    expect(ungatedOffenders(commandCatalog)).toEqual([])
  })

  it.each(INSTALLERS)('names %s the moment its gate is removed', (cliName) => {
    expect(ungatedOffenders(withGateRemoved(cliName))).toEqual([cliName])
  })

  it.each(INSTALLERS)('would also catch %s being added to the low-risk allowlist', (cliName) => {
    // The allowlist ASSERTS low risk. Putting a command that installs software on it would be a false
    // claim, and it is the one edit that silences the gate without looking like a safety change —
    // so pin that no installer is on it.
    expect(LOW_RISK_MUTATING_ALLOWLIST).not.toContain(cliName)
  })

  it('keeps every installer mutating, so the invariant has something to bite on', () => {
    for (const cliName of INSTALLERS) {
      const entry = commandCatalog.find((candidate) => {
        return candidate.cliName === cliName
      })

      expect({ cliName, ...entry }).toMatchObject({ cliName, mutating: true })
    }
  })
})

describe('worktrees-remove stays behind the confirm gate', () => {
  it('declares requiresHumanConfirm on its catalog row', () => {
    // It deletes gitignored local state (a hydrated `.env`, node_modules) and is the one mutating
    // worktrees command NOT on the low-risk allowlist — so this flag is the only thing standing between
    // an agent's `--yes` re-run and the removal. Twin of the tool-level assertion; a row that lost the
    // flag would be named by `ungatedOffenders` above, but this says which row and why.
    const entry = commandCatalog.find((candidate) => {
      return candidate.cliName === 'worktrees-remove'
    })

    expect(entry).toMatchObject({
      cliName: 'worktrees-remove',
      menuGroup: 'worktrees',
      mutating: true,
      groupPath: ['worktrees', 'remove'],
    })
    expect(entry?.mcpTool?.requiresHumanConfirm).toBe(true)
  })
})
