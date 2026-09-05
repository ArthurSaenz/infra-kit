import path from 'node:path'

import { pathExists } from '../fs-utils'

/**
 * Walk upward from `start` to the nearest directory containing a package.json.
 * Used so `infra-kit audit` (no `--all`) targets the package whose package.json
 * script invoked it, regardless of the exact working directory.
 *
 * @example
 * await findPackageRoot('/repo/packages/serverless-config/src')
 * // => '/repo/packages/serverless-config'
 */
export const findPackageRoot = async (start: string): Promise<string> => {
  let current = path.resolve(start)

  while (current !== path.dirname(current)) {
    if (await pathExists(path.join(current, 'package.json'))) {
      return current
    }

    current = path.dirname(current)
  }

  if (await pathExists(path.join(current, 'package.json'))) {
    return current
  }

  throw new Error(
    `No package.json found in or above ${start} — cd into a package directory, or pass --root to audit a monorepo root`,
  )
}
