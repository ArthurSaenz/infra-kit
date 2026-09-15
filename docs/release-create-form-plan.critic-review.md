# Critic review — `docs/release-create-form-plan.md` rev 1 + Architect review

**Mode:** ralplan `--deliberate` · 2026-09-15 · read both documents in full; every code fact below was re-read from the working tree, not taken from either document.

## 1. Per-criterion findings

### C1 — principle–option consistency

| # | Sev | Finding | Plan § | Code fact |
|---|---|---|---|---|
| 1.1 | **MAJOR** | Principle 1 names `parseReleaseSpec` as the rule; §3.3 step 4 implements `parseReleaseRef`. They differ in BOTH directions: `parseReleaseSpec` is classify-only (`isNextToken(token) \|\| tryParse(token) !== null` → version, else `{ name: token }` unvalidated — `validateName` runs later in `resolveNamedInput`), while `parseReleaseRef` validates the name and THROWS, and additionally parses `refs/heads/release/foo` → `{ name: 'foo' }` (`release-id.ts:135-146`), which the flag reads as the name `refs/heads/release/foo`. So rev 1's form has a grammar of its own — the exact defect §Options C is invalidated for. Architect T1 / amendment 2 is correct. One correction to the Architect: `release/v1.2.3` is NOT a superset case — the flag's `tryParse` strips `^.*release/` too (`next-version.ts:18-20`, comment at `:183-184`). | §1 P1, §3.3 step 4, §Options C | `next-version.ts:155-199`, `:22-29`, `:225-231`; `release-id.ts:133-170` |
| 1.2 | **MAJOR** | Principle 2 ("a silent null is the enemy") is honoured for the provider and bent for the human twice: (a) a `toArgs` `null` lands on a gate whose `resolvedArgs` are `{}` and whose only explanation is `FORM_DISCARDED_CLAUSE` — the field that was wrong is never named (`tool-handler.ts:190-191`); classify-only (1.1) shrinks this to blank-token only, and the invalid name then reaches `resolveOrExit`'s named remediation (`release-create.ts:50-72`) with nothing mutated (`collectEntries` precedes `assertBaseBranchSwitchable`/`confirmReleases`, `:394-419`). (b) An untouched optional `type` select: if the host sends `""`, `z.enum` rejects, `acceptedContent` returns `undefined`, `readAcceptedArgs` returns `null` (`argument-form.ts:198-205`) and the WHOLE accepted form is discarded — unmeasured (V0.1/V0.3 recorded declines only, `session-env-picker-v0.md:43-60`) and absent from the pre-mortem. See R4 for the fix I recommend (required `type`, not a measurement). | §1 P2, §3.3 step 3, §3.3 `toArgs` note, §4 | `argument-form.ts:187-212`; `tool-handler.ts:183-191`, `:344-350` |
| 1.3 | MINOR | Principle 4 is honoured and the Architect executed it. Two rules make it hold — always emit `type`, omit blank `description` — and the plan states both (§3.3 steps 2–3). But R7 compares with `toStrictEqual` where the wire compares `canonicalArgs(stripGateKeys(...))` (`confirm-token.ts:194`; `canonicalArgs` = `JSON.stringify(sortKeysDeep)`, `:78-80`). `toStrictEqual` is stricter than the wire (an explicit `description: undefined` key reds it while JSON drops it) — a false red an executor "fixes" by loosening the wrong side. | §1 P4, §3.10 R7 | `confirm-token.ts:78-80`, `:90-97`, `:194` |
| 1.4 | MINOR | Principle 3 honoured: the outer timer arms only after `provider.buildRequestedSchema(params)` has been called (`argument-form.ts:134-135` — argument evaluated first), so the inner 2 500 ms timer is armed strictly before the outer 3 000 ms one. The 500 ms headroom claim is correct. | §3.3 `HINT_BUDGET_MS` | `argument-form.ts:129-139` |
| 1.5 | MINOR | Principle 5 honoured. `readPolicy` extracts the field from `MCP-unreachable` comments regardless of policy (`mcp-reachable-prompt-sites.ts:228-249`), so deleting the six comments is required, not cosmetic; `whenHeadless: 'unreachable'` count is 6 today (`:86,:106,:161,:179,:205,:216`), so AC1's `grep -c` target of 6 for `'refuse'` is right. | §3.4, §3.6, AC1 | verified by grep |
| 1.6 | MINOR | §3.1's rationale is wrong twice and the move is still right. The sweep is a worklist over a `seen` set (`mcp-reachable-prompt-sites.ts:162-185`) — cycle-safe, never evaluates a module. And "benign at runtime" is false: `createReleaseFormProvider()` is called inside the `defineMcpTool({...})` literal at module scope (`release-create.ts:450`), so IF `release-form.ts` imported from `release-create.ts`, any importer entering through `release-form.ts` (the new test does) would evaluate `release-create.ts` against an uninitialised binding — a TDZ crash, not a benign cycle. Endorse Architect amendment 1 verbatim. | §3.1 | `release-create.ts:450`; sweep `:162-185` |

