# Architect review — `infra-kit release remove`

Reviewer: architect pass of a ralplan `--deliberate` consensus loop. Read-only with respect to
`docs/release-remove-command-plan.md` and all source; this file is the only artefact written.

Subject: `docs/release-remove-command-plan.md` (797 lines, Status: `pending approval`).
Tree: `main` @ `969bbe0`, dirty (~10 modified manifests, 6 untracked docs). Every line number below
was read from that tree. The CLI package root is abbreviated `«cli»` = `apps/infra-kit/cli/`.

The plan is unusually well-evidenced for a first draft — it verified more of its own claims than most,
and the two guards it identified (`deleteLocalBranch` failing open, `getReleasePRsWithInfo` being
blind to merged PRs) are real and correctly diagnosed. What follows is what survives that: four
factual corrections, one of which invalidates a load-bearing citation; a structural problem with the
IDE step that contradicts the plan's own Principle 2; and an antithesis on D7 that I think the plan
loses.

---

## 1. Claim verification

The Planner reported five claims. Verdicts: **(a) PARTIAL**, **(b) VERIFIED**, **(c) VERIFIED with
the line number corrected in the plan's favour**, **(d) VERIFIED**, **(e) VERIFIED**. Plus four
claims made inside the plan that came back wrong.

### (a) `getReleasePRsWithInfo` returns only OPEN PRs with `{branch,title,createdAt}` and cannot answer "is it merged" — **PARTIAL: true of the projection, false of the fetch**

The plan's operative conclusion holds; its stated reason does not, and the difference has a design
consequence.

**What holds.** `getReleasePRsWithInfo` (`«cli»/src/integrations/gh/gh-release-prs/gh-release-prs.ts:155-165`)
maps to exactly `{ branch: pr.headRefName, title: pr.title, createdAt: pr.createdAt }`. The two
`gh pr list` calls at `:78` and `:81` carry `--search "Release in:title" --base dev` and
`--search "Hotfix in:title" --base main`, neither with `--state`, so gh's `open` default applies.
**A merged PR is invisible to this helper. Confirmed.**

**What does not hold.** The plan (D-b, and again in D3) says the helper *"carries no `state` or
`number` field"*. The **projection** carries neither; the **fetch** carries both. `ReleasePR`
(`:11-18`) is:

```ts
interface ReleasePR {
  headRefName: string
  number: number
  state: string
  title: string
  baseRefName: string
  createdAt: string
}
```

and both `--json` field lists at `:78,:81` request `number,title,headRefName,state,baseRefName,createdAt`.
The PR number and state are fetched over the wire on every picker run and then discarded at `:155-165`.

**Consequence, and it is not cosmetic.** D3 concludes *"the merged probe must be its own call"*. That
is right for the **`--version` path** (open-only discovery cannot see a merged PR at all). It is
**wrong as a general statement**: on the **picker path** the command has already paid for a `gh pr list`
that returned the PR number, and the plan's design then pays for a second round trip to re-fetch it.
More importantly the plan gives no reason why the fix is a new private helper rather than widening
`ReleasePRInfo` — which is the change that would let `worktrees sync`, `release desc-edit` and this
command stop each re-deriving PR identity. Not blocking; see SUGGESTED 2.

### (b) `mcpExposed: false` collapses the catalog wiring — **VERIFIED, all three predicates exact**

Read from `«cli»/src/lib/command-catalog/__tests__/command-catalog.test.ts`:

- Default-deny (`:235-248`): `entry.mutating && entry.mcpExposed && entry.mcpTool?.requiresHumanConfirm !== true`,
  then filtered against `LOW_RISK_MUTATING_ALLOWLIST`. An `mcpExposed: false` entry never enters.
  **No allowlist edit needed. ✓**
- `EXPECTED_GATED_TOOLS` (`:219-226`): `entry.mcpExposed && entry.mcpTool?.requiresHumanConfirm === true`.
  **No edit needed, and a future exposure flip does red it — the plan's "feature, not an oversight"
  claim is correct. ✓**
- T3 (`:525-534`): `expect(Object.keys(MCP_TOOL_PRESENTATION).sort()).toEqual(getExposedMcpTools()…)`.
  **No presentation row. ✓**
- `allMenuEntries()` (`:24-28`) derives from `MENU_GROUPS.flatMap(getMenuGroupEntries)`, with the
  comment at `:18-23` stating the intent verbatim. **`menuGroup: 'release'` is covered with zero test
  edits. ✓**

The `release-deliver` precedent the plan quotes is also exact — `command-catalog.ts:273-282`, comment
and all.

### (c) The fourth wiring contract exists — **VERIFIED; the brief's line number was wrong and the plan already corrected it**

`«cli»/resources/root/body.md` line **10** is the release line (`- \`ik release create\` / \`release list\` / …`);
line 11 is `release merge-dev`. The task brief said `:11`; **the plan's §3.2 table says `:10` and is
right.**

- Snapshot: `bodies-snapshot.test.ts.snap:351` — confirmed by grep, exact line.
- `bodies.test.ts` — its **only** release assertion is `:149`, `expect(rendered).toContain('\`ik release merge-dev\`')`.
  That is a substring of body.md line **11**, a different line from the one being edited. **The plan's
  claim that `bodies.test.ts` needs no edit is verified.**
- `«cli»/readme.md:51` is the `release create` row of the Release group table (`:49` merge-dev,
  `:50` list, `:51` create, `:55` deliver). Adding a row there is right.

This contract is real and the plan is the only artefact that caught it.

### (d) `deleteLocalBranch` silently no-ops on the current branch — **VERIFIED**

`«cli»/src/lib/git-utils/git-utils.ts:273-280`:

```ts
export const deleteLocalBranch = async (branch: string): Promise<void> => {
  const listed = await $`git branch --list ${branch}`
  if (listed.stdout.trim().length === 0) return
  if ((await getCurrentBranch()) === branch) return
  await $`git branch -D ${branch}`
}
```

Returns `void`, two silent early returns, no signal to the caller distinguishing "absent",
"you are standing on it", and "deleted". The plan's PM-1 is a real fail-open and `branchExists` is the
right shape of fix.

The `cleanupUnpushedBranch` precedent is quoted accurately — `gh-release-prs.ts:209-211` and `:232-235`
carry both sentences verbatim, including *"a cleanup that quietly did nothing is worse than one that
says so."*

`deleteRemoteBranch` (`:290-296`) also verified: `git ls-remote --heads`, empty stdout ⇒ return, so a
network failure rejects rather than reading as "absent". The plan's idempotency table is right.

### (e) `ensureJiraVersion` already refuses `released`/`archived` — **VERIFIED**

`«cli»/src/lib/release-utils/release-utils.ts:159-166`. The throw is an `OperationError` with
`operation: 'reuse Jira fix version "…"'` and remediation *"pick a different version, or un-release it
in Jira first"*. The mirror rule in D2c is a faithful inversion.

`JiraVersion` (`«cli»/src/integrations/jira/types.ts:5-20`) carries `archived: boolean` and
`released: boolean`, so D2c's "no extra call" claim holds. `assertJiraOk` is `const` at `api.ts:29` ✓,
and it is genuinely the only classifier — exporting it rather than forking is correct.

### Additional verifications

| Claim | Verdict | Evidence |
|---|---|---|
| `fetchPRByHead`'s exact form at deliver `:68` | VERIFIED | `gh pr list --head ${head} --state all --json number,state,title --limit 1` |
| `removeReleaseWorktreeIfPresent` is exported and early-returns when absent | VERIFIED | `gh-release-deliver.ts:166`, early return `:169` |
| `removeWorktrees` reports rather than throws | VERIFIED | `remove-worktrees.ts:258-289`, doc `:249-252`: *"Failures are reported, never thrown"* |
| `assertBaseBranchSwitchable` exists with the quoted rationale | VERIFIED | `git-guard.ts:111`; doc `:104-105` — *"moves the failure ahead of the confirmation prompt instead of into the middle of a batch that has already created releases"* |
| `assertManagementContext` refuses linked worktrees **and** dirty trees | VERIFIED | `git-guard.ts:145-158`; it calls `assertCleanCheckout` (`:72`) unconditionally |
| `-v, --version <version>` is an established subcommand flag | VERIFIED | `program.ts:233` on `configureReleaseDeliver` — no Commander collision |
| `getBaseBranch` / `detectReleaseType` | VERIFIED | `release-utils.ts:31-33` (hotfix→`main`, else `dev`), `:249-251` |
| `pickReleaseBranch` calls `assertInteractive` first | VERIFIED | `release-picker.ts:52-53`; `assertInteractive` at `:35` |
| types.ts ORTHOGONAL docblock | VERIFIED | `«cli»/src/types.ts:77-84`, wording exact |
| `confirmOrExit` short-circuits on `confirmedCommand` | VERIFIED | `confirm-or-exit.ts:56-57`, and `:62-63` states the MCP chokepoint injects it into every call |

### Claims that came back WRONG

