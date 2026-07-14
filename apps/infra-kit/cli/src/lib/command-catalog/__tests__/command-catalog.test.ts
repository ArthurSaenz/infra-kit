import { describe, expect, it } from 'vitest'

import { buildProgram, commandPath } from 'src/lib/program'

import {
  MENU_GROUPS,
  commandCatalog,
  getExposedMcpTools,
  getMenuGroupEntries,
  isLongRunningCommand,
} from '../command-catalog'
import type { CommandCatalogEntry } from '../command-catalog'
import { resolveLeaf } from '../palette'

/**
 * Every menu-eligible catalog entry, derived from MENU_GROUPS rather than a second hardcoded group list.
 * This is what keeps the guards below honest: a new group is covered by the leaf invariant and the
 * self-update/mcp exclusion the moment it is declared, with no test edit. A hardcoded list would go
 * quietly stale and stop checking the very commands a regrouping just added.
 */
const allMenuEntries = (): CommandCatalogEntry[] => {
  return MENU_GROUPS.flatMap(({ key }) => {
    return getMenuGroupEntries(key)
  })
}

/** The grouped paths of every menu-eligible command (`release create`) — what the menu shows and runs. */
const allMenuPaths = (): string[] => {
  return allMenuEntries().map((entry) => {
    return entry.groupPath.join(' ')
  })
}

// The exact MCP tool surface that was hand-listed in src/mcp/tools/index.ts
// before the catalog refactor. The catalog must keep this byte-for-byte.
const EXPECTED_EXPOSED_TOOLS = [
  'env-status',
  'env-list',
  'env-load',
  'env-clear',
  'env-token-list',
  'gh-merge-dev',
  'release-create',
  'release-desc-edit',
  'gh-release-deploy-all',
  'gh-release-deploy-selected',
  'gh-release-list',
  'audit',
  'vendor-check',
  'vendor-diff',
  'version',
  'worktrees-add',
  'worktrees-list',
  'worktrees-reload',
  'worktrees-sync',
]

// Deliberately NOT exposed as MCP tools (mutating / host-inspecting / irreversible).
// release-deliver (prod delivery + admin-merge) and worktrees-remove (rm -rf) are
// CLI-only by design.
const EXPECTED_UNEXPOSED_WITH_TOOL = [
  'doctor',
  'vendor-sync',
  'vendor-manifest',
  'gh-release-deliver',
  'worktrees-remove',
]

/**
 * Credential commands that must carry NO MCP tool at all — not merely `mcpExposed: false`. The MCP
 * boundary injects `confirmedCommand: true` into every handler, so an agent must never be one call
 * away from writing or destroying a service token.
 */
const CREDENTIAL_WRITE_COMMANDS = ['env-token-set', 'env-token-remove']

describe('command catalog — MCP exposure policy', () => {
  it('exposes exactly the expected 19 MCP tools (set-equal, order-independent)', () => {
    const exposedNames = getExposedMcpTools()
      .map((tool) => {
        return tool.name
      })
      .sort()

    expect(exposedNames).toEqual([...EXPECTED_EXPOSED_TOOLS].sort())
    expect(exposedNames).toHaveLength(19)
  })

  it('keeps env-token-set / env-token-remove off MCP entirely (no tool object to flip on)', () => {
    const exposedNames = new Set(
      getExposedMcpTools().map((tool) => {
        return tool.name
      }),
    )

    for (const cliName of CREDENTIAL_WRITE_COMMANDS) {
      const entry = commandCatalog.find((candidate) => {
        return candidate.cliName === cliName
      })

      expect(entry, `${cliName} must be in the catalog`).toBeDefined()
      expect(entry?.mcpTool, `${cliName} must carry no MCP tool`).toBeNull()
      expect(entry?.mcpExposed).toBe(false)
      expect(exposedNames.has(cliName)).toBe(false)
    }
  })

  it('never exposes the irreversible release-deliver / worktrees-remove tools', () => {
    const exposedNames = new Set(
      getExposedMcpTools().map((tool) => {
        return tool.name
      }),
    )

    expect(exposedNames.has('gh-release-deliver')).toBe(false)
    expect(exposedNames.has('worktrees-remove')).toBe(false)
  })

  it('keeps doctor, vendor-sync and vendor-manifest UNEXPOSED even though they have tools', () => {
    const exposedNames = new Set(
      getExposedMcpTools().map((tool) => {
        return tool.name
      }),
    )

    for (const unexposed of EXPECTED_UNEXPOSED_WITH_TOOL) {
      const entry = commandCatalog.find((candidate) => {
        return candidate.mcpTool?.name === unexposed
      })

      expect(entry, `catalog should carry a tool for ${unexposed}`).toBeDefined()
      expect(entry?.mcpExposed, `${unexposed} must stay unexposed`).toBe(false)
      expect(exposedNames.has(unexposed), `${unexposed} must not be registered`).toBe(false)
    }
  })

  it('every exposed entry carries a tool, and every entry with mcpExposed=true has one', () => {
    for (const entry of commandCatalog) {
      if (entry.mcpExposed) {
        expect(entry.mcpTool, `${entry.cliName} is exposed but has no tool`).not.toBeNull()
      }
    }
  })

  // The MCP boundary auto-confirms every tool: an agent must never be able to trigger an unattended
  // global package install, nor recursively launch the server it is already talking to.
  it('keeps self-update and mcp off the MCP surface and out of every menu group', () => {
    const exposedNames = new Set(
      getExposedMcpTools().map((tool) => {
        return tool.name
      }),
    )
    const menuNames = new Set(allMenuPaths())

    for (const cliName of ['self-update', 'mcp']) {
      const entry = commandCatalog.find((candidate) => {
        return candidate.cliName === cliName
      })

      expect(entry, `${cliName} must be in the catalog`).toBeDefined()
      expect(entry?.mcpTool).toBeNull()
      expect(entry?.mcpExposed).toBe(false)
      expect(entry?.menuGroup).toBeNull()
      expect(exposedNames.has(cliName)).toBe(false)
      expect(menuNames.has(cliName)).toBe(false)
    }
  })

  it('mcpTool name matches a stable identifier (no duplicate registrations)', () => {
    const names = getExposedMcpTools().map((tool) => {
      return tool.name
    })

    expect(new Set(names).size).toBe(names.length)
  })

  // Golden snapshot of the registered MCP surface: tool name + input/output
  // schema field names. Locks names AND schema shape so any accidental change to
  // the exposed tools/list fails CI (the "tools/list identical" guardrail).
  it('matches the golden MCP tools/list surface (names + schema shape)', () => {
    const surface = getExposedMcpTools()
      .map((tool) => {
        return {
          name: tool.name,
          input: Object.keys(tool.inputSchema).sort(),
          output: Object.keys(tool.outputSchema).sort(),
        }
      })
      .sort((a, b) => {
        return a.name.localeCompare(b.name)
      })

    expect(surface).toMatchSnapshot()
  })
})

