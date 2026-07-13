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
import type { ManagedChild, UnexpectedExitHandler } from './managed-child.js'

/** Handle to the running `turbo watch` child; `kill()` reaps the whole process group. */
export type TurboWatchHandle = ManagedChild

/** Injectable spawn seam so tests run the orchestrator without a real turbo child. */
export type TurboWatchFactory = (opts: TurboWatchOptions) => TurboWatchHandle

export interface TurboWatchOptions {
  /**
   * API app package names, watched DEPENDENCY-INCLUSIVE (`--filter=...<pkg>`): rebuild the app AND its
   * dependency closure, so editing a shared lib the backend uses triggers a rebuild + restart.
   */
  depInclusive: string[]
  /**
   * UI app package names, watched DEP-CLOSURE-ONLY (`--filter=<pkg>^...`): rebuild the frontend's shared-lib
   * dependencies but NEVER the UI's own `build` (that would run a production `vite build` — the UI's live
   * dev is owned by the separate `turbo run dev`/vite child). Covers FE-only libs + UI-only sessions.
   */
  depClosure: string[]
  /** Consumer repo cwd the child runs in (turbo resolves the consumer's own pin here). */
  cwd: string
  /** Runner log file; the child's stdout+stderr are appended to it. */
  logFile: string
  /**
   * Called if the engine dies on its own (not via `kill()`): incremental rebuilds silently stop, so
   * the runner surfaces it. Optional so the injected test factory can ignore it.
   */
  onUnexpectedExit?: UnexpectedExitHandler
}

/**
 * Build the `--filter=` arg vector: `...<pkg>` (dependency-inclusive) for each API package, `<pkg>^...`
 * (dependencies only, excluding the package itself) for each UI package. Pure/order-stable so the exact
 * emitted args are unit-testable; API-only input reproduces the historical `--filter=...<pkg>` vector.
 *
 * @example
 * buildTurboWatchFilters(['api-a'], ['ui-a']) // => ['--filter=...api-a', '--filter=ui-a^...']
 */
export const buildTurboWatchFilters = (depInclusive: string[], depClosure: string[]): string[] => {
  return [
    ...depInclusive.map((name) => {
      return `--filter=...${name}`
    }),
    ...depClosure.map((name) => {
      return `--filter=${name}^...`
    }),
  ]
}

/**
 * Default factory: spawn `pnpm exec turbo watch build <filters> --continue=dependencies-successful
 * --env-mode=loose` detached, tee output to `logFile`, and reap the process group on `kill()`.
 *
 * Filters come from {@link buildTurboWatchFilters}: `...<api>` (dep-inclusive) rebuilds a backend + its
 * closure; `<ui>^...` (dep-closure-only) rebuilds the frontend's shared libs without production-building
 * the UI. `--continue=dependencies-successful` keeps the watcher alive when one package fails to compile,
 * so a shared-lib type error never tears down the whole engine and the last-good `dist/` keeps serving.
 */
export const defaultTurboWatchFactory: TurboWatchFactory = ({
  depInclusive,
  depClosure,
  cwd,
  logFile,
  onUnexpectedExit,
}) => {
  const filters = buildTurboWatchFilters(depInclusive, depClosure)
  const out = fs.openSync(logFile, 'a')
  const child = spawn(
    'pnpm',
    ['exec', 'turbo', 'watch', 'build', ...filters, '--continue=dependencies-successful', '--env-mode=loose'],
    { cwd, detached: true, stdio: ['ignore', out, out] },
  )

  return superviseChild(child, undefined, onUnexpectedExit)
}
