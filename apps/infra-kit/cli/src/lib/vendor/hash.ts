import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { stripLocalBlock } from './local-block'

/**
 * SHA-256 of a file's contents, hex-encoded. Matches the legacy scripts'
 * `createHash('sha256').update(readFileSync(path)).digest('hex')`.
 *
 * `readFileSync` follows symlinks, so a symlinked file is hashed by its target
 * content — the behavior both legacy scripts already relied on.
 *
 * @example
 * sha256('/repo/vendor/configs/eslint-config/index.js') // => 'a1b2c3...'
 */
export const sha256 = (filePath: string): string => {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

/**
 * {@link sha256} of the mirrored half only: a repo-owned `infra-kit:local-start` … `local-end` block is left
 * out, so editing it is neither sync work nor manifest drift. Equals `sha256` for a file without the block.
 *
 * @example
 * mirroredSha256('/repo/.gitignore') // => 'a1b2c3...'
 */
export const mirroredSha256 = (filePath: string): string => {
  return createHash('sha256')
    .update(stripLocalBlock(readFileSync(filePath)))
    .digest('hex')
}
