# Architect review — `docs/release-create-form-plan.md` rev 1

**Mode:** ralplan `--deliberate` · 2026-09-15 · reviewer read the plan and every load-bearing citation below; the zod claims in §5 were executed against the repo's zod 4.6.2, not reasoned about.

## 1. Steelman antithesis — Option D′, the read-only planner tool

If I had to ship the rival, it is not B (the plan kills B correctly: `z.enum([])` throws inside `elicit()` and the feature vanishes on the first release, `elicit-schema-measurements.md:23`). It is a sharper D than the plan argued against:

**D′ — `release-plan`: ungated, `readOnlyHint`, `formProvider` with the same three fields, and a HANDLER that resolves.** The chokepoint's `run-form` state (`tool-handler.ts:156`, `:429-456`) runs an ungated tool's handler with the MERGED arguments; a handler is `async`, so it may call `loadExistingVersions()` once and return `{ releases: [{ version: '1.64.0', type: 'regular' }] }`. The agent passes that array to `release-create` unchanged.

What D′ buys that A cannot, by construction:

1. **The gate binds the number, not the symbol.** Under A the token is minted over `version: "next"` (`confirm-token.ts:165`) and `next` is resolved at execution (`resolveReleaseEntries`, `next-version.ts:257-258`). The human approves a symbol whose value is whatever `origin` holds at confirm time; a colleague cutting `1.64.0` between gate and confirm silently makes the approved `next` into `1.65.0`. D′ signs `1.64.0`. The plan lists "the gate shows `next`" as a cosmetic con (§Options A, cons); it is a binding con.
2. **One network fetch, not three.** A runs `loadExistingVersions` in `buildRequestedSchema` on round 1, again on round 2 (`argument-form.ts:102-104`, `:193` — the provider cannot tell the rounds apart), and a third time in the handler's `ensureKnown` (`release-create.ts:388-393`) whenever `next` is used. D′ resolves once; `release-create` then sees an explicit version and `hasNextToken` is false (`:250`).
3. **Zero wire change on the gated tool.** No D19, no D20, no G8 flip, no six-site policy flip, no `isMcpMode` refusal in `collectEntries`, no `'unreachable'` claim going false. The whole §3.4–§3.6 vanishes. The price is one new `tools/list` entry, which the w1 differential treats the same way it treats any authored delta.
4. **The plan's own rejection of D does not discriminate.** "The human answers a form, then approves the same values at the gate — two dialogs for one decision" (§Options D) is exactly A's shape: form dialog, then gate dialog. Dialog count is identical. The remaining objection — "a tool an agent can call without the human ever typing `/infra-kit:release-create`" — protects a *mutation*; `release-plan` mutates nothing, and an agent cannot obtain a form answer without the human anyway (elicitation goes to the human, `tool-handler.ts:489-493`). `humanOnly` in `manifest.test.mjs:669-679` is about the skill's `disable-model-invocation`, not about which read-only tools exist.
5. **The hint becomes unnecessary.** The planner's result IS the number; the form needs no network at all, so `HINT_BUDGET_MS`, the three prose branches, R3/R4/R9 and pre-mortem 2 all disappear.

Honest cons of D′: the agent must chain two calls and the skill grows a step; a new tool means catalog default-deny rows, `title`/`annotations`, a manifest allowed-tools entry and a w1 delta of its own; and a NAME release resolves nothing, so the planner is a pass-through for half its inputs. And the user decision (§0) says the form is offered *by* `release-create` — D′ moves it.

**Why A still wins, stated honestly rather than by the plan's reasons:** the symbol-vs-number hazard in (1) is not introduced by A — `/infra-kit:release-create next` and `--release next` already bind the token over `next` today — so A inherits an existing property rather than creating one; the user decision fixes the form on the gated tool; and the cost of (2) is bounded by `HINT_BUDGET_MS` and degrades to a hint-less form, never to a lost form. The plan should say that, and should stop claiming the dialog-count argument against D.

## 2. Trade-offs resolved by fiat

