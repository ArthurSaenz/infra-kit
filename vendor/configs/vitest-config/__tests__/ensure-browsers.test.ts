import { describe, expect, it } from 'vitest'

import { installArgsFor, isMissingBrowser } from '../src/ensure-browsers.js'
import { defineBrowserConfig } from '../src/index.js'

describe('ensure-browsers', () => {
  it('installs only the headless shell for headless chromium', () => {
    expect(installArgsFor('chromium', true)).toEqual(['install', 'chromium', '--only-shell'])
  })

  it.each([
    ['chromium', false],
    ['firefox', true],
    ['webkit', true],
  ] as const)('installs the full %s build when headless is %s', (browser, headless) => {
    expect(installArgsFor(browser, headless)).toEqual(['install', browser])
  })

  it('recognises a missing browser build and nothing else', () => {
    expect(isMissingBrowser(new Error("browserType.launch: Executable doesn't exist at /cache/chrome"))).toBe(true)
    expect(isMissingBrowser(new Error('browserType.launch: Target page, context or browser has been closed'))).toBe(
      false,
    )
    expect(isMissingBrowser("Executable doesn't exist")).toBe(false)
  })

  it('is wired into every browser-mode config', () => {
    expect(defineBrowserConfig(import.meta.dirname).test?.globalSetup).toEqual([
      expect.stringMatching(/ensure-browsers\.js$/),
    ])
  })
})
