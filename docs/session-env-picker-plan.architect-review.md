# Architect review — `docs/session-env-picker-plan.md`

**Verdict: architecturally sound with the REQUIRED changes in §7.** Nothing below re-opens the four user
decisions (elicitation is the fix; all three bodies become skills; two independently shippable phases;
`env-load` stays ungated). Every claim checked was checked against the working tree at `534c222` and the
installed SDK (`@modelcontextprotocol/server` `createMcpHandler-CLhGwQTn.d.mts`, `mcp-DXXb3Vv3.mjs`).

## 1. Claims verified against code

| # | Plan claim | Result | Evidence |
|---|---|---|---|
| V1 | `ctx.mcpReq.elicitInput` throws on a 2026-07-28 request | **true** | `createMcpHandler-CLhGwQTn.d.mts:2192-2200` (`@deprecated Throws on a 2026-07-28-era request — return inputRequired(...)`), same text at `:3102-3107` |
| V2 | Legacy shim: server→client `elicitation/create`, in-process handler re-entry, `maxRounds` 8, 600 s/leg | **true** | `d.mts:2806-2831`; loop at `mcp-DXXb3Vv3.mjs:541-600` — `handler(request, ctxNext)` is called with the **same `request` object**, `ctxNext.mcpReq.inputResponses = responses` (`:589-599`) |
| V3 | Shim checks the client's declared capability before sending | **true, and stricter than ours** | `mcp-DXXb3Vv3.mjs:561`: a client that did not declare the capability gets `legacyShimFailure` (an `isError` text result). Our `canForm` probe (`tool-handler.ts:371-373`) prevents ever reaching it |
| V4 | T1 forbids only the legacy prefix | **true — a substring test, not a regex** | `manifest.test.mjs:609-614`: `readText(file).includes('mcp__infra-kit__')` over `SKILLS_DIR`. `mcp__plugin_infra-kit_infra-kit__…` does not contain it; `skills/doctor/SKILL.md:4` proves it |
| V5 | U6 polices fenced lines only | **true** | `manifest.test.mjs:146-163` (`fencedLines`, `COMMAND_HEADS = {node, python3, pnpm, git, infra-kit}`), `bashRules` reads only `Bash(...)` (`:165`). All three bodies have **0 fences today** (`resources/workflow/*.md`) |
| V6 | Gate script + CI | **true** | `scripts/check-workflow-resource-published.mjs`: floor regex `/it needs infra-kit (\d+\.\d+\.\d+) or newer/`, URI regex, `pnpm dlx infra-kit@<latest> mcp` → `resources/list`; `plugin-ci.yml:16-21` path triggers, `:55` PM-C step, `:12-13` script paths. The step is the **only** step in that workflow that reaches npm |
| V7 | `src/md.d.ts` and `?raw` survive | **true** | `src/lib/agent-guidance/resources.ts:1-8` imports `resources/{design,package}/*.md?raw` |
| V8 | `resources-list-baseline.v1.json` = `config` + `dev-context` only | **true** | `src/mcp/__tests__/fixtures/resources-list-baseline.v1.json` |
| V9 | F10 skills-doc claims | **true, one nuance** | Fetched `code.claude.com/docs/en/skills.md` 2026-09-15: `allowed-tools` = "during the turn that invokes this skill. The grant clears when you send your next message"; `disable-model-invocation` also blocks subagent preload; `!` recognised "at the start of a line or immediately after whitespace"; `shell` accepts `bash` (default)/`powershell`. **Nuance:** the doc says the commands "run through the **Bash tool**" — see A-d |
| V10 | `EXPECTED_FORM_TOOLS` is four today | **true** | `command-catalog.test.ts:687-692` |
| V11 | `env-status` reads `process.env` + the cache file; throws without `INFRA_KIT_SESSION` | **true** | `env-status.ts:30` (`getSessionCacheDir()` throws), `:38-42` all five fields are `process.env` reads |
| V12 | Client API allows hand-posted `inputResponses` (Q3) | **true** | `@modelcontextprotocol/client` `index.d.mts:1681-1684` (`autoFulfill:false` + per-call `allowInputRequired:true`), `index-D4xIIEF6.d.mts:979` (`inputResponses?` on `CallToolRequestParams`) |
| V13 | Old CLI rejects a missing `config` "with an error naming config" | **true, but it is a JSON-RPC error, not an `isError` result** | `mcp-DXXb3Vv3.mjs:1432`: `ProtocolError(InvalidParams, "Input validation error: Invalid arguments for tool env-load: …")`. The skill's fallback trigger must cover **both** shapes (§7 R5) |
| V14 | "G8 loses its last `'unreachable'` row" (§10 Consequences) | **false** | `headless-policy-guards.test.ts:33-60`: `POLICY_SITES` keeps `local-deploy.ts#pickServices` and the `worktrees-add` row. Only the `env-load` row goes |
| V15 | `getRepoName` needs no remote (Q4) | **true** | `git-utils.ts:262-266`: `basename(getProjectRoot())` |
| V16 | Injection spawns are safe from the silent auto-updater | **true** | `update-check/guards.ts:78` `if (!isTty) return 'not-a-tty'`; a `!` command has no TTY |
| V17 | `withConfirmToken` adds only `confirmToken`; `confirm` is declared by the gated tools themselves | **true** | `mcp/tools/index.ts` (`withConfirmToken`), `local-deploy.ts:487` |
| V18 | `narrowsArgs` refuses loss on the ungated path (§2.2 ii) | **vacuous for this provider** | `argument-form.ts:237-251` walks `before`'s keys only; `toArgs = {...params, config}` can never drop one. It is a chokepoint invariant for FUTURE providers, not a guarantee env-load relies on. f-u9 needs a synthetic provider |

