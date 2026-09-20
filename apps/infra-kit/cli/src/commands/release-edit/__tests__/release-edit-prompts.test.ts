import { afterEach, describe, expect, it, vi } from 'vitest'

import { promptDescription, promptReleaseDate } from '../release-edit'

vi.mock('@inquirer/input', () => {
  return { default: vi.fn() }
})

const input = vi.mocked((await import('@inquirer/input')).default)

afterEach(() => {
  vi.clearAllMocks()
})

/**
 * This prompt was a zx `question` whose answer was normalised with `answer.replace(/\n$/, '')` —
 * strip one trailing newline, nothing else. So whitespace-only input was NON-empty and overwrote
 * the description with blanks. The rewrite trims instead, which is a deliberate behaviour change:
 * whitespace-only now means keep-current.
 *
 * Pinned here rather than left to `@inquirer/input`'s own normalisation, so the semantics survive a
 * minor bump of that package whichever way its default goes.
 */
describe('release-edit description prompt', () => {
  it('keeps the current description when the answer is empty', async () => {
    input.mockResolvedValue('')

    expect(await promptDescription('current text')).toBe('current text')
  })

  it('keeps the current description when the answer is whitespace only', async () => {
    input.mockResolvedValue('   ')

    expect(await promptDescription('current text')).toBe('current text')
  })

  it('replaces the description with a trimmed answer', async () => {
    input.mockResolvedValue('  new text  ')

    expect(await promptDescription('current text')).toBe('new text')
  })

  it('renders a single-line message', async () => {
    input.mockResolvedValue('x')

    await promptDescription('current text')

    // An embedded newline makes inquirer miscount the ANSI erase-lines it emits on every keystroke
    // re-render, leaving orphaned prompt fragments on screen. zx wrote the message raw and did not
    // care; inquirer does.
    expect(String(input.mock.calls[0]?.[0]?.message)).not.toContain('\n')
  })
})

/**
 * The date prompt validates inline (`validate` returns the validator's message, so inquirer re-asks
 * instead of the handler failing later) and Enter keeps the current date — clearing is `--release-date ""`
 * only, so an empty answer is never ambiguous.
 */
describe('release-edit release date prompt', () => {
  const validateOf = () => {
    const config = input.mock.calls[0]?.[0] as { validate?: (raw: string) => string | boolean } | undefined

    return config?.validate
  }

  it('keeps the current date on Enter', async () => {
    input.mockResolvedValue('')

    expect(await promptReleaseDate('2026-10-28')).toBe('2026-10-28')
    expect(validateOf()?.('')).toBe(true)
  })

  it('keeps a null date on Enter', async () => {
    input.mockResolvedValue('')

    expect(await promptReleaseDate(null)).toBeNull()
  })

  it('accepts a valid date, trimmed', async () => {
    input.mockResolvedValue(' 2026-11-03 ')

    expect(await promptReleaseDate('2026-10-28')).toBe('2026-11-03')
    expect(validateOf()?.('2026-11-03')).toBe(true)
  })

  it('re-asks on an invalid date: validate returns the validator message', async () => {
    input.mockResolvedValue('2026-11-03')

    await promptReleaseDate(null)

    expect(validateOf()?.('2026-02-30')).toBe('Release date "2026-02-30" is not a calendar date in yyyy-mm-dd form.')
    expect(validateOf()?.('next tuesday')).toMatch(/not a calendar date/)
  })

  it('renders a single-line message', async () => {
    input.mockResolvedValue('')

    await promptReleaseDate('2026-10-28')

    expect(String(input.mock.calls[0]?.[0]?.message)).not.toContain('\n')
  })
})
