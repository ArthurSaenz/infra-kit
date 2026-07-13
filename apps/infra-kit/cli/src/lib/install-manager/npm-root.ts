/* eslint-disable sonarjs/no-os-command-from-path */
/**
 * `npm root -g`, the LAZY fallback for {@link detectInstallManager}.
 *
 * Why it is indispensable: the `npm` matcher keys off `npm_config_prefix`, which npm sets only while npm
 * itself is running. A user who ran `npm i -g infra-kit` months ago and now types `ik` has no such var,
 * so every cheap matcher misses and detection reports `unknown` / `canSelfSpawn: false`. Without this
 * probe the single most common install method can never update itself.
 *
 * Shared by `self-update` (interactive) and the background update worker so the two can never disagree
 * about who owns the install.
 */
import { execFileSync } from 'node:child_process'
import process from 'node:process'

const NPM_ROOT_TIMEOUT_MS = 3_000

/**
 * The global npm root, or undefined when npm is absent, slow, or errors. Costs a subprocess, so
 * `detectInstallManager` invokes it at most once and only after every env/path matcher has missed — a
 * pnpm or volta install never pays for it.
 *
 * Resolving the user's `npm` from PATH is inherent here: we must ask the very package manager that owns
 * this install where its global root is. Pinning an absolute path would defeat the detection.
 *
 * @example
 * defaultLazyNpmRoot() // => '/usr/local/lib/node_modules' | undefined
 */
export const defaultLazyNpmRoot = (): string | undefined => {
  try {
    const out = execFileSync('npm', ['root', '-g'], {
      encoding: 'utf-8',
      timeout: NPM_ROOT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32',
    })
    const trimmed = out.trim()

    return trimmed === '' ? undefined : trimmed
  } catch {
    return undefined
  }
}
