import type { Command } from 'commander'

import { worktreesAdd, worktreesAddMcpTool } from 'src/commands/worktrees-add'
import { worktreesList, worktreesListMcpTool } from 'src/commands/worktrees-list'
import { worktreesRemove, worktreesRemoveMcpTool } from 'src/commands/worktrees-remove'
import { worktreesSync, worktreesSyncMcpTool } from 'src/commands/worktrees-sync'
import type { CommandCatalogEntry } from 'src/entry/command-catalog/catalog-entry'
import { emit } from 'src/lib/json-output'

import { emitOutcome } from '../emit-outcome'

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
    .description('Add git worktrees for release branches or feature branches')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('-a, --all', 'Select all active release branches')
    .option('-v, --versions <versions>', 'Specify versions by comma, e.g. 1.2.5, 1.2.6')
    .option('-f, --feature <names>', 'Feature worktrees by comma, each on a feature/<name> branch, e.g. checkout-v2')
    .option(
      '-b, --base <branch>',
      'Base for new feature branches: dev (default; the default branch without one), main, or a release, e.g. 1.4.0',
    )
    .option('-g, --github-desktop', 'Open created worktrees in GitHub Desktop')
    .option('--no-github-desktop', 'Skip GitHub Desktop prompt')
    .option('--orca', 'Open created worktrees in Orca (pane layout from worktrees.orca.layout)')
    .option('--no-orca', 'Skip the Orca prompt')
    .action(async (options) => {
      const result = await worktreesAdd({
        confirmedCommand: options.yes,
        all: options.all,
        versions: options.versions,
        feature: options.feature,
        base: options.base,
        githubDesktop: options.githubDesktop,
        orca: options.orca,
      })

      // A target that did not end as a usable worktree must not exit 0 with `count: 0` and no reason.
      emitOutcome(result, result.structuredContent.failedWorktrees.length > 0)
    })
}

const configureWorktreesList = (cmd: Command): Command => {
  return cmd.description('List all git worktrees with detailed information').action(async () => {
    emit(await worktreesList())
  })
}

const configureWorktreesRemove = (cmd: Command): Command => {
  return cmd
    .description('Remove git worktrees for release or feature branches')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('-a, --all', 'Select all active release and feature worktrees')
    .option('-v, --versions <versions>', 'Specify versions by comma, e.g. 1.2.5, 1.2.6')
    .option('-f, --feature <names>', 'Feature worktrees by comma, e.g. checkout-v2')
    .option('--self', 'Remove the worktree this runs in, closing its Orca tabs (handed off to Orca)')
    .action(async (options) => {
      emit(
        await worktreesRemove({
          confirmedCommand: options.yes,
          all: options.all,
          versions: options.versions,
          feature: options.feature,
          self: options.self,
        }),
      )
    })
}

/** The `worktrees` group. */
export const registerWorktreesCommands = (program: Command): void => {
  const worktreesGroup = program.command('worktrees').description('Git worktree management commands')

  configureWorktreesAdd(worktreesGroup.command('add'))
  configureWorktreesList(worktreesGroup.command('list'))
  configureWorktreesRemove(worktreesGroup.command('remove'))
  configureWorktreesSync(worktreesGroup.command('sync'))
}

/** Cross-surface metadata of the commands registered above, in palette order. */
export const worktreesCatalog: CommandCatalogEntry[] = [
  // --- Worktrees (menu group) ---
  {
    cliName: 'worktrees-add',
    menuGroup: 'worktrees',
    mcpTool: worktreesAddMcpTool,
    mcpExposed: true,
    mutating: true,
    groupPath: ['worktrees', 'add'],
  },
  {
    cliName: 'worktrees-list',
    menuGroup: 'worktrees',
    mcpTool: worktreesListMcpTool,
    mcpExposed: true,
    mutating: false,
    groupPath: ['worktrees', 'list'],
  },
  // worktrees-remove runs `git worktree remove` (no --force) on the named leaf worktrees. It is NOT
  // irreversible in the way release-deliver is: the release branches/commits survive, the
  // worktrees scaffold survives, and worktrees-add recreates a removed worktree. git also
  // refuses to remove a worktree with modified-tracked or untracked files. The residual risk —
  // deletion of gitignored local state (a hydrated `.env` of Doppler secrets, node_modules/dist) — is
  // contained by the command's own invariants rather than by withholding it: under `--agent` it rejects
  // all=true (no one-shot wipe) and errors on any unmatched target before removing anything. So it is
  // gated, not refused, unlike the genuinely-irreversible release-deliver. After a refused removal it sweeps
  // ONLY a leftover git has already unregistered and that holds nothing but `.omc/{state,sessions}`
  // and `.DS_Store` (a post-exit hook re-creating tool state mid-deletion); everything else is
  // reported in failedWorktrees with isError.
  {
    cliName: 'worktrees-remove',
    menuGroup: 'worktrees',
    mcpTool: worktreesRemoveMcpTool,
    mcpExposed: true,
    mutating: true,
    groupPath: ['worktrees', 'remove'],
  },
  {
    cliName: 'worktrees-sync',
    menuGroup: 'worktrees',
    mcpTool: worktreesSyncMcpTool,
    mcpExposed: true,
    mutating: true,
    groupPath: ['worktrees', 'sync'],
  },
]
