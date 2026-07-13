import { realpathSync } from 'node:fs'
import path from 'node:path'

/**
 * The impure companion to the pure detection module: canonicalise a directory that may not exist.
 *
 * `realpathSync` throws on a missing path, and candidate roots routinely miss — `PNPM_HOME` can point at a
 * directory the user never created, `npm root -g` can name a prefix that was removed. A throw there would
 * turn "we could not identify your install" into a crash, so an unresolvable path falls back to
 * `path.resolve`, which still normalises `.`/`..` and yields a usable, non-matching absolute path.
 */
export const safeRealpath = (dir: string): string => {
  try {
    return realpathSync(dir)
  } catch {
    return path.resolve(dir)
  }
}
