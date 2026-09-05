import { describe, expect, it } from 'vitest'

import { buildProgram, commandPath } from 'src/lib/program'

import {
  LOW_RISK_MUTATING_ALLOWLIST,
  MCP_TOOL_PRESENTATION,
  MENU_GROUPS,
  NOT_READ_ONLY,
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
  'version',
  'worktrees-add',
  'worktrees-list',
  'reopen',
  'worktrees-remove',
  'worktrees-sync',
  'config-get',
  'dev-status',
  'local-deploy-all',
  'local-deploy-selected',
]

// Deliberately NOT exposed as MCP tools (mutating / host-inspecting / irreversible).
// release-deliver (prod delivery + admin-merge) is CLI-only by design; doctor is host-inspecting.
// worktrees-remove IS exposed — git protects tracked work and its own invariants (no MCP all=true,
// error on unmatched target) contain the residual risk.
const EXPECTED_UNEXPOSED_WITH_TOOL = ['doctor', 'gh-release-deliver']

/**
 * Credential commands that must carry NO MCP tool at all — not merely `mcpExposed: false`. The MCP
 * boundary injects `confirmedCommand: true` into every handler, so an agent must never be one call
 * away from writing or destroying a service token.
 */
const CREDENTIAL_WRITE_COMMANDS = ['env-token-set', 'env-token-remove']

