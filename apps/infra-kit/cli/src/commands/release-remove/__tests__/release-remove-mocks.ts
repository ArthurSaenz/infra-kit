import { vi } from 'vitest'

import { getReleasePRsWithInfo } from 'src/integrations/gh'
// LEAF paths, matching `release-remove.ts`'s own imports (`:11`, `:17`, `:49`). Mocking the barrels
// instead would intercept nothing: a partial barrel mock does not reach a module that a consumer
// imports from its leaf, and the real `gh`/Jira/`git worktree` call would run inside a "mocked" test.
import { fetchPRByHead } from 'src/integrations/gh/pr-status'
import type { PRStatus } from 'src/integrations/gh/pr-status'
import { removeIdeWorktreeFolders } from 'src/integrations/ide'
import { findVersionByName, loadJiraConfigOptional } from 'src/integrations/jira'
import type { JiraConfig, JiraVersion } from 'src/integrations/jira'
import { getVersionRelatedIssueCounts, removeJiraVersion } from 'src/integrations/jira/remove-version'
import { listOrcaTerminals, orcaCallerInsideTargets } from 'src/integrations/orca'
import { assertBaseBranchSwitchable, assertManagementContext } from 'src/lib/git-guard'
import {
  branchExists,
  deleteLocalBranch,
  deleteRemoteBranch,
  getCurrentBranch,
  getCurrentWorktrees,
  getProjectRoot,
  lsRemoteHead,
  revParseVerify,
} from 'src/lib/git-utils'
import { getJiraDescriptions } from 'src/lib/release-utils'
import { removeReleaseWorktreeIfPresent } from 'src/lib/worktrees/remove-release-worktree'

/**
 * Shared fixtures and default mock wiring for the `release remove` command suites.
 *
 * Deliberately NOT a `vi.mock` bundle: factories are hoisted per FILE, so each suite declares its own
 * `vi.mock` calls (and can therefore leave a module real — `release-remove-guard.test.ts` keeps
 * `src/lib/infra-kit-config` real, which a shared factory list would make impossible). What is shared
 * is only the part that is genuinely identical: the fixture values and the "healthy, fully-present
 * release" baseline every suite then perturbs in exactly one place.
 *
 * {@link installDefaults} calls `.mockResolvedValue` on each collaborator, so a suite that forgets one
 * of the `vi.mock` declarations fails loudly with a TypeError instead of silently calling the real
 * `git`/`gh`/Jira implementation.
 */

export const BRANCH = 'release/v1.2.5'
export const LABEL = '1.2.5'
export const JIRA_NAME = 'v1.2.5'
export const MOVE_TARGET_NAME = 'v1.2.6'
export const BASE_BRANCH = 'dev'
export const PROJECT_ROOT = '/workspace/project-root'
export const WORKTREE_PATH = `${PROJECT_ROOT}-worktrees/${BRANCH}`
export const PR_NUMBER = 42
export const LOCAL_TIP = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
export const REMOTE_TIP = 'f0e1d2c3b4a59687756463524140393827161504'
export const JIRA_VERSION_ID = '10500'
export const MOVE_TARGET_ID = '10600'

export const JIRA_CONFIG: JiraConfig = {
  baseUrl: 'https://example.atlassian.net',
  token: 'jira-token',
  projectId: 10001,
  email: 'dev@example.com',
}

/** The URL `buildJiraVersionUrl` (kept REAL in every suite) derives from {@link JIRA_CONFIG}. */
export const JIRA_VERSION_URL = `${JIRA_CONFIG.baseUrl}/projects/${JIRA_CONFIG.projectId}/versions/${JIRA_VERSION_ID}/tab/release-report-all-issues`

export const jiraVersion = (overrides: Partial<JiraVersion> = {}): JiraVersion => {
  return {
    id: JIRA_VERSION_ID,
    self: `${JIRA_CONFIG.baseUrl}/rest/api/3/version/${JIRA_VERSION_ID}`,
    name: JIRA_NAME,
    archived: false,
    released: false,
    projectId: JIRA_CONFIG.projectId,
    ...overrides,
  }
}

export const moveTargetVersion = (): JiraVersion => {
  return jiraVersion({
    id: MOVE_TARGET_ID,
    name: MOVE_TARGET_NAME,
    self: `${JIRA_CONFIG.baseUrl}/rest/api/3/version/${MOVE_TARGET_ID}`,
  })
}

export const releasePr = (overrides: Partial<PRStatus> = {}): PRStatus => {
  return {
    number: PR_NUMBER,
    state: 'OPEN',
    title: 'Release v1.2.5',
    baseRefName: 'dev',
    headRefName: BRANCH,
    ...overrides,
  }
}

/**
 * Resolve the release's own fix version by name and, separately, a `--move-issues-to` target — the
 * command calls `findVersionByName` twice with different names, so a single `mockResolvedValue` would
 * hand the move-target lookup the release's own version and hide the difference.
 */
export const findVersionByNameFake = (versions: JiraVersion[]) => {
  return async (name: string): Promise<JiraVersion | null> => {
    return (
      versions.find((version) => {
        return version.name === name
      }) ?? null
    )
  }
}

/**
 * The healthy baseline: worktree present and clean, an OPEN PR, both branch tips live, Jira
 * configured with an unreleased fix version carrying no issues, no Orca terminal in the worktree, and
 * a caller that is not inside it.
 *
 * `isAgentMode` is deliberately NOT wired here — `release-remove-guard.test.ts` reads the real
 * `agentMode` holder, and wiring a spy onto a real function would throw.
 */
export const installDefaults = (): void => {
  vi.mocked(assertManagementContext).mockResolvedValue(undefined)
  vi.mocked(assertBaseBranchSwitchable).mockResolvedValue(undefined)

  vi.mocked(getProjectRoot).mockResolvedValue(PROJECT_ROOT)
  vi.mocked(getCurrentWorktrees).mockResolvedValue([BRANCH])
  vi.mocked(getCurrentBranch).mockResolvedValue(BASE_BRANCH)
  vi.mocked(revParseVerify).mockResolvedValue(LOCAL_TIP)
  vi.mocked(lsRemoteHead).mockResolvedValue(REMOTE_TIP)
  vi.mocked(branchExists).mockResolvedValue(false)
  vi.mocked(deleteLocalBranch).mockResolvedValue(undefined)
  vi.mocked(deleteRemoteBranch).mockResolvedValue(undefined)

  vi.mocked(fetchPRByHead).mockResolvedValue(releasePr())
  vi.mocked(getReleasePRsWithInfo).mockResolvedValue([])
  vi.mocked(getJiraDescriptions).mockResolvedValue(new Map<string, string>())

  vi.mocked(removeReleaseWorktreeIfPresent).mockResolvedValue([BRANCH])
  vi.mocked(removeIdeWorktreeFolders).mockResolvedValue([])
  vi.mocked(listOrcaTerminals).mockResolvedValue({ terminals: [], truncated: false })
  vi.mocked(orcaCallerInsideTargets).mockResolvedValue(null)

  vi.mocked(loadJiraConfigOptional).mockResolvedValue(JIRA_CONFIG)
  vi.mocked(findVersionByName).mockImplementation(findVersionByNameFake([jiraVersion(), moveTargetVersion()]))
  vi.mocked(getVersionRelatedIssueCounts).mockResolvedValue({ issuesFixedCount: 0, issuesAffectedCount: 0 })
  vi.mocked(removeJiraVersion).mockResolvedValue(undefined)
}
