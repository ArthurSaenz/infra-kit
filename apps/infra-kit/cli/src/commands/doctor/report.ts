import { Chalk } from 'chalk'
import process from 'node:process'

import { DEFAULT_DEV_PROXY_PORT } from 'src/lib/infra-kit-config'

import type { CheckResult } from './doctor'

/**
 * Presentation layer for `infra-kit doctor`. Everything here is PURE: it takes the already-computed
 * `CheckResult[]` and returns lines. It never probes, never writes, and never reorders its input.
 *
 * Why this is not the logger: doctor emits ~24 checks, and pino-pretty rendered every one as an
 * identical `INFO:` line — so a single FAIL was invisible in a wall of PASS. This module groups the
 * checks into labelled sections with per-section rollups and a summary, which is the whole point.
 *
 * Why this is not Ink: this is a ONE-SHOT report, not a live region. Ink writes `ESC[3J` (erase saved
 * lines) whenever a frame overflows the viewport, which wipes the user's terminal SCROLLBACK — the
 * hazard `src/tui/safe-stderr.ts` exists to contain for the dev-ui. A report that is routinely taller
 * than the viewport is exactly the shape that triggers it, for no benefit a string[] does not already
 * give us.
 *
 * REDACTION INVARIANT — read before adding a check message: these lines are written straight to
 * stderr, which BYPASSES pino's `REDACT_PATHS` backstop (see `lib/logger`). Every doctor message is
 * pre-redacted by construction (`describeEntries` reports a token's SOURCE, never its value;
 * `checkEnvTokenValid` never interpolates the token). Any new check message must hold to that.
 */

/** A named group of checks, in the order they are printed. */
export interface DoctorSection {
  label: string
  checks: CheckResult[]
}

const SECTION_TOOLS = 'Tools & CLIs'
const SECTION_SHELL = 'Shell & integration'
const SECTION_CONFIG = 'Project config'
const SECTION_TOKENS = 'Doppler env tokens'
const SECTION_PROXY = 'Dev proxy (portless)'

/**
 * The `portless serving TLS on :443` check builds its name by interpolating the proxy port, so this
 * key is derived from the SAME constant. A frozen `':443'` literal would silently drop the check into
 * `Other` the day that port changes.
 */
const PORTLESS_SERVING_NAME = `portless serving TLS on :${DEFAULT_DEV_PROXY_PORT}`

/**
 * Which section each check belongs to, in print order. Keyed by check `name` rather than carried as a
 * `category` field on `CheckResult` so the 24 check functions (and their tests) stay untouched — the
 * grouping knowledge lives in exactly one place instead of being smeared across `doctor.ts`.
 *
 * A name that is missing here is NOT dropped: it falls into `Other` at runtime (see {@link groupChecks}).
 * The drift is caught by tests instead — `report.test.ts` asserts every name in
 * {@link DOCTOR_CHECK_NAMES} maps to a non-`Other` section, and that the inventory itself still equals
 * what a real `doctor()` run produces.
 */
const SECTION_MEMBERS: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    SECTION_TOOLS,
    [
      'gh installed',
      'gh authenticated',
      'doppler installed',
      'aws installed',
      'rtk installed',
      'typescript-language-server installed',
      'cmux installed',
      'ide installed',
    ],
  ],
  [
    SECTION_SHELL,
    ['rtk configured', 'zshrc init block', 'warm cache', 'pnpm enableGlobalVirtualStore', 'CLAUDE.md block'],
  ],
  [SECTION_CONFIG, ['infra-kit config valid', 'user override path', 'legacy user-global config']],
  [SECTION_TOKENS, ['env tokens configured', 'env token valid', 'tokens.json perms']],
  [
    SECTION_PROXY,
    ['portless installed', PORTLESS_SERVING_NAME, 'portless CA chain valid', 'portless CA trusted', 'portless routes'],
  ],
]

/** The bucket for any check name not in {@link SECTION_MEMBERS} — a safety net, never a destination. */
export const OTHER_SECTION = 'Other'

/** The section order used for printing. */
const SECTION_ORDER: readonly string[] = SECTION_MEMBERS.map(([label]) => {
  return label
})

/** name → section label. */
const SECTION_BY_NAME = new Map<string, string>(
  SECTION_MEMBERS.flatMap(([label, names]) => {
    return names.map((name): [string, string] => {
      return [name, label]
    })
  }),
)

