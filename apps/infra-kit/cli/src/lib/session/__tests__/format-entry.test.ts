import { describe, expect, it } from 'vitest'

import { formatRunHeader, formatTranscriptEntry } from '../format-entry'

const base = {
  equivalent: { line: 'infra-kit vendor check', reproducible: true },
  durationMs: 4200,
} as const

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