**T1 — classify-only vs classify-and-validate in `toArgs` (§3.3 step 4).** Principle 1 says the form classifies "exactly as the CLI's `--release` flag is parsed (`parseReleaseSpec`)". `parseReleaseSpec` (`next-version.ts:155-199`) is *classification only*: semver or `next` → `version`, anything else → `name`, and `validateName` runs later in `resolveReleaseEntries`. The plan's `toArgs` instead calls `parseReleaseRef` (`release-id.ts:133-170`), which (a) *validates* the name and (b) accepts a superset grammar — `release/v1.2.3` and `refs/heads/release/foo` — that neither the skill's `$ARGUMENTS` rule nor the flag documents. Two consequences the plan does not weigh: a typo like `Checkout Redesign` lands on the `formDiscarded` gate whose `resolvedArgs` are `{}` and whose prose says only "failed validation or narrowed" (`tool-handler.ts:190-191`) — the human never learns *what* was wrong; whereas the same typo through the flag reaches `resolveOrExit` (`release-create.ts:50-72`) and gets the remediation "use a kebab-case name like "checkout-redesign" (lowercase, digits, single hyphens, not a reserved word)". **I would resolve it classify-only**: export one `classifyReleaseToken(token)` from `next-version.ts` (the `isNextToken || tryParse` branch at `:185` lifted out), have `parseReleaseSpec` and `toArgs` both call it, and let an invalid name reach the gate and be refused by `resolveOrExit` — nothing has mutated at that point (`collectEntries` runs before `assertBaseBranchSwitchable` and `confirmReleases`, `:394-419`), the refusal names the rule, and principle 1 becomes a shared function instead of two functions that agree by inspection. The CLI wizard validates at the prompt, but the wizard can re-ask and exit; the form can do neither, so "mirror the wizard" does not settle this.

**T2 — the hint on round 2.** `readAcceptedArgs` rebuilds the schema (`argument-form.ts:193`) and the provider cannot distinguish rounds, so every Accept costs up to `HINT_BUDGET_MS` of `ls-remote` + Jira before the gate appears, for a description string nobody will read (round 2 validates, it does not render). The plan's ADR calls this "accepted, same reasoning as `argument-form.ts:106-118`" — but that comment defends rebuilding the *validator*, which is load-bearing; the hint is not. Resolution: accept, because the alternative is a chokepoint change the scope forbids; but the ADR should say the round-2 hint is waste tolerated for scope, not a property. Note also that `withDeadline` abandons, it does not cancel: a timed-out `git ls-remote` child keeps running (`load-existing-versions.ts:42`, `execa` with no timeout/signal) — one orphan per timed-out round.

**T3 — untouched optional fields on the live wire.** `type` is `.optional()` and `toArgs` reads absence as `regular`. What Claude Code sends for an *untouched* optional select on Accept has never been observed: V0.1/V0.3 recorded declines only (`session-env-picker-v0.md:43-60`). If the host sends `type: ""`, `z.enum` rejects it, `acceptedContent` returns `undefined`, and the whole form is discarded (`argument-form.ts:200-205`) — the silent `null` principle 2 is about. The plan's §5.3 step 0 happens to exercise this (type `next`, leave `type` blank, Accept, expect `type: "regular"` in the gate) but does not name it as the check. Resolve by naming it (amendment 6).

## 3. Amendments

1. **§3.1 — fix the rationale, keep the move.** The reachability sweep is a static AST walk with a `seen` set (`mcp-reachable-prompt-sites.ts:170-175`); it never evaluates a module and is cycle-safe, so "a TDZ trap for the reachability sweep" is false. The real hazard is worse and at runtime: `release-create.ts` calls `createReleaseFormProvider()` inside the `defineMcpTool({...})` literal at module scope (`:450`). Any importer that enters through `release-form.ts` first — the new `release-form.test.ts` will — evaluates `release-create.ts` before `release-form.ts`'s body, and the call hits an uninitialised binding (ESM TDZ `ReferenceError`; under vite-node a `TypeError: … is not a function`). Rewrite the "why move" paragraph to that; delete the sweep sentence.

