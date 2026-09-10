# Critic review — `infra-kit release remove`

Reviewer: critic pass of a ralplan `--deliberate` consensus loop. Read-only with respect to
`docs/release-remove-command-plan.md`, `docs/release-remove-command-plan.architect-review.md`, and all
source. This file is the only artefact written.

Judged against the plan **as it would stand after the Architect's six REQUIRED modifications**. Those
are correct and are not re-argued; where I extend or narrow one I say so. Every source line below was
read from the working tree (`main` @ `969bbe0`, dirty: ~10 modified manifests, 6 untracked docs). CLI
package root abbreviated `«cli»` = `apps/infra-kit/cli/`.

The plan is strong. Its two central diagnoses — `deleteLocalBranch` failing open and
`getReleasePRsWithInfo` being blind to merged PRs — are real, and the ascending-irreversibility
ordering survives every alternative both reviewers constructed. What blocks approval is that three of
its five Principles are violated by its own decisions in ways the Architect found only one of; that
the residue table which *is* the ordering argument is wrong in one row and rests on output the code
discards; that a fifth wiring contract exists behind the fourth one the plan discovered; and that
AC-14 is unsatisfiable by construction — the same defect this reviewer rejected in the previous plan.

---

## 0. The finding that undermines the plan's own ordering argument

**§D4's repairability table — the table that *is* Principle 1 — is wrong in row 5, and rows 4 and 5
together rest on a SHA the code never shows anyone.**

The table reads:

| # | Step | Repairability of the residue if we stop here |
| 4 | Delete the local branch | Still on `origin`; and `git branch -D` prints the tip SHA. |
| 5 | Delete the remote branch | **Still local** (step 4 printed its SHA; objects survive until gc). |

Row 5 is false on the plan's own ordering. Step 4 runs *before* step 5, so at the moment step 5
completes the branch is **neither local nor remote**. "Still local" describes a state the plan's
sequence has already destroyed. The parenthetical half-concedes it, which is why the error survived
drafting — but the headline claim is what a reader uses to rank the step, and it ranks step 5 as
cheaper to repair than it is.

Worse, the fallback both rows retreat to does not exist in the shipped path:

- `deleteLocalBranch` (`«cli»/src/lib/git-utils/git-utils.ts:273-281`) runs
  ``await $`git branch -D ${branch}` `` and **discards the result**. `git branch -D` prints
  `Deleted branch X (was <sha>)`, but zx captures stdout and nothing logs it. §5.5's observability
  list names four things to log; the tip SHA is not one of them.
- After step 5 the only recovery is `git reflog` in the main checkout — and the branch was never
  checked out there in the ordinary case, so the reflog entry is thin or absent.

