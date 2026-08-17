/**
 * Terminal renderer for `infra-kit dev` — a calm-print layer (never a full-screen TUI).
 *
 * The boot collapses into a single transient spinner; the final screen is a STATUS PANEL, one row per
 * server, carrying health, uptime, requests/min, restarts and an error count. There is no log tail:
 * every line — framework output, request logs, a handler's own `console.log` — is written to that
 * service's file under `<cacheRoot>/<session>/dev/<pid>/` and never printed. What still appears above
 * the panel is only what the RUNNER says: a restart, an unhealthy app, a dead engine.
 *
 * The panel's live fields are the reason it is a status surface and not a screenshot. With nothing
 * scrolling beside it, a panel whose numbers never move cannot be told apart from a hung process.
 *
 * All I/O is injected (`write` / `appendLog` / `isTTY` / `now`) so every frame is snapshot-testable and
 * the spinner is deterministically disabled in tests (`isTTY: false`).
 */
import process from 'node:process'

import type { DevUi } from './dev-ui.js'

export type LogLevel = 'info' | 'warn' | 'error' | 'debug'

/**
 * Per-call options for {@link DevRenderer.log}.
 *
 * `tee: false` exists for exactly one caller: `DevServerRunner.reportFault`, which files the fault into the
 * sink ITSELF (at `error` level — that is what turns the panel row red) and then prints it. Without this
 * opt-out the print tees a SECOND copy into the same `runner.log`, so every fault is filed twice — a
 * literal 2× amplifier sitting at the centre of the loop that wrote 455 GB.
 */
export interface LogOptions {
  /** Also append the line to the log file. Default `true`; `false` prints without filing. */
  tee?: boolean
}

/**
 * A row's liveness, as the runner's probe state machine resolved it.
 *
 * Five arms, not a boolean, because a probe has three outcomes and a row has a history. The two that
 * are neither `ok` nor `down` are the honest ones: a UI that has never answered yet is `starting`
 * (vite is spawned after the ready frame, so red would be a lie for the first seconds), and a port that
 * answers something OTHER than vite's ping is `unverified` — a squatter, a shadowing proxy, or a future
 * vite that dropped the endpoint are all consistent with that, and only one of them is broken. Red must
 * stay a PROOF of failure, so `unverified` renders a question mark and never a red dot.
 */
export type HealthState = 'ok' | 'down' | 'starting' | 'unverified' | 'unknown'

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

/**
 * One resolved proxy route on a frontend, painted as an indented line under that app's row: which route,
 * where it lands, and whether it is the local backend or the shared cloud one. This is the "all proxies —
 * which one and where" surface: unlike a {@link DegradedRow} it reports the happy path too, so a frontend
 * that proxies `/api` local and `/media` cloud shows both, and nobody has to guess where a route points.
 */
export interface ProxyRouteRow {
  /** Route path (e.g. `/api`). */
  route: string
  /** Where the route resolves this run — the local backend or the shared cloud origin. */
  source: 'local' | 'cloud'
  /**
   * The origin the route lands on. Omitted when it is not knowable (a `local` route whose backend is not
   * up — a dead alias the degraded row already owns — or a `cloud` route with no `<env>` sourced).
   */
  target?: string
}

/**
 * One server's row on the status panel.
 *
 * The live fields below are what make the panel a STATUS surface rather than a screenshot. The terminal
 * no longer carries a log tail, so a static row would leave "quiet" indistinguishable from "hung" — the
 * moving numbers are the liveness tell, and they are not decoration.
 */
export interface EndpointRow {
  /** Stream tag, e.g. `client/api`. */
  tag: string
  /** The app's `.localhost` alias URL — the only form, since an app that cannot be aliased never starts. */
  url: string
  /** Liveness, as {@link HealthState} defines it; `unknown` renders no dot at all (nothing to probe). */
  health: HealthState
  /** Milliseconds since this server last (re)started. Omitted on the boot frame. */
  uptimeMs?: number
  /** Watch-triggered restarts so far this session. */
  restarts?: number
  /** Requests served in the last 60s. */
  rpm?: number
  /**
   * Errors this service has declared since boot — a 5xx, a `console.error`, a framework failure line.
   * This is the ONLY error signal the user gets now that nothing prints, so a row that cannot count is
   * a row that lies. A COUNT, never a classification: it is incremented from the level the emitter
   * declared, never from anything read out of the line's text.
   */
  errors?: number
  /**
   * Resolved proxy routes for a frontend row (a `<app>/ui` endpoint), painted as an indented list under
   * it. Absent on backend rows — a `<app>/api` endpoint proxies nothing — and on a frontend with no
   * `dev.proxy` block.
   */
  proxies?: ProxyRouteRow[]
}

