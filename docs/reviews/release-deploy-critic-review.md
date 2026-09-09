# Critic review — `docs/release-deploy-command-plan.md`

**Verdict: ITERATE**

Reviewed against `docs/infra-kit-slash-commands-plan.md` §1, §4.1–4.4, §5 PM-0, §6.0, §6.0b, §6.12, §7.4;
`docs/release-create-command-plan.md` §2.3b, §2.5a, §2.7a; and `docs/reviews/elicit-schema-measurements.md`.
Every factual claim below is cited to a file and line I read, or to a measurement I ran in this session.

The plan is strong where it is strongest in this repo's tradition: it does its own measurement pass (§0),
it corrects the governing doc twice (§0.1, §0.6) rather than inheriting stale claims, it front-loads the
one change that is dangerous to defer (PR-0), and it argues the ordering as a correctness property rather
than a preference. Three of its rejections (Option C, the `narrowsArgs` relaxation, the tool-choosing
form field) are rejected on true, cited properties and should stand unchanged.

It fails on five axes: one load-bearing pre-mortem claim is **measurably false** and three statements to
the user rest on it; one option is rejected on a property the chosen option shares; the single named
mitigation for the plan's only authorization scenario is **not implementable** against the measured SDK;
several acceptance criteria pass against a provider that returned `null` for the wrong reason; and the
live-defect class the plan discovered is **larger than the plan's own survey found**, in a way that turns
the plan's chosen fix site from a free win into a contract break on a tool it never analysed.

---

## Two measurements I ran, because each decides multiple sections

### M1 — a piped-stdio inquirer prompt writes to stdout. PM-D2 is false.

**Claim under test (PM-D2, §4 Consequences, OQ-4):** *"it does not reproduce under Claude Code alone: that
client pipes stdio, so `!process.stdin.isTTY` incidentally catches it."*

`withEscape` (`src/lib/prompts/escapable-context.ts:58`) reads:

```ts
if (isMcpMode() || !process.stdin.isTTY) return run(context)
```

**Both branches run the prompt.** `!isTTY` does not catch anything — it skips the Esc listener and calls
`run(context)` anyway. The plan says so correctly in §0.7 ("under MCP it **still runs the prompt**, merely
skipping the escape listener") and then contradicts itself in PM-D2.

`@inquirer/core`'s `create-prompt.js:54` is `output.pipe(context.output ?? process.stdout)`, and no call
site in this tree passes `output` (grepped `src/lib/prompts/*.ts`,
`src/lib/command-echo/confirm-or-exit.ts`, `src/commands/local-deploy/local-deploy.ts`,
`src/commands/worktrees-add/worktrees-add.ts`). Spawning `@inquirer/confirm` with
`stdio: ['pipe','pipe','pipe']` from inside `apps/infra-kit/cli`:

```
STDOUT_BYTES=60
STDOUT_SAMPLE="? Deploy 3 service(s) to stage from this machine? (y/N)[57G"
```

Sixty bytes of prompt text and an ANSI cursor-position escape, **on stdout**, under exactly Claude Code's
spawn shape. The message string is `confirmTarget`'s own (`local-deploy.ts:126-129`).

**Independently corroborated.** `docs/reviews/elicit-schema-measurements.md:55-73` records the same result
from a different fixture — stdin from `/dev/null`, stdout redirected to a file, `worktrees-add`'s GitHub
Desktop message, 54 bytes on stdout and 0 on stderr. Two fixtures, two message strings, same conclusion:
piping removes the TTY, not the write.

Consequences: PM-D2's severity framing is inverted; OQ-4 tells the user the opposite of what is true; the
live defects corrupt the stream under Claude Code **today**; and the ordering is testable after all,
provided E6 runs where `pickEnv` does not throw first (B5).

`release-picker.ts:22`'s comment "These prompts render to stderr" is about the Ink picker, not the
`@inquirer` prompts. Do not generalise it; M1 is the authority.

### M2 — the live-defect class is four sites across three tools, and one of them is ungated.

I independently verified the team lead's Fact 8 and then extended the survey. Results:

| Site | Tool(s) | Gated? | Blocked today by | Status |
|---|---|---|---|---|
| `confirmTarget` (`local-deploy.ts:126,131`, called `:411`) | `local-deploy-all`, `local-deploy-selected` | yes | nothing — reads `yes`, chokepoint injects `confirmedCommand` | **LIVE** |
| `confirm` GitHub Desktop (`worktrees-add.ts:145-148`) | `worktrees-add` | **no** | nothing | **LIVE** |
| `confirm` cmux (`worktrees-add.ts:160-164`) | `worktrees-add` | **no** | nothing | **LIVE** |
| `pickEnv` (`env-picker.ts:33`) | four deploy tools | — | `env` is `z.string()` (required) | latent |
| services checkbox (`gh-release-deploy-selected.ts:105`) | `gh-release-deploy-selected` | — | `services` required | latent |
| `pickServices` (`local-deploy.ts:101`) | `local-deploy-selected` | — | `service` required, `.min(1)` | latent |
| `select` config (`env-load.ts:264`) | `env-load` | — | `config` is `z.string()` (required) | latent |
| `promptDescription` (`release-desc-edit.ts:72`) | `release-desc-edit` | — | `version`/`description` required | latent |

`worktrees-add` carries **no** `requiresHumanConfirm` (`worktrees-add.ts:346-391` — grepped, absent), so it
executes on a single call with no confirm round. Both config keys are `.optional()` with no default
(`infra-kit-config.ts:97-98`).

Three details make this worse than a fourth instance of the same bug:

1. **It fires on the *documented correct* MCP invocation.** `pickReleaseBranches` at `:112` is
   `assertInteractive`-guarded and throws when `versions`/`all` are omitted — which is exactly what the
   schema tells an MCP caller to supply. Supply them, and execution walks past `:112`, past the correctly
   short-circuited `confirmOrExit(confirmedCommand, …)` at `:127`, into the two unguarded prompts at
   `:146` and `:163`. The happy path is the defect path.
2. **The tool's own schema documents the opposite.** `githubDesktop`'s `.describe()` says *"Resolution
   order: this flag → `worktrees.openInGithubDesktop` from infra-kit config → interactive prompt (CLI) /
   **false (MCP, no TTY)**"* (`:373-378`), and `cmux`'s says the same (`:379-384`); the tool description
   says the follow-up prompts *"are unreachable without a TTY"* (`:349`). None of it is implemented.
3. **The correct pattern is nineteen lines above the defect.** `confirmOrExit(confirmedCommand, …)` at
   `:127` short-circuits properly (`confirm-or-exit.ts:56-60`), as does `confirmDeploy`
   (`confirm-deploy.ts:27-29`). The same author, in the same function, guarded one prompt and not the
   next two. That is stronger evidence for §0.7's thesis — "the only guarded prompt is the one someone
   individually remembered" — than the plan's own example.

**The generalisation the plan is missing.** Four exposed tools carry the claim "unreachable without a
TTY" in their descriptions (`env-load.ts:532`, `release-desc-edit.ts:192`, `worktrees-add.ts:349`,
`gh-release-deploy-all.ts:137`, `gh-release-deploy-selected.ts:246`). On three of them the claim is
**accidentally true**, because a required schema field blocks the path — not because any mechanism
enforces it. On `worktrees-add` there is no required field to block it, so the claim is simply false.
**PR-1's entire purpose is to remove those required fields.** The plan treats this as this increment's
ordering note; it is a standing rule: *a `.optional()` relaxation on any exposed tool is a stream-safety
change, because a required field is currently the only thing making four tools' TTY claims true.*

