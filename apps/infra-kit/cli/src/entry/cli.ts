import select, { Separator } from '@inquirer/select'
import { Command } from 'commander'
import process from 'node:process'

import { audit } from 'src/commands/audit'
import { configEdit, configPath } from 'src/commands/config'
import { doctor } from 'src/commands/doctor'
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
import { version } from 'src/commands/version'
import { CURSOR_MODES, worktreesAdd } from 'src/commands/worktrees-add'
import type { CursorMode } from 'src/commands/worktrees-add'
import { worktreesList } from 'src/commands/worktrees-list'
import { worktreesOpen } from 'src/commands/worktrees-open'
import { worktreesRemove } from 'src/commands/worktrees-remove'
import { worktreesSync } from 'src/commands/worktrees-sync'
import { logger } from 'src/lib/logger'
import { parseReleaseSpec } from 'src/lib/version-utils'
import type { ReleaseInput } from 'src/lib/version-utils'

const program = new Command()

const collectReleaseSpec = (value: string, prev: string[]): string[] => {
  return [...prev, value]
}

const normalizeCursorMode = (value: unknown): CursorMode | undefined => {
  if (typeof value === 'undefined') {
    return undefined
  }

  if (value === true) {
    return 'workspace'
  }

  if (value === false) {
    return 'none'
  }

  if (typeof value === 'string' && (CURSOR_MODES as readonly string[]).includes(value)) {
    return value as CursorMode
  }

  throw new Error(`Invalid --cursor value "${String(value)}". Expected one of: ${CURSOR_MODES.join(', ')}.`)
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

program
  .command('merge-dev')
  .description('Merge dev branch into every release branch')
  .option('-a, --all', 'Select all active release branches')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (options) => {
    await ghMergeDev({ all: options.all, confirmedCommand: options.yes })
  })

program
  .command('release-list')
  .description('List all release branches')
  .action(async () => {
    await ghReleaseList()
  })

program
  .command('release-create')
  .description('Create one or more release branches (each entry can mix regular/hotfix and its own description)')
  .option(
    '-r, --release <spec>',
    'Release spec "version[:type[:description]]" (repeatable). Examples: "1.2.5", "1.2.5:hotfix", "next:regular:Holiday backend"',
    collectReleaseSpec,
    [],
  )
  .option(
    '-n, --name <name>',
    'Named release (repeatable). Bare kebab-case name, e.g. "checkout-redesign". Creates a regular release; set a description later via release-desc-edit. Can be combined with --release.',
    collectReleaseSpec,
    [],
  )
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (options) => {
    const specs = options.release as string[]
    const names = options.name as string[]
    const versionInputs: ReleaseInput[] = specs.map(parseReleaseSpec)
    const nameInputs: ReleaseInput[] = names.map((name) => {
      return { name, type: 'regular' as const }
    })
    const combined = [...versionInputs, ...nameInputs]
    const releases = combined.length > 0 ? combined : undefined

    await releaseCreate({
      releases,
      confirmedCommand: options.yes,
    })
  })

program
  .command('release-desc-edit')
  .description("Edit a release's description in Jira and in the matching GitHub PR body")
  .option('-v, --version <version>', 'Release version (e.g. 1.2.5) or release name (e.g. checkout-redesign)')
  .option('-d, --description <description>', 'New description (use "" to clear)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (options) => {
    await releaseDescEdit({
      version: options.version,
      description: options.description,
      confirmedCommand: options.yes,
    })
  })

program
  .command('release-deploy-all')
  .description('Deploy any release branch to any environment')
  .option(
    '-v, --version <version>',
    'Version (e.g. 1.2.5) or release name (e.g. checkout-redesign) to deploy; "dev" deploys from the dev branch',
  )
  .option('-e, --env <env>', 'Specify the environment to deploy to, e.g. dev')
  .option('--skip-terraform', 'Skip terraform deployment step')
  .action(async (options) => {
    await ghReleaseDeployAll({ version: options.version, env: options.env, skipTerraform: options.skipTerraform })
  })

program
  .command('release-deploy-selected')
  .description('Deploy selected services from release branch to any environment')
  .option(
    '-v, --version <version>',
    'Version (e.g. 1.2.5) or release name (e.g. checkout-redesign) to deploy; "dev" deploys from the dev branch',
  )
  .option('-e, --env <env>', 'Specify the environment to deploy to, e.g. dev')
  .option('-s, --services <services...>', 'Specify services to deploy, e.g. client-be client-fe')
  .option('--skip-terraform', 'Skip terraform deployment step')
  .action(async (options) => {
    await ghReleaseDeploySelected({
      version: options.version,
      env: options.env,
      services: options.services,
      skipTerraform: options.skipTerraform,
    })
  })

program
  .command('release-deliver')
  .description('Release a new version to production')
  .option('-v, --version <version>', 'Version (e.g. 1.2.5) or release name (e.g. checkout-redesign) to deliver')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (options) => {
    await ghReleaseDeliver({ version: options.version, confirmedCommand: options.yes })
  })

