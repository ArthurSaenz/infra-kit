# `infra-kit release remove` — the inverse of `release create`

**Status: `pending approval`** · Mode: RALPLAN deliberate · **Revision 3 — consensus-approved by both
reviewers (Architect: SOUND WITH CHANGES, 2 mechanical; Critic: APPROVE), pending user approval.
Revision 3 folds in the apply-before-implementing items; it contains no new design.**

Citations are against `main` @ `969bbe0` unless a line is explicitly marked **(tree)**. Every
reference was re-read for this revision. **Read §3.4 before making the first edit** — five of the
files this change touches are modified-and-uncommitted by a concurrent landing, and this plan
deliberately expresses every count as a _delta_ rather than an absolute for that reason. Claims I
could not verify are marked **UNVERIFIED** and carry the measurement that would settle them plus a
stated fallback. The CLI package root is abbreviated `«cli»` = `apps/infra-kit/cli/`.

---

## 0. Review disposition

D7's _Jira step omitted over MCP_ is reversed by `docs/release-remove-form-and-jira-plan.md` (2026-09-15); the exposure decision stands.

### Round 3 (revision 3) — consensus

Architect: **SOUND WITH CHANGES**, both items mechanical. Critic: **APPROVE**. All eight
apply-before-implementing items are folded in: the delta convention and collision surface (§3.4), the
three missing edit-list files (`palette.test.ts`, `mcp-stdio.e2e.test.ts`,
`remove-release-worktree.test.ts` — §3.2), the §5.3 correction, the §5.5 decline sentence, D4 step 2's
Cursor wording, D7's gated-tool count, and the four test/description additions.

**Two reviewer corrections carried on the record, and one finding that supersedes both:**

| Claim                                                                                | Verified                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architect: the in-flight tool is `setup-deps-status`                                 | It is **`setup-dependency-status`**. The short form matches nothing; the Critic caught this.                                                                                                                                                                                                                            |
| Architect: `deleteRemoteBranch`'s `ls-remote` probe is at `:291`                     | `:291` is the `export const`; the probe is **`:292`**.                                                                                                                                                                                                                                                                  |
| Critic: `AUTHORED_TOOL_NAMES` is at `mcp-stdio.e2e.test.ts:1082`, self-check `:1094` | **(tree)** `:1116` and `:1128`. Also: `withoutAuthoredDeltas` _does_ exist at HEAD (`:1075`) — what is new is the tool-name `Set`, not the helper.                                                                                                                                                                      |
| Both: the working tree adds a 24th exposed tool, so the bump is 24 → 25              | **The tree moved again between the reviews and this revision.** Measured now: HEAD has 23 exposed / 8 gated; **(tree)** has **26 exposed / 10 gated**, and the `it(...)` title at **(tree)** `:82` still reads _"expected 23 MCP tools"_ while its own assertion at `:90` says `toHaveLength(26)` — now stale by three. |

That last row is the decisive argument for §3.4: an absolute count in this plan was wrong within one
review cycle, twice. **Revision 3 states no absolute count as a fact about this change.**

### Round-2 review disposition

Architect: SOUND WITH CHANGES (6 REQUIRED). Critic: ITERATE (10 blocking, 9 non-blocking). Option A's
shape survives both; this revision is a repair pass.

**Accepted and applied in full:** Architect REQUIRED 1-6 and SUGGESTED 1-6; Critic BLOCKING 1-10 and
NON-BLOCKING 11-19. The two reversals worth naming up front:

- **D7 is reversed.** `mcpExposed: true`, gated, with the Jira step omitted over MCP (Architect
  option (ii), which the Critic showed is the shape this plan's own step table implies). §3.3 and §6
  restore the catalog wiring that revision 1 dropped, and **AC-23 inverts**: the golden snapshot must
  now move by exactly one tool.
- **The IDE step is not merely demoted, it is decided.** `allowEditorRelaunch: false`, always. The
  Critic is right that revision 1 never chose the parameter; the Architect is right that the step
  cannot be verified. Reading the module settles both at once — see D4 step 2 and D8.

**Three reviewer citations came back wrong and are corrected here rather than propagated:**

| Review says                                                     | Verified                                                                                                                                                                                                                    | Consequence                                                                             |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Critic B5: add **`«cli»/CLAUDE.md`** (the generated root block) | The block carrying the release line is the **repo-root `/CLAUDE.md`** (`:17-41`, marker `:18`, release line **`:29`** — not `:27`). `«cli»/CLAUDE.md` is a _package_ block from `audit --fix` and contains no release line. | §3.2 edits `/CLAUDE.md`. Editing the wrong file would leave `infra-kit-check-root` red. |
| Critic §1(ii)/B3: `readme.md:57` documents "no `--force`"       | `:57` is the `worktrees list` row; the `worktrees remove` row with _"(no `--force`; …)"_ is **`:58`**.                                                                                                                      | Cited correctly in D4 step 1.                                                           |
| Architect W2: merge-specific throw at `:172-177`                | **`:182-186`** (`operation` `:183`, `remediation` `:184`). The Critic caught this; confirmed.                                                                                                                               | §3.2.                                                                                   |

Also confirmed independently: `assertKnownTargets` has **zero** hits in `src/` — the helper is
`assertTargetsExist` (`«cli»/src/commands/worktrees-remove/worktrees-remove.ts:66`, docblock `:59-65`,
called `:144`). Its docblock's own _"Promise.allSettled"_ is stale — `removeWorktrees` uses
`Promise.all` over a never-rejecting `removeOne` (`«cli»/src/lib/worktrees/remove-worktrees.ts:261-266`).
Not propagated.

---

## 1. RALPLAN-DR summary

### 1.1 Principles

1. **Irreversibility is the ordering axis.** Steps run cheapest-to-undo first, hardest-to-undo last,
   so an abort at any point leaves a residue a human can repair. §D4's table now states each residue
   _as the code actually leaves it_, and where recovery depends on a value (a branch tip SHA), the
   plan captures and prints that value rather than assuming it.
2. **Report only what the code can substantiate — and where it cannot, say so instead of claiming
   it.** Two primitives fail _open_: `deleteLocalBranch` silently no-ops on the current branch
   (`«cli»/src/lib/git-utils/git-utils.ts:277-279`), and Zed folder removal _"confirms no specific
   removal"_ by construction (`«cli»/src/integrations/ide/remove-ide-worktree-folders.ts:42-43`).
   Verifiable steps are verified and reported as done; unverifiable ones are reported as `attempted`
   or `skipped`, never as `removed`.
3. **Refuse rather than guess when the blast radius is other people's work.** A fix version with
   issues attached, a merged PR, a `released` version, and an editor window holding folders we did
   not open, all mean "not ours to destroy". The command refuses or declines to act; it does not
   prompt its way past them, because the MCP boundary auto-confirms and a `--yes` operator never
   reads a warning.
4. **Resumability over batching.** One release per invocation, and a re-run after a partial removal
   must succeed rather than error on already-gone things — bounded by a refusal when _nothing_ about
   the named release can be found, so a typo is not reported as a successful no-op.
5. **Symmetry with `release create`, not with `worktrees remove`.** Create is the operation this
   inverts. Applied consistently in revision 2: D2c mirrors `ensureJiraVersion`'s refusal, D1 mirrors
   its un-prefixed flat id, and **D7 now mirrors its MCP exposure** rather than inverting it without
   argument. `worktrees remove` is a _reversible_ cleanup whose ergonomics (`--all`, multi-select,
   continue-on-error) must not be copied — but its _exposure posture_ is the right precedent, and
   revision 1 was wrong to reach past it to `release-deliver`.

### 1.2 Decision drivers (top 3)

- **D-a — Jira fix-version deletion is unrecoverable, invisible, and its guard is time-of-check.**
  Removing a version strips `fixVersion` from every issue that carried it; Jira records no prior
  value the CLI can read back, and after the delete the affected issues are no longer enumerable _by
  that version_. Worse, the count that authorises the delete is read in preflight and consumed six
  steps later across an unbounded confirm prompt. Drives D2, D4 and PM-2.
- **D-b — the repo's primitives fail open in exactly the situations this command creates.**
  `deleteLocalBranch` returns `void` with two silent early returns; `removeWorktrees` reports
  failures rather than throwing; `getReleasePRsWithInfo`'s **projection** discards the PR number and
  state that its own fetch already retrieved. Composing them naively yields a command that reports
  success while doing nothing. Drives D3, D5 and PM-1.
- **D-c — MCP exposure in this repo is governed by allowlist, not by verb.** **Roughly half the
  exposed set mutates** — 12 of them at the time of writing, against an exposed total that has changed
  twice during this plan's review (§3.4), which is why the ratio rather than the count is the
  argument. `worktrees-add` runs `pnpm install` ungated on the low-risk allowlist; the
  enforced rule is `LOW_RISK_MUTATING_ALLOWLIST` membership **or** `requiresHumanConfirm`
  (`command-catalog.test.ts:235-248`). "Destructive" is therefore not a disqualifier — the catalog's
  own comment at `:65-68` says `worktrees-remove` _"IS exposed"_ because its invariants contain the
  residual risk. Drives D7.

### 1.3 Viable options for the overall shape

**Option A — one command, full-stack, single target, exposed-and-gated over MCP minus the Jira step (CHOSEN).**

- _Pros:_ one mental model ("undo the create"); the ordering principle is enforceable because one
  code path owns all six steps; the residue report is exact because the steps are sequential; agents
  can undo the releases the plugin actively encourages them to create.
- _Cons:_ the command spans three systems, so its unit tests need three sets of mocks; the MCP path
  is deliberately partial (five steps, then a printed Jira handoff), which is a second behaviour to
  document and test.

**Option B — compose existing commands (`worktrees remove` + `gh pr close` + a new `release jira-remove`).**

- _Pros:_ smallest new surface; each piece independently testable.
- _Cons:_ **invalidated.** The ordering principle cannot be enforced across separately-invoked
  commands, and the merged-PR guard would have to be duplicated into every piece or absent from all
  of them. **A runbook cannot refuse.**

  _The `local-deploy` precedent does not transfer, and here is why on the record._ That decision
  ("fix the contract in bash; the CLI is preflight/UX only") was forced by a constraint absent here:
  **CI must never depend on the CLI.** The deploy contract is split across GitHub Actions YAML and
  `.sh` scripts, and a CLI owning the flow would put an npm-published binary on the critical path of
  every production deploy. Release teardown has **no CI consumer and no unattended caller** — it runs
  once, at a human's or an agent's explicit request. The precedent's load-bearing premise is "an
  unattended automated path already exists and must keep working without us". There is none here.

**Option C — `release remove --dry-run` / plan-then-apply.**

- _Pros:_ the operator sees the full inventory before anything runs.
- _Cons:_ **invalidated as the primary shape, folded into A.** Preflight already computes that
  inventory and prints it in the confirmation message. **This rejection creates an obligation**: the
  confirm text is now load-bearing, so revision 2 adds a test (T9) and an acceptance criterion
  (AC-20) that pin its contents. Retained as a follow-up (§8.6).

---

## 2. Decisions

### D1 — Command name, path, and flat id — _unchanged from revision 1; both reviews found it sound_

**Pick: `release remove`**, group path `['release','remove']`, flat id **`release-remove`** for both
`cliName` and the MCP tool `name`.

Rejected: `release delete` (a second teardown verb for a connotation the confirm text can carry);
`release abort`/`cancel` (accurate but unguessable). The reversibility connotation `worktrees remove`
carries is closed in the description and confirm text, not in the verb.

**Placement is inside the `release` group, not top-level.** The house rule recorded for `reopen`
(`«cli»/src/lib/program/program.ts:429`) is about not _inventing_ groups; `release` exists and holds
`release create` (`:409-417`). Stated so a reviewer does not re-open it.

**Not `gh-release-remove`:** the `gh-` prefix marks tools whose subject is GitHub; this spans Jira +
GitHub + local git, like the un-prefixed `release-create`.

> **Observed inconsistency, deliberately not propagated.** `release-deliver` has
> `cliName: 'release-deliver'` while its tool object is named `gh-release-deliver`
> (`command-catalog.ts:276-282` vs `gh-release-deliver.ts:453-455`). Now that `release-remove` is
> exposed (D7), the split would be **wire-visible**, so using one string for both is not merely tidy
> — it is required for the tool name an agent sees to match the command a human types.

**Directory:** `«cli»/src/commands/release-remove/{release-remove.ts, index.ts, __tests__/*}`.

**`--version` accepts a release NAME as well as a version.** `resolveReleaseBranch` is
`formatBranchName(parseReleaseRef(…))` (`«cli»/src/lib/release-utils/release-utils.ts:285-294`) and
its own remediation reads _"pass a version (e.g. "1.2.5") or a release name (e.g.
"checkout-redesign")"_. Revision 1 spoke only of versions, which would leave every named release an
undocumented target. The Commander help string is copied verbatim from `configureReleaseDeliver`
(`program.ts:233`): `'Version (e.g. 1.2.5) or release name (e.g. checkout-redesign) to remove'`.