2. **§3.3 step 4 + §1 principle 1 — one classifier, shared.** Per T1: add `classifyReleaseToken` to `next-version.ts`, call it from `parseReleaseSpec` and `toArgs`; `toArgs` returns `null` only for a non-string or blank token. R5's rows for `'Checkout Redesign'`, `'dev'`, `'1.2'` become `{ name: … }` (refused later by `resolveOrExit` with the named remediation); add a `release-create-batch.test.ts` lane asserting that refusal's text for a form-shaped name. If the planner keeps `parseReleaseRef`, principle 1 must be reworded — today it cites a function the plan does not use.

3. **§3.3 `orNull` wrap — drop it or scope it to the hint.** `trySchema` already wraps the provider in `try/catch` + `withDeadline` (`argument-form.ts:129-139`), so a provider-level wrap changes no outcome on the MCP path; it only hides a programming error from a direct caller. Keep `withDeadline(computeHint())` (that IS the collapse to `null`) and let the zod construction throw — R2's `!== null` catches it either way.

4. **§3.9 `e-r1` round-2 assertion — assert on a defined object.** A handler throw is rethrown by the chokepoint (`tool-handler.ts:604-612`) and reaches the client as an `isError` result with no `structuredContent`; `expect(undefined).not.toMatchObject(…)` throws in vitest. Assert `result.structuredContent?.status` `not.toBe('confirmation_refused')` (and AC6 accordingly).

5. **§3.10 R7 — parse through the REGISTERED shape.** Round 2 is parsed by `z.object(withConfirmToken(tool.inputSchema))` (`src/mcp/tools/index.ts:46-48`, `:86-94`), not by `z.object(releaseCreateMcpTool.inputSchema)`. R7 should parse `{ ...m, confirm: true, confirmToken: 'x' }` through the registered shape and compare `stripGateKeys(parsed)` to `m` via `canonicalArgs` — the same two functions the verify path uses (`confirm-token.ts:194`). That makes R7 the wire's comparison, not an approximation of it.

6. **§5.3 step 0 — name the untouched-field check.** Add: Accept with `type` and `description` UNTOUCHED; the gate must show `type: "regular"` and no `description`; the child's stderr must NOT carry `Tool execution form discarded (validation)`. If it does, the host sends `""` for untouched fields and the schema needs `''` folded into the enum (unmeasured — measure it first) or `type` made required.

7. **§3.2 — `withDeadline` is already duplicated.** `src/lib/mcp-proxy/upstream.ts:224-238` has a `withDeadline` with the opposite contract (rejects on timeout). The extraction is still right; the sentence "a second 15-line copy … is the kind of drift the seam was built to avoid" should say *third*, and the new module's doc comment should name the proxy's rejecting variant so nobody "unifies" them.

8. **§3.4 `.optional()` ordering — delete the concern.** Both `z.array(…).min(1).describe(…).optional()` and `.optional().describe(…)` render `description` under `properties.releases` with `required` absent (executed, zod 4.6.2); only key order differs and `toEqual` ignores it. The sentence about a "misplaced description" reddening D20 describes a case that cannot occur.

9. **§Options D — replace the dialog-count argument.** Per §1(4): the honest reasons D loses are the user decision fixing the form on `release-create` and the symbol-vs-number hazard being pre-existing, not "two dialogs".

10. **§7 Consequences — state T2's cost plainly.** "Two extra network calls per round" should read: up to `HINT_BUDGET_MS` of latency before the dialog on round 1 and before the gate on round 2, and one abandoned `git ls-remote` child per timed-out round.

11. **§1 driver 2 — `z.string()` is not in the measured table.** `elicit-schema-measurements.md:17-26` measured enums, enum arrays, nested objects and empty enums; the bare string is named only in the SDK's *error message*. The plan's own rule ("in the measured table or pinned by a `!== null` test") is satisfied by R2, so say "pinned by R2", not "listed primitive".

12. **§0 / §3.11 line refs.** The skill's classification rule is `SKILL.md:106`, not `:108`; the fixture lives at `src/mcp/__tests__/helpers/env-picker-fixture.ts` (the plan omits the directory, and AC6's `git diff --stat -- …/fixtures/` therefore does not cover it — fine, but the executor should not go looking under `fixtures/`).

