import { describe, expect, it } from 'vitest'

import { isChromeEnabledByDefault } from '../claude-chrome'

const HOME = '/home/dev'

const enabledWith = (state: string | null): boolean => {
  return isChromeEnabledByDefault({
    home: HOME,
    readText: (filePath) => {
      return filePath === `${HOME}/.claude.json` ? state : null
    },
  })
}

describe('isChromeEnabledByDefault', () => {
  it('is true only when /chrome stored "Enabled by default"', () => {
    expect(enabledWith(JSON.stringify({ claudeInChromeDefaultEnabled: true }))).toBe(true)
    expect(enabledWith(JSON.stringify({ claudeInChromeDefaultEnabled: false }))).toBe(false)
  })

  it('is false when the choice was never made or the state file is unreadable', () => {
    expect(enabledWith(JSON.stringify({ numStartups: 3 }))).toBe(false)
    expect(enabledWith(null)).toBe(false)
    expect(enabledWith('{not json')).toBe(false)
  })
})