---

## Rulings on the four questions raised mid-review

### R1 — Should PR-0a ship as its own change ahead of everything? **Yes. And yes, the plan's scoping creates a coupling that delays a fix.**

The *release-train* coupling is not real: §4 gives PR-0 no dependency, and the plan says it "ships alone
and is worth shipping alone". PR-E's wait on PR-C's npm publish and PR-A's red gate does not reach PR-0.

The *scoping* coupling is real, and the plan created it. PR-0 as written bundles four things of very
different risk: (a) extracting `assertInteractive()`; (b) putting it inside `withEscape`, changing
behaviour at 23 call sites across 13 files; (c) the `confirmTarget` field-name fix, two lines; (d) a
survey. Bundling (c) with (b) means a two-line fix to a shipped, stream-corrupting defect inherits the
review burden, the revert risk, and the regression surface of a repo-wide behavioural change. That is the
delay, and it exists independently of any release train.

**Split it.** With M2 in hand the split is clean, because all three live sites share one fix shape:

- **PR-0a — honour the injected flag at the three defect sites.** `confirmTarget` accepts
  `confirmedCommand` alongside `yes`; `worktrees-add.ts:146` and `:163` resolve to `false` when
  `confirmedCommand` is set, restoring the resolution order their own `.describe()` already documents.
  `tool-handler.ts:466` injects `confirmedCommand: true` **unconditionally**, on gated and ungated tools
  alike, so the flag is available at all three sites. Purely local, independently revertable, no shared
  mechanism touched. Ships immediately as a patch.
- **PR-0b — the blanket guard.** Extraction, `withEscape`, the survey, the ACs. Remains PR-1's
  prerequisite.

PR-0a is also the *correct* fix on its own merits at all three sites, not a stopgap: a hard refusal is
wrong for `worktrees-add`, which documents a default (see R2).

### R2 — Would the plan's ACs catch a regression of these sites? **Partly, and the gap is on the ungated tool.**

