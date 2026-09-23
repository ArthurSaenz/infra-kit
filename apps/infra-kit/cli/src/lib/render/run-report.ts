import { Chalk } from 'chalk'
import process from 'node:process'

/**
 * @fileoverview
 *
 * The one-shot run report shared by `infra-kit doctor` and `infra-kit setup`: labelled sections of
 * status rows, a per-section rollup and a totals line. Everything except {@link printRunReport} is
 * PURE: it takes already-computed rows and returns lines. It never probes, never writes, and never
 * reorders its input.
 *
 * Why this is not the logger: pino-pretty renders every row as an identical `INFO:` line, so a single
 * failure is invisible in a wall of passes. Grouped sections with rollups are the whole point.
 *
 * Why this is not Ink: this is a ONE-SHOT report, not a live region. Ink writes `ESC[3J` (erase saved
 * lines) whenever a frame overflows the viewport, which wipes the user's terminal SCROLLBACK — the
 * hazard `src/tui/safe-stderr.ts` exists to contain for the dev-ui. A report that is routinely taller
 * than the viewport is exactly the shape that triggers it, for no benefit a string[] does not already
 * give us.
 *
 * REDACTION INVARIANT — read before adding a row message or note: these lines are written straight to
 * stderr, which BYPASSES pino's `REDACT_PATHS` backstop (see `lib/logger`). Every caller must hand in
 * pre-redacted text (report a token's SOURCE, never its value).
 */

/**
 * `manual` means the CLI did not run the step and the row's notes hold the argv for a human; it never
 * counts as a failure, because nothing failed.
 */
export type RunStatus = 'ok' | 'changed' | 'skipped' | 'manual' | 'warn' | 'fail'

export interface RunRow {
  name: string
  status: RunStatus
  message: string
  /** Hanging lines under the row, printed verbatim and NEVER wrapped: they carry argv a human copies. */
  notes?: string[]
}

export interface RunSection {
  label: string
  rows: RunRow[]
}

export interface RunReport {
  title: string
  sections: readonly RunSection[]
  /** Appended to the totals line, dimmed, only when there is something to say. */
  hints?: readonly string[]
  /** The line printed when no section holds a row. */
  emptyMessage?: string
}

export interface RunReportOptions {
  /** Emit ANSI colour. When false the output contains zero escape bytes. */
  color?: boolean
  /** Use symbol glyphs. When false, two-character ASCII markers are used instead. */
  unicode?: boolean
  /** Terminal width to wrap long messages against. */
  width?: number
}

/**
 * Every character that differs between unicode and ASCII mode, in ONE table. Each variant's status
 * markers are equal-width, and `separator` is a single column in both — which is what makes a section
 * header's measured width independent of the glyph mode.
 *
 * SCOPE: this governs the report's own chrome (markers, separator, rule). It does NOT sanitise row
 * MESSAGES, which already contain non-ASCII punctuation (em-dashes, curly quotes). `--ascii` therefore
 * means "don't require box-drawing/symbol glyphs", not "emit pure ASCII".
 */
export const RUN_REPORT_GLYPHS = {
  unicode: { ok: '✓', changed: '+', skipped: '-', manual: '>', warn: '!', fail: '✗', separator: '·', rule: '─' },
  ascii: { ok: 'ok', changed: '++', skipped: '--', manual: '>>', warn: '!?', fail: '!!', separator: '-', rule: '-' },
} as const

type Glyphs = (typeof RUN_REPORT_GLYPHS)[keyof typeof RUN_REPORT_GLYPHS]

/**
 * Only these two statuses are the lines a report exists for. Painting a skip or a manual step the same
 * way would turn every intentionally-not-run row into an alarm.
 */
const LOUD_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['warn', 'fail'])

/**
 * Never wrap a message into a column narrower than this, however small the terminal claims to be.
 *
 * This is a readability floor, NOT a fit guarantee: the message column starts after the widest row
 * name in the WHOLE report, so on a genuinely narrow terminal a row can still exceed `width`. Wrapping
 * messages into a 4-column ribbon would be worse than overflowing, and the alternative — truncating —
 * is ruled out because these messages carry the commands the user has to copy.
 */
const MIN_MESSAGE_WIDTH = 24

const INDENT = '  '
const ROW_INDENT = '    '

