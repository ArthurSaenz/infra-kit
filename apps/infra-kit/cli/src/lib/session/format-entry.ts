/**
 * Pure formatter for one committed transcript block — the two-line summary a
 * session leaves behind in the scrollback once it finishes. Line 1 echoes the
 * replayable command (`$ ` when it reproduces exactly, `≈ ` when it would
 * re-prompt); line 2 is a status glyph + label + duration + optional summary;
 * an optional third line carries the env-scope notice. No I/O — it returns a
 * string the caller writes wherever it likes.
 */
import type { EquivalentLine } from './equivalent'
import type { SessionOutcome } from './outcome'

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

/** Status glyphs keyed by outcome, in both a unicode and an ASCII-safe variant. */
const GLYPHS: Record<SessionOutcome, { unicode: string; ascii: string }> = {
  ok: { unicode: '✓', ascii: '[ok]' },
  findings: { unicode: '⚠', ascii: '[!]' },
  failed: { unicode: '✗', ascii: '[x]' },
  cancelled: { unicode: '⊘', ascii: '[-]' },
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
}

/**
 * The line a shell prints before it runs something. The session writes this ahead of the spawn, so the
 * child's real output arrives under a heading instead of unannounced.
 *
 * @example
 * formatRunHeader('infra-kit audit') // => '$ infra-kit audit'
 */
export const formatRunHeader = (line: string): string => {
  return `${T.reproPrefix}${line}`
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
 * Render a committed transcript block from a finished session. Line 1 echoes the
 * equivalent command; line 2 is `<glyph> <label> · <duration>[ · <summary>]`; an
 * optional third dim line carries the env notice.
 *
 * @example
 * formatTranscriptEntry({
 *   equivalent: { line: 'infra-kit vendor check', reproducible: true },
 *   outcome: 'ok', durationMs: 4200,
 * })
 * // '$ infra-kit vendor check\n✓ ok · 4.2s'
 */
export const formatTranscriptEntry = (input: TranscriptEntryInput): string => {
  const prefix = input.equivalent.reproducible ? T.reproPrefix : T.nonReproPrefix
  const glyph = input.ascii === true ? GLYPHS[input.outcome].ascii : GLYPHS[input.outcome].unicode
  const label = labelFor(input.outcome, input.findingsCount)

  const statusParts = [label, formatDuration(input.durationMs)]
  const firstSummary = input.summary?.[0]

  if (firstSummary != null && firstSummary.length > 0) statusParts.push(firstSummary)

  const lines = [`${glyph} ${statusParts.join(T.sep)}`]

  if (input.showEquivalent !== false) lines.unshift(`${prefix}${input.equivalent.line}`)

  if (input.envNotice === true) lines.push(T.envNotice)

  return lines.join('\n')
}
