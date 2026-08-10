# `[DO] gh-merge-dev` hardening plan

**Status: pending approval** — no code has been changed. Every git behaviour cited below was measured in a throwaway repo under the session scratchpad (`.../scratchpad/exp/exp{1..7}-*.sh`); anything not measured is labelled **ASSUMPTION**.

Measurement host: `git version 2.54.0`, macOS.

---

## 1. RALPLAN-DR summary

### Principles

1. **Nothing the operator or the team can see is mutated before the operator has seen the whole plan.** One sanctioned exception (`git fetch origin --prune`, justified in §3.4).
2. **Shared refs move forward only.** This command never emits `--force`, `--force-with-lease`, or a `+` refspec, and has no rollback path that rewinds a remote. A rejected push is a correct outcome, not a bug to route around.
3. **The operator's checkout is not a resource this command consumes.** It must not require, take, or leave behind a particular `HEAD`, a clean tree, or an idle worktree.
4. **A run is either fully described or it did not happen.** Every selected branch ends the run with an explicit terminal state — including `not-attempted` — in both the human report and `structuredContent`.
5. **Fail closed, and fail per-branch.** One branch's failure never aborts the others, and never escapes as an unhandled rejection.

### Decision drivers (ranked)

1. **Determinism / trust.** The user's headline requirement: "so I can run it with confidence and it actually gets merged." A command that aborts because a worktree exists, or half-applies and crashes, is worse than no command.
2. **Coexistence with the team's normal worktree layout.** `worktrees-add` / `worktrees-sync` mean "the release branch is checked out somewhere" is the *default* state, not an edge case. Any design whose happy path needs `git switch` is designed against the team's actual workflow.
3. **Merge fidelity.** Whatever we push must be byte-identical to what `git merge origin/dev` would have produced on that branch — or we must detect the divergence and refuse.

Latency and code volume are explicitly *not* top-three drivers here.

### Viable options

#### Option A — worktree-aware switching (`$({cwd: worktreePath})`)

Keep `git switch`, but consult `listWorktrees()` first; when the target branch lives in a linked worktree, run `git pull`/`git merge`/`git push` with that worktree as `cwd`.

*Pros:* smallest conceptual delta; full `git merge` semantics for free (drivers, rerere, hooks, signing); `node_modules` already present there, so `--verify` is nearly free.

*Cons (measured):*
- It mutates a checkout that belongs to someone else's in-flight work. E4.5 confirms the merge lands in `wt-rel` and its `HEAD` moves.
- It is blocked by *their* dirt: E5.2 — `git merge` in a worktree with an uncommitted edit to a file the merge touches exits **2** with `error: Your local changes ... would be overwritten by merge`. So the D5 clean-tree problem is not removed, only relocated onto a colleague.
- A conflict leaves *their* worktree in `MERGING` state for them to discover.
- A stale local branch produces a merge commit that then fails to push (E5.4: `! [rejected] ... (non-fast-forward)`), leaving an unpushed merge commit sitting on their branch (E5.5).
- Branches with no worktree still need the `git switch` path, so both failure modes remain in the code.

*When this is the right choice:* if merge fidelity via hooks/rerere were a hard requirement **and** the team's worktrees were disposable. Neither holds.

#### Option B — checkout-free plumbing  ← **RECOMMENDED**

`fetch` → `merge-base --is-ancestor` for up-to-date/FF detection → `merge-tree --write-tree` for the merge → `commit-tree` for the merge commit → `git push origin <sha>:refs/heads/<branch>` (non-forced).

*Pros (measured):*
- Never reads or writes a working tree. D1, D2, D5, D6 are eliminated by construction — there is no `git switch` and no `git pull` left to fail. Works in a bare repo (E3.9) and off remote-tracking refs alone (E3.10).
- **It honours `.gitattributes` merge drivers.** E2.2: with `CHANGELOG.md merge=union` and a custom `lock.json merge=takeours` driver, `merge-tree --write-tree` produced content byte-identical to the real `git merge` in E2.1 (union-merged changelog, ours-side lockfile). This was the biggest open risk and it is resolved in B's favour.
- The push is fast-forward-only. E3.2: a stale sha is rejected with `! [rejected] ... (fetch first)`, exit 1. A concurrent teammate push therefore loses safely, with no data loss on either side.
- Local `pre-push` hooks still run (E3.5).
- Two-phase plan → confirm → apply falls out naturally, because the merge result is computed *before* anything is pushed.

*Cons (measured):*
- **`rerere` is ignored.** E2.4: a recorded resolution auto-resolves a real `git merge` ("Resolved 'plain.txt' using previous resolution") but `merge-tree` still emits conflict markers. Mitigated: `rerere.enabled` is unset in all 16 repos under `~/projects` (measured), and the plan phase probes for it.
- **`commit.gpgsign` is ignored.** E3.8: `commit-tree` produced a commit with zero `gpgsig` headers despite `commit.gpgsign=true`. Mitigated by a capability probe.
- Local `dev` and release branches are not advanced. This is a deliberate, documented behaviour change (see `--update-local`, §3.6).
- Requires `git >= 2.38` (`--write-tree`). **ASSUMPTION** — not verifiable on this host, which has 2.54. Must be asserted at runtime, not assumed.
- Exit-code taxonomy is sharp-edged: E6 shows a **bad ref also exits 1**, the same code as a conflict. Handled explicitly in §3.4.

