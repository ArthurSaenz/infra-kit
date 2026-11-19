import fs from 'node:fs/promises'
import path from 'node:path'
import { $ } from 'zx'

import { fetchCompareStatus, listOpenPRsByBase } from 'src/integrations/gh/pr-lifecycle'
import { fetchOpenPRsByHead, fetchPRComments, fetchPRsByHeadAllStates } from 'src/integrations/gh/pr-status'
import { getProjectVersions } from 'src/integrations/jira/api'
import type { JiraConfig, JiraVersion } from 'src/integrations/jira/types'
import { WORKTREES_DIR_SUFFIX } from 'src/lib/constants'
import { listWorktrees } from 'src/lib/git-utils/git-utils'
import type { WorktreeEntry } from 'src/lib/git-utils/git-utils'
import { lsRemoteHead, revParseVerify } from 'src/lib/git-utils/merge-refs'
import { displayLabel, formatBranchName, formatJiraName } from 'src/lib/release-id'
import type { ReleaseId } from 'src/lib/release-id'
import { parseJiraVersionIdFromPrBody } from 'src/lib/release-utils/release-utils'
import { classifyDirectory } from 'src/lib/worktrees/sweep-leftover'
import type { DirectoryState } from 'src/lib/worktrees/sweep-leftover'

import type { AnchorPr, CompareStatus, HeadPr, RenameProbe, WorktreeState } from './rename-classifier'

export interface RenameTarget {
  projectRoot: string
  oldId: ReleaseId
  newId: ReleaseId
  /** What a human types: `1.2.3` | `<name>`. */
  oldLabel: string
  newLabel: string
  oldBranch: string
  newBranch: string
  /** Jira fix-version names. */
  oldName: string
  newName: string
  oldPath: string
  newPath: string
}

export const buildRenameTarget = (projectRoot: string, oldId: ReleaseId, newId: ReleaseId): RenameTarget => {
  const oldBranch = formatBranchName(oldId)
  const newBranch = formatBranchName(newId)
  const worktreeDir = `${projectRoot}${WORKTREES_DIR_SUFFIX}`

  return {
    projectRoot,
    oldId,
    newId,
    oldLabel: displayLabel(oldId),
    newLabel: displayLabel(newId),
    oldBranch,
    newBranch,
    oldName: formatJiraName(oldId),
    newName: formatJiraName(newId),
    oldPath: `${worktreeDir}/${oldBranch}`,
    newPath: `${worktreeDir}/${newBranch}`,
  }
}

/** What preflight and the steps need beyond the classifier's input. */
export interface ProbeDetails {
  jiraVersion: JiraVersion | null
  jiraByOldName: JiraVersion | null
  /** The worktree registered at the old path, for the lock and operation guards. */
  oldWorktree: WorktreeEntry | null
}

export interface RenameProbeResult {
  probe: RenameProbe
  details: ProbeDetails
}

const PR_FIELDS_WITH_BODY = 'number,state,title,baseRefName,headRefName,body'

const toHeadPr = (pr: { number: number; body?: string }): HeadPr => {
  return { number: pr.number, bodyJiraId: parseJiraVersionIdFromPrBody(pr.body ?? '') }
}

const openPrsOn = async (head: string): Promise<HeadPr[]> => {
  const prs = (await fetchOpenPRsByHead(head, PR_FIELDS_WITH_BODY)) as { number: number; body?: string }[]

  return prs.map(toHeadPr)
}

// git stores worktree paths as given at creation while macOS tmp and symlinked roots resolve
// elsewhere, so both sides are realpath'd; a missing path falls back to its resolved spelling.
export const realOrResolved = async (target: string): Promise<string> => {
  return fs.realpath(target).catch(() => {
    return path.resolve(target)
  })
}

const leftoverEntries = (leftover: DirectoryState): string[] => {
  if (leftover.state === 'sweepable-only') return leftover.entries
  if (leftover.state === 'has-other-entries') return leftover.otherEntries

  return []
}

const probeWorktree = async (
  target: RenameTarget,
): Promise<{ state: WorktreeState; oldWorktree: WorktreeEntry | null }> => {
  const entries = await listWorktrees(target.projectRoot)

  const [oldReal, newReal, entryReals] = await Promise.all([
    realOrResolved(target.oldPath),
    realOrResolved(target.newPath),
    Promise.all(
      entries.map((entry) => {
        return realOrResolved(entry.path)
      }),
    ),
  ])

  const oldWorktree =
    entries.find((_, index) => {
      return entryReals[index] === oldReal
    }) ?? null

  const atNewPath = entryReals.includes(newReal)
  const leftover = oldWorktree ? ({ state: 'absent' } as const) : await classifyDirectory(target.oldPath)

  const state: WorktreeState = {
    oldPath: target.oldPath,
    newPath: target.newPath,
    atOldPath: oldWorktree !== null,
    atNewPath,
    oldPathLeftover: leftover.state,
    oldPathEntries: leftoverEntries(leftover),
  }

  return { state, oldWorktree }
}

