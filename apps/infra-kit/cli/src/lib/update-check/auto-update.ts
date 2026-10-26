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

import {
  autoSetupLogPath,
  readAutoSetupRecord,
  readNotifiedMarker,
  writeNotifiedMarker,
} from 'src/lib/auto-setup/record'
import type { AutoSetupRecord } from 'src/lib/auto-setup/record'
import { formatUpdateCommand, safeRealpath } from 'src/lib/install-manager'
import { logger } from 'src/lib/logger'
import { tildify } from 'src/lib/path-display'

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
  readAutoSetup?: () => AutoSetupRecord | null
  readNotified?: () => number | null
  writeNotified?: (finishedMs: number) => void
}

/**
 * The refresh runs as `node dist/update-check.js --parent-pid <pid>`: a DEDICATED entry, never
 * `cli.js`. Re-invoking `cli.js` would re-run this very function (plus commander, the catalog, and
 * every top-level side effect) in the child. `ik-mcp` (`dist/mcp-proxy.js`) is a sibling bundle for
 * the same reason.
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

/** `dist/update-check.js`, resolved beside this bundle — the two are emitted side by side. */
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
 * from a static table plus a filesystem prefix, so a conservative charset costs nothing and closes that.
 *
 * The space is deliberate and is NOT a hole: a prefix path may legitimately contain one
 * (`--prefix /Users/Ada Lovelace/.nvm/...`), and dropping the whole notice over it would silence exactly
 * the users who most need it. `formatUpdateCommand` single-quotes such a token, which is safe precisely
 * because the quote characters themselves remain outside this charset.
 */
const SAFE_COMMAND_TOKEN = /^[\w@./+ -]+$/

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
    `infra-kit ${cache.latestVersion} is available (you have ${currentVersion}). Run: ${formatUpdateCommand(cache.updateCommand)}`,
  )
}

/**
 * One line, once per finished record of the RUNNING version, when the last unattended setup left
 * something for a human: the runs that need attention or failed, and the log that lists their commands.
 *
 * "Once" is a marker file holding the record's `finishedMs`, never a write to the record itself: the
 * background pass may be writing a newer record at this very moment, and the startup path must not
 * overwrite it with the copy it read.
 */
const notifyAutoSetup = (
  record: AutoSetupRecord | null,
  currentVersion: string,
  notifiedFor: number | null,
  notify: (line: string) => void,
  markNotified: (finishedMs: number) => void,
): void => {
  if (record === null || record.finishedMs === null || record.version !== currentVersion) return
  if (notifiedFor === record.finishedMs) return

  const failed = record.runs.filter((run) => {
    return run.status === 'failed'
  }).length

  const attention = record.runs.filter((run) => {
    return run.status === 'attention'
  }).length

  if (failed + attention === 0) return

  const parts = [failed > 0 ? `${failed} failed` : null, attention > 0 ? `${attention} need you` : null].filter(Boolean)

  notify(
    `infra-kit ${record.version} background setup: ${parts.join(', ')} — see ${tildify(autoSetupLogPath())}, or run: infra-kit setup`,
  )
  markNotified(record.finishedMs)
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

    // Its own guard: a notice that cannot stamp its record must not cost the update check below.
    try {
      notifyAutoSetup(
        (deps.readAutoSetup ?? readAutoSetupRecord)(),
        currentVersion,
        (deps.readNotified ?? readNotifiedMarker)(),
        notify,
        deps.writeNotified ?? writeNotifiedMarker,
      )
    } catch {
      // Printed at most once more, next command.
    }

    if (!isStale(cache, nowMs)) return

    const childPath = deps.childPath ?? defaultChildPath()

    // Absent when running from source (tsx/vitest) rather than a built `dist/`.
    if (!fileExists(childPath)) return

    spawnChild(childPath)
  } catch {
    // Advisory only — see the module doc.
  }
}
