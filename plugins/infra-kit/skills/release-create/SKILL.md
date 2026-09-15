---
name: release-create
description: Cut one or more release branches through the infra-kit CLI, behind the preview-then-approve protocol.
argument-hint: [--hotfix] [--desc <text>] [<version|next|name>]
disable-model-invocation: true
allowed-tools: Bash(infra-kit release list --json*)
---

# release-create — cutting a release through infra-kit

CLI on PATH: !`zsh -c 'infra-kit version --json' 2>/dev/null || echo '{"error":"infra-kit not on PATH"}'`

The command is `infra-kit release create`. Everything below is about running that command through
`Bash`, with `--json --agent` on every call.

**Version floor.** Read the block above first. On `{"error": …}`, or a `version` below `0.8.0`, tell
the human to update — `pnpm add -g infra-kit@latest`, or `infra-kit setup` from their terminal — and
stop. An older CLI answers none of the shapes below.

**cwd.** Every call runs from the directory Claude Code was launched in — the repo root. If the shell
was `cd`'d elsewhere, `cd` back first (the CLI also accepts `-C <dir>`).

Do not reproduce the command with `git switch`, `git push` or `gh pr create`. Those reproduce none of
the preconditions below and skip the approval in section 2 — which is the only place a human approves
the release.

## 1. Preconditions

Check these before the first call; each one is a refusal the human has to clear, not something to
work around.

- **The main repository checkout, not a linked worktree.** The command refuses outright from inside a
  linked worktree.
- **A clean working tree.** Uncommitted changes are refused; the human commits or stashes.
- **No other worktree holding the base branch.** Regular releases branch off `dev`, hotfixes off
  `main`. If a linked worktree has that branch checked out, the command refuses and names the path.
- **Jira configured.** Every release gets a matching fix version, so `JIRA_BASE_URL`,
  `JIRA_EMAIL`, `JIRA_PROJECT_ID` and `JIRA_TOKEN` (or `JIRA_API_TOKEN`) must be loaded for this
  session (`/infra-kit:session <env>` or `ik env-load` in the terminal that launched Claude Code);
  the CLI reads the session file on every run, so a load made a moment ago counts. The check runs
  before anything is cut.

**You do not have to already be on the base branch.** The command runs `git fetch origin`,
`git switch <base>` and `git pull --ff-only` itself. That is a real side effect on the human's
checkout: say so before the approved run.

## 2. Preview, approve, re-run

`release create` is a mutating command. **Without `--yes` it executes nothing.**

**The preview run** — `infra-kit release create -r "<spec>" --json --agent`, one `-r` per release
(section 3). It exits 2 and prints one JSON object:
`{"status": "confirmation_required", "message", "plan", "rerun": [...], "agentMode"}`.

**Exit 2 here does not mean the call failed.** Nothing was created, nothing was pushed, nothing was
switched. An agent that reads it as a failure — and gives up, or retries with `--yes` on its own, or
falls back to `git` — has skipped the human approval this protocol exists for. Do none of those.

The payload carries two things you need:

- `plan` (and `message`) — exactly what the CLI resolved: every release, its type, its base branch,
  the branch and fix version it will create. **Show these to the human.** This is the approval
  moment; there is no other one.
- `rerun` — the argv of the same call with `--yes` appended, one element per token.

**The approved run** — once the human says go, run exactly `infra-kit <rerun joined by spaces>`,
quoting any element that contains whitespace and changing nothing else. That `Bash` call is
deliberately not pre-approved: the host prompts the human with the full argv, `--yes` included, and
that prompt is the second half of the approval. Never add `--yes` to a call the human has not seen.

If the human wants different arguments, build a new preview run. Do not edit `rerun` by hand — a
changed argument deserves a fresh plan.

**The other exits.** `{"status": "refused"}` (exit 2) is a state only the human can clear — relay
the message and stop. `{"status": "partial_failure"}` (exit 1) means something ran and part of it
failed — relay the payload whole (section 3, batches). Non-JSON stdout, or exit 1 with no JSON, is a
crash: stop and show stderr.

## 3. What goes in `-r`

Each `-r <spec>` is one release, `"<token>[:type[:description]]"`. The token is **exactly one** of:

- a semver string such as `1.64.0`, or the literal token `next` — a version;
- a free-form kebab-case identifier such as `checkout-redesign` — a name.

They are mutually exclusive and one is required. A name that is not kebab-case, or is reserved, is
refused — relay the kebab-case remediation and ask again.

`type` is `regular` or `hotfix` (default `regular`). Everything after the second colon is the
`description` — it may itself contain colons — and becomes the Jira fix version's description and
feeds the PR body.

### The `next` token

`next` is version-only — a named release never auto-bumps. It resolves against the union of the
remote `release/v*` branches on `origin` and the project's Jira fix versions:

- `regular` bumps the minor and resets the patch: `1.63.2` becomes `1.64.0`.
- `hotfix` bumps the patch on the highest minor: `1.63.2` becomes `1.63.3`.

Several `next` entries in one call advance sequentially rather than all resolving to the same
version.

**Be honest about what `next` could see.** The two sources are queried in parallel and a source
that fails is logged and dropped, not raised — if the Jira call fails, `next` is computed from
the remote branches alone and can land on a version Jira already knows about. If neither source
yields a prior version the command refuses and asks for an explicit one. When the exact number
matters, pass the semver instead of the token. The `plan` names the resolved version — that is what
the human approves, not the token.

### Reading `$ARGUMENTS`

The `/infra-kit:release-create` skill hands you `$ARGUMENTS` verbatim, and its argument hint is
`[--hotfix] [--desc <text>] [<version|next|name>]`. **Those two flags are conventions of this skill,
not CLI flags** — `infra-kit release create` accepts neither. They exist so a human can type the
whole request on one line, and it is your job to translate them into the `-r` spec:

- `--hotfix` → `type: "hotfix"` — the `:hotfix` segment. Its absence means `regular`.
- `--desc <text>` → `description` — the segment after the second colon. The text runs to the end of
  the argument string.
- The bare token → the first segment: a semver or the literal `next` for a version, kebab-case for a
  name.

So `--hotfix --desc "Card expiry fix" 1.63.3` is `-r "1.63.3:hotfix:Card expiry fix"`.

If `$ARGUMENTS` is empty, ask the human in prose for the token, the type and the description, then
build the spec. Do not pick a version for them; offer `next` when they have none in mind. Before
asking, show what already exists (read-only):

```
infra-kit release list --json --agent
```

Should a call ever reach the CLI with no `-r`, it exits 2 with `{"status": "argument_required",
"argument", "choices"?}`; when `choices` rows are present, put every row into `AskUserQuestion` as
it is, and ask in prose for anything the rows cannot carry (a version, a description). Then re-run
with the `-r` you built. Never confirm a run whose spec you did not show.

### Batches

One call may create several releases (several `-r`), but **all entries must share the same `type`**.
Regular and hotfix branch off different bases, so a mixed batch is rejected — cut them in separate
invocations.

A batch does not stop at the first failure. Each entry is attempted and the result reports
`successCount`, `failureCount`, `createdBranches` and `failedReleases`; when some failed it arrives
as `partial_failure`, exit 1. Read all four before telling the human the release was created:
partial success is a normal outcome here.

## 4. What one release does

Per entry, in order: fetch and switch to the base branch, cut `release/v<semver>` (or
`release/<name>`), open a GitHub release PR, and create or reuse the Jira fix version (`v<semver>`
or `<name>`).

Two consequences worth stating before the approved run:

- An existing fix version is **reused**, and a `description` that differs is written through to it,
  so the PR and the fix version cannot disagree.
- A fix version that is already released or archived is **refused**, not reused. The human either
  picks a different version or un-releases it in Jira.

## 5. What not to do

- Do not work around a refusal with `git` or `gh`. Every refusal in section 1 is a state only the
  human can clear.
- Do not invent a list of candidate versions for the human. Pass `next` and let the CLI resolve it
  from the real branches and fix versions, or ask for the exact semver.
- Do not read exit 2 on a `confirmation_required` payload as a failure. See section 2.
- Do not run any `infra-kit` call carrying `--yes` that is not the `rerun` of a plan the human saw.