### C2 — fairness of alternatives

| # | Sev | Finding | Plan § |
|---|---|---|---|
| 2.1 | MINOR | **D — "two dialogs for one decision"** applies identically to A (form → gate). The remaining stated reason ("a tool an agent can call without the human typing `/infra-kit:release-create`") does not discriminate either: an agent can already call `gh-release-deploy-all {}` or `env-load {}` and raise a form on its own initiative; `humanOnly` (`manifest.test.mjs:669-679`) governs the skill's model-invocation, not which tools exist. Honest reasons D loses: the user decision (§0) fixes the form on `release-create`; `next`-as-symbol in the gate is pre-existing (`--release next` and `/infra-kit:release-create next` already mint over `next`); D adds a tool surface (catalog default-deny rows, `title`/`annotations`, manifest allowed-tools, its own w1 delta) and a two-call chain in the skill; and a NAME release makes the planner a pass-through. Endorse Architect amendment 9 with that expanded list. | §Options D |
| 2.2 | MINOR | **C** is invalidated by principle 1 — a reason that ALSO applies to A rev 1 (finding 1.1). After R1 it no longer does; until then the C rejection is not fair. | §Options C |
| 2.3 | — | **B** fairly invalidated: network-dependent schema (`argument-form.ts:120-128` names the drift discard) and `z.enum([])` throwing (`elicit-schema-measurements.md:23`) do not apply to A. **A′**, **E** fairly deferred/rejected. | §Options B, E, A′ |
| 2.4 | MINOR | Driver 2 says `z.string()` "is the listed primitive" — the measured table (`elicit-schema-measurements.md:17-26`) contains no bare `z.string()`; the word "string" appears only inside the SDK's TypeError text. Neither `z.string().optional()` nor `z.string().describe()` is measured. The plan's own rule is satisfied by R2 (`!== null` on `buildArgumentForm`); say that. Endorse Architect amendment 11. | §1 driver 2, §Options A pros |

### C3 — risk-mitigation clarity

