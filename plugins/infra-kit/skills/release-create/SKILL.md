---
name: release-create
description: Cut one or more release branches through the infra-kit MCP server.
argument-hint: [--hotfix] [--desc <text>] [<version|next|name>]
disable-model-invocation: true
---

# release-create — cutting a release through infra-kit

The tool is `mcp__plugin_infra-kit_infra-kit__release-create`. Everything below is about calling that tool.
If `mcp__plugin_infra-kit_infra-kit__*` tools are absent this is a subdirectory or legacy session — say so and stop.

Do not shell out. A `Bash` call running `git switch`, `git push` or `gh pr create` reproduces none
of the preconditions below and bypasses the confirm gate in section 2 — which is the only place a
human approves the release.

## 1. Preconditions

Check these before the first call; each one is a refusal the human has to clear, not something to
work around.

- **The main repository checkout, not a linked worktree.** The tool refuses outright from inside a
  linked worktree.
- **A clean working tree.** Uncommitted changes are refused; the human commits or stashes.
- **No other worktree holding the base branch.** Regular releases branch off `dev`, hotfixes off
  `main`. If a linked worktree has that branch checked out, the tool refuses and names the path.
- **Jira configured.** Every release gets a matching fix version, so `JIRA_BASE_URL`,
  `JIRA_EMAIL`, `JIRA_PROJECT_ID` and `JIRA_TOKEN` (or `JIRA_API_TOKEN`) must be in the
  environment — load them with `ik env-load` and source the file it returns. The check runs before
  anything is cut.

**You do not have to already be on the base branch.** The tool runs `git fetch origin`,
`git switch <base>` and `git pull --ff-only` itself. That is a real side effect on the human's
checkout: say so before call 2.

## 2. The two-call confirm protocol

`release-create` is gated. **The first call never executes anything.**

**Call 1** — send the real arguments, with no `confirm` and no `confirmToken`. The result is a gate
payload, `{"status": "confirmation_required", ...}`, and it carries `"isError": true`.

**That `isError` does not mean the call failed.** It is set because the payload is a gate rather
than the tool's declared output. Nothing was created, nothing was pushed, nothing was switched. An
agent that reads it as a failure — and gives up, or retries, or falls back to `Bash` — has skipped
the human approval this protocol exists for. Do none of those.

The gate payload carries two things you need:

- `resolvedArgs` — exactly the arguments the server bound. **Show these to the human.** This is the
  approval moment; there is no other one.
- `confirmToken` — an HMAC bound to the tool name and to those exact arguments. It expires 600
  seconds after it is minted.

**Call 2** — repeat the **same arguments**, unchanged, plus `"confirm": true` and the
`confirmToken` from call 1.

Change any argument between the two calls and round 2 comes back as
`{"status": "confirmation_refused", "reason": "mismatch"}`. That is terminal — it is not a second
gate. The other reasons are `absent`, `malformed`, `mac`, `expired` and `bind`, and every one of
them recovers the same way: call again **without** `confirm` to mint a fresh gate, then re-call
with those arguments and the new token. Never retry call 2 with the old token.

If the human wants different arguments, go back to call 1 with the new arguments. Do not edit the
arguments and reuse the token — that is exactly what `mismatch` refuses.

## 3. What goes in `releases`

`releases` is an array with at least one entry. Every entry carries **exactly one** of:

- `version` — a semver string such as `"1.64.0"`, or the literal token `"next"`.
- `name` — a free-form kebab-case identifier such as `"checkout-redesign"`.

They are mutually exclusive and one is required. An entry with both, or with neither, is rejected
by the schema before the tool runs.

Each entry also carries `type` (`"regular"` or `"hotfix"`, default `"regular"`) and an optional
`description`, which becomes the Jira fix version's description and feeds the PR body.

### The `"next"` token

`"next"` is version-only — a named release never auto-bumps. It resolves against the union of the
remote `release/v*` branches on `origin` and the project's Jira fix versions:

- `"regular"` bumps the minor and resets the patch: `1.63.2` becomes `1.64.0`.
- `"hotfix"` bumps the patch on the highest minor: `1.63.2` becomes `1.63.3`.

Several `"next"` entries in one call advance sequentially rather than all resolving to the same
version.

**Be honest about what `"next"` could see.** The two sources are queried in parallel and a source
that fails is logged and dropped, not raised — if the Jira call fails, `"next"` is computed from
the remote branches alone and can land on a version Jira already knows about. If neither source
yields a prior version the tool refuses and asks for an explicit one. When the exact number
matters, pass the semver instead of the token.

### Reading `$ARGUMENTS`

The `/infra-kit:release-create` skill hands you `$ARGUMENTS` verbatim, and its argument hint is
`[--hotfix] [--desc <text>] [<version|next|name>]`. **Those two flags are conventions of this skill, not
CLI flags** — `infra-kit release create` accepts neither, and the tool takes neither. They exist so a
human can type the whole request on one line, and it is your job to translate them:

- `--hotfix` → `type: "hotfix"` on every entry you build. Its absence means `"regular"`.
- `--desc <text>` → `description` on the entry. The text runs to the end of the argument string.
- The bare token → `version` when it is a semver or the literal `next`, `name` when it is kebab-case.

So `--hotfix --desc "Card expiry fix" 1.63.3` is one entry:
`{version: "1.63.3", type: "hotfix", description: "Card expiry fix"}`.

If `$ARGUMENTS` is empty, ask the human what to cut rather than guessing a version — and read the
`"next"` caveats above before offering it.

**Precedence, when a form is also involved.** If the server answers with an argument form and the
human edits it, **the form wins field by field wherever the human supplied a value, and the values
you parsed from `$ARGUMENTS` win everywhere else.** A human who typed `--hotfix` and then picked
`regular` in the form gets `regular` — they saw the field and changed it. A human who typed
`--hotfix` and left `type` untouched gets `hotfix`. Never rebuild the entry from the form alone: that
converts every untouched field into a silent overwrite by a value the human never saw.

### Batches

One call may create several releases, but **all entries must share the same `type`**. Regular and
hotfix branch off different bases, so a mixed batch is rejected — cut them in separate
invocations.

A batch does not stop at the first failure. Each entry is attempted and the result reports
`successCount`, `failureCount`, `createdBranches` and `failedReleases`. Read all four before
telling the human the release was created: partial success is a normal outcome here.

## 4. What one release does

Per entry, in order: fetch and switch to the base branch, cut `release/v<semver>` (or
`release/<name>`), open a GitHub release PR, and create or reuse the Jira fix version (`v<semver>`
or `<name>`).

Two consequences worth stating before call 2:

- An existing fix version is **reused**, and a `description` that differs is written through to it,
  so the PR and the fix version cannot disagree.
- A fix version that is already released or archived is **refused**, not reused. The human either
  picks a different version or un-releases it in Jira.

## 5. What not to do

- Do not work around a refusal with `git` or `gh`. Every refusal in section 1 is a state only the
  human can clear.
- Do not invent a list of candidate versions for the human. Pass `"next"` and let the server
  resolve it from the real branches and fix versions, or ask for the exact semver.
- Do not read `isError: true` on a `confirmation_required` payload as a failure. See section 2.
