import { Command, InvalidArgumentError } from 'commander'
import { resolve } from 'node:path'
import process from 'node:process'
import { cd } from 'zx'

import { audit } from 'src/commands/audit'
import { configEdit, configPath } from 'src/commands/config'
import { configGet } from 'src/commands/config-get'
import { devStatus } from 'src/commands/dev-status'
import { doctor, printDoctorReport } from 'src/commands/doctor'
import { envClear } from 'src/commands/env-clear'
import { envList } from 'src/commands/env-list'
import { envLoad } from 'src/commands/env-load'
import { envStatus } from 'src/commands/env-status'
import { envTokenList } from 'src/commands/env-token-list'
import { envTokenRemove } from 'src/commands/env-token-remove'
import { envTokenSet } from 'src/commands/env-token-set'
import { ghMergeDev } from 'src/commands/gh-merge-dev'
import { withRunCleanup } from 'src/commands/gh-merge-dev/run-cleanup'
import { ghReleaseDeliver } from 'src/commands/gh-release-deliver'
import { ghReleaseList } from 'src/commands/gh-release-list'
import { releaseCreate } from 'src/commands/release-create'
import { deprecatedLocalDeploy, releaseDeployAll, releaseDeploySelected } from 'src/commands/release-deploy'
import { releaseEdit } from 'src/commands/release-edit'
import { releaseRemove } from 'src/commands/release-remove'
import { setup } from 'src/commands/setup'
import { vendorCheck } from 'src/commands/vendor-check'
import { vendorConfig } from 'src/commands/vendor-config'
import { vendorSync } from 'src/commands/vendor-sync'
import { version } from 'src/commands/version'
import { worktreesAdd } from 'src/commands/worktrees-add'
import { worktreesList } from 'src/commands/worktrees-list'
import { worktreesRemove } from 'src/commands/worktrees-remove'
import { worktreesSync } from 'src/commands/worktrees-sync'
import { IDE_MODES } from 'src/integrations/ide'
import type { IdeMode } from 'src/integrations/ide'
import { agentMode, resolveAgentModeSource } from 'src/lib/agent-mode'
import { isLongRunningCommand } from 'src/lib/command-catalog'
import { commandEcho } from 'src/lib/command-echo'
import { ensureUserProjectConfig } from 'src/lib/config-bootstrap'
import { isCommandDeclined } from 'src/lib/errors/command-declined-error'
import { addJsonOption, emit, jsonOutput } from 'src/lib/json-output'
import { logger } from 'src/lib/logger'
import { InvalidReleaseDateError, assertIsoDate } from 'src/lib/release-date'
import { DEPLOY_SOURCES } from 'src/lib/release-deploy'
import { equivalentLine } from 'src/lib/session/equivalent'
import { writeSessionReport } from 'src/lib/session/report'
import { parseReleaseSpec } from 'src/lib/version-utils'
import type { ReleaseInput } from 'src/lib/version-utils'

/**
 * Side-effect-free construction of the Commander program. It is deliberately isolated from
 * `src/entry/cli.ts` (which runs `warnIfLocalInstall()`, `maybeAutoUpdate()`, and a top-level `await`
 * at module load) so a test — or the session shell — can import and walk the command tree WITHOUT
 * triggering those boot side effects. `cli.ts` calls `buildProgram()` once and owns everything else.
 */

import { addAgentOption } from './agent-option'
import { addDebugOption } from './debug-option'

const collectReleaseSpec = (value: string, prev: string[]): string[] => {
  return [...prev, value]
}

const normalizeIdeMode = (value: unknown, flagName: '--ide' | '--cursor'): IdeMode | undefined => {
  if (typeof value === 'undefined') {
    return undefined
  }

  if (value === true) {
    return 'workspace'
  }

  if (value === false) {
    return 'none'
  }

  if (typeof value === 'string' && (IDE_MODES as readonly string[]).includes(value)) {
    return value as IdeMode
  }

  throw new Error(`Invalid ${flagName} value "${String(value)}". Expected one of: ${IDE_MODES.join(', ')}.`)
}

