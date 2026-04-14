import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

/**
 * List of environments for the project deployment
 */
export const ENVs = ['dev', 'arthur', 'renana', 'roman', 'eliran', 'oriana']

export const DOPPLER_PROJECT_MAP: Record<string, string> = {
  'hulyo-monorepo': 'hulyo',
  'travelist-monorepo': 'travelist',
}

export const ENV_CACHE_DIR = './node_modules/.cache/infra-kit'
export const ENV_LOAD_FILE = 'env-load.sh'
export const ENV_CLEAR_FILE = 'env-clear.sh'

export const INFRA_KIT_SESSION_VAR = 'INFRA_KIT_SESSION'
export const INFRA_KIT_ENV_CONFIG_VAR = 'INFRA_KIT_ENV_CONFIG'
export const INFRA_KIT_ENV_PROJECT_VAR = 'INFRA_KIT_ENV_PROJECT'
export const INFRA_KIT_ENV_LOADED_AT_VAR = 'INFRA_KIT_ENV_LOADED_AT'

export const parseVarNamesFromEnvFile = (filePath: string): string[] => {
  if (!fs.existsSync(filePath)) return []

  const content = fs.readFileSync(filePath, 'utf-8')

  return content
    .split('\n')
    .filter((line) => {
      return line.includes('=') && !line.startsWith('set ')
    })
    .map((line) => {
      return line.split('=')[0]!
    })
}

export const getSessionCacheDir = (): string => {
  const session = process.env[INFRA_KIT_SESSION_VAR]

  if (!session) {
    throw new Error('INFRA_KIT_SESSION is not set. Run `source ~/.zshrc` or `infra-kit init` first.')
  }

  return path.join(ENV_CACHE_DIR, session)
}

export const WORKTREES_DIR_SUFFIX = '-worktrees'
// eslint-disable-next-line sonarjs/publicly-writable-directories
export const LOG_FILE_PATH = '/tmp/mcp-infra-kit.log'
