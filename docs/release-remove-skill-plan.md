# Plan — `/infra-kit:release-remove` procedure skill

**Status: pending approval**

Ticket area: `[DO]`. Analogy: the `release-create` procedure skill landed in e218c9f
(`docs/session-env-picker-plan.md` §3). Deliverable: `plugins/infra-kit/skills/release-remove/SKILL.md`,
invoked as `/infra-kit:release-remove [<version|name>]`, plus the manifest-test, README and
`plugin.json` edits that the plugin's own gates require of any new skill.

## 1. Goal and non-goals

**Goal.** Give a human one slash command that walks the agent through the gated
`mcp__plugin_infra-kit_infra-kit__release-remove` tool with the same discipline `release-create` has:
the two-call confirm protocol, the refusals stated as human-clearable states, "do not shell out", and
an honest account of what the MCP path does differently from the CLI (no picker, Jira never removed,
attached issues do not block, `--skip-jira` / `--move-issues-to` have no tool field).

**Non-goals.**

- No CLI behaviour change. The only CLI edit is one description string (§5, C2), and it is a
  separate commit with its own publish clock.
- No MCP prompt, no `commands/*.md` (`U13'` pins the tree gone), no `allowed-tools`, no Bash rules.
- No batch / multi-target removal, no `--all`; the tool is single-target by design and the skill
  says so.
- No change to `docs/session-env-picker-plan.md` (a historical plan) or
  `docs/session-context-orchestrator.md` (it describes `/infra-kit:session` only — verified, it lists
  no procedure skills).
- No change to the root `CLAUDE.md` generated block: it names `/infra-kit:*` generically and never
  enumerates skills (verified).

## 2. Principles and decision drivers

Principles:

1. **The body is the only text the agent reads.** Everything `server.test.ts` once pinned on a served
   resource is pinned on the body, so every load-bearing sentence becomes a U18 clause.
2. **Say what the MCP path does, not what the CLI does.** Where the two diverge (picker, Jira flags,
   the attached-issue guard) the body states the MCP truth and names the CLI only as "the human runs
   this from their own shell".
3. **A gated tool is human-only.** `disable-model-invocation: true`, no `allowed-tools`: a grant in
   `allowed-tools` would let round 2 run with no host prompt (session-env-picker-plan §3.1).
4. **Register-match `release-create`.** Same section order, same paragraph shapes, no fences, ~150
   lines. A reader who knows one skill should be able to predict the other.
5. **Honest about irreversibility.** The body carries the branch-restoring handles (`localTipSha`,
   `remoteTipSha`) and what the worktree directory takes with it.

Decision drivers (top 3):

