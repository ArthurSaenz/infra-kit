# Architect review (round 2) — `docs/release-deploy-command-plan.md`

**Reviewer:** architect lane, ralplan deliberate mode. **Target:** `docs/release-deploy-command-plan.md` @ 796 lines
(the rewritten version, not the 738-line draft). **Mode:** read-only; no source file was modified.

Every factual claim below was checked in the tree. Where the plan, the governing doc
(`docs/infra-kit-slash-commands-plan.md`, cited **§n**) or the sibling
(`docs/release-create-command-plan.md`, cited **RC §n**) disagree with the code, the code wins.

**Discharged since round 1:** §0.6 corrects §4.3's stale prod claim accurately and in both directions;
§2.6 clause 5 adds the `stage` half; §5.4 no longer prescribes the unusable `.github/fixtures/`
location; PM-D1 moved off a config-opt-out scenario. The `services` reversal is the right call — it
takes the harder path round 1's escape-4 analysis pointed at and pays for it, rather than deferring.

---

## 0. MEASURED — `inputRequired.elicit` schema expressibility

Probed directly against `@modelcontextprotocol/server@2.0.0` as resolved from
`apps/infra-kit/cli`, by calling `inputRequired.elicit({ message, requestedSchema })` and reading back
the rendered `requestedSchema`. Full transcript: `docs/reviews/elicit-schema-measurements.md`.

| Input | Result |
|---|---|
| `z.enum(['dev','stage','arthur'])` | **OK** → `{"type":"string","enum":[…]}` |
| `z.array(z.enum(['client-be','client-fe']))` | **OK** → `{"type":"array","items":{"type":"string","enum":[…]}}` |
| `z.array(z.string())` | **THROW** — *"Elicitation requestedSchema only supports flat primitive properties (string, number, integer, boolean, and string enums): properties.services"* |
| two enums (`version` + `env`) | **OK** — both render |
| `z.enum(['dev']).optional()` | **OK** — renders; omitted from `required` |
| `z.object({a: z.object({b: z.string()})})` | **THROW** — same error, `properties.a` |
| `z.enum([])` | **THROW** — same error, `properties.env` |
| `z.array(z.enum([]))` | **THROW** — same error, `properties.s` |
| `z.enum(['dev']).describe('the target env')` | **OK** → `{"type":"string","description":"the target env","enum":["dev"]}` |
| `z.object({})` | **OK** → `{}`, `required` undefined |

**Four consequences, each load-bearing below.**

- **M1 — the multi-select works.** `z.array(z.enum(...))` renders. Adjudication 2b resolves, and with it
  ruling 1's branch. The plan's §2.4 `services` row is buildable as written.
- **M2 — `z.array(z.string())` is a silent-degradation trap, and it is the obvious spelling.** It is the
  exact type the tool's own `inputSchema` already uses (`gh-release-deploy-selected.ts:258-259`), so a
  provider author copying the tool's shape writes the throwing form. `elicit()` throws **before anything
  is sent**; `buildArgumentForm`'s `catch` swallows it and returns `null` (`argument-form.ts:162-170`);
  the call falls to the gate with no form, no error, and a log line
  (`Tool execution form unavailable`, `tool-handler.ts:336`) identical to a non-elicitation client's.
  Every test asserting "the gate came back" stays green.
- **M3 — per-option labels do not exist on the wire.** Enum members render as bare strings.
  `.describe()` attaches at the **field** level only. **PM-D1's mitigation as written is not
  implementable.** See ruling 5.
- **M4 — an empty enumeration throws through the same silent path.** `z.enum([])` is a `TypeError`, and
  an empty candidate list is exactly what this repo root produces for **both** lists (§0.5). So a
  provider that builds the schema before checking emptiness degrades indistinguishably from one that is
  broken. The provider must return **`null` explicitly** on an empty list, and `z.object({})` (which
  renders cleanly) must never be used to mean "nothing to offer".

Also useful, and unexploited by the plan: `.optional()` correctly drops a field from `required`, so a
form **can** distinguish "must answer" from "may answer" on the wire.

---

## RULINGS ON THE FOUR QUESTIONS

### Ruling 1 — the all-vs-`selected` cut (Option F)

**Option F** = form on `gh-release-deploy-all` (version + env) and `local-deploy-all` (env only);
no form on either `-selected` tool in v1.

**F beats E outright. F beats B. Against A it is a straight trade, and one unmeasured fact decides it.**

Option F has a real property neither A nor E has: **every tool that receives a form can have that form
fully populated, and no array-valued key is ever offered.** `gh-release-deploy-all`'s entire non-boolean
argument set is `version` + `env` (`gh-release-deploy-all.ts:141-150`); `local-deploy-all`'s is `env`
alone (`local-deploy.ts:476-480`, `:494-501`). Consequences:

- the conditional `services` offer (§2.4 `:329`, `:332-334`) — the design's most delicate line —
  disappears entirely;
- **PM-D3 cannot arise**, because no array-valued key is ever in a schema;
- **no dependence on `z.array(z.enum(...))` surviving `inputRequired.elicit`** — adjudication 2b, the
  one unmeasured fact in the plan;
- P4 reverts to the stronger, simpler "the shape's key set is exactly `{version, env}`";
- PR-0's *required* scope shrinks: with `services`/`service` staying required, both service checkboxes
  (`gh-release-deploy-selected.ts:105`, `local-deploy.ts:101`) stay latent.

**Two costs, and the second decides it.** First, F **defers exactly what the user asked for** — OQ-1 and
OQ-5 are about seeing the whole list and picking, and services is the list they named. Second, and
worse: **F removes the env picker from the `-selected` path entirely.** A human who says "deploy the
checkout service to stage" gets an agent that picks `gh-release-deploy-selected`, receives no form, and
guesses the env. Under Option A that call *does* get a form. `env` is the value PM-D1 identifies as
deciding blast radius, and `stage` is the env §0.6 identifies as unprotected on both runners. F trades
away elicitation on a plausible path for precisely the field the pre-mortem is about.

**The dependency the lead named is real, and M1 resolves it.** The conditional-offer construction **is
sound** (adjudication 2): `narrowsArgs` iterates `Object.entries(before)` (`argument-form.ts:242`) and
inspects only keys present in round 1 (`:243-247`), so a key absent from round 1 and present after the
merge is never a violation. And **M1 measures that the schema it produces can actually be sent** —
`z.array(z.enum([...]))` renders as `{"type":"array","items":{"type":"string","enum":[…]}}`. `-selected`
is therefore coherent, and F loses its main advantage.

**Ruling — the branch is closed. The recommendation is A ∪ {`local-deploy-all`}.**

- **F > E**, unconditionally. F's marginal cost over E is one trap-free, zero-network provider, and it
  buys D2's more dangerous runner.