describe('command catalog — CLI/MCP name parity', () => {
  // The authoritative (cliName -> mcpName) map. Divergences are INTENTIONAL and
  // grandfathered here (the `gh-` prefix on release tools). Any new accidental
  // divergence — or a typo that renames an MCP tool — fails this test.
  const EXPECTED_PARITY: Record<string, string> = {
    'merge-dev': 'gh-merge-dev',
    'release-list': 'gh-release-list',
    'release-create': 'release-create',
    'release-desc-edit': 'release-desc-edit',
    'release-deploy-all': 'gh-release-deploy-all',
    'release-deploy-selected': 'gh-release-deploy-selected',
    'release-deliver': 'gh-release-deliver',
    'worktrees-add': 'worktrees-add',
    'worktrees-list': 'worktrees-list',
    'worktrees-reload': 'worktrees-reload',
    'worktrees-remove': 'worktrees-remove',
    'worktrees-sync': 'worktrees-sync',
    audit: 'audit',
    doctor: 'doctor',
    version: 'version',
    'env-status': 'env-status',
    'env-list': 'env-list',
    'env-load': 'env-load',
    'env-clear': 'env-clear',
    'env-token-list': 'env-token-list',
    'vendor-check': 'vendor-check',
    'vendor-diff': 'vendor-diff',
    'vendor-manifest': 'vendor-manifest',
    'vendor-sync': 'vendor-sync',
  }

  it('every catalog entry with a tool matches its expected (cliName, mcpName) pair', () => {
    const actualParity: Record<string, string> = {}

    for (const entry of commandCatalog) {
      if (entry.mcpTool) {
        actualParity[entry.cliName] = entry.mcpTool.name
      }
    }

    expect(actualParity).toEqual(EXPECTED_PARITY)
  })
})

