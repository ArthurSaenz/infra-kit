import { $ } from 'zx'

import { getProjectVersions, loadJiraConfigOptional } from 'src/integrations/jira'
import { logger } from 'src/lib/logger'

import { collectKnownVersions } from './next-version'
import type { SemVer } from './next-version'

const parseRemoteRefs = async (): Promise<string[]> => {
  const previousQuiet = $.quiet

  try {
    $.quiet = true
    const result = await $`git ls-remote --heads origin 'release/v*'`
    const lines = result.stdout.split('\n')

    return lines
      .map((line) => {
        const tab = line.indexOf('\t')

        if (tab === -1) return ''

        return line.slice(tab + 1).replace(/^refs\/heads\//, '')
      })
      .filter(Boolean)
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
