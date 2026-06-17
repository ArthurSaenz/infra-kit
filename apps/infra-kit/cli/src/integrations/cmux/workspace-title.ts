import { displayLabel, parseBranchName } from 'src/lib/release-id'

interface BuildCmuxWorkspaceTitleArgs {
  repoName: string
  branch: string
}

/**
 * Builds the cmux workspace title used by `worktrees-add` and looked up by
 * `worktrees-remove`. Release branches are rendered via their release-id
 * display label so the title reads e.g. `"hulyo-monorepo 1.48.0"` for
 * `"release/v1.48.0"` and `"hulyo-monorepo checkout-redesign"` for
 * `"release/checkout-redesign"`. Non-release branches (cmux titles them too)
 * fall back to the raw branch string.
 */
export const buildCmuxWorkspaceTitle = (args: BuildCmuxWorkspaceTitleArgs): string => {
  const { repoName, branch } = args

  const id = parseBranchName(branch)
  const label = id ? displayLabel(id) : branch

  return `${repoName} ${label}`
}
