import { InvalidArgumentError, Option } from 'commander'
import type { Command } from 'commander'
import process from 'node:process'

import { audit, auditMcpTool } from 'src/commands/audit'
import { DEFAULT_SINCE_DAYS, changeStats, changeStatsMcpTool } from 'src/commands/change-stats'
import { doctor, doctorMcpTool, printDoctorReport } from 'src/commands/doctor'
import { autoSetupCommand, setup, setupMcpTool } from 'src/commands/setup'
import { version, versionMcpTool } from 'src/commands/version'
import type { CommandCatalogEntry } from 'src/entry/command-catalog/catalog-entry'
import { emit, jsonOutput } from 'src/lib/json-output'
import { logger } from 'src/lib/logger'

const parsePositiveDays = (raw: string): number => {
  const days = Number(raw)

  if (!Number.isInteger(days) || days <= 0) throw new InvalidArgumentError('Expected a positive whole number of days.')

  return days
}

export const registerAuditCommand = (program: Command): void => {
  program
    .command('audit')
    .description('Audit against infra-kit.config.ts rules (--all for every package, --root for the monorepo root)')
    .option('-a, --all', 'Audit every non-vendor workspace package')
    .option('-r, --root', 'Audit the monorepo root (turbo pipeline + root commands)')
    .option(
      '--fix',
      'Write the infra-kit guidance block into CLAUDE.md for the audited scope before checking (CLI-only)',
    )
    .option('--design', 'With --fix: scaffold DESIGN.md for frontend/mobile packages that lack one')
    .action(async (options) => {
      // Commander expresses no flag dependency natively, so the combination is validated by hand.
      // This is an ERROR rather than a warning on purpose: a user who typed `--design` asked for a
      // file to be written, and a warning printed above a green audit reads as success.
      if (options.design && !options.fix) {
        logger.error('--design requires --fix (it scaffolds DESIGN.md; there is nothing to scaffold without a fix run)')
        process.exitCode = 1

        return
      }

      const result = await audit({
        all: options.all,
        root: options.root,
        fix: options.fix,
        design: options.design,
      })

      emit(result)

      // This action is the SOLE carrier of the fix-write-failure signal: `audit()` never touches
      // the exit code, it returns a structured result. The second clause is not redundant — before
      // adoption a `missing` block PASSES, so a fix run whose only write failed would otherwise
      // report a green audit and exit 0.
      const { allPassed, fixed } = result.structuredContent

      const anyWriteFailed = (fixed ?? []).some((entry) => {
        return entry.action === 'failed'
      })

      if (!allPassed || anyWriteFailed) {
        process.exitCode = 1
      }
    })
}

// The catalog is handed in by the composition root: it is composed FROM this module's entries, so
// importing it here would be a cycle.
export const registerDoctorCommand = (program: Command, catalog: readonly CommandCatalogEntry[]): void => {
  program
    .command('doctor')
    .description('Check installation and authentication status of gh and doppler CLIs')
    .option(
      '--fix',
      'Remove portless routes left behind by a dev-server that was killed (kill -9, OOM, force-quit). Refuses while a dev session is running, when a booting UI is indistinguishable from a dead route.',
    )
    .option('--ascii', 'Render the report with ASCII markers instead of unicode glyphs (check messages are unchanged)')
    .action(async (options) => {
      const result = await doctor({ fix: Boolean(options.fix), catalog })

      // Presentation lives here, not in `doctor()`: that function returns a structured result and
      // owns no terminal. Skipped entirely under `--json` so stdout carries the payload and nothing else.
      if (!jsonOutput.enabled) {
        printDoctorReport(result.structuredContent.checks, { ascii: Boolean(options.ascii) })
      }

      // Scoped to ONE check, not to `allPassed`. Doctor has always exited 0 with failing rows — an
      // un-authenticated `gh` is a report, not a broken run — and flipping that wholesale would turn
      // every machine missing an optional tool red. A missing Claude Code plugin is different: the
      // consumer repos no longer carry their own copies of these skills, so an agent session there
      // silently loses them, and a non-zero exit is what a setup script can act on.
      const pluginMissing = result.structuredContent.checks.some((check) => {
        return check.name === 'plugin installed' && check.status === 'fail'
      })

      if (pluginMissing) process.exitCode = 1

      emit(result)
    })
}

export const registerSetupCommand = (program: Command): void => {
  // The one command that sets a machine up: the local `initCore` writes, then install-or-update for
  // brew, git, aws, gh, doppler and portless. The recipes that need sudo or pipe a network-fetched script are
  // never run from here — they are printed, for the human to run in their own shell.
  //
  // `--skip-tools` is the additive form (the local writes, and nothing installed). It
  // cannot be combined with `--tools` or `--update`: that is a usage error rather than a precedence
  // rule, because every precedence answer either installs software the caller asked not to install or
  // acts on a set they did not choose (`setup.ts` SKIP_TOOLS_CONFLICT).
  program
    .command('setup')
    .description(
      'Set this machine up: shell integration, agent files, the Claude Code skills plugin, then the external tools',
    )
    .option('--tools <ids...>', 'Limit to these tools (brew, git, aws, gh, doppler, portless)')
    .option('--update [ids...]', 'Update what is already installed; never install a missing tool')
    .option('--skip-tools', 'Do the local setup only, then REPORT what each tool needs — installs nothing')
    .option('--ascii', 'Render the report with ASCII markers instead of unicode glyphs (row messages are unchanged)')
    // Hidden: the update worker's entry points, not a human's. `--auto` runs `--unattended` for the machine
    // and then in every infra-kit project, once per installed version (`commands/setup/auto-setup.ts`).
    .addOption(
      new Option('--unattended', 'Background run: no tool installs, no writes to git-tracked files').hideHelp(),
    )
    .addOption(
      new Option('--auto', 'Unattended setup for the machine and every infra-kit project, once per version').hideHelp(),
    )
    .action(
      async (options: {
        tools?: string[]
        update?: boolean | string[]
        skipTools?: boolean
        ascii?: boolean
        unattended?: boolean
        auto?: boolean
      }) => {
        if (options.auto) {
          emit(await autoSetupCommand())

          return
        }

        emit(
          await setup({
            tools: options.tools as never,
            update: options.update as never,
            skipTools: options.skipTools,
            ascii: Boolean(options.ascii),
            unattended: options.unattended,
          }),
        )
      },
    )
}

