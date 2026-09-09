# `/infra-kit:release-deploy` — the second plugin command, and the first live argument form

**Status: APPROVED and IMPLEMENTED** (e9ea02d and the three commits before it). Approved by the
architect and critic passes recorded in `docs/reviews/`; PR-0a, PR-0b, PR-1, PR-A, PR-B and PR-D are
landed on `main`. **PR-C and PR-E are NOT done** — both need an npm publish, and PR-E is additionally
gated on PR-C being live on the registry, which no code change can satisfy.

Increment of `docs/infra-kit-slash-commands-plan.md` (**§n**) and sibling of
`docs/release-create-command-plan.md` (**RC §n**). Where they decide something this document does not
re-decide it; where measurement contradicts them, §0 states the contradiction and the plan follows the
measurement.

**Revision 5** — one blocker, scoped to PR-D. §0.11: the CI services enum is built from the workflow's
inputs block, but service **jobs** are gated by environment in the `if:` expression, so the picker would
offer services the target env silently skips and the fire-and-forget dispatch would report success. The
repair is not an intersection — the env is chosen in the same form — so service gating moves to
**execution time**, where the env is known, and the picker offers the **full declared set** backed by
that refusal (§1.3 **Option H**). Scope widens to env-bearing forms on **all four** deploy tools.

*This section was written twice.* Revision 4 first removed the services picker entirely (Option G) on the
ground that a union "re-admits the defect". **That was wrong and inconsistent with the same revision**,
which had already added the execution-time refusal that closes it; the lead challenged it and the
challenge was correct. The picker is restored, the false rejection is recorded rather than deleted, and
the genuine residue it was reaching for — an unparseable gate — is stated as **R1**. PR-0a, 0b, 1, A, B
and C are approved and untouched.

Revision 4 also **corrects a fact supplied to revision 3 and relied on**: `withEscape`'s `base?`
parameter has six callers, not zero (§0.9). §2.3's `whenHeadless` design survives in **weakened form** —
optional rather than required — on a **different and stated** argument: it makes the defect class
representable, where the original claim (that a required parameter turns the survey into a compile-time
obligation) is withdrawn as false.

*Revisions 1–3, retained because the corrections are the argument:* the two reviews conflicted on the
`withEscape` guard and neither position was adopted. §1.1 carries three standing rules extracted from
failures this plan committed itself — S1 now including one of my own.

---

## 0. Measured facts

Ten. Five move a decision; four were measured by reviewers and the lead and are adopted as facts.

### 0.1 `local-deploy.ts:333` is FIXED — §4.1's deferral condition is met

`isSharedEnv` (`local-deploy.ts:57-59`) returns `SHARED_ENVS.includes(env) || isProtectedEnv(env)`, with
a docblock (`:38-56`) naming the hazard it closes. `assertCleanTreeForSharedEnv` (`preflight.ts:76-90`)
is called unconditionally from `runPreflight` (`:150`), reached at `local-deploy.ts:371-378`. §7.7 Phase
2b's `local-deploy` half is discharged and absorbed here.

### 0.2 The publish gate handles ONE command, and is fail-fast

`COMMAND_FILE`/`REQUIRED_URI` are module constants naming `release-create`
(`check-workflow-resource-published.mjs:30-31`); `fail()` is `process.exit(1)` (`:34-37`). A second
command file would not be checked at all. The gate is **deliberately red today** — floor `0.5.0`
(`plugins/infra-kit/commands/release-create.md:8`) against workspace and published `0.4.0` — so a
fail-fast generalization would exit on that known redness and never reach the second command. Green by
non-execution, precisely when it matters. Generalizing must be **report-all, then exit** (PR-A).

### 0.3 The `argument-hint` defect is the flag **spellings**, not the semantics

`--hotfix`/`--desc` are not CLI flags, but the hint was **settled by the user** (RC §0) and RC §2.7's
M-5 table gives them a meaning at the agent layer. *Corrected from revision 1's "the meaning never
reached the body":* `resources/workflow/release-create.md:69` and `:78` **do** document the `type`
(`"regular"`/`"hotfix"`, default `"regular"`) and `description` semantics. What never reached the body is
the **flag spellings** that map onto them. OQ-3's repair binds two spellings to semantics that already
exist.

### 0.4 The enumeration sources already exist as tested functions

- **releases** — `getReleasePRsWithInfo()` + `detectReleaseType(pr.title)` + `getJiraDescriptions()`,
  with a first-class `dev` entry (`resolve-branch.ts:39-43`). **Two network calls.**
- **env** — `deployableEnvs(await readWorkflowEnvOptions(<WORKFLOW_FILE>), protectedEnvAccess)`.
  Filesystem only.
- **services** — `parseServicesFromWorkflow()` (`gh-release-deploy-selected.ts:85`, defined `:213-241`).
  Filesystem only, and **it takes no `env`** — see §0.11, which is why the services enum is the full
  declared set and the env gate is enforced at execution time instead.

### 0.5 The env domain is per-workflow, and the list is authoritative for nothing

`deploy-all.yml` and `deploy-selected-services.yml` declare **different** `environment` lists
(`gh-release-deploy-selected.ts:53-56`; `release-deploy.ts:28-33`). And `readWorkflowEnvOptions` reads
the **working tree** while the dispatch targets `--ref <branch>`: `workflow-envs.ts:14-18` is the
enumerator's own docblock — *"ADVISORY ONLY: it sources the interactive picker, and callers must NOT veto
against it"* — with the concrete drift at `:26-30` (hulyo declared 6 envs, its workflows 8).

**This applies identically to CI and local.** `local-deploy.ts:328-329` is character-identical to
`gh-release-deploy-all.ts:48-49`, against the same `deploy-all.yml`. Revision 1 rejected a local form
because "the local env list is explicitly advisory" — a discriminator that does not exist, on a property
the chosen option shares. §1.3 is corrected, and §1.1's standing rule S1 exists because of it.

**This repository has neither workflow.** `.github/workflows/` holds `plugin-ci.yml` and four
`_`-prefixed reusable job files; `devops/scripts/` holds only `lib` — no `deploy-*.sh`. Every enumeration
returns `[]` here.

### 0.6 §4.3's prod claim is over-broad — there IS a real block on the agent path

```ts
// src/lib/workflow-envs/protected-env-access.ts:40-42
if (setting === 'cli-only' && isMcpMode()) return { allowed: false, reason: 'mcp-blocked' }
```

With `protectedEnvs` absent (default `'disallow'`, `:33`) or `'cli-only'`, `assertDeployable`
(`protected-envs.ts:85-110`) **throws in the dispatching process**, with an agent-specific remediation at
`:93-100`. `isMcpMode()` is read at call time (`protected-env-access.ts:24-29`) and an agent cannot flip
it. So §4.3's *"prod is not protected by anything the agent can rely on"* is inaccurate, and repeating it
would be the false-safety statement §4.3 forbids.

**The local runner has the same veto, plus one more.** `preflight.ts:141` calls
`assertDeployable(env, …, protectedEnvAccess)` **before** `assertCleanTreeForSharedEnv` at `:150`. It is
the stricter runner, not the looser. *(Revision 1 described its prod story as being about the working
tree — the same over-broad-claim error §0.6 exists to correct, one clause later. Corrected in §2.7
clause 8.)*

- `DEFAULT_PROTECTED_ENVS = ['prod']` (`protected-envs.ts:26`) — only prod.
- **`stage` is not protected.** Shared, with no `assertDeployable` veto on either runner.

### 0.7 MEASURED — an inquirer prompt under MCP is stream corruption, not a hang

Four sites write prompts into the JSON-RPC channel. **Three are LIVE on two shipped exposed tools.**

`pickReleaseBranch` calls `assertInteractive()` (`release-picker.ts:35-43`) — the **only** guarded
prompt; `assertInteractive` is module-private and called once (`:53`). `withEscape`
(`escapable-context.ts:58`) reads `if (isMcpMode() || !process.stdin.isTTY) return run(context)` —
**both branches run the prompt.**

**Two independent fixtures, two message strings, one conclusion.** `@inquirer/core`'s
`create-prompt.js:54` is `output.pipe(context.output ?? process.stdout)` and no call site passes
`output`:

| Fixture | Result |
|---|---|
| `stdio: ['pipe','pipe','pipe']` — Claude Code's spawn shape | **60 bytes on stdout**: `? Deploy 3 service(s) to stage from this machine? (y/N)⎋[57G` |
| stdin `/dev/null`, stdout redirected to a file | **54 bytes on stdout, 0 on stderr**: `? Open created worktrees in GitHub Desktop? (Y/n)⎋[51G` |

**Piping removes the TTY; it does not remove the write.** The observable is bytes on the protocol
channel — cheap and deterministic to assert — **not a timeout**. Every AC in §5.1 asserts bytes for that
reason (§1.1 S2). `release-picker.ts:22`'s "these prompts render to stderr" is about the Ink picker and
does not generalize.

**The codebase already knew about this class and mis-graded it.** `tool-handler.ts:455-458` says
`confirmedCommand` must keep being injected *"or the non-TTY server would **hang** on an inquirer
prompt"*. It does not hang; it writes 54–60 bytes of protocol garbage and desynchronises the session.
That comment is itself an instance of S1 — prose asserting a behaviour nobody measured — sitting in the
chokepoint this whole increment runs through.

| Site | Tool(s) | Gated? | Status |
|---|---|---|---|
| **`confirmTarget` (`local-deploy.ts:126`,`:131`, called `:411`)** | `local-deploy-all`, `local-deploy-selected` | yes | **LIVE** — `LocalDeployArgs` declares `yes` (`:64-70`), gated at `:411`; `tool-handler.ts:466` injects `confirmedCommand`. Reached whenever the deploy proceeds. |
| **`confirm` GitHub Desktop (`worktrees-add.ts:145-148`)** | `worktrees-add` | **NO** | **LIVE** |
| **`confirm` cmux (`worktrees-add.ts:160-164`)** | `worktrees-add` | **NO** | **LIVE** |
| `pickEnv` (`env-picker.ts:33`) | four deploy tools | — | latent — `env` required |
| services checkbox (`gh-release-deploy-selected.ts:105`) | `gh-release-deploy-selected` | — | latent — `services` required |
| `pickServices` (`local-deploy.ts:101`) | `local-deploy-selected` | — | latent — `service` required `.min(1)` |
| `select` config (`env-load.ts:264`) | `env-load` | — | latent — `config` required |
| `promptDescription` (`release-desc-edit.ts:72`) | `release-desc-edit` | — | latent — both required |

**`worktrees-add` is the worst of the three, and revision 1 never analysed it.** It carries no
`requiresHumanConfirm` (`:346-391`), so it executes on a **single call with no confirm round**. Both
config keys are `.optional()` with no default (`infra-kit-config.ts:97-98`). It fires on the
*documented correct* MCP invocation: supply `versions`, walk past the guarded picker at `:112` and the
correctly short-circuited `confirmOrExit` at `:127`, into two unguarded prompts. **The happy path is the
defect path.** And the correct pattern is nineteen lines above the defect — the same author, in the same
function, guarded one prompt and not the next two. That is stronger evidence for §0.7's thesis than the
`local-deploy` example.

`confirmDeploy` (`confirm-deploy.ts:27-30`) and `confirmOrExit` (`confirm-or-exit.ts:56-60`) both
short-circuit correctly.

### 0.8 MEASURED — what `inputRequired.elicit()` accepts

Adopted from `docs/reviews/elicit-schema-measurements.md` (`@modelcontextprotocol/server@2.0.0`).

| Input | Result |
|---|---|
| `z.enum([...])`, `z.array(z.enum([...]))`, `.optional()`, `.describe()`, `z.object({})` | **OK** |
| `z.array(z.string())` | **THROW** — *"only supports flat primitive properties…"* |
| `z.enum([])` / `z.array(z.enum([]))` | **THROW** |
| nested `z.object` | **THROW** |

- **M1 — the multi-select works**, but only as `z.array(z.enum(...))`. **Load-bearing:** the `services`
  field on `gh-release-deploy-selected` is the array it licenses (§2.5). *(Revision 4 briefly annotated
  this as "not load-bearing here" while Option G held; Option H restores it.)*
- **M2 — `z.array(z.string())` throws, and it is the obvious spelling** — the exact type the tool's own
  `inputSchema` declares (`gh-release-deploy-selected.ts:258-259`), so it is the spelling a provider
  author copies. `elicit()` throws before anything is sent; `buildArgumentForm`'s catch returns `null`
  (`argument-form.ts:162-170`); the call falls to the gate logging `Tool execution form unavailable` —
  **identical to a non-elicitation client.** **Load-bearing, and P10 is the AC.**
- **M3 — per-option labels do not exist.** Enum members are bare strings; `.describe()` is field-level
  only. Revision 1's PM-D1 mitigation is not implementable and its P5 asserted a property the provider
  cannot produce.
