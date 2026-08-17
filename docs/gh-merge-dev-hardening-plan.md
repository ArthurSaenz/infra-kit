# `[DO] gh-merge-dev` hardening plan

**Status: pending approval.** Iterations 1–3.1 designed the merge engine; **§10 (amendment, now at iteration 2)** adds mandatory worktree convergence. Phase 0 has shipped; `scratch-worktree.ts`, `merge-refs.ts` and `merge-run.ts` are built and tested, but nothing is wired into the command yet (§10.9).

Evidence: `E1–E15` measured by me (`scratchpad/exp/exp{1..15}-*.sh`), `C1–C12` by the critic, `A1–A8` by the architect, `F1–F4` by the team lead (`scratchpad/ff-evidence.md`, convergent with E11). All on git 2.54.0, macOS, throwaway repos with `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null`. Anything unmeasured is labelled **ASSUMPTION**.

---

## 0. Changes in §10 amendment, iteration 2

| # | Change | Blocker |
|---|---|---|
| 1 | **§10's classifier is now fully structural — message matching is gone, not merely locale-pinned.** Rebase dirs → in-progress heads → `is-ancestor` → incoming∩dirty path intersection. `LC_ALL=C` still applies to §3.4's one remaining message branch (`hook-failed`), where no structural signal exists — and `merge-run.ts:73` ships that bug today. | B1, **superseded mid-round**: the `LC_ALL=C` table I wrote first was sound but strictly weaker. Verified structurally (E15.1–E15.6), including an identical result under `de_DE.UTF-8` |
| 2 | **`already-current` is now provisional**, verified by `HEAD == origin/<B>` **and** an unchanged `status --porcelain`; otherwise the new status `desynced`. Duplicate worktrees on one branch are detected and **both** skipped (`skipped-duplicate-worktree`). | B2 — re-measured (E14.2 the lie, E14.3 the detector, E14.4 `worktree add --force` permits it) |
| 3 | **Convergence enumerates the SELECTED set, not the pushed set** — otherwise the directive goes unmet on the routine teammate-merged branch that reclassification drops. | B3 |
| 4 | **Scratch-worktree exclusion corrected**: removal moved ahead of convergence *and* the scratch path skipped by name. The old "removed before this step" sentence was false against §3.6's `finally`. | B4 |
| 5 | `skipped-error` made loud (warn-level, own count, own criterion); criterion 22 scoped to non-skipped worktrees. | O5, O6 |
| 6 | Relative `core.hooksPath` recorded as per-worktree; N converged worktrees = N `post-merge` runs costed; git ignoring `post-merge`'s exit status claimed as a good property; submodules declared out of scope. | O7, O8, O9 |
| 7 | §1 Option A's retracted "colleague's checkout" framing fixed in place. | O10 |
| 8 | "Converge the worktree the operator is in **last**" promoted from follow-up prose to design; the watcher ASSUMPTION sharpened to name the unbidden-vs-chosen delta. | O11, §5 |

## 0a. Changes in iteration 4

| # | Change | Driver |
|---|---|---|
| 1 | **New §10: local release worktrees converge by `git merge --ff-only` after a successful push — default, mandatory, no flag.** | User directive |
| 2 | **Principle 3 rewritten in place** (§1) — the old wording forbade exactly what §10 now requires. §10.1 argues the replacement instead of widening it quietly. | the directive contradicts the stated principle |
| 3 | **§3.7 marked SUPERSEDED in place**, its evidence retained (`update-ref` desync, `branch -f`/`fetch b:b` refusal) because §10's mechanism is chosen against it. | must not contradict the document it lives in |
| 4 | **Two ADR consequences rewritten in place** (§8) — the "local branches do not advance" bullet is now the convergence bullet plus an explicit out-of-scope bullet. | same |
| 5 | New evidence **E11** (the whole `merge --ff-only` risk surface), **E12** (`post-merge` runs in the target worktree), **E13** (the three gaps the evidence handoff flagged unverified). | brief required measurement, not assumption |
| 6 | **New status `skipped-operation-in-progress`.** E13.2/E13.3 showed the two exit-128 cases carry different messages, so classifying on the exit code alone would misreport "you are mid-rebase" as a divergence. | E13 |

## 0a. Changes in iteration 3.1

| # | Change | Blocker |
|---|---|---|
| 1 | **Signal guard scoped to the CLI path only.** §3.11 now distinguishes the two callers of `ghMergeDev` explicitly and states what happens under MCP instead. | Architect (a) — the cited precedent lives at an entry point; a per-invocation `process.exit(130)` inside the long-lived MCP server preempts host shutdown |
| 2 | **Reclassification runs again after the verify pass.** §3.6's order is now reclassify → verify → **reclassify** → push, with acceptance criterion 20. | Architect (b) — a minutes-long `--verify=qa` pass makes the first reclassification stale, and under `--atomic` one stale ref aborts every branch |
| 3 | On atomic rejection the report now says **"re-run the command"**, not "retry these shas". | Optional — the offered shas' only reachability root is destroyed by the `worktree remove --force` in the same `finally` |
| 4 | Criteria 17/18 assigned to Phase 2, 19 to Phase 1. | Optional — they were new in iteration 3 and unmapped |
| 5 | §4 splits the hermeticity claim: only the `qa` tier is non-hermetic. | Optional — `install` checks lockfile-vs-`package.json`, which a neighbouring branch's `node_modules` cannot affect |
| 6 | New evidence **A5**: `prepare-commit-msg` receives `$2 = merge` under both `-m` and `--into-name`. | recorded — confirms `-m` carries no hook-fidelity penalty |

## 0b. Changes in iteration 3

Each row names the blocker that drove it. Iteration 2's change table is preserved below, collapsed.

| # | Change | Blocker |
|---|---|---|
| 1 | **Cleanup made real.** A SIGINT/SIGTERM handler scoped to this command; `confirmOrExit` gains an **opt-in** `throwOnDecline` so the decline path unwinds instead of `process.exit(0)`. §3.4/§3.6's `(finally)` annotations, Principle 4 and §9 are now backed by code that runs. New §3.11. | B1 — verified: no signal handler in `entry/cli.ts`; `confirm-or-exit.ts:44-47` exits directly |
| 2 | **Anchor refs deleted.** Change #6 of iteration 2, `update-ref -d` from §3.6, and E9.5/E9.6/E9.8 are gone. This also deletes architect N3 (permanent ref leak) and N4 (shared namespace + D/F conflict). | B2 — I re-measured rather than take it on trust: **E10.5/E10.6/E10.7** |
| 3 | **`getReleasePRsWithInfo()` change reverted** — the bug does not exist. Change #12, its §3.4 paragraph, the Phase 0 bullet and integration case 15 are deleted; the ADR's zero-PR consequence is restated correctly. | B3 — verified at `gh-release-prs.ts:79-98` |
| 4 | **Merge message specified**: `-m "Merge remote-tracking branch 'origin/dev' into <B>"`, written into §3.4's loop and asserted in a test. §0 #3's "Driver 3 met absolutely" softened accordingly. | B4 — a detached merge writes `… into HEAD` (E10.1) |
| 5 | **`$SCRATCH` located** outside every existing working tree; the initial `worktree add --detach` anchored on `origin/dev`, not the first candidate. | B5(a), B5(b) |
| 6 | **`--verify` moved post-confirm** onto the selected set, with its own `checkout --detach <sha>` pass in §3.6. **Pre-consent hook execution disclosed** in §3.4's boundary list and §8. New `hook-failed` status. | B6 |
| 7 | §9's "no partial state" sentence corrected; the refspec set is printed before the push; no report asserts "origin unchanged" without an `ls-remote` re-check. | Optional #7 (adopted) |
| 8 | `clean -fd` chosen deliberately — **non-hermetic, `node_modules` survives between branches** — and §4's cost paragraph corrected to match. | Optional #8 (adopted) |
| 9 | §6.1's orphaned `git config --type=bool` bullet dropped. | Optional #9 (adopted) |
| 10 | `gh-merge-dev-plan` registered `mutating: true` with an allowlist justification; §8 records that the dry run is no longer cheap and that the plan tool honours `versions`. | Optional #10, #12 (adopted) |

Carried forward unchanged from iteration 2 and not re-opened: real `git merge` in one reused detached worktree as both plan and apply substrate; `git push --atomic` with pre-push reclassification; the cascade cleanup; never rewind a shared ref; `--verify` pre-push, default OFF, block-by-skipping; `--update-local` cut; Phase 0 first.

<details>
<summary>Iteration 2's change table (superseded — kept for reviewer diffing)</summary>

| # | Change | Driver |
|---|---|---|
| 1 | **Strategy reversed.** The merge is now performed by real `git merge` in **one reused detached worktree**, which serves as *both* plan and apply substrate. `merge-tree` is deleted from the design entirely. | Critic §B ruling; architect §1a/1b — the old default was chosen on a criterion the plan had declared out of scope |
| 2 | **Deleted:** `git-capabilities`, `chooseStrategy`, `strategy`/`strategyReason`, the `--strategy` flag, old acceptance criteria 9–11, and the whole §2.3 silent-drift failure class | falls out of #1 — one engine means nothing to probe |
| 3 | **Driver 3 is now met absolutely** ("byte-identical or refuse") instead of by an open-world whitelist that C1/C4/C5 proved short by three | Critic §B.1 |
| 4 | **`git push --atomic`** with N refspecs, paired with pre-push reclassification | Critic C2/C3; makes pre-mortem 2.1's "Prevented" literally true |
| 5 | **Cross-branch cleanup designed and tested** — the cascade the new design introduces (E9.3, C6) | Critic blocking #3 |
| 6 | **Merge commits anchored** under `refs/infra-kit/merge-dev/*` between collection and push (E9.5) | new; not raised by either review |
| 7 | Picker re-sequenced **after** the plan, rendering per-branch status inline | Critic §D1 |
| 8 | `--versions` filtered against the open **regular** release set; comma-string type; lossy label round-trip fixed | Architect #3 / Critic #4 — as previously specified it would merge dev into hotfix branches |
| 9 | New ungated MCP tool `gh-merge-dev-plan` | Architect #4 / Critic #5 |
| 10 | Exit-code contract defined; Phase 0 acceptance criterion corrected | Architect #7 / Critic #6 |
| 11 | Phase 1 is now `--dry-run`-only; it can no longer ship a plan-then-fatal command | Critic §D3 |
| 12 | `getReleasePRsWithInfo()` failure now throws instead of reporting success-with-zero-branches | Critic §D4 |
| 13 | `dryRun` ⇒ `successfulMerges: 0`, every `pushed: false`; early return at `gh-merge-dev.ts:48-53` added to the change list | Architect #8 / Critic #8 |
| 14 | Every new flag threaded through `commandEcho`; echo built from branch names, not `releaseBranchLabels` | Architect #9 / Critic #9 |
| 15 | `--verify` re-tiered: default tier `pnpm install --frozen-lockfile`, `--verify=qa` for the suite; root `qa` never invoked by name | Architect #11 / Critic optional |
| 16 | **`--update-local` cut from v1** (was inert; the proposed fix contradicts why Option A died) | Critic #14 |
| 17 | Principles 1, 3, 4 rewritten to what the design actually delivers | Architect §5 |
| 18 | Modules consolidated into `git-utils` + one unit under `commands/gh-merge-dev/`; `OperationError` contract stated | Architect #14 |
| 19 | Acceptance criteria #4/#6/#12/#14 fixed; criteria added for exit code, dryRun, MCP read-only, hotfix exclusion, cascade | Critic #13 |
| 20 | PR-side effects (N CI runs, stale-approval dismissal) recorded; noted that this repo has zero open release PRs, so all validation is fixture-only | Critic §D2 |

*(Rows 3, 6 and 12 above were amended or deleted in iteration 3 — see the iteration-3 table.)*

</details>

---

## 1. RALPLAN-DR summary

### Principles

1. **Before the operator has seen the full plan, this command writes no `refs/heads/*`, touches no existing checkout, and changes nothing on any remote.** What it *does* write before consent — objects, its own scratch worktree and registration, `refs/remotes/*`, and the repo's own merge/commit hook side effects — is enumerated in §3.4 and reclaimed by §3.11. *(Iteration 2's wording opened with "no ref … is mutated" and then declared a ref namespace working space, contradicting itself; the ref namespace is now gone entirely.)*
2. **Shared refs move forward only.** No `--force`, no `--force-with-lease`, no `+` refspec, no rollback that rewinds a remote. A rejected push is a correct outcome.
3. **This command performs no merge work inside a checkout it does not own, and never leaves one in a state the operator has to repair.** It never requires a particular `HEAD` or a clean tree anywhere, never creates a commit outside its own scratch worktree, and never leaves a `MERGING` state or an unpushable commit behind. It *does* consume disk and the `git worktree list` namespace for its scratch worktree, and — after a successful push — it converges the operator's own release worktrees by **fast-forward only**, failing closed and preserving uncommitted work (§10). *(Rewritten in the iteration-4 amendment. The previous absolute phrasing — "no checkout that already exists is a resource this command consumes" — is contradicted by mandatory worktree convergence, and §10.1 argues the replacement rather than quietly widening the old one.)*
4. **A completed run is fully described.** Every selected branch ends with an explicit terminal state in both the report and `structuredContent`. A run cut short by SIGINT or a declined confirmation emits a partial report before exiting.
5. **Fail closed, and fail per-branch.** Preflight failures throw; per-branch outcomes are values. One branch's conflict never changes another branch's result.

### Decision drivers (ranked)

1. **Determinism / trust.** The user's headline requirement. A command that aborts because a worktree exists, or half-applies, or reports a conflict the operator's own `git merge` resolves instantly, is worse than no command.
2. **Coexistence with the team's per-release worktree layout.** "The release branch is checked out somewhere" is the default state.
3. **Merge fidelity.** What we push must be byte-identical to what `git merge origin/dev` would produce on that branch, and reproducible by the operator with a command they already know.

