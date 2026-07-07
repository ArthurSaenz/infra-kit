/**
 * Long-running CLI entry for the local dev-server. Owns flag parsing, OS signal
 * handling, and process exit — the orchestrator (`src/dev/dev-server`) is signal-
 * and exit-agnostic. Kept off the eager cli.js graph: entry/cli.ts reaches this
 * module (and the fastify/chokidar it pulls in) only via `await import(...)`, so
 * those heavy deps never load on the machine command paths.
 */
import { Command } from 'commander'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { runCmuxDevServer } from 'src/dev/cmux-dev'
import { run } from 'src/dev/dev-server'
import type { DevServerOptions } from 'src/dev/dev-server'
import { resolveSelfAppName } from 'src/dev/discovery'
import { isCmuxAvailable } from 'src/integrations/cmux'

/** Raw option object as produced by Commander (comma-joined strings). */
export interface DevCliOptions {
  watch?: boolean
  app?: string
  /** Named preset positional (`infra-kit dev <preset>`); selects launch targets from `devPresets`. */
  preset?: string
  cmux?: boolean
  self?: boolean
}

/** Split a comma-separated flag value into a trimmed, non-empty list (`null` when unset/empty). */
const splitList = (value: string | undefined): string[] | null => {
  if (value == null) return null

  const parts = value
    .split(',')
    .map((s) => {
      return s.trim()
    })
    .filter(Boolean)

  return parts.length > 0 ? parts : null
}

/**
 * Map raw Commander flags to the orchestrator's typed options. Shared by the
 * `infra-kit dev` subcommand and the standalone entry so the two never diverge.
 * `self` is passed through as-is here — it's resolved to `include` later, in
 * `runDevServer`, where `--app` (if also given) is allowed to win.
 */
export const toDevServerOptions = (raw: DevCliOptions): DevServerOptions => {
  return {
    watch: raw.watch ?? false,
    include: splitList(raw.app),
    preset: raw.preset,
    cmux: raw.cmux ?? false,
    self: raw.self ?? false,
  }
}

/**
 * Resolve `--self` into an `include` list, without mutating `options`. `--app` (an
 * explicit `include`) wins over `--self` when both are given — self is only a
 * convenience default for scripts that don't want to hardcode their app name.
 * Lets `resolveSelfAppName`'s error (not inside `apps/<app>/...`) propagate as-is;
 * the caller's top-level catch turns it into a clean message + non-zero exit.
 */
const resolveSelfOptions = (options: DevServerOptions): DevServerOptions => {
  if (!options.self || options.include) {
    return options
  }

  return { ...options, include: [resolveSelfAppName(process.cwd())] }
}

/**
 * Start the dev-server, then wait for an OS signal and shut every server down
 * cleanly before exiting. This is the ONLY place SIGINT/SIGTERM handlers and
 * `process.exit` live for the dev-server feature.
 */
export const runDevServer = async (rawOptions: DevServerOptions): Promise<void> => {
  const options = resolveSelfOptions(rawOptions)

  // `--cmux`: one workspace, one pane per app. `runCmuxDevServer` owns its own
  // signal handling and never returns, so return before wiring the in-process
  // handlers below. Fall through to single-process dev when cmux isn't installed.
  if (options.cmux) {
    if (await isCmuxAvailable()) {
      await runCmuxDevServer(options)

      return
    }

    process.stdout.write('cmux not available; falling back to single-terminal dev\n')
  }

  const runner = await run(options)

  let shuttingDown = false

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return
    shuttingDown = true

    void (async () => {
      try {
        process.stdout.write(`\nReceived ${signal}, shutting down dev-server...\n`)
        await runner.shutdown()
      } finally {
        process.exit(0)
      }
    })()
  }

  process.on('SIGINT', () => {
    return shutdown('SIGINT')
  })
  process.on('SIGTERM', () => {
    return shutdown('SIGTERM')
  })
}

/** Parse `node dist/dev-server.js ...` flags and start the server. */
const parseAndRun = async (argv: string[]): Promise<void> => {
  const program = new Command()

  program
    .name('infra-kit-dev-server')
    .description('Run local dev servers for the apps in a named devPresets preset (or all apps)')
    .argument('[preset]', 'Named preset from devPresets (omit to run every app)')
    .option('-w, --watch', 'Rebuild and restart on file save')
    .option('--app <names>', 'Further narrow to these app folder names (comma-separated)')
    .option(
      '--cmux',
      'Run each app in its own cmux pane (one workspace, N panes; falls back to single terminal if cmux is unavailable)',
    )
    .option('--self', 'Run only the app of the current directory (infer from cwd; use inside apps/<app>/…)')

  program.parse(argv)

  await runDevServer(toDevServerOptions({ ...program.opts<DevCliOptions>(), preset: program.args[0] }))
}

// Self-execute only when run directly (`node dist/dev-server.js`), not when the
// `infra-kit dev` subcommand imports this module for its exported helpers.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  parseAndRun(process.argv).catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