/**
 * Greedy word wrap. Words longer than `width` (a URL, a long `node …/cli.js …` command) are emitted
 * whole on their own line rather than being broken — a command split mid-token is not runnable.
 */
const wrapText = (text: string, width: number): string[] => {
  const words = text.split(/\s+/).filter((word) => {
    return word.length > 0
  })
  const lines: string[] = []
  let current = ''

  for (const word of words) {
    if (current.length === 0) current = word
    else if (`${current} ${word}`.length <= width) current = `${current} ${word}`
    else {
      lines.push(current)
      current = word
    }
  }
  if (current.length > 0) lines.push(current)

  return lines.length > 0 ? lines : ['']
}

type Tally = Record<RunStatus, number>

const tally = (rows: readonly RunRow[]): Tally => {
  const counts: Tally = { ok: 0, changed: 0, skipped: 0, manual: 0, warn: 0, fail: 0 }

  for (const row of rows) counts[row.status] += 1

  return counts
}

type Paint = (text: string) => string

interface Palette extends Record<RunStatus, Paint> {
  header: Paint
  dim: Paint
  bold: Paint
}

/**
 * A palette seeded from an EXPLICIT colour decision rather than chalk's global auto-detection.
 * That default keys on `process.stdout`, but this report is written to `process.stderr` — so relying
 * on it would strip colour from `doctor | cat` (stdout piped, stderr still a terminal) and write raw
 * ANSI into `doctor 2>report.txt`. Both backwards.
 */
const createPalette = (color: boolean): Palette => {
  const chalk = new Chalk({ level: color ? 1 : 0 })

  return {
    header: (text) => {
      return chalk.bold.cyan(text)
    },
    ok: (text) => {
      return chalk.green(text)
    },
    changed: (text) => {
      return chalk.green(text)
    },
    skipped: (text) => {
      return chalk.gray(text)
    },
    manual: (text) => {
      return chalk.cyan(text)
    },
    fail: (text) => {
      return chalk.red(text)
    },
    warn: (text) => {
      return chalk.yellow(text)
    },
    dim: (text) => {
      return chalk.dim(text)
    },
    bold: (text) => {
      return chalk.bold(text)
    },
  }
}

interface CountPart {
  status: RunStatus
  plain: string
}

/**
 * The non-zero counts after the ratio, in a FIXED order shared by the rollup and the totals line. Only
 * the wording differs between the two (`2 warnings` in a header, `2 warned` in the totals).
 */
const countParts = (counts: Tally, warnWord: (count: number) => string): CountPart[] => {
  const parts: CountPart[] = [
    { status: 'changed', plain: `${counts.changed} changed` },
    { status: 'skipped', plain: `${counts.skipped} skipped` },
    { status: 'manual', plain: `${counts.manual} to run yourself` },
    { status: 'fail', plain: `${counts.fail} failed` },
    { status: 'warn', plain: `${counts.warn} ${warnWord(counts.warn)}` },
  ]

  return parts.filter((part) => {
    return counts[part.status] > 0
  })
}

/**
 * `7/7 ok` / `4/5 · 1 failed` / `4/5 · 1 warning` — a section's verdict at a glance. A `changed` row
 * counts toward the ratio because it ran and succeeded; `skipped` and `manual` do not, because nothing
 * was verified.
 *
 * Returns the VISIBLE width alongside the (coloured) text. The caller needs that width to right-align
 * the rollup and cannot recover it from the string, because colour has already been baked in. An
 * earlier version reconstructed a plain stand-in template instead and got it wrong in both directions
 * — all-pass headers stopped 6 columns short, and failing headers overshot by 2 and WRAPPED, which
 * mangled the one line the grouping exists to make obvious. Never measure a coloured string.
 */
const formatRollup = (
  counts: Tally,
  total: number,
  palette: Palette,
  glyphs: Glyphs,
): { text: string; plainWidth: number } => {
  if (counts.ok === total) {
    const plain = `${total}/${total} ok`

    return { text: palette.ok(plain), plainWidth: plain.length }
  }

  const ratio = `${counts.ok + counts.changed}/${total}`
  const parts = countParts(counts, (count) => {
    return `warning${count === 1 ? '' : 's'}`
  })
  const text = [
    palette.dim(ratio),
    ...parts.map((part) => {
      return palette[part.status](part.plain)
    }),
  ].join(` ${glyphs.separator} `)
  // Each joined part costs the space, the single-column separator, and the space.
  const plainWidth = parts.reduce((width, part) => {
    return width + part.plain.length + 3
  }, ratio.length)

  return { text, plainWidth }
}

