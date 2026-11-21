/*
 * `pnpm` is resolved from PATH — same trust posture as the rest of the dev-server (which already
 * shells out to `pnpm exec turbo …`); args are fixed literals plus discovered package names, never
 * shell-interpolated. Matches the file-level disable in `scripts/build.js`.
 */
/* eslint-disable sonarjs/no-os-command-from-path -- runs the user's own CLI, which only PATH can locate */
/**
 * @fileoverview
 *
 * Frontend dev engine for `infra-kit dev --ui`.
 *
 * Delegates FE to ONE `turbo run dev` child (turbo owns the `dev` fan-out and concurrency) rather than
 * infra-kit spawning each framework itself — the same delegation choice already made for builds via
 * `turbo watch`. infra-kit treats UIs opaquely: it runs their `dev` script (vite/vike/astro/…) and
 * never encodes per-framework knowledge.
 *
 * This child's stdio is PIPED, never inherited. With `inherit`, turbo and the framework write straight
 * to the TTY, bypassing the renderer entirely: turbo's run chrome interleaves with the pinned footer,
 * and vite's `Local:` URL contradicts the proxy hero URL the ready header already shows. Piping makes
 * `infra-kit dev` the single owner of the terminal — every line is tee'd verbatim to the runner log,
 * and the framework's own lines are routed through `onLine` into the renderer's tagged tail, so vite's
 * URLs, HMR notices and compile errors surface INSIDE the UI instead of fighting it.
 *
 * `--only` keeps that tail signal-dense. A `dev` task `dependsOn: ["^build"]`, so turbo would otherwise
 * re-walk the whole dependency closure and emit one `cache hit` line per dep — work the runner already
 * did in `buildUiApps` (`turbo run build <pkg>^...`) before spawning this child. `--only` drops those
 * `^build` tasks from the graph, so the redundant walk never happens. `--output-logs=new-only` collapses
 * any stray cache-hit replay, `--no-update-notifier` drops turbo's "Update available" banner, and
 * `--ui=stream` pins line-oriented output (turbo picks it anyway off a pipe, but it is cheap to be
 * explicit, and it is what `parseTurboDevLine`'s `<pkg>:dev:` prefix contract depends on).
 *
 * Detached → its own process group; reaped as a group (SIGTERM→SIGKILL) via {@link superviseChild}.
 */
import { spawn } from 'node:child_process'
import process from 'node:process'
import type { Readable } from 'node:stream'

import { stripAnsi } from './log-format.js'
import { superviseChild } from './managed-child.js'
import type { ManagedChild, UnexpectedExitHandler } from './managed-child.js'
import { TASK_PREFIX, lastRedraw, turboLineLevel } from './turbo-line.js'

/** Handle to the running `turbo run dev` child; `kill()` reaps the whole process group. */
export type UiDevHandle = ManagedChild

/** Injectable spawn seam so tests run the orchestrator without a real turbo child. */
export type UiDevFactory = (opts: UiDevOptions) => UiDevHandle

/** One framework output line, already stripped of turbo's `<pkg>:dev:` prefix. */
export interface TurboDevLine {
  /** The turbo package name that emitted the line (e.g. `website-ui`). */
  pkg: string
  /** The framework's own text, ANSI-stripped. */
  text: string
  /** Severity, read out of turbo's own line format — see {@link turboLineLevel}. */
  level: 'info' | 'error'
}

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
  /**
   * Extra env merged over `process.env` for the turbo child (Layer B passes `INFRA_KIT_UI_PORTS`).
   * `turbo … --env-mode=loose` passes the full env through to each vite `dev` task. Omit → inherit only.
   */
  env?: Record<string, string>
  /** Raw child output (turbo chrome included, ANSI intact), one write per batch of whole lines. */
  appendLog?: (text: string) => void
  /** One call per framework output line; turbo's own chrome is filtered out first. */
  onLine?: (line: TurboDevLine) => void
  /**
   * One call per package whose `dev` task turbo gave up on, while the rest of the run continues.
   *
   * Distinct from {@link onUnexpectedExit}, which fires only when the whole engine dies. With
   * `--continue` a single frontend can fail without taking the engine down — that is the point — so
   * without this the runner would have no signal at all and the dead UI would sit on `◌ starting`
   * until the never-up threshold expired.
   */
  onTaskFailure?: (packageName: string) => void
  /**
   * Called if the child dies on its own (not via `kill()`): every UI's live reload silently stops, so
   * the runner surfaces it. Optional so the injected test factory can ignore it.
   */
  onUnexpectedExit?: UnexpectedExitHandler
}

