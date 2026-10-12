/**
 * The update worker's last step: hand off to `infra-kit setup --auto` and return without waiting.
 *
 * The `infra-kit` on PATH, not this worker's own `dist/`: right after an install the worker is still the
 * OLD code, and the setup that has to run is the new version's. The child decides for itself whether a
 * pass is owed (`autoSetupDue`), so this side holds no version logic an old worker could get wrong.
 *
 * Detached and unref'd with its own lock, so the worker's update lock is released at once and a slow
 * pass never stretches it toward `LOCK_STALE_MS`.
 */
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import process from 'node:process'

import { unattendedChildEnv } from 'src/lib/auto-setup/child-env'
import { PACKAGE_NAME } from 'src/lib/install-manager'

export const AUTO_SETUP_ARGV = ['setup', '--auto', '--json'] as const

export interface StartAutoSetupDeps {
  env?: NodeJS.ProcessEnv
  spawnDetached?: (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => void
}

const defaultSpawnDetached = (command: string, args: readonly string[], env: NodeJS.ProcessEnv): void => {
  const child = spawn(command, [...args], {
    cwd: homedir(),
    env,
    detached: true,
    stdio: 'ignore',
    shell: process.platform === 'win32',
    windowsHide: true,
  })

  // An `infra-kit` missing from PATH surfaces here asynchronously; there is no one to tell.
  child.on('error', () => {})
  child.unref()
}

/**
 * NEVER throws: a setup that does not start is a pass the next update check starts instead.
 *
 * @example
 * startAutoSetup() // spawns `infra-kit setup --auto --json` from $HOME, detached
 */
export const startAutoSetup = (deps: StartAutoSetupDeps = {}): void => {
  try {
    const env = unattendedChildEnv(deps.env ?? process.env)
    const spawnDetached = deps.spawnDetached ?? defaultSpawnDetached

    spawnDetached(PACKAGE_NAME, AUTO_SETUP_ARGV, env)
  } catch {
    // See the function doc.
  }
}