## 2. The truth table R1–R8

- **R4 is the exact complement of R1∪R2∪R3 inside `!gated`.** R2∪R3 = `responses≠undef ∧ hasProvider`; R1 = `responses=undef ∧ canForm ∧ hasProvider ∧ formable`. Complement = `(responses=undef ∧ ¬(canForm∧hasProvider∧formable)) ∨ (responses≠undef ∧ ¬hasProvider)`. Matches the plan's R4 literally. R5–R8 are today's rows 2–5 unchanged (`tool-handler.ts:118-136`).
- **`confirmed` is genuinely irrelevant on R1–R4.** The SDK parses args with `z.object(tool.inputSchema)` at the single `registerTool` site (`mcp/tools/index.ts`), zod strips undeclared keys, no ungated tool declares `confirm` (V17) → `isConfirmed(params)` (`tool-handler.ts:90-92`) is `false` by construction. Reading it on R1–R4 would be dead code.
- **Row-3 `run-form` IS reachable without a form ever being offered** — on the modern era the client sends `inputResponses` on any `tools/call`; the shim path is server-internal. The server is stateless by design (`argument-form.ts:112-118`), so it cannot tell a shim re-entry from a hand-posted accept. **Acceptable under P6**: `readAcceptedArgs` rebuilds the enum from `listProjectEnvs()` on THIS request and `toArgs` merges only `config`, so the handler runs with a name `env-list` knows — exactly what `env-load {config}` already grants an allowlisted caller. Two consequences the plan must state (§7 R2, R4): the `Tool execution form accepted` log line is **not evidence a human chose**, and the body's §7 clause needs a second sentence: "never send `inputResponses` yourself".
- **The mutation matrix (§6.1) names the wrong `!gated`.** Deleting `!gated` from **R1** changes only `gated ∧ confirmed ∧ formable` (a round-2 call would get a form instead of `verify`) — annoying, not dangerous. Deleting `!gated` from **R3** makes an accepted form on a GATED tool return `run-form` ahead of R7 → **the handler runs with no token, no gate**. That is the one deletion the table exists to make observable and it is absent from the matrix (which lists "R1 `!gated` → f4"). R2's and R4's `!gated` also need rows (R2: a decline on a gated tool reads `declined` — same as R6, harmless; R4: a gated call with no provider would `run`).
- **Ordering note:** R1–R4 all start with `!gated`, so their placement relative to R5–R8 is immaterial; the comment at `tool-handler.ts:103-107` explaining why `!confirmed` is spelled on rows 1–3 must be re-anchored to R5–R7.
- **`responses` on a first modern-era call is `undefined`, not `{}`** — the existing gated rows already depend on this and the e2e is green on both eras; E-M1 pins it for the ungated path too.