// The tail and the log files share one strip, and one turbo severity rule; re-exported so this module's
// surface is unchanged by the moves.
export { stripAnsi, turboLineLevel }

/**
 * Turbo's OWN verdict on a task, which uses `<pkg>#dev:` — a HASH, not the colon {@link TASK_PREFIX}
 * matches. That difference is why {@link parseTurboDevLine} drops these lines: they are turbo speaking,
 * not the framework.
 *
 * Both observed forms are matched, because which one turbo emits depends on `--continue`:
 * - `<pkg>#dev:  WARNING  command finished with error, but continuing...` — with `--continue`, emitted
 *   LIVE at the moment the task dies while the rest of the run keeps going. This is the one that matters.
 * - `<pkg>#dev:  ERROR  command (<dir>) <pm> run dev exited (1)` — without `--continue`, emitted as the
 *   run tears everything down.
 *
 * Captured from a real `turbo run dev` (2.10.3) against a two-package workspace, not inferred: turbo
 * prints no per-task completion marker otherwise, so this line is the only live, attributable signal
 * that one frontend died while its siblings live on.
 */
const TASK_FAILURE = /^([^\s#]+)#dev:\s+(?:WARNING|ERROR)\s+command\b/

/**
 * One raw turbo line → the package whose `dev` task just failed, or `null`.
 *
 * Separate from {@link parseTurboDevLine} on purpose: that one answers "what did the framework say",
 * this one answers "did turbo give up on a package". A failing framework often says nothing
 * attributable at all (a missing `dev` script never reaches the framework), so this is the only path
 * by which such a UI can be marked down rather than sitting on `◌ starting` until the never-up
 * threshold expires.
 *
 * @example
 * parseTurboTaskFailure('shop-ui#dev:  WARNING  command finished with error, but continuing...')
 * // => 'shop-ui'
 * parseTurboTaskFailure('shop-ui:dev: ready in 384 ms') // => null (framework line, not turbo's verdict)
 */
export const parseTurboTaskFailure = (raw: string): string | null => {
  const match = TASK_FAILURE.exec(stripAnsi(raw).trimEnd())

  return match?.[1] ?? null
}

/**
 * Per-task bookkeeping turbo emits before the framework speaks: the cache verdict
 * (`cache bypass, force executing <hash>`) and the echoed command (`$ pnpm exec vike dev`).
 * Neither is dev signal — both are already implied by the app appearing in the ready header.
 */
const isTaskChrome = (text: string): boolean => {
  return /^cache (?:bypass|hit|miss)/.test(text) || text.startsWith('$ ')
}

/**
 * One raw turbo line → the framework line to surface, or `null` to drop it.
 *
 * Turbo's run chrome (`• Packages in scope: …`, `• Running dev in 1 packages`, `• Remote caching
 * disabled`, the closing task summary, pnpm's `ELIFECYCLE` teardown) carries no `<pkg>:dev:` prefix.
 * Requiring that prefix drops all of it under one rule instead of chasing a brittle denylist, and what
 * survives is exactly the framework's own stdout/stderr — including its errors.
 *
 * @example
 * parseTurboDevLine('website-ui:dev: ready in 384 ms') // => { pkg: 'website-ui', text: 'ready in 384 ms' }
 * parseTurboDevLine('• Remote caching disabled')       // => null
 */
export const parseTurboDevLine = (raw: string): TurboDevLine | null => {
  const line = stripAnsi(raw).trimEnd()
  const match = TASK_PREFIX.exec(line)

  if (match == null) {
    return null
  }

  // Redraws collapse on the RAW text: the strip deletes every CR and would glue them into `10%50%100%`.
  const redraw = lastRedraw(raw)
  const text = redraw == null ? line.slice(match[0].length) : stripAnsi(redraw).trimEnd()

  if (text.trim() === '' || isTaskChrome(text.trim())) {
    return null
  }

  return { pkg: match[1]!, text, level: turboLineLevel(text) }
}

/**
 * Cap for the newline-less carry buffer. A framework that renders progress with bare CR and never a LF
 * would otherwise grow `pending` without bound for the life of the dev session.
 */
const MAX_PENDING_CHARS = 64 * 1024

/**
 * Split a piped stream into lines: tee each complete raw line to the log, and route each framework
 * line to `onLine`. The tee is line-aligned because the log formatter prefixes every write: a chunk
 * ending mid-line would put a second prefix inside the line, split an ANSI escape, and leave a JSON
 * line unparseable. A trailing partial line is flushed on `end`, so a framework that exits
 * without a final newline never swallows its last (often the most interesting) line.
 *
 * The `data` listener is attached unconditionally — NOT gated on `onLine`/`appendLog` being set. A piped
 * child whose stdout is never read blocks once the OS pipe buffer fills, so draining is the contract
 * here; the sinks are merely optional consumers of what we drain.
 */
export const pumpLines = (
  stream: Readable | null,
  opts: Pick<UiDevOptions, 'appendLog' | 'onLine' | 'onTaskFailure'>,
): void => {
  if (stream == null) {
    return
  }

  let pending = ''

  const emit = (raw: string): void => {
    // Turbo's own task verdict first: it uses `<pkg>#dev:`, so `parseTurboDevLine` would drop it and
    // the death would never reach the runner. Checked before, not instead — the two prefixes are
    // mutually exclusive, so neither line can be consumed twice.
    const failed = parseTurboTaskFailure(raw)

    if (failed != null) {
      opts.onTaskFailure?.(failed)

      return
    }

    const parsed = parseTurboDevLine(raw)

    if (parsed != null) opts.onLine?.(parsed)
  }

  stream.setEncoding('utf-8')
  stream.on('data', (chunk: string) => {
    pending += chunk

    const lines = pending.split('\n')

    pending = lines.pop() ?? ''
    if (lines.length > 0) opts.appendLog?.(`${lines.join('\n')}\n`)
    for (const raw of lines) {
      emit(raw)
    }

    if (pending.length > MAX_PENDING_CHARS) {
      opts.appendLog?.(`${pending}\n`)
      emit(pending)
      pending = ''
    }
  })
  stream.on('end', () => {
    if (pending === '') return
    opts.appendLog?.(`${pending}\n`)
    emit(pending)
    pending = ''
  })
  // A readable that emits `error` with no listener THROWS, taking the whole dev session down. The child's
  // lifecycle is already owned by `superviseChild`, so a read error (pty EIO, a pipe torn down mid-SIGKILL)
  // only needs recording, never escalation.
  stream.on('error', (err: Error) => {
    opts.appendLog?.(`[infra-kit] ui dev stream error: ${err.message}\n`)
  })
}

/**
 * Default factory: spawn `pnpm exec turbo run dev --filter=<pkg> … --only` detached with piped stdio,
 * fan its output into the runner log + the renderer's tail, and reap the process group on `kill()`.
 *
 * Exact `--filter=<pkg>` (no `...`) selects only the UI packages, so an API app that also defines a
 * `dev` task is never picked up.
 */
export const defaultUiDevFactory: UiDevFactory = ({
  packageNames,
  cwd,
  concurrency,
  env,
  appendLog,
  onLine,
  onTaskFailure,
  onUnexpectedExit,
}) => {
  const filters = packageNames.map((name) => {
    return `--filter=${name}`
  })

  const child = spawn(
    'pnpm',
    [
      'exec',
      'turbo',
      'run',
      'dev',
      ...filters,
      `--concurrency=${concurrency}`,
      '--env-mode=loose',
      '--only',
      // Turbo's default is `--continue=never`, i.e. "cancel all tasks" the moment ONE fails: a single
      // frontend with a broken `dev` script would take every OTHER frontend in the run down with it.
      // `--only` has already stripped every dependency task, so `dependencies-successful` and `always`
      // select the same set here; the former matches `turbo-watch.ts` rather than asserting a
      // distinction that does not exist. The now-surviving failure is reported per-package via
      // `parseTurboTaskFailure` — the flag changes the blast radius, not the visibility.
      '--continue=dependencies-successful',
      '--output-logs=new-only',
      // `auto` switches to grouped `::group::` output with no `<pkg>:<task>:` prefix whenever GITHUB_ACTIONS is
      // set, and every line parser below keys off that prefix — so a run inside CI would attribute nothing.
      '--log-order=stream',
      '--no-update-notifier',
      '--ui=stream',
    ],
    { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } },
  )

  pumpLines(child.stdout, { appendLog, onLine, onTaskFailure })
  pumpLines(child.stderr, { appendLog, onLine, onTaskFailure })

  return superviseChild(child, undefined, onUnexpectedExit)
}
