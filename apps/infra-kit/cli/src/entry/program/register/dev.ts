import type { Command } from 'commander'
import process from 'node:process'

import { devStatus, devStatusMcpTool } from 'src/commands/dev-status'
import { e2e, e2eMcpTool } from 'src/commands/e2e'
import type { CommandCatalogEntry } from 'src/entry/command-catalog/catalog-entry'
import { emit, jsonOutput } from 'src/lib/json-output'

/** `dev`, `dev-status` and `e2e`. */
export const registerDevCommands = (program: Command): void => {
  program
    .command('dev')
    .description('Run local dev servers for an app (or every app); api + ui')
    .argument('[app]', 'An app — its api/ui plus the backends its routes can run locally (omit to run every app)')
    .option('-w, --watch', 'Rebuild and restart on file save (the default)')
    .option('--no-watch', 'Build once and never restart on save')
    .option('--app <names>', 'Further narrow to these app folder names (comma-separated)')
    .option(
      '--target <keys>',
      'Run exactly these <app>/api|<app>/ui packages (comma-separated); part-level, unlike --app',
    )
    .option(
      '--orca',
      'Run each app in its own Orca pane (one tab, N panes; falls back to single terminal when Orca is not running)',
    )
    .option('--self', 'Run only the app of the current directory (infer from cwd; use inside apps/<app>/…)')
    .option('-V, --verbose', 'Print full boot narration (default: quiet; full detail always in the session log)')
    .option('--routes', 'Print each app’s registered METHOD /path routes at startup (default: off)')
    .option(
      '--reuse',
      'For test runners: start nothing when this worktree already serves one of these apps, exit on a boot failure',
    )
    .option(
      '--no-ui-health',
      'Do not probe the frontends’ liveness (vite’s HMR ping); their rows carry no health dot (also: INFRA_KIT_NO_UI_HEALTH=1)',
    )
    .action(async (appName, options) => {
      // Lazy import so fastify/chokidar (and the whole dev stack, plus the wizard's inquirer/config
      // graph) never load on the eager cli graph — they land in a split chunk reached only for `dev`.
      const { runDevServerCli } = await import('src/entry/dev-server')

      // A bare `infra-kit dev` in a TTY launches the interactive wizard; any flag/app/pipe/--json
      // runs directly. `runDevServerCli` owns that decision (see `shouldRunWizard`).
      const tty = Boolean(process.stdout.isTTY && process.stdin.isTTY)

      await runDevServerCli({ ...options, appName }, tty, jsonOutput.enabled)
    })

  // Read-only companion to `dev`: reports what dev currently has running from the on-disk dev-context
  // fragments (never starts a server). Top-level per the house rule.
  program
    .command('dev-status')
    .description('Show what `infra-kit dev` currently has running (reads dev-context fragments; starts nothing)')
    .action(async () => {
      emit(await devStatus())
    })

  // Named after `dev` on purpose: `dev` serves the apps, `e2e` tests them. Local by default — the package's
  // `infraKitE2e()` Playwright config reuses or starts `dev`, so every Playwright entry point agrees with
  // this one; cloud is the explicit exception because it runs against an environment other people use.
  program
    .command('e2e')
    .description('Run an app’s Playwright e2e against this worktree (dev reused or started), or --cloud')
    .argument('[playwrightArgs...]', 'Passed to `playwright test` (put them after `--`)')
    .option('--app <name>', 'App folder whose apps/<app>/tests package to run (inferred from cwd when omitted)')
    .option('--dry-run', 'Resolve and print the target and proxy topology without running')
    .option('--cloud', 'Run against the deployed app at INFRA_KIT_ENV instead of this worktree')
    .option('-y, --yes', 'Skip the confirmation a cloud run asks for')
    .action(async (playwrightArgs: string[], options) => {
      emit(
        await e2e({ app: options.app, dryRun: options.dryRun, yes: options.yes, cloud: options.cloud, playwrightArgs }),
      )
    })
}

/** Cross-surface metadata of the commands registered above, in palette order. */
export const devCatalog: CommandCatalogEntry[] = [
  // --- Develop (menu group) ---
  // The local dev server, and the reason most people open this menu at all — so it leads.
  //
  // It is a long-running foreground child, which the one-shot Inquirer menu could not host: that menu
  // ran the pick IN-PROCESS, so a dev server would have blocked the menu process forever. The session
  // shell spawns every pick as a separate child on the primary screen and swallows SIGINT while one
  // runs, so Ctrl-C stops only the dev server and the palette comes back. See `longRunning` for the two
  // session assumptions it still breaks (no verdict; exits 128+signo).
  //
  // Spawning the BARE `['dev']` path is deliberate: `shouldRunWizard` fires on exactly bare + TTY +
  // non-json, so a menu pick lands in the interactive wizard — the wizard IS the flag picker.
  //
  // No tool definition: it never returns a result, so it cannot fit the request/response tool contract.
  {
    cliName: 'dev',
    menuGroup: 'develop',
    mcpTool: null,
    mcpExposed: false,
    mutating: true,
    groupPath: ['dev'],
    longRunning: true,
  },
  // Read-only companion to `dev`: reports what `infra-kit dev` currently has running by reading the
  // on-disk dev-context fragments (never starts a server). Top-level (`infra-kit dev-status`) per the
  // house rule — new commands go top-level with related names, not nested under a group — but carries
  // menuGroup 'develop' so it renders beside `dev` in the palette (same shape as env-status).
  {
    cliName: 'dev-status',
    menuGroup: 'develop',
    mcpTool: devStatusMcpTool,
    mcpExposed: true,
    mutating: false,
    groupPath: ['dev-status'],
  },
  // Tests this worktree by default, the deployed app with `--cloud`. `requiresHumanConfirm` covers the cloud
  // run only — a local run touches nothing but this machine, so it runs without a preview.
  {
    cliName: 'e2e',
    menuGroup: 'develop',
    mcpTool: e2eMcpTool,
    mcpExposed: false,
    mutating: true,
    groupPath: ['e2e'],
  },
]
