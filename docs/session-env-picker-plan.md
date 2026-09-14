# `/infra-kit:session` — the environment picker as an MCP elicitation form, and skills without workflow resources

**Status: pending approval** (RALPLAN-DR, deliberate mode — Planner iteration 2, after
`docs/session-env-picker-plan.architect-review.md` and `docs/session-env-picker-plan.critic-review.md`).
Every REQUIRED/blocking item from both reviews is applied and marked `Δ2:` where it landed.

**Consensus:** iteration 2 — Architect: no blocking items (`docs/session-env-picker-plan.architect-review.md`,
I2 rides C1–C4 + S7 applied below as `Δ3:`); Critic: APPROVE (`docs/session-env-picker-plan.critic-review.md`,
two rides applied as `Δ3:`).

One document, two independently shippable phases:

- **Phase 1 — elicitation env picker** (CLI only): `env-load` collects a missing `config` through the
  existing MCP argument-form chokepoint, so the human picks from ONE native dialog listing every
  environment. **Δ2: Phase 1 now also rewrites the resource's §3 so the defect is fixed the day the
  CLI publishes**, not only after Phase 2 (Architect #3 / Critic #1).
- **Phase 2 — skills are the surface** (plugin + CLI): the three workflow bodies move from
  `apps/infra-kit/cli/resources/workflow/*.md` (served as `infra-kit://workflow/*` resources, read by
  thin `commands/*.md`) into `plugins/infra-kit/skills/<name>/SKILL.md` with the full procedure inline,
  and the workflow-resource architecture leaves the CLI.

Sibling of `docs/release-deploy-command-plan.md` (**RD §n**, the argument-form seam),
`docs/session-command-plan.md` and `docs/mcp-via-plugin-migration-plan.md`. Where they decided
something this document does not re-decide it.

**Δ2 (Critic #11): this plan supersedes `docs/infra-kit-setup-skill-plan.md` Phase 3.** That plan
(status pending approval, rev 3) specifies `plugins/infra-kit/skills/setup/SKILL.md` with
`allowed-tools: Read, Bash(infra-kit doctor --json), Bash(infra-kit init)` (`:915`) and a normative
allowed-tools test (`:633-635`). It predates `setup` becoming an MCP tool (`3d59079`, `f353a16`). Its
Phase 3 body, its `Bash(infra-kit init)` grant and its normative test are **not adopted**: this plan's
`setup` skill carries NO `allowed-tools` (§3.1 — the tool is host- and server-gated) and its body is
today's `resources/workflow/setup.md`. The setup-skill plan's Phases 1–2 are unaffected.

## 0. The problem, and the decisions already taken

`session.md` §3 has the agent call `env-list` and then `AskUserQuestion`, which Claude Code caps at 2–4
options (anthropics/claude-code#12420, #26183 — closed, no fix). A consumer repo has nine environments;
the user saw four plus "Type something", and the LLM silently dropped two under the "four most likely"
rule.

**Decided by the user:** (1) the full list is shown in ONE native Claude Code elicitation dialog and the
human chooses; prose lists survive only as the fallback for clients without `elicitation.form`. (2) All
three workflow bodies become skills; commands and the `infra-kit://workflow/*` resources go.

### 0.1 Facts verified (corrections to the brief in bold; A-/C- = confirmed by the Architect/Critic)

| # | Fact | Where |
|---|---|---|
| F1 | Only two commands exist: `plugins/infra-kit/commands/{release-create,session}.md`. **There is no `commands/setup.md`**; the `SETUP_WORKFLOW_URI` comment ("its human channel is the `/infra-kit:setup` plugin command") is stale — `setup`'s body has agent readers only. | `src/mcp/resources/index.ts:30-36` |
| F2 | **T1 forbids only the LEGACY prefix** `mcp__infra-kit__` (a substring test, A-V4); `skills/doctor/SKILL.md:4` already names `mcp__plugin_infra-kit_infra-kit__version`. T1 needs no lifting. | `manifest.test.mjs:609-614` |
| F3 | **The gate script is `scripts/check-workflow-resource-published.mjs` at the REPO root**; invoked at `plugin-ci.yml:55` (the only step in that workflow that reaches npm, A-V6); unit-guarded by `plugins/infra-kit/__tests__/publish-gate.test.mjs`. | `rg -l` |
| F4 | U4 bans only OMC pipeline keys; U6 checks only `Bash(...)` rules against FENCED command lines (all three bodies have 0 fences today, A-V5); T5 denylists consumer repo names anywhere under `plugins/`. | `manifest.test.mjs:30-40, 146-215, 616-628` |
| F5 | `src/md.d.ts` **stays**: `src/lib/agent-guidance/resources.ts:1-8` imports `?raw`. | A-V7 |
| F6 | `renderForLaunch`/`toolName` (`tool-prefix.ts:66-68`) are consumed only by `resources/index.ts` and tests; `McpLaunch`/launch detection stays for `version` and `server.ts`. | `rg` |
| F7 | Other dependents of the workflow bodies: `server.test.ts:147-360`, `tool-prefix.test.ts:110-195`, `mcp-stdio.e2e.test.ts:346-367, 864, 1356-1373`, `resource-bundle.test.ts:55-73`, `generated-instruction-spelling.test.ts:105-115`, `server.ts:29-33`. `resources-list-baseline.v1.json` holds only `config` + `dev-context` (A-V8). | listed |
| F8 | Every CLI command carries `--json`; `env-status --json` prints on stdout, throws without `INFRA_KIT_SESSION` (A-V11). | `json-output.ts:36-37`, `env-status.ts:30` |
| F9 | `env-status` reads `process.env` + the cached file; both `env-status` and `env-list` are **metadata-only** — five env NAMES' values and token PRESENCE, never a secret (`env-list.ts:21-22`). The plugin `.mcp.json` spawns `infra-kit mcp` from PATH — the same binary a `!` injection runs. Injection spawns cannot trigger the silent auto-updater (no TTY, `update-check/guards.ts:78`, A-V16). | `env-status.ts:38-42` |
| F10 | Claude Code docs (`code.claude.com/docs/en/skills`, fetched 2026-09-15, A-V9): `disable-model-invocation: true` = only `/name` invokes it, never auto-loaded nor preloaded into subagents; `allowed-tools` grants permission **for the turn that invokes the skill and clears on the next user message**; `` !`cmd` `` runs BEFORE the body is sent, "at the start of a line or immediately after whitespace", **through the Bash tool** (`shell: bash|powershell` names the frontmatter key, not the binary); `disableSkillShellExecution` substitutes a placeholder; commands are "legacy, still works"; plugin skills support every field. Silent on elicitation. | fetched |
| F11 | **Δ2: the Bash tool on this machine is zsh 5.9** (`$ZSH_VERSION=5.9`, `$BASH_VERSION` empty — measured by both reviewers). `~/.zshenv:1-19` carries the session-env block (`init.ts:1191-1215`), which runs for EVERY zsh including `-c`, sources `env-load.sh` for the INHERITED `INFRA_KIT_SESSION`, and never mints a session (`.zshrc:142-144` does, interactive only). | A-d |
| F12 | The marketplace sources the plugin from git, **unpinned** (`.claude-plugin/marketplace.json:10` `"source": "./plugins/infra-kit"`): a merge is live on the consumer's next `plugin update`; the CLI is live only on `pnpm add -g`. Two clocks. | C-§4 |
| F13 | The **published 0.7.7** answers `env-load {}` with a JSON-RPC `InvalidParams` (`-32602`) ERROR — `Input validation error: Invalid arguments for tool env-load: …` (`mcp-DXXb3Vv3.mjs:1429-1433`) — not an `isError` result. | A-V13 |
| F14 | The client SDK supports hand-posted `inputResponses` (`inputRequired:{autoFulfill:false}` + per-call `allowInputRequired:true`, `CallToolRequestParams.inputResponses`). On the modern era a client may send `inputResponses` on ANY `tools/call`; the stateless server cannot tell a re-entry from a hand-posted accept. | A-V12, A-§2 |
| F15 | `narrowsArgs` (`src/lib/tool-handler/argument-form.ts:237-251`) walks `before`'s keys only; `{...params, config}` can never drop one — **vacuous for this provider**. | A-V18 |
| F16 | `getRepoName` = `basename(getProjectRoot())` — a git-init'd temp dir needs no remote. | A-V15 |
| F17 | `POLICY_SITES` in `headless-policy-guards.test.ts:33-67` holds several `'unreachable'` rows (`local-deploy#pickServices`, `worktrees-add`, …); only the `env-load` row goes. | A-V14 |

## 1. RALPLAN-DR summary

### 1.1 Principles

1. **The human chooses; the LLM never curates.** Where a form cannot be rendered, the fallback shows
   EVERY entry as prose — never `AskUserQuestion`.
2. **One chokepoint, two consumers.** The form seam (`src/lib/tool-handler/{tool-handler,argument-form}.ts`,
   `types.ts:25-70`) stays the only place a form is built or read. Δ2 (C-S-6): path corrected.
3. **A form is argument collection, never consent.** `env-load` stays in `LOW_RISK_MUTATING_ALLOWLIST`
   (`command-catalog.ts:604-614`).
4. **Fail loud, never re-prompt.** Decline → `form_declined`; discarded answer → `form_discarded`; a
   client that cannot form → a refusal naming `config`.
5. **One body, one home; `allowed-tools` never lists a GATED tool.** Δ2 (A-§5): "gated", not
   "destructive" — every allowlist member reads `destructiveHint: true`; the property U14' checks is
   `requiresHumanConfirm`. The host's permission prompt on a gated tool is the one human-in-the-loop that
   is not the agent's honesty.

### 1.2 Decision drivers

1. Completeness of the list the human sees.
2. Era-independence: Claude Code speaks 2025-11-25 today; the served factory negotiates 2026-07-28 with
   auto-capable clients — one handler must serve both.
3. Two clocks, no gate (F12): every skew must degrade to a working fallback.

### 1.3 Options — Phase 1

| | Option | Pros | Cons |
|---|---|---|---|
| **A** | **Extend the chokepoint with an ungated form path** + `createEnvLoadFormProvider`. **CHOSEN.** | Reuses the measured seam; the SDK's legacy shim fulfils `input_required` on 2025-era connections (`createMcpHandler-*.d.mts:2806-2831`; loop `mcp-DXXb3Vv3.mjs:541-600` re-enters the handler with the same `request` object) and the client driver on 2026 — one handler, both eras. Stays inside one turn, so a skill's turn-scoped `allowed-tools` covers the exchange. | The security table gains rows that are not gate states; the "only a gated tool can reach a form" prose in `types.ts:88-90` and the already-false "absent on every tool today" at `tool-handler.ts:22-27` (C-S-4) must be rewritten. |
| **A′** | Δ2 (A-a): a separate `resolveUngatedForm` wrapper run before the gate when `!gated ∧ hasProvider`, leaving `resolveGateState` byte-identical. | The gate's exhaustiveness proof never meets a UX feature; `GateState` stays a gate type. | A second implementation of the first-call/came-back discriminator and the decline/discard/accept semantics (`tool-handler.ts:103-107`) — a second place for the re-prompt-forever bug. **Rejected**; the synthesis is §2.1's ordering: the gated rows stay first and byte-identical, so the table "literally stays where it is" (C-S-1) while one exhaustive test covers both. |
| B | Live `ctx.mcpReq.elicitInput()` in the handler. | No chokepoint change. | **Invalidated.** `@deprecated Throws on a 2026-07-28-era request` (`createMcpHandler-*.d.mts:2195-2199`, `:3102-3107`); the factory already negotiates 2026 (e2e `e8a`). Bypasses the capability probe (the shim answers `legacyShimFailure` to a client that never declared the capability, `mcp-DXXb3Vv3.mjs:561`), the deadline, the totality wraps, every form test, and G6/G7/G8. |
| C | Prose only. | No CLI code. | **Invalidated as primary** (user decision). Its full-prose-list form IS the non-form fallback (§2.6, §3.3). |

### 1.4 Options — Phase 2

| | Option | Pros | Cons |
|---|---|---|---|
| **M-A** | **Full skills** with bodies inline; `disable-model-invocation` on the human-only two; `allowed-tools` for ungated tools only; `!` injection; resources, `workflow-bodies.ts`, `renderForLaunch`, `commands/`, the publish gate and their tests deleted. **CHOSEN.** | One body, one file; no resource hop; no two-clock blocking gate; injection gives the agent truthful pre-state and the full env list. | Static bodies hardcode the plugin prefix — the legacy `.mcp.json` launch loses the procedure (acceptable: HEAD 534c222 dropped this repo's entry; `doctor` already hardcodes it). The agent-facing procedure moves from the SLOW clock (npm) to the FAST clock (merge) — §3.6 states what replaces the gate. |
| M-B | Frontmatter only on `commands/*.md`; resources stay. | Smallest diff. | Keeps the resource hop, the publish gate and the legacy format; injection would add a second source of truth. Rejected. |
| M-C | OMC-style thin `commands/*.md` aliasing skills. | Familiar. | Two `/` rows per procedure — the duplicate-row defect that retired the MCP prompt. Rejected. |

## 2. Phase 1 — the elicitation env picker (CLI)

### 2.0 Δ2 (Critic #9): V0.1 is the go/no-go gate BEFORE C1

V0.1 (§6.6) — the PUBLISHED plugin's gated deploy form rendering natively in Claude Code 2.1.270 over
the 2025-11-25 legacy shim — is the assumption Phase 1 stands on. It runs first, before any code.

- **Go:** a native dialog appears and the accept reaches the gate. Proceed to C1.
- **No-go:** no dialog (the shim's `elicitation/create` is not rendered by this host, or the host
  answers it with decline/cancel unprompted). Then the primary path is dead for the target client:
  C1/C2's code is NOT started; only the §2.6 prose rewrite ships (as its own commit `C2-prose`, the
  full-prose-list fallback with `AskUserQuestion` removed — the defect is still fixed, without a
  dialog); Phase 2 proceeds unchanged; Phase 1 code is re-planned against the next Claude Code that
  negotiates 2026-07-28 (the client driver path, which needs no shim). V0.3 is the same gate for the
  UNGATED path after C2. Δ3 (I2-C2): a red V0.3 with a green V0.1 means **our U1/U3 path is broken**,
  not that the shim discriminates — the shim is gate-agnostic (`mcp-DXXb3Vv3.mjs:541-600` re-enters
  whatever handler returned `input_required`); debug C1/C2 rather than re-plan.

### 2.1 `resolveGateState` — the extended table, gated rows first

**Δ2 (Critic #1 / S-1, adopted): today's gated rows stay on top and byte-identical; the ungated rows
follow.** The gate's exhaustiveness proof is unchanged, the new rows are reachable only under `!gated`
BY CONSTRUCTION, and the `!gated` conjuncts on U1–U3 are defence-in-depth rather than load-bearing.
First-match-wins; every conjunct spelled; U4 is the literal complement and the function's fall-through.

```
GateState = 'run' | 'form' | 'declined' | 'gate' | 'verify' | 'run-form'

G1   gated ∧ !confirmed ∧ responses === undefined ∧ canForm ∧ hasProvider ∧ formable          → 'form'     (today's row 2, unchanged)
G2   gated ∧ !confirmed ∧ responses !== undefined ∧ !accepted                                 → 'declined' (today's row 3, unchanged)
G3   gated ∧ !confirmed ∧ (responses === undefined ∨ accepted)                                → 'gate'     (today's row 4, unchanged)
G4   gated ∧  confirmed                                                                       → 'verify'   (today's row 5, now an explicit `if`)
U1  !gated ∧ responses === undefined ∧ canForm ∧ hasProvider ∧ formable                      → 'form'
U2  !gated ∧ responses !== undefined ∧ hasProvider ∧ !accepted                                → 'declined'
U3  !gated ∧ responses !== undefined ∧ hasProvider ∧ accepted                                 → 'run-form'
U4  !gated ∧ (  (responses === undefined ∧ !(canForm ∧ hasProvider ∧ formable))
              ∨ (responses !== undefined ∧ !hasProvider) )                                    → 'run'      (fall-through; condition asserted by the 2⁷ test)
```

Today's `if (!input.gated) return 'run'` (`tool-handler.ts:116`) is removed; G1–G3 are `:118-131`
verbatim and G4 is today's bare `return 'verify'` (`:136`) made an explicit `if` (Δ3, I2-C3). `confirmed` is unread on U1–U4: the SDK parses args with `z.object(tool.inputSchema)` at the
single `registerTool` site, zod strips undeclared keys, and no ungated tool declares `confirm`
(`withConfirmToken` adds only `confirmToken`; `confirm` is declared by the gated tools themselves,
A-V17) — `isConfirmed(params)` is `false` by construction. The mutation build's neutering of the
`=== true` predicate at `:365` is unaffected.

Δ2 (A-S3): the doc comment at `tool-handler.ts:94-112` is reworded so "gate" describes G1–G4 only and
the `!confirmed` explanation (`:103-107`) is re-anchored to G1–G3; the exported name `resolveGateState`
is kept (its tests and the mutation build import it), with a one-line note that the ungated rows are a
call-state, not a gate state. `tool-handler.ts:22-27` ("absent on every tool today") and
`types.ts:88-90` are rewritten in C1 (C-S-4).

### 2.2 The `'run-form'` path

`resolveStop` (`:355-400`) returns a union instead of `null`-means-run:

```ts
type StopResolution = { kind: 'stop'; result: ToolsExecutionResult | InputRequiredResult } | { kind: 'run'; params: unknown }
```

`'run-form'` resolves in `resolveUngatedForm` (sonarjs ≤ 15):

1. `merged = await readAcceptedArgs(provider, params, responses, deadlineMs)` (`argument-form.ts:187`).
2. `merged === null` → log `Tool execution form discarded (validation): <tool>` → **terminal**
   `softStop({ status: 'form_discarded', tool, reason: 'validation', message })` — Δ2 (A-S6): `tool` AND
   `reason` as fields, same shape family as `form_declined`. Never run with the round-1 params; never
   re-prompt.
3. `narrowsArgs(stripGateKeys(params), merged)` → same, `reason: 'narrowed'` — a chokepoint invariant
   kept for FUTURE providers; **vacuous for this one** (F15). f-u9 uses a synthetic provider.
4. Otherwise log `Tool execution form accepted: <tool>` → `{ kind: 'run', params: merged }`.

`'form'` on an ungated tool reuses `buildArgumentForm`; `null` falls to `'run'` with the round-1
params and logs `Tool execution form unavailable: <tool>` — the handler then refuses (§2.5).

**Δ2 (Architect #2): row U3 is reachable without a form ever having been offered.** On the modern era a
client may send `inputResponses` on any `tools/call`, and the stateless server cannot tell a shim
re-entry from a hand-posted accept (F14). Consequences, stated: the `Tool execution form accepted` log
line is evidence that VALID content arrived, **not that a human chose**; the skill body's §7 carries
"never send `inputResponses` yourself" (§3.3); and lane **E-M3** posts an accept with no prior form and
asserts the handler ran with a name `env-list` knows — which is the point of P6.

**What replaces the token binding.** On the gated path the token binds an agent-authored round 2 to
what the human approved. On the ungated path: (i) what executes is
`provider.toArgs(acceptedContent(schemaRebuiltNow, responses), params)` — validated against a schema the
server built on THIS request (`listProjectEnvs()` now), merging only `config`; (ii) the human's answer
is an ARGUMENT, not consent — the authority to run is the allowlist, and a forged accept yields exactly
`env-load {config:'x'}`. The guarantee pinned: **"the ungated form path can execute nothing a direct
call could not"** — P6 parses every `toArgs` output with `z.object(envLoadMcpTool.inputSchema)`, E-M3
proves it end-to-end. (`narrowsArgs` is deliberately NOT listed as a guarantee — F15.)

`confirmedCommand:true` / `commandEcho`: unchanged; the shim's re-entry is a fresh invocation of the
same closure, `commandEcho.reset()` runs at `:453` on both.

### 2.3 `createEnvLoadFormProvider` — `src/lib/env-load-form/env-load-form.ts`

Modelled on `lib/deploy-form/deploy-form.ts`; wired as `envLoadMcpTool.formProvider` (`env-load.ts:528`).

- **`isFormable(params)`**: `isRecord(params) && (params.config === undefined || params.config === '')`.
- **`buildRequestedSchema(params)`**: `envs = await orEmpty(listProjectEnvs())`
  (`lib/project-envs/project-envs.ts:32`), statuses via `buildEnvTokenStatus` (`env-list.ts:30`). Empty
  → log `Tool execution form options empty: env-load`, return **`null`** (never `z.enum([])`). Otherwise:

  ```ts
  z.object({
    config: z.enum(names).describe(
      `The environment to load. ${tokenless.length === 0
        ? 'A service token is stored for every one of them.'
        : `NO stored token for: ${tokenless.join(', ')} — choosing one of those fails until you run \`infra-kit env-token-set <env>\`.`}` +
      ' The list is what env-list knows: workflow-declared environments first, then token-only ones.'),
  })
  ```

  `config` required; `listProjectEnvs` order; token annotation in the field `.describe()` (no
  per-option labels on the wire — measurements consequence 4; `gateMapProse` precedent
  `deploy-form.ts:200-206`).
- **`message`**: a getter — `` `Choose the environment to load into terminal session
  ${process.env.INFRA_KIT_SESSION ?? 'UNKNOWN — INFRA_KIT_SESSION is not set, the load will fail'}.
  Picking one LOADS it; there is no further prompt.` `` Δ2 (A-b): the body and the dialog both say the
  click IS the load. Δ2 (A-Q5): a getter because `envLoadMcpTool` is a module-scope constant — a plain
  string would freeze the id at import; production never changes it, tests set it after import. It
  satisfies `message: string` structurally.
- **`toArgs(content, params)`**: non-empty string `config` → `{ ...params, config }`; else `null`.

**Titled enum — V0.2 measurement, prose is the default.** Unchanged (follow-up only).

### 2.4 `env-load` tool changes (`commands/env-load/env-load.ts`)

- `inputSchema.config` → `z.string().optional()`; description and `.describe()` rewritten so neither
  matches `PROMISE` (`headless-policy-guards.test.ts:81`). Literals (also D18):
  - description tail: `Omit "config" and this server offers the human a form listing every environment
    env-list knows, token-less ones marked; a client that cannot render one gets a refusal naming the
    missing field — call env-list and ask the human, never guess.`
  - describe: `Doppler config / environment name to load (e.g. "dev", "arthur"). Omit it to have the
    human choose from a form.`
- Picker site (`env-load.ts:262-279`): `whenHeadless: 'unreachable'` → `'refuse'`; the
  `// MCP-unreachable:` comment goes (G8 requires a REQUIRED field behind `'unreachable'`).
- Before `withEscape` in the `else` branch: `if (isMcpMode()) throw new OperationError(undefined, {
  operation: 'env-load', remediation: 'call env-list, ask the human which environment, and re-call
  env-load with "config"' })`. Δ2 (A-§5 P2): the remediation names `env-list` verbatim (E-L3 asserts
  it) and does not say "form" — the seam owns that word. `'refuse'` stays as the G7 backstop.

### 2.5 Non-elicitation fallback for a missing `config` — **refuse, do not return the list**

Unchanged: a success-shaped list violates `outputSchema` or is the "success while nothing happened"
failure; the refusal matches D13's deploy-tool contract and names `env-list`, the single source.

### 2.6 Δ2 (Architect #3 / Critic #1, #3): Phase 1 rewrites the resource's §3 — the defect is fixed by C2

`resources/workflow/session.md` §3 (`:60-71`, the curating path) is rewritten in **C2** to:

> **A bare token is the environment name.** Call `env-load` with `config: <token>`.
> **No token means the human has not chosen yet.** Call `env-load` **without `config`**: the server
> offers the human a form listing every environment, and the human's pick IS the load. If the call comes
> back as a tool error or a refused result naming `config`, this client cannot render forms: call
> `env-list` and show **every** entry as a numbered prose list, `hasToken: false` annotated with
> `infra-kit env-token-set <env>`, then ask in prose which one. Never `AskUserQuestion`, never invent a
> name, never load without an explicit choice.

`server.test.ts:324-360`: `toHaveLength(119)` updated; add `expect(body).not.toContain('four most
likely')`, `expect(body).not.toContain('AskUserQuestion')`, `` expect(body).toContain('without `config`') ``.
C3 later DELETES the file and MOVES these clauses to U18 — a deletion, not a second rewrite, so "the body
is edited once" holds for the procedure text. C2 touches `resources/workflow/**`, which triggers
`plugin-ci.yml:16` including the PM-C step: it stays green (0.7.7 serves the URI; the command's floor is
0.5.2) — the trigger is not a reason to fold C2 into C3.

## 3. Phase 2 — skills without workflow resources

### 3.1 The three skills

| Skill | Frontmatter | Why |
|---|---|---|
| `skills/session/SKILL.md` | `name: session`, `description`, `argument-hint: [--clear] [<environment>]`, **`disable-model-invocation: true`**, `allowed-tools: mcp__plugin_infra-kit_infra-kit__env-list, mcp__plugin_infra-kit_infra-kit__env-load` — **zero `Bash(` rules** (A-S2) | Human-only: it loads secrets into the human's terminal. `env-load`/`env-list` are ungated and allowlisted. **Δ2 (Architect #6 / Critic #6): `env-clear` is NOT listed because the gate's round 2 is an agent-authored SAME-TURN re-call (`tool-handler.ts:186-188`) — a listed gated tool would let call 1 + call 2 run with no host prompt at all.** The host prompt on call 2 is the belt to the server's braces. |
| `skills/release-create/SKILL.md` | `name`, `description`, `argument-hint: [--hotfix] [--desc <text>] [<version\|next\|name>]`, **`disable-model-invocation: true`**, no `allowed-tools` | Human-only; gated — same reason as `env-clear`. |
| `skills/setup/SKILL.md` | `name: setup`, `description`, **no `disable-model-invocation` key** (U14' asserts absence, C-S-7), **no `allowed-tools`** | Model-invocable on purpose: its reader is the agent about to call `setup` (F1), so auto-loading replaces the deleted resource. Its human gate is `requiresHumanConfirm` + `anthropic/requiresUserInteraction` (`types.ts:95-100`), neither skippable by `allowed-tools`. Δ2: this is where the superseded setup-skill plan's `Bash(infra-kit init)` grant is explicitly NOT adopted. Always-on token delta: three new descriptions load into every session — re-measure README `:115`'s count after C3 (A-S5). |

Bodies: today's `resources/workflow/*.md` verbatim minus the "read the resource" preamble, plus:
"If `mcp__plugin_infra-kit_infra-kit__*` tools are absent this is a subdirectory or legacy session —
say so and stop." The legacy prefix is never named (T1 stays exact; U19).

### 3.2 `!` injection in the session skill

```markdown
Terminal status at invocation: !`zsh -c 'infra-kit env-status --json' 2>/dev/null || echo '{"error":"status unavailable"}'`
Environments this project knows: !`zsh -c 'infra-kit env-list --json' 2>/dev/null || echo '{"error":"list unavailable"}'`
```

- **Δ2 (Architect #5 / Critic #5) — corrected rationale.** The reading is NOT frozen: `~/.zshenv`'s
  session-env block runs for every zsh, `-c` included, and sources the file for the INHERITED
  `INFRA_KIT_SESSION` (F11); the MCP server inherits the same id, so the injection reads the file
  `env-load` wrote. `zsh -c` is kept because it makes the reading **independent of which shell the
  host's Bash tool is** (measured zsh 5.9 here; a `$SHELL=bash` or Linux host would otherwise skip
  `~/.zshenv`). The injected `sessionConfig` means **"what has LANDED for this session id"** — the
  terminal applies it at its next `precmd`, which cannot run while Claude Code is foreground.
- Δ2 (A-S4): the `|| echo` text is cause-agnostic — no `zsh`, no `INFRA_KIT_SESSION`, no `infra-kit` on
  PATH all read the same branch.
- Δ2 (C-S-2): both commands are metadata-only (F9); lane **SEC** pins that neither `--json` output
  contains any value from the fixture's `env-load.sh`.
- Inline code, not a fence — outside U6's corpus; the skills carry zero `Bash(` rules, so a future
  fenced `infra-kit …` line turns U6 red instead of becoming a grant (A-S2).
- The `env-list --json` line is what makes the non-form fallback a full prose list with no LLM in the
  loop. Body clause (pinned by U18): "if either block above is not JSON, treat it as unknown and call
  `env-list` yourself".

**What survives of the old §2.** Timing and Destination stay, compressed. The `env-status`-over-MCP
paragraphs collapse to: the injected block is the truthful reading of what has landed for this session
id at invocation; nothing in this turn can read the post-load state — the human confirms at their own
prompt. `{"error": …}` in the status block means stop before calling anything and tell the human to run
`infra-kit setup --skip-tools`.

### 3.3 The session body in `skills/session/SKILL.md`

§3 = the C2 text (§2.6) with one change: the fallback reads the injected `Environments this project
knows` block instead of calling `env-list` (calling it only when the block is not JSON). §4 unchanged
plus "a name absent from the form must still be typed and passed as `config`". §6 gains: "`env-load` is
not gated, but it can PROMPT — an argument form, not a confirm gate; the human's pick is the load." §7
gains two clauses: "Do not supply a `config` the human did not name in order to skip the form." and
**Δ2 (Architect #2): "Never send `inputResponses` yourself — that field is the human's answer, and the
server cannot tell yours from theirs."** Floor sentence: "the form path needs infra-kit `<next>` or newer;
an older server answers a tool error naming `config` — take the fallback".

### 3.4 Deletions from the CLI, with dependents (verified, F5–F7)

| Delete | Dependents to update |
|---|---|
| `resources/workflow/{session,release-create,setup}.md` | `plugin-ci.yml` path triggers (`:16-21`); `server.test.ts` clause tables → U18 |
| `src/mcp/workflow-bodies.ts` | `tool-prefix.test.ts:13,143-150`; `server.test.ts` imports |
| `src/mcp/resources/index.ts`: three `*_WORKFLOW_URI`, `registerWorkflow`, three registrations, the `renderForLaunch`/`toolName`/`WORKFLOW_BODIES` imports. **`CONFIG_RESOURCE_URI`/`DEV_CONTEXT_RESOURCE_URI` stay.** Δ3 (A-S7): `SESSION_WORKFLOW_URI` survives ONE release (`<next+1>`) as a 3-line string-constant deprecation stub (§3.6), removed in `<next+2>`. | `resources/__tests__/index.test.ts` (dev-context lanes stay) |
| `tool-prefix.ts`: `renderForLaunch`, `toolName` (keep `McpLaunch`, launch detection) | `tool-prefix.test.ts:110-195`; `generated-instruction-spelling.test.ts:105-115` (inline fixture string) |
| `scripts/check-workflow-resource-published.mjs`, `publish-gate.test.mjs`, the PM-C step + two path triggers in `plugin-ci.yml` — **Δ2 (A-S1, adopted by the lead): the script's stdio driver survives as `scripts/report-published-cli-skew.mjs`, a non-gating `continue-on-error: true` step (§3.6)** | `docs/session-context-orchestrator.md:14-41` — recipe now edits `skills/session/SKILL.md`; **Δ2 (Architect #7): step 4 becomes "if the change needs a newer CLI, bump the floor sentence in the SKILL.md and keep the fallback clause"** (no gate, but a floor); README rows `:36-37` (command → skill) and the counts at `:115` |
| `plugins/infra-kit/commands/` | `manifest.test.mjs`: §3.5 |
| `server.test.ts:147-360`; e2e `:346-367`, `e3p` (`:864`), `:1356-1373`, the authored resources-list delta (reverts to the v1 baseline); `resource-bundle.test.ts:55-73`; `server.ts:29-33` comment | — |

**Not deleted:** `src/md.d.ts`; `dev-context`/`config` resources; `tool-prefix.ts`.

### 3.5 `manifest.test.mjs` changes (plain node)

- **U3** `EXPECTED_SKILLS` += `release-create`, `session`, `setup`.
- **T1 stays exactly as written** (F2).
- **Delete** U13, U14, T1b, U17(flags), U17(legacy count), `LEGACY_PREFIX_ALLOWED`; **add**:
  - **U13'** `plugins/infra-kit/commands` does not exist.
  - **U14'** frontmatter key sets pinned per skill; `disable-model-invocation: true` on exactly
    `session` and `release-create` and **the key absent on `setup`** (C-S-7); `allowed-tools` names no
    gated tool (`release-create`, `env-clear`, `setup`, the four deploy tools, `worktrees-remove`,
    `release-remove`, `gh-merge-dev`) and carries **zero `Bash(` rules** on `session`/`release-create`
    (A-S2); `setup` has no `allowed-tools` at all.
  - **U17'** every `argument-hint` flag is defined with `→` in the SAME `SKILL.md`.
  - **U18** the session body: two injection lines, each at line start, `zsh -c`, outside any fence; the
    clause table from `server.test.ts` (`` without `config` ``, `form_declined`, "at its next prompt",
    "nothing is watching", session-id comparison, `--clear` → `env-clear`); the negatives (`four most
    likely`, `AskUserQuestion`); **Δ2 (Critic #10/#12): the PM-5 clause "not JSON, treat it as unknown"**;
    **Δ2 (Critic #4): the two-shape fallback phrase "a tool error or a refused result naming `config`"**;
    "never send `inputResponses` yourself".
  - **U19** the legacy prefix appears under `plugins/` only in T1's own literal (count 1).
- CLI side, `command-catalog.test.ts`: every `mcp__plugin_infra-kit_infra-kit__<name>` in
  `plugins/infra-kit/skills/**/SKILL.md` is an `mcpExposed` catalog tool.

### 3.6 Δ2 (Critic #8): release order — stated once

The plugin clock is the merge (F12); "CLI first" is producible **only** by publishing Phase 1 before
merging Phase 2. **Chosen: option (a).**

```
C1 → C2 → C4a (publish infra-kit <next>: config optional, resource §3 rewritten, form live)
   → C3 (skills + deletions, plugin.json bump) → C4b (publish infra-kit <next+1>: resources gone)
```

Windows and their survivability:

| Window | What happens | Guard |
|---|---|---|
| Old plugin + `<next>` CLI (between C4a and a consumer's `plugin update`) | `commands/session.md` reads the resource → present, rewritten §3 → the form path works from the old command. Δ3 (I2-C4): the old command has no `allowed-tools`, so the host prompts ONCE for `env-load` before the dialog. | C2's `server.test.ts` clauses |
| Old plugin + `<next+1>` CLI | Δ3 (A-S7, adopted): C4b keeps a **3-line deprecation stub** at `infra-kit://workflow/session` for ONE release — "this procedure moved to the `/infra-kit:session` skill; update the plugin; meanwhile: no token → call `env-load` without `config`, and on an error naming `config` list `env-list`'s rows in prose" — so the old command's first instruction still lands on the form path, not on the 404 fallback. `release-create`/`setup` URIs are deleted outright (their commands' fallbacks call the tool directly). The stub is a `registerResource` of a string constant, no `?raw`; RES asserts exactly one workflow URI in `<next+1>`. | RES (`<next+1>`) + U18 |
| Old plugin + `<next+2>` CLI (end state) | stub gone → resource 404 → the command's fallback clause (`env-list`, ask, `env-load`); the `AskUserQuestion` cap can bite again, but only for a consumer two CLI releases ahead of their plugin. | RES asserts the v1 baseline |
| New plugin + `<next>` CLI (the designed pairing) | skill → `env-load` without `config` → form. | E-L1/E-M1 |
| New plugin + `< next` CLI (stragglers who updated the plugin but not the global CLI) | `env-load {}` → JSON-RPC `-32602` (F13) → the skill's two-shape fallback → prose list from the injected block. **Mandatory-survivable; E-skew is its gate.** | E-skew (§6.4), U18 |

**Δ2 (A-c synthesis, lead-adopted) — what replaces the gate:** (a) the HEAD cross-check (§3.5) — tool
NAMES exist at HEAD; (b) the floor sentence + the two-shape fallback in each skill; (c)
`scripts/report-published-cli-skew.mjs`, the gate's stdio driver reduced to a **non-gating**
`continue-on-error: true` plugin-ci step: it runs `pnpm dlx infra-kit@latest mcp`, lists the published
`tools/list`, and prints, per skill, every plugin-prefixed tool the skill names that the published build
lacks, plus whether `env-load.inputSchema.required` still contains `config`. It reports skew; it never
blocks — the fast-clock/slow-clock antithesis is answered by visibility, not by a gate that reddens
unrelated plugin PRs. Δ3 (I2 rides): the report is written to `$GITHUB_STEP_SUMMARY` (so it is
readable on the PR without opening the log); the decision half is a pure, exported `collectSkew(publishedTools,
skillTexts)` unit-tested in `plugins/infra-kit/__tests__/skew-report.test.mjs` (the seam
`publish-gate.test.mjs` had, kept); and the plugin-prefixed-tool scan regex is ONE shared constant used by
`collectSkew`, U14'/U18 and the CLI-side cross-check, so the three cannot drift on what "names a tool" means. Residue: nothing PROVES the published CLI matches a merged skill; the fallbacks
are the mitigation.

## 4. Pre-mortem

| # | Scenario | Likelihood | Mitigation (testable) |
|---|---|---|---|
| **PM-1** (P1) | Claude Code 2.1.270 never renders the form over the legacy shim on an ungated tool. | Most likely, silent. | **Δ2: V0.1 is the pre-C1 go/no-go with the no-go outcome in §2.0**; E-L1/E-L2 (shim e2e); V0.3 (ungated live). |
| **PM-2** (P1) | Human picks a token-less env; the load fails after the choice. | Certain on a fresh clone. | Field prose (P4); `EnvAuthError` names `env-token-set <env>`; body says relay it, do not re-open the form; E-L1 is built on it. |
| **PM-3** (P1) | The dialog makes the load feel local to the terminal the human is looking at. | Common. | Form `message` names `INFRA_KIT_SESSION` and says the pick is the load (P7); the injected block shows the same id and means "what has landed for this session id" (Δ2 precision). |
| **PM-4** (P2) | The injection reads a stale or wrong-session value on a host whose Bash tool is not zsh, or after `env-clear`. | Plausible on Linux/`$SHELL=bash` hosts; not on this machine (F11). | `zsh -c` (§3.2, corrected rationale); U18 pins the spelling; **Δ2: V0.4's positive half only** — after an in-session load, the injected `sessionConfig` reads `dev`; the bare spelling's reading is RECORDED, not a criterion. |
| **PM-5** (P2) | The host ignores the hardening (older Claude Code; `disableSkillShellExecution` placeholder; "`!` needs a leading space"). | Plausible across the installed base. | Nothing safety-relevant rides on it (no gated tool in `allowed-tools`); **Δ2: the "not JSON → unknown, call `env-list`" clause is in U18**; V0.5 records the observations in `docs/reviews/session-env-picker-v0.md`. |
| **PM-6** (P2) | Skew: new plugin + old CLI, or old plugin + new CLI. | Certain for some window (F12). | §3.6 table; **Δ2: E-skew is decidable** — a captured fixture of 0.7.7's real `-32602` text plus the new refusal, both asserted to contain `config`; U18 pins the two-shape phrase. |

## 5. Execution — files, ordered commits, release

| Step | Files | Content |
|---|---|---|
| **V0.1 gate** (before C1) | `docs/reviews/session-env-picker-v0.md` (new) | Go/no-go per §2.0. V0.2 (titled enum) and **V0.6** (capture 0.7.7's `-32602` text via `pnpm dlx infra-kit@0.7.7 mcp`, read-only) run alongside. |
| **C1 `[BE] tool-handler: ungated form path`** | `tool-handler.ts`, `types.ts` (stale prose at `:88-90`), `tool-handler.ts:22-27` (C-S-4), `tool-handler.test.ts` | G1–G4 first, U1–U4; `'run-form'`; `form_discarded`; `StopResolution`; f0 rewritten; f-u1…f-u12 + f7c; matrix §6.1. No provider registered — AC2 pins that every existing lane passes unchanged. |
| **C2 `[BE] env-load: elicitation env picker`** | `src/lib/env-load-form/*`, `env-load.ts`, `headless-policy-guards.test.ts` (drop the `env-load` row + G6 expectation), `command-catalog.test.ts` (`EXPECTED_FORM_TOOLS`), `mcp-stdio.e2e.test.ts` (D17/D18, E-L1…E-M3, OBS, SEC, E-skew + fixture `fixtures/env-load-missing-config.0.7.7.json`), `mcp-harness.ts`, **`resources/workflow/session.md` §3 (Δ2 §2.6)**, `server.test.ts:324-360` | Phase 1 complete and defect-fixing. |
| **C4a `[DO] release: infra-kit <next>`** | standing lockstep flow (bump → publish config → re-pin → publish cli); plugin.json aligned | Consumers: `pnpm add -g infra-kit@<next>` (exact). |
| **C3 `[DO] plugin: workflow bodies become skills; workflow resources leave the CLI`** | `skills/{session,release-create,setup}/SKILL.md`, `commands/` (deleted), `manifest.test.mjs` (§3.5), `publish-gate.test.mjs` + gate script (deleted), `scripts/report-published-cli-skew.mjs` (new), `plugin-ci.yml`, README, `plugin.json` (U9), CLI deletions §3.4, `command-catalog.test.ts` cross-check, `docs/session-context-orchestrator.md`, `docs/reviews/session-env-picker-v0.md` (V0.4/V0.5 rows) | One commit: plugin tests and CLI tests pin each other's files. |
| **C4b `[DO] release: infra-kit <next+1>`** | standing flow | Workflow resources gone except the session deprecation stub (A-S7); plugin aligned. The stub's removal rides the NEXT ordinary release (`<next+2>`), no dedicated commit. |

## 6. Test plan

### 6.1 Unit — `resolveGateState`

Exhaustive 2⁷ partition against a reference table (asserts the ROW that matched, so U4's complement
condition is checked even though the code falls through). **Δ2 (Architect #1 / Critic #1) — mutation
matrix, every `!gated`/`gated` conjunct named with its observer:**

| Mutation | Effect | Lane that reddens |
|---|---|---|
| **Reorder: U1–U4 above G1–G4** (the only way `!gated` on U-rows becomes load-bearing) | an accepted form on a gated tool hits U3 → handler runs with no token; a gated no-provider call hits U4 → `run` on call 1 | **f4** (`:570`, accepted gated form must gate with a token), **f5** (`:587`, gated no-provider gates), **f2** (`:525`, url-only gated client gets the gate) — AC2 is what pins these |
| Delete `!gated` from U1 / U2 / U3 | inert by construction (G1–G4 consume every `gated` input first) | none — pinned as defence-in-depth by the 2⁷ table's reference rows; the reorder row above is the real guard |
| Delete `gated` from G1 | Δ3 (I2-C1): **inert** — an ungated formable first call returns `'form'` from G1 exactly as U1 would, and the re-entry never matches G1 (`responses !== undefined`); f-u4 is NOT an observer | 2⁷ table only (reference row names G1 vs U1) |
| Delete `gated` from G3 | every ungated call without responses gates | f0, f-u2, f-u3, f-u5 |
| Delete `gated` from G4 | `confirmed` ungated calls verify a token that cannot exist — unreachable (`confirm` stripped) | 2⁷ table only |
| Delete `!confirmed` from G1 | `gated ∧ confirmed ∧ formable ∧ canForm ∧ hasProvider` → a second form on round 2 | **f7c (new; Δ3 renamed from f-u13)**: `gated ∧ confirmed ∧ formable`, form-capable client → `verify`. Fills a PRE-EXISTING gap: f7 at `:727` carries `inputResponses` but its fixture's `formable`/`canForm` are not asserted, so today's row 2 `!confirmed` has no observer either |
| Delete `!confirmed` from G2 | a confirmed round 2 carrying a stale decline reads `declined` | f7 (`:727`) |
| G1 `canForm` / `hasProvider` / `formable` | (existing) | f2 / f5 / f8 |
| U1 `canForm` / `hasProvider` / `formable` / `responses === undefined` | | f-u2 / f-u5 / f-u3 / f-u4 |
| U2 `!accepted` / `hasProvider` | | f-u4 / f-u7 |
| U3 `accepted` | a decline executes | f-u6 |
| U4 second disjunct | | f-u7 |

### 6.2 Integration — `tool-handler.test.ts`

f0 → "ungated + provider whose `isFormable` is false → runs". New: f-u1 form offered; f-u2 URL_ONLY →
runs; f-u3 field supplied → runs; f-u4 accept → handler once with `{config:'stage',
confirmedCommand:true}`; f-u5 no provider → runs; f-u6 decline/cancel/missing → `form_declined`; f-u7
responses without provider → runs; f-u8 invalid accept → `form_discarded` with `tool` + `reason:
'validation'`; f-u9 narrowing (synthetic provider) → `reason:'narrowed'`; f-u10 `isFormable` throws →
runs; f-u11 schema null/deadline → runs + `form unavailable`; f-u12 each log line exactly once; **f7c**
(above — a gated-path lane, numbered with f7).

### 6.3 Provider — `env-load-form.test.ts`

P1 `isFormable` table; P2 `buildArgumentForm(...) !== null`, enum equals the fixture in order,
`required` = `['config']`; P3 empty → `null` + log; P4 describe names every token-less env and
`env-token-set`; P5 `toArgs` cases; **P6** every output parses under `z.object(envLoadMcpTool.inputSchema)`;
P7 `message` carries `INFRA_KIT_SESSION` and "there is no further prompt"; P8 `listProjectEnvs` rejects
→ `null`.

### 6.4 e2e — `mcp-stdio.e2e.test.ts`

Fixture: spawn `cwd` = a **`realpath`'d** (memory: `/var`→`/private/var`) `git init`'d temp dir with
`.github/workflows/deploy.yml` declaring `environment.options: [dev, stage, prod]`; `HOME` = temp home
with `.infra-kit/projects/<basename>/tokens.json` `{version:1, envs:{dev:'dp.st.dev.x'}}` (F16);
`INFRA_KIT_ENV_TOKEN` deleted. No PATH-stubbed `doppler` (A-Q4: it tests a stub).

| Lane | Client | Assert | Δ2: delete X → this lane reddens |
|---|---|---|---|
| E-L1 | bare 2025-era `Client`, `elicitation.form`, `setRequestHandler(ElicitRequestSchema, spy → accept {config:'stage'})` | spy exactly once; enum deep-equals `env-list`'s `configs`; `isError` matching `/env-token-set stage/` | `envLoadMcpTool.formProvider` wiring → spy never called (also `command-catalog.test.ts:696`) |
| E-L2 | same, decline | `form_declined`; spy once; no `env-load.sh` | `buildFormDeclined` on U2 → handler error text instead |
| E-L3 | `{elicitation:{url:{}}}` | spy never; `isError` naming `config` and `env-list` | the `canForm` probe → the shim's `legacyShimFailure` text (`mcp-DXXb3Vv3.mjs:561`) instead of our refusal |
| E-M1 | pinned 2026, `autoFulfill:false`, `allowInputRequired:true` | one `input_required`, one key, enum; re-call with `inputResponses` → `/env-token-set stage/` | the modern driver path |
| E-M2 | pinned modern, decline | `form_declined` | — |
| **E-M3** (Δ2, A-Q3) | pinned modern, hand-posted `inputResponses` accept with NO prior form, `config:'stage'`; and one with `config:'nope'` | first: `/env-token-set stage/` (handler ran — U3 reachability); second: `form_discarded`/`validation`, handler never (P6) | `readAcceptedArgs` schema validation |
| D17/D18 | tools/list baseline | `D12_REQUIRED['env-load'] = undefined`; `D13_PROSE['env-load']` literals | — |
| OBS | `LOG_FILE_PATH` growth, attributed as `e6` | E-L1: `form requested` + `form accepted`; E-L2: `form declined (decline)`; E-L3: neither | the `form accepted` log line → OBS |
| **SEC** (Δ2, C-S-2) | after a real load into the disposable session (fixture token + no doppler: use the E-L1 error path's cache, or a hand-written `env-load.sh` in the session dir) | `env-status --json` and `env-list --json` outputs contain no VALUE from `env-load.sh` | a value leak in either command |
| RES (Phase 2) | resources/list, both eras | Δ3: in `<next+1>` equals the v1 baseline PLUS exactly `infra-kit://workflow/session`, whose body is the 3-line stub (asserted `toContain('without `config`')` and `toHaveLength(3)` lines); `release-create`/`setup` URIs → not found. In `<next+2>` equals the v1 baseline exactly | any other workflow URI reintroduced; the stub growing past three lines |
| **E-skew** (Δ2, decidable) | fixture `fixtures/env-load-missing-config.0.7.7.json` (captured by V0.6: the JSON-RPC `-32602` message beginning `Input validation error: Invalid arguments for tool env-load:`) + the live refusal from §2.4 | both texts contain the literal `config`; Δ3 (Critic ride): the fixture is asserted to be the JSON-RPC ERROR shape (`error.code === -32602`) and the live refusal the RESULT shape (`isError: true`, `structuredContent` absent) — the two-shape phrase is pinned to two real shapes, not two strings | either text loses `config`, or either shape changes; U18 covers the body's phrase |

### 6.5 Plugin suite — `manifest.test.mjs`

U3, U2, U4, U5, U6, U12, T5 over the three new skills; U13', U14', U17', U18, U19; `claude plugin
validate --strict` (U1); U9 bump. **Δ2: delete X → lane:** `zsh -c` in an injection line → U18; a fence
around an injection → U6 (dead-rule clause 3 has no rule) + U18; `disable-model-invocation: true` on
`session` → U14'; the key appearing on `setup` → U14'; a `Bash(` rule on `session` → U14'.

### 6.6 Manual — V0 (recorded in `docs/reviews/session-env-picker-v0.md`; V0.2 also in `elicit-schema-measurements.md`)

- **V0.1 — go/no-go (§2.0)**: consumer repo, published plugin, Claude Code 2.1.270:
  `gh-release-deploy-all` omitting `env` → native dialog; tee `/tmp/mcp-infra-kit.log` filtered by pid,
  never printing `params`; record the negotiated protocol version.
- **V0.2** titled enum through `inputRequired.elicit()`.
- **V0.3** (after C2, before C4a) worktree `dist/mcp.js` under a temporary `.mcp.json`: `env-load` with no
  arguments → one dialog, every env, token-less marked, session id + "picking one loads it" in the
  message; decline → `form_declined`, no second dialog.
- **V0.4** injection: a project skill with the two §3.2 lines; load `dev`; re-invoke in the same Claude
  Code session; the injected `sessionConfig` reads `dev` (criterion). Also record what the BARE spelling
  reads (observation only — on this host it is expected to read `dev` too, F11).
- **V0.5** on 2.1.270: `/infra-kit:session` from the built plugin tree — injection fires at line start;
  no permission prompt on `env-load`; the elicitation dialog still appears with `allowed-tools` set (a
  form is not a permission — expected yes; the docs are silent); `/infra-kit:setup` auto-loadable,
  `/infra-kit:release-create` not.
- **V0.6** capture 0.7.7's `-32602` text for the E-skew fixture (`pnpm dlx infra-kit@0.7.7 mcp`, hand-rolled
  `initialize` + `tools/call env-load {}`).

## 7. Acceptance criteria

**Gate** — 0. V0.1 recorded as GO in `docs/reviews/session-env-picker-v0.md` before C1 is started (or
NO-GO with the §2.0 outcome taken).

**Phase 1** — 1. G1–G4 then U1–U4; the 2⁷ table and the §6.1 matrix green, including the reorder
row and f7c. 2. With no provider registered, every pre-change `tool-handler.test.ts` lane passes
unchanged (this is what pins the reorder mutation). 3. Form-capable client, no `config` → exactly one
`input_required` whose enum equals `env-list`'s `configs`, both eras. 4. Accept `stage` → handler once
with `config:'stage'`; decline → `form_declined`, handler never; url-only → refusal naming `config` and
`env-list`; hand-posted accept with no form → runs only with a known name, invalid → `form_discarded`
(E-M3). 5. Empty env list → no form + log + refusal. 6. Field prose names every token-less env; message
names `INFRA_KIT_SESSION` and says the pick is the load. 7. `env-load` stays allowlisted and ungated;
`EXPECTED_FORM_TOOLS` is five. 8. G6/G7/G8 pass with the `env-load` site on `'refuse'`. 9. D17/D18
declared and positively asserted. **9a (Δ2).** `resources/workflow/session.md` §3 carries `` without
`config` ``, and neither `four most likely` nor `AskUserQuestion`; Δ3 (Critic ride): it also carries the
two-shape fallback phrase "a tool error or a refused result naming `config`" — pinned in C2's
`server.test.ts` first, then moved to U18 by C3; line count updated.
**9b (Δ2).** SEC: no secret value in either `--json` output.

**Phase 2** — 10. `commands/` gone; the three skills exist with §3.1 frontmatter; `claude plugin validate
--strict` passes. 11. `resources/list` equals the v1 baseline plus only the session deprecation stub on
both eras (Δ3; the stub leaves in `<next+2>`). 12. `WORKFLOW_BODIES`,
`renderForLaunch`, `toolName`, `resources/workflow/`, the gate script, its test and its CI step no longer
exist; `report-published-cli-skew.mjs` exists as a `continue-on-error` step; `src/md.d.ts` and the
`config`/`dev-context` resources still exist. 13. Every plugin-prefixed tool named in a skill is an
exposed catalog tool. 14. U18's full clause table passes (injection spelling, negatives, PM-5 clause,
two-shape phrase, `inputResponses` clause). 15. Legacy prefix count under `plugins/` = 1. **16 (Δ2).**
V0.4: `sessionConfig` reads `dev` after an in-session load through the `zsh -c` spelling (the bare
spelling's reading is recorded, not judged). **17 (Δ2).** V0.5 observations recorded in
`docs/reviews/session-env-picker-v0.md`; `plugin.json` bumped. 18. E-skew green against the captured
0.7.7 fixture.

**Both** — 19. `pnpm run qa` at the root exits 0 (`; echo EXIT=$?`); `node --test
plugins/infra-kit/__tests__/*.test.mjs` exits 0.

## 8. Verification commands

```sh
cd /Users/arthur/projects/infra-kit/apps/infra-kit/cli && pnpm exec vitest run \
  src/lib/tool-handler src/lib/env-load-form src/lib/command-catalog src/lib/prompts src/lib/agent-guidance src/mcp ; echo EXIT=$?
cd /Users/arthur/projects/infra-kit && node --test 'plugins/infra-kit/__tests__/*.test.mjs' ; echo EXIT=$?
cd /Users/arthur/projects/infra-kit && claude plugin validate ./plugins/infra-kit --strict --json ; echo EXIT=$?
# Δ2 (C-S-5): a full qa REWRITES manifests + the vendor mirror — shasum before/after, diff before committing
cd /Users/arthur/projects/infra-kit && shasum pnpm-lock.yaml apps/*/*/package.json > /tmp/qa-before.sum ; pnpm run qa ; echo EXIT=$? ; shasum -c /tmp/qa-before.sum
cd /Users/arthur/projects/infra-kit/apps/infra-kit/cli && pnpm exec vitest run src/mcp/__tests__/mcp-stdio.e2e.test.ts ; echo EXIT=$?
pnpm add -g infra-kit@<exact-version> && infra-kit version --json
```

## 9. Stated residues

- **Client timeout vs shim timeout** (~5 min vs 600 s/leg): a timed-out form is a decline, not a retry.
- **No nested elicitation; `Elicitation` hooks can auto-answer.**
- **No blocking publish gate.** The skew report (§3.6c) shows drift; nothing blocks on it.
- **`allowed-tools` is turn-scoped.** The non-form fallback crosses a turn (ask → answer → `env-load`)
  and prompts once; the elicitation path does not.
- **Legacy `.mcp.json` launch** loses the procedures.
- **Titled enum**; **`version --json` injection** (A-Q8: fold `version` into `env-status --json` if a
  floor branch is ever needed, never a third spawn).

## 10. ADR

**Decision.** Phase 1: `env-load` collects a missing `config` through the argument-form chokepoint,
extended with an ungated path placed AFTER the unchanged gated rows (form → validated merged args → run;
decline → `form_declined`; discard → `form_discarded`; no form → the handler's refusal naming `config`),
and the resource's §3 is rewritten in the same phase. Phase 2: the three workflow bodies become plugin
skills — `session` and `release-create` human-only, `setup` model-invocable; `allowed-tools` only for
ungated tools; the session skill injects `zsh -c 'infra-kit env-status --json'` and `env-list --json`;
resources, `workflow-bodies.ts`, `renderForLaunch`, `commands/`, the blocking publish gate and their tests
go; a non-gating skew report replaces the gate. Release order: C1, C2, C4a, C3, C4b.

**Drivers.** Full-list correctness; one handler for both protocol eras; two clocks must degrade to
working fallbacks.

**Alternatives.** B (live `elicitInput`): throws on 2026-era requests. C (prose only): user decision;
kept as fallback. **Δ2: A′ (separate `resolveUngatedForm` wrapper before the gate, table untouched):
a second implementation of the came-back discriminator and decline/discard semantics — rejected in
favour of one table with the gated rows first.** Gating `env-load`: a confirm round-trip on a reversible
tool. Filtering token-less envs: hides the env the user must see. Embedding the list in the refusal:
duplicates `env-list`. M-B / M-C: resource hop kept / duplicate `/` rows. Bare `infra-kit env-status`
injection: host-shell-dependent. `disable-model-invocation` on `setup`: removes the agent surface the
resource provided while its human gate is already host- and server-side. The setup-skill plan's
`Bash(infra-kit init)` grant: predates `setup` as an MCP tool. Blocking skew gate kept: reddens unrelated
plugin PRs and has no object to pin once the resource is gone.

**Why chosen.** The seam exists and is measured; the only new semantics is "an accepted form on an
ungated tool runs", argued from "the answer is an argument, not consent" and pinned by P6/E-M3.
Skills are the documented direction (F10); `doctor` is the in-repo precedent for `allowed-tools`.

**Consequences.** Six states, eight rows with the gate on top; `resolveStop` returns a union; the
"only a gated tool can reach a form" doctrine is rewritten; **Δ2 (Architect #7): G8 loses only the
`env-load` `'unreachable'` row — the other `POLICY_SITES` rows stay (F17)**; ~425 lines of markdown move
to the plugin; the SKILL.md carries the CLI floor sentence and the orchestrator recipe bumps it (no gate,
a floor); plugin CI reaches npm only in a `continue-on-error` report; two CLI publishes bracket the
plugin merge; three always-on skill descriptions raise the per-session token baseline (re-measure
README `:115`).

**Follow-ups.** Titled enum (V0.2); the deploy providers' `message` carrying the session id; a
`form_discarded` reason for validation drift vs invalid content (needs cross-request state — RD says no).

## 11. Open questions for the Architect (iteration 2)

1. §2.1 ordering (gated rows first, U4 as fall-through with the 2⁷ table asserting its complement) —
   accepted as the A′ synthesis, or is the explicit `if` for U4 preferred at the cost of a dead final
   `return`?
2. `report-published-cli-skew.mjs` as a `continue-on-error` step is adopted per the lead; confirm the
   step's placement (after U9, so a plugin PR's report reflects the bump) and that its one npm fetch
   is acceptable on every plugin PR.
3. E-M3's second half (`config:'nope'` hand-posted → `form_discarded`) — keep as the P6 proof, or is
   P6's unit assertion sufficient?
4. C4a/C4b as two publishes: acceptable cost, or fold to one publish and declare "new plugin + old
   CLI" the guaranteed window (option b)?
