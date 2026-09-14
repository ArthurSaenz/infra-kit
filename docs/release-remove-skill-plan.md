# Plan — `/infra-kit:release-remove` procedure skill

**Status: approved — implemented ca41400 (C1, plugin 0.7.10), e0d7d49 (C2, CLI strings)** (revision 2 — Architect: sound; Critic: approve; all 12 iteration-1 edits applied, evidence cited inline as `file:line`)

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

- No CLI behaviour change. The only CLI edits are three strings on `releaseRemoveMcpTool` (§5, C2),
  in a separate commit with its own publish clock.
- No MCP prompt, no `commands/*.md` (`U13'` pins the tree gone), no `allowed-tools`, no Bash rules.
- No batch / multi-target removal, no `--all`; the tool is single-target by design and the skill
  says so.
- No round-1 plan inventory in the gate payload (that is follow-up F4, a CLI change).
- No change to `docs/session-env-picker-plan.md` (a historical plan) or
  `docs/session-context-orchestrator.md` (it describes `/infra-kit:session` only — verified, it lists
  no procedure skills).
- No change to the root `CLAUDE.md` generated block: it names `/infra-kit:*` generically and never
  enumerates skills (verified).
- Not touched: the stale `.claude/worktrees/agent-*/plugins/…` copies. They sit outside every scan
  root — `manifest.test.mjs:9-10` roots at `plugins/infra-kit/`, `command-catalog.test.ts:223-224`
  at `<repo>/plugins/infra-kit/skills`, and the `test:claude` glob in `package.json:24` is
  `plugins/infra-kit/…` — so they neither pass nor fail anything here.

## 2. Principles and decision drivers

Principles:

1. **The body is the only text the agent reads.** Everything `server.test.ts` once pinned on a served
   resource is pinned on the body, so every load-bearing sentence becomes a U18 clause.
2. **Say what the MCP path does, not what the CLI does.** Where the two diverge (picker, Jira flags,
   the attached-issue guard, _when_ the checks run, _what_ the gate carries) the body states the MCP
   truth and names the CLI only as "the human runs this from their own shell".
3. **A gated tool is human-only.** `disable-model-invocation: true`, no `allowed-tools`: a grant in
   `allowed-tools` would let round 2 run with no host prompt (session-env-picker-plan §3.1).
