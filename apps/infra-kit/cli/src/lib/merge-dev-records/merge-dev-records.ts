/**
 * @fileoverview
 *
 * The state files `merge-dev --keep-conflicts` leaves for each hand-off, one per branch under the
 * shared git dir. `gh-merge-dev` writes and resumes them; `doctor` lists the ones nobody finished.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { $ } from 'zx'

import { branchSlug } from 'src/lib/git-utils'

const gitCommonDir = async (cwd: string): Promise<string> => {
  return path.resolve(cwd, (await $({ cwd, quiet: true })`git rev-parse --git-common-dir`).stdout.trim())
}

/** The state file: `<git-common-dir>/infra-kit/merge-dev-resolutions/<slug>.json`. */
export interface ResolutionRecord {
  branch: string
  worktreePath: string
  /** `origin/<branch>` at hand-off — the lease `--continue` checks origin against. */
  baseSha: string
  /** The dev commit merged in. Recorded, because dev moving after the hand-off must not matter. */
  devSha: string
  conflictPaths: string[]
  /**
   * A clean merge handed off because verify failed: every path either side changed since the merge
   * base, the lockfile excepted. Replaces `conflictPaths` as the scope; absent on a conflict hand-off.
   */
  editablePaths?: string[]
  /** Both sides changed the lockfile, so git's clean text merge of it is unproven: the CLI rebuilds it. */
  lockfileBothSides?: boolean
  /** The verify a `verify-failed` hand-off failed — the default for every `--continue` of it. */
  handOffVerify?: string
  /**
   * `AUTO_MERGE` right after the merge stopped: git's merge with markers, i.e. everything NOT the
   * resolver's. A `verify-failed` hand-off has no conflict, so it records the clean merge's tree.
   */
  autoMergeTree: string
  rererePreResolved: string[]
  ignoredAtHandoff: string[]
  lockfileOnly: boolean
  cliVersion: string
  createdAt: string
  /** The tree the last `--continue` preview showed; a committed resume must still carry it. */
  previewedTree?: string
  /** A merge commit a commit hook rewrote after approval: never pushable, only abortable. */
  unapprovedCommit?: string
  /** The lockfile blob the CLI's last rebuild staged — tells a registry move from a foreign lockfile. */
  lockfileBlob?: string
  /** Ignored build output a passing verify created (`dist/`, `.turbo/`, …), outside `node_modules/`. */
  ignoredByVerify?: string[]
  /** The tree and command of the last passing verify, so an unchanged tree is not verified twice. */
  verified?: { treeSha: string; command: string }
}

export const recordsDir = async (cwd: string): Promise<string> => {
  return path.join(await gitCommonDir(cwd), 'infra-kit', 'merge-dev-resolutions')
}

export const recordPath = async (cwd: string, branch: string): Promise<string> => {
  return path.join(await recordsDir(cwd), `${branchSlug(branch)}.json`)
}

export const readRecord = async (file: string): Promise<ResolutionRecord | null> => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as ResolutionRecord
  } catch {
    return null
  }
}

export const writeRecord = async (cwd: string, record: ResolutionRecord): Promise<void> => {
  const file = await recordPath(cwd, record.branch)

  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`)
}

export const listRecords = async (cwd: string): Promise<ResolutionRecord[]> => {
  const dir = await recordsDir(cwd)

  const names = await fs.readdir(dir).catch(() => {
    return [] as string[]
  })

  const records = await Promise.all(
    names
      .filter((name) => {
        return name.endsWith('.json')
      })
      .sort()
      .map((name) => {
        return readRecord(path.join(dir, name))
      }),
  )

  return records.filter((record): record is ResolutionRecord => {
    return record !== null
  })
}

export interface PendingResolution {
  branch: string
  worktreePath: string
  createdAt: string
  worktreeExists: boolean
}

/** Every hand-off `--continue`/`--abort` has not finished yet — what `doctor` reports as forgotten. */
export const listPendingResolutions = async (cwd: string): Promise<PendingResolution[]> => {
  return Promise.all(
    (await listRecords(cwd)).map(async (record) => {
      return {
        branch: record.branch,
        worktreePath: record.worktreePath,
        createdAt: record.createdAt,
        worktreeExists: await fs.stat(record.worktreePath).then(
          () => {
            return true
          },
          () => {
            return false
          },
        ),
      }
    }),
  )
}