const tracksOwnOriginBranch = async (cwd: string, branch: string): Promise<boolean> => {
  const upstream = `${branch}@{upstream}`

  try {
    const result = await $({ cwd, quiet: true })`git rev-parse --symbolic-full-name ${upstream}`

    return result.stdout.trim() === `refs/remotes/origin/${branch}`
  } catch {
    // No upstream configured, or it names a tracking ref that no longer exists.
    return false
  }
}

const probeCompare = async (oldSha: string | null, newSha: string | null): Promise<CompareStatus | null> => {
  if (oldSha === null || newSha === null) return null
  if (oldSha === newSha) return 'identical'

  return fetchCompareStatus(oldSha, newSha)
}

const probeAnchor = async (oldBranch: string): Promise<AnchorPr | null> => {
  const [anchor] = await fetchPRsByHeadAllStates(oldBranch)

  if (anchor === undefined) return null

  const comments = anchor.state === 'CLOSED' ? await fetchPRComments(anchor.number) : []

  return {
    number: anchor.number,
    state: anchor.state,
    bodyJiraId: parseJiraVersionIdFromPrBody(anchor.body),
    comments,
  }
}

const probeJira = async (target: RenameTarget, bodyJiraId: string | null, config: JiraConfig) => {
  const versions = await getProjectVersions(config)
  const newLower = target.newName.toLowerCase()

  const jiraVersion =
    bodyJiraId === null
      ? null
      : (versions.find((version) => {
          return String(version.id) === bodyJiraId
        }) ?? null)

  // Case-insensitive: whether Jira Cloud treats version names that way for uniqueness is unverified.
  const byNewName =
    versions.find((version) => {
      return version.name.toLowerCase() === newLower
    }) ?? null

  const jiraByOldName =
    versions.find((version) => {
      return version.name === target.oldName
    }) ?? null

  return { jiraVersion, byNewName, jiraByOldName }
}

/** Read-only: git, GitHub and Jira are the journal, so every run starts from what they say now. */
export const probeRename = async (target: RenameTarget, jiraConfig: JiraConfig): Promise<RenameProbeResult> => {
  const { projectRoot, oldBranch, newBranch } = target

  const [anchorPr, openOldPrs, openNewPrs, oldRemoteSha, newRemoteSha, localOldSha, localNewSha, worktree] =
    await Promise.all([
      probeAnchor(oldBranch),
      openPrsOn(oldBranch),
      openPrsOn(newBranch),
      lsRemoteHead(projectRoot, oldBranch),
      lsRemoteHead(projectRoot, newBranch),
      revParseVerify(projectRoot, `refs/heads/${oldBranch}`),
      revParseVerify(projectRoot, `refs/heads/${newBranch}`),
      probeWorktree(target),
    ])

  const [compareOldToNew, jira, childPrs, localNewTracksNew] = await Promise.all([
    probeCompare(oldRemoteSha, newRemoteSha),
    probeJira(target, anchorPr?.bodyJiraId ?? null, jiraConfig),
    // No PR can target a base that is gone from origin.
    oldRemoteSha === null ? Promise.resolve([]) : listOpenPRsByBase(oldBranch),
    localNewSha === null ? Promise.resolve(false) : tracksOwnOriginBranch(projectRoot, newBranch),
  ])

  const { jiraVersion } = jira

  const probe: RenameProbe = {
    oldName: target.oldName,
    newName: target.newName,
    oldBranch,
    newBranch,
    anchorPr,
    openOldPrs,
    openNewPrs,
    oldRemoteSha,
    newRemoteSha,
    compareOldToNew,
    localOldSha,
    localNewSha,
    localNewTracksNew,
    worktree: worktree.state,
    jiraVersion: jiraVersion
      ? {
          id: jiraVersion.id,
          name: jiraVersion.name,
          released: jiraVersion.released,
          archived: jiraVersion.archived,
        }
      : null,
    jiraByNewName: jira.byNewName ? { id: jira.byNewName.id } : null,
    childPrs,
  }

  return {
    probe,
    details: {
      jiraVersion,
      jiraByOldName: jira.jiraByOldName,
      oldWorktree: worktree.oldWorktree,
    },
  }
}
