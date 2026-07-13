/**
 * Terminal renderer for `infra-kit dev` — a calm-print layer (never a full-screen TUI) that owns
 * every line the dev-server writes to the terminal, plus the tee to the session log (`logs.txt`).
 *
 * Design (see `.omc/plans/dev-log-redesign.md`): the boot collapses into a single transient spinner;
 * the final screen leads with per-server endpoints + health; the live tail is tagged + timestamped.
 * Full detail always reaches the log file regardless of `--verbose`.
 *
 * All I/O is injected (`write` / `appendLog` / `isTTY` / `now`) so every frame is snapshot-testable
 * and the spinner is deterministically disabled in tests (`isTTY: false`). The renderer coexists with
 * a child that owns its own TTY (vite via `turbo run dev`), because that child starts only AFTER
 * {@link DevRenderer.ready} has cleared the spinner — the spinner is never live concurrently with
 * inherited child output.
 */
import process from 'node:process'

import type { DevUi } from './dev-ui.js'

export type LogLevel = 'info' | 'warn' | 'error' | 'debug'

/** Injected I/O seams. Defaults wire to the real stdout + a caller-provided file appender. */
export interface DevRendererDeps {
  /** Terminal sink (default: `process.stdout.write`). */
  write: (text: string) => void
  /** File tee — always receives full detail (default: no-op; the runner passes its log appender). */
  appendLog: (text: string) => void
  /** Whether the terminal is a TTY. Gates the spinner + ANSI color; false in CI / when piped. */
  isTTY: boolean
  /** Clock seam (default: `() => new Date()`), so timestamps + `ready in Xs` are testable. */
  now: () => Date
  /** When true, boot narration reaches the terminal; otherwise it is file-only. */
  verbose: boolean
}

/** One resolved backend endpoint row in the ready header. */
export interface EndpointRow {
  /** Stream tag, e.g. `client/api`. */
  tag: string
  /** The app's `.localhost` alias URL — the only form, since an app that cannot be aliased never starts. */
  url: string
  /** Liveness: `true` → `● ok`, `false` → `● down`, `null` → no dot (not probed). */
  healthy: boolean | null
}

/**
 * A UI app whose URL the runner does not own, so it streams its own below — referenced, never given a
 * (fabricated) endpoint row. The fallback case only: a UI whose port the runner pre-assigned is an
 * {@link EndpointRow}, proxy or no proxy.
 */
export interface UiRef {
  /** Stream tag, e.g. `client/ui`. */
  tag: string
}

/**
 * An app that was asked for but never came up. It has no URL and no health — but it MUST still get a
 * row: the header is a report of what the user asked for, and an app that silently vanishes from it
 * reads as "not requested" rather than "broken".
 */
export interface FailedRow {
  /** Stream tag, e.g. `client/api`. */
  tag: string
  /** One-line reason, e.g. `config is missing field: 'connectionURL'`. */
  reason: string
}