- **F > B.** B's rejection in the plan rests on a distinction that does not exist (see antithesis), but
  B is still wrong for `local-deploy-selected`, whose `service: z.array(z.string()).min(1)`
  (`local-deploy.ts:509-512`) needs its own relaxation.
- **A ∪ {`local-deploy-all`} > F, and > A.** Given M1, the target is forms on **`gh-release-deploy-all`
  (version + env)**, **`gh-release-deploy-selected` (version + env + conditional services)**, and
  **`local-deploy-all` (env only)**. It dominates F on coverage — full env elicitation on every path,
  plus the services picker the user actually asked for in OQ-1/OQ-5 — and dominates A by including the
  cheapest, trap-free provider in the set instead of excluding it on a discriminator that does not
  exist. `local-deploy-selected` stays out, correctly, pending its own relaxation.

**Consequence the plan must carry:** `createDeployFormProvider(workflowFile)` (`:313`) cannot express
"no `version` field", so it needs a **second parameter naming the offered field set**. §2.4 `:309-310`'s
claim that the workflow file "is the only axis on which they differ" is no longer true — it is one of
two axes, and the second one (which fields exist on this tool) is what keeps the local provider from
offering a `version` argument its tool does not declare.

**And M2/M4 add two hard constraints on that provider**, both of which fail silently if missed:

- the services field **must** be `z.array(z.enum(availableServices))`, never `z.array(z.string())` (M2);
- the provider **must** return `null` before building a schema when either candidate list is empty
  (M4) — not `z.object({})`, which renders cleanly and would mean "a form with no fields".

### Ruling 2 — `withEscape` blast radius: 23 sites, no regressions, and two more live defects

**Count:** 23 call sites across 13 files (excluding `__tests__` and the definition), confirming the
lead's measurement and correcting the plan's "~20" (§2.2 `:264`, §4 `:539`).

**Is there a call site where a blanket `isMcpMode()` refusal inside `withEscape` would be a regression?
No. I surveyed all 23 and there is none, and the reason is categorical rather than incidental:** under
`isMcpMode()`, `process.stdin` **is** the JSON-RPC transport (`mcp-mode.ts:2-4`), so no prompt at any
site can return a usable value. A refusal cannot remove a capability that does not exist. §1.1 principle
5 is correct and the blanket is correct — **for that clause**. (The regression risk lives in the two
*other* clauses §2.2 imports alongside it; see T1.)

**What the survey does find is more valuable than a regression: two additional live defects of the
`confirmTarget` class, on a second exposed tool.**

| Site(s) | MCP-reachable? | Why |
|---|---|---|
| `entry/cli.ts:145` | **No** | CLI palette only; the MCP server is `entry/mcp.js` (`mcp.ts:29-31`), a different entry. |
| `dev/dev-wizard-run.ts:74`, `:79`, `:84` | **No** | `dev` is not an exposed tool — the catalog imports `devStatusMcpTool`, not a `dev` tool (`command-catalog.ts:3-26`). |
| `commands/env-token-set/env-token-set.ts:62` | **No** | Not in the catalog; only `envTokenListMcpTool` is (`command-catalog.ts:11`). |
| `lib/release-deploy/source-picker.ts:40` | **No** | Reached only through the merged CLI command (`release-deploy.ts:38`); `confirm-deploy.ts:23-25` records that agents call the leaf tools and "never traverse the merged command at all". |
| `lib/release-deploy/confirm-deploy.ts:34` | **No** | Guarded — `confirmedCommand` returns early at `:30`. |
| `lib/command-echo/confirm-or-exit.ts:58` | **No** | Guarded — the ternary at `:56-57` skips `withEscape` when `confirmedCommand` is truthy, and all 7 callers pass it (`release-desc-edit.ts:165`, `gh-release-deliver.ts:410`, `worktrees-add.ts:127`, `gh-merge-dev.ts:471`, `worktrees-remove.ts:156`, `release-create.ts:272`, `worktrees-sync.ts:48`); `tool-handler.ts:466` injects it as `true`. |
| `commands/release-create/release-create.ts:81`, `:97`, `:138`, `:152`, `:184`, `:191` | **No** | `releases` is `z.array(...).min(1)` with **no `.optional()`** (`:432-476`); the SDK validates before the handler, so `promptForReleasesInteractive` (`:235`) is unreachable over MCP. |
| `commands/release-desc-edit/release-desc-edit.ts:72` | **No** | `version` and `description` are both required (`:194-197`). |
| `commands/env-load/env-load.ts:264` | **No** | `config` is required. |
| `lib/prompts/env-picker.ts:33` | **Latent** | `env` required on all four deploy tools **today**; PR-1 deliberately removes that. |
| `commands/gh-release-deploy-selected/gh-release-deploy-selected.ts:105` | **Latent** | `services` required (`:258-259`); PR-1 removes it. |
| `commands/local-deploy/local-deploy.ts:101` | **Latent** | `service` required with `.min(1)` (`:509-512`). |
| **`commands/local-deploy/local-deploy.ts:126`, `:131`** | **LIVE** | `confirmTarget` (`:122-141`) is gated on `yes` at `:411`, but `LocalDeployArgs` declares `yes` (`:64-70`) while `tool-handler.ts:466` injects `confirmedCommand`. |
| **`commands/worktrees-add/worktrees-add.ts:146`, `:163`** | **LIVE — new finding** | `githubDesktop` and `cmux` are `.optional()` in the MCP schema (`:373-375`, `:379-380`), and `:143-148` / `:160-165` fall through to `withEscape(confirm(...))` when the argument is omitted **and** `infra-kit.json` sets no `worktrees.openInGithubDesktop` / `openInCmux`. There is no `isMcpMode()` branch. The schema's own `.describe()` at `:377` promises the resolution order ends in *"interactive prompt (CLI) / **false (MCP, no TTY)**"* — **a documented MCP fallback the code does not implement.** |

**Two rulings follow.**

1. **The blanket guard in `withEscape` is right, and this survey is the argument for it.** The plan's
   fallback — "guard the four deploy-reachable sites individually" (§2.2 `:267-268`) — **would have
   missed both `worktrees-add` sites entirely**, because they are not deploy pickers and nothing in
   this increment's scope would have looked at them. Take the blanket; discard the fallback. **This is
   a decision, not an option.**
2. **The survey as the plan states it is a promise, not a gate.** §2.2 `:264-268` and §4 `:539` carry no
   artifact, no decision rule, no owner and no §5 row. It must become the table above, in the plan, with
   the reachability verdict per site — otherwise the two `worktrees-add` defects stay undiscovered and
   PR-0 ships without knowing what it fixed.

### Ruling 3 — the live `confirmTarget` defect: split it out, and G0d cannot catch a regression of it