// --- Command configurators (one source of options + action per command) ---
//
// These were factored out when each command had TWO registrations — a grouped form and a flat alias —
// that had to be kept from diverging. The flat aliases are gone; the configurators stay because they
// keep `buildProgram` readable, and a command still gets exactly one definition.
const configureMergeDev = (cmd: Command): Command => {
  return cmd
    .description('Merge dev branch into every release branch')
    .option('-a, --all', 'Select all active release branches')
    .option('-v, --versions <versions>', 'Specify versions by comma, e.g. 1.2.5, 1.2.6')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--dry-run', 'Compute and print the merge plan without pushing anything')
    .option(
      '--verify [command]',
      'Check each merge before pushing it. Bare runs `pnpm install --frozen-lockfile`; pass a command to run that instead. A branch that fails is dropped from the push, never rolled back',
    )
    .action(async (options) => {
      // The signal guard is installed HERE, on the CLI path, and nowhere else:
      // `ghMergeDev` is a pure handler that returns a structured result, so a
      // process.exit inside it would preempt any host that embeds it.
      const result = await withRunCleanup(() => {
        return ghMergeDev({
          all: options.all,
          versions: options.versions,
          dryRun: options.dryRun,
          verify: options.verify,
          confirmedCommand: options.yes,
        })
      })

      emit(result)

      // A partial run used to exit 0, so no CI step or wrapper script could tell
      // "merged all six" from "merged two, gave up on four". Same shape as
      // `audit` and `vendor check` below: the action owns the exit code, `emit`
      // never touches it.
      if (result.structuredContent.failedMerges > 0) {
        process.exitCode = 1
      }
    })
}

/**
 * The zsh wrappers capture stdout as the file to source — `f=$(infra-kit env-load …); source "$f"` —
 * so the bare path is the CLI's stdout contract. It is printed by the CLI action, not the handler, so
 * the handler's return stays a pure structured result that `--json`/`--agent` callers serialise
 * themselves. Printed BEFORE `emit` so `--json` keeps its historical shape (path line, then the payload).
 */
const emitSourcePath = <T extends { structuredContent: { filePath: string } }>(result: T): T => {
  process.stdout.write(`${result.structuredContent.filePath}\n`)

  return emit(result)
}

const configureReleaseList = (cmd: Command): Command => {
  return cmd.description('List all release branches').action(async () => {
    emit(await ghReleaseList())
  })
}

const configureReleaseCreate = (cmd: Command): Command => {
  return cmd
    .description('Create one or more release branches (each entry can mix regular/hotfix and its own description)')
    .option(
      '-r, --release <spec>',
      'Release spec "<version|next|name>[@yyyy-mm-dd][:type[:description]]" (repeatable). The token is a semver ("1.2.5"), the literal "next", or a kebab-case name ("checkout-redesign"); "@yyyy-mm-dd" is the planned release date, written to the Jira fix version. Type is regular|hotfix (default regular). Examples: "1.2.5", "1.2.5:hotfix", "1.64.0@2026-10-28", "next:regular:Holiday backend", "checkout-redesign:regular:Q3 redesign".',
      collectReleaseSpec,
      [],
    )
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (options) => {
      const specs = options.release as string[]
      const inputs: ReleaseInput[] = specs.map(parseReleaseSpec)
      const releases = inputs.length > 0 ? inputs : undefined

      emit(
        await releaseCreate({
          releases,
          confirmedCommand: options.yes,
        }),
      )
    })
}

/**
 * Validated in the option's `argParser`, not in `.action` like `-r`: Commander formats ONLY an
 * `InvalidArgumentError` thrown there into its standard
 * `error: option '--release-date <yyyy-mm-dd>' argument '…' is invalid. <message>` line; a custom
 * class propagates raw to `entry/cli.ts`. `""` passes through untouched — it is the clear intent.
 */
const parseReleaseDateOption = (raw: string): string => {
  if (raw === '') return raw

  try {
    return assertIsoDate(raw)
  } catch (err) {
    if (err instanceof InvalidReleaseDateError) throw new InvalidArgumentError(err.message)

    throw err
  }
}