## 3. Steelman antithesis

### A-a. Extending `resolveGateState` vs a separate ungated-form wrapper

**Strongest case against the plan.** `resolveGateState` is the one function a mutation build attacks (`tool-handler.ts:114-116`, `:363-365`) and its first line, `if (!input.gated) return 'run'`, is the entire proof that ungated tools are untouched by the gate. Replacing that line with four rows means the security table's exhaustiveness proof now has to cover a UX feature; the type `GateState` gains a member (`run-form`) that is not a gate state; and the "no provider ⇒ old behaviour" property becomes something the test suite asserts rather than something the code shows. A ten-line `resolveUngatedForm` run only when `!gated ∧ hasProvider`, placed before the gate in `resolveStop`, would leave the gate table byte-identical.

**Why the plan's choice still wins, narrowly.** The first-call/came-back discriminator (`responses !== undefined`) and the decline/discard/accept semantics are the subtle part (`tool-handler.ts:103-107`); a second implementation of them is a second place for the re-prompt-forever bug. One table with an exhaustive 2⁷ test is the stronger guard — **provided** the R3 `!gated` mutation is in the matrix (§7 R1). Synthesis: keep one table; rename nothing in the public surface, but rename the type/function locally (`CallState`/`resolveCallState`) or at minimum reword the doc comment so "gate" no longer describes R1–R4.

### A-b. "The answer is an argument, not consent" with `narrowsArgs` designed for CONFIRM

Sound. `narrowsArgs`/`readAcceptedArgs` were built to protect the **gate's token binding** (what the human approves is what runs). On the ungated path there is nothing to bind: the authority to run comes from `LOW_RISK_MUTATING_ALLOWLIST` (`command-catalog.ts:594-606`) and a forged accept yields exactly `env-load {config:'x'}`. The plan's guarantee — "the ungated form path can execute nothing a direct call could not" — is the right invariant and P6 pins it. What is **not** sound is presenting `narrowsArgs` as one of the three guarantees (V18: vacuous here). And one honesty gap: the form's `message` says "Choose the environment to load into terminal session X" and the load runs on the answer with **no further prompt** (allowlisted + `allowed-tools`); that is the designed feature, but the body must say the human's click IS the load.

### A-c. Deleting the publish gate

**Strongest case against.** The gate was the only artefact that ever looked at what a user actually installs (`pnpm dlx infra-kit@latest mcp`, hand-rolled JSON-RPC, deliberately sharing no code with the repo). Phase 2 makes the plugin — git-sourced, unpinned (`.claude-plugin/marketplace.json` `"source": "./plugins/infra-kit"`, no version) — the carrier of the prose that drives the CLI, i.e. it moves the agent-facing procedure from the SLOW clock (npm, gated) to the FAST clock (merge = live on next `plugin update`). The HEAD cross-check (§3.5) proves tool NAMES exist at HEAD; it proves nothing about the published build, and the session skill's actual dependency is a SCHEMA property (`config` optional), which no name check sees. The residue in §9 is honest but the bite is real: the next skill edit that assumes a CLI change and forgets its fallback clause ships to every consumer on merge, and no test knows.

**Why deletion is still right.** Redness-as-feature between merge and publish blocked unrelated plugin PRs (`plugin-ci.yml:50-55` says so), and a gate that pins a URI has no successor object to pin once the resource is gone. Synthesis (§7 S1): keep the gate's stdio driver as a **non-gating** `continue-on-error: true` step that lists the published `tools/list` and prints, per skill, every plugin-prefixed tool it names that the published build lacks, plus whether `env-load.inputSchema.required` still contains `config`. It reports skew without blocking; it costs one npm fetch. Also §7 R5: the E-skew fixture must be the real published error text (V13).

