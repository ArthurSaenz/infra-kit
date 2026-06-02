import fs from 'node:fs/promises'
import path from 'node:path'

import type { PackageCheck } from '../types'

/**
 * Check that every required file exists relative to the package root AND is a
 * regular file. A directory that happens to share the required name fails — a
 * required `readme.md` must be the file, not a folder.
 */
export const checkFiles = async (packageDir: string, requiredFiles: string[]): Promise<PackageCheck[]> => {
  return Promise.all(
    requiredFiles.map(async (file) => {
      const stat = await fs.stat(path.join(packageDir, file)).catch(() => {
        return null
      })

      if (!stat) {
        return { name: `file:${file}`, status: 'fail' as const, message: `missing file: ${file}` }
      }

      if (!stat.isFile()) {
        return { name: `file:${file}`, status: 'fail' as const, message: `not a file: ${file} (found a directory)` }
      }

      return { name: `file:${file}`, status: 'pass' as const, message: 'exists' }
    }),
  )
}
