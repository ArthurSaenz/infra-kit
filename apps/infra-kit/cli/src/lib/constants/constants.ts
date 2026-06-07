import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

export const ENV_LOAD_FILE = 'env-load.sh'
export const ENV_CLEAR_FILE = 'env-clear.sh'

export const INFRA_KIT_SESSION_VAR = 'INFRA_KIT_SESSION'
export const INFRA_KIT_ENV_CONFIG_VAR = 'INFRA_KIT_ENV_CONFIG'
export const INFRA_KIT_ENV_PROJECT_VAR = 'INFRA_KIT_ENV_PROJECT'
export const INFRA_KIT_ENV_LOADED_AT_VAR = 'INFRA_KIT_ENV_LOADED_AT'

/**
 * Matches a line of the form `KEY=...` where KEY is an env-var identifier
 * (letter or underscore, then word chars). Capture group 1 is the name. Shared
 * between env-load (validation, var counting) and parseVarNamesFromEnvFile.
 */
export const ENV_VAR_LINE_PATTERN = /^([A-Z_]\w*)=/i

export const parseVarNamesFromEnvFile = (filePath: string): string[] => {
  if (!fs.existsSync(filePath)) return []

  const content = fs.readFileSync(filePath, 'utf-8')
  const names: string[] = []

  for (const line of content.split('\n')) {
    const match = ENV_VAR_LINE_PATTERN.exec(line)

    if (match) {
      names.push(match[1]!)
    }
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
