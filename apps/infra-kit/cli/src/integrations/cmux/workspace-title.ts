import { displayLabel, parseBranchName } from 'src/lib/release-id'

interface BuildCmuxWorkspaceTitleArgs {
  branch: string
}

/**
 * Builds the cmux workspace title for a worktree. The title is now just the
 * branch's display label — the repo name is NOT prefixed, because every worktree
 * workspace lives inside a per-repo sidebar GROUP whose header already carries the
 * repo name (e.g. group `hulyo-monorepo` → workspaces titled `1.48.0`,
 * `checkout-redesign`, `dev`). Release branches render via their release-id label
 * (`release/v1.48.0` → `1.48.0`, `release/checkout-redesign` → `checkout-redesign`);
 * non-release branches fall back to the raw branch string.
 *
 * Note: the title is NO LONGER a dedup/close key — that role moved to the
 * workspace cwd (see {@link listCmuxWorkspacesByCwd}), because dropping the repo
 * prefix makes titles collide across repos (both hulyo and travelist can have a
 * `fix-post-script-ci-cd` branch).
 */
export const buildCmuxWorkspaceTitle = (args: BuildCmuxWorkspaceTitleArgs): string => {
  const { branch } = args

  const id = parseBranchName(branch)

  return id ? displayLabel(id) : branch
}
