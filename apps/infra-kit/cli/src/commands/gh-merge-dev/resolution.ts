import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { $ } from 'zx'

import { agentMode } from 'src/lib/agent-mode'
import { confirmOrExit } from 'src/lib/command-echo'
import { isCommandDeclined } from 'src/lib/errors/command-declined-error'
import { OperationError } from 'src/lib/errors/operation-error'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import {
  branchSlug,
  isAncestor,
  listWorktrees,
  lsRemoteHead,
  pushAtomic,
  resolutionWorktreePath,
  revParseVerify,
} from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
import { pickReleaseBranches } from 'src/lib/prompts/release-picker'
import { formatBranchName, parseReleaseRef } from 'src/lib/release-id'
import { formatBranchPickerItems } from 'src/lib/release-utils'

import packageJson from '../../../package.json' with { type: 'json' }
import { LOCKFILE, mergeLockfile } from './lockfile-merge'
import { MERGE_MESSAGE_PREFIX, reclassify } from './merge-run'
import { registerRunCleanup } from './run-cleanup'

/** The mandatory check before any resolution commit; it also creates the `node_modules` hooks need. */
export const INSTALL_CHECK_COMMAND = 'pnpm install --frozen-lockfile --ignore-scripts'

const RESOLUTION_DIFF_CAP = 64 * 1024
const REASON_CAP = 4096

export type ResolutionState = 'needs-agent' | 'lockfile-only' | 'exists'

export interface Resolution {
  worktreePath: string
  baseSha: string
  devSha: string
  conflictPaths: string[]
  lockfileOnly: boolean
  rererePreResolved: string[]
  state: ResolutionState
}

/** The state file: `<git-common-dir>/infra-kit/merge-dev-resolutions/<slug>.json`. */
interface ResolutionRecord {
  branch: string
  worktreePath: string
  /** `origin/<branch>` at hand-off — the lease `--continue` checks origin against. */
  baseSha: string
  /** The dev commit merged in. Recorded, because dev moving after the hand-off must not matter. */
  devSha: string
  conflictPaths: string[]
  /** `AUTO_MERGE` right after the merge stopped: git's merge with markers, i.e. everything NOT the resolver's. */
  autoMergeTree: string
  rererePreResolved: string[]
  ignoredAtHandoff: string[]
  lockfileOnly: boolean
  cliVersion: string
  createdAt: string
  /** The tree the last `--continue` preview showed; `--yes` commits only this tree. */
  previewedTree?: string
}

export type BlockedCode =
  | 'unmerged-paths'
  | 'markers-remaining'
  | 'out-of-scope-edit'
  | 'verify-failed'
  | 'verify-mutated-tree'
  | 'parents-mismatch'
  | 'git-too-old'

export interface Blocked {
  code: BlockedCode
  paths?: string[]
  detail: string
}

export interface ContinuePlanRow {
  branch: string
  worktreePath: string
  baseSha: string
  devSha: string
  conflictPaths: string[]
  lockfileMerged: boolean
  committed?: boolean
  mergeSha?: string
  treeSha?: string
  diffStat?: string
  resolutionDiff?: string
  resolutionDiffTruncated?: boolean
  rerereFiles: string[]
  verify?: { command: string; ok: boolean; reason?: string }
  blocked?: Blocked
}

export type ResolutionResultStatus =
  'merged' | 'up-to-date' | 'push-aborted' | 'verify-failed' | 'hook-failed' | 'tree-changed' | 'blocked' | 'aborted'

export interface ResolutionResultEntry {
  branch: string
  status: ResolutionResultStatus
  mergeSha?: string
  conflictPaths?: string[]
  pushed: boolean
  reason?: string
  blocked?: Blocked
}

export interface ResolutionRunOutcome {
  results: ResolutionResultEntry[]
  atomicPush: { attempted: boolean; aborted: boolean; abortedBy?: string }
  declined: boolean
}

const stderrOf = (error: unknown): string => {
  const { stderr, message } = error as { stderr?: string; message?: string }

  return String(stderr || message || error)
    .trim()
    .slice(-REASON_CAP)
}

const git = async (cwd: string, args: string[]): Promise<string> => {
  return (await $({ cwd, quiet: true })`git ${args}`).stdout
}

const lines = (stdout: string): string[] => {
  return stdout
    .split('\n')
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line.length > 0
    })
}

const nulFields = (stdout: string): string[] => {
  return stdout.split('\0').filter((field) => {
    return field.length > 0
  })
}

const revParseQuiet = async (cwd: string, ref: string): Promise<string | null> => {
  try {
    return (await git(cwd, ['rev-parse', '-q', '--verify', ref])).trim() || null
  } catch {
    return null
  }
}