const configureReleaseEdit = (cmd: Command): Command => {
  return cmd
    .description(
      "Edit a release's description and/or release date in Jira (description also in the matching GitHub PR body)",
    )
    .option('-v, --version <version>', 'Release version (e.g. 1.2.5) or release name (e.g. checkout-redesign)')
    .option('-d, --description <description>', 'New description (use "" to clear)')
    .option('--release-date <yyyy-mm-dd>', 'New planned release date (use "" to clear)', parseReleaseDateOption)
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (options) => {
      emit(
        await releaseEdit({
          version: options.version,
          description: options.description,
          releaseDate: options.releaseDate,
          confirmedCommand: options.yes,
        }),
      )
    })
}

/**
 * The merged deploy option set. `--from` carries NO default on purpose: it decides whether a reviewed
 * release ref or the current working tree ships, and a default would silently re-create the ambiguity
 * the flag exists to remove. Flags belonging to the other source are refused, not ignored
 * (`assertFlagsMatchSource`) — a silently dropped `--skip-terraform` reads as "terraform was skipped".
 */
const withDeploySourceOptions = (cmd: Command): Command => {
  return cmd
    .option('-f, --from <where>', `Where the deploy runs: ${DEPLOY_SOURCES.join(' | ')} (required)`)
    .option(
      '-v, --version <version>',
      'With --from ci: version (e.g. 1.2.5) or release name to deploy; "dev" deploys from the dev branch. Prompts when omitted',
    )
    .option('-e, --env <env>', 'Specify the environment to deploy to, e.g. dev')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--skip-terraform', 'With --from ci: skip the terraform deployment step')
    .option('--dry-run', 'With --from local: resolve target, contract and commands without deploying')
    .option('--print-env', 'With --from local: print the resolved build contract')
}

const configureReleaseDeployAll = (cmd: Command): Command => {
  return withDeploySourceOptions(cmd)
    .description('Deploy every service to any environment, in CI or from this machine')
    .action(async (options) => {
      emit(
        await releaseDeployAll({
          from: options.from,
          version: options.version,
          env: options.env,
          skipTerraform: options.skipTerraform,
          yes: options.yes,
          dryRun: options.dryRun,
          printEnv: options.printEnv,
        }),
      )
    })
}

const configureReleaseDeploySelected = (cmd: Command): Command => {
  return withDeploySourceOptions(cmd)
    .description('Deploy selected services to any environment, in CI or from this machine')
    .option('-s, --services <services...>', 'Specify services to deploy, e.g. client-be client-fe')
    .action(async (options) => {
      emit(
        await releaseDeploySelected({
          from: options.from,
          version: options.version,
          env: options.env,
          services: options.services,
          skipTerraform: options.skipTerraform,
          yes: options.yes,
          dryRun: options.dryRun,
          printEnv: options.printEnv,
        }),
      )
    })
}

const configureReleaseDeliver = (cmd: Command): Command => {
  return cmd
    .description('Release a new version to production')
    .option('-v, --version <version>', 'Version (e.g. 1.2.5) or release name (e.g. checkout-redesign) to deliver')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (options) => {
      emit(await ghReleaseDeliver({ version: options.version, confirmedCommand: options.yes }))
    })
}

const configureReleaseRemove = (cmd: Command): Command => {
  return cmd
    .description('Tear down a release: worktree, PR, branches, and the Jira fix version')
    .option('-v, --version <version>', 'Version (e.g. 1.2.5) or release name (e.g. checkout-redesign) to remove')
    .option('--move-issues-to <version>', 'Reassign issues carrying the fix version to this version before removing it')
    .option('--skip-jira', 'Remove everything except the Jira fix version')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (options) => {
      emit(
        await releaseRemove({
          version: options.version,
          moveIssuesTo: options.moveIssuesTo,
          skipJira: options.skipJira,
          confirmedCommand: options.yes,
        }),
      )
    })
}

const configureWorktreesSync = (cmd: Command): Command => {
  return cmd
    .description('Remove release worktrees whose PRs are no longer open')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (options) => {
      emit(await worktreesSync({ confirmedCommand: options.yes }))
    })
}

