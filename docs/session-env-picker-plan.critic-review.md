# Critic review — `docs/session-env-picker-plan.md` (iteration 1)

**Verdict: ITERATE.** The chosen options are the right ones and every invalidation I spot-checked is a
fact, not a fiat. What blocks is narrower than the plan's size suggests: the mutation matrix mislabels
the one deletion that bypasses the gate (and misses a second, broader one); Phase 1 as written ships
the defect intact for the C2→C3 window; two acceptance criteria are not decidable as written; the
release order the plan calls "safe" cannot be produced by the commit sequence the plan prescribes; and
one sibling plan already claims the same `skills/setup/SKILL.md` with a different design.

Everything below was checked against the working tree at `534c222` and the installed SDK
(`@modelcontextprotocol/server/dist/createMcpHandler-CLhGwQTn.d.mts`, `mcp-DXXb3Vv3.mjs`). User
decisions (elicitation is the fix; all three bodies become skills; independently shippable phases;
`env-load` stays ungated) are not re-opened.

## 1. Criteria

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Principle–option consistency | **FAIL** | P1 is violated for the whole C2→C3 window: plan `:219-222` ships no prose, and the only agent path stays `resources/workflow/session.md:70` ("offer the four most likely"). Architect REQUIRED #3 has a testable fix (§3 below). P2/P5 wording items are real but non-blocking. |
| 2 | Fair alternatives | **PASS** | B: `elicitInput` is `@deprecated Throws on a 2026-07-28-era request` at `createMcpHandler-CLhGwQTn.d.mts:2195-2199` and again `:3102-3107` — verified by me, the citation is exact. C: invalidated on P1 (a user decision) and kept as the fallback — fair. M-B on F10 (commands are legacy) + the gate's two-clock hazard; M-C on the duplicate-row memory. The Architect's A-a wrapper alternative is not in the ADR's rejected list — add it (S-3). |
| 3 | Risk mitigation clarity | **FAIL** | All four lanes exist (unit §6.1, integration §6.2, e2e §6.4, observability = OBS row + f-u12). The "delete X → which lane reddens" statement exists ONLY for §6.1. Nothing says what deletion reddens E-L1/E-L3/RES/OBS/U18/U14'. PM-5's mitigation ("a non-JSON status block is treated as unknown") is a body clause no test pins — it is absent from U18's clause table (plan `:323-326`). V0.1 is the load-bearing assumption of Phase 1 (PM-1) and has no stated no-go outcome. |
| 4 | Testable acceptance criteria | **FAIL** | AC16's negative half is unsatisfiable on the author's machine: my own Bash tool reports `zsh=5.9 bash=` (empty), confirming the Architect's measurement — a "bare" injection already sources `~/.zshenv:1-19`. E-skew (`:426`) is not decidable as written: the skill body is prose, it contains no regex, so "the fallback trigger matches" has no assertable object. AC17 "V0.5 recorded" needs the file named (`docs/reviews/elicit-schema-measurements.md`, plan `:369`). Everything else is a command or a named lane. |
| 5 | Concrete verification steps | **PASS** | §8: every line gates on `; echo EXIT=$?`; root `pnpm run qa` is present; the flake-discipline line matches memory. One caveat (S-5): a full `pnpm run qa` rewrites manifests and the vendor mirror — the plan should say "shasum before/after, diff before committing". |
| 6 | Security — the ungated form path | **FAIL (matrix), PASS (invariants)** | Architect REQUIRED #1 confirmed and **strengthened** — see §2. R5–R8 are byte-for-byte today's rows 2–5 (`tool-handler.ts:118-136`). `env-load` stays at `command-catalog.ts:611-612` in `LOW_RISK_MUTATING_ALLOWLIST`; the fail-closed invariant at `command-catalog.test.ts:244-268` is untouched; the form-tools test (`:687-692`, `:696-707`) asserts nothing about gating, so adding `env-load` to `EXPECTED_FORM_TOOLS` weakens nothing. |
| 7 | Skew / publish safety | **FAIL** | E-skew covers one shape; the old CLI answers a missing `config` with a JSON-RPC `InvalidParams` **error** (`mcp-DXXb3Vv3.mjs:1429-1433`, `validateToolInput` → `ProtocolError`), not an `isError` result — Architect V13 confirmed. And §3.6's "safe order: CLI first" is **unachievable** by the plan's own commit plan (§4 below). |
| 8 | Scope discipline | **PASS with one gap** | Present: setup as a skill (§3.1), `disable-model-invocation`/`allowed-tools` decisions (§3.1), `!` injection (§3.2), CI gate deletion (§3.4), `plugin.json` bump (C3, AC17). No unwanted scope (`version --json` and titled enum are correctly parked). **Gap:** `docs/infra-kit-setup-skill-plan.md` (status "pending approval", rev 3) already specifies `plugins/infra-kit/skills/setup/SKILL.md` with `allowed-tools: Read, Bash(infra-kit doctor --json), Bash(infra-kit init)` (`:915`) and a normative-copy test (`:633-635`). This plan's `setup` row has no `allowed-tools` and a different body, yet §0 says siblings are "not re-decided". Two pending plans now disagree on one file. |

