---
name: release-remove
description: Tear down one release branch through the infra-kit MCP server; the Jira fix version is left for a human.
argument-hint: [<version|name>]
disable-model-invocation: true
---

# release-remove — tearing down a release through infra-kit

The tool is `mcp__plugin_infra-kit_infra-kit__release-remove`. Everything below is about calling that tool.
If `mcp__plugin_infra-kit_infra-kit__*` tools are absent this is a subdirectory or legacy session — say so and stop.

Do not shell out. A `Bash` call running `git worktree remove`, `gh pr close`, `git branch -D` or
`git push --delete` reproduces none of the checks below and bypasses the confirm gate in
section 2 — which is the only place a human approves the teardown. Nothing this tool removes is
recreatable.

## 1. What the tool refuses

**The first call checks nothing about the release.** Every refusal below comes back from call 2,
after the human has approved and before anything is touched. When one does, relay it and stop:
each is a state only the human can clear. Once they have, start again from call 1 — never retry
call 2 with the old token.

- **The main repository checkout, not a linked worktree.** The tool refuses outright from inside a
  linked worktree — the release's own included.
- **A clean working tree** in the main checkout. Uncommitted changes there are refused; the human
  commits or stashes.
- **The release has not shipped.** A release whose PR is `MERGED` is refused: its branch records
  the merge and its fix version is delivered work. Undoing a delivery is a revert of the merge
  commit on the base branch and a new release, never a removal.
- **Jira configured.** `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_PROJECT_ID` and `JIRA_TOKEN` (or
  `JIRA_API_TOKEN`) must be in the environment the MCP server was launched with, even though the
  tool never touches the fix version — it still has to find it and check its state. A server
  spawned by a host does not inherit an `ik env-load`ed shell, so an unconfigured Jira is an
  ordinary refusal here. The exit the refusal names, `infra-kit release remove --skip-jira`, is a
  CLI flag a human runs from a configured shell; the tool has no equivalent. This check runs
  before the existence check below, so with Jira unconfigured a mistyped version is refused with
  the Jira message, not the typo message.
- **The fix version is neither released nor archived.** The same class of signal as a merged PR:
  the release is history, not scaffolding. The human un-releases it in Jira or leaves the release
  alone.
- **Something named that version exists.** No worktree, no PR in any state, no local or remote
  branch and no fix version means a typo — check the spelling against
  `mcp__plugin_infra-kit_infra-kit__gh-release-list` (open PRs only). A release this tool already
  tore down keeps a CLOSED PR, so a genuine re-run passes this check.
- **No other worktree holding the base branch, and a clean release worktree.** When the main
  checkout is on the release branch the tool switches it to the base branch (`dev`, or `main` for
  a hotfix, read off the PR title) before the local delete, and refuses on modified or untracked
  files inside the release worktree — the main checkout's status cannot see in there. The human
  commits or stashes inside the worktree.

**Attached issues do not block.** A fix version still set as `fixVersion` or `affectsVersion` on
issues is reported, not refused: that guard protects a delete which never runs over MCP, and the
version is left for the human either way. A tool description that lists it among the refusals is
stale; this body is what holds.

## 2. The two-call confirm protocol

`release-remove` is gated. **The first call never executes anything — and inspects nothing.**

**Before call 1**, show the human what exists: call `mcp__plugin_infra-kit_infra-kit__gh-release-list`
(read-only; the open release PRs with version and type) and
`mcp__plugin_infra-kit_infra-kit__worktrees-list` (read-only; the release worktrees on disk) and
relay their rows for the release in question. The host may prompt for permission on those two
calls; that prompt is not a tool refusal — answer it and go on. This is the only inventory the
human will get before approving: the gate below does not carry one.

**Call 1** — send `version` with no `confirm` and no `confirmToken`. The result is a gate payload,
`{"status": "confirmation_required", ...}`, and it carries `"isError": true`.

**That `isError` does not mean the call failed.** It is set because the payload is a gate rather
than the tool's declared output. Nothing was removed, nothing was closed, nothing was deleted. An
agent that reads it as a failure — and gives up, or retries, or falls back to `Bash` — has skipped
the human approval this protocol exists for. Do none of those.

The gate payload carries two things you need:

- `resolvedArgs` — exactly the arguments the server bound. It carries `version` and nothing else:
  no worktree path, no PR number, no branch tips, no issue counts — those arrive only in the
  result of call 2. **Show `resolvedArgs` to the human** next to the rows you listed before call 1.
  This is the approval moment; there is no other one.
- `confirmToken` — an HMAC bound to the tool name and to those exact arguments. It expires 600
  seconds after it is minted.

