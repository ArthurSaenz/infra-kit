---
name: merge-dev
description: Merge origin/dev into open release branches through infra-kit's release merge-dev, including an opt-in agent hand-off that resolves real conflicts in a CLI-owned worktree, behind the preview-then-approve protocol.
argument-hint: [--all | <version,...>] [--verify <cmd>]
disable-model-invocation: true
allowed-tools: Bash(infra-kit release list --json*)
---

# merge-dev — merging dev into release branches, with agent-assisted conflict resolution

CLI on PATH: !`zsh -c 'infra-kit version --json' 2>/dev/null || echo '{"error":"infra-kit not on PATH"}'`

Git on PATH: !`zsh -c 'git --version' 2>/dev/null || echo '{"error":"git not on PATH"}'`

The command is `infra-kit release merge-dev`. Everything below is about running that command through
`Bash`, with `--json --agent` on every call.

**Version floor.** Read both lines above first. On `{"error": …}` from either, or an `infra-kit
version` below `0.12.0`, or a `git --version` below `2.42` (git needs to be that new for
`AUTO_MERGE`, which the resolution hand-off reads per worktree), tell the human to update —
`pnpm add -g infra-kit@latest` or `infra-kit setup` for the CLI, their system package manager for
git — and stop. An older CLI or git answers none of the shapes below.

**cwd.** Every call runs from the directory Claude Code was launched in — the repo root. If the
shell was `cd`'d elsewhere, `cd` back first (the CLI also accepts `-C <dir>`).

Do not reproduce any step with `git merge`, `git commit`, `git push` or `gh`. Those reproduce none
of the mechanical checks below — the scope check against `AUTO_MERGE`, the atomic push, the
recorded-dev reclassify — and skip the approvals in sections 2 and 6, which are the only places a
human approves what lands on a shared branch.

## 1. What this adds to the plain command

The plain run fetches `origin/dev`, merges it into each selected regular release branch inside one
scratch worktree, then pushes atomically. This skill adds three modes, mutually exclusive with each
other and with `--dry-run`:

- `--keep-conflicts` — after pushing every clean branch, hand off each conflicted branch to a
  CLI-owned resolution worktree instead of discarding it.
- `--continue` — resume a hand-off: stage, scope-check, merge the lockfile, verify, and (on
  `--yes`) commit and push.
- `--abort` — delete a hand-off's worktree and state, touching nothing on any branch.

**Push grouping.** Clean branches are pushed at the first approval (section 2); resolved branches are
pushed later, as their own atomic set (section 6). A hard conflict on one branch never delays the
others.

### Reading `$ARGUMENTS`

The `/infra-kit:merge-dev` skill hands you `$ARGUMENTS` verbatim; its argument hint is
`[--all | <version,...>] [--verify <cmd>]`.

- `--all` → the CLI's own `--all` — every open regular release branch.
- `<version,...>` → the CLI's `--versions <list>`, a comma-separated list of the labels `infra-kit release list` shows.
- `--verify <cmd>` → the CLI's `--continue --verify=<cmd>` — an extra command that runs, under `--continue` only, after the mandatory frozen-lockfile install check and before any commit.

If `$ARGUMENTS` is empty, ask which branches in prose. Before asking, show what already exists
(read-only and pre-approved):

```
infra-kit release list --json --agent
```

Should a call reach the CLI with neither `--all` nor `--versions`, it exits 2 with
`{"status": "argument_required", "argument", "choices"?}`; relay it the same way `release-create`
and `release-remove` do — ask in prose against the rows above, then build the call.

## 2. Preview and approval 1 — `--keep-conflicts`

**Preview.** Run `infra-kit release merge-dev (--versions X | --all) --keep-conflicts --json
--agent`. It exits 2 with `{"status": "confirmation_required", "message", "plan", "rerun", …}`.
Show `plan.entries` to the human as a table, one row per branch: **clean**, **lockfile-only**,
**code conflict** with its `conflictPaths`, **hook-failed/error**, and **skipped** (hotfixes,
title/base mismatches). This is the only place the human approves what is about to be pushed and
handed off — do not skip it.

**Approval 1.** Once the human says go, run exactly the `rerun` given, `--yes` appended, unchanged.
This pushes every clean branch atomically and, for each conflicted branch, creates a resolution
worktree at `<root>-worktrees/merge-dev/<branch-slug>` — detached, stopped mid-merge, with a state
file recording `baseSha`, `devSha` and `conflictPaths`.