So the two steps the plan places at positions 4 and 5 *because* they are cheap to undo are, in
combination, undoable only from an artefact the command throws away. This is Principle 2 (*"never
report a mutation the code did not verify"*) inverted: the plan reports a **recoverability** the code
does not preserve.

**Fix, and it is cheap.** Three edits, all inside decisions the plan already owns:

1. Correct row 5 to *"Neither local nor remote. Recoverable only from the tip SHA, which step 4 must
   have logged, plus git's gc window."*
2. Add the tip SHA to §5.5: `deleteLocalBranch` must return or log `Deleted branch X (was <sha>)`
   before step 5 runs — the same relationship §5.5 already states for the Jira version id (*"the id is
   the only handle that exists after the delete"*). The branch SHA is the identical case and the plan
   applies the rule to Jira only.
3. Put the SHA in the residue report of D4's `OperationError`, so a run that dies at step 5 or 6 hands
   the operator the one string that makes steps 4-5 reversible.

This also strengthens the plan: with the SHA logged, "ascending irreversibility" becomes true of rows
4-5 rather than asserted about them, and the `branchExists` probe D5 already adds is the natural place
to read it.

---

## 1. Cross-check of the Architect's four claimed in-plan errors

Instruction was to verify each independently rather than take them on trust. **All four hold.** Two
carry citation errors of the Architect's own, which matter because the plan's fix is a line edit.

### (i) `assertKnownTargets` does not exist — **CONFIRMED**

`grep -rn 'assertKnownTargets'` across the repo returns exactly four hits, **all of them inside the
two review documents themselves** (`plan.md:303`, `plan.md:611`,
`architect-review.md:147,149,597,659`). Zero in `src/`. The real helper is `assertTargetsExist`,
declared at `«cli»/src/commands/worktrees-remove/worktrees-remove.ts:66` and called at `:144`.

The Architect is also right that the attributed rationale is near-verbatim correct (docblock at
`:59-65`) and right that the docblock's own `Promise.allSettled` is stale — `removeWorktrees` uses
`Promise.all` over a never-rejecting `removeOne`, with a comment saying so
(`«cli»/src/lib/worktrees/remove-worktrees.ts:261-263`).

**One addition the Architect did not draw.** The plan's T3 second case says a future
`assertKnownTargets` copy-paste *"would silently break"* resumability. With the identifier corrected,
that sentence names a real and specific hazard: `assertTargetsExist` validates against
`currentWorktrees`, and by the time `release remove` reaches its second run the worktree is **gone by
design**. So the copy-paste would not merely be unhelpful — it would refuse every resume run, which is
the plan's primary use case. Say that, rather than "silently break"; it is the stronger deterrent.

### (ii) The `removeReleaseWorktreeIfPresent` hoist is not "a move, not a rewrite" — **CONFIRMED; the Architect's line numbers are off by ten**

`«cli»/src/commands/gh-release-deliver/gh-release-deliver.ts:166` exports it. The merge-specific throw
is at **`:182-186`**, not the Architect's `:182`→`:172-177`:

```ts
operation: `remove worktree for ${releaseBranch} before merge`,
remediation: `run manually: git worktree remove ${worktreeDir}/${releaseBranch} (use --force if uncommitted changes)`,
```

Both strings are merge-specific and both must be parameterised, not just `operation`: the remediation
tells a `release remove` operator to run `git worktree remove --force`, which is exactly the escape
the repo has deliberately refused elsewhere (`«cli»/readme.md:57` documents `worktrees remove` as
having *"no `--force`"*, and `removeOne` runs bare `git worktree remove` at
`remove-worktrees.ts:240`). Handing a teardown operator a `--force` suggestion undoes that policy
through a hoisted string. **Amend the Architect's REQUIRED 3 to cover the remediation as well as the
operation.**

### (iii) The plan forks `fetchPRByHead` while forbidding forks one section later — **CONFIRMED**

`gh-release-deliver.ts:67-72` is exactly the call D3 specifies:

```ts
const result = await $`gh pr list --head ${head} --state all --json number,state,title --limit 1`
```

with a docblock (`:62-66`) whose stated purpose is *resume* semantics — the same purpose
`release remove` needs it for. Meanwhile §3.2 hoists `removeReleaseWorktreeIfPresent` with the
rationale *"two callers, and the second one (this command) must not fork it."* The contradiction is
real and sits in adjacent sections.

### (iv) `ReleasePR` carries `number` and `state` — **CONFIRMED**

`«cli»/src/integrations/gh/gh-release-prs/gh-release-prs.ts:11-18` declares both, and **both**
`gh pr list` calls request them: `--json number,title,headRefName,state,baseRefName,createdAt` at
`:78` and `:81`. The projection at `:155-165` maps to `{branch, title, createdAt}` and discards them.

So the plan's *conclusion* (a separate `--state all` probe is needed) is right — neither call carries
`--state`, so both are open-only — while its *reason* (*"carries no `state` or `number` field"*) is
wrong about the fetch. The Architect's correction is exact.

**Nothing the Architect claimed came back wrong on substance.** Two citation slips (W2's line range;
S11's `confirm-or-exit.ts:71-77`, where the actual `process.exit(0)` is at `:77` and the
`whenHeadless: 'refuse'` argument at `:64`) do not change any finding.

---

## 2. Principle–option consistency

The Architect found one violation (P2, the IDE step). I find **that violation is stronger than
stated**, plus two more the Architect missed.

### P2 — violated three times, not once. And the IDE case is worse than "unverifiable"

The Architect's W4 says step 2 *cannot* be verified. True, but incomplete. The decisive fact is the
call site, which neither document reads:

```ts
// worktrees-remove.ts:170-179
// `!confirmedCommand` is the interactive path (a human used the picker/confirm). Only there
// do we let Zed's destructive `--reuse` relaunch fire; MCP/--yes runs (confirmedCommand=true)
// and worktrees-sync never relaunch an editor window.
await removeIdeWorktreeFolders({ …, removedWorktrees: removal.removed, allowEditorRelaunch: !confirmedCommand })
```

and `removeFromZed` returns immediately when `allowEditorRelaunch` is false
(`«cli»/src/integrations/ide/remove-ide-worktree-folders.ts:132`).

So on a `--yes` run — **which is the exact invocation the plan's own PM-1 narrates**
(`infra-kit release remove --version 2.4.0 --yes`) — step 2 is not merely unverified, it is a
**guaranteed no-op** for Zed, and the plan would list `ide-folders` among the completed steps anyway.
That is not "reporting an unverified mutation"; it is reporting a mutation the code is documented not
to perform. It also means the plan's §3.1 handler sketch is **missing a required parameter**: the
`RemoveIdeWorktreeFoldersArgs` shape (`:22, :47`) takes `allowEditorRelaunch`, and the plan never
decides its value.

Two further P2 breaks:

- **§0 above** — reported recoverability that the discarded branch SHA does not support.
- **D8 item 5** — *"`.omc/` state inside the worktree, swept by `removeWorktrees`' existing
  ENOTEMPTY-with-one-retry recovery"* is listed as in-scope cleanup. Read the code: that sweep runs
  only inside `recoverFromRejectedRemove`, only when git has **already unregistered** the worktree,
  and only for an allowlisted leftover; a path git still lists is *"a real refusal (dirty tree) and is
  reported as such"* (`remove-worktrees.ts:186-217`). Listing it as a scope item implies a cleanup the
  command performs; it is a recovery from one specific failure. Reword or drop.

### P3 — "refuse rather than guess when the blast radius is other people's work" — violated by the IDE step, in the opposite direction

When `allowEditorRelaunch` **is** true (the interactive path this command will normally take),
`zed --reuse` *"REPLACES the focused window's entire folder set … and silently drops any other open
folder"* (`remove-ide-worktree-folders.ts:30-38`). That is a guess about other people's work — a
window the operator has open on an unrelated project is closed with no report — inside a command whose
Principle 3 forbids exactly that. The plan's D8 lists IDE folder removal as in-scope with no mention
of the relaunch semantics, so an implementer reading D8 will wire it without knowing.

This is not an argument to drop the step. It is an argument that D8 must **state the Zed behaviour and
choose `allowEditorRelaunch` deliberately**, and that the confirm text must say the focused editor
window will be re-stated. `worktrees-remove` earned this by having a comment at its call site; the plan
has neither.

### P5 — "symmetry with `release create`" — the Architect's finding stands, and I add the measurement

The Architect is right that P5 is invoked for D2c and D1 and inverted for D7 without acknowledgement.
Verified: `release-create` is `mcpExposed: true` (`command-catalog.ts:242-248`), and
`plugins/infra-kit/commands/` contains exactly **one** file — `release-create.md`. The plugin's entire
command surface is dedicated to making agents create releases, and D7 makes the inverse unreachable to
them. Whether or not one accepts the Architect's SUGGESTED 3, **P5 must be argued on the record or
narrowed**; as written the principle is a warrant the plan invokes when it agrees and ignores when it
does not.

### P1 and P4 — upheld, subject to §0 and to the Architect's REQUIRED 4

---

## 3. Fair alternatives — does D7 survive the Architect's antithesis?

**No, not as written — and I reach that from a different direction than the Architect.**

The Architect's argument is that D7's two supporting facts (auto-confirm; degraded gate) are true of
the entire exposed mutating set and therefore do not discriminate. I verified both predicates:
`EXPECTED_GATED_TOOLS` derives from `entry.mcpExposed && requiresHumanConfirm === true`
(`command-catalog.test.ts:219-227`), default-deny from `entry.mutating && entry.mcpExposed && …`
(`:235-248`), T3 from `getExposedMcpTools()` (`:526-534`). The Architect's reading is exact, and the
non-discrimination point is correct.

I add the argument that settles it. **D7's stated criterion is "genuinely irreversible ⇒ CLI-only",
quoting the `release-deliver` comment verbatim. But the plan has already established that only *one of
six* steps is irreversible** — D4's own table gives repair paths for steps 1-5 and marks only step 6
*"Not repairable."* So the criterion the plan invokes applies to one sixth of the command. Applying a
whole-command exclusion on the strength of one step is the same selective-warrant move as P5, and the
plan's own decision table is the evidence against it.

That makes the Architect's option (ii) — expose, gate, omit the Jira step over MCP — not merely a
preference but **the shape the plan's own analysis implies**. It is also the closer precedent: the
Architect names `worktrees-remove` (destructive, exposed, gated, plus `assertMcpRemovalInput` at
`worktrees-remove.ts:39-57`), and I confirm `release remove` needs only the first two because D6 makes
it single-target already.

**Options B and C were treated fairly; that is not where the plan's alternatives analysis fails.**

- **Option B** (compose three commands) is rejected on a real argument — a runbook cannot refuse — and
  the Architect's S10 correctly notes the missing CI-dependency distinction. Fair, not a strawman.
- **Option C** (`--dry-run`) is rejected as *"the confirm text carries the same data today."* This is
  fair reasoning but it creates an obligation the plan does not discharge: **the confirm text is now
  load-bearing, and nothing tests it** (§6 below). A rejection that makes an untested string
  load-bearing is only fair if the plan then tests it.

**D7 does not survive. The Architect ranked this SUGGESTED; I rank it BLOCKING**, on the narrow ground
that the plan's stated criterion contradicts its own step table. Either resolution the Architect names
(defer-with-a-reason, or expose-minus-Jira) discharges it; what cannot ship is the current text, which
reads as settled.

---

## 4. Risk–mitigation clarity

### 4.1 U1-U3 — the gate hides a redesign behind a checkbox. Architect is right; the hole is one deeper

Accepted in full: U2-false makes D2b's probe unimplementable as specified, the JQL-`total` fallback is
a different endpoint with a different auth scope, and U1's fallback (`DELETE /version/{id}`) has its
own unmeasured behaviour in U3. The Architect's REQUIRED 5 is correct.

**What both documents miss: the fallback the Architect proposes for U1 is not compatible with D2d.**
S5 says *"if U1 is false, ship v1 with the Jira step behind `--skip-jira`-by-default."* But D2d makes
`--skip-jira` the flag that means *"I know Jira is unconfigured and I accept an orphaned fix
version"* — a deliberate, echoed, exceptional act. Defaulting it inverts the flag's meaning from
"exception" to "normal", and every run then echoes `--skip-jira` through `commandEcho`, so shell
history no longer distinguishes the two cases. If U1 fails, the honest v1 is a **separate outcome**
(`jira: 'manual'`, with the version id, name, URL and the removal path printed), not a re-purposed
flag. State it that way.

### 4.2 The `--move-issues-to` data-loss hole — confirmed, and the count arithmetic is worse than stated

The Architect's REQUIRED 2 is correct on both halves. I add the consequence for the guard itself:
because `getVersionRelatedIssueCounts` (U2) returns two counts over two fields, and D2b refuses on
`count > 0`, the plan never says **which count the refusal keys on**. If it keys on the sum, the
escape hatch cannot clear it (`--move-issues-to` addresses only `moveFixIssuesTo`), so a version with
`issuesFixedCount: 0, issuesAffectedCount: 2` is **permanently unremovable by this command** — refused
by the guard, and un-clearable by the flag the refusal recommends. That is a dead end the refusal text
actively directs the operator into. Whichever resolution the Architect's REQUIRED 2 takes, D2b must
name the predicate per-count.

### 4.3 TOCTOU — the Architect found one window; there are two, and the second one aborts mid-teardown

The Jira window (preflight probe at step 0, delete at step 6, unbounded confirm in between) is real and
the Architect's re-probe synthesis is the right fix. **I rank it BLOCKING rather than SUGGESTED**: PM-2
is the plan's own worst-case incident, and its sole mitigation is a check that has gone stale by the
time it authorises the unrecoverable act. A mitigation that can be stale at the moment it matters is
not a mitigation in deliberate mode. The cost is one API call on the path that is about to make an
irreversible one.

**The second window the Architect missed: PR state.** D3's merged-PR refusal — PM-3's mitigation — is
probed at step 0 and acted on at step 3, across the same unbounded confirm. If the PR is merged in
between, `gh pr close` on a merged PR fails, so the command aborts at step 3 with the worktree and IDE
folders already gone. That residue is repairable (`worktrees add` recreates both), so this is
**NON-BLOCKING** — but the plan claims *"no mutation of any kind occurs"* for the merged case (AC-3),
and that claim is only true when the merge precedes preflight. The cheap fix rides along with the Jira
re-probe: re-call `fetchPRByHead` immediately before step 3 and refuse with D3's message rather than
letting `gh` produce an opaque failure.

### 4.4 Risks named without a located mitigation

- **A dirty release worktree.** `removeOne` runs bare `git worktree remove`
  (`remove-worktrees.ts:240`), no `--force`, and a dirty tree is reported as a failure. Preflight
  cannot see it: `assertManagementContext` → `assertCleanCheckout` (`git-guard.ts:72, :145`) reads the
  **main checkout's** status. So D4's claim that step 0 moves *every* detectable failure ahead of the
  confirm has a hole exactly at the step the Architect calls the most failure-prone. Mitigation is one
  line — probe the worktree's status in preflight, or state that step 1 is the one failure the confirm
  cannot precede.
- **A headless CLI run without `--yes`.** `confirmOrExit` calls `withEscape(…, { whenHeadless:
  'refuse' })` (`confirm-or-exit.ts:64`) and the decline path is `process.exit(0)` (`:77`). So
  `infra-kit release remove --version 1.2.5` in CI or a pipe exits **0 having done nothing**, with no
  residue report — indistinguishable from AC-6's "fully removed, every step skipped". The Architect's
  S11 notes the decline-exits-0 fact; neither document notes that it collides with the plan's own
  success semantics. State it, and consider `throwOnDecline: true` for this command specifically —
  `ConfirmOrExitOptions` already supports it and the plan acquires nothing before the confirm, so the
  documented reason for the default does not apply here.

---

## 5. Acceptance criteria — all 14 audited

Ruling: **PASSES** = a competent engineer who was not in this conversation could verify it without
asking the author. **FAILS** = ambiguous, unfalsifiable, unsatisfiable, contradicted by a REQUIRED
modification, or two criteria wearing one number.

| # | Ruling | Reason |
|---|---|---|
| 1 | **FAILS** | Two criteria + an unverifiable clause |
| 2 | **FAILS** | Three criteria; and it certifies a remediation that names flags this command rejects |
| 3 | **PASSES** | Model criterion — enumerates the collaborators that must have zero calls |
| 4 | **FAILS** | "the issues are reassigned" is unverifiable in unit test and false for affects-links |
| 5 | **PASSES** | |
| 6 | **PASSES**, but needs one sentence | Survives REQUIRED 4 only by an unstated mechanism |
| 7 | **PASSES** | |
| 8 | **PASSES**, two criteria | Splittable, but both halves are mechanically checkable |
| 9 | **PASSES**, can pass for the wrong reason | |
| 10 | **FAILS** | Contradicted by the Architect's REQUIRED 1 |
| 11 | **PASSES**, two criteria | |
| 12 | **PASSES** | The strongest criterion in the list |
| 13 | **PASSES** | |
| 14 | **FAILS — unsatisfiable by construction** | See below |

**AC-1** bundles "removes each of six artefacts" with "in this order", and its `ide-folders` clause
cannot be verified at all (§2). Split into a removal criterion and an ordering criterion, and state
the IDE outcome as `attempted`. As written, an implementer cannot tell whether an ordering regression
fails AC-1 or only T5.

**AC-2** bundles the picker path, the non-TTY throw and the `--json` throw. Worse, it certifies a
remediation string the command does not honour: `assertInteractive`
(`«cli»/src/lib/prompts/release-picker.ts:35-44`) throws with *"pass the branch selection explicitly
(CLI: `--version`/`--versions`/`--all` …)"* — and D6 rejects `--versions` and `--all` **outright**. So
the criterion passes while the command's own refusal advertises two flags it will reject as unknown
options. Either narrow AC-2 to "names `--version`", or fix the shared remediation; do not certify the
current text.

**AC-4** — "with it, the issues are reassigned rather than unset" is not verifiable by any test the
plan proposes: T2(d) asserts only that `moveFixIssuesTo` was **passed**. Reassignment is a live-Jira
fact and belongs in §5.4's manual gate. And after REQUIRED 2 the criterion is false for
`issuesAffectedCount > 0`. Restate as two: a unit criterion (the parameter(s) are sent) and a manual
one (the issues carry the new version).

**AC-6** is saved by a mechanism the plan never states: a fully-removed release still has a **CLOSED
PR forever** (GitHub PRs cannot be deleted), so the Architect's REQUIRED 4 predicate — *no PR in any
state* — never fires for a release this CLI actually removed. Without that sentence, AC-6 and REQUIRED
4 read as a direct contradiction and an implementer will resolve it by weakening one of them. One
sentence in D4 closes it permanently.

**AC-9** passes, but a test that dirties the tree satisfies it for the wrong reason:
`assertManagementContext` refuses **both** a linked worktree and a dirty checkout (`git-guard.ts:145`,
`:158`). Say "from inside a linked worktree, with a clean tree".

**AC-10** — *"A failure at any step aborts"* is directly contradicted by the Architect's REQUIRED 1,
which makes step 2 non-aborting. Reword to "at any step other than the IDE step".

**AC-14 — `pnpm run qa` is green at the repo root. Unsatisfiable, and the plan knows it.** Measured
from the root `package.json`:

```
"qa": "pnpm run vendor:check && pnpm exec turbo run test ts-check prettier-check eslint-check infra-kit-check --continue --output-logs=errors-only && pnpm run test:claude"
```

`vendor:check` is **`&&`-chained first**, and the recorded repo fact — restated by the plan itself in
§7 — is that it is already red on HEAD with no refresh command. So AC-14 can never be met by this
work, *and* a red `vendor check` means the turbo lane behind it never runs at all: the acceptance
criterion nominally covering `tsc`, `eslint`, `prettier` and `vitest` executes **none of them**. This
is the identical defect this reviewer rejected as criterion 1.8 of the previous plan; it must not ship
twice. Replace with the named lanes (they are the ones §7 already runs) plus *"`git status --short`
shows no `??` files"*, and state that `vendor check` redness is pre-existing and must not be "fixed"
by editing `vendor/`.

### Missing criteria

- **The confirm text.** §1.3 rejects Option C *because* the confirm text carries the inventory. Nothing
  in §6 or §5 asserts it does. Add: the confirm message names the PR number, both Jira issue counts,
  the worktree path, the base branch it will switch to, and (per §2) that the focused editor window
  will be re-stated.
- **The Jira version id in the log.** §5.5 calls it *"the only handle that exists after the delete"*.
  No criterion pins it.
- **The root `CLAUDE.md` regeneration** — see §7.
- **The U1/U2/U3 measurement being recorded.** §5.4 step 7 is a manual instruction with no acceptance
  hook, so nothing fails if it is skipped. Given that the whole of D2 rests on it, it belongs in §6.

---

## 6. Test plan — does it meet the house bar?

The house bar (`«cli»/src/commands/worktrees-remove/__tests__/worktrees-remove-failure-report.test.ts:15-24`)
is that the docblock names the **exact false-success** the test prevents. **T1, T3, T4 and T5 meet it**
— each names a specific wrong-green rather than a behaviour. T4 in particular is well-aimed: it pins
PM-1's fail-open at the seam where `deleteLocalBranch` returns `void`. T2 and T7 are enumerations of
cases rather than named false-successes, but their cases are concrete and independently checkable. T6
mirrors an existing ordering test. **T8 is the weakest** — "POSTs to the right URL with the right body"
is a shape assertion, not a false-success; its one real invariant is the seraph-header classification,
which is worth keeping and worth being the docblock's subject.

**Both tests the brief requires are present.** T3 covers the already-partially-removed re-run
(explicitly: worktree absent, PR CLOSED, branches absent, Jira version null → succeeds). T1 covers the
MERGED-PR refusal, with zero-call assertions on four collaborators and a `--yes`-does-not-bypass case.
Both are correctly specified.

**Four gaps:**

1. **Nothing tests AC-13** (Jira unconfigured ⇒ refuse unless `--skip-jira`). It is a stated
   acceptance criterion and a departure from `gh-release-deliver`'s tolerant path
   (`deliverJiraReleaseSafely`, `gh-release-deliver.ts:348`), which makes it exactly the kind of
   deliberate asymmetry a later "consistency" refactor deletes. Add a case to T2.
2. **Nothing tests the confirm text** (§5 above). Load-bearing by Option C's rejection, unpinned.
3. **Nothing tests the IDE step's non-abort** after REQUIRED 1 — the Architect asks for it in S1 but
   the §5.1 table is not amended, so the plan as it stands would land with T5 unchanged.
4. **T5's ordering assertion needs a stated mechanism.** "Assert call ordering across the mocked
   collaborators" is not implementable without saying how — a shared `vi.fn()` call-order array, or
   `mock.invocationCallOrder`. Given that the collaborators live in five different modules and one of
   them (`removeReleaseWorktreeIfPresent`) is being hoisted mid-plan, this is the test most likely to
   be quietly downgraded to "each collaborator was called".

§5.3's three wiring checks are right, and the *"if `-u` changes this file, the exposure decision was
implemented wrongly"* framing of the snapshot is the best-designed check in the plan.

---

## 7. Verification steps — and the fifth wiring contract

§7's command block respects three of the four named repo hazards correctly: explicit `; echo EXIT=$?`
on every gate, `eslint --no-cache`, `git status --short` for `??` files, and the never-stash rule.
`tsc -b` is right because vitest does not typecheck. **Three problems:**

**7.1 — No prettier lane.** Root qa runs `prettier-check` as a *separate turbo task* from
`eslint-check`, and the CLI's own `prettier-check` script covers `**/*` including markdown. The plan
edits two `.md` files (`resources/root/body.md`, `readme.md`) under a recorded hazard that *prettier
owns the bytes of `.md` resources*. §7 has no prettier command. Add
`npx prettier --check apps/infra-kit/cli ; echo "EXIT=$?"`.

**7.2 — The shasum guard is named in prose and absent from the commands.** §7's notes say to
`shasum` the changed `package.json`s before and after `pnpm run qa`. The command block does not.
Additionally, **the tree is already dirty with ~10 modified manifests**, so a naive before/after diff
cannot distinguish qa's rewrites from the pre-existing modifications. Either run the qa gate from a
clean tree or record the baseline shasums explicitly first.

**7.3 — There is a fifth wiring contract, and it is inside root qa.** §3.3 lists four contracts and
calls `resources/root/body.md` *"the fourth contract, not in the original brief."* Good catch, but it
is only half of one. Measured:

- Root qa runs `infra-kit-check`, which ends in
  `"infra-kit-check-root": "pnpm exec infra-kit audit --root"`.
- This repo's **own** `CLAUDE.md` carries the generated block (`CLAUDE.md:17-41`, between
  `<!-- infra-kit:begin -->` / `<!-- infra-kit:end -->`, stamped `<!-- infra-kit:version 0.4.0 -->`),
  and line 27 is the release line generated from `body.md:10`.
- `infra-kit` is a root devDependency at `workspace:*`, so `pnpm exec infra-kit` runs the **workspace
  build** — and the recorded repo fact is that qa has **no build step** (turbo `test` depends on
  `^build`, i.e. dependencies, not self).

Three consequences the plan must state:

1. **`«cli»/CLAUDE.md`'s generated block is an edited file** and belongs in §3.2's table. Editing
   `body.md` without regenerating the root block reds `infra-kit-check-root`.
2. **Regenerating it requires a rebuilt `dist/`.** Running `pnpm exec infra-kit audit --fix --root`
   against a stale `dist/` re-emits the **old** line and silently masks the drift — the "dist-reading
   is vacuous" failure class, arriving through the audit lane. The verification block needs an
   explicit `pnpm --filter infra-kit run build` before the audit step.
3. **The version marker.** `<!-- infra-kit:version 0.4.0 -->` is part of the generated block; the plan
   must say whether regeneration bumps it, because a marker bump is a wire-visible diff in every
   consumer repo and §8.5 already flags consumer drift without mentioning it.

This is not pedantry: §3.3 exists precisely to enumerate the contracts that make the command real, and
it currently stops one short of the lane that would go red.

---

## 8. Also missed by both documents

**M1 — the hoisted worktree helper cannot feed the IDE step.** `removeReleaseWorktreeIfPresent`
returns `Promise<void>` (`gh-release-deliver.ts:166`). `removeIdeWorktreeFolders` requires
`{ projectRoot, worktreeDir, currentWorktrees, removedWorktrees, allowEditorRelaunch }`
(`remove-ide-worktree-folders.ts:22, :47`) and **returns `[]` immediately when `removedWorktrees` is
empty** (`:49`). So the hoist in §3.2 is insufficient twice over: beyond the operation string
(REQUIRED 3), it must also **return the removed branches**, or step 2 has nothing to pass and becomes
a no-op for a second, independent reason. §3.1's handler sketch has no signature for this.

**M2 — `--version` accepts a release *name*, and the flag name says otherwise.** `resolveReleaseBranch`
(`release-utils.ts:285-294`) is `formatBranchName(parseReleaseRef(…))` and its remediation is *"pass a
version (e.g. "1.2.5") or a release name (e.g. "checkout-redesign")"*. The plan's D6 and every AC speak
only of versions. Harmless, but the picker/`--version` path must be documented as accepting both or
half the releases this repo can create are undocumented targets. `configureReleaseDeliver`
(`program.ts:230-236`) has the right help string to copy verbatim.

**M3 — the plan never says what a step-6 *failure* leaves.** The Architect raised this; I add that it
is the only step whose residue is *good* (an orphaned fix version, deletable in the Jira UI in ten
seconds) and therefore the one worth stating, because a reader who cannot derive it will assume the
worst and add a rollback nobody needs.

**M4 — `deleteLocalBranch` uses `-D`, and the docblock's reason does not apply here.**
`git-utils.ts:265-272` justifies force-delete because *"a delivered release branch was squash-merged —
its tip is unreachable from the base"*. `release remove` targets an **undelivered** release by D3, so
`-D` here discards genuinely unmerged commits. That is the intended behaviour, but it is the single
most destructive local act in the command and the plan treats it as a cheap step. It is another reason
the tip SHA must be logged (§0).

---

## VERDICT: ITERATE

The shape is right and I am not asking for a rethink. Single-target, guard-first,
ascending-irreversibility, abort-with-residue-report is correct, both fail-opens are real, and the
plan's evidence discipline is above the bar. But a plan is approvable when an engineer who was not in
this conversation can implement it as written, and this one currently instructs that engineer to:
report a completed mutation on a path where the code is documented to do nothing; rely on a
recoverability that the code discards; satisfy an acceptance criterion that cannot be satisfied and
whose failure skips the entire test lane behind it; and leave a generated block that reds root qa. Two
of the Architect's six REQUIRED items also need widening, and one of its SUGGESTED items is, in
deliberate mode, blocking.

The Architect's six REQUIRED items stand, with items 2 and 3 widened as noted. The list below is my
addition to them, ordered.

### BLOCKING

1. **Correct D4's residue table row 5 and log the branch tip SHA.** Row 5 currently says "Still
   local"; after step 4 the branch is neither local nor remote. `deleteLocalBranch`
   (`git-utils.ts:273-281`) discards `git branch -D`'s `(was <sha>)` output, so the recoverability the
   table asserts for rows 4-5 does not exist. Add the SHA to §5.5's observability list and to D4's
   residue `OperationError`, on the same reasoning §5.5 already applies to the Jira version id. (§0)

2. **Decide `allowEditorRelaunch` and state Zed's semantics in D8.** The parameter is required
   (`remove-ide-worktree-folders.ts:22, :47`); `worktrees-remove` passes `!confirmedCommand`
   (`worktrees-remove.ts:178`), so on the plan's own PM-1 invocation (`--yes`) step 2 is a **guaranteed
   no-op**, not merely unverifiable — the Architect's REQUIRED 1 understates it. When it *does* fire,
   `zed --reuse` replaces the focused window's entire folder set and silently drops unrelated open
   folders (`:30-38`), which Principle 3 forbids; the confirm text must say so. (§2)

3. **Make the hoisted `removeReleaseWorktreeIfPresent` return the removed branches.** It returns
   `void`; `removeIdeWorktreeFolders` needs `removedWorktrees` and returns `[]` when it is empty
   (`:49`). §3.1's handler sketch has no signature for this, so REQUIRED 3's operation-string fix alone
   still leaves step 2 unimplementable. Also parameterise the **remediation**, not just the operation:
   the hardcoded string (`gh-release-deliver.ts:184`) tells the operator to run
   `git worktree remove --force`, an escape this repo has deliberately refused (`readme.md:57`,
   `remove-worktrees.ts:240`). (§1 ii, §8 M1)

4. **Replace AC-14.** `pnpm run qa` is `vendor:check && turbo run test ts-check prettier-check
   eslint-check infra-kit-check … && test:claude` (root `package.json`). `vendor:check` is
   `&&`-chained first and is already red on HEAD, so the criterion is unsatisfiable **and** the lane it
   nominally covers never executes. Name the lanes, add `git status --short` for `??` files, and state
   that `vendor check` redness is pre-existing and must not be repaired by editing `vendor/`. (§5)

5. **Add `«cli»/CLAUDE.md` (the generated root block) to §3.2 and a build step to §7.** Root qa runs
   `infra-kit audit --root`; the block lives at `CLAUDE.md:17-41` and its release line derives from
   `body.md:10`. `pnpm exec infra-kit` resolves to the `workspace:*` build and qa has no build step, so
   `audit --fix --root` against a stale `dist/` re-emits the old line and masks the drift. Also state
   whether the `<!-- infra-kit:version -->` marker moves. This is a fifth wiring contract; §3.3 stops
   at four. (§7.3)

6. **Promote the Jira issue-count re-probe (Architect SUGGESTED 1) to required.** PM-2 is the plan's
   own worst-case incident and its sole mitigation is a preflight check separated from the
   irreversible act by an unbounded confirm and five cross-system mutations. A mitigation that can be
   stale at the moment it authorises an unrecoverable call is not a mitigation in deliberate mode. The
   repo's own precedent is `assertCleanCheckout`'s split-the-volatile-guard docblock
   (`git-guard.ts:62-66`). (§4.3)

7. **Re-argue D7 or narrow it.** Beyond the Architect's non-discrimination argument: D7 invokes
   `release-deliver`'s *"genuinely irreversible ⇒ CLI-only"* criterion, but D4's own table marks **one
   of six** steps irreversible and gives repair paths for the other five. The plan's stated criterion
   contradicts its own decision table. Either resolution the Architect names discharges this; the
   current text, which reads as settled, does not. (§3)

8. **Fix the three broken acceptance criteria and add the four missing ones.** AC-1 (split; the
   `ide-folders` clause is unverifiable), AC-2 (split; and it certifies a remediation naming
   `--versions`/`--all`, which D6 rejects — `release-picker.ts:38-42`), AC-4 (split into a
   parameter-sent unit criterion and a live-Jira manual one; false for affects-links after REQUIRED 2),
   AC-10 (contradicted by REQUIRED 1). Add criteria for: the confirm text's inventory (load-bearing
   because §1.3 rejects Option C on it), the Jira version id in the log, the root `CLAUDE.md`
   regeneration, and the U1/U2/U3 measurement being recorded. (§5)