**Call 2** — repeat the **same arguments**, unchanged, plus `"confirm": true` and the
`confirmToken` from call 1. This is where section 1's checks run, all of them, before the first
step.

Change any argument between the two calls and round 2 comes back as
`{"status": "confirmation_refused", "reason": "mismatch"}`. That is terminal — it is not a second
gate. The other reasons are `absent`, `malformed`, `mac`, `expired` and `bind`, and every one of
them recovers the same way: call again **without** `confirm` to mint a fresh gate, then re-call
with those arguments and the new token. Never retry call 2 with the old token.

If the human names a different release, go back to call 1 with the new `version`. Do not edit the
arguments and reuse the token — that is exactly what `mismatch` refuses.

## 3. What goes in `version`

`version` is required and is the whole input: a semver such as `"1.64.0"` (`"v1.64.0"` is also
accepted) or a release name such as `"checkout-redesign"`. It resolves to `release/v<semver>` or
`release/<name>`. One call removes exactly one release — there is no batch form, because a
multi-target run would have to keep going past a failure and lose the residue report.

There is no picker. The CLI lets a human choose from the open release PRs; the tool has no TTY, so
a missing `version` is refused. If the human did not say which release, ask — the
`gh-release-list` rows from section 2 are what to ask against. It lists open PRs only, so a partly
torn-down release with a closed PR is not in it; `worktrees-list` may still show its directory.

### Reading `$ARGUMENTS`

The `/infra-kit:release-remove` skill hands you `$ARGUMENTS` verbatim, and its argument hint is
`[<version|name>]`. The bare token → `version`, as typed. There are no flags: the CLI's
`--skip-jira` and `--move-issues-to` have **no tool field**. A `skipJira` or `moveIssuesTo` key you
add anyway is stripped by the server before the tool sees it — it will not appear in
`resolvedArgs`, and nothing it named will happen — because the Jira step is never attempted over
MCP. If the human asks for either, do not translate the request into anything — say it is
`infra-kit release remove` from their own shell, and stop.

If `$ARGUMENTS` is empty, ask the human which release to remove rather than guessing.

## 4. What one removal does

In order: remove the release worktree (and close the cmux window rooted there), strip the folder
from the Cursor workspace (Zed is always a declared skip), close the PR with a comment, delete the
local branch (switching the main checkout to the base branch first when it is on the release), and
delete the branch on `origin`. The worktree goes first because git will not delete a branch that a
worktree still has checked out; the rest follow in the order that leaves the most repairable
residue if one fails.

**The Jira fix version is never removed over MCP.** When Jira knows a fix version for this release
the result reports `jira: "manual"` with the version's `id`, `name` and `url` in `jiraVersion`;
when it knows none, `jira: "absent"` and `jiraVersion: null`. In the manual case, hand that link
to the human: removing a fix version is irreversible (new id, new URL, lost issue links) and is
theirs to finish in Jira. Until you have said so, the release is not fully removed.

Three consequences worth stating before call 2:

- **What is lost with the worktree directory** is everything gitignored inside it: a hydrated `.env`
  of Doppler secrets (re-fetch with `ik env-load`), `node_modules` and `dist`. If the human meant
  to keep uncommitted work there, this is the moment to stop.
- **Resumable.** Every step is a verified no-op when its artefact is already gone, so a re-run
  finishes a partial teardown — the result says `absent` or `already-closed` for the steps that
  found nothing. A step that fails yields a residue report naming the completed steps, the
  `git branch <branch> <sha>` handle that restores the branch, and the re-run that finishes; relay
  it whole.
- **A merge in the window.** Call 2 re-runs every check in section 1 before the first step, so a PR
  merged between call 1 and call 2 is refused with nothing touched. Only a merge during call 2
  itself reaches the PR step's own re-probe — after the worktree is already gone — and the residue
  report then says what is left.

`localTipSha` and `remoteTipSha` in the result are the tips before deletion — the only handles that
restore the branch. Keep them in your reply.

## 5. What not to do

- Do not work around a refusal with `git` or `gh`. Every refusal in section 1 is a state only the
  human can clear.
- Do not translate `--skip-jira` or `--move-issues-to` into a tool call, and do not remove,
  release or reassign the fix version yourself by any other route. Over MCP the fix version is
  always left for the human.
- Do not pick the release for the human — not the newest, not the only one. Ask against the
  `gh-release-list` rows.
- Do not read `isError: true` on a `confirmation_required` payload as a failure. See section 2.
- Do not retry call 2 after a section 1 refusal. The refusal is the answer; the human clears the
  state, then it is call 1 again.
- Do not report the release as removed on the strength of call 2 returning. Read `worktree`, `pr`,
  `localBranch`, `remoteBranch` and `jira` in the result and say what each one did.