describe('command catalog — MCP exposure policy', () => {
  it('exposes exactly the expected 23 MCP tools (set-equal, order-independent)', () => {
    const exposedNames = getExposedMcpTools()
      .map((tool) => {
        return tool.name
      })
      .sort()

    expect(exposedNames).toEqual([...EXPECTED_EXPOSED_TOOLS].sort())
    expect(exposedNames).toHaveLength(23)
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

  it('never exposes the irreversible release-deliver tool, but does expose worktrees-remove', () => {
    const exposedNames = new Set(
      getExposedMcpTools().map((tool) => {
        return tool.name
      }),
    )

    // release-deliver is genuinely irreversible (prod deploy + admin-merge) — stays CLI-only.
    expect(exposedNames.has('gh-release-deliver')).toBe(false)
    // worktrees-remove is exposed: git protects tracked work and the tool's own invariants (no MCP
    // all=true, error on unmatched target) contain the residual gitignored-deletion risk.
    expect(exposedNames.has('worktrees-remove')).toBe(true)
  })

  it('keeps doctor UNEXPOSED even though it has a tool', () => {
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

describe('command catalog — destructive-op confirm gate (default-deny)', () => {
  // The exact set of MCP tools that MUST be gated behind the two-call confirm flow. Pinning it here
  // (not just deriving it) makes a future mis-flag to `requiresHumanConfirm: undefined` red this test,
  // not merely the default-deny invariant below.
  const EXPECTED_GATED_TOOLS = [
    'gh-merge-dev',
    'release-create',
    'gh-release-deploy-all',
    'gh-release-deploy-selected',
    'env-clear',
    'worktrees-remove',
    // Writes to real cloud infrastructure from the developer's own machine, with no CI run to
    // inspect afterwards — the two-phase gate is the only thing standing between an agent and a
    // deploy it decided on by itself.
    'local-deploy-all',
    'local-deploy-selected',
  ]

  it('gates exactly the expected high-risk destructive tools with requiresHumanConfirm', () => {
    const gated = commandCatalog
      .flatMap((entry) => {
        return entry.mcpExposed && entry.mcpTool?.requiresHumanConfirm === true ? [entry.mcpTool.name] : []
      })
      .sort()

    expect(gated).toEqual([...EXPECTED_GATED_TOOLS].sort())
  })

  /**
   * The P1 invariant, fail-closed. Every mutating, MCP-exposed tool must EITHER carry
   * `requiresHumanConfirm` OR be an explicit, one-line-justified member of LOW_RISK_MUTATING_ALLOWLIST.
   * A future `mcpExposed: true` on a new mutating tool that sets neither reds CI — opting out of the
   * gate becomes a deliberate, greppable allowlist edit, never a silently-typed `false`.
   */
  it('leaves no mutating, exposed tool ungated unless it is on the low-risk allowlist', () => {
    const offenders = commandCatalog
      .filter((entry) => {
        return entry.mutating && entry.mcpExposed && entry.mcpTool?.requiresHumanConfirm !== true
      })
      .map((entry) => {
        return entry.cliName
      })
      .filter((cliName) => {
        return !LOW_RISK_MUTATING_ALLOWLIST.includes(cliName)
      })

    expect(offenders, `ungated mutating+exposed tools not on the allowlist: ${offenders.join(', ')}`).toEqual([])
  })

  /**
   * `audit` gained the CLI-only `--fix` / `--design` flags, which write into the repo. The catalog
   * entry must NOT follow them: the MCP handler forwards `params.all` / `params.root` by field and
   * `auditInputSchema` has no `fix` key, so the exposed tool is still read-only. Flipping this to
   * `mutating: true` (or letting the handler become a bare `handler: audit`) is the change the
   * ungated-mutating gate above cannot see for itself.
   */
  it('keeps `audit` exposed and non-mutating despite the CLI-only --fix flag', () => {
    const entry = commandCatalog.find((candidate) => {
      return candidate.cliName === 'audit'
    })

    expect(entry).toMatchObject({ mcpExposed: true, mutating: false })
  })

  // The allowlist is a safety escape hatch, not a dumping ground: every member must actually be a
  // mutating, MCP-exposed catalog entry that is NOT gated. A stale name (e.g. a tool that was later
  // gated or removed) would silently widen the escape hatch, so pin it.
  it('keeps every allowlist member a real, ungated, mutating, exposed entry', () => {
    for (const cliName of LOW_RISK_MUTATING_ALLOWLIST) {
      const entry = commandCatalog.find((candidate) => {
        return candidate.cliName === cliName
      })

      expect(entry, `${cliName} on the allowlist must exist in the catalog`).toBeDefined()
      expect(entry?.mutating, `${cliName} must be mutating to warrant allowlisting`).toBe(true)
      expect(entry?.mcpExposed, `${cliName} must be MCP-exposed to warrant allowlisting`).toBe(true)
      expect(
        entry?.mcpTool?.requiresHumanConfirm ?? false,
        `${cliName} is gated, so it should not be allowlisted`,
      ).toBe(false)
    }
  })
})

describe('command catalog — CLI/MCP name parity', () => {
  // The authoritative (cliName -> mcpName) map. Divergences are INTENTIONAL and
  // grandfathered here (the `gh-` prefix on release tools). Any new accidental
  // divergence — or a typo that renames an MCP tool — fails this test.
  const EXPECTED_PARITY: Record<string, string> = {
    'local-deploy-all': 'local-deploy-all',
    'local-deploy-selected': 'local-deploy-selected',
    'merge-dev': 'gh-merge-dev',
    'release-list': 'gh-release-list',
    'release-create': 'release-create',
    'release-desc-edit': 'release-desc-edit',
    'release-deploy-all': 'gh-release-deploy-all',
    'release-deploy-selected': 'gh-release-deploy-selected',
    'release-deliver': 'gh-release-deliver',
    'worktrees-add': 'worktrees-add',
    'worktrees-list': 'worktrees-list',
    reopen: 'reopen',
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
    'config-get': 'config-get',
    'dev-status': 'dev-status',
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
    expect(groupPaths('develop')).toEqual(['dev', 'dev-status'])

    expect(groupPaths('release')).toEqual([
      'release merge-dev',
      'release list',
      'release create',
      'release desc-edit',
      'release deploy-all',
      'release deploy-selected',
      'release deliver',
      // `local deploy-*` are absent by design: they are DEPRECATED aliases of
      // `release deploy-* --from local`, carrying `menuGroup: null` so the palette offers only
      // the merged commands. They remain in the catalog (and as MCP tools) and still resolve if typed.
    ])

    // `reopen` is top-level (groupPath ['reopen']) but carries menuGroup 'worktrees', so it renders in
    // this group between list and remove — exactly like env-status sits in the environment group.
    expect(groupPaths('worktrees')).toEqual([
      'worktrees add',
      'worktrees list',
      'reopen',
      'worktrees remove',
      'worktrees sync',
    ])

    // `Environment` is the Doppler env commands and nothing else. It used to be a 13-entry drawer that
    // also held config, vendor, and setup commands — the four groups below are what came out of it.
    expect(groupPaths('environment')).toEqual(['env-status', 'env-list', 'env-load', 'env-clear', 'env-token-list'])
    expect(groupPaths('configuration')).toEqual(['config-get', 'config path', 'config edit'])
    expect(groupPaths('vendor')).toEqual(['vendor check', 'vendor config'])
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

describe('command catalog — MCP tool annotations & titles', () => {
  /**
   * The catalog entry behind each exposed tool, keyed by MCP tool NAME (which is not always the
   * `cliName` — `merge-dev` registers as `gh-merge-dev`). The annotation derivation reads
   * `entry.mutating`, so the tests need the same join the derivation makes.
   */
  const entryByToolName = new Map(
    commandCatalog.flatMap((entry) => {
      return entry.mcpExposed && entry.mcpTool ? [[entry.mcpTool.name, entry] as const] : []
    }),
  )

  /**
   * T1 — REAL CONTENT. Catches a missing presentation row and an implementer setting
   * `annotations.title`. Cannot catch a title or hint that is merely WRONG.
   */
  it('t1: gives every exposed tool a display title and boolean hints, and never sets annotations.title', () => {
    for (const tool of getExposedMcpTools()) {
      expect(tool.title, `${tool.name} must carry a title`).toBeTruthy()
      expect(tool.title, `${tool.name}'s title must not restate its name`).not.toBe(tool.name)
      expect(typeof tool.annotations.readOnlyHint, `${tool.name}.readOnlyHint`).toBe('boolean')
      expect(typeof tool.annotations.openWorldHint, `${tool.name}.openWorldHint`).toBe('boolean')
      // Top-level `title` is the modern field; some hosts prefer `annotations.title` when present, so
      // setting both is a divergence waiting to happen.
      expect(tool.annotations, `${tool.name} must not carry annotations.title`).not.toHaveProperty('title')
    }
  })

  /**
   * T2 — REFACTOR DETECTOR, not a correctness test: it asserts the very formula that produced the
   * value. It fails when the derivation is replaced by hand-typed literals, which is the regression
   * worth catching here. Correctness for `readOnlyHint` comes from T5's cross-artifact check.
   */
  it('t2: derives readOnlyHint from `mutating`, tightened by NOT_READ_ONLY', () => {
    for (const tool of getExposedMcpTools()) {
      const entry = entryByToolName.get(tool.name)!

      expect(tool.annotations.readOnlyHint, `${tool.name}.readOnlyHint`).toBe(
        !entry.mutating && !NOT_READ_ONLY.includes(tool.name),
      )
    }
  })

  /**
   * T3 — REAL CONTENT, and the strongest unit test of the set: it fails in BOTH directions, so a new
   * exposed tool with no row and a stale row for a tool that was renamed or unexposed are each red.
   * It cannot judge whether an `openWorld` VALUE is right — nothing mechanical can; see the citation
   * discipline on MCP_TOOL_PRESENTATION.
   */
  it('t3: keeps MCP_TOOL_PRESENTATION and the exposed tool set in exact correspondence', () => {
    const exposed = getExposedMcpTools()
      .map((tool) => {
        return tool.name
      })
      .sort()

    expect(Object.keys(MCP_TOOL_PRESENTATION).sort()).toEqual(exposed)
  })

  /**
   * T4 — the omission halves are REAL CONTENT (they catch a meaningless hint leaking onto a read-only
   * tool, and `idempotentHint` being reintroduced without the argument that removed it). The
   * destructive half is a theorem given the derivation, and is asserted to pin it.
   */
  it('t4: omits destructiveHint on read-only tools, sets it on every write tool, and never ships idempotentHint', () => {
    for (const tool of getExposedMcpTools()) {
      if (tool.annotations.readOnlyHint) {
        expect(tool.annotations, `${tool.name} is read-only, so destructiveHint is meaningless`).not.toHaveProperty(
          'destructiveHint',
        )
      } else {
        expect(tool.annotations.destructiveHint, `${tool.name} is not read-only`).toBe(true)
      }

      expect(tool.annotations, `${tool.name} must not ship idempotentHint`).not.toHaveProperty('idempotentHint')
    }
  })

  /**
   * T5 — REAL CONTENT, and the only unit check that crosses to independently-authored data:
   * `requiresHumanConfirm` is written per-command under `src/commands/`, while `readOnlyHint` is
   * derived from the catalog's `mutating`. A tool gated in one artifact but read-only in the other
   * makes the two disagree, and this fires. Note the coverage limit: this independence holds for the
   * gated subset only, not for all thirteen write tools.
   */
  it('t5: makes every gated tool destructive without collapsing the two sets', () => {
    const tools = getExposedMcpTools()

    for (const tool of tools) {
      if (tool.requiresHumanConfirm === true) {
        expect(tool.annotations.destructiveHint, `gated ${tool.name} must read destructive`).toBe(true)
        expect(tool.annotations.readOnlyHint, `gated ${tool.name} must not read read-only`).toBe(false)
      }
    }

    // The converse must NOT hold. Allowlist membership is a gate decision ("is a confirm prompt
    // warranted?"); destructiveHint answers "does this perform destructive updates?". These two are
    // destructive yet deliberately ungated — if a future reader collapses the sets, this reds.
    for (const name of ['release-desc-edit', 'worktrees-sync']) {
      const tool = tools.find((candidate) => {
        return candidate.name === name
      })

      expect(tool?.annotations.destructiveHint, `${name} must read destructive`).toBe(true)
      expect(tool?.requiresHumanConfirm, `${name} must stay ungated`).not.toBe(true)
    }
  })

  /**
   * T7 — REAL CONTENT. Catches a stale name, and catches the array being used to LOOSEN a hint: a
   * member that is already `mutating: true` would be doing nothing, and a member that is not exposed
   * would be unreachable. The array may only ever tighten toward the spec default of
   * `readOnlyHint: false`.
   */
  it('t7: keeps every NOT_READ_ONLY member a real, exposed, non-mutating entry', () => {
    // Pinned BY NAME, because a `for…of` over the array cannot see the array shrinking: delete
    // 'reopen' and T7 loops zero times, T2 asserts a formula that moved with it, T4/T5 accept the
    // now-read-only tool, and T6 derives its expectation from the same source — nothing would red
    // while `reopen` silently started advertising `readOnlyHint: true`. `reopen` is `mutating: false`
    // yet its MCP-reachable `force` flag closes cmux workspaces, which is the whole reason the
    // exception exists.
    expect(NOT_READ_ONLY, 'reopen must stay excepted — its MCP-reachable `force` closes workspaces').toContain('reopen')

    const reopen = getExposedMcpTools().find((tool) => {
      return tool.name === 'reopen'
    })

    expect(reopen?.annotations.readOnlyHint, 'reopen must never advertise itself as read-only').toBe(false)

    for (const name of NOT_READ_ONLY) {
      const entry = entryByToolName.get(name)

      expect(entry, `${name} in NOT_READ_ONLY must be an exposed catalog tool`).toBeDefined()
      expect(entry?.mutating, `${name} is already mutating, so NOT_READ_ONLY does nothing for it`).toBe(false)
    }
  })
})