program
  .command('worktrees-sync')
  .description('Remove release worktrees whose PRs are no longer open')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (options) => {
    await worktreesSync({ confirmedCommand: options.yes })
  })

program
  .command('worktrees-add')
  .description('Add git worktrees for release branches')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('-a, --all', 'Select all active release branches')
  .option('-v, --versions <versions>', 'Specify versions by comma, e.g. 1.2.5, 1.2.6')
  .option('-c, --cursor [mode]', 'Cursor mode for created worktrees: workspace (default) | windows | none')
  .option('--no-cursor', 'Skip Cursor (alias for --cursor none)')
  .option('-g, --github-desktop', 'Open created worktrees in GitHub Desktop')
  .option('--no-github-desktop', 'Skip GitHub Desktop prompt')
  .option('-m, --cmux', 'Open created worktrees in cmux (3-pane layout)')
  .option('--no-cmux', 'Skip cmux prompt')
  .action(async (options) => {
    await worktreesAdd({
      confirmedCommand: options.yes,
      all: options.all,
      versions: options.versions,
      cursor: normalizeCursorMode(options.cursor),
      githubDesktop: options.githubDesktop,
      cmux: options.cmux,
    })
  })

program
  .command('worktrees-list')
  .description('List all git worktrees with detailed information')
  .action(async () => {
    await worktreesList()
  })

program
  .command('worktrees-remove')
  .description('Remove git worktrees for release branches')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('-a, --all', 'Select all active release branches')
  .option('-v, --versions <versions>', 'Specify versions by comma, e.g. 1.2.5, 1.2.6')
  .action(async (options) => {
    await worktreesRemove({ confirmedCommand: options.yes, all: options.all, versions: options.versions })
  })

program
  .command('worktrees-open')
  .description('Open Cursor + cmux for existing release worktrees (cold-start restore)')
  .action(async () => {
    await worktreesOpen()
  })

const configCmd = program.command('config').description('Manage infra-kit configuration files')

configCmd
  .command('path')
  .description('Show the resolved config merge chain and file paths')
  .action(async () => {
    await configPath()
  })

configCmd
  .command('edit')
  .description('Open the user-scope per-project override file in $EDITOR')
  .action(async () => {
    await configEdit()
  })

program
  .command('audit')
  .description('Audit against infra-kit.config.ts rules (--all for every package, --root for the monorepo root)')
  .option('-a, --all', 'Audit every non-vendor workspace package')
  .option('-r, --root', 'Audit the monorepo root (turbo pipeline + root commands)')
  .action(async (options) => {
    const result = await audit({ all: options.all, root: options.root })

    if (!result.structuredContent.allPassed) {
      process.exitCode = 1
    }
  })

program
  .command('doctor')
  .description('Check installation and authentication status of gh and doppler CLIs')
  .action(async () => {
    await doctor()
  })

program
  .command('version')
  .description('Print the installed infra-kit CLI version')
  .action(async () => {
    await version()
  })

program
  .command('env-status')
  .description('Show Doppler authentication status and detected project info')
  .action(async () => {
    await envStatus()
  })

program
  .command('env-list')
  .description('List available Doppler configs for the detected project')
  .action(async () => {
    await envList()
  })

program
  .command('init')
  .description('Inject shell integration into your profile .zshrc')
  .action(async () => {
    await init()
  })

program
  .command('env-load')
  .description('Load Doppler env vars for a config. Source the returned file path to apply.')
  .option('-c, --config <config>', 'Environment config name to load (e.g. dev, arthur)')
  .action(async (options) => {
    await envLoad({ config: options.config })
  })

program
  .command('env-clear')
  .description('Clear loaded env vars. Source the returned file path to apply.')
  .action(async () => {
    await envClear()
  })

if (process.argv.length <= 2) {
  const releaseCommands = [
    'merge-dev',
    'release-list',
    'release-create',
    'release-desc-edit',
    'release-deploy-all',
    'release-deploy-selected',
    'release-deliver',
  ]
  const worktreeCommands = ['worktrees-add', 'worktrees-list', 'worktrees-open', 'worktrees-remove', 'worktrees-sync']
  const envCommands = [
    'audit',
    'doctor',
    'init',
    'version',
    'config',
    'env-status',
    'env-list',
    'env-load',
    'env-clear',
  ]

  const commandMap = new Map(
    program.commands.map((cmd) => {
      return [cmd.name(), cmd]
    }),
  )

  const allNames = [...releaseCommands, ...worktreeCommands, ...envCommands]
  const maxLen = Math.max(
    ...allNames.map((n) => {
      return n.length
    }),
  )

  const toChoices = (names: string[]) => {
    return names
      .filter((n) => {
        return commandMap.has(n)
      })
      .map((n) => {
        return {
          name: `${n.padEnd(maxLen)}  ${commandMap.get(n)!.description()}`,
          value: n,
        }
      })
  }

  const selected = await select(
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

  await runProgram(['node', 'infra-kit', selected])
} else {
  await runProgram()
}
