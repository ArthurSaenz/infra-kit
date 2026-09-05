import fs from 'node:fs'

/**
 * A guidance file's content, or `null` when it does not exist or cannot be read.
 *
 * `null` is exactly the input `inspectPackageGuidance` reads as `missing`, so every read-only
 * reader of a `CLAUDE.md` — the adoption probe, the audit check and `doctor` — funnels an
 * unreadable file into that one state instead of throwing out of an inspection.
 *
 * Swallowing the error is deliberate here and wrong for a writer: `agent-guidance.ts` keeps its
 * own throwing read, because treating an existing-but-unreadable file as absent would let the
 * upsert overwrite hand-authored content it never managed to see.
 *
 * @example
 * readGuidanceFile('/repo/packages/lib-a/CLAUDE.md')
 * // => '# notes\n<!-- infra-kit:package:begin -->…'
 * @example
 * readGuidanceFile('/repo/packages/lib-a/absent.md')
 * // => null
 */
export const readGuidanceFile = (filePath: string): string | null => {
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}