describe('command catalog — menu grouping', () => {
  const groupPaths = (group: Parameters<typeof getMenuGroupEntries>[0]): string[] => {
    return getMenuGroupEntries(group).map((entry) => {
      return entry.groupPath.join(' ')
    })
  }

  it('preserves each menu group in display order, as grouped paths', () => {
    expect(groupPaths('develop')).toEqual(['dev'])

    expect(groupPaths('release')).toEqual([
      'release merge-dev',
      'release list',
      'release create',
      'release desc-edit',
      'release deploy-all',
      'release deploy-selected',
      'release deliver',
    ])

    expect(groupPaths('worktrees')).toEqual([
      'worktrees add',
      'worktrees list',
      'worktrees reload',
      'worktrees remove',
      'worktrees sync',
    ])

    // `Environment` is the Doppler env commands and nothing else. It used to be a 13-entry drawer that
    // also held config, vendor, and setup commands — the four groups below are what came out of it.
    expect(groupPaths('environment')).toEqual(['env-status', 'env-list', 'env-load', 'env-clear', 'env-token-list'])
    expect(groupPaths('configuration')).toEqual(['config path', 'config edit'])
    expect(groupPaths('vendor')).toEqual(['vendor check', 'vendor diff', 'vendor config'])
    expect(groupPaths('setup')).toEqual(['init', 'doctor', 'audit', 'version'])
  })

  /**
   * `dev` is the only long-running command. The flag drives TWO things that must never drift apart: the
   * `postAction` report is suppressed for it (its action resolves at boot, so a report would claim a
   * verdict the server has not produced), and `classifyOutcome` reads its `128 + signo` exit as a cancel
   * rather than a failure. Keyed by the SPACE-JOINED Commander path, which is what `postAction` is handed.
   */
  it('marks dev — and only dev — as long-running, keyed by its Commander path', () => {
    expect(isLongRunningCommand('dev')).toBe(true)

    // Every other menu command does a unit of work and exits: it must still write its report.
    for (const path of allMenuPaths()) {
      if (path === 'dev') continue

      expect(isLongRunningCommand(path), `"${path}" must not be long-running`).toBe(false)
    }
  })

  it('does not match an unknown path', () => {
    expect(isLongRunningCommand('nope')).toBe(false)
    expect(isLongRunningCommand('')).toBe(false)
  })

  /**
   * The report suppression only fires if the string `postAction` COMPUTES (`commandPath(actionCommand)`)
   * equals the string the catalog MATCHES (`groupPath.join(' ')`). Asserting against a hand-typed `'dev'`
   * would pin neither. This resolves the real Commander leaf out of a real program and feeds it through
   * the real `commandPath`, so the two sides are pinned to each other rather than to my assumption.
   *
   * The trap this used to guard — a command registered BOTH grouped and as a flat alias, producing two
   * different `commandPath()` strings for one command — is now structurally impossible: the CLI registers
   * the grouped form only. The test stays because it pins the computed string to the matched one, which
   * is what the report suppression actually depends on.
   */
  it('agrees with the real commandPath() the postAction hook feeds it', () => {
    const leaf = buildProgram().commands.find((command) => {
      return command.name() === 'dev'
    })

    expect(leaf, 'dev must be a registered top-level command').toBeDefined()
    expect(commandPath(leaf!)).toBe('dev')
    expect(isLongRunningCommand(commandPath(leaf!))).toBe(true)
  })

  // A group with no commands renders a dangling `— Label —` header over nothing. Cheap to assert once
  // the group list is data, and it is the failure mode of a rename that misses the catalog entries.
  it('every declared menu group has at least one command', () => {
    for (const { key, label } of MENU_GROUPS) {
      expect(getMenuGroupEntries(key), `group "${label}" would render an empty header`).not.toHaveLength(0)
    }
  })

  // NOTE: there is deliberately NO "entry names an undeclared group" test — `menuGroup` is typed
  // `MenuGroup | null` and `MenuGroup` is DERIVED from MENU_GROUPS, so an undeclared group is a compile
  // error. A runtime assertion there could never fail; it would read as coverage while checking nothing.

  // Every menu-eligible catalog entry MUST resolve to a Commander leaf (an action, no subcommands).
  // A bare group (`vendor`, `config`) prints help and exits non-zero, which the session shell would
  // misreport as a failure. This guard is what makes "menu-eligible ⇒ leaf" a structural invariant
  // rather than an assertion. It walks a freshly-built, side-effect-free program (buildProgram).
  //
  // It resolves through the group tree, which is the change that let the flat aliases go: this used to
  // demand a TOP-LEVEL command per menu entry, and that demand is precisely why grouped leaves needed a
  // hidden flat sibling (`vendor-check`) to be menu-eligible at all.
  it('every menu-eligible command resolves to a Commander leaf (action, no subcommands)', () => {
    const program = buildProgram()

    for (const entry of allMenuEntries()) {
      const path = entry.groupPath.join(' ')
      const cmd = resolveLeaf(program.commands, entry.groupPath)

      expect(cmd, `menu entry "${path}" must resolve to a registered command`).toBeDefined()
      expect(cmd!.commands, `menu entry "${path}" must be a leaf (no subcommands)`).toHaveLength(0)
    }
  })

  // The flat surface is GONE, not hidden: a hidden command still parses, so `infra-kit release-create`
  // would keep working and the deprecation would never actually land. Commander must reject it outright.
  it('registers no flat alias for any grouped command — not even a hidden one', () => {
    const topLevel = new Set(
      buildProgram().commands.map((cmd) => {
        return cmd.name()
      }),
    )

    for (const entry of commandCatalog) {
      if (entry.groupPath.length < 2) continue

      expect(topLevel.has(entry.cliName), `"${entry.cliName}" is still registered as a flat command`).toBe(false)
    }
  })

  it('every catalog entry carries a groupPath whose first token is a real top-level command', () => {
    const program = buildProgram()
    const topLevel = new Set(
      program.commands.map((cmd) => {
        return cmd.name()
      }),
    )

    for (const entry of commandCatalog) {
      expect(entry.groupPath.length, `${entry.cliName} groupPath must be non-empty`).toBeGreaterThan(0)
      expect(topLevel.has(entry.groupPath[0]!), `${entry.cliName} groupPath[0] must be a top-level command`).toBe(true)
    }
  })
})