/**
 * A section heading with its rollup pushed to the right margin (or one space away, when the label and
 * rollup together already fill the line). The gap is computed entirely from VISIBLE widths, so the
 * rendered header is exactly `width` columns and never wraps.
 */
const formatSectionHeader = (section: RunSection, palette: Palette, glyphs: Glyphs, width: number): string => {
  const rollup = formatRollup(tally(section.rows), section.rows.length, palette, glyphs)
  const gap = Math.max(1, width - INDENT.length - section.label.length - rollup.plainWidth)

  return `${INDENT}${palette.header(section.label)}${' '.repeat(gap)}${rollup.text}`
}

/**
 * One row, as one or more lines: `    ✓ name    message`, with any wrapped continuation and every note
 * hanging-indented to the message column so the two-column shape survives a long message.
 *
 * Colour is applied AFTER padding, never before: `padEnd` counts ANSI escape bytes as visible
 * characters, so colouring the glyph or name first would silently skew every column on the coloured
 * (i.e. the primary, interactive) path — the one a strip-and-assert test cannot see.
 */
const formatRow = (row: RunRow, nameWidth: number, palette: Palette, glyphs: Glyphs, width: number): string[] => {
  const loud = LOUD_STATUSES.has(row.status)
  // Each glyph set is internally equal-width (`✓`/`✗`/`!` = 1, `ok`/`!!`/`!?` = 2), so the marker needs
  // no padding — but the column arithmetic below still has to account for its width.
  const glyphWidth = glyphs.ok.length
  const plainName = row.name.padEnd(nameWidth)
  const colour = palette[row.status]
  const name = loud ? colour(plainName) : plainName
  const messageColumn = ROW_INDENT.length + glyphWidth + 1 + nameWidth + 2
  const messageWidth = Math.max(MIN_MESSAGE_WIDTH, width - messageColumn)
  const [first, ...rest] = wrapText(row.message, messageWidth)
  const hanging = ' '.repeat(messageColumn)
  const paint = (text: string): string => {
    return loud ? text : palette.dim(text)
  }
  // `trimEnd` so a row with an empty message (or an empty note) leaves no trailing whitespace.
  const head = `${ROW_INDENT}${colour(glyphs[row.status])} ${name}  ${paint(first ?? '')}`.trimEnd()

  return [
    head,
    ...rest.map((line) => {
      return `${hanging}${paint(line)}`
    }),
    ...(row.notes ?? []).map((note) => {
      return `${hanging}${note}`.trimEnd()
    }),
  ]
}

/** The closing rule + totals, with any hints trailing on the totals line. */
const formatSummary = (
  report: RunReport,
  rows: readonly RunRow[],
  palette: Palette,
  glyphs: Glyphs,
  width: number,
): string[] => {
  const counts = tally(rows)
  const rule = glyphs.rule.repeat(Math.max(12, Math.min(width - INDENT.length, 56)))
  const parts = countParts(counts, () => {
    return 'warned'
  })
  const totals = [
    palette.ok(`${counts.ok} passed`),
    ...parts.map((part) => {
      return palette[part.status](part.plain)
    }),
  ].join(` ${glyphs.separator} `)
  const hints = (report.hints ?? []).map((hint) => {
    return `  ${palette.dim(hint)}`
  })

  return [`${INDENT}${palette.dim(rule)}`, `${INDENT}${totals}${hints.join('')}`]
}

/**
 * Render the whole report. Pure: same input, same lines, no I/O and no environment sniffing — every
 * capability is passed in (see {@link resolveReportCapabilities}), which is what makes the colour,
 * ASCII and narrow-width behaviours unit-testable rather than machine-dependent.
 *
 * @example
 * formatRunReport({ title: 'infra-kit setup', sections: [{ label: 'Shell', rows: [row] }] }, { color: false })
 * // => ['infra-kit setup', '', '  Shell …', '    ✓ zshrc init block  written', …]
 */