9. **Name the per-count predicate in D2b.** With `--move-issues-to` mapping to `moveFixIssuesTo` only,
   a version with `issuesFixedCount: 0, issuesAffectedCount: 2` is refused by the guard and
   un-clearable by the flag the refusal recommends — a dead end the refusal text directs the operator
   into. Whichever way REQUIRED 2 resolves, state which count each half of the guard reads. (§4.2)

10. **Add the two missing tests the plan's own decisions make load-bearing**: AC-13's
    Jira-unconfigured refusal (a deliberate asymmetry with `deliverJiraReleaseSafely`,
    `gh-release-deliver.ts:348`, and therefore exactly what a later consistency refactor deletes), and
    the confirm-text assertion. Amend §5.1's T5 row for REQUIRED 1's non-abort case — S1 asks for it
    but the table is not amended. State T5's ordering mechanism (shared call-order array or
    `invocationCallOrder`); "assert call ordering" across five modules is not implementable as
    written. (§6)

### NON-BLOCKING

11. **Do not default `--skip-jira` if U1 fails.** D2d defines it as a deliberate exception echoed by
    `commandEcho`; defaulting it inverts the meaning and makes shell history stop distinguishing the
    two cases. Use a separate `jira: 'manual'` outcome that prints the id, name, URL and removal path.
    (§4.1)

