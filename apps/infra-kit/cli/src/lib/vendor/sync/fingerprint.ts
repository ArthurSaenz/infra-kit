import { lstatSync, readlinkSync } from 'node:fs'
import path from 'node:path'

import { sha256 } from '../hash'
import type { Fingerprint, SourceFile, TrackedFile } from './types'

const MISSING_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR'])

/**
 * What sits at `absolutePath`, without following a link, or `null` when nothing does. `ENOTDIR` also reads
 * as absent: a file where a parent directory should be means the child path cannot exist.
 */
export const fingerprintOnDisk = (absolutePath: string): Fingerprint | null => {
  let stat

  try {
    stat = lstatSync(absolutePath)
  } catch (error) {
    if (MISSING_CODES.has((error as NodeJS.ErrnoException).code ?? '')) return null

    throw error
  }

  if (stat.isSymbolicLink()) return { kind: 'link', text: readlinkSync(absolutePath) }

  // Git only records the owner-execute bit, so group/other bits must not make two files differ.
  if (stat.isFile()) return { kind: 'file', executable: (stat.mode & 0o100) !== 0, sha: sha256(absolutePath) }

  return { kind: 'other' }
}

/**
 * A source file's fingerprint, taking the mode from git rather than disk so `core.fileMode=false` checkouts
 * still propagate the executable bit git records.
 */
export const fingerprintSourceFile = (repoRoot: string, file: TrackedFile): SourceFile => {
  const absolutePath = path.join(repoRoot, file.path)

  const fingerprint: Fingerprint =
    file.mode === '120000'
      ? { kind: 'link', text: readlinkSync(absolutePath) }
      : { kind: 'file', executable: file.mode === '100755', sha: sha256(absolutePath) }

  return { ...file, fingerprint }
}

/** Whether two fingerprints describe the same bytes, mode and link text. */
export const sameFingerprint = (a: Fingerprint, b: Fingerprint | null): boolean => {
  if (b === null || a.kind !== b.kind) return false
  if (a.kind === 'link' && b.kind === 'link') return a.text === b.text
  if (a.kind === 'file' && b.kind === 'file') return a.executable === b.executable && a.sha === b.sha

  return false
}
