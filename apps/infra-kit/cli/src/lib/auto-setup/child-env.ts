/**
 * The environment every unattended setup process gets: an allowlist, not the worker's snapshot.
 *
 * The worker inherits whichever shell ran the command that triggered it, and that shell can carry
 * anything — `env-load`'s Doppler secrets, another project's `INFRA_KIT_SESSION`, `GIT_DIR` from a git
 * hook, `CLAUDECODE` from an agent. Each would follow the setup into every project. A setup needs to
 * find its tools and its home, and nothing else.
 */
const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'TMPDIR',
  'PNPM_HOME',
  'NVM_DIR',
  'VOLTA_HOME',
  'FNM_DIR',
])

const ALLOWED_PREFIXES = ['LC_', 'XDG_', 'HOMEBREW_'] as const

const isAllowed = (key: string): boolean => {
  return (
    ALLOWED_KEYS.has(key) ||
    ALLOWED_PREFIXES.some((prefix) => {
      return key.startsWith(prefix)
    })
  )
}

/**
 * @example
 * unattendedChildEnv({ PATH: '/bin', DOPPLER_TOKEN: 'x', GIT_DIR: '/r/.git' }) // => { PATH: '/bin' }
 */
export const unattendedChildEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => {
      return isAllowed(key)
    }),
  )
}