const configureWorktreesAdd = (cmd: Command): Command => {
  return cmd
    .description('Add git worktrees for release branches')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('-a, --all', 'Select all active release branches')
    .option('-v, --versions <versions>', 'Specify versions by comma, e.g. 1.2.5, 1.2.6')
    .option('-i, --ide [mode]', 'Editor mode for created worktrees: workspace (default) | none')
    .option('--no-ide', 'Skip the editor (alias for --ide none)')
    .option('-c, --cursor [mode]', 'Deprecated alias for --ide')
    .option('--no-cursor', 'Deprecated alias for --no-ide')
    .option('-g, --github-desktop', 'Open created worktrees in GitHub Desktop')
    .option('--no-github-desktop', 'Skip GitHub Desktop prompt')
    .option('--orca', 'Open created worktrees in Orca (pane layout from worktrees.orca.layout)')
    .option('--no-orca', 'Skip the Orca prompt')
    .action(async (options) => {
      // `--ide` wins over the deprecated `--cursor` alias when both are provided.
      const ide = normalizeIdeMode(options.ide, '--ide') ?? normalizeIdeMode(options.cursor, '--cursor')

      emit(
        await worktreesAdd({
          confirmedCommand: options.yes,
          all: options.all,
          versions: options.versions,
          ide,
          githubDesktop: options.githubDesktop,
          orca: options.orca,
        }),
      )
    })
}

const configureWorktreesList = (cmd: Command): Command => {
  return cmd.description('List all git worktrees with detailed information').action(async () => {
    emit(await worktreesList())
  })
}

const configureWorktreesRemove = (cmd: Command): Command => {
  return cmd
    .description('Remove git worktrees for release branches')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('-a, --all', 'Select all active release branches')
    .option('-v, --versions <versions>', 'Specify versions by comma, e.g. 1.2.5, 1.2.6')
    .action(async (options) => {
      emit(await worktreesRemove({ confirmedCommand: options.yes, all: options.all, versions: options.versions }))
    })
}

const configureVendorConfig = (cmd: Command): Command => {
  return cmd
    .description('Show the machine-local factory config (~/.infra-kit/vendor.json) or scaffold it with --init')
    .option('--init', 'Scaffold ~/.infra-kit/vendor.json (skips if it already exists)')
    .action(async (options) => {
      emit(await vendorConfig({ init: options.init }))
    })
}

const configureVendorCheck = (cmd: Command): Command => {
  return cmd
    .description('Verify vendor/ matches vendor/.sync-manifest.json (self-contained; for any consumer repo)')
    .action(async () => {
      const result = await vendorCheck()

      emit(result)

      if (!result.structuredContent.ok) {
        process.exitCode = 1
      }
    })
}

const configureVendorSync = (cmd: Command): Command => {
  return cmd
    .description(
      "Mirror the source repo's vendorSource files into every target in ~/.infra-kit/vendor.json (human-only)",
    )
    .argument('[targets...]', 'Narrow to these target names from ~/.infra-kit/vendor.json')
    .option('-y, --yes', 'Apply the previewed plan (needs a real terminal on stdin)')
    .option('--check', 'Preview only; exit 1 when any target would change')
    .option('--commit', 'Commit exactly the synced paths in each target after it syncs')
    .option('--manifest-only', 'Rewrite vendor/README.md and vendor/.sync-manifest.json only; copy nothing')
    .action(async (targets: string[], options) => {
      let result: Awaited<ReturnType<typeof vendorSync>>

      try {
        result = await vendorSync({
          targets,
          confirmedCommand: options.yes,
          check: options.check,
          commit: options.commit,
          manifestOnly: options.manifestOnly,
        })
      } catch (error) {
        // `throwOnDecline` exists so a "no" unwinds instead of `process.exit(0)`; the decline itself
        // is still a clean exit, not an error.
        if (!isCommandDeclined(error)) throw error

        logger.info('Operation cancelled.')

        return
      }

      emit(result)

      const { failed, changed, mode } = result.structuredContent

      if (failed || (mode === 'check' && changed)) process.exitCode = 1
    })
}

const configureConfigPath = (cmd: Command): Command => {
  return cmd.description('Show the resolved config merge chain and file paths').action(async () => {
    emit(await configPath())
  })
}