export const isLockfileOnly = (conflictPaths: string[] | undefined): boolean => {
  return conflictPaths?.length === 1 && conflictPaths[0] === LOCKFILE
}

// --- state files ---

const recordsDir = async (cwd: string): Promise<string> => {
  const commonDir = (await git(cwd, ['rev-parse', '--git-common-dir'])).trim()

  return path.join(path.resolve(cwd, commonDir), 'infra-kit', 'merge-dev-resolutions')
}

const recordPath = async (cwd: string, branch: string): Promise<string> => {
  return path.join(await recordsDir(cwd), `${branchSlug(branch)}.json`)
}

const readRecord = async (file: string): Promise<ResolutionRecord | null> => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as ResolutionRecord
  } catch {
    return null
  }
}

const writeRecord = async (cwd: string, record: ResolutionRecord): Promise<void> => {
  const file = await recordPath(cwd, record.branch)

  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`)
}

const listRecords = async (cwd: string): Promise<ResolutionRecord[]> => {
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

const toResolution = (record: ResolutionRecord, state: ResolutionState): Resolution => {
  return {
    worktreePath: record.worktreePath,
    baseSha: record.baseSha,
    devSha: record.devSha,
    conflictPaths: record.conflictPaths,
    lockfileOnly: record.lockfileOnly,
    rererePreResolved: record.rererePreResolved,
    state,
  }
}

/** Remove the worktree, its registration and its state file. Never throws. */
const discardResolution = async (cwd: string, branch: string, worktreePath: string): Promise<void> => {
  await git(cwd, ['worktree', 'remove', '--force', worktreePath]).catch(() => {
    return fs.rm(worktreePath, { recursive: true, force: true })
  })
  await fs.rm(await recordPath(cwd, branch), { force: true }).catch(() => {
    return undefined
  })
  await git(cwd, ['worktree', 'prune']).catch(() => {
    return undefined
  })
}

// --- git probes ---

const unmergedPaths = async (cwd: string): Promise<string[]> => {
  return nulFields(await git(cwd, ['diff', '--name-only', '-z', '--diff-filter=U']))
}

/** Every ignored path `git status` reports, one per file (`--untracked-files=all`). */
const ignoredPaths = async (cwd: string): Promise<string[]> => {
  const fields = nulFields(
    await git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all', '--ignored=matching']),
  )

  return fields
    .filter((field) => {
      return field.startsWith('!! ')
    })
    .map((field) => {
      return field.slice(3)
    })
}

/**
 * Conflicted files rerere already rewrote from a recorded resolution — still unmerged in the index,
 * but no longer in `rerere remaining`.
 */
// `rerere remaining` prints nothing when rerere is off, which would read as "rerere resolved
// everything"; so it is consulted only when rerere is on (git's own rule: `rerere.enabled`, or unset
// with an `rr-cache` directory present).
const rererePreResolvedPaths = async (cwd: string, unmerged: string[]): Promise<string[]> => {
  const configured = (
    await git(cwd, ['config', '--type=bool', '--get', 'rerere.enabled']).catch(() => {
      return ''
    })
  ).trim()

  const rrCache = path.join((await git(cwd, ['rev-parse', '--git-common-dir'])).trim(), 'rr-cache')
  const hasCache = await fs.stat(path.resolve(cwd, rrCache)).then(
    () => {
      return true
    },
    () => {
      return false
    },
  )

  if (configured === 'false' || (configured === '' && !hasCache)) return []

  const remaining = new Set(lines(await git(cwd, ['rerere', 'remaining'])))

  return unmerged.filter((file) => {
    return !remaining.has(file)
  })
}

const isUnderNodeModules = (file: string): boolean => {
  return file.split('/').includes('node_modules')
}

/**
 * Every path the resolver touched outside the conflicted set, or hid from `git status`. Empty
 * means the scope check passed.
 */
// Four independent reads, because each is blind where another sees:
// - porcelain's worktree column (Y) and `??` catch unstaged and untracked edits; the index column
//   is skipped because it legitimately carries git's auto-merged dev changes;
// - the index diff against AUTO_MERGE catches an out-of-scope edit that was STAGED;
// - the ignored set, diffed against the hand-off snapshot, catches files `.gitignore` hides —
//   including a self-hiding untracked `sub/.gitignore` of `*`; only `node_modules/` may appear;
// - `ls-files -v` catches assume-unchanged (lowercase tag) and skip-worktree (`S`), both of which
//   make `git status` blind to an edit of that path.
const scopeViolations = async (cwd: string, record: ResolutionRecord): Promise<string[]> => {
  const allowed = new Set([...record.conflictPaths, LOCKFILE])
  const knownIgnored = new Set(record.ignoredAtHandoff)

  const staged = nulFields(
    await git(cwd, ['diff', '--cached', '--name-only', '-z', '--no-renames', record.autoMergeTree]),
  )

  const touched = [...(await worktreeSideChanges(cwd)), ...staged].filter((file) => {
    return !allowed.has(file)
  })

  const newlyIgnored = (await ignoredPaths(cwd)).filter((file) => {
    return !knownIgnored.has(file) && !isUnderNodeModules(file)
  })

  return [...new Set([...touched, ...newlyIgnored, ...(await hiddenByIndexFlags(cwd))])].sort()
}

/** Paths with a worktree-side change (porcelain Y column) or untracked (`??`). */
const worktreeSideChanges = async (cwd: string): Promise<string[]> => {
  const fields = nulFields(await git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all']))
  const changed: string[] = []
  let isRenameSource = false

  for (const field of fields) {
    if (isRenameSource) {
      isRenameSource = false
      continue
    }

    const [x, y] = field

    if (y !== ' ') changed.push(field.slice(3))

    // A rename record carries its source path as the next NUL field.
    isRenameSource = x === 'R' || x === 'C'
  }

  return changed
}

/** Paths flagged assume-unchanged (lowercase tag) or skip-worktree (`S`) in `ls-files -v`. */
const hiddenByIndexFlags = async (cwd: string): Promise<string[]> => {
  return (await git(cwd, ['ls-files', '-v']))
    .split('\n')
    .filter((line) => {
      const tag = line.charAt(0)

      return tag === 'S' || (tag !== '' && tag !== tag.toUpperCase())
    })
    .map((line) => {
      return line.slice(2)
    })
}

/** Staged files that still carry a conflict marker; the lockfile is merged separately. */
const markerPaths = async (cwd: string): Promise<string[]> => {
  const exclude = `:(exclude)${LOCKFILE}`

  try {
    await git(cwd, ['diff', '--cached', '--check', 'HEAD', '--', '.', exclude])

    return []
  } catch (error) {
    // `--check` also reports whitespace errors, which dev's own changes may carry; only markers count.
    const found = new Set<string>()

    for (const line of String((error as { stdout?: string }).stdout ?? '').split('\n')) {
      const match = /^(.*):\d+: leftover conflict marker/.exec(line)

      if (match?.[1]) found.add(match[1])
    }

    return [...found].sort()
  }
}

/** Stage the conflicted paths the resolver edited or deleted. `-A` stages deletions too. */
const stageConflictPaths = async (cwd: string, conflictPaths: string[]): Promise<void> => {
  const present: string[] = []

  // A path gone from both the index and the disk (a staged deletion, a rename/rename source) is
  // already resolved, and naming it would fail the whole `git add` with "pathspec did not match".
  for (const file of conflictPaths) {
    const onDisk = await fs.lstat(path.join(cwd, file)).then(
      () => {
        return true
      },
      () => {
        return false
      },
    )
    const inIndex = onDisk || (await git(cwd, ['--literal-pathspecs', 'ls-files', '--', file])).length > 0

    if (inIndex) present.push(file)
  }

  if (present.length > 0) await git(cwd, ['--literal-pathspecs', 'add', '-A', '--', ...present])
}

const writeTree = async (cwd: string): Promise<string> => {
  return (await git(cwd, ['write-tree'])).trim()
}

const commitParents = async (cwd: string): Promise<string[]> => {
  return (await git(cwd, ['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ').slice(1)
}

const runVerify = async (
  cwd: string,
  extra: string | undefined,
): Promise<{ command: string; ok: boolean; reason?: string }> => {
  const command = extra ? `${INSTALL_CHECK_COMMAND} && ${extra}` : INSTALL_CHECK_COMMAND

  try {
    await $({ cwd, quiet: true })`sh -c ${command}`

    return { command, ok: true }
  } catch (error) {
    return { command, ok: false, reason: stderrOf(error) }
  }
}

/** The resolution itself — the index against AUTO_MERGE — with rerere's files labelled as such. */
const describeResolution = async (
  cwd: string,
  record: ResolutionRecord,
): Promise<Pick<ContinuePlanRow, 'diffStat' | 'resolutionDiff' | 'resolutionDiffTruncated'>> => {
  const diffStat = (await git(cwd, ['diff', '--cached', '--stat', record.autoMergeTree])).trim()
  const raw = await git(cwd, ['diff', '--cached', record.autoMergeTree, '--', '.', `:(exclude)${LOCKFILE}`])
  const rerere = new Set(record.rererePreResolved)

  const labelled = raw
    .split(/^(?=diff --git )/m)
    .map((section) => {
      const file = /^diff --git a\/(.*) b\//.exec(section)?.[1]

      return file && rerere.has(file) ? `# rerere (recorded resolution)\n${section}` : section
    })
    .join('')

  const truncated = Buffer.byteLength(labelled) > RESOLUTION_DIFF_CAP

  return {
    diffStat,
    resolutionDiff: truncated ? Buffer.from(labelled).subarray(0, RESOLUTION_DIFF_CAP).toString() : labelled,
    resolutionDiffTruncated: truncated,
  }
}