## 2. The mutation matrix — REQUIRED #1 confirmed and strengthened

Plan `:378-388` lists "R1 `!gated` → f4". Reading R1–R8 (`:100-108`) as first-match-wins against
`resolveGateState` (`tool-handler.ts:113-137`) and the existing lanes (`tool-handler.test.ts`):

| Deleted conjunct | Effect | Lane that reddens today |
|---|---|---|
| R1 `!gated` | `gated ∧ confirmed ∧ formable ∧ canForm ∧ hasProvider` → `form` instead of `verify`. A round-2 gets a second form. Annoying, not a bypass. | none of f0–f14 as named; needs a `gated ∧ confirmed ∧ formable → verify` lane (f7 at `:727` carries `inputResponses` but its `formable`/`canForm` fixture must be checked) |
| R2 `!gated` | `gated ∧ confirmed ∧ responses ∧ !accepted` → `declined` instead of `verify`. Fails safe. | f7 `:727` (a confirmed round 2 carrying a decline must reach VERIFY) — verify the fixture's `accepted` |
| **R3 `!gated`** | an accepted form on a GATED tool returns `run-form` ahead of R7: `readAcceptedArgs` merges, the handler **runs with no token and no gate**. | **f4 `:570`** ("an accepted form gates on the COLLECTED values, with a token bound to them") — this is the lane the plan mislabels as R1's |
| **R4 `!gated`** | R4's first disjunct is `responses === undefined ∧ !(canForm ∧ hasProvider ∧ formable)`. Without `!gated`, **every gated tool that has no provider** (`release-create`, `env-clear`, `worktrees-remove`, `release-remove`, `gh-merge-dev`…) and every gated provider tool facing a non-form client **returns `run` on call 1**, ahead of R7. This is the broadest bypass in the table, and it needs no forged `inputResponses`. | **f5 `:587`** ("a gated tool with NO provider gates on call 1") and f2 `:525` (url-only client gets the gate) |

The Architect listed R4 in passing and named R3 "the load-bearing one". Both are gate bypasses; R4's
is wider. Both rows go in the matrix with the lanes above, and f4/f5/f2 must be cited as the observers
(so AC2 "every pre-change lane passes unchanged" is what pins them — say so).

**Hardening the plan should adopt (S-1, not blocking):** order the rows **R5–R8 first, then R1–R4**.
R5–R8 partition `gated` exhaustively today (`tool-handler.ts:131-136` comment), so with them on top
the new rows are reachable only under `!gated` by construction, the gate's exhaustiveness proof is
unchanged, and the `!gated` conjuncts on R1–R4 become defence-in-depth rather than load-bearing.
The plan's "every conjunct spelled on every row" rule still applies; only the order changes, and R8
becomes an explicit `return 'verify'` under `gated ∧ confirmed` with R4's `run` as the fall-through.
This also answers the Architect's A-a antithesis better than a rename: the gate table literally
stays where it is.

## 3. Phase 1 must fix the defect — REQUIRED #3, made testable

Today's `resources/workflow/session.md:60-71` is the curating path (`AskUserQuestion`, "offer the four
most likely"). §2.6 leaves it as the only agent path until C3. The user's report is unfixed by
Phase 1 alone, so "independently shippable" is a CI property, not a product one. Fix in C2:

- Rewrite §3 of the resource to: bare token → `env-load {config}`; no token → `env-load` **without**
  `config` (the form); on a tool error OR a refused result naming `config` → call `env-list` and show
  **every** entry as a numbered prose list, `hasToken:false` annotated; never `AskUserQuestion`.