### D2 — Jira deletion mechanics

**Verified:** no delete path exists. `grep -rn 'DELETE|removeAndSwap|relatedIssueCounts|deleteJiraVersion'
«cli»/src/integrations/jira/` returns nothing. `api.ts` exports `createJiraVersion` (:67),
`getProjectVersions` (:112), `findVersionByName` (:140), `updateJiraVersion` (:156),
`deliverJiraRelease` (:201), `loadJiraConfig` (:236), `loadJiraConfigOptional` (:283); every call goes
through the module-private `assertJiraOk` (:29).

#### D2a — which API, and what happens if the API is not what we think

**Pick: `POST /rest/api/3/version/{id}/removeAndSwap`** — one code path serves both the plain delete
and the reassignment; `DELETE /version/{id}` is the deprecated form and would mean two error surfaces
for one operation.

**UNVERIFIED (Atlassian-documented, not measured against this repo's instance).** Three claims the
implementation PR must measure with one `curl` each against a throwaway version, recording the actual
request/response in a code comment — the discipline `docs/jira-401-misreported-as-404-plan.md` §1.1
established:

- **U1.** `removeAndSwap` deletes a version, and an empty body means "delete and unset the field from
  every issue that carried it".
- **U2.** `GET /rest/api/3/version/{id}/relatedIssueCounts` returns `issuesFixedCount` and
  `issuesAffectedCount`.
- **U3.** `DELETE /rest/api/3/version/{id}` still works but is deprecated.

**Fallbacks, stated now rather than left behind the measurement gate** — because the design already
depends on the answers, and a failed measurement must produce a known next step, not a re-planning
cycle:

- **If U2 is false**, D2b's probe becomes `GET /rest/api/3/search?jql=fixVersion=<id>` reading
  `total`. This is a **redesign, not a swap**: a different endpoint, a different permission scope
  (search vs project-admin), and a different failure mode (JQL syntax, project scoping). It returns
  **one** number, so the refusal text loses the fix/affects split and D2b's per-count predicate
  collapses to a single count — and, critically, the `moveAffectedIssuesTo` half of D2b's escape
  hatch becomes unverifiable, so with the JQL fallback the command must **refuse rather than
  reassign** when it cannot distinguish the two.
- **If U1 is false** — in particular if an empty body 400s, or defaults a swap target — v1 ships with
  a **distinct `jira: 'manual'` outcome**: steps 1-5 run, and the command prints the fix version's
  id, name and URL plus the exact manual removal path. **It does NOT default `--skip-jira`.** D2d
  defines that flag as a deliberate exception echoed by `commandEcho`; defaulting it would invert its
  meaning from "exception" to "normal" and make shell history stop distinguishing the two cases.
  `jira: 'manual'` is a reported outcome, not a flag.
- **The worst case is not a 404.** A 404 fails loudly at measurement time. A _semantic_ surprise —
  `removeAndSwap` being permissive in an unexpected direction — is discovered by an operator whose
  tickets moved somewhere they did not choose. The measurement must therefore assert the **post-state
  of a test issue**, not merely the HTTP status.

#### D2b — versions with issues attached: the guard, per count

| Option                                                                         | Verdict                                                                                                                                                                                     |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delete regardless                                                              | **Rejected.** Silently strips `fixVersion` from real tickets; this is PM-2.                                                                                                                 |
| Warn + extra confirm                                                           | **Rejected.** A confirm is not a gate over MCP and is skipped by `--yes`; and a warning is only actionable if it enumerates the issues, which is most of the work of the reassignment path. |
| Always reassign                                                                | **Rejected as default.** Forces the operator to nominate a target even for the overwhelmingly common empty version.                                                                         |
| **Refuse per count, with `--move-issues-to <version>` as the opt-in (CHOSEN)** | The dangerous case is a hard stop; the safe case is one command; the escape is deliberate and greppable.                                                                                    |

**The predicate, stated per count** (revision 1 left this ambiguous, which created a dead end):

```
refuse if (issuesFixedCount > 0 || issuesAffectedCount > 0) and --move-issues-to is absent
```

**`--move-issues-to <version>` maps to BOTH `moveFixIssuesTo` AND `moveAffectedIssuesTo`.** Revision 1
mapped it to `moveFixIssuesTo` only, which meant a version with `issuesAffectedCount > 0` lost its
affects links _through the very flag that exists to prevent data loss_, and a version with
`issuesFixedCount: 0, issuesAffectedCount: 2` was **permanently unremovable** — refused by the guard
and un-clearable by the flag the refusal recommended. Mapping one flag to both parameters closes both
holes with one line.

_Rejected alternative: two flags (`--move-issues-to` + `--move-affected-to`)._ An operator who wants
two different destinations has a Jira UI for it; two flags would double the preflight validation and
the failure surface to serve a case nobody has asked for.

**The counts are never summed.** They are counts over two different fields and an issue can carry the
version in both, so `21 + 2` is an upper bound on distinct issues, not a total. Refusal text:

```
operation:      remove Jira fix version "v1.2.5"
stderrExcerpt:  v1.2.5 is set as fixVersion on 21 issue(s) and as affectsVersion on 2 issue(s)
remediation:    deleting it would clear both fields on those issues with no way to restore them —
                pass --move-issues-to <version> to reassign both, or clear the version from the
                issues in Jira first
```

`--move-issues-to` is validated with `findVersionByName` **in preflight**, so a typo'd target fails
before any mutation.

#### D2c — released / archived versions

`ensureJiraVersion` already refuses to _reuse_ a `released` or `archived` version
(`release-utils.ts:159-165`, remediation _"pick a different version, or un-release it in Jira
first"_). **The mirror rule: refuse to remove one.** Read from the `JiraVersion` that
`findVersionByName` already returned (`«cli»/src/integrations/jira/types.ts` carries `released` and
`archived`) — no extra call.

No `--force`. D3's merged-PR guard covers the same mistake from the GitHub side, and the two are
deliberately independent because either alone is dodgeable: a hotfix delivered while Jira was down
has an unreleased version with a merged PR; a version released by hand in the UI has no merged PR. A
shared override would collapse two guards into one.

#### D2d — Jira absent, unconfigured, or out of scope

- **Version not found by name** → not an error. `jira: 'absent'`. This is the resume path.
- **Jira not configured at all** → **refuse**, unless `--skip-jira`. `release create` _requires_ Jira
  (`loadJiraConfig` throws, `api.ts:236`), so any release this CLI created lives in a repo where Jira
  is configured; an unconfigured environment means either "not ours" or "your env is broken", and in
  the second case tearing down branch and PR while orphaning a fix version is the mess this command
  exists to prevent. This is a deliberate departure from `gh-release-deliver`'s tolerant
  `deliverJiraReleaseSafely` (`gh-release-deliver.ts:348`) — correctly: deliver tolerates because the
  irreversible merge and deploy _already happened_ by the time it reaches Jira. Here nothing has
  happened yet. **Because this asymmetry is exactly what a later "consistency" refactor deletes, it
  is pinned by a test (T2e) and an acceptance criterion (AC-12).**
- **Running over MCP** → the Jira step is **not attempted at all**; the outcome is `jira: 'manual'`
  carrying the version id, name and URL. See D7.

#### D2e — the time-of-check window (**promoted to blocking by the Critic; accepted**)

The count probe runs at step 0; the delete runs at step 6. Between them sit an interactive
confirmation of unbounded duration and five mutations across two remote systems. A teammate attaching
a ticket to that fix version in between — the ordinary workflow of a team that files tickets against
an open release — is silently overwritten, because the guard that would have refused already passed.
**A mitigation that can be stale at the moment it authorises an unrecoverable act is not a mitigation.**

The repo has already split a guard for exactly this class. `«cli»/src/lib/git-guard/git-guard.ts:62-66`:

> Split out of `assertManagementContext` because tree cleanliness is the _volatile_ half of that
> guard: it is the only leg that can stop being true between the check and the mutation it
> authorizes, **so it has to be re-assertable on its own immediately before each destructive step.**

**Design — re-probe, do not re-guard.** The two checks ask different questions and only one is a
guard:

- **Preflight keeps the guard.** Refuse on a non-zero count. Its job is to fail _before consent_,
  which is what makes the confirm text honest.
- **Step 6 gets a re-probe.** Immediately before `removeJiraVersion`, call
  `getVersionRelatedIssueCounts` again and compare with the preflight values. **Equal ⇒ proceed
  silently** (the overwhelming case — the operator sees nothing new). **Changed ⇒ abort before the
  delete**, reporting steps 1-5 complete, the version intact, and the counts' movement. That residue
  is fully repairable: re-run and the guard fires properly.

Cost: one API call on the path about to make an irreversible one.

### D3 — GitHub PR handling

**Verified constraint, with revision 1's reasoning corrected.** `getReleasePRsWithInfo`
(`«cli»/src/integrations/gh/gh-release-prs/gh-release-prs.ts:155-165`) projects to
`{branch, title, createdAt}` and its two `gh pr list` calls (`:78`, `:81`) carry no `--state`, so gh's
`open` default applies — **a merged PR is invisible to it.** But revision 1 said the helper _"carries
no `state` or `number` field"_, and that is wrong about the fetch: `ReleasePR` (`:11-18`) declares
both, and **both** calls request `--json number,title,headRefName,state,baseRefName,createdAt`. **The
data is fetched over the wire on every picker run and then discarded by the projection.** The
conclusion (a separate `--state all` probe is needed) survives; the reason changes, and the change
matters because it turns "add a call" into "stop discarding, or reuse the call that already exists".

**Reuse, do not fork.** `fetchPRByHead` (`gh-release-deliver.ts:67-72`, docblock `:62-66`) already
**is** the call D3 needs — `gh pr list --head ${head} --state all --json number,state,title --limit 1`
— and its docblock's stated purpose is _resume_ semantics, the same purpose this command needs. It is
hoisted with `PRStatus` into `«cli»/src/integrations/gh/` (§3.2), not re-declared. Revision 1
proposed a private `fetchPrStatus` while applying an anti-fork rule to `removeReleaseWorktreeIfPresent`
one section later; that contradiction is removed.

| PR state   | Action                           | Why                                                                                                                       |
| ---------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **MERGED** | **Refuse, before any mutation.** | The release has shipped. Removing it deletes the branch recording the merge and strips a fix version from delivered work. |
| OPEN       | `gh pr close <n> --comment "…"`  | PRs cannot be deleted, only closed. Closing is reversible (reopen), which is why it sits early.                           |
| CLOSED     | Skip, `pr: 'already-closed'`     | Idempotency.                                                                                                              |
| none       | Skip, `pr: 'absent'`             | A release whose PR creation failed, or a second run.                                                                      |

```
operation:      remove release 1.2.5
stderrExcerpt:  PR #418 for release/v1.2.5 is MERGED
remediation:    this release has shipped — removing it would delete the branch recording the merge
                and strip its Jira fix version from delivered work. To undo a delivery, revert the
                merge commit on <base> and cut a new release.
```

**Close explicitly rather than by side effect.** Deleting an open PR's head branch auto-closes it;
doing it that way means the reported outcome is what GitHub inferred, and the PR carries no
explanation. We also do **not** use `gh pr close --delete-branch`: it deletes the local branch too,
which fails when a worktree holds it — the root cause documented at `gh-release-deliver.ts:160-165`.

**PR-state re-probe before step 3.** Same window as D2e. If the PR is merged between preflight and
step 3, `gh pr close` fails with an opaque `gh` error after the worktree is already gone. One extra
`fetchPRByHead` immediately before step 3 turns that into D3's own refusal message. Ranked below D2e
because the residue is repairable (`worktrees add` restores the worktree) — but it is also what makes
**AC-7** honest, since _"no mutation of any kind"_ is otherwise only true when the merge precedes
preflight.

### D4 — Step order, residues, and partial-failure semantics

**Ordering principle: irreversibility ascending.** Each step placed by "if the command dies
immediately after this step, how hard is the residue to repair by hand?"

| #   | Step                                                                                                                                                                                   | Verifiable?                                                       | Residue if we stop here                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0   | **Preflight** (no mutation): resolve target → guards → PR state → Jira version + both issue counts → validate `--move-issues-to` → **capture the local and remote tip SHAs** → confirm | n/a                                                               | Nothing done.                                                                                                                                          |
| 1   | Remove the release worktree (+ its cmux workspace)                                                                                                                                     | **Yes** — `removeWorktrees` returns `removed`/`failed` per branch | `worktrees add` recreates it. Gitignored contents are destroyed: a hydrated `.env` of Doppler secrets (`env-load` re-fetches), `node_modules`, `dist`. |
| 2   | Strip the worktree from configured editors                                                                                                                                             | **Cursor yes, Zed no** (see below)                                | Cosmetic. Cursor's `.code-workspace` is re-added by `worktrees add`; Zed is untouched by design.                                                       |
| 3   | Close the PR                                                                                                                                                                           | **Yes** — `gh` returns the new state                              | Reopen in the GitHub UI.                                                                                                                               |
| 4   | Delete the local branch                                                                                                                                                                | **Yes** — `branchExists` re-probe (D5)                            | Still on `origin`, and preflight captured the tip SHA.                                                                                                 |
| 5   | Delete the remote branch                                                                                                                                                               | **Yes** — `git ls-remote` re-probe                                | **Neither local nor remote.** Recoverable only from the tip SHA and git's gc window.                                                                   |
| 6   | **Remove the Jira fix version** (after the D2e re-probe)                                                                                                                               | **Yes** — the call either succeeds or throws                      | **Not repairable.** New id, new URL, lost issue links.                                                                                                 |

**Revision 1's row 5 was wrong and is corrected.** It read _"Still local (step 4 printed its SHA)"_ —
but step 4 runs first, so at the moment step 5 completes the branch is neither local nor remote. And
the fallback both rows retreated to does not exist in the shipped path: `deleteLocalBranch`
(`git-utils.ts:273-281`) runs ``await $`git branch -D ${branch}` `` and **discards the result**, so
the `(was <sha>)` line git prints is never captured or logged. Revision 1 therefore promised a
recoverability the code does not preserve — Principle 2 inverted.

**Fix: capture the tip SHAs in preflight, not from the delete.**

```
plan.localTipSha  = git rev-parse --verify refs/heads/<branch>          (null when absent)
plan.remoteTipSha = git ls-remote --heads origin <branch>  → first field (null when absent)
```

Both go into the confirm text, the success report, and the residue `OperationError`.

**The remote SHA is refreshed at the moment of deletion, closing the one window preflight leaves
open.** A teammate pushing between preflight and step 5 would make the preflight value stale, and
`deleteRemoteBranch` would discard the new tip silently. The fix is free and already half-written:
`deleteRemoteBranch` runs `git ls-remote --heads origin <branch>` at `git-utils.ts:292` immediately
before deleting and **throws the SHA away**, testing only `.trim().length === 0` — the same
fetch-then-discard pattern this plan criticises in `ReleasePRInfo`. Capture it there and report that
value for `remoteTipSha`, falling back to preflight's when the probe returns nothing.

This is a deliberate departure from the reviewers' _"make `deleteLocalBranch` return or log the sha"_: reading
in preflight touches no shared primitive and no other caller, and it is **strictly more robust**,
because `git branch -D`'s `(was <sha>)` output is a localizable porcelain string that a parser should
not depend on. It also covers the case where the branch is already gone when step 4 runs, where there
is no delete output to read at all.

**Ordering constraints that are not preferences:** step 1 before step 4 (git refuses to delete a
branch checked out in another worktree — `git-utils.ts:265-272`); step 3 before step 5 (see D3).

**The alternative order was considered and rejected.** "Least-recoverable _first_, so an abort has
done nothing" reads well but maximises the probability that the one unrepairable step executes, and
leaves the one residue a human cannot fix.

**What a step-6 failure leaves — the only _good_ residue, stated so nobody adds a rollback for it.**
Everything else is gone and the fix version survives: an orphaned version pointing at a deleted
branch, whose URL in the (now closed) PR body still resolves. Ten seconds in the Jira UI, or a
re-run, which finds every other step already done and retries only step 6.

#### Step 2 in detail — the editor step is decided, not deferred

Revision 1 listed this as a verified mutation. Both reviews rejected that, and reading the module
shows the situation is split, not uniform (`«cli»/src/integrations/ide/remove-ide-worktree-folders.ts`):

- **Cursor (`removeFromCursor`, `:92-114`)** surgically edits the `.code-workspace` `folders` array
  and returns a **real, verified** `removed` list. It catches its own errors and warns (`:109-113`).
- **Zed (`removeFromZed`, `:129-143`)** is gated on `allowEditorRelaunch`; when false it is a
  deliberate no-op with an info message (`:132-138`). When true it calls `reuseZedWorkspace`, and
  `removed` is **always `[]`** — the module comment at `:36-43` explains why: _"`zed --reuse`
  REPLACES the focused window's entire folder set … and silently drops any other open folder"_, and
  _"`removed` stays empty because `--reuse` performs no diff — it confirms no specific removal, and
  reporting intended-but-unverified paths would be a lie."_

**Decision: `allowEditorRelaunch: false`, always.**

| Option                                                                          | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `!confirmedCommand` (what `worktrees-remove` passes, `worktrees-remove.ts:178`) | **Rejected.** It fires Zed's destructive relaunch on the interactive path — closing folders the operator opened for unrelated work, with no report. Principle 3 forbids exactly that. `worktrees remove` earns the trade because it is frequently a bulk operation where re-stating the whole folder set _is_ the point; `release remove` is single-target by D6, so re-stating every folder to drop one is disproportionate. |
| **`false`, always (CHOSEN)**                                                    | Cursor still works surgically and verifiably (it never reads the flag). Zed prints its own manual-close hint (`:133-136`). No unrelated window is touched.                                                                                                                                                                                                                                                                    |

This also resolves the Critic's sharpest version of the finding: on a `--yes` run — the exact
invocation PM-1 narrates — `worktrees-remove`'s `!confirmedCommand` makes the Zed leg a **guaranteed
no-op**, so a plan that copied it would report a mutation the code is documented not to perform. With
`false` always, there is no such gap: the Zed outcome is a declared skip on every path.

**Reporting:** step 2 carries the actual `RemoveIdeWorktreeFoldersOutcome[]` — never a bare
"completed". **Cursor is reported as verified only when `removed` is non-empty, and `attempted` when
it is empty**, because `removed: []` arrives from three different paths: nothing to remove, no
`workspaceConfigPath` configured (`:95-96`), and a **caught write failure** (`:109-113`). An empty
array is therefore not evidence of anything, and the realistic Cursor failure surfaces only as a
`logger.warn` from inside the integration — which would let a success-shaped report stand over a
failed write. This is exactly what revised Principle 2 prescribes (_"unverifiable ones are reported as
`attempted` or `skipped`, never as `removed`"_); revision 2 said "Cursor's verified `removed`" without
the qualifier. Zed is always a declared skip. **And the whole step is best-effort: `warn` on failure,
never abort.** A cosmetic step must not strand a teardown with the worktree gone, the PR
open, the branch live and the fix version live.

#### Failure semantics: abort on first error — except step 2

Revision 1 justified this with _"the six steps are causally dependent"_. Checked pairwise that is
**overstated** — only 1→4 and 3→5 are dependent; 2→anything, 3→6, 4→5 and 5→6 are not. **The
argument that actually carries it is reachability:** continuing past an unseen failure can **reach
the unrecoverable step on a state the operator never inspected**, which is Principle 1 inverted. That
is why abort is right, and it is also why step 2 — which can never reach step 6 in any meaningful
sense, and cannot be verified anyway — is the one exemption.

The thrown `OperationError` names the failed step **and** enumerates what already ran, **and carries
the tip SHAs**:

```
operation:      remove release 1.2.5 — step 5 of 6 (delete remote branch)
stderrExcerpt:  <git's stderr>
remediation:    completed: worktree, ide-folders (attempted), pr-closed, local-branch (was a1b2c3d).
                The Jira fix version v1.2.5 was NOT removed. Restore the branch with
                `git branch release/v1.2.5 a1b2c3d` if needed, then re-run
                `infra-kit release remove --version 1.2.5` to finish; completed steps are skipped.
```

#### Idempotency, resumability, and its bound

Verified no-ops that make a re-run safe: worktree absent → `removeReleaseWorktreeIfPresent` returns
early (`gh-release-deliver.ts:169`); local branch absent → `deleteLocalBranch` returns early
(`git-utils.ts:275`); remote branch absent → `deleteRemoteBranch` returns early, probing with
`git ls-remote --heads` rather than `--exit-code` so a network failure rejects instead of reading as
"absent" (`:292`); PR closed/absent → skipped; Jira version absent → skipped.

**The mechanism that keeps this resumable is a deliberate omission: `--version` is NOT validated
against a discovered release set.** `resolveReleaseBranch` is pure string formatting with no lookup
(`release-utils.ts:285-294`), so `--version 1.2.5` addresses a half-removed release fine. This is the
opposite of `worktrees-remove`'s `assertTargetsExist` (`worktrees-remove.ts:66`, docblock `:59-65`,
called `:144`), which validates _because its downstream fails open_ — there, an unmatched name builds
a path that does not exist and the removal reports a no-op as success. Here every downstream no-op is
a verified early return.

> **Why a copy-paste of `assertTargetsExist` into this command would be catastrophic, not merely
> unhelpful:** it validates against `currentWorktrees`, and by the time `release remove` reaches its
> second run **the worktree is gone by design**. It would refuse _every_ resume run — the command's
> primary use case. T3 pins this.

**The bound (Architect REQUIRED 4 — accepted).** Without a terminal check, a typo'd `--version 1.2.6`
for `1.2.5` reports every step "absent/skipped" and **exits 0 with a confident success report** — the
same class of fail-open D5 and Principle 2 exist to close, arriving through the door left open on
purpose. **Fix, without re-adding target validation:** a terminal preflight predicate on the plan
object — if there is **no worktree AND no PR in any state AND no local branch AND no remote branch
AND no Jira version**, refuse:

```
operation:      remove release 9.9.9
stderrExcerpt:  found no worktree, no PR (any state), no local or remote branch, and no Jira fix version
remediation:    nothing named "9.9.9" exists to remove — check the spelling against `infra-kit
                release list`. (A release this command already removed keeps a CLOSED PR, so a
                genuine re-run is not affected.)
```

**Why this does not contradict AC-15 (a fully-removed release re-runs clean).** GitHub PRs cannot be
deleted, only closed — so a release _this CLI removed_ keeps a `CLOSED` PR forever, and the "no PR in
any state" conjunct never fires for it. Without this sentence the refusal and AC-15 read as a direct
contradiction and an implementer would resolve it by weakening one of them.

_The one genuine edge:_ a release whose PR creation failed, later fully removed, then re-run — no PR
ever existed, so it refuses. That is indistinguishable from a typo by construction, the refusal text
says so, and a refusal costs nothing.

#### The one detectable failure preflight cannot precede

D4 claims step 0 moves every detectable failure ahead of the confirm. **One hole, stated rather than
papered over:** a **dirty release worktree**. `removeOne` runs bare `git worktree remove`
(`remove-worktrees.ts:240`) with no `--force`, and git refuses on modified or untracked files;
`assertCleanCheckout` cannot see it because it reads the **main checkout's** status
(`git-guard.ts:72`, called from `assertManagementContext` `:145`). Preflight therefore adds a
`git -C <worktreePath> status --porcelain` probe when the worktree exists, and refuses with the
worktree's own dirty paths. If that probe is dropped in implementation, step 1 is the one failure the
confirm cannot precede and D4 must say so — it must not silently remain a claim that is false.

### D5 — Self-destruction guards — _unchanged in substance; both reviews found it sound_

Two hazards: (1) operator inside the release's linked worktree — covered by `assertManagementContext`
(`git-guard.ts:145-158`); (2) operator standing on `release/vX` in the main checkout —
`deleteLocalBranch` returns silently (`git-utils.ts:277-279`), so a naive composition reports success
with the branch still present. This is PM-1.

**Pick: switch to the base branch, then delete, then verify.** Precedent, verbatim
(`gh-release-prs.ts:209-211`): _"`git switch` has to come first because `deleteLocalBranch` silently
no-ops on the current branch, so a rollback that skipped it would report success while leaving the
branch in place"_; and `:232-235`: _"the delete is checked rather than assumed — a cleanup that
quietly did nothing is worse than one that says so."_

- Base = `getBaseBranch(detectReleaseType(prTitle ?? ''))` — the derivation `release create` uses;
  `detectReleaseType` returns `'regular'` for anything not starting with "hotfix", so a release with
  no PR falls to `dev`. The chosen base is named in the confirm text.
- `assertBaseBranchSwitchable({ operation, base })` runs **in preflight, before the confirm**
  (`git-guard.ts:111`); its own docblock gives the reason — it _"moves the failure ahead of the
  confirmation prompt instead of into the middle of a batch that has already created releases."_
- The switch fires at step 4 only when `getCurrentBranch() === branch`.
- **After** `deleteLocalBranch`, a new `branchExists(branch)` primitive re-probes and the command
  throws if it returns true. This converts the fail-open into a fail-closed.

**Note on `-D`.** `deleteLocalBranch` force-deletes, and its docblock's justification
(`git-utils.ts:265-272`) is that _"a delivered release branch was squash-merged — its tip is
unreachable from the base"_. `release remove` targets an **undelivered** release by D3, so `-D` here
discards genuinely unmerged commits. That is intended — an abandoned release branch is exactly what
this removes — but it is the most destructive local act in the command, and it is a second
independent reason the tip SHA must be captured in preflight and printed.

### D6 — Selection surface

**Pick: a single `--version <ref>`. No `--versions`, no `--all`.**

`worktrees remove --all` is defensible _because it is reversible_ — its own tool description says the
release branches and commits are never deleted. Nothing here is recreatable. A destructive `--all`
would be one keystroke from deleting every fix version in the project. Multi-target would also force
continue-on-error semantics that destroy the residue report. The N-invocations cost is the point:
friction proportional to blast radius.

- **Interactive:** `pickReleaseBranch` over open release PRs, fed by `formatBranchPickerItems`. Note
  the recorded fact that picker descriptions key off the **Jira** name (`formatJiraName(id)`), not
  the branch — reuse the helper.
- **Empty picker:** log _"no open release PRs — pass `--version <ref>` to remove a release that is
  already partially torn down"_. This is the resume affordance.
- **Non-TTY / `--json` / MCP:** `pickReleaseBranch` calls `assertInteractive`
  (`«cli»/src/lib/prompts/release-picker.ts:35-44`), which throws. **But its remediation is shared
  and names flags this command rejects** — _"CLI: `--version`/`--versions`/`--all`"_. This command
  accepts only `--version`, so the shared string advertises two options it will reject as unknown.
  Revision 1's AC-2 certified that text. Resolution: the command **catches `assertInteractive`'s
  error and re-throws with its own remediation naming only `--version`**; the shared helper is left
  alone, because three other commands legitimately accept all three flags. AC-5 pins the corrected
  text.

**Headless confirm — a fourth exit path that must not read as success.** `confirmOrExit` calls
`withEscape(…, { whenHeadless: 'refuse' })` (`«cli»/src/lib/command-echo/confirm-or-exit.ts:64`) and
the decline path is `process.exit(0)` (`:77`). So `infra-kit release remove --version 1.2.5` in CI or
a pipe **without `--yes`** would exit 0 having done nothing — indistinguishable from AC-15's
"fully-removed, every step skipped".

**Pick: `confirmOrExit(…, { throwOnDecline: true })` for this command**, letting the error fall
through `entry/cli.ts`'s generic handler (`:45-57`) to exit 1 with a readable message.

**State the divergence plainly rather than implying the docblock supports it.** The option exists
(`ConfirmOrExitOptions.throwOnDecline`, `:35-49`), but `CommandDeclinedError`'s own docblock says
callers who opt in are _"responsible for catching it and exiting 0"_ (`command-declined-error.ts:6-7`),
and its only existing consumer does exactly that — `gh-merge-dev.ts:477` swallows it and returns a
`declined: true` report at exit 0. **`release remove` is deliberately the first caller to use
`throwOnDecline` for exit-code semantics rather than the leak safety the docblock describes.** Two
things make that defensible: the default is not being flipped (the docblock's _"must stay that way"_
binds the default, not a per-caller opt-in), and this command's decline genuinely must not read as
success — an operator scripting `release remove && …` would otherwise proceed as though a release had
been torn down. The Esc/decline split is deliberate and matches the entry file's own distinction:
**Esc = "I never answered" → exit 0** (`isPromptCancellation`, `:49-52`); **"n" = "I answered, and the
answer was no" → exit 1.**
**This makes the step-0 "acquire nothing before the confirm" ordering load-bearing rather than
incidental** — a future edit that opens a handle before the prompt breaks it.

### D7 — MCP exposure — **REVERSED from revision 1**

**Pick: `mcpExposed: true`, `requiresHumanConfirm: true`, with the Jira step omitted over MCP.**

Revision 1 chose CLI-only on the `release-deliver` precedent. Both reviews rejected the reasoning on
independent grounds, and re-reading the catalog shows they are right:

- **The two supporting facts do not discriminate.** (1) _The boundary auto-confirms_ (`«cli»/src/types.ts:78-84`)
  is true of **every** exposed mutating tool, including `release-create`, `worktrees-remove` and
  `local-deploy-all`; if it disqualified a tool, the entire exposed mutating set would be
  disqualified. (2) _The two-phase gate is degraded for v1-SDK clients_ — true, and it **fails safe
  (the tool never runs)** — but the catalog already ships a whole set of gated tools under that same
  degradation, **eight** of them at the time of writing (`gh-merge-dev`, `release-create`,
  `gh-release-deploy-all`, `gh-release-deploy-selected`, `env-clear`, `worktrees-remove`,
  `local-deploy-all`, `local-deploy-selected`); revision 2 said five, and the argument is stronger at
  the true number. Declining to add one more is a statement about the gate, not about this command.
- **The stated criterion contradicts this plan's own table.** D7 quoted _"genuinely irreversible ⇒
  CLI-only"_. D4's table marks **one of six** steps irreversible and gives repair paths for the other
  five. A whole-command exclusion on the strength of one step is a selective warrant.
- **The governing rule in this repo is allowlist, not verb.** Roughly half the exposed set mutates
  (12 at the time of writing); `worktrees-add` runs `pnpm install` on the low-risk allowlist. The
  enforced rule is
  `LOW_RISK_MUTATING_ALLOWLIST` membership **or** `requiresHumanConfirm`
  (`command-catalog.test.ts:235-248`). The catalog says so about the closest analogue in its own words
  (`:65-68`): _"`worktrees-remove` IS exposed — git protects tracked work and its own invariants (no
  MCP `all=true`, error on unmatched target) contain the residual risk."_
- **P5 was being applied selectively.** `release-create` is `mcpExposed: true`
  (`command-catalog.ts:242-248`), and `plugins/infra-kit/commands/` contains **exactly one file** —
  `release-create.md` — whose body tells the agent to follow the MCP workflow resource and _"do not
  improvise with git or gh"_ if the server is absent. The plugin's entire command surface exists to
  make agents create releases. Under revision 1's D7, every one of those releases was a one-way door
  for the agent that made it, and the remedy was a five-step manual runbook — the exact thing Option
  B was rejected for.

**What keeps the unrecoverable act human-only: the Jira step is not attempted over MCP.**

Over MCP the command runs steps 1-5 and reports `jira: 'manual'` with the fix version's id, name and
URL, plus the instruction to remove it in the Jira UI or via the CLI. So an agent can undo the five
reversible artefacts it created and can never reach the one irreversible call — which also means
exposure does not depend on U1-U3 being measured. This is `worktrees-remove`'s shape (expose, gate,
narrow over MCP), minus the fan-out guard, which D6 makes unnecessary by being single-target.

