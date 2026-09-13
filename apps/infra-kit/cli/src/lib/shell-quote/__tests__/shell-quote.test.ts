import { describe, expect, it } from 'vitest'

import { shellLine, shellQuote } from 'src/lib/shell-quote'

/**
 * The contract is "a shell reads this back as the argv it came from", so the assertions that matter are
 * the ones where a naive `join(' ')` produces a DIFFERENT, still-runnable command — those are the cases
 * that fail silently in someone's terminal rather than loudly here.
 */

describe('shellQuote', () => {
  it('leaves an already-inert word alone', () => {
    for (const word of ['brew', '--system', '/usr/local/bin/aws', 'dopplerhq/cli/doppler', 'awscli@2.17.0']) {
      expect(shellQuote(word)).toBe(word)
    }
  })

  it.each([
    ['a space', '/Applications/My Editor.app'],
    ['a pipe', 'curl -fsSL https://example.test/i.sh | bash'],
    ['a subshell', '$(curl -fsSL https://example.test/i.sh)'],
    ['a semicolon', 'echo one; echo two'],
  ])('quotes %s so it stays one argument', (_label, word) => {
    expect(shellQuote(word)).toBe(`'${word}'`)
  })

  it('escapes an embedded single quote rather than closing on it', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'")
  })

  it('quotes the empty string, which would otherwise vanish from the line', () => {
    expect(shellQuote('')).toBe("''")
  })
})

describe('shellLine', () => {
  it('keeps a piped bash -c payload inside its own argument', () => {
    const argv = ['sudo', '/bin/bash', '-c', 'curl -fsSL https://example.test/i.sh | bash -s -- --system']

    // The naive join spills the pipe into the OUTER command line, which runs curl with no URL and pipes
    // its usage text into a second shell — a different command that fails for an unrelated reason.
    expect(argv.join(' ')).not.toBe(shellLine(argv))
    expect(shellLine(argv)).toBe("sudo /bin/bash -c 'curl -fsSL https://example.test/i.sh | bash -s -- --system'")
  })

  it('is a plain join when every word is inert', () => {
    expect(shellLine(['brew', 'install', 'gnupg'])).toBe('brew install gnupg')
  })
})