**An exit 1 with a parseable JSON `results` here is the expected hand-off, not a failure.** The
first `--yes` under `--keep-conflicts` exits 1 on purpose whenever any branch was handed off, so CI
still sees an incomplete run. Read the `results` and continue to section 3/4; only non-JSON stdout,
or exit 1 with no JSON at all, is a real crash — stop and show stderr.

**Resolution states**, per conflicted branch's `resolution.state`:

| State           | Meaning                                                                               | What you do                                                                                             |
| --------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `needs-agent`   | A real conflict outside the lockfile.                                                 | Resolve it — section 4.                                                                                 |
| `lockfile-only` | The only conflict is `pnpm-lock.yaml`.                                                | No editing needed; `--continue` merges it deterministically — section 4 still applies for the approval. |
| `exists`        | A state file for this branch already exists — a previous hand-off was never finished. | Do not hand off again. Offer the human `--continue` or `--abort` for it.                                |

## 3. Relay-only outcomes

Do not act on `hook-failed` or `error`, or on a **clean** branch's `push-aborted` from approval 1 —
there is no retry for any of them. Relay the CLI's `reason` verbatim to the human, together with the
Option D recipe (section 9).

A **resolved** branch's `push-aborted` from approval 2 is different: its merge commit is already
made and approved, and the same `--continue` rerun resumes from it and pushes that same commit.
Offer the human that rerun; do not treat it as relay-only.

## 4. Resolving conflicts in the worktree

Before editing, run the read-only `git -C <worktreePath> rev-parse -q --verify AUTO_MERGE`. If it
is missing, the worktree's git is below the floor this hand-off needs — relay that and fall back to
Option D (section 9) for this branch.

Inside `worktreePath`, the agent:

- edits or deletes **only** paths listed in `conflictPaths`. It never edits any other file, and it
  never touches `pnpm-lock.yaml` — the CLI merges the lockfile deterministically inside `--continue`
  by writing dev's side (`git show :3:pnpm-lock.yaml`) and re-running `pnpm install --lockfile-only
