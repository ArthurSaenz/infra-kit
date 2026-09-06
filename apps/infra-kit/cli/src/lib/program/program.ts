import { Command } from 'commander'
import process from 'node:process'

import { audit } from 'src/commands/audit'
import { configEdit, configPath } from 'src/commands/config'
import { configGet } from 'src/commands/config-get'
import { devStatus } from 'src/commands/dev-status'
import { doctor, printDoctorReport } from 'src/commands/doctor'
import { envAutoload } from 'src/commands/env-autoload'
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
import { init } from 'src/commands/init'
import { runMcp } from 'src/commands/mcp'
import { releaseCreate } from 'src/commands/release-create'
import { deprecatedLocalDeploy, releaseDeployAll, releaseDeploySelected } from 'src/commands/release-deploy'
import { releaseDescEdit } from 'src/commands/release-desc-edit'
import { reopen } from 'src/commands/reopen'
import { runSelfUpdate } from 'src/commands/self-update'
import { vendorCheck } from 'src/commands/vendor-check'
import { vendorConfig } from 'src/commands/vendor-config'
import { version } from 'src/commands/version'
import { worktreesAdd } from 'src/commands/worktrees-add'
import { worktreesList } from 'src/commands/worktrees-list'
import { worktreesRemove } from 'src/commands/worktrees-remove'
import { worktreesSync } from 'src/commands/worktrees-sync'
import { IDE_MODES } from 'src/integrations/ide'
import type { IdeMode } from 'src/integrations/ide'
import { isLongRunningCommand } from 'src/lib/command-catalog'
import { commandEcho } from 'src/lib/command-echo'
import { ensureUserProjectConfig } from 'src/lib/config-bootstrap'
import { runEnvAutoLoad, surfaceStickyAuthFailure } from 'src/lib/env-autoload'
import { addJsonOption, emit, jsonOutput } from 'src/lib/json-output'
import { logger } from 'src/lib/logger'
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
      // `ghMergeDev` is also the MCP tool handler inside a long-lived server,
      // where a per-invocation handler calling process.exit would preempt the
      // host's shutdown and take the server down on a stray signal.
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
      'Release spec "<version|next|name>[:type[:description]]" (repeatable). The token is a semver ("1.2.5"), the literal "next", or a kebab-case name ("checkout-redesign"). Type is regular|hotfix (default regular). Examples: "1.2.5", "1.2.5:hotfix", "next:regular:Holiday backend", "checkout-redesign:regular:Q3 redesign".',
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

