# Critic review — `docs/release-remove-form-and-jira-plan.md`

Reviewer: critic pass of a ralplan `--deliberate` consensus loop. Read-only with respect to the plan,
`docs/release-remove-form-and-jira-plan.architect-review.md`, and all source. This file is the only
artefact written. Every `file:line` below was opened at HEAD `4818ee4`. `«rr»` as in the plan.

The decisions (A: form when `version` omitted; B: reverse D7) are the user's and are not judged. What is
judged is whether the plan's decisions honour its own five Principles, whether its alternatives are
argued from evidence, and whether every mitigation and acceptance criterion is a test or a command.

## Verdict: ITERATE

Fixable in one revision. The seam, the enumeration source and the gate/HMAC reasoning are sound, and the
Architect's confirmations hold. What blocks approval: two refusal texts still name a CLI-only exit over
MCP (P2 — the second is produced by the plan's OWN D9 change); the load-bearing claim that U18 is
"inverted" so retired sentences cannot survive is false (U18 is presence-only), which hollows out PM-4
and P5; PM-1 has no baked-in mitigation for the one failure the e2e fixture cannot reproduce; and §10 as
written is not runnable end-to-end.

## Required changes for APPROVE

1. **P2 at `«rr»:251` (Architect #1, ADOPTED).** `'un-release it in Jira first, or remove the release without it via --skip-jira'` is marked "unchanged" in D7 (`:246-256`), but over MCP `--skip-jira` is refused by D6 row 3 — DD-3's exact shape. §4.2's B3 column also mis-describes this refusal as "a Jira-UI-only exit". Amend D7 to fork the remediation on `isMcpMode()` like `:234-235` (MCP: un-release it in Jira, or ask a human to run `--skip-jira` from a configured shell); fix B3's premise; add a case to the guard test's released/archived pair (`release-remove-mcp-guards.test.ts:285,299`) asserting no `--skip-jira` in the MCP message.
2. **P2 at `«rr»:591` (Architect #2, ADOPTED and sharpened).** `buildResidueError` appends ``Re-run `infra-kit release remove --version …` `` to every step failure and, at `:601`, prepends the step's refusal. D9 forks `:755` to say "re-call release-remove" — so the plan's own change produces one message carrying BOTH "re-call release-remove" and "Re-run infra-kit release remove". Pre-existing for steps 1–5 over MCP today, but P2 puts it in scope. Fork the `:591` sentence on `isMcpMode()`; the new toctou MCP `it` must assert the WHOLE remediation contains no `infra-kit release remove`.
3. **PM-4 / P5 / §11 rest on a false claim.** `manifest.test.mjs:912-920` (procedure-skill U18) asserts PRESENCE only: removing `'There is no picker'` from `PROCEDURE_CLAUSES` does not fail if the sentence survives. "The skill cannot keep the old clauses" is untrue as written. Required: a retired-clause list for `release-remove` asserted absent (the session-body U18 at `:817`/`:842` already has this pattern) covering `'There is no picker'`, `'no tool field'`, `'Attached issues do not block'`, `'jira: "manual"'`, `'never removed over MCP'`, `'never touches the fix version'`, `'carries \`version\` and nothing else'`; extend AC-12's grep terms to `never removed|never touches|do not block|no tool field`; add `apps/infra-kit/cli/src/lib/command-catalog`to AC-12's paths (Architect #3 —`command-catalog.ts:666-668`and`command-catalog.test.ts:284-286`both carry "never attempted", outside the plan's grep). PM-3(c) likewise needs the actual "do not pass`moveIssuesTo`on your own initiative" sentence as a U18 clause, not the bare token`'moveIssuesTo'`.
4. **PM-1 has no mitigation for the environmental miss (Architect #4, ADOPTED with a concrete shape).** Measured here: `gh pr list --search` 662/658/728 ms (3 runs, warm auth, this repo) — ~1.4 s sequential median for `gh-release-prs.ts:78,81`, tail unbounded, twice per accepted form, all under `FORM_DEADLINE_MS` 3 000. The e2e stub cannot miss; a real repo can, and the human then reads D6 row 1's remediation "call from a client that can render the argument form" — which blames the client for a timeout. Required: (a) `Promise.all` the two searches in `fetchAllReleasePRs` (add `src/integrations/gh/gh-release-prs` to Scope; its test mocks by `--base` substring, `gh-release-prs.test.ts:28-29,66`, so it is order-agnostic); (b) an in-provider `withDeadline` on the enumeration with THREE distinct log lines — options empty / gh failed / gh timed out — so a miss is attributable in stderr (§8.4), pinned by a new `f11`; (c) reword D6 row 1's remediation to list its four causes without asserting the client's capability.
5. **Architect #5 — real but NOT new; the plan must say so and pin it.** `isFormable = version === undefined` makes `{ moveIssuesTo: 'x' }` formable; `toArgs` spreads round-1 params, so the gate shows `{ moveIssuesTo, version }` in `resolvedArgs` — the same shape as call-1 `{version, moveIssuesTo}`, which B1 already accepts as "the CLI's `--move-issues-to --yes` shape" under PM-3's residual. Do NOT add an `isFormable` exclusion: refusing it buys nothing (the agent re-calls with both). Required: `f1` gains `{ moveIssuesTo: 'x' }` → true; `f8` asserts the merge keeps `moveIssuesTo`; B1's "counts before a target" row is corrected to "when the agent follows the skill". Decide `version: ''` (Architect #11) and pin it in `f1` either way.
6. **D13 misses `SKILL.md:60` and `:62-67`.** "The first call never executes anything — and inspects nothing" and "This is the only inventory the human will get" are false on the form path: call 1 runs two `gh` searches and a Jira `getProjectVersions`, and the picker rows ARE an inventory. Amend both; keep U18's `'The first call checks nothing about the release'` (`:875`) only if that sentence still literally appears.
7. **§10 is not runnable as a script.** Lines 293–312 `cd apps/infra-kit/cli && …`; a shell keeps that cwd, so `pnpm run test:claude` (`:309`, a ROOT script) fails and the AC-12 grep (`:315`, root-relative paths) exits 2 on missing paths. Wrap each block in `( cd … && … )` or use absolute paths.

## Architect items: adopted / downgraded / refuted

- ADOPT as required: #1, #2, #3, #4, #5 (reframed — see 5).
- DOWNGRADE to NIT (fix in the revision, not gating): #6 "the token is spent" is false (`confirm-token.ts:21-22` TTL + argument binding, no nonce store; `argument-form.ts:88` "stateless BY CONSTRUCTION") — rest the skill rule on binding; #7 skew window → §11; #8 witness wording ("any pre-mutation throw"; order is `:928` → `:932` → `:934` → `:937`); #9 cite drift (`:533-537`, `:500-503`; `f3` is a helper test since `gh-release-prs.ts:153` already filters); #10 released target — record out of scope; #11 → folded into 5.
- DOWNGRADE the "tradeoff tension" `(released)` row decoration to OPTIONAL: it exceeds the CLI picker (`formatBranchPickerItems` shows description only) and so contradicts P1 "nothing the CLI picker would not offer" — adopt only with a P1 amendment.
- REFUTE: nothing outright; #5's "blind reassignment reachable" overstates a shape the plan already accepts.

## What the Architect missed

- Required 3 (U18 presence-only), 6 (`SKILL.md:60`), 7 (§10 cwd).
- A3's cite: `release-create-form-plan.md:233` lists B's DOWNSIDES ("network-dependent validation, empty-enum hole"); it does not say enum is better when candidates are enumerable. The rejection stands on the CLI picker's existence; fix the cite.
- P3 wording: `withDeadline` abandons, never cancels (`deadline.ts:13`); "never blocks past" is the chokepoint's property, not the provider's. NIT.
- Step 9 (one description string) is split across commits 1 and 2 while `e-rr3` asserts both halves — land 9 and 12 in commit 2. NIT.
- AC-13's second half ("the skill's §1/§3/§4/§5 describe…") is prose; fold into the U18 clause lists of required 3.

## Confirmed by this reviewer

Alternatives are argued from evidence I verified: A2 vs `«rr»:916-920` (single-target by design); B2 vs `:342` + `:826` (`skipJira` → empty preflight → `jiraVersion: null`); B4's N-Jira-calls cost. Pre-mortem has 4 scenarios with named tests; test plan has unit / integration-e2e / manual / observability — the deliberate-mode gates pass once 3 and 4 land. Snapshot grows by one key only (`.snap:234-242` lists key names, not descriptions). CLI parity of "form then unconfigured-Jira refusal" holds (`:937` picker precedes `:942` guard). `pnpm run qa`, `ts-check`, `test:claude` and every vitest path in §10 exist.

---

## Revision 2 (2026-09-15) — re-evaluation

Every required change re-checked against rev 2's text and the code at HEAD `4818ee4`.

| Req                         | Status | Where in rev 2 / evidence                                                                                                                                                                                                                                                                                         |
| --------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 `:251` fork               | DONE   | D7 bullet 3; B3 premise corrected (§4.2); step 5; guard-test pair `:285-302`                                                                                                                                                                                                                                      |
| 2 `:591` fork               | DONE   | D9 second paragraph; toctou + merged-pr-refusal MCP cases assert the WHOLE remediation; step 4                                                                                                                                                                                                                    |
| 3 U18 presence-only         | DONE   | P5 corrected; D13 `RETIRED_CLAUSES` absence loop (session-body precedent `:842-849` verified); AC-12 terms + `command-catalog` path; literal `moveIssuesTo` sentence as a presence clause                                                                                                                         |
| 4 PM-1 environmental miss   | DONE   | DD-2 records the measurement; D2 three distinct log lines; D2/step 0 `Promise.all` (mock keys on `--base main` substring, `gh-release-prs.test.ts:66`, verified order-agnostic); D4 `FETCH_BUDGET_MS` on both fetches, `release-form.ts:26-34` headroom argument verified; D6 row 1 lists causes; `f4`/`f5`/`f11` |
| 5 `{moveIssuesTo}` formable | DONE   | B1 counts row; D3 (`version: ''` follows `env-load-form.ts:74`, verified); `f1`/`f8`/`f9`                                                                                                                                                                                                                         |
| 6 `SKILL.md:60`, `:62-67`   | DONE   | D13; both sentences in `RETIRED_CLAUSES`; `:20` clause stays literally true (verified)                                                                                                                                                                                                                            |
| 7 §10 runnable              | DONE   | subshells, `$ROOT`/`$CLI`, root-only `test:claude` from root, grep paths root-relative                                                                                                                                                                                                                            |

Deliberate-mode gates: PM-1a/1b/2/3/4 each carry a named test (`f2`/`e-rr1`, `f4`/`f5`/`f11`, `f7`/`e-rr1`, `f1`/`f8`/U18, U18 absence + AC-12); unit / e2e / manual / observability lanes present; §10 runnable top to bottom.

### Verdict: ITERATE — one wording contradiction, fixable in a sentence

**R2-1. D7's new MCP text for `:251` contradicts the test D7 names and AC-16.** D7 (rev 2 line 140) words the MCP remediation as `…ask a human to run infra-kit release remove --skip-jira from a configured shell`, then pins it with `expect(message).not.toContain('--skip-jira')` — that assertion fails against that text. AC-16 (line 307) says "no refusal or residue text names `--skip-jira`, `--move-issues-to` or `infra-kit release remove`" over MCP, yet the plan deliberately KEEPS three texts that do: `:235` word-for-word (D7 bullet 2), D6 row 3's `or run infra-kit release remove --skip-jira from a configured shell`, and the new `:251` fork. AC-16 is unsatisfiable by construction as written. Fix: (a) state the rule the plan actually applies — a CLI command may appear over MCP only in the `ask a human to run …` hand-off shape (`:235` is the precedent; the existing guard test at `:344` already uses this convention with `not.toContain('pass --skip-jira')`); (b) change the D7 assertion to `not.toContain('via --skip-jira')` + `toContain('un-release it in Jira')`; (c) reword AC-16 to "names none of them as an action for the CALLER; the `ask a human to run` hand-off is the sanctioned shape". Sections: D7, §8.1 count-guard describe, AC-16.

### Architect's two NITs — not approval-blocking; fold into implementation as notes

- (a) `«rr»:292` (`assertSomethingExists`, "check the spelling against `infra-kit release list`") IS reachable over MCP on a typo'd `version` (`:943`, after the guards). It is a read hint, not an exit, so P2 is not violated — but rev 2's P2 says "every other refusal text an MCP caller can read", so the one-line `isMcpMode()` fork naming `gh-release-list` belongs in step 5 and `infra-kit release list` in AC-16's term list once R2-1 rewords it.
- (b) `:753` → `:755` in D9: the `refuse({` opens at `:753`, the `remediation` line is `:755`. Cite drift only.

Nothing else remains. AC numbering (AC-16 sits between AC-13 and AC-14) is cosmetic.

---

## Revision 3 (2026-09-15) — APPROVE

R2-1 is closed exactly as specified and the two NITs are folded in. Principle 2 (line 25) now states the rule the plan actually applies — a CLI flag or command may appear over MCP only in the "ask a human to run … from a configured shell" hand-off shape, with `:234-235` as precedent and the existing `release-remove-mcp-guards.test.ts:344` `not.toContain('pass --skip-jira')` as the pinning convention — and names the three hand-off texts kept on purpose (`:235`, D6 row 3, the `:251` fork). D7 (line 140) and §8.1 (line 269) assert `not.toContain('via --skip-jira')` + `toContain('un-release it in Jira')`, which the D7 MCP text satisfies (its only `--skip-jira` sits inside the hand-off clause). AC-16 (line 308) is reworded to "as an action for the CALLER" and lists one named assertion per forked text, so it is satisfiable by construction. NIT (a): D7 (line 141) and step 5 fork `assertSomethingExists` (`«rr»:292`, reachable at `:943`) to name the `gh-release-list` tool; the MCP text contains no CLI command, so the resume-test `not.toContain('infra-kit release list')` case is satisfiable. NIT (b): `:755` in principle 2, D9, step 4 and the ADR. One non-blocking observation for the implementer: D6 row 3's kept remediation says "or run infra-kit release remove --skip-jira from a configured shell" without the literal "ask a human" prefix; AC-16 sanctions it by name and no test asserts on that remediation (the `skipJira` guard test matches stderr), so it is consistent — wording it "ask a human to run …" would make every hand-off read identically. No remaining items.