// --- hand-off ---

export interface HandOffOutcome {
  resolution?: Resolution
  /** Why no resolution worktree was created, or `resolution-exists`. */
  reason?: string
}

/**
 * Leave each conflicted branch mid-merge in its own detached worktree for someone to resolve, and
 * record what `--continue` needs to check that resolution. Git only: no pnpm, no network.
 *
 * `devSha` is the dev commit the plan saw, so the hand-off reproduces exactly the conflict the
 * operator approved even if dev moved since.
 */
export const handOffConflicts = async (args: {
  cwd: string
  branches: string[]
  devSha: string
}): Promise<Map<string, HandOffOutcome>> => {
  const { cwd, branches, devSha } = args
  const outcomes = new Map<string, HandOffOutcome>()

  for (const branch of branches) {
    outcomes.set(branch, await handOffOne(cwd, branch, devSha))
  }

  return outcomes
}

const handOffOne = async (cwd: string, branch: string, devSha: string): Promise<HandOffOutcome> => {
  const existing = await readRecord(await recordPath(cwd, branch))

  if (existing) {
    return {
      resolution: toResolution(existing, 'exists'),
      reason: `resolution-exists: ${existing.worktreePath} — finish it with --continue or drop it with --abort`,
    }
  }

  const baseSha = await revParseVerify(cwd, `origin/${branch}`)

  if (!baseSha) return { reason: `origin/${branch} does not exist on origin` }

  const worktreePath = resolutionWorktreePath(cwd, branch)

  const discard = (): Promise<void> => {
    return discardResolution(cwd, branch, worktreePath)
  }

  // Covers only the window in which the hand-off is half-built; a finished one is meant to outlive the run.
  const unregister = registerRunCleanup(discard)

  try {
    await git(cwd, ['worktree', 'prune'])
    await fs.mkdir(path.dirname(worktreePath), { recursive: true })
    await git(cwd, ['worktree', 'add', '--detach', worktreePath, baseSha])

    // `--no-commit`: if the conflict no longer reproduces, nothing may be committed here without review.
    await $({
      cwd: worktreePath,
      quiet: true,
    })`git merge --no-commit ${devSha} -m ${MERGE_MESSAGE_PREFIX + branch}`.catch(() => {
      return undefined
    })

    const unmerged = await unmergedPaths(worktreePath)

    if (unmerged.length === 0) {
      await discard()

      return { reason: 'the merge no longer conflicts — re-run release merge-dev' }
    }

    const autoMergeTree = await revParseQuiet(worktreePath, 'AUTO_MERGE')

    if (!autoMergeTree) {
      await discard()

      const version = (await git(cwd, ['--version'])).trim()

      return { reason: `git-too-old: the scope check needs AUTO_MERGE, written by git ≥ 2.42 (found ${version})` }
    }

    const rererePreResolved = await rererePreResolvedPaths(worktreePath, unmerged)
    const lockfileOnly = isLockfileOnly(unmerged)

    const record: ResolutionRecord = {
      branch,
      worktreePath,
      baseSha,
      devSha,
      conflictPaths: unmerged,
      autoMergeTree,
      rererePreResolved,
      ignoredAtHandoff: await ignoredPaths(worktreePath),
      lockfileOnly,
      cliVersion: packageJson.version,
      createdAt: new Date().toISOString(),
    }

    await writeRecord(cwd, record)

    return { resolution: toResolution(record, lockfileOnly ? 'lockfile-only' : 'needs-agent') }
  } catch (error) {
    await discard()

    return { reason: stderrOf(error) }
  } finally {
    unregister()
  }
}