**MCP-only guard — `assertMcpRemoveInput`**, modelled on `assertMcpRemovalInput`
(`worktrees-remove.ts:39-57`) and applied to the shared handler so a direct call cannot bypass it:

1. `version` is **required** over MCP (the picker needs a TTY). Also required in the tool's
   `inputSchema`, belt and braces.
2. `moveIssuesTo` is **refused** over MCP — the Jira step does not run there, so accepting the flag
   would let an agent believe it reassigned issues that were never touched.
3. `skipJira` is refused as meaningless over MCP for the same reason.

**The tool `description` must say the Jira step will not run — not only the result.** An agent decides
whether to call a tool from its description; if `jira: 'manual'` is discoverable only afterwards, an
agent may reasonably report "release removed" and never surface the URL a human has to act on. The
description states plainly that this tool removes the worktree, editor entry, PR and both branches,
and that **the Jira fix version is deliberately left in place** for a human, returned as
`jira: 'manual'` with its id, name and URL.

**Catalog wiring this restores** (revision 1 dropped all of it, which was correct _only_ under
`mcpExposed: false`):

**Every row is a delta.** No absolute count below is a fact about this change — see §3.4 for why.

| Artefact                                      | Edit (expressed as a delta)                                                                                                                                                                                             | Verified predicate                                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `EXPECTED_EXPOSED_TOOLS`                      | **add one entry** (`'release-remove'`) and **increment whatever `toHaveLength(N)` currently asserts by one**. Also fix the enclosing `it(...)` title, which already names a count its own assertion contradicts (§3.4). | `command-catalog.test.ts` — the array and its length assertion                |
| `EXPECTED_GATED_TOOLS`                        | **add one entry**                                                                                                                                                                                                       | derived from `mcpExposed && requiresHumanConfirm === true`                    |
| `MCP_TOOL_PRESENTATION`                       | **add one row**, with a one-line justification citing the call site that proves network reach                                                                                                                           | T3 asserts exact bidirectional correspondence with `getExposedMcpTools()`     |
| `LOW_RISK_MUTATING_ALLOWLIST`                 | **no edit** — `requiresHumanConfirm: true` satisfies default-deny                                                                                                                                                       | the filter is `mutating && mcpExposed && requiresHumanConfirm !== true`       |
| `palette.test.ts` grouped rows                | **append one label**, `'release remove'`, after `'release deliver'` in the Release Management array (catalog insertion order)                                                                                           | a hardcoded `toEqual`, **not** derived — see §3.4 C1                          |
| `mcp-stdio.e2e.test.ts` `AUTHORED_TOOL_NAMES` | **add one name**                                                                                                                                                                                                        | the `.size` self-check adjusts automatically — see §3.4 C2                    |
| Golden snapshot                               | **gains exactly one tool object**, nothing else changed                                                                                                                                                                 | the single `exports[...]` key in `__snapshots__/command-catalog.test.ts.snap` |

