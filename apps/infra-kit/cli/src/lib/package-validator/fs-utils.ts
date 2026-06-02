import fs from 'node:fs/promises'

/**
 * Resolve whether a path is reachable, suppressing ENOENT into a boolean.
 *
 * @example
 * await pathExists('/etc/hosts') // => true
 * await pathExists('/nope')      // => false
 */
export const pathExists = async (target: string): Promise<boolean> => {
  try {
    await fs.access(target)

    return true
  } catch {
    return false
  }
}
