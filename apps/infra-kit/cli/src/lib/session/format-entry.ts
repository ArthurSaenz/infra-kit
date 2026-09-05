/**
 * @fileoverview
 * Pure formatters for the lines the session shell itself owns — everything
 * that frames a run without ever touching the child's own output.
 *
 * The bulk of this file is the two-line transcript block a session leaves
 * behind in the scrollback once a command finishes. Line 1 echoes the
 * replayable command (`$ ` when it reproduces exactly, `≈ ` when it would
 * re-prompt); line 2 is a status glyph + label + duration + optional summary,
 * optionally run out to a rule that closes the block off; an optional third
 * line carries the env-scope notice. No I/O — it returns a string the caller
 * writes wherever it likes.
 *
 * The block is framed from the OUTSIDE only. The command runs as a child with
 * `stdio: 'inherit'`, writing straight to the terminal, so nothing here can
 * touch its output — no left gutter, no indent, no box. The header above and
 * the status rule below are the only lines we own, which is why the rule hangs
 * off the footer: it is the one place we can draw a hard edge between one run
 * and the next.
 *
 * The other formatter here, {@link formatPauseHint}, owns a different line —
 * the dim hint the post-run pause writes into the blank row the footer's
 * trailing newline just opened. It shares this file for the same reason the
 * footer's rule does: both are lines the session shell draws around a child
 * it never touches, using the same `chromeStyler`/`cellWidth` machinery.
 */
import { Chalk } from 'chalk'

import type { EquivalentLine } from './equivalent'
import type { SessionOutcome } from './outcome'

/**
 * Level 1 (basic 16 colours) FORCED, so the formatter stays pure: what it emits depends on its own
 * `color` argument, never on the ambient TTY. Callers decide — `runSession` derives the flag from the
 * default chalk instance, which is the thing that honours `NO_COLOR`/`FORCE_COLOR`/TTY detection. Tests
 * can therefore assert real escape codes without faking a terminal.
 */
const ansi = new Chalk({ level: 1 })

/** All literal, user-facing copy for the transcript entry. */
const T = {
  ok: 'ok',
  findingsPlain: 'completed with findings',
  failed: 'failed',
  cancelled: 'cancelled',
  findingsSuffix: 'findings',
  sep: ' · ',
  reproPrefix: '$ ',
  nonReproPrefix: '≈ ',
  envNotice: 'Applies to your shell after you exit this session.',
}

/**
 * Copy for the post-run pause hint — deliberately NOT part of {@link T}, whose doc scopes it to "the
 * transcript entry" (see the block above): the pause hint is a different line, written after the
 * footer rather than as part of it, so it gets its own module-scope const.
 *
 * The `suspend` variant is offered only where suspending is actually possible (win32 has no
 * `SIGSTOP`); the `ascii` variant swaps the middle-dot separator for a hyphen, same words.
 */
const PAUSE_HINT: Record<'suspend' | 'plain', { unicode: string; ascii: string }> = {
  suspend: {
    unicode: 'any key commands · Esc / Ctrl-C quit · Ctrl-Z suspend',
    ascii: 'any key commands - Esc / Ctrl-C quit - Ctrl-Z suspend',
  },
  plain: {
    unicode: 'any key commands · Esc / Ctrl-C quit',
    ascii: 'any key commands - Esc / Ctrl-C quit',
  },
}

/** Status glyphs keyed by outcome, in both a unicode and an ASCII-safe variant. */
const GLYPHS: Record<SessionOutcome, { unicode: string; ascii: string }> = {
  ok: { unicode: '✓', ascii: '[ok]' },
  findings: { unicode: '⚠', ascii: '[!]' },
  failed: { unicode: '✗', ascii: '[x]' },
  cancelled: { unicode: '⊘', ascii: '[-]' },
}

/** The rule character that runs the footer out to the right margin. */
const RULE = { unicode: '─', ascii: '-' }

/**
 * Shortest rule worth drawing. Below this the footer is left bare: a two-dash stub next to a status
 * reads as a typo, not as an edge, and on a narrow terminal the wrap it risks is worse than no rule.
 */
const MIN_RULE_WIDTH = 3

/** Identity styler — the no-colour branch, so the two paths differ only in the escape codes. */
const plain = (text: string): string => {
  return text
}

/** The outcome's own colour: the one hue in the block, so the eye lands on the verdict first. */
const OUTCOME_COLOR: Record<SessionOutcome, (text: string) => string> = {
  ok: (text) => {
    return ansi.green(text)
  },
  findings: (text) => {
    return ansi.yellow(text)
  },
  failed: (text) => {
    return ansi.red(text)
  },
  cancelled: (text) => {
    return ansi.gray(text)
  },
}

/**
 * The block's chrome — the `$`/`≈` prompt, the command, the rule, the env notice. Carries no outcome,
 * which is why it is split from {@link outcomeStyler}: the header has no verdict to colour.
 */
