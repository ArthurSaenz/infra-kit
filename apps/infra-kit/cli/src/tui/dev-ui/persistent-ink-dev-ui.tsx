import { render as inkRender } from 'ink'
import process from 'node:process'
import type { ReactElement } from 'react'

import type { DevUi, LogLevel, LogOptions, ReadySummary } from 'src/dev/dev-ui'
import { DevRenderer } from 'src/dev/render'
import { createSafeStream } from 'src/tui/safe-stderr'

import { BootRegion } from './boot-region'
import { LiveRegion } from './live-region'

/**
 * Ink-backed {@link DevUi} for `infra-kit dev`: a boot region that collapses into a PERSISTENT status
 * panel. It is the UI on any interactive TTY.
 *
 * There is one shape of session now, not two. Until recently `ready` branched on `summary.hasUiChild`
 * and, for a UI session, unmounted Ink and handed off to a DECSTBM scroll-region UI — because the
 * `turbo run dev` child's piped output produced an unbounded tail, Ink repaints its live region on every
 * appended line, and a pinned footer can only survive a scrolling stream if the TERMINAL is told to
 * confine it.
 *
 * That tail no longer exists. Framework lines and request lines go to their per-service log files and
 * are never printed, so there is nothing to scroll past the panel and nothing for a scroll region to
 * defend it from. The branch, the handoff, and the whole DECSTBM machinery were deleted with the stream
 * that justified them.
 *
 * What still prints above the panel is only what the RUNNER says — a restart, an unhealthy app, a dead
 * engine. Those are rare and they are events, not logs.
 *
 * The embedded {@link DevRenderer} owns the file-tee format (`teeOnly`); in persistent mode it is used
 * ONLY for teeing, never its direct stdout write, which would collide with the live region. Every
 * component here is OUTPUT-ONLY (no `useInput`) — see live-region.tsx.
 */

/** The subset of an Ink render handle this UI drives — shared by `ink` and `ink-testing-library`. */
interface RenderHandle {
  rerender: (tree: ReactElement) => void
  unmount: () => void
}

/** Render seam: `ink`'s `render` by default; `ink-testing-library`'s `render` is injected in tests. */
type RenderFn = (tree: ReactElement, options?: unknown) => RenderHandle

export interface PersistentInkDevUiDeps {
  /** File tee — the same appender the runner hands the plain renderer. */
  appendLog: (text: string) => void
  /** Mirrors the renderer's verbose gate: only in verbose does a `debug` log reach the terminal. */
  verbose?: boolean
  /** Clock seam (for deterministic tee + event timestamps in tests). */
  now?: () => Date
  /** Render seam (default `ink`'s `render`); tests inject `ink-testing-library`'s `render`. */
  render?: RenderFn
  /**
   * Target stream (default: `process.stdout` behind the scrollback-safe filter).
   *
   * The runner injects a stream whose `write` BYPASSES the output interceptor. That is not optional:
   * the interceptor owns `process.stdout` for the life of the session, so a panel painted through the
   * raw stream would have its frames filed into a log file instead of drawn — a blank screen, with no
   * error and no failing test.
   */
  stdout?: NodeJS.WriteStream
}

export class PersistentInkDevUi implements DevUi {
  private readonly renderer: DevRenderer
  private readonly renderFn: RenderFn
  private readonly stdout: NodeJS.WriteStream
  private readonly verbose: boolean
  private readonly now: () => Date
  /** Live Ink handle, or `null` when not mounted. */
  private instance: RenderHandle | null = null
  /** True once boot is done: never mount the boot region again. */
  private finalized = false
  /** True while the persistent panel owns the terminal (after ready). */
  private persistent = false
  private phase = ''
  private narration = ''
  private headerLines: string[] = []
  private logLines: string[] = []
  private footerLines: string[] = []

  constructor(deps: PersistentInkDevUiDeps) {
    this.verbose = deps.verbose ?? false
    this.renderFn = deps.render ?? (inkRender as RenderFn)
    // NOT raw `process.stdout`: Ink writes `ESC[3J` (erase saved lines) whenever a frame overflows the
    // viewport, which wipes the terminal's SCROLLBACK — the user's history, and every previous command's
    // output when `dev` runs as a session-shell child. `createSafeStream` drops that one escape and
    // forwards everything else live.
    this.stdout = deps.stdout ?? createSafeStream(process.stdout as NodeJS.WriteStream)
    this.now =
      deps.now ??
      ((): Date => {
        return new Date()
      })
    this.renderer = new DevRenderer({
      appendLog: deps.appendLog,
      verbose: this.verbose,
      isTTY: true,
      write: (text) => {
        this.stdout.write(text)
      },
      now: this.now,
    })
  }