**W1 — `assertKnownTargets` does not exist. The helper is `assertTargetsExist`.**
D4's resumability argument rests on a named contrast: *"This is the opposite of `worktrees-remove`'s
`assertKnownTargets`."* A repo-wide grep for that identifier returns **zero** hits in `src/`, `docs/`
or anywhere else. The real helper is `assertTargetsExist`
(`«cli»/src/commands/worktrees-remove/worktrees-remove.ts:66`).

Good news for the plan: **the rationale it attributes is correct**, near-verbatim. The docblock at
`:59-65` reads *"Without this an unmatched version builds a path that does not exist; `removeWorktrees`
(Promise.allSettled) swallows the failure and reports a no-op as success."* So the argument survives
intact and only the identifier is wrong. But a plan whose central resumability decision cites a symbol
by name must cite the symbol that exists — a reader who greps for it concludes the contrast is
invented. Also note the docblock's own `Promise.allSettled` is stale: `removeWorktrees` uses
`Promise.all` over a `removeOne` that never rejects (`remove-worktrees.ts:261-266`). Do not propagate
that phrase.

**W2 — hoisting `removeReleaseWorktreeIfPresent` is NOT "a move, not a rewrite".**
§3.2 says: *"It is already `export`ed, so it is a move, not a rewrite."* The export is real, but the
function's failure path is merge-specific (`gh-release-deliver.ts:172-177`):

```ts
throw new OperationError(undefined, {
  operation: `remove worktree for ${releaseBranch} before merge`,
  remediation: `run manually: git worktree remove ${worktreeDir}/${releaseBranch} (use --force if uncommitted changes)`,
  stderrExcerpt: failure?.reason,
})
```

A byte-identical move makes `release remove` fail with *"remove worktree for release/v1.2.5 **before
merge**"* — a message naming an operation this command never performs. The hoist must take the
`operation` string as a parameter, and the plan must say so, or the implementer will do exactly what
§3.2 authorises. This is small but it is the difference between a correct residue report and a
confusing one, in the step the plan itself puts first.

**W3 — the plan proposes forking `fetchPRByHead` while hoisting `removeReleaseWorktreeIfPresent` for
the opposite reason.**
§3.1 declares a new `const fetchPrStatus = async (branch) => …  // gh pr list --state all`, and D3
says it is *"modelled on the one `gh-release-deliver` already makes"*. But `fetchPRByHead`
(`gh-release-deliver.ts:67-72`) **is** that call, with the identical `--state all --json number,state,title --limit 1`
shape and a docblock explaining the resume semantics. Meanwhile §3.2 hoists
`removeReleaseWorktreeIfPresent` with the stated rationale *"two callers, and the second one (this
command) must not fork it."* **The plan applies its own anti-fork principle to one helper and violates
it for another, in the same section.** `fetchPRByHead` should be hoisted alongside — the pair
(`PRStatus`, `fetchPRByHead`) into `«cli»/src/integrations/gh/`, exported, imported back by deliver.
See REQUIRED 3.

**W4 — the IDE step is structurally unverifiable, and the plan lists it as a completed mutation.**
`removeIdeWorktreeFolders` (`«cli»/src/integrations/ide/remove-ide-worktree-folders.ts:44`) carries
this docblock at `:35-43`:

> Zed has no surgical remove. The only mutation mechanism, `zed --reuse`, REPLACES the focused
> window's entire folder set … That is why the no-op on the non-interactive path reports
> `supported: true`: the capability exists, and skipping is a policy choice rather than a missing
> capability.
>
> `removed` stays empty because `--reuse` performs no diff — it **confirms no specific removal**, and
> reporting intended-but-unverified paths would be a lie.

