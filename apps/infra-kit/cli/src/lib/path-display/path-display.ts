import fs from 'node:fs/promises'
import os from 'node:os'

/**
 * Shared path-display helpers for CLI output. Extracted from `commands/config`
 * and `commands/init/migrate-config` (which each had private copies) so config
 * surfaces print paths consistently. Keep this dependency-light (node builtins
 * only) — it is imported by several commands.
 */

/**
 * Resolve whether a file is reachable, suppressing ENOENT (and any access error)
 * into a boolean. Used to render `[✓]`/`[ ]` existence markers.
 *
 * @example
 * await fileExists('/etc/hosts') // => true
 * await fileExists('/nope.txt')  // => false
 */
export const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath)

    return true
  } catch {
    return false
  }
}

/**
 * Replace the user's home prefix with `~` so logged paths stay short and portable
 * across machines. Leaves non-home paths untouched.
 *
 * @example
 * // os.homedir() === '/Users/arthur'
 * tildify('/Users/arthur/.infra-kit/infra-kit.json') // => '~/.infra-kit/infra-kit.json'
 * tildify('/etc/hosts')                              // => '/etc/hosts'
 */
export const tildify = (filePath: string): string => {
  const home = os.homedir()

  return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath
}
