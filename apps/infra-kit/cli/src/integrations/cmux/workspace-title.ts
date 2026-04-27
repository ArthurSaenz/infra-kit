interface BuildCmuxWorkspaceTitleArgs {
  repoName: string
  branch: string
}

/**
 * Builds the cmux workspace title used by `worktrees-add` and looked up by
 * `worktrees-remove`. The `release/` prefix is stripped so the title reads
 * e.g. `"hulyo-monorepo v1.48.0"` for branch `"release/v1.48.0"`.
 */
export const buildCmuxWorkspaceTitle = (args: BuildCmuxWorkspaceTitleArgs): string => {
  const { repoName, branch } = args

  const version = branch.replace('release/', '')

  return `${repoName} ${version}`
}