### A-d. `!`zsh -c …`` — frozen reading or not?

**Not a frozen reading; the mechanism is verified, the justification is half wrong.**

- `~/.zshenv` carries the session-env block (`init.ts:1191-1215`, installed here: `~/.zshenv:1-19`). It runs for **every** zsh, `-c` included (only `-f`/`NO_RCS` skip it), and sources `${XDG_CACHE_HOME:-$HOME/.cache}/infra-kit/$INFRA_KIT_SESSION/env-load.sh` when readable and not older than `env-clear.sh`. It never mints a session (`.zshrc:142-144` does that, interactive only) — so a `zsh -c` child reads the **inherited** id, never a fresh one. `precmd` is irrelevant: the block sources at startup, not via the hook.
- `INFRA_KIT_SESSION` inheritance is measured: this review's Bash tool reports `session=1e2285d3`, parent `/Users/arthur/.local/bin/claude`. The MCP server spawned by the plugin inherits the same id (F9), so the file the injection reads is the file `env-load` wrote. Truthful.
- **But** the Bash tool on this machine is **zsh 5.9, not bash** (`$ZSH_VERSION=5.9`, `$BASH_VERSION` empty, observed via the tool itself; the tool's own error format `(eval):1: … not found` is zsh's). The docs say `!` commands "run through the Bash tool", and `shell: bash` describes the frontmatter key, not the binary. So on this install a **bare** `infra-kit env-status --json` already sources `~/.zshenv` and is already truthful; PM-4's "certain with a bare command" is unproven and AC 16's negative half ("`null` through bash") is likely **unsatisfiable**. `zsh -c` remains the right spelling — it makes truth independent of what the host picks for the Bash tool (a `$SHELL=bash` machine, Linux) — but the rationale must change and AC 16's negative must become a recorded observation, not a criterion (§7 R6).
- Two residual truths the body must state precisely: (1) the injected `sessionConfig` is "**what has landed for this session id**", not "what the terminal currently holds" — the terminal applies it at its next `precmd` (`.zshrc:157-171`), which cannot run while Claude Code is foreground; (2) the `|| echo` text attributes failure to two causes, but a third (no `zsh` binary — Linux consumers) reads the same; make the fallback text generic.

## 4. Tensions (stated, then a synthesis where one exists)

**T1 — "edit the body once" vs "Phase 1 is independently shippable".** §2.6 ships Phase 1 with no prose; the only agent path stays `resources/workflow/session.md` §3 ("offer the four most likely… `AskUserQuestion`"). Phase 1 alone therefore fixes nothing the user reported — the defect is repaired only by C3. That is a **P1 violation for the whole C2→C3 window** and makes "independently shippable" true only in the CI sense. Synthesis: C2 edits `resources/workflow/session.md` §3 to two sentences (call `env-load` without `config`; on an error naming `config`, list EVERY entry as prose). C3 deletes the file, so this is a deletion, not a second rewrite; `server.test.ts:324-360`'s clause table and line count move with it. §7 R3.

**T2 — one chokepoint vs a clean gate.** Stated in A-a; synthesis there.

**T3 — fast clock for prose vs proof against the slow clock.** Stated in A-c; synthesis there.

**T4 — `allowed-tools` as UX vs the host prompt as the human gate.** Listing `env-load` makes the form path prompt-free (good: one dialog). It also means the human's click is the load. The session row's stated reason for excluding `env-clear` — "the approval moment is a turn boundary (the grant has cleared by call 2 anyway)" — is **wrong**: the gate's round 2 is an agent-authored re-call (`tool-handler.ts:186-188`), which happens in the SAME turn, so a listed gated tool would let call 1 + call 2 run with no host prompt at all. The release-create row states this correctly; the session row contradicts it. The conclusion (exclude) stands; the rationale must match, because U14' encodes it. §7 R7.

