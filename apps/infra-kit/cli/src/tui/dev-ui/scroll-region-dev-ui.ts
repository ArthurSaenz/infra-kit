import process from 'node:process'

import type { DevUi, LogLevel, ReadySummary } from 'src/dev/dev-ui'
import { DevRenderer, formatClock } from 'src/dev/render'
import { SHOW_CURSOR, installRegion, moveTo, paintFooter, resetScrollRegion } from 'src/dev/scroll-region'

/**
 * A {@link DevUi} that pins the `infra-kit dev` ready header to the bottom of the terminal as a STICKY
 * FOOTER using a DECSTBM scroll region, for sessions that run a `turbo run dev` UI child
 * (`summary.hasUiChild`). {@link PersistentInkDevUi} hands off to it at `ready`.
 *
 * Deliberately NO React / NO Ink. A UI session's tail is unbounded — every vite/HMR line the piped
 * child emits arrives as an `event` — and Ink's reconciler repaints its live region on each one. The
 * scroll region instead confines ALL scrolling (`log` + `event` lines) to the rows above the footer
 * using terminal escapes alone, so an append costs one `write` and the footer never repaints. See
 * {@link file://../../dev/scroll-region.ts}.
 *
 * The embedded {@link DevRenderer} is the single source of the file-tee format (`teeOnly`) and the
 * ready-header layout (`formatReadyLines`) — reused, never duplicated — exactly like the Ink UIs. Every
 * terminal write goes through the injected `stdout` so tests drive a fake stream.
 */

export interface ScrollRegionDevUiDeps {
  /** File tee — the same appender the runner hands every renderer. */
  appendLog: (text: string) => void
  /** Only in verbose does boot narration reach the terminal (it is always tee'd to the file). */
  verbose: boolean
  /** Target stream (default `process.stdout`). Its `isTTY`/`rows` gate the whole feature. */
  stdout?: NodeJS.WriteStream
}

export class ScrollRegionDevUi implements DevUi {
  /** Embedded plain renderer: owns the file-tee format + the ready-header layout. Never drives a spinner. */
  private readonly renderer: DevRenderer
  private readonly stdout: NodeJS.WriteStream
  private readonly verbose: boolean
  /** The current footer block (the full ready header), recomputed on `ready`/`refresh`. */
  private footerLines: string[] = []
  /** True while a scroll region is installed and the footer is live (false when disabled / disposed). */
  private installed = false
  /** True once the resize listener is attached, so it is added at most once and removed exactly once. */
  private resizeBound = false

  constructor(deps: ScrollRegionDevUiDeps) {
    this.verbose = deps.verbose
    this.stdout = deps.stdout ?? process.stdout
    this.renderer = new DevRenderer({
      appendLog: deps.appendLog,
      verbose: this.verbose,
      // Colors follow the real stream: a TTY footer is colored; a piped / captured stream stays plain.
      isTTY: Boolean(this.stdout.isTTY),
      write: (text) => {
        this.stdout.write(text)
      },
    })
  }

  /** `LogFn`-shaped adapter for the build runner seam. */
  readonly logFn = (message: string, level: LogLevel = 'info'): void => {
    this.log(message, level)
  }

  /**
   * Row count, falling back to 24 (the classic terminal default) for any non-positive or absent value.
   *
   * `rows` is NOT merely `undefined` on a row-less stream: a pty allocated without a window size — what
   * `script(1)` gives us, and what some CI runners and terminal emulators report before their first
   * `SIGWINCH` — sets `isTTY === true` alongside `rows === 0`. A `??` fallback passes that `0` straight
   * through, `installRegion` then reads the terminal as "too short", and the footer silently never
   * installs on a terminal that is in fact perfectly tall enough.
   */
  private rows(): number {
    const reported = this.stdout.rows

    return reported != null && reported > 0 ? reported : 24
  }

  /** Write each line as its own terminal row (used for the non-TTY / too-short plain fallback). */
  private writeLines(lines: readonly string[]): void {
    for (const line of lines) {
      this.stdout.write(`${line}\n`)
    }
  }