12. **Re-probe the PR state before step 3.** Same window as the Jira one; the residue is repairable
    (`worktrees add` restores both artefacts), so this is not blocking — but AC-3's *"no mutation of
    any kind"* is only true when the merge precedes preflight, and `gh pr close` on a merged PR
    otherwise produces an opaque failure instead of D3's message. One extra `fetchPRByHead`. (§4.3)

13. **Close the preflight hole at step 1.** A dirty release worktree cannot be seen by
    `assertCleanCheckout` (it reads the main checkout, `git-guard.ts:72`) and `removeOne` uses no
    `--force` (`remove-worktrees.ts:240`), so the most failure-prone step is the one failure the
    confirm cannot precede. Probe it in preflight, or say so in D4. (§4.4)

14. **State the headless-confirm outcome.** `whenHeadless: 'refuse'` (`confirm-or-exit.ts:64`) +
    `process.exit(0)` (`:77`) means a non-TTY run without `--yes` exits 0 having done nothing,
    indistinguishable from AC-6's success. Consider `throwOnDecline: true` here: the option exists, and
    the documented reason for the default (callers holding resources) does not apply, since D4's step-0
    ordering acquires nothing before the confirm. (§4.4)

15. **Correct the citations, with the Architect's own two slips folded in.**
    `assertKnownTargets` → `assertTargetsExist` (`worktrees-remove.ts:66`; called `:144`); the
    merge-specific throw is at `gh-release-deliver.ts:182-186`, not `:172-177`; `ReleasePR`
    (`gh-release-prs.ts:11-18`) carries `number` and `state` and both fetches request them (`:78`,
    `:81`) — the **projection** at `:155-165` discards them. Rewrite T3's *"would silently break"* as
    the sharper truth: `assertTargetsExist` validates against `currentWorktrees`, and by the second run
    the worktree is gone by design, so the copy-paste would refuse **every** resume. (§1)

