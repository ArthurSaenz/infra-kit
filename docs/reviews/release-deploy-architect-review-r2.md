# Architect review, round 2 — `docs/release-deploy-command-plan.md` @ 914 lines

**Verdict: ITERATE — one change, scoped to PR-D. Everything else is approved and should proceed.**

All 13 round-1 items are genuinely fixed, not reworded, and the four claims flagged for scrutiny all
hold. This review originally closed as APPROVE. It is downgraded by **§5 Q2**, a measurement taken
afterwards at the lead's request: `deploy-selected-services.yml` in **both** consumer repos gates
`docs-fe` and `mobile` by environment at run time, and the CI form's services enum is built from the
workflow's declared boolean inputs, which do not carry those gates. So the CI services picker can offer
a service the target environment will silently skip, and the dispatch reports success — PM-D3's outcome
by a second route the plan declares closed. That is a violation of the plan's own principle 3, measured,
on the increment's headline new capability.

**Scope of the blocker: PR-D only.** PR-0a, PR-0b, PR-1, PR-A, PR-B and PR-C are unaffected and should
ship on the stated schedule — PR-0a in particular closes three live stream-corrupting defects and must
not wait for this.

Companion: `docs/reviews/release-deploy-architect-review.md` (round 1). Read-only review; no source file
was modified.

---

## 1. VERIFICATION OF THE 13 ROUND-1 ITEMS

| # | Round-1 item | Status | Evidence |
|---|---|---|---|
| 1 | Scope → A ∪ {`local-deploy-all`}; factory takes both axes | **FIXED** | §1.3, §2.1, §2.5 `:379-391`: `createDeployFormProvider({workflowFile, fields, toolName})` with a per-tool `fields` table; §2.5 `:375-377` explicitly retracts the "only axis" claim. PR-1 also relaxes `local-deploy.ts:478` (§2.4 `:351-352`) — verified required today (`z.string()`, `sharedInput` `:476-480`). |
| 2 | §2.2 vs §4 contradiction; `!isTTY`; `jsonOutput` | **FIXED — and the deferral is correct** | §2.3 `:324-339` resolves to `isMcpMode()` only, keeps `!isTTY` in `release-picker.ts` on that file's own argument (`:33-34`), and defers `jsonOutput.enabled` to F-3. See ruling A2. G0e added (`:699`). |
| 3 | Survey table, blanket guard, fallback deleted | **FIXED** | §0.9 `:161-194` is the 23-site table; `:191-194` deletes the fallback and states why (it would have missed both `worktrees-add` sites). |
| 4 | Split PR-0a ahead, widened to the class | **FIXED** | §2.2 `:292-316`; §4 `:663-665`, ordering at `:686` — "PR-0a → (everything else)". Covers all three sites. |
| 5 | Replace the unreachable G0d | **FIXED** | G0f/G0g (`:700-701`), both over extracted predicates, both red on `main`, neither needing AWS, a git tree, or `devops/scripts/*.sh`. §2.2 `:312-316` states why extraction is mandatory rather than tidy. |
| 6 | Labels → field prose; P5; PM-D1 demoted | **FIXED** | §2.5 `:421-438` records all three repairs with (a) and (c) rejected on stated grounds; P5 `:716` now asserts the `.describe()` contents against `isSharedEnv`; the old scenario is PM-D3 and relabelled *comprehension*. |
| 7-8 | Silent-degradation ACs + sendability | **FIXED, and extended** | P10 `:721` carries both halves (the `z.array(z.string())` mutation **and** `buildArgumentForm(...) !== null`). P1 `:712` splits into (a)/(b) and binds the empty case to the log line — which is the M4 distinction. §2.5 `:410-415` extends the empty-list rule to `availableServices`, a case I did not name: a repo with `environment` choices but no boolean service inputs would have thrown `z.array(z.enum([]))` and killed the **whole** form, env dropdown included. That is a genuine addition. |
| 9 | §5.4 fixture pinned | **FIXED** | `:736-740`: `mkdtemp` + `git init` + `cwd` on the spawn, with the `getProjectRoot()` reason stated. §5.2 `:705-708` adds the same seam for the unit lane — also not something I named. |
| 10 | `resources/workflow/**` in CI paths | **FIXED** | G5 `:759`, with the mutation stated. |
| 11 | Option B's rejection | **FIXED — and the new claim is TRUE.** See ruling A5. |
| 12 | Publish gate seam | **FIXED** | G4 `:758` over an extracted `collectViolations(...)`, with the reason revision 1's G4 was unimplementable; `:761-765` states four previously-unstated decisions, including that a floor-less command becomes a violation rather than a `fail()` crash (`check-workflow-resource-published.mjs:47-50`) and the one-spawn requirement. |
| 13 | Precision fixes | **FIXED** | §0.7 `:114` "whenever the deploy proceeds" with the `(Revision 1 said "always"; corrected.)` note; §0.3's title is now "the flag **spellings**, not the semantics"; I1 `:729` partitions `getExposedMcpTools()` and asserts both halves; §2.6 `:471-474` cites `release-deploy.ts:29-33`. |

