---
name: worktrees
description: Start, list, or remove feature worktrees through the infra-kit CLI — a feature/<name> branch in its own checkout under <root>-worktrees/feature/, cut from dev, main or a release branch, behind the preview-then-approve protocol. Use when the user wants to start a feature in a separate worktree, resume one, or clean one up.
argument-hint: [<feature-name>] [--base <dev|main|release>] [--remove]
allowed-tools: Bash(infra-kit worktrees list --json*), Bash(infra-kit release list --json*)
---

# worktrees — feature worktrees through infra-kit

CLI on PATH: !`zsh -c 'infra-kit version --json' 2>/dev/null || echo '{"error":"infra-kit not on PATH"}'`

The commands are `infra-kit worktrees add`, `worktrees list` and `worktrees remove`, each run
through `Bash` with `--json --agent`.

**Version floor.** Read the block above first. On `{"error": …}`, or a `version` below `0.14.0`, tell
the human to update — `pnpm add -g infra-kit@latest`, or `infra-kit setup` from their terminal — and
stop. An older CLI has no `--feature` flag.

**cwd.** Every call runs from the main checkout — the directory Claude Code was launched in. If the
shell was `cd`'d elsewhere, `cd` back first (the CLI also accepts `-C <dir>`). The CLI refuses to
run from inside a linked worktree.

**Not by hand, not `EnterWorktree`.** A raw `git worktree add` is blocked by this repo's hooks, and
Claude Code's built-in `EnterWorktree` makes its own worktree under `.claude/worktrees/` that
infra-kit knows nothing about. Both skip `pnpm install`, the editor and Orca wiring, and the
`feature/` layout that `ik dev`, `list` and `remove` rely on.

## 1. What a feature worktree is

`--feature checkout-v2` means the branch `feature/checkout-v2`, checked out at
`<root>-worktrees/feature/checkout-v2`, with `pnpm install` already run in it. The `feature/`
prefix is optional in the name and added when missing; spaces become `-`.

- **New branch** (neither local nor on `origin`): cut from `origin/<base>` with **no upstream**, so a
  bare `git push` can never land on the base. The first push is `git push -u origin feature/<name>`.
- **Existing branch** (local, or on `origin` — someone's PR): checked out as it is. `--base` is not
  applied to it, and the preview says so.

`--base` is `dev` by default, or the repo's default branch (`main`) in a repo with no `dev`. `--base
main` and any release branch work too: `1.4.0`, `release/v1.4.0`, or a named release such as
`checkout-redesign`. A base missing from `origin` is refused before anything is
created.

## 2. Reading `$ARGUMENTS`

The bare token is the feature name. `--base <b>` is passed through. `--remove` means section 5
instead of section 3. With no name, ask the human for one — never invent it. Ask for a base only
when they say the feature belongs to a release; to offer the choices, list the open releases:

```
infra-kit release list --json --agent
```

## 3. Create: preview, approve, re-run

`worktrees add` is a mutating command. **Without `--yes` it creates nothing.**

**The preview run** is `infra-kit worktrees add --feature <name> [--base <b>] --json --agent`. Add
`--orca` only when the human wants the worktree opened in Orca panes. The run exits 2 and prints
`{"status": "confirmation_required", "message", "rerun": [...], …}`. **Exit 2 here is not a
failure.** `message` names each branch and what it starts from (`new branch from origin/dev`, or
`existing remote branch (base not applied)`). Show that to the human. This is the approval moment.

**The approved run** runs exactly `infra-kit <rerun joined by spaces>` once the human says go,
changing nothing. The host prompts the human with the full argv, `--yes` included. Never add
`--yes` to a call the human has not seen. For a different name or base, do a fresh preview run.
Do not edit `rerun` by hand.

**The result.** `createdWorktrees` lists the branches created, and `features[]` gives each
`branch`, `base` and `source` (`new` | `local` | `remote`). A name that already has a worktree is
skipped with nothing created. Report its path from `worktrees list` instead. A branch missing from
`createdWorktrees` failed in `git worktree add` or `pnpm install`; stderr says which.

## 4. After creating it

The work happens **in the new worktree**, not in this session's checkout. Hooks, the plugin and
`ik dev` ports are all per-directory. Tell the human the path. The cleanest next step is a new
Claude Code session launched in that directory (an Orca pane if they passed `--orca`). If they want
this session to carry on there instead, use absolute paths under the worktree and run its commands
with `cd <path> && …` in the same `Bash` call.

## 5. List and remove

```
infra-kit worktrees list --json --agent
```

`features` lists the `feature/*` worktree branches. `worktrees` lists the release ones.

Removal is `infra-kit worktrees remove --feature <name> --json --agent`: the same preview → approve →
`rerun` protocol as section 3. Every name must be an active feature worktree, or nothing is removed.
The **branch and its commits survive**. What is lost is everything gitignored in the directory: a
hydrated `.env`, `node_modules`, `dist`. git refuses a worktree with uncommitted or untracked files,
and that branch comes back in `failedWorktrees`. Relay it, and do not force it.

## 6. What not to do

- Do not create or remove a worktree with `git worktree` or `EnterWorktree`.
- Do not choose the feature name or a release base for the human.
- Do not run any call carrying `--yes` that is not the `rerun` of a preview the human saw.
- Do not read exit 2 on `confirmation_required` as a failure, and do not retry it with `--yes` on
  your own.
- Do not push the new branch or open a PR unless the human asks.