16. **Fix D8 item 5.** The `.omc/` sweep runs only inside `recoverFromRejectedRemove`, only when git
    has already unregistered the worktree, and only for an allowlisted leftover
    (`remove-worktrees.ts:186-217`). Listing it as scope implies a cleanup the command performs. (§2)

17. **Add the prettier lane and a real shasum baseline to §7.** `prettier-check` is a separate turbo
    task from `eslint-check` and the plan edits two `.md` files under the "prettier owns the bytes"
    hazard. And the tree is already dirty with ~10 modified manifests, so the before/after shasum the
    notes demand needs an explicit baseline step — or a clean tree. (§7.1, §7.2)

18. **Document that `--version` accepts a release name** (`release-utils.ts:285-294`); copy
    `configureReleaseDeliver`'s help string verbatim (`program.ts:233`). (§8 M2)

19. **Say what a step-6 failure leaves** — an orphaned fix version, everything else gone, ten seconds
    in the Jira UI. It is the only *good* residue in the table and the only one a reader must derive.
    (§8 M3)

---

# Round 2 — review of revision 2 (2026-09-10)

Scope: revision 2 of the plan (1179 lines) and the Architect's round-2 section
(`architect-review.md:693-1089`). Round-1 findings stand except where corrected below. Read-only on
source and on both other documents. Every claim below was re-read from the **working tree**, not from
`969bbe0`, for reasons that turn out to be the point of this round.

## R2.0 — Two of my round-1 citations were wrong. Acknowledged on the record.

Both corrections verified independently, and the plan is right on both:

- **The file is the repo-root `/CLAUDE.md`, not `«cli»/CLAUDE.md`.** Verified: `<!-- infra-kit:begin -->`
  at `/CLAUDE.md:17`, `<!-- infra-kit:version 0.4.0 -->` at `:18`, the release line at **`:29`** (I said
  `:27`), `<!-- infra-kit:end -->` at `:41`. `«cli»/CLAUDE.md` exists but a grep for `release` in it
  returns nothing — it is a *package* block. My round-1 blocking item 5 would have sent an implementer
  to edit a file with no release line, leaving `infra-kit-check-root` red while appearing to have done
  the work. The plan caught it; the correction is more useful than the finding was.
- **`readme.md:58`, not `:57`.** `:57` is the `worktrees list` row; `:58` is `worktrees remove` with the
  *"no `--force`"* text I used as the basis for the remediation-parameterisation argument. The argument
  is unaffected; the pointer was off by one.

The substance of both items survived; only my pointers were wrong. Noted rather than defended.

## R2.1 — Disposition of my round-1 items: all 19 substantively discharged

Checked against the revised text, not against the summary of it. None was reworded in place.

