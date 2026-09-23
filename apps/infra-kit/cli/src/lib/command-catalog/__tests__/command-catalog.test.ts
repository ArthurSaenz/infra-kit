import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { mutatingCommandsReachedBy } from 'src/commands/doctor/agent-allowlist'
import { buildProgram, commandPath } from 'src/lib/program'

import {
  LOW_RISK_MUTATING_ALLOWLIST,
  MENU_GROUPS,
  commandCatalog,
  getMenuGroupEntries,
  isLongRunningCommand,
} from '../command-catalog'
import type { CommandCatalogEntry } from '../command-catalog'
import { resolveLeaf } from '../palette'

/**
 * Every menu-eligible catalog entry, derived from MENU_GROUPS rather than a second hardcoded group list.
 * This is what keeps the guards below honest: a new group is covered by the leaf invariant and the
 * `mcp` exclusion the moment it is declared, with no test edit. A hardcoded list would go quietly stale
 * and stop checking the very commands a regrouping just added.
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

// The rows flagged `mcpExposed` — the set the retired MCP server registered. The field is historical
// and unread at runtime (an agent reaches every command over Bash), so this list pins the VALUES until
// the field is removed: a flip has to be a deliberate edit here, never a silent side effect of a
// catalog change.
const EXPECTED_EXPOSED_TOOLS = [
  'setup',
  'env-status',
  'env-list',
  'env-load',
  'env-clear',
  'env-token-list',
  'gh-merge-dev',
  'release-create',
  'release-edit',
  'gh-release-deploy-all',
  'gh-release-deploy-selected',
  'gh-release-list',
  'audit',
  'vendor-check',
  'version',
  'worktrees-add',
  'worktrees-list',
  'worktrees-remove',
  'worktrees-sync',
  'config-get',
  'dev-status',
  'local-deploy-all',
  'local-deploy-selected',
  'release-remove',
  // The read half of the two-command setup surface. Exposed with `mutating: false`, which is a claim
  // about the TOOL: `--fix` is CLI-only and unreachable through an empty `inputSchema`.
  'doctor',
]

// Has a tool but was never listed on the server: prod delivery + admin-merge is irreversible, so it
// stayed CLI-only. worktrees-remove WAS listed — git protects tracked work and its own invariants (no
// agent `all: true`, error on an unmatched target) contain the residual risk.
const EXPECTED_UNEXPOSED_WITH_TOOL = ['gh-release-deliver']

/**
 * Credential commands that must carry NO tool definition at all — not merely `mcpExposed: false` — so
 * no agent-facing seam (form provider, `argument_required` refusal, confirm gate) can ever be wired to
 * writing or destroying a service token.
 */
const CREDENTIAL_WRITE_COMMANDS = ['env-token-set', 'env-token-remove']

/** Tool names of the rows flagged `mcpExposed` — the historical registration set, pinned. */
const exposedToolNames = (): string[] => {
  return commandCatalog.flatMap((entry) => {
    return entry.mcpExposed && entry.mcpTool ? [entry.mcpTool.name] : []
  })
}

describe('command catalog — mcpExposed values (historical, pinned)', () => {
  it('flags exactly the expected 25 rows mcpExposed (set-equal, order-independent)', () => {
    const exposedNames = exposedToolNames().sort()

    expect(exposedNames).toEqual([...EXPECTED_EXPOSED_TOOLS].sort())
    // 25: `setup-dependency` and `setup-dependency-status` folded into the single `setup` tool
    // (26 → 25), then `doctor` was exposed (25 → 26), then `reopen` was removed (26 → 25).
    expect(exposedNames).toHaveLength(25)
  })

  it('keeps env-token-set / env-token-remove without a tool entirely (no tool object to flip on)', () => {
    for (const cliName of CREDENTIAL_WRITE_COMMANDS) {
      const entry = commandCatalog.find((candidate) => {
        return candidate.cliName === cliName
      })

      expect(entry, `${cliName} must be in the catalog`).toBeDefined()
      expect(entry?.mcpTool, `${cliName} must carry no tool`).toBeNull()
      expect(entry?.mcpExposed).toBe(false)
    }
  })

  it('keeps release-deliver mcpExposed: false even though it has a tool', () => {
    for (const unexposed of EXPECTED_UNEXPOSED_WITH_TOOL) {
      const entry = commandCatalog.find((candidate) => {
        return candidate.mcpTool?.name === unexposed
      })

      expect(entry, `catalog should carry a tool for ${unexposed}`).toBeDefined()
      expect(entry?.mcpExposed, `${unexposed} must stay unexposed`).toBe(false)
    }
  })

  it('every entry with mcpExposed=true carries a tool', () => {
    for (const entry of commandCatalog) {
      if (entry.mcpExposed) {
        expect(entry.mcpTool, `${entry.cliName} is exposed but has no tool`).not.toBeNull()
      }
    }
  })

  it('tool names are unique across the catalog (no two rows answer to one name)', () => {
    const names = commandCatalog.flatMap((entry) => {
      return entry.mcpTool ? [entry.mcpTool.name] : []
    })

    expect(new Set(names).size).toBe(names.length)
  })
})