---

## 2. RULINGS REQUESTED

### A1 — §0.9's categorical claim is sound, and PR-0a resolves `worktrees-add` to `false` before `withEscape`

**The claim** (§0.9 `:183-185`): *"No site regresses under a blanket `isMcpMode()` refusal … under
`isMcpMode()`, `process.stdin` **is** the transport (`mcp-mode.ts:2-4`), so no prompt at any site can
return a usable value. A refusal cannot remove a capability that does not exist."*

**Sound for all 23 sites.** `mcp-mode.ts:2-4` states the premise as the module's reason for existing, and
`mcp-mode.ts:6-10` records why `isTTY` cannot substitute for it. The inference is valid: a prompt that
cannot return a value has no capability to remove.

**The lead's sharper question — does it survive `worktrees-add`, where the correct behaviour is a
documented `false`, not a refusal? Yes, because of PR ordering, and the plan gets this right.**

The distinction matters and the claim alone does not carry it: *no regression* is not *correct
behaviour*. If PR-0b landed alone, `worktrees-add` over MCP would move from corrupting the stream to
hard-refusing — better, but still a broken tool, and the schema's own `.describe()` at `:377`/`:382`
would still be a lie. Checked:

- **§2.2 item 2 (`:307-308`)** puts the `isMcpMode()` resolution at `:143-148` and `:160-165` — inside
  the `??` chain, so `false` short-circuits and the `withEscape` arm is never evaluated.
- **G0g (`:701`)** asserts the extracted resolver returns `false` under `isMcpMode()` with no config
  value, "matching `:377`/`:382`'s documented order", with the mutation "remove the `isMcpMode()` leg".
- **§4 `:686`** orders `PR-0a → (everything else)`, so `false` lands **before** the blanket refusal.

So the refusal is a backstop at those two sites, not the mechanism. **The Critic's #5 is addressed.**
The one thing I would add to §0.9's paragraph is the sentence that makes the distinction explicit —
*"no regression" is the floor, not the target; where a documented non-interactive answer exists, PR-0a
supplies it and PR-0b only catches what PR-0a missed* — because a later reader who takes the categorical
claim on its own could conclude a refusal is always the right answer, which is what would reintroduce
the Critic's objection.

### A2 — the `jsonOutput.enabled` deferral to F-3 is correct, not an over-read

I argued it "deserves its own sentence, its own row, and its own PR." The planner gave it its own
follow-up. That is the thing I asked for, not licence taken from it.

The objection was never that prompts on the `--json` path are acceptable — §2.3 `:337-338` agrees they
are not, and cites the same leak I did (`release-picker.ts:17-19`). The objection was that a
user-visible behaviour change at ~10 sites (`:335-336` enumerates them) does not belong inside a PR
described as a stream-safety prerequisite, argued in a subordinate clause, and covered by a row that
tests the extracted function rather than any call site. Splitting it fixes exactly that.