const configureConfigEdit = (cmd: Command): Command => {
  return cmd.description('Open the user-scope per-project override file in $EDITOR').action(async () => {
    emit(await configEdit())
  })
}

// Commands excluded from the layer-3 config auto-seed: `version` touches config ZERO times today, so
// seeding is pure new cost on the fastest path. Everything else DOES seed — `doctor`, `config path`,
// `dev` and the whole `env-*` family included.
//
// `setup` is deliberately absent from this set rather than overlooked: it is the command that
// establishes this project's layer-3 override file, so excluding it would mean the setup command is the
// one command that does not set up the config. That holds for `setup --skip-tools` too — the seed is a
// local write, not a tool install, so the additive form has exactly the same business here.
const SEED_EXCLUDED = new Set(['version'])

/**
 * Canonical space-joined command path for a leaf (e.g. the `check` leaf of `vendor` → "vendor check").
 * Stops at the root program (a node with no parent) so its name — the bin basename like "cli" — never
 * leaks into the equivalent line.
 */
export const commandPath = (leaf: Command): string => {
  const parts: string[] = []

  for (let node: Command | null = leaf; node && node.parent; node = node.parent) {
    parts.unshift(node.name())
  }

  return parts.join(' ')
}

/**
 * Build the full Commander program: ONE surface per command (the grouped form — `release create`, never
 * `release-create`), plus `--json` on every command and the pre-action hooks. Pure: no I/O, no
 * top-level await, no process mutation — safe to import from a test to introspect the command tree.
 *
 * @example
 * const program = buildProgram()
 * program.commands.some((c) => c.name() === 'doctor') // => true
 */
