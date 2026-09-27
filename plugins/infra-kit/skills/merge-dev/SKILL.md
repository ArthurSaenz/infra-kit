---
name: merge-dev
description: Merge origin/dev into open release branches through infra-kit's release merge-dev, autonomously — clean merges pushed once they pass qa, real conflicts resolved and qa-verified by the agent in CLI-owned worktrees, with one human approval before any agent-resolved merge is pushed.
argument-hint: [<version,...>] [--verify <cmd>]
disable-model-invocation: true
allowed-tools: Bash(infra-kit release list --json*)
---

# merge-dev — merging dev into release branches, autonomously

CLI on PATH: !`zsh -c 'infra-kit version --json' 2>/dev/null || echo '{"error":"infra-kit not on PATH"}'`

Git on PATH: !`zsh -c 'git --version' 2>/dev/null || echo '{"error":"git not on PATH"}'`

Root `qa` script: !`node -e 'const s=require("./package.json").scripts||{};console.log(s.qa?"present":"absent")' 2>/dev/null || echo absent`

The command is `infra-kit release merge-dev`. Everything below is about running that command through
`Bash`, with `--json --agent` on every call.

**Version floor.** Read the lines above first. On `{"error": …}` from either, or an `infra-kit
version` below `0.11.15`, or a `git --version` below `2.42` (git needs to be that new for
`AUTO_MERGE`, which the resolution hand-off reads per worktree), tell the human to update —
`pnpm add -g infra-kit@latest` or `infra-kit setup` for the CLI, their system package manager for
git — and stop.

**cwd.** Every call runs from the directory Claude Code was launched in — the repo root. If the
shell was `cd`'d elsewhere, `cd` back first (the CLI also accepts `-C <dir>`).

Do not reproduce any step with `git merge`, `git commit`, `git push` or `gh`. Those skip the
mechanical checks the CLI makes — the scope check against `AUTO_MERGE`, the tree binding, the atomic
push, the recorded-dev reclassify.

## 0. The autonomy contract

The human invoking this skill is the go-ahead for the whole run. You drive it end to end without
asking, with exactly **one** stop for the human:

- **Clean merges** (git merged them with no conflict) are pushed without asking, but only after the
  verify command (section 1) passes on each one. A branch that fails verify is not pushed.
- **Conflicted branches** are handed off, resolved by you, and verified by you in a loop until
  `--continue`'s preview is clean. Nothing you authored is pushed until the human has seen it.
- **The one stop — approval 2 (section 6):** a single table of every resolved branch, its
  resolution diff and its passing verify. The human's "go" pushes them all.

Do not ask which branches, do not ask before the first run, and do not stop mid-resolution to ask
about a hunk: resolve it on your best judgement and flag it for approval 2 (section 4).

## 1. Arguments and the verify command

The skill hands you `$ARGUMENTS` verbatim.

- **No version → `--all`.** Every open regular release branch.
- `<version,...>` → the CLI's `--versions <list>`. Always pass `--all` or `--versions`: without
  either the CLI exits 2 with `argument_required`.
- `--verify <cmd>` → overrides the default verify below.

To see which release labels exist (read-only and pre-approved):

```
infra-kit release list --json --agent
```

**Verify command (`V`).** When `$ARGUMENTS` has no `--verify`: if the "Root `qa` script" line above
says `present`, `V` is `pnpm run qa`; otherwise `V` is empty and only the CLI's built-in
frozen-lockfile install check runs. It is passed differently to the two phases, because the
clean-merge phase runs in a fresh scratch checkout with no `node_modules`, while `--continue`
installs before verifying on its own:

- first run (section 2): `--verify='pnpm install --frozen-lockfile && V'` (or bare `--verify` when
  `V` is empty);
- every `--continue` (sections 5–6): `--verify='V'` (omitted when `V` is empty).

Pass the same `--verify` value on every `--continue` call of a run: the CLI reuses a passing verify
only for the same tree and the same command, so changing it re-runs the whole suite.

## 2. The first run — clean merges pushed, conflicts handed off

1. **Preview.** `infra-kit release merge-dev (--all | --versions X) --keep-conflicts --verify='…'
--json --agent` exits 2 with `{"status": "confirmation_required", "plan", "rerun", …}`. Print
   `plan.entries` as a short table for the human's information — **clean**, **lockfile-only**,
   **code conflict** with its `conflictPaths`, **hook-failed/error**, **skipped** — and continue
   without waiting.
