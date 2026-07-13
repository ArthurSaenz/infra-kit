/**
 * Launch the infra-kit MCP server (stdio transport) as a CHILD process.
 *
 * It must never be imported in-process: src/entry/mcp.ts calls `startServer()` at top-level module load,
 * connecting the stdio transport as a side effect, and `emit()` in src/lib/json-output writes to
 * `process.stdout`. Any stdout write on the CLI dispatch path would corrupt the JSON-RPC framing.
 * Spawning gives the child pristine stdio by construction.
 *
 * `dist/mcp.js` is emitted as a sibling of `dist/cli.js` (esbuild `splitting: true`; both import the
 * shared `chunk-*.js`), so `new URL('./mcp.js', import.meta.url)` resolves correctly from the bundle.
 */
import { spawn } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { logger } from 'src/lib/logger'
import { withoutPackageManagerEnv } from 'src/lib/pm-env'

export interface McpDeps {
  spawn?: typeof spawn
  exit?: (code: number) => void
  env?: NodeJS.ProcessEnv
  onError?: (message: string) => void
}

const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM'] as const

/** Resolve the server entry next to this bundle rather than importing it (see module doc). */
export const mcpServerPath = (): string => {
  return fileURLToPath(new URL('./mcp.js', import.meta.url))
}

export const runMcp = (deps: McpDeps = {}): void => {
  const spawnFn = deps.spawn ?? spawn
  const exit =
    deps.exit ??
    ((code: number) => {
      return process.exit(code)
    })
  const env = deps.env ?? process.env
  const onError =
    deps.onError ??
    ((message: string) => {
      return logger.error(message)
    })

  const child = spawnFn(process.execPath, [mcpServerPath()], {
    stdio: 'inherit',
    env: withoutPackageManagerEnv(env),
  })

  // An unhandled 'error' event throws. Spawning `process.execPath` should never fail, but a launcher
  // that dies by uncaught exception instead of a named exit is the worst possible failure for a client
  // reading our stdio.
  child.on('error', (error) => {
    onError(`failed to launch the MCP server: ${error.message}`)
    exit(1)
  })

  // Forward the client's shutdown signals so the server can close its transport cleanly.
  FORWARDED_SIGNALS.forEach((signal) => {
    process.on(signal, () => {
      child.kill(signal)
    })
  })

  child.on('exit', (code, signal) => {
    exit(signal ? 1 : (code ?? 1))
  })
}
