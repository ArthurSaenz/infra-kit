/**
 * These prompts were zx `question` calls until they started killing the process: zx's `question`
 * opens its own readline and acquires no stdin ref, so once the preceding `withEscape` released the
 * last reader — unref'ing stdin — the event loop drained MID-PROMPT and node exited with the
 * question still on screen.
 *
 * The structural sweep in `lib/prompts/__tests__/every-inquirer-site-is-escapable.test.ts` is what
 * fences that drain: it proves every `@inquirer/*` call sits inside `withEscape`, hence acquires.
 * These tests are NOT that fence. They pin the prompt SEMANTICS that the rewrite could silently
 * have changed — which the sweep says nothing about.
 */
import process from 'node:process'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { stdinReaderCount } from 'src/lib/prompts/stdin-ref'
import { parseVersion } from 'src/lib/version-utils'

import { promptForVersionInput } from '../release-create'

vi.mock('@inquirer/input', () => {
  return { default: vi.fn() }
})

const input = vi.mocked((await import('@inquirer/input')).default)

const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin')

/**
 * A TTY-shaped stdin. Non-negotiable for the ownership test below: `withEscape` early-returns
 * BEFORE `acquireStdin()` when `!process.stdin.isTTY` (escapable-context.ts), and vitest has no TTY
 * — so against the real stdin the reader count is always 0 and the assertion would be measuring the
 * early return, not the acquire.
 */
const fakeTtyStdin = () => {
  const stream = new PassThrough()

  Object.defineProperty(stream, 'ref', { value: vi.fn(), configurable: true })
  Object.defineProperty(stream, 'unref', { value: vi.fn(), configurable: true })
  Object.defineProperty(stream, 'isTTY', { value: true, configurable: true })
  Object.defineProperty(process, 'stdin', { value: stream, configurable: true })
}

afterEach(() => {
  if (realStdin) Object.defineProperty(process, 'stdin', realStdin)

  vi.clearAllMocks()
})

describe('release-create version prompt', () => {
  it('falls back to the suggestion when the answer is empty', async () => {
    input.mockResolvedValue('')

    const suggested = await promptForVersionInput([parseVersion('v1.2.3')], 'regular')

    // The suggestion is rendered into the MESSAGE as `[x.y.z]` rather than passed as inquirer's
    // `default:` — `default` prefills the editable buffer, which would change both what the user
    // sees and what an empty submit returns. Read it back from the message to pin the fallback
    // without hardcoding the bump rule.
    const message = String(input.mock.calls[0]?.[0]?.message)
    // Sliced rather than matched: a bracket-capturing regex trips sonarjs/super-linear-regex.
    const open = message.indexOf('[')
    const close = message.indexOf(']', open)
    const hinted = open === -1 || close === -1 ? undefined : message.slice(open + 1, close)

    expect(hinted).toBeTruthy()
    expect(suggested).toBe(hinted)
  })

  it('returns a typed answer verbatim and trims it', async () => {
    input.mockResolvedValue('  2.0.0  ')

    expect(await promptForVersionInput([parseVersion('v1.2.3')], 'regular')).toBe('2.0.0')
  })

  it('does not pass inquirer a default (which would prefill the buffer)', async () => {
    input.mockResolvedValue('1.0.0')

    await promptForVersionInput([parseVersion('v1.2.3')], 'regular')

    expect(input.mock.calls[0]?.[0]).not.toHaveProperty('default')
  })
})

describe('release-create prompt stdin ownership', () => {
  it('holds a stdin reader for as long as the prompt is pending', async () => {
    fakeTtyStdin()

    let release: (answer: string) => void = () => {}

    input.mockReturnValue(
      new Promise<string>((resolve) => {
        release = resolve
      }) as ReturnType<typeof input>,
    )

    expect(stdinReaderCount()).toBe(0)

    const pending = promptForVersionInput([parseVersion('v1.2.3')], 'regular')

    // Let withEscape run up to its acquire.
    await Promise.resolve()

    // The whole bug in one assertion: a call site that drops `withEscape` reads a stdin nobody is
    // holding open, and node exits mid-prompt.
    expect(stdinReaderCount()).toBeGreaterThan(0)

    release('1.2.4')
    await pending

    expect(stdinReaderCount()).toBe(0)
  })
})