/**
 * The plugin's skills drive the CLI over Bash now (`.omc/plans/mcp-to-cli-skills-migration.md` §3.9):
 * a SKILL.md that still names an MCP tool — plugin-prefixed or the legacy `mcp__infra-kit__` route —
 * sends every session that invokes it to a tool it does not have, and nothing in the plugin's own suite
 * (plain node, no path into this package) can cross-check the argv it names against the catalog.
 *
 * The scan patterns are read from the plugin suite's fixture rather than spelled here: they are the one
 * definition of "names a tool" that `manifest.test.mjs` and `scripts/report-published-cli-skew.mjs`
 * also read, so the scans cannot drift on what counts as a mention.
 */
describe('command catalog — the plugin skills name no MCP tool and allow only read-only argv', () => {
  const REPO_ROOT = path.resolve(import.meta.dirname, '../../../../../../..')
  const PLUGIN_ROOT = path.join(REPO_ROOT, 'plugins', 'infra-kit')
  const SKILLS_DIR = path.join(PLUGIN_ROOT, 'skills')

  interface ScanPatterns {
    pluginToolName: string
    legacyToolPrefix: string[][]
  }

  const scanPatterns = (): ScanPatterns => {
    const fixture = path.join(PLUGIN_ROOT, '__tests__', '__fixtures__', 'scan-patterns.json')

    return JSON.parse(fs.readFileSync(fixture, 'utf8')) as ScanPatterns
  }

  const skillFiles = (): [string, string][] => {
    return fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).flatMap((entry): [string, string][] => {
      const file = path.join(SKILLS_DIR, entry.name, 'SKILL.md')

      return entry.isDirectory() && fs.existsSync(file) ? [[entry.name, fs.readFileSync(file, 'utf8')]] : []
    })
  }

  it('has at least one skill to scan', () => {
    expect(skillFiles().length).toBeGreaterThan(0)
  })

  it('names no plugin-prefixed tool in any SKILL.md', () => {
    const re = new RegExp(scanPatterns().pluginToolName, 'g')
    const named = skillFiles().flatMap(([skill, body]) => {
      return [...body.matchAll(re)].map((match) => {
        return [skill, match[1]]
      })
    })

    expect(named, 'skills still naming a plugin-served MCP tool').toEqual([])
  })

  it('names no legacy-route tool in any SKILL.md', () => {
    const prefixes = scanPatterns().legacyToolPrefix.map((fragments) => {
      return fragments.join('')
    })
    const named = skillFiles().filter(([, body]) => {
      return prefixes.some((prefix) => {
        return body.includes(prefix)
      })
    })

    expect(
      named.map(([skill]) => {
        return skill
      }),
      'skills still naming a legacy-route MCP tool',
    ).toEqual([])
  })

  /**
   * Plan §3.9: `allowed-tools` lists read-only argv only, so the host prompts for every mutating call.
   * Checked through the same rule the `Agent allowlist` doctor row applies to a repo's settings, so the
   * plugin cannot ship an allow the doctor would warn a consumer about.
   */
  it('lists no allowed-tools pattern that reaches a mutating catalog row', () => {
    const offending = skillFiles().flatMap(([skill, body]) => {
      const line = /^allowed-tools:(.*)$/m.exec(body)?.[1] ?? ''
      const patterns = [...line.matchAll(/Bash\((?:[^()]|\([^()]*\))*\)/g)].map((match) => {
        return match[0]
      })

      return patterns.flatMap((pattern) => {
        const reached = mutatingCommandsReachedBy(pattern)

        return reached.length === 0 ? [] : [{ skill, pattern, reached }]
      })
    })

    expect(offending).toEqual([])
  })
})