- **M4 — an empty enumeration throws through the same silent path**, swallowed at
  `argument-form.ts:134-138`. At this repo root **both** lists are empty (§0.5), so `=== null` cannot
  distinguish a decision from a bug. The provider must `return null` **explicitly**; `z.object({})`
  renders cleanly and must never mean "nothing to offer".

### 0.9 MEASURED — 23 `withEscape` sites, and they do NOT share one correct behaviour

The survey (architect lane) found 23 sites across 13 files, and found §0.7's two `worktrees-add`
defects. Revision 1 had it as "~20" and as an intention rather than an artifact.

| Site(s) | MCP-reachable? | Correct headless behaviour |
|---|---|---|
| `entry/cli.ts:145` | no — CLI palette; server is `entry/mcp.js` (`mcp.ts:29-31`) | n/a |
| `dev/dev-wizard-run.ts:74`,`:79`,`:84` | no — `dev` is not exposed | n/a |
| `env-token-set.ts:62` | no — not in the catalog | n/a |
| `release-deploy/source-picker.ts:40` | no — merged CLI command only (`confirm-deploy.ts:23-25`) | n/a |
| `release-deploy/confirm-deploy.ts:34` | no — guarded at `:30` | n/a |
| `command-echo/confirm-or-exit.ts:58` | no — guarded at `:56-57`; all 7 callers pass it | n/a |
| `release-create.ts` ×6 | schema-blocked — `releases` `.min(1)`, not optional | **`'unreachable'`** |
| `release-desc-edit.ts:72` | schema-blocked | **`'unreachable'`** |
| `env-load.ts:264` | schema-blocked | **`'unreachable'`** |
| `env-picker.ts:33` | schema-blocked → **live after PR-1** | **`'unreachable'` → `'refuse'`** |
| `gh-release-deploy-selected.ts:105` | schema-blocked → live after PR-1 | **`'unreachable'` → `'refuse'`** |
| `local-deploy.ts:101` | schema-blocked | **`'unreachable'`** |
| `local-deploy.ts:126`,`:131` | **LIVE** | **`'refuse'`** |
| **`worktrees-add.ts:146`,`:163`** | **LIVE** | **`{ value: false }`** — its own `.describe()` (`:373-384`) documents the resolution order ending in *"false (MCP, no TTY)"*, and `:349` says the prompts are "unreachable without a TTY" |

**The first four rows are structurally out of reach** (a different entry point, an unexposed command, a
CLI-only path, an already-guarded call) and are not schema claims; they take the `'refuse'` default and
G8 does not apply to them. **The ten `'unreachable'` rows are schema claims and G8 checks them.**

**Note the two arrows: PR-1 makes three of those claims false.** Relaxing `env` and `services` converts
`env-picker.ts:33` and `gh-release-deploy-selected.ts:105` from schema-blocked to live, so their
declarations must flip to `'refuse'` in the same PR — and **G8 is what forces it** rather than leaving it
to be noticed. That is S3 made mechanical: the plan's own schema relaxation is the first thing the new
check catches.

**This is the finding that decides §2.3, and it turns on a distinction the survey did not draw: "no
regression" is not "correct behaviour".** The architect asked whether a blanket refusal would *remove a
capability* and answered no — correctly, on the ground that under `isMcpMode()` stdin *is* the transport
(`mcp-mode.ts:2-4`), so no prompt can return a usable value. But "the prompt could not have worked
anyway" establishes only that refusing takes nothing away; it says nothing about whether refusing is the
**right** thing to do instead. At `worktrees-add` it is not: the correct MCP behaviour is neither
prompting nor refusing but **resolving to the documented default without prompting**. A blanket throw
fixes the stream corruption and breaks the tool — on the only ungated tool in the set, where the break
lands on a single call with no confirm round to absorb it. A survey that asks only "does this regress"
cannot find that; the column it needs is "what *should* happen here", which is why §2.3 gives every site
somewhere to record one — and requires it of the sites whose answer is not the `'refuse'` default.

**Two more facts that shape the fix — and the first is a correction to revision 3.**

- **`withEscape`'s `base?: PromptContext` has SIX callers across four files**, all passing
  `{ output: process.stderr }`: `entry/cli.ts:149`, `env-load.ts:278`, `env-token-set.ts:69`, and a
  shared `promptContext` at `dev-wizard-run.ts:59` consumed at `:76`, `:81`, `:86`. It is load-bearing,
  and `env-token-set.ts:64-68` says why: some env commands run inside `$(…)` where the shell wrapper
  captures stdout, so a prompt on stdout is swallowed and *"the user would face a blank, silent terminal
  and type a credential into the void."*

  **Revision 3 asserted "zero callers (grepped)" as a measured fact and it was false.** The grep matched
  only same-line named arguments; every real caller passes an object literal on the following line. This
  is **S1 turned on my own process** — a grep result is evidence of a search, not of a fact — and it
  matters because §2.3's original justification rested on the parameter being free. It is not free, and
  §2.3 is re-derived on different grounds rather than quietly re-justified.

  *Design consequence, and it recovers most of the cost:* `base` **is** a `PromptContext`, so the second
  parameter widens to `PromptContext & { whenHeadless?: HeadlessPolicy }` rather than becoming a third.
  All six existing callers stay valid unchanged; only the two sites needing a non-default policy are
  edited.
- **`tool-handler.ts:466` injects `confirmedCommand: true` unconditionally**, on gated and ungated tools
  alike — it sits after `resolveStop` returns `null`, which is the ungated path too. The CLI maps `--yes`
  onto the same field (`program.ts:109`; `worktrees-add.ts:130-131`), which is why §2.2 keys on
  `isMcpMode()` instead. *(The critic's B6 proposed `confirmedCommand` and has since **withdrawn** it,
  having verified the same mapping.)*

### 0.10 The standing generalization: a `.optional()` relaxation is a stream-safety change

Five exposed tools' descriptions claim their prompts are "unreachable without a TTY"
(`env-load.ts:532`, `release-desc-edit.ts:192`, `worktrees-add.ts:349`, `gh-release-deploy-all.ts:137`,
`gh-release-deploy-selected.ts:246`). On four the claim is **accidentally true** — a required schema
field blocks the path, not any mechanism. On `worktrees-add` there is no required field, so the claim is
simply false (§0.7).

**PR-1's entire purpose is to remove those required fields.** So this is not this increment's ordering
note; it is a standing rule, recorded as **S3** in §1.1 and enforced by §5.1's G6.

### 0.11 The CI services list omits run-time environment gates — the input block is not the deciding artifact

`deploy-selected-services.yml` gates individual service **jobs** by environment, in both consumers
(verified by the lead in each repo; this checkout has no such workflow, §0.5):

- **`docs-fe`** — hulyo `:217`, travelist `:222`:
  `if: inputs.docs-fe == 'true' && (environment == 'dev' || 'arthur' || 'eliran' || 'renana' || 'roman' || 'oriana')`
- **`mobile`** — hulyo `:283`, travelist `:288`:
  `if: inputs.mobile == 'true' && (environment == 'dev' || environment == 'prod')`

`parseServicesFromWorkflow()` reads `workflow_dispatch.inputs` and **takes no env**
(`gh-release-deploy-selected.ts:214-239`, called at `:85`). So a services picker built from it offers
`mobile` for `stage`, the job's `if:` evaluates false, the job is skipped, and — because dispatch is
fire-and-forget — the tool returns **`success: true`**.

**Three reasons this is a blocker rather than a residue.** It is PM-D3's exact outcome by a second
route the plan called closed: a human's selection produces a deploy that reports success and ships
nothing. It violates **principle 3** — the artifact that decides is the job's `if:` expression, and the
enumerator reads the inputs block instead. And it is the **third** instance of **S1** in this plan's
vicinity: the constraint is documented in the inputs' own prose —
`description: 'Deploy docs-fe (dev + per-developer envs only)'` (hulyo `:64`, travelist `:76`) and
`'Deploy mobile (dev/prod only)'` (`:100`, `:112`) — while the enumerator does not implement it.

**The machinery exists but the reuse is not free.** `readWorkflowGates` (`workflow-gates.ts:37`) and
`intersectGates` (`:101`) already parse these gates —
`ENV_EQUALS_PATTERN = /inputs\.environment\s*==\s*'(?<env>[a-z0-9-]+)'/g` (`:22`) is exactly the
construct above, and the module is deliberately best-effort (`:34-36`: an unparseable gate yields no
restriction, "because inventing one would silently shrink what the user can deploy"). Two obstacles:

1. It lives under `commands/local-deploy/`, so the CI path cannot import it without an extraction.
   **It should move to `src/lib/workflow-gates/`** — a leaf with no command dependencies, beside
   `src/lib/workflow-envs/`, which is the same shape of shared read.
