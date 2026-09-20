import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { applyConfigMigrations } from './apply-config-migrations'
import type { MigrationResult } from './types'

/**
 * The target was modified between the caller's read and this write. Rewriting it would clobber a
 * human's (or another process's) edit with bytes derived from a stale read; the caller retries from
 * the fresh file on its next run instead.
 */
export class ConfigFileChangedError extends Error {
  constructor(filePath: string) {
    super(`${filePath} changed on disk since it was read`)
    this.name = 'ConfigFileChangedError'
  }
}

export interface WriteMigratedConfigFileOptions {
  path: string
  /** The bytes the caller read — only the indentation is taken from them. */
  raw: string
  migrated: Record<string, unknown>
  /** `mtimeMs` observed when `raw` was read; the stale-read guard compares against it. */
  expectedMtimeMs: number
}

export interface FileMigrationResult extends MigrationResult {
  path: string
}

const DEFAULT_INDENT = 2

// The first indented line decides, so a hand-edited 4-space file is not reformatted wholesale.
const detectIndent = (raw: string): string | number => {
  return /^([ \t]+)\S/m.exec(raw)?.[1] ?? DEFAULT_INDENT
}

// Group / other permission bits and the setuid/sticky family; the file-type bits above them are not
// chmod's business.
const PERMISSION_BITS = 0o7777

/**
 * Serialise `migrated` over `path` — atomically, keeping the file's mode and indentation, and
 * refusing when the file moved on since it was read. Never applies the registry: the caller has
 * already done that (the loader on its retry, {@link migrateConfigFile} on the setup path), so
 * the registry runs exactly once per file whichever way in. Does not log — each caller owns its
 * own line. Throws on any fs error; callers decide.
 *
 * The rename goes over the realpath'd target, so a symlinked `~/.infra-kit/infra-kit.json`
 * (dotfiles repo) keeps its symlink and the link target is what gets replaced — `writeFile`
 * follows a link implicitly, `rename` would replace the link itself.
 */
export const writeMigratedConfigFile = async ({
  path: filePath,
  raw,
  migrated,
  expectedMtimeMs,
}: WriteMigratedConfigFileOptions): Promise<void> => {
  const target = await fs.realpath(filePath)
  const dir = path.dirname(target)
  const base = path.basename(target)
  // pid + random: two racing CLIs never share a tmp name, and a reader never sees a torn file.
  const tmp = path.join(dir, `.${base}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  const content = `${JSON.stringify(migrated, null, detectIndent(raw))}\n`

  try {
    await fs.writeFile(tmp, content, 'utf8')

    // Re-stat as late as possible: the window between this check and the rename is the smallest
    // this process can make it.
    const stat = await fs.stat(target)

    if (stat.mtimeMs !== expectedMtimeMs) {
      throw new ConfigFileChangedError(filePath)
    }

    // writeFile's mode is umask-masked; chmod sets the original bits exactly (0600 stays 0600).
    await fs.chmod(tmp, stat.mode & PERMISSION_BITS)
    await fs.rename(tmp, target)
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Setup path: stat + read + {@link applyConfigMigrations} + {@link writeMigratedConfigFile}. An
 * empty (or whitespace-only) file is a no-op rather than a JSON error — an empty layer is a valid
 * "nothing to override". Throws on read/parse/write errors, including {@link ConfigFileChangedError}.
 */
export const migrateConfigFile = async (filePath: string): Promise<FileMigrationResult> => {
  const stat = await fs.stat(filePath)
  const raw = await fs.readFile(filePath, 'utf8')

  if (raw.trim() === '') {
    return { changed: false, result: {}, notes: [], path: filePath }
  }

  const parsed: unknown = JSON.parse(raw)

  if (!isRecord(parsed)) {
    return { changed: false, result: {}, notes: [], path: filePath }
  }

  const migrated = applyConfigMigrations(parsed)

  if (migrated.changed) {
    await writeMigratedConfigFile({ path: filePath, raw, migrated: migrated.result, expectedMtimeMs: stat.mtimeMs })
  }

  return { ...migrated, path: filePath }
}