// --- selection ---

/**
 * The resolutions a `--continue`/`--abort` run acts on: named by `--versions`, every one under
 * `--all`, or picked interactively.
 */
const selectRecords = async (args: {
  cwd: string
  versions?: string | string[]
  all?: boolean
}): Promise<ResolutionRecord[]> => {
  const { cwd, versions, all } = args
  const records = await listRecords(cwd)
  const available = records.map((record) => {
    return record.branch
  })

  if (versions !== undefined) {
    const tokens = (Array.isArray(versions) ? versions : versions.split(','))
      .map((token) => {
        return token.trim()
      })
      .filter((token) => {
        return token.length > 0
      })

    return tokens.map((token) => {
      const branch = formatBranchName(parseReleaseRef(token))
      const record = records.find((candidate) => {
        return candidate.branch === branch
      })

      if (!record) {
        throw new OperationError(undefined, {
          operation: `select the resolution for "${token}"`,
          stderrExcerpt: `${branch} has no resolution in progress`,
          remediation:
            available.length > 0
              ? `pass one of: ${available.join(', ')}`
              : 'start one with release merge-dev --keep-conflicts',
        })
      }

      return record
    })
  }

  if (all || records.length === 0) return records

  const picked = await pickReleaseBranches(formatBranchPickerItems({ branches: available, descriptions: new Map() }), { required: true })

  return records.filter((record) => {
    return picked.includes(record.branch)
  })
}

