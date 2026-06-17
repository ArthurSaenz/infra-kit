import { $ } from 'zx'

import { getProjectVersions, loadJiraConfigOptional } from 'src/integrations/jira'
import { logger } from 'src/lib/logger'
import { parseBranchName } from 'src/lib/release-id'

import { collectKnownVersions } from './next-version'
import type { SemVer } from './next-version'

/**
 * Extract version-branch tokens from raw `git ls-remote` stdout. Each line is
 * `<sha>\t<ref>`; refs are routed through release-id's lenient
 * {@link parseBranchName} and only `kind: 'version'` ids are kept (named
 * `release/<name>` branches are irrelevant to `next`-bump math and are dropped).
 * Returns the no-`v` semver tokens (e.g. `1.2.3`) that
 * {@link collectKnownVersions} parses as versions. Pure — no I/O — so it is
 * unit-testable without the network.
 */
export const extractVersionBranches = (lsRemoteStdout: string): string[] => {
  return lsRemoteStdout
    .split('\n')
    .map((line) => {
      const tab = line.indexOf('\t')

      if (tab === -1) return null

      return parseBranchName(line.slice(tab + 1))
    })
    .filter((id): id is NonNullable<typeof id> => {
      return id !== null && id.kind === 'version'
    })
    .map((id) => {
      return id.raw
    })
}

const parseRemoteRefs = async (): Promise<string[]> => {
  const previousQuiet = $.quiet

  try {
    $.quiet = true
    const result = await $`git ls-remote --heads origin 'release/v*'`

    return extractVersionBranches(result.stdout)
  } finally {
    $.quiet = previousQuiet
  }
}

const fetchJiraVersionNames = async (): Promise<string[]> => {
  const config = await loadJiraConfigOptional()

  if (!config) return []

  const versions = await getProjectVersions(config)

  return versions.map((v) => {
    return v.name
  })
}

/**
 * Load known release versions from the union of:
 * - remote release branches (`release/v*` on origin)
 * - Jira fix versions (when configured)
 *
 * Each source is queried in parallel; if either fails, we log a warning
 * and continue with the other so a transient outage doesn't block release
 * creation.
 */
export const loadExistingVersions = async (): Promise<SemVer[]> => {
  const [branchesResult, jiraResult] = await Promise.allSettled([parseRemoteRefs(), fetchJiraVersionNames()])

  if (branchesResult.status === 'rejected') {
    logger.warn({ error: branchesResult.reason }, 'Failed to list remote release branches; continuing without them')
  }

  if (jiraResult.status === 'rejected') {
    logger.warn({ error: jiraResult.reason }, 'Failed to fetch Jira versions; continuing without them')
  }

  return collectKnownVersions({
    remoteBranches: branchesResult.status === 'fulfilled' ? branchesResult.value : [],
    jiraVersions: jiraResult.status === 'fulfilled' ? jiraResult.value : [],
  })
}
