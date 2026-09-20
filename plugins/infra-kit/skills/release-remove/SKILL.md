---
name: release-remove
description: Tear down one release through the infra-kit CLI — worktree, PR, both branches and the Jira fix version, behind the preview-then-approve protocol.
argument-hint: [<version|name>]
disable-model-invocation: true
allowed-tools: Bash(infra-kit release list --json*), Bash(infra-kit worktrees list --json*)
---

# release-remove — tearing down a release through infra-kit

CLI on PATH: !`zsh -c 'infra-kit version --json' 2>/dev/null || echo '{"error":"infra-kit not on PATH"}'`

The command is `infra-kit release remove`. Everything below is about running that command through
`Bash`, with `--json --agent` on every call.

**Version floor.** Read the block above first. On `{"error": …}`, or a `version` below `0.8.0`, tell
the human to update — `pnpm add -g infra-kit@latest`, or `infra-kit setup` from their terminal — and
stop. An older CLI answers none of the shapes below.

**cwd.** Every call runs from the directory Claude Code was launched in — the repo root. If the shell
was `cd`'d elsewhere, `cd` back first (the CLI also accepts `-C <dir>`).

Do not reproduce the command by hand. A `Bash` call running `git worktree remove`, `gh pr close`,
`git branch -D` or `git push --delete` reproduces none of the checks below and skips the approval in
section 2 — which is the only place a human approves the teardown. Nothing this command removes is
recreatable, and the Jira fix version it removes last has no undo at all.

## 1. What the command refuses

Every check below runs in **preflight, before the plan is shown** — the preview run in section 2
already runs them all, and the approved run repeats them before the first step. A refusal is
`{"status": "refused", …}`, exit 2, with nothing touched. When one arrives, relay it and stop: each
is a state only the human can clear. Once they have, start again from a fresh preview run.

- **The main repository checkout, not a linked worktree.** The command refuses outright from inside a
  linked worktree — the release's own included.
- **A clean working tree** in the main checkout. Uncommitted changes there are refused; the human
  commits or stashes.
- **The release has not shipped.** A release whose PR is `MERGED` is refused: its branch records
  the merge and its fix version is delivered work. Undoing a delivery is a revert of the merge
  commit on the base branch and a new release, never a removal.
- **Jira configured.** `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_PROJECT_ID` and `JIRA_TOKEN` (or
  `JIRA_API_TOKEN`) must be loaded for this session (`/infra-kit:session <env>` or `ik env-load` in
  the terminal that launched Claude Code); the CLI reads the session file on every run, so a load
  made a moment ago counts. The command removes the fix version, so it has to find it and check its
  state first. The `--skip-jira` exit the refusal names is a human's flag (section 3). This check
  runs before the existence check below, so with Jira unconfigured a mistyped version is refused
  with the Jira message, not the typo message.
- **The fix version is neither released nor archived.** The same class of signal as a merged PR:
  the release is history, not scaffolding. The human un-releases it in Jira or leaves the release
  alone; tearing down the branch and PR while keeping the fix version is `--skip-jira`, a human's
  flag (section 3).
- **Something named that version exists.** No worktree, no PR in any state, no local or remote
  branch and no fix version means a typo — check the spelling against `infra-kit release list`
  (open PRs only) or `infra-kit worktrees list`, both fenced in section 2. A release this command
  already tore down keeps a CLOSED PR, so a genuine re-run passes this check.
- **No other worktree holding the base branch, and a clean release worktree.** When the main
  checkout is on the release branch the command switches it to the base branch (`dev`, or `main` for
  a hotfix, read off the PR's base branch) before the local delete, and refuses on modified or untracked
  files inside the release worktree — the main checkout's status cannot see in there. The human
  commits or stashes inside the worktree.

**Attached issues block.** A fix version still set as `fixVersion` or `affectsVersion` on issues is
refused with both counts: deleting it would clear both fields on those issues with no way to
restore them. The exit is `--move-issues-to <name>`: an existing fix version name the human chooses,
exactly as Jira spells it; start a fresh preview run with `-v` and `--move-issues-to`. A name Jira
does not know is refused in preflight, before anything is touched. The other exit is the human
clearing the version from the issues in Jira, then a fresh preview run with `-v` alone.

## 2. Preview, approve, re-run

`release remove` is a mutating command. **Without `--yes` it executes nothing.**

**Before the preview run**, settle which release and show the human what exists. Both calls are
read-only and pre-approved:

```
infra-kit release list --json --agent
```

The open release PRs — `releases[]` with `version`, `type` and the Jira `description`.

```
infra-kit worktrees list --json --agent
```

The release worktrees on disk — `worktrees[]` with their paths and branches.

When the human already named a release, relay both lists' rows for it. When they have not, ask:
run `infra-kit release remove --json --agent` with no `-v` and it exits 2 with
`{"status": "argument_required", "argument": "version", "choices": [...]}` — the same rows the CLI's
own picker draws (label, value, the type and Jira description). Put **every** `choices` row into
`AskUserQuestion` as it is; the human's pick is the `-v`. No `choices` on the payload (the
enumeration failed, or there are no open release PRs) means ask in prose against the
`release list` rows above. Never pick for them and never guess.

**The preview run** — `infra-kit release remove -v <version> --json --agent`, plus
`--move-issues-to <name>` only when the human named one. It runs every check in section 1, then
exits 2 and prints one JSON object:
`{"status": "confirmation_required", "message", "plan", "rerun": [...], "agentMode"}`.