/**
 * Every check name `doctor()` can produce. This is the inventory the coverage test asserts the section
 * map covers, and that a deterministic `doctor()` run is reconciled against — so a new check that
 * updates neither this list nor {@link SECTION_MEMBERS} fails CI instead of quietly landing in `Other`.
 */
export const DOCTOR_CHECK_NAMES: readonly string[] = SECTION_MEMBERS.flatMap(([, names]) => {
  return names
})

/**
 * The checks `infra-kit doctor --fix` can actually resolve — stale portless routes
 * ({@link import('./doctor').pruneStalePortlessRoutes}) and loose token-store modes
 * ({@link import('./doctor').checkTokenStorePerms}). The summary's remediation hint is driven by this
 * set rather than by matching message text, so it cannot drift from the real `--fix` code paths.
 */
export const FIXABLE_NAMES: ReadonlySet<string> = new Set(['portless routes', 'tokens.json perms'])

/**
 * Group checks into printable sections. NON-MUTATING by contract: `structuredContent.checks` is built
 * from the same array in `doctor()`, and its order is part of that payload's compatibility surface, so
 * this must never sort or splice the input.
 *
 * Empty sections are omitted (a machine with no portless binary reports one portless check, not five),
 * and any unmapped name lands in a trailing {@link OTHER_SECTION} rather than disappearing.
 *
 * @example
 * groupChecks([{ name: 'gh installed', status: 'pass', message: '…' }])
 * // => [{ label: 'Tools & CLIs', checks: [ … ] }]
 */
export const groupChecks = (checks: readonly CheckResult[]): DoctorSection[] => {
  const buckets = new Map<string, CheckResult[]>()

  for (const check of checks) {
    const label = SECTION_BY_NAME.get(check.name) ?? OTHER_SECTION
    const bucket = buckets.get(label)

    if (bucket) bucket.push(check)
    else buckets.set(label, [check])
  }

  const ordered = [...SECTION_ORDER, OTHER_SECTION]

  return ordered.flatMap((label): DoctorSection[] => {
    const bucket = buckets.get(label)

    return bucket && bucket.length > 0 ? [{ label, checks: bucket }] : []
  })
}

export interface DoctorReportOptions {
  /** Emit ANSI colour. When false the output contains zero escape bytes. */
  color?: boolean
  /** Use `✓`/`✗` glyphs. When false, ASCII `ok`/`FAIL` markers are used instead. */
  unicode?: boolean
  /** Terminal width to wrap long messages against. */
  width?: number
}

/**
 * Every character that differs between unicode and ASCII mode, in ONE table. Each variant's `pass`
 * and `fail` are equal-width, and `separator` is a single column in both — which is what makes a
 * section header's measured width independent of the glyph mode.
 *
 * SCOPE: this governs the report's own chrome (markers, separator, rule). It does NOT sanitise check
 * MESSAGES, which come from `doctor.ts` and already contain non-ASCII punctuation (em-dashes, curly
 * quotes). `--ascii` therefore means "don't require box-drawing/symbol glyphs", not "emit pure ASCII".
 */
const GLYPHS = {
  unicode: { pass: '✓', fail: '✗', separator: '·', rule: '─' },
  ascii: { pass: 'ok', fail: '!!', separator: '-', rule: '-' },
} as const

type Glyphs = (typeof GLYPHS)[keyof typeof GLYPHS]

/**
 * Never wrap a message into a column narrower than this, however small the terminal claims to be.
 *
 * This is a readability floor, NOT a fit guarantee: the message column starts after the widest check
 * name in its section (`typescript-language-server installed` alone is 36 chars), so on a genuinely
 * narrow terminal a row can still exceed `width`. Wrapping messages into a 4-column ribbon would be
 * worse than overflowing, and the alternative — truncating — is ruled out because these messages carry
 * the commands the user has to copy.
 */
const MIN_MESSAGE_WIDTH = 24

/**
 * Greedy word wrap. Words longer than `width` (a URL, a long `node …/cli.js …` command) are emitted
 * whole on their own line rather than being broken — a fix command split mid-token is not runnable,
 * and printing these commands runnable is the entire reason doctor renders them.
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

/** Per-section pass/fail tallies. */
const tally = (checks: readonly CheckResult[]): { passed: number; failed: number } => {
  const failed = checks.filter((check) => {
    return check.status === 'fail'
  }).length

  return { passed: checks.length - failed, failed }
}

