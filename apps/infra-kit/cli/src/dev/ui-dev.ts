/*
 * `pnpm` is resolved from PATH — same trust posture as the rest of the dev-server (which already
 * shells out to `pnpm exec turbo …`); args are fixed literals plus discovered package names, never
 * shell-interpolated. Matches the file-level disable in `scripts/build.js`.
 */
/* eslint-disable sonarjs/no-os-command-from-path */
/**
 * Frontend dev engine for `infra-kit dev --ui`.
 *
 * Delegates FE to ONE `turbo run dev` child (turbo owns the `dev` fan-out, `^build` ordering
 * and concurrency) rather than infra-kit spawning each framework itself — the same delegation
 * choice already made for builds via `turbo watch`. infra-kit treats UIs opaquely: it runs their
 * `dev` script (vite/vike/astro/…) and never encodes per-framework knowledge.
 *
 * Unlike the `turbo watch` child, this one's stdio is INHERITED — the framework dev servers own
 * their own TTY output (HMR overlays, URLs, spinners), so it streams raw to the terminal below the
 * BE server table rather than being teed into the runner log (which would corrupt it with ANSI).
 *
 * Detached → its own process group; reaped as a group (SIGTERM→SIGKILL) via {@link superviseChild}.
 */
import { spawn } from 'node:child_process'

import { superviseChild } from './managed-child.js'
import type { ManagedChild } from './managed-child.js'

/** Handle to the running `turbo run dev` child; `kill()` reaps the whole process group. */
export type UiDevHandle = ManagedChild

/** Injectable spawn seam so tests run the orchestrator without a real turbo child. */
export type UiDevFactory = (opts: UiDevOptions) => UiDevHandle

export interface UiDevOptions {
  /** UI app package names; each becomes an exact `--filter=<pkg>` (turbo runs its `dev` task). */
  packageNames: string[]
  /** Consumer repo cwd the child runs in. */
  cwd: string
  /**
   * Concurrency cap. Must be ≥ the number of selected UI `dev` tasks (they're persistent) —
   * turbo hard-errors when persistent tasks exceed concurrency (default 10).
   */
  concurrency: number
}

/**
 * Default factory: spawn `pnpm exec turbo run dev --filter=<pkg> … --concurrency=N --env-mode=loose`
 * detached, streaming to the parent terminal, and reap the process group on `kill()`.
 *
 * Exact `--filter=<pkg>` (no `...`) selects only the UI packages, so an API app that also defines a
 * `dev` task is never picked up.
 */
export const defaultUiDevFactory: UiDevFactory = ({ packageNames, cwd, concurrency }) => {
  const filters = packageNames.map((name) => {
    return `--filter=${name}`
  })
  const child = spawn(
    'pnpm',
    ['exec', 'turbo', 'run', 'dev', ...filters, `--concurrency=${concurrency}`, '--env-mode=loose'],
    { cwd, detached: true, stdio: ['ignore', 'inherit', 'inherit'] },
  )

  return superviseChild(child)
}