2. **`collectGates` unions across every workflow file** (`:90-92`: "A service appearing in several
   workflows is allowed wherever ANY of them allows it"). That is right for the local runner's
   "can I deploy this at all" question and **wrong** for "will *this* dispatch's job run", where the
   only gate that matters is the one in the workflow being dispatched. The extraction therefore needs a
   **workflow-scoped read** — `readWorkflowGates(projectRoot, { workflowFile })` — not a bare move.

---

## 1. RALPLAN-DR summary

### 1.1 Principles, and three standing rules the failures produced

1. **The form narrows a visible choice; it never becomes the authorization.**
2. **A guard that cannot fail on its own named mutation is a defect — and so is one that cannot pass.**
   Revision 1 shipped one of each (P5 asserted a non-existent property; G0d was unreachable).
3. **Enumerate from the artifact that decides, and say what the enumeration is not** — applied
   symmetrically (§0.5).
4. **State the boundary accurately in both directions.** Overstating protection is §4.3's failure;
   understating it (§0.6) trains an agent to discount a control that works.
5. **A prompt is never correct under MCP** — but "not prompting" has **two** correct spellings, refuse
   and default, and which one applies is a per-site fact (§0.9).

**S1 — a docblock or `.describe()` string is evidence of intent, never of behaviour, and may never be
cited as a discriminator between two options.** This plan violated it three times: "the local env list is
advisory" (§0.5), "option labels carry the environment's kind" (M3), "`!isTTY` incidentally catches it"
(§0.7). The codebase violates it twice more: in the chokepoint (`tool-handler.ts:455-458`'s "would
hang") and in `deploy-selected-services.yml`, whose input descriptions state the env gates in prose while
the enumerator reading that block ignores them (§0.11). **Five instances is no longer a pattern of
carelessness; it is the default failure mode of this codebase's documentation, and S1 is the rule that
catches it.**

**S2 — assert the invariant, not the message.** The guard's job is that no bytes reach stdout under MCP.
Error text is churn; bytes on the protocol channel are the property. Every §5.1 row asserts bytes.

**S3 — a `.optional()` relaxation on any exposed tool is a stream-safety change**, because a required
schema field is currently the only thing making four tools' TTY claims true (§0.10).

**S4 — a rejection is invalidated by any change that removes the property it cited, including a change in
the same edit. When you add a mitigation, re-read every rejection that named the thing you just
mitigated.** Revision 4 added the execution-time gate refusal and, in the same edit, rejected the union
services picker because "the union re-admits the defect" — a claim the refusal had already made false.
Nothing caught it: the two passages were internally consistent with the drafts they were each written
against, and only against each other were they contradictory. This is **not** S1 — no prose was mistaken
for behaviour — and it generalises well enough to earn its own number: the failure is *stale rejection
after a mitigation lands*, and its tell is a rejection whose reason names a defect the same change
closes. §7's ADR records both instances.

### 1.2 Decision drivers

- **D1 — the human-facing question must leave the agent.**
- **D2 — blast radius.** Shared environments; on the local runner, the caller's own AWS credentials.
- **D3 — do not widen chokepoint invariants in the increment that first runs any of this.**

### 1.3 Viable options

#### Option H — union services picker + execution-time gate refusal — **CHOSEN**

Env-bearing forms on all four deploy tools, **plus a `services` multi-select on
`gh-release-deploy-selected`** offering the full declared set, conditional on round 1 omitting the key.
Service gating is enforced at **execution time**, after the env resolves and before `gh workflow run`.

**Revision 4 initially chose Option G below and rejected this one on the ground that "the union
re-admits the defect". That rejection is wrong, and it was internally inconsistent with the same
revision.** §0.11's defect is *silent success*: the job's `if:` evaluates false, the job is skipped, and
fire-and-forget dispatch returns `success: true`. The execution-time refusal converts that into a loud
failure **independently of whether a picker exists**. Once it is in place, a union picker cannot produce
a silent skip, because nothing is dispatched. The rejection was reasoning from a draft in which the
execution-time refusal did not yet exist, and it survived into a revision that added it.

The other two intersect objections do not reach the union either, and revision 4 misapplied both: the
round-2 rebuild (`argument-form.ts:102-104`) invalidates *intersection at round 1*, and a union needs no
intersection; "the agent's guess decides whether the human gets a picker" is an objection to
*conditionality of the domain*, not to an unconditional list.

- **+** It is what the user asked for in their own words. Option G's central cost was giving that up.
- **+** **The refusal round trip exists in both designs.** Under G, an agent-supplied `mobile` for `stage`
  is refused just the same — the human simply cannot correct it themselves and must go back through the
  agent. G does not avoid the wasted round trip; it removes the human's ability to fix it.
- **−** **It brings back four pieces of delicate machinery Option G deleted, and they are ACTIVE, not
  historical text.** A reader who saw Option G must not assume any of them lapsed:
  1. **the conditional offer** — `services` is offered only when round 1 omitted the key (§2.5, P4);
  2. **the empty-selection rule** — `toArgs` returns `null` on `services: []` (§2.5, P12);
  3. **M2's throwing spelling** — the field must be `z.array(z.enum(...))`, never `z.array(z.string())`
     (§0.8 M2, P10);
  4. **R1b** — a guessing agent silently removes the picker (§6).

  All four were specified in revision 3 and reviewed. Re-accepted known risk, not new risk.
- **−** **The list carries no gate information and cannot** (M3: no per-option labels). The best available
  marking is the field-level `.describe()`, which §2.5 requires to name the gate map — read before the
  list, skippable, exactly PM-D3's grade.
- **−** **One residual is genuinely worse under a picker**, and it is stated rather than traded away: see
  PM-D3. The gate parser is best-effort by design (`workflow-gates.ts:34-36`) and
  `ENV_EQUALS_PATTERN` (`:22`) matches only `inputs.environment == '<literal>'`. A gate written any other
  way — `contains(fromJSON(…), inputs.environment)`, a matrix condition, a composite — yields **no**
  restriction, so the dispatch proceeds and the job is skipped silently. That path exists in **both**
  designs; what differs is that under H the server **rendered a dropdown containing that service**, which
  is an affirmative representation that it is a legitimate choice here. Under G the same list came from
  the agent. Equal in outcome, worse in provenance.

**Why H wins anyway.** The residual above is a difference in degree on a path both designs share, and it
is bounded by the same parser either way. Against it sits the fact that the picker is the increment's
headline request, that the safety argument for removing it turned out to be false, and that G's own
refusal path leaves the human less able to recover, not more. Where H is weaker it is weaker legibly,
and §2.5's gate-map `.describe()` gives the human strictly more information than G gives them.

#### Option G — env-bearing forms on all four tools, no services field anywhere — superseded

Everything H has, minus the picker. **Its §0.11 argument is discharged by the execution-time refusal**,
so what remains is the residual-provenance point above — a reason to state a residue, not to withhold
the feature. Retained here because its one durable finding stands on its own: **the reversal of
`local-deploy-selected`'s exclusion does NOT depend on it.** That tool gets an `env` picker under either
option, because `env` is offered to every tool regardless of the services question; its *services* picker
stays deferred for an independent reason (`service: z.array(z.string()).min(1)`, `local-deploy.ts:509-512`,
would need its own relaxation, and `assertServicesUsable` at `:352` already refuses loudly there, so there
is no silent-success defect to fix).

#### Option G′ — the original framing of G, for the record

Forms on `gh-release-deploy-all` (version + env), `gh-release-deploy-selected` (version + env),
`local-deploy-all` (env), `local-deploy-selected` (env). **No `services`/`service` field in any schema.**
Service gating moves to execution time, where the env is known (§2.5).

- **+** §0.11 is closed **by construction**, not documented: a picker that does not exist cannot offer a
  service the target env skips.
- **+** **It reverses the `local-deploy-selected` exclusion, so scope widens rather than narrows.** That
  tool was excluded for exactly one reason — its candidates are `eligibleServices(services, selectedEnv)`
  (`local-deploy.ts:340`), an env-dependent domain. Remove the services field and the reason evaporates;
  `service: z.array(z.string()).min(1)` (`:509-512`) is a **contingent second lock**, not the load-bearing
  one, and it stops mattering once nothing offers the field.
- **+** Removes every dependence on M1 (`z.array(z.enum(...))`), on the conditional-offer construction —
  the design's most delicate line — and therefore on `narrowsArgs`' array rule, which can no longer fire
  from any form. R1 and PM-D1's `services: []` half disappear rather than being mitigated.
- **+** `local-deploy-all`'s schema is `sharedInput` = `{env, dryRun, confirm}` (`:476-480`), so its form
  is one env enum with zero network calls.
- **−** **It defers precisely what the user asked for in OQ-1/OQ-5** — the services list. Deferred to F-7,
  conditioned on the workflow-scoped gate read (§0.11) landing first.

**Why this is not Option F wearing a new name.** F was rejected because it removed the env picker from the
`-selected` path, so "deploy the checkout service to stage" got an agent that guessed the env — trading
elicitation away on exactly the field the pre-mortems are about. **G keeps version + env on every tool
including both `-selected` ones**; it drops only the field that cannot be enumerated correctly in a single
round trip. F's fatal cost is absent, and G additionally covers a tool F excluded.

#### Option A ∪ {`local-deploy-all`} — the previous choice, now superseded

Forms on three tools, with `services` offered on `gh-release-deploy-selected` when round 1 omitted it.
**Invalidated by §0.11:** the offered enum is built from the inputs block, which is not the artifact that
decides, so the picker offers services the chosen env silently skips and the dispatch reports success.

#### Option B — intersect the services enum with the env gates

The direct repair, and it does not survive its own circularity. `readWorkflowGates` needs an env to
intersect against, and **the env is chosen in the same form** — the exact dependency that excluded
`local-deploy-selected`, now applying to `gh-release-deploy-selected`. Three sub-variants, all rejected:

- *Intersect against the **union** of all envs* — offers `mobile` for `stage` again. This is the residue
  the blocker refuses to accept.
- *Intersect against round 1's `env` when present* — the round-2 rebuild re-reads the **round-1** params
  (`argument-form.ts:102-104`), so a human who changes `env` in the form is validated against the enum
  built for the old one. Broken in the one case the field exists for.
- *Offer `services` only when `env` is fixed in round 1 and not offered* — a two-mode form whose mode is
  decided by what the agent happened to guess. It makes the agent's guess determine whether the human
  gets a picker, which is D1 inverted.

#### Option C — two round trips: env first, then a gate-filtered services form

**Structurally impossible without widening the chokepoint.** `resolveGateState` sends
`responses !== undefined ∧ accepted` to state `gate` (`tool-handler.ts:113-136`); there is no state that
issues a second form, and re-issuing `inputRequired` on a returning request is PM-4's infinite-prompt bug
verbatim. Adding a state is exactly the chokepoint widening **D3** forbids in the increment that first
runs any of this. Filed as the shape F-7 should take once D3 no longer applies.

*A real CI/local discriminator exists and argues for **ordering**, not exclusion: on the local runner a
wrong env dies at preflight (`preflight.ts:58-68`, `:76-90`) before anything spawns; a wrong env
dispatched to CI simply runs.*

#### Option C — two commands, `-ci` and `-local`
Rejected on §4.2 and the CLI's own recorded merge (`release-deploy.ts:21-33`).

#### Option D — body only, no form, no schema change
Rejected on D1; retained as OQ-4's fallback. **PR-0a and PR-0b ship regardless.**

#### Option F — forms only on the two `-all` tools
Rejected: it removes the env picker from the `-selected` path, so "deploy the checkout service to stage"
gets an agent that guesses the env — trading away elicitation on exactly the field the pre-mortems are
about. F's one good property — no array in any schema, so `narrowsArgs`' array rule cannot fire — is
bought back under H by the conditional offer instead, at the cost of the machinery §1.3 Option H lists.

---

## 2. The design

### 2.1 Scope

| Tool | Body | Form | Fields |
|---|---|---|---|
| `gh-release-deploy-all` | yes | **yes** | `version`, `env` |
| `gh-release-deploy-selected` | yes | **yes** | `version`, `env`, `services` (conditional, union) |
| `local-deploy-all` | yes | **yes** | `env` |
| `local-deploy-selected` | yes | **yes** | `env` (its `service` picker → F-7) |
| `gh-release-deliver` | named as unreachable over MCP, with §0.6's framing | n/a | — |

Every deploy tool carries a provider, so the asymmetry revision 3 had to explain is gone. Exactly one
form offers services, and it is backed by the execution-time gate refusal (§2.5), not by the enum. `NO_FORM_CLAUSE` (`tool-handler.ts:167-171`) still
matters for the other five gated tools, and its comment ("only one gated tool in eight carries a
provider") is stale on both counts — none does today, four will. PR-D updates it.

### 2.2 PR-0a — the three live defects. Standalone, ships ahead of everything.

**Coupling these to this feature was an error, and so was bundling them with a 13-file refactor.** This
plan cannot merge until a CLI is published and a red CI gate goes green (§0.2, §4). Two shipped exposed
tools corrupt the JSON-RPC stream **today**, under the most common client (§0.7). A three-site fix must
not inherit a repo-wide behavioural change's review burden, revert risk, or regression surface.

PR-0a, purely local and independently revertable:

1. **`LocalDeployArgs` accepts `confirmedCommand`** (`local-deploy.ts:64-70`) so `:411`'s gate sees the
   flag `tool-handler.ts:466` actually injects. *(`local-deploy-all`'s MCP `inputSchema` is `sharedInput`
   and declares **no `yes` field at all**, so a schema mapping has nothing to map — accepting
   `confirmedCommand` is the only workable repair.)*
2. **`worktrees-add.ts:145-148` and `:160-164` resolve to `false` under `isMcpMode()`**, restoring the
   order their own `.describe()` documents.

**I disagree with the critic's B6 on the key for (2), and the disagreement is load-bearing.** B6 proposes
keying on `confirmedCommand`, on the ground that the chokepoint injects it unconditionally. It does
(§0.9) — but `worktrees-add.ts:130-131` maps the **CLI's `--yes`** onto the same field
(*"Track --yes flag if confirmation was interactive"*), so keying the default on it would stop
`infra-kit worktrees add --yes` prompting on a TTY. That breaks the documented resolution order in the
CLI direction while fixing it in the MCP direction, and the `.describe()` text is explicit about which
axis it means: *"interactive prompt (CLI) / false (**MCP**, no TTY)"* (`:377`, `:382`). `isMcpMode()` is
the key that fixes exactly what is broken.

Both fixes are **superseded by §2.3's declarative form in PR-0b** — the inline `isMcpMode()` branches
become `whenHeadless: { value: false }`. That churn is deliberate and stated so nobody later reads it as
duplicated logic: a live stream-corruption defect on an ungated exposed tool should not wait on a
23-site type-level refactor.

**Each behind an extracted, pure predicate**, because revision 1's G0d claimed to be "red against `main`
today" and was **unreachable**: reaching `confirmTarget` at `:411` requires passing `discoverServices`
(`:316`), which throws at `:318-324` on an empty result, and this checkout's `devops/scripts/` holds only
`lib` (§0.5). The plan's headline evidence could not run.

### 2.3 PR-0b — `withEscape` declares its headless behaviour. Required parameter.

**The two reviews conflict here, and neither position is adopted.** The architect says take a blanket
`assertInteractive()` inside `withEscape` and drop the per-site fallback. The critic says the blanket
guard breaks `worktrees-add`'s documented default.

**On the facts, the critic is right and the architect's "no site regresses" is wrong** — for the two
sites the architect's own survey discovered. §0.9 states why: the architect asked whether a refusal
removes a capability and answered no; the real question is that "not prompting" has two correct
spellings and `worktrees-add`'s is `false`, not a throw.

*One correction to the lead's framing, for the record.* Revision 2 was not itself broken: it put the
`worktrees-add` default in PR-0a, ahead of PR-0b, so `withEscape` was never reached at those sites under
MCP and no regression could occur. The conflict was narrower than "the blanket guard is wrong". **I adopt
the synthesis anyway, and not to comply** — it is strictly better, for a reason revision 2 could not
claim: it removes the dependence on PR ordering and on an author remembering to add a branch, which is
precisely how §0.7's defect class arises in the first place.

**The design — and the argument for it is that it makes the defect class unrepresentable**, not that it
is cheap. There is today no way to write down "this prompt must not run headless, and here is what should
happen instead"; the information lives in `.describe()` prose that nothing reads. Every instance in §0.7
is the same shape: an author who never had a place to record the answer. The parameter is that place.

```ts
type HeadlessPolicy = 'refuse' | 'unreachable' | { value: T }

withEscape(fn, { output: process.stderr })                    // unchanged — defaults to 'refuse'
withEscape(fn, { whenHeadless: { value: false } })            // worktrees-add's two sites
withEscape(fn, { whenHeadless: 'unreachable' })               // release-create ×6, env-load, …
```

- **Detection lives in one place** — `isMcpMode()`, keyed exactly as `release-picker.ts:35-44` does.
  **Never `isTTY`**: `commands/mcp/mcp.ts` spawns with `stdio: 'inherit'`, so a terminal-launched
  `infra-kit mcp` hands the child a real TTY. It only looks sufficient because Claude Code pipes.
- **Policy is per-site**, so `worktrees-add` keeps its documented default and every picker refuses.
- **OPTIONAL, defaulting to `'refuse'`** — changed from revision 3. Two edits instead of 23; the §0.9
  categorical argument becomes the *default* behaviour rather than something 23 sites restate; it does
  not collide with `base`'s six real callers (§0.9); and the next author who needs a headless default has
  a pattern to copy instead of getting a throw by default.
- **The "required parameter makes the survey a compile-time obligation" claim is WITHDRAWN, and the
  reasoning is worth recording.** It is false: a site that should be `{value:false}` but is written
  `'refuse'` compiles fine, and by §0.9's own argument it can never fail a test, because a refusal is
  never a regression. So a required parameter would not pin the survey — it would pin **whatever the
  author typed**, which is §6.0's "never assert facts about literals you wrote by hand" one level up.
  That is exactly how `worktrees-add` stayed broken: the wrong answer was indistinguishable from the
  right one at every layer except the tool's own `.describe()`.
- **`'unreachable'` is what restores the missing check.** It is not a policy but a **claim about the
  owning tool's schema** — "this site cannot be reached under MCP because a required field blocks the
  path" — and a claim about a schema is checkable against the catalog. §0.9 already makes that claim for
  10 of the 23 sites, and **S3 says those claims are true only contingently.** So `'unreachable'` makes
  S3 enforceable rather than advisory: the day someone relaxes `release-create`'s `releases` to
  `.optional()`, six claims become false and **G8 says so**. It also shrinks the mechanical-fill risk,
  because for the largest group of sites the lazy answer (`'refuse'`) is no longer indistinguishable
  from the correct one.
- **Two checks, side by side, not one subsuming the other.** **G6** is description↔policy (a `.describe()`
  promising a non-interactive value must not be `'refuse'`) — the check that would have caught
  `worktrees-add`. **G8** is schema↔`'unreachable'`. Neither implies the other: `worktrees-add` has a
  promise and no blocking field; `release-create` has a blocking field and no promise.
- **Signature:** the second parameter widens to `PromptContext & { whenHeadless?: HeadlessPolicy }`, so
  all six `{ output: process.stderr }` callers are valid unchanged (§0.9).

`release-picker.ts` keeps its own `assertInteractive()` call, so the Ink path still refuses before the
dynamic import.

**Clause scope — `isMcpMode()` only.** Revision 1 specified this two incompatible ways (§2.2 said "all
three clauses survive extraction", §4 said "the `isMcpMode()` branch") and no row could tell them apart.
Resolved:

- **`isMcpMode()`** — the `whenHeadless` policy applies at all 23 sites.
- **`!process.stdin.isTTY`** — **stays in `release-picker.ts` only.** `release-picker.ts:33-34` argues
  that clause for *one Ink picker*; principle 5 says nothing about non-TTY, and extending it to 23 sites
  on the strength of a sentence about MCP reaches past what the justification covers.
- **`jsonOutput.enabled`** — **deferred to F-3.** It is a user-visible change at ~10 sites
  (`env-load.ts:264`, `release-create.ts` ×6, `worktrees-add.ts:146/163`, `release-desc-edit.ts:72`,
  `env-token-set.ts:62`, `confirm-or-exit.ts:58`), defensible on its own merits and not inside a PR
  described as a stream-safety prerequisite.

**PR-0b carries `worktrees-add`'s default** (as `whenHeadless: { value: false }`), so it cannot land
having converted a silently-broken tool into a visibly-broken one.

**And PR-0b must explicitly DELETE PR-0a's inline `isMcpMode() ? false : …` branch** at
`worktrees-add.ts:143-148` and `:160-165`. An inline branch and a `whenHeadless: { value: false }` are
simultaneously satisfiable — the leftover is redundant, not a type error, and nothing complains — so
revision 3's "superseded by" was only a comment. G0g asserts the resolution happens **through**
`whenHeadless` after PR-0b, which makes the deletion observable rather than aspirational.

### 2.4 PR-1 — relax the MCP schemas. Depends on PR-0b.

`narrowsArgs` iterates `Object.entries(before)` (`argument-form.ts:242-247`). A key **absent from round 1
may be freely added** by the form; a key present whose array length changes is refused in either
direction. So an array argument is form-fillable only if round 1 omits it — which requires it optional.

Relaxed to `.optional()`: `version`, `env`, `services` on the two gh tools, **and `env` on
`local-deploy-all`** (`local-deploy.ts:478`). Descriptions rewritten in the same PR; note the two
spellings — the gh tools say *"required when invoked via MCP"*, `sharedInput` says *"Required for MCP."*

> **PR-1's relaxation list, settled under Option H.** `version` + `env` + **`services`** on the two gh
> tools, and `env` on the local pair. **`services` does need relaxing** — the form supplies it, and
> `narrowsArgs` only permits a key the form adds if round 1 omitted it, which requires it optional.
> *(Revision 4 recommended dropping `services` from this list, on the grounds that no form offered it.
> Option H makes that recommendation wrong; it is reversed here.)* `local-deploy-selected`'s `env` is
> **free** — `sharedInput` (`local-deploy.ts:476-480`) is shared by both local tools, so the one-line
> relaxation already in PR-1's scope covers it. `service` (`:509-512`) stays required; relaxing it is
> F-7's job, not this PR's.

**This is an S3 change and must be reviewed as one.** Removing those required fields removes the only
thing making `pickEnv`'s and the services checkbox's TTY claims true. PR-0b is what makes it safe, and G6
is what proves the claims still hold afterwards.

**Ordering is a correctness property.** PR-1 before PR-0b means a non-elicitation client omits `env`, no
form is offered, the handler reaches `pickEnv`, and 54–60 bytes of prompt land on the protocol channel.
*Nothing mechanical enforces the merge order.* The critic proposed making PR-1 import
`assert-interactive.ts` so it cannot compile without PR-0b — **not adopted:** manufacturing an unused
import is a lie in the code about why a file is imported, and the next reader deletes it. The honest gate
is **E6 in PR-1's acceptance criteria, which fails without PR-0b**; beyond that it is human discipline,
labelled as such in R6.

**The residual.** After PR-1 a non-elicitation client omitting `env` gets round 1 → a gate whose
`resolvedArgs` has no `env`; round 2 → a clean `OperationError` before any dispatch. Nothing mutates, but
a human approved a gate with a hole in it. §2.6's body rule closes it.

### 2.5 The form's shape

```ts
createDeployFormProvider({ workflowFile, fields, toolName })
// fields: ('version' | 'env')[]
```

| Tool | `workflowFile` | `fields` |
|---|---|---|
| `gh-release-deploy-all` | `deploy-all.yml` | `['version','env']` |
| `gh-release-deploy-selected` | `deploy-selected-services.yml` | `['version','env']` |
| `local-deploy-all` | `deploy-all.yml` (`local-deploy.ts:30`) | `['env']` |
| `local-deploy-selected` | `deploy-all.yml` (`local-deploy.ts:30`) | `['env']` |

Two axes, not one — revision 1 claimed the workflow file was "the only axis", which is false: the two CI
tools read different workflows (§0.5) *and* the local pair offers no `version`. `toolName` is a parameter
because §5.6's log line names it.

**`isFormable(params)`** — true when at least one declared field is absent; false for a non-record. Only
meaningful after PR-1.

**`buildRequestedSchema(params)`:**

| Field | Offered when | Shape |
|---|---|---|
| `version` | in `fields` | `z.enum([...releaseLabels, 'dev']).optional()` |
| `env` | in `fields` | `z.enum(deployableEnvs(...)).optional()` |
| `services` | in `fields` **and absent from round 1** | `z.array(z.enum(availableServices)).optional()` |

**`availableServices` is the full declared set** — `parseServicesFromWorkflow()`, ungated. It is not
filtered by env, and it **cannot** be: the env is chosen in the same form (§1.3), and there is no such
thing as a per-option label to mark the gated ones (M3). What makes that safe is §2.5's execution-time
refusal, not the enum.

**`services` is offered only when round 1 omitted it.** If the agent supplied a list and the human picks
a different number, `narrowsArgs` discards the merge silently (`argument-form.ts:242-247`), the gate
shows the agent's list, and the human's selection vanishes. The conditionality is what prevents that; P4
asserts both directions.

**Four hard constraints, each failing silently if missed (§0.8):**

1. **`z.array(z.enum(...))`, never `z.array(z.string())`** (M2) — the throwing spelling is the exact type
   the tool's own `inputSchema` declares (`gh-release-deploy-selected.ts:258-259`), so it is what an
   author copies. `elicit()` throws before anything is sent and the failure is indistinguishable from a
   non-elicitation client. P10 is the AC.
2. **Explicit early `return null` when an offered field's candidate list is empty** — envs, releases, and
   `availableServices` (M4).
3. **Never `z.object({})` to mean "nothing to offer"** — it renders cleanly and would send a form with no
   fields.
4. **No `.default()`; every field `.optional()`** (RC §2.5a). Round-1 values go into `.describe()`.

**The `services` field's `.describe()` must carry the gate map**, derived from the workflow-scoped
`readWorkflowGates` so it cannot drift from the predicate — e.g. *"mobile: dev, prod only. docs-fe: dev
and personal envs only. Others: any environment."* This is the only marking the wire permits (M3), it is
read before the list rather than beside the row, and PM-D3 grades it accordingly. It is strictly more
than Option G would have shown the human, who saw no list at all.

**Service gating moves to execution time, where the env is actually known.** §0.11's defect is not merely
avoided by dropping the picker — the underlying tool still dispatches `mobile` to `stage` and reports
success. PR-D therefore also:

- extracts `workflow-gates.ts` to `src/lib/workflow-gates/` **exposing BOTH reads — the existing union
  and a new workflow-scoped one — and leaves `local-deploy` on the union.** This is a requirement, not a
  detail: `discoverServices` calls `readWorkflowGates(projectRoot)` at `service-discovery.ts:66` and
  intersects it with the script guard at `:83`, and its comment at `:63-65` states why the union is
  wanted — *"travelist gates `mobile` and `media` in the workflow but has no `skip_unless_env_enabled`
  in either script, so trusting the script alone would let `--all` include services CI refuses."* It
  asks "can this service deploy here at all from this machine"; the CI refusal asks "will *this*
  dispatch's job run". **Collapsing the module to one read silently narrows `local-deploy`, and no
  existing test would complain** — which is exactly why the requirement is in prose here and pinned by
  P13's second leg.

  **The union is demonstrably wrong for a single dispatch, not merely imprecise.** travelist's `media`
  inherits `['prod']` from `deploy-all.yml:59` — through the `uses: ./.github/workflows/_deploy-media-jobs.yml`
  form that `REUSABLE_WORKFLOW_PATTERN` (`:19`) catches — while `deploy-selected-services.yml` gates
  `media` not at all. Under the union, `media` + `dev` on `deploy-selected` would be **falsely refused**:
  a gate from a workflow that is not being dispatched, blocking a deploy the dispatched workflow allows.
- in `gh-release-deploy-selected`, intersects the requested services against that workflow's gates for
  `selectedEnv` **after** the env resolves and **before** `gh workflow run`, refusing with a named
  `OperationError` that lists which services the env excludes;
- keeps the module's best-effort contract (`workflow-gates.ts:34-36`): an unparseable gate yields **no**
  restriction, because inventing one would silently shrink what the user can deploy. So this closes the
  measured gates and does not pretend to close every possible one.

This is where the `mobile` + `stage` acceptance criterion binds and can fail (§5.2 P13).

**It is a trade, not a pure win, and §2.5 owes the statement.** Putting a text-derived gate set in front
of a dispatch converts an **unbounded, silent, fail-open** risk — a job skipped and reported as success,
with no signal anywhere — into a **bounded, loud, nameable, fail-closed** one: a deploy CI would have run,
refused by a gate the parser got wrong (R1c). That is the right direction, because a false refusal has a
workaround the human can take — fix the gate expression, or dispatch `gh workflow run` directly — and a
silent success has none. But it is a direction, not an elimination, and until this increment
`readWorkflowGates` never gated a dispatch at all: **the fail-closed direction is new, and this increment
is what introduces it.**

**Shared-environment marking — corrected against M3.** Per-option labels do not exist on the wire.
Considered: *(a) encode the kind in the enum **value** and strip it in `toArgs`* — **rejected**: it puts
a parse step on the path producing the argument the token is minted over (`tool-handler.ts:185`),
contradicts the merge contract, and shows the human `"stage (shared)"` while `resolvedArgs` shows
`stage`. *(c) widen the provider interface to the SDK's `TitledSingleSelectEnumSchema`
(`createMcpHandler-CLhGwQTn.d.mts:585-588`)* — **rejected on D3**, filed as F-4. **(b) field-level
`.describe()` naming both partitions — adopted**, derived from `isSharedEnv` so it cannot drift. It is
**weaker** than a per-row marker: read before the list, not beside the chosen row. §3 PM-D3 says so.

The `env` `.describe()` also carries the **drift escape hatch**: the enum is a working-tree read (§0.5),
and because the field is `.optional()` and `toArgs` merges, **leaving it blank keeps a round-1 value the
tree does not declare.** P11 asserts it.

**`toArgs`** merges field-by-field, never constructs, and introduces no key beyond round-1 keys ∪ declared
fields (P12). Plus: **an empty `services` selection returns `null`.** `narrowsArgs` cannot catch it — the
key is absent from `before`, so an auto-filled `services: []` would be accepted and reach the tool.
Returning `null` routes it through the existing validation-discard path (`formDiscarded: true`,
`tool-handler.ts:203`, plus `FORM_DISCARDED_CLAUSE`), making it a named outcome rather than a silent one.

**What the picker costs, stated plainly.** A human can pick `mobile` for `stage`, submit, and be refused
one round trip later — a UX cost, not a safety one, because nothing dispatches. Two things bound how
often that happens: the `.describe()` gate map above, and the fact that the same refusal exists whether
the list came from the human or the agent. **What it does not bound is the unparseable-gate path**
(§1.3 Option H, PM-D3): where the parser cannot read a gate it imposes none, the dispatch proceeds, and
the job is skipped silently — and under a picker the server rendered that option itself. That residue is
**R1**, and it is the honest price of the feature rather than an argument against it.

### 2.6 all-vs-selected discrimination — the form structurally cannot choose

`formProvider` is per-tool (`command-catalog.ts:57`, `types.ts:91`); `StopDeps.toolName` is bound at
registration (`tool-handler.ts:242`); round 2 re-enters the same tool (`:106-110`). §0.5 makes it worse
than impossible: the two tools' env domains differ, so a merged form's env dropdown would depend on a
field in its own form. **And this is a decision the codebase already recorded** —
`release-deploy.ts:29-33` states why the split was deliberately not merged behind a
`--services`-present-or-absent flag: it "would make the env picker's domain depend on that flag". Cited,
not re-derived.

The body instructs the agent, with a decidable rule and no silent default: services named → `-selected`;
"everything"/"all" → `-all`; **neither clear → ask in chat, once, before call 1**; **name the tool before
call 1**; **omit `version`/`env` so the human can choose them**; **omit `services` unless the human named
the exact services** — supplying a guessed list silently removes the picker (§2.5, R1); and **if round 1
returns a gate rather than a form, this client cannot render forms** — re-call with the arguments filled
in rather than confirming a gate with holes in it.

**And the body must carry the env gates as a stated fact** (§0.11): some services only deploy to some
environments — the workflow's input descriptions say which — a dispatch whose job is gated out is
**skipped, not failed**, and the tool returns `success: true` regardless because dispatch is
fire-and-forget. The agent must not read that success as "the service deployed". This is exactly the
"hard-won environment semantics" §4 says a `tools/list` entry cannot express, and it remains true even
with §2.5's execution-time refusal in place, because that refusal covers only gates the parser could read.

### 2.7 The prod boundary — body requirements

1. **The veto is real and enforced in the dispatching process**; an agent cannot disable it.
2. **Defeated by exactly two things:** `protectedEnvs: "allow"`, or a human running raw
   `gh workflow run`, which no infra-kit code mediates.
3. **GitHub Environment protection gates zero jobs today.**
4. **`gh-release-deliver` is registered but not exposed** — a reach limitation, not a guarantee.
5. **Only `prod` is protected. `stage` is shared and has no veto on either runner.**
6. **The dropdown's omission of `prod` is a picker default, not a boundary.**
7. **The enumerated env list is authoritative for neither the ref nor GitHub**; leaving the form's `env`
   blank preserves a round-1 value the tree does not declare.
8. **The local runner has BOTH refusals, and they are orthogonal** — `preflight.ts:141` applies the same
   `protectedEnvs` policy veto as CI, **before** `assertCleanTreeForSharedEnv` at `:150` adds the
   dirty-tree refusal. **It is the stricter runner, not the looser.**

### 2.8 The command file

`plugins/infra-kit/commands/release-deploy.md` — 9 lines, the shape U14 pins:

```markdown
---
name: release-deploy
description: Deploy an existing release to an environment, in CI or from this machine, through the infra-kit MCP server.
argument-hint: [<version|name|dev>] [<env>] [--from ci|local] [--services <name...>]
---

Read the MCP resource `infra-kit://workflow/release-deploy` and follow it exactly, treating $ARGUMENTS as the release, environment and services the user asked for.
If that resource cannot be read — this session may expose no resource tools, or the server may predate it: it needs infra-kit <FLOOR> or newer — call the `mcp__infra-kit__gh-release-deploy-all` or `mcp__infra-kit__gh-release-deploy-selected` tool directly and let its confirm gate drive the rest.
If the infra-kit MCP server is not connected in this session, say so and stop — do not improvise with git, gh or the deploy scripts.
```

Both flags are real Commander options (`program.ts:180`, `:213`), so unlike `release-create`'s this hint
is not red on arrival.

### 2.9 The `argument-hint` guard

Every `--flag` in a command's `argument-hint` must occur literally in that command's workflow body
(`apps/infra-kit/cli/resources/workflow/<stem>.md`). **Red on `main` today:** `release-create.md:4`
carries `--hotfix`/`--desc`; the only `--flag` token in its body is `--ff-only`.

**The guard proves occurrence, not definition** (R5) — a body containing `--from` in any sentence passes.
Fair for a plain-node guard, stated so nobody reads it as proving the flag is documented.

**PR-A must add `apps/infra-kit/cli/resources/workflow/**` to `plugin-ci.yml`'s `paths:` filter**
(`:5-17`). Without it, a PR deleting `--hotfix` from the body and touching nothing under `plugins/` never
runs the guard — fail-open in exactly §0.3's mutation direction. **T1b half two is generalized** to a loop
over `EXPECTED_COMMANDS`.

### 2.10 Registration

A per-key metadata record beside `WORKFLOW_BODIES`, iterated on both channels. Counts move
(`prompts/list` 1 → 2, `resources/list` +1); every count assertion derives from the declared sets, **no
literals**. `argsSchema` stays omitted on both prompts.

---

## 3. Pre-mortem — three scenarios, one authorization (§6.0b)

### PM-D1 (AUTHORIZATION) — the value nobody chose is minted into the token and executed

A consumer runs a client configured `elicitation: { form: { applyDefaults: true } }` — **sanctioned
configuration** (§0.13). The agent calls `gh-release-deploy-selected` omitting `env`, exactly as the body
instructs. The form is emitted. The client fills it from defaults **without rendering anything to a
person**, returns `action:'accept'`, and:

- `env` becomes the **first row of the enum** — ordered by whoever wrote the consumer's workflow YAML;
- `toArgs` merges it, and `narrowsArgs` permits it: scalar substitution is "the feature";
- `buildConfirmGate` (`tool-handler.ts:177-200`) mints the token over the **merged** value;
- round 2 verifies, and the deploy runs.

**Nothing failed.** The form was offered per the protocol. `narrowsArgs` permitted exactly what it is
specified to permit. The token bound exactly what was collected. `assertDeployable` correctly did not
fire — the value is `dev` or `stage`, not `prod`. Every log line says success and every §5 row is green,
because each asks whether the mechanism *ran*.

**This is materially new damage, not PM-0 restated.** Before this increment, `env` is whatever the *agent*
composed and a human reads it in the gate payload beside the tool name. After it, an argument **neither
the agent nor any human selected** — an artifact of enum ordering — is merged over the agent's value,
signed, and executed. *We moved the decision off the agent and onto a client that may have nobody behind
it.*

**What no assertion can tell:** whether a person was on the other end. The SDK's presentation language is
a SHOULD; auto-fill is conforming. The server cannot know.

*Partially mitigated.* The auto-filled `services: []` half is closed by §2.5's `toArgs` → `null` rule, so
the degenerate "deploy nothing, report success" outcome becomes a named discard (P12). The `env` half is
**not** closed and cannot be by anything here. Consent still lives in the agent's transcript-visible second call plus the host's permission prompt,
exactly as today; what the increment adds is a new *source* for the value that prompt shows. *The lever
that would close it* — ordering the enum least-destructive-first so the default is a personal env — is
filed as F-6, not adopted, because it trades a deterministic list order for a safety heuristic and
deserves its own argument.

### PM-D2 (liveness) — the schema is relaxed before the guard lands

PR-1 merges, PR-0b does not. A non-elicitation client omits `env`; no form; state 3 gates; round 2
verifies and runs; `pickEnv` renders an inquirer `select` **into the JSON-RPC channel**.

*Revision 1 claimed this "does not reproduce under Claude Code alone: that client pipes stdio, so
`!process.stdin.isTTY` incidentally catches it." Measurably false, and the plan contradicted its own
§0.7 in saying it.* `withEscape:58`'s `!isTTY` branch also calls `run(context)`. Two independent fixtures
measure 54–60 bytes on **stdout**, 0 on stderr (§0.7). **Piping removes the TTY, not the write.**

**Three consequences.** The failure is **stream corruption — a parse error or a desynchronised session —
not a hang**, so the observable is bytes, cheap and deterministic (S2). The live defects corrupt the
stream under the most common client today. And the ordering is **testable**, which revision 1 doubted:
E6 asserts zero bytes on stdout with a non-empty env list, which can only pass for the right reason.

**A manual check that comes back green under Claude Code is not evidence of anything here** — the earlier
draft told the reader the opposite.

*Mitigated by:* PR-0a and PR-0b ahead of everything; E6 in PR-1's AC with its mutation **executed**; and
G0a's dual-flag fixture — with `isTTY: false`, deleting the `isMcpMode()` clause leaves `!isTTY` true and
the guard still refuses, so only a fixture setting **both** true can fail.

### PM-D3 (comprehension) — the dropdown flattens the distinction that decides blast radius

A human asks for "the release, on the QA environment" — **without naming it**. The agent omits `env`. The
form opens: `dev`, `stage`, `renana`, `oriana`. They pick `stage`, accept, approve, and QA's environment
is replaced mid-cycle.

**Nothing failed.** `assertDeployable` was right not to fire — `stage` is not protected, deliberately.
What no assertion asks is whether the person understood that one row is shared by the whole team and the
two below it belong to individuals. **And the form makes this worse than today:** today the agent
composes the string and the human reads it in a gate payload beside the tool name.

*Mitigation, honestly graded — a residue, not a closure.* **Per-option labels do not exist on the wire**
(M3), so revision 1's "requirement, not a polish item" was unbuildable. What remains is field-level
`.describe()` prose (§2.5b), read **before** the list rather than beside the chosen row, plus §2.7 clause
5 in the body. Against an auto-filling client it does nothing at all. F-4 is the repair if per-row marking
is later judged required.

*Credit where the codebase already helps:* on the discard path `resolveGateArgs` logs
`form discarded (narrowed)` (`tool-handler.ts:305`) and `buildConfirmGate` prepends
`FORM_DISCARDED_CLAUSE` (`:166-167`, `:186`) to the message the human approves. The scenario survives — an
agent may summarise the gate rather than quote it — but the existing mitigation is real.

---

## 4. Execution

**PR-0a — the three live defects. Standalone, ships immediately, ahead of this entire plan.** §2.2.
`LocalDeployArgs` accepts `confirmedCommand`; `worktrees-add`'s two sites resolve to `false` under
`isMcpMode()`; both behind extracted predicates. No dependency on anything else here.

**PR-0b — `withEscape`'s optional `whenHeadless` parameter (default `'refuse'`) + the 23-site sweep.**
§2.3. Two sites take `{ value: false }`, ten take `'unreachable'`, the rest inherit the default. Carries
`worktrees-add`'s default declaratively, superseding PR-0a's inline branches.

**PR-1 — relax the deploy schemas + rewrite the descriptions. Depends on PR-0b.** §2.4. An S3 change.

**PR-A — generalize the publish gate and the plugin guards. Order-free.** §2.9 + §0.2, including the
`plugin-ci.yml` `paths:` addition.

**PR-B — repair the `release-create` hint binding.** Per OQ-3.

**PR-C — the workflow body on both channels. Bumps and publishes the CLI.** §2.10.

**PR-D — the four form providers, plus the workflow-gates extraction. Depends on PR-1.** §2.5. First live
`formProvider`. Also extracts `workflow-gates.ts` to `src/lib/workflow-gates/` with a workflow-scoped
read, and adds the execution-time service-gate refusal to `gh-release-deploy-selected` (§0.11).

**PR-E — the plugin command file.** Blocked until PR-C's publish is on npm.

**Ordering:** PR-0a → everything. PR-0b → PR-1 → PR-D. PR-A before PR-E. PR-C **published** before PR-E
merges. §7.8's publish checklist applies to PR-C and PR-D.

---

## 5. Test plan

### 5.1 PR-0a / PR-0b — **every row asserts bytes on stdout, not error text (S2)**

**Every mutation in G0f, G0g and E6 must be EXECUTED, not merely described.** These three are the only
assertions standing between three live defects and a regression, and each guards a site whose fixture is
non-trivial — `local-deploy`'s call site must reach `:411`, past `discoverServices` (`:316`, which throws
at `:318-324` in this checkout, §0.5), `eligibleServices`, `runPreflight`'s AWS lookup and the `dryRun`
return. A fixture that is specified but never run against the reverted code is exactly the
specified-but-unrun shape that let revision 1's G0d ship as "red on `main` today" while being
unreachable. Running the revert once, per site, is the difference.

| # | Assertion | Mutation |
|---|---|---|
| **G0a** | Under `isMcpMode() === true` **with `process.stdin.isTTY === true`**, a `whenHeadless: 'refuse'` site writes **zero bytes to stdout** and throws a clean `OperationError`. | Delete the `isMcpMode()` check → 54–60 bytes appear. **Both flags must be true**; with `isTTY: false` the old `!isTTY` path would refuse anyway and the row stays green against the broken version. |
| **G0b** | A `whenHeadless: { value: false }` site under `isMcpMode()` writes **zero bytes to stdout** and **returns `false`** — it does not throw. | Change it to `'refuse'` → `worktrees-add` throws where its schema documents a default; the return-value assertion fails. This is the row the architect's blanket-throw would have failed. |
| **G0c** | Outside MCP, on a TTY → the callback **is** invoked. | Make the guard unconditional → every interactive CLI prompt dies. |
| **G0e** | **Non-TTY, outside MCP → the callback IS invoked** (`!isTTY` did not ride along). | Add `!isTTY` to the shared guard → red. The only case where §2.3's two candidate readings differ; revision 1 had no row for it. |
| **G0f** | *(PR-0a — **at the call site**, sited with `local-deploy`'s tests)* `local-deploy-all` driven under `isMcpMode()` with the deploy proceeding writes **zero bytes to stdout**, and every byte it writes parses as JSON-RPC. | **Revert only `LocalDeployArgs`'s `confirmedCommand`** → `confirmTarget` runs at `:411` and ~60 bytes appear (§0.7). *(Revision 3 tested an extracted `shouldSkipConfirm` predicate; a predicate test proves the predicate works and says nothing about whether `:411` calls it — so all three reverts stayed green. The predicate assertion may stay as a unit, but it is not the AC.)* |
| **G0g** | *(PR-0a — **at the call site**)* `worktrees-add` invoked under `isMcpMode()` with `versions` supplied and no config keys set writes **zero bytes to stdout**, resolves both flags to `false`, and every byte parses as JSON-RPC. **After PR-0b, the same holds with PR-0a's inline branch deleted** — i.e. the resolution comes through `whenHeadless`. **And a CLI run with `--yes` on a TTY still prompts.** | **Revert `worktrees-add.ts:146` alone → 54 bytes appear** (§0.7); revert `:163` alone → the cmux leg fails. Delete `whenHeadless` while also deleting the inline branch → red, which is what makes PR-0b's deletion observable. Key it on `confirmedCommand` → the `--yes` leg fails (`program.ts:109`, `worktrees-add.ts:130-131`). |
| **G8** | *(PR-0b)* Every site declaring `whenHeadless: 'unreachable'` is matched by a **required** field in the owning tool's MCP `inputSchema` that blocks the path. Ten sites make this claim today (§0.9). | Relax `release-create`'s `releases` to `.optional()` → six claims become false → red. **This is what makes S3 enforceable instead of advisory**, and it is the landmine PR-1 walks toward on a different tool. |
| **G6** | **Text-to-behaviour (S3).** For every exposed tool whose description or `.describe()` promises a non-interactive MCP value, the declared `whenHeadless` at the reachable site matches — in particular such a site must **not** be `'refuse'`. Five tools carry such a claim (`env-load.ts:532`, `release-desc-edit.ts:192`, `worktrees-add.ts:349`, `gh-release-deploy-all.ts:137`, `gh-release-deploy-selected.ts:246`). | Change `worktrees-add`'s site to `'refuse'` while leaving `:377`'s text saying `false` → red. **This is the check that would have caught `worktrees-add` before it shipped.** Sits beside G8, neither subsuming the other: `worktrees-add` has a promise and no blocking field; `release-create` has a blocking field and no promise. |
| **G7** | **AST sweep, sibling of the existing `src/lib/prompts/__tests__/every-inquirer-site-is-escapable.test.ts`:** every `@inquirer` call reachable from an `mcpExposed` command sits behind `withEscape` with an explicit `whenHeadless`, or its command's schema makes it unreachable. | Add a raw `@inquirer` call in a reachable command → red. This sweep would have caught all four §0.7 sites. *(**Not** enforced by `tsc` — the parameter is optional, so a missing declaration compiles and silently takes the `'refuse'` default. G7 is therefore the primary mechanism here, not a supplement to the type system: it catches both the raw-call bypass and the un-wrapped site.)* |

### 5.2 PR-D — `src/commands/release-deploy/__tests__/deploy-form.test.ts`

**Fixture seam:** `readWorkflowEnvOptions` resolves through `getProjectRoot()` (`workflow-envs.ts:31-34`
→ `git-utils.ts:143-147`, `git rev-parse --show-toplevel`) — not cwd-relative. P1–P12 need a
`getProjectRoot` seam or a chdir'd `git init` fixture; unstated, P2's "excludes `prod`" becomes
`[]`-vs-`[]`.

| # | Assertion | Mutation |
|---|---|---|
| **P1** | **Both legs, and (a) is PARAMETERIZED over every candidate list the provider reads** — empty envs, empty releases, **and empty `availableServices`** where the tool consumes it. Each → `null` **and** the `form options empty (<file>): <tool>` log line naming which list was empty. (b) A fixture *with* env choices → **non-null**, `env` enum options **equal** the declared list. | (a) Remove the early emptiness check for any one list → the provider returns a **non-null** schema containing `z.enum([])`, so the `=== null` leg reddens for that parameter. **Correction to revision 3, whose stated mechanism was wrong:** `z.enum([])` constructs fine and throws inside `inputRequired.elicit()`, caught at `argument-form.ts:162-170` — **not** at `trySchema`'s `:134-138`. So at the provider level the mutation yields non-null (directly red), and the null-by-the-wrong-route hazard M4 names lives one layer up, in `buildArgumentForm`, which is P10's territory. Revision 3 attributed the throw to the wrong catch and described a redness that would not have occurred. (b) Return `null` unconditionally. |
| **P2** | Env options exclude `prod` under default access, include it under `{allowed:true}` — asserted on the enum's option list. | Drop `deployableEnvs`. |
| **P3** | A release option carries **the literal Jira description text** for a fixture whose branch and Jira names differ. | Key the map by `pr.branch` → descriptions empty. **Assert `=== 'the fixture text'`;** `!== undefined` and `undefined` both pass the bug. |
| **P4** | `services` is in `gh-release-deploy-selected`'s shape **iff** absent from round 1 — both directions, each asserting `schema !== null` **first**. And **no other provider's shape contains `services`/`service` for any params**. | Offer it unconditionally → the present-case leg fails. Add it to any other provider → the absence leg fails. Without the non-null precondition an optional-chained `schema?.shape?.services` is `undefined` both ways. |
| **P4b** | The `services` enum equals the **full** declared set — it is **not** filtered by the round-1 `env`. | Filter it by env → red. This pins the union deliberately: a filtered enum would be built from an env the human is about to change (§1.3), and the round-2 rebuild reads round-1 params (`argument-form.ts:102-104`), so the filter would validate against the wrong env. |
| **P5** | The `env` field's **`.describe()`** contains both partitions, derived from `isSharedEnv`. | Hardcode the names, then use a fixture whose `isSharedEnv` disagrees. *(Revision 1's P5 asserted per-option labels, which M3 shows cannot exist.)* |
| **P6** | `toArgs` merges: a round-1 `{skipTerraform:true}` survives content mentioning only `env`. | `{...content}` construction. |
| **P7** | Both local providers' shapes have **no `version` key**; the two gh instances read **different workflow files**. | Drop the `fields` parameter → the local providers offer a `version` their tools do not declare. Hardcode the filename → the two CI env lists match. |
| **P8** | `isFormable` true iff ≥1 declared field is absent; false for a non-record. | `return true` always. |
| **P9** | No `.default()`; every field `.optional()`; validates synchronously. | Add `.default('dev')`; add `.refine(async …)`. |
| **P10** | **Every provider's schema is sendable** — `buildArgumentForm(provider, params, deadline) !== null` for each of the four, against a populated fixture, **including the services-bearing shape**. | **Change `services` to `z.array(z.string())`, the tool's own spelling (`gh-release-deploy-selected.ts:258-259`) → `elicit()` throws before anything is sent, `buildArgumentForm` returns `null`, red** (M2). Also: return a nested `z.object` from any provider → same. Revision 1 asserted only on the returned zod object, never on `elicit()` accepting it. |
| **P11** | An omitted `env` in accepted content leaves the round-1 `env` intact — the drift escape hatch. | Write `undefined` for untouched fields. |
| **P12** | `toArgs`'s output key set ⊆ round-1 keys ∪ declared fields, **and an empty `services` selection returns `null`**. | Introduce any other key → red. Return the merge for `services: []` → accepted, because the key is absent from `before` and `narrowsArgs` never inspects it (PM-D1's closed half). |
| **P13** | **`mobile` + `stage` is refused before dispatch, naming the excluded service; `mobile` + `dev` proceeds.** Fixture: a `deploy-selected-services.yml` whose `mobile` job carries `if: … (environment == 'dev' \|\| environment == 'prod')`. Also: the workflow-scoped read returns **only that file's** gate for a service two workflows gate differently. | Intersect against `parseServicesFromWorkflow()` alone → `mobile` + `stage` dispatches and the tool reports `success: true` (§0.11, red on `main` today given the fixture). Separately: use the un-scoped `readWorkflowGates` → the two-workflow leg fails, because `collectGates` unions across files (`:90-92`). |

### 5.3 Integration — `src/mcp/__tests__/server.test.ts`

| # | Assertion | Mutation |
|---|---|---|
| **I1** | **Partition `getExposedMcpTools()` and assert BOTH halves:** `filter(hasProvider)` equals the three-tool set, `filter(!hasProvider)` equals the rest. | Wire the provider on the generic path → both halves shift. *(Revision 1 asserted "the names equal the literal pair" — facts about hand-typed literals, which §6.0 forbids; a count catches an addition, the complement catches a move.)* |
| **I2** | `prompts/list` count equals the metadata record's length; `resources/list` contains the new URI. Derived, no literals. | Register the resource, forget the prompt. |
| **I3** | Both bodies byte-identical across channels. | Trim one channel. |
| **I4** | After PR-1, the three fields are optional in `tools/list` and **no** deploy tool description contains `required when invoked via MCP` **or** `Required for MCP.` | Leave either spelling unedited. |

### 5.4 E2E — `mcp-stdio.e2e.test.ts`, spawned child, built bundle

**Fixture, fully specified.** The provider resolves workflows through `git rev-parse --show-toplevel`, and
the e2e's spawns pass **no `cwd`** (`:67`, `:513`, `:1702`). So: **`mkdtemp` + `git init`**, carrying
`deploy-all.yml` and `deploy-selected-services.yml` with declared `environment` choices and boolean
service inputs, **with `cwd` set on the spawn**, plus a stub `gh` on `PATH` recording argv.

| # | Lane | Mutation |
|---|---|---|
| **E1** | **Positive, three legs.** `elicitation.form` client; call `gh-release-deploy-selected` **omitting `env` and `services`** → `input_required` whose `env` enum equals the fixture's declared envs minus `prod` and whose `services` enum equals the fixture's **full** boolean-input set minus `skip_terraform_deploy` → accept `{env:'stage', services:['a']}` → gate + token → round 2 → **stub `gh` recorded exactly one invocation with `-f environment=stage -f a=true`**. | Mint the token over round-1 args → `mismatch`. Also the only lane that fails if the SDK's down-conversion disappears (PM-6). |
| **E1b** | **The picker offers a gate-excluded service and the refusal catches it.** Same call; the form's `services` enum **does** contain `mobile`; accept `{env:'stage', services:['mobile']}` → refused before dispatch, naming `mobile`, and **stub `gh` recorded zero invocations**. | Drop §2.5's execution-time intersection → one invocation is recorded and the tool returns `success: true` (§0.11). **This lane is the whole justification for offering the union**: it asserts that the enum being permissive is safe *because* the refusal is not. Response shape alone cannot distinguish refused from refused-but-dispatched; the argv recording can. |
| **E2** | A url-only client (`{elicitation:{url:{}}}`) gets no form; `gh` recorded nothing. | Probe `caps?.elicitation` instead of `caps?.elicitation?.form`. |
| **E3** | Round 1 `env:'stage'`, round 2 `env:'prod'` + round-1 token → `confirmation_refused`/`mismatch`, `gh` recorded **zero**. | Skip the bind check. |
| **E4** | **In a repo with no deploy workflow — the one lane that legitimately runs at this repo root** — no form, gate, and the **distinct** `form options empty (<file>): <tool>` line. | Return `null` without logging. |
| **E5** | Decline → `status:'form_declined'`, **exactly one** `input_required` on the wire, `gh` recorded nothing. | Re-issue `inputRequired` on decline (the SDK's canonical example). |
| **E6** | **Stream safety, in the fixture repo where `envOptions` is NON-EMPTY, with `version` SUPPLIED.** Non-elicitation client omits `env` **only** → gate → round 2 → clean `OperationError`, and **the child wrote ZERO bytes to stdout that are not JSON-RPC frames**. | **Revert PR-0b — and the mutation must be EXECUTED, not described.** The un-guarded code writes ~54–60 bytes (§0.7) and the byte assertion fails. **Two fixture preconditions, both load-bearing, and omitting either restores the vacuity by a different door:** (i) a non-empty env list, or `pickEnv([])` throws at `env-picker.ts:25-31` before `withEscape` is consulted; (ii) **`version` must be supplied**, or `resolveDeployBranch` takes its interactive branch at `resolve-branch.ts:26` and throws *there* — through the already-guarded `pickReleaseBranch` — before the env guard is ever reached. Both are stated here rather than in the prerequisite prose so that a later "simplification" of the fixture reopens a named hole rather than a silent one. |

### 5.5 Plugin guards

| # | Assertion | Mutation |
|---|---|---|
| **G1** | `EXPECTED_COMMANDS` covers both files; U14's key set and 3-non-empty-body-lines hold. | Add a 4th line. |
| **G2** | `hintFlags ⊆ bodyFlags`, plus the non-vacuity check. | **Red on `main` today** for `release-create`. |
| **G3** | T1b half two, looped: every command names ≥1 `mcp__infra-kit__` tool. | Delete either fallback clause. |
| **G4** | **Over an extracted pure `collectViolations(commandFiles, publishedVersion, servedUris)`** — two violating fixture command files both appear. | Keep fail-fast → only the first. *(Seam named because the script hardcodes `COMMAND_FILE` `:30`, shells `pnpm view` `:125`, and spawns `pnpm dlx … mcp` with a 60 s timeout `:75-80` — none of which belongs in `manifest.test.mjs`. I/O stays in the script's tail; if the seam proves impossible the AC is dropped, not left standing untestable.)* |
| **G5** | `plugin-ci.yml`'s `paths:` includes `apps/infra-kit/cli/resources/workflow/**`. | Remove it → the "delete `--hotfix` from the body" mutation never triggers the job. |

**Four decisions the gate's generalization must make explicit:** `readFloor` currently calls `fail()` on a
missing regex (`:47-50`) — under report-all a floor-less command is a **violation, not a crash**; the N
commands must share **one** `resources/list` spawn or CI costs N × 60 s; divergent floors are each
compared against the single published version, and the script's prose must stop calling it "the floor";
plus G5's path filter.

### 5.6 Observability

- `Tool execution form options empty (<workflowFile>): <tool>` — new; **asserted by E4 and P1(a)**, which
  is what makes M4's swallowed-`TypeError` route distinguishable from a decision.
- `form discarded (narrowed)` (`tool-handler.ts:305`) — unreachable on **three** legs: the conditional
  offer keeps `services` absent from round 1 (P4), the round-2 rebuild sees the same `params` (R2), and
  `toArgs` introduces no key (P12). All three are needed; revision 1 credited the first alone.
- `form discarded (validation)` (`tool-handler.ts:299`) — **reachable**, and the one
  `argument-form.ts:120-128` predicts fires in practice: round 2 re-validates against a moved world, so an
  env deleted from the workflow YAML between the two rounds discards the human's pick onto the gate. R2.

### 5.7 Gate

Root `pnpm run qa` green, with the two known timing flakes (`lock.test`, `portless-driver.test`) re-run in
isolation before being called regressions. sonarjs cognitive-complexity ≤ 15;
`buildRequestedSchema` should extract its enumeration steps.

---

## 6. Stated residues

- **R1 — an unparseable env gate still skips silently, and under a picker the SERVER rendered the option.
  This is the PM-0 pattern, and it is stated here in PM-0's own terms rather than filed as a parser
  limitation.** `workflow-gates.ts:34-36` is best-effort by design and `ENV_EQUALS_PATTERN` (`:22`) reads
  only `inputs.environment == '<literal>'`; a gate written any other way — `contains(fromJSON(…),
  inputs.environment)`, a matrix condition, a composite — imposes no restriction, so the dispatch
  proceeds and the job is skipped with `success: true`.

  **Ask PM-0's question — not "did it work" but who was on the other end and what did the mechanism
  represent to them.** Every layer behaved to spec: the parser declined to invent a gate it could not
  read, exactly as its docblock says it must; the refusal did not fire because it had nothing to fire on;
  the dispatch succeeded because GitHub accepted it. **What no assertion asks is what the human was
  shown.** Under Option G the service list came from the agent and the human approved a string. Under
  Option H **the server rendered that service in a dropdown while the human was deploying to an
  environment that skips it** — an affirmative representation, by the party that knows the workflow, that
  this is a legitimate choice here. The outcome is identical; the standing behind it is not, and the
  difference is invisible to every test in §5 because each asks whether the refusal fired, and it
  correctly did not.

  **Bounded, not closed**, by the `.describe()` gate map (which a scanning human may skip — PM-D3's own
  grade) and by **F-8**. Accepted deliberately as the price of the feature.

  **Both R1 and R1c are latent, measured, with a stated scope.** Across both consumers there are **9 env
  comparisons, all at job level, all literal-equality chains** — zero `!=`, zero `contains`/`startsWith`,
  zero non-literal operands, no mixed operators. The reusable `_deploy-*-jobs.yml` files reference
  `inputs.environment` only inside `secrets[format(...)]` lookups. So every gate in existence today both
  parses and parses correctly. That turns "we think the gates parse" into a measurement with a boundary:
  **these are hazards about gates nobody has written yet, not about the ones that exist** — and R1c's
  shape (b) needs only one env comparison added to a step in an existing job to become active.

- **R1c — a gate the parser reads WRONGLY. It fails in the OPPOSITE direction to R1, this increment
  introduces it, and F-8's notice cannot catch it by construction.**

  **The mechanism is broader than the `if:` expression.** `collectGates` splits blocks on two-space-
  indented keys (`workflow-gates.ts:75`), so a "block" is an **entire job including its `steps:`** —
  steps are indented deeper and stay inside. `SCRIPT_NAME_PATTERN` matches `script_name:` anywhere in
  that block (`:76-77`), and `ENV_EQUALS_PATTERN` is `/g` over the whole of it (`:82`). Two shapes
  follow:
  - **(a) mixed operators** — `environment == 'dev' || (environment != 'prod' && …)` extracts `['dev']`
    and silently drops the negated arm, yielding a gate **narrower** than the real one;
  - **(b) an unrelated clause in the same block** — a step-level `if: ${{ inputs.environment == 'prod' }}`
    on a notification or cache step inside a service's job makes `collectGates` conclude the **service**
    is prod-only. The structure already exists in both consumers (`_deploy-media-jobs.yml:40`,
    `_deploy-serverless-jobs.yml:62`, both `if: failure()`); only the env comparison is missing, not the
    shape.

  **The directions are opposite, which is why this is not folded into R1.** An unreadable gate yields
  `envs.length === 0` → `continue` (`:88`) → no restriction → **fails OPEN**: it reproduces the
  pre-existing silent skip and changes nothing. A misread gate **fails CLOSED**: the refusal blocks a
  deploy CI would have run.

  **And the closed direction is new damage this increment introduces on the CI path.** Until now
  `readWorkflowGates` fed only `discoverServices` and never gated a workflow dispatch; §2.5 puts it in
  front of one. **Note also that the module's docblock (`:34-36`) states the safe direction as a design
  commitment** — *"a gate we cannot parse yields no restriction, because inventing one would silently
  shrink what the user can deploy"* — and the `/g` extraction can violate that commitment **without
  being unparseable**. That is the case the docblock does not cover, and it is a **fifth instance of
  S1**: a docblock stating an intent the code does not guarantee.

  **F-8(ii)'s notice cannot cover it, by construction** — a wrong parse looks exactly like a right one,
  so there is nothing to key on. Only F-8(i) closes R1c, and F-8(iii) covers it without understanding
  gates at all.
- **R1b — a guessing agent silently removes the picker.** An agent that supplies `services` gets a form
  with no services field: no notice, no log line. The only control is the §2.6 prose rule, read by the
  agent — P6's reader/timing mismatch. F-5 would close it.
- **R2 — the round-2 rebuild invariant is unstated and fails silently.** `readAcceptedArgs` rebuilds from
  the round-2 `params` (`tool-handler.ts:296` → `argument-form.ts:193`), which are round-1's arguments
  echoed back. If a future edit made `buildRequestedSchema` read anything else, zod would **strip** the
  unknown key at `acceptedContent` (`argument-form.ts:200`), `toArgs` would merge nothing, and the picks
  would vanish with **no discard log and no `formDiscarded` flag** — worse than anything §2.5 designs out.
- **R3 — the drift escape hatch is a property of `.optional()` + merge, not a designed affordance.**
- **R4 — field-level prose is weaker than a per-row marker**, and does nothing against auto-fill.
- **R5 — §2.9's guard proves occurrence, not definition.**
- **R6 — nothing mechanically enforces the PR merge order.** E6 in PR-1's AC is the test-level gate;
  beyond that, human discipline.

**Follow-ups.** *(F-1 is retired — `local-deploy-selected` is in scope for an `env` picker under Option
H; only its services picker remains deferred, as F-7.)* F-3 the
`jsonOutput.enabled` clause, argued and asserted on its own. F-4 widen `buildRequestedSchema` to the SDK's
titled enum variants. F-5 a gate-payload clause for "a form was available but you supplied every field".
F-6 order the env enum least-destructive-first. **F-7 `local-deploy-selected`'s services picker**,
conditioned on relaxing `service`'s `.min(1)` (`local-deploy.ts:509-512`) — deferred, not blocked, since
`assertServicesUsable` (`:352`) already refuses loudly there. **F-8 — close R1 and R1c, which need different things.** Three parts:
(i) **evaluate rather than match** — parse the `if:` expression instead of scanning it, so
`contains(fromJSON(…), inputs.environment)`, negations and composite conditions are *read*. **This is the
only part that closes R1c**, and it is the expensive one;
(ii) **make the unreadable case visible** — a "gate not understood" notice on the tool's result, so the
human is told the list was unverified rather than being shown an unmarked dropdown. Two limits, both
load-bearing and both easy to miss. **It is less free than it reads:** `collectGates` collapses "this job
has no `if:`" and "this job has an `if:` whose env comparisons I could not extract" into the *same*
fall-through at `:88` — and the docblock at `:71-72` says the first case must mean "all environments" —
so the notice needs a **third state in the return type**, not a log line bolted onto the existing one.
**And it cannot cover R1c by construction:** a wrong parse looks exactly like a right one, so there is
nothing to key on. Stated here rather than left implicit, because otherwise F-8(ii) reads as closing both
residues and it closes one;
(iii) **verify after dispatch** — poll the run and report which jobs were skipped, which is the only
thing that turns fire-and-forget success into truth, and the only part that covers **both** residues
without understanding the gates at all. Cheapest per unit of coverage if the polling cost is acceptable. *(A
gate-filtered rather than union services enum would need a second round trip, which today requires a new
`resolveGateState` state — the D3 chokepoint widening this increment forbids. Recorded so the union is
read as a bounded choice, not an oversight.)* Plus: amend
§4.1/§7.7 for the discharged deferral and §4.3 for §0.6's wording; correct `tool-handler.ts:455-458`'s
"would hang" to "would write onto the protocol channel"; consider promoting §2.9's binding into a general
guard.

---

## 7. ADR

**Title:** `release-deploy` ships as an MCP workflow body over four deploy tools, behind a standalone
live-defect fix and a type-enforced headless-behaviour contract, with env-bearing forms on all four and
service gating moved to execution time

**Status:** approved, and implemented except PR-C/PR-E (see the header)

**Decision.** Ship **PR-0a standalone and ahead of this plan** — two exposed tools corrupt the JSON-RPC
stream today and must not wait behind a publish cycle. Then give `withEscape` a **required
`whenHeadless`** parameter (`'refuse'` | `{value}`), so detection lives in one place, policy is per-site,
and each site can finally *record* what should happen headless — `'refuse'` by default, `{value}` where a
default is documented, `'unreachable'` where a required schema field blocks the path. Then relax the schemas
— an S3 change — then one body over all four deploy tools, then **env-bearing forms on all four** from a
factory parameterized by **workflow file and offered field set**, plus a **services multi-select on
`gh-release-deploy-selected` offering the full declared set**. The enum is deliberately **not** filtered
by env — the env is chosen in the same form — and what makes that safe is that service gating is enforced
at **execution time**, where the env is known, via a workflow-scoped extraction of `readWorkflowGates`.
A picker that can over-offer plus a refusal that cannot be bypassed beats a picker that does not exist:
the refusal round trip is present either way, and only the picker lets the human resolve it. Shared-environment marking is field-level prose, because per-option labels do not
exist on the wire. Generalize the publish gate to N commands with report-all semantics and a testable
seam, and bind every `argument-hint` flag to its body with the CI path filter that makes the binding
two-directional.

**Drivers.** (1) The environment question must leave the agent. (2) Blast radius. (3) Do not widen
chokepoint invariants in the increment that first runs any of this.

**Alternatives considered.** A blanket `assertInteractive()` inside `withEscape` (architect) — **rejected:
it breaks `worktrees-add`'s documented `false (MCP, no TTY)` default on the only ungated tool in the set,
where the break lands on a single call with no confirm round.** Per-site guards without any recorded
policy (revision 2's fallback) — **rejected: it would have missed both `worktrees-add` sites, and it
depends on an author remembering, which is how this defect class arises.** A **required** `whenHeadless`
(revision 3) — **rejected on its own terms**: it pins what the author typed rather than what is true, and
costs 23 edits against six real `base` callers for a guarantee it does not deliver. A two-spelling
`'refuse' | {value}` — rejected: it leaves the architect's objection standing, because a wrong `'refuse'`
is invisible at every layer; `'unreachable'` is what converts the largest group of sites into a checkable
claim. Keying `worktrees-add`'s
default on `confirmedCommand` (critic B6) — **rejected: `worktrees-add.ts:130-131` maps the CLI's `--yes`
onto that field, so it would stop `infra-kit worktrees add --yes` prompting on a TTY, breaking the
documented order in the CLI direction while fixing the MCP one.** Offering a services enum from
`parseServicesFromWorkflow()` (revision 3's choice) — **rejected on §0.11: it enumerates the inputs block,
which is not the artifact that decides, so it offers services the target env skips and the dispatch
reports success.** Intersecting that enum with the env gates — rejected: the env is chosen in the same
form, and all three sub-variants fail (union re-admits the defect; round-1 intersection is invalidated by
the round-2 rebuild reading round-1 params; offer-only-when-env-is-fixed makes the agent's guess decide
whether the human gets a picker). Two round trips — **structurally impossible**: `resolveGateState` has no
state that issues a second form, and adding one is the D3 widening this increment forbids. Option C —
rejected on §4.2 and the CLI's recorded merge. Option D — rejected on D1, retained as OQ-4's fallback.
Option F — rejected: it removes the env picker from the `-selected` path, which Option H does not, and
its one advantage (no array in any schema) is bought back under H by the conditional offer.
Relaxing `narrowsArgs` to permit array growth —
rejected; omitting the key in round 1 reaches the same outcome without touching the check. A tool-choosing
form field — impossible, cited to `release-deploy.ts:29-33`. Encoding shared/personal in the enum **value**
— rejected: a parse step on the authorization-critical path, and the human approves a different string
than they picked. Widening the provider interface to the SDK's titled enums — rejected on D3 (F-4).
Bundling `jsonOutput.enabled` into PR-0b — rejected (F-3). Manufacturing an unused import so PR-1 cannot
compile without PR-0b — rejected: a lie in the code about why a file is imported.

**Consequences.**

- **`whenHeadless`'s justification changed between revisions, and the change is recorded rather than
  smoothed over.** Revision 3 argued for a *required* parameter on the ground that it would make the
  23-site survey a compile-time obligation, and that `base?` was dead so the parameter was free. **Both
  premises were wrong** — `base?` has six callers (§0.9, a fact supplied to me and relied on without
  independent check, which is S1 applied to this plan's own process), and a required parameter pins only
  what the author typed, since a wrong `'refuse'` compiles and can never fail a test. The design survives
  as **optional, defaulting to `'refuse'`, with a third spelling `'unreachable'`**, on the argument that
  it makes the defect class representable and — via `'unreachable'` and G8 — makes S3 enforceable. Two
  edits, not 23.
- Because it is optional and widens `PromptContext` rather than adding a parameter, PR-0b's diff is
  **small**: two sites gain `whenHeadless`, ten declare `'unreachable'`, and the six `base` callers are
  untouched. Revision 3's "large diff, breadth is the point" no longer applies.
- The failure mode is **stream corruption, not a hang**, so every guard AC asserts bytes on stdout. The
  chokepoint's own comment (`tool-handler.ts:455-458`) says "hang" and is wrong; F-6's list includes
  correcting it.
- Relaxing the schema moves a class of refusal from schema validation to execution time; nothing mutates
  before it, but a human can approve a gate with a hole in it, closed only by a body rule.
- A form opens whenever the agent omits something, so **Decline is a frequent path and Decline is
  terminal.**
- **All four deploy tools open a picker, and one of them offers services — over-permissively, on
  purpose.** The enum shows every declared service and the execution-time refusal is what makes that
  safe.
- **Three process failures are recorded about this plan itself, and two of the three are the same shape.**
  The first: revision 3 asserted `withEscape`'s `base?` had "zero callers (grepped)" and built §2.3's
  original justification on it; a grep result is evidence of a search, not of a fact — **S1** turned
  inward. The third, found last: that same count reached revision 3 **through a reviewer**, was adopted
  because a reputable party asserted it, and was never independently measured until it was challenged.
  That is **S1 again, applied to a reviewer rather than to a docblock** — the rule already says *evidence
  of intent, never of behaviour*, and an assertion by a careful colleague is intent in exactly that
  sense. **No S5 is added**: inflating the list would obscure that all three docblock/grep/reviewer cases
  are one failure — a claim adopted because someone reputable stated it rather than because it was
  measured. The second: revision 4 added the execution-time gate refusal and, **in the same edit**,
  rejected the union services picker because "the union re-admits the defect" — a claim that edit had
  already invalidated. That is not S1; no prose was mistaken for behaviour. It is a **stale rejection
  after a mitigation lands**, and it earns its own rule, **S4**. Both are kept in place rather than
  edited away, because in each case the corrected reasoning is the argument.
- The residual is **R1**, and it is a PM-0-shaped one: the outcome is identical under either option, but
  under a picker **the server rendered the option**, which is an affirmative representation the
  agent-supplied path never makes. Bounded by the `.describe()` gate map and by F-8, not closed, and
  invisible to every §5 assertion because each asks whether the refusal fired and it correctly did not.
- PR-D grew: it now also extracts `workflow-gates.ts` and fixes a pre-existing dispatch defect. That is
  scope the increment did not originally own, taken because §0.11 makes it a correctness precondition for
  anything this plan says about `-selected`.
- The env dropdown is authoritative for neither the ref nor GitHub, and its omission of `prod` is a
  default, not a boundary.
- `stage` remains unprotected by design; the response here is prose, not a veto.
- Six residues stand (§6), including R2, which would fail more silently than anything this plan designs
  out.

---

## 8. OPEN QUESTIONS FOR THE USER

**OQ-1 — "which releases" (plural): a multi-select, or a full list to pick one from?**
Both CI tools take a single `version`. Picking N means N dispatches to the same environment, racing —
last one wins, non-deterministically — and needs a breaking schema change on both tools.
**Recommendation: single-select release.** I read the plural as "show me the whole list and let me pick",
which is what this does. If you meant several at once, the coherent shape is one release → several
environments; several releases → one environment is not coherent and I would push back.

**OQ-1b — you get the services picker, and here is exactly what it will and will not do. This is the one
place where I changed my mind twice, so I want the trade in front of you rather than settled quietly.**
Your services list has a wrinkle: the workflow declares the services in one place, but it gates them by
environment somewhere else, in each job's `if:` condition — `mobile` only runs for `dev`/`prod`, `docs-fe`
only for `dev` and personal envs. I cannot filter the dropdown by environment, because you choose the
environment in the same form. So **the dropdown shows every service**, and if you pick `mobile` while
deploying to `stage` you will get a clean refusal naming it — one wasted round trip — instead of the
current behaviour, which is that GitHub skips the job and the tool tells you it succeeded. The field's
description will list which services are restricted to which environments, which is the best the protocol
allows (there is no way to grey out individual rows). **The one thing this does not catch:** the gate
reader is a text matcher, so a gate written in an unusual style is invisible to it, and that service
would still be dispatched and skipped silently — same as today, except the dropdown offered it. Widening
the reader is a follow-up. I briefly proposed dropping the picker entirely to avoid all this; that was an
over-correction — it would not have saved you the refusal round trip, only taken away your ability to fix
it yourself.

**OQ-2 — should `release-deploy` cover the local (`--from local`) path?**
**Recommendation: yes in the body, and yes in the form for both local tools.** I had excluded
`local-deploy-all` on the ground that the local env list is "advisory" — a property the chosen option
shares, so that rejection was wrong. And `local-deploy-selected` was excluded because its service list
depends on the env picked in the same form; with no services field anywhere, that reason evaporates. So
this round the scope got **wider**, not narrower: all four deploy tools get an env picker.

**OQ-3 — `release-create`'s `argument-hint` names `--hotfix`/`--desc`, and the body never defines them.**
Cheaper than I first said: the body already documents the `type` and `description` **semantics**
(`resources/workflow/release-create.md:69`, `:78`); only the flag **spellings** are missing.
**Recommendation: keep your hint and add two lines** binding `--hotfix` → `type: "hotfix"` and
`--desc <text>` → `description`.

**OQ-4 — are you comfortable making `version`/`env`/`services` optional on the CI tools, and `env` on
`local-deploy-all`?**
Everything about the form depends on it: the chokepoint only lets a form supply an argument round 1
omitted. **Recommendation: yes, strictly after PR-0b** — and note this is now a recognised *class* of
change (S3), not a one-off: a required schema field is currently the only thing making four exposed tools'
"unreachable without a TTY" claims true. One correction to what I told you earlier: I said the ordering
inversion would not reproduce under Claude Code. The opposite is true — it writes 54–60 bytes of prompt
onto the protocol channel under exactly that client, so it is cheap to catch and a green manual check
under it means nothing. If you would rather not touch the schema, Option D stands and PR-0a/PR-0b still
ship.

**OQ-5 — `stage` has no protection at all. Leave it that way?**
`DEFAULT_PROTECTED_ENVS` is `['prod']` only, so `stage` — shared by the whole team — has no veto on either
runner. The form arguably makes this worse: a person picks a row from a list where nothing marks it as
shared, and per-option labels turn out not to exist on the wire, so the best available marking is prose
above the list a scanning human may skip. **Recommendation for this increment: field-level prose plus a
sentence in the body** — flagging that this is weaker than what I promised you two rounds ago, because I
promised something the SDK cannot render. Whether `stage` deserves a real confirmation tier is a policy
question I would rather put to you separately.

---

*Artifact status: **approved and implemented**. Landed in e9ea02d, 715b8a5, 6d48b3c, 98e101e.*

*What the implementation changed about this document's claims, recorded rather than quietly edited:*
*G8 fired for real when PR-1 relaxed the schemas, naming all five `'unreachable'` claims it falsified*
*— the tripwire §2.4 predicted. G0f's byte assertion turned out to be superseded by PR-0b's*
*`whenHeadless: 'refuse'` at that site, so the mutation now reddens the outcome leg instead; the*
*coverage is intact and the AC wording was wrong. And `readWorkflowGates` had to keep BOTH reads, which*
*§2.5 called a requirement and the union-read mutation proved by falsely refusing `media` + `dev`.*
