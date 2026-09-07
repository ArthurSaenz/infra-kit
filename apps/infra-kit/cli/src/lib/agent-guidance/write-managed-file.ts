import fs from 'node:fs'
import path from 'node:path'

import { hasManagedBlock } from 'src/lib/managed-block'

/**
 * What a managed write did to one file.
 *
 * `failed` carries the continue-and-report policy (§3.6): a per-file error is recorded against
 * that path and the run proceeds, because aborting halfway can leave exactly one well-formed
 * block behind — which adopts the workspace and reddens every package the run never reached.
 */
export type WriteAction = 'created' | 'updated' | 'unchanged' | 'removed' | 'failed'

/**
 * Refuse to write through a symlink. Gates on `lstatSync` inside a try/catch rather than
 * `existsSync`: `existsSync` *follows* links, so a **dangling** symlink reports `false`, the
 * symlink branch is never reached, and the write goes through the link — creating a file
 * outside the repo. Any stat failure (ENOENT for a plain absent file) is fine and returns.
 *
 * @example
 * assertNotSymlink('/repo/CLAUDE.md')
 * // returns silently when the path is absent or a regular file; throws when it is a symlink
 */
export const assertNotSymlink = (filePath: string): void => {
  let stats: fs.Stats

  try {
    stats = fs.lstatSync(filePath)
  } catch {
    return
  }

  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to write ${filePath} because the destination is a symlink`)
  }
}

/**
 * Write `next` to `filePath` with the OMC-style safety rails: refuse symlinks, and skip the
 * write entirely when the bytes are identical (so re-runs are churn-free). The prior file is
 * overwritten in place — guidance files are managed content under version control, so no
 * sibling copy of them is kept.
 *
 * @example
 * writeManaged('/repo/CLAUDE.md', body)
 * // => 'created' | 'updated' | 'unchanged'
 */
export const writeManaged = (filePath: string, next: string): WriteAction => {
  assertNotSymlink(filePath)

  const previous = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null

  if (previous === next) return 'unchanged'

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, next, 'utf-8')

  return previous === null ? 'created' : 'updated'
}

/**
 * Post-write assertion: the managed block really is in the file we just wrote.
 *
 * @example
 * assertBlockPresent('/repo/CLAUDE.md', ROOT_MARKER_START, ROOT_MARKER_END)
 * // throws when the block is missing from the file on disk
 */
export const assertBlockPresent = (filePath: string, start: string, end: string): void => {
  const content = fs.readFileSync(filePath, 'utf-8')

  if (!hasManagedBlock(content, start, end)) {
    throw new Error(`Post-write validation failed: managed block missing from ${filePath}`)
  }
}

/** The text before the start marker and after the end marker, or `null` when there is no block. */
const outsideMarkers = (content: string, start: string, end: string): { before: string; after: string } | null => {
  if (!hasManagedBlock(content, start, end)) return null

  return {
    before: content.slice(0, content.indexOf(start)),
    after: content.slice(content.indexOf(end) + end.length),
  }
}

/**
 * Post-write assertion for the **replace-in-place** path only: every byte outside the markers
 * survived the update untouched.
 *
 * First insertion is deliberately exempt and must not be checked here. `upsertManagedBlock`'s
 * non-replace path collapses a trailing run of blank lines and appends a newline, so a file
 * that ends in blank lines legitimately changes outside the markers the first time a block
 * lands in it. After that, byte-identity is true and worth pinning.
 *
 * @example
 * assertOutsideMarkersUnchanged(before, after, ROOT_MARKER_START, ROOT_MARKER_END)
 * // throws when hand-authored text around the block was altered
 */
export const assertOutsideMarkersUnchanged = (before: string, after: string, start: string, end: string): void => {
  const previous = outsideMarkers(before, start, end)
  const next = outsideMarkers(after, start, end)

  if (previous === null || next === null) return

  if (previous.before !== next.before || previous.after !== next.after) {
    throw new Error('Post-write validation failed: content outside the managed markers changed')
  }
}