## 5. Principle violations (plan's own §1.1)

| Principle | Violation | Evidence |
|---|---|---|
| P1 human chooses, LLM never curates | Phase 1 alone leaves the curating path as the ONLY agent path (T1) | plan `:219-222`; `resources/workflow/session.md` §3 "offer the four most likely" |
| P2 one chokepoint | Minor: `env-load.ts` gains form-aware prose in its `OperationError.remediation` ("cannot render the environment form") — a second place that knows a form exists. Same pattern as the deploy tools' `'refuse'`, so tolerated; keep the wording to "call env-list, ask, re-call with config" and let the seam own the word "form" | plan `:205-208` |
| P5 "never lists a destructive tool" | Wording, not substance: the catalog says every allowlist member "reads destructive" (`command-catalog.ts` comment above `MCP_TOOL_PRESENTATION`, `destructiveHint` true on `env-load`). P5 means "never lists a **gated** tool" — that is what U14' checks. Say so | `command-catalog.ts:606-612` |
| §10 accuracy | "G8 loses its last `'unreachable'` row" is false (V14) | `headless-policy-guards.test.ts:33-60` |
| §3.4 vs §3.6 | "no floor sentence, no gate" (orchestrator recipe) vs "each skill carries a CLI floor sentence" | plan `:298` vs `:345`; `docs/session-context-orchestrator.md:38-41` step 4 |

## 6. §11 open questions — recommendations

1. **`form_discarded` terminal — agree.** Running with round-1 params means running with no `config`, which the handler refuses anyway; a distinct terminal status is the honest shape and matches P4.
2. **Refusal without the list — agree**, with one addition: the refusal's remediation must name `env-list` verbatim (E-L3 asserts it), and the Phase-1 direct-MCP caller is the only reader who ever sees it without the injected list.
3. **E-M1 manual mode — confirmed** (V12): client `inputRequired:{autoFulfill:false}`, per-call `allowInputRequired:true`, then a fresh `callTool('env-load', { inputResponses: { args: { action:'accept', content:{config:'stage'} } } })`. Also add the hand-posted-accept lane with NO prior form (proves §2 row-3 reachability and that P6 holds).
4. **Fixture — git-init'd temp cwd + temp HOME.** `getRepoName` is `basename(getProjectRoot())` (V15), so no remote is needed; the token store keys off that basename; Layer-3 auto-seed lands under the temp HOME. Avoid the PATH-stubbed `doppler` — it tests a stub. Watch macOS `/var`→`/private/var` (memory: realpath asymmetry) by `realpath`-ing the temp dir before `git init`.
5. **`message` getter — accept, with the reason written down.** `envLoadMcpTool` is a module-scope constant, so a plain string would freeze `INFRA_KIT_SESSION` at import; the server's env never changes after that, so the getter exists for tests that set the variable after import, not for production. A getter satisfies `message: string` structurally; no interface change.
6. **`setup` model-invocable — agree.** Its human gate is `anthropic/requiresUserInteraction` + `requiresHumanConfirm` (`types.ts:95-100`), neither skippable by `allowed-tools`. Record the always-on token delta: three new descriptions load into every session; README `:115` pins 431 against a 20% rule.
7. **Keep `env-clear` and `release-create` OUT — agree, fix the rationale** (T4).
8. **`version --json` injection — leave as residue.** Each `!` line is a node boot plus Layer-3 seed; two per invocation is already the cost. If a floor branch is ever needed, fold `version` into `env-status --json`'s output (additive `outputSchema` field) rather than a third spawn.

## 7. Verdict

### REQUIRED (blocking)