4. **Register-match `release-create` — copy its register, not its sentences.** Same section order,
   same paragraph shapes, no fences, ~150 lines. But `release-create`'s "check these before the
   first call" is true of _that_ tool's UX only by accident; copied here it described the CLI's
   interactive confirm window as if it were the MCP gate (revision 1's defect, edit 1). Every
   sentence about timing, payload contents or refusals is checked against `tool-handler.ts` and
   `release-remove.ts`, not against the sibling skill.
5. **Honest about irreversibility.** The body carries the branch-restoring handles (`localTipSha`,
   `remoteTipSha`) and what the worktree directory takes with it.

Decision drivers (top 3):

1. The plugin's manifest tests are the contract: `EXPECTED_SKILLS`, `PROCEDURE_SKILLS`, `U17'`, U18,
   U6, U19, T1/T5 must all go green on the new file with no test loosened.
2. The MCP path differs from the CLI path in five places the agent must not get wrong: the gate
   inspects nothing (`tool-handler.ts:587-591` — `resolveStop` returns before `handler` runs), the
   gate payload is `{status, tool, resolvedArgs, confirmToken, formDiscarded, message}` with no
   inventory (`tool-handler.ts:221-230`), `skipJira`/`moveIssuesTo` are stripped at the boundary
   rather than refused (`mcp/tools/index.ts:43-48`, `tool-handler.ts:121-122`), the attached-issue
   count guard is skipped (`release-remove.ts:260`), and `jira` is `manual` only when a fix version
   exists (`release-remove.ts:765` returns `'absent'` before the `isMcpMode()` branch at `:770`).
3. One plugin publish (`0.7.10`) with a re-measured token-budget line; the CLI string fixes ride the
   next routine CLI publish and must not be a prerequisite for the plugin.

## 3. Options

**A — standalone skill mirroring `release-create`'s shape (chosen).**
Pros: matches the existing procedure-skill shape exactly (`PROCEDURE_SKILLS` entry is a copy of
`release-create`'s); one skill = one gated tool, so `/infra-kit:release-remove` is discoverable next
to `/infra-kit:release-create`; U18 clause list is independent, so a rewrite of one body cannot
silently drop the other's clauses. Cons: ~25 always-on tokens for the description; two bodies share
the confirm-protocol paragraphs nearly verbatim (deliberate — U18 pins both copies).

**B — fold removal into `release-create` as a `--remove` mode.**
Rejected: `argument-hint` would advertise a flag that maps to a _different tool_, breaking the U17'
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

**E — grant the two read-only tools in `allowed-tools`.**
Rejected (edit 3): `PROCEDURE_SKILLS` pins `release-create`'s key set without `allowed-tools`, and
parity with it is the point of this skill; `gh-release-list` and `worktrees-list` are exposed and
ungated (`command-catalog.test.ts:53,58`), so without a grant they cost the human one ordinary host
permission prompt per call under default mode — a prompt, not a refusal, and the body says so.

## 4. The deliverable — `plugins/infra-kit/skills/release-remove/SKILL.md`

Verified against the manifest suite's logic in a sandbox (not by editing the repo): frontmatter keys
sort to exactly `argument-hint, description, disable-model-invocation, name`; zero fenced commands
(U6); zero `--flags` in the hint (U17' vacuous); no legacy prefix (U19/T1); no denylist word (T5);
every clause in §5's `PROCEDURE_CLAUSES` list is found in the joined-paragraph body; the three tool
names it mentions (`release-remove`, `gh-release-list`, `worktrees-list`) are all exposed by the
catalog (`command-catalog.test.ts:53,58,66`) and all present in the published 0.7.9 build.
170 lines, max line length 117 (release-create: 150 / 116).

```markdown
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
```

### 4.1 Evidence for the sentences revision 2 changed

| Body sentence                                                                                            | Evidence                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §1 "The first call checks nothing about the release … every refusal below comes back from call 2"        | `tool-handler.ts:587-591`: `resolveStop` runs first and returns the gate; `handler(...)` — and with it every `assert*` in `releaseRemove` (`release-remove.ts:928-945`) — runs only on the confirmed call.                                                  |
| §1 "A clean working tree in the main checkout"                                                           | `git-guard.ts:145-157`: `assertManagementContext` ends with `assertCleanCheckout` (`:156`).                                                                                                                                                                 |
| §1 Jira bullet "This check runs before the existence check"                                              | Guard order `release-remove.ts:941-943`: `assertJiraRemovable` then `assertSomethingExists`.                                                                                                                                                                |
| §1 typo bullet → `gh-release-list` (open PRs only)                                                       | `gh-release-list.ts:75`: "List every open release PR…". The CLI's `infra-kit release list` is the same catalog entry (`command-catalog.ts:242-247`) but the agent must not shell out.                                                                       |
| §1 base-branch bullet "When the main checkout is on the release branch the tool switches it"             | `release-remove.ts:713-715`: `if ((await getCurrentBranch()) === plan.branch) await $\`git switch …\``.                                                                                                                                                     |
| §2 "carries `version` and nothing else: no worktree path, no PR number, no branch tips, no issue counts" | `tool-handler.ts:221-230` — the gate is `{status, tool, resolvedArgs, confirmToken, formDiscarded, message}`; `buildConfirmMessage` (`release-remove.ts:466-482`) is rendered by `confirmOrExit` on the CLI path only.                                      |
| §2 "host may prompt for permission … is not a tool refusal"                                              | Both tools ungated: not in `EXPECTED_GATED_TOOLS` (`command-catalog.test.ts:53,58` list them as plain exposed tools).                                                                                                                                       |
| §2 token "expires 600 seconds after it is minted" (TTL only, not single-use)                             | `confirm-token.ts:22` `CONFIRM_TOKEN_TTL_SECONDS = 600`; no consumption on verify.                                                                                                                                                                          |
| §3 "A `skipJira` or `moveIssuesTo` key you add anyway is stripped by the server"                         | `mcp/tools/index.ts:43-48`: `z.object(...)` strips undeclared keys; `tool-handler.ts:121-122` restates it. `assertMcpRemoveInput` (`release-remove.ts:174-200`) is reachable only by a direct handler call.                                                 |
| §4 worktree first "because git will not delete a branch that a worktree still has checked out"           | `STEP_ORDER` `release-remove.ts:67`; the local-branch step (`:710-729`) runs after `removeWorktreeStep`. The code's own comment (`:62-66`) gives ascending irreversibility as the ordering rule for the rest, which the body keeps for the remaining steps. |
| §4 `jira: "manual"` when a fix version exists, `"absent"` when none                                      | `release-remove.ts:765` `if (!plan.jira \|\| !plan.jiraConfig) return 'absent'` precedes `:770` `if (isMcpMode()) … return 'manual'`.                                                                                                                       |
| §4 "A merge in the window": call 2 re-runs every check; only a merge during call 2 reaches the re-probe  | Guards at `:941` on the confirmed call; `closePrStep` re-probe `:690-698` runs after `removeWorktreeStep`.                                                                                                                                                  |

Notes on wording choices Architect/Critic should weigh:

- §1 ends with **"Attached issues do not block"** and _"A tool description that lists it among the
  refusals is stale; this body is what holds."_ Written to stay true before and after C2 reaches
  consumers, since the plugin and the CLI update on different clocks.
- §2 prescribes the two read-only listings **before call 1** because the gate is blind: `resolvedArgs`
  is `{version}` and nothing else, so the listing rows are the only inventory the human sees before
  approving. This is the removal counterpart of `release-create`'s "pass `next` and let the server
  resolve it" — the agent never enumerates candidates from `git branch`.
- §4 keeps the residue-report sentence generic ("relay it whole") rather than restating its format:
  the format lives in `buildResidueError` (`release-remove.ts:579-603`) and restating it would drift.
- The base-branch bullet in §1 folds `assertBaseBranchSwitchable` and `assertWorktreeClean` into one
  bullet because both are about the switch the tool may make; the clean-worktree refusal names the
  worktree, not the main checkout, which is the non-obvious half.
- Frontmatter: still no `allowed-tools` although the body names two read-only tools — option E above.

## 5. File-by-file change list

### C1 — `[DO] plugin: release-remove skill — tearing down a release over MCP` (plugin bump 0.7.10)

| File                                               | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `plugins/infra-kit/skills/release-remove/SKILL.md` | New; the §4 text verbatim.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `plugins/infra-kit/__tests__/manifest.test.mjs`    | (a) `EXPECTED_SKILLS`: insert `'release-remove'` after `'release-create'` (list is asserted sorted). (b) `PROCEDURE_SKILLS`: add `'release-remove': { keys: ['argument-hint', 'description', 'disable-model-invocation', 'name'], humanOnly: true }`; update the comment above it from "`session` and `release-create` are human-only" to name `release-remove` too. (c) `PROCEDURE_CLAUSES`: add the list below; update the comment "The other two procedure bodies" → "The other three", and the U18 test title to "the release-create, release-remove and setup bodies carry every load-bearing clause". No other assertion enumerates skills (verified: `U3`, `U14'`, `U17'`, U18 are the only consumers of these tables). |
| `plugins/infra-kit/README.md`                      | Table row after `/infra-kit:release-create`: `\| skill \| \`/infra-kit:release-remove\` \| Tears down one release through the gated \`release-remove\` tool; the Jira fix version is left for a human (human-invoked only) \|`. Re-run prettier on the file if the column widths shift. Token-budget line: replace `**496** (plugin version 0.7.8, …)`with the measured value against`0.7.10`, and add one sentence to the paragraph below it: "<N> against 0.7.10 is +<x>%, the `/infra-kit:release-remove` description."                                                                                                                                                                                                     |
| `plugins/infra-kit/.claude-plugin/plugin.json`     | `"version": "0.7.9"` → `"0.7.10"` (U9 CI gate, `scripts/check-plugin-version-bump.mjs`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

`PROCEDURE_CLAUSES['release-remove']`, verbatim:

```js
  'release-remove': [
    'mcp__plugin_infra-kit_infra-kit__release-remove',
    'confirmation_required',
    'confirmToken',
    '"confirm": true',
    'does not mean the call failed',
    'The first call checks nothing about the release',
    'carries `version` and nothing else',
    'The bare token → `version`',
    'There is no picker',
    'have **no tool field**',
    'Attached issues do not block',
    '`jira: "manual"`',
    '`jira: "absent"`',
    '`MERGED` is refused',
    'linked worktree',
    'clean working tree',
    'verified no-op',
    'What is lost with the worktree directory',
    '`git worktree remove`, `gh pr close`, `git branch -D` or `git push --delete`',
    ABSENT_TOOLS_CLAUSE,
  ],
```

Every fragment sits inside one paragraph (no fragment spans a blank line), so it survives a rewrap
under `joinedParagraphs` — re-verified in a sandbox against the §4 text after revision 2 (20/20).

Token-budget procedure: `claude --plugin-dir ./plugins/infra-kit plugin details infra-kit`, read the
projected always-on cost, write it into the README line with `0.7.10`. Expected: ~+25 tokens over
496 (one 20-word description), well under the 20% rule; the line is refreshed regardless because the
recorded pair is `(value, version)`. **This rule is a manual release-checklist step**: `plugin-ci.yml`
runs validate, the manifest suite, the U9 bump gate and the skew report only — nothing in CI reads the
README number.

### C2 — `[BE] release-remove: the MCP tool's prose stops describing the CLI path` (CLI, separate commit)

Three strings on `releaseRemoveMcpTool` (`release-remove.ts:986-1030`), no behaviour change:

| Location                               | Now                                                                                                              | After                                                                                                                                                                                                          |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `description` (`:989`), refusal list   | `…when the fix version is released/archived or still carries issues, or when nothing named that version exists.` | `…when the fix version is released/archived, or when nothing named that version exists. A fix version that still carries issues is reported, not refused: that guard protects a delete which never runs here.` |
| `description` (`:989`), Jira flags     | `the moveIssuesTo/skipJira flags are CLI-only and are refused here because the Jira step does not run.`          | `the moveIssuesTo/skipJira flags are CLI-only and have no field over MCP; the server strips them because the Jira step does not run.`                                                                          |
| `outputSchema.jira` describe (`:1023`) | `Always "manual" over MCP: the fix version is left for a human. "absent" means none was found.`                  | `"manual" when a fix version exists over MCP (it is left for a human); "absent" when Jira knows none.`                                                                                                         |

Why in scope rather than deferred: three strings, no behaviour change, and **nothing pins them** —
`tools-list-baseline.v1.json` predates `release-remove` (0 hits), and no test under `src/` asserts the
text (verified by grep). Leaving them means the agent sees two documents at once — `tools/list` and
the skill — that disagree on what is refused, what is stripped and when `jira` is `manual`; the
description is the one an agent reads _first_ when deciding whether to call. Why a separate commit: it
is CLI code with a CLI publish clock (`[BE]`), while C1 is `[DO] plugin:` with a plugin bump;
`plugin-ci.yml` path filters would not even run on it. The skill body's "a tool description that lists
it among the refusals is stale" line covers consumers on ≤0.7.9 until the next CLI publish carries C2.

Not touched: `command-catalog.test.ts` (its cross-check reads `skills/*/SKILL.md` dynamically and
`release-remove` is already in `EXPECTED_GATED_TOOLS`), `plugin-ci.yml` (paths cover `plugins/**`),
`scripts/report-published-cli-skew.mjs` (reports only; all three named tools are in the published
0.7.9 — `pnpm view infra-kit version` = 0.7.9 = `apps/infra-kit/cli/package.json`, and this session's
own tool list from the global CLI carries all three), `docs/session-env-picker-plan.md`,
`docs/session-context-orchestrator.md`, root `CLAUDE.md`, `.claude/worktrees/agent-*/` copies.

## 6. Pre-mortem

| #   | Failure                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Skill text drifts from the MCP guard set.** A later CLI change adds or removes a refusal on the MCP path and the body keeps describing the old set — e.g. someone restores the attached-issue count guard over MCP and the body still says "do not block".                                                                                                                                                                                                | U18 pins the sentence, so the body cannot lose it silently, but nothing links it to the CLI. Follow-up F1 (§9): a CLI test in `release-remove-mcp-guards.test.ts` that reads `plugins/infra-kit/skills/release-remove/SKILL.md` and asserts `Attached issues do not block` is present iff the `isMcpMode()` early return exists — the same file-pinning pattern `command-catalog.test.ts` already uses for tool names. Not in C1: it couples the CLI suite to plugin text and deserves its own decision. |
| 2   | **A fenced command reddens U6.** An editor "helpfully" fences `infra-kit release remove --skip-jira` in §1 or §3; U6 clause 2 fails (fenced `infra-kit` head with no rule), and adding a `Bash(` rule fails U14'.                                                                                                                                                                                                                                           | The body names CLI commands inline only, like `release-create`; §3 of this plan (option D) records why. U6's red test `U6 red: a fenced infra-kit command with no matching rule fails clause 2` is the guard.                                                                                                                                                                                                                                                                                            |
| 3   | **The agent reads `isError` as failure and falls back to Bash.** Worst case it runs `git push origin --delete release/v1.64.0` with no human approval.                                                                                                                                                                                                                                                                                                      | Same three-layer defence as `release-create`: the "does not mean the call failed" paragraph (U18-pinned), the explicit list of the four shell commands it must not run (U18-pinned), and `disable-model-invocation` so the procedure only loads when a human typed the slash command. Plus the tool-side fact that the gate returns before any mutation.                                                                                                                                                 |
| 4   | **The description-string inaccuracy causes an agent to refuse a legitimate removal.** On a ≤0.7.9 CLI the agent reads "refuses when … still carries issues" in `tools/list`, sees issue counts in the `gh-release-list`/`worktrees-list` rows or in its own knowledge of the version, and tells the human it cannot proceed — or, reading "are refused here", pads call 1 with `skipJira: true` "to be safe" and is surprised when `resolvedArgs` lacks it. | The §1 sentence "A tool description that lists it among the refusals is stale; this body is what holds" and the §3 "stripped by the server … will not appear in `resolvedArgs`" sentence are written for exactly this reader; C2 removes the inaccuracies at the source on the next CLI publish.                                                                                                                                                                                                         |
| 5   | **Token-budget line left stale.** C1 bumps `plugin.json` but the README still says 496 / 0.7.8; nothing in `plugin-ci.yml` reads the number, so the only enforcement is the manual release checklist, and the recorded baseline drifts two versions behind.                                                                                                                                                                                                 | AC 8 makes the refreshed line a condition of C1 and names the check as manual; the number is measured, not estimated.                                                                                                                                                                                                                                                                                                                                                                                    |
| 6   | **Refused after the human approved.** Call 2 comes back with a section-1 refusal (dirty main checkout, Jira unconfigured, merged in the window). The agent treats the human's earlier "yes" as standing consent and retries call 2 — with the same token (a TTL-only token still verifies) — or "helps" by clearing the state itself (`git stash`).                                                                                                         | §1 opener and the §5 bullet "Do not retry call 2 after a section 1 refusal": relay, let the human clear it, restart from call 1. U18 pins `The first call checks nothing about the release`. A re-mint is this plan's rule anyway once the human has changed the checkout — the server would accept the old token within its TTL — because the fresh gate is the new approval.                                                                                                                           |
| 7   | **The human approves a blind gate on `{version}` alone and a wrong-but-existing release is torn down.** `resolvedArgs` is `{version: "1.64.0"}`; the human meant `1.64.1`; both exist; nothing in the gate would have shown the difference.                                                                                                                                                                                                                 | Edit 3's pre-call listing: the body requires `gh-release-list` + `worktrees-list` rows shown _before_ call 1 and again next to `resolvedArgs`, so the human approves against the PR title, type and worktree path, not a bare number. Structural fix is F4 (a round-1 inventory echo in the gate), a CLI change.                                                                                                                                                                                         |

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
  dynamic scan of `skills/*/SKILL.md` must find `release-remove`, `gh-release-list` and
  `worktrees-list` all exposed.
- C2 only: `pnpm --filter infra-kit exec vitest run src/commands/release-remove src/mcp` — the
  strings are unpinned, so this is a no-regression run, not a behaviour test.
- `pnpm run qa` at the root before the commit (per memory: a full qa can rewrite manifests and the
  vendor mirror — `git status` before committing).

**E2E (human-only, describe, do not automate):** in a consumer checkout on a throwaway release
(`/infra-kit:release-create --desc "skill e2e" e2e-remove-probe`, then
`/infra-kit:release-remove e2e-remove-probe`): observe (1) the agent calling `gh-release-list` and
`worktrees-list` first and relaying the probe's row (PR number, type, worktree path), answering the
host's permission prompt for each; (2) the gate payload with `isError: true` and
`resolvedArgs: { version: "e2e-remove-probe" }` — and nothing else in it — shown next to those rows;
(3) the result carrying `jira: "manual"` with a `jiraVersion.url` (the probe was created with a fix
version), plus `localTipSha`/`remoteTipSha` relayed; (4) a second invocation reporting
`worktree: "absent"`, `pr: "already-closed"`, `localBranch: "absent"`, `remoteBranch: "absent"` — the
resumability claim — and the probe absent from `gh-release-list`'s rows (closed PR) as §3 warns.
Then the human deletes the fix version in Jira by hand, which is the point.

**Observability:** the `report-published-cli-skew.mjs` step summary on the PR must list no unexposed
tool for `release-remove`; the README token-budget line is the durable record of the description's
cost — refreshed by hand at release time, since CI does not enforce it.

## 8. Acceptance criteria

1. `plugins/infra-kit/skills/release-remove/SKILL.md` exists with frontmatter exactly
   `name`, `description`, `argument-hint: [<version|name>]`, `disable-model-invocation: true`.
2. `node --test 'plugins/infra-kit/__tests__/*.test.mjs'` passes with `'release-remove'` in
   `EXPECTED_SKILLS`, `PROCEDURE_SKILLS` and `PROCEDURE_CLAUSES`, and no existing assertion loosened.
3. Removing any one clause from the body makes U18 fail naming that clause (checked by hand, once).
4. The body contains zero fenced command lines and never names `mcp__infra-kit__`.
5. The body states, in these words or U18-pinned equivalents: the first call checks nothing and every
   refusal arrives on call 2; the gate carries `version` and nothing else; `version` is required and
   there is no picker; `skipJira` / `moveIssuesTo` have no tool field and are stripped; attached
   issues do not block; the fix version is never removed over MCP — `jira: "manual"` with
   `jiraVersion` when one exists, `jira: "absent"` when none; a `MERGED` PR is refused; a dirty main
   checkout is refused; every step is a verified no-op on re-run; what is lost with the worktree
   directory; the four shell commands not to run; the two read-only listings before call 1.
6. `claude plugin validate ./plugins/infra-kit --strict --json` reports no errors.
7. `pnpm run test:claude` and the CLI command-catalog test pass (three exposed names found).
8. `plugin.json` is `0.7.10` and the README token-budget line records a freshly measured number against
   `0.7.10`, with the delta ≤ 20% of 496 — checked by hand, as CI does not.
9. README table has the `/infra-kit:release-remove` row marked "human-invoked only".
10. C2: the three `releaseRemoveMcpTool` strings no longer describe the CLI path (no attached-issue
    refusal claim, "stripped" not "refused", `jira` manual-or-absent); the CLI suites pass.

## 9. ADR

**Decision.** Ship `release-remove` as a standalone, human-only procedure skill mirroring
`release-create`'s frontmatter, section order and register; hint `[<version|name>]` with no flags;
body states the MCP-path truth where it diverges from the CLI, including that the gate inspects
nothing and carries no inventory, so the agent lists releases and worktrees before call 1; the tool's
three CLI-flavoured strings are fixed in a separate CLI commit.

**Drivers.** The manifest gates as the contract; the five MCP/CLI divergences (gate timing, gate
payload, stripped flags, attached-issue guard, `manual`-vs-`absent`); separate plugin/CLI publish
clocks.

**Alternatives considered.** B (fold into `release-create --remove`), C (model-invocable),
D (fence the CLI escape), E (grant the read-only tools) — §3.

**Why chosen.** One skill per gated tool is the shape the tests already encode
(`PROCEDURE_SKILLS` is keyed by skill = tool); the human-only policy follows from the U14' rationale
without a new argument; a body checked sentence-by-sentence against the handler is the only thing
that stops an agent from inheriting either the tool description's overclaims or the sibling skill's
CLI-shaped timing.

**Consequences.** +~25 always-on tokens; two bodies carry the confirm-protocol paragraphs nearly
verbatim (accepted — U18 pins both, and a shared include has no mechanism in SKILL.md); two extra
host permission prompts per removal for the read-only listings (accepted — option E); the "stale
description" sentence in §1 is a deliberate cross-document statement that C2 makes moot but not
false; the human's approval is still on `{version}` alone until F4.

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
- F4: a round-1 plan-inventory echo for gated single-target tools — the CLI already builds exactly
  this text in `buildConfirmMessage` (`release-remove.ts:466-482`) and renders it only through
  `confirmOrExit`; surfacing it in the gate's `message` would let the human approve against the
  worktree path, PR state, tip SHAs and issue counts instead of a bare `version` (pre-mortem #7).
  A `tool-handler.ts` change with its own confirm-gate tests; not this plan.

## 10. Commit plan

1. **C1** `[DO] plugin: release-remove skill — tearing down a release over MCP` — the SKILL.md,
   `manifest.test.mjs` (three tables + two comments + one test title), README (row + token-budget
   line), `plugin.json` 0.7.10. Body notes: U17' is vacuous by design (no flags), the measured token
   number, and that the body contradicts the ≤0.7.9 tool description on purpose.
2. **C2** `[BE] release-remove: the MCP tool's prose stops describing the CLI path` — three strings
   in `release-remove.ts`. Rides the next CLI publish; not a prerequisite for C1.

Order: C2 first is fine but not required; neither commit's tests read the other's files. Publish the
plugin (C1) as a normal plugin release; C2 publishes with whatever CLI release comes next.