- G0a/G0b/G0c test `withEscape` itself, so they cover **any** caller for a regression *of the mechanism*.
  Good, and G0a's dual-flag fixture requirement is genuinely load-bearing: with `isTTY: false`, deleting
  the `isMcpMode()` clause leaves `!isTTY` true, the guard still refuses, and the assertion stays green.
  Keep that row exactly as written — it is the best-constructed AC in the plan.
- **G0d is scoped to `local-deploy-*` only.** No AC asserts that `worktrees-add` over MCP does not prompt,
  and none asserts its documented `false (MCP, no TTY)` resolution. So if §2.2's stated fallback is ever
  taken — "guard the four deploy-reachable sites individually and file the rest" — `worktrees-add` loses
  every protection while all ACs stay green. The fallback silently drops the only **ungated** affected
  tool, which is the most reachable one in the set. That is B16.
- There is a ready-made shape for the missing guard already in the tree:
  `src/lib/prompts/__tests__/every-inquirer-site-is-escapable.test.ts` AST-walks for `@inquirer` calls
  outside a `withEscape` callback. A sibling sweep — *every `@inquirer` site reachable from an
  `mcpExposed` command is behind a guard, or its command's schema makes it unreachable* — is
  implementable in the same style and would have caught all four M2 sites. The plan should specify it.

### R3 — Is "fixes sites the plan did not consider" a benefit or an unbounded-blast-radius risk? **Both, and `worktrees-add` is the proof of each.**

