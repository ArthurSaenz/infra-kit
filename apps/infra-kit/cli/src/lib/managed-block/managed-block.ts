/**
 * Generic "managed block" helpers — a marker-delimited region a tool owns and
 * rewrites idempotently while never touching content outside the markers.
 *
 * This is the same mechanism `infra-kit init` already uses for the `~/.zshrc`
 * shell block (`# -- infra-kit:begin -- … # -- infra-kit:end --`), lifted here so
 * it can be reused for the repo agent-instruction guidance block in `CLAUDE.md`.
 * It mirrors the design of OMC's
 * `<!-- OMC:START --> … <!-- OMC:END -->` CLAUDE.md installer.
 */

/**
 * Where a freshly upserted block lands relative to existing content.
 *
 * - `replace-in-place`: if the block already exists, rewrite it where it sits
 *   (surrounding text untouched, verbatim); if absent, append it at end-of-file.
 * - `append-end`: strip any existing block from wherever it is, then append the
 *   fresh block at end-of-file (i.e. always relocate to the end). This preserves
 *   the historical `~/.zshrc` behavior of `removeExistingBlock` + append.
 */
export type BlockPlacement = 'replace-in-place' | 'append-end'

export interface UpsertManagedBlockArgs {
  /** Existing file content (`''` for a new file). */
  content: string
  /** Inner body to place between the markers (WITHOUT the markers). */
  body: string
  startMarker: string
  endMarker: string
  /** Defaults to `replace-in-place`. */
  placement?: BlockPlacement
}

/**
 * Whether `content` contains a well-formed `start … end` block. A reversed pair
 * (end before start) is treated as absent — the same guard `doctor.ts` applies
 * to the zshrc block, ported here so corrupted markers never match.
 *
 * @example
 * hasManagedBlock('a<!--s-->x<!--e-->b', '<!--s-->', '<!--e-->') // => true
 * hasManagedBlock('<!--e--><!--s-->', '<!--s-->', '<!--e-->')    // => false (reversed)
 */
export const hasManagedBlock = (content: string, startMarker: string, endMarker: string): boolean => {
  const startIdx = content.indexOf(startMarker)
  const endIdx = content.indexOf(endMarker)

  return startIdx !== -1 && endIdx !== -1 && endIdx >= startIdx
}

/**
 * Remove the first complete `start … end` block, preserving surrounding text.
 * Returns `null` when no well-formed block is present (no markers, or reversed),
 * so callers can fall through to legacy-format handling — this matches the
 * `string | null` contract of `init.ts`'s original `removeBetween`, with the
 * added reversed-marker guard.
 *
 * @example
 * removeManagedBlock('top\n<!--s-->mid<!--e-->\nbot', '<!--s-->', '<!--e-->')
 * // => 'top\nbot'
 */
export const removeManagedBlock = (content: string, startMarker: string, endMarker: string): string | null => {
  const startIdx = content.indexOf(startMarker)
  const endIdx = content.indexOf(endMarker)

  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return null

  // eslint-disable-next-line sonarjs/super-linear-regex
  const before = content.slice(0, startIdx).replace(/\n+$/, '')
  const after = content.slice(endIdx + endMarker.length).replace(/^\n+/, '')

  return before + (after ? `\n${after}` : '')
}

/**
 * Read the version token that follows `versionPrefix` (e.g.
 * `'<!-- infra-kit:version '`). Returns the token up to the next whitespace or
 * `>`, or `null` if the prefix is absent. Mirrors OMC's `OMC:VERSION:` line.
 *
 * @example
 * extractVersion('<!-- infra-kit:version 0.1.105 -->', '<!-- infra-kit:version ')
 * // => '0.1.105'
 */
export const extractVersion = (content: string, versionPrefix: string): string | null => {
  const idx = content.indexOf(versionPrefix)

  if (idx === -1) return null

  const rest = content.slice(idx + versionPrefix.length)
  const match = rest.match(/^([^\s>]+)/)

  return match ? match[1]! : null
}

/**
 * Compose a full block string: `start\n{body}\nend`. Kept identical in shape to
 * the historical `buildShellBlock()` output so doctor's exact-match comparison
 * stays valid.
 */
export const buildManagedBlock = (startMarker: string, body: string, endMarker: string): string => {
  return `${startMarker}\n${body}\n${endMarker}`
}

/**
 * Insert or update a managed block in `content`, preserving everything outside
 * the markers. Idempotent: re-running with the same body yields the same block
 * and never nests duplicates.
 *
 * @example
 * // fresh file
 * upsertManagedBlock({ content: '', body: 'hi', startMarker: '<!--s-->', endMarker: '<!--e-->' })
 * // => '<!--s-->\nhi\n<!--e-->\n'
 *
 * @example
 * // existing block replaced in place, surrounding text kept
 * upsertManagedBlock({
 *   content: 'top\n<!--s-->\nold\n<!--e-->\nbot',
 *   body: 'new', startMarker: '<!--s-->', endMarker: '<!--e-->',
 * })
 * // => 'top\n<!--s-->\nnew\n<!--e-->\nbot'
 */
export const upsertManagedBlock = ({
  content,
  body,
  startMarker,
  endMarker,
  placement = 'replace-in-place',
}: UpsertManagedBlockArgs): string => {
  const block = buildManagedBlock(startMarker, body, endMarker)
  const present = hasManagedBlock(content, startMarker, endMarker)

  if (placement === 'replace-in-place' && present) {
    const startIdx = content.indexOf(startMarker)
    const endIdx = content.indexOf(endMarker) + endMarker.length

    return content.slice(0, startIdx) + block + content.slice(endIdx)
  }

  // append-end, or replace-in-place with no existing block: drop any stale block
  // then append the fresh one at end-of-file.
  const stripped = present ? (removeManagedBlock(content, startMarker, endMarker) ?? content) : content
  // eslint-disable-next-line sonarjs/super-linear-regex
  const base = stripped.replace(/\n+$/, '')

  return base.length > 0 ? `${base}\n${block}\n` : `${block}\n`
}