**Split it out — and widen it.** The plan concedes the premise three times (`:201-202`, `:227-228`,
`:539-540` "worth shipping alone") and then does not act on it. Four reasons to act:

1. The fix is a field name and has nothing to do with the `withEscape` refusal; coupling them makes a
   23-site survey the gate on a two-line correctness fix.
2. §2.2 `:270-274` gets the causality right — without the field fix, PR-0 converts a silently-broken
   tool into a visibly-broken one — and that is an argument for the field fix landing **first, alone**,
   not for landing them together.
3. PR-0 as specified is self-contradictory (T1) and will iterate; a live defect on exposed tools should
   not iterate with it.
4. **It is not one defect.** Ruling 2 finds the same class on `worktrees-add:146` and `:163`, where the
   schema's `.describe()` (`:377`) documents an MCP fallback the code lacks. A PR framed as "fix
   `local-deploy`'s field name" fixes one third of the class.

**Recommended split:**
- **PR-0a** — accept `confirmedCommand` in `LocalDeployArgs` (`local-deploy.ts:64-70`) **and** add the
  missing `isMcpMode()` resolution for `githubDesktop`/`cmux` (`worktrees-add.ts:143-148`, `:160-165`),
  making the code match its own `.describe()`. Plus a unit test per site over an extracted predicate.
- **PR-0b** — the `withEscape` blanket guard + the survey table.

**Would the plan's ACs catch a regression of it? No.** G0d claims to be *"Red against `main` today, no
mutation needed"* and is **unreachable**. Reaching `confirmTarget` at `local-deploy.ts:411` requires
passing `discoverServices` (`:316`, which throws at `:318-324` on an empty result), `eligibleServices`
(`:340-348`), `runPreflight` (`:371`, an AWS `resolveAccountIdentity`) and the `dryRun` early return
(`:382-408`). In this checkout `devops/scripts/` contains only `lib` — no `deploy-*.sh` — so
`discoverServices` returns `[]` (`service-discovery.ts:57-61`) and the command dies at `:318`. **The one
assertion the plan advertises as red-on-`main` is vacuous at the repo root**, and it is filed in
`assert-interactive.test.ts`, the wrong home for a claim about `local-deploy`'s argument plumbing.

What §5 *does* catch is the **schema-relaxation hazard** — E6, and only given a working fixture (ruling
4). It catches nothing about the field-name defect. Replace G0d with an assertion over an extracted
`shouldSkipConfirm(args)` predicate, or over `LocalDeployArgs` accepting `confirmedCommand`: a real
unit, genuinely red today, with no AWS or filesystem dependency. Add the equivalent for `worktrees-add`.

### Ruling 4 — §5 names the vacuity and does not escape it. As written it is **not shippable**.

Premise confirmed: `.github/workflows/` holds only `plugin-ci.yml` and four `_`-prefixed reusable job
files, so `readWorkflowEnvOptions` returns `[]` (`workflow-envs.ts:93-112`), `deployableEnvs` returns
`[]`, the provider returns `null`, and no form opens.

| Lane | Escapes? | Why |
|---|---|---|
| §5.2 P1–P9 (unit, provider) | **Yes** | They call `buildRequestedSchema` directly against fixture workflows. P1 *asserts* the empty case rather than being silently subject to it. This lane is correct. |
| §5.1 G0d | **No** | Unreachable at the repo root — ruling 3. |
| §5.4 E1–E6 (e2e) | **No** | The fixture prerequisite is *named* (`:612-615`) and *unspecified*. The provider resolves workflows through `getProjectRoot()` = `git rev-parse --show-toplevel` (`git-utils.ts:143-147`) — not cwd-relative, not fixture-relative — and the e2e's three spawns pass **no `cwd`** (`mcp-stdio.e2e.test.ts:67`, `:513`, `:1702`). The fixture must therefore be a `mkdtemp` + `git init` tree **and** the spawn must set `cwd` to it. Neither is stated. |

The sharpest consequence: **E6 — the PM-D2 stream-safety lane, the assertion that justifies PR-0 being a
prerequisite — goes green against a reverted PR-0**, because `pickEnv` *throws* rather than prompting
when its options list is empty (`env-picker.ts:25-31`). The guard whose absence E6 exists to detect is
never exercised.

**M4 makes this sharper than a test-coverage gap.** `z.enum([])` **throws** (§0), so at this repo root a
provider that builds the schema before checking emptiness does not return a tidy `null` — it throws
inside `trySchema`, is swallowed by `argument-form.ts:134-138`, and returns `null` anyway. The *same*
outcome by the *wrong* route. That is why the empty-list check must be an explicit early `return null`
in the provider, and why **§5's P1 must assert the reason and not only the value**: `=== null` passes
identically whether the provider decided or the SDK threw. Bind P1 to the new
`form options empty (<file>)` log line (§5.6, asserted by E4) so the two are distinguishable.

**Ruling:** measured against §6.0's meta-guard — *"a guard that must first find something in order to
check it will report success when it finds nothing"* — §5 is on the wrong side of the line for the two
lanes that carry the increment's risk. **Not shippable as written.** It becomes shippable with three
edits: name `mkdtemp` + `git init` + `cwd` in §5.4's prerequisite; re-home G0d onto an extracted
predicate; and make P1 assert the *reason* for `null`, not just the value.

### Ruling 5 — PM-D1's label mitigation is not implementable as specified; take field-level prose and downgrade the claim

**M3 settles this: per-option labels do not exist on the wire.** Enum members render as bare strings
(`{"type":"string","enum":["dev","stage","arthur"]}`), and `.describe()` attaches at the **field** level
only (`{"description":"the target env","enum":[…]}`). So §2.4 `:343-346`'s requirement — *"Each option's
label carries its kind (`stage — SHARED`, `renana — personal`), derived from `isSharedEnv`. This is
PM-D1's only mitigation and it is a requirement, not a polish item"* — **cannot be built.** The lead
asked me to rule on whether that mitigation was load-bearing or decorative. As written it is neither:
it is **absent**, and P5 would have asserted a property the provider cannot produce.

Three options exist. Ruling on each:

- **(a) Encode the kind in the enum VALUE (`"stage (shared)"`) and map back in `toArgs`. REJECTED for
  v1.** It puts a parse step on the path that produces the argument the confirm token is minted over
  (`tool-handler.ts:185`) and that the deploy binds to. It contradicts the merge contract the plan
  inherits from RC §2.5a and restates at `:360-361` — *"merges field-by-field over `params`, never
  constructs"* — because a value transform is neither. And it opens an audit seam that is small but
  real: the human picks `"stage (shared)"` while the gate payload's `resolvedArgs` shows `stage`, so
  the string the human saw is not the string they are shown approving. On an authorization-critical
  path that is the wrong direction to trade.