## 4. Principle audit (deliberate mode)

| Principle | Honoured by §3? | Where it bends |
|---|---|---|
| 1 One classification, both surfaces | **Partly.** `toArgs` uses `parseReleaseRef` (validating, accepts `release/…` refs), not the `parseReleaseSpec` rule the principle cites. The form therefore has a grammar the flag and the skill do not (superset on branch refs, stricter on names). | Amendment 2 |
| 2 A silent `null` is the enemy | **Honoured for the provider** (R2/e-r1 assert offered). **Bent for the human:** a `toArgs` `null` (typo, reserved word) is a discard with `{}` shown and no field named; and T3's untouched-enum case would be a discard no test can see. | Amendments 2, 6 |
| 3 Schema never depends on the network | **Honoured.** `withDeadline(computeHint(), 2_500)` under `FORM_DEADLINE_MS = 3_000`; the zod object is built regardless. AC8 pins the order of the constants. | — |
| 4 Merge is a fixed point of the tool's parse | **Honoured, and verified by execution** (§5a). Holds *only because* `toArgs` always emits `type` and omits blank `description` — exactly the two shapes that drift. R7 must parse through the registered shape to be the real check. | Amendment 5 |
| 5 `'unreachable'` ends here | **Honoured.** G8 reddens as described; the six sites go `'refuse'`, G7 still finds a written answer; `readPolicy` reading the comment on any policy (`:243`) justifies deleting the six `// MCP-unreachable:` lines. | — |

No §3 change contradicts a stated principle outright; principle 1 is the one the plan asserts and then does not implement.

## 5. Verified / refuted claims

