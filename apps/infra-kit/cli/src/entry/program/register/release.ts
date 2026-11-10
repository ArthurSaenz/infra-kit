import { InvalidArgumentError } from 'commander'
import type { Command } from 'commander'

import { ghMergeDev, ghMergeDevMcpTool } from 'src/commands/gh-merge-dev'
import { withRunCleanup } from 'src/commands/gh-merge-dev/run-cleanup'
import { ghReleaseDeliver, ghReleaseDeliverMcpTool } from 'src/commands/gh-release-deliver'
import { ghReleaseList, ghReleaseListMcpTool } from 'src/commands/gh-release-list'
import { releaseCreate, releaseCreateMcpTool } from 'src/commands/release-create'
import { releaseDeployAll, releaseDeploySelected } from 'src/commands/release-deploy'
import { ghReleaseDeployAllMcpTool } from 'src/commands/release-deploy/gh-release-deploy-all'
import { ghReleaseDeploySelectedMcpTool } from 'src/commands/release-deploy/gh-release-deploy-selected'
import { releaseEdit, releaseEditMcpTool } from 'src/commands/release-edit'
import { releaseRemove, releaseRemoveMcpTool } from 'src/commands/release-remove'
import type { CommandCatalogEntry } from 'src/entry/command-catalog/catalog-entry'
import { emit } from 'src/lib/json-output'
import { InvalidReleaseDateError, assertIsoDate } from 'src/lib/release-date'
import { DEPLOY_SOURCES } from 'src/lib/release-deploy'
import { parseReleaseSpec } from 'src/lib/version-utils'
import type { ReleaseInput } from 'src/lib/version-utils'

import { emitOutcome } from '../emit-outcome'

const collectReleaseSpec = (value: string, prev: string[]): string[] => {
  return [...prev, value]
}

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
    .option(
      '--keep-conflicts',
      'On the confirmed run, leave each conflicted branch mid-merge in <root>-worktrees/merge-dev/ for resolution',
    )
    .option('--continue', 'Check, preview, then commit and push the selected resolutions left by --keep-conflicts')
    .option('--abort', 'Discard the selected resolutions left by --keep-conflicts')
    .option(
      '--tree <branch=sha>',
      'With --continue --yes: the approved tree per branch, as a --continue preview prints it (repeatable)',
      (value: string, prev: string[] | undefined): string[] => {
        return [...(prev ?? []), value]
      },
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
          keepConflicts: options.keepConflicts,
          continue: options.continue,
          abort: options.abort,
          tree: options.tree,
          confirmedCommand: options.yes,
        })
      })

      // A partial run used to exit 0, so no CI step or wrapper script could tell
      // "merged all six" from "merged two, gave up on four". The action owns the exit code.
      emitOutcome(result, result.structuredContent.failedMerges > 0)
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
      'Release spec "<version|next|name>[@yyyy-mm-dd][:type[:description]]" (repeatable). The token is a semver ("1.2.5"), the literal "next", or a kebab-case name ("checkout-redesign"); "@yyyy-mm-dd" is the planned release date, written to the Jira fix version. Type is regular|hotfix (default regular). Examples: "1.2.5", "1.2.5:hotfix", "1.64.0@2026-10-28", "next:regular:Holiday backend", "checkout-redesign:regular:Q3 redesign".',
      collectReleaseSpec,
      [],
    )
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (options) => {
      const specs = options.release as string[]
      const inputs: ReleaseInput[] = specs.map(parseReleaseSpec)
      const releases = inputs.length > 0 ? inputs : undefined

      const result = await releaseCreate({
        releases,
        confirmedCommand: options.yes,
      })

      // A batch where an entry failed must not exit 0, or no script or agent can tell "created all
      // three" from "created one".
      emitOutcome(result, result.structuredContent.failureCount > 0)
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
      'With --from ci: version (e.g. 1.2.5) or release name to deploy; "dev" ("main" with gitFlow main) deploys from that branch. Prompts when omitted',
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

/** The `release` group: one grouped leaf per release-flow command. */
export const registerReleaseCommands = (program: Command): void => {
  const releaseGroup = program.command('release').description('Release management commands')

  configureMergeDev(releaseGroup.command('merge-dev'))
  configureReleaseList(releaseGroup.command('list'))
  configureReleaseCreate(releaseGroup.command('create'))
  configureReleaseEdit(releaseGroup.command('edit'))
  configureReleaseDeployAll(releaseGroup.command('deploy-all'))
  configureReleaseDeploySelected(releaseGroup.command('deploy-selected'))
  configureReleaseDeliver(releaseGroup.command('deliver'))
  configureReleaseRemove(releaseGroup.command('remove'))
}

/** Cross-surface metadata of the commands registered above, in palette order. */
export const releaseCatalog: CommandCatalogEntry[] = [
  // --- Release Management (menu group) ---
  {
    cliName: 'merge-dev',
    menuGroup: 'release',
    mcpTool: ghMergeDevMcpTool,
    mcpExposed: true,
    mutating: true,
    groupPath: ['release', 'merge-dev'],
  },
  {
    cliName: 'release-list',
    menuGroup: 'release',
    mcpTool: ghReleaseListMcpTool,
    mcpExposed: true,
    mutating: false,
    groupPath: ['release', 'list'],
  },
  {
    cliName: 'release-create',
    menuGroup: 'release',
    mcpTool: releaseCreateMcpTool,
    mcpExposed: true,
    mutating: true,
    groupPath: ['release', 'create'],
  },
  {
    cliName: 'release-edit',
    menuGroup: 'release',
    mcpTool: releaseEditMcpTool,
    mcpExposed: true,
    mutating: true,
    groupPath: ['release', 'edit'],
  },
  {
    cliName: 'release-deploy-all',
    menuGroup: 'release',
    mcpTool: ghReleaseDeployAllMcpTool,
    mcpExposed: true,
    mutating: true,
    groupPath: ['release', 'deploy-all'],
  },
  {
    cliName: 'release-deploy-selected',
    menuGroup: 'release',
    mcpTool: ghReleaseDeploySelectedMcpTool,
    mcpExposed: true,
    mutating: true,
    groupPath: ['release', 'deploy-selected'],
  },
  // release-deliver does prod delivery + admin-merge — genuinely irreversible,
  // so it is human-only: refused under `--agent`, `--yes` included.
  {
    cliName: 'release-deliver',
    menuGroup: 'release',
    mcpTool: ghReleaseDeliverMcpTool,
    mcpExposed: false,
    mutating: true,
    humanOnly: true,
    groupPath: ['release', 'deliver'],
  },
  // Gated, not refused, unlike its neighbour `release-deliver`. What an agent may run is governed by
  // the allowlist-or-gate rule, not by whether the verb sounds destructive: `requiresHumanConfirm` puts it behind the
  // two-phase gate, `version` is optional so the human picks from a form, `skipJira` is refused,
  // `moveIssuesTo` is accepted and shown in the gate, and the one irreversible step (the Jira fix
  // version) runs behind that gate. The asymmetry that would otherwise exist is the argument for
  // gating rather than refusing it: an agent can create a release, so it must be able to clean one up.
  {
    cliName: 'release-remove',
    menuGroup: 'release',
    mcpTool: releaseRemoveMcpTool,
    mcpExposed: true,
    mutating: true,
    groupPath: ['release', 'remove'],
  },
]
