import fs from 'node:fs'
import path from 'node:path'

import { removeManagedBlock, upsertManagedBlock } from 'src/lib/managed-block'
// Deep loader path, not the `package-validator` barrel — see the note in `adoption.ts`.
import { readPackageJson } from 'src/lib/package-validator/loader'

import { buildDesignSkeleton } from './bodies/design-skeleton'
import { buildPackageBody } from './bodies/package-body'
import { buildRootBody } from './bodies/root-body'
import { PACKAGE_MARKER_END, PACKAGE_MARKER_START, ROOT_MARKER_END, ROOT_MARKER_START } from './markers'
import type { PackageType } from './package-type'
import { detectPackageType } from './package-type'
import {
  assertBlockPresent,
  assertNotSymlink,
  assertOutsideMarkersUnchanged,
  backupFile,
  writeManaged,
} from './write-managed-file'
import type { BackupPolicy, WriteAction } from './write-managed-file'

/**
 * Marker pair for the legacy `@AGENTS.md` import region once injected into `CLAUDE.md`.
 * Migration-only: `syncRootGuidance` strips this region so the full guidance body can take
 * its place. TODO(remove after ~2 release cycles once repos have re-run init).
 */
export const LEGACY_IMPORT_START = '<!-- infra-kit:import:begin -->'
export const LEGACY_IMPORT_END = '<!-- infra-kit:import:end -->'

const AGENTS_FILE = 'AGENTS.md'
const CLAUDE_FILE = 'CLAUDE.md'
const README_FILE = 'README.md'
const DESIGN_FILE = 'DESIGN.md'

/** Types that own a visual language, and so can be given a `DESIGN.md` skeleton. */
const DESIGN_TYPES: readonly PackageType[] = ['frontend', 'mobile']

/** One file touched by a guidance sync. */
export interface GuidanceWrite {
  /** Absolute path of the file. */
  path: string
  action: WriteAction
  /** Resolved package type; absent for the repo-root files. */
  type?: PackageType
  /** Why the write failed. Only set when `action` is `failed`. */
  message?: string
}

export interface SyncRootGuidanceOptions {
  /** CLI version recorded in the block's version line. */
  version: string
}

export interface SyncPackageGuidanceOptions {
  /** Repo root the package's relative directory and type convention are measured against. */
  repoRoot: string
  /** CLI version recorded in the block's version line. */
  version: string
  /** Scaffold a `DESIGN.md` skeleton for `frontend`/`mobile` packages that lack one. */
  design?: boolean
  /** `type` declared in the package's `infra-kit.config.ts`. Wins over every detected signal. */
  declaredType?: PackageType
}

/**
 * File content, or `null` when the file does not exist.
 *
 * Deliberately NOT the swallowing `readGuidanceFile` the read-only inspectors share: this
 * result is the baseline an upsert preserves, so an existing-but-unreadable file must throw
 * (surfacing as `action: 'failed'`) rather than read as absent and be overwritten wholesale.
 */
const readExistingFile = (filePath: string): string | null => {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null
}

/** Whether `dir` holds an exactly-cased `name`, decided from the directory listing. */
const hasExactFile = (dir: string, name: string): boolean => {
  try {
    return fs.readdirSync(dir).includes(name)
  } catch {
    return false
  }
}

/** The failure entry every catch in this module produces. */
const failedWrite = (filePath: string, error: unknown, type?: PackageType): GuidanceWrite => {
  const message = error instanceof Error ? error.message : String(error)
  const entry: GuidanceWrite = { path: filePath, action: 'failed', message }

  if (type) entry.type = type

  return entry
}

interface UpsertFileArgs {
  filePath: string
  body: string
  startMarker: string
  endMarker: string
  backup: BackupPolicy
  /**
   * Rewrite the file's existing content before the block is upserted into it — the root file
   * strips its legacy `@AGENTS.md` import region this way. The unchanged-bytes assertion runs
   * against this result, so what it removes counts as removed by intent rather than as damage.
   */
  prepare?: (content: string) => string
}

/**
 * Upsert a managed block into one file, then assert what the write promised: the block is
 * present, and — on the replace-in-place path only — every byte outside the markers survived.
 */
const upsertGuidanceFile = ({
  filePath,
  body,
  startMarker,
  endMarker,
  backup,
  prepare,
}: UpsertFileArgs): WriteAction => {
  const before = readExistingFile(filePath)
  const baseline = before === null ? '' : (prepare?.(before) ?? before)

  const next = upsertManagedBlock({
    content: baseline,
    body,
    startMarker,
    endMarker,
    placement: 'replace-in-place',
  })

  const action = writeManaged(filePath, next, { backup })

  assertBlockPresent(filePath, startMarker, endMarker)

  // First insertion is exempt: `upsertManagedBlock` normalizes trailing newlines when no
  // block is there yet, which legitimately changes bytes outside the markers exactly once.
  if (before !== null) assertOutsideMarkersUnchanged(baseline, next, startMarker, endMarker)

  return action
}

/**
 * Migrate a legacy `AGENTS.md` now that the guidance lives solely in `CLAUDE.md`.
 * Strips the infra-kit managed block, then asymmetrically:
 * - no infra-kit block at all (hand-authored, not ours) → leave untouched (`unchanged`),
 * - file was purely generated (nothing but whitespace remains) → back up + delete (`removed`),
 * - hand-authored content surrounds the block → back up + write the block-free remainder (`updated`).
 * Every destructive path leaves a timestamped `.backup.` first.
 */
