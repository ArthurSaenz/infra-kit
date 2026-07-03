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

import { run } from 'src/dev/dev-server'
import type { DevServerOptions } from 'src/dev/dev-server'

/** Raw option object as produced by Commander (comma-joined strings). */
export interface DevCliOptions {
  watch?: boolean
  app?: string
  watchMode?: string
}

/** Coerce the raw `--watch-mode` value to the typed union; anything unrecognized → `oneshot`. */
const parseWatchMode = (value: string | undefined): 'oneshot' | 'turbo' => {
  return value === 'turbo' ? 'turbo' : 'oneshot'
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
 */
export const toDevServerOptions = (raw: DevCliOptions): DevServerOptions => {
  return {
    watch: raw.watch ?? false,
    include: splitList(raw.app),
    watchMode: parseWatchMode(raw.watchMode),
  }
}

/**
 * Start the dev-server, then wait for an OS signal and shut every server down
 * cleanly before exiting. This is the ONLY place SIGINT/SIGTERM handlers and
 * `process.exit` live for the dev-server feature.
 */
export const runDevServer = async (options: DevServerOptions): Promise<void> => {
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
    .description('Run local dev servers for every apps/<app>/api that has a serverless.yml')
    .option('-w, --watch', 'Rebuild and restart on file save')
    .option('--app <names>', 'Only run these apps (comma-separated folder names)')
    .option('--watch-mode <mode>', 'Rebuild strategy in --watch: oneshot (default) or turbo (turbo watch build)')

  program.parse(argv)

  await runDevServer(toDevServerOptions(program.opts<DevCliOptions>()))
}

// Self-execute only when run directly (`node dist/dev-server.js`), not when the
// `infra-kit dev` subcommand imports this module for its exported helpers.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  parseAndRun(process.argv).catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