  /** `LogFn`-shaped adapter for the build runner seam. */
  readonly logFn = (message: string, level: LogLevel = 'info'): void => {
    this.log(message, level)
  }

  // ---- boot ---------------------------------------------------------------

  /** Mount the Ink boot region (or rerender it in place) with the current phase + narration. */
  private renderBoot(): void {
    const tree = <BootRegion phase={this.phase} narration={this.narration} />

    if (this.instance) {
      this.instance.rerender(tree)

      return
    }
    this.instance = this.renderFn(tree, { stdout: this.stdout, exitOnCtrlC: false, patchConsole: false })
  }

  /** Unmount Ink if mounted (idempotent). */
  private unmount(): void {
    if (this.instance) {
      this.instance.unmount()
      this.instance = null
    }
  }

  narrate(message: string): void {
    this.renderer.teeOnly(message, 'info')
    if (this.persistent) {
      // Visible only in verbose (matches the plain renderer); tee already happened above.
      if (this.verbose) {
        this.logLines.push(message)
        this.rerenderPersistent()
      }

      return
    }
    if (this.finalized) {
      return
    }
    this.narration = message
    if (this.instance) {
      this.renderBoot()
    }
  }

  log(message: string, level: LogLevel = 'info', options: LogOptions = {}): void {
    const willWrite = level !== 'debug' || this.verbose

    if (this.persistent) {
      // Never the embedded renderer's direct stdout write here — append to the live region instead.
      // `tee: false` means the caller has ALREADY filed this line (see `DevServerRunner.reportFault`);
      // teeing it again would put a second copy of every fault into `runner.log`.
      if (options.tee !== false) {
        this.renderer.teeOnly(message, level)
      }
      if (willWrite) {
        this.logLines.push(message)
        this.rerenderPersistent()
      }

      return
    }
    if (willWrite) {
      this.unmount()
    }
    this.renderer.log(message, level, options)
  }

  bootStep(phase: string): void {
    this.renderer.teeOnly(phase, 'info')
    if (this.finalized) {
      return
    }
    this.phase = phase
    this.renderBoot()
  }

  // ---- the persistent panel ----------------------------------------------

  /** Commit the header, tee it, mount the live panel, and STAY mounted for the rest of the session. */
  ready(summary: ReadySummary): void {
    this.headerLines = this.renderer.formatHeaderLines(summary)
    this.footerLines = this.renderer.formatFooterLines(summary)
    this.logLines = []
    for (const line of this.headerLines) {
      this.renderer.teeOnly(line, 'info')
    }
    this.finalized = true
    this.persistent = true
    // Re-clamp the panel when the terminal resizes. Guarded: an injected (test/piped) stream may not
    // be an EventEmitter TTY.
    if (typeof this.stdout.on === 'function') {
      this.stdout.on('resize', this.onResize)
    }
    this.rerenderPersistent()
  }

  /**
   * Cap for the pinned panel: it is a live region and cannot scroll, so it must never exceed the
   * viewport. Reserve rows for the runner's occasional lines above it; fall back to an 80×24 assumption
   * when the stream reports no row count (piped / test stdout).
   */
  private maxFooterLines(): number {
    return Math.max(3, (this.stdout.rows ?? 24) - 6)
  }

  /** Mount or repaint the live region from the current header / logs / panel snapshot. */
  private rerenderPersistent(): void {
    const tree = (
      <LiveRegion
        headerLines={this.headerLines}
        logLines={this.logLines}
        footerLines={this.footerLines}
        maxFooterLines={this.maxFooterLines()}
      />
    )

    if (this.instance) {
      this.instance.rerender(tree)

      return
    }
    this.instance = this.renderFn(tree, { stdout: this.stdout, exitOnCtrlC: false, patchConsole: false })
  }

  /** Re-clamp + repaint on terminal resize (SIGWINCH), so a shrink never overflows the viewport. */
  private readonly onResize = (): void => {
    if (this.persistent) {
      this.rerenderPersistent()
    }
  }

  /**
   * Repaint the live status rows in place from a fresh summary (header + runner lines untouched).
   *
   * This is the panel's heartbeat. With no log tail on screen, a panel whose numbers never move is
   * indistinguishable from a hung process — so this is what proves the session is alive.
   */
  refresh(summary: ReadySummary): void {
    // A session still in boot has no panel to refresh.
    if (!this.persistent) {
      return
    }
    this.footerLines = this.renderer.formatFooterLines(summary)
    this.rerenderPersistent()
  }

  dispose(): void {
    if (this.persistent) {
      // Commit the last panel state, then release the terminal.
      this.rerenderPersistent()
      if (typeof this.stdout.off === 'function') {
        this.stdout.off('resize', this.onResize)
      }
    }
    this.finalized = true
    this.persistent = false
    this.unmount()
  }
}