/** `version` and `change-stats`. */
export const registerInfoCommands = (program: Command): void => {
  program
    .command('version')
    .description('Print the installed infra-kit CLI version')
    .action(async () => {
      emit(await version())
    })

  program
    .command('change-stats')
    .description(
      'Change-failure baseline for this git repo: agent vs human commits, revert and 72h follow-up-fix rates',
    )
    .option('--since <days>', `Window in days, ending now (default ${DEFAULT_SINCE_DAYS})`, parsePositiveDays)
    .action(async (options: { since?: number }) => {
      emit(await changeStats({ since: options.since }))
    })
}

/** Cross-surface metadata of the commands registered above, in palette order. */
export const diagnosticsCatalog: CommandCatalogEntry[] = [
  // --- Setup & Diagnostics (menu group) ---
  // `doctor` checks the machine; `audit` checks the REPO against its config rules. Both answer "is this
  // in a good state?". `setup` is the command that ACTS on those answers, which is why it leads the
  // group rather than sitting outside it.
  //
  // Sets the machine up in one pass: the local `initCore` writes, then install-or-update for the five
  // external tools. Exposed in the menu despite mutating, on the rule the catalog
  // already enforces: exposure is bounded by a tool's own invariants, not by the verb (`worktrees-add`
  // is exposed, ungated, and runs `pnpm install`). Here the invariant is computed —
  // `lib/dependency-install/risk-predicate` refuses any recipe needing sudo or piping a network-fetched
  // script, which is both bootstrap recipes, on every host regardless of configuration.
  //
  // `requiresHumanConfirm` rather than LOW_RISK_MUTATING_ALLOWLIST membership: the allowlist ASSERTS low
  // risk, and that would be a false claim for a command that installs software. It fires unconditionally
  // — `skipTools` included — because the read path that raises no prompt is `doctor`, a separate command
  // and therefore a separate permission identity.
  //
  // `menuGroup: 'setup'` REVERSES an earlier decision to hide the row, and the two reasons it rested on
  // are recorded here so they are not silently re-adopted:
  //   1. "It would be a one-keystroke installer" — `run-session.ts` spawns `[deps.cliPath,
  //      ...command.groupPath]` with ZERO flags, so the palette can only offer the flagless form, never
  //      the narrowed `setup --skip-tools`. That argument does not survive the catalog's own rule, which
  //      the far more consequential `release deploy-all` row already tests: exposure follows the
  //      invariant, and setup's is a converge that installs nothing sudo-shaped and is idempotent on a
  //      machine that is already set up.
  //   2. "The row would read a bare `setup` and collide with the `pnpm run setup` script" — the label is
  //      a render inside a palette the user reached by typing `ik`, where every other row is likewise
  //      unqualified (`doctor`, `audit`). A label ambiguity that exists only for a reader who ignores
  //      the surface they are standing in does not outweigh the command being undiscoverable.
  // The cost that decided it: `setup` reachable only from `--help` is a command most users never learn
  // exists. A human who wants the additive local writes without the installer still types
  // `infra-kit setup --skip-tools`.
  {
    cliName: 'setup',
    menuGroup: 'setup',
    mcpTool: setupMcpTool,
    mcpExposed: true,
    mutating: true,
    groupPath: ['setup'],
  },
  {
    cliName: 'doctor',
    menuGroup: 'setup',
    mcpTool: doctorMcpTool,
    mcpExposed: true,
    // `mutating: false` is a statement about the FLAGLESS invocation the plugin grants
    // (`Bash(infra-kit doctor)`), not about every argv the command accepts. `--fix` chmods the token
    // store and prunes stale portless routes, and it is fenced by manifest U15: the grant is the bare
    // command, so an agent cannot reach `--fix` without a fresh permission prompt. Exactly the `audit`
    // precedent (`mutating: false` beside a CLI-only `--fix`), and pinned the same way — plus U-D2(b),
    // which drives the real `doctor()` and asserts the handler reaches zero `chmodSync` calls on a
    // fixture the CLI path demonstrably chmods.
    mutating: false,
    groupPath: ['doctor'],
  },
  {
    cliName: 'audit',
    menuGroup: 'setup',
    mcpTool: auditMcpTool,
    mcpExposed: true,
    mutating: false,
    groupPath: ['audit'],
  },
  {
    cliName: 'version',
    menuGroup: 'setup',
    mcpTool: versionMcpTool,
    mcpExposed: true,
    mutating: false,
    groupPath: ['version'],
  },

  // Read-only git-history report (roadmap P2 baseline). Off the palette: a periodic measurement, not a
  // daily action.
  {
    cliName: 'change-stats',
    menuGroup: null,
    mcpTool: changeStatsMcpTool,
    mcpExposed: false,
    mutating: false,
    groupPath: ['change-stats'],
  },
]