1. The plugin's manifest tests are the contract: `EXPECTED_SKILLS`, `PROCEDURE_SKILLS`, `U17'`, U18,
   U6, U19, T1/T5 must all go green on the new file with no test loosened.
2. The MCP guard set differs from the CLI guard set in three places; the skill must not inherit the
   tool description's one inaccuracy (it claims a refusal on attached issues that `isMcpMode()` skips).
3. One plugin publish (`0.7.10`) with a re-measured token-budget line; the CLI description fix rides
   the next routine CLI publish and must not be a prerequisite for the plugin.

## 3. Options

**A — standalone skill mirroring `release-create` 1:1 (chosen).**
Pros: matches the existing procedure-skill shape exactly (`PROCEDURE_SKILLS` entry is a copy of
`release-create`'s); one skill = one gated tool, so `/infra-kit:release-remove` is discoverable next
to `/infra-kit:release-create`; U18 clause list is independent, so a rewrite of one body cannot
silently drop the other's clauses. Cons: ~25 always-on tokens for the description; two bodies share
the two-call protocol paragraphs verbatim (deliberate — U18 pins both copies).

**B — fold removal into `release-create` as a `--remove` mode.**
Rejected: `argument-hint` would advertise a flag that maps to a *different tool*, breaking the U17'
convention that a flag maps to a tool field; the `releases` array semantics (batch, `next`, `type`)
have no counterpart in removal (single-target, no picker); and a human typing
`/infra-kit:release-create --remove 1.64.0` is the wrong affordance for the one irreversible action
in the plugin. The description budget saving is ~25 tokens.

**C — model-invocable skill (no `disable-model-invocation`).**
Rejected: `setup` stays model-invocable because its reader is the agent about to call the tool and
its human gate is the confirm protocol. That argument would apply here too, except that
`release-remove` deletes branches and closes PRs — the U14' rationale for `release-create`
("gated ⇒ human-only") holds a fortiori. An auto-loaded teardown procedure is exactly what a
`"remove that branch"` phrase should not trigger.

**D — a skill that also fences `infra-kit release remove --skip-jira` for the Jira-unconfigured case.**
Rejected: U6 would require a `Bash(infra-kit ...)` rule, and U14' forbids any `Bash(` rule on a
human-only procedure skill. The CLI command is named inline only, as the thing a human runs.

## 4. The deliverable — `plugins/infra-kit/skills/release-remove/SKILL.md`

Verified against the manifest suite's logic in a sandbox (not by editing the repo): frontmatter keys
sort to exactly `argument-hint, description, disable-model-invocation, name`; zero fenced commands
(U6); zero `--flags` in the hint (U17' vacuous); no legacy prefix (U19/T1); no denylist word (T5);
every clause in §5's `PROCEDURE_CLAUSES` list is found in the joined-paragraph body; the two tool
names it mentions (`release-remove`, `gh-release-list`) are both exposed by the catalog and both
present in the published 0.7.9 build. 144 lines, max line length 117 (release-create: 150 / 116).

````markdown
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
`git push --delete` reproduces none of the preconditions below and bypasses the confirm gate in
section 2 — which is the only place a human approves the teardown. Nothing this tool removes is
recreatable.

## 1. Preconditions

Check these before the first call; each one is a refusal the human has to clear, not something to
work around.

- **The main repository checkout, not a linked worktree.** The tool refuses outright from inside a
  linked worktree — the release's own included.
- **The release has not shipped.** A release whose PR is `MERGED` is refused: its branch records
  the merge and its fix version is delivered work. Undoing a delivery is a revert of the merge
  commit on the base branch and a new release, never a removal.
- **Jira configured.** `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_PROJECT_ID` and `JIRA_TOKEN` (or
  `JIRA_API_TOKEN`) must be in the environment the MCP server was launched with, even though the
  tool never touches the fix version — it still has to find it and check its state. A server
  spawned by a host does not inherit an `ik env-load`ed shell, so an unconfigured Jira is an
  ordinary refusal here. The exit the refusal names, `infra-kit release remove --skip-jira`, is a
  CLI flag a human runs from a configured shell; the tool has no equivalent.
- **The fix version is neither released nor archived.** The same class of signal as a merged PR:
  the release is history, not scaffolding. The human un-releases it in Jira or leaves the release
  alone.
- **Something named that version exists.** No worktree, no PR in any state, no local or remote
  branch and no fix version means a typo — check the spelling against `infra-kit release list`. A
  release this tool already tore down keeps a CLOSED PR, so a genuine re-run passes this check.
- **No other worktree holding the base branch, and a clean release worktree.** The tool switches
  the main checkout to the base branch (`dev`, or `main` for a hotfix, read off the PR title)
  before the local delete, and refuses on modified or untracked files inside the release worktree —
  the main checkout's status cannot see in there. The human commits or stashes inside the worktree.

**Attached issues do not block.** A fix version still set as `fixVersion` or `affectsVersion` on
issues is reported, not refused: that guard protects a delete which never runs over MCP, and the
version is left for the human either way. A tool description that lists it among the refusals is
stale; this body is what holds.

## 2. The two-call confirm protocol

`release-remove` is gated. **The first call never executes anything.**

**Call 1** — send `version` with no `confirm` and no `confirmToken`. The result is a gate payload,
`{"status": "confirmation_required", ...}`, and it carries `"isError": true`.

**That `isError` does not mean the call failed.** It is set because the payload is a gate rather
than the tool's declared output. Nothing was removed, nothing was closed, nothing was deleted. An
agent that reads it as a failure — and gives up, or retries, or falls back to `Bash` — has skipped
the human approval this protocol exists for. Do none of those.

The gate payload carries two things you need:

- `resolvedArgs` — exactly the arguments the server bound. **Show these to the human**, with what
  section 4 says will happen to this release. This is the approval moment; there is no other one.
- `confirmToken` — an HMAC bound to the tool name and to those exact arguments. It expires 600
  seconds after it is minted.

**Call 2** — repeat the **same arguments**, unchanged, plus `"confirm": true` and the
`confirmToken` from call 1.

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
a missing `version` is refused. If the human did not say which release, ask. To show them what is
open, call `mcp__plugin_infra-kit_infra-kit__gh-release-list` (read-only) and relay its rows — it
lists open PRs only, so a partly torn-down release with a closed PR is not in it.

### Reading `$ARGUMENTS`

The `/infra-kit:release-remove` skill hands you `$ARGUMENTS` verbatim, and its argument hint is
`[<version|name>]`. The bare token → `version`, as typed. There are no flags: the CLI's
`--skip-jira` and `--move-issues-to` have **no tool field**, and the tool refuses `skipJira` and
`moveIssuesTo` outright because the Jira step is never attempted over MCP. If the human asks for
either, do not translate the request into anything — say it is `infra-kit release remove` from
their own shell, and stop.

If `$ARGUMENTS` is empty, ask the human which release to remove rather than guessing.

## 4. What one removal does

In order: remove the release worktree (and close the cmux window rooted there), strip the folder
from the Cursor workspace (Zed is always a declared skip), close the PR with a comment, delete the
local branch (switching the main checkout to the base branch first when it is on the release), and
delete the branch on `origin`. The order is ascending irreversibility, so an abort leaves the most
repairable residue.

**The Jira fix version is never removed over MCP.** The result reports `jira: "manual"` with the
version's `id`, `name` and `url` in `jiraVersion`. Hand that link to the human: removing a fix
version is irreversible (new id, new URL, lost issue links) and is theirs to finish in Jira. Until
you have said so, the release is not fully removed.

Three consequences worth stating before call 2:

- **What is lost with the worktree directory** is everything gitignored inside it: a hydrated `.env`
  of Doppler secrets (re-fetch with `ik env-load`), `node_modules` and `dist`. If the human meant
  to keep uncommitted work there, this is the moment to stop.
- **Resumable.** Every step is a verified no-op when its artefact is already gone, so a re-run
  finishes a partial teardown — the result says `absent` or `already-closed` for the steps that
  found nothing. A step that fails yields a residue report naming the completed steps, the
  `git branch <branch> <sha>` handle that restores the branch, and the re-run that finishes; relay
  it whole.
- **The PR is re-probed** before it is closed. One merged in the window between the gate and call 2
  is refused there, after the worktree is already gone — the residue report says what is left.

`localTipSha` and `remoteTipSha` in the result are the tips before deletion — the only handles that
restore the branch. Keep them in your reply.

## 5. What not to do

- Do not work around a refusal with `git` or `gh`. Every refusal in section 1 is a state only the
  human can clear.
- Do not translate `--skip-jira` or `--move-issues-to` into a tool call, and do not remove,
  release or reassign the fix version yourself by any other route. Over MCP the fix version is
  always left for the human.
- Do not pick the release for the human — not the newest, not the only one. Ask, or show
  `gh-release-list`'s rows and ask.
- Do not read `isError: true` on a `confirmation_required` payload as a failure. See section 2.
- Do not report the release as removed on the strength of call 2 returning. Read `worktree`, `pr`,
  `localBranch`, `remoteBranch` and `jira` in the result and say what each one did.
````

Notes on wording choices Architect/Critic should weigh:

- §1 ends with **"Attached issues do not block"** and the sentence *"A tool description that lists
  it among the refusals is stale; this body is what holds."* This is the one place the skill
  contradicts the tool's description. It is written to stay true both before and after the C2 fix
  (below) reaches consumers, since the plugin and the CLI update on different clocks.
- §3 offers `gh-release-list` (read-only, exposed, ungated) as the in-protocol way to show a human
  what is open, with the caveat that a partly torn-down release (CLOSED PR) is not in it. This is the
  removal counterpart of `release-create`'s "pass `next` and let the server resolve it" — the agent
  never enumerates candidates from `git branch`.
- §4 keeps the residue-report sentence generic ("relay it whole") rather than restating its format:
  the format lives in `buildResidueError` and restating it would drift.
- The base-branch bullet in §1 folds `assertBaseBranchSwitchable` and `assertWorktreeClean` into one
  bullet because both are about the switch the tool makes; the clean-worktree refusal names the
  worktree, not the main checkout, which is the non-obvious half.

## 5. File-by-file change list

### C1 — `[DO] plugin: release-remove skill — tearing down a release over MCP` (plugin bump 0.7.10)

| File | Change |
| --- | --- |
| `plugins/infra-kit/skills/release-remove/SKILL.md` | New; the §4 text verbatim. |
| `plugins/infra-kit/__tests__/manifest.test.mjs` | (a) `EXPECTED_SKILLS`: insert `'release-remove'` after `'release-create'` (list is asserted sorted). (b) `PROCEDURE_SKILLS`: add `'release-remove': { keys: ['argument-hint', 'description', 'disable-model-invocation', 'name'], humanOnly: true }`; update the comment above it from "`session` and `release-create` are human-only" to name `release-remove` too. (c) `PROCEDURE_CLAUSES`: add the list below; update the comment "The other two procedure bodies" → "The other three", and the U18 test title to "the release-create, release-remove and setup bodies carry every load-bearing clause". No other assertion enumerates skills (verified: `U3`, `U14'`, `U17'`, U18 are the only consumers of these tables). |
| `plugins/infra-kit/README.md` | Table row after `/infra-kit:release-create`: `\| skill \| \`/infra-kit:release-remove\` \| Tears down one release through the gated \`release-remove\` tool; the Jira fix version is left for a human (human-invoked only) \|`. Re-run prettier on the file if the column widths shift. Token-budget line: replace `**496** (plugin version 0.7.8, …)` with the measured value against `0.7.10`, and add one sentence to the paragraph below it: "<N> against 0.7.10 is +<x>%, the `/infra-kit:release-remove` description." |
| `plugins/infra-kit/.claude-plugin/plugin.json` | `"version": "0.7.9"` → `"0.7.10"` (U9 CI gate). |

`PROCEDURE_CLAUSES['release-remove']`, verbatim:

```js
  'release-remove': [
    'mcp__plugin_infra-kit_infra-kit__release-remove',
    'confirmation_required',
    'confirmToken',
    '"confirm": true',
    'does not mean the call failed',
    'The bare token → `version`',
    'There is no picker',
    'refuses `skipJira` and `moveIssuesTo`',
    'Attached issues do not block',
    '`jira: "manual"`',
    '`MERGED` is refused',
    'linked worktree',
    'verified no-op',
    'What is lost with the worktree directory',
    '`git worktree remove`, `gh pr close`, `git branch -D` or `git push --delete`',
    ABSENT_TOOLS_CLAUSE,
  ],
```

Every fragment sits inside one paragraph (no fragment spans a blank line), so it survives a rewrap
under `joinedParagraphs`.

Token-budget procedure: `claude --plugin-dir ./plugins/infra-kit plugin details infra-kit`, read the
projected always-on cost, write it into the README line with `0.7.10`. Expected: ~+25 tokens over
496 (one 20-word description), well under the 20% rule; the line is refreshed regardless because the
recorded pair is `(value, version)`.

### C2 — `[BE] release-remove: description stops claiming the attached-issue refusal over MCP` (CLI, separate commit)

| File | Change |
| --- | --- |
| `apps/infra-kit/cli/src/commands/release-remove/release-remove.ts` `releaseRemoveMcpTool.description` | `…when the fix version is released/archived or still carries issues, or when nothing named that version exists.` → `…when the fix version is released/archived, or when nothing named that version exists. A fix version that still carries issues is reported, not refused: that guard protects a delete which never runs here.` |

Why in scope rather than deferred: it is one string, no behaviour change, and **nothing pins it** —
`tools-list-baseline.v1.json` predates `release-remove` (0 hits), and no test under `src/` asserts the
text (verified by grep). Leaving it means the agent sees two documents at once — `tools/list` and the
skill — that disagree on whether a removal will be refused, and the description is the one an agent
reads *first* when deciding whether to call. Why a separate commit: it is CLI code with a CLI publish
clock (`[BE]`), while C1 is `[DO] plugin:` with a plugin bump; `plugin-ci.yml` path filters would not
even run on it. The skill body's "a tool description that lists it among the refusals is stale" line
covers consumers on ≤0.7.9 until the next CLI publish carries C2.

Not touched: `command-catalog.test.ts` (its cross-check reads `skills/*/SKILL.md` dynamically and
`release-remove` is already in `EXPECTED_GATED_TOOLS`), `plugin-ci.yml` (paths cover `plugins/**`),
`scripts/report-published-cli-skew.mjs` (reports only; both named tools are in the published 0.7.9 —
`pnpm view infra-kit version` = 0.7.9 = `apps/infra-kit/cli/package.json`, and this session's own
tool list from the global CLI carries both), `docs/session-env-picker-plan.md`,
`docs/session-context-orchestrator.md`, root `CLAUDE.md`.

## 6. Pre-mortem

| # | Failure | Mitigation |
| --- | --- | --- |
| 1 | **Skill text drifts from the MCP guard set.** A later CLI change adds or removes a refusal on the MCP path and the body keeps describing the old set — e.g. someone restores the attached-issue count guard over MCP and the body still says "do not block". | U18 pins the sentence, so the body cannot lose it silently, but nothing links it to the CLI. Follow-up F1 (§9): a CLI test in `release-remove-mcp-guards.test.ts` that reads `plugins/infra-kit/skills/release-remove/SKILL.md` and asserts `Attached issues do not block` is present iff the `isMcpMode()` early return exists — the same file-pinning pattern `command-catalog.test.ts` already uses for tool names. Not in C1: it couples the CLI suite to plugin text and deserves its own decision. |
| 2 | **A fenced command reddens U6.** An editor "helpfully" fences `infra-kit release remove --skip-jira` in §1 or §3; U6 clause 2 fails (fenced `infra-kit` head with no rule), and adding a `Bash(` rule fails U14'. | The body names CLI commands inline only, like `release-create`; §3 of this plan (option D) records why. U6's red test `U6 red: a fenced infra-kit command with no matching rule fails clause 2` is the guard. |
| 3 | **The agent reads `isError` as failure and falls back to Bash.** Worst case it runs `git push origin --delete release/v1.64.0` with no human approval. | Same three-layer defence as `release-create`: the "does not mean the call failed" paragraph (U18-pinned), the explicit list of the four shell commands it must not run (U18-pinned), and `disable-model-invocation` so the procedure only loads when a human typed the slash command. Plus the tool-side fact that the gate returns before any mutation. |
| 4 | **The description-string inaccuracy causes an agent to refuse a legitimate removal.** On a ≤0.7.9 CLI the agent reads "refuses when … still carries issues", sees `fixVersion on 3 issue(s)` in the gate, and tells the human it cannot proceed. | The §1 sentence "A tool description that lists it among the refusals is stale; this body is what holds" is written for exactly this reader; C2 removes the inaccuracy at the source on the next CLI publish. |
| 5 | **Token-budget line left stale.** C1 bumps `plugin.json` but the README still says 496 / 0.7.8; the release checklist's 20% rule passes, but the recorded baseline is now two versions behind. | AC 8 makes the refreshed line a condition of C1; the number is measured, not estimated. |

## 7. Test plan

**Unit — manifest suite** (`node --test 'plugins/infra-kit/__tests__/*.test.mjs'`):

- U3 green only once `'release-remove'` is in `EXPECTED_SKILLS` (it is red on the new directory
  alone — that red is the proof the list is exact).
- U2 name/directory match; U4 no unsupported frontmatter key.
- U14' on `release-remove`: exact key set, `disable-model-invocation: 'true'`, no `allowed-tools`, zero
  `Bash(` rules.
- U17' vacuous (no flags in the hint) — state this in the commit body so nobody "fixes" it.
- U18 clause list green; then a **red check by hand** before committing: delete one clause
  (`Attached issues do not block`) from a scratch copy and confirm the suite names it, so the list is
  known to bite.
- U6 zero fenced command lines; U19 count unchanged (1); T1/T5 clean.

**Integration:**

- `claude plugin validate ./plugins/infra-kit --strict --json` → no errors/warnings.
- `pnpm run test:claude` (the hooks + skills + plugin suites, concurrency 1).
- CLI catalog cross-check: `pnpm --filter infra-kit exec vitest run src/lib/command-catalog` — the
  dynamic scan of `skills/*/SKILL.md` must find `release-remove` and `gh-release-list` exposed.
- C2 only: `pnpm --filter infra-kit exec vitest run src/commands/release-remove src/mcp` — the
  description is unpinned, so this is a no-regression run, not a behaviour test.
- `pnpm run qa` at the root before the commit (per memory: a full qa can rewrite manifests and the
  vendor mirror — `git status` before committing).

**E2E (human-only, describe, do not automate):** in a consumer checkout on a throwaway release
(`/infra-kit:release-create --desc "skill e2e" e2e-remove-probe`, then
`/infra-kit:release-remove e2e-remove-probe`): observe (1) the gate payload with `isError: true` and
`resolvedArgs: { version: "e2e-remove-probe" }`, (2) the agent showing the §4 inventory before call 2,
(3) the result carrying `jira: "manual"` with a `jiraVersion.url`, (4) a second invocation reporting
`worktree: "absent"`, `pr: "already-closed"`, `localBranch: "absent"`, `remoteBranch: "absent"` — the
resumability claim. Then the human deletes the fix version in Jira by hand, which is the point.

**Observability:** the `report-published-cli-skew.mjs` step summary on the PR must list no unexposed
tool for `release-remove`; the README token-budget line is the durable record of the description's
cost.

## 8. Acceptance criteria

1. `plugins/infra-kit/skills/release-remove/SKILL.md` exists with frontmatter exactly
   `name`, `description`, `argument-hint: [<version|name>]`, `disable-model-invocation: true`.
2. `node --test 'plugins/infra-kit/__tests__/*.test.mjs'` passes with `'release-remove'` in
   `EXPECTED_SKILLS`, `PROCEDURE_SKILLS` and `PROCEDURE_CLAUSES`, and no existing assertion loosened.
3. Removing any one clause from the body makes U18 fail naming that clause (checked by hand, once).
4. The body contains zero fenced command lines and never names `mcp__infra-kit__`.
5. The body states, in these words or U18-pinned equivalents: `version` is required and there is no
   picker; `skipJira` / `moveIssuesTo` are refused; attached issues do not block; the fix version is
   never removed over MCP and the result is `jira: "manual"`; a `MERGED` PR is refused; every step is a
   verified no-op on re-run; what is lost with the worktree directory; the four shell commands not to
   run.
6. `claude plugin validate ./plugins/infra-kit --strict --json` reports no errors.
7. `pnpm run test:claude` and the CLI command-catalog test pass.
8. `plugin.json` is `0.7.10` and the README token-budget line records a freshly measured number against
   `0.7.10`, with the delta ≤ 20% of 496.
9. README table has the `/infra-kit:release-remove` row marked "human-invoked only".
10. C2: the tool description no longer claims a refusal on attached issues; the CLI suites pass.

## 9. ADR

**Decision.** Ship `release-remove` as a standalone, human-only procedure skill mirroring
`release-create`'s frontmatter, section order and register; hint `[<version|name>]` with no flags;
body states the MCP-path truth where it diverges from the CLI; the tool description's inaccuracy is
fixed in a separate CLI commit.

**Drivers.** The manifest gates as the contract; the three MCP/CLI divergences (picker, Jira flags,
attached-issue guard); separate plugin/CLI publish clocks.

**Alternatives considered.** B (fold into `release-create --remove`), C (model-invocable),
D (fence the CLI escape) — §3.

**Why chosen.** One skill per gated tool is the shape the tests already encode
(`PROCEDURE_SKILLS` is keyed by skill = tool); the human-only policy follows from the U14' rationale
without a new argument; a body that names the divergences is the only thing that stops an agent from
inheriting the tool description's overclaim.

**Consequences.** +~25 always-on tokens; two bodies carry the confirm-protocol paragraphs verbatim
(accepted — U18 pins both, and a shared include has no mechanism in SKILL.md); the "stale
description" sentence in §1 is a deliberate cross-document statement that C2 makes moot but not
false.

**Follow-ups.**

- F1: a CLI-side test that ties `Attached issues do not block` in the skill body to the `isMcpMode()`
  early return in `assertJiraRemovable` (pre-mortem #1). Needs a decision on coupling the CLI suite to
  plugin text.
- F2: if the "stale description" sentence reads as noise once every consumer is on a C2-carrying CLI,
  drop it in a later plugin bump; it is not U18-pinned, so the drop is free.
- F3 (out of scope, noted): the residue report's re-run instruction names the CLI form
  (`infra-kit release remove --version …`), not the tool; an agent that hits a residue report has to
  re-call the tool instead. The body says "relay it whole" and section 5 forbids the CLI, which is
  enough for now.

## 10. Commit plan

1. **C1** `[DO] plugin: release-remove skill — tearing down a release over MCP` — the SKILL.md,
   `manifest.test.mjs` (three tables + two comments + one test title), README (row + token-budget
   line), `plugin.json` 0.7.10. Body notes: U17' is vacuous by design (no flags), the measured token
   number, and that the body contradicts the ≤0.7.9 tool description on purpose.
2. **C2** `[BE] release-remove: description stops claiming the attached-issue refusal over MCP` —
   one string in `release-remove.ts`. Rides the next CLI publish; not a prerequisite for C1.

Order: C2 first is fine but not required; neither commit's tests read the other's files. Publish the
plugin (C1) as a normal plugin release; C2 publishes with whatever CLI release comes next.