*Benefit, and it is a real argument for the blanket placement over the per-picker fallback:* the two
`worktrees-add` prompts are `withEscape` callers, so PR-0b fixes their stream corruption for free, on a
tool nobody was looking at. That is exactly the property §2.2 claims ("one edit covering every call site,
versus three copies that the next optional argument re-opens") and here it is demonstrated rather than
asserted. Keep the blanket placement.

*Risk, and it is not hypothetical:* after PR-0b, `worktrees-add` over MCP **throws** where its own schema
documents a default of `false`. The plan already identified this failure mode for `local-deploy` —
"it turns a silently-broken tool into a visibly-broken one, which is a regression in *appearance* that
must be fixed in the same change" — and fixed it in PR-0. It did not identify it here **because it never
analysed `worktrees-add`**, and `worktrees-add` is worse than the `local-deploy` case: ungated, so the
break lands on a single call with no confirm round to absorb it. PR-0b cannot land without the
`worktrees-add` default fix (which PR-0a supplies). That is B14.

**Ruling on the survey:** the mechanism is right; the process that scoped it is not adequate. §2.2 states
the survey as an intention — "the survey must be done, not assumed" — with **no gate, no named output
artifact, and no AC**. On this evidence that process missed one ungated exposed tool and two contract
breaks. Make the survey a deliverable: a table in PR-0b of all 23 sites × {exposed? gated? reachable
under MCP today? documented MCP behaviour? behaviour after the guard?}, with one AC row per
exposed-and-reachable site. Without that, "fixes sites the plan did not consider" means "changes
behaviour on tools nobody checked", and the sample of one says that produces a contract break.

### R4 — Is there a systematic problem of trusting asserted over measured behaviour? **Yes, and the ACs cannot catch that class at all.**

Four claims in this plan's vicinity, all false or non-discriminating, all in the same direction — the
assertion was more favourable than the reality:

| Claim | Source | Reality |
|---|---|---|
| "the local env list is advisory" is a discriminator | `local-deploy.ts:326-327` comment | `workflow-envs.ts:14-16` — the enumerator's own docblock, true of the CI tools identically (B2) |
| "option labels carry the environment's kind" | §2.4 design assertion | no per-option labels exist (`elicit-schema-measurements.md:48-53`) (B3) |
| "`!isTTY` incidentally catches it" | PM-D2, from `release-picker.ts:26-34` | measured false, M1 (B1) |
| "the prompts are unreachable without a TTY" | four tools' own `.describe()` text | false on `worktrees-add`; accidentally true elsewhere via required fields (M2) |

The plan's method is not the problem — §0 is a genuine measurement pass and is the best section in the
document. The problem is **coverage**: §0 measured seven things the author already suspected, and none of
the four above were among them. The rule to adopt is narrower and more useful than "measure more": *a
docblock or `.describe()` string is evidence of intent, never of behaviour, and may not be cited as a
discriminator between two options.* Every one of the four failures is an instance of citing prose as
mechanism.

**No AC anywhere in §5 binds a tool's documented behaviour to its actual behaviour.** §2.8's hint↔body
guard is the closest analogue in the entire document, and it is *text-to-text*, not text-to-behaviour. Add
one AC that does: for every exposed tool whose description or `.describe()` claims an MCP/no-TTY
behaviour, assert that behaviour over the wire. Four tools carry such a claim today and PR-1 invalidates
two more by construction. That is B17.

---

## Per-criterion report

### 1. Principle–option consistency — **fails on two of five principles**

| Principle | Applied consistently? |
|---|---|
| P1 — "the form narrows a visible choice; it never becomes the authorization" | Yes. §2.4's no-`.default()` rule, §4.4 Decision 2, and PM-D1's residue all hold the line. |
| P2 — "a guard that cannot fail on its own named mutation is a defect" | **No.** P5 names a mutation for a mitigation that cannot be built (B3). P1 and E6 are green for the wrong reason (B4, B5). |
| P3 — "enumerate from the artifact that decides — and say what the enumeration is not" | **No.** §0.5 establishes the CI env list is authoritative for neither the ref nor GitHub, then Option B is rejected because the *local* list is advisory (B2). |
| P4 — "state the boundary accurately in both directions" | Mostly. §0.6 is a genuine correction and §2.6 clauses 1–7 are accurate. Clause 8 understates the local runner (B9). |
| P5 — "a prompt is never correct under MCP" | Yes, and PR-0b follows from it directly — M2 strengthens it. But §2.2's fallback would abandon it on the one ungated tool (B16). |

The drivers do follow from the principles, and D3 ("the purchase is gated on a stream-safety
prerequisite") is a real derivation rather than post-hoc justification — §0.7's table produces it, and M2
widens it.

### 2. Fair alternatives — **one rejection is on a false discriminator; the rest are fair**

- **Option B (form on all four tools) — rejected unfairly.** See B2 and Q6 below.
- **Option C (`-ci`/`-local` split)** — fair. `release-deploy.ts:20-33` does record the merge.
- **Option D (body only)** — fair, correctly retained as the OQ-4 fallback with PR-0 shipping regardless.
- **"Relax `narrowsArgs` to permit array growth"** — fair and well argued. `argument-form.ts:232-236`'s own
  docblock says what the plan quotes. Keep verbatim.
- **"A 'deploy everything?' field choosing the tool"** — fair, and correctly graded *impossible*.
  `command-catalog.ts:57` is per-tool, `src/mcp/tools/index.ts:53` forwards at the single registration
  site, `resolveStop` closes over `deps.toolName` (`tool-handler.ts:346-400`). Verified.
- **"Keep the schema required, substitute scalars only"** — fair. `narrowsArgs` iterates
  `Object.entries(before)` (`argument-form.ts:242`).
- **"Guard the three deploy-reachable pickers individually"** — the plan rejects this as primary and M2
  vindicates that: the blanket guard is the only version that reaches `worktrees-add`. But the *fallback*
  is now demonstrably unsafe and must be re-graded, not merely retained (B16).
- **"Repeating §4.3's prod wording"** — fair; §0.6 is the strongest section in the document.

### 3. Risk-mitigation clarity — **PM-D1's mitigation is not implementable; three others are underspecified**

PM-D1's *only* mitigation contradicts the measurement doc outright (B3). PM-D3's is sound as a mechanism
but has an unstated cost and an unhandled hole (B11, B12). PR-0's survey is an intention, not a mitigation
(B16). PM-D2's mitigation is correct on the G0a half and rests on a false premise on the other.

### 4. Testable acceptance criteria — **five vacuous or unimplementable, plus three missing**

Vacuous/unimplementable: B4 (P1), B5 (E6), B6 (no empty-services AC), B7 (G4), and N3 (P4's null guard).
Missing entirely: an AC for `worktrees-add` (B16), an AC binding documented MCP behaviour to actual
behaviour (B17), and an AC for the CLI's `--yes` surviving the `confirmTarget` fix (N7).

The rest of §5 is good: P3's "assert the literal Jira description text, not `!== undefined`" is exactly
the right lesson from `picker-descriptions-keyed-by-jira-name`; P7 genuinely falsifies the factory; E3's
"`gh` recorded **zero** invocations" is the right shape, because response shape alone cannot distinguish
refused from refused-but-ran; E5's decline mutation is the SDK's own canonical example and would redden.

### 5. Concrete verification steps — **adequate, with two gaps**

§5.4's named prerequisite (fixture consumer repo + stub `gh` recording argv) is the right call and is
honestly labelled "real work". §5.7 correctly carries the two known timing flakes and the sonarjs ceiling.
Gaps: no lane states how the provider's unit tests reach a fixture workflow at all —
`readWorkflowEnvOptions` resolves through `getProjectRoot()` (`workflow-envs.ts:31-34`), so P1–P8 need a
chdir or a seam (N4); and the survey has no verification step at all (B16).

### 6. Deliberate-mode floors — **count met; the authorization scenario is the wrong kind**

Three scenarios, one labelled AUTHORIZATION — but PM-D1 is a **comprehension** failure (B10). Test-plan
coverage spans unit, integration, e2e, plugin guards and observability; that floor is met.

---

## Answers to the six original questions

**Q1 — Is PR-0 → PR-1 stated as correctness, with the inversion named, and is it testable?**
Stated in three places (§2.3, §4, ADR Consequences 1) and named as PM-D2. **Testable: yes** — E6 is the
right lane and its mutation does redden it, *provided* it runs where `pickEnv` has a non-empty list (B5).
The plan's claim that the inversion is hard to catch is false (M1), making the ordering easier to enforce
than the plan believes. What is genuinely unenforced is the merge order: nothing mechanical stops PR-1
landing first. Cheap enforcement — make PR-1's diff import from `assert-interactive.ts` so it does not
compile without PR-0b. Say so, or label it a human-discipline constraint.

**Q2 — Is the live defect handled at the right priority?**
Placement is right (PR-0, first, "worth shipping alone") and G0d correctly asserts it is red on `main`
today. Four corrections. (a) Severity is understated by PM-D2's false claim (M1). (b) The described fix is
incomplete: `local-deploy-all`'s MCP `inputSchema` is `sharedInput` (`local-deploy.ts:477-481`), declaring
`env`, `dryRun`, `confirm` — **no `yes` field at all** — so "map it at the two MCP tool handlers" has
nothing to map; accepting `confirmedCommand` is the only workable half of §2.2's either/or. (c) The defect
class is 4 sites across 3 tools, not 1 site across 2 (M2). (d) The scoping couples a two-line fix to a
13-file behaviour change (R1). G0d is also mis-sited: `src/lib/prompts/__tests__/assert-interactive.test.ts`
cannot exercise `runLocalDeploy`'s destructuring.

**Q3 — Is the `services` conditional offer sound, and assertable in both directions without vacuity?**
Mechanism sound, P4's both-directions shape right. Three defects: it is vacuous if the fixture yields a
`null` schema and the test optional-chains (N3); an empty `availableServices` list makes
`z.array(z.enum([]))` throw and the whole form vanish silently (B6); and the conditionality has an
unstated cost — the human can never correct an agent's *wrong* service list (B12).

**Q4 — Does §2.8's `argument-hint` guard catch the real defect, and is it evaluable by `manifest.test.mjs`?**
Yes to both, with one wiring hole. Evaluable: `manifest.test.mjs` is plain `node --test` and
`apps/infra-kit/cli/resources/workflow/release-create.md` is a plain file in the same repo. Catches the
real defect: `plugins/infra-kit/commands/release-create.md:4` declares `[--hotfix] [--desc <text>]` and
the body contains neither, so the guard is red on `main` with no mutation. The non-vacuity check is the
right §6.0 anchor.

**The hole:** `plugin-ci.yml`'s `paths:` filter is `plugins/**`, `.claude-plugin/**`, the workflow file,
a fixtures dir, and two `scripts/*.mjs` (`plugin-ci.yml:5-17`). **`apps/infra-kit/cli/resources/workflow/**`
is not in it.** A PR deleting `--from` from the body and touching nothing under `plugins/` never runs the
guard. PR-A must extend the filter.

Separately, the predicate checks *occurrence*, not *definition* — a body mentioning `--from` in any
sentence passes. Fair for a plain-node guard; say it, so nobody later reads it as proving the flag is
documented (N8).

One thing the plan gets right: §2.7's claim that `--from` and `--services` are real Commander options is
**true** (`program.ts:180` `-f, --from <where>`; `program.ts:213` `-s, --services <services...>`), unlike
`release-create`'s. `release-deploy`'s hint will not be red on arrival.

**Q5 — Is the CI publish-gate generalization specified precisely enough?** **No.** See B7, B8. The
direction is right and §0.2's argument is correct — `fail()` is `process.exit(1)`
(`check-workflow-resource-published.mjs:34-37`) and the gate is red today, so a fail-fast generalization
would never reach the second command. Four implementation decisions are unstated.

**Q6 — Given fact 5, should the chosen option include `local-deploy-all`?** **Yes.** The plan's own §2.5
already contains the correct discriminator, and it *separates* the two local tools rather than grouping
them:

| Tool | Form? | True reason |
|---|---|---|
| `local-deploy-all` | **yes** | One env enum. `deployableEnvs(await readWorkflowEnvOptions(DEPLOY_ALL_WORKFLOW), protectedEnvAccess)` at `local-deploy.ts:328-329` — one filesystem read, zero network calls. The cheapest provider in the increment. |
| `local-deploy-selected` | **no** | Its candidates are `eligibleServices(services, selectedEnv)` (`local-deploy.ts:337`) — the domain **depends on the env chosen in the same form**. That is §2.5's own argument, and here it is true rather than asserted. |

Two costs to state if adopted: `local-deploy-all`'s `env` is `z.string()` (required) at
`local-deploy.ts:478`, so PR-1 must relax it too; and its description reads `'... Required for MCP.'`, not
`'required when invoked via MCP'`, so I4's literal widens.

---

## Blockers

### B1 — CRITICAL. PM-D2's central claim is measurably false, and three statements to the user depend on it.
Evidence M1: `escapable-context.ts:58` (both branches call `run(context)`); `@inquirer/core`
`create-prompt.js:54`; no `output:` at any call site; 60 measured bytes on **stdout** from a fully piped
child. PM-D2, §4 Consequences bullet 1, and OQ-4's recommendation all tell the reader the inversion is
invisible under Claude Code. Fix all three; the conclusion (PR-0 first) survives and gets stronger.

### B2 — CRITICAL. Option B is rejected on a property the chosen option shares.
`local-deploy.ts:328-329` is character-identical to `gh-release-deploy-all.ts:48-49`, and "ADVISORY ONLY"
is the **enumerator's own docblock** (`workflow-envs.ts:14-16`), applying identically to both. §0.5 says
so itself. The stated discriminator does not exist, and the rejection violates Principle 3. Replace it
with Q6's table and move `local-deploy-all` into the chosen option.

### B3 — CRITICAL. PM-D1's only mitigation is not implementable, and P5 asserts a thing that cannot exist.
`elicit-schema-measurements.md:48-53`: enum members are bare strings on the wire; `.describe()` is
field-level only. §2.4's "`stage — SHARED`" and P5 cannot be built as written. Either adopt value-encoding
plus strip-in-`toArgs` — and then handle its consequences (a parse failure returns `null` →
`formDiscarded` → the gate silently shows the agent's original env; a new AC is owed) — or drop to a
field-level `.describe()` and say plainly the marking is not per-row. Re-derive PM-D1's "only mitigation"
claim either way.

### B4 — CRITICAL. `worktrees-add` renders two prompts into the JSON-RPC stream on an UNGATED tool, and the plan never analysed it.
`worktrees-add.ts:145-148` and `:160-164`; no `requiresHumanConfirm` at `:346-391`; both config keys
`.optional()` with no default (`infra-kit-config.ts:97-98`). Fires on the *documented* MCP invocation
(supply `versions`, walk past the guarded picker at `:112` and the correctly short-circuited
`confirmOrExit` at `:127`). Its own `.describe()` promises `false (MCP, no TTY)` (`:373-384`) and the tool
description says the prompts are "unreachable without a TTY" (`:349`). §0.7's table and §2.2 must be
rewritten around four sites and three tools, not one site and two.

### B5 — HIGH. PR-0b's blanket guard breaks `worktrees-add`'s documented default; it must carry the fix.
After PR-0b, `worktrees-add` over MCP throws where its schema documents `false`. The plan already named
this failure mode for `local-deploy` ("a regression in *appearance* that must be fixed in the same
change") and fixed it there; it missed it here because `worktrees-add` was never analysed, and this case
is worse — ungated, so the break lands on a single call with no confirm round. PR-0b cannot land without
it.

### B6 — HIGH. Split PR-0. A two-line live-defect fix must not inherit a 13-file behaviour change's risk.
PR-0 bundles the `assertInteractive` extraction, the `withEscape` blanket guard across 23 sites in 13
files, the `confirmTarget` fix, and a survey. Split into **PR-0a** (honour `confirmedCommand` at the three
live sites — `confirmTarget`, `worktrees-add` ×2; `tool-handler.ts:466` injects it unconditionally, so it
is available at all three) shipping immediately as a patch, and **PR-0b** (the blanket guard) remaining
PR-1's prerequisite. PR-0a is also the correct fix on its merits, since a hard refusal is wrong where a
default is documented.

### B7 — HIGH. The 23-site survey is an intention with no gate, no artifact, and no AC.
§2.2 says "the survey must be done, not assumed" and stops there. On this evidence that process missed one
ungated exposed tool and two contract breaks. Make it a deliverable: a table of all 23 sites × {exposed?
gated? reachable under MCP today? documented MCP behaviour? behaviour after the guard?}, with one AC row
per exposed-and-reachable site.

### B8 — HIGH. No AC covers `worktrees-add`, and §2.2's fallback silently drops it.
G0a–G0c cover the mechanism, but G0d is scoped to `local-deploy-*`. If §2.2's fallback is taken — "guard
the four deploy-reachable sites individually" — the only ungated affected tool loses every protection with
all ACs green. Add per-site ACs, and extend
`src/lib/prompts/__tests__/every-inquirer-site-is-escapable.test.ts`'s AST-sweep shape with a sibling:
every `@inquirer` site reachable from an `mcpExposed` command is behind a guard, or its schema makes it
unreachable. That sweep would have caught all four M2 sites.

### B9 — HIGH. No AC binds a tool's documented MCP behaviour to its actual behaviour, and PR-1 invalidates four such claims.
Five description strings claim "unreachable without a TTY" (`env-load.ts:532`, `release-desc-edit.ts:192`,
`worktrees-add.ts:349`, `gh-release-deploy-all.ts:137`, `gh-release-deploy-selected.ts:246`). On three
tools the claim is true only because a required schema field blocks the path; PR-1 removes exactly those
fields. §2.8's hint↔body guard is the closest analogue in the document and it is text-to-text. Add a
text-to-behaviour AC, and record the standing rule: *a `.optional()` relaxation on any exposed tool is a
stream-safety change.*

### B10 — HIGH. P1 is vacuous: `null` is what the provider returns for every failure, including the wrong ones.
`ArgumentFormProvider.buildRequestedSchema`'s contract is "never throws … returns `null` when it cannot
offer real values" (`src/types.ts:44-56`). An internal bug, a swallowed `z.enum([])` `TypeError`, and a
genuinely-empty enumeration all produce `null`. `elicit-schema-measurements.md:34-39` names this exact
shape and §6.0 names it as the repo's recurring false green. Pair P1 with a positive leg: a fixture *with*
env choices returns a non-null schema whose `env` enum options **equal** the declared list.

### B11 — HIGH. E6 — the ordering test — passes vacuously at this repo root, for a reason §5.4 does not name.
`pickEnv([])` throws before reaching `withEscape` (`env-picker.ts:25-31`). At this root there is no
`deploy-all.yml` (`.github/workflows/` holds `plugin-ci.yml` and four `_`-prefixed files), so `envOptions`
is `[]`, nothing prompts, and E6 is green **with PR-0 reverted**. §5.4's prerequisite covers the form
lanes ("passes by never opening a form"); E6's failure mode is different and must be named. E6 must run in
the fixture repo, and its mutation must be *executed* (§6.0's mutation-adequacy rule).

### B12 — HIGH. An empty service list makes the whole form vanish silently, and no AC covers it.
`z.array(z.enum([]))` throws (`elicit-schema-measurements.md:24`), caught at `argument-form.ts:168-170`
and flattened to `null`. §2.4 returns `null` "when the env list or the release list is empty" —
**`availableServices` is not in that list.** A workflow with `environment` choices but no boolean service
inputs kills the *entire* form for `gh-release-deploy-selected`, env dropdown included, with no log line.
Reachable: `gh-release-deploy-selected.ts:88-94` throws for exactly that repo shape, but only in the
handler. Add the guard, its log line, and an AC.

### B13 — HIGH. G4 has no seam. The publish gate is a network script and cannot be tested where the plan puts it.
`check-workflow-resource-published.mjs` hardcodes `COMMAND_FILE` (`:30`), shells to `pnpm view` (`:125`),
and spawns `pnpm dlx infra-kit@<v> mcp` with a 60 s timeout (`:75-80`). G4 says "tested with two violating
fixture command files" — there is no commands-directory parameter, no registry injection point, and no way
to run it inside `manifest.test.mjs`. Export a pure
`collectViolations(commandFiles, publishedVersion, servedUris)` and test that, leaving I/O in the tail.

### B14 — HIGH. The publish-gate generalization is underspecified in four places, each changing the code.
1. **`readFloor` itself calls `fail()`** (`:47-50`) — a missing floor regex is currently fatal; under
   report-all it must accumulate, and a floor-less command must be a violation, not a crash.
2. **Spawn count.** `listPublishedResources` is one 60 s-bounded spawn per call (`:71-122`); N commands
   must share **one** spawn and one `resources/list`.
3. **Divergent floors** across commands — say how they compare, since "the floor" is singular throughout.
4. **The `paths:` filter** must gain `apps/infra-kit/cli/resources/workflow/**` (Q4).

### B15 — MEDIUM. §2.6 clause 8 understates the local runner's prod protection — the failure Principle 4 forbids.
Clause 8 ("a refusal about the **working tree**, not about authorization"), read beside clause 5 ("no veto
on either runner"), tells a reader the local runner has no authorization veto for prod. It does:
`src/commands/local-deploy/preflight.ts:141` calls `assertDeployable(env, …, protectedEnvAccess)`, reached
from `runPreflight` before `assertCleanTreeForSharedEnv` at `:150`. The local runner has **both**. Same
class of error §0.6 exists to correct, one clause later.

### B16 — MEDIUM. PM-D1 is a comprehension failure wearing an authorization label; the real scenario is a residue clause.
§6.0b's test is "whether the party it ran on behalf of was the one intended". In PM-D1 the intended party
was on the other end and picked what they picked — a real, worth-keeping UX failure, but not §6.0b's.

The genuine one sits unworked in PM-D1's own residue: **an `applyDefaults` client accepts the form without
rendering anything, and the auto-filled value reaches the gate as though a person chose it.** This is new
damage, not PM-0 restated. Before: `env` is whatever the agent composed and the human sees it in the gate.
After: a value **neither the agent nor any human selected** — the client's first enum row, ordered by
whoever wrote the consumer's workflow YAML — is merged by `toArgs`, minted into the token by
`buildConfirmGate` (`tool-handler.ts:177-200`), and executed. `narrowsArgs` permits it, the token binds
it, every log line says success. §0.13 is sanctioned configuration, so this is not hypothetical.

### B17 — MEDIUM. An auto-filled empty `services: []` passes `narrowsArgs` and the plan never handles it.
`narrowsArgs` iterates `Object.entries(before)` only (`argument-form.ts:242`). When round 1 **omits**
`services` — which §2.4 requires for the field to be offered — a form returning `services: []` adds a key
absent from `before`, so the loop never inspects it and the merge is accepted. Post-PR-0b it fails closed
(`gh-release-deploy-selected.ts:100-105` falls to the checkbox, which now refuses), so the outcome is a
refusal *after* the human filled in a form, with no explanation — avoidable. Require `toArgs` to drop an
empty `services`, or the schema to carry `.min(1)`, and assert it.

### B18 — MEDIUM. The conditional offer's cost is unstated: the human can never correct an agent's wrong service list.
For `gh-release-deploy-selected`, an agent that *guesses* `services` gets a form with no services field —
so the argument with the widest blast radius is the one the human cannot touch. §2.5's body rule ("omit
the arguments you intend the human to choose") puts that decision entirely in the agent's hands, which is
the decision D1 says must leave the agent. State the cost in §2.4 and the ADR Consequences; consider
instructing the agent to *always* omit `services`, which makes the field always offered and the cost
disappear.

---

## Notes (not blocking)

**N1 — PM-D3 overstates the current silence.** `resolveGateArgs` logs `form discarded (narrowed)`
(`tool-handler.ts:305`) and `buildConfirmGate` prepends `FORM_DISCARDED_CLAUSE`
(`tool-handler.ts:166-167, 186`) to the message the human approves. The scenario survives — an agent may
summarise rather than quote — but credit the existing mitigation.

**N2 — §5.6 declares the wrong discard line unreachable.** The other discard path —
`readAcceptedArgs` returning `null`, logged as `form discarded (validation)` (`tool-handler.ts:299`) —
remains reachable and is the one `argument-form.ts:120-128` predicts will fire in practice (round 2
re-validates against a moved world). Neither §5.6 nor any AC covers it.

**N3 — P4 must assert non-null before reading `.shape`.** With a `null` schema, an optional-chained
`schema?.shape?.services` is `undefined` in both directions.

**N4 — the provider unit tests have no stated fixture seam.** `readWorkflowEnvOptions` resolves via
`getProjectRoot()` (`workflow-envs.ts:31-34`); unstated, several ACs become `[]`-vs-`[]`.

**N5 — I1's complement half is unasserted.** Per §6.0's assertion-binding rule, partition the exposed set
and assert **both** halves. The count catches an addition; the complement catches a move.

**N6 — §5.6's new log line names a value the provider does not have.** `Tool execution form options empty
(<workflowFile>): <tool>` — the provider knows the file, not the tool. Pass the name into the factory or
drop it.

**N7 — G0d is mis-sited, and its converse is missing.** Move it beside `local-deploy`'s tests, and add:
the CLI's `--yes` still skips `confirmTarget` after the fix.

**N8 — §2.8's guard proves occurrence, not definition.** Fair for a plain-node guard; say it.

---

## What must change before this is approvable

1. Correct PM-D2, §4 Consequences bullet 1, and OQ-4 against M1 (B1).
2. Rewrite §0.7 and §2.2 around four sites and three tools, including the ungated one (B4).
3. Split PR-0 into PR-0a (three-site flag fix, ships immediately) and PR-0b (blanket guard); make PR-0b
   carry `worktrees-add`'s documented default (B5, B6).
4. Turn the survey into a deliverable with per-site ACs, and add the `mcpExposed` AST sweep (B7, B8).
5. Add the text-to-behaviour AC and the standing `.optional()`-is-a-stream-safety-change rule (B9).
6. Replace Option B's rejection with the true discriminator and move `local-deploy-all` in (B2, Q6).
7. Re-derive PM-D1's mitigation and rewrite P5 (B3).
8. Strengthen P1 (B10); pin E6 and E4 to the fixture repo with executed mutations (B11).
9. Add the empty-`availableServices` guard, log line and AC (B12).
10. Give the publish gate a seam and specify the four unstated decisions, including the `paths:` filter
    (B13, B14).
11. Fix §2.6 clause 8 to credit `preflight.ts:141` (B15).
12. Work the `applyDefaults` scenario as the §6.0b authorization pre-mortem, keeping PM-D1 as the
    comprehension scenario it is (B16).
13. Handle `services: []` and state the conditional offer's cost (B17, B18).

Everything else — §0.1, §0.2, §0.3, §0.5, §0.6, §2.3's `narrowsArgs` derivation, §2.5's structural
impossibility argument, §2.7, the choice of `withEscape` as the fix site (which M2 vindicates), the PR
decomposition's ordering constraints, and the ADR's rejected-alternatives list — should survive iteration
unchanged.