const configureReleaseDescEdit = (cmd: Command): Command => {
  return cmd
    .description("Edit a release's description in Jira and in the matching GitHub PR body")
    .option('-v, --version <version>', 'Release version (e.g. 1.2.5) or release name (e.g. checkout-redesign)')
    .option('-d, --description <description>', 'New description (use "" to clear)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (options) => {
      emit(
        await releaseDescEdit({
          version: options.version,
          description: options.description,
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
    .option('-m, --cmux', 'Open created worktrees in cmux (3-pane layout)')
    .option('--no-cmux', 'Skip cmux prompt')
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
          cmux: options.cmux,
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

const configureReopen = (cmd: Command): Command => {
  return cmd
    .description('Reopen editor + cmux windows for every active worktree in the current project (additive, idempotent)')
    .option('--all', 'Reopen across every discovered infra-kit project (Stage 3 — not yet implemented)')
    .option('--project <names...>', 'Restrict --all to these project names')
    .option('--root <paths...>', 'Discovery roots for --all (repeatable)')
    .option('--release-only', 'Restrict to release worktrees (reproduces the legacy worktrees-reload scope)')
    .option('--force', 'Close each cmux workspace first, then reopen (the legacy worktrees-reload behaviour)')
    .option('--dry-run', 'Print the plan (paths + cmux titles) and spawn nothing')
    .action(async (options) => {
      emit(
        await reopen({
          all: options.all,
          project: options.project,
          root: options.root,
          releaseOnly: options.releaseOnly,
          force: options.force,
          dryRun: options.dryRun,
        }),
      )
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

// Commands excluded from the cli-invocation auto-load trigger: the env-* family
// (avoids recursion — `env-autoload`/`env-load` would re-enter), plus the
// host-inspecting / meta commands where priming Doppler env would be surprising
// (`init` bootstraps the shell block, `doctor` inspects auth, `version` prints a
// string, `dev` is a long-running server that manages its own env,
// `self-update` replaces this binary, and `mcp` hands its stdio to a child).
// `--help`/`--version`/the bare-arg menu don't fire preAction at all.
const AUTO_LOAD_EXCLUDED = new Set(['init', 'doctor', 'version', 'dev', 'self-update', 'mcp'])

const isAutoLoadExcludedCommand = (name: string): boolean => {
  return name.startsWith('env-') || AUTO_LOAD_EXCLUDED.has(name)
}

// Commands excluded from the layer-3 config auto-seed. A SEPARATE, much SMALLER set than
// AUTO_LOAD_EXCLUDED above — the asymmetry is intentional, not an oversight:
//   - `env-autoload` is the hidden command the zsh precmd hook fires BACKGROUNDED on every prompt
//     (see the shell body in init.ts). It runs constantly; the seed has no business on that path.
//   - `mcp` is excluded for LAZINESS, not cwd: the MCP server seeds at its first TOOL INVOCATION
//     (lib/tool-handler), so a server that never receives a tool call never writes to $HOME.
//   - `version` / `self-update` touch config ZERO times today, so seeding is pure new cost on the two
//     fastest paths; `self-update` also re-execs the binary.
// Everything else DOES seed — `doctor`, `config path`, `dev` and `init` included (they are all in
// AUTO_LOAD_EXCLUDED, but that set answers a different question), as does the whole `env-*` family
// apart from `env-autoload`.
const SEED_EXCLUDED = new Set(['env-autoload', 'mcp', 'version', 'self-update'])

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
 * `release-create`), plus `--json` on every command and the pre-action auto-load hook. Pure: no I/O, no
 * top-level await, no process mutation — safe to import from a test to introspect the command tree.
 *
 * @example
 * const program = buildProgram()
 * program.commands.some((c) => c.name() === 'doctor') // => true
 */
export const buildProgram = (): Command => {
  const program = new Command()

  // --- Grouped command surface (preferred form) ---
  const releaseGroup = program.command('release').description('Release management commands')

  configureMergeDev(releaseGroup.command('merge-dev'))
  configureReleaseList(releaseGroup.command('list'))
  configureReleaseCreate(releaseGroup.command('create'))
  configureReleaseDescEdit(releaseGroup.command('desc-edit'))
  configureReleaseDeployAll(releaseGroup.command('deploy-all'))
  configureReleaseDeploySelected(releaseGroup.command('deploy-selected'))
  configureReleaseDeliver(releaseGroup.command('deliver'))

  const worktreesGroup = program.command('worktrees').description('Git worktree management commands')

  configureWorktreesAdd(worktreesGroup.command('add'))
  configureWorktreesList(worktreesGroup.command('list'))
  configureWorktreesRemove(worktreesGroup.command('remove'))
  configureWorktreesSync(worktreesGroup.command('sync'))

  // Top-level (`infra-kit reopen`), not under the worktrees group — house rule: new commands go
  // top-level with related names, not nested under a group. It still renders in the Worktrees palette
  // group via its catalog menuGroup.
  configureReopen(program.command('reopen'))

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
      // the exit code, so the MCP tool can reuse it. The second clause is not redundant — before
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

  const vendorCmd = program.command('vendor').description('Verify the mirrored vendor/ tree')

  configureVendorCheck(vendorCmd.command('check'))
  configureVendorConfig(vendorCmd.command('config'))

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

      // Presentation lives here, not in `doctor()`: the MCP tool shares that function and has no
      // terminal. Skipped entirely under `--json` so stdout carries the payload and nothing else.
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

  // No `update` alias: the `update` verb is reserved.
  program
    .command('self-update')
    .description('Update this CLI using the package manager that installed it')
    .option('--dry-run', 'Print the detected manager and the command that would run; install nothing')
    .action((options) => {
      runSelfUpdate({ dryRun: Boolean(options.dryRun) })
    })

  program
    .command('mcp')
    .description('Run the infra-kit MCP server (stdio transport)')
    .action(() => {
      runMcp()
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
      '--cmux',
      'Run each app in its own cmux pane (one workspace, N panes; falls back to single terminal if cmux is unavailable)',
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
    .command('init')
    .description(
      'Inject shell integration into .zshrc, sync repo agent-instruction files, and install the Claude Code plugin',
    )
    .option('--skip-plugin', 'do not install the Claude Code plugin; only write the settings keys')
    .action(async (options) => {
      emit(await init({ skipPlugin: Boolean(options.skipPlugin) }))
    })

  program
    .command('env-load')
    .description('Load Doppler env vars for a config. Source the returned file path to apply.')
    .option('-c, --config <config>', 'Environment config name to load (e.g. dev, arthur)')
    .action(async (options) => {
      emit(await envLoad({ config: options.config }))
    })

  program
    .command('env-clear')
    .description('Clear loaded env vars. Source the returned file path to apply.')
    .option('--purge', "Also delete this project's warm cache outright (durable disable)")
    .action(async (options) => {
      emit(await envClear({ purge: Boolean(options.purge) }))
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

  // Internal: driven by the init shell-startup integration (backgrounded). Writes
  // env-load.sh when envAutoLoad is configured + eligible; the precmd hook sources
  // it. Hidden + no stdout output so it never pollutes the shell or the menu.
  program
    .command('env-autoload', { hidden: true })
    .description('Internal: prime env for the shell-startup auto-load trigger')
    // The shell passes its already-canonicalized (`${dir:A}`) project dir so node can
    // key the warm cache identically; see writeEnvLoadFile / shouldWriteWarm.
    .option('--project-dir <dir>', 'Canonical project dir for the warm-cache key (shell-startup only)')
    .action(async (options) => {
      await envAutoload({ projectDir: options.projectDir })
    })

  // Register `--json` on every command, then resolve the flag before each action
  // runs. In JSON mode we lower the logger to `warn` so the human-oriented info
  // lines stop cluttering stderr while errors still surface; the structured
  // payload is written to stdout by `emit`. No handler logic is affected.
  program.commands.forEach(addJsonOption)

  program.hook('preAction', async (_thisCommand, actionCommand) => {
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

    // Replay a sticky Doppler auth failure (revoked / mis-scoped service token) recorded
    // by the BACKGROUNDED shell-startup auto-load, which runs with stderr discarded and
    // so has no channel of its own. Deliberately OUTSIDE the auto-load exclusion below:
    // warning is not loading. `version`, `doctor` and `dev` never auto-load, but they are
    // exactly what a user whose shell env went quiet runs next — gating the warning on the
    // same set would leave them warned by nothing. Warns at most once per session, never
    // throws, and writes nothing to stdout.
    surfaceStickyAuthFailure()

    // cli-invocation auto-load: primes the shell env for SUBSEQUENT commands. The
    // current command does NOT see these vars — a child process can't mutate its
    // parent shell; the precmd hook sources the written file on the next prompt.
    // runEnvAutoLoad self-gates on config trigger and swallows transient failures,
    // so this is a no-op unless configured for cli-invocation and never blocks.
    if (!isAutoLoadExcludedCommand(actionCommand.name())) {
      await runEnvAutoLoad({ expectedTrigger: 'cli-invocation' })
    }
  })

  // Session-shell side channel: after a leaf action RESOLVES (Commander runs postAction only on
  // success — never when the action throws or calls process.exit), write the report file the parent
  // reads. Its presence is what lets the parent tell a completed run from a cancel. A no-op outside a
  // session (no captured report path) and never on the MCP path (that never builds this program).
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