- **(b) Field-level prose that enumerates the partition. ADOPTED for v1.** The `env` field's
  `.describe()` carries, e.g., *"Target environment. SHARED — deploying replaces what the whole team is
  using: dev, stage. Personal: arthur, renana."* — both sets derived from `isSharedEnv`, so the text
  cannot drift from the predicate. It renders (M3's last row confirms `description` survives beside
  `enum`). It is **weaker** than a per-row marker: it is read before the list, not beside the chosen
  row, and a scanning human may skip it. Say so.
- **(c) Widen `ArgumentFormProvider.buildRequestedSchema` to return a raw restricted schema**, reaching
  the SDK's `TitledSingleSelectEnumSchema` / `TitledMultiSelectEnumSchema`
  (`createMcpHandler-CLhGwQTn.d.mts:585-588`). **Correct eventually, rejected for this increment** — it
  widens a chokepoint interface (`types.ts:57`) in exactly the increment D3 says must not widen
  chokepoint invariants, and it would put the untyped restricted shape on the provider contract with no
  zod validation behind it. File it as the follow-up if per-row marking is later judged required.

**Consequences for the plan, all mandatory:**

1. **Rewrite §2.4 `:343-346`** to specify (b), and drop "each option's label".
2. **Rewrite §5's P5** to assert the field-level `description` contains both partitions, derived from
   `isSharedEnv` — mutation: hardcode the env names, and a fixture whose `isSharedEnv` disagrees reddens
   it. As currently worded P5 is unbuildable.
3. **Downgrade PM-D1's mitigation paragraph.** It currently reads *"Mitigated, and the mitigation is a
   requirement not a nicety"* (`:496-497`). The honest form is: *the per-option distinction the scenario
   needs is not expressible on the wire; what remains is field-level prose the human may not read, plus
   §2.6 clause 5 in the body.* Combined with the residue the plan already states — that a client with
   `applyDefaults` picks a row without rendering anything (`:498-500`) — **PM-D1 is a partially-mitigated
   authorization residue, not a closed one.** That is a better pre-mortem than the current one, because
   §6.0b's whole point is to record what no assertion can tell apart rather than to reach for a
   mitigation that closes it.
4. The plan's own line *"the form makes this **worse than today**"* (`:491-494`) now stands **without**
   the offsetting mitigation. It should be read as what it is: a live argument that the env dropdown, as
   buildable, trades a string the human read in a gate payload for a row they picked from an
   undifferentiated list. That is not disqualifying — §2.6 clause 5 and the body still run — but it must
   not be presented as solved.

---

## STEELMAN ANTITHESIS

**Option B, and the rewrite strengthened the case against itself without noticing.**

The false discriminator survived the rewrite. §1.3 Option B (`:210-212`) still rejects the local form
because *"the local env list is explicitly advisory (`local-deploy.ts:326-327`)"*. But
`local-deploy.ts:328-329` is:

```ts
const protectedEnvAccess = await resolveProtectedEnvAccess()
const envOptions = deployableEnvs(await readWorkflowEnvOptions(DEPLOY_ALL_WORKFLOW), protectedEnvAccess)
```

— character-identical to `gh-release-deploy-all.ts:48-49`, against the same `deploy-all.yml`
(`local-deploy.ts:30`, `gh-release-deploy-all.ts:20`). And the advisory warning is not local-specific:
it is the enumerator's own docblock, `workflow-envs.ts:14-16` — *"ADVISORY ONLY: it sources the
interactive picker, and callers must NOT veto against it."*

**The plan has already internalised this and left the rejection standing.** §0.5's own title is "the
list is authoritative for nothing", and §2.6 clause 7 requires the body to say so about the **CI** list.
The rejection depends on the opposite being true.

