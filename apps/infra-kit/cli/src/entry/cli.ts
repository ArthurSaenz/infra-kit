import select, { Separator } from '@inquirer/select'
import { Command, Option } from 'commander'
import process from 'node:process'

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
import { releaseCreateBatch } from 'src/commands/release-create-batch'
import { worktreesAdd } from 'src/commands/worktrees-add'
import { worktreesList } from 'src/commands/worktrees-list'
import { worktreesRemove } from 'src/commands/worktrees-remove'
import { worktreesSync } from 'src/commands/worktrees-sync'

const program = new Command()

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
  .description('Create a single release branch')
  .option('-v, --version <version>', 'Specify the version to create, e.g. 1.2.5')
  .option('-d, --description <description>', 'Optional description for the Jira version')
  .addOption(new Option('-t, --type <type>', 'Release type (default: regular)').choices(['regular', 'hotfix']))
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--no-checkout', 'Do not checkout the created branch after creation (checkout is default)')
  .action(async (options) => {
    await releaseCreate({
      version: options.version,
      description: options.description,
      type: options.type,
      confirmedCommand: options.yes,
      checkout: options.checkout,
    })
  })

program
  .command('release-create-batch')
  .description('Create multiple release branches (batch operation)')
  .option('-v, --versions <versions>', 'Specify the versions to create by comma, e.g. 1.2.5, 1.2.6')
  .addOption(new Option('-t, --type <type>', 'Release type (default: regular)').choices(['regular', 'hotfix']))
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (options) => {
    await releaseCreateBatch({
      versions: options.versions,
      type: options.type,
      confirmedCommand: options.yes,
    })
  })

program
  .command('release-deploy-all')
  .description('Deploy any release branch to any environment')
  .option('-v, --version <version>', 'Specify the version to deploy, e.g. 1.2.5')
  .option('-e, --env <env>', 'Specify the environment to deploy to, e.g. dev')
  .option('--skip-terraform', 'Skip terraform deployment step')
  .action(async (options) => {
    await ghReleaseDeployAll({ version: options.version, env: options.env, skipTerraform: options.skipTerraform })
  })

program
  .command('release-deploy-selected')
  .description('Deploy selected services from release branch to any environment')
  .option('-v, --version <version>', 'Specify the version to deploy, e.g. 1.2.5')
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
  .option('-v, --version <version>', 'Specify the version to release, e.g. 1.2.5')
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
  .option('-c, --cursor', 'Open created worktrees in Cursor')
  .option('--no-cursor', 'Skip Cursor prompt')
  .option('-g, --github-desktop', 'Open created worktrees in GitHub Desktop')
  .option('--no-github-desktop', 'Skip GitHub Desktop prompt')
  .action(async (options) => {
    await worktreesAdd({
      confirmedCommand: options.yes,
      all: options.all,
      versions: options.versions,
      cursor: options.cursor,
      githubDesktop: options.githubDesktop,
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
  .command('doctor')
  .description('Check installation and authentication status of gh and doppler CLIs')
  .action(async () => {
    await doctor()
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
    'release-create-batch',
    'release-deploy-all',
    'release-deploy-selected',
    'release-deliver',
  ]
  const worktreeCommands = ['worktrees-add', 'worktrees-list', 'worktrees-remove', 'worktrees-sync']
  const envCommands = ['doctor', 'init', 'env-status', 'env-list', 'env-load', 'env-clear']

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

  program.parse(['node', 'infra-kit', selected])
} else {
  program.parse()
}