export const formatRunReport = (report: RunReport, options: RunReportOptions = {}): string[] => {
  const width = options.width ?? 80
  const palette = createPalette(options.color ?? false)
  const glyphs = (options.unicode ?? true) ? RUN_REPORT_GLYPHS.unicode : RUN_REPORT_GLYPHS.ascii
  const sections = report.sections.filter((section) => {
    return section.rows.length > 0
  })
  const rows = sections.flatMap((section) => {
    return section.rows
  })
  const title = palette.bold(report.title)

  if (rows.length === 0) return [title, '', `${INDENT}${palette.dim(report.emptyMessage ?? 'Nothing ran.')}`]

  // ONE name column for the whole report, not one per section: the message column is the eye's
  // vertical guide down the page, and re-measuring it per section made it jump at every heading.
  const nameWidth = Math.max(
    ...rows.map((row) => {
      return row.name.length
    }),
  )
  const body = sections.flatMap((section): string[] => {
    return [
      formatSectionHeader(section, palette, glyphs, width),
      ...section.rows.flatMap((row) => {
        return formatRow(row, nameWidth, palette, glyphs, width)
      }),
      '',
    ]
  })

  return [title, '', ...body, ...formatSummary(report, rows, palette, glyphs, width)]
}

/** Values of `FORCE_COLOR` that mean "off" — `'0'` is chalk's documented disable, and `Boolean('0')` is `true`. */
const FORCE_COLOR_OFF = new Set(['', '0', 'false', 'none'])

/** The locale variables consulted for UTF-8 capability, in POSIX precedence order. */
const LOCALE_VARS = ['LC_ALL', 'LC_CTYPE', 'LANG'] as const

export interface ReportCapabilityInput {
  /** The `--ascii` flag: forces ASCII glyphs regardless of locale. */
  ascii?: boolean
  env?: NodeJS.ProcessEnv
  /** The stream the report is written to — `process.stderr`, NOT stdout. */
  stream?: { isTTY?: boolean; columns?: number }
}

/** `NO_COLOR` (any non-empty value) wins; then `FORCE_COLOR`; then whether the target stream is a TTY. */
const resolveColor = (env: NodeJS.ProcessEnv, stream: { isTTY?: boolean }): boolean => {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false

  if (env.FORCE_COLOR !== undefined) return !FORCE_COLOR_OFF.has(env.FORCE_COLOR.toLowerCase())

  return Boolean(stream.isTTY)
}

/**
 * UTF-8 unless a locale variable is SET and says otherwise. The "is set" guard is load-bearing: an
 * unset locale is the common case (launchd, CI, bare `sh`), and testing an empty string against
 * `/UTF-?8/` would force ASCII on every one of those terminals, all of which render the glyphs fine.
 */
const resolveUnicode = (env: NodeJS.ProcessEnv, ascii: boolean): boolean => {
  if (ascii) return false

  const locale = LOCALE_VARS.map((name) => {
    return env[name]
  }).find((value) => {
    return value !== undefined && value !== ''
  })

  return locale === undefined ? true : /UTF-?8/i.test(locale)
}

/**
 * Resolve colour / unicode / width from the environment and the TARGET stream. Split out from
 * {@link formatRunReport} so the formatter stays pure and these three rules stay testable without
 * mutating `process.env`.
 *
 * @example
 * resolveReportCapabilities({ env: { NO_COLOR: '1' }, stream: { isTTY: true, columns: 120 } })
 * // => { color: false, unicode: true, width: 120 }
 */
export const resolveReportCapabilities = (input: ReportCapabilityInput = {}): Required<RunReportOptions> => {
  const env = input.env ?? process.env
  const stream = input.stream ?? process.stderr

  return {
    color: resolveColor(env, stream),
    unicode: resolveUnicode(env, input.ascii ?? false),
    width: stream.columns ?? 80,
  }
}

export interface PrintRunReportDeps extends ReportCapabilityInput {
  /** Where the report goes. Defaults to a single `process.stderr.write`. */
  write?: (text: string) => void
}

/**
 * Write the report to stderr — humans on stderr, machines on stdout, which is what keeps
 * `--json | jq` clean.
 *
 * ONE write, deliberately: pino also targets fd 2, and emitting 30 separate writes would let any
 * concurrent `logger.*` call tear a line straight through the middle of the report.
 */
export const printRunReport = (report: RunReport, deps: PrintRunReportDeps = {}): void => {
  const write =
    deps.write ??
    ((text: string): void => {
      process.stderr.write(text)
    })

  write(`${formatRunReport(report, resolveReportCapabilities(deps)).join('\n')}\n`)
}
