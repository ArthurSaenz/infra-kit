import { describe, expect, it, vi } from 'vitest'

import { ensurePlaywrightBrowsers, missingBrowserDirs } from '../playwright-browsers'

const LISTING = `Chrome for Testing 156.0.8078.4 (playwright chromium v1248)
  Install location:    /cache/ms-playwright/chromium-1248
  Download url:        https://cdn.playwright.dev/builds/cft/156.0.8078.4/mac-arm64/chrome-mac-arm64.zip

Firefox 157.0 (playwright firefox v1555)
  Install location:    /cache/ms-playwright/firefox-1555
  Download url:        https://cdn.playwright.dev/builds/firefox/1555/firefox-mac-arm64.zip
  Download fallback 1: https://playwright.download.prss.microsoft.com/builds/firefox/1555/firefox-mac-arm64.zip
`

const TESTS_DIR = '/repo/apps/client/tests'

const onDisk = (...dirs: string[]) => {
  return (dir: string) => {
    return dirs.includes(dir)
  }
}

describe('missingBrowserDirs', () => {
  it('names only the install locations that are not on disk', () => {
    expect(missingBrowserDirs(LISTING, onDisk('/cache/ms-playwright/chromium-1248'))).toEqual([
      '/cache/ms-playwright/firefox-1555',
    ])
  })

  it('is empty for a listing without install locations', () => {
    expect(missingBrowserDirs('', onDisk())).toEqual([])
  })
})

describe('ensurePlaywrightBrowsers', () => {
  const run = async (overrides: Parameters<typeof ensurePlaywrightBrowsers>[1] = {}) => {
    const install = vi.fn(async (_testsDir: string) => {
      return 0
    })

    await ensurePlaywrightBrowsers(TESTS_DIR, {
      env: {},
      dryRun: async () => {
        return LISTING
      },
      exists: onDisk('/cache/ms-playwright/chromium-1248'),
      install,
      ...overrides,
    })

    return install
  }

  it('installs in the tests package when a build is missing', async () => {
    const install = await run()

    expect(install).toHaveBeenCalledExactlyOnceWith(TESTS_DIR)
  })

  it('does nothing when every build is on disk', async () => {
    const install = await run({
      exists: () => {
        return true
      },
    })

    expect(install).not.toHaveBeenCalled()
  })

  it('leaves CI to its own install step', async () => {
    const install = await run({ env: { CI: 'true' } })

    expect(install).not.toHaveBeenCalled()
  })

  it('does not install when the listing could not be read', async () => {
    const install = await run({
      dryRun: async () => {
        return null
      },
    })

    expect(install).not.toHaveBeenCalled()
  })

  it('resolves when the install fails, leaving the error to Playwright', async () => {
    const install = vi.fn(async (_testsDir: string) => {
      return 1
    })

    await run({ install })

    expect(install).toHaveBeenCalledOnce()
  })
})
