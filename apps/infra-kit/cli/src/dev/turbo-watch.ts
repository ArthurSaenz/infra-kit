/*
 * `pnpm` is resolved from PATH — the same trust posture as the rest of the dev-server, which
 * already shells out to `pnpm exec turbo …`; the args are fixed literals plus discovered package
 * names, never shell-interpolated. Matches the file-level disable in `scripts/build.js`.
 */
/* eslint-disable sonarjs/no-os-command-from-path */
/**
 * `turbo watch build` engine for `infra-kit dev --watch`.
 *
 * Spawns ONE long-lived `turbo watch build` child that owns incremental rebuilds and
 * dependency-graph fan-out. Its stdout is teed to the runner log but NEVER parsed for
 * control flow: piped `turbo watch` block-buffers stdout and emits no per-task completion
 * marker for `tsc -b` tasks, so the dev-server derives "a build finished" from watching
 * `dist/` output instead (see {@link file://./dev-server.ts} `setupWatch`).
 *
 * The child is a 5-deep tree (`sh → pnpm → node → turbo → native binary`); killing the
 * wrapper PID orphans the rest. So it is spawned `detached` (its own process group) and
 * torn down with a process-GROUP signal — verified to fully reap the tree.
 */
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'

import { superviseChild } from './managed-child.js'
import type { ManagedChild } from './managed-child.js'

/** Handle to the running `turbo watch` child; `kill()` reaps the whole process group. */
export type TurboWatchHandle = ManagedChild

/** Injectable spawn seam so tests run the orchestrator without a real turbo child. */
export type TurboWatchFactory = (opts: TurboWatchOptions) => TurboWatchHandle

export interface TurboWatchOptions {
  /** App package names; each becomes a `--filter=...<pkg>` (dependency-inclusive) arg. */
  packageNames: string[]
  /** Consumer repo cwd the child runs in (turbo resolves the consumer's own pin here). */
  cwd: string
  /** Runner log file; the child's stdout+stderr are appended to it. */
  logFile: string
}

/**
 * Default factory: spawn `pnpm exec turbo watch build --filter=...<pkg> ... --continue=dependencies-successful
 * --env-mode=loose` detached, tee output to `logFile`, and reap the process group on `kill()`.
 *
 * `--filter=...<pkg>` (the leading `...`) includes each app's dependencies, so editing a
 * shared lib triggers a rebuild. `--continue=dependencies-successful` keeps the watcher
 * alive when one package fails to compile, so a shared-lib type error never tears down the
 * whole engine and the last-good `dist/` keeps serving.
 */
export const defaultTurboWatchFactory: TurboWatchFactory = ({ packageNames, cwd, logFile }) => {
  const filters = packageNames.map((name) => {
    return `--filter=...${name}`
  })
  const out = fs.openSync(logFile, 'a')
  const child = spawn(
    'pnpm',
    ['exec', 'turbo', 'watch', 'build', ...filters, '--continue=dependencies-successful', '--env-mode=loose'],
    { cwd, detached: true, stdio: ['ignore', out, out] },
  )

  return superviseChild(child)
}