| # | Claim | Evidence | Verdict |
|---|---|---|---|
| a | Token minted over `toArgs`'s raw output; round 2 arrives post-parse; fixed point needed | `tool-handler.ts:209-210` mints over `gateArgs.params` = `merged` from `readAcceptedArgs` (`:344`, `:360`, `:390`) with no tool-schema parse; round 2 params are SDK-parsed (`src/mcp/tools/index.ts:46-48`) before `resolveVerify` (`tool-handler.ts:459-462`); `verifyConfirmToken` compares `canonicalArgs(stripGateKeys(params))` (`confirm-token.ts:194`). Executed on zod 4.6.2: `{version:'1.2.3',type:'hotfix'}`, `{version:'next',type:'regular'}`, `{name:…,type,description:'x'}` are fixed points; `{version:'1.2.3'}` (no `type`) and `{…,description:''}` DRIFT. | **Verified**, including the two drift shapes the plan's `toArgs` rules exist to avoid |
| b | `narrowsArgs` permits adding an absent `releases` key | `argument-form.ts:237-251` iterates `Object.entries(before)` only; a key absent in `before` is never examined. Round-1 `{}` parses to `{}` with no `releases` key (executed). | **Verified** |
| c | G8 reddens when `releases` goes optional; what it checks | `headless-policy-guards.test.ts:191-209`: for each `'unreachable'` site with a named field, `requiredFields(tool)` (`:80-97`) does `z.object(inputSchema).safeParse({})` and collects issue paths; a successful parse yields an empty set → `broken` non-empty. `safeParse({})` succeeds once `releases` is optional (executed). Also `:146-158` reddens if the rows stay while sites flip to `'refuse'`. | **Verified** |
| d | `w1c-pre-d13` excludes release-create's prose | `mcp-stdio.e2e.test.ts:2237-2275`: exact eleven-path key set and per-string `/required (?:for MCP\|when invoked via MCP)/i`. Baseline `release-create` description carries "Confirmation is auto-skipped for MCP calls" and does not match that regex (executed against the fixture); `required` is `['releases']`; `releases` description is the "One or more releases to create…" literal. | **Verified** — D20 needs its own mechanism, as planned |
| e | Module cycle → TDZ trap for the reachability sweep | `mcp-reachable-prompt-sites.ts:162-185` is a worklist over a `seen` set; never evaluates modules. But `release-create.ts:450` calls `createReleaseFormProvider()` at module scope, so importing `release-form.ts` first (the new test) evaluates `release-create.ts` against an uninitialised binding. | **Refuted as stated; conclusion stands** for a stronger reason (amendment 1) |
| f | A form on a gated tool feeds the gate, never executes | `resolveGateState` `:133-141` (`form` needs `responses === undefined`), `:146` (`gate` on accept), `resolveForm` `:409-420` returns `stopWith(form)`; `buildGate` → `resolveGateArgs` → `buildConfirmGate` over merged (`:380-394`); `handler` is called only on `kind: 'run'` (`:591-593`). | **Verified** |
| g | Six `whenHeadless: 'unreachable'` at `:86/:106/:161/:179/:205/:216`, comments one line above | `release-create.ts` listing | **Verified** |
| h | `releases` `.min(1)` at `:497`, `type` default at `:472-476`, transform at `:487-495`, `ReleaseCreateArgs.releases` optional at `:35` | listing | **Verified** |
| i | `[]` cannot arrive over the wire | `safeParse({releases: []})` fails (executed) | **Verified** |
| j | `env-load.ts:266-271` refusal shape and `:290` `'refuse'`; `env-picker.ts:47-56` voice | listings | **Verified** |
| k | Catalog pins the provider set (`:744-750`, `:758`, `:771-775`) | `command-catalog.test.ts:736-778` | **Verified** |
| l | `release-create.test.ts:16` casts `inputSchema.releases` to `ZodArray` and reads `.element` | line 16 | **Verified** — breaks at module load after `.optional()` without `.unwrap()` |
| m | `FORM_DEADLINE_MS` comment already names the release provider (`:33-41`) | `argument-form.ts:35` | **Verified** |
| n | Fixture is `git init` with no origin; child env spreads `process.env`; deletes `INFRA_KIT_ENV_TOKEN` | `helpers/env-picker-fixture.ts:94`, `:112`, `:120` | **Verified** (path differs from the plan's) |
| o | `PROCEDURE_CLAUSES` survive §3.11 | `manifest.test.mjs:853-867`; none of the rewritten sentences is a listed literal | **Verified** |
| p | New description text does not match `PROMISE` | regex at `headless-policy-guards.test.ts:77` run against the proposed sentences | **Verified** |
| q | `loadExistingVersions` is `allSettled` over ls-remote + Jira (`:68-84`); Jira via `loadJiraConfigOptional` | `load-existing-versions.ts:41-49`, `:68-84` | **Verified**; on the fixture both sources fail fast → `[]` → "no prior versions" branch is deterministic |
| r | `.optional()` ordering affects the served `description` placement | executed both orderings | **Refuted** (amendment 8) |
| s | `git ls-remote` 1.65–1.88 s measured | not reproducible by a reviewer | **Unverified** (accepted as the planner's measurement) |

## 6. Verdict

**ARCHITECT: SOUND WITH AMENDMENTS**

Summary for the Critic:
- Option A is the right ship; the fixed-point claim (P4) is true and was executed, not argued — but only because `toArgs` always emits `type` and drops blank `description`; those two rules are load-bearing and R7 must parse through the REGISTERED shape (`withConfirmToken`) to be the real check.
- The plan does not implement its own principle 1: `toArgs` uses `parseReleaseRef` (validating, accepts `release/…` refs) where the principle cites `parseReleaseSpec` (classify-only). Recommend one shared classifier and letting invalid names reach `resolveOrExit`'s named remediation instead of a `{}` discard gate.
- §3.1's cycle rationale is wrong (the sweep is a cycle-safe AST walk) but the move is MORE necessary than stated: `createReleaseFormProvider()` runs at module scope in `release-create.ts:450`, so entering through `release-form.ts` first is a TDZ crash.
- D was rejected for a reason that applies equally to A (form + gate = two dialogs either way); the honest reasons are the user decision and that `next`-as-symbol in the gate is pre-existing. Say so.
- Untouched optional `type` on a live Accept is unmeasured; §5.3 step 0 must name that check and watch stderr for `form discarded (validation)`.
- Minor: `e-r1` round-2 assertion must not `toMatchObject` on an undefined `structuredContent`; a third `withDeadline` (rejecting) already exists in `mcp-proxy/upstream.ts`; `z.string()` is pinned by R2, not "in the measured table"; the `.optional()` ordering worry is a non-issue.

## Rev 2 re-review

Checked against the text of rev 2 (not the log), the code, and the Critic's C1–C15.

### Amendments — applied?

| Mine | Status in rev 2 | Note |
|---|---|---|
| A1 TDZ rationale | Applied (§3.1 last bullet) | Text matches the mechanism: `createReleaseFormProvider()` inside the `defineMcpTool` literal at `:450`; sweep sentence gone. `release-form.ts`'s import set (§3.3) has no route back to `commands/` — verified: nothing under `lib/version-utils`, `integrations/jira`, `lib/logger`, `lib/git-utils` or `types.ts` imports `src/commands`. No TDZ remains. |
| A2 shared classifier | Applied in the Critic's form (§1 P1, §3.1, §3.3 step 4, R5, AC3, AC7b) | See "new problems" — none found; `parseReleaseSpec` stays byte-identical. |
| A3 drop `orNull` | Applied (§3.3 step 1, step 4, R9) | |
| A4 `e-r1` round 2 | Applied in the Critic's form (stderr marks) | `Tool execution refused (` is `tool-handler.ts:464`; `Tool execution failed: release-create` is `:597-601`; both verified. Determinism holds: `loadJiraConfig` throws on any missing `JIRA_*` var (`api.ts:236-250`), the fixture deletes them (§3.9), and `assertManagementContext` runs before it (`release-create.ts:384`) — either throw produces the `failed` line. The case that would NOT produce it — both guards passing and `executeOne` swallowing a per-entry failure into `failedReleases` — is unreachable while the Jira vars are deleted, which is exactly why the fixture edit is load-bearing and is named so. |
| A5 R7 comparator | Applied in the Critic's form (R7, AC4) | `confirm` is in the tool's own shape (`:501-504`); `withConfirmToken` is module-private (`mcp/tools/index.ts:86`), so parsing through `z.object(releaseCreateMcpTool.inputSchema)` with `confirm: true` and comparing `canonicalArgs(stripGateKeys(parsed))` is the same comparison `confirm-token.ts:194` makes. Correct. |
| A6 untouched-field check | Applied in the Critic's modified form (`type` required; step 0 checks `description` only; pre-mortem 5) | Cost not stated in the plan: the wizard's select carries `default: 'regular'` (`:156`, `:174`); a required enum with no `.default()` cannot pre-select, so the human must click `regular` every time. Acceptable, one sentence in Option A's cons would make the parity claim exact. |
| A7 third `withDeadline` | Applied (§3.2) | |
| A8 ordering | Deleted (§3.4) | |
| A9 Option D reasons | Applied (§Options D, §7) | |
| A10 T2 cost | Applied (§7 Consequences, pre-mortem 2, follow-ups) | |
| A11 `z.string()` pinned by R2 | Applied (driver 2, Option A pros, R2) | |
| A12 line refs | Applied | |

Critic's C1–C15: each is reflected in the body text where the log says it is; C13's AC7 uses the real flag (`mcpMode.enabled`, `src/lib/mcp-mode/mcp-mode.ts:17-22` — verified, an exported mutable holder) and the batch test's existing `loadJiraConfig` + git-guard mocks (`release-create-batch.test.ts:17-28`, `:68-70` — verified).

### New problems introduced by rev 2?

1. **`classifyReleaseToken` lifted from `:185` — behaviour of `parseReleaseSpec` for existing callers.** The inline branch is `isNextToken(token) || tryParse(token) !== null` on an already-trimmed token, returning `{ version: token, type }` else `{ name: token, type }`, with `description` set afterwards (`next-version.ts:185-198`). A classifier returning `{ version: token } | { name: token }` and a `parseReleaseSpec` that spreads `{ ...id, type }` then sets `description` produces the same objects for every input, including the degenerate `:hotfix` (empty token → `{ name: '' }` → `validateName` "Release name is empty", as today). `tryParse` strips any `…release/` prefix (`stripBranchPrefix`, `:18-20`), so `release/v1.2.3` and `refs/heads/release/v1.2.3` classify as `version` (as typed) in BOTH callers — the form and the flag now agree by construction, which is what principle 1 asks. No existing test can move. **No problem.**
2. **`createReleaseFormProvider({ hintBudgetMs })` at module scope.** Still evaluated inside the `defineMcpTool` literal, but the provider module now imports only `zod`, `lib/logger`, `lib/deadline`, `lib/version-utils`, `types` — none of which reaches `commands/release-create`. No cycle, no TDZ. `lib/deadline` is new and leaf. **No problem.**
3. **R3 imports `FORM_DEADLINE_MS` from `lib/tool-handler/argument-form`** (to assert `HINT_BUDGET_MS < FORM_DEADLINE_MS`). Test-only; `release-form.ts` itself does not import `tool-handler`, so the catalog bundle guard (`command-catalog.ts:72`) is unaffected. **No problem.**
4. **`'NEXT'` passes through as typed (R5).** `resolveReleaseEntries` lowercases via `isNextToken` (`:98-100`, `:257`) and `hasNextToken` does too (`:279-282`), so `ensureKnown` fires and the token resolves. The gate shows `NEXT`. **No problem**, cosmetic only.
5. **The blank-token discard is the one human-triggered `{}` gate left** (§3.3 toArgs step 1). Principle 2 now says "unreachable by construction where possible" and the skill disambiguates on `formDiscarded` (§3.11). `.min(1)` on the string is unmeasured, so this is the honest residual; it is stated. **No problem.**
6. **Malformed-semver remediation** — `'1.2'` classifies as a name and is refused with *use a kebab-case name like "checkout-redesign"* (AC7b's text). For a human who meant a version, that message points the wrong way. Pre-existing on the flag path (`--release 1.2` gets the same text today), and the form's `release` description does show the expected shapes. Not a rev-2 defect; a one-line follow-up in §7 ("remediation could name both shapes") would be tidy.

### Principle consistency of the final §3

- P1 — now honoured by a shared function, not by two functions that agree by inspection; validation downstream (`resolveOrExit`) as stated. Option C's rejection reworded accordingly.
- P2 — provider side pinned by R2/e-r1; human side reduced to the blank token, which the skill handles by `formDiscarded`. Consistent.
- P3 — unchanged and honoured; the inner/outer timer ordering claim (`argument-form.ts:134-135`, argument evaluated before `withDeadline` arms) is correct.
- P4 — honoured under the wire's comparator; the two load-bearing rules (always `type`, never blank `description`) are now named in the principle itself.
- P5 — unchanged and honoured.

No §3 change contradicts a stated principle.

**ARCHITECT (rev 2): SOUND**

Paste-ready summary for the Critic:
- All twelve Architect amendments are in the body text, seven of them in the Critic's modified form; every C1–C15 revision I could check against code holds (`mcpMode.enabled` flag, stderr line literals at `tool-handler.ts:464` and `:597-601`, `confirm` in the tool shape, `withConfirmToken` private).
- `classifyReleaseToken` lifted from `next-version.ts:185` leaves `parseReleaseSpec` byte-identical for every input including the empty-token edge (`:hotfix`); `stripBranchPrefix` makes `release/…` classify the same on both surfaces — principle 1 is now structural.
- No module cycle after the move: `release-form.ts`'s imports never reach `commands/`; `createReleaseFormProvider({…})` at module scope is safe.
- `e-r1`'s round-2 determinism rests on the fixture deleting `JIRA_*` (so `loadJiraConfig` throws before `executeOne` could swallow a failure) — the plan names that dependency; keep it.
- One parity cost of `type` required is unstated: the wizard pre-selects `regular` (`:156`, `:174`); a required enum cannot. Non-blocking; one sentence in Option A's cons.
- Residuals correctly stated: blank token → `{}` discard gate (skill disambiguates on `formDiscarded`); `'1.2'` gets the kebab-case remediation (pre-existing flag behaviour; optional §7 follow-up).