**Exit 2 here does not mean the call failed.** Nothing was removed, nothing was closed, nothing was
deleted. An agent that reads it as a failure — and gives up, or retries with `--yes` on its own, or
falls back to `git` — has skipped the human approval this protocol exists for. Do none of those.

The payload carries two things you need:

- `plan` (and `message`) — what the CLI resolved: the worktree path, the PR, the branches and their
  tips, the fix version and its issue counts. **Show it to the human** next to the listed rows, and
  say in so many words that this also removes the Jira fix version and that that part cannot be
  undone. This is the approval moment; there is no other one.
- `rerun` — the argv of the same call with `--yes` appended, one element per token.

**The approved run** — once the human says go, run exactly `infra-kit <rerun joined by spaces>`,
quoting any element that contains whitespace and changing nothing else. That `Bash` call is
deliberately not pre-approved: the host prompts the human with the full argv, `--yes` included, and
that prompt is the second half of the approval. Never add `--yes` to a call the human has not seen.

If the human names a different release, build a new preview run with the new `-v`. Do not edit
`rerun` by hand — a changed argument deserves a fresh plan.

**The other exits.** `{"status": "refused"}` (exit 2) — section 1; relay and stop.
`{"status": "partial_failure"}` (exit 1) — a step failed after earlier ones ran; the payload is the
residue report (section 4), relay it whole. Non-JSON stdout, or exit 1 with no JSON, is a crash:
stop and show stderr.

## 3. What goes in `-v`

`-v` names the release; omit it to be offered the picker (section 2). Named, it is a semver such as
`1.64.0` (`v1.64.0` is also accepted) or a release name such as `checkout-redesign`, and it resolves
to `release/v<semver>` or `release/<name>`. One release per call — repeat the whole protocol for
another; there is no batch form, because a multi-target run would have to keep going past a failure
and lose the residue report.

The picker lists open PRs only, so a partly torn-down release with a closed PR is not in it;
`worktrees list` may still show its directory, and `-v` passed by hand is the way to finish it.

### Reading `$ARGUMENTS`

The `/infra-kit:release-remove` skill hands you `$ARGUMENTS` verbatim, and its argument hint is
`[<version|name>]`. The bare token → `version`, passed as `-v <token>` as typed. The CLI's
`--move-issues-to <name>` → passed through, only when the human wrote it. `--skip-jira` has no field
you may pass: under agent mode the fix version is checked and removed with the release, and the flag
is refused because a run that skipped it would leave a live fix version behind with nothing in the
result pointing at it. If the human asks for it, do not translate the request into anything — say it
is `infra-kit release remove --skip-jira` from their own configured shell, and stop.

If `$ARGUMENTS` is empty, omit `-v` and let the picker do the asking (section 2).

## 4. What one removal does

In order: remove the release worktree (and close its Orca terminals), strip the folder
from the Cursor workspace, close the PR with a comment, delete the
local branch (switching the main checkout to the base branch first when it is on the release), and
delete the branch on `origin`. The worktree goes first because git will not delete a branch that a
worktree still has checked out; the rest follow in the order that leaves the most repairable
residue if one fails.

**The Jira fix version is removed** — step 6, last, because it is the one step with no undo. The
issue counts are re-read right before it, and a change since preflight aborts with nothing in Jira
touched; the residue report then names the re-run. The result reports `jira: "removed"` with the
version's `id`, `name` and `url` in `jiraVersion` (keep them in your reply: the id is what an
Atlassian support request needs); `jira: "absent"` and `jiraVersion: null` when Jira knew none.

Three consequences worth stating before the approved run:

- **What is lost with the worktree directory** is everything gitignored inside it: a hydrated `.env`
  of Doppler secrets (re-fetch with `ik env-load`), `node_modules` and `dist`. If the human meant
  to keep uncommitted work there, this is the moment to stop.
- **Resumable.** Every step is a verified no-op when its artefact is already gone, so a re-run
  finishes a partial teardown — the result says `absent` or `already-closed` for the steps that
  found nothing. A step that fails yields a residue report naming the completed steps, the
  `git branch <branch> <sha>` handle that restores the branch, and the re-run that finishes; relay
  it whole.
- **A merge in the window.** The approved run re-runs every check in section 1 before the first
  step, so a PR merged between the preview and the approval is refused with nothing touched. Only a
  merge during the approved run itself reaches the PR step's own re-probe — after the worktree is
  already gone — and the residue report then says what is left.

`localTipSha` and `remoteTipSha` in the result are the tips before deletion — the only handles that
restore the branch. Keep them in your reply.

## 5. What not to do

- Do not work around a refusal with `git` or `gh`. Every refusal in section 1 is a state only the
  human can clear.
- Do not translate `--skip-jira` into a call, and do not remove, release or reassign the fix
  version yourself by any other route. Do not pass `--move-issues-to` on your own initiative — only a
  name the human gave you.
- Do not pick the release for the human — not the newest, not the only one. The picker is theirs;
  when there is none, ask against the `release list` rows.
- Do not read exit 2 on a `confirmation_required` payload as a failure. See section 2.
- Do not run any `infra-kit` call carrying `--yes` that is not the `rerun` of a plan the human saw,
  and never re-run one after a section 1 refusal. The refusal is the answer; the human clears the
  state, then it is a fresh preview run.
- Do not report the release as removed on the strength of exit 0. Read `worktree`, `pr`,
  `localBranch`, `remoteBranch` and `jira` in the result and say what each one did.