Presentation row (`title` + the one annotation nothing derives):

```ts
// release-remove.ts closes the PR via `gh pr close` and deletes the origin branch through
// deleteRemoteBranch (git-utils.ts:291); the Jira leg is MCP-unreachable but the gh/git legs are not.
'release-remove': { title: 'Remove a release', openWorld: true },
```

### D8 — Scope of "locally"

Read, not assumed. **In scope:**

1. **The git worktree** at `<projectRoot><WORKTREES_DIR_SUFFIX>/<branch>`, via `removeWorktrees`
   (`remove-worktrees.ts:259`). This also closes the **cmux workspace** by cwd
   (`closeCmuxWorkspaceByCwd` inside `removeOne`) — it comes free and is named in the confirm text so
   operators know their window will close.
2. **The Cursor `.code-workspace` folder entry**, surgically and verifiably
   (`remove-ide-worktree-folders.ts:92-114`).
3. **The local git branch** (D5), force-deleted, tip SHA captured and printed.
4. **Everything inside the worktree directory**, including gitignored contents: a hydrated `.env` of
   Doppler secrets (`env-load` re-fetches) and `node_modules`/`dist`.

**Deliberately NOT done:**

- **Zed's folder set.** `allowEditorRelaunch: false` (D4 step 2). The command prints Zed's own hint
  to close the folder manually (`:133-136`). Stated here because an implementer reading a bare "IDE
  folders are removed" would wire `!confirmedCommand` and silently start dropping unrelated open
  folders.

