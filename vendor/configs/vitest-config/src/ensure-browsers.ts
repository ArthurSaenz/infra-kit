import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import * as playwright from 'playwright'
import type { TestProject } from 'vitest/node'

/**
 * Vitest `globalSetup` for browser-mode projects: downloads the browser build the resolved Playwright
 * expects when this machine does not have it yet.
 *
 * Every Playwright release pins its own browser revision, so a catalog bump, a new machine or a
 * cleared cache leaves the suite failing on `Executable doesn't exist` until someone runs
 * `playwright install` by hand.
 */

type BrowserName = 'chromium' | 'firefox' | 'webkit'

const isBrowserName = (name: string): name is BrowserName => ['chromium', 'firefox', 'webkit'].includes(name)

/** Headless chromium runs the separate headless-shell build, a far smaller download than the full browser. */
export const installArgsFor = (browser: BrowserName, headless: boolean): string[] =>
  browser === 'chromium' && headless ? ['install', 'chromium', '--only-shell'] : ['install', browser]

export const isMissingBrowser = (error: unknown): boolean =>
  error instanceof Error && error.message.includes("Executable doesn't exist")

/**
 * Launching is the only public way to ask: Playwright has no API for the path of the headless-shell
 * build, and `executablePath()` names the full browser even when the shell is what a run would start.
 */
const isInstalled = async (browser: BrowserName, headless: boolean): Promise<boolean> => {
  try {
    const launched = await playwright[browser].launch({ headless })

    await launched.close()

    return true
  } catch (error) {
    if (isMissingBrowser(error)) return false

    throw error
  }
}

// The package exports no `./cli` subpath, and the consumer package running the suite has no `playwright` bin.
const playwrightCli = (): string =>
  join(dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js')

export default async function ensureBrowsers(project: TestProject): Promise<void> {
  // CI installs browsers in its own step, with the system libraries (`--with-deps`) this cannot add.
  if (process.env.CI) return

  const { instances = [], headless } = project.config.browser

  for (const { browser } of instances) {
    if (!isBrowserName(browser) || (await isInstalled(browser, headless))) continue

    const args = installArgsFor(browser, headless)

    console.error(
      `[@wl/vitest-config] ${browser} for this Playwright is not installed; running \`playwright ${args.join(' ')}\``,
    )
    execFileSync(process.execPath, [playwrightCli(), ...args], { stdio: 'inherit' })
  }
}