**One condition:** F-3 must remain a named follow-up with its closing argument attached, not an
open-ended someday. §6's residue list is the right home and the plan puts it there. Accept.

### A3 — the `entry/cli.ts:145` row is correct

Verified. `cli.ts:124` gates the Ink palette on `process.stdout.isTTY && process.stdin.isTTY`; the
`else` branch reaches `withEscape` at `:145-150`. The comment at `:117-122` documents the live case —
`infra-kit > log.txt`, stdout redirected while stdin is still a TTY — and states *"`withEscape` keys on
stdin, so its guard does not fire."* Under a blanket `isMcpMode()` guard neither clause fires there
either: `entry/cli.ts` is not the MCP entry (`mcp.ts:29-31` spawns `./mcp.js`), and `mcpMode.enabled` is
set only in `createMcpServer()` (`mcp-mode.ts:12-14`), so `isMcpMode()` is false on every CLI path.
**No risk. Row correct.**

Incidental corroboration for §0.7's inquirer claim: `cli.ts:149` passes `{ output: process.stderr }`
explicitly — the only `withEscape` call site that does. A site would not need to pass stderr if stderr
were the default.

### A4 — the `release-create` six sites are genuinely not MCP-reachable, on two independent legs

This is the row where a false "no" would be worst, so I checked the code path rather than inferring from
the schema alone. **The plan's "no" is correct**, and it holds twice over:

1. **The schema.** `releases: z.array(...).min(1)` (`release-create.ts:432-476`), no `.optional()`. The
   SDK validates before the handler, so over MCP `releases` is present **and** non-empty.
2. **The funnel.** `collectEntries` (`:222-240`) returns at `:232` whenever
   `inputReleases && inputReleases.length > 0`; the interactive path is the fall-through at `:235`.
   All six `withEscape` sites are downstream of it: `:138`, `:152`, `:184`, `:191` are inside
   `promptForReleasesInteractive` (`:119-197`), and `:81`/`:97` are inside `promptForVersionInput` and
   `promptForNameInput`, whose only call sites are `:174` and `:169` — both inside that same function,
   whose only caller is `:235`. One gate, six sites.

**One line worth adding to §0.9.** That safety rests on a *schema constraint*, which is the same
protection §0.7 calls "latent" for the deploy pickers — and PR-1 is the increment that deliberately
removes it from four of them. If `releases` is ever relaxed (RC §2.5 contemplates a `release-create`
form), **six sites go live at once** on the one gated tool already shipped to users. Recording that in
the table turns a current fact into a standing constraint.

### A5 — Option B's new discriminator is TRUE

The lead was right to flag this: three prior claims in this vicinity were false in the same direction.
This one holds.

**Claim** (§1.3 `:240-243`): `local-deploy-selected`'s service candidates are
`eligibleServices(services, selectedEnv)` — *the domain depends on the env chosen in the same form.*

**Verified:**
- `eligibleServices(services, env)` filters by `isEligible` (`service-discovery.ts:149-153`, `:137-139`),
  which tests `service.allowedEnvs === null || service.allowedEnvs.includes(env)`.
