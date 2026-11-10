import type { Command } from 'commander'

import { configEdit, configPath } from 'src/commands/config'
import { configGet, configGetMcpTool } from 'src/commands/config-get'
import { configSet } from 'src/commands/config-set'
import { configUnset } from 'src/commands/config-unset'
import type { CommandCatalogEntry } from 'src/entry/command-catalog/catalog-entry'
import { emit } from 'src/lib/json-output'

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

/** The `config` group plus the flat `config-get|set|unset` commands. */
export const registerConfigCommands = (program: Command): void => {
  const configCmd = program.command('config').description('Manage infra-kit configuration files')

  configureConfigPath(configCmd.command('path'))
  configureConfigEdit(configCmd.command('edit'))

  // Top-level (`infra-kit config-get`), not under the config group — house rule: new commands go
  // top-level with related names. Read-only: prints the fully merged config.
  program
    .command('config-get')
    .description('Print the fully merged infra-kit config (project + user-global + per-project override layers)')
    .argument('[key]', 'Print only this top-level key (e.g. worktrees)')
    .action(async (key) => {
      emit(await configGet({ key }))
    })

  // Writes go to a per-machine override layer only — the committed infra-kit.json changes through review.
  program
    .command('config-set')
    .description('Set a top-level key in this project’s per-machine config override (validated before it is kept)')
    .argument('<key>', 'Top-level config key (e.g. protectedEnvs, worktrees)')
    .argument('<value>', 'JSON value, or a bare string (e.g. cli-only, \'{"openInOrca":true}\')')
    .option('--global', 'Write ~/.infra-kit/infra-kit.json (every project on this machine) instead')
    .action(async (key, value, options) => {
      emit(await configSet({ key, value, global: options.global }))
    })

  program
    .command('config-unset')
    .description('Remove a top-level key from this project’s per-machine config override')
    .argument('<key>', 'Top-level config key')
    .option('--global', 'Remove it from ~/.infra-kit/infra-kit.json instead')
    .action(async (key, options) => {
      emit(await configUnset({ key, global: options.global }))
    })
}

/** Cross-surface metadata of the commands registered above, in palette order. */
export const configCatalog: CommandCatalogEntry[] = [
  // --- Configuration (menu group) ---
  // Read-only merged-config introspection. Top-level (`infra-kit config-get`) per the house rule — new
  // commands go top-level with related names — but menuGroup 'configuration' renders it beside
  // `config path`/`config edit`. Exposed to agents (mutating:false); `config edit` stays CLI-only for writes.
  {
    cliName: 'config-get',
    menuGroup: 'configuration',
    mcpTool: configGetMcpTool,
    mcpExposed: true,
    mutating: false,
    groupPath: ['config-get'],
  },
  // Per-machine override writers, top-level per the house rule. No tool definition and no menu row:
  // both take a required <key>, which the flagless palette cannot supply.
  {
    cliName: 'config-set',
    menuGroup: null,
    mcpTool: null,
    mcpExposed: false,
    mutating: true,
    groupPath: ['config-set'],
  },
  {
    cliName: 'config-unset',
    menuGroup: null,
    mcpTool: null,
    mcpExposed: false,
    mutating: true,
    groupPath: ['config-unset'],
  },
  {
    cliName: 'config-path',
    menuGroup: 'configuration',
    mcpTool: null,
    mcpExposed: false,
    mutating: false,
    groupPath: ['config', 'path'],
  },
  {
    cliName: 'config-edit',
    menuGroup: 'configuration',
    mcpTool: null,
    mcpExposed: false,
    mutating: true,
    groupPath: ['config', 'edit'],
    entersAltScreen: true,
  },

  // The bare group: help + a non-zero exit, so it never belongs in the leaf-only menu.
  { cliName: 'config', menuGroup: null, mcpTool: null, mcpExposed: false, mutating: false, groupPath: ['config'] },
]