1. **Mutation matrix:** add `!gated` on R2, R3 and R4; R3's is the load-bearing one (gate bypass). State that R1's `!gated` deletion is caught by a `gated ∧ confirmed ∧ formable → verify` lane, not by f4. (§2)
2. **Row-3 reachability is stated, not hidden:** §2.2 says the `form accepted` log is not evidence a human chose; §3.3 §7 adds "never send `inputResponses` yourself"; drop `narrowsArgs` from the list of guarantees or mark it "chokepoint invariant, vacuous for this provider". (§3 A-b, V18)
3. **Phase 1 must fix the defect:** C2 rewrites `resources/workflow/session.md` §3 to "call `env-load` without `config`; on an error naming `config`, list every entry as prose", moving the clause table/line count in `server.test.ts:324-360`. Otherwise strike "independently shippable" from the plan's framing. (T1, P1)
4. **The E-skew fixture is the real error:** the old CLI answers a missing `config` with a JSON-RPC `InvalidParams` error, text `Input validation error: Invalid arguments for tool env-load: …` (`mcp-DXXb3Vv3.mjs:1432`), not an `isError` result. Capture it from `pnpm dlx infra-kit@0.7.7 mcp`, and word the skill's fallback trigger as "a tool error OR a refused result naming `config`". (V13)
5. **AC 16's negative half is dropped** ("`null` through bash"); V0.4 records what the bare spelling reads on 2.1.270 without making it a criterion. Reword §3.2's rationale: `zsh -c` makes the reading independent of which shell the host's Bash tool is (measured zsh 5.9 here), and the reading is "what has landed for this session id". (A-d)
6. **Fix the session row's `env-clear` rationale** to the release-create row's: a listed gated tool lets the agent's same-turn call 2 skip the host prompt. (T4)
7. **Correct §10:** G8 keeps two `'unreachable'` rows; reconcile §3.4 "no floor sentence" with §3.6 "each skill carries a floor sentence" (the SKILL.md carries it; the orchestrator recipe step 4 becomes "if the change needs a newer CLI, bump the floor sentence and keep the fallback"). (V14)

### SUGGESTED

- S1 Keep the gate's stdio driver as a **non-gating** `continue-on-error` plugin-ci step: published `tools/list` vs the plugin-prefixed names each skill uses, plus `env-load.inputSchema.required ∌ config`. Reports skew; never blocks. (A-c)
- S2 U14'/U18 additionally assert the `session` and `release-create` skills carry **zero** `Bash(` rules, so a future fenced `infra-kit …` line turns U6 red instead of becoming a Bash grant (`env-token-set` writes the token store). (V5)
- S3 Rename locally (`CallState`/`resolveCallState`) or reword the doc comment at `tool-handler.ts:94-112` so "gate" no longer describes R1–R4; re-anchor the `!confirmed` comment (`:103-107`) to R5–R7. (A-a)
- S4 Make the `|| echo` fallback text cause-agnostic (`{"error":"status unavailable"}`) — no-zsh hosts read the same branch. (A-d)
- S5 Re-measure the always-on token cost after C3 and update README `:115` (three new descriptions).
- S6 `form_discarded` on the ungated path should carry `reason` as a field (the plan says so) AND keep the `tool` field so an agent's programmatic branch matches `form_declined`'s shape.

---

# Iteration 2 — re-review of the Δ2 revision

**Verdict: no blocking items.** All seven REQUIRED items are resolved where the plan says they are; the
Δ2 additions were checked against code below. Four non-blocking corrections (I2-C1…C4) and three new
suggestions (S7–S9) follow.

## I2.1 REQUIRED #1–7 — status

