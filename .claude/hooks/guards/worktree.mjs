// Steer toward infra-kit's MCP worktree tools: BLOCK raw `git worktree add|remove` at any path;
// ADVISE (non-blocking) on `git worktree list`. Soft steer — bypassable via aliases or subshells.
//
// The block is path-independent on purpose. Scoping it to the managed `<repo>-worktrees/` dir
// only asked WHERE the worktree lives, but the thing that matters is WHAT infra-kit does when it
// creates one (pnpm install, IDE open, Jira-derived description). A plain
// `git worktree add ../my-branch` skipped all of that precisely BY landing outside the managed
// dir, so the old rule was blind to the case it most needed to catch.
//
// A genuinely throwaway worktree is still fine — it just goes through the human, who can approve
// the blocked call rather than have the guard guess intent from the path.

export const name = 'worktree';

// Checked per shell segment, so `cd /repo && git worktree add ...` is still seen despite the ^.
export const scope = 'segment';

// Allows leading `VAR=val` and `-C <path>` / `--git-dir=<path>`; anchored so it won't fire on
// `git commit -m "...worktree add..."`.
const GIT_PREFIX = String.raw`^([A-Za-z_][A-Za-z0-9_]*=[^ ]+ +)*git +(-C +[^ ]+ +|--git-dir=[^ ]+ +)*worktree +`;

const RE_MANAGED = new RegExp(`${GIT_PREFIX}(add|remove)\\b`);
const RE_LIST = new RegExp(`${GIT_PREFIX}list\\b`);

const BLOCK_MSG =
  "Use infra-kit's MCP worktree tools instead of raw 'git worktree add/remove': 'worktrees-add' / 'worktrees-remove'. Raw git skips infra-kit's setup (pnpm install, IDE open, release description), which is why the branch works but the worktree is half-configured. If you are inside a linked worktree, cd to the main checkout first — both raw git and the MCP tool refuse worktree management from within a linked worktree. If you truly want an unmanaged throwaway worktree, ask the user to run the git command themselves.";

const ADVISE_MSG =
  "There is also an infra-kit 'worktrees-list' MCP tool that returns a structured release-worktree summary (version, release type, Jira description). Prefer it for release-worktree info; keep using 'git worktree list' when you need the full inventory (feature/ad-hoc worktrees, the main checkout, paths or HEADs), which the MCP tool does not cover.";

export function check(command) {
  if (RE_MANAGED.test(command)) return { action: 'block', message: BLOCK_MSG };
  if (RE_LIST.test(command)) return { action: 'advise', context: ADVISE_MSG };
  return null;
}