export const buildProgram = (): Command => {
  // `-C` is git's spelling and, like git's, it is ROOT-ONLY: `infra-kit -C <dir> release list`. It is
  // applied by `process.chdir` in the preAction hook below, FIRST, so every cwd reader downstream
  // (`getProjectRoot`, the layer-3 seed, `commandEcho`) sees one directory. Capital `-C` so it never
  // collides with the `-c <config>` leaf option on `env-load`; Commander keeps them apart regardless.
  const program = new Command().option(
    '-C <dir>',
    'Run as if infra-kit was started in <dir> instead of the current working directory',
  )

  // --- Grouped command surface (preferred form) ---
  const releaseGroup = program.command('release').description('Release management commands')

  configureMergeDev(releaseGroup.command('merge-dev'))
  configureReleaseList(releaseGroup.command('list'))
  configureReleaseCreate(releaseGroup.command('create'))
  configureReleaseEdit(releaseGroup.command('edit'))
  configureReleaseDeployAll(releaseGroup.command('deploy-all'))
  configureReleaseDeploySelected(releaseGroup.command('deploy-selected'))
  configureReleaseDeliver(releaseGroup.command('deliver'))
  configureReleaseRemove(releaseGroup.command('remove'))

  const worktreesGroup = program.command('worktrees').description('Git worktree management commands')

  configureWorktreesAdd(worktreesGroup.command('add'))
  configureWorktreesList(worktreesGroup.command('list'))
  configureWorktreesRemove(worktreesGroup.command('remove'))
  configureWorktreesSync(worktreesGroup.command('sync'))

  const configCmd = program.command('config').description('Manage infra-kit configuration files')

  configureConfigPath(configCmd.command('path'))
  configureConfigEdit(configCmd.command('edit'))

  // Top-level (`infra-kit config-get`), not under the config group — house rule: new commands go
  // top-level with related names. Read-only: prints the fully merged config.
  program
    .command('config-get')
    .description('Print the fully merged infra-kit config (project + user-global + per-project override layers)')
    .action(async () => {
      emit(await configGet())
    })

  // DEPRECATED. The CI/local choice moved onto `release deploy-* --from`, so it is stated on every
  // invocation instead of being carried by which command group you typed. These stay one release so
  // muscle memory does not simply fail, are hidden from the palette (`menuGroup: null` in the catalog),
  // and warn on every run.
  const localCmd = program
    .command('local')
    .description('Deprecated — use `release deploy-all|deploy-selected --from local`')

  const withDeprecatedLocalOptions = (cmd: Command): Command => {
    return cmd
      .option('-e, --env <name>', 'Target environment (prompts when omitted)')
      .option('-y, --yes', 'Skip the confirmation prompt')
      .option('--dry-run', 'Resolve target, contract and commands without deploying')
      .option('--print-env', 'Print the resolved build contract')
  }

  withDeprecatedLocalOptions(localCmd.command('deploy-all'))
    .description('Deprecated — use `release deploy-all --from local`')
    .action(async (options) => {
      emit(
        await deprecatedLocalDeploy(
          {
            env: options.env,
            yes: options.yes,
            dryRun: options.dryRun,
            printEnv: options.printEnv,
          },
          'all',
        ),
      )
    })

  withDeprecatedLocalOptions(localCmd.command('deploy-selected'))
    .description('Deprecated — use `release deploy-selected --from local`')
    .option('-s, --service <name...>', 'Service name(s), as in deploy-<name>.sh (prompts when omitted)')
    .action(async (options) => {
      emit(
        await deprecatedLocalDeploy(
          {
            env: options.env,
            services: options.service,
            yes: options.yes,
            dryRun: options.dryRun,
            printEnv: options.printEnv,
          },
          'selected',
        ),
      )
    })

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

  const vendorCmd = program.command('vendor').description('Mirror and verify the vendored starter files')

  configureVendorCheck(vendorCmd.command('check'))
  configureVendorConfig(vendorCmd.command('config'))
  configureVendorSync(vendorCmd.command('sync'))

  program
    .command('doctor')
    .description('Check installation and authentication status of gh and doppler CLIs')
    .option(
      '--fix',
      'Remove portless routes left behind by a dev-server that was killed (kill -9, OOM, force-quit). Refuses while a dev session is running, when a booting UI is indistinguishable from a dead route.',
    )
    .option('--ascii', 'Render the report with ASCII markers instead of unicode glyphs (check messages are unchanged)')
    .action(async (options) => {
      const result = await doctor({ fix: Boolean(options.fix) })

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

  program
    .command('dev')
    .description('Run local dev servers for a named devServersPresets preset (or all apps); api + ui')
    .argument('[preset]', 'Named preset from devServersPresets (omit to run every app)')
    .option('-w, --watch', 'Rebuild and restart on file save')
    .option('--app <names>', 'Further narrow to these app folder names (comma-separated)')
    .option(
      '--target <keys>',
      'Run exactly these <app>/api|<app>/ui packages (comma-separated); part-level, unlike --app',
    )
    .option(
      '--orca',
      'Run each app in its own Orca pane (one tab, N panes; falls back to single terminal when Orca is not running)',
    )
    .option('--self', 'Run only the app of the current directory (infer from cwd; use inside apps/<app>/…)')
    .option('-V, --verbose', 'Print full boot narration (default: quiet; full detail always in the session log)')
    .option('--routes', 'Print each app’s registered METHOD /path routes at startup (default: off)')
    .option(
      '--no-ui-health',
      'Do not probe the frontends’ liveness (vite’s HMR ping); their rows carry no health dot (also: INFRA_KIT_NO_UI_HEALTH=1)',
    )
    .action(async (preset, options) => {
      // Lazy import so fastify/chokidar (and the whole dev stack, plus the wizard's inquirer/config
      // graph) never load on the eager cli graph — they land in a split chunk reached only for `dev`.
      const { runDevServerCli } = await import('src/entry/dev-server')

      // A bare `infra-kit dev` in a TTY launches the interactive wizard; any flag/preset/pipe/--json
      // runs directly. `runDevServerCli` owns that decision (see `shouldRunWizard`).
      const tty = Boolean(process.stdout.isTTY && process.stdin.isTTY)

      await runDevServerCli({ ...options, preset }, tty, jsonOutput.enabled)
    })

  // Read-only companion to `dev`: reports what dev currently has running from the on-disk dev-context
  // fragments (never starts a server). Top-level per the house rule.
  program
    .command('dev-status')
    .description('Show what `infra-kit dev` currently has running (reads dev-context fragments; starts nothing)')
    .action(async () => {
      emit(await devStatus())
    })

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
    .action(
      async (options: { tools?: string[]; update?: boolean | string[]; skipTools?: boolean; ascii?: boolean }) => {
        emit(
          await setup({
            tools: options.tools as never,
            update: options.update as never,
            skipTools: options.skipTools,
            ascii: Boolean(options.ascii),
          }),
        )
      },
    )

  program
    .command('version')
    .description('Print the installed infra-kit CLI version')
    .action(async () => {
      emit(await version())
    })

  program
    .command('env-status')
    .description('Show which env is loaded in this session (local introspection; no Doppler call)')
    .action(async () => {
      emit(await envStatus())
    })

  program
    .command('env-list')
    .description(
      'List available Doppler configs for the detected project, and whether a service token resolves for each',
    )
    .action(async () => {
      emit(await envList())
    })

  program
    .command('env-load')
    .description('Load Doppler env vars for a config. Source the returned file path to apply.')
    .option('-c, --config <config>', 'Environment config name to load (e.g. dev, arthur)')
    .action(async (options) => {
      emitSourcePath(await envLoad({ config: options.config }))
    })

  program
    .command('env-clear')
    .description('Clear loaded env vars. Source the returned file path to apply.')
    .action(async () => {
      emitSourcePath(await envClear())
    })

  // --- Doppler service tokens (flat, related names — not a nested `env token <sub>` group) ---
  //
  // There is deliberately NO `--token <value>` flag on `env-token-set`, and there must never be one:
  // argv is world-visible in `ps`, lands in shell history, and `commandEcho` prints option VALUES back
  // to the terminal. The three input channels below all keep the token out of argv.
  program
    .command('env-token-set')
    .description('Store the Doppler service token for an env (masked prompt; validated against Doppler before writing)')
    .argument('<env>', 'Environment / Doppler config the token is scoped to (e.g. dev)')
    .option('--stdin', 'Read the token from stdin instead of prompting (e.g. from a password manager)')
    .option('--from-env <var>', 'Read the token from the named environment variable (the NAME, never the value)')
    .option('--force', 'Store even when the token’s scope could not be verified. Never overrides a real mismatch.')
    .action(async (env, options) => {
      emit(
        await envTokenSet({
          env,
          stdin: options.stdin,
          fromEnv: options.fromEnv,
          force: options.force,
        }),
      )
    })

  program
    .command('env-token-list')
    .description('Show which envs have a Doppler service token (redacted), and where it came from')
    .option('--check', 'Also ask Doppler whether each token is valid and correctly scoped')
    .action(async (options) => {
      emit(await envTokenList({ check: Boolean(options.check) }))
    })

  program
    .command('env-token-remove')
    .description('Delete an env’s Doppler service token from the local store (does NOT revoke it in Doppler)')
    .argument('<env>', 'Environment / Doppler config whose token to remove')
    .action(async (env) => {
      emit(await envTokenRemove({ env }))
    })

  // Register `--json` on every command, then resolve the flag before each action
  // runs. In JSON mode we lower the logger to `warn` so the human-oriented info
  // lines stop cluttering stderr while errors still surface; the structured
  // payload is written to stdout by `emit`. No handler logic is affected.
  program.commands.forEach(addJsonOption)

  // `--agent` rides the same recursion as `--json`, on the root too, so a skill can put it anywhere in
  // the line. Read in the hook below, never off `process.argv`.
  addAgentOption(program)

  // Register `--debug` on the root AND every subcommand. The logger already reads the flag off
  // `process.argv` at module load; this only stops Commander rejecting it as unknown first, which
  // is what made the log level unreachable from the command line.
  addDebugOption(program)

  program.hook('preAction', async (_thisCommand, actionCommand) => {
    // `-C` FIRST — before the echo, before `--json`, before the seed — so nothing in
    // this hook or the action ever sees the launch cwd. Relative to where the user typed it, which is
    // what `process.cwd()` still is at this line. A bad dir throws here, before `--json` is resolved,
    // so it reaches `entry/cli.ts` as a plain stderr line and exit 1 — stated, not structured.
    //
    // zx's `cd`, NOT `process.chdir`: zx snapshots its own cwd at import and every `$\`git …\`` in the
    // tree would keep running in the launch dir (measured: after `process.chdir('/tmp')`, `$\`pwd\``
    // still printed the launch dir — `-C <repo> version --json` reported `repoRoot: null`). `cd` sets
    // both the zx cwd and `process.cwd()`.
    const { C: changeDir } = program.opts<{ C?: string }>()

    if (changeDir !== undefined) cd(resolve(process.cwd(), changeDir))

    // Bind the "📟 Equivalent command" line to the argv Commander just parsed. This is the only place
    // that knows it, so it is the only place that says it: when the commands named themselves, they
    // printed the flat `release-create`, which the grouped-only surface no longer parses — a replay line
    // that errors out. `commandPath()` is the same string the menu spawns, so what we print is runnable
    // by construction, and stays runnable through any future regrouping.
    commandEcho.start(commandPath(actionCommand))

    // `optsWithGlobals` (not `opts`) so `--json` is seen on grouped subcommands:
    // for `release list --json` Commander binds the post-subcommand flag to the
    // parent `release` group, so the leaf's own `opts()` would not carry it.
    jsonOutput.enabled = Boolean(actionCommand.optsWithGlobals().json)

    if (jsonOutput.enabled) {
      logger.level = 'warn'
    }

    // Resolved once, here, from the same `optsWithGlobals()` read `--json` needs.
    agentMode.source = resolveAgentModeSource({
      env: process.env,
      stdinIsTTY: process.stdin.isTTY === true,
      flag: Boolean(actionCommand.optsWithGlobals().agent),
    })

    // Layer-3 config auto-seed: ensure ~/.infra-kit/projects/<main-repo>/infra-kit.json exists (plus
    // its annotated .example.jsonc sibling) so a user always has a per-project override file to edit.
    // Self-gating: no-ops outside a git repo, and when the repo has no committed `infra-kit.json`.
    // Never throws, never changes the exit code, and performs zero writes in the steady state.
    //
    // Gated on `commandPath()`, NOT `actionCommand.name()`: a leaf's `name()` is only its last
    // segment (`config path`'s name() is just 'path'), so a name-keyed set cannot distinguish grouped
    // leaves and would collide. Nothing in SEED_EXCLUDED is a grouped leaf today, but the set must be
    // able to express one without a silent trap.
    //
    // Placed after the `--json` warn downgrade purely so a first-run `logger.info` stays out of a
    // machine consumer's stderr. That is COSMETIC, not stdout safety: `logger` is pino with
    // `destination: 2` (stderr) and `emit()` is the sole stdout writer, so the seed's log line could
    // never corrupt `--json` stdout.
    if (!SEED_EXCLUDED.has(commandPath(actionCommand))) {
      await ensureUserProjectConfig()
    }
  })

  // Session-shell side channel: after a leaf action RESOLVES (Commander runs postAction only on
  // success — never when the action throws or calls process.exit), write the report file the parent
  // reads. Its presence is what lets the parent tell a completed run from a cancel. A no-op outside a
  // session (no captured report path).
  program.hook('postAction', (_thisCommand, actionCommand) => {
    const path = commandPath(actionCommand)

    // A long-running command (`dev`) resolves its action SECONDS AFTER BOOT and then keeps running on
    // its open handles. Writing a report here would tell the parent "this produced a verdict" while the
    // server is merely starting — and report-presence is exactly how the parent tells a completed run
    // from a cancel. It would stamp a Ctrl-C out of dev `⚠ completed with findings`, and an Esc out of
    // the dev wizard `✓ ok` (claiming a server ran when none did). No report: the exit code decides.
    if (isLongRunningCommand(path)) {
      return
    }

    const snapshot = commandEcho.snapshot()
    const flags = snapshot?.formattedOptions ?? ''
    const suffix = flags ? ` ${flags}` : ''
    const line = `infra-kit ${path}${suffix}`

    writeSessionReport({ equivalent: equivalentLine(line, true) })
  })

  return program
}