const chromeStyler = (color: boolean): { dim: (text: string) => string; bold: (text: string) => string } => {
  if (!color) return { dim: plain, bold: plain }

  return {
    dim: (text: string) => {
      return ansi.dim(text)
    },
    bold: (text: string) => {
      return ansi.bold(text)
    },
  }
}

/** The verdict's hue: the one saturated colour in the block, so the eye lands on the outcome first. */
const outcomeStyler = (color: boolean, outcome: SessionOutcome): ((text: string) => string) => {
  return color ? OUTCOME_COLOR[outcome] : plain
}

/**
 * Width in terminal cells. `String.length` counts UTF-16 code units, so an astral character — any emoji
 * a command folds into its summary — counts as TWO, and the rule comes out a cell short for each one.
 *
 * Deliberately not a complete solution: a CJK or ZWJ-composed summary still mismeasures, since those
 * need a real grapheme + east-asian-width table. Acceptable because the worst case is cosmetic (a rule
 * that wraps or stops short, never a corrupted line) and no command supplies a summary today.
 */
const cellWidth = (text: string): number => {
  return [...text].length
}

/**
 * Truncate `text` to `width - 1` cells, or return it untouched when `width` is `undefined`.
 *
 * The `undefined` case is its own branch rather than falling out of the arithmetic, mirroring
 * {@link ruleSuffix}'s `width == null` guard at the top of this file. `columns()` is
 * `() => number | undefined`, and callers normalise a missing or zero terminal width to
 * `undefined` — so `undefined - 1` is `NaN`, and every comparison against `NaN` is `false`. A
 * naive `cellWidth(text) > width - 1` would therefore silently never truncate, which reads as
 * "it works" right up until a real narrow terminal proves it doesn't.
 */
const truncateToWidth = (text: string, width: number | undefined): string => {
  if (width == null) return text

  const limit = Math.max(0, width - 1)

  if (cellWidth(text) <= limit) return text

  return [...text].slice(0, limit).join('')
}

/** Everything {@link formatPauseHint} needs to render the post-run pause's hint line. */
export interface PauseHintInput {
  /** Whether `Ctrl-Z suspend` is offered (platform-dependent: no `SIGSTOP` on win32). */
  canSuspend: boolean
  /** Use ASCII glyphs instead of unicode (for `!isTTY` / `TERM=dumb`). */
  ascii?: boolean
  /** Emit ANSI colour (default `false`). The caller owns TTY/`NO_COLOR` detection. */
  color?: boolean
  /** Terminal width in columns; the hint truncates to one cell short of it. `undefined` leaves it whole. */
  width?: number
}

/**
 * The dim hint the post-run pause writes into the blank row the footer's trailing newline just
 * opened: "any key commands", plus the ways out, plus `Ctrl-Z suspend` where suspending is
 * possible. No I/O and no trailing newline — the caller decides where it lands and how it is
 * erased (`\r\x1b[2K`, before anything else draws).
 *
 * @example
 * formatPauseHint({ canSuspend: true }) // => 'any key commands · Esc / Ctrl-C quit · Ctrl-Z suspend'
 */
export const formatPauseHint = (input: PauseHintInput): string => {
  const dim = chromeStyler(input.color === true).dim
  const variant = PAUSE_HINT[input.canSuspend ? 'suspend' : 'plain']
  const text = input.ascii === true ? variant.ascii : variant.unicode

  return dim(truncateToWidth(text, input.width))
}

/** Everything the formatter needs to render one transcript block. */
export interface TranscriptEntryInput {
  /** The replayable command line + whether it reproduces the selection. */
  equivalent: EquivalentLine
  /** Terminal state of the session. */
  outcome: SessionOutcome
  /** Wall-clock duration in milliseconds. */
  durationMs: number
  /** Optional short summary lines; the first is appended to the status line. */
  summary?: string[]
  /** Finding count, used to label a `findings` outcome as `${n} findings`. */
  findingsCount?: number
  /** Append the "applies to your shell after you exit" env notice as a third line. */
  envNotice?: boolean
  /** Use ASCII glyphs instead of unicode (for `!isTTY` / `TERM=dumb`). */
  ascii?: boolean
  /**
   * Render the `$ …` / `≈ …` equivalent line (default `true`). The session shell echoes the command
   * BEFORE it runs — like any shell — so when the child reports back the same line, repeating it under
   * the output would be noise. The caller decides: it is the only party that knows what it echoed.
   */
  showEquivalent?: boolean
  /** Emit ANSI colour (default `false`). The caller owns TTY/`NO_COLOR` detection. */
  color?: boolean
  /**
   * Terminal width in columns. When given, the status line is run out to a rule that closes the block;
   * omit it (or pass a width too narrow for {@link MIN_RULE_WIDTH}) to leave the footer bare.
   */
  width?: number
}