- `allowedEnvs` comes from each script's own `skip_unless_env_enabled "$DEPLOY_STAGE" "<label>"
  "<envs>"` guard, intersected with the workflow gates (`:20`, `:83`, `:101-126`).
- `local-deploy.ts:340` calls `eligibleServices(services, selectedEnv)`, and `:350` → `resolveNames` →
  `pickServices(eligible, env)` (`:300`). **The picker's domain is env-filtered.**
- The docblock at `service-discovery.ts:141-147` makes it concrete: without the filter, `--all --env
  stage` would deploy `docs-fe` and `mobile`, which CI refuses.

**And the asymmetry that makes it load-bearing is real.** The CI side's
`parseServicesFromWorkflow()` (`gh-release-deploy-selected.ts:214-239`) takes **no env argument** — it
reads the workflow's boolean inputs and nothing else. So the CI services domain is env-independent and
its form is buildable; the local one is not, because a schema is built once, before any answer, and
cannot make one field's enum depend on another field's value. That is a genuine structural exclusion of
the same kind as §2.6's, and §1.3 `:241` says so ("That is §2.6's own argument, and here it is true
rather than asserted") — an accurate self-assessment.

The plan also does the honest thing at `:246-252`: it names the wrong rejection it is replacing, and
records the real CI/local discriminator (local preflight fails closed — `preflight.ts:58-68`, `:76-90`)
as an argument for **ordering**, not exclusion. That is the correction I asked for, made without
over-claiming.

### A6 — PR-0a's ACs are the right *unit* shape, but PR-0a asserts no stream invariant

**Ruling on the form of the assertion: neither a byte count nor error-text matching. Both are wrong, and
the 54-vs-60 discrepancy is the proof.**

G0f and G0g (`:700-701`) are **predicate** assertions — `shouldSkipConfirm(args)` returns `true` for
`{confirmedCommand:true}` and `{yes:true}`; the `worktrees-add` resolver returns `false` under
`isMcpMode()`. That is the correct shape for a unit test: reachable, red on `main`, no AWS, no git tree,
no `devops/scripts/*.sh`. Neither asserts error text (brittle) nor a byte count.

**A byte count would be the wrong invariant, and the two measurements demonstrate why.** The lead
measured 54 bytes; §0.7 `:120-125` measures 60 for
`? Deploy 3 service(s) to stage from this machine? (y/N)[57G`. Both are correct — the count is a
function of the message string and the terminal-width escape, so any AC pinning a number breaks when
someone rewords a prompt. The invariant is not *how many* bytes reach stdout; it is that **none of them
fails to parse as JSON-RPC** — which is exactly how E6 (`:749`) is written.

**The gap: PR-0a fixes a stream-corruption defect and ships with no stream-level assertion.** E6 lives in
PR-1's ACs (§4 `:669-670`), and PR-0a ships ahead of everything (`:686`). So the PR that closes three
live stream-corrupting defects proves only that two predicates return the right booleans.

**Not a blocker, and deliberately so.** Requiring an e2e before PR-0a lands would put a live-defect fix
behind test infrastructure — the precise coupling error §2.2 `:294-296` just corrected. Shipping the
predicates now is strictly better than not shipping. **Recommended addition, cheap:** give PR-0a one e2e
leg on **`worktrees-add`**, which is the reachable half — it needs a git repo with a release branch and
no `worktrees.openInGithubDesktop` in config, but **no AWS and no deploy scripts**, unlike the
`local-deploy` half. Assert *every byte the child wrote to stdout parses as JSON-RPC*; mutation: revert
the `isMcpMode()` leg. That is E6's assertion shape applied one PR earlier, on the site where it is
affordable.

**One smaller seam in the same area:** G0g asserts the extracted resolver's return value, not that
`:143-148` / `:160-165` actually call it. P7 (`:718`) does assert wiring for the factory; the same idea
one line lower would close this — assert the resolved value at the call site, not only in the helper.

---

## 3. RESIDUAL ITEMS — none blocking

1. **§0.9's categorical paragraph should distinguish "no regression" from "correct behaviour"** (A1).
   One sentence; prevents a later reader concluding a refusal is always the right answer.
2. **PR-0a should carry one stdout-parses-as-JSON-RPC e2e leg on `worktrees-add`** (A6), and G0g should
   assert the value at the call site as well as in the helper.
3. **§0.9's `release-create` row should record that its safety is a schema constraint** (A4) — relaxing
   `releases` takes six sites live at once on the most-shipped gated tool.
4. **Citation drift:** §1.3 `:241` cites `local-deploy.ts:337` for `eligibleServices(services,
   selectedEnv)`; it is at **`:340`**. The claim is right; the line is three off.
5. **Unverified citation, flagged rather than disputed:** I could not locate `@inquirer/core` on disk at
   the paths I searched, so §0.7 `:120-122`'s `create-prompt.js:54`
   (`output.pipe(context.output ?? process.stdout)`) and the 60-byte figure are **not independently
   confirmed by me**. The direction is well corroborated — `entry/cli.ts:149` is the only `withEscape`
   call site that passes `{ output: process.stderr }`, which it would not need to do if stderr were the
   default — and nothing in the plan depends on the exact number now that no AC pins one. Worth a second
   pair of eyes on the line reference before it is quoted onward.

---

## 5. ADDENDUM — the two follow-up questions on the Option B discriminator

### Q1 — is env-dependency the reason the plan should be giving? Yes, but it must be labelled load-bearing, because the second reason is contingent

Both reasons hold today, and they are **not of the same kind**:

- **`service: z.array(z.string()).min(1)` required (`local-deploy.ts:509-512`)** — *contingent*. It is the
  identical barrier that stood in front of `gh-release-deploy-selected`'s `services` and that PR-1
  removes with one `.optional()`. A later PR relaxing it costs one line.
- **The env-dependency (`eligibleServices(services, selectedEnv)`, `local-deploy.ts:340`;
  `service-discovery.ts:137-153`)** — *structural*. It survives every schema change, because a form is
  built once, before any answer, so one field's enum can never depend on another field's value in the
  same round trip.

**Ruling: the env-dependency is load-bearing and the plan must say so explicitly.** §1.3 `:240-243`
currently lists both with "Plus" joining them, which reads as two co-equal reasons. That is exactly the
failure the lead named: a reader who relaxes `service` in a later PR concludes F-1 is discharged. It is
not. One sentence fixes it — *"the array requirement is a second lock that PR-1-style relaxation would
open; the env-dependency is the one that does not."*

**And a scope opportunity the exclusion is currently wider than it needs to be.** The env-dependency
excludes a **services** picker on `local-deploy-selected`. It does not exclude a **form**. An env-only
form on that tool — `fields: ['env']`, the same provider `local-deploy-all` already gets, with `service`
left required so `services` is never offered — has no dependency problem at all, costs one row in §2.5's
table, and closes the exact gap the plan used to reject Option F (§1.3 `:267-271`: *"a human who says
'deploy the checkout service to stage' … receives no form, and guesses the env"*). The plan makes that
argument against Option F on the CI side and then leaves the identical hole on the local side. Worth
taking; not a blocker.

### Q2 — BLOCKER (PR-D): yes, the env-dependency reaches back, and it lands on the CI services picker

**Measured in both consumer repos**, by parsing the job blocks of
`.github/workflows/deploy-selected-services.yml`:

| Repo | Service | Environments its job's `if:` permits |
|---|---|---|
| `hulyo-monorepo` (`:217`) | `docs-fe` | `dev`, `arthur`, `eliran`, `renana`, `roman`, `oriana` |
| `hulyo-monorepo` (`:283`) | `mobile` | `dev`, `prod` |
| `travelist-monorepo` (`:222`) | `docs-fe` | `dev`, `arthur`, `eliran`, `renana`, `roman`, `oriana` |
| `travelist-monorepo` (`:288`) | `mobile` | `dev`, `prod` |

So `docs-fe` on `stage`, or `mobile` on `stage`/any personal env, is **declared as a `workflow_dispatch`
boolean input and skipped by its job's `if:`**.

**The form would offer it.** `parseServicesFromWorkflow()` (`gh-release-deploy-selected.ts:214-239`)
reads `on.workflow_dispatch.inputs` and filters only `skip_terraform_deploy` (`:29`, `:232-235`). It
never reads the `if:` gates and takes no env argument (called with none, `:85`).

**And the tool cannot notice.** The dispatch is fire-and-forget — the tool description states it
*"returns once GitHub accepts the workflow_dispatch, NOT when the deployment finishes"* — so a skipped
job returns nothing. The human picks two services from a dropdown, one silently does not deploy, and
every layer reports `success: true`.

**That is PM-D3's user-visible outcome by a second route.** The plan retires PM-D3 as unreachable by
construction (§3, §5.6 `:771-773`), and it is right about the route it names — the conditional offer does
prevent the `narrowsArgs` discard. This is a different mechanism reaching the same place: not a
discarded selection, a skipped job. Nothing in §5 asserts against it.

**It is also a violation of the plan's own principle 3** (§1.1 `:206-208`, *"Enumerate from the artifact
that decides, and say what the enumeration is not"*). The declared boolean inputs are **not** the
artifact that decides; the `if:` gates are, for 2 services of 18 in hulyo and 2 of 16 in travelist. The
plan applies principle 3 rigorously to the env list (§0.5) and not at all to the services list.

**The machinery to fix it already exists in the same package.** `readWorkflowGates(projectRoot)`
(`workflow-gates.ts:37-65`) already parses exactly these gates — `ENV_EQUALS_PATTERN` at `:21-22`,
`collectGates` at `:74-93` — over **every** workflow in the directory (`:50-52`), which includes
`deploy-selected-services.yml`; and `intersectGates` (`:101-108`) already computes the answer. It is
written, documented and used by `discoverServices` (`service-discovery.ts:66`, `:83`).

**Required change, PR-D only — one of these two, stated in §2.5 and asserted in §5.2:**

- **(i) Filter when the env is known.** `isFormable` fires when *any* declared field is absent, so the
  common `-selected` shape is env supplied by the agent and `services` omitted. In that case the env
  **is** available at schema-build time from `params`, and the services enum can be filtered through
  `readWorkflowGates`/`intersectGates`. When `env` is also absent the enum cannot be filtered, and the
  field's `.describe()` must say which services are env-gated. This is the honest version and it reuses
  tested code.
- **(ii) At minimum, state it.** Add it to §6 as a residue, and put the gated services in the `services`
  field's `.describe()` so the human sees the constraint the enum cannot express — the same remedy §2.5
  `:430-434` adopts for shared environments, for the same reason (M3: no per-option labels).

Either way, **§3 PM-D3 must stop claiming the hazard is closed**, and the asymmetry must be stated
plainly: the plan excludes `local-deploy-selected` for an env-dependency that the CI tool also has, in
lesser degree. That is defensible — total versus partial is a real difference — but it has to be said,
or the discriminator reads as a rule applied to one side only.

---

## 4. WHAT CHANGED MY VERDICT

Round 1 withheld approval on five things: a scope decision resting on an unmeasured fact; a guard
specified two incompatible ways with no row able to tell them apart; a headline AC that could not run;
a mitigation that could not be built and whose guard could not pass; and a survey deferred as a promise
that turned out to contain two more live defects.

All five are closed with measurements rather than argument — §0.8 for the SDK, §0.9 for the survey,
§0.7 for the stream bytes — and the two additions the plan made on its own (the `availableServices`
empty-list case at §2.5 `:410-415`, and the unit-lane `getProjectRoot` seam at `:705-708`) are both
things I missed.

**On the round-1 scope, this is an APPROVE**, and I want that recorded plainly: nothing in §1-§3 above
withholds it, and the §3 residuals are a sentence, a test leg, a note and a line number.

The verdict is **ITERATE** on one thing only, and it is a thing this review went looking for at the
lead's direction and found in production rather than in argument (§5 Q2). The plan's discriminator for
excluding `local-deploy-selected` is true; what it had not noticed is that the same dependency exists in
weaker form on the tool it *does* give a services picker, and that the enumerator it uses is not the
artifact that decides. Two services in each consumer repo are affected today. The fix is small, the
machinery exists, and it touches PR-D alone.

**Ship PR-0a now.** It is standalone, ordered first (§4 `:686`), and closes three live
stream-corrupting defects on shipped tools.

---

*Read-only review. No source file was modified.*
