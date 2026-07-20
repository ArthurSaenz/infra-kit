import { afterEach, describe, expect, it, vi } from 'vitest'

import { promptDescription } from '../release-desc-edit'

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
describe('release-desc-edit description prompt', () => {
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
