/* eslint-disable sonarjs/no-os-command-from-path -- runs the user's own CLI, which only PATH can locate */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import process from 'node:process'

import { logger } from 'src/lib/logger'

import { spawnForwardingSignals } from './spawn-forwarding-signals'

export interface PlaywrightBrowsersDeps {
  env?: NodeJS.ProcessEnv
  exists?: (dir: string) => boolean
  /** Stdout of `playwright install --dry-run` in the tests package, or `null` when it could not run. */
  dryRun?: (testsDir: string) => Promise<string | null>
  install?: (testsDir: string) => Promise<number>
}

const INSTALL_LOCATION = 'Install location:'

/** The browser builds a `playwright install --dry-run` listing names that are not on disk. */
export const missingBrowserDirs = (
  dryRunOutput: string,
  exists: (dir: string) => boolean = fs.existsSync,
): string[] => {
  const locations = dryRunOutput.split('\n').flatMap((line) => {
    const trimmed = line.trim()

    return trimmed.startsWith(INSTALL_LOCATION) ? [trimmed.slice(INSTALL_LOCATION.length).trim()] : []
  })

  return locations.filter((dir) => {
    return !exists(dir)
  })
}

const defaultDryRun = (testsDir: string): Promise<string | null> => {
  return new Promise((resolve) => {
    execFile('pnpm', ['exec', 'playwright', 'install', '--dry-run'], { cwd: testsDir }, (error, stdout) => {
      resolve(error ? null : stdout)
    })
  })
}

const defaultInstall = (testsDir: string): Promise<number> => {
  // stdout may carry this command's --json result document; the download progress goes to stderr.
  return spawnForwardingSignals('pnpm', ['exec', 'playwright', 'install'], {
    cwd: testsDir,
    stdio: ['ignore', 2, 'inherit'],
  })
}

/**
 * Download the browser builds the tests package's Playwright expects when this machine lacks them.
 * Every Playwright release pins its own browser revisions, so a version bump, a new machine or a new
 * worktree's first run would otherwise fail every test on `Executable doesn't exist`.
 *
 * Never blocks the run: when the check or the download fails, Playwright reports the missing build itself.
 */
export const ensurePlaywrightBrowsers = async (testsDir: string, deps: PlaywrightBrowsersDeps = {}): Promise<void> => {
  // CI installs browsers in its own step, with the system libraries (`--with-deps`) this cannot add.
  if ((deps.env ?? process.env).CI) return

  const listing = await (deps.dryRun ?? defaultDryRun)(testsDir)

  if (listing === null) return

  const missing = missingBrowserDirs(listing, deps.exists)

  if (missing.length === 0) return

  logger.info(
    `Playwright browsers missing (${missing.length}); running \`pnpm exec playwright install\` in ${testsDir}`,
  )

  const exitCode = await (deps.install ?? defaultInstall)(testsDir)

  if (exitCode !== 0) logger.warn(`\`playwright install\` exited ${exitCode}; continuing with the browsers on disk`)
}
