/**
 * The PARENT half of the auto-update: it never fetches, never installs, and never blocks.
 *
 * All it does is (a) surface a notice the background child left behind for installs we may not touch
 * ourselves, and (b) hand off to a detached child when the throttle window has elapsed. Everything
 * expensive or mutating happens in `src/entry/update-check.ts`, after this process has exited.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { safeRealpath } from 'src/lib/install-manager'
import { logger } from 'src/lib/logger'

import { autoUpdateSkipReason } from './guards'
import { isNewerVersion } from './semver'
import { isStale, readUpdateCache } from './update-cache'
import type { UpdateCache } from './update-cache'

export interface AutoUpdateDeps {
  argv?: string[]
  env?: NodeJS.ProcessEnv
  isTty?: boolean
  cwd?: string
  nowMs?: number
  /** Realpath of the running `dist/cli.js`. */
  selfRealPath?: string
  /** Absolute path to the `dist/update-check.js` sibling bundle. */
  childPath?: string
  readCache?: () => UpdateCache | null
  spawnChild?: (childPath: string) => void
  notify?: (line: string) => void
  fileExists?: (p: string) => boolean
}

/**
 * The refresh runs as `node dist/update-check.js --parent-pid <pid>`: a DEDICATED entry, never
 * `cli.js`. Re-invoking `cli.js` would re-run this very function (plus commander, the catalog, and
 * every top-level side effect) in the child. The `mcp` command already spawns a sibling bundle for the
 * same reason.
 *
 * `detached` + `unref` + `stdio: 'ignore'` is what lets the child outlive us: a `ik version` exits in
 * ~50ms, far sooner than any registry round-trip. `windowsHide` keeps a console window from flashing.
 */
const defaultSpawnChild = (childPath: string): void => {
  const child = spawn(process.execPath, [childPath, '--parent-pid', String(process.pid)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })

  child.unref()
}

/** `dist/update-check.js`, resolved beside this bundle exactly as `mcp.ts` resolves `dist/mcp.js`. */
const defaultChildPath = (): string => {
  return fileURLToPath(new URL('./update-check.js', import.meta.url))
}

const defaultSelfRealPath = (): string => {
  return fs.realpathSync(fileURLToPath(new URL('./cli.js', import.meta.url)))
}

/**
 * The cache is never executed — only printed — but it is still attacker-shaped input if anything with
 * the user's uid can write it. An unconstrained token could carry ANSI escapes that rewrite the terminal
 * around the "Run: …" line, turning it into a convincing copy-paste trap. Package-manager argv is drawn
 * from a static table, so a conservative charset costs nothing and closes that.
 */
const SAFE_COMMAND_TOKEN = /^[\w@./+-]+$/i

const isSafeCommandToken = (token: string): boolean => {
  return SAFE_COMMAND_TOKEN.test(token)
}

/**
 * Print the pending notice for installs the worker was not allowed to touch (Homebrew, or a location it
 * could not identify). Those users get the one command that will actually work; running a guessed global
 * install on their behalf is worse than printing one.
 *
 * The verdict is READ from the cache, never recomputed: `detectInstallManager` may shell out to
 * `npm root -g`, and the CLI startup path must never pay for a subprocess. A null `updateCommand` means
 * the worker either installs it silently after we exit, or there is nothing to do.
 *
 * `logger` is pino with `destination: 2` — stderr. Nothing here may reach stdout.
 */
const notifyIfUninstallable = (
  cache: UpdateCache | null,
  currentVersion: string,
  notify: (line: string) => void,
): void => {
  if (!cache?.latestVersion || !cache.updateCommand) return
  if (!isNewerVersion(cache.latestVersion, currentVersion)) return
  if (!cache.updateCommand.every(isSafeCommandToken)) return

  notify(
    `infra-kit ${cache.latestVersion} is available (you have ${currentVersion}). Run: ${cache.updateCommand.join(' ')}`,
  )
}

/**
 * Best-effort. Advisory and background only: it must never throw, never block, and never change the
 * exit code — a failure to update is not a failure of the command the user actually ran.
 *
 * @example
 * maybeAutoUpdate('0.1.130')
 */
export const maybeAutoUpdate = (currentVersion: string, deps: AutoUpdateDeps = {}): void => {
  try {
    const argv = deps.argv ?? process.argv
    const env = deps.env ?? process.env
    const isTty = deps.isTty ?? Boolean(process.stdout.isTTY)
    const cwd = deps.cwd ?? process.cwd()
    const nowMs = deps.nowMs ?? Date.now()
    const selfRealPath = deps.selfRealPath ?? defaultSelfRealPath()
    const readCache = deps.readCache ?? readUpdateCache
    const spawnChild = deps.spawnChild ?? defaultSpawnChild
    const fileExists =
      deps.fileExists ??
      ((p: string) => {
        return fs.existsSync(p)
      })
    const notify =
      deps.notify ??
      ((line: string) => {
        logger.info(line)
      })

    if (autoUpdateSkipReason({ argv, env, isTty, selfRealPath, cwd, realpath: safeRealpath }) !== null) return

    const cache = readCache()

    notifyIfUninstallable(cache, currentVersion, notify)

    if (!isStale(cache, nowMs)) return

    const childPath = deps.childPath ?? defaultChildPath()

    // Absent when running from source (tsx/vitest) rather than a built `dist/`.
    if (!fileExists(childPath)) return

    spawnChild(childPath)
  } catch {
    // Advisory only — see the module doc.
  }
}