| # | Status | Δ2 location | Note |
|---|---|---|---|
| 1 mutation matrix | **RESOLVED, stronger than asked** | §2.1 `:121-147`, §6.1 `:412-431` | The reorder (gated rows first, U4 fall-through) makes `!gated` on U1–U3 inert by construction and pins the dangerous case as a *reorder* mutation observed by f4/f5/f2 (`tool-handler.test.ts:570/587/525` — verified lanes). One matrix row has a false observer — I2-C1 |
| 2 row-3 reachability | **RESOLVED** | §2.2 `:177-191`, §3.3 `:319-320`, E-M3 `:465` | `narrowsArgs` demoted to "chokepoint invariant, vacuous for this provider" (F15) |
| 3 Phase 1 fixes the defect | **RESOLVED** | §2.6 `:249-266`, C2 row `:405`, AC 9a `:512` | `server.test.ts:327` `toHaveLength(119)` is the line the plan names; the negatives (`four most likely`, `AskUserQuestion`) are asserted |
| 4 E-skew fixture | **RESOLVED** | F13 `:57`, §3.6 table `:376`, lane `:470`, V0.6 `:495` | Captured from the published build, both shapes, both must contain `config` |
| 5 AC16 negative dropped | **RESOLVED** | §3.2 `:289-295`, PM-4 `:395`, V0.4 `:488-490`, AC16 `:522-524` | "what has LANDED for this session id" is now the stated meaning |
| 6 `env-clear` rationale | **RESOLVED** | §3.1 `:274` | Same-turn round 2, `tool-handler.ts:186-188` |
| 7 §10 / floor | **RESOLVED** | §10 `:585-588`, §3.4 `:331`, §3.3 `:320-321` | F17 records the surviving `POLICY_SITES` rows |

## I2.2 New material, verified

