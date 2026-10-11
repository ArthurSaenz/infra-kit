import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { z } from 'zod'

import { tildify } from 'src/lib/path-display'

/** Doctor's row shape, restated so `setup` can read the verdict without importing `doctor` (which imports `init`). */
export interface ChromeCheck {
  name: string
  status: 'pass' | 'fail' | 'warn' | 'skip'
  message: string
}

const readTextFile = (filePath: string): string | null => {
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

const CHROME_CHECK_NAME = 'claude in chrome'
const CHROME_NATIVE_HOST = 'com.anthropic.claude_code_browser_extension'
const CHROME_SETUP_HINT = 'run `/chrome` inside Claude Code to set up Claude in Chrome'

/** Chrome reads a user-level native messaging host manifest from these directories only. */
const CHROME_NATIVE_HOST_DIRS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  darwin: ['Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'],
  linux: ['.config', 'google-chrome', 'NativeMessagingHosts'],
}

export interface ChromeCheckDeps {
  platform?: NodeJS.Platform
  home?: string
  readText?: (filePath: string) => string | null
  isExecutable?: (filePath: string) => boolean
}

const defaultIsExecutable = (filePath: string): boolean => {
  try {
    fs.accessSync(filePath, fs.constants.X_OK)

    return true
  } catch {
    return false
  }
}

const parseJsonOrNull = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * The generated wrapper `exec`s the `claude` binary that ran `/chrome`. A Claude Code reinstall to
 * another location leaves the wrapper pointing at a path that is gone, and the extension then fails
 * to connect with no error on the Claude Code side.
 */
const CHROME_WRAPPER_EXEC = /^exec\s+(?<target>\S+)\s+--chrome-native-host\b/m

/**
 * The host half of the Claude in Chrome connection: Chrome can only reach Claude Code through the
 * native messaging host that `/chrome` registers. Whether the extension is CONNECTED right now is
 * visible to a live session only, so `/infra-kit:doctor` asks that half; this row answers "could it".
 *
 * Unregistered is a `warn`, not a `fail`: a machine that never set Chrome up is a choice, but the
 * browser-driven skills cannot run on it. Registered-but-broken is a `fail`.
 *
 * @example
 * checkClaudeInChrome({ platform: 'win32' }) // => { name: 'claude in chrome', status: 'skip', … }
 */
export const checkClaudeInChrome = (deps: ChromeCheckDeps = {}): ChromeCheck => {
  const platform = deps.platform ?? process.platform
  const home = deps.home ?? os.homedir()
  const readText = deps.readText ?? readTextFile
  const isExecutable = deps.isExecutable ?? defaultIsExecutable
  const dirSegments = CHROME_NATIVE_HOST_DIRS[platform]

  if (dirSegments === undefined) {
    return { name: CHROME_CHECK_NAME, status: 'skip', message: `no Chrome native host location known for ${platform}` }
  }

  const manifestPath = path.join(home, ...dirSegments, `${CHROME_NATIVE_HOST}.json`)
  const manifestText = readText(manifestPath)

  if (manifestText === null) {
    return {
      name: CHROME_CHECK_NAME,
      status: 'warn',
      message: `Chrome native host not registered — ${CHROME_SETUP_HINT}`,
    }
  }

  const parsed = z.object({ path: z.string().min(1) }).safeParse(parseJsonOrNull(manifestText))

  if (!parsed.success) {
    return {
      name: CHROME_CHECK_NAME,
      status: 'fail',
      message: `${tildify(manifestPath)} has no host path — ${CHROME_SETUP_HINT} again`,
    }
  }

  const wrapper = parsed.data.path

  if (!isExecutable(wrapper)) {
    return {
      name: CHROME_CHECK_NAME,
      status: 'fail',
      message: `Chrome native host ${tildify(wrapper)} is missing or not executable — ${CHROME_SETUP_HINT} again`,
    }
  }

  const target = CHROME_WRAPPER_EXEC.exec(readText(wrapper) ?? '')?.groups?.target

  if (target !== undefined && !isExecutable(target)) {
    return {
      name: CHROME_CHECK_NAME,
      status: 'fail',
      message: `Chrome native host runs ${tildify(target)}, which no longer exists — ${CHROME_SETUP_HINT} again`,
    }
  }

  return {
    name: CHROME_CHECK_NAME,
    status: 'pass',
    message: `Native host registered (${tildify(wrapper)}); /infra-kit:doctor checks the live connection`,
  }
}

/**
 * Whether `/chrome`'s "Enabled by default" is on. Read from `~/.claude.json`, Claude Code's own state
 * file: there is no documented setting for it, which is why this is only ever READ, never written —
 * Claude Code rewrites that file whole, so a write from here would race a running session.
 *
 * @example
 * isChromeEnabledByDefault() // => true after `/chrome` → "Enabled by default"
 */
export const isChromeEnabledByDefault = (deps: Pick<ChromeCheckDeps, 'home' | 'readText'> = {}): boolean => {
  const home = deps.home ?? os.homedir()
  const readText = deps.readText ?? readTextFile
  const state = z
    .object({ claudeInChromeDefaultEnabled: z.boolean().optional() })
    .safeParse(parseJsonOrNull(readText(path.join(home, '.claude.json')) ?? ''))

  return state.success && state.data.claudeInChromeDefaultEnabled === true
}
