import { render as inkRender } from 'ink'
import process from 'node:process'
import type { ReactElement } from 'react'

import type { DevUi, LogLevel, ReadySummary } from 'src/dev/dev-ui'
import { DevRenderer, formatClock } from 'src/dev/render'
import { createSafeStream } from 'src/tui/safe-stderr'

import { BootRegion } from './boot-region'
import { LiveRegion } from './live-region'
import { ScrollRegionDevUi } from './scroll-region-dev-ui'

/**
 * Ink-backed {@link DevUi} for `infra-kit dev` that keeps a PERSISTENT live footer after `ready` on a
 * backend-only session. It is the default UI on any interactive TTY: the boot phase is identical to the
 * plain path, but at {@link ready} it branches on `summary.hasUiChild`.
 *
 * - UI session (`hasUiChild`): unmount Ink and HAND OFF to a {@link ScrollRegionDevUi}, which pins the
 *   ready header as a DECSTBM scroll-region footer. The `turbo run dev` child's piped output makes the
 *   tail unbounded, and Ink repaints its live region on every appended line; the scroll region appends
 *   with a single write instead. The scroll-region UI owns `ready`/`event`/`log`/`refresh`/`dispose`
 *   for the rest of the session.
 * - Backend-only (`!hasUiChild`): mount {@link LiveRegion} and STAY mounted — the header is committed
 *   once via `<Static>`, logs accrete above the footer, and `refresh` repaints the footer in place as
 *   health flips.
 *
 * The embedded {@link DevRenderer} owns the file-tee format (`teeOnly`) exactly as in `InkDevUi`; in
 * persistent mode it is used ONLY for teeing (never its direct stdout write, which would collide with
 * the live region). Every component here is OUTPUT-ONLY (no `useInput`) — see live-region.tsx.
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
  /** Target stream (default: `process.stdout` behind the scrollback-safe filter). */
  stdout?: NodeJS.WriteStream
}

export class PersistentInkDevUi implements DevUi {
  private readonly renderer: DevRenderer
  private readonly renderFn: RenderFn
  private readonly stdout: NodeJS.WriteStream
  private readonly verbose: boolean
  private readonly now: () => Date
  /** The file tee appender — kept so a UI-session handoff can hand the same sink to {@link ScrollRegionDevUi}. */
  private readonly appendLog: (text: string) => void
  /** Live Ink handle, or `null` when not mounted. */
  private instance: RenderHandle | null = null
  /** True once boot is done: never mount the boot region again. */
  private finalized = false
  /**
   * The scroll-region UI a UI session hands off to at {@link ready}, or `null` for a backend-only
   * session. Once set, every post-ready seam (`log`/`event`/`refresh`/`dispose`) delegates to it.
   */
  private handoff: ScrollRegionDevUi | null = null
  /** True while the persistent live region owns the terminal (backend-only session after ready). */
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
    // forwards everything else live. The handoff at `ready` passes this same stream to ScrollRegionDevUi,
    // so both UIs are covered by this single default.
    this.stdout = deps.stdout ?? createSafeStream(process.stdout as NodeJS.WriteStream)
    this.appendLog = deps.appendLog
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

  // ---- boot (identical to InkDevUi) --------------------------------------

  /** Mount the Ink boot region (or rerender it in place) with the current phase + narration. */
  private renderBoot(readyLines?: string[]): void {
    const tree = <BootRegion phase={this.phase} narration={this.narration} readyLines={readyLines} />

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
    if (this.handoff) {
      this.handoff.narrate(message)

      return
    }
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

  log(message: string, level: LogLevel = 'info'): void {
    if (this.handoff) {
      this.handoff.log(message, level)

      return
    }
    const willWrite = level !== 'debug' || this.verbose

    if (this.persistent) {
      // Never the embedded renderer's direct stdout write here — append to the live region instead.
      this.renderer.teeOnly(message, level)
      if (willWrite) {
        this.logLines.push(message)
        this.rerenderPersistent()
      }

      return
    }
    if (willWrite) {
      this.unmount()
    }
    this.renderer.log(message, level)
  }

  bootStep(phase: string): void {
    this.renderer.teeOnly(phase, 'info')
    if (this.finalized) {
      return
    }
    this.phase = phase
    this.renderBoot()
  }

  stopSpinner(): void {
    if (!this.persistent) {
      this.unmount()
    }
  }

  // ---- ready + persistence -----------------------------------------------

  ready(summary: ReadySummary): void {
    if (summary.hasUiChild) {
      this.readyHandoff(summary)

      return
    }
    this.readyPersistent(summary)
  }

  /**
   * UI session: unmount Ink and hand off to a {@link ScrollRegionDevUi}, which pins the ready header as
   * a scroll-region footer above the `turbo run dev` child's high-volume piped tail. From here on every
   * post-ready seam delegates to the handoff (see {@link log}/{@link event}/{@link refresh}/{@link dispose}).
   */
  private readyHandoff(summary: ReadySummary): void {
    this.finalized = true
    this.unmount()
    this.handoff = new ScrollRegionDevUi({ appendLog: this.appendLog, verbose: this.verbose, stdout: this.stdout })
    this.handoff.ready(summary)
  }

  /** Backend-only session: commit the header, tee it, mount the live footer, and STAY mounted. */
  private readyPersistent(summary: ReadySummary): void {
    this.headerLines = this.renderer.formatHeaderLines(summary)
    this.footerLines = this.renderer.formatFooterLines(summary)
    this.logLines = []
    for (const line of this.headerLines) {
      this.renderer.teeOnly(line, 'info')
    }
    this.finalized = true
    this.persistent = true
    // Re-clamp the footer when the terminal resizes. Guarded: an injected (test/piped) stream may not
    // be an EventEmitter TTY.
    if (typeof this.stdout.on === 'function') {
      this.stdout.on('resize', this.onResize)
    }
    this.rerenderPersistent()
  }

  /**
   * Cap for the pinned footer: it is a live region and cannot scroll, so it must never exceed the
   * viewport. Reserve rows for the scrolling log tail above it; fall back to an 80×24 assumption when
   * the stream reports no row count (piped / test stdout).
   */
  private maxFooterLines(): number {
    return Math.max(3, (this.stdout.rows ?? 24) - 6)
  }

  /** Mount or repaint the live region from the current header / logs / footer snapshot. */
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

  /** Re-clamp + repaint the footer on terminal resize (SIGWINCH), so a shrink never overflows the viewport. */
  private readonly onResize = (): void => {
    if (this.persistent) {
      this.rerenderPersistent()
    }
  }

  event(input: { tag: string; text: string }): void {
    if (this.handoff) {
      this.handoff.event(input)

      return
    }
    if (this.persistent) {
      const line = `  ${formatClock(this.now())}  ${input.tag}  ${input.text}`

      this.renderer.teeOnly(`${input.tag} ${input.text}`, 'info')
      this.logLines.push(line)
      this.rerenderPersistent()

      return
    }
    this.unmount()
    this.renderer.event(input)
  }

  /** Repaint the live footer in place from a fresh summary (header + logs untouched). No-op if not persistent. */
  refresh(summary: ReadySummary): void {
    if (this.handoff) {
      this.handoff.refresh(summary)

      return
    }
    // A session still in boot has no live footer to refresh.
    if (!this.persistent) {
      return
    }
    this.footerLines = this.renderer.formatFooterLines(summary)
    this.rerenderPersistent()
  }

  dispose(): void {
    if (this.handoff) {
      this.handoff.dispose()
      this.handoff = null

      return
    }
    if (this.persistent) {
      // Commit the last footer state, then release the terminal.
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
