import { describe, expect, it } from 'vitest'

import { MARKER_END, MARKER_START, removeExistingBlock } from '../init'

describe('removeExistingBlock — current markers', () => {
  it('strips a current-marker block and preserves surrounding user content', () => {
    const content = `export USER_A=1\n${MARKER_START}\nzmodload zsh/stat\n${MARKER_END}\nexport USER_B=2\n`

    const result = removeExistingBlock(content)

    expect(result).toContain('export USER_A=1')
    expect(result).toContain('export USER_B=2')
    expect(result).not.toContain(MARKER_START)
    expect(result).not.toContain('zmodload zsh/stat')
  })
})

describe('removeExistingBlock — legacy paired markers', () => {
  it('strips the `# region infra-kit` / `# endregion infra-kit` block', () => {
    const content = ['before', '# region infra-kit', 'alias ik="x"', '# endregion infra-kit', 'after'].join('\n')

    const result = removeExistingBlock(content)

    expect(result).toContain('before')
    expect(result).toContain('after')
    expect(result).not.toContain('# region infra-kit')
    expect(result).not.toContain('alias ik="x"')
  })
})

describe('removeExistingBlock — oldest single-marker heuristic', () => {
  it('strips the marker plus contiguous block lines, stopping at the first user line', () => {
    const content = [
      'export USER_TOP=1',
      '# infra-kit shell functions',
      'alias ik="pnpm exec infra-kit"',
      'env-load() { :; }',
      'env-clear() { :; }',
      'export PATH="$HOME/bin:$PATH"',
      'export USER_BOTTOM=2',
    ].join('\n')

    const result = removeExistingBlock(content)

    // The infra-kit lines are gone…
    expect(result).not.toContain('# infra-kit shell functions')
    expect(result).not.toContain('alias ik="pnpm exec infra-kit"')
    expect(result).not.toContain('env-load() { :; }')
    // …but the scan must stop at the first non-block line and keep the user's exports.
    expect(result).toContain('export USER_TOP=1')
    expect(result).toContain('export PATH="$HOME/bin:$PATH"')
    expect(result).toContain('export USER_BOTTOM=2')
  })
})

describe('removeExistingBlock — no block present', () => {
  it('returns the content unchanged when there is no infra-kit block', () => {
    const content = 'export USER_A=1\nexport USER_B=2\n'

    expect(removeExistingBlock(content)).toBe(content)
  })
})