The rejection's second half (`:211-212`, "its service list is a different enumerator") does not apply to
`local-deploy-all` **at all**: its input schema is `sharedInput` = `{env, dryRun, confirm}`
(`local-deploy.ts:476-480`, `:494-501`). No `version`, no `service`. Its form is a single env enum with
**zero network calls** — none of §2.4's three traps (`:348-358`) can reach it. It is the cheapest and
least trap-laden provider available in this increment, and D3 ("do not widen the surface in the
increment that first runs any of it") argues for shipping *it* first, not for excluding it.

**A third leg the rewrite added and did not draw.** §0.6 now establishes that `stage` has no veto on
**either runner** (`DEFAULT_PROTECTED_ENVS = ['prod']`, `protected-envs.ts:26`) and is "the environment
an agent is most likely to disrupt". §1.2 D2 says the local runner is the more dangerous one — caller's
own AWS credentials, no CI audit trail. PR-1 relaxes the schema on the **two gh tools only**
(`:542-544`), so after this increment `local-deploy-*` still requires `env` and still instructs the
agent to guess it — the exact D1 complaint the increment exists to retire, left standing on the runner
its own driver ranks most dangerous, for the env its own §0.6 identifies as least protected.

**Where the antithesis stops, honestly.** `local-deploy-selected` declares
`service: z.array(z.string()).min(1)` required (`local-deploy.ts:509-512`) and hits the same wall as
`services`. And there **is** a genuine CI/local discriminator the plan never states: on the local runner
a wrong env dies at preflight — `assertEnvMatchesAccount` (`preflight.ts:58-68`) refuses when the AWS
account reports a different stage, `assertCleanTreeForSharedEnv` (`:76-90`) refuses a dirty tree, both
before anything is spawned (`:135-156`). A wrong env dispatched to CI simply runs. That is a real reason
to *prioritise* the CI form. It is not the reason given, and it argues for ordering rather than
exclusion.

---

## TRADEOFF TENSIONS

### T1 — "one edit covering every call site" versus "PR-0 must not be a CLI regression." The plan wants both and contradicts itself about which it chose.

Two passages specify PR-0's guard differently, and the difference is the entire blast radius:

- **§2.2 `:260-262`:** *"All three clauses survive extraction — `isMcpMode() || !process.stdin.isTTY ||
  jsonOutput.enabled` — and `jsonOutput.enabled` matters more after extraction, not less: it now covers
  every inquirer prompt."*
- **§4 PR-0 `:537-538`:** *"call it from `withEscape`'s **`isMcpMode()` branch**."*

The first refuses at 23 sites on **non-TTY** and **`--json`**; the second refuses only under MCP. The
ambiguity is easy to write because `withEscape:58` is a single early return covering two unrelated
conditions: `if (isMcpMode() || !process.stdin.isTTY) return run(context)`.

**§1.1 principle 5 resolves only half of it.** *"A prompt is never correct **under MCP**"* is true and
licenses the `isMcpMode()` clause at all 23 sites (ruling 2). It says nothing about non-TTY — and
`release-picker.ts:33-34` records the opposite intent for that clause: *"The `!isTTY` clause stays as
well, for genuinely non-interactive runs (pipes, CI)"* — a judgement made for **one Ink picker**, not
for the confirm on every destructive CLI command.

**The `!isTTY` clause: lower risk than it looks, but unjustified and untested.** Most sites are already
non-functional on a non-TTY stdin (inquirer cannot work there), so a refusal is a better message rather
than a lost capability. The site that *looks* most at risk is safe, and is worth recording because
someone will raise it: `cli.ts:145-150` runs the inquirer palette fallback when **stdout** is not a TTY
while stdin still is (`:124`), and the comment at `:117-122` documents `infra-kit > log.txt` as a
deliberate live case, noting *"`withEscape` keys on stdin, so its guard does not fire."* Stdin is a TTY
there, so neither reading fires. **No regression.**

**The `jsonOutput.enabled` clause: a concrete, user-visible change at ~10 sites, argued in a subordinate
clause.** §2.2 `:261-262` explicitly celebrates that it "now covers every inquirer prompt", and `--json`
is registered on every command (`release-picker.ts:17-19`). So on a TTY, `--json` invocations that today
prompt-then-emit would hard-refuse at `env-load.ts:264`, `release-create.ts:81/97/138/152/184/191`,
`worktrees-add.ts:146/163`, `release-desc-edit.ts:72`, `env-token-set.ts:62`, `confirm-or-exit.ts:58`.
That is defensible as a fix — a prompt on the `--json` path is exactly the leak `release-picker.ts:17-19`
names — but it is a behaviour change at ~10 sites shipped inside a PR described as a stream-safety
prerequisite, and G0b tests the extracted function rather than one call site.

**And §5.1 cannot tell the two readings apart.** G0a fixes `isMcpMode() === true` **with
`isTTY === true`** — the correct PM-D2-proof fixture, and a genuinely good row. G0c fixes "outside MCP,
on a TTY, not `--json`" and expects the callback to run. **Neither reading fails either row.** The
non-TTY case — the only case where the two specifications differ — has no row at all. The most
consequential decision in PR-0 is both under-specified and untested.

**Resolution:** `isMcpMode()` only, everywhere. `jsonOutput.enabled` is defensible on its own merits but
is a separate decision that deserves its own sentence and its own row. `!isTTY` stays in
`release-picker.ts`, where it was argued for one Ink picker.

### T2 — "the form asks for what the agent omitted" versus "the human sees the list." §2.4's conditionality buys PM-D3 and sells the picker.

`services` is offered only when round 1 omitted it (`:329`, `:332-334`). Sound (adjudication 2). But the
mirror image is unstated: **an agent that guesses `services: ['client-be']` silently costs the human the
service picker entirely** — no field, no notice, no log line; the gate simply shows one service.

The only control is §2.5's prose instruction to *"omit the arguments you intend the human to choose"*
(`:383`), read by the agent — governing **P6**'s exact reader/timing mismatch (*"A form cannot warn an
agent off a path it is about to choose"*). The gate payload already carries a field-shaped channel for
this class of fact (`formDiscarded`, `tool-handler.ts:203`); a "a form was available but you supplied
every field" clause would cost one line. Not required for v1 — but the residue must be **stated**,
because the plan reasoned carefully about PM-D3 and not at all about its inverse.

### T3 — "Enumerate from the artifact that decides" (§1.1 principle 3) versus "never veto on a local read of a remote fact."

The `env` field is `z.enum([...])` built from the working tree, and `readAcceptedArgs` re-runs the
provider and **validates round-2 content against that same schema** (`argument-form.ts:193-205`). So the
human's affordance is hard-bounded by a list the codebase has twice recorded must bound nothing:
`workflow-envs.ts:14-18` and `env-picker.ts:15-18` — *"Vetoing on a local read of a remote fact is what
made `stage` and `prod` undeployable under the old `environments` array"* — with the concrete drift at
`workflow-envs.ts:26-30` (hulyo declared 6 envs; its workflows declared 8).

§1.1 principle 3 (`:176-177`) now names this correctly in the abstract, and §2.6 clause 7 requires the
body to say it. But §5 P2 and E1 still *pin* the enum to "declared envs minus prod", converting the
drift behaviour into a tested invariant. There is a free mitigation the plan already has and does not
know it has: the field is `.optional()` and `toArgs` merges, so a human who leaves `env` blank keeps a
round-1 value the working tree does not declare. That escape hatch is undocumented, untested and
undiscoverable — it belongs in the field's `.describe()` and in a §5 row.

---

## SYNTHESIS

1. **Adopt A ∪ {`local-deploy-all`}** — measured, no longer a branch (§0 M1, ruling 1). Forms on
   `gh-release-deploy-all` (version + env), `gh-release-deploy-selected` (version + env + conditional
   services), `local-deploy-all` (env only); `local-deploy-selected` deferred. Give
   `createDeployFormProvider` a second parameter naming the offered field set and amend §2.4 `:309-310`.
   Fold M1/M2/M4 into the plan's §0 as measured facts, and add the two hard provider constraints:
   `z.array(z.enum(...))` never `z.array(z.string())`; explicit `return null` on an empty list.
2. **Resolve §2.2 vs §4 to `isMcpMode()` only** (+ `jsonOutput.enabled` argued and asserted separately);
   leave `!isTTY` in `release-picker.ts`. Add **G0e**: non-TTY, outside MCP, not `--json` → the callback
   **is** invoked. Without it the two readings are indistinguishable by test, which is what §6.0's
   mutation-adequacy rule forbids.
3. **Put ruling 2's 23-site table in the plan**, with the reachability verdict per site, and **take the
   blanket guard — discard the per-picker fallback.** The survey is the argument: per-picker guarding
   would have missed `worktrees-add.ts:146` and `:163`.
4. **Split PR-0a ahead of everything**, widened to the whole class: `LocalDeployArgs` +
   `worktrees-add`'s missing `isMcpMode()` resolution, each with an extracted-predicate unit test
   (ruling 3).
5. **Fix Option B's rejection** whichever scope wins — the advisory-list discriminator does not exist,
   and §0.5 now says so. If a true discriminator is wanted, it is that local preflight fails closed
   (`preflight.ts:58-68`, `:76-90`) where CI does not; note that it argues for ordering, not exclusion.
6. **Rewrite §2.4's label requirement to field-level prose, rewrite P5 accordingly, and downgrade
   PM-D1's mitigation paragraph to a stated residue** (ruling 5, V2). Re-cut PM-D1's human to one who
   did **not** name the env, so scenario and mitigation match.
7. **State the three residues:** PM-D3's inverse (T2), the round-2 rebuild invariant (adjudication 2c),
   and the drift escape hatch (T3).

---

## PRINCIPLE VIOLATIONS

**V1 — §1.1 principle 2 ("a guard that cannot fail on its own named mutation is a defect"), at §5.1
G0d.** Advertised as red-on-`main` with no mutation; unreachable. `devops/scripts/` holds only `lib`, so
`discoverServices` returns `[]` (`service-discovery.ts:57-61`) and `runLocalDeploy` throws at
`local-deploy.ts:318-324` before `:411`. Wrong file, vacuous assertion, on the plan's own headline
evidence. See ruling 3.

**V2 — §1.1 principle 2, at §2.4's label requirement (P5): the property does not exist.** Now measured
rather than inferred. §2.4 `:343-346` makes shared/personal labelling a **requirement, not a polish
item**, and it is PM-D1's only mitigation. §0 M3 shows enum members render as bare strings and
`.describe()` attaches at the field level only, so **P5 as worded asserts a property the provider cannot
produce** — a guard that cannot pass, which is the same defect class as one that cannot fail. The SDK
does carry titled variants on the wire (`TitledSingleSelectEnumSchema`, `TitledMultiSelectEnumSchema`,
`createMcpHandler-CLhGwQTn.d.mts:585-588`; `enumNames`, `dist/src-CX2iR2pK.mjs:1500`, `:2771`), but
there is no route to them from the `z.ZodObject<z.ZodRawShape>` that `buildRequestedSchema` is typed to
return (`types.ts:57`), and §2.4 `:336` forbids `oneOf`, the other conventional carrier. Ruling 5 settles
the repair: field-level prose in v1, interface-widening as a named follow-up.

**V2b — §1.1 principle 2, at §5.2 P1.** §0 M4 shows `z.enum([])` throws, so at this repo root `null` is
reached by a swallowed `TypeError` (`argument-form.ts:134-138`) rather than by the provider deciding.
P1 asserts `=== null` and passes identically either way — the §6.0 shape exactly. Require an explicit
early `return null` on an empty candidate list, and bind P1 to the `form options empty (<file>)` line so
"nothing to offer" is distinguishable from "the provider is broken".

**V3 — §6.0's meta-guard, at §5.4 and §5.1.** Ruling 4. Improved over the prior draft but still
incomplete: `cwd` and `git init` unnamed, and E6 goes green against a reverted PR-0
(`env-picker.ts:25-31`).

**V4 — §1.1 principle 2, at §5.6.** §5.6 claims `form discarded (narrowed)` is unreachable and credits
P4 with keeping it so. Unreachability rests on **three** legs and P4 covers one: (a) the conditional
offer — P4; (b) the round-2 rebuild seeing the same `params` — **unstated**, adjudication 2c; (c)
`toArgs` never introducing a key `params` lacks — **unasserted**. Add a `toArgs` output-key-set row.

**V5 — §2.8's guard is fail-open in CI.** Unchanged and unaddressed across both drafts.
`manifest.test.mjs` runs at `plugin-ci.yml:35-36`; that job's triggers (`plugin-ci.yml:5-17`) are
`plugins/**`, `.claude-plugin/**`, and two named scripts. The guard's other operand —
`apps/infra-kit/cli/resources/workflow/<stem>.md` — is **not** a trigger path, so the mutation "delete
`--hotfix` from the body" (§0.3's own defect direction) never runs the guard on a PR. One line in the
path filter; belongs in PR-A's AC.

**V6 — §6.0's assertion-binding rule, at §5.3 I1.** *"the names equal the literal pair"* asserts over
hand-written literals — the thing §6.0's third bullet names explicitly (*"never assert facts about
literals you wrote by hand"*). Partition `getExposedMcpTools()` into has-provider / no-provider and
assert both halves, as §6.12 R6 does for `declaredPromptNames`.

**V7 — §1.1 principle 5 is used to license more than it says.** *"A prompt is never correct under MCP"*
licenses the `isMcpMode()` clause. §2.2 `:260-262` extends the refusal to `!isTTY` and
`jsonOutput.enabled` at 23 sites on the strength of that one sentence (`:265`: *"Under MCP an inquirer
prompt is always wrong, so refusing is strictly better everywhere"*). The justification does not reach
two-thirds of the change it is offered for. See T1.

---

## CLAIM ADJUDICATIONS

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| **1** | PR-0: `assertInteractive()` inside `withEscape` is the right site | **PLACEMENT CORRECT / SPEC CONTRADICTORY** | Well chosen: `withEscape:58` already reads `isMcpMode()` and makes the wrong choice there — it skips the Esc plumbing and **still runs the prompt**. One-line edit at the exact seam. But §2.2 `:260-262` and §4 `:537-538` specify different guards (T1). |
| **1a** | "Survey the ~20 call sites" is a gate | **REFUTED — a promise** | §2.2 `:264-268`, §4 `:539`: no artifact, no decision rule, no owner, no §5 row. Count is 23, not ~20. |
| **1b** | Some call site where a blanket MCP refusal regresses something | **REFUTED — none exists** | Surveyed all 23 (ruling 2). Under `isMcpMode()`, stdin *is* the transport (`mcp-mode.ts:2-4`); no prompt can return a usable value. `cli.ts:145-150` looks at risk and is not — it keys on stdin, a TTY in the documented `infra-kit > log.txt` case (`:117-124`). |
| **1c** | The survey finds nothing actionable | **REFUTED — it finds two more live defects** | `worktrees-add.ts:146`, `:163`: `githubDesktop`/`cmux` are `.optional()` (`:373-375`, `:379-380`), `:143-148`/`:160-165` fall through to `withEscape(confirm(...))` with no `isMcpMode()` branch, and `:377`'s own `.describe()` promises *"false (MCP, no TTY)"*. Same class as `confirmTarget`, different exposed tool. |
| **1d** | The per-picker fallback is an acceptable alternative | **REFUTED** | It would have missed both `worktrees-add` sites — they are not deploy pickers. Take the blanket. |
| **2** | `services` in the form when round 1 omits the key | **CONFIRMED — sound** | `narrowsArgs` iterates `Object.entries(before)` (`argument-form.ts:242`), inspecting only keys present in `before` (`:243-247`); `toArgs` merges over `params`, so `narrowsArgs(stripGateKeys(params), merged)` (`tool-handler.ts:306`) is `false`. Not a contradiction of the earlier draft's "structurally impossible" — it is that draft's own escape 4, now paid for rather than deferred. |
| **2a** | The conditionality is assertable in both directions without vacuity | **CONFIRMED** | Direct reads of `Object.keys(shape)` for the present/absent cases; the named mutation (offer unconditionally) reddens the present case. P4 is well-formed. |
| **2b** | `inputRequired.elicit` accepts `z.array(z.enum(...)).optional()` | **CONFIRMED — measured** | §0 M1: renders as `{"type":"array","items":{"type":"string","enum":[…]}}`. The multi-select is buildable; ruling 1's branch closes on A ∪ {`local-deploy-all`}. **But no AC still covers the conversion**: P1/P4/P9 assert on the returned zod shape, never on `elicit()` accepting it, and P9 covers only the async-refine `TypeError`. Add one. |
| **2b′** | `z.array(z.string())` is an equally valid spelling | **REFUTED — it throws, silently** | §0 M2. It is the **exact** type the tool's own `inputSchema` uses (`gh-release-deploy-selected.ts:258-259`), so it is the spelling a provider author copies. `elicit()` throws before anything is sent; `buildArgumentForm`'s catch returns `null` (`argument-form.ts:162-170`); the call falls to the gate logging `Tool execution form unavailable` (`tool-handler.ts:336`) — identical to a non-elicitation client. **Needs a named AC with the mutation stated.** |
| **2b″** | An empty candidate list degrades cleanly to "no form" | **REFUTED — same silent path** | §0 M4: `z.enum([])` throws. At this repo root **both** lists are empty (§0.5), so a provider that builds before checking emptiness reaches `null` by a thrown `TypeError` swallowed at `argument-form.ts:134-138`, not by a decision. P1's `=== null` cannot tell the two apart. Require an explicit early `return null`, and bind P1 to the `form options empty (<file>)` line. |
| **2c** | The round-2 rebuild preserves the conditional offer | **HOLDS TODAY; FAILS SILENTLY IF BROKEN — unstated** | `readAcceptedArgs` rebuilds from the round-2 `params` (`tool-handler.ts:296` → `argument-form.ts:193`), and those are round-1's arguments echoed back (`argument-form.ts:102-104`), so `services` is still absent and the validating schema still carries the field. If a future edit made `buildRequestedSchema` read anything else, zod would **strip** the unknown key at `acceptedContent` (`argument-form.ts:200`), `toArgs` would merge nothing, and the picks would vanish with **no discard log and no `formDiscarded` flag** — worse than PM-D3. |
| **2d** | Residue: a guessing agent silently loses the picker | **REAL, UNSTATED** | T2. |
| **3** | PM-D1 retargeted to `stage` is a genuine authorization scenario | **CONFIRMED — better than the prod version** | Asks §6.0b's question concretely ("picked the second row"), is not a liveness failure, needs no operator opt-out so it sits on the modal path, and the premise is exact: `DEFAULT_PROTECTED_ENVS = ['prod']` (`protected-envs.ts:26`). Its strongest line — *"the form makes this **worse than today**"* (`:491-494`) — is a correct argument against the increment's own headline feature, which is what §6.0b asks for. |
| **3a** | The label mitigation is load-bearing | **REFUTED as specified — it cannot be built** | §0 M3, measured: enum members render as bare strings and `.describe()` attaches at the **field** level only, so a per-option marker does not exist on the wire. §2.4 `:343-346` requires one and calls it "a requirement, not a polish item"; P5 would assert a property the provider cannot produce. Ruling 5 adopts field-level prose (b), rejects value-encoding (a) and interface-widening (c) for v1, and downgrades PM-D1 to a partially-mitigated residue. Separately, the mitigation was **also** aimed at the wrong failure: the scenario's human *named* `stage` and then picked it, so no marker would have changed the outcome — re-cut the scenario to a human who did not name the env. The plan's own concession (`:499-500`) is correct and should stay. |
| **4** | §2.6's rewritten prod framing is accurate | **CONFIRMED — round 1's objection discharged** | `protected-env-access.ts:33` (default `'disallow'`), `:38`, `:40-42` (`'cli-only'` + `isMcpMode()` → `mcp-blocked`); `protected-envs.ts:85-110` (in-process throw, `:93-100` the agent-specific remediation); call-time-read docblock at `protected-env-access.ts:24-29`. The two defeat conditions are exact, and clause 5 (`stage` unprotected on both runners) is correctly placed in the same breath. |
| **5** | The `yes`/`confirmedCommand` live defect | **CONFIRMED IN FULL** | `LocalDeployArgs` declares `yes`, not `confirmedCommand` (`local-deploy.ts:64-70`); destructured at `:312`; gated at `:411`; `confirmTarget` (`:122-141`) → `withEscape` → `@inquirer/confirm`/`select`, writing to `process.stdout` — the JSON-RPC transport; `tool-handler.ts:466` injects `confirmedCommand: true`, never `yes`; `withEscape:58` lets it run under MCP. `confirmDeploy` reads the right field (`confirm-deploy.ts:27-30`) and its docblock (`:21-25`) asserts *"every MCP call arrives with `confirmedCommand: true`"* — true for the gh pair, false for the local pair. |
| **5a** | §0.7's table says this row is reached "**always**" | **OVERSTATED** | Exactly: whenever the deploy proceeds — after `:316-324`, `:340-348`, `:371`, and the `dryRun` return at `:382-408`. Still live, not latent. But "always" is precisely what makes G0d look reachable when it is not. |
| **5b** | PR-0 is the right home for it | **REFUTED — split, and widen to the class** | Ruling 3. |
| **5c** | The plan's ACs would catch a regression of it | **REFUTED** | V1 / ruling 3. §5 catches the schema-relaxation hazard (E6, given a working fixture) and nothing about the field name. |
| **6** | §0.7: "the only guarded prompt is the one someone individually remembered" | **CONFIRMED** | `assertInteractive` exists once, module-private, `release-picker.ts:35-43`, called only from `pickReleaseBranch` (`:53`). `withEscape` guards nothing. |
| **6a** | §0.7's latency claims for the three pickers | **CONFIRMED** | `env` required on all four deploy tools; `services` required (`gh-release-deploy-selected.ts:258-259`); `service` required with `.min(1)` (`local-deploy.ts:509-512`). The mechanism keeping them latent is a **required MCP schema field** — the same mechanism that makes `release-create`'s six sites unreachable (`:432-476`) — and PR-1 deliberately removes it. That is exactly why the ordering constraint is load-bearing rather than administrative. |
| **7** | §5 escapes the enumeration vacuity | **REFUTED for §5.4 and G0d; CONFIRMED for §5.2** | Ruling 4. |
| **8** | §2.8's `argument-hint` guard | **SOUND PREDICATE / FAIL-OPEN EVALUATION** | Red-today verified exactly: `plugins/infra-kit/commands/release-create.md:4` carries `--hotfix`/`--desc`; the only `--flag` token in `apps/infra-kit/cli/resources/workflow/release-create.md` is `--ff-only`. V5 for the CI trigger gap. |
| **8a** | §0.3: "the meaning never reached the body" | **OVERSTATED** | The `type` semantics **are** documented in that body at `:69` and `:78` (`"regular"`/`"hotfix"`, default `"regular"`); only the **flag spellings** are missing. OQ-3's recommended repair is therefore binding two spellings to semantics that already exist — cheaper than the plan implies. |
| **9** | §2.5: the form structurally cannot choose the tool | **CONFIRMED (mechanism) / OVERSTATED (framing)** | `formProvider` per-tool on `CatalogMcpTool` (`command-catalog.ts:57`) and `McpTool` (`types.ts:91`); `StopDeps.toolName` bound at registration (`tool-handler.ts:242`); round 2 re-enters the same tool (`tool-handler.ts:106-110`). But the constraint is downstream of a design *preference* recorded at `release-deploy.ts:29-33`, which rejected the merged `--services`-present-or-absent surface for a stronger reason than the plan's own. §2.5 `:372-374` now makes nearly that argument without the citation — add it, and impossibility becomes a documented decision. |
| **10** | Option C's rejection (two commands, `-ci` and `-local`) | **CONFIRMED** | `release-deploy.ts:21-33` records the CLI's own merge of the `release …` / `local …` command-group split into `--from`. Correct citation, correct conclusion. |
| **11** | Option B's rejection ground | **REFUTED** | `local-deploy.ts:328-329` ≡ `gh-release-deploy-all.ts:48-49`; the advisory warning is `workflow-envs.ts:14-16`, the enumerator's own. See antithesis. |
| **12** | §0.1: `local-deploy.ts:333` is fixed | **CONFIRMED** | `isSharedEnv` at `local-deploy.ts:57-59` returns `SHARED_ENVS.includes(env) \|\| isProtectedEnv(env)`, docblock `:38-56`; `assertCleanTreeForSharedEnv` (`preflight.ts:76-90`) is called unconditionally from `runPreflight` (`:150`), reached at `local-deploy.ts:371-378`. |
| **13** | §0.2: the publish gate is single-command and fail-fast | **CONFIRMED** | `COMMAND_FILE` / `REQUIRED_URI` module constants (`check-workflow-resource-published.mjs:30-31`); `fail()` → `process.exit(1)` (`:34-37`). Red today: floor `0.5.0` (`plugins/infra-kit/commands/release-create.md:8`) vs workspace `0.4.0` (`apps/infra-kit/cli/package.json:4`); CI expects it red (`plugin-ci.yml:42-45`). Floor and workspace version verified; the registry was not queried. The report-all requirement is correct and G4 tests it. |

---

## VERDICT

**ITERATE.**

The rewrite corrected the prod-boundary inaccuracy, found a live defect round 1 missed, and took the
harder correct path on `services` — which the §0 measurements now vindicate. What stops approval: PM-D1's
mitigation is not buildable as specified and its guard could never pass; PR-0's guard is specified two
incompatible ways and no row can tell them apart; the one AC advertised as red-on-`main` cannot run; two
of the schema shapes the provider might reasonably build fail **silently**; and the survey PR-0 defers
turns out to contain two more live defects on a second exposed tool.

Required before approval:

1. **Adopt A ∪ {`local-deploy-all`}** (§0 M1 closes the branch); give `createDeployFormProvider` an
   offered-fields parameter; amend §2.4 `:309-310`.
2. **Resolve §2.2 vs §4 on PR-0's clauses** to `isMcpMode()` only, with `jsonOutput.enabled` argued and
   asserted separately; leave `!isTTY` in `release-picker.ts`. Add **G0e** (non-TTY, outside MCP, not
   `--json` → callback invoked).
3. **Put the 23-site survey table in the plan** with a reachability verdict per site, and **decide for
   the blanket guard**; delete the per-picker fallback.
4. **Split PR-0a ahead of the plan**, widened to the whole class: `LocalDeployArgs` accepting
   `confirmedCommand`, **plus** `worktrees-add.ts:143-148` / `:160-165` gaining the `isMcpMode()`
   resolution its own `.describe()` at `:377` already promises.
5. **Replace G0d** with an assertion over an extracted predicate — as filed it cannot fail
   (`service-discovery.ts:57-61` → `local-deploy.ts:318-324` fires first). Add the `worktrees-add`
   equivalent.
6. **Rewrite §2.4 `:343-346` to field-level `describe()` prose naming both partitions from
   `isSharedEnv`; rewrite P5 to assert that; downgrade PM-D1's mitigation paragraph (`:496-497`) to a
   stated residue.** Per-option labels do not exist on the wire (§0 M3). Reject value-encoding; file
   interface-widening (`createMcpHandler-CLhGwQTn.d.mts:585-588`) as the follow-up. Re-cut PM-D1's human
   to one who did not name the env.
7. **Add two silent-degradation ACs.** (i) The services field must be `z.array(z.enum(...))` — mutation:
   change it to `z.array(z.string())`, the tool's own spelling
   (`gh-release-deploy-selected.ts:258-259`), and the test must redden (§0 M2). (ii) The provider must
   `return null` explicitly on an empty candidate list, and P1 must assert the *reason* — bind it to the
   `form options empty (<file>)` line, because `z.enum([])` throws and `=== null` alone cannot tell a
   decision from a swallowed `TypeError` (§0 M4, `argument-form.ts:134-138`).
8. **Add an AC that the built schema is actually sendable** — `buildArgumentForm(...) !== null` for the
   services-bearing shape. P1/P4/P9 all assert on the returned zod object and none on `elicit()`
   accepting it (§0 M1, adjudication 2b).
9. **Complete §5.4's fixture:** `mkdtemp` + `git init` + **`cwd` on the spawn**
   (`git-utils.ts:143-147`; `mcp-stdio.e2e.test.ts:67`, `:513`, `:1702`). State that E6 goes green
   against a reverted PR-0 without it (`env-picker.ts:25-31`).
10. **Add `apps/infra-kit/cli/resources/workflow/**` to `plugin-ci.yml`'s path filters** in PR-A.
11. **Fix Option B's rejection** — the advisory-list discriminator does not exist, and §0.5 says so.
12. **Add three residues:** a `toArgs` output-key-set row for §5.6; the round-2 rebuild invariant (2c);
    PM-D3's inverse (T2). Plus the drift escape hatch in §2.4's `.describe()` and a §5 row (T3).
13. **Precision:** §0.7's "always" → "whenever the deploy proceeds"; §0.3's "the meaning never reached
    the body" → "the flag spellings never reached the body" (`resources/workflow/release-create.md:69`,
    `:78`); rebind §5.3 I1 to a partition of `getExposedMcpTools()`; cite `release-deploy.ts:29-33` in
    §2.5.

---

*Read-only review. No source file was modified.*