/**
 * The line a shell prints before it runs something. The session writes this ahead of the spawn, so the
 * child's real output arrives under a heading instead of unannounced.
 *
 * Deliberately NOT ruled or boxed, unlike the footer: this line gets copied out of the scrollback and
 * re-run, so it stays exactly what a user would type. Emphasis is carried by weight, not by decoration.
 *
 * @example
 * formatRunHeader('infra-kit audit') // => '$ infra-kit audit'
 */
export const formatRunHeader = (line: string, opts: { color?: boolean } = {}): string => {
  const chrome = chromeStyler(opts.color === true)

  return `${chrome.dim(T.reproPrefix.trim())} ${chrome.bold(line)}`
}

/** Format a duration compactly: sub-second as `820ms`, otherwise `4.2s`. */
const formatDuration = (durationMs: number): string => {
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`

  return `${(durationMs / 1000).toFixed(1)}s`
}

/** The human label for an outcome; `findings` folds in the count when present. */
const labelFor = (outcome: SessionOutcome, findingsCount?: number): string => {
  if (outcome === 'findings') {
    return findingsCount != null ? `${findingsCount} ${T.findingsSuffix}` : T.findingsPlain
  }

  return { ok: T.ok, failed: T.failed, cancelled: T.cancelled }[outcome]
}

/**
 * The rule that runs the status out to the right margin, giving the block a visible bottom edge — or
 * `''` when there is no room for one. `statusWidth` is the status line's width in COLUMNS, which is why
 * the caller measures the un-styled text: escape codes occupy no cells.
 *
 * The rule stops one cell short of `width`, because terminals disagree about what filling the last cell
 * means. An eagerly-wrapping one moves to the next row the moment it is written, so the `\n` the caller
 * appends costs a SECOND row — a phantom blank line under every entry. (A VT100-family terminal instead
 * defers the wrap and would be fine.) Leaving the last cell empty is correct on both, and the cost is a
 * single unused column.
 */
const ruleSuffix = (
  statusWidth: number,
  width: number | undefined,
  ruleChar: string,
  dim: (text: string) => string,
): string => {
  if (width == null) return ''

  // -1 for the last cell we leave empty, -1 for the space between the status and the rule.
  const ruleWidth = width - 2 - statusWidth

  if (ruleWidth < MIN_RULE_WIDTH) return ''

  return ` ${dim(ruleChar.repeat(ruleWidth))}`
}

/**
 * Render a committed transcript block from a finished session. Line 1 echoes the
 * equivalent command; line 2 is `<glyph> <label> · <duration>[ · <summary>]`, run
 * out to a closing rule when a `width` is given; an optional third dim line
 * carries the env notice.
 *
 * @example
 * formatTranscriptEntry({
 *   equivalent: { line: 'infra-kit vendor check', reproducible: true },
 *   outcome: 'ok', durationMs: 4200,
 * })
 * // '$ infra-kit vendor check\n✓ ok · 4.2s'
 */
export const formatTranscriptEntry = (input: TranscriptEntryInput): string => {
  const color = input.color === true
  const chrome = chromeStyler(color)
  const verdictColor = outcomeStyler(color, input.outcome)
  const ascii = input.ascii === true
  const prefix = input.equivalent.reproducible ? T.reproPrefix : T.nonReproPrefix
  const glyph = ascii ? GLYPHS[input.outcome].ascii : GLYPHS[input.outcome].unicode
  const label = labelFor(input.outcome, input.findingsCount)

  const detail = [formatDuration(input.durationMs)]
  // First LINE of the first summary: a summary with an embedded newline would otherwise blow the rule's
  // arithmetic apart — the measured width would span rows the terminal renders separately.
  const firstSummary = input.summary?.[0]?.split('\n')[0]

  if (firstSummary != null && firstSummary.length > 0) detail.push(firstSummary)

  // The verdict carries the colour; the duration and summary trail behind it, dimmed.
  const verdict = `${glyph} ${label}`
  const trailer = `${T.sep}${detail.join(T.sep)}`
  // Measured on the UNSTYLED text and styled after: escape codes occupy no columns, so a rule sized
  // against the styled string would come out ~20 cells short of the margin.
  const statusWidth = cellWidth(verdict) + cellWidth(trailer)
  const rule = ruleSuffix(statusWidth, input.width, ascii ? RULE.ascii : RULE.unicode, chrome.dim)

  const lines = [`${verdictColor(verdict)}${chrome.dim(trailer)}${rule}`]

  if (input.showEquivalent !== false) {
    lines.unshift(`${chrome.dim(prefix.trim())} ${chrome.bold(input.equivalent.line)}`)
  }

  if (input.envNotice === true) lines.push(chrome.dim(T.envNotice))

  return lines.join('\n')
}
