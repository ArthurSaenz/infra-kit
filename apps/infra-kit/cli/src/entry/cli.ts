import select, { Separator } from '@inquirer/select'
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
import { ghMergeDev } from 'src/commands/gh-merge-dev'
import { ghReleaseDeliver } from 'src/commands/gh-release-deliver'
import { ghReleaseDeployAll } from 'src/commands/gh-release-deploy-all'
import { ghReleaseDeploySelected } from 'src/commands/gh-release-deploy-selected'
import { ghReleaseList } from 'src/commands/gh-release-list'
import { init } from 'src/commands/init'
import { releaseCreate } from 'src/commands/release-create'
import { releaseDescEdit } from 'src/commands/release-desc-edit'
import { vendorCheck } from 'src/commands/vendor-check'
import { vendorConfig } from 'src/commands/vendor-config'
import { vendorDiff } from 'src/commands/vendor-diff'
import { vendorManifest } from 'src/commands/vendor-manifest'
import { vendorSync } from 'src/commands/vendor-sync'
import { version } from 'src/commands/version'
import { worktreesAdd } from 'src/commands/worktrees-add'
import { worktreesList } from 'src/commands/worktrees-list'
import { worktreesReload } from 'src/commands/worktrees-reload'
import { worktreesRemove } from 'src/commands/worktrees-remove'
import { worktreesSync } from 'src/commands/worktrees-sync'
import { IDE_MODES } from 'src/integrations/ide'
import type { IdeMode } from 'src/integrations/ide'
import { getMenuGroupCommands } from 'src/lib/command-catalog'
import { runEnvAutoLoad } from 'src/lib/env-autoload'
import { addJsonOption, emit, jsonOutput } from 'src/lib/json-output'
import { logger } from 'src/lib/logger'
import { formatAlignedRows } from 'src/lib/render'
import { parseReleaseSpec } from 'src/lib/version-utils'
import type { ReleaseInput } from 'src/lib/version-utils'

const program = new Command()

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