#### Option C — ephemeral detached worktree per branch

`git worktree add --detach <tmp> origin/<branch>` → merge → push → `git worktree remove --force`.

*Verified end-to-end in E4.7*: the add succeeds even while `release/v1` is checked out in another worktree, the merge runs, `git push origin HEAD:refs/heads/release/v1` from detached HEAD succeeds, and the removal is clean.

*Pros:* full `git merge` semantics including rerere and signing; isolated from every other checkout; the only design that can host a real `pnpm install && pnpm run qa`.

*Cons:* disk and latency per branch; a fresh worktree has a cold turbo cache and no `node_modules`, so `--verify` pays full cost per branch; more moving parts to leave behind on a crash (a stale worktree registration).

*When this is the right choice:* as the **verification substrate** and as the **escape hatch** when the capability probe says B is unsafe. Not as the default path.

#### Option D — hybrid: B by default, C on demand ← **this is what "recommended" actually means**

B computes the plan and performs the merge for every branch. C is materialised **only** when `--verify` is passed, or when the capability probe detects `rerere.enabled` / `commit.gpgsign` / an unresolvable merge driver. A is dropped entirely.

**Invalidation of A:** every advantage A has over B is either non-existent in practice (drivers work under B; rerere and signing are off everywhere and are detected) or better served by C (which does not mutate someone else's checkout). A's costs are unique to A. It is dominated.

**Invalidation of C-as-default:** C pays per-branch worktree cost on every run for semantics that B already reproduces (E2.2). Reserve it.

---

## 2. Pre-mortem — three ways this destroys something in three months

### 2.1 The half-applied run

**Mechanism.** Today's loop pushes branch-by-branch as it goes. D3 makes a mid-loop crash likely rather than theoretical: the `catch` in `mergeDev` calls `git merge --abort` unconditionally, and E5.3 measures that call exiting **128** with `fatal: There is no merge to abort (MERGE_HEAD missing)` whenever the failure was in `switch`/`pull`/`push`. That rejection is thrown *from inside the catch*, escapes `mergeDev`, escapes the `for` loop, and terminates the command. Branches 1–2 are pushed, 3–6 are not, `$.quiet` is stuck at `true`, and `HEAD` is parked on an arbitrary release branch.

**Blast radius.** Every developer on the merged release branches pulls a merge nobody announced; the un-merged branches silently go stale into the release. The operator cannot reconstruct which is which without inspecting six remotes by hand. Trust in the command is gone after one occurrence.

**Prevented by.** Plan-then-apply (§3.3–3.5): the full plan for all branches is computed and displayed before the first push. The apply loop records a terminal state per branch and can never throw out of a branch iteration — cleanup is itself wrapped, and `$.quiet` restoration moves into `finally`. Every branch appears in the final report, including `not-attempted`. Phase 0 ships the cleanup guard alone, ahead of everything else.

### 2.2 The force-push that eats a colleague's commit

**Mechanism.** Someone hits `! [rejected] (fetch first)` (E3.2) and "fixes" it — either by hand or by a well-meaning follow-up PR adding `--force-with-lease` to the push, or by a `--verify` rollback that rewinds origin after a failed QA. E3.4 confirms `--force-with-lease` with an explicit expected oid does rewind the remote.

**Blast radius.** A teammate's commit vanishes from a shared release branch. GitHub shows the PR losing commits. Recovery requires a reflog that only exists on the machine that pushed it — and only if it is still there.

**Prevented by.** Principle 2, made mechanical: (a) verification is **pre-push only**, so there is never a state that "needs" rolling back; (b) there is no rollback-by-rewinding code path at all; (c) a unit test asserts that no argument vector reaching `git push` ever contains `--force`, `--force-with-lease`, `-f`, or a leading `+` in the refspec. The non-forced sha push is already FF-only by measurement, so correctness does not depend on the test — the test exists to stop a future edit from removing the property.

### 2.3 The silent semantic drift

**Mechanism.** A consumer repo (hulyo, travelist) adds `.gitattributes`, turns on `rerere.enabled`, or sets `commit.gpgsign=true` — none of which is visible to whoever last touched this command. Measured consequences: drivers are fine (E2.2), but a **missing** driver definition makes `merge-tree` exit **128** with `fatal: custom merge driver takeours lacks command line` (E2.3); rerere is silently skipped (E2.4); commits come out unsigned (E3.8). If GitHub branch protection requires signed commits, every push starts failing for everyone.

**Blast radius.** Either a merge that lands *different content* than `git merge` would have (rerere), or a repo-wide push outage. The failure is silent in the first case — the worst kind.

**Prevented by.** A capability probe in the plan phase (§3.4) that reads `git --version`, `git config --get rerere.enabled`, `git config --get commit.gpgsign`, and `git config --get-regexp '^merge\..*\.driver'`, and either auto-selects `--strategy=worktree` or refuses with a named reason. The probe result is printed in the plan and carried in `structuredContent.strategy` + `structuredContent.strategyReason`, so a change in a consumer repo surfaces as a visible strategy switch rather than as drift.

---

## 3. Recommended design

### 3.1 New modules (repo convention: `src/lib/<kebab>/<kebab>.ts` + `index.ts` + `__tests__/`)

| Path | Responsibility |
|---|---|
| `src/lib/git-capabilities/git-capabilities.ts` | `probeGitCapabilities(cwd)` → `{ version, supportsWriteTree, rerereEnabled, gpgSignEnabled, customMergeDrivers: string[] }`. Pure probe, no policy. |
| `src/lib/git-merge-tree/git-merge-tree.ts` | Thin, evidence-backed wrappers: `revParseVerify`, `isAncestor`, `mergeTree`, `commitTree`, `pushSha`, `lsRemoteHead`. Each one owns exactly one measured exit-code contract. No policy. |
| `src/lib/merge-plan/merge-plan.ts` | Policy: `buildMergePlan({ into: string[], from: 'dev' })` → `MergePlan`; `renderMergePlan(plan)` → the human preview; `chooseStrategy(capabilities, flags)`. |
| `src/lib/merge-apply/merge-apply.ts` | `applyMergePlan(plan, { verify })` → per-branch results. Owns the pre-push staleness re-check and the ephemeral-worktree verification. |
| `src/lib/ephemeral-worktree/ephemeral-worktree.ts` | `withDetachedWorktree(sha, fn)` — add / run / always remove. Used by `--verify` and by `--strategy=worktree`. |

### 3.2 Modified files

- `src/commands/gh-merge-dev/gh-merge-dev.ts` — orchestration rewrite; stops calling `assertManagementContext`.
- `src/lib/git-guard/git-guard.ts` — **add** `assertRepoWithOrigin({ operation })` (repo exists + `origin` remote resolves). `assertManagementContext` is left untouched for its other callers.
- `src/lib/program/program.ts` — `configureMergeDev` gains `--versions`, `--dry-run`, `--verify`, `--update-local`, `--strategy <plumbing|worktree>`.
- `src/lib/command-catalog/command-catalog.ts` + its snapshot — description change only if the summary line moves.

### 3.3 Flag surface

CLI (`infra-kit release merge-dev`):

| Flag | Default | Notes |
|---|---|---|
| `-a, --all` | – | unchanged |
| `-v, --versions <list>` | – | **new, and a bug fix.** `configureMergeDev` currently defines only `--all` and `--yes`, yet the code calls `commandEcho.addOption('--versions', …)` on a partial selection. The echoed "equivalent command" is therefore **not runnable** — Commander rejects the unknown option. (`--versions` is defined on `worktrees add`/`remove`, not here.) Call this **D8**. |
| `-y, --yes` | – | unchanged |
| `--dry-run` | `false` | compute and print the plan, push nothing |
| `--verify` | `false` | see §4 |
| `--update-local` | `false` | after a successful push, advance local branches that are **not** checked out anywhere (§3.6) |
| `--strategy <plumbing\|worktree>` | auto | `auto` = plumbing unless the capability probe objects |

MCP `inputSchema` additions (all `.optional()`, so existing callers are unaffected):
`versions: z.array(z.string())`, `dryRun: z.boolean()`, `verify: z.boolean()`, `updateLocal: z.boolean()`, `strategy: z.enum(['plumbing','worktree'])`.

`versions` also finally gives MCP a way to target a subset — today `all` is the only input, so an agent literally cannot merge two of five branches.

### 3.4 Plan phase — exact command sequence

```
git --version                                  # parse; require >= 2.38.0 for --write-tree  [ASSUMPTION: 2.38 floor]
git rev-parse --git-dir                        # in a repo
git remote get-url origin                      # origin resolves
git config --get rerere.enabled                # → strategy=worktree if true            [E2.4]
git config --get commit.gpgsign                # → strategy=worktree if true            [E3.8]
git config --get-regexp '^merge\..*\.driver'   # informational; a *missing* driver surfaces as exit 128 below  [E2.3]

git fetch origin --prune                       # THE one sanctioned mutation, see below

git rev-parse --verify --quiet origin/dev^{commit}

for each selected branch B:
  git rev-parse --verify --quiet origin/<B>^{commit}     # absent → status 'error', do NOT continue to merge-base
  git merge-base --is-ancestor origin/dev origin/<B>     # exit 0 → 'up-to-date'
  git merge-base --is-ancestor origin/<B> origin/dev     # exit 0 → 'fast-forward'
  git merge-tree --write-tree --name-only --messages origin/<B> origin/dev
```

`merge-tree` result classification, all measured:

| Observation | Meaning | Evidence |
|---|---|---|
| exit 0, stdout line 1 = tree oid | clean merge | E1.5, E3.1 |
| exit 1, stdout line 1 matches `/^[0-9a-f]{40,64}$/` | **conflict**; line 1 is the (conflicted) tree, subsequent lines are conflicted paths, then a blank line, then messages | E1.1, E1.2 |
| exit 1, stdout = `merge-tree: <ref> - not something we can merge` | **bad ref**, *not* a conflict | E6 |
| exit 128 | fatal: unrelated histories, or a `.gitattributes` driver with no `driver` command | E6, E2.3 |

**The exit-1 collision is the trap**: conflict and bad-ref share an exit code. The discriminator must be "line 1 is a hex oid", not the exit code. The `rev-parse --verify` pre-check makes bad-ref unreachable in practice, but the wrapper must still discriminate — belt and braces.

Notes:
- `--name-only` changes the conflict block from `<mode> <oid> <stage>\t<path>` triples to bare paths (E1.1 vs E1.2) — that is what we want for the preview.
- `--messages` is a no-op on the conflict path (messages already print) and emits an empty section on a clean merge (E1.3, E2.5). Keep it anyway so the flag's meaning does not depend on the outcome.
- `--stdin` batch mode works (`<branch1> <branch2>` per line — *not* `--`) and returns a per-merge `0`/`1` status prefix with NUL separators, but the **process exit code is 0 even when a merge conflicts**, and per-branch attribution requires positional parsing of a NUL stream. Rejected for v1: N is a handful of branches, and per-branch invocations give per-branch error isolation for free. Revisit if N ever grows.
- **`merge-base --is-ancestor` exits 128 on an unknown ref** (E6), so the `rev-parse --verify` check must come first — otherwise a deleted branch produces a fatal instead of a per-branch `error`.

**Why `git fetch origin --prune` is allowed before consent.** It writes only `refs/remotes/*`; it never touches a local branch, the index, the working tree, or the remote. A plan computed on stale refs would be a lie, and a plan that lies is worse than a refresh the operator did not explicitly authorise. This is stated in the plan output ("fetched origin; plan computed against …") so it is not a surprise.

### 3.5 Apply phase — exact command sequence

Per branch, in plan order, only after `confirmOrExit`:

```
# staleness re-check (defence in depth; the push below already rejects — E3.2)
git ls-remote origin refs/heads/<B>            # oid must equal the one the plan was built on, else 'stale-plan', skip

# fast-forward case: reproduce what `git merge` would do (it fast-forwards; no merge commit)
git push origin origin/dev:refs/heads/<B>

# real-merge case:
git commit-tree <tree> -p origin/<B> -p origin/dev -F -    # message on stdin
git push origin <sha>:refs/heads/<B>                        # non-forced ⇒ FF-only
```

Commit message, matching what a real merge writes (measured verbatim in E5.5):

```
Merge remote-tracking branch 'origin/dev' into <B>
```

Author/committer come from the repo's `user.name`/`user.email`, exactly as `git merge` would. Signing does not (E3.8) — hence the probe.

Finally, once: `git fetch origin --prune` to refresh remote-tracking refs (the push already updates `refs/remotes/origin/<B>` for the pushed branch — E3.1 — but not the others).

Status vocabulary: `up-to-date` · `fast-forward` · `merged` · `conflict` · `stale-plan` · `verify-failed` · `push-rejected` · `error` · `not-attempted`.

### 3.6 Local branches — and the `update-ref` landmine

After a plumbing push, the local `dev` and release branches are untouched and now behind origin (E3.1). Default behaviour: leave them, and say so in the report.

`--update-local` advances a local branch **only** when that branch is not checked out in any worktree. The implementation must use **`git branch -f`, never `git update-ref`**:

- E4.9: `git branch -f release/v1 <sha>` on a branch checked out in a linked worktree → exit 128, `fatal: cannot force update the branch 'release/v1' used by worktree at '<path>'`. **Fails closed.**
- E4.8: `git update-ref refs/heads/release/v1 <sha>` on the same branch → **exit 0**, ref moved, and the linked worktree's index is now desynced from its own `HEAD` — `git status` there shows phantom staged deletions (`D  d.txt`) that the teammate did not cause. Silent corruption of someone else's checkout.
- E4.10: `git fetch origin <b>:<b>` also fails closed (exit 128, `refusing to fetch into branch ... checked out at`).

### 3.7 `structuredContent` (additive; the four existing keys keep their names)

```ts
{
  successfulMerges: number,   // branches that ended in the desired state (includes up-to-date)
  failedMerges: number,       // conflict | push-rejected | verify-failed | error | stale-plan
  failedBranches: string[],
  totalBranches: number,
  strategy: 'plumbing' | 'worktree',
  strategyReason: string,
  dryRun: boolean,
  results: Array<{
    branch: string
    status: 'up-to-date' | 'fast-forward' | 'merged' | 'conflict' | 'stale-plan'
          | 'verify-failed' | 'push-rejected' | 'error' | 'not-attempted'
    mergeSha?: string
    conflictPaths?: string[]
    pushed: boolean
    reason?: string
  }>
}
```

`successfulMerges` counting `up-to-date` as success is a **deliberate semantic clarification** (today an up-to-date branch runs a no-op merge and counts as success anyway, so this is not a break). `results[]` carries the precise truth for any consumer that needs it. `outputSchema` gains the new keys; nothing is removed or renamed.

---

## 4. Should this command run `pnpm install` + `pnpm run qa`?

**Recommendation: ship it as `--verify`, default OFF, pre-push only, non-blocking-by-skipping. Do not create a separate `infra-kit verify-merge`.**

**Where it would run.** The plumbing path has no working tree, so QA has nowhere to execute. It requires materialising the planned merge commit: `git worktree add --detach <tmp> <mergeSha>` → `pnpm install --frozen-lockfile` → `pnpm run qa` → `git worktree remove --force`. E4.7 verifies the whole add/run/push-from-detached/remove cycle works even while the branch is checked out elsewhere. Note this does **not** require `--strategy=worktree` — the merge sha already exists locally after `commit-tree`, so verification is an orthogonal step on top of the plumbing plan.

**Cost.** Per branch: one cold `pnpm install` plus one cold-cache `turbo run test ts-check prettier-check eslint-check infra-kit-check` across the whole workspace. A fresh worktree shares no turbo cache, so there is no amortisation across branches. Root `qa` also begins with `pnpm run vendor:check`, which shells out to the *globally installed* `infra-kit`, not the one under test. Consumer repos are where this command actually runs: travelist has 19 workspace packages, hulyo 7. With five open release branches that is five cold installs plus five cold full-monorepo QA runs, serialised, in front of a push the operator is waiting on. **ASSUMPTION:** wall-clock not measured — running the suite was outside the read-only planning boundary.

**Flakes.** `lock.test` and `portless-driver.test` are known to flake under full-suite load and pass in isolation. A gate that flakes turns a command whose entire purpose is determinism into a coin flip. That alone disqualifies it as a default.

**Does it duplicate CI?** Yes, almost entirely. Every release branch has an open PR; the push we perform triggers CI on exactly the commit we just built. Local QA is a slower, flakier, cold-cache copy of a check that is about to run anyway on the same sha. Its only genuine advantage is *earliness* — it can stop a broken merge from reaching a shared branch at all.

**Block, warn, or roll back?** Block-by-skipping. A failed `--verify` means that branch is **not pushed**; the other branches proceed; the branch reports `verify-failed` with the failing task. Never roll back: rolling back a pushed merge means rewinding a shared ref, which is banned by Principle 2 and is pre-mortem 2.2 happening. That is precisely why verification must run *before* the push and never after.

**Does it belong in this command at all?** Yes, and only here. The artifact being verified is the planned merge commit, which exists only inside this command's plan; a standalone `infra-kit verify-merge` would have to recompute the merge, which means duplicating the plan phase and then racing it. Keep one command, one artifact, one gate.

**Default: OFF.** Turning it on by default would trade a 5-second command for a multi-minute one, gated on known-flaky tests, to duplicate a CI run that is already triggered by the same push. Off is the honest default; `--verify` is there for the release-cut run where the operator wants the wait.

---

## 5. Phased implementation

### Phase 0 — stop the bleeding (D3, D8, `$.quiet`, HEAD parking)

No new modules, no strategy change. Touches `gh-merge-dev.ts` and `program.ts` only.

- Guard the cleanup: `git rev-parse -q --verify MERGE_HEAD` before `git merge --abort`, and wrap the cleanup in its own `try`/`catch` so nothing can throw out of the outer `catch`.
- Move `$.quiet = false` into a `finally`.
- Record the starting branch and restore it in a `finally`.
- Add `-v, --versions <list>` to `configureMergeDev` and thread it into `GhMergeDevArgs` + MCP `inputSchema`, so the echoed command is runnable and MCP can target a subset.

**Acceptance:** with the *first* git command mocked to reject, `ghMergeDev` returns a structured result rather than throwing, and `git merge --abort` is never invoked. `infra-kit release merge-dev --versions "1.2.5" --yes` parses (today it exits with an unknown-option error).

### Phase 1 — plan phase, read-only

Add `git-capabilities`, `git-merge-tree`, `merge-plan`. Add `--dry-run`. `ghMergeDev` computes and prints the plan; `--dry-run` stops there; the legacy loop still performs the apply.

**Acceptance:** in a temp repo with one conflicting and one clean release branch, `--dry-run` names the conflicting file(s) and `git rev-parse --all` is byte-identical before and after, apart from `refs/remotes/*` moved by the fetch. Capability probe correctly reports `rerereEnabled` for a repo with `rerere.enabled=true`.

### Phase 2 — plumbing apply becomes the default

Replace the loop with `commit-tree` + sha push. Delete the `git switch` / `git pull` legs entirely (D1, D2, D5, D6 die here). Swap `assertManagementContext` for `assertRepoWithOrigin`. Extend `structuredContent` / `outputSchema`.

**Acceptance:** §7 criteria 1–9.

### Phase 3 — `--verify`, `--strategy=worktree`, `--update-local`

Add `ephemeral-worktree` and `merge-apply`'s verification step. Auto-select `worktree` when the probe objects.

**Acceptance:** §7 criteria 10–13.

### Phase 4 — observability and docs

`--json` parity for the new shape, per-branch duration in the log lines, `readme.md` + `command-catalog` description refresh, and a `docs/` note on why local branches are not advanced by default.

---

## 6. Test plan

### The existing tests break — deliberately

`gh-merge-dev-conflict-cleanup.test.ts` mocks zx's `$` by **reconstructing the command string** and matching `'git merge origin/dev --no-edit'` exactly. Phase 2 deletes that command, so the test's premise disappears. Worse, such a mock is structurally incapable of testing the new design: a mock that returns `{ stdout: '' }` for `merge-tree` would report every branch as a clean merge with an empty tree oid — a false green on the exact property that matters. It must be **rewritten, not patched**.

Disposition:

- **Keep the zx-string mock** only for pure-policy tests: flag/arg threading, the MCP omitted-arg guard (`gh-merge-dev-mcp-guard.test.ts` survives as-is — it never gets past argument resolution), and the "no force token ever reaches `git push`" assertion.
- **Move everything about git semantics to real temporary repositories.** Justification: the entire change is a claim about git's behaviour. A string mock encodes our *belief* about git and will keep passing after git changes, after a `.gitattributes` appears, or after we get an exit code wrong — all three of which this plan's measurements show are live risks (E6's exit-1 collision would sail past any mock). Real repos are also cheap here: the fixtures in §6.2 build in well under a second and need no network.

### 6.1 Unit

- `git-merge-tree`: classification table driven by *recorded real outputs* — clean (exit 0 + oid), conflict (exit 1 + oid + paths), bad ref (exit 1, no oid), fatal (exit 128). Asserts the bad-ref case is **not** reported as a conflict.
- `git-capabilities`: version parsing (`2.38.0` boundary, `2.54.0`, a hypothetical `2.37.9` → refuse), each config probe.
- `merge-plan`: status derivation from probe results; `chooseStrategy` truth table (rerere on → worktree; gpgsign on → worktree; explicit `--strategy` wins; otherwise plumbing).
- `command-echo` threading: a partial selection echoes `--versions "1.2.5, 1.2.6"` **and** that line parses through the real Commander program.
- Force-token guard: no `$` invocation beginning `git push` ever contains `--force`, `--force-with-lease`, `-f`, or a `+`-prefixed refspec.

### 6.2 Integration — real temp repos

A shared fixture builder (`makeRemoteFixture()`) creating a bare `origin.git`, a clone, `dev`, and N release branches, with `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null` so the developer's own git config cannot leak in (as used in every experiment here).

1. Clean merge → origin advances; the pushed tree equals the `merge-tree` tree; the local branch is untouched.
2. Conflict → nothing pushed for that branch; conflicting paths reported; other branches still merge.
3. Up-to-date → nothing pushed, status `up-to-date`.
4. Fast-forward → origin ends exactly at `origin/dev`'s sha, with **no** merge commit.
5. Concurrent teammate push between plan and apply → `stale-plan` or `push-rejected`; origin still holds the teammate's commit (replicates E3.2).
6. `dev` and the release branch each checked out in a linked worktree → the whole run succeeds (this is the D1/D2 regression test, and it fails on today's code with the exact `fatal: 'dev' is already used by worktree at …` from E5.1).
7. Dirty main checkout → the run succeeds (D5 regression).
8. `.gitattributes` with `merge=union` → the pushed content equals what a control `git merge` produces in a scratch clone (locks in E2.2).
9. `rerere.enabled=true` → strategy auto-switches to `worktree`, and the reason is in `structuredContent.strategyReason`.
10. `commit.gpgsign=true` → same.
11. A release branch deleted on origin between selection and plan → `error` for that branch only, no fatal (guards the E6 `is-ancestor` exit-128 trap).
12. `--update-local` with the branch checked out in a worktree → local ref unchanged, reported as skipped, and **no** phantom-deletion state in that worktree (the E4.8 regression).

### 6.3 E2E

- `--dry-run` against a real fixture: assert `git rev-parse --all` unchanged except `refs/remotes/*`.
- MCP path: `ghMergeDevMcpTool.handler({ all: true, versions: [...], dryRun: true, confirmedCommand: true })` returns a plan and pushes nothing; `outputSchema` validates the result.
- `--verify` with a fixture whose `qa` script exits non-zero → branch reports `verify-failed`, origin unchanged, temp worktree removed (assert `git worktree list` is back to its pre-run set).
- Gate CI/QA invocations on an explicit `; echo EXIT=$?` — filtered runners have been observed reporting exit 0 on a failing suite.

### 6.4 Observability

- One structured log line per branch: `{ branch, status, mergeSha, conflictCount, durationMs, pushed }`.
- The plan preview is printed to stderr before the confirm, and repeated in the final report so the transcript contains both intent and outcome.
- On any non-success, the report prints a copy-pasteable manual recipe **for that branch's actual status** — today's blanket `git switch … && git pull …` script is wrong advice for a worktree-occupied branch, which is the most common failure.
- `strategy` + `strategyReason` are always printed, so a consumer repo's config change surfaces as a visible line rather than as drift.

---

## 7. Testable acceptance criteria

1. With `dev` checked out in a linked worktree, a full run completes and pushes every non-conflicting selected branch. (Today: exit 128, `fatal: 'dev' is already used by worktree at …`.)
2. With every selected release branch checked out in a linked worktree, same.
3. With uncommitted changes in the main checkout, the command runs to completion.
4. `git rev-parse --abbrev-ref HEAD` is identical before and after any run, success or failure.
5. `--dry-run` leaves `git rev-parse --all` byte-identical apart from `refs/remotes/*`.
6. No git command emitted by the command contains `--force`, `--force-with-lease`, `-f`, or a `+`-prefixed refspec (asserted over the full recorded invocation list).
7. When any single branch fails, every other selected branch still reaches a terminal state, and the returned `results[]` has exactly one entry per selected branch.
8. `git merge --abort` is invoked **only** when `MERGE_HEAD` exists; a failure in the cleanup path never propagates out of the command.
9. A teammate push landing between plan and apply leaves origin at the teammate's commit; the branch reports `stale-plan` or `push-rejected`; nothing is lost.
10. In a repo with `.gitattributes` declaring `merge=union`, the pushed tree equals the tree a control `git merge` produces.
11. With `rerere.enabled=true` or `commit.gpgsign=true`, `structuredContent.strategy === 'worktree'` and `strategyReason` names the trigger.
12. `--verify` failing on branch X leaves `origin/X` unchanged, pushes the other branches, and leaves `git worktree list` identical to its pre-run value.
13. `--update-local` never advances a local branch that is checked out in any worktree, and never leaves a worktree showing changes its owner did not make.
14. The echoed equivalent command for a partial selection parses through the real Commander program and, re-run with `--yes`, selects the same branches.

---

## 8. ADR — checkout-free merge plumbing for `gh-merge-dev`

**Status:** proposed.

**Decision.** Merge `origin/dev` into release branches without touching any working tree: `merge-tree --write-tree` + `commit-tree` + a non-forced `git push <sha>:refs/heads/<branch>`, behind a two-phase plan → confirm → apply. An ephemeral detached worktree is used only for opt-in `--verify` and as an auto-selected escape hatch when a capability probe finds `rerere.enabled`, `commit.gpgsign`, or an unusable merge driver.

**Drivers.** Determinism; coexistence with the team's per-release worktrees; merge fidelity.

**Alternatives considered.** (A) worktree-aware switching — dominated: it relocates the clean-tree requirement onto a colleague's checkout and can leave their worktree in `MERGING` state or holding an unpushable merge commit (E5.2, E5.4, E5.5). (C) ephemeral worktree as the default — correct but pays per-branch install/checkout cost for semantics that plumbing already reproduces (E2.2); retained for verification only. (Status quo + patches) — cannot fix D1/D2 without one of A/B/C, because `git switch` is the defect.

**Why chosen.** The two properties that decided it are both measured, not assumed: `merge-tree` honours `.gitattributes` merge drivers byte-for-byte (E2.2), and a plain sha push is fast-forward-only and rejects on divergence (E3.2). Together they mean the plumbing path produces the same content as a real merge and cannot lose a concurrent push. Everything else follows: no checkout means no worktree collision, no dirty-tree gate, and a natural preflight.

**Consequences — including the bad ones.**
- `rerere` resolutions are not replayed (E2.4). Mitigated by a probe; unset in all 16 local repos today, but a consumer could enable it tomorrow and the mitigation is the only thing standing between that and silent drift.
- Merge commits are unsigned unless the probe routes to the worktree strategy (E3.8).
- Local `dev` and release branches no longer advance as a side effect. Anyone who relied on "run merge-dev, then my local dev is fresh" loses that; `--update-local` is the opt-in replacement and it deliberately refuses branches checked out in a worktree.
- A hard `git >= 2.38` floor (**ASSUMPTION** — asserted at runtime, not verified against an old binary).
- Two strategies means two code paths to keep tested.
- The existing conflict-cleanup test must be deleted and rewritten; its premise (`git merge origin/dev --no-edit`) ceases to exist.
- Conflict resolution moves entirely off this command: it reports conflicts and never leaves a half-merged tree for a human to resolve in place. That is the intended trade, but it does mean the operator has to create their own merge context for a conflicting branch.

**Follow-ups.** Batch the plan via `merge-tree --stdin` if the branch count ever justifies it (format and its exit-code caveat recorded in §3.4). Consider surfacing the plan as an `--json` artifact consumable by CI. Consider whether `release deliver` should share `merge-plan`.

---

## 9. Rollback / safety story

**During the plan phase.** Nothing to roll back. The only mutation is `git fetch origin --prune`, which touches `refs/remotes/*`. Ctrl-C is always safe.

**During the apply phase.** The unit of work is a single push, and a push either lands or is rejected — there is no partial push. So the recovery procedure is *inspection*, not repair:

1. Read the final report (or `structuredContent.results`). Every selected branch has a terminal state, including `not-attempted`.
2. `git fetch origin --prune && git log --oneline -1 origin/<branch>` for each branch to confirm the report against reality.
3. Re-run the command. It is idempotent by construction: already-merged branches classify as `up-to-date` (E3.6 confirms `merge-base --is-ancestor` detects this) and are skipped, and a no-op push of an identical sha is accepted as `Everything up-to-date` (E3.7).

**If a merge should not have been pushed.** Do **not** rewind the branch. Push a revert of the merge commit (`git revert -m 1 <mergeSha>`) through the normal review path, exactly as for any other unwanted commit on a shared branch. The command will never do this for you, and it will never offer to.

**If `--verify` was on and a branch failed it.** Nothing was pushed for that branch — verification is pre-push. The temp worktree is removed in a `finally`; if a crash leaves one behind, `git worktree list` shows it and `git worktree remove --force <path>` (or `git worktree prune`) clears it. No shared state is involved.

**If the command crashed anyway.** `HEAD` is restored in a `finally` and, under the plumbing strategy, was never moved in the first place. The worst case is a set of branches pushed and a set not — enumerable in one `git fetch` plus one `git log` per branch, and resolved by re-running.

---

### Appendix A — reconciliation with the team-lead evidence brief

The brief at `scratchpad/merge-dev-git-evidence.md` was produced independently on the same git 2.54.0. It agrees with everything load-bearing here (checkout-free path works, `is-ancestor` idempotency probe, FF-only push rejection, drivers honoured, `merge-tree <ours=release> <theirs=dev>` argument order — this plan uses `origin/<B> origin/dev`, which matches). Four deltas:

1. **Its E4 "the exit code is the only correct signal" is too strong, and following it would introduce a bug.** A *bad ref* also exits 1 — `merge-tree: nosuchref - not something we can merge`, no OID on stdout (E6 here). So exit 1 is ambiguous between "conflict" and "ref does not exist". Both halves of the brief's trap are real but neither alone is sufficient. The correct rule is the table in §3.4: exit 0 = clean; exit 1 **and** line 1 matches `/^[0-9a-f]{40,64}$/` = conflict; exit 1 **and** no OID = bad ref; exit 128 = fatal.
2. **Its E7 open assumption on `rerere` is now measured — and the answer is unfavourable.** `merge-tree` does *not* replay rerere resolutions, while `git merge` does (E2.4 here: same conflict, real merge prints `Resolved 'plain.txt' using previous resolution`, merge-tree emits markers). Handled by the capability probe in §3.4.
3. **Its E7 open assumption on signing is now measured, and confirms the brief's suspicion.** With `commit.gpgsign=true`, `git commit-tree` produced a commit with zero `gpgsig` headers (E3.8 here). The brief's instruction — detect and either pass `-S` or refuse — is adopted; this plan routes to `--strategy=worktree` instead of `-S`, since that also fixes rerere in one move.
4. **Its E7 note that `git worktree` experiments are blocked is not correct in this sandbox.** `bash-guard` blocked a recursive force-remove, not worktree commands. `git worktree add`, `add --detach`, and `remove --force` all ran (E4.1, E4.7). So the `git switch` collision is **measured, not assumed** — exit 128, and the exact wording is `fatal: '<b>' is already used by worktree at '<path>'` (E5.1), *not* the `already checked out at` phrasing the brief quotes. Anything that string-matches git's stderr must use the former.

One hazard neither the brief nor the original defect list contains, found here and driving §3.6: `git update-ref` on a branch checked out in a linked worktree **succeeds** and silently desyncs that worktree (E4.8), whereas `git branch -f` refuses (E4.9).

### Appendix B — evidence index

| Ref | Claim | Script |
|---|---|---|
| E1.1–E1.4 | merge-tree conflict output shape, exit 1, `--name-only`, `-z` | `exp1-mergetree.sh` |
| E1.5–E1.6 | clean merge exit 0 + tree oid; up-to-date still emits a tree (no signal) | `exp1-mergetree.sh` |
| E2.1–E2.2 | merge-tree honours `merge=union` and a custom driver, byte-identical to `git merge` | `exp2-drivers.sh` |
| E2.3 | missing driver command → exit 128 fatal | `exp2-drivers.sh` |
| E2.4 | rerere applies to `git merge`, is ignored by `merge-tree` | `exp2-drivers.sh` |
| E3.1 | commit-tree + `push <sha>:refs/heads/<b>` succeeds; local branch stays stale | `exp3-push.sh` |
| E3.2 | divergent sha push rejected, exit 1, `(fetch first)` | `exp3b-push.sh` |
| E3.5 | local `pre-push` hook runs on a sha push | `exp3b-push.sh` |
| E3.6–E3.7 | `is-ancestor` up-to-date detection; identical-sha push is a clean no-op | `exp3b-push.sh` |
| E3.8 | `commit.gpgsign` ignored by `commit-tree` (0 `gpgsig` headers) | `exp3b-push.sh` |
| E3.9–E3.10 | merge-tree works bare and off remote-tracking refs only | `exp3b-push.sh` |
| E4.3–E4.4 | `git switch`/`checkout` of a worktree-held branch → exit 128 | `exp4-worktrees.sh` |
| E4.5 | merge via `cwd` inside a linked worktree works, moves *their* HEAD | `exp4-worktrees.sh` |
| E4.7 | detached ephemeral worktree: add / merge / push / remove all succeed | `exp4-worktrees.sh` |
| E4.8 | `update-ref` silently desyncs a linked worktree (phantom deletions) | `exp4-worktrees.sh` |
| E4.9–E4.10 | `branch -f` and `fetch <b>:<b>` fail closed on a worktree-held branch | `exp4-worktrees.sh` |
| E5.1 | `git switch dev` → `fatal: 'dev' is already used by worktree at …` (D1) | `exp5-corrections.sh` |
| E5.2 | merge in a dirty worktree → exit 2, local changes would be overwritten | `exp5-corrections.sh` |
| E5.3 | `git merge --abort` with no merge → exit 128 (the D3 double-fault) | `exp5-corrections.sh` |
| E5.4–E5.5 | stale local + push → non-fast-forward rejection, unpushed merge left behind | `exp5-corrections.sh` |
| E6 | bad ref exits **1** like a conflict; `is-ancestor` on a bad ref exits 128 | `exp6-errors.sh` |
| E7 | `--stdin` batch format and its always-0 exit code | `exp7-stdin.sh` |