describe('command catalog — destructive-op confirm gate (default-deny)', () => {
  // The exact set of MCP tools that MUST be gated behind the two-call confirm flow. Pinning it here
  // (not just deriving it) makes a future mis-flag to `requiresHumanConfirm: undefined` red this test,
  // not merely the default-deny invariant below.
  const EXPECTED_GATED_TOOLS = [
    'setup',
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
    // Deletes a PR, both branches and the Jira fix version. Exposed rather than CLI-only because the
    // gate plus its MCP narrowing (no `skipJira`, and the irreversible Jira delete behind the gate)
    // contain the residual risk — the same reasoning that exposes `worktrees-remove`.
    'release-remove',
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
   * The P1 invariant, fail-closed. Every mutating command must carry `requiresHumanConfirm`, be
   * `humanOnly` (refused under agent mode outright), or be an explicit, one-line-justified member of
   * LOW_RISK_MUTATING_ALLOWLIST.
   *
   * Keyed on `mutating` alone: every command is one `Bash(infra-kit …)` away, and `mcpExposed` is
   * historical ("was listed on the retired server"), so keying on it left `env-token-set` and
   * `env-token-remove` outside the invariant. A new mutating command that sets neither reds CI — opting out
   * of the gate becomes a deliberate, greppable allowlist edit, never a silently-typed `false`.
   */
  it('leaves no mutating command ungated unless it is on the low-risk allowlist', () => {
    const offenders = commandCatalog
      .filter((entry) => {
        return entry.mutating && entry.mcpTool?.requiresHumanConfirm !== true && entry.humanOnly !== true
      })
      .map((entry) => {
        return entry.cliName
      })
      .filter((cliName) => {
        return !LOW_RISK_MUTATING_ALLOWLIST.includes(cliName)
      })

    expect(offenders, `ungated mutating commands not on the allowlist: ${offenders.join(', ')}`).toEqual([])
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

  /**
   * U-D1, the same shape one command over. `doctor --fix` chmods the token store and prunes stale
   * portless routes, so `mutating: false` is only true of the EXPOSED TOOL — and it is true only
   * because the tool takes no input: an empty `inputSchema` is what leaves an agent no way to ask for
   * `--fix`. Adding any key here, however harmless it looks, is the change that makes the catalog's
   * claim false, and the ungated-mutating gate above cannot see it.
   *
   * The other half lives on the skill side: U15 in `plugins/infra-kit/__tests__/manifest.test.mjs`
   * keeps `--fix` out of every fence in the doctor SKILL.md, so no standing grant ever covers it. This
   * half is the declaration.
   */
  it('keeps `doctor` exposed, non-mutating, and inputless despite the CLI-only --fix flag', () => {
    const entry = commandCatalog.find((candidate) => {
      return candidate.cliName === 'doctor'
    })

    expect(entry).toMatchObject({ mcpExposed: true, mutating: false })
    expect(Object.keys(entry?.mcpTool?.inputSchema ?? { fix: true })).toEqual([])
  })

  /**
   * U-C1. The two-command setup surface, asserted as a shape rather than as four separate absences.
   *
   * `setup` and `doctor` are the whole of it. `init` is gone from Commander too, so a catalog entry
   * appearing for it is the observable symptom of someone reviving the removed name onto the palette
   * and the MCP surface (which both derive from here), and it fails this test rather than passing
   * quietly. The three `setup-dependency*` names were never published, so they were deleted outright
   * instead of being aliased.
   */
  it('carries setup and doctor, and no entry for init or the setup-dependency trio', () => {
    const cliNames = commandCatalog.map((entry) => {
      return entry.cliName
    })

    expect(cliNames).toContain('setup')
    expect(cliNames).toContain('doctor')

    const removed = cliNames.filter((cliName) => {
      return /^(?:init|setup-dependency)/u.test(cliName)
    })

    expect(removed, `catalog still carries removed setup-surface names: ${removed.join(', ')}`).toEqual([])
  })

  /**
   * The converse of the default-deny invariant. `requiresHumanConfirm` is written per-command under
   * `src/commands/`, while `mutating` is declared here; a tool gated in one artifact but read-only in
   * the other means one of the two is lying, and this fires.
   */
  it('gates only mutating entries', () => {
    for (const entry of commandCatalog) {
      if (entry.mcpTool?.requiresHumanConfirm === true) {
        expect(entry.mutating, `gated ${entry.cliName} must be mutating`).toBe(true)
      }
    }
  })

  // The allowlist is a safety escape hatch, not a dumping ground: every member must actually be a
  // mutating catalog entry that is NOT gated. A stale name (e.g. a tool that was later gated or
  // removed) would silently widen the escape hatch, so pin it. `mcpExposed` is deliberately NOT
  // required — it is historical, and the members that motivated dropping it (`env-token-set`,
  // `env-token-remove`) never carried a tool at all.
  it('keeps every allowlist member a real, ungated, mutating entry', () => {
    for (const cliName of LOW_RISK_MUTATING_ALLOWLIST) {
      const entry = commandCatalog.find((candidate) => {
        return candidate.cliName === cliName
      })

      expect(entry, `${cliName} on the allowlist must exist in the catalog`).toBeDefined()
      expect(entry?.mutating, `${cliName} must be mutating to warrant allowlisting`).toBe(true)
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
    'release-remove': 'release-remove',
    'release-create': 'release-create',
    'release-edit': 'release-edit',
    'release-deploy-all': 'gh-release-deploy-all',
    'release-deploy-selected': 'gh-release-deploy-selected',
    'release-deliver': 'gh-release-deliver',
    'worktrees-add': 'worktrees-add',
    'worktrees-list': 'worktrees-list',
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
    setup: 'setup',
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
      'release edit',
      'release deploy-all',
      'release deploy-selected',
      'release deliver',
      'release remove',
      // `local deploy-*` are absent by design: they are DEPRECATED aliases of
      // `release deploy-* --from local`, carrying `menuGroup: null` so the palette offers only
      // the merged commands. They remain in the catalog (and as MCP tools) and still resolve if typed.
    ])

    expect(groupPaths('worktrees')).toEqual(['worktrees add', 'worktrees list', 'worktrees remove', 'worktrees sync'])

    // `Environment` is the Doppler env commands and nothing else. It used to be a 13-entry drawer that
    // also held config, vendor, and setup commands — the four groups below are what came out of it.
    expect(groupPaths('environment')).toEqual(['env-status', 'env-list', 'env-load', 'env-clear', 'env-token-list'])
    expect(groupPaths('configuration')).toEqual(['config-get', 'config path', 'config edit'])
    expect(groupPaths('vendor')).toEqual(['vendor check', 'vendor config', 'vendor sync'])
    // `setup` LEADS the group: it is the command that acts on what `doctor` and `audit` report, and the
    // position is asserted so a later reshuffle has to be deliberate. It carried `menuGroup: null` until
    // the cost of hiding it landed — a shipped command nobody could find outside `--help`; its catalog
    // entry records the two arguments that kept it out and why neither survives.
    expect(groupPaths('setup')).toEqual(['setup', 'doctor', 'audit', 'version'])
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

describe('command catalog — the registered argument-form providers', () => {
  /**
   * The four deploy tools, `env-load` and `release-create`, and only those, offer the human a form for
   * their arguments.
   *
   * Pinned as a set rather than derived: the seam is optional and every failure on it is silent, so
   * a `formProvider` dropped in a future refactor would take the pickers away without reddening
   * anything — the tools would simply gate with whatever the agent guessed, exactly as they did
   * before this existed.
   */
  const EXPECTED_FORM_TOOLS = [
    'env-load',
    'gh-release-deploy-all',
    'gh-release-deploy-selected',
    'local-deploy-all',
    'local-deploy-selected',
    'release-create',
    'release-remove',
  ]

  const providerFor = (name: string) => {
    return commandCatalog.find((entry) => {
      return entry.mcpTool?.name === name
    })?.mcpTool?.formProvider
  }

  it('registers a form provider on exactly the four deploy tools, env-load, release-create and release-remove', () => {
    const withForm = commandCatalog
      .flatMap((entry) => {
        return entry.mcpExposed && entry.mcpTool?.formProvider !== undefined ? [entry.mcpTool.name] : []
      })
      .sort()

    expect(withForm).toEqual([...EXPECTED_FORM_TOOLS].sort())
  })

  // The field set is the second of the provider's two axes, and passing the wrong one is invisible
  // in the shape tests (which construct their own providers). `isFormable` is the cheapest probe of
  // what each tool was actually wired with: it is pure and reads the field list directly.
  it('wires each tool with its own field set — only -selected has services, only the CI pair has version', () => {
    expect(providerFor('gh-release-deploy-all')?.isFormable({ version: '1.2.5', env: 'dev' })).toBe(false)
    expect(providerFor('gh-release-deploy-selected')?.isFormable({ version: '1.2.5', env: 'dev' })).toBe(true)
    expect(providerFor('local-deploy-all')?.isFormable({ env: 'dev' })).toBe(false)
    expect(providerFor('local-deploy-selected')?.isFormable({ env: 'dev', service: ['client-be'] })).toBe(false)
    expect(providerFor('release-create')?.isFormable({})).toBe(true)
    expect(providerFor('release-create')?.isFormable({ releases: [{ version: 'next', type: 'regular' }] })).toBe(false)
    expect(providerFor('release-remove')?.isFormable({})).toBe(true)
    expect(providerFor('release-remove')?.isFormable({ version: '1.2.5' })).toBe(false)
  })

  it('wires env-load with the config picker — formable only while config is missing or blank', () => {
    expect(providerFor('env-load')?.isFormable({})).toBe(true)
    expect(providerFor('env-load')?.isFormable({ config: '' })).toBe(true)
    expect(providerFor('env-load')?.isFormable({ config: 'dev' })).toBe(false)
  })
})