**Explicitly NOT in scope, because no release-keyed state exists there:**

- **dev-context fragments** are keyed by _app folder name_ (`<app>.json`,
  `«cli»/src/lib/dev-context/dev-context.ts:49`), never by branch or release.
- **`~/.infra-kit/projects/<repo>/`** holds the Layer-3 config override keyed by main-repo root. No
  per-release entry, no name→release map.
- **The worktrees container directory** and its `release/`/`feature/` subfolders, left in place by
  `removeWorktrees` (`:255-257`) so the per-repo scaffold survives.

**Corrected from revision 1:** the `.omc/` sweep is **not** a cleanup this command performs. It runs
only inside `recoverFromRejectedRemove` (`remove-worktrees.ts:194`), only when git has **already
unregistered** the worktree, and only for an allowlisted leftover; a path git still lists is _"a real
refusal (dirty tree) and is reported as such"_ (`:186-193`). Listing it as scope implied a cleanup
that does not exist. What _is_ true: `.omc/` inside the worktree directory goes with the directory
when `git worktree remove` succeeds, and the recorded hazard that closing a Claude tab re-creates
`<worktree>/.omc` seconds later is what the ENOTEMPTY single-retry recovery exists for.

---

## 3. File-by-file implementation plan

### 3.1 New files

**`«cli»/src/commands/release-remove/release-remove.ts`**

```ts
export interface ReleaseRemoveArgs extends RequiredConfirmedOptionArg {
  version?: string
  moveIssuesTo?: string
  skipJira?: boolean
}

/** Step ids in execution order — also the vocabulary of the residue report. */
type RemovalStep = 'worktree' | 'ide-folders' | 'pr' | 'local-branch' | 'remote-branch' | 'jira'

interface ReleaseRemovePlan {                 // resolved by preflight, before any mutation
  branch: string
  id: ReleaseId
  label: string
  baseBranch: string
  worktreePresent: boolean
  worktreeDirty: string[] | null              // porcelain paths, when a worktree exists
  localTipSha: string | null                  // captured here, NOT parsed from `git branch -D`
  remoteTipSha: string | null
  pr: PRStatus | null                         // hoisted type; `--state all`
  jira: { version: JiraVersion; fixCount: number; affectsCount: number } | null
  moveIssuesTo: JiraVersion | null
}

const assertMcpRemoveInput  = (args: ReleaseRemoveArgs): void            // D7: version required; refuses moveIssuesTo/skipJira
const assertNotMerged       = (plan: ReleaseRemovePlan): void            // D3
const assertJiraRemovable   = (plan: ReleaseRemovePlan): void            // D2b per-count + D2c
const assertSomethingExists = (plan: ReleaseRemovePlan): void            // D4 terminal predicate
const buildPlan             = async (branch: string, args): Promise<ReleaseRemovePlan>
const runStep = async <T>(step: RemovalStep, done: DoneStep[], fn: () => Promise<T>): Promise<T>
const tryStep = async (step: RemovalStep, done: DoneStep[], fn: () => Promise<void>): Promise<void>  // best-effort; warns, never throws

export const releaseRemove = async (args: ReleaseRemoveArgs) => { … }
export const releaseRemoveMcpTool = defineMcpTool({
  name: 'release-remove', requiresHumanConfirm: true, /* inputSchema requires `version` */ …
})
```