  narrate(message: string): void {
    this.renderer.teeOnly(message, 'info')
    if (this.verbose) {
      this.stdout.write(`${message}\n`)
    }
  }

  /** A general message: lands inside the scroll region and scrolls normally, plus a file tee. */
  log(message: string, level: LogLevel = 'info'): void {
    if (level !== 'debug' || this.verbose) {
      this.stdout.write(`${message}\n`)
    }
    this.renderer.teeOnly(message, level)
  }

  /** Boot narration only — no spinner (a spinner would fight the child for the cursor). */
  bootStep(phase: string): void {
    this.narrate(phase)
  }

  /** No-op: this UI never runs a spinner. */
  stopSpinner(): void {
    // Nothing to stop.
  }

  /**
   * Install (or re-install) the scroll region and paint the footer for the CURRENT terminal size.
   * Returns `false` when the terminal is too short to host both a region and the footer — the caller
   * then falls back to a one-shot plain print (or disposes, on a shrink).
   */
  private applyRegion(): boolean {
    const rows = this.rows()
    const region = installRegion(this.footerLines.length, rows)

    if (region === '') return false
    this.stdout.write(`${region}${paintFooter(this.footerLines, rows)}`)

    return true
  }

  /** Attach the resize listener once (guarded — an injected stream may not be an EventEmitter TTY). */
  private bindResize(): void {
    if (this.resizeBound || typeof this.stdout.on !== 'function') return
    this.stdout.on('resize', this.onResize)
    this.resizeBound = true
  }

  ready(summary: ReadySummary): void {
    this.footerLines = this.renderer.formatReadyLines(summary)
    for (const line of this.footerLines) {
      this.renderer.teeOnly(line, 'info')
    }

    // Not a real terminal (piped / test capture): just print the header once, no region.
    if (!this.stdout.isTTY) {
      this.writeLines(this.footerLines)

      return
    }

    // Too short for a region → print plainly and leave the feature disabled (installed stays false).
    if (!this.applyRegion()) {
      this.writeLines(this.footerLines)

      return
    }
    this.installed = true
    this.bindResize()
  }

  /** One tagged, timestamped tail line — scrolls inside the region like any other `log`. */
  event(input: { tag: string; text: string }): void {
    const line = `  ${formatClock(new Date())}  ${input.tag}  ${input.text}`

    this.stdout.write(`${line}\n`)
    this.renderer.teeOnly(`${input.tag} ${input.text}`, 'info')
  }

  /** Recompute the footer and repaint it in place — nothing else is reprinted. No-op when not installed. */
  refresh(summary: ReadySummary): void {
    this.footerLines = this.renderer.formatReadyLines(summary)
    if (!this.installed) return
    this.stdout.write(paintFooter(this.footerLines, this.rows()))
  }

  /**
   * Re-clamp on terminal resize (SIGWINCH, surfaced as the stream's `resize` event): re-run the region
   * install + repaint for the new size. If the new size is too short to host the footer, dispose
   * gracefully rather than paint a broken region.
   */
  private readonly onResize = (): void => {
    if (!this.installed) return
    if (!this.applyRegion()) {
      this.dispose()
    }
  }

  /**
   * Release the terminal: drop the resize listener, reset the scroll region, drop the cursor onto the
   * last row with a fresh newline, and restore the cursor. Idempotent and safe if never installed — the
   * region escapes are emitted only while a region is actually live, so a second call (or a disposal of
   * a never-installed instance) writes nothing and leaves the terminal usable.
   */
  dispose(): void {
    if (this.resizeBound && typeof this.stdout.off === 'function') {
      this.stdout.off('resize', this.onResize)
      this.resizeBound = false
    }
    if (this.installed) {
      const rows = this.rows()

      this.stdout.write(`${resetScrollRegion()}${moveTo(rows, 1)}\n${SHOW_CURSOR}`)
      this.installed = false
    }
  }
}