Latency and code volume are tiebreakers only, and are named as such wherever they are used.

### Viable options

#### Option A — merge inside the operator's existing release worktrees

*Pros:* no new worktree; `node_modules` already present.

*Cons (measured):* mutates an in-flight checkout the command did not create (E4.5 moves its `HEAD`); blocked by whatever dirt is in it (E5.2 — exit 2, `Your local changes ... would be overwritten by merge`); a conflict strands that worktree in `MERGING` for its owner to discover; a stale local branch yields an unpushable merge commit left behind on it (E5.4, E5.5). Branches without a worktree still need a fallback path. *(Wording corrected in §10 amendment iteration 2: earlier drafts said "a **colleague's** checkout", which §10.1 retracts — `worktrees-add` creates worktrees on the operator's own machine. The four merge hazards above stand on their own without that framing, and they are what actually rejected this option.)*

*When right:* if the team's worktrees were disposable. They are not.

#### Option B — checkout-free plumbing (`merge-tree` + `commit-tree` + sha push)

This was iteration 1's recommendation. It is now **rejected**, and the reasons are the reviews', not latency:

- **Driver 3 was delivered by an open-world whitelist that is measurably short.** `merge.ff=false` makes real `git merge` produce a merge commit on a strictly-behind branch while the plumbing FF-leg produces none, and `merge-tree` returns rc=0 with a bare tree oid — **zero signal** (C4). `commit-msg` / `pre-merge-commit` / `prepare-commit-msg` hooks run under `git merge` and not at all under `commit-tree` (C5). `commit.gpgsign` is ignored by `commit-tree` (E3.8). rerere is ignored (E2.4) — and worse, iteration 1's mitigation cited `rerere.enabled` being *unset* as evidence rerere was off, when unset is precisely the state in which git auto-enables it if `$GIT_DIR/rr-cache` exists (C1). That was the worst factual error in the document.
- **Operator reproducibility.** A `commit-tree` merge cannot be reproduced by any command the operator knows. Their natural check — `git switch release/x && git merge origin/dev` — can legitimately produce a different tree, and their correct inference from that evidence is "the tool is broken." On the team's most-used command, on a plan whose recovery story is *inspection, not repair*, that is the wrong trade.
- **Its two headline wins were not discriminating.** FF-only push safety belongs to `git push`, not to `merge-tree`; the worktree design pushes identically (E4.7, E9.6). Driver-honouring (E2.2) is real and surprising, but it only closes one of five gaps.

*What B genuinely had, and what is now lost:* it held **no local state**, so branch k could not affect branch k+1, and two concurrent runs on one machine could not collide. That property is real and is the one thing this plan must now buy back deliberately — see §3.5 and pre-mortem 2.3.

*When right:* a CI robot merging into branches nobody has checked out, where reproducibility does not matter and every repo config is known. Not this.

#### Option C — one reused detached worktree as both plan and apply substrate ← **RECOMMENDED**

`git worktree add --detach <scratch> origin/<first>` once per run; per branch `checkout --detach origin/<B>` → `git merge origin/dev --no-edit` → collect sha **or** conflict paths → cleanup → next; push nothing until the operator confirms; then one `git push --atomic` of the collected shas; `worktree remove --force` in a `finally`.

*Pros:* full `git merge` fidelity permanently — rerere, all hooks, `merge.ff`, signing, drivers, and whatever git 2.60 adds — so Driver 3 is met by construction and the probe disappears. The operator's reproduction is exact. Per-run cost, not per-branch. **The plan and the apply are the same operation**, so they cannot disagree — under any design where `merge-tree` plans and `git merge` applies, the preflight can lie about the artifact you ship (C1 is exactly that case: merge-tree says conflict, `git merge` resolves it).

*Cons (measured):* introduces cross-branch state coupling — an unaborted conflict makes the next `checkout --detach` fail with `error: you need to resolve your current index first` (E9.3, first-hand; C6 independently). Introduces a scratch worktree that a crash can leave registered (E8.7). Both are designed for in §3.5 and §3.6, and both are the subject of pre-mortem 2.3.

#### Option D — hybrid (B plans, C applies)

Rejected on its own merits, not by elimination: it is the only option that can ship a preflight which disagrees with the artifact. C1 measures the disagreement. A preflight that can lie is worse than no preflight.

---

## 2. Pre-mortem — three ways this destroys something in three months

### 2.1 The half-applied run

**Mechanism.** Today's loop pushes branch-by-branch. D3 makes a mid-loop crash likely rather than theoretical: the `catch` in `mergeDev` calls `git merge --abort` unconditionally, and that call exits **128** with `fatal: There is no merge to abort (MERGE_HEAD missing)` whenever the failure was in `switch`/`pull`/`push` (E5.3). The rejection is thrown from inside the catch, escapes the loop, and kills the command. Branches 1–2 pushed, 3–6 not, `$.quiet` stuck true, `HEAD` parked on an arbitrary release branch.

**Blast radius.** Developers on the merged branches pull a merge nobody announced; the unmerged branches go stale into the release; the operator cannot tell which is which without inspecting six remotes.

**Prevented by.** Two mechanisms, and this time "prevented" is literal. (a) Nothing is pushed until every branch has been merged locally and the operator has confirmed. (b) The push is a single `git push --atomic` with N refspecs: measured all-or-nothing — with one of three refs non-fast-forward, **all three refs stayed unchanged on origin** and the command exited 1 (C2b), where the same push without `--atomic` landed two of three (C2c). GitHub's receive-pack advertises the `atomic` capability (C3). Each ref remains individually FF-checked, so Principle 2 is untouched.

### 2.2 The force-push that eats a colleague's commit

**Mechanism.** Someone "fixes" a rejected push with `--force-with-lease`, or a rollback feature rewinds origin after a failed `--verify`. E3.4 confirms `--force-with-lease` with an explicit expected oid does rewind the remote.

**Blast radius.** A teammate's commit vanishes from a shared release branch; the PR loses commits; recovery needs a reflog that may not exist.

**Prevented by.** (a) Verification is **pre-push only**, so no state ever "needs" rolling back. (b) There is no rollback-by-rewinding code path. (c) A unit test asserts no argument vector reaching `git push` contains `--force`, `--force-with-lease`, `-f`, or a `+`-prefixed refspec. Correctness does not depend on the test — the non-forced push is FF-only by measurement (E3.2, C2b) — the test stops a future edit from removing the property.

### 2.3 One conflict poisons the rest of the run *(new — this is the risk the recommended design introduces)*

**Mechanism.** The reused worktree carries state between branches. Measured first-hand (E9.3): after branch 2 conflicts (`UU c.txt`, `MERGE_HEAD` present), `git checkout --detach origin/r3` fails with `error: you need to resolve your current index first`. Branches 3…N then report `error` — not because they conflict, but because branch 2 did. That is D3's failure class, reintroduced by the design chosen to eliminate D3's failure class, and it lands on Driver 1. Second-order: if the process dies mid-conflict, the scratch worktree stays registered, and the next run's `worktree add` fails with `fatal: '<path>' is a missing but already registered worktree` (E8.7) or `fatal: '<path>' already exists` (E8.9) — the command is then broken every run until someone runs `git worktree prune`.

**Blast radius.** Silently wrong per-branch results (the worst kind — a branch that would merge cleanly is reported as failing, and the operator's re-run is idempotently wrong forever), plus a command that stops working on the operator's machine with a message that names git internals rather than a remedy.

**Prevented by.** Four mechanisms, each independently tested (§6.2 case 3): (a) `resetScratchWorktree()` runs in a `finally` around **every** branch iteration — `merge --abort` guarded by `rev-parse -q --verify MERGE_HEAD` (E5.3: unguarded it exits 128), then `reset --hard`, then `clean -fd`, because `reset --hard` alone leaves untracked files behind (E8.6); (b) a **pristine assertion** before each `checkout --detach` — `status --porcelain` empty and `MERGE_HEAD` absent (E8.2) — which converts a cleanup miss into a fail-fast rather than a cascade; (c) a **per-process unique scratch path** (§3.4) so two concurrent runs cannot collide; (d) `prune`-then-retry recovery at startup: on `add` failure, run `git worktree prune` and retry once (E8.8 measured this recovers the stale-registration case).

**`clean -fd`, not `-fdx` — a deliberate choice.** `-fd` leaves ignored paths, so `node_modules` installed by `--verify` on branch k survives into branch k+1. That makes verification **non-hermetic**: branch k+1 is verified against a tree another branch installed. pnpm reconciles, so it is normally correct and much faster, and §4's cost model is written to match. The hermetic alternative (`-fdx`) is defensible and is recorded as a follow-up; what is not defensible is specifying one and costing the other, which iteration 2 did.

---

## 3. Recommended design

### 3.1 Modules

Consolidated per architect #14 — no new `src/lib/` peers beyond one.

| Path | Responsibility |
|---|---|
| `src/lib/git-utils/git-utils.ts` (**extend**) | `revParseVerify`, `isAncestor`, `lsRemoteHeads`, `pushAtomic`, `withScratchWorktree`, `resetScratchWorktree`, `assertPristineWorktree`. Thin git wrappers next to the existing `listWorktrees` / `deleteLocalBranch` / `isWorkingTreeClean` family, behind the existing barrel. |
| `src/lib/command-echo/confirm-or-exit.ts` (**extend**) | Opt-in `throwOnDecline` — see §3.11. |
| `src/commands/gh-merge-dev/merge-run.ts` + `__tests__/` | The whole policy unit: `planMergeRun()`, `renderPlan()`, `applyMergeRun()`, the status vocabulary, and the reproduction-recipe renderer. Single-consumer, so it lives with its command rather than in `src/lib/`. |
| `src/commands/gh-merge-dev/run-cleanup.ts` + `__tests__/` | The cleanup contract: scratch-worktree teardown, the partial-report emitter, and the SIGINT/SIGTERM guard that makes both run on paths that do not unwind (§3.11). |

**Error contract, explicit** (architect #14, critic #6): **preflight failures throw `OperationError`** — not a repo, no `origin`, `getReleasePRsWithInfo()` failed, scratch worktree unobtainable after prune-and-retry, an explicitly named `--versions` branch that is not an open regular release. **Per-branch outcomes are values in `results[]` and never throw.**

### 3.2 Modified files

- `src/commands/gh-merge-dev/gh-merge-dev.ts` — orchestration rewrite; stops calling `assertManagementContext`; **the early return at `:48-53` must gain the new required `outputSchema` keys** (it currently returns only the four legacy fields, and `defineMcpTool` ties the return type to the schema).
- `src/lib/git-guard/git-guard.ts` — **add** `assertRepoWithOrigin({ operation })`. `assertManagementContext` untouched for its other callers.
- `src/lib/program/program.ts` — `configureMergeDev` gains the new flags and `process.exitCode = 1` on partial failure.
- `src/lib/command-catalog/command-catalog.ts` (+ snapshot) — register `gh-merge-dev-plan`.
- `src/commands/gh-merge-dev/__tests__/gh-merge-dev-mcp-guard.test.ts` — **breaks twice** and must be rewritten (§6).

### 3.3 Flag surface

| Flag | Default | Notes |
|---|---|---|
| `-a, --all` | – | unchanged |
| `-v, --versions <versions>` | – | **new.** Comma **string**, matching `program.ts:212,249` and every other command; the MCP schema accepts `string \| string[]` and normalises. Fixes **D8**: `configureMergeDev` (`program.ts:85-93`) defines only `--all`/`--yes` while `gh-merge-dev.ts:77` echoes `--versions`, so today's echoed command does not parse. |
| `--dry-run` | `false` | plan, print, push nothing |
| `--verify [tier]` | off; `install` when bare | `install` = `pnpm install --frozen-lockfile`; `qa` = the configured full task set |
| `-y, --yes` | – | unchanged |

Removed vs iteration 1: `--strategy` (one engine now) and `--update-local` (§3.7).

**`--versions` must be filtered against the open regular-release set.** `worktrees-add.ts:75-118` skips `getReleasePRsWithInfo()` entirely when `versions` is given — correctly, because it *wants* hotfix worktrees. Copying that shape here bypasses the `detectReleaseType(pr.title) === 'regular'` filter at `gh-merge-dev.ts:34-42` and merges `dev` into hotfix branches, which target `main`. That would be a new bug worse than the D8 it fixes. Here, `--versions` **selects from** the fetched regular-release set; a token that does not resolve to a member is a preflight throw naming the valid set.

**The label round trip is lossy and must not ship.** `releaseBranchLabels` (`release-utils.ts:196-203`) is a `flatMap` returning `[]` for any branch that fails `parseBranchName`. So `--versions` accepts **either** a version label (`1.2.5`) **or** a raw branch name, and `commandEcho` is built from branch names.

### 3.4 Preflight and plan phase

```
git rev-parse --git-dir                      # in a repo            ┐ throw on failure
git remote get-url origin                    # origin resolves      ┘
gh …  (getReleasePRsWithInfo)                # already throws on failure AND on zero PRs
git fetch origin --prune
git rev-parse --verify --quiet origin/dev^{commit}

# scratch worktree, once per run — anchored on origin/dev (see below)
git worktree add --detach "$SCRATCH" origin/dev
#   on failure: git worktree prune, retry once (E8.8), then throw

for each candidate branch B:
  git rev-parse --verify --quiet origin/<B>^{commit}   # absent → 'error', skip
  git merge-base --is-ancestor origin/dev origin/<B>   # exit 0 → 'up-to-date', skip (no checkout)
  assertPristineWorktree($SCRATCH)                     # status empty && no MERGE_HEAD  (E8.2)
  git -C "$SCRATCH" checkout --detach origin/<B>
  git -C "$SCRATCH" merge origin/dev --no-edit \
      -m "Merge remote-tracking branch 'origin/dev' into <B>"    # see "Merge message"
      exit 0 → 'merged' (or 'fast-forward' when HEAD == origin/dev); sha = rev-parse HEAD
      exit 1 → 'conflict'; conflict paths = diff --name-only --diff-filter=U   [structural]
      hook nonzero → 'hook-failed'  (distinct from 'error' — see §8)           [message; LC_ALL=C]
      other  → 'error'
  finally: resetScratchWorktree($SCRATCH)
```

`merge-base --is-ancestor` exits **128** on an unknown ref (E6), which is why `rev-parse --verify` comes first — otherwise a branch deleted on origin produces a fatal instead of a per-branch `error`.

**Any git invocation whose output is classified by *message* runs with `LC_ALL=C`.** This git build ships and honours message catalogs (E14.5), so a message-based branch silently collapses under a non-English locale. In this section that applies to exactly one branch: `conflict` is decided **structurally** by `diff --diff-filter=U` returning paths, and only `hook-failed` falls back to text — the same order `classifyMergeFailure` (`merge-run.ts:64-76`) already uses, and its existing `/hook/i` fallback (`:73`) is a live instance of the bug. §10 needs no such caveat: its classifier is fully structural and reads no prose at all.

**The scratch worktree is anchored on `origin/dev`, not the first candidate.** A candidate deleted on origin between `gh pr list` and the fetch would make the initial `add` fail, and §3.1's error contract turns that into a preflight **throw** that kills the run for every other branch — violating Principle 5 and contradicting integration case 13. `origin/dev` is `rev-parse --verify`'d one line earlier and is guaranteed to exist.

**`$SCRATCH` lives outside every existing working tree:** `<git-common-dir>/infra-kit/merge-dev-<runId>`, with `runId` from `INFRA_KIT_SESSION` (this repo's per-terminal id convention) falling back to the pid. Two properties matter. It must not land inside the main checkout — an untracked directory there breaks `isWorkingTreeClean`, and therefore `assertManagementContext` (`git-guard.ts:37`), for **every other release and worktree command in this CLI**, so a crashed `gh-merge-dev` would make `worktrees add` and `release create` refuse to run with a message naming nothing about `gh-merge-dev`. And it must not collide with the team's `<projectRoot>-worktrees/` convention, which `getCurrentWorktrees` scans. The `<runId>` suffix is what makes two concurrent runs safe (E8.9: a colliding path is a hard `fatal: … already exists`).

**Merge message: `-m "Merge remote-tracking branch 'origin/dev' into <B>"`.** A merge on a detached HEAD writes `… into HEAD` (E10.1), so `--no-edit` alone diverges from the operator's own `git switch <B> && git merge origin/dev` (E10.4) — the reproducibility claim that justified this whole strategy. Measured: `-m` and `--into-name <B>` both restore the control's exact subject *and* empty body, with a byte-identical tree in all four variants (E10.1–E10.4).

Chosen `-m` over `--into-name` because `--into-name` is git ≥ 2.40 and would reinstate a version floor this design had just eliminated, to fix a subject line. The real cost of `-m` is that it **freezes git's message format**: if git ever changes the default merge subject, `-m` keeps writing the old one — a fidelity divergence in the opposite direction. That is a cosmetic, *detectable* divergence (the §6.2 case-10 assertion pins the subject against a control `git merge`, so a future git change turns into a failing test), whereas a version floor is a hard environmental failure. Prefer cosmetic-and-detectable over hard-and-environmental.

`-m` also carries **no hook-fidelity penalty**: `prepare-commit-msg` receives `$2 = merge` under both variants (A5), so a repo whose hook branches on the merge source behaves identically either way. That was the one way `-m` could have been worse than cosmetic, and it is measured closed. Recorded as a follow-up: adopt `--into-name` if a git floor becomes acceptable for other reasons.

**Principle 1 boundary, stated plainly.** Before consent this writes: objects; a scratch worktree and its `.git/worktrees/<name>` registration; `refs/remotes/*` (the fetch); and — the largest item, and the one iteration 2 omitted — **the repo's own merge and commit hooks execute, once per candidate branch**. Hooks are arbitrary user code: they can write files, POST to a webhook, or increment a counter, and under §3.5 they run for candidates the operator may never select. This is a direct consequence of making the plan and the apply the same operation, and it is reachable through the ungated `gh-merge-dev-plan` tool (§3.8, §8). It does **not** write: any `refs/heads/*`, any existing checkout, or anything on any remote. Acceptance criterion 5 asserts exactly that boundary rather than a blanket "nothing changed".

### 3.5 Selection, then confirmation

The picker currently runs **before** anything is known (`gh-merge-dev.ts:56-69`), so the operator chooses blind and only then learns which branches conflict — which defeats the preflight. New order:

```
fetch → plan ALL open regular release branches → picker renders status inline → confirm → push
```

`formatBranchPickerItems` already carries a `description` field: `1.2.5 — clean`, `1.2.6 — CONFLICT: 3 files`, `1.2.7 — up to date`. With `--all` or `--versions` the picker is skipped and only the named set is planned. With `--dry-run` the plan prints and the command exits before the confirm; the picker is skipped entirely on a dry run rather than prompting for a selection that will not be acted on.

Cost, stated honestly: planning all candidates means merging branches the operator may not select. N is a handful of release branches, the work is local, and it is the price of an informed choice.

### 3.6 Apply phase

```
reclassify()                                           # fetch + is-ancestor, drops already-merged branches

# --verify only: post-confirm, selected set only (see §4)
for each remaining branch:
  assertPristineWorktree($SCRATCH)
  git -C "$SCRATCH" checkout --detach <collected-sha>
  <verify tier>                                        # nonzero → 'verify-failed', DROP from refspecs
  finally: resetScratchWorktree($SCRATCH)

reclassify()                                           # AGAIN — the verify pass is a long window; see below
print the exact refspec set about to be pushed
git push --atomic origin <sha1>:refs/heads/<b1> <sha2>:refs/heads/<b2> …
git worktree remove --force "$SCRATCH"           (finally — §3.11 makes this real)

# reclassify():
git fetch origin --prune
for each selected branch with a collected sha:
  git merge-base --is-ancestor origin/dev origin/<B>   # exit 0 → reclassify 'up-to-date', DROP from refspecs
```

**Reclassification is mandatory, not optional.** Two operators planning against the same `origin/dev` produce the same tree but different shas (committer timestamp), so the second push is rejected on a branch that is in fact correctly merged. Reporting that as `failed` on a daily command manufactures recurring false failures. Under `--atomic` it is worse: one teammate's hand-merge would abort **every** branch in the run. So the re-fetch and `is-ancestor` re-test run *before* the push and drop already-merged branches from the refspec set. `--atomic` without this is a downgrade.

**And it must run *after* the verify pass, not only before it.** Moving verification post-confirm (§4) put a step between the reclassification and the push — and under `--verify=qa` that step is minutes long. A teammate merging `dev` into a release branch during those minutes makes the first reclassification stale, and under `--atomic` that one stale ref aborts **every** branch in the run: exactly the failure this section calls "a downgrade" and made reclassification mandatory to prevent. Iteration 2 did not have this problem only because verification sat in a different place. So `reclassify()` runs twice — immediately before the verify pass and immediately before the push — and the second call is what the push actually depends on. Without `--verify` the two calls are adjacent and the second is a cheap no-op.

**No anchor refs.** Iteration 2 wrote each collected sha to `refs/infra-kit/merge-dev/<B>` to keep it reachable across the plan → confirm → push window. That is unnecessary, and I re-measured it rather than accept the review's word: the scratch worktree's own HEAD reflog holds every abandoned merge sha, and a **realistic** `git gc --prune=now` (no artificial `reflog expire`) leaves them all alive and pushable (E10.5, E10.6). Only `worktree remove --force` — which deletes that reflog — makes an unpushed sha collectable (E10.7), and removal happens strictly *after* the push. Iteration 2's supporting evidence (old E9.5) began by destroying the very protection that exists naturally, so it measured an artificial scenario. Deleting the anchors also removes a permanent, gc-immune ref leak on every declined run and a namespace shared between concurrent runs. On a crash the scratch worktree survives registered, so `git -C <scratch> reflog` recovers the shas by name — the anchors' stated fallback purpose, already covered.

**On atomic rejection:** report which ref aborted the push, and tell the operator to **re-run the command** — not to retry the collected shas by hand. Two reasons. Auto-retrying per branch would convert an all-or-nothing guarantee back into the partial application it exists to prevent. And a printed "push these shas" recipe is advice with a short shelf life: the `worktree remove --force` in the same `finally` destroys the reflog that is those shas' only reachability root (E10.7), so they survive on nothing but gc's default two-week loose-object grace. Re-running is idempotent (§9), re-derives the merges from current refs, and absorbs whatever a teammate landed in the meantime.

**Close the reporting window.** `--atomic` is all-or-nothing for *refs*, not for the operator's *knowledge*: a push that succeeds server-side but whose response is lost (network drop, or SIGKILL between the push returning and the report printing) leaves origin advanced on every branch while the command reports "aborted". `--atomic` makes that wrong report *more* credible, because the operator has been told all-or-nothing and reads "aborted" as "nothing happened". Three requirements: print the exact refspec set **before** issuing the push, so the transcript names what was in flight; on any push failure re-run `git ls-remote origin` and report **observed** origin state; and never let the report assert "origin unchanged" without having checked. The per-branch pre-push `ls-remote` of iteration 1 stays dropped — it was a TOCTOU that could not close a window the push already closes.

Status vocabulary: `up-to-date` · `fast-forward` · `merged` · `conflict` · `hook-failed` · `verify-failed` · `push-aborted` · `error` · `not-attempted`.

### 3.7 Local branches — superseded by §10

> **SUPERSEDED (iteration 4).** The decision below — report the skew, never touch a checkout — was reversed by direct user directive. Worktree convergence is now **default, mandatory, flagless** behaviour; see **§10**. What survives from this section is its evidence: `git update-ref` must never be used to advance a worktree-held branch (E4.8), and `git branch -f` (E4.9) / `git fetch origin <b>:<b>` (E4.10) both refuse one. §10's mechanism is `git merge --ff-only` run *inside* the worktree, which is measured to sidestep all three (E11).
>
> The rest of this section is kept because §10 argues against it, and deleting the losing side would make that argument unreadable.

*(original text follows)*

The skew is real: after a remote-only merge, the operator's local release branch is behind origin by a merge commit they created. `git branch -f` refuses worktree-held branches (E4.9) and on this team every release branch is worktree-held — so the flag as previously specified was **inert in exactly the configuration that motivated it**. `git update-ref` must never be the workaround: it succeeds and silently desyncs the worktree, showing its owner phantom staged deletions (E4.8).

The architect's fix — `git -C <worktreePath> merge --ff-only <sha>` — writes into a checkout that may belong to a colleague's in-flight work, which is verbatim the reason Option A was rejected and a breach of Principle 3. It is defensible as a narrow, opt-in exception, but shipping it silently would be incoherent.

**Decision: cut it.** In its place, the report prints, per skewed branch, the exact one-liner the operator can run themselves (`git -C <worktree> merge --ff-only origin/<B>`), so the skew is visible and actionable without this command reaching into anyone's checkout. Revisit as an explicit narrow exception once the core lands.

### 3.8 MCP surface

`tool-handler.ts:87` gates **before** the handler and `:93` injects `confirmedCommand: true` unconditionally, so `confirmOrExit` is a no-op on the MCP path. Consequence: plan → confirm → apply is CLI-only, and to obtain a read-only plan an agent must send `confirm: true` — the "execute the destructive operation" signal.

**Fix: a separate ungated tool `gh-merge-dev-plan`** (`requiresHumanConfirm` absent), whose handler is the preflight + plan phase with `dryRun` forced true. Rationale over the alternative: making `requiresHumanConfirm` a per-invocation predicate changes a **registration-time** property sourced from the catalog (`tool-handler.ts:11-14`) and therefore touches the shared boundary for every gated tool. This is also the only shape that gives agents a preflight without touching the destructive tool at all.

**It registers `mutating: true`, with an allowlist entry.** `command-catalog.test.ts:217` pins the exact `requiresHumanConfirm` list and `:229-236` enforces default-deny — any `mutating && mcpExposed` tool without the flag must be an explicitly justified member of `LOW_RISK_MUTATING_ALLOWLIST`. Registering the planner `mutating: false` would be a mislabel the catalog then propagates: it creates a worktree, performs N full checkouts, and **runs the repo's merge and commit hooks N times** (§3.4). It is read-only *with respect to shared state* — which is the right test for leaving it ungated — but it is not side-effect-free on the operator's machine, and the allowlist justification must say exactly that. Requires a `__snapshots__` update. The planner honours `versions`, so an agent can bound the work rather than always paying for every open release branch.

### 3.9 `structuredContent`

```ts
{
  successfulMerges: number,   // 0 when dryRun
  failedMerges: number,
  failedBranches: string[],
  totalBranches: number,
  dryRun: boolean,
  atomicPush: { attempted: boolean, aborted: boolean, abortedBy?: string },
  results: Array<{
    branch: string
    status: 'up-to-date' | 'fast-forward' | 'merged' | 'conflict' | 'hook-failed'
          | 'verify-failed' | 'push-aborted' | 'error' | 'not-attempted'
    mergeSha?: string
    conflictPaths?: string[]
    pushed: boolean          // always false when dryRun
    reproduce: string        // exact command the operator can run to reproduce this branch's merge
    reason?: string
  }>
}
```

`successfulMerges` counting `up-to-date` as success is a deliberate clarification (an up-to-date branch already ran a no-op merge and counted as success). **`dryRun` is different and must not be fudged:** `successfulMerges: N` after a dry run would tell every existing consumer that N merges were pushed. `--json` is already wired globally (`addJsonOption`), so this hits CLI scripts today, not only MCP agents. On a dry run `successfulMerges` is `0` and every `results[].pushed` is `false`.

### 3.10 Exit-code contract

- Preflight failure → throw `OperationError` → CLI exits 1 via `entry/cli.ts:57`.
- Any selected branch not reaching its desired terminal state → **`process.exitCode = 1` set in the action**, following the existing precedent in `audit` (`program.ts:461`) and `vendor check` (`program.ts:296`). `emit` never touches the exit code.
- All branches `merged` / `fast-forward` / `up-to-date`, or a clean `--dry-run` → exit 0.

### 3.11 Making cleanup real — the two paths that never unwind

Every `(finally)` in §3.4/§3.6, Principle 4, and §9 assumes stack unwinding. Two of the most ordinary exits do not unwind, both verified in this repo:

- **A declined confirmation.** `confirmOrExit` calls `process.exit(0)` (`confirm-or-exit.ts:44-47`). `process.exit` skips every `finally`. In a plan → confirm design, declining is a *first-class expected outcome* — so as specified, the single most common non-happy path leaks the scratch worktree every time.
- **SIGINT / SIGTERM.** `entry/cli.ts` installs no signal handler (verified: the only signal handling in the CLI is `entry/dev-server.ts`, which is the `dev` command's own entry, plus `setupErrorHandlers` whose sole caller is the MCP server at `entry/mcp.ts:46`). Node's default action terminates without unwinding.

**Fix, in two parts.**

*(a) Signal guard — **installed on the CLI path only**.* A SIGINT/SIGTERM handler that runs cleanup, emits the partial report, and exits **130** / **143**. There is a precedent to copy rather than invent: `installBootSignalGuard` (`entry/dev-server.ts:301`) already does exactly this shape — `register`/`unregister` seams defaulting to `process.on`/`process.off`, conventional 130/143 exit codes, and removal in a `finally` — and `entry/__tests__/boot-signal-guard.test.ts` shows how to test it with a fake signal bus plus a real-process listener-count assertion. Reuse both the pattern and the test idiom.

**`ghMergeDev` has two callers, and the guard belongs to only one of them.** The precedent above lives at an *entry point*, which owns the process; `ghMergeDev` does not. It is also the MCP tool handler running inside the long-lived server (`entry/mcp.ts`), where a per-invocation `process.on('SIGINT', … process.exit(130))` would preempt the host's shutdown semantics and, on a stray signal, take the whole server down mid-session — project memory records that an MCP tool calling `process.exit` crashes the long-lived server. So:

- **CLI:** `configureMergeDev`'s action wraps the call — `withRunCleanup(() => ghMergeDev(args))` — which installs the guard, and removes it in a `finally`. The exit action stays injectable, but purely as a **test seam** (so the unit test can assert 130/143 without killing the runner), not as a second production mode.
- **MCP:** no guard is installed at all. It is not needed and would be harmful. Ordinary `finally` unwinding already covers this path, because neither of the two non-unwinding exits exists there: `confirmOrExit` is a no-op under MCP (`confirmedCommand: true` is always injected, §3.8), so the decline branch is unreachable, and the server — not the tool — owns signal handling. **Residual, stated rather than hidden:** if the *server* is signalled while a tool call is mid-flight, the scratch worktree survives registered. That is the server's lifecycle to manage, and the next run recovers it with `prune`-and-retry (E8.8) — the same recovery as a SIGKILL.

*(b) Decline path — an opt-in, not a shared behaviour change.* `confirmOrExit` gains an optional `throwOnDecline`, **defaulting to false so every existing caller keeps today's `process.exit(0)` semantics**. `gh-merge-dev` passes `true`, catches the resulting cancellation, runs cleanup, and exits 0. Scoping this deliberately: `confirmOrExit` is used by every mutating command in this CLI, and flipping the default would change exit semantics for all of them inside a phase whose acceptance criteria cover none of them. Project memory also records that `process.exit` placement is load-bearing on the MCP boundary — that path is unaffected here, because MCP always injects `confirmedCommand: true` and never reaches the decline branch (§3.8), but it is a reason not to touch the shared default casually. An opt-in is strictly additive and testable in isolation.

Until both land, §9, Principle 4 and the `(finally)` annotations are aspirational rather than descriptive. Acceptance criterion 4 tests this and **fails against the design without §3.11** — that is the criterion working, not a criterion to soften.

---

## 4. Should this command run `pnpm install` + `pnpm run qa`?

**Recommendation: `--verify` ships tiered, default OFF; bare `--verify` = `pnpm install --frozen-lockfile`; `--verify=qa` = the full configured suite. Pre-push only, block-by-skipping, never roll back. It stays in this command.**

**Where it runs: after the confirmation, on the selected set only, in its own pass.** Iteration 2 said "the worktree already exists and already holds the merge" — true only *during* the plan loop, because after the loop HEAD sits on the last branch's merge and every earlier sha has been checked out away. That wording implicitly placed verification **before** the operator confirms, which would contradict the plan → confirm → apply narrative, make `--dry-run --verify` do the full work of a real run, and pay for N installs on branches the operator never selected — including through the ungated planner. Verification therefore gets its own `checkout --detach <collected-sha>` pass in §3.6, after the confirm and after reclassification, over the selected branches only. That also matches "`--verify` accepts a branch subset" below.

**Why the install tier is the default, not the suite.** The characteristic breakage of a `dev` → release merge in a pnpm monorepo is `pnpm-lock.yaml`: both sides touched it, the text merge is clean, and the result is semantically broken. No merge engine reports anything, because it is not a conflict. `pnpm install --frozen-lockfile` catches that class in a fraction of the time and **cannot flake on timing**. That is the tier an operator will actually leave switched on. Caveat to implement: `--frozen-lockfile` also fails on a legitimately changed lockfile, so the failure message must distinguish "lockfile inconsistent with package.json" from "lockfile would change", or ordinary dependency bumps produce false `verify-failed`s.

**Why the suite is not the default.** It duplicates CI on the same commit the push is about to trigger, and it is gated on `lock.test` and `portless-driver.test`, which flake under full-suite load — a flaky gate turns a determinism command into a coin flip. **ASSUMPTION:** wall-clock unmeasured — running the suite was outside the read-only planning boundary.

**Cost model, corrected to match `clean -fd` (§2.3).** Because cleanup does not remove ignored paths, `node_modules` persists in the scratch worktree across branches: the first verified branch pays a cold install, later ones pay a reconcile. Iteration 2 asserted the opposite ("`node_modules` does not carry cleanly between branches") while specifying `-fd`, which was a contradiction.

**Hermeticity differs by tier, and only one tier is affected.** The `install` tier asks whether `pnpm-lock.yaml` is consistent with the merged `package.json` files — a question answered from the lockfile and manifests in the tree being verified. A neighbouring branch's leftover `node_modules` cannot change that answer, so the cheap default tier is **hermetic**. The `qa` tier executes code against whatever is installed, so branch k+1's suite genuinely runs against a tree branch k installed: that tier is **not** hermetic under `-fd`. Since `qa` is opt-in and already the slow path, this is the right place for the trade to land; `-fdx` remains the follow-up for anyone who wants `qa` hermetic and uniformly cold.

**Never invoke root `qa` by name.** Its first leg is `pnpm run vendor:check`, which shells out to the **globally installed** `infra-kit`, not the one under test; combined with this repo's dead vendor-sync state, `--verify=qa` would go red for reasons unrelated to the merge on its first real run. The `qa` tier invokes a **named, configurable** task set that the repo declares.

**Block, warn, or roll back?** Block-by-skipping. A failed verify means that branch is dropped from the refspec set; the others proceed; the branch reports `verify-failed`. Never roll back — rewinding a shared ref is Principle 2 and pre-mortem 2.2. That is precisely why verification is pre-push.

**Separate command?** No. The artifact verified is the collected merge sha, which exists only inside this run. A standalone `infra-kit verify-merge` would have to recompute the merge and then race it.

`--verify` accepts a branch subset (verifying all N in isolation says nothing about the combination, and usually only the imminent release matters). Any test that gates on a filtered runner's output must use an explicit `; echo EXIT=$?` — a hard requirement, not a suggestion, per this repo's `rtk swallows exit codes` history.

---

## 5. Phased implementation

### Phase 0 — stop the bleeding (D3, D8, `$.quiet`, HEAD parking)

No strategy change. Touches `gh-merge-dev.ts` and `program.ts`.

- Guard the cleanup: `git rev-parse -q --verify MERGE_HEAD` before `git merge --abort`, and wrap the cleanup in its own `try`/`catch` so nothing throws out of the outer `catch`.
- `$.quiet = false` and the starting-branch restore both move into `finally`.
- Add `-v, --versions <versions>` (comma string), filtered against the open **regular** release set, and thread it into `GhMergeDevArgs` + MCP `inputSchema`.

*(Iteration 2 also had a `getReleasePRsWithInfo()` bullet here. Deleted — the bug does not exist; see §8.)*

**Acceptance.** A **per-branch** git failure (mocked mid-loop) yields a structured result with that branch marked failed, the remaining branches still processed, and `git merge --abort` invoked only when `MERGE_HEAD` exists. A **preflight** failure still throws (exit 1) — the iteration-1 criterion said the opposite and would have converted a total preflight failure into exit 0. `infra-kit release merge-dev --versions "1.2.5" --yes` parses; a hotfix version is rejected by name.

### Phase 1 — plan phase behind `--dry-run` only, **with the cleanup contract**

Add `withScratchWorktree` + `planMergeRun` + `renderPlan`, **and §3.11's signal guard + `throwOnDecline`**. `--dry-run` computes and prints the plan and exits. **Without the flag the legacy path is untouched.**

§3.11 is a prerequisite of this phase, not a later polish: this is the phase that first creates a scratch worktree, so it is the phase that first *leaks* one on Ctrl-C. Shipping the worktree without the cleanup would put a stale registration on operators' machines, which §2.3 identifies as breaking the command every subsequent run.

Iteration 1 had Phase 1 ship the plan phase *plus* the legacy apply loop. That is worse than either endpoint: the legacy loop's `git switch dev` (`:98`) fatals on this team's normal worktree layout, so the phase would print a correct six-branch plan and then die before merging anything; and the plan is computed against `origin/*` while the loop merges local branches after `git pull`, so the printed plan describes a different operation than the one executed.

**Acceptance.** §7 criterion 19 (a crashed run does not break `isWorkingTreeClean` for other commands), plus: `--dry-run` on a fixture with one conflicting and one clean branch names the conflicting paths; `git rev-parse refs/heads/…` is byte-identical before and after; `git worktree list` returns to its pre-run set **after a clean exit, after SIGINT, and after a declined confirmation**; without `--dry-run` behaviour is bit-for-bit the Phase 0 command.

### Phase 2 — worktree apply + atomic push becomes the default

Replace the loop with the collected-sha + `push --atomic` path. Delete `git switch` / `git pull`. Swap `assertManagementContext` for `assertRepoWithOrigin`. Re-sequence the picker after the plan. Extend `structuredContent` / `outputSchema` (including the `:48-53` early return). Wire the exit-code contract.

**Acceptance.** §7 criteria 1–12, plus 17 (commit-object fidelity — this is the phase that introduces the detached merge) and 18 (`hook-failed`).

### Phase 3 — `gh-merge-dev-plan` MCP tool and `--verify`

**Acceptance.** §7 criteria 13–16, plus 20 (a teammate push during the verify pass does not abort the run) — `--verify` is what creates that window, so the criterion belongs to the phase that adds it.

### Phase 4 — observability and docs

Report/docs only — `--json` is already wired globally, so iteration 1's "`--json` parity" was over-scoped.

---

## 6. Test plan

### The existing tests

`gh-merge-dev-conflict-cleanup.test.ts` mocks zx's `$` by reconstructing command strings and matching `'git merge origin/dev --no-edit'`. Phase 2 changes the invocation shape, so its premise goes. More importantly the mock is structurally incapable of testing the new design: it encodes our *belief* about git and keeps passing after git changes. **Rewrite, do not patch.**

`gh-merge-dev-mcp-guard.test.ts` does **not** survive as-is — iteration 1 said it did, and that was wrong. It mocks `src/lib/git-guard` with only `{ assertManagementContext: vi.fn() }` (`:39-41`) and asserts it was called (`:109`), so swapping in `assertRepoWithOrigin` breaks the assertion **and** leaves the command calling an `undefined` export. Its TTY/picker discriminator is genuinely valuable and must be preserved through the rewrite.

Keep the zx string mock only for pure-policy tests: flag threading, the MCP guard, and the force-token assertion. Everything about git semantics moves to real temporary repositories — the change *is* a claim about git's behaviour, and every trap found in this plan (the exit-1 collision, the cascade, `merge.ff`, the `update-ref` desync) would sail past a string mock.

### 6.1 Unit

- `--versions` resolution: label and raw-branch forms both resolve; a hotfix branch throws; an unknown token throws naming the valid set.
- **Signal guard** (§3.11): with a fake `register`/`unregister` bus, SIGINT runs cleanup and exits 130, SIGTERM 143; against the real process, exactly one listener is added per signal and removal returns the counts to baseline. Idiom lifted from `entry/__tests__/boot-signal-guard.test.ts`.
- **`throwOnDecline`**: default-false callers still take the `process.exit(0)` path; `gh-merge-dev` passes true and receives a catchable cancellation.
- Status derivation and the reproduction-recipe renderer.
- `commandEcho`: every flag threaded — **`--dry-run` especially**, since an echo omitting it prints a command that *pushes*. Echo built from branch names, not `releaseBranchLabels`.
- Force-token guard: no `git push` invocation contains `--force`, `--force-with-lease`, `-f`, or a `+`-prefixed refspec. Substrate stated explicitly: the zx string mock.

### 6.2 Integration — real temp repos

Shared `makeRemoteFixture()`: bare `origin.git`, a clone, `dev`, N release branches, `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null`.

1. Clean merge → origin advances; local branches untouched.
2. Conflict → nothing pushed for that branch; conflicting paths reported.
3. **Cascade (the most important new test).** Branches ordered clean / conflict / clean: branch 3 must merge successfully. Without the `finally` cleanup this fails with `error: you need to resolve your current index first` (E9.3). Assert branch 3's status is `merged`, not `error`.
4. Pristine assertion: pre-dirty the scratch worktree and confirm the run fails fast rather than cascading.
5. Stale worktree registration (delete the scratch dir behind git's back) → `prune`-and-retry recovers (E8.7 → E8.8).
6. Up-to-date → no checkout, no push.
7. Fast-forward → origin ends at `origin/dev`'s sha.
8. **`merge.ff=false`** → a strictly-behind branch gets a real merge commit (C4); asserts the fidelity the plumbing design silently lost.
9. **Hook divergence** → a `commit-msg` hook runs and its effect appears in the pushed commit (C5).
9b. **Hook failure** → a `commit-msg` hook exiting nonzero yields status `hook-failed`, not `error`, and does not stop other branches.
10. **Commit object fidelity** → subject, body, author and committer all match a control `git merge` performed on the branch itself. The subject assertion is what pins the `-m` decision (E10.1 vs E10.4): without it, a detached merge silently writes `… into HEAD`, and a future git format change goes unnoticed.
11. **Atomic all-or-nothing** → one non-FF ref among three leaves all three unchanged on origin (C2b), and the control without `--atomic` lands two of three (C2c).
12. Concurrent teammate merge → reclassified `up-to-date` and dropped from the refspec set, **not** reported as failed.
13. Branch deleted on origin between selection and plan → `error` for that branch only, no fatal (guards E6's `is-ancestor` 128), **and** the run still completes for the others — which is what anchoring the scratch worktree on `origin/dev` buys (§3.4).
14. `--versions` naming a hotfix branch → preflight throw.
15. **Cleanup on the non-unwinding paths** → after a declined confirmation and after SIGINT, `git worktree list` is back to its pre-run set and a partial report was emitted. Fails without §3.11.
16. Two concurrent runs → distinct scratch paths, neither disturbs the other.
17. Scratch worktree location → a crashed run leaves `isWorkingTreeClean` true in the main checkout, so `assertManagementContext` still passes for other commands (§3.4).

### 6.3 E2E

- `--dry-run`: `refs/heads/*` byte-identical, `git worktree list` restored, `successfulMerges === 0`.
- `gh-merge-dev-plan` MCP tool returns a plan **without** `confirm: true` and pushes nothing; `gh-merge-dev` still gates.
- `--verify` failing → branch dropped from the refspec set, scratch worktree removed, and its ref **observed** unchanged via `git ls-remote` rather than assumed (§3.6).
- Every filtered-runner gate uses `; echo EXIT=$?`.

### 6.4 Observability

- One structured log line per branch: `{ branch, status, mergeSha, conflictCount, durationMs, pushed }`.
- The plan prints before the confirm and again in the final report.
- Per-branch **reproduction recipe** in the report — the exact `git -C <path> merge origin/dev` an operator can run. Iteration 1's blanket `git switch … && git pull …` script is wrong advice for a worktree-occupied branch, i.e. the common case.
- Before the confirm, state how many open PRs will re-run CI (§8, Consequences).

---

## 7. Testable acceptance criteria

1. With `dev` checked out in a linked worktree, a full run completes and pushes every non-conflicting selected branch. (Today: exit 128, `fatal: 'dev' is already used by worktree at …` — E5.1.)
2. With every selected release branch checked out in a linked worktree, same.
3. With uncommitted changes in the main checkout, the run completes.
4. **After an induced mid-run throw, after SIGINT, and after a declined confirmation**, `git rev-parse --abbrev-ref HEAD` in the main checkout is unchanged and no scratch worktree remains in `git worktree list`. The decline case is the one that fails against a design without §3.11, and it is the most ordinary of the three. *(Iteration 1's "HEAD unchanged after any run" was a vacuous green — nothing moves HEAD under this design — and its "or failure" half was untestable for SIGKILL.)*
5. `--dry-run` leaves every `refs/heads/*` byte-identical and `git worktree list` at its pre-run set. Objects and `refs/remotes/*` are explicitly **out of scope** — the plan writes both by design (§3.4).
6. No git command emitted contains `--force`, `--force-with-lease`, `-f`, or a `+`-prefixed refspec. Substrate: the zx string mock.
7. A conflict on branch k leaves branches k+1…N unaffected — each reaches its own correct terminal state.
8. `results[]` has exactly one entry per selected branch, every entry carrying a `reproduce` string that, run verbatim in a fixture, produces the same tree.
9. One non-fast-forwardable ref leaves **all** refs unchanged on origin, and the report names the ref that aborted the push.
10. A branch a teammate already merged is reported `up-to-date`, not `failed`, and is absent from the refspec set.
11. With `merge.ff=false`, a strictly-behind branch receives a real merge commit (`rev-list --parents -n1` shows two parents).
12. Exit code: 0 when every selected branch reaches its desired terminal state; 1 when any does not; 1 on preflight failure.
13. `dryRun` ⇒ `successfulMerges === 0` and every `results[].pushed === false`, on both the MCP and `--json` surfaces.
14. `gh-merge-dev-plan` returns a plan **without** `confirm: true` and performs no push; `gh-merge-dev` without `confirm: true` still returns the gate.
15. `--versions` cannot select a branch whose PR title is not a regular release; the attempt throws and names the valid set.
16. Echo round trip, stated purely: `labels(selected)` → Commander parse → resolved branch set `=== selected`. *(Iteration 1's version asserted a live re-run selects the same branches, which is false in general because `releaseBranchLabels`' `flatMap` drops non-parsing branches.)*
17. The merge commit's subject, body, author and committer are byte-identical to a control `git merge origin/dev` run on the branch itself — i.e. no commit says `into HEAD`.
18. A failing merge/commit hook yields `hook-failed` for that branch alone, distinguishable in `results[]` from `error`.
19. A crashed run leaves the main checkout's `isWorkingTreeClean` true, so every other release/worktree command in the CLI still runs.
20. A teammate push landing **during the verify pass** does not abort the run: the second `reclassify()` drops that branch, and the remaining branches still push atomically. Fails against an ordering with only one reclassification.
21. Under MCP, invoking `gh-merge-dev` installs **no** process-level signal listener (`process.listenerCount('SIGINT')` unchanged across the call); under the CLI path exactly one is added and removed.

---

## 8. ADR — real `git merge` in one reused detached worktree, with an atomic push

**Status:** proposed (iteration 3.1; supersedes iteration 1's checkout-free-plumbing decision).

**Decision.** Perform every merge with real `git merge -m "Merge remote-tracking branch 'origin/dev' into <B>"` inside a single per-run detached scratch worktree, collecting merge shas without pushing; present the plan; and on confirmation push all of them in one non-forced `git push --atomic`. No `merge-tree`, no `commit-tree`, no capability probe, no strategy switch, no anchor refs.

**Drivers.** Determinism; coexistence with the team's per-release worktrees; merge fidelity and operator reproducibility.

**Alternatives considered.** *(A) Merging in the operator's existing worktrees* — mutates a colleague's checkout, is blocked by their dirt (E5.2), strands their worktree in `MERGING`. *(B) Checkout-free plumbing* — iteration 1's recommendation, reversed: its fidelity guarantee was an open-world whitelist measured short by three (C1 rerere-via-`rr-cache`, C4 `merge.ff` with **no** signal, C5 hooks), and its merge commits cannot be reproduced by any command the operator knows. *(D) B-plans-C-applies* — the only option whose preflight can disagree with the shipped artifact (C1 is that disagreement).

**Why chosen.** Using the same engine for the plan and the apply makes Driver 3 true *for merge content* by construction rather than by enumeration, and makes the operator's reproduction exact. `--atomic` is measured all-or-nothing (C2b) and advertised by GitHub (C3), which turns the half-applied run from *reported* into *impossible*. The cost — cross-branch coupling — is measured (E9.3), bounded, and fixed by a cleanup that this plan already specifies for Phase 0.

**Consequences — including the bad ones.**
- **New failure class: cross-branch state coupling.** An unaborted conflict breaks every later branch (E9.3). Mitigated by cleanup-in-`finally` plus a pristine assertion, but it is a real risk that Option B did not have and it is now pre-mortem 2.3.
- **The command owns a scratch worktree.** Disk, a `git worktree list` entry, and a crash can leave it registered (E8.7). Recovery is `prune`-and-retry (E8.8); the path is per-run unique and lives outside every working tree (§3.4, E8.9).
- **Two concurrent runs on one machine are no longer trivially safe.** Option B held no local state; this design does. Handled by the unique path, but it is a property that was free and is now engineered.
- **Driver 3 is met for merge *content*, not automatically for the commit *object*.** The design's own detached HEAD writes `… into HEAD` (E10.1); `-m` restores parity (E10.2) at the cost of freezing git's message format. One measured divergence, closed by one flag and pinned by criterion 17 — but it is not "free by construction", and iteration 2 claimed it was.
- **The repo's merge and commit hooks run once per candidate branch, before consent** — arbitrary user code, on branches the operator may never select, reachable through the ungated `gh-merge-dev-plan` tool. This is the direct cost of making the plan and the apply the same operation.
- **Hooks can also fail where the operator's own merge succeeds.** A `commit-msg` hook shelling to `npx commitlint` needs `node_modules`, and the scratch worktree starts cold — a false failure produced *by* the fidelity win, symmetrical to the false conflict that killed Option B. Contained by the distinct `hook-failed` status so it is attributable rather than filed as a generic `error`, and by `clean -fd` keeping `node_modules` after the first install.
- **The dry run is no longer cheap.** Under Option B a `--dry-run` was pure object-database work; here it is N full working-tree checkouts of a monorepo plus a worktree add/remove — and it is reachable through an ungated, agent-callable tool. `gh-merge-dev-plan` honours `versions` so an agent can bound the work.
- `--atomic` means one genuinely diverged branch blocks the whole run. Reclassification (§3.6, run both before and after the verify pass) removes the common cause; the residual case is reported with the offending ref named and the operator told to re-run — not handed a list of shas whose reachability the same `finally` is about to destroy.
- **Local release worktrees are converged, by fast-forward, as mandatory default behaviour (§10).** This reverses iteration 2's "`--update-local` is cut, the skew is only reported" and it rewrites Principle 3. The command now writes into checkouts it did not create — a real widening of blast radius, accepted because the write is a fast-forward *after* the push, which is measured to be unable to conflict, unable to create a commit, unable to strand `MERGING`, and unable to destroy uncommitted work (E11.1–E11.7). The residue that remains genuinely new: files change under whatever editor or dev server is watching that worktree, and the repo's `post-merge` hook runs there (E12.1). Both are exactly what the operator's own `git pull --ff-only` would do.
- Local branches with **no** worktree, and local `dev`, are still not advanced (§10.5) — the first because there is no working copy for the staleness to be visible in, the second because this command never pushes `dev` and therefore never made it stale.
- Every push re-triggers CI on that branch's open PR — an `--all` run fires N CI runs, simultaneously under `--atomic`. If the repo enables "dismiss stale pull request approvals when new commits are pushed", **every release PR loses its approvals.** The report must state the PR count before the confirm.
- `structuredContent` reports **git** truth, not **PR** truth: a branch can report `merged` while its PR goes red seconds later.
- This repo currently has **zero open release PRs**, so every acceptance criterion is fixture-only and nobody should later claim an end-to-end verification against live GitHub state here. The mechanism matters and iteration 2 stated it wrongly: with zero release PRs `loadSortedReleasePRs` **throws** (`gh-release-prs.ts:83-88`, operation `find open release PRs`) and the command exits 1 — it does not reach the `:48-53` "no open release branches" early return. That early return is reachable only when open release PRs exist and **none of them is a regular release** (all hotfixes), which is why Phase 2 must preserve it. Iteration 2 additionally specified a `getReleasePRsWithInfo()` "silent success with zero branches" fix; **that bug does not exist** — `loadSortedReleasePRs` (`:79-98`) already rethrows failures as `OperationError` — and the change is reverted. Distinguishing "call failed" from "zero results" is not implementable locally anyway: the conflation is inside a shared integration whose second consumer is `worktrees-sync.ts:46`.
- The `git >= 2.38` floor from iteration 1 is **gone** — no `merge-tree --write-tree`, and `-m` was chosen over `--into-name` precisely to avoid reinstating a 2.40 floor. `git push --atomic` needs git ≥ 1.8.5 and a server advertising `atomic`; GitHub does (C3). **ASSUMPTION:** other remotes untested.

**Follow-ups.** Reconsider `--update-local` as an explicit narrow exception to Principle 3. Adopt `--into-name` if a git floor becomes acceptable for other reasons. Consider `clean -fdx` if hermetic verification is wanted. Report rather than silently drop PRs whose head ref fails `parseBranchName` (`gh-release-prs.ts:32-46`) — narrow, since `KEBAB_RE`/`BRANCH_SEMVER_RE` accept everything `release-create` produces. Consider sharing `merge-run` with `release deliver`. Consider splitting Phase 2, which now carries criteria 1–12.

---

## 9. Rollback / safety story

**Before the confirm.** Nothing on any remote or any `refs/heads/*` has been touched. Ctrl-C and declining are both safe *because of §3.11*, not because of `finally` alone: the signal guard and the `throwOnDecline` unwind are what remove the scratch worktree and emit the partial report on those paths. If the process is killed hard (SIGKILL), the worktree survives registered and the next run recovers it with `prune`-and-retry (E8.8) — and its reflog still holds any collected shas (E10.5).

**At the push.** All-or-nothing **for refs** (C2b): either every selected branch advanced or none did. That is not the same as no partial state for the *operator* — a lost response or a kill between the push returning and the report printing leaves origin fully advanced while the transcript says "aborted". So the refspec set is printed before the push, and any failure path re-checks with `git ls-remote` and reports observed origin state rather than inferring it (§3.6). On a genuine abort the report names the ref responsible; the operator re-runs, and reclassification (§3.6) drops whatever a teammate merged in the meantime.

**After a successful push.** Re-running is idempotent: already-merged branches classify `up-to-date` via `merge-base --is-ancestor` (E3.6) and are skipped. Note the honest limit: idempotence assumes the classification is right — a branch misreported as conflicting stays misreported on every re-run, which is why the report carries a per-branch reproduction recipe so the operator can check the tool against git directly.

**If a merge should not have been pushed.** Do **not** rewind. `git revert -m 1 <mergeSha>` through the normal review path. This command will never rewind and will never offer to.

**If `--verify` failed for a branch.** Nothing was pushed for it — verification is pre-push, and the branch was dropped from the refspec set before the push was assembled.

---

## 10. Amendment (iteration 4) — local release worktrees converge by fast-forward, as default behaviour

**Status: pending approval.** This amends the plan it lives in; it does not replace it. Where it contradicts an earlier section, the earlier section has been edited in place: Principle 3 (§1), §3.7, and two ADR consequences (§8).

**Directive.** After `gh-merge-dev` pushes, the operator's local release worktrees must carry the merge. This is default, mandatory, flagless behaviour — a user decision, not a proposal. No opt-in, and `--update-local` is not reintroduced under a new name.

### 10.1 Principle 3 had to be rewritten, and here is why the reconciliation is real

Iterations 1–3 rejected Option A and cut `--update-local` citing Principle 3, *"no checkout that already exists is a resource this command consumes."* Making writes-into-existing-checkouts the default contradicts that sentence outright. Widening it quietly would be dishonest, so it is rewritten in §1 and defended here.

Two concessions the earlier iterations got wrong, and which I accept:

- **The "colleague's checkout" framing was overstated.** `worktrees-add` creates worktrees on the operator's own machine. These are one person's parallel workspaces. The blast radius is real but it is the operator's own — not a teammate's, as §1 Option A's cons implied.
- **The user's preconditions genuinely dissolve two recorded objections.** "Blocked by their dirt" and "stale local branch → unpushable merge commit" both assume an operator who has not checked. Someone who checks clean-and-pushed does not hit either.

The reconciliation offered was that Option A wrote into a checkout to perform a *merge*, whereas this writes only a *fast-forward* after the merge already landed on origin. **I tested that claim rather than assuming it, and it holds — on six measured counts** (E11, all in real repos):

| Option A (merge in the operator's worktree) | §10 (fast-forward after the push) |
|---|---|
| Can conflict, leaving `UU` paths (E5.3) | **Cannot conflict** — it checks out an already-computed ancestor tree (E11.1) |
| Can strand the worktree in `MERGING` for its owner to discover | **No merge is performed; there is no `MERGE_HEAD` to leave**, and a refusal leaves no residue of ours at all (E13.4) |
| Runs *into* whatever state the worktree is in | **Refuses outright if the operator has their own merge or rebase in flight**, leaving `MERGE_HEAD` / the rebase directory untouched (E13.2, E13.3) |
| Can create a commit that then fails to push (E5.4/E5.5) | **Creates no commit at all** |
| Blocked by *any* dirt in the way | **Succeeds with unrelated dirt, preserving it** (E11.3) |
| — | **Fails closed on every precondition violation**, preserving the operator's work: tracked-file collision → exit 1 (E11.4); untracked-file collision → exit 1 (E11.5); diverged branch → exit 128 (E11.6, E11.7) |
| — | **Idempotent**: re-run is `Already up to date.`, exit 0 (E11.2) |

It is also measured to be immune to the trap that killed `--update-local`: `git update-ref` advances a worktree-held branch and leaves its owner staring at phantom staged deletions (E4.8), while `git branch -f` (E4.9) and `git fetch origin <b>:<b>` (E4.10) simply refuse. `merge --ff-only` run *inside* the worktree moves `HEAD`, index and working tree together — `git status` is empty afterwards (E11.1). That is the whole reason the mechanism is a merge command rather than a ref write.

**What is genuinely new, and is not explained away:** files change under whatever editor, watcher, or dev server is pointed at that worktree, and the repo's `post-merge` hook executes there with the worktree as cwd (E12.1 — measured, and absent from the brief). Both are precisely what the operator's own `git pull --ff-only` would do, which is the point: the command now finishes the job instead of printing a command and leaving it half-done.

### 10.2 Decision drivers (ranked)

1. **The operator's workspace must reflect the truth that was just pushed.** The user's directive, and the reason the feature exists.
2. **Uncommitted work is sacred.** No path may overwrite or discard it. This outranks convergence: a worktree that cannot be converged safely must be left exactly as it was.
3. **A convergence failure must never turn a successful push into a failed run.** The push is irreversible; the convergence is a courtesy on top of it.

### 10.3 Options

**F1 — `git merge --ff-only origin/<B>` inside each matching worktree, after the push. ← RECOMMENDED.** One merge engine (the scratch worktree) still produces every commit; this only moves existing checkouts onto commits that are already on origin.
*Pros:* measured fail-closed on all three failure classes; idempotent; preserves unrelated dirt; end state byte-identical to what the operator's own `git pull --ff-only` produces; no second engine.
*Cons:* touches checkouts the command did not create; runs `post-merge` hooks there; N extra git invocations.
*When wrong:* if release worktrees were shared or remote. They are neither.

**F2 — ref-only advance (`git branch -f` / `git fetch origin <b>:<b>` / `update-ref`).** *Dead on measurement, not on taste.* The first two refuse a worktree-held branch (E4.9, E4.10) and every release branch here is worktree-held; the third succeeds and silently corrupts the worktree's view (E4.8). F2 cannot serve the exact case the feature exists for.

**F3 — merge directly in the operator's worktree as the engine (true Option A).** The user's original challenge, argued fairly now that the concessions above are accepted. *Pros:* one fewer worktree, warm `node_modules`, no scratch machinery. *Cons, and these are what still kill it:* it is a **second engine covering only a subset** — branches with no worktree, with a dirty worktree, or sitting at a different commit still need the general path, so both paths must exist and both must be tested; its preconditions are checks that can pass and then stop being true between check and act; and a conflict strands the operator's own workspace mid-merge, which is the failure class this whole plan was written to remove. F1 keeps every benefit of A's *end state* without adopting A's *risk class*.

**F4 — status quo: print the command, let the operator run it.** Refused by direct directive, and it is the behaviour the user rejected.

**F5 — `git pull --ff-only` per worktree.** Behaviourally equivalent to F1 but issues a network fetch per worktree. Redundant: our own push already updated `refs/remotes/origin/<B>` (E3.1). Listed only so the reader knows it was considered.

### 10.4 Pre-mortem

**10.4.1 The overwritten afternoon.** *Mechanism:* the convergence step discards an operator's uncommitted work — a `-f`, a `reset --hard`, or a `checkout -f` added later "to make convergence more reliable". *Blast radius:* unrecoverable loss of work that was never committed anywhere; a single occurrence permanently ends trust in a command that runs daily. *Prevented by:* Driver 2 made mechanical — the convergence step's entire vocabulary is `git merge --ff-only`, and a unit test asserts no invocation in this code path contains `-f`, `--force`, `reset`, `checkout`, `clean`, or `stash`. Git's own refusals (E11.4, E11.5) are the safety net, and they are load-bearing rather than incidental.

**10.4.2 The successful push reported as a failure.** *Mechanism:* a dirty worktree — routine, not exceptional — makes the fast-forward fail; that failure flows into `failedBranches` or flips the exit code. The operator sees "failed", re-runs, and the second run reports every branch `up-to-date`, which reads as "nothing happened". *Blast radius:* the command that exists to be trusted starts lying about irreversible work it completed successfully; worse, a CI or scripted caller gates on the non-zero exit. *Prevented by:* convergence outcomes live in their own `worktreeSync` block, never in `failedBranches`, and §3.10's exit-code contract is explicitly unchanged by them (criterion 26).

**10.4.3 The detached-worktree drive-by.** *Mechanism:* enumeration matches on "a worktree exists for this repo" rather than on the branch, and a detached worktree — someone mid-bisect, or a leftover scratch checkout — gets fast-forwarded. **Measured: a detached worktree does fast-forward silently (E11.8)**, moving `HEAD` to the release tip and destroying the bisect state. *Blast radius:* the operator's unrelated investigation is silently ruined, with nothing in the report explaining it. *Prevented by:* matching on `entry.branch === <pushed branch>` exactly, using `listWorktrees`' porcelain parse, and skipping every `detached`, `bare`, `prunable` or `locked` entry by name. This scenario is the reason enumeration is specified as a branch match rather than a path lookup.

### 10.5 Design

**Ordering.** Strictly after `pushAtomic` returns success. An aborted or rejected push converges nothing — there is nothing on origin to converge to. No extra fetch is needed: the push itself updates `refs/remotes/origin/<B>` (E3.1). **The scratch worktree is removed before convergence begins**, not in the enclosing `finally` — see the scratch-worktree note below.

**Enumeration is over the SELECTED branch set, not the pushed set.** This is the correction that matters most. §3.6's reclassification drops a branch a teammate merged mid-run from the refspecs and reports it `up-to-date` — but that branch's `origin/<B>` **is** ahead of the operator's worktree, so under the pushed-set reading the directive goes unmet on precisely the routine case the mandatory reclassification exists to catch, while the report says `up-to-date` and the operator reads "nothing to do". Convergence is idempotent (E11.2), so widening the enumeration costs one `merge --ff-only` per extra branch and returns an honest `already-current`. It also picks up branches classified `up-to-date` at plan time whose worktrees were behind for unrelated reasons.

`listWorktrees(mainRepoRoot)` (already implemented, porcelain-parsed). For each selected branch `B`, take entries where `entry.branch === B` — a short-name match, which the parser guarantees by stripping `refs/heads/` (`git-utils.ts:64-66`). Skip and report: `detached` (E11.8 — it would move), `bare`, `prunable`, `locked` (may be on absent media), and any branch with more than one entry (above).

**The scratch worktree is excluded by two independent guards, and the earlier claim that it was excluded by ordering was false.** Iteration 1 of this amendment said it "is removed before this step" — but against §3.6 the removal sits in a `finally` while convergence is the last statement of the try, so the scratch worktree was in fact *live and enumerated* during convergence, protected by the `detached` filter alone. Since §10.4.3 measures that detached worktrees **do** fast-forward (E11.8), the command's own worktree was one relaxed filter from being converged onto a release branch. Fixed both ways: the removal moves ahead of convergence, **and** `$SCRATCH` is skipped by path name regardless. Two guards, and neither is the sentence that was wrong.

**Convergence order: the worktree the operator is currently in goes last.** Promoted from follow-up prose to design, because it costs one sort and removes the worst instance of the watcher assumption below — the operator's own terminal rebuilding underneath them while the run is still printing. Determined by comparing each entry's path against `process.cwd()`'s worktree; on no match the order is unchanged.

**Dirty handling: attempt-and-report, not probe-first.** This is an evidence-driven choice. A `isWorkingTreeClean` probe would refuse a worktree with unrelated dirt — which git converges perfectly well (E11.3) — so the probe would be *stricter than git* and would skip worktrees that had no problem. It would also be TOCTOU. Instead, invoke and classify:

**The classifier reads git's state, never git's prose.** Attempt-and-report is unchanged — probe-first is TOCTOU and stricter than git (F1/E11.3). What changes is *how the refusal is classified*: after `merge --ff-only` has declined to change anything, the outcome is derived entirely from structural queries, in this order.

| Probe (in order, first match wins) | Status |
|---|---|
| exit 0 **and** `HEAD == origin/<B>` **and** `status --porcelain` unchanged | `already-current` |
| exit 0 **and** either check fails | **`desynced`** |
| exit 0 otherwise (ref advanced, tree consistent) | `fast-forwarded` |
| `rebase-merge` or `rebase-apply` directory exists | `skipped-operation-in-progress` |
| `MERGE_HEAD` / `CHERRY_PICK_HEAD` / `REVERT_HEAD` verifies | `skipped-operation-in-progress` |
| `merge-base --is-ancestor HEAD origin/<B>` exits non-zero | `skipped-diverged` |
| `diff --name-only HEAD origin/<B>` ∩ `status --porcelain`, any entry with code `??` | `skipped-untracked-collision` |
| same intersection, non-empty without `??` | `skipped-dirty` |
| nothing matched | `skipped-error` (**loud** — see below) |

Measured end-to-end (E15.1–E15.6): all six refusal cases classify correctly, and **E15.1 re-run under `LC_ALL=de_DE.UTF-8` produces an identical result** — which is the point.

**Why this replaces the `LC_ALL=C` message table I specified in amendment iteration 2.** That fix was sound but strictly weaker. Structural classification is:
- **locale-immune** — not "immune once we remember the env var on every call site", immune by construction;
- **git-version-immune** — wording changes between releases; `MERGE_HEAD` existing does not;
- **more informative** — the intersection yields the **actual colliding paths**, so the report can say *"uncommitted changes to `src/app.ts` would be overwritten"* instead of quoting a sentence that already contains the paths in a form we would have to scrape.

It also matches the in-repo precedent exactly: `classifyMergeFailure` (`merge-run.ts:64-76`) keys on `git diff --diff-filter=U` returning paths, not on text. `hasMergeInProgress` (`scratch-worktree.ts:50-58`) already exists and is the `MERGE_HEAD` half of row 5 — reuse it, extended to the cherry-pick/revert heads and the two rebase directories.

**Implementation trap, measured (E15.8):** `git rev-parse --git-path rebase-merge` returns a **relative** path in the main checkout (`.git/rebase-merge`) and an **absolute** one in a linked worktree. Resolve the result against the worktree's own path, not against `process.cwd()`, or the main-checkout case silently tests the wrong directory and reports `skipped-diverged` for a worktree that is mid-rebase.

**git's stderr is still captured — as `reason` only, never as the discriminator.** It is the operator's actionable detail and it is quoted verbatim; nothing branches on it.

> **`LC_ALL=C` still applies elsewhere.** §3.4's merge classification retains one message-based branch (`hook-failed`) because no structural signal distinguishes a hook failure from a generic one, and that branch is already shipped as `/hook/i.test(reason)` at `merge-run.ts:73` — a live locale bug today (E14.5: `Bereits aktuell.` / `Déjà à jour.`, 20 locales installed). Force `LC_ALL=C` there. §10 needs no such caveat because it has no message-based branch left.

Three notes, each from a measurement rather than a guess:

- `skipped-untracked-collision` is separate because it is invisible to a clean-tree probe and easy to hit — an operator with a scratch file whose name matches an incoming one (E11.5).
- `skipped-diverged` covers the realistic case of an operator who already merged `dev` themselves (E11.7).
- **`skipped-operation-in-progress` exists because the two exit-128 cases are not the same case.** A worktree with its own conflicted merge *or* rebase in progress refuses with `error: Merging is not possible because you have unmerged files` / `fatal: Exiting because of an unresolved conflict` — **not** the diverging-branches message — and both leave `HEAD`, `MERGE_HEAD` and the rebase directory exactly as the operator left them (E13.2, E13.3). Classifying exit 128 by code alone would file "you are mid-rebase" as `skipped-diverged` and tell the operator to reconcile a divergence that does not exist. *(Amendment iteration 2 first resolved this by matching the message; that is superseded — the two cases are separated **structurally**, by the presence of a rebase directory or an in-progress head, which is why the classifier reads no prose at all.)*

**A fast-forward that would *delete* a locally-modified file is not a special case.** Measured (E13.1): it refuses with exit 1 and the same `Your local changes … would be overwritten` message, `HEAD` unmoved, the file still on disk with the edit intact — i.e. it lands in `skipped-dirty` and needs no extra handling. The control (E13.1b) confirms the deletion does happen once the file is clean. This was an open question in the evidence brief; it is now closed and it required no design change.

**A refusal leaves nothing of ours behind.** After every refusal class above, there is no `MERGE_HEAD` and no rebase directory attributable to this command (E13.4) — so there is no cleanup step, and none is specified.

**`already-current` can be a lie, so it is verified rather than believed.** Measured (E14.2): with the branch ref already at `origin/<B>` but the worktree's index and tree stale, `merge --ff-only` prints `Already up to date.` at **exit 0** and changes nothing — leaving `M f.txt` / `D g.txt` staged-phantom state and the incoming file absent from disk. §10.1's claim needs the corresponding precision: `merge --ff-only` cannot **create** the E4.8 desync, but it does not **repair** it, and left unchecked it files it as a success row while criterion 22 passes ref-wise on a wrong tree. The detector is structural and cheap (E14.3): `HEAD == origin/<B>` **and** `status --porcelain` unchanged from the pre-run snapshot the design already takes for criterion 23. Failing either, report **`desynced`** — an honest "your worktree's ref moved but its files did not", with the remedy (`git -C <path> checkout -- .` or a hard reset the operator chooses) rather than a claim of convergence.

**Two worktrees on one branch: skip both.** Git refuses this normally, but `git worktree add --force` permits it — measured (E14.4): the plain add fatals with `already used by worktree at`, `--force` succeeds and two porcelain records then carry `branch refs/heads/release/v1`. Converging either one advances the shared ref and drops the other straight into the `desynced` state above. So enumeration detects duplicate `entry.branch` values and skips **every** entry for that branch as `skipped-duplicate-worktree`, naming all the paths. Converging one and reporting success would actively damage the other.

**`skipped-error` is loud.** It is the catch-all for disk-full, an unreadable or unmounted-but-not-`locked` worktree, and anything git says that this table does not model. It logs at **warn** level, gets its own count in the final summary — distinct from the expected skips, which are routine and not warnings — and is asserted distinguishable in `results[]` by criterion 33. The exit-code contract still does not move (§10.5 failure policy); a silent catch-all is the thing to avoid, not a non-zero exit.

**Local `dev` is out of scope**, and the brief's framing needs one correction: this command never pushes `dev`, so it does not make local `dev` stale. A stale local `dev` is pre-existing staleness that our `git fetch` merely reveals. Converging it would mean fixing something we did not break, on a branch we did not touch, outside the user's stated requirement. Reported as informational when `origin/dev` is ahead; not acted on.

**Local release branches with no worktree are out of scope.** There is no working copy for the staleness to be visible in, so the skew is harmless; and advancing them is exactly the `--update-local` shape that was cut. Reported, not acted on. Follow-up noted: `worktrees add` on such a branch would create a worktree at the stale tip — `worktrees sync` is the existing answer.

**Failure policy.** A convergence failure is a report line. It never enters `failedBranches`, never sets `process.exitCode`, never throws. The push already landed and is irreversible; refusing to report success for work that succeeded would be the worse error.

**Idempotency.** Guaranteed by the mechanism: a second run's convergence is `Already up to date.` at exit 0 (E11.2).

**Concurrency.** A dev server or editor watching that worktree sees files change. That is the intended effect, not a hazard to mitigate — it is what `git pull` does. `infra-kit dev --watch` will rebuild, which is the desired outcome. No mitigation is warranted; the report names each converged path so the change is never mysterious.

**Hooks: `post-merge` is per-worktree, is paid N times, and cannot corrupt the result.** Three separate points, and iteration 1 overstated the first. A **relative** `core.hooksPath` — `.husky`, the common real-world setting — resolves against the *working-tree root*, so each converged worktree runs **its own** copy of the hook, which for a stale release branch is an older script than the operator would expect; and a worktree whose checkout lacks the directory runs nothing at all, silently, at rc 0 (A8). So "the repo's `post-merge` hook executes there" (§10.1, §8) is precise only for absolute or `$GIT_DIR`-resolved hooks. **Cost:** N converged worktrees means N `post-merge` runs, serially, immediately after the push the operator is already waiting on — and in a husky monorepo `post-merge` commonly runs `pnpm install`, so a five-worktree `--all` run can trigger five installs. **Good property worth claiming:** git ignores `post-merge`'s exit status, so a failing hook cannot corrupt the classification or the convergence outcome.

**Submodules are out of scope.** `merge --ff-only` updates the gitlink but does not check out the submodule working tree unless `submodule.recurse=true`, so for anyone who sets that, the "identical to your own `git pull --ff-only`" equivalence has this one exception. Neither this repo nor the consumers use submodules; stated so the equivalence claim is not read as unqualified.

**Two adjacent cases that need no handling, stated so nobody re-opens them.** *Sparse checkout:* git applies the fast-forward within the cone itself, so a sparse worktree converges correctly with no new status. *Case-insensitive volumes* (the macOS default): an incoming file colliding case-insensitively with an untracked one is already `skipped-untracked-collision` — the same class, detected by the same path intersection, no special casing.

**ASSUMPTION — not measured, and it is the one most likely to bite in practice.** Whether a running watcher copes gracefully with a multi-file fast-forward is a real-world question, not a git one, and this plan does not answer it. What can be said: a fast-forward writes the same bytes `git pull --ff-only` writes, so nothing in a watcher's *input domain* is new, and `infra-kit dev --watch` rebuilding a dependency closure on change is the intended reaction. **What is genuinely different, and eliding it would be dishonest:** a manual `git pull` is operator-initiated at a moment they chose, whereas this fires unbidden at the end of a command they ran for a different reason. That is the actual delta — not novel file churn, but unchosen timing. It is still not a reason to gate a mandatory directive on an annoyance, and the convergence-order rule above removes its worst instance. Answer it by using the feature, not by more git measurement.

**`--verify` interaction — the warm-`node_modules` benefit is forfeited, deliberately.** It was the one genuine advantage of Option A. Capturing it would mean verifying *in* the operator's worktree, which requires checking the merge out there **before** the push — Option A's risk class, and the thing §10.1's whole argument depends on not doing. Verification stays in the scratch worktree (§3.6, §4). Stated plainly rather than left for a reviewer to notice.

**`--dry-run` converges nothing**, because nothing was pushed. Same for the ungated `gh-merge-dev-plan` tool (§3.8) — which matters, since that tool is agent-callable without confirmation and must not write into the operator's checkouts.

**MCP.** No new flag, so `inputSchema` is unchanged; only `outputSchema` extends. The step is non-interactive, so the no-TTY surface is unaffected. Worktrees are enumerated from the git common dir, which is correct regardless of the server's cwd within the repo.

### 10.6 `structuredContent` — additive

```ts
worktreeSync: Array<{
  branch: string
  worktreePath: string
  status: 'fast-forwarded' | 'already-current' | 'desynced' | 'skipped-dirty'
        | 'skipped-untracked-collision' | 'skipped-operation-in-progress'
        | 'skipped-diverged' | 'skipped-duplicate-worktree' | 'skipped-error'
  reason?: string        // git's own stderr (LC_ALL=C), trimmed — the operator's actionable detail
}>
```

Nothing existing changes. Empty array on `--dry-run` and on an aborted push. `desynced` and `skipped-duplicate-worktree` are new in amendment iteration 2; `skipped-error` additionally carries its own count in the summary.

**Report lines** (§6.4): one per entry — `release/v1.2.5 → fast-forwarded (…/wt/release/v1.2.5)`, `release/v1.2.6 → skipped: uncommitted changes to src/app.ts would be overwritten`, `release/v1.2.7 → already current`, `release/v1.2.8 → no local worktree`. Each skip line carries the one-liner to finish by hand.

### 10.7 Test plan

**Unit** — status classification from recorded real `merge --ff-only` outputs, one case per row of the §10.5 table, including both exit-1 variants (they differ only in stderr); the forbidden-verb assertion from pre-mortem 10.4.1; enumeration filtering (detached/bare/prunable/locked excluded, main checkout included, branch matched exactly).

**Integration** — real temp repos, copying the fixture builder at `src/lib/git-utils/__tests__/scratch-worktree.test.ts` (bare origin + clone + `dev` + release branches, `GIT_CONFIG_GLOBAL=/dev/null`):
1. Clean worktree → fast-forwarded; `git status` in it is **empty** afterwards (the E4.8 contrast — this is the test that proves the desync trap is avoided).
2. Unrelated dirt → fast-forwarded, dirt still present.
3. Tracked-file collision → `skipped-dirty`, HEAD unmoved, file contents byte-identical.
4. Untracked-file collision → `skipped-untracked-collision`, file contents byte-identical.
5. Diverged (local unpushed commit) → `skipped-diverged`, local commit still `HEAD`.
5b. Worktree with its own conflicted **merge** in progress → `skipped-operation-in-progress`, `MERGE_HEAD` still present and unchanged. Fails against a classifier that keys on exit 128 alone (it would say `skipped-diverged`).
5c. Worktree with its own conflicted **rebase** in progress → same status, rebase directory intact.
5d. Fast-forward that would **delete** a locally-modified file → `skipped-dirty`, file still present with the edit intact; and the control, that the deletion does apply once the file is clean.
6. Re-run → all `already-current`, no state change.
7. **Detached worktree at an ancestor commit → untouched** (fails without the branch-match filter, per E11.8).
7b. **The scratch worktree is never converged**, asserted with the `detached` filter deliberately disabled so the by-name skip is what is under test (B4's second guard).
8. Main checkout on a release branch → converged like any other.
9. One skipped worktree does not affect the others, and does not change the exit code or `failedBranches`.
10. Aborted atomic push → `worktreeSync` empty, no worktree touched.
11. **Desync detection**: move the branch ref only (the E4.8 trap), then converge → `desynced`, not `already-current`, and the run does not claim convergence (E14.2/E14.3).
12. **Duplicate worktrees** via `worktree add --force` → both entries `skipped-duplicate-worktree`, neither converged, both paths named (E14.4).
13. **Locale**: the whole classification suite re-run under `LC_ALL=de_DE.UTF-8` must produce identical statuses (E15.1 measures this for the dirty case). This passes trivially for a structural classifier and fails for any message-based one — which is the point of asserting it.
13b. **`--git-path` resolution**: a mid-rebase **main checkout** classifies `skipped-operation-in-progress`, not `skipped-diverged`. Fails against an implementation that resolves the relative `.git/rebase-merge` against `process.cwd()` instead of the worktree path (E15.8).
14. **Selected-not-pushed**: a branch dropped from the refspecs by reclassification still has its worktree converged, and reports `fast-forwarded` — not `already-current` and not absent (B3).
15. `skipped-error` is distinguishable from the expected skips in `results[]` and carries its own summary count.

**E2E** — `--dry-run` converges nothing; `gh-merge-dev-plan` converges nothing; a run with one dirty and two clean worktrees exits **0** with two `fast-forwarded` and one `skipped-dirty`.

**Observability** — the per-branch report lines above; a structured log line per convergence `{ branch, worktreePath, status, durationMs }`; the count of converged worktrees in the final summary.

Verification gate for this work: `cd apps/infra-kit/cli && pnpm run qa` (not root `qa` — §4).

### 10.8 Acceptance criteria

22. After a successful run, every **non-skipped** local worktree holding a **selected** release branch is at `origin/<B>`, and `git status --porcelain` in each is byte-identical to what it was before the run. *(Scoped in amendment iteration 2: the unconditional version was falsified by criteria 23–25, since skips are expected behaviour, and "pushed" was the wrong set per B3.)*
23. A worktree with uncommitted changes that the fast-forward would overwrite is left **exactly** as it was — same `HEAD`, same file bytes — and is reported `skipped-dirty`.
24. A worktree with an untracked file colliding with an incoming file is left exactly as it was and reported `skipped-untracked-collision`.
25. A worktree whose branch has diverged is left exactly as it was and reported `skipped-diverged`.
25b. A worktree with the operator's own merge or rebase in progress is reported `skipped-operation-in-progress` — **not** `skipped-diverged` — and its `MERGE_HEAD` / rebase directory survive the run byte-identical.
26. Any number of convergence skips leaves the process exit code and `failedBranches` unchanged from the same run with no worktrees present.
27. A **detached** worktree sitting at an ancestor of the pushed commit is not moved.
28. Re-running immediately reports every worktree `already-current` and changes nothing.
29. `--dry-run`, a declined confirmation, and an aborted atomic push each leave `worktreeSync` empty and every worktree untouched.
30. No git invocation in the convergence path contains `-f`, `--force`, `reset`, `checkout`, `clean`, or `stash`.
31. A worktree whose branch ref is at `origin/<B>` but whose tree is stale is reported `desynced`, **not** `already-current`, and the run does not report it as converged.
32. Every status in the §10.5 table is produced identically under `LC_ALL=C` and under a non-English locale, and no code path in §10's classifier branches on git's message text.
33. `skipped-error` is distinguishable in `results[]` and the report from every expected skip, logs at warn level, and has its own summary count.
34. A branch dropped from the refspec set by reclassification still gets its worktree converged.
35. Two worktrees sharing one branch are both reported `skipped-duplicate-worktree` and neither is converged.
36. The scratch worktree is never converged, even with the `detached` filter disabled.

### 10.9 Phasing — where this lands

Honest build state, re-checked during amendment iteration 2 and moving fast — **Phase 2 landed while this amendment was being written.** `gh-merge-dev.ts` now imports `planMergeRun` / `pushableRefs` / `reclassify` / `withScratchWorktree` / `pushAtomic` and runs the full designed flow: plan in the scratch worktree → render → picker **after** the plan → `confirmOrExit(..., { throwOnDecline: true })` → `reclassify` → refspec set printed → `pushAtomic`. Phase 0 and the §3.11 cleanup contract are in. So the prerequisite this section named is satisfied.

**What does not exist is convergence itself**: no `ff-only` call, no `worktreeSync`, nothing in `git-utils` or the command that touches an operator worktree. §10 is now the immediate next unit of work rather than a downstream one, and its call site is unambiguous — directly after `pushAtomic` returns success, before the `withScratchWorktree` callback returns (which is what removes the scratch worktree, satisfying B4's ordering requirement for free).

One consequence of the shipped shape worth noting for the implementer: `reclassify` is currently called **once**, immediately before the push, which is correct while there is no `--verify` pass between them. §3.6's second call becomes necessary only when `--verify` lands.

This feature is strictly downstream of the atomic push, because it converges to what the push landed. It therefore lands as **Phase 2b**, immediately after Phase 2 wires the engine and the push into the command. It cannot ship earlier — before Phase 2 there is no push to converge to, and shipping the convergence against the legacy `git switch`/`git pull` loop would converge worktrees to a merge produced by a different, about-to-be-deleted engine.

Implementation is one new module, `src/lib/git-utils/worktree-sync.ts` (+ `__tests__/`), exported from the existing barrel alongside `merge-refs` and `scratch-worktree`, and one call site at the end of §3.6's apply phase.

### 10.10 ADR — converge local release worktrees by fast-forward, by default

**Status:** proposed (iteration 4).

**Decision.** After a successful `git push --atomic`, run `git merge --ff-only origin/<B>` inside every local worktree whose checked-out branch is exactly `B`, for each pushed branch `B`. Mandatory, no flag. Failures are reported, never fatal. Local `dev` and worktree-less branches are out of scope.

**Drivers.** The operator's workspace must reflect what was pushed; uncommitted work is sacred; a convergence failure must not fail a successful run.

**Alternatives considered.** F2 ref-only advance — refuted by measurement, not preference (E4.8/E4.9/E4.10). F3 merge-in-the-operator's-worktree as the engine — the user's own proposal, rejected because it is a second engine over a subset with time-of-check/time-of-use preconditions, while F1 delivers the same end state. F4 print-and-leave — the rejected status quo. F5 `pull --ff-only` — redundant network round trips.

**Why chosen.** It is the smallest write that satisfies the directive, and every one of its failure modes was measured to fail closed with the operator's work intact (E11.1–E11.7). It reuses the existing porcelain worktree enumeration and adds no second merge engine.

**Consequences, including the bad ones.**
- Principle 3 had to be rewritten; the command now writes into checkouts it did not create. That is a genuine widening, argued in §10.1 rather than smuggled in.
- Files change under running editors, watchers, and dev servers, and `post-merge` hooks run in those worktrees (E12.1). Intended, and identical to a manual `git pull --ff-only`.
- Convergence is best-effort, so a run can succeed with some worktrees still stale. Making it fatal would be worse (pre-mortem 10.4.2), but the divergence between "pushed" and "local" is now a state the report must be read to understand.
- The warm-`node_modules` advantage of Option A is forfeited (§10.5).
- Skipped worktrees accumulate silently across runs if the operator never reads the report — a dirty worktree skipped daily stays behind indefinitely. Mitigated only by reporting; a future `infra-kit worktrees sync` could reconcile.

**Follow-ups.** Reconsider worktree-less local branches once this is in use. Consider whether `worktrees sync` should adopt the same classification vocabulary.

---

### Appendix A — reconciliation with the earlier evidence brief

`scratchpad/merge-dev-git-evidence.md` was produced independently on the same git 2.54.0 and agrees on the mechanics. Four deltas, all still standing after iteration 3 even though the plumbing path is no longer recommended:

1. **Its "the exit code is the only valid signal" for `merge-tree` is too strong** — a bad ref also exits 1, with no OID (E6). Moot for the recommended design, retained because the plumbing path is still described as the rejected Option B.
2. **rerere** — measured: `merge-tree` does not replay resolutions, `git merge` does (E2.4), and `rerere.enabled` *unset* is the auto-enable state whenever `$GIT_DIR/rr-cache` exists (C1). Under the recommended design this stops mattering entirely, which is one of the reasons it was recommended.
3. **Signing** — measured: `commit-tree` ignores `commit.gpgsign` (E3.8). Also resolved by using real `git merge`.
4. **Its note that `git worktree` experiments are blocked is not correct in this sandbox.** `bash-guard` blocked a recursive force-remove, not worktree commands; `git worktree add/--detach/remove --force/prune` all ran (E4.1, E4.7, E8.x, E9.x). The `git switch` collision is measured, and the exact wording is `fatal: '<b>' is already used by worktree at '<path>'` (E5.1), **not** `already checked out at` — anything string-matching git's stderr must use the former.

### Appendix B — evidence index

| Ref | Claim | Source |
|---|---|---|
| E1.1–E1.6 | `merge-tree` output shape, exit codes, up-to-date emits a tree with no signal | `exp1-mergetree.sh` |
| E2.1–E2.4 | drivers honoured byte-identically; missing driver → 128; rerere ignored | `exp2-drivers.sh` |
| E3.1–E3.10 | commit-tree + sha push; FF-only rejection; pre-push hook runs; `gpgsign` ignored; bare-repo merge-tree | `exp3-push.sh`, `exp3b-push.sh` |
| E4.3–E4.10 | `switch` collision; merge via `cwd`; ephemeral detached worktree cycle; `update-ref` desync vs `branch -f` fail-closed | `exp4-worktrees.sh` |
| E5.1–E5.5 | `fatal: … already used by worktree at` (D1); dirty-worktree merge exit 2; `merge --abort` with no merge → 128 (D3); stale-local push rejection | `exp5-corrections.sh` |
| E6 | bad ref exits **1** like a conflict; `is-ancestor` on a bad ref exits 128 | `exp6-errors.sh` |
| E7 | `--stdin` batch format and its always-0 exit code | `exp7-stdin.sh` |
| E8.1–E8.10 | pristine-assertion primitives; `reset --hard` leaves untracked files; stale registration → `prune` recovery; path collision; `remove --force` while dirty | `exp8-worktree-recovery.sh` |
| E9.1–E9.4 | **cascade reproduced** (`error: you need to resolve your current index first`); `merge --abort` clears it and branch 3 proceeds | `exp9-cascade-anchor.sh` |
| ~~E9.5–E9.8~~ | *(retired in iteration 3 — measured anchor-ref survival under an artificial `reflog expire`; superseded by E10.5–E10.7, which show the anchors are unnecessary)* | — |
| E10.1–E10.4 | detached merge writes `… into HEAD`; `-m` and `--into-name` both restore the on-branch subject **and** empty body; all four trees byte-identical | `exp10-anchors-msg.sh` |
| E10.5–E10.6 | the scratch worktree's HEAD reflog keeps abandoned merge shas alive through a **realistic** `gc --prune=now`, and they still push | `exp10-anchors-msg.sh` |
| E10.7 | only after `worktree remove --force` does an unpushed sha become collectable — and removal happens after the push, so the anchors' window does not exist | `exp10-anchors-msg.sh` |
| C1, C1b, C1c | rerere auto-enabled by `rr-cache`; `--type=bool` returns the string `"false"`; rerere divergence is a false conflict, not silent drift | critic `crit1-rerere-bool.sh` |
| C2a–C2c, C3 | `--atomic` all-or-nothing measured; non-atomic control partially applies; GitHub advertises `atomic` | critic `crit2-atomic.sh` |
| C4, C5 | `merge.ff=false` divergence is **silent** under merge-tree; `commit-tree` runs no merge/commit hooks | critic `crit3-ff-hooks.sh` |
| C6 | reused-worktree cascade, independently measured | critic `crit4-reused-worktree.sh` |
| C11, C12 | the scratch worktree's HEAD reflog keeps abandoned merge shas alive; anchors unnecessary — independently reproduced here as E10.5–E10.7 | critic `crit6-anchors.sh` |
| A1, A2 | detached merge subject `… into HEAD`; `--into-name` restores it, identical tree | architect |
| A5 | `prepare-commit-msg` receives `$2 = merge` under **both** `-m` and `--into-name` — `-m` costs no hook fidelity | architect |
| E11.1–E11.2 | `merge --ff-only` in a clean worktree: FF succeeds, `git status` **empty** afterwards (the E4.8 contrast); re-run is `Already up to date.` exit 0 | `exp11-ffonly.sh` |
| E11.3 | unrelated dirt does **not** block the fast-forward, and is preserved | `exp11-ffonly.sh` |
| E11.4 | tracked-file collision → exit **1**, `Your local changes … would be overwritten`, HEAD unmoved, work intact | `exp11-ffonly.sh` |
| E11.5 | untracked-file collision → exit **1**, `The following untracked working tree files would be overwritten`, file intact — invisible to a clean-tree probe | `exp11-ffonly.sh` |
| E11.6–E11.7 | diverged branch (unpushed commit; operator already merged dev themselves) → exit **128**, `Not possible to fast-forward`, local commit preserved | `exp11-ffonly.sh` |
| E11.8 | **a detached worktree DOES fast-forward** — enumeration must match on branch, not on path | `exp11-ffonly.sh` |
| E11.10 | `git worktree list --porcelain` lists the main checkout as its own record | `exp11-ffonly.sh` |
| E12.1 | `merge --ff-only` runs the shared `post-merge` hook, cwd = the target worktree | `exp12-ffhook.sh` |
| E13.1 / E13.1b | a FF that would **delete** a locally-modified file → exit 1, `Your local changes … would be overwritten`, file and edit intact; the deletion applies normally once clean | `exp13-ff-gaps.sh` |
| E13.2 / E13.3 | worktree with its own conflicted **merge** or **rebase** → exit 128, `Merging is not possible because you have unmerged files` — a *different* message from the diverged case, so exit code alone cannot classify it; operator state untouched | `exp13-ff-gaps.sh` |
| E13.4 | after every refusal class, no `MERGE_HEAD` and no rebase directory attributable to this command — nothing to clean up | `exp13-ff-gaps.sh` |
| F1–F4 | independent measurement of E11.1–E11.6 by the team lead (`scratchpad/ff-evidence.md`) — convergent, no conflicts | team lead |
| E14.1–E14.3 | `Already up to date.` at exit 0 on a ref-advanced/tree-stale worktree, leaving `M f.txt` / `D g.txt` and the incoming file absent; the structural detector (`HEAD == origin` **and** clean status) classifies it correctly | `exp14-desync-dup.sh` |
| E14.4 | `git worktree add --force` **does** permit two worktrees on one branch (plain add fatals) — the route into the desync above | `exp14-desync-dup.sh` |
| E14.5 | git message catalogs are honoured here: `Bereits aktuell.` (de), `Déjà à jour.` (fr), 20 locales installed — the classifier needs `LC_ALL=C` | `exp14-desync-dup.sh` |
| A6, A7, A8 | architect's independent measurement of the desync lie, the localized build, and relative `core.hooksPath` being per-worktree | architect |
| E15.1–E15.6 | the **structural** classifier resolves all six refusal cases correctly — rebase dir, in-progress heads, `is-ancestor`, and the incoming∩dirty path intersection split on `??` — with E15.1 producing an identical result under `LC_ALL=de_DE.UTF-8` | `exp15-structural.sh` |
| E15.8 | `rev-parse --git-path` returns a **relative** path in the main checkout and an **absolute** one in a linked worktree — resolve against the worktree, not `process.cwd()` | `exp15-structural.sh` |
