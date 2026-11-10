import type { Command } from 'commander'
import process from 'node:process'

import { deployRun } from 'src/commands/deploy-run'
import { deploySync } from 'src/commands/deploy-sync'
import { localDeployAllMcpTool, localDeploySelectedMcpTool } from 'src/commands/local-deploy'
import { deprecatedLocalDeploy } from 'src/commands/release-deploy'
import type { CommandCatalogEntry } from 'src/entry/command-catalog/catalog-entry'
import { emit } from 'src/lib/json-output'

/** The deprecated `local deploy-*` group. */
export const registerDeprecatedLocalCommands = (program: Command): void => {
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
}

/** `deploy-run` and `deploy-sync`. */
export const registerDeployCommands = (program: Command): void => {
  program
    .command('deploy-run')
    .description(
      'Deploy a service: its deploy.ts from infra-kit.deploy.ts, else its devops/scripts .sh (what the CI deploy job runs)',
    )
    .argument('<service>', 'The service as infra-kit.deploy.ts names it, e.g. client-be')
    .action(async (service: string) => {
      emit(await deployRun({ service }))
    })

  program
    .command('deploy-sync')
    .description('Generate the deploy-all / deploy-selected workflows from infra-kit.deploy.ts')
    .option('--check', 'Compare only; exit 1 when the committed workflows differ from the manifest')
    .action(async (options) => {
      const result = await deploySync({ check: options.check })

      emit(result)

      if (!result.structuredContent.ok) {
        process.exitCode = 1
      }
    })
}

/** Cross-surface metadata of the commands registered above, in palette order. */
export const deprecatedLocalCatalog: CommandCatalogEntry[] = [
  // The CLI commands behind these two are DEPRECATED aliases of `release deploy-* --from local`,
  // so `menuGroup: null` keeps them out of the palette while they still resolve for anyone who types
  // them. The tools are deliberately NOT folded into the release pair: `local-deploy-selected`
  // requires `service` with `.min(1)` — a merged tool would have to relax that, and an agent omitting
  // it would deploy everything. Agent-reachable while human-unbrowsable is the intended end state here.
  {
    cliName: 'local-deploy-all',
    menuGroup: null,
    mcpTool: localDeployAllMcpTool,
    mcpExposed: true,
    // Writes to real cloud infrastructure. Both carry `requiresHumanConfirm`, so an agent gets the
    // two-phase gate — unlike the release-deploy-* pair these leave no CI run to inspect afterwards.
    mutating: true,
    groupPath: ['local', 'deploy-all'],
  },
  {
    cliName: 'local-deploy-selected',
    menuGroup: null,
    mcpTool: localDeploySelectedMcpTool,
    mcpExposed: true,
    mutating: true,
    groupPath: ['local', 'deploy-selected'],
  },
]

/** Cross-surface metadata of the commands registered above, in palette order. */
export const deployCatalog: CommandCatalogEntry[] = [
  // Generates the repo's deploy workflows from infra-kit.deploy.ts. No palette row: a bare pick would
  // rewrite tracked files from the menu, and the command is run beside an edit of the manifest anyway.
  // Deploys with whatever AWS credentials are loaded and checks nothing itself: CI's deploy job runs it,
  // a human may, an agent only through `local deploy-*`, whose gates ran first (see deploy-run.ts).
  {
    cliName: 'deploy-run',
    menuGroup: null,
    mcpTool: null,
    mcpExposed: false,
    mutating: true,
    humanOnly: true,
    groupPath: ['deploy-run'],
  },
  {
    cliName: 'deploy-sync',
    menuGroup: null,
    mcpTool: null,
    mcpExposed: false,
    mutating: true,
    groupPath: ['deploy-sync'],
  },
]