So step 2 of D4 **cannot** be verified, by construction, and on the non-interactive path it is a
documented no-op that still reports success. That directly contradicts Principle 2 (*"Never report a
mutation the code did not verify … Every destructive step is followed by a probe that proves it
happened, or the command throws"*). It also means `runStep('ide-folders', …)` enters the residue
report's completed list on a run where nothing happened. Developed in §5.

---

## 2. Steelman antithesis

I took the five candidate lines. **Two hold and one of them is serious. Three fail** — and I state why,
because a rejected attack the plan can point at is worth as much as an accepted one.

### 2.1 The `local-deploy` precedent does NOT apply. Attack rejected.

The brief asks whether the recorded *"fix the contract in bash, the CLI is preflight/UX only"* decision
applies here. It does not, and the reason is specific rather than a matter of taste.

That decision was forced by a constraint absent here: **CI must never depend on the CLI.** The deploy
contract is split across GitHub Actions YAML and `.sh` scripts, the YAML sets variables the scripts
never set, and a CLI that owned the flow would put an npm-published binary on the critical path of
every production deploy. `release remove` has no CI consumer, no unattended caller, and no non-CLI
counterpart — it runs exactly once, interactively, at a human's request. The precedent's load-bearing
premise is "an unattended automated path already exists and must keep working without us". There is no
such path here.

Nor does the reporting-command variant survive on its own merits. Printing five commands means printing
`gh pr close`, `git branch -D`, `git push origin --delete` and a `curl` to `removeAndSwap` — and the
whole value the plan adds is the **ordering and the three refusals**, none of which a printed list can
enforce. A runbook cannot refuse. That is §1.3 Option B's argument and it is correct.

**Verdict: the plan is right to be a command. Its Option B rejection should cite the CI-dependency
distinction explicitly**, because a reviewer who remembers the local-deploy decision will otherwise
raise this, and the plan currently has no answer on the record.

### 2.2 Continue-on-error. Attack rejected, but the plan's stated reason is half wrong.

D4 justifies abort-on-first-error with: *"the six steps are one release and are causally dependent."*
Checked step by step, that claim is **overstated**:

| Pair | Causally dependent? | Evidence |
|---|---|---|
| 1 (worktree) → 4 (local branch) | **Yes** | git refuses to delete a branch checked out in another worktree; `git-utils.ts:265-272` |
| 3 (close PR) → 5 (delete remote) | **Yes, in effect** | deleting the head branch auto-closes the PR, so skipping 3 means GitHub infers an outcome we did not control |
| 2 (IDE) → anything | **No** | IDE folder removal has zero effect on git, gh or Jira |
| 3 (close PR) → 6 (Jira) | **No** | independent systems |
| 4 (local) → 5 (remote) | **No** | either can succeed alone; `deleteRemoteBranch` never reads local state |
| 5 (remote) → 6 (Jira) | **No** | independent systems |

So **two of the five adjacencies are dependent and three are not.** A continue-on-error advocate can
say truthfully: a failed IDE-folder removal (the least consequential step, and per W4 the one that
cannot even be verified) currently aborts the whole teardown, leaving a worktree gone, a PR open, a
branch live and a fix version live — a *worse* residue than if the command had pressed on.

**The plan still wins, on a stronger argument it does not make.** With continue-on-error, step 3
failing while step 5 succeeds means GitHub closes the PR by inference, with no comment, and the report
says "pr: failed, remote-branch: removed" — a residue that is *misleading*, not merely incomplete.
And on the Jira side, continue-on-error means the irreversible step executes after a failure the
operator has not seen, which is the exact inversion of Principle 1. Abort is right because **pressing
past a failure can reach the unrecoverable step on a state the operator never inspected**, not because
the steps are uniformly dependent.

**Required fix: replace the causal-dependence claim with the reachability claim**, and either drop the
IDE step out of the abort chain (best-effort, `warn`, never abort — see §5/S2) or admit that a cosmetic
step can abort a teardown.

### 2.3 Step ordering. Attack rejected; "irreversibility ascending" is right, and "cheapest-to-detect-failure first" is already satisfied.

The brief proposes two alternative principles. Both dissolve on inspection:

- *"Most likely to fail first, so an abort costs least."* This is **already true** under the plan's
  ordering, by accident of what the steps are. Step 1 (worktree removal) is empirically the most
  failure-prone — it is the only step with a documented ENOTEMPTY retry path, and the recorded hazard
  is that closing a Claude tab re-creates `<worktree>/.omc` seconds after exit. The most fragile step
  is already first. No reordering needed.
- *"Cheapest-to-detect-failure first."* The plan does something better: **it moves every detectable
  failure out of the mutation sequence entirely**, into preflight (D4 step 0 — guards, PR state, Jira
  version, issue counts, `--move-issues-to` validation, `assertBaseBranchSwitchable`). A principle
  about ordering *mutations* by detectability is only interesting when detection must happen mid-run;
  here it does not.

And the alternative the plan explicitly rejects — least-recoverable first — is refuted by its own
argument, which is correct: it maximises the probability that the one unrepairable step executes.

**Verdict: ordering is sound. §D4's rejection paragraph is one of the strongest passages in the plan.**
One gap: **the plan never states what happens if step 6 itself fails.** Steps 1-5 have completed, the
Jira version survives, and the residue is "everything gone except the fix version" — an orphaned
version pointing at a deleted branch, with a PR-body URL that now 404s from the other direction. That
is a *good* residue (repairable in the Jira UI in ten seconds) and the plan should say so, because a
reader currently has to derive it.

### 2.4 `mcpExposed: false` is asymmetric. **ATTACK HOLDS. This is the strongest objection in the review.**

The plan's D7 reasoning is internally sound and every fact it cites is verified. It is nonetheless
answering the wrong question.

**The verified asymmetry.** `release-create` is `mcpExposed: true` (`command-catalog.ts`, and it is in
`EXPECTED_EXPOSED_TOOLS`), and the plugin ships a **first-class agent affordance built specifically to
drive it**: `plugins/infra-kit/commands/release-create.md`, whose body reads

> Read the MCP resource `infra-kit://workflow/release-create` and follow it exactly … If the infra-kit
> MCP server is not connected in this session, say so and stop — do not improvise with git or gh.

So the repo does not merely *permit* agent-created releases; it has a shipped command, a served
workflow resource, a version floor and a publish gate all dedicated to making agents create releases.
Under D7, **every one of those releases is a one-way door for the agent that made it.** An agent that
mistypes a version, or cuts a release against the wrong base, or creates `1.2.5` when the user said
`1.2.6`, must hand the human a five-step manual runbook — the exact runbook §1.3 Option B was rejected
for being.

**The plan's rebuttal does not reach this.** D7's two supporting facts are:

1. *The boundary auto-confirms* (`types.ts:77-84`) — verified, and true of **every** exposed mutating
   tool including `release-create`, `worktrees-remove`, `local-deploy-all` and
   `release-deploy-selected`. If auto-confirmation disqualified a tool from exposure, the catalog's
   entire exposed mutating set would be disqualified. It does not discriminate.
2. *The two-phase gate is degraded* (v1-SDK clients reject the `structuredContent` payload) — verified
   as a recorded repo fact, and it **fails safe: the tool never runs**. But the catalog already ships
   five gated tools under that same degradation (`EXPECTED_GATED_TOOLS` includes `worktrees-remove`,
   `env-clear`, `local-deploy-all`, `local-deploy-selected`). Declining to add a sixth because the gate
   is degraded is a statement about the gate, not about this command — and if it is a real reason, it
   is a reason to stop exposing the five, not to single out the sixth.

**The `release-deliver` precedent is weaker than it reads.** Deliver is CLI-only because it merges to
prod and deploys — it is the *most* consequential command in the catalog and has no agent-facing
counterpart of any kind. `release remove` is the inverse of a command the plugin actively pushes agents
toward. The precedent that actually matters is not deliver; it is **`worktrees-remove`**, which is
destructive, exposed, gated, and additionally carries `assertMcpRemovalInput`
(`worktrees-remove.ts:39-57`) — an MCP-only guard that refuses `all=true` and *requires* explicit
`versions`, with the docblock *"guard the shared handler too so a direct/agent call can never fan out
to every worktree."* That is the in-repo pattern for "destructive, but agents legitimately need it":
**expose it, gate it, and add an MCP-only narrowing guard.** `release remove` is already single-target
by D6, so it needs only the first two.

**Where the attack stops.** The Jira delete genuinely is unrecoverable in a way no `worktrees remove`
step is, and I do not think exposure should ship in v1 against an **unmeasured** API (U1-U3). So the
honest position is not "D7 is wrong" but **"D7 is under-argued and mis-scoped"**. Synthesis in §7/S4.

### 2.5 Refusing on attached issues makes the command useless when most needed. **Attack rejected — but the plan's blast radius is understated by a factor.**

The brief's framing — *"a mistakenly-created release accumulates tickets fast"* — is the weakest of the
five, because the plan already ships the escape hatch: `--move-issues-to <version>`, validated in
preflight. The operator is not blocked; they are made to name a destination. Given that removing the
version otherwise strips `fixVersion` from N real tickets with no readable record of the prior value,
requiring a destination is proportionate. Reject.

**But two real defects sit inside D2b that the attack points at without naming:**

1. **The refusal message is wrong about what the counts mean.** D2b's text renders
   `23 issue(s) attached (21 fix, 2 affects)` — presenting `issuesFixedCount + issuesAffectedCount` as a
   sum of distinct issues. They are counts over **two different fields** and an issue can carry the
   version in both, so `21 + 2` is an upper bound on distinct issues, not a total. The refusal should
   report the two counts separately and never add them.
2. **`--move-issues-to` moves only `fixVersion`.** `RemoveJiraVersionParams` declares both
   `moveFixIssuesTo` and `moveAffectedIssuesTo`, but the CLI exposes **one** flag and D2b's chosen row
   says only *"passes `moveFixIssuesTo` through"* (and T2(d) asserts only that). So an operator who
   passes `--move-issues-to v1.2.6` on a version with `issuesAffectedCount > 0` silently loses the
   affects links — the precise data loss the guard exists to prevent, through the escape hatch the
   guard offers. Either map one flag to **both** parameters, or refuse when `issuesAffectedCount > 0`
   and the flag cannot address it. **Blocking — this is a data-loss hole inside the mitigation for
   PM-2.**

---

## 3. The three UNVERIFIED Jira claims (U1-U3)

**The gate is necessary but not sufficient, and the plan does not say what happens if it fails.**

What the plan does right: it names all three, states the measurement (one `curl` each against a
throwaway version), forbids proceeding past the Jira step until U1 and U2 are measured, and requires
the result recorded in a comment following the `docs/jira-401-misreported-as-404-plan.md` §1.1
precedent. That is the correct discipline and it is more than most plans do.

**What is missing: the gate blocks the step, but the design already depends on the answers.**

- **If U2 is false** (no `relatedIssueCounts` endpoint, or it does not return those field names), then
  **D2b's chosen option is unimplementable as specified.** The refusal is defined by a count the CLI
  cannot obtain. Fallback: `GET /rest/api/3/search?jql=fixVersion=<id>` returning `total`, which is a
  different endpoint, a different auth scope (search vs. project-admin) and a different failure mode
  (JQL syntax, permission scoping to the project). Reachable, but it is a **redesign of D2b's probe**,
  not a swap.
- **If U1 is false** — specifically if `removeAndSwap` with an **empty body** does something other than
  "delete and unset" — then D2a's chosen option loses its stated advantage ("one code path serves both
  the plain delete and the swap") and the fallback is the deprecated `DELETE /version/{id}` **whose own
  behaviour is U3, also unmeasured**. Both fallbacks for the primary path are unverified simultaneously.
- **The worst case is not "the endpoint 404s".** It is `removeAndSwap` with an empty body being
  *permissive in an unexpected direction* — e.g. defaulting a swap target, or 400-ing on an absent
  body. A 404 fails loudly at measurement time; a semantic surprise is discovered by an operator whose
  tickets moved somewhere they did not choose.

**Judgement: the gate as written is a stop-work order on the implementer, which is right, but it leaves
the *plan* dependent on an unproven shape.** The plan needs a stated fallback so a failed measurement
produces a known next step rather than a re-planning cycle. My recommendation (REQUIRED 5):

> If U2 is false, D2b's count probe becomes a JQL `total` and the refusal text loses the fix/affects
> split. **If U1 is false, ship v1 with the Jira step behind `--skip-jira`-by-default**: perform steps
> 1-5, and *print* the version id, name and URL with the exact `curl` (or Jira UI path) to remove it by
> hand. That degrades cleanly to the one artefact a human can safely delete in ten seconds, keeps the
> five verifiable steps, and does not block the whole command on an Atlassian API question.

That fallback also happens to be the honest v1 shape if the D7 debate (§2.4) resolves toward exposure —
see §7/S4.

---

## 4. The resumability design: `--version` with no known-target validation

**Judgement: sound, and the plan's reasoning is correct — but it is one guard short, and the guard it
is short of is the one it already knows how to write.**

The mechanism is real. `resolveReleaseBranch` (`release-utils.ts:285-294`) is pure string formatting
over `parseReleaseRef` + `formatBranchName`, with no lookup of any kind; it throws only on a
*malformed* ref, with remediation *"pass a version (e.g. "1.2.5") or a release name"*. So
`--version 1.2.5` addresses a half-removed release exactly as the plan says.

And the contrast with `assertTargetsExist` is substantively right (modulo W1's naming). There, an
unmatched name builds a path that does not exist and `removeWorktrees` reports the no-op as success —
validation is required *because the downstream fails open*. Here every downstream no-op is a verified
early return (`deleteLocalBranch` `:275`, `deleteRemoteBranch` `:292`, `removeReleaseWorktreeIfPresent`
`:169`, PR absent, Jira version absent). **The asymmetry is genuine, not a rationalisation.**

**The failure the brief predicts is real and the plan does not close it.** Typo `--version 1.2.6` for
`1.2.5` and every step reports "absent/skipped" and the command **exits 0 having done nothing**, with a
success report. That is not a confusing error — it is worse, a confident success. It is the same class
of fail-open the plan spends D5 and Principle 2 closing on the branch side, arriving through the door
the plan deliberately left open.

**The fix does not require re-adding validation, and must not.** Add a **terminal assertion on the plan
object**: if preflight resolves *no evidence the release ever existed* — no worktree, no PR in any state
(the `--state all` probe already runs), no local branch, no remote branch, and no Jira version — then
**refuse**, with remediation naming `release list` and pointing out that a genuinely-already-removed
release is indistinguishable from a typo. This preserves every resume case (any *one* surviving artefact
permits the run) while turning the total-miss case from silent success into a refusal. It costs one
predicate over data preflight has already gathered, and it belongs in D4 next to the deliberate
omission it complements. **REQUIRED 4.**

---

## 5. Principle violations

The plan states five principles. Checked against its own decisions:

**P1 — "Irreversibility is the ordering axis." Upheld.** Verified against the step table; see §2.3.

**P2 — "Never report a mutation the code did not verify." VIOLATED, once, structurally.**
Step 2 (IDE worktree folders) **cannot** be verified. `remove-ide-worktree-folders.ts:42-43` states it
outright: *"`removed` stays empty because `--reuse` performs no diff — it confirms no specific removal,
and reporting intended-but-unverified paths would be a lie."* And `:35-40` documents that the
non-interactive path is a deliberate no-op that still reports `supported: true`. So `release remove`
will enumerate `ide-folders` among the "completed" steps in its residue report (D4's error text lists
exactly that vocabulary) on runs where nothing was removed and nothing could be verified. The plan's
own Principle 2 forbids that.

The integration is not wrong — its docblock is a model of honesty — but the plan inherits an
unverifiable step into a report whose stated contract is verified-only. **Fix: demote step 2 out of the
verified sequence.** Make it best-effort: run it, `warn` on failure, **never abort**, and report it as
`ide-folders: attempted` rather than `removed`. This simultaneously repairs §2.2's real complaint (a
cosmetic step aborting a teardown) and restores P2. **REQUIRED 1.**

**P3 — "Refuse rather than guess when the blast radius is other people's work." Upheld in the three
named cases, with one gap.** The `--move-issues-to` / `issuesAffectedCount` hole (§2.5) is exactly this
principle failing at the escape hatch rather than at the guard.

**P4 — "Resumability over batching." Upheld, one guard short** (§4).

**P5 — "Symmetry with `release create`, not with `worktrees remove`." Selectively applied.**
The plan invokes symmetry-with-create for D2c (mirror `ensureJiraVersion`'s refusal) and D1 (flat id
without the `gh-` prefix) — both good. It then invokes *asymmetry* with create for D7 (create is
exposed; remove is not) **without noticing that this is the same principle pointing the other way**.
P5 says "create is the operation this inverts". An inverse that agents cannot reach when the forward
operation ships with a dedicated plugin command is not symmetry. The plan should either argue the
exception on the record or follow its own principle (§2.4, §7/S4).

Two smaller inconsistencies:

- **§3.1's `fetchPrStatus` vs §3.2's hoist** (W3) — the anti-fork rule applied to one helper and
  violated for another in adjacent sections.
- **§3.2's "a move, not a rewrite"** (W2) — a byte-identical move ships a wrong error message.

---

## 6. The real tradeoff tension

### T1 — Preflight-completeness vs. time-of-check/time-of-use, and the plan picks completeness without naming the cost

Two of the plan's own commitments collide:

- **D4 step 0** pushes *everything* checkable into preflight: guards, PR state, Jira version, issue
  counts, `--move-issues-to` validation, `assertBaseBranchSwitchable`, then the confirm. The stated
  reason is `assertBaseBranchSwitchable`'s own docblock — *"moves the failure ahead of the confirmation
  prompt instead of into the middle of a batch."*
- **Principle 2** demands each destructive step be *proved* at the moment it runs.

Between preflight and step 6 sits an **interactive confirmation prompt of unbounded duration**, plus
five mutations against two remote systems. Every preflight fact is a claim about the past by the time
it authorises the irreversible step. Concretely: the issue-count probe runs at step 0; the delete runs
at step 6. A teammate attaching a ticket to that fix version in between — the ordinary case for a
release still open enough to be worth removing — is silently overwritten, because the guard that would
have refused already passed.

The repo **knows** about this class of problem and has already split a guard for it. `git-guard.ts:60-66`:

> Split out of `assertManagementContext` because tree cleanliness is the *volatile* half of that
> guard: it is the only leg that can stop being true between the check and the mutation it authorizes,
> **so it has to be re-assertable on its own immediately before each destructive step.**

The plan cites `assertCleanCheckout`'s existence but never applies its lesson, and never re-asserts
anything. **What is lost by picking completeness:** the issue-count guard — the mitigation for PM-2,
the plan's own worst-case incident — is a TOCTOU check on cross-system state with a human-length window
in the middle. That is not a hypothetical race; it is the ordinary workflow of a team that files
tickets against an open release.

The reverse choice loses too: checking at step 6 means an operator can answer the confirm, watch five
steps succeed, and *then* be refused — the exact failure `assertBaseBranchSwitchable` exists to prevent,
with the added insult that the refusal now arrives on a release whose branch and PR are already gone.

### Synthesis for T1 — re-probe, do not re-guard

The tension dissolves because **the two checks are asking different questions and only one of them
needs to be a guard.**

- **Preflight keeps the guard.** Refuse on `count > 0`, exactly as D2b specifies. Its job is to fail
  *before consent*, which is what makes the confirm text honest and what stops the operator authorising
  something they would not have.
- **Step 6 gets a re-probe, not a second guard.** Immediately before `removeJiraVersion`, call
  `getVersionRelatedIssueCounts` again and compare to the preflight value. **Equal** ⇒ proceed silently
  (the overwhelming case; the operator sees nothing new). **Changed** ⇒ abort *before* the delete, with
  a residue report saying steps 1-5 completed, the version survived, and the count moved from N to M
  during the run. That is a clean, fully-repairable residue: re-run and the guard fires properly.

Cost: one extra API call on the path that is about to make an irreversible one — trivially justified.
It follows the repo's existing volatile-guard precedent exactly, and it is the only place in the design
where a stale fact authorises an unrecoverable act. **SUGGESTED 1** rather than REQUIRED only because
D2b's refusal already makes the common case safe; the re-probe closes the window rather than opening a
new capability.

---

## 7. Synthesis — concrete section-level edits

Each keeps Option A, its footprint, and its file list. No new phase.

**S1 — demote the IDE step out of the verified chain** *(fixes P2, and §2.2's real complaint)*. D4:
step 2 becomes best-effort — run, `warn` on failure, never abort; residue vocabulary reports
`ide-folders: attempted`, never `removed`. Cite `remove-ide-worktree-folders.ts:42-43` as the reason.
Add a test case to T5 asserting a throwing `removeIdeWorktreeFolders` does not stop steps 3-6.

**S2 — replace D4's causal-dependence claim with the reachability claim.** Two of five adjacencies are
dependent (1→4, 3→5) and the plan should say which. The argument that carries abort-on-first-error is:
*continuing past an unseen failure can reach the unrecoverable step on a state the operator never
inspected.* Add the step-6-failure residue explicitly (orphaned fix version, repairable in the Jira UI
in ten seconds) so a reader does not have to derive it.

**S3 — close the `--move-issues-to` affects-links hole** *(§2.5)*. Either map the one flag to **both**
`moveFixIssuesTo` and `moveAffectedIssuesTo`, or refuse when `issuesAffectedCount > 0` because the flag
cannot address it. Amend T2(d) to assert whichever is chosen. Also stop summing the two counts in the
refusal text — report them separately, since an issue can carry the version in both fields.

**S4 — re-argue D7 on the record, and pick one of two shapes.** The auto-confirm and degraded-gate facts
are true of the whole exposed mutating set and do not discriminate; the `release-deliver` precedent is
weaker than the `worktrees-remove` one (destructive, exposed, gated, plus an MCP-only narrowing guard at
`worktrees-remove.ts:39-57`); and the plugin ships `commands/release-create.md` specifically to make
agents create releases. Two acceptable resolutions:

- **(i) Keep CLI-only, and say the real reason:** *"exposure is deferred until U1-U3 are measured,
  because a destructive tool must not reach agents through an unproven API. Revisit once the Jira
  semantics are recorded."* Honest, dated, and re-openable — and it makes the pinned `EXPECTED_GATED_TOOLS`
  red-on-flip a scheduled event rather than a hypothetical one.
- **(ii) Expose it, gated, minus Jira.** `mcpExposed: true`, `requiresHumanConfirm: true`, and the Jira
  step **omitted over MCP** — an agent can undo the five reversible artefacts it created and is told to
  hand the fix-version URL to a human. This is exactly `worktrees-remove`'s shape and closes the
  asymmetry without ever putting an unrecoverable call behind an auto-confirming boundary.

I prefer **(ii)** on the merits and would accept **(i)** as written. What is not acceptable is the
current text, which reads as settled while resting on two facts that do not discriminate.

**S5 — state the U1/U2 fallback designs** *(§3)*. U2 false ⇒ JQL `total`, and the refusal loses the
fix/affects split. U1 false ⇒ ship v1 with the Jira step skipped by default, printing the version id,
name, URL and the manual removal path. Without these the gate is a stop-work order with no next step.

**S6 — add the "no evidence at all" refusal** *(§4)*. Keep the deliberate omission of target validation;
add a terminal preflight predicate — no worktree **and** no PR in any state **and** no local branch
**and** no remote branch **and** no Jira version ⇒ refuse, naming `release list`. Extend T3 with the
typo case (`--version 9.9.9` against an untouched repo ⇒ throws, not exit 0).

**S7 — hoist `fetchPRByHead`, not fork it** *(W3)*. Move `PRStatus` + `fetchPRByHead` to
`«cli»/src/integrations/gh/`, export both, import back into `gh-release-deliver`. Delete `fetchPrStatus`
from §3.1's sketch. Same rationale the plan already gives for `removeReleaseWorktreeIfPresent`.

**S8 — parameterise the hoisted worktree helper's `operation` string** *(W2)*. §3.2's "a move, not a
rewrite" is false: `gh-release-deliver.ts:172-177` hardcodes *"remove worktree for X **before merge**"*
and a merge-specific remediation. Say so in the row.

**S9 — correct the citations.** `assertKnownTargets` → **`assertTargetsExist`**
(`worktrees-remove.ts:66`), and do not repeat its docblock's stale `Promise.allSettled` (the code is
`Promise.all` over a never-rejecting `removeOne`). Amend D-b and D3: `ReleasePRInfo` carries no
`state`/`number`; `ReleasePR` (`:11-18`) carries both and the fetch requests both — the projection at
`:155-165` discards them.

**S10 — add the CI-dependency distinction to §1.3 Option B** *(§2.1)*. The local-deploy "CLI is
preflight/UX only" decision was forced by *CI must never depend on the CLI*. No CI or unattended path
consumes release teardown, so the precedent does not transfer. One sentence, and it pre-empts the
objection a reviewer who remembers that decision will otherwise raise.

**S11 — note that declining the confirm exits 0.** `confirm-or-exit.ts:71-77` calls `process.exit(0)`
on decline (no `throwOnDecline` unless the caller opts in). Consistent with the other six callers, but
worth one line in §5.5 so nobody scripts `release remove && …` expecting a decline to be non-zero.
Related recorded hazard: `process.exit(0)` there skips every `finally`, so the command must acquire no
resource before the confirm — which the D4 step-0 ordering already satisfies. State it so a future edit
does not break it.

---

## VERDICT: SOUND WITH CHANGES

The shape is right. Single-target, guard-first, ascending-irreversibility, abort-with-residue-report is
the correct design for this problem, and the two fail-opens the plan found (`deleteLocalBranch`,
merged-PR blindness) are real defects that a naive implementation would have shipped. The step ordering
survives every alternative I could construct against it. What blocks approval is a data-loss hole
inside the plan's own PM-2 mitigation, one structural violation of its own Principle 2, a silent-success
path it opened deliberately and did not close, and an exposure decision that rests on two facts which do
not discriminate.

### REQUIRED (blocking)

1. **Demote the IDE-folder step out of the verified chain.** *(amends D4 step 2, §3.1 handler body item
   7, and the residue-report vocabulary)* `removeIdeWorktreeFolders` cannot verify a removal by
   construction (`remove-ide-worktree-folders.ts:42-43`) and is a documented no-op on the
   non-interactive path (`:35-40`). Best-effort: `warn`, never abort, report `attempted` not `removed`.
   Add the non-aborting case to T5. As written the plan violates its own Principle 2. → S1

2. **Close the `--move-issues-to` affects-links hole.** *(amends D2b, and T2(d))* One flag maps to
   `moveFixIssuesTo` only, so a version with `issuesAffectedCount > 0` loses its affects links through
   the very escape hatch that exists to prevent data loss. Map the flag to both parameters or refuse
   when it cannot address the affected count. Also stop rendering `21 fix + 2 affects` as `23 issues` —
   the counts are over different fields and an issue may appear in both. → S3

3. **Hoist `fetchPRByHead` instead of forking it, and parameterise the worktree helper's `operation`
   string.** *(amends §3.1's `fetchPrStatus`, §3.2's `gh-release-deliver` row)* `fetchPRByHead`
   (`gh-release-deliver.ts:67-72`) already makes the exact `--state all` call D3 specifies; forking it
   contradicts the anti-fork rationale the plan gives one section later for
   `removeReleaseWorktreeIfPresent`. And that hoist is **not** "a move, not a rewrite" — `:172-177`
   hardcodes a merge-specific operation string and remediation. → S7, S8

4. **Add the "no evidence at all" refusal.** *(amends D4's resumability paragraph, and T3)* Keep the
   deliberate omission of target validation; add a terminal preflight predicate so a typo'd `--version`
   that matches no worktree, no PR in any state, no local branch, no remote branch and no Jira version
   **refuses** instead of exiting 0 with a full "everything skipped" success report. → S6

5. **State the U1/U2 fallback designs.** *(amends D2's UNVERIFIED block and §8.5)* The gate correctly
   stops the implementer, but the plan's design already depends on the answers: U2 false makes D2b's
   probe unimplementable as specified, and U1 false falls back to `DELETE /version/{id}`, whose own
   behaviour is U3 — also unmeasured. Name the JQL-`total` fallback for U2, and for U1 the "ship steps
   1-5, print the manual Jira removal" degradation. → S5

6. **Correct the citations.** *(amends D4 and D-b/D3)* `assertKnownTargets` does not exist anywhere in
   the repo — the helper is `assertTargetsExist` (`worktrees-remove.ts:66`); its rationale is as the
   plan describes, but a named citation must name the real symbol. And `getReleasePRsWithInfo`'s blind
   spot is the **projection** at `:155-165`, not the fetch: `ReleasePR` (`:11-18`) carries `number` and
   `state`, and both `gh pr list` calls request them. → S9

### SUGGESTED (non-blocking)

1. **Re-probe the issue count immediately before the Jira delete** — equal ⇒ proceed silently, changed
   ⇒ abort before the irreversible call. Follows `assertCleanCheckout`'s split-the-volatile-guard
   precedent (`git-guard.ts:60-66`), and closes the only TOCTOU window in the design where a stale fact
   authorises an unrecoverable act. *(amends D4 step 6)* → §6/T1

2. **Widen `ReleasePRInfo` to carry `number` and `state`** rather than paying for a second `gh pr list`
   on the picker path — the data is fetched and discarded today, and three commands re-derive PR
   identity. Scoped as a follow-up if it grows. *(amends §8.6)* → §1(a)

3. **Re-argue D7 on the record.** Auto-confirmation and the degraded gate are true of the entire exposed
   mutating set and do not single this command out; `worktrees-remove` is the closer precedent than
   `release-deliver`; and the plugin ships `commands/release-create.md` to make agents create the very
   thing they could not remove. Either defer exposure explicitly pending U1-U3, or expose it gated with
   the Jira step omitted over MCP. *(amends D7 and §8.3)* → S4

4. **Add the CI-dependency distinction to the Option B rejection** so the local-deploy precedent is
   answered rather than left to a reviewer's memory. *(amends §1.3)* → S10

5. **Say what a step-6 failure leaves** (orphaned fix version, everything else gone, repairable in the
   Jira UI) — currently the only step whose residue a reader must derive. *(amends D4)* → S2

6. **Note that declining the confirm exits 0** and skips every `finally`, so the D4 step-0 ordering
   (acquire nothing before the confirm) is load-bearing rather than incidental. *(amends §5.5)* → S11

---

# Round 2 — re-review of revision 2

Scope: focused verification of the six repairs, not a fresh review. Round-1 content above is left
intact as the record of how the design got here, including the two citations of my own that were
wrong.

**Headline.** Five of my six REQUIRED items are discharged cleanly, several with better designs than I
asked for. What blocks approval now is **not** a design defect: it is that the plan's citation base
(`969bbe0`) is no longer the tree an implementer will edit, and the numbers that moved are precisely
the ones D7's new catalog wiring depends on.

---

## R2.0 The citation base is stale — and it moved under exactly the wiring D7 added

This is the finding that matters most this round, and it is not visible from the plan alone.

`apps/infra-kit/cli/src/lib/command-catalog/command-catalog.ts` and its test are **modified in the
working tree and uncommitted**:

```
 M apps/infra-kit/cli/src/lib/command-catalog/__tests__/command-catalog.test.ts
 M apps/infra-kit/cli/src/lib/command-catalog/command-catalog.ts
     2 files changed, 20 insertions(+), 2 deletions(-)
```

`git log -S 'setup-deps-status'` over that directory returns **nothing** — the change exists only in
the working tree. It adds a 24th exposed tool, `setup-deps-status` (almost certainly the in-flight
`docs/archive/mcp/mcp-setup-dependency-plan.md` work, which was already untracked at this session's start).

Measured both ways:

| Artefact | HEAD `969bbe0` | Working tree | Plan says |
|---|---|---|---|
| `EXPECTED_EXPOSED_TOOLS` entries | 23 | **24** (`setup-deps-status` first) | 23 |
| length assertion | `toHaveLength(23)` at `:87` | **`toHaveLength(24)` at `:88`** | bump `23 → 24` at `:87` |
| `it(...)` title | "expected 23 MCP tools" `:79` | "expected 23 MCP tools" **`:80` — already stale vs. its own assertion** | not mentioned |
| worktrees-remove comment | `:65-68` | `:66-69` | `:65-68` |
| `EXPECTED_GATED_TOOLS` | `:205` | `:206` | `:205-227` / `:205-217` |
| T3 correspondence | `:526-534` | `:528-536` | `:526-534` |

**The plan is internally correct against its declared base.** Every one of those citations is exact at
`969bbe0`; I re-read the HEAD blob to confirm rather than assume. But the implementer edits the working
tree, where the bump is **24 → 25**, every cited line is **+1**, and there is a pre-existing trap
waiting: the `it(...)` title says *23* while the assertion already says *24*, so an implementer
following §3.2 mechanically will produce a test named for 23, asserting 25, over a list of 25.

**Two counts the plan leans on, checked against both trees.** I parsed the catalog entries rather than
trusting either figure:

```
HEAD 969bbe0 : entries=37  exposed=23  mutating+exposed=12
WORKING TREE : entries=38  exposed=24  mutating+exposed=12
```

- **The plan's "12 mutating" is RIGHT; the brief's recorded 13 is wrong.** Confirmed in both trees —
  `setup-deps-status` is read-only, so the mutating count is unchanged. The twelve are `merge-dev`,
  `release-create`, `release-desc-edit`, `release-deploy-all`, `release-deploy-selected`,
  `local-deploy-all`, `local-deploy-selected`, `worktrees-add`, `worktrees-remove`, `worktrees-sync`,
  `env-load`, `env-clear`. D-c's argument stands on the correct number.
- **"12 of 23" should read "12 of 24"** in the working tree. The ratio argument is unaffected.

This is a coordination fact, not a design defect, but it is blocking in the ordinary sense: applied
as written, §3.2's catalog-test row produces a red test. → **R2-REQUIRED 1**

---

## R2.1 D7 reversal — wired, and the MCP narrowing is coherent

**Wiring: verified against the real predicates** (allowing for the +1 drift above).

| Claim | Verdict |
|---|---|
| `EXPECTED_EXPOSED_TOOLS` + length bump | **Correct at HEAD, off by one in the tree** (R2.0) |
| `EXPECTED_GATED_TOOLS` derived from `mcpExposed && requiresHumanConfirm === true` | **VERIFIED** — predicate exact, and `release-remove` must be added or the pinned list reds |
| `MCP_TOOL_PRESENTATION` row required, with an `openWorld` justification | **VERIFIED** — T3 asserts exact bidirectional correspondence with `getExposedMcpTools()` |
| `LOW_RISK_MUTATING_ALLOWLIST` needs **no** edit because `requiresHumanConfirm: true` satisfies default-deny | **VERIFIED** — the filter is `mutating && mcpExposed && requiresHumanConfirm !== true` |
| AC-23 inverts: the snapshot must now **gain exactly one** tool | **Correct** — the single `exports[...]` key is the exposed surface |
| The catalog says so in its own words | **VERIFIED verbatim** at `command-catalog.test.ts:65-68` (HEAD) / `:66-69` (tree): *"worktrees-remove IS exposed — git protects tracked work and its own invariants (no MCP all=true, error on unmatched target) contain the residual risk."* |

One rhetorical miscount: D7 says *"the catalog already ships **five** gated tools under that same
degradation."* `EXPECTED_GATED_TOOLS` holds **eight** — `gh-merge-dev`, `release-create`,
`gh-release-deploy-all`, `gh-release-deploy-selected`, `env-clear`, `worktrees-remove`,
`local-deploy-all`, `local-deploy-selected`. The argument gets *stronger* with the right number, so
this is non-blocking, but it is a third document in a row miscounting something it uses as evidence.

**Is a 5-of-6 MCP surface coherent, or does it relocate the asymmetry I objected to?** It does not
relocate it, and the distinction is substantive rather than verbal.

My round-1 objection was that an agent could create an artefact set through a dedicated plugin command
and then face a **five-step manual runbook** — the exact thing Option B was rejected for. Under
revision 2 the agent tears down all five reversible artefacts and hands back one URL for a ten-second
UI action, reported in the tool result as `jira: 'manual'` with the version's id and name. The residue
is bounded, named, and machine-readable. That is a different object from a runbook.

The remaining asymmetry is real, and it is the one the whole design is organised around: the Jira
delete is the single act with no repair path, so keeping it human-only is the irreversibility principle
applied consistently rather than an arbitrary carve-out. §8.5 names the consequence honestly
(*"the MCP path deliberately leaves an orphaned Jira fix version every time"*). `assertMcpRemoveInput`
refusing `moveIssuesTo` and `skipJira` is right for the stated reason — accepting a reassignment flag
on a path that never calls Jira would let an agent believe it moved issues it never touched — and
applying it to the shared handler rather than only the `inputSchema` mirrors
`assertMcpRemovalInput` (`worktrees-remove.ts:39-57`), which is the correct precedent.

One ergonomic gap, non-blocking: `jira: 'manual'` is discoverable only in the **result**. An agent
deciding whether to call the tool should learn from the **description** that the Jira step will not
run, otherwise it may reasonably report "release removed" without surfacing the URL. → R2-SUGGESTED 1

**Verdict: D7 is genuinely reversed, not merely re-worded.** My round-1 SUGGESTED 3 (option ii) is
adopted in full.

---

## R2.2 The IDE step — the plan's reading of the module is exactly right

I re-read `remove-ide-worktree-folders.ts` end to end. Every citation in D4 step 2 and D8 is exact —
this is the most accurately-cited section of the document.

- **`removeFromCursor` at `:92`**, surgical, returns a real `removed` list from
  `removeFoldersFromCursorWorkspace`, catches its own errors at `:109` and warns. **It does not read
  `allowEditorRelaunch` at all** (`RemoveFromCursorArgs` has no such field), so the Cursor path does
  full, verified work under `false`. ✓
- **`removeFromZed` at `:129`**, gated `if (!allowEditorRelaunch)` → `logger.info` at `:133-135`
  (*"Zed folder removal skipped (no interactive session); close removed worktree folders in Zed
  manually if needed."*) → `return { provider: 'zed', supported: true, removed: [] }`. ✓
- **The module docblock at `:30-35` states the plan's conclusion before the plan does:** *"Zed's path
  is DESTRUCTIVE, so it fires ONLY when `allowEditorRelaunch` is true … on the non-interactive/MCP
  path it is a deliberate no-op (`supported: true`, `removed: []`) with an info message. Zed's
  `removed` is ALWAYS `[]`."*
- **`removedWorktrees.length === 0 → return []` at `:49`.** ✓

**So `false` does make the Zed outcome a *declared* skip rather than a silent one** — it is an explicit
branch that logs, returns a typed outcome, and prints a manual-close hint. That is materially different
from `removed: []` arriving from the `--reuse` path, where the same empty array means "we fired a
destructive relaunch and cannot say what it did".

**The `--yes` argument is verified and is the sharpest point in the section.** `worktrees-remove.ts:178`
passes `allowEditorRelaunch: !confirmedCommand`, with the comment at `:170-172`: *"Only there do we let
Zed's destructive `--reuse` relaunch fire; MCP/--yes runs (confirmedCommand=true) and worktrees-sync
never relaunch an editor window."* So a plan that copied `!confirmedCommand` would, on the exact `--yes`
invocation PM-1 narrates, produce a **guaranteed** Zed no-op while reporting a mutation. Choosing
`false` always removes the gap on every path instead of on some.

**Is the single exemption from abort-on-first-error justified, or does it reopen the reachability
argument?** It is justified, and it does not reopen it — for a reason stronger than the plan gives.

Reachability says: do not continue past an unseen failure, because you may reach the unrecoverable step
on a state nobody inspected. For step 2 to threaten that, a Cursor-workspace edit would have to change
the state steps 3-6 act on. It cannot — `.code-workspace` has zero bearing on `gh`, `git` or Jira. And
empirically the exemption is nearly unreachable: `removeFromCursor` already swallows its own failures
(`:109-115`, returning `removed: []`), so a throw escaping `removeIdeWorktreeFolders` could only come
from `getInfraKitConfig()`/`resolveConfiguredIdes` — a config fault the handler already exercised at
step 2 of its own ordering. The exemption is well-founded and narrow.

It also does not violate Principle 2, because step 2 reports the actual
`RemoveIdeWorktreeFoldersOutcome[]` rather than a bare "completed". **My round-1 REQUIRED 1 is
discharged, and the plan went further than I asked by deciding the parameter instead of only demoting
the step.**

---

## R2.3 Tip SHAs — the reasoning holds and row 5 is now honest

All three grounds for rejecting *"make `deleteLocalBranch` log the sha"* check out:

1. **The output really is discarded.** `git-utils.ts:279` is ``await $`git branch -D ${branch}` `` with
   no assignment. Revision 1's row 5 promised a recoverability the code does not preserve; the plan is
   right to call that Principle 2 inverted.
2. **Touches no shared primitive.** Preflight capture is local to the new command; the alternative
   changes a helper `gh-release-deliver` and `cleanupUnpushedBranch`-adjacent code paths depend on.
3. **The decisive reason is the third, not the first two.** `(was <sha>)` being localizable is
   defensible but arguable; *"absent when the branch is already gone"* is not — and that is the
   **resume** case, which is this command's primary use case. A recovery mechanism that fails exactly
   on the second run would be worthless.

**Is preflight capture sufficient?** For `localTipSha`, yes: nobody else can move your local branch,
the tree is clean-guarded, and D5 switches away from it before deleting.

For `remoteTipSha` there is a narrow window — a teammate pushing between preflight and step 5 would
make the printed SHA stale, and `deleteRemoteBranch` runs a plain `git push origin --delete` that would
discard the new tip silently. **Row 5 is still honest** (it says the SHA is what preflight captured),
and the window is vanishingly small on a branch being torn down. Worth noting only because the free fix
already exists: `deleteRemoteBranch` runs `git ls-remote --heads origin <branch>` at `:291` immediately
before deleting and **discards the SHA**, testing only `.trim().length === 0` — the same fetch-then-throw-away
pattern as `ReleasePRInfo`. Capturing it there costs nothing and closes the window. → R2-SUGGESTED 2

Row 5 as rewritten (*"Neither local nor remote. Recoverable only from the tip SHA captured in step 0
and printed in the report, within git's gc window"*) is accurate. **Discharged.**

---

## R2.4 The abort rationale is deployed correctly

The plan now concedes *"only 1→4 and 3→5 are dependent; 2→anything, 3→6, 4→5 and 5→6 are not"* — which
matches my pairwise table exactly (I said two of five adjacencies; the plan names the same two) — and
rests the argument on reachability. That is the argument I identified as the winning one, stated in the
plan's own words rather than transcribed.

It does not collide with the step-2 exemption, per R2.2: step 2 cannot reach step 6 in the sense
reachability cares about, and the plan says so in the same paragraph. The one thing that would have been
a collision — exempting a step whose failure leaves state later steps act on — is not what was exempted.

T5(c) pins it (*"a throwing `removeIdeWorktreeFolders` does not stop steps 3-6"*) and AC-19 states it as
an acceptance criterion. **Discharged.**

---

## R2.5 The hoists — one is fully mechanical, one has a missed consumer

**`fetchPRByHead` + `PRStatus`: discharged.** §3.2 hoists them to
`src/integrations/gh/pr-status.ts` and imports them back, and `ReleaseRemovePlan.pr` is typed
`PRStatus | null` rather than a re-declared shape. The round-1 contradiction (anti-fork applied to one
helper, violated for another one section later) is gone.

**`removeReleaseWorktreeIfPresent`: the analysis is right, the file list is incomplete.**

The plan's two required changes are both correct and both verified:

- **(a)** Both failure strings at `:182-186` are merge-specific — `operation` at `:183`
  (*"remove worktree for X **before merge**"*) and `remediation` at `:184`, which tells the operator to
  run `git worktree remove --force`. The plan's catch that handing a teardown operator a `--force`
  suggestion would undo a documented policy is real: `readme.md:58` documents `worktrees remove` as
  having *"no `--force`"* and `removeOne` runs it bare at `remove-worktrees.ts:240`. Good find.
- **(b)** The `Promise<void>` → `Promise<string[]>` change is genuinely necessary:
  `removeIdeWorktreeFolders` returns `[]` immediately when `removedWorktrees` is empty (`:49`), and the
  helper early-returns at `:169` when no worktree exists — so the caller cannot synthesise
  `[branch]` without lying in exactly that case.

**What §3.2 misses.** It justifies the return-type change with *"Deliver's call site ignores the new
return"*, which is true of the production call site (`gh-release-deliver.ts:420` — the only one). But
there is a **second consumer**, and it is an assertion on the return value:

```
src/commands/gh-release-deliver/__tests__/remove-release-worktree.test.ts:6
  import { removeReleaseWorktreeIfPresent } from '../gh-release-deliver'
:68
  await expect(removeReleaseWorktreeIfPresent(RELEASE_BRANCH)).resolves.toBeUndefined()
```

Returning `string[]` makes that resolve to `['release/v…']`, and the test goes red. The import path
also relocates with the hoist. §3.2 lists **no** edit to this file, and §8.5's consequence line
(*"it now returns the removed branches"*) does not name it either.

In the plan's favour: §7 step 2 **does** run `apps/infra-kit/cli/src/commands/gh-release-deliver`, so
this is caught by the plan's own verification rather than shipped. But §3.2 is the implementation
contract an engineer works from, and it currently asserts a safety property that is false as stated.
One row, and the plan's fifth-wiring-contract precedent says a missing file in that table is treated as
blocking. → **R2-REQUIRED 2**

---

## R2.6 Citation health — materially improved, with the one systemic caveat above

I spot-checked every correction the round-2 brief named, plus a sample of new material.

**The corrections are right, including both of mine:**

| Citation | Verdict |
|---|---|
| Merge-specific throw at `gh-release-deliver.ts:182-186` (`operation` `:183`, `remediation` `:184`) | **VERIFIED. My round-1 `:172-177` was wrong; the Critic's correction stands.** |
| `confirm-or-exit.ts:64` (`whenHeadless: 'refuse'`), `:77` (`process.exit(0)`), `:35-49` (`ConfirmOrExitOptions`) | **VERIFIED, all three exact.** My round-1 `:71-77` was a loose range. |
| The file to edit is the **repo-root `/CLAUDE.md`**, block `:17-41`, release line **`:29`** | **VERIFIED exactly** — `<!-- infra-kit:begin -->` at `:17`, `<!-- infra-kit:version 0.4.0 -->` at `:18`, release line `:29`, `<!-- infra-kit:end -->` at `:41`. The Critic's `:27` was wrong. |
| `«cli»/CLAUDE.md` has no release line, so editing it would leave `infra-kit-check-root` red | **VERIFIED** — zero `release` hits in that file. |
| `readme.md:58` is the `worktrees remove` row with *"no `--force`"*; `:57` is `worktrees list` | **VERIFIED.** The Critic's `:57` was wrong. |
| `assertKnownTargets` has zero hits; the helper is `assertTargetsExist` (`:66`, docblock `:59-65`, called `:144`) | **VERIFIED** — my round-1 REQUIRED 6, discharged. |
| `infra-kit-check-root` is inside root qa | **VERIFIED** — `package.json:37` `"infra-kit-check-root": "pnpm exec infra-kit audit --root"`, reached from `:38`, and `qa` at `:23`. Contract 5 is real. |
| `pnpm --filter infra-kit run build` is a valid invocation | **VERIFIED** — the CLI package is named `infra-kit` and has a `build` script. |
| `release-picker.ts` `assertInteractive` remediation names `--version`/`--versions`/`--all` | **VERIFIED verbatim at `:35-42`.** D6's re-throw is warranted. |
| `remove-worktrees.ts:240` runs `git worktree remove` bare; `recoverFromRejectedRemove` at `:194` sweeps only an already-unregistered leftover | **VERIFIED**; D8's correction of revision 1's `.omc/` scope claim is right. |
| IDE module: `:49`, `:92`, `:109`, `:129`, `:133-136`, `:30-43` | **VERIFIED, every one exact.** |

**Assessment.** Revision 2's citations hold up to spot-checking better than either prior document — I
found no *wrong* line number introduced by this revision, which is a first across three rounds. The
systemic problem is no longer accuracy but **freshness**: the tree moved under the plan while it was
being written (R2.0). The right response is not another citation audit but a re-anchor plus a
convention — cite against a named commit and re-read the anchored files immediately before
implementing.

One residual reading to flag, non-blocking. D6 says the `throwOnDecline: false` default's *"documented
reason … is about resource leaks, not about exit codes."* The docblock (`:35-49`) actually gives two
statements: *"**Defaults to false, and must stay that way.** Seven commands call this helper; flipping
the default would change the exit semantics of all of them at once"*, **and** the opt-in guidance about
acquired resources. The plan is not flipping the default — it passes the option for one new caller —
so the first statement does not bind it and the decision is sound. But the plan is extending the
option beyond its documented purpose (using it for exit-code semantics rather than leak safety), and it
should say so plainly rather than imply the docblock supports it. → R2-SUGGESTED 3

---

## R2.7 New material — what I checked, and what I found

**Acceptance criteria (27).** Spot-checked the ones with verifiable predicates:

- **AC-25** — *"after `pnpm --filter infra-kit run build && pnpm exec infra-kit audit --fix --root`,
  `/CLAUDE.md` line 29 lists `release remove`, the marker at `:18` is unchanged"*. Both anchors verified;
  and the criterion is stable because extending the release line adds no lines, so `:29` and `:18` hold
  after regeneration. Well-formed.
- **AC-18** — the clean-tree qualifier is a real catch: `assertManagementContext` calls
  `assertCleanCheckout` unconditionally (`git-guard.ts:145`, `:158`), so a linked-worktree test that
  dirties the tree would indeed pass for the wrong reason.
- **AC-15 vs AC-13** — the reconciliation is sound. GitHub PRs cannot be deleted, so a release this CLI
  removed keeps a `CLOSED` PR and the "no PR in any state" conjunct never fires for it. The plan names
  the one genuine edge (a release whose PR creation failed, later fully removed) and accepts a refusal
  there. Correct, and stating it forestalls an implementer "resolving" the apparent contradiction by
  weakening one criterion.
- **AC-23 / §8.5** — inherits R2.0: *"the exposed MCP tool count goes 23 → 24"* is right at HEAD and
  wrong in the tree (24 → 25).
- **AC-27** replacing *"`pnpm run qa` is green"* is a genuine improvement. Verified: `vendor:check` is
  `&&`-chained first in `package.json:23`, so on a red vendor check the named lanes never execute at
  all — a criterion of "qa is green" was both unsatisfiable and vacuous. Naming the lanes is right.

**U1/U2 fallbacks.** Better than what I asked for in round 1. Two points I did not make and the plan
did: (i) under the JQL fallback the command must **refuse rather than reassign**, because a single
`total` cannot distinguish the fix and affects counts that `--move-issues-to` now writes to separately —
that follows from D2b's own per-count design and I missed it; (ii) it declines to default `--skip-jira`
on the U1 failure path, on the grounds that doing so would invert that flag's meaning from "exception"
to "normal" and destroy its value in shell history, introducing a distinct `jira: 'manual'` outcome
instead. Both are right, and the second is a better answer than my round-1 recommendation, which did
loosely propose the flag route. **Discharged, and improved.**

**The fifth wiring contract and the stale-`dist/` mitigation.** Verified end to end, and it is the
strongest new section. `infra-kit` is a root devDependency at `workspace:*`, so `pnpm exec infra-kit`
runs the workspace build; qa has no build step; therefore `audit --fix --root` against a stale `dist/`
re-emits the **old** guidance line and masks the drift — the recorded "dist-reading is vacuous" failure
class arriving through the audit lane. §7 step 1 puts `pnpm --filter infra-kit run build` before the
audit, and step 5 proves stability by re-running `audit --root` and requiring exit 0. The version-marker
warning (`:18` must not move; a move means the working tree's version differs from the one that last
wrote the block) is a real trap correctly identified. No defect found.

**§7 generally.** The baseline-manifest shasum before/after, the separate cold `eslint --no-cache` and
`prettier --check` gates, the `; echo EXIT=$?` on every lane, the `git status --short` for `??` files,
and the explicit "do not fix `vendor/`" note all honour recorded hazards correctly. Note that §7 step 2
already includes the `gh-release-deliver` test directory, which is what catches R2-REQUIRED 2.

**What I could not verify:** U1/U2/U3 remain UNVERIFIED by construction (they need a live Jira
instance); the plan's gate plus stated fallbacks is the correct treatment and I have nothing to add.

---

## Round-1 items: disposition

| Round-1 item | Status |
|---|---|
| **REQUIRED 1** — demote the IDE step out of the verified chain | **DISCHARGED**, and exceeded: the parameter is decided (`false` always), not merely the reporting demoted (R2.2) |
| **REQUIRED 2** — `--move-issues-to` affects-links hole; stop summing the counts | **DISCHARGED** — maps to both Jira parameters, per-count refusal predicate, counts reported separately, and the revision-1 dead end (`fixCount: 0, affectsCount: 2` being permanently unremovable) is named and pinned by T2(c) |
| **REQUIRED 3** — hoist `fetchPRByHead`; parameterise the worktree helper's strings | **PARTIALLY DISCHARGED** — `fetchPRByHead` fully; the worktree hoist's analysis is right and goes further than I asked (both strings, plus the return type), but its file list misses a consumer (R2.5) → R2-REQUIRED 2 |
| **REQUIRED 4** — the "no evidence at all" refusal | **DISCHARGED**, with the AC-13/AC-15 collision explicitly reconciled and the one genuine edge accepted on the record |
| **REQUIRED 5** — state the U1/U2 fallbacks | **DISCHARGED**, and improved (R2.7) |
| **REQUIRED 6** — correct the citations | **DISCHARGED** for every named item; superseded by the freshness problem (R2.0) |
| **SUGGESTED 1** — re-probe before the Jira delete | **ADOPTED** as D2e, promoted to blocking by the Critic, pinned by T10 |
| **SUGGESTED 2** — widen `ReleasePRInfo` | **ADOPTED as a follow-up** (§8.6), correctly scoped out |
| **SUGGESTED 3** — re-argue D7 | **ADOPTED**, option (ii) (R2.1) |
| **SUGGESTED 4** — CI-dependency distinction in the Option B rejection | **ADOPTED** verbatim in §1.3 |
| **SUGGESTED 5** — say what a step-6 failure leaves | **ADOPTED** in D4 |
| **SUGGESTED 6** — note the exit-0 decline | **ADOPTED and upgraded** — D6 now switches to `throwOnDecline: true`, with AC-6 pinning a non-zero exit |

---

## VERDICT: SOUND WITH CHANGES

The design is settled and I have no remaining objection to it. Both reversals are real: D7 is wired,
not declared, and the IDE step is decided rather than deferred. The abort rationale now rests on the
argument that actually carries it. Revision 2 introduced no wrong line number that I could find, which
across three rounds of citation drift is worth saying plainly.

The two blocking items are mechanical. Neither is a design defect and neither needs another planning
round — they are corrections an implementer must make before the first commit.

### R2-REQUIRED (blocking)

1. **Re-anchor the catalog citations to the working tree, not `969bbe0`.** *(amends §3.2's
   `command-catalog.test.ts` row, D-c, D7's wiring table, and §8.5)* `command-catalog.{ts,test.ts}` are
   modified and **uncommitted** in the tree, adding a 24th exposed tool (`setup-deps-status`, not in any
   commit). So: the length bump is **24 → 25**, not 23 → 24; `EXPECTED_GATED_TOOLS` is at `:206`; the
   worktrees-remove comment at `:66-69`; T3 at `:528-536`; and D-c/§8.5 should read **12 of 24**. Also
   flag the trap that the `it(...)` title at `:80` already says *"expected 23 MCP tools"* while its
   assertion says 24 — the implementer must fix the title too, or ship a test named for a count it does
   not assert. Because that change is in flight, the plan should say which tree it is anchored to and
   re-read these lines immediately before editing.

2. **Add `«cli»/src/commands/gh-release-deliver/__tests__/remove-release-worktree.test.ts` to §3.2.**
   *(amends the worktree-hoist row and §8.5)* The row justifies the `Promise<void>` → `Promise<string[]>`
   change with *"Deliver's call site ignores the new return"* — true of `:420`, the only production
   caller, but there is a second consumer that **asserts** the return value:
   `:68` is `await expect(removeReleaseWorktreeIfPresent(RELEASE_BRANCH)).resolves.toBeUndefined()`,
   and `:6` imports the helper from `'../gh-release-deliver'`, an import the hoist relocates. Both need
   updating. §7 step 2 already runs that directory so this cannot ship silently, but §3.2 is the
   implementation contract and currently asserts a safety property that is false as stated.

### R2-SUGGESTED (non-blocking)

1. **Say `jira: 'manual'` in the MCP tool *description*, not only in the result** — an agent should know
   before calling that the Jira step will not run, or it may reasonably report "release removed" without
   surfacing the URL a human must act on. *(amends D7)*

2. **Capture `remoteTipSha` in `deleteRemoteBranch`'s existing probe as well as in preflight.** That
   function already runs `git ls-remote --heads origin <branch>` at `:291` immediately before deleting
   and discards the SHA, testing only `.trim().length === 0` — the same fetch-then-discard pattern the
   plan criticises in `ReleasePRInfo`. Capturing it there costs nothing and closes the narrow window
   where a mid-run push makes the preflight value stale. *(amends D4 step 5)*

3. **State that `throwOnDecline: true` extends the option beyond its documented purpose.** The docblock
   (`confirm-or-exit.ts:35-49`) gives two statements, and the plan quotes only the resource-leak one.
   The plan is not flipping the default so nothing is violated, but it should say it is using the
   mechanism for exit-code semantics rather than imply the docblock endorses that. *(amends D6)*

4. **Correct "five gated tools" to eight.** `EXPECTED_GATED_TOOLS` holds eight entries; D7's argument is
   stronger with the right number. *(amends D7)*