Handler order (mirrors `worktreesRemove`'s guard ordering, which its own tests pin):

1. `assertManagementContext({ operation: 'remove a release' })` — **first**, so a linked-worktree
   caller gets worktree advice rather than a config error.
2. `getInfraKitConfig()` — **below** the guard above and **above** the `try` whose catch rewraps,
   because its missing-config throw is a plain `Error` whose text `buildMessage` would drop.
3. `assertMcpRemoveInput(args)`.
4. Resolve the target: `--version` → `resolveReleaseBranch` (**no** target validation, D4); else
   `pickReleaseBranch(...)`, re-throwing `assertInteractive`'s error with a `--version`-only
   remediation (D6).
5. `buildPlan` → `assertNotMerged` → `assertJiraRemovable` → `assertSomethingExists` →
   `assertBaseBranchSwitchable` → dirty-worktree probe.
6. `commandEcho.addOption('--version', label)` (+ `--move-issues-to` / `--skip-jira` when set).
7. `confirmOrExit(confirmedCommand, <inventory message>, { throwOnDecline: true })`, then
   `commandEcho.addOption('--yes', true)`.
8. Steps 1-6 of D4 — step 2 via `tryStep`, the rest via `runStep`, with the D2e and D3 re-probes
   immediately before steps 6 and 3 respectively.
9. `commandEcho.print()`; return `{ content, structuredContent }`.

The confirm message is load-bearing (Option C's rejection rests on it) and must name: the release
label and branch, the PR number and state, **both** Jira issue counts separately, the fix version
name, the worktree path, the base branch it will switch to, the local tip SHA, and — when a cmux
workspace exists — that the window will close.

**`«cli»/src/commands/release-remove/index.ts`** — `export { releaseRemove, releaseRemoveMcpTool } from './release-remove'`

**`«cli»/src/integrations/jira/remove-version.ts`** (a leaf module, so tests can mock it without a
barrel partial-mock dropping siblings — the hazard commented at `gh-release-deliver.ts:8-12`):

```ts
export interface JiraVersionIssueCounts { issuesFixedCount: number; issuesAffectedCount: number }
export const getVersionRelatedIssueCounts = async (versionId: string, config: JiraConfig): Promise<JiraVersionIssueCounts>
export interface RemoveJiraVersionParams { versionId: string; moveFixIssuesTo?: string; moveAffectedIssuesTo?: string }
export const removeJiraVersion = async (params: RemoveJiraVersionParams, config: JiraConfig): Promise<void>
```

Same Basic-auth shape as `api.ts:79-88`; failures routed through the now-exported `assertJiraOk`
rather than a second classifier (a fork would silently lose the seraph-header classification that
makes a 404 read as "auth").

**`«cli»/src/integrations/gh/pr-status.ts`** — the hoisted `PRStatus` type and `fetchPRByHead`
(§3.2), exported from `«cli»/src/integrations/gh/index.ts`.

**`«cli»/src/lib/worktrees/remove-release-worktree.ts`** — the hoisted worktree helper (§3.2).

### 3.2 Edited files

| File                                                                                    | Edit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `«cli»/src/lib/git-utils/git-utils.ts`                                                  | Add `export const branchExists = (branch: string): Promise<boolean>` beside `deleteLocalBranch` (`:273`); docblock states _why_ — `deleteLocalBranch` fails open on the current branch, so callers that must not fail open verify. Export from the index.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `«cli»/src/integrations/jira/api.ts`                                                    | Export `assertJiraOk` (`:29`) — `const` → `export const`; no behaviour change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `«cli»/src/integrations/jira/index.ts`                                                  | Re-export `getVersionRelatedIssueCounts`, `removeJiraVersion`, `JiraVersionIssueCounts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `«cli»/src/commands/gh-release-deliver/gh-release-deliver.ts`                           | **Two hoists out**, both imported back. (1) `PRStatus` + `fetchPRByHead` (`:62-72`) → `src/integrations/gh/pr-status.ts`. (2) `removeReleaseWorktreeIfPresent` (`:166`) → `src/lib/worktrees/remove-release-worktree.ts` — **not a byte-identical move**, see the next row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `«cli»/src/commands/gh-release-deliver/__tests__/remove-release-worktree.test.ts`       | **Two edits, both forced by the hoist.** `:6` imports `removeReleaseWorktreeIfPresent` from `'../gh-release-deliver'` — a path the hoist relocates — and `:68` asserts `await expect(removeReleaseWorktreeIfPresent(RELEASE_BRANCH)).resolves.toBeUndefined()`, which `Promise<string[]>` breaks. Revision 2's _"Deliver's call site ignores the new return"_ was true of the **production** caller (`gh-release-deliver.ts:420`) only; this is a second consumer that **asserts** the return value. §7 step 2 already runs this directory, so it cannot ship silently — but §3.2 is the implementation contract and must name it.                                                                                                                                                                                                                                                                                                                        |
| ↳ the worktree hoist, specifically                                                      | The signature changes twice over. **(a)** Both failure strings at `:182-186` are merge-specific and must become parameters — not just `operation` (`:183`, _"remove worktree for X **before merge**"_) but also `remediation` (`:184`), which tells the operator to run `git worktree remove --force`, an escape this repo has deliberately refused (`«cli»/readme.md:58` documents `worktrees remove` as having _"no `--force`"_; `removeOne` runs it bare at `remove-worktrees.ts:240`). Handing a teardown operator a `--force` suggestion would undo that policy through a hoisted string. **(b)** It returns `Promise<void>`; `removeIdeWorktreeFolders` needs `removedWorktrees` and **returns `[]` immediately when that is empty** (`remove-ide-worktree-folders.ts:49`), so the helper must return the removed branches (`Promise<string[]>`) or step 2 is a no-op for a second, independent reason. Deliver's call site ignores the new return. |
| `«cli»/src/lib/worktrees/index.ts`                                                      | `export { removeReleaseWorktreeIfPresent } from './remove-release-worktree'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `«cli»/src/integrations/gh/index.ts`                                                    | `export { fetchPRByHead } from './pr-status'; export type { PRStatus } from './pr-status'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `«cli»/src/lib/program/program.ts`                                                      | Add `configureReleaseRemove` beside `configureReleaseDeliver` (`:230-238`) with `-v, --version <version>` (help string copied verbatim from `:233`, which already documents that a release _name_ is accepted), `--move-issues-to <version>`, `--skip-jira`, `-y, --yes`, and `.action(async (options) => { emit(await releaseRemove({ … })) })`. Register at `:417`: `configureReleaseRemove(releaseGroup.command('remove'))`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `«cli»/src/lib/command-catalog/command-catalog.ts`                                      | Import `releaseRemoveMcpTool`; entry after `release-deliver` (`:282`): `{ cliName: 'release-remove', menuGroup: 'release', mcpTool: releaseRemoveMcpTool, mcpExposed: true, mutating: true, groupPath: ['release','remove'] }`. Add the `MCP_TOOL_PRESENTATION` row from D7 with its justification comment. **No** `LOW_RISK_MUTATING_ALLOWLIST` edit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `«cli»/src/lib/command-catalog/__tests__/command-catalog.test.ts`                       | **Deltas, not absolutes** (§3.4): add one entry to `EXPECTED_EXPOSED_TOOLS`; **increment whatever `toHaveLength(N)` currently asserts**; add one entry to `EXPECTED_GATED_TOOLS`. **And fix the enclosing `it(...)` title** — it already names a count its own assertion contradicts, so a mechanical edit ships a test named for one number and asserting another.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `«cli»/src/lib/command-catalog/__tests__/palette.test.ts`                               | **Append `'release remove'`** after `'release deliver'` in the Release Management array of the hardcoded `toEqual` (the `it('renders seven honest groups…')` block). Catalog insertion order governs the position. This is **not** covered by the derived menu invariants — see §3.4 C1 and the §5.3 correction. Group count is unchanged, so the test title stays accurate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `«cli»/src/mcp/__tests__/mcp-stdio.e2e.test.ts`                                         | **Add `'release-remove'` to `AUTHORED_TOOL_NAMES`** ((tree) `:1116`). The `.size` self-check ((tree) `:1128`) adjusts automatically. **Carries a sequencing dependency on another session's unlanded work — see §3.4 C2.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `«cli»/src/lib/command-catalog/__tests__/__snapshots__/command-catalog.test.ts.snap`    | Regenerate — **it must gain exactly one tool and change nothing else** (AC-23).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `«cli»/resources/root/body.md:10`                                                       | Extend the release line to include `release remove`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **`/CLAUDE.md` (repo root)**                                                            | The generated block at `:17-41` — release line **`:29`** — is regenerated by `infra-kit audit --fix --root`. **This is an edited file and it is checked by root qa** (§3.3 contract 5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `«cli»/src/lib/agent-guidance/__tests__/__snapshots__/bodies-snapshot.test.ts.snap:351` | Update the snapshot line. **`bodies.test.ts` needs no edit** — its only release assertion is `toContain('`ik release merge-dev`')` (`:149`), a substring of `body.md` line 11, a different line from the one edited. Verified; do not "helpfully" add an assertion. Recorded hazard: prettier owns the bytes of `.md` resources.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `«cli»/readme.md`                                                                       | Add a `release remove` row to the Release table (after `:51`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### 3.3 Wiring contracts — five, not four

1. **`program.ts`** — `configureReleaseRemove` + registration. Without it the command does not exist.
2. **`command-catalog.ts`** + its test lists + the golden snapshot + **`palette.test.ts`** +
   **`mcp-stdio.e2e.test.ts`** — a larger surface than revision 1 claimed, because D7 is reversed, and
   larger than revision 2 listed, because two of these are hardcoded rather than derived (§3.4 C1,
   C2). Without the entry the command is invisible to the palette; without the test-list edits CI
   reds.
3. **`defineMcpTool`** co-located, exported, referenced by the catalog, `requiresHumanConfirm: true`,
   `version` required in `inputSchema`.
4. **`«cli»/resources/root/body.md`** — the source of the generated guidance block. Without it every
   consumer's `CLAUDE.md` keeps advertising a command list that omits `release remove`.
5. **The repo's own `/CLAUDE.md` generated block — and it is inside root qa.** Measured:
   `infra-kit-check` ends in `"infra-kit-check-root": "pnpm exec infra-kit audit --root"`, the block
   lives at `/CLAUDE.md:17-41`, and its release line (`:29`) derives from `body.md:10`. **Editing
   `body.md` without regenerating the block reds `infra-kit-check-root`.**

   **The stale-`dist/` trap, and how §7 avoids it.** `infra-kit` is a root devDependency at
   `workspace:*`, so `pnpm exec infra-kit` runs the **workspace build** — and the recorded repo fact
   is that qa has **no build step** (turbo `test` depends on `^build`, i.e. dependencies, not self).
   Running `audit --fix --root` against a stale `dist/` therefore re-emits the **old** line and
   silently masks the drift: the "dist-reading is vacuous" failure class, arriving through the audit
   lane. §7 puts an explicit `pnpm --filter infra-kit run build` **before** the audit step, and AC-25
   pins the regenerated line.

   **The version marker.** `<!-- infra-kit:version 0.4.0 -->` (`/CLAUDE.md:18`) is part of the
   generated block. **This change must not move it.** A marker bump is a wire-visible diff in every
   consumer repo, and nothing about adding a command to the body text changes the block's format
   version. If regeneration moves it, that is a signal the working tree's version differs from the
   one that last wrote the block — investigate rather than commit.

### 3.4 The collision surface, and why this plan states no absolute counts

**Read this before the first edit.**

A concurrent `setup-dependency-status` landing is in flight in the same working tree. Six files are
touched by **both** landings, five of them currently modified-and-uncommitted:

| File                                                                                 | State           | What both landings do to it                                                                                           |
| ------------------------------------------------------------------------------------ | --------------- | --------------------------------------------------------------------------------------------------------------------- |
| `«cli»/src/lib/command-catalog/command-catalog.ts`                                   | `M` uncommitted | each adds one catalog entry                                                                                           |
| `«cli»/src/lib/command-catalog/__tests__/command-catalog.test.ts`                    | `M` uncommitted | each adds entries to `EXPECTED_EXPOSED_TOOLS` (+ `EXPECTED_GATED_TOOLS` for ours) and increments the length assertion |
| `«cli»/src/lib/command-catalog/__tests__/__snapshots__/command-catalog.test.ts.snap` | `M` uncommitted | each adds one tool object                                                                                             |
| `«cli»/src/lib/command-catalog/__tests__/palette.test.ts`                            | `M` uncommitted | each appends one label to a hardcoded `toEqual`                                                                       |
| `«cli»/src/lib/program/program.ts`                                                   | `M` uncommitted | each registers a command                                                                                              |
| `«cli»/src/mcp/__tests__/mcp-stdio.e2e.test.ts`                                      | `M` uncommitted | each adds a name to `AUTHORED_TOOL_NAMES`                                                                             |

**Why every count in this plan is a delta.** Measured directly, twice, a review cycle apart:

|                                     | `EXPECTED_EXPOSED_TOOLS` | `EXPECTED_GATED_TOOLS` |
| ----------------------------------- | ------------------------ | ---------------------- |
| HEAD `969bbe0`                      | 23                       | 8                      |
| Tree, when the reviews were written | 24                       | —                      |
| Tree, when revision 3 was written   | **26**                   | **10**                 |

An absolute count in this document was wrong within one review cycle, twice. So: **increment whatever
`toHaveLength(N)` currently asserts; add one entry to each list. The absolute number is not a fact
about this change.** AC-23 was already phrased this way (_"gains exactly one tool object"_) and is the
only count-adjacent criterion that survived both drifts — its phrasing is the model.

**A trap already present in the tree.** The `it(...)` title reads _"exposes exactly the expected 23
MCP tools"_ while its own assertion three lines later says `toHaveLength(26)`. It is stale **before
either command lands**. An implementer editing mechanically will ship a test named for one count and
asserting another; fix the title in the same edit.

**C1 — `palette.test.ts` is not derived, and §5.3 used to say it was.** The
`it('renders seven honest groups, labelled with the grouped path it actually runs')` block is a
hardcoded `toEqual` over every palette row, grouped and ordered; the Release Management array ends at
`'release deliver'`. A catalog entry with `menuGroup: 'release'` appends a row there and the assertion
goes red. The derived-from-`MENU_GROUPS` reasoning that makes `command-catalog.test.ts` need no edit
is true of _that_ file and false of this one. Proof this is real rather than hypothetical: the
concurrent session had to make exactly this one-line edit for its own command
(`+ 'setup-dependency-status'` in the Setup & Diagnostics array).

**C2 — `mcp-stdio.e2e.test.ts`, and a sequencing dependency on someone else's unlanded change.** The
w1 differential compares the served `tools/list` against a pre-migration v1 baseline fixture,
stripping tools registered after that baseline so the fixture keeps its evidential value. An exposed
`release-remove` is such a tool, so it must join `AUTHORED_TOOL_NAMES` or the differential compares
the served set against a fixture that predates it.

**The `Set`, its filter and its `.size` self-check exist only in the concurrent session's uncommitted
work.** Verified: `withoutAuthoredDeltas` _does_ exist at HEAD (`:1075`), but `AUTHORED_TOOL_NAMES`
does not appear anywhere in the HEAD blob. **So D7's exposure depends on another session's unlanded
change.** Two acceptable resolutions, and the implementer must pick one deliberately:

- **Land after that work commits** — the cheap path, and the expected one.
- **Own the mechanism** — if that work is reverted or lands in a different shape, `release remove`
  must add the strip itself, or the differential is unsatisfiable.

AC-27's unscoped `npx vitest run` catches this; §7 step 2's scoped run must therefore include
`src/mcp/` (it does, as of revision 3).

**Pre-implementation re-read — run this before the first edit, not from this document:**

```bash
cd /Users/arthur/projects/infra-kit/apps/infra-kit/cli
git status --short src/lib/command-catalog src/lib/program src/mcp
grep -n "toHaveLength(\|const EXPECTED_EXPOSED_TOOLS\|const EXPECTED_GATED_TOOLS\|expected .* MCP tools" \
  src/lib/command-catalog/__tests__/command-catalog.test.ts
grep -n "release deliver'" src/lib/command-catalog/__tests__/palette.test.ts
grep -n "AUTHORED_TOOL_NAMES" src/mcp/__tests__/mcp-stdio.e2e.test.ts
```

**The usual A/B move is unavailable here.** `git stash` is forbidden in this repo — a pnpm command run
while stashed rewrites `pnpm-lock.yaml` and wedges the pop — so `git show HEAD:<path>` is the only
safe comparison, and against a dirty tree it answers the wrong question anyway (it shows HEAD, not
what you are editing). Read the working tree directly, with the commands above.

---

## 4. Pre-mortem — three incidents, three months out

### PM-1 — "It said it removed it"

**Story.** An operator finishes on `release/v2.4.0` in the main checkout and runs
`infra-kit release remove --version 2.4.0 --yes`. Every line reads success. Three weeks later
`release create 2.4.0` fails with "branch already exists". The Jira version is gone, the PR is
closed, the remote branch is gone — and a local branch with 40 commits sits there with no PR, no fix
version, and nobody able to say what it was.

**Signal.** A post-delete existence probe. `deleteLocalBranch` returns `void` and nothing downstream
reads the branch again.

**Mitigation in the plan.** D5: switch to base before the delete, plus the `branchExists` assertion
that throws when the delete did not take. T4 runs the whole command with `getCurrentBranch()`
returning the target and asserts both the switch and the fail-closed. Additionally D4 captures the
tip SHA in preflight, so even the residue of a _partial_ run hands back the string that restores the
branch.

### PM-2 — "What shipped in 2.4.0?"

**Story.** A release is abandoned and removed. Its fix version carried 23 tickets. At sprint review
nobody can answer what was in it: both version fields are cleared on all 23, Jira kept no prior
value, and the issues are no longer enumerable by that version because the version is gone.

**Signal.** An issue-count probe before the delete — **taken at the moment of the delete, not six
steps earlier.**

**Mitigation in the plan.** D2b's per-count refusal with `--move-issues-to` mapping to **both**
Jira parameters (revision 1's single-parameter mapping was itself a data-loss hole inside this
mitigation, and its summed count made the refusal text wrong about what it was refusing); the counts
printed separately in the confirm text; and **D2e's re-probe immediately before the delete**, which
is what makes the guard a mitigation rather than a stale fact. T2 and T10.

### PM-3 — "Cleaning up old releases"

**Story.** Someone tidies a backlog of stale release branches. One shipped a fortnight ago: merged,
deployed, `released: true`. The merge commit survives on `main`, so the code is safe — but the fix
version that was the delivery record is gone, and with it the answer to "which release deployed
this", which the deploy audit references by version URL.

**Signal.** A PR-state probe and a `released`/`archived` check. `getReleasePRsWithInfo` sees only open
PRs, so nothing in the existing helpers can catch it.

**Mitigation in the plan.** Two independent guards, deliberately: D3 refuses on `state === 'MERGED'`
via the hoisted `fetchPRByHead`, and D2c refuses on `released || archived`. Either alone is dodgeable
— a hotfix delivered while Jira was down has an unreleased version with a merged PR; a version
released by hand has no merged PR. Neither is bypassable by `--yes`. D3's re-probe before step 3
closes the window where a merge lands mid-run. T1 and T2b cover them separately.

---

## 5. Test plan

House style (`«cli»/src/commands/worktrees-remove/__tests__/worktrees-remove-failure-report.test.ts:15-24`):
the docblock names the **exact false-success** the test prevents, and says which collaborators are
mocked and which stay real.

### 5.1 Unit — command

| File                                              | Invariant pinned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T1** `release-remove-merged-pr-refusal.test.ts` | A `MERGED` PR refuses **before any mutation**: `removeWorktrees`, `deleteLocalBranch`, `deleteRemoteBranch` and `removeJiraVersion` each called **zero** times. Prevents "the guard existed but ran after step 1". Case (b): `--yes` does not bypass it. Case (c): a PR that becomes `MERGED` between preflight and step 3 is refused by the **re-probe** with D3's message, not by an opaque `gh pr close` failure.                                                                                                                                                                                                                                                                                                                                                    |
| **T2** `release-remove-jira-guard.test.ts`        | (a) `issuesFixedCount > 0` refuses, `removeJiraVersion` never called; (b) `released: true` refuses **with the PR mocked absent**, proving D2c and D3 are two guards and not one; (c) `issuesFixedCount: 0, issuesAffectedCount: 2` — **the revision-1 dead end** — refuses without the flag and **succeeds with it**; (d) `--move-issues-to` passes **both** `moveFixIssuesTo` **and** `moveAffectedIssuesTo`; (e) an unknown `--move-issues-to` target fails in preflight (`removeWorktrees` never called); (f) **Jira unconfigured refuses unless `--skip-jira`** — pinning D2d's deliberate asymmetry with `deliverJiraReleaseSafely` (`gh-release-deliver.ts:348`), which is exactly what a later "consistency" refactor would delete.                              |
| **T3** `release-remove-resume.test.ts`            | (a) **The already-partially-removed re-run**: worktree absent, PR `CLOSED`, branches absent, Jira version `null` → **succeeds**, every step reported skipped with its reason. (b) `--version` on a release with no _open_ PR is accepted — no target validation is applied. The docblock states the sharpened hazard: a copy-paste of `assertTargetsExist` (`worktrees-remove.ts:66`) validates against `currentWorktrees`, which by the second run is **gone by design**, so it would refuse **every** resume — the command's primary use case. (c) **The typo case**: `--version 9.9.9` against an untouched repo → **throws**, does not exit 0 with an "everything skipped" success.                                                                                 |
| **T4** `release-remove-current-branch.test.ts`    | **The PM-1 fail-open.** With `getCurrentBranch()` returning the target: (a) `git switch <base>` is issued before the delete; (b) when `branchExists` still reports the branch after `deleteLocalBranch`, the command **throws** instead of reporting success. Docblock names the false-success verbatim.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **T5** `release-remove-order.test.ts`             | (a) The six steps run in D4's order. **Mechanism, stated because "assert call ordering" across five modules is not implementable as written:** a single `order: string[]` array that every mocked collaborator pushes its step name into, asserted with `toEqual`. (`mock.invocationCallOrder` is the fallback, but it compares opaque global counters and reads worse in a failure message.) (b) A failure at step 5 does **not** call `removeJiraVersion` and throws an `OperationError` enumerating the four completed steps, naming the surviving Jira version, **and carrying the local tip SHA**. (c) **A throwing `removeIdeWorktreeFolders` does not stop steps 3-6** and is reported as `attempted` — pinning D4's single exemption from abort-on-first-error. |
| **T6** `release-remove-guard.test.ts`             | Guard ordering: `assertManagementContext` throws before `getInfraKitConfig` is read; the missing-config message survives un-rewrapped; `assertBaseBranchSwitchable` runs before `confirmOrExit`. Mirrors `worktrees-remove-guard.test.ts`. **Plus the decline case, pinning AC-6** — the only behavioural criterion that had no test in revision 2: a declined confirm **throws `CommandDeclinedError`** rather than resolving, and no mutation collaborator is called. The docblock names the false-success: `confirmOrExit`'s default `process.exit(0)` would make a decline indistinguishable from AC-15's "already fully removed, every step skipped".                                                                                                              |
| **T7** `release-remove-echo-parity.test.ts`       | `commandEcho` reproduces the exact invocation (`--version`, `--move-issues-to`, `--skip-jira`, `--yes`), and the MCP tool's `outputSchema` validates the returned `structuredContent` (the zod round-trip the `worktrees-remove` echo-parity test performs).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **T8** `release-remove-mcp-guards.test.ts`        | **New for D7.** In MCP mode: (a) a call without `version` throws with a remediation naming `version`; (b) `moveIssuesTo` is refused; (c) **the Jira step is never attempted** — `removeJiraVersion` called zero times — and the result carries `jira: 'manual'` with the version id, name and URL; (d) on the CLI path with the same inputs, the Jira step **does** run **and `moveIssuesTo`/`skipJira` are accepted** — proving the narrowing is MCP-scoped and not a general disablement. Both halves of (d) are needed: without the "Jira runs" half a command that simply broke Jira would pass; without the "flags accepted" half a guard that refused them unconditionally would pass (a\)-(c\) and be caught only by T2(d).                                      |
| **T9** `release-remove-confirm-text.test.ts`      | **New.** The confirm message names the PR number, **both** issue counts separately (never a sum), the fix version name, the worktree path, the base branch, and the local tip SHA. Load-bearing because §1.3 rejects Option C on the grounds that this text carries the inventory; without this test that rejection rests on an unasserted string.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **T10** `release-remove-toctou.test.ts`           | **New.** (a) Issue counts unchanged between preflight and step 6 → the delete proceeds and nothing extra is logged. (b) Counts changed → the command **aborts before `removeJiraVersion`**, reporting steps 1-5 done and the version intact. Docblock names the false-success: a guard that passed six steps ago authorising an unrecoverable call.                                                                                                                                                                                                                                                                                                                                                                                                                     |

### 5.2 Unit — integration layer

| File                                                                   | Invariant pinned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T11** `«cli»/src/integrations/jira/__tests__/remove-version.test.ts` | Docblock subject is the **classification**, not the URL shape: a non-OK response must throw a _classified_ `JiraApiError` — assert `kind === 'auth'` for `404 + x-seraph-loginreason: AUTHENTICATED_FAILED`, the recorded misreport this repo already fixed once and which a hand-rolled second classifier would silently reintroduce. Secondary: `removeJiraVersion` POSTs to `/version/{id}/removeAndSwap` with Basic auth and includes each `move*` field only when supplied; `getVersionRelatedIssueCounts` parses both counts. |

### 5.3 Integration / wiring

| Check                                                                                 | Where                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `release remove` resolves as a Commander leaf and its `groupPath` matches the catalog | Covered with **zero edits** by `allMenuEntries()`/`allMenuPaths()`, which derive from `MENU_GROUPS` (`command-catalog.test.ts:24-35`). **This holds for `command-catalog.test.ts` ONLY.** Revision 2 generalised it to "the menu invariants", which was false: `palette.test.ts` asserts a hardcoded `toEqual` over every grouped row and **must** be edited (§3.4 C1). Do not read this row as "no menu test needs touching". |
| Exposure, gating and presentation                                                     | The three list edits in §3.2 plus T3's correspondence assertion (`:526-534`).                                                                                                                                                                                                                                                                                                                                                  |
| Golden snapshot moves by exactly one tool                                             | Regenerate, then **read the diff**: exactly one added tool object, no other key touched (AC-23).                                                                                                                                                                                                                                                                                                                               |
| Guidance body renders the new command                                                 | `bodies-snapshot.test.ts.snap:351`.                                                                                                                                                                                                                                                                                                                                                                                            |
| Root `/CLAUDE.md` block regenerated from a **fresh** build                            | §7 step 5; AC-25.                                                                                                                                                                                                                                                                                                                                                                                                              |

### 5.4 Manual gate on the implementation PR (live Jira + a real repo)

1. `infra-kit release create --version 99.0.0` in a scratch repo → note branch, PR #, fix version URL.
2. `infra-kit worktrees add`; open the Cursor workspace; confirm the cmux workspace exists.
3. `git switch release/v99.0.0` (the PM-1 setup).
4. `infra-kit release remove --version 99.0.0` → the confirm text carries the full inventory;
   afterwards `git branch --list` and `git ls-remote --heads origin` are both empty for it, the PR is
   CLOSED with our comment, the Jira URL 404s, the worktree is gone, the Cursor workspace entry is
   gone, **and Zed is untouched** with its manual-close hint printed.
5. Re-run → **exits 0**, every step skipped.
6. `--version 99.9.9` → **refuses** (D4 terminal predicate).
7. Attach one issue as `fixVersion` and one as `affectsVersion` to a fresh `v99.0.1`; attempt removal
   → refusal naming **both counts separately**; then `--move-issues-to v99.0.2` → **both** issues
   carry the new version (this is the live half of AC-11, unverifiable in unit test).
8. **U1/U2/U3 measurement**, recorded in a code comment — including the **post-state of a test
   issue**, not merely the HTTP status (D2a).
9. Over MCP: call the tool, confirm the gate, confirm steps 1-5 run and `jira: 'manual'` is returned
   with the fix version untouched in Jira.

### 5.5 Observability

- Each step logs at `info` on completion with its step id, so a partial run is reconstructable from
  the log alone.
- **The local and remote tip SHAs are logged before step 4** — the same rule §5.5 already applies to
  the Jira id, and the reason revision 1's residue table was wrong: after steps 4-5 the SHA is the
  only handle that restores the branch, and `git branch -D`'s own `(was <sha>)` output is discarded
  by `deleteLocalBranch` and is a localizable string besides.
- The Jira step logs the version **id and name** before deletion — the id is the only handle that
  exists afterwards and is what an Atlassian support request needs.
- **Guard** refusals log at `warn`, not `error`: a refused removal is the command working. **This rule
  does not cover the decline** — revision 2 said "refusals log at `warn`, never `error`", which is
  false for the most ordinary refusal there is. An uncaught `CommandDeclinedError` falls through
  `entry/cli.ts`'s catch (`:45`) past the prompt-cancellation branch (`:49-52`) to
  `logger.error(message)` (`:56`) and `process.exit(1)` (`:57`). That renders as
  `Operation cancelled by the operator` at **exit 1**, with no stack trace — readable, non-zero, and
  **satisfying AC-6 with no code change**. D6's phrase "let the CLI entry render the refusal" means
  this fallthrough; there is no dedicated rendering path and none is needed.
- `logger.debug` carries the resolved `ReleaseRemovePlan`, so a support session can see what preflight
  decided without re-running anything.
- A **declined** confirm throws `CommandDeclinedError` (D6) rather than `process.exit(0)`, so a
  decline is never mistaken for a completed removal by a caller reading the exit code.

---

## 6. Acceptance criteria

Each is independently verifiable by an engineer who was not in this conversation. Revision 1's
AC-1/2/4/10/14 were split or replaced; the snapshot criterion (now AC-23) inverts with D7; five criteria are new.

**Removal behaviour**

1. Given an open release with a worktree, a Cursor workspace entry, an OPEN PR, local and remote
   branches, and a fix version with zero attached issues: `infra-kit release remove --version <v>`
   ends with the worktree directory absent, the Cursor `.code-workspace` entry absent,
   `gh pr view <n> --json state` = `CLOSED`, `git branch --list release/v<v>` empty,
   `git ls-remote --heads origin release/v<v>` empty, and the fix version URL returning 404.
2. In the same run the steps execute in the order worktree → ide-folders → pr → local-branch →
   remote-branch → jira (T5a).
3. In the same run **Zed is not relaunched** and the returned Zed outcome is a declared skip with
   `removed: []`.
4. `infra-kit release remove` with no `--version` on a TTY presents the single-select picker.
5. The same command on a non-TTY, or with `--json`, throws an `OperationError` whose remediation
   names `--version` **and does not name `--versions` or `--all`**.
6. A non-TTY run **without `--yes`** exits **non-zero** with a "declined" message — never 0.

**Refusals (each must leave every artefact unchanged)**

7. A PR in state `MERGED` is refused; worktree, both branches, PR state and fix version are all
   verifiably unchanged.
8. A PR that becomes `MERGED` between preflight and step 3 is refused with the D3 message.
9. A fix version with `issuesFixedCount > 0` **or** `issuesAffectedCount > 0` is refused unless
   `--move-issues-to` is supplied; the refusal text reports the two counts **separately** and never
   sums them.
10. A fix version with `released: true` or `archived: true` is refused, independently of PR state.
11. With `--move-issues-to <target>`: the request carries **both** `moveFixIssuesTo` and
    `moveAffectedIssuesTo` set to the target's id (unit-verifiable), **and** the affected issues
    carry the new version afterwards (live-Jira, §5.4 step 7).
12. Jira unconfigured is refused unless `--skip-jira`.
13. `--version <ref>` matching no worktree, no PR in any state, no local branch, no remote branch and
    no fix version is refused, naming `release list`.
14. If the issue counts change between preflight and step 6, the command aborts **before**
    `removeJiraVersion` and reports steps 1-5 complete with the version intact.

**Resumability and failure reporting**

15. Running against an already fully-removed release exits 0 with every step reported skipped (this
    does not collide with AC-13: a release this CLI removed keeps a CLOSED PR forever).
16. Running against a partially-removed release completes the remaining steps and exits 0.
17. With `HEAD` on the target branch in the main checkout, the command switches to the base branch and
    the local branch is genuinely deleted; if the delete does not take, it throws.
18. Run from inside a linked worktree **with a clean tree**, the command refuses with the
    management-context remediation and mutates nothing. (The clean-tree qualifier matters:
    `assertManagementContext` refuses a dirty checkout too, `git-guard.ts:145,158`, so a test that
    dirties the tree would pass for the wrong reason.)
19. A failure at any step **other than `ide-folders`** aborts; the error names the failed step, the
    completed ones, and the local tip SHA. A failure at `ide-folders` does **not** abort.

**Surfaces, wiring and evidence**

20. The confirm message names: the release label and branch, the PR number and state, both issue
    counts separately, the fix version name, the worktree path, the base branch, and the local tip
    SHA.
21. The log carries the Jira version id and name before the delete, and both tip SHAs before step 4.
22. `release remove` appears in the CLI menu/palette under the `release` group and resolves as a
    Commander leaf.
23. `release-remove` appears in `tools/list` over MCP with `requiresHumanConfirm` gating, and the
    golden snapshot gains **exactly one** tool object with no other key changed.
24. Over MCP: a call without `version` errors; `moveIssuesTo` is refused; the Jira step is never
    attempted; the result carries `jira: 'manual'` with the fix version's id, name and URL.
25. After `pnpm --filter infra-kit run build && pnpm exec infra-kit audit --fix --root`, `/CLAUDE.md`
    line 29 lists `release remove`, the `<!-- infra-kit:version -->` marker at `:18` is unchanged, and
    a re-run of `infra-kit audit --root` exits 0.
26. The U1/U2/U3 measurements are recorded in a code comment in
    `«cli»/src/integrations/jira/remove-version.ts`, each naming the request, the response and the
    post-state of the test issue.
27. `npx vitest run`, `npx tsc -b`, cold `npx eslint --no-cache` and `npx prettier --check` over
    `«cli»` all exit 0, and `git status --short` shows no `??` files. (Replaces revision 1's AC-14 —
    see §7.)

---

## 7. Verification steps

**Why `pnpm run qa` is not the criterion.** Measured from the root `package.json`:

```
"qa": "pnpm run vendor:check && pnpm exec turbo run test ts-check prettier-check eslint-check infra-kit-check --continue --output-logs=errors-only && pnpm run test:claude"
```

`vendor:check` is **`&&`-chained first** and is already red on HEAD with no refresh command, so a
criterion of "qa is green" is unsatisfiable **and** the lane it nominally covers — `test`, `ts-check`,
`prettier-check`, `eslint-check`, `infra-kit-check` — never executes at all. The named lanes below are
the criterion (AC-27). **`vendor check` redness is pre-existing and must NOT be "fixed" by editing
`vendor/`** — that file set is checksum-guarded and editing it kills the whole gate.

```bash
cd /Users/arthur/projects/infra-kit

# 0a. FIRST: run §3.4's pre-implementation re-read. Five of the files this change edits are
#     modified-and-uncommitted by a concurrent landing, and every count in this plan is a delta
#     because the absolutes moved twice during review.

# 0b. Baseline BEFORE anything: the tree already carries ~10 modified manifests, so a naive
#    before/after diff cannot tell qa's rewrites from the pre-existing edits.
find . -name package.json -not -path '*/node_modules/*' -print0 | xargs -0 shasum > /tmp/manifests.before

# 1. Build FIRST — the audit lane reads dist/, and qa has no build step (turbo `test` depends on
#    ^build, i.e. dependencies, not self). Skipping this makes step 5 re-emit the OLD guidance line.
pnpm --filter infra-kit run build ; echo "EXIT=$?"

# 2. Tests, with an explicit exit code — rtk/turbo proxies can report 0 while failing.
#    Scope note: the catalog and mcp paths are DIRECTORIES, not single files. Revision 2 named
#    command-catalog.test.ts by path, which silently skipped palette.test.ts (§3.4 C1); and it never
#    entered src/mcp/, which skipped the AUTHORED_TOOL_NAMES differential (§3.4 C2).
npx vitest run \
  apps/infra-kit/cli/src/commands/release-remove \
  apps/infra-kit/cli/src/integrations/jira/__tests__/remove-version.test.ts \
  apps/infra-kit/cli/src/commands/gh-release-deliver \
  apps/infra-kit/cli/src/lib/command-catalog/__tests__ \
  apps/infra-kit/cli/src/mcp \
  apps/infra-kit/cli/src/lib/agent-guidance/__tests__ ; echo "EXIT=$?"

# 3. Types — vitest does not typecheck.
npx tsc -b apps/infra-kit/cli ; echo "EXIT=$?"

# 4. Lint COLD, and prettier SEPARATELY — `prettier-check` is its own turbo task, and this change
#    edits two .md files under the "prettier owns the bytes of .md resources" hazard.
npx eslint --no-cache apps/infra-kit/cli/src ; echo "EXIT=$?"
npx prettier --check apps/infra-kit/cli ; echo "EXIT=$?"

# 5. Regenerate the root guidance block from the FRESH build (contract 5), then prove it is stable.
pnpm exec infra-kit audit --fix --root ; echo "EXIT=$?"
pnpm exec infra-kit audit --root       ; echo "EXIT=$?"   # must be 0 on the second run
git diff CLAUDE.md                                        # release line :29 changed; marker :18 NOT

# 6. The snapshot must gain exactly one tool and nothing else (AC-23).
git diff apps/infra-kit/cli/src/lib/command-catalog/__tests__/__snapshots__/

# 7. Untracked files hide from a green lint run.
git status --short

# 8. Optional full gate. It will still die on the pre-existing vendor:check; run it only to confirm
#    nothing NEW broke, and diff the manifests afterwards.
pnpm run qa ; echo "EXIT=$?"
find . -name package.json -not -path '*/node_modules/*' -print0 | xargs -0 shasum > /tmp/manifests.after
diff /tmp/manifests.before /tmp/manifests.after   # a full qa REWRITES manifests + the vendor mirror
```

Recorded hazards honoured above: `rtk` proxies swallow exit codes (every gate carries `; echo
EXIT=$?`); `eslint --cache` can exit 0 while a cold run finds errors; `prettier --check` is a separate
gate from eslint; a full `pnpm run qa` rewrites manifests and the vendor mirror (baseline + diff);
`git status` for `??` files. **Never run a pnpm command while stashed** — it rewrites
`pnpm-lock.yaml` and wedges the pop; use `git show HEAD:<path>` for A/B comparisons.

Pre-existing flakes: `lock.test` and `portless-driver.test` flake under full-suite load and pass in
isolation. Re-run the file alone before calling either a regression.

---

## 8. ADR — `release remove` is a single-target, guard-first teardown, exposed to agents minus its one irreversible step

**Status:** proposed (pending approval). **Date:** 2026-09-10. **Supersedes:** revision 1's D7.

**8.1 Decision.** Add `infra-kit release remove`: one release, torn down across git worktree, Cursor
workspace entry, GitHub PR, local branch, remote branch and Jira fix version, in ascending order of
irreversibility, aborting on the first failure (except the cosmetic editor step) with a residue report
that carries the branch tip SHA. It refuses on a merged PR, on a fix version with issues attached
absent an explicit reassignment target, on a released or archived version, on an unconfigured Jira,
and on a target for which no artefact of any kind exists. It is exposed over MCP behind
`requiresHumanConfirm`, with the Jira step omitted there.

**8.2 Drivers.** (a) Deleting a Jira fix version is unrecoverable, clears two fields on real tickets
with no readable prior value, and its guard is separated from the act by an unbounded confirm.
(b) The primitives this composes fail _open_ — `deleteLocalBranch` no-ops on the current branch, the
release-PR projection discards the state it fetched, and Zed folder removal confirms nothing.
(c) MCP exposure in this repo is governed by allowlist-or-gate, not by verb.

**8.3 Alternatives considered.**

- _Compose three existing commands_ — rejected: a runbook cannot refuse, and the ordering principle is
  unenforceable across separate invocations. The `local-deploy` "CLI is preflight only" precedent does
  not transfer: it was forced by _CI must never depend on the CLI_, and no CI or unattended path
  consumes release teardown.
- _Multi-target `--versions` / `--all`_ — rejected: multiplies an irreversible act behind one
  confirmation and forces continue-on-error semantics that destroy the residue report.
- _CLI-only (revision 1's D7)_ — **rejected on review.** Its two supporting facts are true of the
  entire exposed mutating set, and its stated criterion ("genuinely irreversible") applies to one of
  six steps. It also left agents able to create releases through a dedicated plugin command
  (`plugins/infra-kit/commands/release-create.md`, the plugin's only command) that they could never
  clean up.
- _Expose including the Jira step_ — rejected: it would put an unrecoverable call behind a boundary
  that auto-confirms, against an API whose semantics are still unmeasured (U1-U3).
- _Warn-and-confirm instead of refusing on attached issues_ — rejected: a confirm is not a gate over
  MCP and is skipped by `--yes`.
- _Two reassignment flags (`--move-issues-to` + `--move-affected-to`)_ — rejected: doubles the
  preflight surface to serve a case (two different destinations) that the Jira UI already handles.
- _Least-recoverable step first_ — rejected: it maximises the probability that the one unrepairable
  step executes.
- _`allowEditorRelaunch: !confirmedCommand`_ (what `worktrees remove` passes) — rejected: it fires
  Zed's destructive relaunch, which silently drops unrelated open folders. Disproportionate for a
  single-target teardown.
- _Parse the tip SHA from `git branch -D` output_ — rejected: the string is localizable and absent when
  the branch is already gone. Captured in preflight instead.
- _`--force` to override the released-version guard_ — rejected: D2c and D3 are deliberately
  independent, and a shared override would collapse them into one.

**8.4 Why chosen.** It keeps every failure mode repairable: single-target bounds the blast radius,
ascending irreversibility keeps every abort recoverable, capture-then-print makes rows 4-5 of the
residue table true rather than asserted, verify-after-mutate closes both known fail-opens, the D2e
re-probe makes PM-2's mitigation valid at the moment it matters, and the MCP narrowing lets agents
undo what they create without ever reaching the one call a human cannot undo.

**8.5 Consequences.**

- Cleaning up N stale releases costs N invocations. Deliberate.
- Two new Jira API surfaces enter the codebase, with three unmeasured claims (U1-U3) that now have
  **stated fallbacks** rather than only a stop-work gate.
- `assertJiraOk` becomes exported — a small widening taken to avoid a second, divergent classifier.
- Two helpers move out of `gh-release-deliver` (`PRStatus`/`fetchPRByHead`, and
  `removeReleaseWorktreeIfPresent`). The second is **not** behaviour-identical: its two failure
  strings become parameters and it now returns the removed branches.
- The exposed MCP tool set gains **one** entry, so `EXPECTED_EXPOSED_TOOLS`, its length assertion,
  `EXPECTED_GATED_TOOLS`, `MCP_TOOL_PRESENTATION`, `palette.test.ts`, `AUTHORED_TOOL_NAMES` and the
  golden snapshot all move together by one. (Stated as a delta deliberately — see §3.4.) A future
  change that silently unexposes it will red the pinned lists.
- **Landing order is constrained by a concurrent change.** `AUTHORED_TOOL_NAMES` exists only in the
  `setup-dependency-status` session's uncommitted work, so exposure either lands after that commits or
  must carry the strip mechanism itself (§3.4 C2).
- `resources/root/body.md` and the repo's own `/CLAUDE.md` block both change, so every consumer repo's
  generated block drifts until `ik audit --fix --root` runs there — and regeneration **requires a
  fresh build** or it re-emits the old line.
- The MCP path deliberately leaves an orphaned Jira fix version every time, reported as
  `jira: 'manual'`. That is the plan's designated _good_ residue, but it is a residue nonetheless and
  agents must be told to hand the URL to a human.

**8.6 Follow-ups (out of scope).**

- **Widen `ReleasePRInfo` to carry `number` and `state`.** The fetch already retrieves both and the
  projection discards them (`gh-release-prs.ts:11-18`, `:78`, `:81`, `:155-165`); three commands
  currently re-derive PR identity. Deferred because it touches every consumer of the picker.
- `listLocalReleaseBranches()` so the picker can also offer half-removed releases instead of relying
  on `--version`. Deferred: a new discovery source brings its own ordering and dedup questions.
- A non-interactive `--dry-run` audit mode. The confirm text now carries the same inventory and is
  tested (T9), so this is ergonomics, not safety.
- Naming symmetry: `release-deliver` (catalog) vs `gh-release-deliver` (tool name). Untouched —
  renaming an exposed tool is a wire-visible change; `release-remove` avoids creating a second case.
- If U1-U3 measure cleanly and the MCP path proves safe in practice, revisit whether the Jira step can
  be enabled over MCP behind the gate.