// --- continue ---

const isRegisteredWorktree = async (cwd: string, worktreePath: string): Promise<boolean> => {
  const wanted = await fs.realpath(worktreePath).catch(() => {
    return null
  })

  if (!wanted) return false

  const entries = await listWorktrees(cwd)

  for (const entry of entries) {
    if (
      (await fs.realpath(entry.path).catch(() => {
        return entry.path
      })) === wanted
    ) {
      return true
    }
  }

  return false
}

const blockRow = (row: ContinuePlanRow, code: BlockedCode, detail: string, paths?: string[]): ContinuePlanRow => {
  return { ...row, blocked: { code, detail, ...(paths && paths.length > 0 ? { paths } : {}) } }
}

/**
 * Steps 1–8 of the `--continue` pipeline for one branch: load, stage, scope-check, conflict-check,
 * merge the lockfile, write the tree, verify, scope-check again. Never commits.
 */
const prepareBranch = async (cwd: string, record: ResolutionRecord, extraVerify?: string): Promise<ContinuePlanRow> => {
  const wt = record.worktreePath
  const row: ContinuePlanRow = {
    branch: record.branch,
    worktreePath: wt,
    baseSha: record.baseSha,
    devSha: record.devSha,
    conflictPaths: record.conflictPaths,
    lockfileMerged: false,
    rerereFiles: record.rererePreResolved,
  }

  if (!(await isRegisteredWorktree(cwd, wt))) {
    return blockRow(row, 'parents-mismatch', `the resolution worktree ${wt} is gone — run --abort, then start again`)
  }

  const head = await revParseQuiet(wt, 'HEAD')
  const mergeHead = await revParseQuiet(wt, 'MERGE_HEAD')

  if (head === record.baseSha && mergeHead === record.devSha) return prepareUncommitted(record, row, extraVerify)

  return prepareCommitted(record, row, head, mergeHead)
}

/** The resume after a push-aborted or interrupted `--yes`: the approved tree is already committed. */
const prepareCommitted = async (
  record: ResolutionRecord,
  row: ContinuePlanRow,
  head: string | null,
  mergeHead: string | null,
): Promise<ContinuePlanRow> => {
  const wt = record.worktreePath
  const parents = mergeHead ? [] : await commitParents(wt)
  const tree = mergeHead ? null : await revParseQuiet(wt, 'HEAD^{tree}')
  const isApprovedCommit =
    parents.length === 2 &&
    parents[0] === record.baseSha &&
    parents[1] === record.devSha &&
    tree !== null &&
    tree === record.previewedTree

  if (!isApprovedCommit || !head || !tree) {
    const found = mergeHead ? `HEAD ${head ?? 'none'} merging ${mergeHead}` : `HEAD ${head ?? 'none'}`

    return blockRow(
      row,
      'parents-mismatch',
      `expected HEAD ${record.baseSha} merging ${record.devSha}, or an approved merge commit of the two; found ${found}`,
    )
  }

  const violations = await scopeViolations(wt, record)

  if (violations.length > 0) {
    return blockRow(row, 'out-of-scope-edit', 'only the conflicted paths may change', violations)
  }

  return {
    ...row,
    committed: true,
    mergeSha: head,
    treeSha: tree,
    lockfileMerged: record.conflictPaths.includes(LOCKFILE),
    ...(await describeResolution(wt, record)),
  }
}

