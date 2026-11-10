import type { Command } from 'commander'
import process from 'node:process'

import { envClear, envClearMcpTool } from 'src/commands/env-clear'
import { envList, envListMcpTool } from 'src/commands/env-list'
import { envLoad, envLoadMcpTool } from 'src/commands/env-load'
import { envStatus, envStatusMcpTool } from 'src/commands/env-status'
import { envTokenList, envTokenListMcpTool } from 'src/commands/env-token-list'
import { envTokenRemove } from 'src/commands/env-token-remove'
import { envTokenSet, envTokenSetFromFile } from 'src/commands/env-token-set'
import type { CommandCatalogEntry } from 'src/entry/command-catalog/catalog-entry'
import { emit } from 'src/lib/json-output'

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

/** The Doppler env commands: `env-status|list|load|clear` and `env-token-*`. */
export const registerEnvCommands = (program: Command): void => {
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
    .option(
      '-c, --config <config>',
      'Environment config name to load (e.g. dev, arthur). Omitted: the picker opens on defaultEnv; headless runs load it',
    )
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
    .description(
      'Add or replace the Doppler service token for an env (masked prompt or piped stdin; validated against Doppler before writing)',
    )
    .argument(
      '[env]',
      'Environment / Doppler config the token is scoped to (e.g. dev); omitted → picker, incl. a new env',
    )
    .option(
      '--stdin',
      'Read the token from stdin (implied when stdin is piped, e.g. `op read … | ik env-token-set dev`)',
    )
    .option('--from-env <var>', 'Read the token from the named environment variable (the NAME, never the value)')
    .option('--from-file <path>', 'Import several tokens from a `<env>=<token>` file, each validated on its own')
    .option('--force', 'Store even when the token’s scope could not be verified. Never overrides a real mismatch.')
    .action(async (env, options) => {
      if (options.fromFile) {
        if (env || options.stdin || options.fromEnv) {
          throw new Error('--from-file names its envs itself — drop <env>, --stdin and --from-env.')
        }

        emit(await envTokenSetFromFile({ fromFile: options.fromFile, force: options.force }))

        return
      }

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
}

/** Cross-surface metadata of the commands registered above, in palette order. */
export const envCatalog: CommandCatalogEntry[] = [
  // --- Environment (menu group): the Doppler env commands, and ONLY those ---
  // Every menu-eligible entry must be a Commander LEAF (an action, no subcommands) so the session
  // shell's report discriminator holds. The bare `vendor`/`config` GROUPS are menuGroup:null — a bare
  // group prints help and exits non-zero, which the shell would misreport. Their useful leaves
  // (vendor check/config/sync, config path/edit) are surfaced by `register/vendor.ts` and `register/config.ts`.
  {
    cliName: 'env-status',
    menuGroup: 'environment',
    mcpTool: envStatusMcpTool,
    mcpExposed: true,
    mutating: false,
    groupPath: ['env-status'],
  },
  {
    cliName: 'env-list',
    menuGroup: 'environment',
    mcpTool: envListMcpTool,
    mcpExposed: true,
    mutating: false,
    groupPath: ['env-list'],
  },
  {
    cliName: 'env-load',
    menuGroup: 'environment',
    mcpTool: envLoadMcpTool,
    mcpExposed: true,
    mutating: true,
    groupPath: ['env-load'],
    sessionEnvNotice: true,
  },
  {
    cliName: 'env-clear',
    menuGroup: 'environment',
    mcpTool: envClearMcpTool,
    mcpExposed: true,
    mutating: true,
    groupPath: ['env-clear'],
    sessionEnvNotice: true,
  },
  // The only env-token command that is agent-callable. It READS, and only ever emits redacted values.
  {
    cliName: 'env-token-list',
    menuGroup: 'environment',
    mcpTool: envTokenListMcpTool,
    mcpExposed: true,
    mutating: false,
    groupPath: ['env-token-list'],
  },

  // env-token-set / env-token-remove carry NO tool definition (no schema to publish, no
  // `argument_required` payload to shape) and sit in LOW_RISK_MUTATING_ALLOWLIST (`command-catalog.ts`), so under
  // --agent they are ungated. The guard on the write is not a confirm: the host's permission prompt on
  // the argv, then `probeToken` (Doppler itself refuses a cross-config download) and `assertTokenScope`
  // (the payload must name this config) before `tokens.json` is touched. Removal is local-only — the
  // Doppler token survives and the next set puts it back.
  // env-token-set is a menu row: its `[env]` is optional and the picker supplies it (a new env
  // included). env-token-remove still takes a required `<env>` the flagless menu cannot supply.
  {
    cliName: 'env-token-set',
    menuGroup: 'environment',
    mcpTool: null,
    mcpExposed: false,
    mutating: true,
    groupPath: ['env-token-set'],
  },
  {
    cliName: 'env-token-remove',
    menuGroup: null,
    mcpTool: null,
    mcpExposed: false,
    mutating: true,
    groupPath: ['env-token-remove'],
  },
]