- `server.test.ts:324-360` gains two NEGATIVE clauses — `expect(body).not.toContain('four most
  likely')`, `expect(body).not.toContain('AskUserQuestion')` — and one positive, ``without `config` ``;
  the `toHaveLength(119)` literal is updated. C3 then deletes the file and MOVES these clauses to U18
  (the plan already plans the move for the positive ones).
- C2 touches `apps/infra-kit/cli/resources/workflow/**`, which triggers `plugin-ci.yml:16` including
  the PM-C step (`:55`). It stays green (0.7.7 serves the URI; the floor in `commands/session.md` is
  0.5.2). State this so nobody reads the trigger as a reason to fold C2 into C3.

## 4. Release order — a contradiction the plan must resolve

§3.6 (`:341-343`): "Safe order when released separately: CLI first, plugin second". §5 (`:369`): C3 is
ONE commit carrying both the plugin skills and the CLI deletions, and the only publish is C4 after
C3. The plugin is git-sourced (`.claude-plugin/marketplace.json:10` `"source": "./plugins/infra-kit"`,
no version pin) — a merge is live on the consumer's next `plugin update`; the CLI is live only on
`pnpm add -g`. So with the plan's own sequence, **"new plugin + old CLI" is the guaranteed window**
for every consumer between C3's merge and C4's install, and "CLI first" never happens. Two honest
resolutions; pick one and write it down:

- **(a)** Publish Phase 1 before merging Phase 2: C1, C2, **C4a** (`<next>`: `config` optional), then
  C3, **C4b** (deletions). The skill's form path then meets a CLI that already accepts a missing
  `config` on day one, and E-skew guards only the stragglers.
- **(b)** Keep one C4 and declare the "new plugin + old CLI" window mandatory-survivable: E-skew is
  the gate for it, both error shapes pinned (§5 below).

Either way the phrase "CLI first" must be marked as *not producible by commit order* — the plugin
clock is the merge.

## 5. E-skew — make it decidable, both shapes

Plan `:426`: "the session skill's fallback trigger matches the pre-change zod error". A SKILL.md body
holds prose, not a regex, so nothing can "match". What CAN be asserted:

1. A fixture file holding the REAL text captured from `pnpm dlx infra-kit@0.7.7 mcp` for
   `tools/call env-load {}` — a JSON-RPC error, code `-32602`, message beginning `Input validation error:
   Invalid arguments for tool env-load:` (`mcp-DXXb3Vv3.mjs:1432`) — plus the new refusal from §2.4.
2. Both texts contain the literal `config` (the token the body names).
3. U18 asserts the body carries the two-shape phrase: "a tool error **or** a refused result naming
   `config`".

That is the whole lane. The Architect's REQUIRED #4 is confirmed; this adds what the test asserts.

## 6. Pre-mortem falsifiers — gaps