2. **Run.** Execute exactly the `rerun` given, `--yes` appended, unchanged. This verifies and
   atomically pushes every clean branch that passed, and for each conflicted branch creates a
   resolution worktree at `<root>-worktrees/merge-dev/<branch-slug>` — detached, mid-merge, with a
   state file recording `baseSha`, `devSha` and `conflictPaths`.
3. **Exit 1 with parseable JSON `results` is the expected hand-off, not a failure** — the CLI exits 1
   whenever a branch was handed off, so CI sees an incomplete run. Only non-JSON stdout, or exit 1
   with no JSON, is a crash: stop and show stderr.

Nothing in section 2 is retried. A clean branch that failed verify, `hook-failed`, `error` or a
clean `push-aborted` goes into the final report (section 8) with the CLI's `reason` verbatim.

**Resolution states**, per handed-off branch's `resolution.state`:

| State           | Meaning                                                  | What you do                                                                |
| --------------- | -------------------------------------------------------- | -------------------------------------------------------------------------- |
| `needs-agent`   | A real conflict outside the lockfile.                    | Resolve it — section 4.                                                    |
| `lockfile-only` | The only conflict is `pnpm-lock.yaml`.                   | No editing; go straight to section 5 — the CLI merges the lockfile itself. |
| `exists`        | A hand-off for this branch was left unfinished by a run. | Resume it with `--continue` (section 5) as if you had just handed it off.  |

## 3. Permissions, once

Edits inside `<root>-worktrees/merge-dev/` are outside the launch directory, so each write prompts.
If any branch is `needs-agent`, tell the human once, before the first edit, to run
`/add-dir <root>-worktrees/merge-dev` (with the real path), then carry on.

## 4. Resolving conflicts in the worktree

Before editing, run the read-only `git -C <worktreePath> rev-parse -q --verify AUTO_MERGE`. If it
is missing, that worktree's git is below the floor — report the branch as blocked with Option D
(section 9) and move to the next branch.

Inside `worktreePath`:

- Edit or delete **only** paths in `conflictPaths`, and never `pnpm-lock.yaml` — the CLI rebuilds it
  from dev's side inside `--continue`. **Never run `pnpm` yourself while the lockfile has conflict
  markers**: pnpm silently re-resolves the whole tree and can bump ranged dependencies.
- Run **no mutating git command** — no `add`, `commit`, `merge --continue`, `checkout --`, `reset`,
  `stash`. The CLI stages, commits and pushes; you only edit files on disk.
- Read freely for context: `git show :1:<path>` / `:2:<path>` / `:3:<path>` (base/ours/theirs),
  `git log origin/dev -- <path>`, `git log <baseSha> -- <path>`, `git diff`, and the surrounding code
  and tests.
- Resolve **hunk by hunk**; on a real code conflict never take one side wholesale. Prefer keeping
  both intents: the release branch's fix and dev's change. A modify/delete conflict is resolved by
  explicitly keeping or removing the file.
- Keep one line per file for approval 2: which side won each hunk and why.
- **A hunk that needs a product decision** (both sides changed behaviour in incompatible ways): pick
  the reading most consistent with the release branch's purpose, and mark the file
  **⚠ needs review** with the question in one sentence. Do not stop to ask.

Work through every `needs-agent` branch before approval 2; branches are independent, so one that
stays blocked never holds the others back.

## 5. The fix loop — `--continue` preview

After each round of edits, run `infra-kit release merge-dev --continue --versions <b…> --verify='V'
--json --agent`. It stages, scope-checks, rebuilds the lockfile, runs the install check and `V`, and
exits 2 with a clean preview or a `blocked` row. Act on the code:

