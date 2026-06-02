import type { PackageCheck } from '../types'

/**
 * Check that every required script is present in the package.json `scripts` map
 * and carries a runnable command. A key declared with an empty or whitespace-only
 * value fails as well — an empty script silently no-ops in CI, so presence alone
 * is not enough.
 */
export const checkScripts = (scripts: Record<string, string>, requiredScripts: string[]): PackageCheck[] => {
  return requiredScripts.map((script) => {
    const value = scripts[script]

    if (typeof value !== 'string') {
      return { name: `script:${script}`, status: 'fail', message: `missing "${script}" in package.json scripts` }
    }

    if (value.trim().length === 0) {
      return { name: `script:${script}`, status: 'fail', message: `"${script}" is empty in package.json scripts` }
    }

    return { name: `script:${script}`, status: 'pass', message: 'defined' }
  })
}