| PM | Status | Gap / fix |
|---|---|---|
| PM-1 | mitigation named (V0.1, E-L1/E-L2, V0.3) | **V0.1 is the go/no-go for Phase 1 and must run BEFORE C1** with the no-go stated: if Claude Code 2.1.270 does not render the legacy shim's `elicitation/create` for an ungated tool, the primary path is dead for the target client and only the §3.3 prose fallback ships. The plan lists V0 first (`:366`) but never says what a red V0.1 changes. |
| PM-2 | P4 + `EnvAuthError` naming `env-token-set` | falsifiable — OK |
| PM-3 | P7 + injected id | falsifiable — OK; add the Architect's precision ("what has landed for this session id") |
| PM-4 | `zsh -c` + U18 + V0.4 | the *mechanism* is right, the *rationale* is wrong (this host's Bash tool is zsh 5.9 — measured). Reword per Architect #5; V0.4's bare-spelling half becomes a recorded observation |
| PM-5 | "non-JSON status → unknown" body clause + V0.5 | **no falsifier**: add the clause to U18's table; V0.5 stays the manual record |
| PM-6 | §3.6 + E-skew | see §4/§5 — the lane must be decidable and the window stated correctly |

Add a "delete X → lane" row for the non-unit lanes so criterion 3 is met in full:
`envLoadMcpTool.formProvider` wiring → E-L1 (spy never called) and the form-tools test (`:696`);
the `canForm` probe → E-L3 (a url-only client would reach `legacyShimFailure`, `mcp-DXXb3Vv3.mjs:561`);
the `form accepted` log → OBS; `zsh -c` → U18; `disable-model-invocation: true` on `session` → U14';
any workflow URI reintroduced → RES.

## 7. Architect REQUIRED items — position

| # | Item | Position |
|---|---|---|
| 1 | Mutation matrix `!gated` rows | **AGREE, strengthened** — R4's deletion is the broader bypass; cite f4/f5/f2 as observers (§2) |
| 2 | Row-3 reachability stated; `narrowsArgs` vacuous here | **AGREE** — `narrowsArgs` (`argument-form.ts:237-251`) walks `before`'s keys only; `{...params, config}` can never drop one |
| 3 | Phase 1 fixes the defect | **AGREE, blocking** — testable as §3 |
| 4 | E-skew fixture is the real JSON-RPC error | **AGREE, blocking** — plus the lane must be made decidable (§5) |
| 5 | AC16 negative dropped; rationale reworded | **AGREE** — independently measured (`zsh=5.9 bash=`) |
| 6 | `env-clear` rationale in the session row | **AGREE, blocking but cheap** — the wrong rationale ("the grant has cleared by call 2") is exactly what would license a future editor to add a gated tool; the gate's round 2 is an agent-authored same-turn re-call (`tool-handler.ts:186`) |
| 7 | §10: G8 keeps `'unreachable'` rows; floor-sentence reconciliation | **AGREE** — `POLICY_SITES` has six `'unreachable'` rows (`headless-policy-guards.test.ts:34-67`); only the `env-load` row goes |

Architect SUGGESTED: endorse S2 (zero `Bash(` rules on `session`/`release-create` — `env-token-set`
writes the store), S3, S4, S6. S1 (a non-gating step that still reaches npm) is compatible with the
user's "delete the gate" but not asked for — leave it to the user, do not fold it in by default.

## 8. Additional findings (blocking marked ●)

- ● **Supersede `docs/infra-kit-setup-skill-plan.md` Phase 3 explicitly.** One sentence in §0: that
  plan's `skills/setup/SKILL.md` (Bash-granted `infra-kit init`) predates `setup` becoming an MCP tool
  (`3d59079`, `f353a16`); its Phase 3 and normative `allowed-tools` test are not adopted.
- ● **State V0.1 as a gate with a no-go outcome** (§6, PM-1).
- ● **Release order** (§4).
- ● **E-skew decidability + both shapes** (§5).
- ● **Mutation rows for the non-unit lanes; PM-5 clause into U18** (§6).
- S-1 Row order R5–R8 then R1–R4 (§2).
- S-2 The injection puts command output into the prompt. Both commands are metadata-only —
  `env-status.ts:38-42` reads five env NAMES' values (config/project/loaded-at/flags), `env-list.ts:21-22`
  says "never the token itself" — say so in §3.2, and pin it: a provider/e2e assertion that neither
  `--json` output contains any value from the fixture's `env-load.sh`.
- S-3 ADR "Alternatives": add the separate `resolveUngatedForm`-before-the-gate wrapper (Architect A-a)
  as considered and why the single table wins.
- S-4 `tool-handler.ts:22-27` already lies ("Absent on every tool today" — four deploy tools carry a
  provider); fold that rewrite into C1 alongside `types.ts:88-90`.
- S-5 §8: note the `pnpm run qa` manifest/vendor-mirror rewrite (shasum before/after).
- S-6 §1.1 P2 names `lib/argument-form`; the file is `src/lib/tool-handler/argument-form.ts`.
- S-7 U14' should also pin that `setup`'s frontmatter has NO `disable-model-invocation` key (the plan
  says "absent", U14' as written pins the `true` cases — make absence an explicit assertion).

## 9. Changes for the Planner (next iteration)

1. Mutation matrix: rows for `!gated` on R2, R3, R4; R3 → f4 (`:570`), R4 → f5 (`:587`) + f2 (`:525`);
   R1's needs a new `gated ∧ confirmed ∧ formable → verify` lane. Say AC2 is what pins R3/R4.
2. §2.2: the `form accepted` log is not evidence of a human; §3.3 §7 adds "never send `inputResponses`
   yourself"; `narrowsArgs` marked "chokepoint invariant, vacuous for this provider".
3. C2 rewrites `resources/workflow/session.md` §3 (form first, full prose fallback, no
   `AskUserQuestion`); `server.test.ts:324-360` gains the two negative clauses + length update; note the
   plugin-ci path trigger stays green. §2.6 is rewritten accordingly.
4. E-skew: captured JSON-RPC `-32602` fixture from 0.7.7 + the new refusal; assertions as §5; skill
   phrase "a tool error or a refused result naming `config`".
5. AC16: keep the `zsh -c` positive half; drop the bash negative; reword §3.2's rationale
   ("independent of which shell the host's Bash tool is — measured zsh 5.9 here"; the reading is "what
   has landed for this session id"). V0.4's bare half becomes a recorded observation.
6. Session row: `env-clear` excluded because a listed gated tool lets the agent's same-turn round 2
   skip the host prompt.
7. §10: "G8 loses the `env-load` `'unreachable'` row (five remain)"; reconcile §3.4/§3.6 on the floor
   sentence (SKILL.md carries it; orchestrator step 4 = bump the floor, keep the fallback).
8. §3.6/§5: resolve the release order (§4 option a or b) and delete "CLI first" as an achievable order.
9. V0.1 is a pre-C1 gate with a stated no-go outcome.
10. Test plan: "delete X → lane" rows for E-L1/E-L3/RES/OBS/U18/U14'; PM-5's non-JSON clause added to
    U18's table; AC17 names the file that records V0.5.
11. §0: one sentence superseding `infra-kit-setup-skill-plan.md` Phase 3.

---

# Iteration 2 — re-review of the Δ2 revision

**Verdict: APPROVE.** Every blocking item from iteration 1 (Architect #1–7, Critic #8–12) lands where
the plan's `Δ2:` markers say it does. The Architect's four text corrections (I2-C1…C4), the `<next+1>`
straggler window, and two nits of mine below are non-blocking and ride into the next edit of the plan
text; none changes a decision, a test lane or a commit boundary.

## I2.1 Critic #8–#12 — status

| # | Item | Status | Δ2 location |
|---|---|---|---|
| 8 | Release order contradiction | **RESOLVED** | §3.6 `:359-376`: option (a) chosen (C1→C2→C4a→C3→C4b), "CLI first" stated as producible only by publishing Phase 1 before merging Phase 2 (F12 `:56`); the windows table names the guard per window. Nit: add the designed end-state row (new plugin + `<next+1>`) — the table stops at `<next>`. |
| 9 | V0.1 as a pre-C1 gate with a no-go outcome | **RESOLVED** | §2.0 `:106-119`, AC 0 `:500-501`, PM-1 `:392`, §5 row `:403`. I2-C2 applies: a red V0.3 with a green V0.1 is a C1/C2 bug, not a shim property — the shim (`mcp-DXXb3Vv3.mjs:541-600`) sees only the `InputRequiredResult`. |
| 10 | E-skew decidable, both shapes | **RESOLVED** | F13 `:57`, V0.6 `:495-496`, lane `:470`, §3.6 row `:376`, U18 `:353`, AC 18 `:525`. Spot-check of the fixture design in I2.3. |
| 11 | Supersede setup-skill plan Phase 3 | **RESOLVED** | `:22-28`; §3.1 `:276` says where the `Bash(infra-kit init)` grant is explicitly not adopted. |
| 12 | delete-X→lane rows; PM-5 clause in U18; AC17 names the file | **RESOLVED** | e2e table column `:458-470`; plugin lanes `:475-477`; PM-5 clause `:352` and `:303-304`; AC 17 `:524-525` names `docs/reviews/session-env-picker-v0.md`. |

## I2.2 Criteria, re-run

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Principle–option consistency | **PASS** | P1: C2 rewrites the resource's §3 (`:249-266`) with the negatives asserted; P2: the remediation no longer says "form" (`:239-242`); P5 reworded to "gated" (`:75`). Residual: the "old plugin + `<next+1>`" straggler window re-opens P1 (Architect I2.2(c)) — must be labelled as such, see I2.4. |
| 2 | Fair alternatives | **PASS** | A′ (separate `resolveUngatedForm` wrapper) is now a listed, rejected option (`:92`, ADR `:570`). |
| 3 | Risk mitigation clarity | **PASS** | Every PM has a falsifier: PM-1 §2.0 gate; PM-5's clause is in U18 (`:352`); all four lanes carry "delete X → lane" (`:418-431`, `:458-470`, `:475-477`). One matrix row has a false observer (I2-C1, `:422`) — text only. |
| 4 | Testable ACs | **PASS** | AC16 positive-only (`:522-524`); AC0 gate; AC 9a/9b; AC 18 E-skew against the captured fixture; AC17 names the recording file. |
| 5 | Verification steps | **PASS** | §8 unchanged in gating; the qa manifest-rewrite guard added (`:538-539`). |
| 6 | Security | **PASS** | G1–G4 on top, U1–U4 below (`:128-140`); the load-bearing mutation is now the *reorder*, observed by f4/f5/f2 (`:420`), which AC2 pins; E-M3 (`:465`) proves P6 end-to-end incl. the invalid-content half; the allowlist and `command-catalog.test.ts:244-268` are untouched; U14' denylist expanded to every gated tool (`:343-347`) plus zero `Bash(` rules. Partition spot-check in I2.3. |
| 7 | Skew / publish safety | **PASS** | Both shapes (F13, `:376`, `:470`); the order is mandatory-(a) with the straggler window declared mandatory-survivable and E-skew its gate. Labelling nit in I2.4. |
| 8 | Scope discipline | **PASS** | Supersession stated; `report-published-cli-skew.mjs` (A-S1) is a lead-adopted addition — non-gating, so it does not contradict the user's "delete the gate". Nothing else beyond the two phases. |

## I2.3 Spot-checks

**2⁷ partition (§2.1 `:128-140`).** Inputs: `gated, confirmed, responses∈{undef,def}, canForm,
hasProvider, formable, accepted` — 128 rows. `gated`: G1 ⊂ (`!confirmed ∧ responses undef`); G2 ∪ G3 =
`!confirmed ∧ ((def ∧ !accepted) ∨ (undef ∨ accepted))` = all of `gated ∧ !confirmed`; G4 = `gated ∧
confirmed`. So no `gated` input reaches a U row — the `!gated` conjuncts on U1–U3 are inert by
construction, exactly as `:123-126` claims. `!gated`: `responses undef` is split by `canForm ∧
hasProvider ∧ formable` between U1 and U4's first disjunct; `responses def` is split by `hasProvider`
between U2∪U3 (then by `accepted`) and U4's second disjunct. Disjoint and total. The table can name
the row from `(state, gated)` because `'run'` is U4-only and `'form'`/`'declined'` are disambiguated by
`gated`. **Confirmed.** I2-C1 is also right: G1 without `gated` matches exactly U1's inputs and yields
the same `'form'`, and the caller's fall-through (gate vs run) reads `deps.requiresHumanConfirm`, not
the row — the mutation is inert, so `:422`'s "f-u4 reddens" is a false observer.

**E-skew fixture (V0.6 `:495-496`, F13, lane `:470`).** Capture via `pnpm dlx infra-kit@0.7.7 mcp` with
an exact pin (memory: `@latest` is a stale-cache hit) — sound. The assertion "both texts contain the
literal `config`" is what the body's trigger keys on, so it is the right predicate, but it is
shape-blind: a fixture accidentally re-captured from a NEW CLI (an `isError` *result*) would still
contain `config` and stay green. **Nit (non-blocking):** the lane should also pin the shape — the
fixture is a JSON-RPC `error` with `code === -32602` and the live refusal is a `result` with
`isError: true` — so the "two shapes" claim is what the test proves, not just the substring.

## I2.4 Rides into the next edit (non-blocking)

1. **I2-C1** (`:422`): mark "delete `gated` from G1" inert / documented redundancy; drop f-u4 as observer.
2. **I2-C2** (`:117-119`): green V0.1 + red V0.3 = C1/C2 bug hunt, not a no-go.
3. **I2-C3** (`:142`): "G1–G3 verbatim, G4 made explicit".
4. **I2-C4** (`:373`): the legacy command has no `allowed-tools`, so the host prompts once before the dialog.
5. **`<next+1>` straggler window** (`:374`): label it as the one P1-violating window (the old command's
   fallback says "ask the user which one" with nothing forbidding `AskUserQuestion`), bounded by the
   consumer's next `plugin update`; add the designed end-state row. My recommendation: **adopt S7** — a
   3-line deprecation stub at `infra-kit://workflow/session` for one release closes the window for the
   cost of one URI in the RES baseline; if the user prefers the 404, say "accepted" and why.
6. **E-skew shape assertion** (I2.3): `error.code === -32602` for the fixture, `isError: true` result for
   the live refusal.
7. **C2's `server.test.ts` clauses** (`:261-262`): also pin the two-shape phrase ("a tool error or a
   refused result naming `config`") in the RESOURCE body — today only U18 (C3) pins it, leaving the C4a
   window's body unpinned for that clause.