/** Everything {@link DevRenderer.ready} needs to paint the final header in one shot. */
export interface ReadySummary {
  /** Resolved preset / target label (e.g. `client`, `*`). */
  target: string
  watch: boolean
  /**
   * True when this session launches a `turbo run dev` UI child that inherits the TTY. It is the
   * authoritative "is this a UI session?" signal — NOT `uiRefs.length > 0`. A UI whose port the runner
   * pre-assigned becomes an {@link EndpointRow}, not a {@link UiRef}, so `uiRefs` is normally empty even
   * for a UI session; any live region painted then would scribble into vite's inherited output. The
   * scroll-region footer (which tolerates the child) is chosen on this flag instead.
   */
  hasUiChild: boolean
  /** Slugified release for the header meta; omitted outside a git repo. */
  release?: string
  /** Backend readiness time in ms (UI is fire-and-forget, so this is BE-only — labeled honestly). */
  elapsedMs: number
  /** Real backend endpoint rows (owned ports + pre-probed health). */
  endpoints: EndpointRow[]
  /** UI apps that print their own URL below. */
  uiRefs: UiRef[]
  /**
   * Apps that failed to start. Optional only so the (many) existing summaries need not restate an
   * empty list; a non-empty one downgrades the title from a green `ready` to an honest `N failed`.
   */
  failed?: FailedRow[]
  /** Human watch summary, e.g. `1 app · 5 packages`; omitted when not watching. */
  watchSummary?: string
  /** Compact, human-readable log path shown as the `logs → …` label (e.g. `~/.cache/infra-kit/<session>/logs.txt`). */
  logPath: string
  /** Absolute log path backing the clickable OSC-8 hyperlink (wrapped as `file://<logHref>`). */
  logHref: string
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPINNER_INTERVAL_MS = 80

const ANSI = {
  reset: '\x1B[0m',
  dim: '\x1B[2m',
  bold: '\x1B[1m',
  teal: '\x1B[36m',
  green: '\x1B[32m',
  blue: '\x1B[34m',
  red: '\x1B[31m',
} as const

/** Erase the current line and return the cursor to column 0 (used to clear the spinner). */
const CLEAR_LINE = '\r\x1B[2K'

/**
 * SGR color codes (`ESC [ … m`) and OSC-8 hyperlink wrappers (`ESC ] 8 ; ; … ESC \`), non-greedy.
 * Matching the ESC control character is the whole point here — this pattern exists to remove it.
 */
// eslint-disable-next-line sonarjs/no-control-regex, no-control-regex
const ANSI_PATTERN = /\x1B\[[0-9;]*m|\x1B\]8;;.*?\x1B\\/g

/**
 * Strip SGR colors + OSC-8 hyperlink escapes, keeping the hyperlink's visible label. Applied at the
 * file-tee seam so `logs.txt` stays greppable plain text even though the terminal frames it renders
 * from are colored + hyperlinked (both renderers format once, for a TTY, and tee the same string).
 */
export const stripAnsi = (s: string): string => {
  return s.replace(ANSI_PATTERN, '')
}

/** Zero-pad to 2 digits for `HH:MM:SS`. */
const pad2 = (n: number): string => {
  return String(n).padStart(2, '0')
}

/** `HH:MM:SS` for a tail timestamp. */
export const formatClock = (d: Date): string => {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** `2.4s` for the `ready in …` header. */
export const formatElapsed = (ms: number): string => {
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * Resolve the endpoint URL for an app: `https://<alias><prefix>`, where `alias` is the portless hostname
 * the runner registered (e.g. `feat-x.backend-api.localhost`). The runner refuses to start an app it could
 * not alias, so there is no port-form to fall back to.
 *
 * There is no port and no scheme choice, by construction. The proxy serves TLS on 443 — the implicit HTTPS
 * port — so the URL is byte-identical to the `dev.proxy` local template that `infra-kit/vite` proxies to,
 * and what the table prints cannot drift from what the frontend calls. Any port suffix here would mean the
 * proxy is not on 443, which `ensureProxy` has already refused to start.
 */
export const resolveEndpointUrl = (input: { prefixUrl: string; alias: string }): string => {
  return `https://${input.alias}${input.prefixUrl}`
}

export class DevRenderer implements DevUi {
  private readonly deps: DevRendererDeps
  private spinnerTimer: ReturnType<typeof setInterval> | null = null
  private spinnerPhase = ''
  private spinnerFrame = 0

  constructor(deps: Partial<DevRendererDeps> = {}) {
    this.deps = {
      write:
        deps.write ??
        ((text: string): void => {
          process.stdout.write(text)
        }),
      appendLog: deps.appendLog ?? ((): void => {}),
      isTTY: deps.isTTY ?? Boolean(process.stdout.isTTY),
      now:
        deps.now ??
        ((): Date => {
          return new Date()
        }),
      verbose: deps.verbose ?? false,
    }
  }

  /** Wrap `s` in an ANSI color on a TTY; return it untouched when piped (deterministic snapshots). */
  private color(code: string, s: string): string {
    return this.deps.isTTY ? `${code}${s}${ANSI.reset}` : s
  }

  /**
   * Wrap `label` in an OSC-8 terminal hyperlink to `href` (a filesystem path → `file://` URI) so the
   * log path is cmd/ctrl-clickable. Returns the bare `label` when piped (deterministic snapshots) or
   * when `href` is empty — terminals without OSC-8 support silently ignore the escapes anyway.
   */
  private hyperlink(href: string, label: string): string {
    if (!this.deps.isTTY || href === '') return label

    // `encodeURI` escapes spaces / non-ASCII but leaves `#` and `?`, which a file URI reads as a
    // fragment / query — encode those too so a path containing them still resolves to the real file.
    const uri = encodeURI(href).replace(/[#?]/g, (c) => {
      return `%${c.charCodeAt(0).toString(16).toUpperCase()}`
    })

    return `\x1B]8;;file://${uri}\x1B\\${label}\x1B]8;;\x1B\\`
  }

  /**
   * Append one line to the log file ONLY — the canonical `[iso] [LEVEL] msg` shape, no terminal write.
   * The single source of the file-tee format: the private {@link tee} and the Ink boot UI both route
   * here, so the log file stays identical whichever renderer is live.
   */
  teeOnly(message: string, level: LogLevel): void {
    this.deps.appendLog(`[${this.deps.now().toISOString()}] [${level.toUpperCase()}] ${stripAnsi(message)}\n`)
  }

  /** File tee for a line that is ALSO written to the terminal; delegates the format to {@link teeOnly}. */
  private tee(message: string, level: LogLevel): void {
    this.teeOnly(message, level)
  }

  /**
   * No-op for the plain renderer: it owns no Ink / raw-mode terminal state to release. Present to
   * satisfy {@link DevUi} so the runner can call `dispose()` uniformly. Idempotent by construction.
   */
  dispose(): void {
    // Nothing to release — the plain renderer never seizes the terminal.
  }

  /**
   * Write one terminal line spinner-safely: if the spinner is live on a TTY, erase it, print the
   * line, then repaint the spinner, so a mid-boot message never shreds the `\r`-based spinner.
   */
  private emit(line: string): void {
    if (this.spinnerTimer != null && this.deps.isTTY) {
      this.deps.write(`${CLEAR_LINE}${line}\n`)
      this.paintSpinner()

      return
    }

    this.deps.write(`${line}\n`)
  }

  /** A general message routed by level (terminal + file tee). Debug is terminal-only in verbose. */
  log(message: string, level: LogLevel = 'info'): void {
    if (level !== 'debug' || this.deps.verbose) {
      this.emit(message)
    }
    this.tee(message, level)
  }

  /** A boot-narration step: terminal only when `--verbose`, but always tee'd to the log. */
  narrate(message: string): void {
    if (this.deps.verbose) {
      this.emit(message)
    }
    this.tee(message, 'info')
  }

  /** `LogFn`-shaped adapter for the build runner seam (which passes `(msg, level)`). */
  readonly logFn = (message: string, level: LogLevel = 'info'): void => {
    this.log(message, level)
  }

  // ---- boot spinner -------------------------------------------------------

  /** Paint the current spinner frame in place (TTY only). */
  private paintSpinner(): void {
    const frame = SPINNER_FRAMES[this.spinnerFrame % SPINNER_FRAMES.length]!

    this.deps.write(`${CLEAR_LINE}${this.color(ANSI.teal, frame)} ${this.color(ANSI.dim, this.spinnerPhase)}`)
  }

  /**
   * Update the boot phase. On a TTY this drives a single transient spinner line; when piped it
   * prints one plain phase line (no ANSI, deterministic). Always tee'd to the log.
   */
  bootStep(phase: string): void {
    this.tee(phase, 'info')
    this.spinnerPhase = phase

    if (!this.deps.isTTY) {
      this.deps.write(`${phase}\n`)

      return
    }

    if (this.spinnerTimer == null) {
      this.spinnerTimer = setInterval(() => {
        this.spinnerFrame += 1
        this.paintSpinner()
      }, SPINNER_INTERVAL_MS)
      // Never keep the event loop alive for the spinner alone.
      this.spinnerTimer.unref?.()
    }
    this.paintSpinner()
  }

  /** Stop + erase the spinner line (idempotent). Called before the ready header prints. */
  stopSpinner(): void {
    if (this.spinnerTimer != null) {
      clearInterval(this.spinnerTimer)
      this.spinnerTimer = null
    }
    if (this.deps.isTTY) {
      this.deps.write(CLEAR_LINE)
    }
  }

  // ---- the ready header ---------------------------------------------------

  /** Format the health dot for an endpoint row (`● ok` / `● down` / '' when unprobed). */
  private healthDot(healthy: boolean | null): string {
    if (healthy === null) return ''
    if (healthy) return this.color(ANSI.green, '● ok')

    return this.color(ANSI.red, '● down')
  }

  /**
   * Collapse the boot and print the final header in one shot: title line, one endpoint row per
   * backend server (with health dot), a reference line per UI app, the watch line, the clickable
   * log path, and a separator rule. Synchronous — health is pre-probed by the caller.
   */
  ready(summary: ReadySummary): void {
    this.stopSpinner()

    const lines = this.formatReadyLines(summary)

    for (const line of lines) {
      this.emit(line)
      this.tee(line, 'info')
    }
  }

  /** Column width for the aligned `tag` gutter — the widest endpoint/UI/failed tag. */
  private tagWidth(summary: ReadySummary): number {
    const tags = [
      ...summary.endpoints.map((e) => {
        return e.tag
      }),
      ...summary.uiRefs.map((u) => {
        return u.tag
      }),
      ...(summary.failed ?? []).map((f) => {
        return f.tag
      }),
    ]

    return tags.reduce((w, t) => {
      return Math.max(w, t.length)
    }, 0)
  }

  /**
   * The `infra-kit dev · <meta>   ready in Xs` title line.
   *
   * A green `ready` is a claim about the whole session, so it is spent only when the whole session
   * is up. With anything in `failed` the status turns red and counts the casualties instead — the
   * boot time alone, next to a green word, is exactly how a half-dead session used to pass for a
   * healthy one.
   */
  private titleLine(summary: ReadySummary): string {
    const meta = [summary.target, summary.watch ? 'watch' : null, summary.release]
      .filter((s): s is string => {
        return Boolean(s)
      })
      .join(' · ')

    const failedCount = summary.failed?.length ?? 0
    const elapsed = formatElapsed(summary.elapsedMs)
    const status =
      failedCount > 0
        ? this.color(ANSI.red, `${failedCount} failed · started in ${elapsed}`)
        : this.color(ANSI.green, `ready in ${elapsed}`)

    return `  ${this.color(ANSI.bold, 'infra-kit dev')}  ${this.color(ANSI.dim, meta)}   ${status}`
  }

  /** The static legend tail: watch line + clickable log path, then a separator rule. */
  private legendLines(summary: ReadySummary): string[] {
    const watchText = summary.watch && summary.watchSummary ? `watching ${summary.watchSummary}` : 'watch off'
    const logLink = this.hyperlink(summary.logHref, summary.logPath)
    const watchLine = `${watchText}          logs → ${logLink}`
    const rule = '─'.repeat(60)

    return [`  ${this.color(ANSI.dim, watchLine)}`, `  ${this.color(ANSI.dim, rule)}`]
  }

  /** A UI reference row (`client/ui   → starting below …`) — used only when infra-kit could not claim its port. */
  private uiRefLine(tag: string, tagWidth: number): string {
    return `  ${this.color(ANSI.teal, tag.padEnd(tagWidth))}  ${this.color(
      ANSI.dim,
      '→ starting below (vite prints its URL)',
    )}`
  }

  /** One endpoint row (`client/api  http://…`); appends a health dot only when `withHealthDot` and the endpoint is probed. */
  private endpointLine(endpoint: ReadySummary['endpoints'][number], tagWidth: number, withHealthDot: boolean): string {
    const dot = withHealthDot ? this.healthDot(endpoint.healthy) : ''
    const dotSuffix = dot ? `  ${dot}` : ''

    return `  ${this.color(ANSI.teal, endpoint.tag.padEnd(tagWidth))}  ${this.color(ANSI.blue, endpoint.url)}${dotSuffix}`
  }

  /** One failed row (`client/api  ● failed  <reason>`) — no URL, because there is nothing listening. */
  private failedLine(failed: FailedRow, tagWidth: number): string {
    return `  ${this.color(ANSI.teal, failed.tag.padEnd(tagWidth))}  ${this.color(
      ANSI.red,
      '● failed',
    )}  ${this.color(ANSI.dim, failed.reason)}`
  }

  /**
   * Shared header layout: blank, title line, blank, one endpoint row per backend, a reference row per
   * UI app, then the watch/log legend. `withHealthDot` is the ONLY difference between the static Ink
   * header (false — health is live, the footer owns it) and the ready/boot frame (true).
   */
  private formatLines(summary: ReadySummary, { withHealthDot }: { withHealthDot: boolean }): string[] {
    const tagWidth = this.tagWidth(summary)
    const lines: string[] = ['', this.titleLine(summary), '']

    for (const e of summary.endpoints) {
      lines.push(this.endpointLine(e, tagWidth, withHealthDot))
    }
    // Failures sit with the live rows, not in the scrollback above: the log line announcing the crash
    // is metres up the terminal by now, and the header is the only thing the user actually reads.
    for (const f of summary.failed ?? []) {
      lines.push(this.failedLine(f, tagWidth))
    }
    for (const u of summary.uiRefs) {
      lines.push(this.uiRefLine(u.tag, tagWidth))
    }

    lines.push('', ...this.legendLines(summary))

    return lines
  }

  /**
   * Static reference lines for the persistent Ink header, committed ONCE via `<Static>`: title,
   * endpoint URLs WITHOUT the health dot (health is live → the footer owns it), UI reference rows,
   * watch line, clickable log path, separator. Pure; colors follow `isTTY`.
   */
  formatHeaderLines(summary: ReadySummary): string[] {
    return this.formatLines(summary, { withHealthDot: false })
  }

  /**
   * Live status lines for the persistent Ink footer, re-rendered in place as health flips (never
   * committed to `<Static>`): one health row per PROBED backend endpoint (`client/api  ● ok`).
   * Unprobed endpoints (`healthy === null`) are omitted. Pure; colors follow `isTTY`.
   */
  formatFooterLines(summary: ReadySummary): string[] {
    const tagWidth = this.tagWidth(summary)

    return summary.endpoints
      .filter((e) => {
        return e.healthy !== null
      })
      .map((e) => {
        return `  ${this.color(ANSI.teal, e.tag.padEnd(tagWidth))}  ${this.healthDot(e.healthy)}`
      })
  }

  /**
   * Build the ready-header lines with NO side effects (no terminal write, no tee), so both
   * {@link ready} (which writes + tees them) and the Ink boot UI (which commits them via `<Static>`
   * and tee-only's them) share one layout. Colors follow `isTTY` exactly like every other line.
   */
  formatReadyLines(summary: ReadySummary): string[] {
    return this.formatLines(summary, { withHealthDot: true })
  }

  // ---- the live tail ------------------------------------------------------

  /**
   * One tagged, timestamped tail line: `14:02:11  client/api  GET /api/v1/ping 200 12ms`. Arrives
   * strictly after {@link ready} (a request implies a running server), so it never interleaves the
   * header. Timestamp comes from the injected clock.
   */
  event(input: { tag: string; text: string }): void {
    const ts = formatClock(this.deps.now())
    const line = `  ${this.color(ANSI.dim, ts)}  ${this.color(ANSI.teal, input.tag)}  ${input.text}`

    this.emit(line)
    this.tee(`${input.tag} ${input.text}`, 'info')
  }
}