/**
 * A UI app whose URL the runner does not own, so it streams its own below — referenced, never given a
 * (fabricated) endpoint row. The fallback case only: a UI whose port the runner pre-assigned is an
 * {@link EndpointRow}, proxy or no proxy.
 */
export interface UiRef {
  /** Stream tag, e.g. `client/ui`. */
  tag: string
  /**
   * Errors this UI has declared since boot. Present for the same reason an {@link EndpointRow} has one:
   * with nothing printing, a row that cannot count is a row that lies — and this row belongs to the app
   * whose vite config never wired `infraKitDev()`, i.e. the one most likely to be misconfigured.
   */
  errors?: number
  /** Resolved proxy routes for this frontend, painted as an indented list under its reference line. */
  proxies?: ProxyRouteRow[]
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

/**
 * A route that wanted a local backend and is falling back to cloud because that backend failed to start.
 *
 * It gets a row of its own — not a footnote on the failed backend's row — because the two facts land on
 * different people. `client/api ● failed` says a server is down, which reads as "that half is broken".
 * It does NOT say the frontend beside it came up healthy and is now sending every `/api` request to the
 * shared cloud backend. That second fact is the one that gets you writing to the cloud dev database
 * while you believe you are on localhost, and it is invisible everywhere else on the screen: the vite
 * proxy resolved cleanly, so nothing else has anything to complain about.
 *
 * Only rendered under `--watch` — without it the run is refused outright (see `local-pairing.ts`).
 */
export interface DegradedRow {
  /** Route path (e.g. `/api`). */
  route: string
  /** Stream tag of the frontend serving it, e.g. `client/ui`. */
  tag: string
  /**
   * Where the route ACTUALLY resolves now. Not always `cloud`: the helper falls back to
   * `route.default ?? route.from[0]`, so a single-source `from: ['local']` route with no `default` falls
   * back to `local` — at an alias nothing registered, i.e. a 502 on every request. The row must name the
   * real destination, or it is doing the same lying-by-omission it exists to prevent.
   */
  fallback: 'local' | 'cloud'
  /** The cloud origin it now resolves to. Only ever set when `fallback` is `cloud` and it is knowable. */
  target?: string
}

/** Everything {@link DevRenderer.ready} needs to paint the final header in one shot. */
export interface ReadySummary {
  /** Resolved preset / target label (e.g. `client`, `*`). */
  target: string
  watch: boolean
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
  /**
   * Routes silently demoted from local to cloud by a backend that failed to start. Recomputed on every
   * repaint, so a route CLEARS from the panel the moment `--watch` gets its backend up (see
   * {@link DegradedRow}).
   */
  degraded?: DegradedRow[]
  /** Human watch summary, e.g. `1 app · 5 packages`; omitted when not watching. */
  watchSummary?: string
  /**
   * Compact, human-readable log path shown as the `logs → …` label. A DIRECTORY, not a file
   * (e.g. `~/.cache/infra-kit/<session>/dev/<pid>`): there is one log per service, so a single path
   * would have to pick a favourite.
   */
  logPath: string
  /** Absolute log path backing the clickable OSC-8 hyperlink (wrapped as `file://<logHref>`). */
  logHref: string
  /**
   * Milliseconds since the session became ready — the panel's HEARTBEAT.
   *
   * Every other live field belongs to a backend: uptime, req/min, restarts. A UI-only session has no
   * backend, so its rows have nothing that moves — and Ink does not repaint an identical frame, so the
   * screen would sit perfectly still while the session ran. With no log tail left to prove otherwise,
   * a motionless panel is indistinguishable from a hung process. This is the one field that ticks for
   * EVERY session shape. Omitted on the boot frame, where nothing has elapsed yet.
   */
  sessionUptimeMs?: number
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

/** `2.4s` for the `ready in …` header. */
export const formatElapsed = (ms: number): string => {
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * `47s` / `4m12s` / `2h03m` — the panel's liveness tell.
 *
 * With no log tail on screen, a panel whose numbers never move is indistinguishable from a hung
 * process. This is the field that proves the session is alive even when nothing is happening, so it is
 * always rendered and always advancing.
 */
export const formatUptime = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60

  if (hours > 0) return `${hours}h${pad2(minutes)}m`
  if (minutes > 0) return `${minutes}m${pad2(seconds)}s`

  return `${seconds}s`
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
  log(message: string, level: LogLevel = 'info', options: LogOptions = {}): void {
    if (level !== 'debug' || this.deps.verbose) {
      this.emit(message)
    }
    if (options.tee !== false) {
      this.tee(message, level)
    }
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

  /**
   * The error counter, shared by endpoint rows and UI reference rows.
   *
   * Zero is rendered, not omitted: with nothing else printing, this is the only failure signal on the
   * screen, so a dim `⚠ 0` is a claim worth making.
   *
   * Non-zero is BOLD red, and that is not decoration. A frontend that fails to compile still serves and
   * still answers vite's ping, so its dot stays green — the dot is liveness, and the app IS alive. This
   * counter is the only thing on the screen that says the app is nevertheless broken, so it has to win a
   * glance against a green dot sitting two columns away.
   */
  private errorCount(errors: number): string {
    const text = `⚠ ${errors}`

    return errors > 0 ? this.color(`${ANSI.bold}${ANSI.red}`, text) : this.color(ANSI.dim, text)
  }

  /**
   * The padded tag gutter for a PANEL row — red once the row has declared an error, teal otherwise.
   *
   * Footer only, never {@link formatHeaderLines}. The header is committed once through Ink's `<Static>`,
   * so a tag reddened there would be a photograph of the boot: it could never turn red later, and — far
   * worse — could never turn back. The panel repaints, so the color tracks the fact.
   */
  private tagCell(tag: string, tagWidth: number, errors: number | undefined): string {
    return this.color((errors ?? 0) > 0 ? ANSI.red : ANSI.teal, tag.padEnd(tagWidth))
  }

  /** Format the health dot for an endpoint row — one arm per {@link HealthState}; `unknown` prints nothing. */
  private healthDot(health: HealthState): string {
    switch (health) {
      case 'ok':
        return this.color(ANSI.green, '● ok')
      case 'down':
        return this.color(ANSI.red, '● down')
      case 'starting':
        return this.color(ANSI.dim, '◌ starting')
      // Answering, but not with vite's ping. Dim, never red: a non-204 is equally consistent with a
      // broken squatter and a perfectly healthy vite behind something that shadows the ping, and a red
      // dot on a coin-flip is how a dot stops being read at all.
      case 'unverified':
        return this.color(ANSI.dim, '◍ ?')
      default:
        return ''
    }
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
      // A degraded row's gutter is `<tag> <route>`, which is wider than any bare tag — measure the label
      // it actually prints or its `● cloud …` cell would sit out of column with every row above it.
      ...(summary.degraded ?? []).map((d) => {
        return `${d.tag} ${d.route}`
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

  /**
   * A UI reference row — used when infra-kit could not claim the UI's port, so it has no URL to print.
   *
   * It STILL carries an error count. That is the whole point: this row is exactly the misconfigured app
   * (its vite config never wired `infraKitDev()`), which is the app most likely to be broken — and with
   * no log tail on screen, a row with no error field is a row that cannot report the breakage. It used
   * to be a bare reference line, so its errors were counted into a file nobody had a reason to open.
   */
  private uiRefLine(ref: UiRef, tagWidth: number, errors: number | undefined): string {
    const errText = errors == null ? '' : `  ${this.errorCount(errors)}`

    return `  ${this.color(ANSI.teal, ref.tag.padEnd(tagWidth))}  ${this.color(
      ANSI.dim,
      'no managed port (vite prints its own URL)',
    )}${errText}`
  }

  /**
   * The live half of an endpoint row: `up 4m12s   18/min   ↺2   ⚠ 3`.
   *
   * Empty on the boot frame (no field is set yet). Each field is omitted individually when absent — a
   * server with no restarts should not have to say so.
   */
  private statusFields(endpoint: ReadySummary['endpoints'][number]): string {
    const parts: string[] = []

    if (endpoint.uptimeMs != null) parts.push(this.color(ANSI.dim, `up ${formatUptime(endpoint.uptimeMs)}`))
    if (endpoint.rpm != null && endpoint.rpm > 0) parts.push(this.color(ANSI.dim, `${endpoint.rpm}/min`))
    if (endpoint.restarts != null && endpoint.restarts > 0) parts.push(this.color(ANSI.dim, `↺${endpoint.restarts}`))
    // Errors are the exception to "omit when zero" — see {@link errorCount}.
    if (endpoint.errors != null) {
      parts.push(this.errorCount(endpoint.errors))
    }

    return parts.join('   ')
  }

  /** One endpoint row (`client/api  https://…  ● ok  up 4m12s  18/min  ⚠ 0`). */
  private endpointLine(endpoint: ReadySummary['endpoints'][number], tagWidth: number, withHealthDot: boolean): string {
    const dot = withHealthDot ? this.healthDot(endpoint.health) : ''
    const status = this.statusFields(endpoint)
    const suffix = [dot, status].filter(Boolean).join('  ')

    return `  ${this.color(ANSI.teal, endpoint.tag.padEnd(tagWidth))}  ${this.color(ANSI.blue, endpoint.url)}${
      suffix ? `  ${suffix}` : ''
    }`
  }

  /** One failed row (`client/api  ● failed  <reason>`) — no URL, because there is nothing listening. */
  private failedLine(failed: FailedRow, tagWidth: number): string {
    return `  ${this.color(ANSI.teal, failed.tag.padEnd(tagWidth))}  ${this.color(
      ANSI.red,
      '● failed',
    )}  ${this.color(ANSI.dim, failed.reason)}`
  }

  /**
   * One degraded-route row (`⚠ /api  ● cloud (local backend failed)  https://dev.hulyo.co.il`).
   *
   * Tagged by ROUTE, not by app, and deliberately so: the app rows above already say what is up and what
   * is down, and neither of them can say "the frontend that came up healthy is talking to cloud". The
   * route is the thing that got redirected, so the route is what the row is about.
   */
  private degradedLine(row: DegradedRow, tagWidth: number): string {
    const label = `${row.tag} ${row.route}`
    // A `local` fallback is not a cloud proxy — it is a dead alias that 502s. Saying "cloud" there would
    // name a destination the traffic never reaches.
    const state = row.fallback === 'cloud' ? '● cloud (local backend down)' : '● dead alias (local backend down)'
    const target = row.target ? `  ${this.color(ANSI.dim, row.target)}` : ''

    return `  ${this.color(ANSI.red, '⚠')} ${this.color(ANSI.teal, label.padEnd(tagWidth))}  ${this.color(
      ANSI.red,
      state,
    )}${target}`
  }

  /**
   * The indented proxy lines painted under a frontend's row: `  ├ /api    ● local  https://…`. One per
   * resolved route, so "which one and where" is answered inline instead of left to guess. A filled dot is
   * the local backend, a hollow one the shared cloud origin — the same local=●/cloud=○ language the rest
   * of the panel uses. The last route gets a `└` elbow so the group reads as one block belonging to the
   * app above it. Empty when the frontend declares no routes.
   */
  private proxyLines(proxies: ProxyRouteRow[]): string[] {
    if (proxies.length === 0) return []

    const routeWidth = Math.max(
      ...proxies.map((p) => {
        return p.route.length
      }),
    )

    return proxies.map((p, i) => {
      const elbow = i === proxies.length - 1 ? '└' : '├'
      const dot = p.source === 'local' ? this.color(ANSI.green, '●') : this.color(ANSI.dim, '○')
      const where = p.target ? `  ${this.color(ANSI.blue, p.target)}` : ''

      return `    ${this.color(ANSI.dim, elbow)} ${this.color(ANSI.teal, p.route.padEnd(routeWidth))}  ${dot} ${this.color(
        ANSI.dim,
        p.source,
      )}${where}`
    })
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
      // A frontend's proxy routes hang directly off its own row, so "where does /api go" reads as a
      // property of the app rather than a footnote somewhere below it.
      if (e.proxies) lines.push(...this.proxyLines(e.proxies))
    }
    // Failures sit with the live rows, not in the scrollback above: the log line announcing the crash
    // is metres up the terminal by now, and the header is the only thing the user actually reads.
    for (const f of summary.failed ?? []) {
      lines.push(this.failedLine(f, tagWidth))
    }
    for (const u of summary.uiRefs) {
      lines.push(this.uiRefLine(u, tagWidth, u.errors))
      if (u.proxies) lines.push(...this.proxyLines(u.proxies))
    }
    // Below the app rows, because it is a consequence of one of them — a `● failed` backend is WHY a
    // route went to cloud, and the two read as cause and effect only in that order.
    for (const d of summary.degraded ?? []) {
      lines.push(this.degradedLine(d, tagWidth))
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
   * The live status rows — THE PANEL. Re-rendered in place on every tick; never committed to `<Static>`.
   *
   * This is the only part of the screen that can change after `ready`, and that makes it the only place
   * live fields can live. The header is committed once through `<Static>`, so anything painted there is
   * a photograph: an uptime or an error count rendered into the header would be frozen at its boot value
   * for the whole session, looking live and being a lie. (It was: the live fields went into the shared
   * endpoint line first, the header picked them up, the footer kept printing a bare health dot, and a
   * real run showed a panel with no uptime, no req/min and no error count at all. No unit test saw it —
   * only the rendered terminal did.)
   *
   * Every row is rendered, including an endpoint that was never probed and a UI with no backend at all:
   * with no log tail on screen this panel is the entire signal, and a row that is absent cannot report
   * that its service is broken.
   */
  formatFooterLines(summary: ReadySummary): string[] {
    const tagWidth = this.tagWidth(summary)
    const rows = summary.endpoints.map((e) => {
      const dot = this.healthDot(e.health)
      const status = this.statusFields(e)
      const cells = [dot, status].filter(Boolean).join('  ')

      return `  ${this.tagCell(e.tag, tagWidth, e.errors)}  ${cells}`
    })

    // A UI whose port infra-kit could not claim has no endpoint row — but its errors still have to land
    // somewhere the user can see, and it is precisely the app most likely to be misconfigured.
    for (const ref of summary.uiRefs) {
      if (ref.errors == null) continue
      rows.push(`  ${this.tagCell(ref.tag, tagWidth, ref.errors)}  ${this.errorCount(ref.errors)}`)
    }

    // Degraded routes live in the PANEL, not only in the header. The header is committed once through
    // `<Static>` — a photograph — so a degraded row painted only there would still be on screen after
    // `--watch` brought the backend back and the route went local again: a permanent warning about a
    // condition that has been fixed, which trains the user to ignore it. The caller re-derives this list
    // from the running set on every tick, so the row survives exactly as long as the problem does.
    for (const d of summary.degraded ?? []) {
      rows.push(this.degradedLine(d, tagWidth))
    }

    // The heartbeat. Without it a UI-only session — whose rows carry no backend uptime and no req/min —
    // would render an identical frame every tick, and Ink does not repaint an identical frame. The panel
    // would be genuinely, verifiably alive and look exactly like a hung process.
    if (summary.sessionUptimeMs != null) {
      const beat = `up ${formatUptime(summary.sessionUptimeMs)}`

      rows.push(`  ${this.color(ANSI.dim, beat)}`)
    }

    return rows
  }

  /**
   * Build the ready-header lines with NO side effects (no terminal write, no tee), so both
   * {@link ready} (which writes + tees them) and the Ink boot UI (which commits them via `<Static>`
   * and tee-only's them) share one layout. Colors follow `isTTY` exactly like every other line.
   */
  formatReadyLines(summary: ReadySummary): string[] {
    return this.formatLines(summary, { withHealthDot: true })
  }
}