| Item | Where | Real? |
|---|---|---|
| **B1** residue row 5 + tip SHA | D4 table row 5 rewritten (*"Neither local nor remote"*); `localTipSha`/`remoteTipSha` captured in preflight (`:376-378`); §5.5 logs both before step 4; the residue `OperationError` carries the SHA and a `git branch <b> <sha>` recipe (`:445-448`); §8.3 records the rejected alternative | **Real — and the mechanism is better than the one I asked for.** See R2.2. |
| **B2** `allowEditorRelaunch` + Zed | D4 step 2 decides `false` always with a two-row option table; D8 gains a *"Deliberately NOT done: Zed's folder set"* section; AC-3 | **Real, and exceeded** — I asked for a decision and a warning; the plan chose the option that makes the warning unnecessary. |
| **B3** hoist returns removed branches + parameterise **both** strings | §3.2's `↳` row, sub-points (a) and (b) | **Real.** Both halves, with `readme.md:58` cited for the `--force` policy. Incomplete file list — Architect R2-REQUIRED 2. |
| **B4** replace AC-14 | AC-27 + §7's *"Why `pnpm run qa` is not the criterion"* preamble quoting the actual script | **Real.** Names the `&&`-chain and says the covered lanes never execute. |
| **B5** root `/CLAUDE.md` + build step | Contract 5 (§3.3), §3.2 row, §7 steps 1 and 5, AC-25, §8.5 | **Real, and extended** — the stale-`dist/` trap and the version-marker warning are both the plan's own additions. |
| **B6** Jira re-probe → blocking | D2e as a named sub-decision, T10, AC-14 | **Real.** Cites `git-guard.ts:62-66` as the in-repo precedent, and correctly frames it as re-probe-not-re-guard. |
| **B7** re-argue or narrow D7 | D7 reversed to `mcpExposed: true` + gated + Jira omitted over MCP; §3.3 contract 2 widened; §8.3 records revision 1's D7 as rejected-on-review | **Real** — wired, not declared. |
| **B8** fix 4 ACs, add 4 | 27 criteria; AC-1/2/3 split from old AC-1; AC-4/5 from old AC-2; AC-11 split unit/live; AC-19 excepts `ide-folders`; AC-20/21/25/26 are the four I said were missing | **Real.** |
| **B9** per-count predicate | D2b states the predicate as code (`:222`), maps the flag to **both** parameters, names the revision-1 dead end explicitly, T2(c) | **Real.** |
| **B10** two missing tests + T5 mechanism | T2(f) Jira-unconfigured, T9 confirm text, T5(c) non-abort, T5(a) states the `order: string[]` mechanism | **Real.** |
| **NB 11-19** | `jira: 'manual'` not `--skip-jira`-by-default (D2a); PR re-probe (D3, T1c, AC-8); dirty-worktree probe (D4's *"the one detectable failure preflight cannot precede"*); `throwOnDecline` (D6, AC-6); citations (§0); `.omc/` scope corrected (D8); prettier + shasum baseline (§7); `--version` accepts a name (D1); step-6 residue (D4) | **All real.** |

The plan also self-corrects three of its own revision-1 claims (the causal-dependence argument, the
summed counts, the `.omc/` scope) rather than quietly dropping them. That is the behaviour that makes
the rest of the document trustworthy.

## R2.2 — The two fixes the plan rejected and replaced. Both replacements are better.

**(a) Preflight `localTipSha`/`remoteTipSha` instead of logging `git branch -D`'s output.** I asked for
the wrong thing and the plan is right to refuse it. The decisive ground is the third one it gives, not
the first: `(was <sha>)` is **absent when the branch is already gone**, and that is the *resume* case —
this command's primary use case. A recovery handle that is missing precisely on the second run is not a
handle. The localizability argument is real but secondary, and touching a primitive
`gh-release-deliver` also depends on would have been gratuitous. Verified: `git-utils.ts` runs
``await $`git branch -D ${branch}` `` with no assignment. **Accepted without reservation.**

The Architect's R2-SUGGESTED 2 (also capture the SHA from `deleteRemoteBranch`'s existing
`git ls-remote --heads` probe, which currently tests only `.trim().length === 0` and throws the SHA
away) is a genuine freebie and closes the one narrow window. Agreed, non-blocking.

**(b) `allowEditorRelaunch: false` always, best-effort, the single exemption. Is the exemption a crack?**

**No — and I reach that from the reporting side rather than the reachability side.** The Architect's
ground is that `removeFromCursor` swallows its own errors, so the exempted throw is nearly unreachable.
I verified it: `remove-ide-worktree-folders.ts:110-114` catches, warns, and returns
`{ provider: 'cursor', supported: true, removed: [] }`. So a throw escaping `removeIdeWorktreeFolders`
could only come from `getInfraKitConfig()`/`resolveConfiguredIdes`. The exemption is narrow and it
cannot carry state into steps 3-6, because a `.code-workspace` edit has zero bearing on `gh`, `git` or
Jira. The failure model holds.