interface Palette {
  header: (text: string) => string
  pass: (text: string) => string
  fail: (text: string) => string
  dim: (text: string) => string
  bold: (text: string) => string
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
    header: (text): string => {
      return chalk.bold.cyan(text)
    },
    pass: (text): string => {
      return chalk.green(text)
    },
    fail: (text): string => {
      return chalk.red(text)
    },
    dim: (text): string => {
      return chalk.dim(text)
    },
    bold: (text): string => {
      return chalk.bold(text)
    },
  }
}

/**
 * `7/7 ok` / `4/5 · 1 failed` — a section's verdict at a glance.
 *
 * Returns the VISIBLE width alongside the (coloured) text. The caller needs that width to right-align
 * the rollup and cannot recover it from the string, because colour has already been baked in. An
 * earlier version reconstructed a plain stand-in template instead and got it wrong in both directions
 * — all-pass headers stopped 6 columns short, and failing headers overshot by 2 and WRAPPED, which
 * mangled the one line the grouping exists to make obvious. Never measure a coloured string.
 */
const formatRollup = (
  counts: { passed: number; failed: number },
  total: number,
  palette: Palette,
  glyphs: Glyphs,
): { text: string; plainWidth: number } => {
  if (counts.failed === 0) {
    const plain = `${total}/${total} ok`

    return { text: palette.pass(plain), plainWidth: plain.length }
  }

  const ratio = `${counts.passed}/${total}`
  const failed = `${counts.failed} failed`

  return {
    text: `${palette.dim(ratio)} ${glyphs.separator} ${palette.fail(failed)}`,
    // +3 = the space, the single-column separator, and the space.
    plainWidth: ratio.length + failed.length + 3,
  }
}

const INDENT = '  '
const ROW_INDENT = '    '

/**
 * A section heading with its rollup pushed to the right margin (or one space away, when the label and
 * rollup together already fill the line). The gap is computed entirely from VISIBLE widths, so the
 * rendered header is exactly `width` columns and never wraps.
 */
const formatSectionHeader = (section: DoctorSection, palette: Palette, glyphs: Glyphs, width: number): string => {
  const counts = tally(section.checks)
  const rollup = formatRollup(counts, section.checks.length, palette, glyphs)
  const gap = Math.max(1, width - INDENT.length - section.label.length - rollup.plainWidth)

  return `${INDENT}${palette.header(section.label)}${' '.repeat(gap)}${rollup.text}`
}

/**
 * One check, as one or more lines: `    ✓ name    message`, with any wrapped continuation
 * hanging-indented to the message column so the two-column shape survives a long message.
 *
 * Colour is applied AFTER padding, never before: `padEnd` counts ANSI escape bytes as visible
 * characters, so colouring the glyph or name first would silently skew every column on the coloured
 * (i.e. the primary, interactive) path — the one a strip-and-assert test cannot see.
 */
const formatCheckRow = (
  check: CheckResult,
  nameWidth: number,
  palette: Palette,
  glyphs: { pass: string; fail: string },
  width: number,
): string[] => {
  const failed = check.status === 'fail'
  // Both glyph pairs are internally equal-width (`✓`/`✗` = 1, `ok`/`!!` = 2), so the marker needs no
  // padding — but the column arithmetic below still has to account for its width.
  const glyphWidth = glyphs.pass.length
  const plainGlyph = failed ? glyphs.fail : glyphs.pass
  const plainName = check.name.padEnd(nameWidth)
  const glyph = failed ? palette.fail(plainGlyph) : palette.pass(plainGlyph)
  const name = failed ? palette.fail(plainName) : plainName
  const messageColumn = ROW_INDENT.length + glyphWidth + 1 + nameWidth + 2
  const messageWidth = Math.max(MIN_MESSAGE_WIDTH, width - messageColumn)
  const [first, ...rest] = wrapText(check.message, messageWidth)
  const paint = (text: string): string => {
    return failed ? text : palette.dim(text)
  }
  // `trimEnd` so a check with an empty message does not leave trailing whitespace on the line.
  const head = `${ROW_INDENT}${glyph} ${name}  ${paint(first ?? '')}`.trimEnd()

  return [
    head,
    ...rest.map((line) => {
      return `${' '.repeat(messageColumn)}${paint(line)}`
    }),
  ]
}

