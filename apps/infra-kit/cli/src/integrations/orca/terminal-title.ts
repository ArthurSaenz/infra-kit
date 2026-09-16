import { displayLabel, parseBranchName } from 'src/lib/release-id'

interface BuildOrcaTerminalTitleArgs {
  branch: string
}

/**
 * The Orca TAB title for a worktree's terminals — release branches render via
 * their release-id label (`release/v1.48.0` → `1.48.0`), anything else is the raw
 * branch. It labels the tab only: the sidebar row keeps Orca's automatic branch
 * name, and titles are never an ownership key because Orca programs rewrite the
 * per-terminal title at runtime (`✳ Claude Code`).
 */
export const buildOrcaTerminalTitle = (args: BuildOrcaTerminalTitleArgs): string => {
  const { branch } = args

  const id = parseBranchName(branch)

  return id ? displayLabel(id) : branch
}