const runProgram = async (argv?: string[]): Promise<void> => {
  try {
    if (argv) {
      await program.parseAsync(argv)
    } else {
      await program.parseAsync()
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    logger.error(message)
    process.exit(1)
  }
}

// --- Deprecation support for flat command aliases (Phase 3 grouping) ---
// Flat names (`release-create`, `worktrees-add`, `vendor-config`, ...) are kept
// as working aliases of the grouped forms (`release create`, ...) for one
// release cycle. They warn once when invoked directly, but stay silent when the
// interactive no-arg menu drives them (the menu is a guided surface).
const invokedViaMenu = { value: false }

const deprecatedAlias = (cmd: Command, preferred: string): Command => {
  return cmd.hook('preAction', () => {
    if (!invokedViaMenu.value) {
      logger.warn(`"${cmd.name()}" is a deprecated alias; use "${preferred}" instead.`)
    }
  })
}

// --- Command configurators (one source of options + action, shared by the
// grouped form and its flat alias so the two can never diverge) ---
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

const configureWorktreesReload = (cmd: Command): Command => {
  return cmd
    .description(
      'Close all cmux/editor worktree windows, then reopen the current release worktrees (also cold-start restore)',
    )
    .action(async () => {
      emit(await worktreesReload())
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
configureWorktreesReload(worktreesGroup.command('reload'))

// --- Deprecated flat aliases (kept one release cycle; warn when used directly) ---
deprecatedAlias(configureMergeDev(program.command('merge-dev')), 'release merge-dev')
deprecatedAlias(configureReleaseList(program.command('release-list')), 'release list')
deprecatedAlias(configureReleaseCreate(program.command('release-create')), 'release create')
deprecatedAlias(configureReleaseDescEdit(program.command('release-desc-edit')), 'release desc-edit')
deprecatedAlias(configureReleaseDeployAll(program.command('release-deploy-all')), 'release deploy-all')
deprecatedAlias(configureReleaseDeploySelected(program.command('release-deploy-selected')), 'release deploy-selected')
deprecatedAlias(configureReleaseDeliver(program.command('release-deliver')), 'release deliver')
deprecatedAlias(configureWorktreesAdd(program.command('worktrees-add')), 'worktrees add')
deprecatedAlias(configureWorktreesList(program.command('worktrees-list')), 'worktrees list')
deprecatedAlias(configureWorktreesRemove(program.command('worktrees-remove')), 'worktrees remove')
deprecatedAlias(configureWorktreesSync(program.command('worktrees-sync')), 'worktrees sync')
deprecatedAlias(configureWorktreesReload(program.command('worktrees-reload')), 'worktrees reload')

const configCmd = program.command('config').description('Manage infra-kit configuration files')

configCmd
  .command('path')
  .description('Show the resolved config merge chain and file paths')
  .action(async () => {
    emit(await configPath())
  })

configCmd
  .command('edit')
  .description('Open the user-scope per-project override file in $EDITOR')
  .action(async () => {
    emit(await configEdit())
  })

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

vendorCmd
  .command('check')
  .description('Verify vendor/ matches vendor/.sync-manifest.json (self-contained; for any consumer repo)')
  .action(async () => {
    const result = await vendorCheck()

    emit(result)

    if (!result.structuredContent.ok) {
      process.exitCode = 1
    }
  })

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

vendorCmd
  .command('diff')
  .description('Source-aware drift check (rsync dry-run) of each target vendored subtree vs the source')
  .option('-r, --repos <repos>', 'Restrict to comma-separated target repo names')
  .action(async (options) => {
    const result = await vendorDiff({ repos: parseRepos(options.repos) })

    emit(result)

    if (!result.structuredContent.ok) {
      process.exitCode = 1
    }
  })

// Grouped form (preferred); the flat `vendor-config` below is a deprecated alias.
configureVendorConfig(vendorCmd.command('config'))

deprecatedAlias(configureVendorConfig(program.command('vendor-config')), 'vendor config')

program
  .command('doctor')
  .description('Check installation and authentication status of gh and doppler CLIs')
  .action(async () => {
    emit(await doctor())
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
  .description('List available Doppler configs for the detected project')
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
  .action(async () => {
    emit(await envClear())
  })

// Internal: driven by the init shell-startup integration (backgrounded). Writes
// env-load.sh when envAutoLoad is configured + eligible; the precmd hook sources
// it. Hidden + no stdout output so it never pollutes the shell or the menu.
program
  .command('env-autoload', { hidden: true })
  .description('Internal: prime env for the shell-startup auto-load trigger')
  .action(async () => {
    await envAutoload()
  })

// Register `--json` on every command, then resolve the flag before each action
// runs. In JSON mode we lower the logger to `warn` so the human-oriented info
// lines stop cluttering stderr while errors still surface; the structured
// payload is written to stdout by `emit`. No handler logic is affected.
program.commands.forEach(addJsonOption)

// Commands excluded from the cli-invocation auto-load trigger: the env-* family
// (avoids recursion — `env-autoload`/`env-load` would re-enter), plus the
// host-inspecting / meta commands where priming Doppler env would be surprising
// (`init` bootstraps the shell block, `doctor` inspects auth, `version` prints a
// string). `--help`/`--version`/the bare-arg menu don't fire preAction at all.
const isAutoLoadExcludedCommand = (name: string): boolean => {
  return name.startsWith('env-') || name === 'init' || name === 'doctor' || name === 'version'
}

program.hook('preAction', async (_thisCommand, actionCommand) => {
  // `optsWithGlobals` (not `opts`) so `--json` is seen on grouped subcommands:
  // for `release list --json` Commander binds the post-subcommand flag to the
  // parent `release` group, so the leaf's own `opts()` would not carry it.
  jsonOutput.enabled = Boolean(actionCommand.optsWithGlobals().json)

  if (jsonOutput.enabled) {
    logger.level = 'warn'
  }

  // cli-invocation auto-load: primes the shell env for SUBSEQUENT commands. The
  // current command does NOT see these vars — a child process can't mutate its
  // parent shell; the precmd hook sources the written file on the next prompt.
  // runEnvAutoLoad self-gates on config trigger and swallows transient failures,
  // so this is a no-op unless configured for cli-invocation and never blocks.
  if (!isAutoLoadExcludedCommand(actionCommand.name())) {
    await runEnvAutoLoad({ expectedTrigger: 'cli-invocation' })
  }
})

if (process.argv.length <= 2) {
  // Menu groups derive from the single command catalog (no hand-maintained
  // name arrays). Membership and order live in src/lib/command-catalog.
  const releaseCommands = getMenuGroupCommands('release')
  const worktreeCommands = getMenuGroupCommands('worktrees')
  const envCommands = getMenuGroupCommands('environment')

  const commandMap = new Map(
    program.commands.map((cmd) => {
      return [cmd.name(), cmd]
    }),
  )

  const groups = [
    { label: 'Release Management', names: releaseCommands },
    { label: 'Worktrees', names: worktreeCommands },
    { label: 'Environment', names: envCommands },
  ]

  // Flat {name, description, group} list shared by both the Ink palette and the
  // Inquirer fallback; descriptions come from Commander (single source).
  const paletteItems = groups.flatMap(({ label, names }) => {
    return names
      .filter((name) => {
        return commandMap.has(name)
      })
      .map((name) => {
        return { name, description: commandMap.get(name)!.description(), group: label }
      })
  })

  let selected: string | null

  // Interactive TTY → Ink command palette, loaded lazily via dynamic import so
  // React/Ink never touch the MCP / `--json` / non-TTY code paths. Otherwise fall
  // back to the Inquirer menu (scripts, pipes, CI).
  if (process.stdout.isTTY && process.stdin.isTTY) {
    const { runCommandPalette } = await import('src/tui/boot')

    selected = await runCommandPalette(paletteItems)
  } else {
    const alignedLabels = formatAlignedRows(
      paletteItems.map((item) => {
        return [item.name, item.description] as const
      }),
    )
    const labelByName = new Map<string, string>()

    paletteItems.forEach((item, index) => {
      labelByName.set(item.name, alignedLabels[index] ?? item.name)
    })

    const toChoices = (names: string[]) => {
      return names
        .filter((name) => {
          return commandMap.has(name)
        })
        .map((name) => {
          return {
            name: labelByName.get(name) ?? name,
            value: name,
          }
        })
    }

    selected = await select(
      {
        message: 'Select a command to run',
        choices: [
          new Separator(' '),
          new Separator('— Release Management —'),
          ...toChoices(releaseCommands),
          new Separator(' '),
          new Separator('— Worktrees —'),
          ...toChoices(worktreeCommands),
          new Separator(' '),
          new Separator('— Environment —'),
          ...toChoices(envCommands),
        ],
      },
      { output: process.stderr },
    )
  }

  // The menu is a guided surface; don't nag about deprecated flat names here.
  if (selected) {
    invokedViaMenu.value = true

    await runProgram(['node', 'infra-kit', selected])
  }
} else {
  await runProgram()
}
