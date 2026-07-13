/**
 * Update this CLI in place, using the package manager that actually owns the install.
 *
 * `process.exit` is used directly (rather than `process.exitCode`) because this command is CLI-only and
 * is NEVER exposed over MCP — see the `self-update` entry in src/lib/command-catalog. Exiting from a
 * long-lived MCP server would kill it; there is no such server on this path.
 *
 * Every process interaction is injected via {@link SelfUpdateDeps} (same seam shape as
 * src/dev/proxy/portless-driver.ts) so tests assert the exact argv and env without shelling out.
 */
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { defaultLazyNpmRoot, detectInstallManager, safeRealpath } from 'src/lib/install-manager'
import { logger } from 'src/lib/logger'
import { withoutPackageManagerEnv } from 'src/lib/pm-env'

export interface SelfUpdateDeps {
  spawnSync?: typeof spawnSync
  print?: (line: string) => void
  exit?: (code: number) => never
  env?: NodeJS.ProcessEnv
  selfRealPath?: string
  lazyNpmRoot?: () => string | undefined
}

/** The realpath of THIS module. A global bin is a symlink, but `import.meta.url` already resolves it. */
const defaultSelfRealPath = (): string => {
  return realpathSync(fileURLToPath(import.meta.url))
}

/**
 * Translate a spawn outcome into an exit. Kept separate from the spawn so each failure mode names itself:
 * a bare `exit(status ?? 1)` would turn a missing binary and a SIGKILL into the same silent `1`.
 */
const exitFromResult = (
  result: ReturnType<typeof spawnSync>,
  manager: string,
  print: (line: string) => void,
  exit: (code: number) => never,
): never => {
  if (result.error) {
    print(`${manager} not found on PATH: ${result.error.message}`)

    return exit(1)
  }

  if (result.signal) {
    print(`update terminated by signal ${result.signal}`)

    return exit(1)
  }

  return exit(result.status ?? 1)
}

/**
 * An EACCES from `npm i -g` (root-owned global dir) surfaces the package manager's own error verbatim
 * through `stdio: 'inherit'`. We NEVER auto-retry with sudo — silently escalating privileges to write to
 * a global directory is not something a self-updater may do.
 */
export const runSelfUpdate = ({ dryRun }: { dryRun: boolean }, deps: SelfUpdateDeps = {}): void => {
  const spawn = deps.spawnSync ?? spawnSync
  const print =
    deps.print ??
    ((line: string) => {
      return logger.info(line)
    })
  const exit =
    deps.exit ??
    ((code: number) => {
      return process.exit(code)
    })
  const env = deps.env ?? process.env
  const selfRealPath = deps.selfRealPath ?? defaultSelfRealPath()
  const lazyNpmRoot = deps.lazyNpmRoot ?? defaultLazyNpmRoot

  const { manager, updateCommand, canSelfSpawn } = detectInstallManager({
    selfRealPath,
    env,
    realpath: safeRealpath,
    lazyNpmRoot,
  })
  const printable = updateCommand.join(' ')

  if (dryRun) {
    print(`Detected install manager: ${manager}`)
    print(`Would run: ${printable}`)

    return
  }

  if (!canSelfSpawn) {
    print(`Detected install manager: ${manager}`)
    print(`Run this yourself: ${printable}`)
    print(
      manager === 'homebrew'
        ? 'Not run for you: Homebrew manages this install; running a package manager would create a split-brain install.'
        : 'Not run for you: the install location is unrecognized, so the command above is a guess — a guessed global install is worse than a printed one.',
    )

    return
  }

  // `shell` on win32 so the `.cmd` shims npm/pnpm/yarn ship as their global bins resolve.
  const result = spawn(updateCommand[0]!, updateCommand.slice(1), {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: withoutPackageManagerEnv(env),
  })

  exitFromResult(result, manager, print, exit)
}