const migrateLegacyAgentsFile = (agentsPath: string): WriteAction => {
  if (!fs.existsSync(agentsPath)) return 'unchanged'

  assertNotSymlink(agentsPath)

  const content = fs.readFileSync(agentsPath, 'utf-8')
  const stripped = removeManagedBlock(content, ROOT_MARKER_START, ROOT_MARKER_END)

  if (stripped === null) return 'unchanged'

  if (stripped.trim() === '') {
    backupFile(agentsPath)
    fs.rmSync(agentsPath)

    return 'removed'
  }

  return writeManaged(agentsPath, stripped, { backup: 'always' })
}

/** The root `CLAUDE.md` write: strip the legacy import region, then upsert the root block. */
const syncRootClaudeFile = (claudePath: string, version: string): WriteAction => {
  return upsertGuidanceFile({
    filePath: claudePath,
    body: buildRootBody(version),
    startMarker: ROOT_MARKER_START,
    endMarker: ROOT_MARKER_END,
    backup: 'always',
    prepare: (content) => {
      return removeManagedBlock(content, LEGACY_IMPORT_START, LEGACY_IMPORT_END) ?? content
    },
  })
}

/**
 * Refresh the repo-root guidance block in `<root>/CLAUDE.md`, preserving every hand-authored
 * byte outside the markers, and migrate a legacy `AGENTS.md` away. The root keeps the
 * always-backup policy: it is one file written by a command a human runs deliberately, so the
 * volume argument behind the git-aware package policy does not apply.
 *
 * Never throws. A per-file error comes back as an entry with `action: 'failed'` and a
 * `message`, so a caller syncing many files can continue and report.
 *
 * @example
 * await syncRootGuidance('/repo', { version: '0.4.0' })
 * // => [{ path: '/repo/CLAUDE.md', action: 'created' }, { path: '/repo/AGENTS.md', action: 'unchanged' }]
 */
export const syncRootGuidance = async (
  root: string,
  { version }: SyncRootGuidanceOptions,
): Promise<GuidanceWrite[]> => {
  const claudePath = path.join(root, CLAUDE_FILE)
  const agentsPath = path.join(root, AGENTS_FILE)
  const written: GuidanceWrite[] = []

  try {
    written.push({ path: claudePath, action: syncRootClaudeFile(claudePath, version) })
  } catch (error) {
    written.push(failedWrite(claudePath, error))
  }

  try {
    written.push({ path: agentsPath, action: migrateLegacyAgentsFile(agentsPath) })
  } catch (error) {
    written.push(failedWrite(agentsPath, error))
  }

  return written
}

/** Scaffold `DESIGN.md` for a type that owns a visual language, never overwriting an existing file. */
const syncDesignFile = (packageDir: string, packageName: string, type: PackageType): GuidanceWrite | null => {
  if (!DESIGN_TYPES.includes(type) || hasExactFile(packageDir, DESIGN_FILE)) return null

  const designPath = path.join(packageDir, DESIGN_FILE)

  try {
    return {
      path: designPath,
      action: writeManaged(designPath, buildDesignSkeleton(packageName), { backup: 'git-aware' }),
      type,
    }
  } catch (error) {
    return failedWrite(designPath, error, type)
  }
}

/**
 * Write (or refresh) one workspace package's guidance block in its own `CLAUDE.md`, selecting
 * the body by detected package type and preserving every hand-authored byte outside the
 * markers. Package files use the git-aware backup policy — a backup lands exactly when git
 * could not recover the file.
 *
 * Never throws: a per-file error comes back as `action: 'failed'` with a `message`, because a
 * run that aborted halfway could leave one well-formed block behind, which adopts the whole
 * workspace and reddens every package the run never reached.
 *
 * @example
 * await syncPackageGuidance('/repo/apps/client/ui', { repoRoot: '/repo', version: '0.4.0' })
 * // => [{ path: '/repo/apps/client/ui/CLAUDE.md', action: 'created', type: 'frontend' }]
 */
export const syncPackageGuidance = async (
  packageDir: string,
  { repoRoot, version, design, declaredType }: SyncPackageGuidanceOptions,
): Promise<GuidanceWrite[]> => {
  const claudePath = path.join(packageDir, CLAUDE_FILE)
  const pkgJson = await readPackageJson(packageDir)
  const packageName = pkgJson.name ?? path.basename(packageDir)
  const type = detectPackageType({ packageDir, repoRoot, pkgJson, declaredType })

  const body = buildPackageBody({
    version,
    type,
    packageName,
    relDir: path.relative(repoRoot, packageDir).split(path.sep).join('/'),
    hasReadme: hasExactFile(packageDir, README_FILE),
    hasDesign: hasExactFile(packageDir, DESIGN_FILE),
  })

  const written: GuidanceWrite[] = []

  try {
    written.push({
      path: claudePath,
      action: upsertGuidanceFile({
        filePath: claudePath,
        body,
        startMarker: PACKAGE_MARKER_START,
        endMarker: PACKAGE_MARKER_END,
        backup: 'git-aware',
      }),
      type,
    })
  } catch (error) {
    written.push(failedWrite(claudePath, error, type))
  }

  if (design) {
    const designWrite = syncDesignFile(packageDir, packageName, type)

    if (designWrite) written.push(designWrite)
  }

  return written
}
