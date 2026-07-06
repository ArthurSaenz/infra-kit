import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

export const ENV_LOAD_FILE = 'env-load.sh'
export const ENV_CLEAR_FILE = 'env-clear.sh'

/** Subdir of the cache root holding the project-scoped WARM caches (one dir per
 *  project, keyed by {@link warmCacheKey}). Kept in sync with the zsh block in
 *  init.ts, which reads `$cache_root/projects/$key/env-load.sh`. */
export const WARM_CACHE_SUBDIR = 'projects'

/**
 * Default warm-cache TTL in seconds (2h). Governs BOTH the node-side eviction
 * sweep and the zsh-side source gate (`_INFRA_KIT_WARM_TTL` in the shell block);
 * the two MUST stay equal, so this constant is the single source of truth and the
 * shell default is emitted from it. Short by design: a warm file older than this
 * is never sourced (bounds a revoked/rotated secret served at prompt-0) and is
 * deleted on the next write. The background refresh lands in ~1-2s regardless.
 */
export const DEFAULT_WARM_TTL_SECONDS = 2 * 60 * 60

export const INFRA_KIT_SESSION_VAR = 'INFRA_KIT_SESSION'
export const INFRA_KIT_ENV_CONFIG_VAR = 'INFRA_KIT_ENV_CONFIG'
export const INFRA_KIT_ENV_PROJECT_VAR = 'INFRA_KIT_ENV_PROJECT'
/**
 * Absolute project root (git top-level) the loaded env belongs to. Lets the shell
 * startup gate tell a same-project subshell (skip) from a NEW project (load), so a
 * different project's secrets are never silently kept after `cd`/new shell.
 */
export const INFRA_KIT_ENV_PROJECT_ROOT_VAR = 'INFRA_KIT_ENV_PROJECT_ROOT'
export const INFRA_KIT_ENV_LOADED_AT_VAR = 'INFRA_KIT_ENV_LOADED_AT'
/**
 * Marker exported into env-load.sh ONLY when the load was triggered automatically
 * (see lib/env-autoload). Its presence is the sole signal distinguishing an
 * auto-loaded env from a deliberate manual `env-load`, so auto-load never
 * clobbers a manual choice. A manual load unsets it.
 */
export const INFRA_KIT_ENV_AUTOLOADED_VAR = 'INFRA_KIT_ENV_AUTOLOADED'
/**
 * Suppression sentinel exported by env-clear. While set in a shell, cli-invocation
 * auto-load stays silent (a deliberate clear must not be immediately re-loaded).
 * Lifted by a manual `env-load` or a new shell.
 */
export const INFRA_KIT_ENV_CLEARED_VAR = 'INFRA_KIT_ENV_CLEARED'

/**
 * Matches a line of the form `KEY=...` where KEY is an env-var identifier
 * (letter or underscore, then word chars). Capture group 1 is the name. Shared
 * between env-load (validation, var counting) and parseVarNamesFromEnvFile.
 */
export const ENV_VAR_LINE_PATTERN = /^([A-Z_]\w*)=/i

/**
 * Track whether a physical line leaves us inside an open single-quoted value,
 * mirroring how `shellSingleQuote` emits values (`'…'`, with literal quotes as
 * `'\''`). Outside a quote a backslash escapes the next char; inside a quote a
 * `'` closes it. Lets the parser skip the continuation lines of a multiline value.
 */
const advanceSingleQuoteState = (line: string, startInQuote: boolean): boolean => {
  let inQuote = startInQuote

  for (let i = 0; i < line.length; i++) {
    if (!inQuote && line[i] === '\\') {
      i++
      continue
    }

    if (line[i] === "'") {
      inQuote = !inQuote
    }
  }

  return inQuote
}

export const parseVarNamesFromEnvFile = (filePath: string): string[] => {
  if (!fs.existsSync(filePath)) return []

  const content = fs.readFileSync(filePath, 'utf-8')
  const names: string[] = []
  let inQuote = false

  for (const line of content.split('\n')) {
    // Only a line that starts OUTSIDE a quoted value can be a real assignment;
    // continuation lines of a multiline secret value are skipped.
    if (!inQuote) {
      const match = ENV_VAR_LINE_PATTERN.exec(line)

      if (match) {
        names.push(match[1]!)
      }
    }

    inQuote = advanceSingleQuoteState(line, inQuote)
  }

  return names
}

/**
 * Root cache dir for infra-kit across all sessions. Resolved from
 * $XDG_CACHE_HOME when set, falling back to ~/.cache/infra-kit. Keep in sync
 * with the shell block emitted by `infra-kit init` (src/commands/init/init.ts).
 */
export const getCacheRoot = (): string => {
  const xdg = process.env.XDG_CACHE_HOME
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), '.cache')

  return path.join(base, 'infra-kit')
}

export const getSessionCacheDir = (): string => {
  const session = process.env[INFRA_KIT_SESSION_VAR]

  if (!session) {
    throw new Error(`${INFRA_KIT_SESSION_VAR} is not set. Run \`infra-kit init\` then \`source ~/.zshrc\`.`)
  }

  return path.join(getCacheRoot(), session)
}

/**
 * The warm-cache key for a project: the hex SHA-256 of its CANONICAL (realpath'd)
 * directory. This MUST be byte-identical to the zsh block's
 * `printf %s "$canon" | shasum -a 256 | cut -c1-64` — same input string (no
 * trailing newline), same digest, full 64-hex output — or a warm file written by
 * node is never found by the shell. The shell passes the already-canonicalized
 * dir via `--project-dir`, so node hashes that VERBATIM (it does not re-resolve).
 */
export const warmCacheKey = (canonicalProjectDir: string): string => {
  return crypto.createHash('sha256').update(canonicalProjectDir, 'utf8').digest('hex')
}

/** Root holding all project-scoped warm caches: `$cacheRoot/projects`. */
export const getWarmCacheRoot = (): string => {
  return path.join(getCacheRoot(), WARM_CACHE_SUBDIR)
}

/** This project's warm-cache dir: `$cacheRoot/projects/<warmCacheKey>`. */
export const getProjectWarmCacheDir = (canonicalProjectDir: string): string => {
  return path.join(getWarmCacheRoot(), warmCacheKey(canonicalProjectDir))
}

/**
 * Write content atomically: write to a pid-suffixed temp file in the same
 * directory, then rename. fs.renameSync is atomic on a single filesystem, so
 * concurrent writers can't produce a half-written secret file.
 */
export const atomicWriteFileSync = (filePath: string, content: string, mode: number): void => {
  const tmpPath = `${filePath}.tmp.${process.pid}`

  fs.writeFileSync(tmpPath, content, { mode })

  try {
    fs.renameSync(tmpPath, filePath)
  } catch (error) {
    fs.rmSync(tmpPath, { force: true })
    throw error
  }
}

export const WORKTREES_DIR_SUFFIX = '-worktrees'
// eslint-disable-next-line sonarjs/publicly-writable-directories
export const LOG_FILE_PATH = '/tmp/mcp-infra-kit.log'