--ignore-scripts`. **Never run `pnpm` yourself on a lockfile that still has conflict markers** — it
  does not merge the markers, it silently re-resolves the whole tree from scratch, which can bump
  ranged dependencies with nobody asking for it.
- runs **no mutating git command** — no `add`, `commit`, `merge --continue`, `checkout --`, `reset`,
  `stash`, or anything that changes the index, `HEAD` or a ref. The CLI stages, commits and pushes;
  the agent only edits files on disk.
- may read for context, and only read: `git show :1:<path>` / `:2:<path>` / `:3:<path>` (ours/theirs/
  base), `git log origin/dev -- <path>`, `git log <baseSha> -- <path>`, `git diff`.
- resolves **hunk by hunk** and never takes one side wholesale on a real code conflict.
- resolves a modify/delete conflict by explicitly keeping or removing the file — say which, and why.
- writes one line per file saying which side won each hunk and why.
- **stops and asks the human in prose** whenever a hunk needs a product decision, rather than
  guessing.
- **hands back** to the human after 2 blocked `--continue` previews on the same branch, or as soon
  as one file needs more than about 15 hunks resolved. Say so plainly and stop, rather than grinding.

Editing outside the Claude Code cwd prompts for permission on every write. Warn the human up front
and suggest `/add-dir <root>-worktrees/merge-dev` once, rather than approving every file one at a
time.

## 5. Check — `--continue` preview

Run `infra-kit release merge-dev --continue --versions <b…> --json --agent` after each round of
edits.

- `unmerged-paths`, `markers-remaining`, `out-of-scope-edit` or `verify-failed`: the agent fixes the
  named paths, within the budget from section 4.
- `verify-mutated-tree`, `parents-mismatch`, `tree-changed` or `git-too-old`: relay the block to the human and
  suggest either `--abort` plus a fresh `--keep-conflicts` hand-off, or Option D (section 9). Do not
  keep retrying these — they mean the worktree's state no longer matches what the CLI can safely
  push.

## 6. Approval 2 and the approved run

Once `--continue`'s preview is clean for a branch (lockfile-only branches reach this with no editing
at all), show the human, per branch:

- `diffStat` — the size of what changed.
- The agent's own per-file lines from section 4 (skip this for `lockfile-only`).
- `resolutionDiff` — the index diffed against `AUTO_MERGE`, with any hunk `rerere` already
  pre-resolved labelled **"rerere (recorded resolution)"**, never as the agent's own work. When it is
  truncated, fall back to `git -C <worktreePath> diff --cached AUTO_MERGE` for the full diff.
- `treeSha` — the exact tree this approval covers. The preview's `rerun` carries it as
  `--tree <branch>=<treeSha>`; `--yes` commits a branch only if its resolved tree still equals it.
- `lockfileMerged` and `lockfileDiffStat` — whether the CLI rebuilt `pnpm-lock.yaml` from dev, and
  its size against dev (`vsDev`, which should show only what the release branch added) and against
  the base branch (`vsBase`).
- The verify result (the mandatory frozen-lockfile install, plus `--verify=<cmd>` if one was given).

This is the second and last approval — it is bound to the exact tree that will be committed and
pushed. On "go", run the `rerun` verbatim (`--continue --tree … --yes`). Never add `--yes` to a
call the human has not seen this diff for, and never edit the `--tree` value: a rerun of an older
preview reports `tree-changed` and commits nothing.

**`tree-changed` on the approved run** means the tree moved after the human saw it: an edit after
the preview (preview again, and get approval again), or a commit hook that rewrote the approved
tree. In the hook case the commit already exists with a tree nobody approved; it is never pushed,
and every later `--continue` blocks it as `tree-changed`. Relay that and offer `--abort` plus a
fresh `--keep-conflicts` hand-off.

## 7. `--abort`

Confirm-gated like the other two modes: preview which resolution worktrees and state files would be
removed, get approval, then run the `rerun` verbatim. It deletes the worktree and the state file for
each selected branch and touches nothing else — no commit, no push, no ref move.

## 8. Report

Report as one markdown table, one row per branch, including skipped rows:

| Branch           | Result         | Commit / reason                   | Next step              |
| ---------------- | -------------- | --------------------------------- | ---------------------- |
| `release/v1.2.3` | ✅ pushed      | `a1b2c3d`                         | —                      |
| `release/v1.3.0` | ⏸ blocked      | `markers-remaining`: `src/app.ts` | fix, then `--continue` |
| `release/v1.4.0` | ❌ hook-failed | the hook's first stderr line      | `--abort`, or Option D |
| `release/v1.1.9` | ⏭ skipped      | hotfix (targets main)             | —                      |

`Result` is the row's own `status` from `results` (`merged`/`fast-forward`/`up-to-date` count as
pushed or already there), `Commit / reason` is the short `mergeSha` or the CLI's reason verbatim, and
`Next step` is `--continue`, `--abort` or the Option D recipe. Below the table, one line of totals.
Never report a branch as merged on the strength of exit 0 alone; read its own row in `results`.

## 9. Option D — the manual fallback

Use this when the CLI refuses a hand-off outright (`git-too-old`, a repeated `verify-mutated-tree`/
`parents-mismatch`, or an edit that genuinely needs a file outside `conflictPaths`, which v1 always
refuses rather than widening scope). It needs no CLI change and no agent worktree:

Every step is the **human's**, in their own terminal. The agent does not run any of them.

1. The human runs `infra-kit worktrees add <release>` to get a normal (non-detached) worktree for
   the release branch.
2. In that worktree, the human merges `origin/dev`, resolves the conflicts and commits.
3. The human pushes the release branch themselves.

The hand-merge reaches origin only when the human pushes it. Until then, no `release merge-dev` run
knows about it.

## 10. What not to do

- Do not run `git merge`, `git commit`, `git push` or `gh` yourself for any part of this flow —
  section 1's rule.
- Do not read an exit 2 `confirmation_required`, or an exit 1 hand-off with JSON, as a failure. See
  sections 2 and 3.
- Do not edit any path outside `resolution.conflictPaths`, and never edit `pnpm-lock.yaml` yourself.
- Do not run `pnpm install` (or anything else) inside a resolution worktree while `pnpm-lock.yaml`
  still carries conflict markers.
- Do not retry `hook-failed`, `git-too-old`, or a clean branch's `push-aborted` — relay them. A
  resolved branch's `push-aborted` resumes through its own `--continue` rerun (section 3).
- Do not run any `infra-kit … --yes` call that is not the `rerun` of a plan or diff the human just
  saw.
- Do not keep resolving past the section 4 budget — hand back to the human instead.