- `unmerged-paths`, `markers-remaining`: finish the named paths, preview again.
- `verify-failed`: read `reason` (the tail of the failing command's output). When the failure is in
  a conflicted path, or caused by how you resolved one (a type error, a lint error, a failing test
  touching the merged code), fix it in the conflicted paths and preview again. When the fix would
  need a file outside `conflictPaths`, the hand-off cannot carry it: stop this branch and report it
  as blocked with the failing output and Option D.
- `out-of-scope-edit`: you touched a path outside `conflictPaths` — revert that edit by hand (edit
  the file back; no git command), preview again.
- `tree-changed` on `pnpm-lock.yaml` saying **the registry moved**: the CLI already rebuilt it —
  preview again.
- `verify-mutated-tree`, `parents-mismatch`, any other `tree-changed`, `git-too-old`: stop this
  branch; report it with `--abort` plus a fresh hand-off, or Option D, as the next step.

**Budget:** at most **5** blocked previews per branch. On the 6th, stop that branch and report it
blocked with the last `blocked` row — do not grind.

A preview that is clean has already run `V` on that exact tree; the approved run reuses that result
(`verify.reused: true`) instead of running the suite again.

## 6. Approval 2 — the one stop

When every handed-off branch is either clean in its last preview or stopped, show the human **one**
message:

1. A table, one row per clean-preview branch: `diffStat`, the verify command and ✅, `lockfileMerged`
   with `lockfileDiffStat` (`vsDev` should show only what the release branch itself added), and the
   count of ⚠ files.
2. Under it, per branch: your per-file lines from section 4, with every **⚠ needs review** question
   first, and the `resolutionDiff` — hunks `rerere` pre-resolved labelled **"rerere (recorded
   resolution)"**, never as your own work. When `resolutionDiffTruncated`, say so and give the
   `git -C <worktreePath> diff --cached AUTO_MERGE` to read the rest.
3. The stopped branches, one line each, so the human sees the whole run in one place.

Ask once: push all, push some (they name which), or change something. On "go", run each clean
branch's `rerun` verbatim (`--continue --tree <branch>=<treeSha> … --yes`), batched as the CLI gave
it. Never edit a `--tree` value, and never run `--yes` for a tree the human has not seen.

If the human asks for changes, edit, return to section 5, and come back here with a fresh preview —
the new tree needs its own approval.

**`tree-changed` on the approved run** means the tree moved after the human saw it: preview again
and bring it back to approval 2. When its reason says a commit hook rewrote the approved tree, that
commit is never pushable — report it with `--abort` plus a fresh hand-off.

A **resolved** branch's `push-aborted` keeps its approved commit: the same `--continue` rerun resumes
and pushes that commit. Run it once without asking again; report if it aborts a second time.

## 7. `--abort`

Only on the human's request, or as the recorded next step in the report — never on your own
initiative. It is confirm-gated: run the preview, show which worktrees and state files go, and run
the `rerun` with `--yes` on their "go". It deletes the worktree and state file only — no commit,
push or ref move.

## 8. Report

End with one markdown table, one row per branch, including skipped rows:

| Branch           | Result               | Commit / reason                        | Next step          |
| ---------------- | -------------------- | -------------------------------------- | ------------------ |
| `release/v1.2.3` | ✅ pushed (clean)    | `a1b2c3d`                              | —                  |
| `release/v1.2.4` | ✅ pushed (resolved) | `e4f5a6b` · 2 files, 1 ⚠               | —                  |
| `release/v1.3.0` | ⏸ blocked            | `verify-failed`: needs `src/other.ts`  | Option D           |
| `release/v1.4.0` | ❌ verify-failed     | `pnpm run qa` — the first failing line | fix on dev, re-run |
| `release/v1.1.9` | ⏭ skipped            | hotfix (targets main)                  | —                  |

`Result` is the row's own `status` from `results` (`merged`/`fast-forward`/`up-to-date` count as
pushed or already there). Below the table, one line of totals. Never report a branch as merged on
the strength of exit 0 alone; read its own row in `results`.

## 9. Option D — the manual fallback

For a branch the hand-off cannot carry (`git-too-old`, a repeated `verify-mutated-tree` /
`parents-mismatch`, or a fix that needs a file outside `conflictPaths`). Every step is the
**human's**, in their own terminal:

1. `infra-kit worktrees add <release>` for a normal worktree of the release branch.
2. Merge `origin/dev` there, resolve, commit.
3. Push the release branch.

## 10. What not to do

- Do not run `git merge`, `git commit`, `git push` or `gh` for any part of this flow.
- Do not read exit 2 `confirmation_required`, or exit 1 with hand-off JSON, as a failure.
- Do not edit outside `resolution.conflictPaths`, and never edit `pnpm-lock.yaml`.
- Do not run `pnpm` in a resolution worktree while `pnpm-lock.yaml` carries conflict markers.
- Do not run `--yes` on a `--continue` whose tree the human has not approved in section 6.
- Do not retry `hook-failed`, `git-too-old`, or a clean branch's `push-aborted` or verify failure.
- Do not exceed the section 5 budget.
