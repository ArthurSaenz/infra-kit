import { describe, expect, it } from 'vitest'

import { commandCatalog, getExposedMcpTools, getMenuGroupCommands } from '../command-catalog'

// The exact MCP tool surface that was hand-listed in src/mcp/tools/index.ts
// before the catalog refactor. The catalog must keep this byte-for-byte.
const EXPECTED_EXPOSED_TOOLS = [
  'env-status',
  'env-list',
  'env-load',
  'env-clear',
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

describe('command catalog — MCP exposure policy', () => {
  it('exposes exactly the expected 18 MCP tools (set-equal, order-independent)', () => {
    const exposedNames = getExposedMcpTools()
      .map((tool) => {
        return tool.name
      })
      .sort()

    expect(exposedNames).toEqual([...EXPECTED_EXPOSED_TOOLS].sort())
    expect(exposedNames).toHaveLength(18)
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
  it('preserves the three menu groups in display order', () => {
    expect(getMenuGroupCommands('release')).toEqual([
      'merge-dev',
      'release-list',
      'release-create',
      'release-desc-edit',
      'release-deploy-all',
      'release-deploy-selected',
      'release-deliver',
    ])

    expect(getMenuGroupCommands('worktrees')).toEqual([
      'worktrees-add',
      'worktrees-list',
      'worktrees-reload',
      'worktrees-remove',
      'worktrees-sync',
    ])

    expect(getMenuGroupCommands('environment')).toEqual([
      'audit',
      'vendor',
      'vendor-config',
      'doctor',
      'init',
      'version',
      'config',
      'env-status',
      'env-list',
      'env-load',
      'env-clear',
    ])
  })
})
