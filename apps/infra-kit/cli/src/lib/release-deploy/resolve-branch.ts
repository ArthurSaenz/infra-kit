import { getReleasePRsWithInfo } from 'src/integrations/gh'
import { commandEcho } from 'src/lib/command-echo'
import { pickReleaseBranch } from 'src/lib/prompts/release-picker'
import {
  detectReleaseType,
  formatBranchPickerItems,
  getJiraDescriptions,
  resolveReleaseBranch,
} from 'src/lib/release-utils'
import type { ReleaseType } from 'src/lib/release-utils'

/**
 * Resolve the release branch a workflow dispatch should target.
 *
 * `version` accepts a version (`1.2.5`), a release name (`checkout-redesign`), or the literal `dev`.
 * When it is omitted the open release PRs are offered in the searchable picker, annotated with their
 * Jira descriptions and release types — so `--version` stays optional on the CLI even though the MCP
 * schemas require it (interactive pickers are unavailable without a TTY).
 *
 * Shared by `deploy-all` and `deploy-selected`, which carried byte-identical copies of this block.
 */
export const resolveDeployBranch = async (version?: string): Promise<string> => {
  if (version) return version === 'dev' ? 'dev' : resolveReleaseBranch(version)

  commandEcho.setInteractive()

  const releasePRsInfo = await getReleasePRsWithInfo()

  const branches = releasePRsInfo.map((pr) => {
    return pr.branch
  })

  const releaseTypes = new Map<string, ReleaseType>(
    releasePRsInfo.map((pr) => {
      return [pr.branch, detectReleaseType(pr.title)]
    }),
  )

  const descriptions = await getJiraDescriptions()

  return pickReleaseBranch([
    { value: 'dev', label: 'dev' },
    ...formatBranchPickerItems({ branches, descriptions, types: releaseTypes }),
  ])
}
