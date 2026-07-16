// Steer toward infra-kit's MCP worktree tools: BLOCK raw `git worktree add|remove` under the
// managed `<repo>-worktrees/` dir; ADVISE (non-blocking) on `git worktree list`. Ad-hoc worktrees
// elsewhere are left alone. Soft steer — bypassable via `git -C`, aliases, or subshells.

export const name = 'worktree';

// Allows leading `VAR=val` and `-C <path>` / `--git-dir=<path>`; anchored so it won't fire on
// `git commit -m "...worktree add..."`.
const GIT_PREFIX = String.raw`^([A-Za-z_][A-Za-z0-9_]*=[^ ]+ +)*git +(-C +[^ ]+ +|--git-dir=[^ ]+ +)*worktree +`;

const RE_MANAGED = new RegExp(`${GIT_PREFIX}(add|remove) +.*-worktrees/`);
const RE_LIST = new RegExp(`${GIT_PREFIX}list\\b`);

const BLOCK_MSG =
  "Use infra-kit's MCP worktree tools for managed worktrees: 'worktrees-add' / 'worktrees-remove' instead of raw 'git worktree add/remove' under <repo>-worktrees/. Raw git is fine for ad-hoc worktrees OUTSIDE the -worktrees/ dir. If you are inside a linked worktree, cd to the main checkout first — both raw git and the MCP tool refuse worktree management from within a linked worktree.";

const ADVISE_MSG =
  "There is also an infra-kit 'worktrees-list' MCP tool that returns a structured release-worktree summary (version, release type, Jira description). Prefer it for release-worktree info; keep using 'git worktree list' when you need the full inventory (feature/ad-hoc worktrees, the main checkout, paths or HEADs), which the MCP tool does not cover.";

export function check(command) {
  if (RE_MANAGED.test(command)) return { action: 'block', message: BLOCK_MSG };
  if (RE_LIST.test(command)) return { action: 'advise', context: ADVISE_MSG };
  return null;
}