**(a) G1–G4 then U1–U4, U4 as fall-through, 2⁷ table.** Partition is proven by construction:
G1–G3 partition `gated ∧ !confirmed` (today's comment at `tool-handler.ts:133-135`), G4 is
`gated ∧ confirmed`, so nothing `gated` reaches a U row; U4 is the literal complement of U1∪U2∪U3
inside `!gated` (checked in iteration 1) and, as the fall-through, needs no spelled condition to be
total. The 2⁷ table can identify the matched row from `(state, gated)` alone because `'run'` is now
produced by U4 only. **f-u13 is correct and fills a pre-existing hole**: today's f7 lanes cannot
observe `!confirmed` on row 2 — the first (`:727`) carries `inputResponses` (so `responses !== undefined`
excludes row 2 regardless) and the second (`:744`) uses `URL_ONLY` (so `canForm` excludes it). A
`FORM_CAPABLE` + `formable` round 2 with confirm+token and no `inputResponses` is the only fixture where
deleting `!confirmed` from G1 turns `verify` into a second form. Name it `f7c`, not `f-u13` — it is a
G-row lane and belongs beside f7.

**(b) E-M3 as the P6 proof.** Keep both halves. P6 (unit) asserts `toArgs`'s OUTPUT shape; it cannot
see whether `readAcceptedArgs` still calls `acceptedContent` with the schema-aware overload
(`argument-form.ts:200`). E-M3's `config:'nope'` half is the only lane that reddens if that call
regresses to the schema-less overload — invalid content would then reach `toArgs` and the handler. The
`'stage'` half proves U3 reachability with no prior form. Client-side API confirmed in iteration 1 (V12).

**(c) Release order C1→C2→C4a→C3→C4b and the four windows.** Correct as far as it goes, with one
honesty gap: the "Old plugin + `<next+1>` CLI" window (`:374`) is labelled "Acceptable", but the old
command's fallback clause (`commands/session.md:2`) says "ask the user which one" with nothing
forbidding `AskUserQuestion` — that window **re-opens the P1 defect** for stragglers on the old plugin
and is bounded only by their next `plugin update`. Option (b) (one publish) would have had NO
P1-violating window (its guaranteed window, new plugin + 0.7.7, falls to the injected full prose list).
Option (a) is still the right call because it is the only order that honours "two independently
shippable phases" at the release level and lets V0.3 run against a PUBLISHED build; but the table must
say which window is P1-violating and why it is accepted. See S7 for a cheap mitigation. Also add the
designed end state (new plugin + `<next+1>`) as a row — the table currently stops at `<next>`.

**(d) `scripts/report-published-cli-skew.mjs`.** Placement after U9 is right (the report reflects the
bump). One npm fetch per plugin PR is what the gate already cost. Two design notes → S8, S9.

**(e) Supersession of `docs/infra-kit-setup-skill-plan.md` Phase 3.** Verified: that plan's `:915`
carries `allowed-tools: Read, Bash(infra-kit doctor --json), Bash(infra-kit init)`, `:633-640` is its
normative allowed-tools test, `:863` is the Phase 3 section, and it predates `setup` as an MCP tool. The
supersession sentence at `:22-28` is accurate and the non-adoption of the `Bash(infra-kit init)` grant is
consistent with P5 as reworded.

## I2.3 Non-blocking corrections to the plan text

- **I2-C1 (§6.1 `:422`)** "Delete `gated` from G1 → f-u4 reddens" is false. G1 without `gated` matches
  exactly the inputs U1 matches and returns the same `'form'`; the caller's fall-through target (gate vs
  run) is chosen from `deps.requiresHumanConfirm`, not from which row fired. The mutation is **inert** —
  `gated` on G1 is redundant once U1 exists. Say so ("documented redundancy; pinned only if the 2⁷ table
  asserts the row, which it cannot distinguish") rather than naming an observer that does not observe.
- **I2-C2 (§2.0 `:117-119`)** "a red V0.3 with a green V0.1 means the shim serves gated re-entries only"
  is not a real outcome: `LegacyInputRequiredShim.fulfill` (`mcp-DXXb3Vv3.mjs:541-600`) sees only the
  `InputRequiredResult` and knows nothing about gates. Green V0.1 + red V0.3 means OUR U1/U3 path is
  broken (or `canForm`/`formable` read false for env-load), and the response is a C1/C2 bug hunt, not a
  no-go.
- **I2-C3 (§2.1 `:142`)** "G1–G4 are `:118-136` verbatim" — G4 changes from the fall-through `return
  'verify'` to an explicit `if`; say "G1–G3 verbatim, G4 made explicit".
- **I2-C4 (§3.6 `:373`)** the "Old plugin + `<next>`" row: the legacy command has no `allowed-tools`, so
  the host prompts once for `env-load` before the dialog. Not a defect; state it so V0.3-style checks
  in that window are not misread as "the grant failed".

## I2.4 §11 (iteration 2) — recommendations

1. **U4 as the fall-through, G4 explicit — accepted.** An explicit `if` for U4 leaves a final statement
   that can only be `return 'run'` again or a `never` assertion; both are dead code the linter will
   flag and a reader will distrust. The 2⁷ table asserts U4's complement; keep a closing comment in the
   style of today's `:133-135` ("condition complete: `!gated ∧ …`").
2. **Skew report after U9 — accepted.** Add one line: write the report to `$GITHUB_STEP_SUMMARY` as well
   as stdout, otherwise a `continue-on-error` step's output is invisible on the PR page and the
   "visibility, not a gate" argument is void.
3. **Keep E-M3's `'nope'` half** — reasons in (b).
4. **C4a/C4b — keep (a).** Cost is one extra lockstep publish; benefit is Phase 1 verified in production
   before Phase 2 merges. Label the `<next+1>` straggler window honestly (see (c)) and consider S7.

## I2.5 New suggestions

- **S7** In C4b, serve `infra-kit://workflow/session` as a 3-line deprecation stub for ONE release
  ("call `env-load` without `config`; on an error naming `config`, call `env-list` and list every entry
  as prose; this resource is retired") instead of a 404, deleting it in `<next+2>`. It closes the only
  P1-violating window at the cost of one URI in the RES baseline for one release. If rejected, keep the
  404 and state the window as accepted.
- **S8** `report-published-cli-skew.mjs` keeps a pure `collectSkew({ skills, publishedTools })` with a
  unit test (the shape `publish-gate.test.mjs` had for `collectViolations`). A report script with no
  test can print nothing and look healthy — a fail-open report is worse than none.
- **S9** The skill scan (every `mcp__plugin_infra-kit_infra-kit__<name>` in `skills/**/SKILL.md`) will
  exist twice — the TS cross-check in `command-catalog.test.ts` and the mjs report. Put the regex in one
  fixture (`plugins/infra-kit/__tests__/__fixtures__/scan-patterns.json` already holds fragmented
  needles) and read it from both, so the two scans cannot drift.