**But that same swallow produces a small overstatement the plan should fix.** D4 step 2 says the report
carries *"Cursor's verified `removed`"*. `removed: []` is returned on **three** different paths:
a successful removal of nothing, no `workspaceConfigPath` configured (`:95`), and a caught write
failure (`:113`). So `[]` is not evidence of anything, and the realistic Cursor failure surfaces only
as a `logger.warn` from inside the integration while step 2 reports success-shaped output. That is the
false-success class this plan exists to close, arriving at the one step it exempted. The fix is one
word: Cursor's outcome is *"verified when non-empty, `attempted` when empty"* — which is what
Principle 2 as revised already says (*"unverifiable ones are reported as `attempted` or `skipped`,
never as `removed`"*). **Non-blocking**, because the residue is a stale workspace entry.

## R2.3 — The stale citation base. Independently confirmed, and two collision files nobody has named.

I confirmed the Architect's R2.0 from the tree, and then went looking for what else the collision
touches. It is wider than either document says.

**Confirmed:** `command-catalog.ts`, `command-catalog.test.ts`, the golden snapshot, `palette.test.ts`,
`program.ts` and `mcp/__tests__/mcp-stdio.e2e.test.ts` are all `M` and uncommitted;
`src/commands/setup-dependency-status/` and `src/lib/dependency-{install,probe,registry}/` are
untracked. HEAD has `toHaveLength(23)` at `:87`; the tree has `toHaveLength(24)` at `:88` while the
`it()` title at `:80` still reads *"expected 23 MCP tools"*.

**One correction to the Architect: the tool is named `setup-dependency-status`, not `setup-deps-status`.**
Verified — `EXPECTED_EXPOSED_TOOLS[0]` in the tree is `'setup-dependency-status'`, the untracked
directory is `src/commands/setup-dependency-status/`, and `palette.test.ts:57` and
`mcp-stdio.e2e.test.ts:1082` both carry that spelling. R2.0 and R2-REQUIRED 1 use the short form twice;
an implementer grepping for `setup-deps-status` finds nothing. The count finding is unaffected.

### Two files in the collision surface that neither review names — and §5.3 affirmatively denies one

**C1 — `«cli»/src/lib/command-catalog/__tests__/palette.test.ts:40-58` is a hardcoded `toEqual` over
every palette row, grouped and ordered.** The Release Management array lists seven commands ending in
`'release deliver'`. A catalog entry with `menuGroup: 'release'` appends `'release remove'` there, and
the assertion goes red.

This is not a citation slip; it is a **false claim in the plan**. §5.3 row 1 says the menu invariants
are *"Covered with **zero test edits** by `allMenuEntries()`/`allMenuPaths()` … Verify by running."*
That is true of `command-catalog.test.ts` and false of `palette.test.ts`, which is a different file
with a literal list. And §7 step 2 names `command-catalog.test.ts` **by path**, not the `__tests__`
directory — so the plan's own scoped verification does not run it either. The proof that this is a real
consequence rather than a hypothesis: the concurrent session **already had to make exactly this edit**
(`git diff` on that file is a one-line insertion of `'setup-dependency-status'` into the
Setup & Diagnostics array).

**C2 — `«cli»/src/mcp/__tests__/mcp-stdio.e2e.test.ts:1082` `AUTHORED_TOOL_NAMES`.** The w1 differential
compares the served `tools/list` against a pre-migration v1 baseline fixture, stripping tools
registered after that baseline. `release-remove` is such a tool, so it must be added to that Set or the
differential compares 25 served tools against a 23-tool fixture and fails. The self-check at `:1094`
(`expect(listed.length - copy.tools.length).toBe(AUTHORED_TOOL_NAMES.size)`) adjusts automatically once
the name is in the Set.

**And C2 carries a sequencing dependency the plan must state.** That entire 18-line block — the Set, the
filter, and the self-check — exists **only in the peer session's uncommitted work**; at `969bbe0` the
helper strips no tools at all. So `release remove`'s exposure *depends on someone else's unlanded
change*. If that work is reverted or lands in a different shape, `release remove` must build the strip
mechanism itself or the differential is unsatisfiable. AC-27's unscoped `npx vitest run` does catch
this; §7 step 2 does not, because it never enters `src/mcp/`.

### The plan-quality answer: stop citing absolute counts, and declare the surface

Re-anchoring to the working tree is the Architect's recommendation, and it is necessary but not
sufficient — the tree is itself moving, and the peer's numbers will change again the moment that work
is committed or rebased. Re-anchoring to an uncommitted tree buys one round of accuracy and then
expires the same way `969bbe0` did. Four things, in order of durability:

1. **Convert every count-bearing citation into a delta.** AC-23 already does this — *"gains **exactly
   one** tool object with no other key changed"* is true at HEAD, in the tree, and after the peer
   lands. §3.2's *"`toHaveLength(23)` → `24`"*, §8.5's *"23 → 24"* and D-c's *"12 of 23"* are absolute
   and therefore perishable. They should read: *"increment whatever `toHaveLength(N)` currently
   asserts; add one entry to `EXPECTED_EXPOSED_TOOLS`. The absolute number is not a fact about this
   change."* This is strictly better than re-anchoring because it cannot go stale.
2. **Declare the collision surface as a named list** — the six files both landings touch:
   `command-catalog.ts`, `command-catalog.test.ts`, `__snapshots__/command-catalog.test.ts.snap`,
   `palette.test.ts`, `program.ts`, `mcp/__tests__/mcp-stdio.e2e.test.ts`. The plan currently names
   three, omits two (C1, C2), and tells the implementer a fourth needs no edit.
3. **State the sequencing constraint** (C2): exposure depends on `AUTHORED_TOOL_NAMES` existing. Land
   after the peer commits, or own the mechanism.
4. **Add a pre-implementation re-read step** — a single command that prints the current state of those
   six files' anchors, run *before the first edit*, not from a review document. And record the hazard
   that the usual A/B move is unavailable here: `git stash` is forbidden in this repo (a pnpm command
   run while stashed rewrites `pnpm-lock.yaml` and wedges the pop), so `git show HEAD:<path>` is the
   only safe comparison — and against a dirty tree it answers the wrong question anyway.

**Is a plan pinned to a commit implementable while a peer mutates the same files?** Yes, but only if it
says so. The defect is not the pinning — pinning is right for a review artefact, and the plan's
citations *are* exact against its declared base, which the Architect and I both verified separately.
The defect is that the plan reads as an **implementation contract** while carrying a **review-time
convention**, with no statement that the two have diverged. One paragraph converts it.

## R2.4 — Acceptance criteria re-audit (27)

My round-1 rulings were: 5 failing, 4 missing. All nine are addressed, and the new ones hold up.

- **Old AC-1 → AC-1/2/3.** Split into artefact-state, ordering, and the Zed non-relaunch. AC-1 now
  enumerates six *observable* post-conditions (`gh pr view --json state`, `git branch --list`,
  `git ls-remote`, a 404) rather than "removes, in order". Independently verifiable. ✓
- **Old AC-2 → AC-4/5/6.** AC-5 now requires the remediation to name `--version` **and not** name
  `--versions`/`--all`, which was my objection: the shared `assertInteractive` string
  (`release-picker.ts:35-44`) advertises two flags D6 rejects. D6's re-throw is the right resolution —
  it leaves the shared helper alone for the three commands that legitimately accept all three. ✓
- **Old AC-4 → AC-11**, split into a unit-verifiable half (both `move*` parameters carried) and a
  live-Jira half (§5.4 step 7). This was the criterion I ruled unverifiable; the split fixes it. ✓
- **Old AC-10 → AC-19**, now *"any step **other than `ide-folders`**"*, reconciled with the exemption. ✓
- **Old AC-14 → AC-27.** Named lanes plus `git status --short` for `??` files. ✓
- **The four I said were missing** are AC-20 (confirm text), AC-21 (log carries the Jira id and both
  SHAs), AC-25 (`/CLAUDE.md` regenerated from a fresh build, marker unmoved), AC-26 (U1-U3 recorded,
  including the post-state of a test issue). All present, all falsifiable. ✓
- **AC-15 vs AC-13** — the reconciliation is correct and, more importantly, *written down*: PRs cannot
  be deleted, so a release this CLI removed keeps a `CLOSED` PR and the "no PR in any state" conjunct
  never fires. The plan names the one genuine edge (a release whose PR creation failed, later fully
  removed) and accepts a refusal there. Without that paragraph an implementer would have "resolved"
  the apparent contradiction by weakening one of the two. ✓
- **AC-18**'s clean-tree qualifier is the fix for the pass-for-the-wrong-reason hole I raised. ✓
- **AC-23 survives the working-tree finding**, because it is phrased as a delta. It is the only
  count-adjacent criterion that does. That is the pattern §3.2 and §8.5 should copy (R2.3).

**Two residues, both minor:**

- **AC-6 has no test.** *"A non-TTY run without `--yes` exits non-zero with a 'declined' message"* is
  pinned by no entry in §5.1. Every other behavioural criterion has a T-number. Add a case to T6 (the
  guard-ordering file is the natural home).
- **AC-2 and AC-19 overlap on ordering** — AC-2 asserts the six-step order, AC-19 asserts abort
  semantics including the exemption. Not a defect, but T5 is the sole evidence for both, so a T5
  regression fails two criteria for one cause. Worth knowing when reading a red run.

## R2.5 — I chased the `throwOnDecline` change as a potential blocker. It is not one; one sentence is wrong.

D6 switches to `confirmOrExit(…, { throwOnDecline: true })` and AC-6 requires a **non-zero** exit. But
`CommandDeclinedError`'s own docblock says *"Callers that opt in via `throwOnDecline` are responsible
for catching it and **exiting 0**"*, and its only existing consumer swallows it —
`gh-merge-dev.ts:477` is `if (!isCommandDeclined(error)) throw error`, after which the command builds a
report with `declined: true` and exits 0. So the plan takes an option in the opposite direction from
its documented contract and its only precedent, and lists **no** edit to any entry or error-rendering
file. That looked like round 1's defect class recurring: an acceptance criterion the described code
cannot meet.

**Traced, and AC-6 is satisfiable with no code change.** `entry/cli.ts:45-58`: prompt cancellations
exit 0 with `logger.info('Operation cancelled.')`; **everything else** falls through to
`logger.error(error.message)` and `process.exit(1)`. An uncaught `CommandDeclinedError` therefore
renders as `Operation cancelled by the operator` at exit 1. Readable, non-zero, no stack trace. AC-6
holds and the divergence is deliberate and argued (Esc = "I never answered" → 0; "n" = "I answered no"
→ non-zero).

**What is wrong is one sentence.** §5.5 says *"Refusals log at `warn`, never `error`: a refused
removal is the command working."* The most ordinary refusal of all — declining the prompt — will log
at **`error`**, via the generic handler, and the plan lists no edit to change that. D6's phrase *"let
the CLI entry render the refusal"* also implies a rendering path that does not exist; what exists is
the unknown-error fallthrough. **Non-blocking**, but the plan should say plainly: the decline is
rendered by `entry/cli.ts:53-57` at `error` level with exit 1; §5.5's warn-not-error rule covers guard
refusals, not the decline; and `release remove` is deliberately the first caller to use
`throwOnDecline` for exit-code semantics rather than the leak safety its docblock describes — which is
the Architect's R2-SUGGESTED 3, and it should be stated as a divergence rather than as docblock support.

## R2.6 — Are the Architect's two blocking items the complete set? No — two more, both mechanical.

Its two are correct and I verified both independently:

- **R2-REQUIRED 1 (re-anchor)** — confirmed, with the identifier corrected (R2.3) and, I'd argue,
  superseded by the delta-not-absolute convention, which fixes it durably rather than once.
- **R2-REQUIRED 2 (`remove-release-worktree.test.ts`)** — confirmed verbatim: `:6` imports
  `removeReleaseWorktreeIfPresent` from `'../gh-release-deliver'` (a path the hoist relocates) and the
  second `it()` asserts `await expect(removeReleaseWorktreeIfPresent(RELEASE_BRANCH)).resolves.toBeUndefined()`,
  which `Promise<string[]>` breaks. §3.2's *"Deliver's call site ignores the new return"* is true of
  the production caller only.

**Missing from both lists: C1 (`palette.test.ts`) and C2 (`mcp-stdio.e2e.test.ts`)** — R2.3. C1 is the
more serious of the two because the plan does not merely omit it, §5.3 tells the implementer no such
edit exists.

**Its two open notes, both confirmed:**

- **D7's "five gated tools" is eight.** Verified verbatim: `EXPECTED_GATED_TOOLS` holds `gh-merge-dev`,
  `release-create`, `gh-release-deploy-all`, `gh-release-deploy-selected`, `env-clear`,
  `worktrees-remove`, `local-deploy-all`, `local-deploy-selected`. The argument is *stronger* at eight,
  so this is cosmetic — but it is the fourth miscount across three documents, which is itself the
  argument for the delta convention in R2.3.
- **The `throwOnDecline` docblock reading** — see R2.5, where I reach the same place by a different
  route.

## R2.7 — New material

**U1/U2 fallbacks (D2a).** Better than what either review asked for, and the plan makes two moves I did
not. (i) Under the JQL fallback the command must **refuse rather than reassign**, because a single
`total` cannot feed a flag that now writes to two parameters — that follows from D2b's own per-count
design, and it is the kind of consequence a plan usually discovers during implementation. (ii) It
declines to default `--skip-jira` on the U1 failure path and introduces a distinct `jira: 'manual'`
outcome instead, on the grounds that defaulting the flag inverts its meaning from "exception" to
"normal" and destroys its value in shell history. That was my non-blocking item 11 and the plan states
the reason better than I did. Also good: the measurement must assert *the post-state of a test issue*,
not the HTTP status — which is the only form of the measurement that catches a semantic surprise.

**Contract 5 and the stale-`dist/` mitigation.** Verified end to end and it is the strongest new
section. The build-before-audit ordering (§7 step 1), the stability re-run (`audit --root` must exit 0
on the second pass), and the version-marker warning (`:18` must not move; a move means the tree's
version differs from the one that last wrote the block) are all correct and all were derived, not
copied from my item.

**T8-T11.** All four meet the house bar — each docblock subject is a named false-success rather than a
behaviour list. T10's is the best in the document (*"a guard that passed six steps ago authorising an
unrecoverable call"*). T11 correctly makes the **classification** the subject rather than the URL
shape, which was my round-1 complaint about the old T8. T8(d) — the CLI path with the same inputs
*does* run the Jira step — is the right way to prove the narrowing is MCP-scoped and not a general
disablement; without it the test would pass against a command that simply broke Jira.

**One gap in T8.** It pins that `moveIssuesTo` and `skipJira` are refused over MCP, but nothing pins
that they are **accepted** on the CLI path — so a guard that refused them unconditionally would pass
T8(a)-(c) and be caught only by T2(d). Cheap to fold into T8(d), which already exercises the CLI path.
Non-blocking.

---

## VERDICT: APPROVE

The design is settled and I have no remaining objection to it. All ten of my round-1 blocking items and
all nine non-blocking ones are discharged substantively — I read the revised sections rather than the
summary, and none was reworded in place. The two reversals are real: D7 is wired rather than declared,
and the IDE step is decided rather than demoted. Both of the fixes the plan **rejected** and replaced
are better than what I asked for, and in one case (the tip SHA on the resume path) my proposal would
have failed exactly where the command is most used. Revision 2 also corrected two of my own citations
and one of the Architect's.

Nothing outstanding is a design defect, and nothing would mislead an implementer into shipping
something *wrong*. What remains is a plan whose citation convention belongs to a review artefact while
its content is now an implementation contract, plus two files missing from an edit list. Those produce
red tests that name their own fix, not silent damage — and the bar for another round is a defect that
ships something wrong. Another full round would buy accuracy that the delta convention in item 1 below
buys permanently and for free.

### Apply before implementing

Ordered. Items 1-4 must be in the plan text before the first commit; 5-8 are one-line clarifications.

1. **Convert every count-bearing citation to a delta, and say which tree the plan is anchored to.**
   *(amends §3.2's `command-catalog.test.ts` row, D-c, D7's wiring table, §8.5)* Replace
   *"`toHaveLength(23)` → `24`"* with *"increment whatever `toHaveLength(N)` currently asserts"*, *"23 →
   24"* with *"+1"*, and *"12 of 23"* with *"12 of the exposed set"*. AC-23 already reads this way and
   is the only count-adjacent criterion that survives the tree drift — copy its phrasing. Then state
   that `command-catalog.{ts,test.ts}`, the snapshot, `palette.test.ts`, `program.ts` and
   `mcp/__tests__/mcp-stdio.e2e.test.ts` are **modified and uncommitted** by a concurrent
   `setup-dependency-status` landing, that the citations are exact at `969bbe0` and `+1` in the tree,
   and that the `it()` title at `:80` already says *"expected 23"* while its assertion says 24 — so the
   title must be fixed too, or the test ships named for a count it does not assert. **The tool is
   `setup-dependency-status`; the Architect's `setup-deps-status` matches nothing.** Add a re-read step
   before the first edit, and note that `git stash` is unavailable here (it rewrites `pnpm-lock.yaml`
   and wedges the pop), so `git show HEAD:<path>` is the only safe A/B — and it answers the wrong
   question against a dirty tree.

2. **Add `«cli»/src/lib/command-catalog/__tests__/palette.test.ts` to §3.2, and correct §5.3.**
   `:40-58` is a hardcoded `toEqual` over grouped palette rows; `'release remove'` must be appended
   after `'release deliver'` in the Release Management array (catalog insertion order). §5.3 row 1
   currently says the menu is *"covered with **zero test edits**"* — true of `command-catalog.test.ts`,
   **false of this file**, which is the more damaging error because it tells the implementer not to
   look. §7 step 2 names `command-catalog.test.ts` by path, so widen it to the `__tests__` directory or
   this escapes the plan's own verification. Proof it is real: the concurrent session already made this
   exact one-line edit for its own command.

3. **Add `«cli»/src/mcp/__tests__/mcp-stdio.e2e.test.ts` to §3.2, and state the sequencing dependency.**
   `release-remove` must join `AUTHORED_TOOL_NAMES` at `:1082` or the w1 differential compares the
   served tools against a v1 baseline that predates it; the self-check at `:1094` adjusts via `.size`.
   **That Set, its filter and its self-check exist only in the peer session's uncommitted work** — at
   `969bbe0` the helper strips no tools at all — so D7's exposure depends on someone else's unlanded
   change. Say so: land after that work commits, or own the strip mechanism. Add `src/mcp/` to §7 step
   2; AC-27's unscoped `npx vitest run` catches it, the scoped step does not.

4. **Add `«cli»/src/commands/gh-release-deliver/__tests__/remove-release-worktree.test.ts` to §3.2**
   (Architect R2-REQUIRED 2). `:6` imports from `'../gh-release-deliver'` — a path the hoist relocates —
   and the second `it()` asserts `.resolves.toBeUndefined()`, which `Promise<string[]>` breaks. §3.2's
   *"Deliver's call site ignores the new return"* is true of `:420` only.

5. **Fix §5.5's decline sentence.** *"Refusals log at `warn`, never `error`"* is false for the decline:
   an uncaught `CommandDeclinedError` reaches `entry/cli.ts:53-57`, logs at **`error`**, and exits 1.
   AC-6 is satisfiable with no code change, so this is a description error, not a design one. Scope the
   warn-not-error rule to guard refusals, name `entry/cli.ts:53-57` as what renders the decline, and
   state plainly that `release remove` is the first caller to use `throwOnDecline` for **exit-code
   semantics** rather than the leak safety its docblock describes (`command-declined-error.ts:6-7`
   says decliners should exit 0; `gh-merge-dev.ts:477` is the only precedent and it swallows to 0).

6. **Soften D4 step 2's "Cursor's verified `removed`".** `removed: []` is returned on three paths —
   nothing to remove, no `workspaceConfigPath` (`:95`), and a **caught write failure** (`:113`) — so an
   empty array is not evidence. Report Cursor as verified when non-empty and `attempted` when empty,
   which is what revised Principle 2 already prescribes. The single abort exemption itself is sound:
   step 2 cannot carry state into steps 3-6, and the exempted throw is nearly unreachable.

7. **Correct D7's "five gated tools" to eight** — `EXPECTED_GATED_TOOLS` holds `gh-merge-dev`,
   `release-create`, `gh-release-deploy-all`, `gh-release-deploy-selected`, `env-clear`,
   `worktrees-remove`, `local-deploy-all`, `local-deploy-selected`. The argument is stronger at the
   correct number.

8. **Two test gaps.** Give AC-6 a test (a decline case in T6 — it is the only behavioural criterion
   with no T-number), and fold into T8(d) an assertion that `moveIssuesTo`/`skipJira` are **accepted**
   on the CLI path, so an unconditional refusal cannot pass T8. Also adopt the Architect's
   R2-SUGGESTED 1 (say `jira: 'manual'` in the tool **description**, not only the result) and
   R2-SUGGESTED 2 (capture `remoteTipSha` from `deleteRemoteBranch`'s existing `ls-remote` probe, which
   already fetches and discards it).