/** Steps 2–5: stage the resolver's edits and prove the index is resolved, in scope and marker-free. */
const resolveIndex = async (record: ResolutionRecord): Promise<Blocked | null> => {
  const wt = record.worktreePath
  const outOfScope = (paths: string[], detail: string): Blocked | null => {
    return paths.length > 0 ? { code: 'out-of-scope-edit', detail, paths } : null
  }

  await stageConflictPaths(
    wt,
    record.conflictPaths.filter((file) => {
      return file !== LOCKFILE
    }),
  )

  const scoped = outOfScope(await scopeViolations(wt, record), 'only the conflicted paths may change')

  if (scoped) return scoped

  const unmerged = await unmergedPaths(wt)
  const stillUnmerged = unmerged.filter((file) => {
    return file !== LOCKFILE
  })

  if (stillUnmerged.length > 0) {
    return { code: 'unmerged-paths', detail: 'these paths are still unmerged', paths: stillUnmerged }
  }

  const markers = await markerPaths(wt)

  if (markers.length > 0) return { code: 'markers-remaining', detail: 'conflict markers are still staged', paths: markers }

  if (!unmerged.includes(LOCKFILE)) return null

  const merged = await mergeLockfile(wt)

  if (!merged.ok) return { code: 'verify-failed', detail: merged.reason, paths: [LOCKFILE] }

  return outOfScope(await scopeViolations(wt, record), 'merging the lockfile changed other paths')
}

/** Steps 2–8 for a resolution still mid-merge. */
const prepareUncommitted = async (
  record: ResolutionRecord,
  row: ContinuePlanRow,
  extraVerify?: string,
): Promise<ContinuePlanRow> => {
  const wt = record.worktreePath
  const blocked = await resolveIndex(record)

  if (blocked) return { ...row, blocked }

  const lockfileMerged = record.conflictPaths.includes(LOCKFILE)
  const treeSha = await writeTree(wt)

  // Before any commit, always: it also installs the `node_modules` a commit hook may shell into.
  const verify = await runVerify(wt, extraVerify)
  const verified = { ...row, treeSha, lockfileMerged, verify }

  if (!verify.ok) return blockRow(verified, 'verify-failed', verify.reason ?? 'the verify command failed')

  const afterVerify = await scopeViolations(wt, record)
  const unstaged = lines(await git(wt, ['diff', '--name-only']))

  if (afterVerify.length > 0 || unstaged.length > 0 || (await writeTree(wt)) !== treeSha) {
    return blockRow(verified, 'verify-mutated-tree', 'the verify step changed the tree', [
      ...new Set([...afterVerify, ...unstaged]),
    ])
  }

  return { ...verified, ...(await describeResolution(wt, record)) }
}

/** `git commit` that can never wait on a human: no terminal prompt, no stdin, no controlling TTY. */
// `detached` puts git in its own session, so a hook or a gpg pinentry that opens `/dev/tty` fails
// instead of hanging the run; the failure is reported as `hook-failed` and never retried.
const commitMerge = async (cwd: string): Promise<{ ok: true } | { ok: false; reason: string }> => {
  try {
    await $({
      cwd,
      quiet: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })`git commit --no-edit --cleanup=strip`

    return { ok: true }
  } catch (error) {
    return { ok: false, reason: stderrOf(error) }
  }
}

const blockedResult = (row: ContinuePlanRow): ResolutionResultEntry => {
  const blocked = row.blocked as Blocked

  return {
    branch: row.branch,
    status: blocked.code === 'verify-failed' ? 'verify-failed' : 'blocked',
    conflictPaths: row.conflictPaths,
    pushed: false,
    reason: [`${blocked.code}: ${blocked.detail}`, ...(blocked.paths ? [`(${blocked.paths.join(', ')})`] : [])].join(' '),
    blocked,
  }
}

/** Step 10: commit an approved tree, then prove the commit is exactly what was approved. */
const commitApproved = async (
  row: ContinuePlanRow,
  record: ResolutionRecord,
): Promise<{ sha: string } | ResolutionResultEntry> => {
  const wt = record.worktreePath
  const fail = (status: ResolutionResultStatus, reason: string, extra: Partial<ResolutionResultEntry> = {}) => {
    return { branch: row.branch, status, conflictPaths: row.conflictPaths, pushed: false, reason, ...extra }
  }

  if (row.committed && row.mergeSha) return { sha: row.mergeSha }

  if (!record.previewedTree || row.treeSha !== record.previewedTree) {
    return fail(
      'tree-changed',
      `the resolution is tree ${row.treeSha} but the approved preview was ${record.previewedTree ?? 'never run'} — preview again`,
    )
  }

  const committed = await commitMerge(wt)

  if (!committed.ok) return fail('hook-failed', committed.reason)

  const sha = (await git(wt, ['rev-parse', 'HEAD'])).trim()
  const tree = (await git(wt, ['rev-parse', 'HEAD^{tree}'])).trim()

  if (tree !== row.treeSha) {
    return fail('tree-changed', `a commit hook rewrote the tree (${tree}, approved ${row.treeSha})`, { mergeSha: sha })
  }

  const parents = await commitParents(wt)

  if (parents.length !== 2 || parents[0] !== record.baseSha || parents[1] !== record.devSha) {
    const blocked: Blocked = {
      code: 'parents-mismatch',
      detail: `commit parents are ${parents.join(' ')}, expected ${record.baseSha} ${record.devSha}`,
    }

    return fail('blocked', `parents-mismatch: ${blocked.detail}`, { mergeSha: sha, blocked })
  }

  return { sha }
}