| Scenario | Detection | Mitigation | Verdict |
|---|---|---|---|
| 1 mismatch on every round 2 | R7 + `e-r1` round 2 | `toArgs` emits `type`, drops blank `description` | ✓ but R7's comparator must be the wire's (1.3) and `e-r1`'s round-2 assertion is unrunnable as written (4.2) |
| 2 hint/form vanished on slow network | R3 injected timeout, R4 log line | `HINT_BUDGET_MS = 2_500` | ✓; add the Architect's orphan fact: `withDeadline` abandons, `$({quiet:true})\`git ls-remote …\`` has no timeout/signal (`load-existing-versions.ts:42`), one orphan child per timed-out round on a long-lived server |
| 3 tests "fixed" | AC1 + AC6 greps | §3.6/§3.9 DELETE-never-adjust | ✓ (AC6's `git diff --stat -- …/fixtures/` covers the baseline; the fixture HELPER lives in `helpers/`, which is fine — it is meant to change) |
| 3b unmeasured zod modifier | R2 `!== null` | §3.3 modifier ban | ✓ |
| 4 free-text field does not render | §5.3 step 0 | Option B fallback → plan revised | ✓ (the fallback violates principle 3; "revised, not shipped" is the right framing) |
| **missing** — untouched optional `type` sent as `""` | none | none | **MAJOR** — see 1.2(b); a discard on the ONLY live path, with the human's `release` thrown away |
| **missing** — TDZ crash if a future edit re-introduces the import | none named | §3.1 move | MINOR — the new test file entering through `release-form.ts` IS the detector; say so in §3.1 |

Deliberate-mode bar: 5 scenarios, each with detection + mitigation — met, with one MAJOR omission.

### C4 — testable acceptance criteria

| AC | Verdict | Note |
|---|---|---|
| AC1 | ✓ | greps + counts; current `'unreachable'` count 6 verified |
| AC2 | ✓ | unit, observable `.success` |
| AC3 | ✓ | `pnpm --filter infra-kit exec vitest run …; echo EXIT=$?` — package name is `infra-kit` (verified); `rtk` rule honoured |
| AC4 | MINOR | must say `canonicalArgs(stripGateKeys(parsed)) === canonicalArgs(m)` (1.3), not `toStrictEqual` |
| AC5 | ✓ | |
| AC6 | **MAJOR** | `not.toMatchObject({ status: 'confirmation_refused' })` on `result.structuredContent`: a handler throw is rethrown by the chokepoint (`tool-handler.ts:597-604`) and reaches the client as an `isError` result with NO `structuredContent`; `expect(undefined).not.toMatchObject(...)` throws. And `not.toBe('confirmation_refused')` alone is weak — it also passes on any unrelated `isError`. Stronger observable exists: from a stderr `mark` (the `e-l1` pattern, `:1061`), assert `Tool execution refused (` is ABSENT and `Tool execution failed: release-create` (`tool-handler.ts:598-601`) is PRESENT — that proves the token verified AND the handler was entered. On the fixture the handler must throw (`git init` repo; `loadJiraConfig` reads `process.env.JIRA_*` which §3.9 deletes), so the line is deterministic. |
| AC7 | MINOR | `isMcpMode()` is `mcpMode.enabled` (`mcp-mode.ts:18-23`); say `mcpMode.enabled = true` in `beforeEach`/reset in `afterEach` rather than "mocked". `release-create-batch.test.ts` already mocks `loadJiraConfig` + `assertManagementContext` (`:17-28`, `:68-70`), which the refusal path needs since both run BEFORE `collectEntries` (`release-create.ts:384-394`). It does NOT mock `@inquirer/select` today — the plan's "assert zero calls" needs a `vi.mock('@inquirer/select')` added; also assert `commandEcho.setInteractive` was not called (`:128`) — it is the wizard's first side effect. |
| AC8 | MINOR | `HINT_BUDGET_MS` must be EXPORTED for AC8 and INJECTABLE for R3 ("injected to 5 ms"); §3.3's signature `createReleaseFormProvider(): ArgumentFormProvider` admits neither. Give it `createReleaseFormProvider(options?: { hintBudgetMs?: number })` and export the constant. |
| AC9 | ✓ | `pnpm run test:claude` exists at root (`package.json:24`) |
| AC10 | ✓ | cold eslint + prettier named; vendor/manifest diff guard named |
| AC11 | ✓ | |

### C5 — concrete verification steps

Cold-runnable, with three gaps:
- §5.3 step 3 says the hint "shows both computed numbers for this repo's real `origin`" — this repo may have no `release/v*` branches, in which case the correct output is the REFUSED branch. Name a repo that has them (hulyo/travelist) or state both acceptable outcomes.
- §5.3 step 0 must include the untouched-field Accept (Architect amendment 6) — or, per R4, becomes moot for `type` and applies to `description` only.
- §3.9 `e-r1` on `connectLegacyFormClient` is the FIRST lane that drives accept → gate → confirm on a form-fed gated tool (today: `e-l1` runs an ungated handler, `e-d1m` stops at the form, `assertConfirmedCallExecutes` gates without a form). Say so; it is why its round-2 assertion has to be exact.

### C6 — deliberate mode

- Pre-mortem: 5 scenarios with detection + mitigation — passes the bar; one MAJOR omission (C3).
- Test plan: unit (§5.1) / integration-e2e (§5.2) / manual e2e (§5.3) / observability (§5.4) all present.
- Repo rules: no `process.exit` on the MCP path (§3.5 refusal precedes the wizard; the three `exit`s at `:93/:112/:121` stay behind `withEscape` sites that throw under MCP) ✓; no counter-style `for` introduced ✓; comments WHY-only (§3.3 constant comment carries the measurement; §3.4 one wizard comment in the `env-picker.ts:47-56` voice) ✓; form tests assert OFFERED (R2, `e-r1`) ✓; `; echo EXIT=$?` on every command AC ✓; lockstep publish order + `plugin.json` (0.7.10 today) + exact-version global refresh in §7/§5.3 ✓.

## 2. Architect amendments — verdicts

| # | Verdict | Why |
|---|---|---|
| 1 §3.1 rationale | **ENDORSE** | Verified (1.6). Add: the new test file is the detector. |
| 2 shared `classifyReleaseToken` | **ENDORSE, one correction** | Verified (1.1). Drop the `release/v1.2.3` example from the superset claim (the flag strips it too); `refs/heads/release/foo` is the real divergence. The classifier returns the token AS TYPED (`{ version: token }`, like `parseReleaseSpec:186`); `v1.63.3` is NOT normalised — R5's `'v1.63.3' → '1.63.3'` row becomes `→ { version: 'v1.63.3', type: 'regular' }` (`resolveReleaseEntries` normalises downstream, `:262-276`). `null` only for non-string or blank. |
| 3 drop provider-level `orNull` | **ENDORSE** | `trySchema` already wraps (`argument-form.ts:129-139`); a provider wrap hides a programming error from R2's direct call. Keep `withDeadline(computeHint(), …)` only. |
| 4 `e-r1` round-2 assertion | **MODIFY** | Right diagnosis, weak replacement. Use the stderr-mark assertion in AC6 above (refused-line absent, failed-line present). |
| 5 R7 through the registered shape | **MODIFY** | The comparator change (`canonicalArgs(stripGateKeys(...))`) is the load-bearing half — endorse. The `withConfirmToken` half is immaterial to `releases`: `z.object` strips an undeclared `confirmToken` and `stripGateKeys` removes a declared one, so both shapes yield the same canonical string; and `withConfirmToken` is module-private (`mcp/tools/index.ts:86-94`, `const`), so "must" would force an export for no assertion gain. Parse `{ ...m, confirm: true }` through `z.object(releaseCreateMcpTool.inputSchema)` (`confirm` IS in the tool's own shape) and compare canonically; leave `confirmToken` to D9/`e-r1`. |
| 6 name the untouched-field check | **MODIFY** | Measuring is the weaker fix. Make `type` REQUIRED (`z.enum(['regular','hotfix'])`, no `.optional()`): a required two-option select is the one shape rendered live (V0.3), it removes the `""` path instead of measuring it, and it is MORE faithful to the wizard (which asks `regular\|hotfix` explicitly, `:164-180`) — the "blank means regular" prose was the departure. The command-plan's no-`.default()` rule (`release-create-command-plan.md:963-974`) is untouched: required ≠ defaulted. `toArgs` still reads `content.type === 'hotfix' ? 'hotfix' : 'regular'` (total). Step 0 then checks untouched `description` only (`z.string().optional()` accepts `""`, `toArgs` folds it — safe either way). If the planner keeps `type` optional, then amendment 6 as written is mandatory AND the pre-mortem needs the scenario. |
| 7 third `withDeadline` | **ENDORSE** | `mcp-proxy/upstream.ts:224-238` rejects on timeout; name it in the new module's doc comment. |
| 8 `.optional()` ordering | **ENDORSE** | Executed by the Architect; delete the sentence. |
| 9 Options D reasons | **ENDORSE, expanded** | See 2.1. |
| 10 T2 cost in §7 | **ENDORSE** | Add the orphan `ls-remote` child. |
| 11 `z.string()` not measured | **ENDORSE** | See 2.4. |
| 12 line refs | **ENDORSE** | `SKILL.md:106` (verified: "The bare token → `version` when it is a semver or the literal `next`, `name` when it is kebab-case."); fixture at `src/mcp/__tests__/helpers/env-picker-fixture.ts:111-121`. |

Architect claims re-checked and confirmed: the D12 served-side loop iterates `D12_REQUIRED` (`mcp-stdio.e2e.test.ts:2395`), so one map entry covers both halves of D19; `w1c-pre-d12` expected map + its "five fields" title need the sixth entry; `loadJiraConfig` reads the five `JIRA_*` env vars §3.9 deletes (`jira/api.ts:237-240`) — the fixture hint branch is deterministic.

## 3. REQUIRED revisions for rev 2

1. **§1 P1 + §3.3 step 4 + §3.10 R5 + §5.1** — add `export const classifyReleaseToken = (token: string): { version: string } | { name: string }` to `next-version.ts` (the `:185` branch lifted out, `parseReleaseSpec` calls it); `toArgs` calls it after the trim and returns `null` only for a non-string or blank token. R5 rows: `'v1.63.3'` → `{ version: 'v1.63.3', type: 'regular' }`; `'Checkout Redesign'`, `'dev'`, `'1.2'` → `{ name: … }`; `''`, `'   '`, `42`, `undefined` → `null`. Add to `release-create-batch.test.ts`: `releaseCreate({ releases: [{ name: 'Checkout Redesign', type: 'regular' }], confirmedCommand: true })` rejects with the kebab-case remediation and `prepareGitForRelease` was not called. Reword the C rejection to cite the shared function.
2. **§3.3 step 3 `type`** — required, not optional; delete "Blank means regular" from its `.describe()`; R2 `required` becomes `['type','release']`; `e-r1`/`e-r2` `required` assertions likewise; §5.3 step 0 checks untouched `description` only. (Alternative, if rejected: keep optional, add Architect amendment 6 verbatim to step 0, AND add pre-mortem scenario 5: "untouched `type` arrived as `""`; whole form discarded" with detection = step-0 stderr `form discarded (validation)` and mitigation = fold `''` into the enum after measuring it.)
3. **§3.10 R7 + AC4** — parse `{ ...m, confirm: true }` through `z.object(releaseCreateMcpTool.inputSchema)`; assert `canonicalArgs(stripGateKeys(parsed)) === canonicalArgs(m)` (import both from `src/lib/tool-handler/confirm-token`). Drop `toStrictEqual`.
4. **§3.9 `e-r1` round 2 + AC6 + §5.4** — replace the `not.toMatchObject` assertion with: take a stderr `mark` before the confirm call; after it, `stderr().slice(mark)` does NOT contain `Tool execution refused (` and DOES contain `Tool execution failed: release-create`. State that this is the first form-fed gated confirm lane.
5. **§3.1** — replace the "why move" paragraph with the module-scope-call TDZ rationale (Architect amendment 1); delete the sweep sentence and "benign at runtime"; add "the new `release-form.test.ts` imports `release-form` first and is the regression detector".
6. **§3.3 `buildRequestedSchema`** — delete the provider-level `orNull` wrap; `withDeadline(computeHint(), HINT_BUDGET_MS)` is the only collapse. Signature: `createReleaseFormProvider(options?: { hintBudgetMs?: number })`, `HINT_BUDGET_MS` exported (AC8, R3).
7. **§3.11 SKILL.md** — the empty-`resolvedArgs` gate has two causes and the agent must tell them apart: `formDiscarded: true` → the human's answer was discarded; re-call with no `releases` to open a fresh form; `formDiscarded: false` → the client cannot render a form; ask by chat and re-call with `releases`. Never confirm either.
8. **§Options D, §7 Alternatives** — replace "two dialogs" with the reasons in finding 2.1.
9. **§1 driver 2, §Options A pros** — "`z.string()` pinned by R2", not "listed primitive".
10. **§3.2** — "third copy", name `mcp-proxy/upstream.ts:224-238`'s rejecting variant in the new module's doc comment.
11. **§7 Consequences** — round-2 hint rebuild is tolerated waste (up to 2.5 s before the gate), not a property; one abandoned `git ls-remote` child per timed-out round.
12. **§3.4 last bullet** — delete the `.optional()` ordering concern.
13. **AC7** — `mcpMode.enabled = true` (reset in `afterEach`), `vi.mock('@inquirer/select')` added to the file, assert zero calls AND `commandEcho.setInteractive` not called.
14. **§5.3 step 3** — name a repo with `release/v*` branches, or state both hint outcomes as acceptable.
15. **§0, §3.9 line refs** — `SKILL.md:106`; `src/mcp/__tests__/helpers/env-picker-fixture.ts`.

## 4. Verdict

No blocker: Option A is the right ship, the state-machine, gate and G8 claims are true and were executed, and the test plan has all four lanes. Four MAJORs stand between rev 1 and something an executor can build without re-deciding: the plan does not implement its own principle 1 (R1), the only live path has an unmeasured silent-discard shape with no pre-mortem row (R2), the fixed-point test uses a comparator the wire does not (R3), and the named round-2 assertion cannot run as written (R4).

CRITIC: ITERATE

## Rev 2 evaluation

Re-read rev 2 in full against the plan TEXT (not the revision log); every line ref rev 2 added was re-checked in the working tree: `tool-handler.ts:464` (`Tool execution refused (`), `:600` (`Tool execution failed:`), `mcp-mode.ts:18/:21-23` (`mcpMode` / `isMcpMode`), `next-version.ts:278-282` (`hasNextToken` goes through `isNextToken`, which lowercases — so R5's `' NEXT '` → `{ version: 'NEXT' }` row is safe: `ensureKnown` is still called and `resolveReleaseEntries` still resolves it), `jira/api.ts:237-240`, the wizard's select at `:164-176`.

### Per-revision status

| # | Status | Where in rev 2 |
|---|---|---|
| R1 shared classifier, classify-only, R5 rows, AC7b, C reworded | **APPLIED** | §1 P1; §3.1 first bullet (token as typed, `parseReleaseSpec` byte-identical); §3.3 step 4 (no `release-id` import, §3.3 imports); R5; §5.1 `next-version.test.ts` cases; AC3 second clause; AC7b; §Options C |
| R2 `type` required, pre-mortem row | **APPLIED** | §3.3 step 3 `type` (required, the `""` reasoning written out, required ≠ defaulted); R2/`e-r1` `required` = `['type','release']`; §5.3 step 0 checks untouched `description`; pre-mortem 5 |
| R3 R7 comparator | **APPLIED** | §1 P4 ("under the wire's comparator"); R7 parses `{ ...m, confirm: true }`, compares `canonicalArgs(stripGateKeys(parsed)) === canonicalArgs(m)`; AC4 forbids `toStrictEqual` |
| R4 `e-r1` round-2 stderr assertion | **APPLIED** | §3.9 `e-r1` (mark, refused-absent, failed-present, why not the payload); §5.4; AC6; stated as the first form-fed gated confirm lane |
| R5 §3.1 TDZ rationale | **APPLIED** | §3.1 third bullet; sweep sentence and "benign at runtime" gone; test file named as detector |
| R6 no `orNull`, injectable budget, exported constant | **APPLIED** | §3.3 heading signature `createReleaseFormProvider(options?: { hintBudgetMs?: number })`; `export const HINT_BUDGET_MS`; step 1 "NO provider-level try/catch"; R3 injects 5 ms; AC8 |
| R7 SKILL `formDiscarded` split | **APPLIED** | §3.11 new paragraph; AC9 pins both literals |
| R8 Option D reasons | **APPLIED** | §Options D (dialog count and `humanOnly` explicitly disowned; D′ steelmanned and recorded as follow-up in §7) |
| R9 `z.string()` pinned by R2 | **APPLIED** | driver 2; Option A pros; R2 "Pins" column |
| R10 third `withDeadline` | **APPLIED** | §3.2 |
| R11 §7 waste + orphan | **APPLIED** | §7 Consequences; pre-mortem 2 residual; §3.2 note; follow-up (timeout/signal on `parseRemoteRefs`) |
| R12 `.optional()` ordering | **APPLIED** | bullet absent from §3.4 |
| R13 AC7 mechanics | **APPLIED** | AC7 (`mcpMode.enabled`, `vi.mock('@inquirer/select')`, `setInteractive` not called) |
| R14 §5.3 step 3 repo | **APPLIED** | §5.3 step 3 (hulyo/travelist; REFUSED branch is the passing outcome here) |
| R15 line refs | **APPLIED** | §1 P1 / §Options C `SKILL.md:106`; §3.9 and §3.9 Fixture `src/mcp/__tests__/helpers/env-picker-fixture.ts` |

15/15 applied in the text.

### Six criteria, second pass

1. **Principle–option consistency.** P1 now names the function §3.3 uses; C's rejection cites the same function. P2's new sentence ("unreachable by construction where possible, or a refusal that names the rule") is exactly what §3.3 steps 3–4 implement. P3, P4 (with the comparator), P5 unchanged and still honoured. No §3 change contradicts a principle.
2. **Fairness.** D/D′ now loses on reasons that do not apply to A (user decision, tool-surface cost, name pass-through) and the two non-discriminating reasons are disowned in the text. B, C, E, A′ as before. Fair.
3. **Risk mitigation.** Five rows, each with a Detection column and a Mitigation column filled by name (R3/R4/R7/`e-r1`/AC1/AC6/R2/step 0). Row 5's `description` half is detectable only live — correctly placed in step 0 and AC11 rather than claimed as a unit test.
4. **ACs.** AC1–AC11 + AC7b each have a command or a named test and an observable; AC6's assertion is now runnable and discriminating.
5. **Verification steps.** Cold-runnable; step 3 no longer assumes this repo's remote state.
6. **Deliberate mode.** Pre-mortem ≥ 3 with detection + mitigation each; unit / integration-e2e / manual e2e / observability all present. Repo rules unchanged from pass 1: no `process.exit` on the MCP path, no counter-style `for`, WHY-only comments, OFFERED assertions, `; echo EXIT=$?`, lockstep publish, exact-version refresh.

### New findings introduced by rev 2

| Sev | Finding | Plan § |
|---|---|---|
| MINOR | The wizard's type select carries `default: 'regular'` (`release-create.ts:173`); a required `z.enum` on the wire has no way to pre-select, so the human must click where the wizard would let them press Enter. Worth one sentence in Option A's cons (the Architect's non-blocking note; I agree it is a con, not a defect — pre-selection was the `""` path R2 removed). | §Options A cons |
| MINOR | §3.3 step 2 reads `content.type === 'hotfix' ? 'hotfix' : 'regular'` while `type` is now required by the schema, so the `'regular'` fallback is dead on the MCP path. Keep it (it is what makes `toArgs` total per `types.ts:60-66`) but the R5 row "`type` absent → `'regular'` present" should say it pins totality, not a wire case. | §3.3 step 2, R5 |
| MINOR | `isRecord` in §3.3 `isFormable`/step 5 has no stated source; `env-load-form.ts:24` defines a module-private one. The provider should define its own likewise (not import from `argument-form.ts`, which does not export it). | §3.3 |

None of these changes the build.

### Remaining required revisions

None. The three MINORs above are text and may be folded in by the executor.

CRITIC (rev 2): APPROVE
