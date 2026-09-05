import { describe, expect, it } from 'vitest'

import { formatPauseHint, formatRunHeader, formatTranscriptEntry } from '../format-entry'
import type { TranscriptEntryInput } from '../format-entry'

const base = {
  equivalent: { line: 'infra-kit vendor check', reproducible: true },
  durationMs: 4200,
} as const

/** The SGR escape sequences chalk emits at level 1, spelled once so the expectations stay readable. */
const ESC = '\u001B'
const SGR = {
  bold: `${ESC}[1m`,
  boldOff: `${ESC}[22m`,
  dim: `${ESC}[2m`,
  dimOff: `${ESC}[22m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  red: `${ESC}[31m`,
  gray: `${ESC}[90m`,
  colorOff: `${ESC}[39m`,
}

// eslint-disable-next-line no-control-regex -- Matching the SGR escape byte is the entire point here.
const ANSI = /\u001B\[\d+m/gu

/** What the terminal actually SHOWS: the styled string minus every zero-width escape sequence. */
const visible = (text: string): string => {
  return text.replaceAll(ANSI, '')
}

describe('formatRunHeader', () => {
  it('echoes the command the way a shell does, before it runs', () => {
    expect(formatRunHeader('infra-kit audit')).toBe('$ infra-kit audit')
  })
})

describe('formatTranscriptEntry', () => {
  it('omits the equivalent line when the caller already echoed it as a header', () => {
    expect(formatTranscriptEntry({ ...base, outcome: 'ok', showEquivalent: false })).toBe('✓ ok · 4.2s')
  })

  it('keeps the equivalent line when the child resolved a different one (interactive flags)', () => {
    expect(
      formatTranscriptEntry({
        equivalent: { line: 'infra-kit release create --version=1.4.0', reproducible: false },
        durationMs: 4200,
        outcome: 'ok',
        showEquivalent: true,
      }),
    ).toBe('≈ infra-kit release create --version=1.4.0\n✓ ok · 4.2s')
  })

  it('renders an ok outcome', () => {
    expect(formatTranscriptEntry({ ...base, outcome: 'ok' })).toBe('$ infra-kit vendor check\n✓ ok · 4.2s')
  })

  it('renders a findings outcome with a count', () => {
    expect(formatTranscriptEntry({ ...base, outcome: 'findings', findingsCount: 3 })).toBe(
      '$ infra-kit vendor check\n⚠ 3 findings · 4.2s',
    )
  })

  it('renders a findings outcome without a count as a plain label', () => {
    expect(formatTranscriptEntry({ ...base, outcome: 'findings' })).toBe(
      '$ infra-kit vendor check\n⚠ completed with findings · 4.2s',
    )
  })

  it('renders a failed outcome', () => {
    expect(formatTranscriptEntry({ ...base, outcome: 'failed' })).toBe('$ infra-kit vendor check\n✗ failed · 4.2s')
  })

  it('renders a cancelled outcome', () => {
    expect(formatTranscriptEntry({ ...base, outcome: 'cancelled' })).toBe(
      '$ infra-kit vendor check\n⊘ cancelled · 4.2s',
    )
  })

  it('uses the ≈ prefix for a non-reproducible equivalent', () => {
    expect(
      formatTranscriptEntry({
        equivalent: { line: 'infra-kit dev --app=client', reproducible: false },
        outcome: 'ok',
        durationMs: 820,
      }),
    ).toBe('≈ infra-kit dev --app=client\n✓ ok · 820ms')
  })

  it('renders ascii glyphs when ascii is set', () => {
    expect(formatTranscriptEntry({ ...base, outcome: 'ok', ascii: true })).toBe(
      '$ infra-kit vendor check\n[ok] ok · 4.2s',
    )
  })

  it('appends the first summary line to the status line', () => {
    expect(formatTranscriptEntry({ ...base, outcome: 'ok', summary: ['2 files synced'] })).toBe(
      '$ infra-kit vendor check\n✓ ok · 4.2s · 2 files synced',
    )
  })

  it('appends the env-notice as a third line', () => {
    expect(formatTranscriptEntry({ ...base, outcome: 'ok', envNotice: true })).toBe(
      '$ infra-kit vendor check\n✓ ok · 4.2s\nApplies to your shell after you exit this session.',
    )
  })

  it('formats sub-second durations in milliseconds', () => {
    expect(formatTranscriptEntry({ ...base, durationMs: 820, outcome: 'ok' })).toContain('820ms')
  })
})

/**
 * The rule is what gives a run block a bottom edge, so it must reach the right margin — and stop one
 * cell short of it. Filling the last cell parks the cursor in deferred-wrap, and the `\n` the caller
 * appends then costs TWO rows, printing a phantom blank line under every entry.
 *
 * `✓ ok · 4.2s` is 11 columns, so at width 40 the rule is 40 - 2 - 11 = 27.
 */
describe('formatTranscriptEntry — the closing rule', () => {
  it('runs the status out to one cell short of the right margin', () => {
    const entry = formatTranscriptEntry({ ...base, outcome: 'ok', showEquivalent: false, width: 40 })

    expect(entry).toBe(`✓ ok · 4.2s ${'─'.repeat(27)}`)
    expect(entry).toHaveLength(39)
  })

  it('draws no rule at all when no width is known (a redirected stderr)', () => {
    expect(formatTranscriptEntry({ ...base, outcome: 'ok', showEquivalent: false })).toBe('✓ ok · 4.2s')
  })

  it('drops the rule rather than wrap it when the terminal is too narrow for a real one', () => {
    // 15 - 2 - 11 leaves 2 cells: a two-dash stub reads as a typo, not as an edge.
    expect(formatTranscriptEntry({ ...base, outcome: 'ok', showEquivalent: false, width: 15 })).toBe('✓ ok · 4.2s')
  })

  it('draws the shortest rule worth having at the boundary width', () => {
    expect(formatTranscriptEntry({ ...base, outcome: 'ok', showEquivalent: false, width: 16 })).toBe('✓ ok · 4.2s ───')
  })

  it('sizes the rule against the whole status, summary included', () => {
    const entry = formatTranscriptEntry({
      ...base,
      outcome: 'ok',
      showEquivalent: false,
      summary: ['2 files synced'],
      width: 40,
    })

    expect(entry).toBe(`✓ ok · 4.2s · 2 files synced ${'─'.repeat(10)}`)
    expect(entry).toHaveLength(39)
  })

  it('rules with dashes when ascii is set', () => {
    // The ascii glyph is wider than the unicode one: `[ok] ok · 4.2s` is 14 columns, so 30 - 2 - 14 = 14.
    const entry = formatTranscriptEntry({ ...base, outcome: 'ok', showEquivalent: false, ascii: true, width: 30 })

    expect(entry).toBe(`[ok] ok · 4.2s ${'-'.repeat(14)}`)
    expect(entry).toHaveLength(29)
  })

  it('leaves the equivalent line unruled — only the footer closes the block off', () => {
    const lines = formatTranscriptEntry({ ...base, outcome: 'ok', width: 40 }).split('\n')

    expect(lines[0]).toBe('$ infra-kit vendor check')
    expect(lines[1]).toBe(`✓ ok · 4.2s ${'─'.repeat(27)}`)
  })
})

/**
 * Colour is decoration, never layout. Escape codes occupy no columns, so a rule sized against the
 * STYLED string would come out ~20 cells short of the margin — that is the bug these tests exist for.
 */
describe('format-entry — colour', () => {
  it('changes nothing a terminal can measure', () => {
    const input: TranscriptEntryInput = {
      ...base,
      outcome: 'ok',
      summary: ['2 files synced'],
      width: 40,
      envNotice: true,
    }

    expect(visible(formatTranscriptEntry({ ...input, color: true }))).toBe(formatTranscriptEntry(input))
  })

  it('keeps the rule flush with the margin under colour', () => {
    const entry = formatTranscriptEntry({ ...base, outcome: 'ok', showEquivalent: false, width: 40, color: true })

    expect(visible(entry)).toHaveLength(39)
  })

  it('paints the verdict in the outcome colour and dims everything trailing it', () => {
    const entry = formatTranscriptEntry({ ...base, outcome: 'failed', showEquivalent: false, color: true })

    expect(entry).toBe(`${SGR.red}✗ failed${SGR.colorOff}${SGR.dim} · 4.2s${SGR.dimOff}`)
  })

  it('gives each outcome its own hue', () => {
    const hue = (outcome: 'ok' | 'findings' | 'failed' | 'cancelled'): string | undefined => {
      return formatTranscriptEntry({ ...base, outcome, showEquivalent: false, color: true }).match(ANSI)?.[0]
    }

    expect([hue('ok'), hue('findings'), hue('failed'), hue('cancelled')]).toStrictEqual([
      SGR.green,
      SGR.yellow,
      SGR.red,
      SGR.gray,
    ])
  })

  it('emits no escape codes at all when colour is off', () => {
    const entry = formatTranscriptEntry({ ...base, outcome: 'ok', width: 40, envNotice: true })

    expect(visible(entry)).toBe(entry)
    expect(visible(formatRunHeader('infra-kit audit'))).toBe('$ infra-kit audit')
  })

  it('dims the header prompt and bolds the command, so the command is what the eye lands on', () => {
    expect(formatRunHeader('infra-kit audit', { color: true })).toBe(
      `${SGR.dim}$${SGR.dimOff} ${SGR.bold}infra-kit audit${SGR.boldOff}`,
    )
  })

  it('keeps the coloured header exactly as copy-pasteable as the plain one', () => {
    expect(visible(formatRunHeader('infra-kit audit', { color: true }))).toBe(formatRunHeader('infra-kit audit'))
  })
})

describe('formatPauseHint', () => {
  it('renders the suspend variant', () => {
    expect(formatPauseHint({ canSuspend: true })).toBe('any key commands · Esc / Ctrl-C quit · Ctrl-Z suspend')
  })

  it('renders the plain variant when suspending is not offered', () => {
    expect(formatPauseHint({ canSuspend: false })).toBe('any key commands · Esc / Ctrl-C quit')
  })

  it('renders the suspend variant in ascii, the separator swapped for a hyphen', () => {
    expect(formatPauseHint({ canSuspend: true, ascii: true })).toBe(
      'any key commands - Esc / Ctrl-C quit - Ctrl-Z suspend',
    )
  })

  it('renders the plain variant in ascii', () => {
    expect(formatPauseHint({ canSuspend: false, ascii: true })).toBe('any key commands - Esc / Ctrl-C quit')
  })
})

/**
 * Mirrors the `screen hint widths` guard in `src/tui/screens/__tests__/hint-width.test.ts`: this
 * hint renders on a real terminal row, so a variant at or past 80 columns risks a wrap an
 * emulator never reflows back — exactly the failure that guard exists to catch one layer up.
 */
describe('formatPauseHint — column budget', () => {
  const columns = (text: string): number => {
    return [...text].length
  }

  const variants: Record<string, string> = {
    suspend: formatPauseHint({ canSuspend: true }),
    plain: formatPauseHint({ canSuspend: false }),
    suspendAscii: formatPauseHint({ canSuspend: true, ascii: true }),
    plainAscii: formatPauseHint({ canSuspend: false, ascii: true }),
  }

  for (const [name, text] of Object.entries(variants)) {
    it(`${name} fits in 80 columns`, () => {
      expect(columns(text)).toBeLessThan(80)
    })
  }
})

describe('formatPauseHint — truncation', () => {
  it('truncates to width - 1 cells, walking the array-spread cellWidth uses rather than raw .slice', () => {
    // The hint's only non-ASCII character is `·` (U+00B7): a single BMP code point that is ALSO a
    // single UTF-16 unit, so cells and UTF-16 units coincide for this exact string — a bug that
    // counted UTF-16 units instead of cells could not be caught by comparing against `.slice()`
    // here. What this pins down instead is that truncation walks `[...text]` (the same measure
    // `cellWidth` uses elsewhere in this file) to the cell just short of `width`, matching the
    // spec exactly, so the day a hint folds in an astral character the arithmetic is already right.
    const hint = formatPauseHint({ canSuspend: true })
    const width = 10

    expect(formatPauseHint({ canSuspend: true, width })).toBe([...hint].slice(0, width - 1).join(''))
    expect(formatPauseHint({ canSuspend: true, width })).toBe('any key c')
  })

  it('leaves the hint untouched at a width it already fits inside', () => {
    const hint = formatPauseHint({ canSuspend: false })

    expect(formatPauseHint({ canSuspend: false, width: 100 })).toBe(hint)
  })

  it('leaves the hint whole when width is undefined, rather than silently no-op truncating on NaN', () => {
    const hint = formatPauseHint({ canSuspend: true })

    expect(formatPauseHint({ canSuspend: true, width: undefined })).toBe(hint)
    expect(formatPauseHint({ canSuspend: true })).toBe(hint)
  })
})

describe('formatPauseHint — colour', () => {
  it('emits the dim SGR pair when color is true', () => {
    expect(formatPauseHint({ canSuspend: true, color: true })).toBe(
      `${SGR.dim}any key commands · Esc / Ctrl-C quit · Ctrl-Z suspend${SGR.dimOff}`,
    )
  })

  it('emits no escape codes when color is false (the default)', () => {
    const hint = formatPauseHint({ canSuspend: true })

    expect(visible(formatPauseHint({ canSuspend: true, color: true }))).toBe(hint)
    expect(visible(hint)).toBe(hint)
  })
})