/** Step 11: drop a branch origin already carries the recorded dev in, and block any other movement. */
const reclassifyAgainstRecord = async (
  cwd: string,
  record: ResolutionRecord,
  sha: string,
): Promise<'keep' | ResolutionResultEntry> => {
  const entry = (status: ResolutionResultStatus, reason?: string, blocked?: Blocked): ResolutionResultEntry => {
    return {
      branch: record.branch,
      status,
      mergeSha: sha,
      conflictPaths: record.conflictPaths,
      pushed: false,
      ...(reason ? { reason } : {}),
      ...(blocked ? { blocked } : {}),
    }
  }

  let nowUpToDate: string[]

  try {
    nowUpToDate = (await reclassify(cwd, [{ branch: record.branch, sha }], record.devSha)).nowUpToDate
  } catch (error) {
    const blocked: Blocked = { code: 'parents-mismatch', detail: `origin/${record.branch}: ${stderrOf(error)}` }

    return entry('blocked', `parents-mismatch: ${blocked.detail}`, blocked)
  }

  if (nowUpToDate.includes(record.branch))
    return entry('up-to-date', `origin/${record.branch} already carries ${record.devSha}`)

  const remote = await revParseVerify(cwd, `origin/${record.branch}`)

  if (remote === record.baseSha) return 'keep'

  // A non-forced push would reject a moved branch anyway; a force-REWIND to an ancestor is the case
  // it would not — the push would fast-forward and resurrect the dropped commits.
  const rewound = remote !== null && (await isAncestor(cwd, remote, record.baseSha))
  const blocked: Blocked = {
    code: 'parents-mismatch',
    detail: `origin/${record.branch} ${rewound ? 'was rewound' : 'moved'} to ${remote ?? 'nothing'} since the hand-off at ${record.baseSha}`,
  }

  return entry('blocked', `parents-mismatch: ${blocked.detail}`, blocked)
}

const renderRows = (rows: ContinuePlanRow[]): void => {
  logger.info('\n📋 Resolution preview:')

  for (const row of rows) {
    if (row.blocked) {
      logger.info(`  ${row.branch} — BLOCKED ${row.blocked.code}: ${row.blocked.detail}`)
    } else {
      logger.info(`  ${row.branch} — ready${row.committed ? ' (already committed)' : ''}: tree ${row.treeSha}`)
    }
  }
}

/**
 * `release merge-dev --continue`: check each selected resolution, show it, and on approval commit,
 * re-check against origin and push the ready ones in one atomic set.
 */
export const continueResolutions = async (args: {
  cwd: string
  versions?: string | string[]
  all?: boolean
  verify?: string
  confirmedCommand: boolean | undefined
}): Promise<ResolutionRunOutcome> => {
  const { cwd, versions, all, verify, confirmedCommand } = args
  const idle: ResolutionRunOutcome = { results: [], atomicPush: { attempted: false, aborted: false }, declined: false }
  const records = await selectRecords({ cwd, versions, all })

  if (records.length === 0) {
    logger.info('ℹ️ No merge-dev resolutions in progress')

    return idle
  }

  if (!confirmedCommand) {
    const rows: ContinuePlanRow[] = []

    for (const record of records) {
      const row = await prepareBranch(cwd, record, verify)

      if (!row.blocked && !row.committed && row.treeSha) {
        record.previewedTree = row.treeSha
        await writeRecord(cwd, record)
      }

      rows.push(row)
    }

    renderRows(rows)

    const plan = { branches: rows }

    if (
      rows.every((row) => {
        return row.blocked
      })
    ) {
      throw new StructuredRefusalError({ status: 'refused', plan, agentMode: agentMode.source }, 2, {
        operation: 'continue the merge-dev resolutions',
        stderrExcerpt: 'every selected resolution is blocked',
        remediation: 'fix the paths each row names, then preview again — or drop it with --abort',
      })
    }

    try {
      await confirmOrExit(
        confirmedCommand,
        `Commit and push the resolved merges for: ${rows
          .filter((row) => {
            return !row.blocked
          })
          .map((row) => {
            return row.branch
          })
          .join(', ')}?`,
        { plan, throwOnDecline: true },
      )
    } catch (error) {
      if (!isCommandDeclined(error)) throw error

      return { ...idle, declined: true }
    }
  }

  return executeContinue(cwd, records, verify)
}

