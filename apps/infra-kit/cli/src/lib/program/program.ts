import { Command } from 'commander'
import process from 'node:process'

import { audit } from 'src/commands/audit'
import { configEdit, configPath } from 'src/commands/config'
import { doctor } from 'src/commands/doctor'
import { envAutoload } from 'src/commands/env-autoload'
import { envClear } from 'src/commands/env-clear'
import { envList } from 'src/commands/env-list'
import { envLoad } from 'src/commands/env-load'
import { envStatus } from 'src/commands/env-status'
import { envTokenList } from 'src/commands/env-token-list'
import { envTokenRemove } from 'src/commands/env-token-remove'
import { envTokenSet } from 'src/commands/env-token-set'
import { ghMergeDev } from 'src/commands/gh-merge-dev'
import { ghReleaseDeliver } from 'src/commands/gh-release-deliver'
import { ghReleaseDeployAll } from 'src/commands/gh-release-deploy-all'
import { ghReleaseDeploySelected } from 'src/commands/gh-release-deploy-selected'
import { ghReleaseList } from 'src/commands/gh-release-list'
import { init } from 'src/commands/init'
import { runMcp } from 'src/commands/mcp'
import { releaseCreate } from 'src/commands/release-create'
import { releaseDescEdit } from 'src/commands/release-desc-edit'
import { reopen } from 'src/commands/reopen'
import { runSelfUpdate } from 'src/commands/self-update'
import { vendorCheck } from 'src/commands/vendor-check'
import { vendorConfig } from 'src/commands/vendor-config'
import { vendorDiff } from 'src/commands/vendor-diff'
import { vendorManifest } from 'src/commands/vendor-manifest'
import { vendorSync } from 'src/commands/vendor-sync'
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

/** Parse a `--repos a,b,c` option into a target-name list (undefined = all). */
const parseRepos = (value: unknown): string[] | undefined => {
  return typeof value === 'string' ? value.split(',').filter(Boolean) : undefined
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
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (options) => {
      emit(await ghMergeDev({ all: options.all, confirmedCommand: options.yes }))
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

const configureReleaseDeployAll = (cmd: Command): Command => {
  return cmd
    .description('Deploy any release branch to any environment')
    .option(
      '-v, --version <version>',
      'Version (e.g. 1.2.5) or release name (e.g. checkout-redesign) to deploy; "dev" deploys from the dev branch',
    )
    .option('-e, --env <env>', 'Specify the environment to deploy to, e.g. dev')
    .option('--skip-terraform', 'Skip terraform deployment step')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (options) => {
      emit(
        await ghReleaseDeployAll({
          version: options.version,
          env: options.env,
          skipTerraform: options.skipTerraform,
          confirmedCommand: options.yes,
        }),
      )
    })
}

const configureReleaseDeploySelected = (cmd: Command): Command => {
  return cmd
    .description('Deploy selected services from release branch to any environment')
    .option(
      '-v, --version <version>',
      'Version (e.g. 1.2.5) or release name (e.g. checkout-redesign) to deploy; "dev" deploys from the dev branch',
    )
    .option('-e, --env <env>', 'Specify the environment to deploy to, e.g. dev')
    .option('-s, --services <services...>', 'Specify services to deploy, e.g. client-be client-fe')
    .option('--skip-terraform', 'Skip terraform deployment step')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (options) => {
      emit(
        await ghReleaseDeploySelected({
          version: options.version,
          env: options.env,
          services: options.services,
          skipTerraform: options.skipTerraform,
          confirmedCommand: options.yes,
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

const configureVendorDiff = (cmd: Command): Command => {
  return cmd
    .description('Source-aware drift check (rsync dry-run) of each target vendored subtree vs the source')
    .option('-r, --repos <repos>', 'Restrict to comma-separated target repo names')
    .action(async (options) => {
      const result = await vendorDiff({ repos: parseRepos(options.repos) })

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

  program
    .command('audit')
    .description('Audit against infra-kit.config.ts rules (--all for every package, --root for the monorepo root)')
    .option('-a, --all', 'Audit every non-vendor workspace package')
    .option('-r, --root', 'Audit the monorepo root (turbo pipeline + root commands)')
    .action(async (options) => {
      const result = await audit({ all: options.all, root: options.root })

      emit(result)

      if (!result.structuredContent.allPassed) {
        process.exitCode = 1
      }
    })

  const vendorCmd = program.command('vendor').description('Verify and sync the mirrored vendor/ tree')

  configureVendorCheck(vendorCmd.command('check'))

  vendorCmd
    .command('sync')
    .description('Copy vendored files from the source repo into each target and regenerate manifests')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('-r, --repos <repos>', 'Restrict to comma-separated target repo names')
    .action(async (options) => {
      emit(await vendorSync({ confirmedCommand: options.yes, repos: parseRepos(options.repos) }))
    })

  vendorCmd
    .command('manifest')
    .description('Regenerate each target vendor/.sync-manifest.json + README from current content (no copy)')
    .option('-r, --repos <repos>', 'Restrict to comma-separated target repo names')
    .action(async (options) => {
      emit(await vendorManifest({ confirmedCommand: true, repos: parseRepos(options.repos) }))
    })

  configureVendorDiff(vendorCmd.command('diff'))
  configureVendorConfig(vendorCmd.command('config'))

  program
    .command('doctor')
    .description('Check installation and authentication status of gh and doppler CLIs')
    .option(
      '--fix',
      'Remove portless routes left behind by a dev-server that was killed (kill -9, OOM, force-quit). Refuses while a dev session is running, when a booting UI is indistinguishable from a dead route.',
    )
    .action(async (options) => {
      emit(await doctor({ fix: Boolean(options.fix) }))
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
    .description('Inject shell integration into .zshrc and sync repo agent-instruction files')
    .action(async () => {
      emit(await init())
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
