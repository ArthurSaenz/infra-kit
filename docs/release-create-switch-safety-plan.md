# [DO] `release create` — safety of the auto-switch practice

Status: **pending approval** (ralplan `--deliberate`; Planner → Architect → Critic, revision 7 — Critic APPROVE)

## Problem

`release create` mutates the operator's own checkout: it runs `git switch <base>` and
`git checkout -b <release>` in the main working tree. The clean-tree premise that makes that
acceptable is asserted **once** (`release-create.ts:356`) and never again, while the batch loop
below it runs an arbitrary number of destructive git sequences, continues past failures, and hands
each entry's leftover state to the next entry as its precondition.

Scope fixed by the operator (2026-09-07):

- Two release types only. `getBaseBranch` mapping unchanged: `regular → dev`, `hotfix → main`.
- Dirty tree ⇒ **refuse**, with the offending paths named. Never stash, never repair.
  *(The operator was offered "make the command independent of tree cleanliness by relocating into a
  scratch worktree" and declined it in favour of the refusal.)*
- HEAD ends on the base branch; restoring the pre-run branch was explicitly declined.

## Defects (verified against the working tree, 2026-09-07)

| # | Defect | Evidence |
|---|---|---|
| D1 | The clean-tree guard is stale by the time it is relied on. It runs at `:356`, `confirmReleases` (`:358`) awaits input, then the loop (`:363`) switches branches. The **large** window is not the prompt — it is entry k>1, whose guard evidence predates entry k−1's full Jira + `gh pr create` + double-push round trip. | `release-create.ts:356,358,363`; `release-utils.ts:45` |
| D2 | `$.quiet` is a global set `true` and reset only after the last successful statement, with no `try/finally`. Every throw in between leaks `true`; this process is also a long-lived MCP server, so the leak outlives the failing tool call. The `catch` at `gh-release-prs.ts:225` logs and rethrows without resetting. | `release-utils.ts:42,48`; `gh-release-prs.ts:174,176` and `203,219` |
| D3 | No rollback. `git checkout -b` (`:207`) can succeed while a later step fails; `executeOne`'s catch (`:299-308`) swallows it and proceeds to entry k+1. The trailing `git switch <base>` sits **inside** the `try` (`:217`), so on failure HEAD is left on the half-made release branch — the failure path silently breaks the end-on-base contract too. | `gh-release-prs.ts:207,217`; `release-create.ts:299-308` |
| D3b | **`push -u` runs before the empty commit** (`:208` then `:209`). The branch is local-only for exactly one command, so almost every failure leaves a *pushed*, zero-commit remote branch with no PR. | `gh-release-prs.ts:207-213` |
| D3c | **The Jira version is created before any git work** (`release-utils.ts:67` → `:82`). Every git failure orphans a Jira version, and retrying the same version fails as a duplicate. | `release-utils.ts:67,82` |
| D4 | `git switch <base>` hard-fails when `dev`/`main` is held by a linked worktree — the normal case on this team. Git's own message *does* name the holding path and `extractStderr` surfaces it; the damage is that `executeOne` relabels it with wrong remediation. | `gh-release-prs.ts:205`; `release-create.ts:302`; `operation-error.ts:19-22` |
| D5 | `git pull origin <base>` is not `--ff-only`: a diverged local base silently produces a merge commit on `dev`/`main`, and the release branch is cut from it. **This is itself a divergence source** — see PM3. | `release-utils.ts:46`; `gh-release-prs.ts:206` |
| D6 | The **switch/pull pair** runs twice per entry (`release-utils.ts:45-46`, then `gh-release-prs.ts:205-206`). `git fetch` runs once *per entry*, at `release-utils.ts:44`. The second pull is the one that races, because it runs after the Jira round trip. | as cited |
| D7 | The dirty-tree refusal names no files. | `git-guard.ts:75-81` |
| D8 | Guard placement is inconsistent between the two consumers: `deliver` asserts as its first statement (`gh-release-deliver.ts:370`), `release create` only after `loadJiraConfig` (`:332`) and the wizard (`:341`). | as cited |
| D9 | `$.quiet` restoration is missing a `finally` in `gh-release-deliver`'s deliberate unmute block (`:292` sets `false`, `:302` restores `true`) — the pairing is intentional and correct; only the exception path is unguarded. | `gh-release-deliver.ts:291-303,402,415` |

D1 + D3/D3b/D3c together are the real hazard: **a failure in entry k is the input to entry k+1**,
and the leftovers it produces are the ones that block retrying entry k.

## Principles

- **P1 — Verify adjacent to the mutation.** A guard separated from its use by a prompt *or a network
  round trip* is a stale assertion, not a guard.
- **P2 — Refuse with the evidence, never repair.** Report what blocks the run and the command to
  clear it. Never touch the operator's uncommitted work — **and never delete *or adopt* a ref the
  command cannot prove it created**. Adoption is the more consequential direction: a wrongly deleted
  branch is recoverable from the reflog, but a release PR opened from someone else's branch ships
  their code.
- **P3 — Each entry is atomic through `gh pr create`.** That is the declared boundary. A Jira
  version created before a git failure is a *reusable*, not orphaned, artefact (A1'), so it needs no
  rollback. What may survive a failure is: a pushed release branch with no PR (resumable, A10) and a
  reusable Jira version. Nothing else. Each survivor is named in the failure report.
- **P4 — Restore global process state on every exit path**, in both directions. *(Scope limit:
  `$` is process-global and this is a long-lived MCP server, so a path-scoped fix does not fully
  discharge P4 against a concurrent tool call. Accepted; noted in Follow-ups.)*
- **P5 — Preserve the deliberate contract.** Two types, unchanged base mapping, HEAD ends on the
  base branch — including on the failure path, which today it does not.

## Decision drivers

- **DD1** The batch loop continues on failure, so entry k's leftovers are entry k+1's preconditions.
- **DD2** The clean-tree fact is what *authorizes* the auto-switch; its freshness at the moment of
  mutation is the whole safety argument.
- **DD3** Asymmetric costs: a false refusal costs one `git stash`; a false proceed costs a mangled
  local base branch, a pushed branch with no PR, and an orphan Jira version. Bias toward refusal.
- **DD4** Ordering beats machinery: reordering the existing git sequence removes more leftover
  states than any rollback bolted around the current order.

## Options

### Option A — Reorder, guard at the boundary, resume-or-roll-back *(chosen)*

**A0 — Reorder the destructive sequence (prerequisite).** `gh-release-prs.ts:207-210` becomes
`git checkout -b` → `git commit --allow-empty …` → a **single** `git push -u origin <branch>`.
Collapses two pushes into one, eliminates the zero-commit remote branch, and makes "local-only,
safe to delete" the common failure state rather than a one-command sliver (D3b).

**A1' — Make Jira version creation idempotent (replaces the earlier "move Jira after the PR").**
`createJiraVersion` (`jira/api.ts:49-92`) POSTs unconditionally and `assertJiraOk` (`:79`) throws on
the duplicate — that, and only that, is what makes D3c block a retry. `findVersionByName` already
exists (`jira/api.ts:134-147`) and is already re-exported (`integrations/jira/index.ts:4`), so
`createSingleRelease` becomes `findVersionByName(versionName, cfg) ?? createJiraVersion(...)`.
About five lines.

*Why this replaces the reorder.* Moving `createJiraVersion` after `createReleaseBranch` was the
revision-3 design. It is workable — `updateReleasePRBody` (`gh-release-prs.ts:170-181`) does close
the loop and is in production use at `release-desc-edit.ts:185` — but it manufactures a new survivor
(a live PR with a placeholder body and no Jira version) that **no command in this CLI can repair**:
`release-desc-edit` refuses in exactly that state (`release-desc-edit.ts:129-136`). It would also be
invisible to A10, whose detector keys on "no open PR", so the entry would be neither retryable nor
resumable. Idempotency retires D3c without any of that, and preserves today's invariant that a PR
never exists without its Jira version.

*Cost:* one extra `getProjectVersions` round trip per entry — the same call `getJiraDescriptions`
(`release-utils.ts:105`) already makes elsewhere. A Jira version still survives a git failure; it is
now reusable rather than blocking, which the failure report says.

*Four decisions this needs, none of them free:*

1. **Adoption asymmetry vs P2.** A1' adopts any Jira version matching the name, with no provenance
   gate — while P2 and PM7 impose one on branch adoption. The asymmetry is deliberate and is argued
   rather than assumed: a Jira fix version is a *name reservation* in a shared project, routinely
   pre-created by a PM for exactly this release, so a name match is the intended target rather than
   a foreign artefact — and unlike a branch it carries no code, so the "ships someone else's code"
   harm P2 exists to prevent cannot arise. Recorded as PM8.
2. **Description on the reuse path.** `createSingleRelease` (`release-utils.ts:61-91`) passes
   `description` only into `createJiraVersion`; a bare reuse would silently keep the old description
   while the PR body is built from the **new** one (`gh-release-prs.ts:200`), leaving the two
   permanently divergent. When the descriptions differ, reuse must call
   `updateJiraVersion({ versionId, description })` (`jira/api.ts:156-197`) — the same call
   `release-desc-edit.ts:180` already makes for this purpose — and the test lane must assert it.
3. **Released / archived versions.** `deliverJiraRelease` (`jira/api.ts:207-237`) sets
   `released: true`. Re-cutting a release whose version was already delivered is a realistic re-run,
   and a silent reuse of a delivered version is wrong. Refuse and report in that case.
4. **Return-shape mismatch, and where the URL helper goes.** `findVersionByName` returns
   `JiraVersion | null` while `createJiraVersion` returns `{ success, version }`, and
   `release-utils.ts:79` reads `result.version!.projectId` / `.id`, so both arms need a common URL
   builder. `buildJiraVersionUrl` already exists at `release-desc-edit.ts:28` — but **exporting it
   from there would be a genuine module cycle**: the consumer is `createSingleRelease` in
   `lib/release-utils`, and `release-desc-edit.ts:13-18` already imports `src/lib/release-utils`.
   It also inverts layering (`lib → commands`; the only such edge today is `lib/command-catalog`,
   the deliberate composition root). Move it into `src/integrations/jira` instead — both its
   parameters, `JiraConfig` and `JiraVersion`, originate there — and have `release-desc-edit` import
   it from that barrel. A1' is therefore ~20 lines across three files, not ~5.

*Residual:* A1' is check-then-act, so two concurrent runs can both see `null` and both POST; the
loser still gets the duplicate. Not worse than today. The completing fix — catch the duplicate and
re-find — is in scope, but it is **not implementable as stated today**: `assertJiraOk`
(`jira/api.ts:23-40`) throws `Error('HTTP <status>: <statusText>')` and only *logs* the response
body (`:28-37`), so a catch cannot tell a duplicate-name conflict from any other 4xx. Either
`assertJiraOk` attaches the body, or the retry re-finds on every failure. Decide in the change; do
not leave it implicit.

**A2 — Place the base-branch precheck where `base` first exists (corrected).**
`base` is derived from `entries`, and `entries` are *produced by* the wizard (`:341`), so
`assertBaseBranchSwitchable(base)` **cannot** be hoisted above it. It goes immediately after
`assertHomogeneousReleaseType` (`:351`) — which is what makes a single `base` knowable there, so
that function becomes load-bearing and its JSDoc (`:237-247`, "no longer a technical limit") must be
updated. That position is still **before the confirmation prompt (`:358`) and before every
mutation**, which is the property that matters. Both base-agnostic legs of `assertManagementContext` — linked-worktree **and** clean-tree — are
hoisted to the top of the handler, matching `deliver` (D8). Hoisting the clean-tree leg is free and
DD3-aligned: today the most common refusal costs the operator every version, type and description
they typed into the wizard (`:341`) before it fires at `:356`.
The volatile clean-tree leg is re-asserted **twice**, and the second one is the one that discharges
P1:

- **Per entry in `executeOne`, immediately before `prepareGitForRelease` (`:285`)** — in `commands/`,
  not inside `lib/release-utils`, so no `lib → git-guard` import is introduced (see A4). This is the
  cheap early refusal, before anything mutates. It goes **inside** the existing `try` (which opens
  at `:284`), so the refusal is recorded as that entry's failure and the batch continues — required
  by PM1, which needs the summary to enumerate the entries that already completed with their PR
  URLs. Placing it outside the `try` would abort the batch and lose that report.
- **Immediately before `git checkout -b` inside `createReleaseBranch`** — because A1' keeps Jira
  creation *ahead* of the git work, the first check is separated from the actual mutation by an
  unbounded HTTP round trip, which is precisely the staleness P1 exists to forbid. Checking again at
  the mutation site is what makes acceptance criterion 1 true *at the mutation* rather than one
  round trip before it. Layering is clear in this direction: after A4 `getWorkingTreeStatus` lives
  in `git-utils`, `gh-release-prs.ts` already imports `lib/errors`, `lib/logger`, `lib/release-id`
  and `lib/release-utils`, and nothing under `lib/git-utils` imports `integrations/gh`.

This second check is the answer to the strongest objection against A1': revision 3's "move Jira
after the PR" would have removed the round trip entirely, and A1' was chosen over it on
retryability grounds (the unrepairable survivor at `release-desc-edit.ts:129-136`). That argument
settles retryability but says nothing about adjacency, so adjacency is paid for here instead.

**A3 — Match worktrees by branch name (design constraint on the new code, not a fix to old code).**
`listWorktrees` already strips `refs/heads/` (`git-utils.ts:67`), so compare `entry.branch === base`.
A path-equality predicate would be exposed to the `/var`→`/private/var` asymmetry between
`listWorktrees`' git-reported paths and `getProjectRoot`'s `--show-toplevel`. The value added over
git's native error is the **remediation text**: `release-create.ts:302` currently says "verify the
version or name is unique and the base branch is clean" for a worktree-holding failure.

**A3b — `assertBaseBranchSwitchable` lives in `git-guard`; it needs a `cwd` and a current-branch leg.**
`git-guard.ts:4` already imports from `src/lib/git-utils`, so hosting this predicate adds a
**symbol**, not a module edge — nothing reachable from the `git-utils` barrel imports `git-guard`,
so there is no cycle and the cost is smaller than earlier drafts implied. `git-guard` composing
read-only git primitives into `OperationError` refusals is exactly what this is.
Two mechanics the item must state: `listWorktrees` takes a **mandatory `cwd`**
(`git-utils.ts:41`), so the predicate needs `getProjectRoot()`; and `listWorktrees` **includes the
main checkout as its own record** (`git-utils.ts:40-41`), so branch-name-only matching would refuse
the single most common invocation — the operator already standing on `dev`. The path-free
discriminator is `getCurrentBranch()` (`git-utils.ts:194`): git forbids two worktrees on one branch,
so `currentBranch === base` is a *complete* proof that the holder is us, and it must be the first
leg. Path equality remains forbidden (A3).

**A4 — Porcelain reader belongs in `git-utils`.** Promote `isWorkingTreeClean`
(`git-utils.ts:203-207`, which runs `git status --porcelain` and discards the output) to
`getWorkingTreeStatus(): Promise<string[]>`, with `isWorkingTreeClean` derived from it.
`git-guard.ts` stays a pure composer of primitives + `OperationError`.

**A5a — Preserve the refusal detail through `executeOne`'s re-wrap (Ship 1, required by A5).**
`OperationError` stores only `operation` and `remediation` (`operation-error.ts:60-70`);
`stderrExcerpt` is consumed into the message string by `buildMessage` (`:31-40`) and **not kept on
the instance**, and `extractStderr` (`:18-23`) reads `.stderr` off the cause. So when `executeOne`
re-wraps a per-entry failure — `new OperationError(error, { … })` at `release-create.ts:300-303` —
the inner refusal's text is **erased**: the surfaced message is only the generic outer one
("verify the version or name is unique and the base branch is clean"), which is wrong advice for
every refusal this plan adds. That silently defeats A5 for **every** new per-entry refusal in Ship 1
(A2's second clean-tree check, A6's divergence refusal, A8a's keep-and-report). It does not affect
criterion 4, whose refusal fires at `:351` outside the loop.
Note the cause-walk alone does **not** fix this: walking from the outer error finds an inner
`OperationError` with no `.stderr`, whose own cause is `undefined`.
Fix: add `readonly stderrExcerpt?: string` to `OperationError` and have `extractStderr` read it as
well as `.stderr` while walking the `cause` chain. **The `extractStderr` cause-walk therefore moves
out of A8 (Ship 2) and into Ship 1**, because Ship 1 is where the first nested `OperationError`
appears.

**A5 — Two-channel refusal.** `STDERR_EXCERPT_MAX_BYTES = 200` plus the single-line join
(`operation-error.ts:1,36,39`) cannot carry a realistic status. So: a `logger.error` block listing
every path *before* the throw (the idiom `gh-release-prs.ts:226` already uses), and an
`OperationError` carrying the first few paths plus an accurate `(+N more)`.

**A6 — `--ff-only`** on the base pull (D5), refusing a diverged base by name rather than merging it.

**A7 — Per-invocation quiet** (`$({ quiet: true })`) at every release-create-path site, including
`updateReleasePRBody` (`:174,176`). Six sites in this repo already use a correct save/restore idiom
(`preflight.ts:25-44`, `env-load.ts:364-388`, `local-deploy.ts:74-91`,
`load-existing-versions.ts:38-46`, `env-token-set.ts:103-118`, `doppler-project.ts:77-96`);
`$({quiet:true})` is preferred because it touches no global at all.

**A8a — In-call pre-push cleanup (Ship 1, no machinery required).**
A0 leaves `release/vX` present locally whenever the run fails at the empty commit or the push —
including PM4's own scenario. A re-run then dies at `gh-release-prs.ts:207` with
`fatal: a branch named 'release/vX' already exists`, so "local-only leftover" is **not** the same as
"retryable". Closing that needs no progress record, no schema change and no `executeOne` rollback:
`createReleaseBranch` knows *in-call* that it just ran `checkout -b`, so a narrow `try/catch` inside
it switches back to `<base>` and deletes the local branch before rethrowing. It belongs in Ship 1
with A0; A8 below remains Ship 2, covering the post-push cases A8a cannot see.

Three clauses are load-bearing, because "pre-push" is a *phase* the caller can name and not a *fact*
the callee can observe:

1. **The try opens only after the `checkout -b` await resolves.** Otherwise an `already exists`
   failure lands inside the cleanup region and force-deletes (`git-utils.ts:257`, `-D`) a branch the
   command did not create — the P2 catastrophe, in a ship that has no A8 carve-out to stop it. This
   scoping rule is what makes acceptance criterion 7 true in Ship 1 rather than merely asserted.
2. **Probe before deleting.** What the code observes is not "the push has not happened" but "the
   push *call rejected*" — and a push the remote accepted whose transport then died exits non-zero
   with the ref created. So: `git ls-remote --heads origin <branch>` (the idiom `deleteRemoteBranch`
   already uses, `git-utils.ts:269-271`); a ref present means **keep and report**, never delete.
   **A probe that rejects counts as "ref present"** — keep the branch, report it, and append the
   probe failure. Only an *empty, successful* probe authorizes the delete. This must be stated,
   because the probe's most likely failure is correlated with the push's (same network, same auth),
   and clause 3's swallow rule would otherwise push an implementer straight into the unsafe default.
   `deleteRemoteBranch`'s JSDoc (`git-utils.ts:262-267`) already establishes this rule for the repo:
   a network/auth failure must propagate rather than be "silently misread as 'branch absent'".
   Without this, Ship 1 destroys the operator's only handle to a pushed branch *and* — with A11 not
   yet landed — cannot even name it in the report, which is strictly worse than today's do-nothing.
3. **The cleanup swallows and appends, never throws**, exactly as A9's `finally` must. A rejecting
   cleanup would skip the rethrow and replace the original diagnosis.

The cleanup region runs from just after `checkout -b` resolves to the **end of the function**, so a
`gh pr create` failure is inside it too — safe, because that is post-push and clause 2's probe then
keeps and reports.

**A8 — Rollback with explicit provenance, best-effort (Ship 2).**
`createReleaseBranch` signals progress by **throwing a `ReleaseBranchProgressError`** carrying
`{ createdLocalBranch, pushed }` (a function cannot both return and throw the same record, and
`createSingleRelease` has no catch to thread an out-param through). **That interposition must not
break `extractStderr`**, which today reads `.stderr` off the immediate cause only, one level, with
no recursion (`operation-error.ts:14-23`) — so `executeOne`'s `new OperationError(error, …)`
(`release-create.ts:300`) would silently lose git's own stderr from every release-create failure,
including D4's worktree-holding message whose entire value is that git names the path. Fix
`extractStderr` to walk the `cause` chain; that is a small, general improvement and is a **required
part of A8**, with a unit test asserting a worktree-holding `git switch` failure still surfaces the
path.
Progress state is never re-derived from `git branch --list`, because that cannot distinguish a
branch this entry created from a pre-existing one — and `deleteLocalBranch` force-deletes (`git-utils.ts:257`,
`-D`), so a wrong inference destroys operator commits (P2). If `git checkout -b` fails **because the
branch already exists**, the command refuses and reports; it never rolls back.
`git switch <base>` must run **before** any delete, because `deleteLocalBranch` silently no-ops on
the current branch (`git-utils.ts:255`) and force-deletes with `-D` otherwise (`:257`), so a
rollback that forgets this passes while doing nothing. Note A9 largely subsumes this: its `finally`
already puts HEAD on base before `executeOne`'s catch runs, so the explicit switch matters only when
that `finally`'s own switch failed — which is precisely the silent-no-op case.
The whole rollback is wrapped in its own `try/catch` inside `executeOne`'s catch: a rollback failure
is **appended to the failure record**, never thrown, so it cannot escape the loop (`:363-368`) and
skip `logFinalSummary` (`:370`) and `commandEcho.print()` (`:372`).
In the pushed case the **local** branch is also kept, not deleted — it is the operator's handle and
the input to A10.

**A9 — Collapse the duplicated switch/pull** (D6): `createReleaseBranch` documents "caller
guarantees a freshly-pulled base checkout" and drops `:205-206`. Its trailing `git switch <base>`
(`:217`) moves into a `finally`, so P5 holds on the failure path too (D3). Two constraints on that
`finally`: it **swallows and appends, never throws** — a `git switch` failure there would replace the
original error and destroy the diagnosis (the mechanism meant to uphold P5 would erase the failure);
and because A1' keeps the Jira round trip *between* `prepareGitForRelease`'s pull and
`checkout -b`, removing the second pull moves base-freshness verification away from the mutation it
authorizes — the exact anti-pattern P1 names. So A9 keeps a cheap freshness assertion at the
mutation site in place of the deleted pull. The assertion is **`HEAD` == the `origin/<base>` SHA that
`prepareGitForRelease` just fetched and pulled**, carried forward explicitly. Its value must be
described honestly: with A6 in the same ship, `git pull --ff-only` makes local base *identical* to
the fetched tip, so this number is the same as a post-pull HEAD snapshot — it is a **local-drift
detector** (a concurrent MCP tool call, an operator switching branches mid-run), not a proof of
remote convergence. Remote convergence is what the deleted pull actually provided, and A9 abandons
it deliberately; the fetch stays in `prepareGitForRelease`. Unstated cost: "carried forward
explicitly" is a three-hop signature change — `prepareGitForRelease` (`release-utils.ts:39`, today
`Promise<void>`, exported at `lib/release-utils/index.ts:9`) → `executeOne`
(`release-create.ts:285`) → `createSingleRelease` (`release-utils.ts:61`) →
`CreateReleaseBranchArgs` (`gh-release-prs.ts:183-193`).

**A10 — Resume a half-created release (this is what makes retry real), with a provenance gate.**
Adoption is a P2 action: the command must prove the branch is one of its own before attaching a PR
and a Jira version to it. So adoption requires **all** of:

- `gh pr list --head <branch> --state all --json state,url` returns **empty**. Not
  `getReleasePRsWithInfo` / `fetchAllReleasePRs` (`gh-release-prs.ts:75-100`), which is title-search
  based, open-only, and capped at 200 with `warnIfTruncated` (`:54,:61-68`) — a full page makes "no
  PR" indistinguishable from truncation, and GitHub's search index lags by seconds in exactly the
  window after a partial `gh pr create`. A **closed** PR means someone abandoned this release
  deliberately; a **merged** one makes `gh pr create` fail `No commits between dev and release/vX`.
  Either way: refuse, do not adopt.
- Shape assertion on the remote branch: `git rev-list --count origin/<base>..origin/<branch>` is 1,
  that commit is empty (`git diff-tree --quiet`), and its parent **equals** the base tip —
  `git rev-parse origin/<branch>^` == `git rev-parse origin/<base>`. **Reachability is not enough**:
  a `release/*` branch cut from `origin/dev` months ago satisfies a reachability test (ancestry is
  transitive) and its single empty commit is still the only commit absent from dev, so adoption
  would open a release PR on a branch *behind* dev by everything merged since — and
  `release deploy-all` would then deploy from it. Without the base-tip leg a hotfix-shaped branch
  adopted as regular also opens a PR carrying all of `main`'s diff against `dev`.

Adoption is **checkout-free** — `gh pr create --base <base> --head <branch>` needs no local branch,
and `git switch <branch>` onto a stale local copy would diverge from the remote.
Without A10, A0 merely converts D3b's leftover from "pushed empty branch" to "pushed branch with one
commit and no PR" — tidier, still un-retryable, because a re-cut branch makes a new commit and
`push -u` is then rejected as non-fast-forward.

**A11 — Widen the failure record and the MCP schema.** `FailedRelease` is `{ version, error }`
(`release-create.ts:212-215`) and `outputSchema.failedReleases` is locked to the same shape
(`:462-469`). Naming the surviving artefacts (remote branch, local branch, Jira version, PR URL)
requires widening both. This is a **tool-schema change visible to every MCP client**.
It is not merely release-note material: `structuredContent` is validated against `outputSchema`
(`mcp/tools/index.ts:40`; `tool-handler.ts:51-54` — validation is skipped only when `isError` is
set), so A8's surviving-artefact fields are stripped or rejected on the MCP path unless A11 lands
**first**. A11 alone is inert; **A8 alone is broken.**

A11 also breaks the W1 baseline differential, and the remedy is constrained by that file rather
than free. The assertion that reds is the whole-object `toEqual` in the `comparable` loop
(`mcp/__tests__/mcp-stdio.e2e.test.ts:1560`); `release-create` is in the baseline fixture, so it is
compared. Two obvious remedies are **explicitly ruled out by the file itself**:

- *Re-capturing the fixture* — forbidden at `:822-826`: the fixture is evidence captured **before**
  any dependency change and is the reference the confirm-gate defect is proven against.
- *Adding `release-create` to `SOURCE_CHANGED_DURING_MIGRATION`* (`:1428`) — the same comment block
  rejects this for the previous case, and the arithmetic is now worse: the list already holds three
  names, and 23 − 4 = 19 trips the suite-swallowing guard
  `expect(comparable.length).toBeGreaterThanOrEqual(20)` at `:1524`.

The sanctioned pattern is a **named strip of the changed field, applied to the *served* list**, via
`withoutAuthoredDeltas` (`:931-941`, applied at `:1414`) — the mechanism D9-D11 already use for
`confirmToken`, `title` and `annotations`. The direction matters and is easy to get backwards:
D4's `skipPreflight` handling (`:817-843`) normalizes the **baseline** because that field was
*removed*; A11 *adds* fields, and you cannot normalize out of a baseline something the baseline does
not contain. (`failedWorktrees` is **not** the precedent to copy — it was handled by the exclusion
list at `:1425-1428`, the very remedy ruled out above.)

**There are two failing assertions, and the plan must name the first one.** Before `:1560` is
reached, the self-check at `:1491-1494` fails, with a message that actively misdiagnoses the cause:
*"predicate is tautological — it reports the unchanged tool … as differing"*. Its `unchangedControl`
(`:1485-1490`) is the first non-excluded tool with a non-empty `inputSchema.properties`, which
**resolves to `release-create`** in the current fixture (verified: 23 tools; excluded set is
`gh-merge-dev`, `worktrees-remove`, `worktrees-sync`). Extending `withoutAuthoredDeltas` fixes
`:1493` and `:1560` together; a baseline-side edit fixes neither, because the self-check reads the
stripped served list.

Two further details A11 must carry: the baseline element declares
`required: ["version","error"]` **and** `additionalProperties: false`, so the new fields must be
`.optional()` or `required` drifts as a second key — and `additionalProperties: false` is exactly
what makes the client-compatibility question real rather than theoretical, since a strict validator
will reject the widened payload. Nothing today checks that.

### Option B — Move creation into a scratch worktree — *rejected by the operator*

`gh-merge-dev` proves the mechanism in this repo (`withScratchWorktree`; real merges and
`pushAtomic` from a scratch checkout, `gh-merge-dev.ts:385`), and a trailing `git switch <base>` in
the main checkout could satisfy P5, so the earlier claim that "HEAD never moves" was not a valid
refutation and has been withdrawn. **B is rejected because the operator was offered exactly this —
"make the command independent of tree cleanliness by relocating into a scratch worktree" — and
chose the refusal-with-report design instead.** It stays available if that decision is revisited;
on the merits it is plausibly *less* code than A8 + A9 + A0.

### Option C — Guard only (re-check + file listing) — *rejected*

**Antithesis (steelman):** A fixes the cheapest defect in the wrong command. `deliver`'s
guard-to-mutation window (`gh-release-deliver.ts:370` → `:310`) spans a picker, a squash merge, an
RC-PR merge and a workflow dispatch — *minutes* — and its mutation is a merge into `dev` that is
immediately pushed. By DD3 that window is strictly worse.

**Answer:** right about `deliver`, wrong about C. C leaves D3b and D3c intact — the leftovers that
make a retry impossible — and A0 + A1' + A10 are the items that address them, none of which are in C.
`deliver` is promoted to follow-up #1 rather than absorbed.

**Scope note:** the operator asked specifically about creating release/hotfix branches, so this plan
stays there. `deliver` having a worse window is surfaced, not hidden.

## Pre-mortem

- **PM1 — A per-entry refusal fires mid-batch, after entry 1 already created a PR.** Mitigated by
  A2: every stable refusal now happens before the confirmation prompt, so the only mid-batch refusal
  left is a genuinely newly-dirtied tree. The refusal must still enumerate completed entries with
  their PR URLs.
- **PM2 — Rollback deletes a branch someone already fetched.** A0 shrinks this to the true
  local-only window; a pushed branch is never auto-deleted. Correction carried from review: telling
  the operator to "just run `gh pr create`" is **wrong** whenever the push preceded the empty commit
  — GitHub rejects it with `No commits between dev and release/vX`. After A0 that state cannot
  arise; until A0 lands the advice must not be printed.
- **PM3 — `--ff-only` becomes a day-one refusal.** *(Corrected — the earlier "static answer" was
  refuted by this plan's own D5.)* The dominant divergence source is **this command itself**: every
  prior run's non-`--ff-only` `git pull origin <base>` (`release-utils.ts:46`, `gh-release-prs.ts:206`)
  can have left a merge commit on the local base. `syncMainIntoDev` (`gh-release-deliver.ts:305-313`)
  is a second, bounded source (its merge is pushed immediately, so divergence survives only a failed
  push), and an ordinary operator commit is a third. So A6 will refuse on checkouts that worked
  yesterday. That is correct per DD3, but it must be budgeted: the refusal prints
  `git rev-list --left-right --count origin/<base>...<base>` and the recovery
  (`git switch <base> && git reset --hard origin/<base>`, with an explicit warning that this discards
  local base commits — P2 forbids the tool from running it).
  *(Unmeasurable in this repo regardless: `infra-kit` has no `dev` branch.)*
- **PM4 — `git commit --allow-empty-message --allow-empty --message ''` (`gh-release-prs.ts:209`;
  the `--allow-empty` is load-bearing for A0) is rejected by a `commit-msg` hook.**
  **Unverified risk.** This repo has no `core.hooksPath`, no `.husky/`, no non-sample `.git/hooks/`;
  the consumer repos were not reachable from here. A0 makes such a failure happen *before* the push
  instead of after — strictly better — but it must be confirmed against one real consumer repo
  before A0 lands.
- **PM5 — The rollback itself fails.** `deleteLocalBranch` rejects when the branch is checked out in
  another worktree (`git-utils.ts:247-248`), and A8's `git switch <base>` can fail for D4's own
  reason. Mitigated by A8's best-effort wrapping: the rollback failure is appended to the failure
  record, never thrown, so the batch summary and `commandEcho.print()` always run.
- **PM6 — The branch already existed.** `git checkout -b` fails with `already exists`; a
  provenance-free rollback would force-delete it. Mitigated by A8 (explicit progress record, and an
  outright refusal in this case) and by A10, which adopts the existing branch instead.

- **PM7 — A10 adopts a branch it did not create.** A `release/*` branch pushed by another operator,
  or a stale one from months ago, would otherwise get a PR opened against it and a Jira version
  attached — shipping someone else's code under this release. **The gate proves shape, not
  provenance**, and that must be stated honestly: a branch another operator pushed with this same
  command satisfies every leg identically. What makes adoption safe is not that we can prove we
  created it, but that the legs force it to be **empty and cut from the current base tip** — so no
  foreign code can ride in, which is the harm P2 exists to prevent. A real provenance signal (a
  trailer on A0's empty commit) is nearly free and is the recommended hardening if adoption ever
  covers non-empty branches.

- **PM8 — A1' adopts a Jira version it did not create.** The direct analogue of PM7, and the
  asymmetry P2 would otherwise forbid. Accepted deliberately, with the argument recorded in A1'
  decision 1: a fix version is a shared name reservation carrying no code. Refused outright when the
  version is already released or archived (A1' decision 3).

- **PM9 — A11 reddens the W1 baseline differential and the obvious fixes are forbidden.** Both
  re-capturing the fixture (`mcp-stdio.e2e.test.ts:822-826`) and extending
  `SOURCE_CHANGED_DURING_MIGRATION` (`:1428`, and 23 − 4 = 19 < the `:1524` floor of 20) are ruled
  out by the file itself. Mitigated by using the sanctioned named-normalization pattern (`:830-831`)
  plus a `w1c-pre` control; the risk is that an implementer discovers this only after attempting a
  re-capture, so it is called out in A11 rather than left to be found.

- **PM10 — The new refusal's message is swallowed by an existing wrapper.** `executeOne` re-wraps
  every per-entry failure (`release-create.ts:300-303`) and `OperationError` does not retain
  `stderrExcerpt`, so a refusal that reads perfectly in a unit test renders as a generic string on
  the MCP path. Detection is silent — nothing in the old test plan inspected
  `failedReleases[].error`. Mitigated by A5a plus the dedicated integration assertion.

- **PM11 — The cleanup's own probe fails.** A8a's `ls-remote` most likely fails for the same reason
  the push did, and clause 3's swallow rule would otherwise fall through to the delete — satisfying
  the letter of all three clauses while committing the exact P2 harm clause 2 exists to prevent.
  Mitigated by treating a rejecting probe as "ref present".

## Test plan

Harness template: **`src/commands/gh-merge-dev/__tests__/gh-merge-dev-worktrees.test.ts`** — a
command-level test over a real temp git repo (`fs.mkdtemp`, `git init -q --bare`) that mocks four
modules: `src/integrations/gh` (`:30`), `src/lib/git-guard` (`:34`), `src/lib/git-utils` **partially**
(`:38` — `getMainRepoRoot`, the seam that makes the fixture reachable) and `src/lib/logger` (`:44`).
The release-create lane needs that same partial `git-utils` seam. Plus
`src/lib/git-utils/__tests__/merge-refs.test.ts` for the bare-origin fixture.
*(Correction: `git-guard.test.ts` is 100% `vi.mock`-based with no git process at all, and
`release-create.test.ts` deliberately avoids the handler — there is currently **zero** coverage of
`releaseCreate`/`executeOne`. A mocked `isWorkingTreeClean` cannot prove "no `git switch` ran", so
tests written in that style would be green and vacuous.)*
Seams for the integration lane: `vi.mock('src/integrations/jira')` and
`vi.mock('src/integrations/gh', …)`, per that precedent.

**Unit**
- `getWorkingTreeStatus` / dirty refusal: clean → resolves; dirty → throws; the message carries the
  first N paths plus an accurate `(+N more)`; the `logger.error` channel carries the full list.
- `assertBaseBranchSwitchable`: base held by another worktree → throws naming it; held by the
  current checkout → resolves; detached and bare entries ignored; **branch-name matching, asserted
  under a symlinked prefix** so the `/var`→`/private/var` asymmetry cannot pass by accident.
- Rollback decision table: (createdLocalBranch? pushed? already-existed?) × failure point →
  deletes / keeps / refuses-without-rollback / what is reported.

**Integration** (real temp git repo, per the template above)
- Tree dirtied *between* the `:351` precheck and the per-entry switch ⇒ refusal, and **no**
  `git switch` was executed.
- Batch of 2, entry 1 failing after `checkout -b` ⇒ entry 2 starts on a clean base branch, no
  `release/*` local branch survives, HEAD is on the base branch (the D3 failure-path leak).
- **Resume:** entry failed after push ⇒ re-running adopts the remote branch and creates only the PR
  (A10), with no `branch already exists` and no non-fast-forward push.
- **Pre-existing branch:** `checkout -b` fails with `already exists` ⇒ refusal, and the branch is
  **not** deleted (P2 / PM6).
- **Adoption refusals (PM7):** a remote `release/*` branch with a closed PR, with a merged PR, with
  two commits, with a non-empty commit, or whose parent is not reachable from `origin/<base>` ⇒
  refused, not adopted.
- **Idempotent Jira (A1'):** a second run for the same version reuses the existing Jira version
  instead of failing on the duplicate.
- **`extractStderr` through the progress error (A8):** a worktree-holding `git switch` failure still
  surfaces git's own path in the final `OperationError` message.
- **Rollback failure** ⇒ batch summary and `commandEcho.print()` still run (PM5).
- Base branch held by a linked worktree ⇒ refusal before the confirmation prompt, correct remediation.
- Diverged local base ⇒ `--ff-only` refusal printing the divergence count; base branch unchanged.

- **The refusal survives the re-wrap (A5a):** a per-entry dirty-tree refusal's paths appear in
  `structuredContent.failedReleases[0].error`, not merely in the thrown error. Without this
  assertion the whole message-preservation path can ship green and vacuous.

**E2E / regression**
- `$.quiet === false` after a failing `release create`, and an outer `quiet = true` block is not
  unmuted by an inner call (both directions).
- Existing `release-create.test.ts` and `git-guard.test.ts` stay green: base mapping, the two types,
  homogeneous-type rejection and end-on-base-branch are unchanged (P5).
- **`integrations/gh/gh-release-prs/__tests__/gh-release-prs.test.ts:231-295` — breaks in Ship 1, not
  Ship 2.** It is the only existing coverage of `createReleaseBranch`. It survives A0's reorder by
  luck (`findCreateCommand`, `:248`, searches for the `gh pr create` call rather than asserting
  order), but **A2's second clean-tree check and A9's freshness assertion both redden it
  immediately**: the file mocks `zx` module-wide (`:30-52`) with a fallthrough returning
  `{ stdout: JSON.stringify(responses.release) }`, and `lib/git-utils/git-utils.ts:3` imports `$`
  from the same module — so `git status --porcelain` returns `"[]"` (non-empty ⇒ refuses) and
  `git rev-parse HEAD` returns `"[]"` (≠ the carried SHA ⇒ throws). The mock needs explicit branches:
  `git status --porcelain` → `''` and `git rev-parse HEAD` → the carried origin SHA. Separately, A8's
  `ReleaseBranchProgressError` (Ship 2) changes what escapes the function, so the file needs a second
  extension then.

**Observability**
- Every refusal is an `OperationError` (`operation — stderr — try`) paired with the `logger.error`
  detail block (A5), so CLI and MCP render alike.
- The summary distinguishes *refused before any mutation* from *failed mid-sequence*, and in the
  latter case names every surviving artefact in `structuredContent` — the machine-checkable form of
  P3's boundary — which requires A11's schema widening.

## Acceptance criteria

1. **[Ship 1]** A tree dirtied after the `:351` prechecks is refused before any `git switch`; all offending paths
   appear in the logged detail block, and the first few plus an accurate count in the `OperationError`.
2. **[Ship 1 for the checkout leg via A9; Ship 2 for the leftover leg via A8]** After any
   single-entry failure the checkout is on the base branch; a local `release/*` branch
   survives only when the branch was pushed or pre-existed, and in those cases it is reported.
3. **[Ship 1, conditional on PM4 — A8a ships with A0 and both wait on that answer]** A failure
   before the push is retryable as a fresh run — A1' removes the
   duplicate-Jira blocker and A8a removes the leftover local branch, so no `branch already exists`.
   **[Ship 2] A failure after the push is resumable via A10** when the branch passes the adoption
   gate, and otherwise is reported with the manual recovery rather than an opaque git error.
4. **[Ship 1]** A base branch held by a linked worktree is refused **before the confirmation prompt and before
   any mutation**, with remediation naming the worktree.
5. **[Ship 1]** **No global `$.quiet` mutation remains reachable from the release-create call
   graph.** Stated structurally rather than behaviourally on purpose: once A7 lands, both the
   "restored to `false`" and the "does not unmute an outer block" assertions become trivially true
   and would guard nothing. Note `prepareGitForRelease` (`release-utils.ts:42,48`) is shared, so A7
   there changes behaviour for its other callers too — intended, but call it out in review.
6. **[Ship 1]** `getBaseBranch`, the two release types and end-on-base-branch are unchanged — and now hold on the
   failure path as well.
7. No ref the command cannot prove it created is ever deleted **[Ship 1 — *substantively* true, not
   vacuously: A8a does delete, and clause 1's scoping is what keeps it to the branch it just created.
   The scoping needs its own test]**, and none is adopted unless it is empty and cut from the current
   base tip **[Ship 2]**.

## Landing plan

Two ships. The first discharges the operator's actual request; the second is the recovery
machinery, and it should not land before the integration harness exists (this command has **zero**
handler-level coverage today — `release-create.test.ts:8` imports only `assertHomogeneousReleaseType`
and `releaseCreateMcpTool`).

**Ship 1 — "the clean-tree premise is true when it is used"**
A2 (guard placement + the two clean-tree re-checks), A1' (idempotent Jira), A3b
(`assertBaseBranchSwitchable`'s home and its current-branch leg), A0 + A8a + A9 (reorder,
in-call pre-push cleanup, and de-duplicate the git sequence — A0 and A9 must land together, since A9
removes the pull A0's new order assumes the caller performed, and A8a cleans up exactly the leftover
A0 creates), A3, A4, A5, A6, A7.
Ordering note: A6 edits both pull sites (`release-utils.ts:46`, `gh-release-prs.ts:206`) and A9
deletes the second — a textual conflict if they land out of order, not a semantic one.
After Ship 1 a **pre**-push failure leaves nothing behind and is retryable as a fresh run (A8a). A
**post**-push failure still leaves a pushed branch with no PR; it is *reported* with the manual
recovery (`git push origin --delete <branch>`), not silently left. Ship 2 turns that report into an
automatic resume.

**Ship 2 — recovery**
A11 **first** (pure schema widening + the `mcp-stdio.e2e` golden update), then A8 (which depends on
A11 for its report fields, and includes the `extractStderr` `cause`-walk), then A10.

**Blocked on PM4:** A0 (and therefore A8a, which cleans up after it) must not land before the
empty-commit / `commit-msg` question is confirmed against one real consumer repo. **A9 is
deliberately split out of that gate**: its `finally` is what makes HEAD end on the base branch after
a failure — the failure-path halves of criteria 2 and 6 — and it is independently safe. If PM4 comes
back "yes, a hook exists", Ship 1 still lands A2, A9, A1', A3-A7; only A0 + A8a wait.

## ADR

- **Decision:** Reorder the destructive git sequence (A0 + A9), make Jira creation idempotent rather
  than reordering it (A1'), hoist the base-agnostic guards and re-assert the clean tree per entry
  (A2), and apply `--ff-only`, per-invocation `quiet` and two-channel refusals — as Ship 1. Then, as
  Ship 2, widen the failure record and MCP schema (A11), add a provenance-based best-effort rollback
  (A8), and a provenance-gated resume path (A10).
- **Drivers:** DD1–DD4.
- **Alternatives:** B (scratch worktree) — rejected by the operator's own choice, not on the merits;
  the earlier technical refutation was wrong and has been withdrawn. C (guard only) — rejected; its
  steelman is recorded and answered.
- **Why chosen:** A is the smallest change that makes the operator's stated premise — "if the tree is
  clean we may run automatically" — true at the moment it is used, and that leaves a failed release
  recoverable rather than wedged.
- **Consequences:** A6 and the worktree precheck will refuse runs that previously proceeded
  (intended, DD3, budgeted in PM3). A11 is a visible MCP schema change with a contract-test golden
  update. A0 changes the shape of the new branch's first push and is gated on PM4. A1' adds one Jira
  round trip per entry.
- **Follow-ups:** (0) `release-create`'s MCP `description` still claims the command must be run
  "on the matching base branch", which was never true and is now further out of date — it does not
  mention any of the new refusals. Updating it belongs with A11 in Ship 2, because it reddens the
  same contract test: **measured during Ship 1**, changing that one string fails
  `mcp-stdio.e2e.test.ts:1495` (the `unchangedControl` self-check), not `:1560` — empirical
  confirmation that `unchangedControl` resolves to `release-create` and that the self-check fires
  first. (1) `gh-release-deliver` has a strictly worse guard-to-mutation window than the
  command fixed here and should get the same treatment next. (2) The `$.quiet` idiom is inconsistent
  repo-wide (three idioms, six correct sites) and `$` remains process-global against concurrent MCP
  tool calls — P4 is not fully discharged by a path-scoped fix. (3) `release create` currently has
  zero handler-level test coverage; this plan's integration lane is also the first such coverage.

## Verification note

Every file:line citation in this document was checked against the working tree during the Architect
and Critic passes; the Critic's final pass verified ~55 of them with no failures, and the
`unchangedControl` resolution to `release-create` was confirmed by executing the predicate against
`tools-list-baseline.v1.json` (23 tools). Two items remain explicitly unverified and are marked as
such: PM4 (consumer-repo `commit-msg` hook).

Two items were resolved during implementation. **A7's scope note is void**: `prepareGitForRelease`
has exactly one production caller (`release-create.ts:292`) and `createReleaseBranch` exactly one
(`release-utils.ts`), so scoping the quiet change to this path affects nobody else. **PM4's landing
gate was mis-scoped**: the empty commit already runs today (`gh-release-prs.ts:209`), so a
`commit-msg` hook would break the command as it stands — A0 only moves that failure ahead of the
push, which is strictly better, and cannot gate on it.

## Residual risk accepted in Ship 1

`assertBaseBranchSwitchable` runs **once** (`release-create.ts:372`), not per entry. The volatile
clean-tree leg is re-asserted twice, but a worktree opened on the base branch *during* a batch
still surfaces at `release-utils.ts:61` as a raw `git switch` failure relabelled by `executeOne`
with the wrong remediation — the exact mislabelling A3 exists to remove. Accepted because a
worktree is stable state, not volatile: nothing the command does can cause it, and a mid-batch
appearance requires a person acting concurrently. Worth revisiting if it is ever observed.

## Open question for the operator

Constraint 3 was stated as "HEAD ends on the base branch". Does that forbid the **scratch-worktree
mechanism** as such, or only mandate the **end state**? If only the end state, Option B becomes
live again and is plausibly less code than the A0 + A8/A8a + A9 + A10 + A11 total. Because that
total is now visibly the larger half of the plan, this answer is worth having **before Ship 1**, not
merely before A8.