/** Steps 10–11 for one branch: the pushable commit, or the branch's terminal result. */
const commitAndReclassify = async (
  cwd: string,
  record: ResolutionRecord,
  verify: string | undefined,
): Promise<{ sha: string } | ResolutionResultEntry> => {
  const row = await prepareBranch(cwd, record, verify)

  if (row.blocked) return blockedResult(row)

  const committed = await commitApproved(row, record)

  if (!('sha' in committed)) return committed

  const reclassified = await reclassifyAgainstRecord(cwd, record, committed.sha)

  return reclassified === 'keep' ? committed : reclassified
}

/** Step 12: one atomic push, then look at origin rather than trusting a failed push's exit. */
const pushResolved = async (
  cwd: string,
  toPush: { record: ResolutionRecord; sha: string }[],
): Promise<Pick<ResolutionRunOutcome, 'results' | 'atomicPush'>> => {
  if (toPush.length === 0) return { results: [], atomicPush: { attempted: false, aborted: false } }

  const refs = toPush.map((item) => {
    return { branch: item.record.branch, sha: item.sha }
  })

  logger.info(
    `\n⬆️  Pushing atomically: ${refs
      .map((ref) => {
        return ref.branch
      })
      .join(', ')}`,
  )

  const pushed = await pushAtomic(cwd, refs)
  const results: ResolutionResultEntry[] = []

  for (const item of toPush) {
    // A push that landed but lost its response reads as "aborted"; only origin knows.
    const landed = pushed.pushed || (await lsRemoteHead(cwd, item.record.branch)) === item.sha

    results.push({
      branch: item.record.branch,
      status: landed ? 'merged' : 'push-aborted',
      mergeSha: item.sha,
      conflictPaths: item.record.conflictPaths,
      pushed: landed,
      ...(landed ? {} : { reason: pushed.stderr?.trim().slice(-REASON_CAP) }),
    })
  }

  return { results, atomicPush: { attempted: true, aborted: !pushed.pushed, abortedBy: pushed.stderr?.split('\n')[0] } }
}

const executeContinue = async (
  cwd: string,
  records: ResolutionRecord[],
  verify: string | undefined,
): Promise<ResolutionRunOutcome> => {
  const settled: ResolutionResultEntry[] = []
  const toPush: { record: ResolutionRecord; sha: string }[] = []

  for (const record of records) {
    const outcome = await commitAndReclassify(cwd, record, verify)

    if ('sha' in outcome) {
      toPush.push({ record, sha: outcome.sha })
    } else {
      settled.push(outcome)
    }
  }

  const pushed = await pushResolved(cwd, toPush)
  const results = [...settled, ...pushed.results]

  // A resolution is moot once origin carries its dev commit, whoever put it there.
  const finished = records.filter((record) => {
    return results.some((result) => {
      return result.branch === record.branch && (result.pushed || result.status === 'up-to-date')
    })
  })

  for (const record of finished) {
    await discardResolution(cwd, record.branch, record.worktreePath)
  }

  const order = records.map((record) => {
    return record.branch
  })

  results.sort((a, b) => {
    return order.indexOf(a.branch) - order.indexOf(b.branch)
  })

  return { results, atomicPush: pushed.atomicPush, declined: false }
}

// --- abort ---

/** `release merge-dev --abort`: discard the selected resolution worktrees and their state. */
export const abortResolutions = async (args: {
  cwd: string
  versions?: string | string[]
  all?: boolean
  confirmedCommand: boolean | undefined
}): Promise<ResolutionRunOutcome> => {
  const { cwd, versions, all, confirmedCommand } = args
  const idle: ResolutionRunOutcome = { results: [], atomicPush: { attempted: false, aborted: false }, declined: false }
  const records = await selectRecords({ cwd, versions, all })

  if (records.length === 0) {
    logger.info('ℹ️ No merge-dev resolutions in progress')

    return idle
  }

  const plan = {
    branches: records.map((record) => {
      return { branch: record.branch, worktreePath: record.worktreePath }
    }),
  }

  try {
    await confirmOrExit(
      confirmedCommand,
      `Discard the resolution worktrees for: ${records
        .map((record) => {
          return record.branch
        })
        .join(', ')}?`,
      { plan, throwOnDecline: true },
    )
  } catch (error) {
    if (!isCommandDeclined(error)) throw error

    return { ...idle, declined: true }
  }

  for (const record of records) {
    await discardResolution(cwd, record.branch, record.worktreePath)
    logger.info(`🗑️  Discarded the resolution for ${record.branch}`)
  }

  return {
    ...idle,
    results: records.map((record) => {
      return { branch: record.branch, status: 'aborted' as const, conflictPaths: record.conflictPaths, pushed: false }
    }),
  }
}