/** The closing rule + totals, plus a `--fix` hint only when a FAILING check is actually fixable. */
const formatSummary = (checks: readonly CheckResult[], palette: Palette, glyphs: Glyphs, width: number): string[] => {
  const counts = tally(checks)
  const rule = glyphs.rule.repeat(Math.max(12, Math.min(width - INDENT.length, 56)))
  const fixable = checks.filter((check) => {
    return check.status === 'fail' && FIXABLE_NAMES.has(check.name)
  }).length
  const passed = palette.pass(`${counts.passed} passed`)
  const failed = palette.fail(`${counts.failed} failed`)
  const totals = counts.failed === 0 ? passed : `${passed} ${glyphs.separator} ${failed}`
  const hintText = palette.dim(`${fixable} fixable — run \`infra-kit doctor --fix\``)
  const hint = fixable > 0 ? `  ${hintText}` : ''

  return [`${INDENT}${palette.dim(rule)}`, `${INDENT}${totals}${hint}`]
}

/**
 * Render the whole report. Pure: same input, same lines, no I/O and no environment sniffing — every
 * capability is passed in (see {@link resolveReportCapabilities}), which is what makes the colour,
 * ASCII and narrow-width behaviours unit-testable rather than machine-dependent.
 *
 * @example
 * formatDoctorReport([{ name: 'gh installed', status: 'pass', message: 'installed' }], { color: false })
 * // => ['infra-kit doctor', '', '  Tools & CLIs …', '    ✓ gh installed  installed', …]
 */
export const formatDoctorReport = (checks: readonly CheckResult[], options: DoctorReportOptions = {}): string[] => {
  const color = options.color ?? false
  const unicode = options.unicode ?? true
  const width = options.width ?? 80
  const palette = createPalette(color)
  const glyphs = unicode ? GLYPHS.unicode : GLYPHS.ascii

  if (checks.length === 0) return [palette.bold('infra-kit doctor'), '', `${INDENT}${palette.dim('No checks ran.')}`]

  const sections = groupChecks(checks).flatMap((section): string[] => {
    const nameWidth = Math.max(
      ...section.checks.map((check) => {
        return check.name.length
      }),
    )

    return [
      formatSectionHeader(section, palette, glyphs, width),
      ...section.checks.flatMap((check) => {
        return formatCheckRow(check, nameWidth, palette, glyphs, width)
      }),
      '',
    ]
  })

  return [palette.bold('infra-kit doctor'), '', ...sections, ...formatSummary(checks, palette, glyphs, width)]
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
 * {@link formatDoctorReport} so the formatter stays pure and these three rules stay testable without
 * mutating `process.env`.
 *
 * @example
 * resolveReportCapabilities({ env: { NO_COLOR: '1' }, stream: { isTTY: true, columns: 120 } })
 * // => { color: false, unicode: true, width: 120 }
 */
export const resolveReportCapabilities = (input: ReportCapabilityInput = {}): Required<DoctorReportOptions> => {
  const env = input.env ?? process.env
  const stream = input.stream ?? process.stderr

  return {
    color: resolveColor(env, stream),
    unicode: resolveUnicode(env, input.ascii ?? false),
    width: stream.columns ?? 80,
  }
}

export interface PrintDoctorReportDeps extends ReportCapabilityInput {
  /** Where the report goes. Defaults to a single `process.stderr.write`. */
  write?: (text: string) => void
}

/**
 * Write the report to stderr — humans on stderr, machines on stdout, which is what keeps
 * `doctor --json | jq` and the MCP stdio transport clean.
 *
 * ONE write, deliberately: pino also targets fd 2, and emitting 30 separate writes would let any
 * concurrent `logger.*` call tear a line straight through the middle of the report.
 */
export const printDoctorReport = (checks: readonly CheckResult[], deps: PrintDoctorReportDeps = {}): void => {
  const write =
    deps.write ??
    ((text: string): void => {
      process.stderr.write(text)
    })

  write(`${formatDoctorReport(checks, resolveReportCapabilities(deps)).join('\n')}\n`)
}
