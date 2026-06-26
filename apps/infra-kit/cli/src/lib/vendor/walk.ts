import { readdirSync } from 'node:fs'
import path from 'node:path'

import { isSkippedDir, isSkippedFile } from './skip-sets'

/**
 * Convert a (possibly Windows) relative path to a POSIX-normalized form so the
 * manifest is byte-identical across operating systems.
 */
const toPosix = (relativePath: string): string => {
  return relativePath.split(path.sep).join('/')
}

/**
 * Walk a `vendor/` tree and return the relative paths of every non-skipped file,
 * POSIX-normalized and sorted byte-wise. The sort makes the output independent
 * of `readdirSync` order, which keeps generated manifests deterministic.
 *
 * Symlink handling matches the legacy scripts: only REAL directories
 * (`entry.isDirectory()`) are recursed; a symlink is treated as a leaf and its
 * relative path is emitted, to be hashed later by following it to target
 * content (`sha256`/`readFileSync`). This preserves legacy behavior exactly —
 * the manifest checksum reflects target content, never the link itself.
 *
 * @example
 * walkVendorTree('/repo/vendor')
 * // => ['README.md', 'configs/eslint-config/index.js', ...]
 */
export const walkVendorTree = (vendorRoot: string): string[] => {
  const acc: string[] = []

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        if (isSkippedDir(entry.name)) {
          continue
        }

        walk(full)
        continue
      }

      if (isSkippedFile(entry.name)) {
        continue
      }

      acc.push(toPosix(path.relative(vendorRoot, full)))
    }
  }

  walk(vendorRoot)

  return acc.sort()
}
