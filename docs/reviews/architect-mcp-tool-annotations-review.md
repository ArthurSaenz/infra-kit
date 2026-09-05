# Architect review — `docs/mcp-tool-annotations-plan.md` (§3 onward)

**Verdict: NEEDS REVISION** — blocking items 1–5 in §8 below.
Reviewer: Architect (read-only). Sections §1 (steelman antithesis) and §2 (tensions) were delivered
separately and are not repeated here.

All paths are relative to `apps/infra-kit/cli` unless prefixed with `docs/`.

---

## §3 — Semantic corrections (per-tool)

Three per-tool assignments in the plan's §5 tables do not survive contact with the sources: two are
outright wrong, one has a rationale that is wrong even though its value happens to survive. All three
were found by reading three command modules — which is itself the finding, since the plan applies its
"Ground truth (verified)" discipline to §3 (SDK shapes, fixture keys) but not to §5, where the actual
risk lives.

### E1 — ERROR. `env-token-list` — `openWorld` must be `true`

| | |
|---|---|
| **Plan's assignment** | `openWorld: false`, rationale *"reads the local token store; never calls Doppler"* |
| **Correct assignment** | `openWorldHint: true` |

**Evidence.**

- `src/commands/env-token-list/env-token-list.ts:5` — imports `probeEnvToken` (and `getDopplerProject`)
  from `src/integrations/doppler`.
- `src/commands/env-token-list/env-token-list.ts:115-131`:
  ```ts
  if (check) {
    const project = await getDopplerProject()
    …
    const probe = await probeEnvToken({
      childEnv: buildDopplerChildEnv(token),
      …
    })
    row.status = probe.outcome
  ```
- `src/commands/env-token-list/env-token-list.ts:173-176` — `check` is a field of the **MCP
  `inputSchema`**, not a CLI-only flag. Its own `.describe()` reads: *"Probe Doppler for each token's
  validity and scope (one cheap call per environment)."*
- `src/commands/env-token-list/env-token-list.ts:171` — the tool `description` states it in English:
  *"With check=true, also asks Doppler whether each token is valid and correctly scoped."*

This is an agent-reachable network call to an external peer, which is the definition `openWorldHint`
exists for. The plan's justification appears to have been taken from the description's trailing
"Read-only." while missing the sentence above it — read-only and closed-world are different
predicates, and this tool is the first and read-only but not the second.

### E2 — ERROR. `env-load` — the `ADDITIVE_ONLY` justification is factually false

| | |
|---|---|
| **Plan's assignment** | member of `ADDITIVE_ONLY` ⇒ `destructiveHint: false`, rationale *"additive only: writes a **new** script under the infra-kit cache dir; `env-clear` is the deletion op"* |
| **Correct assignment** | remove from `ADDITIVE_ONLY` (⇒ `destructiveHint: true`). Under S1 below the array disappears entirely and this resolves itself. |

**Evidence.**

- `src/commands/env-load/env-load.ts:192` — the function's own doc comment: *"Download Doppler secrets
  for a resolved config and **atomically write env-load.sh**"*.
- `src/commands/env-load/env-load.ts:212` — `const cacheDir = getSessionCacheDir()`.

The path is **deterministic per terminal session**, not a fresh file per call. Loading `dev` after
`prod` overwrites the previous `env-load.sh`. That is an *update*, not an append, which is precisely
the distinction `destructiveHint` encodes ("may perform destructive updates … as opposed to purely
additive").

Whether overwriting a cache artifact clears the destructive bar is arguable. The stated reason is not
arguable — it is wrong, and it is the only thing standing between `env-load` and
`destructiveHint: true`. Two further points push toward `true`:

- The plan's **P4** says *"Under-claiming risk is the dangerous error; over-claiming is merely noisy."*
  This is the tool where under-claiming bites hardest: the overwritten file defines the session's
  entire environment, and a re-source silently swaps it — the same argument-substitution shape the
  confirm-token work just closed off elsewhere.
- With `env-load` removed, `ADDITIVE_ONLY` has exactly one member (`worktrees-add`). A one-member
  hand-maintained safety array is weak justification for the whole opt-out mechanism, which is an
  independent argument for S1.

### E3 — FRAGILE RATIONALE. `worktrees-remove` — value defensible, reason wrong

| | |
|---|---|
| **Plan's assignment** | `openWorld: false`, rationale *"deletes local worktrees"* |
| **Correct assignment** | keep `false` **only** with the real rationale stated; or flip to `true` conservatively |

**Evidence.**

- `src/commands/worktrees-remove/worktrees-remove.ts:3` — imports `getReleasePRsWithInfo` from
  `src/integrations/gh`.
- `src/commands/worktrees-remove/worktrees-remove.ts:19` — imports `getJiraDescriptions`.
- `src/commands/worktrees-remove/worktrees-remove.ts:130`:
  ```ts
  const [descriptions, prInfo] = await Promise.all([getJiraDescriptions(), getReleasePRsWithInfo()])
  ```
  GitHub **and** Jira.

The call sits in the `else` branch at `:121-141`, reached only when neither `all` nor `versions` is
supplied — i.e. the interactive branch picker, which is TTY-only and therefore unreachable on the MCP
path. So `false` is correct *today*, but for a reason the plan does not state and that nothing
enforces. The day the picker becomes MCP-reachable, or someone adds a network call outside that
branch, the hint goes silently wrong. The row must carry the real reason, or take the conservative
value. (S3 below turns this from a comment into a check.)

### Adjacent correction worth landing in the same change

`src/lib/command-catalog/command-catalog.ts:515` — the `LOW_RISK_MUTATING_ALLOWLIST` justification for
`release-desc-edit` reads:

> *"Edits a GitHub release body only — reversible by re-editing; no git/branch/deploy side effect."*

"GitHub release body only" is wrong: `src/commands/release-desc-edit/release-desc-edit.ts:180` calls
`updateJiraVersion({ versionId, description })` and `:185` calls `updateReleasePRBody`. The plan's own
`destructiveHint: true` for this tool is better supported than the allowlist comment admits. §7.2
already edits adjacent lines, so this is a free fix.

### Minor wrinkle — `env-clear` idempotency rationale

`src/commands/env-clear/env-clear.ts:127` — the description ends *"**Errors** if no env is currently
loaded."* A second call raises rather than no-opping. `idempotentHint: true` is still defensible (an
error is not an effect on the environment), but the plan's stated rationale shape — borrowed from
`worktrees-remove`'s "has no further effect" — does not apply verbatim. One clause in the table.

### Confirmed correct — settled, no Planner action needed

| tool | plan's assignment | verified against |
|---|---|---|
| `release-desc-edit` | `destructive: true`, `idempotent: true`, `openWorld: true` | `release-desc-edit.ts:180` (`updateJiraVersion`), `:185` (`updateReleasePRBody`), `:32` (`buildPRBody` rewrites canonically ⇒ same text twice = same state) |
| `worktrees-add` | `destructive: false` (additive), `idempotent: true`, `openWorld: true` | `categorizeWorktrees` (`worktrees-add.ts:~278-289`) filters `selectedReleaseBranches` against existing worktree branches — existing worktrees are **skipped, not errored**; `createWorktrees` only ever runs `git worktree add`; `` $({cwd: worktreePath})`pnpm install` `` at `:301` ⇒ open-world |
| `worktrees-sync` | `destructive: true`, `idempotent: true`, `openWorld: true` | `getReleasePRs()` at `:45`; description at `:130` — *"Only removes — never creates"* |
| `worktrees-list` | `readOnly: true`, `openWorld: true` | Jira fix-version description in the output schema, `worktrees-list.ts:106`; description at `:97` |
| `version` | `readOnly: true`, `openWorld: false` | `version.ts` in full — reads `packageJson.version` and logs it. No registry check on this path |
| `audit` | `readOnly: true`, `openWorld: false` | `audit.ts:242-255` — an explicit comment documents that `--fix` / `--design` are unreachable through the MCP schema and that `mutating: false` holds only while that stays true |
| `config-get` | `readOnly: true`, `openWorld: false` | `config-get.ts:58` — *"Read-only introspection … use `config edit` (CLI-only) to modify"* |
| `env-status` | `readOnly: true`, `openWorld: false` | `env-status.ts:94` — *"Pure local introspection — makes NO Doppler call"* |
| `env-list` | `readOnly: true`, `openWorld: false` | `env-list.ts:147` — *"Not a live fetch from Doppler … never a live Doppler probe"* |
| `vendor-check` | `readOnly: true`, `openWorld: false` | `vendor-check.ts:120` — *"Self-contained (no source repo or config needed)"* |
| `dev-status` | `readOnly: true`, `openWorld: false` | `dev-status.ts:178` — reads on-disk fragments; the TCP liveness probe is loopback-only, which is closed-world |
| gated set (8) | `destructive: true` | `requiresHumanConfirm: true` confirmed at `env-clear.ts:128`, `gh-merge-dev.ts:602`, `gh-release-deploy-all.ts:139`, `gh-release-deploy-selected.ts:244`, `local-deploy.ts:497` and `:506`, `release-create.ts:393`, `worktrees-remove.ts:211` |

Structural counts also confirmed: `grep -c 'mcpExposed: true'` = **23**; `LOW_RISK_MUTATING_ALLOWLIST`
= 4 members (`release-desc-edit`, `worktrees-add`, `worktrees-sync`, `env-load`,
`command-catalog.ts:513-522`); read-only set = 11. The plan's distribution table is accurate.

`reopen` is treated in §2 (tension T-1) and §8 item 4, not here — its `readOnlyHint: true` is a
derivation consequence, not a table entry.

---

## §4 — Composition risks

### C1 — The plan's `src/mcp/tools/index.ts` edit **does** compose cleanly, but §7.4's diff is stale

The call site today (verified, `src/mcp/tools/index.ts:33-46`):

```ts
inputSchema: z.object(
  tool.requiresHumanConfirm === true ? withConfirmToken(tool.inputSchema) : tool.inputSchema,
),
outputSchema: z.object(tool.outputSchema),
},
wrapForRegistration(
  createToolHandler({
    toolName: tool.name,
    handler: tool.handler,
    requiresHumanConfirm: tool.requiresHumanConfirm,
  }),
),
```

**Direct answer: yes, it composes — no conflict.**

- `title` and `annotations` are sibling keys in the same config object literal that already holds
  `description` / `inputSchema` / `outputSchema`. Adding two keys does not interact with either helper.
- `withConfirmToken` (`:51-59`) is a `ZodRawShape → ZodRawShape` function operating on
  `tool.inputSchema` only. It never sees or rewrites the config object.
- `wrapForRegistration` (`:61-65`) adapts the handler's `(params, ctx)` signature. It is the third
  positional argument to `registerTool`, entirely outside the config object.
- `RegistrableMcpTool extends CatalogMcpTool` preserves `requiresHumanConfirm`, which the loop still
  reads at `:34` (schema branch) and `:44` (gate wiring). Widening the return type is additive.

What is wrong is the *presentation*: §7.4 prints a plain `inputSchema: z.object(…)` and an unwrapped
`createToolHandler({ … })`, and calls itself *"The only registration change — two added properties,
inside the existing loop."* An implementer diffing against that will not find the lines. Re-render it.

### C2 — `getExposedMcpTools()` will return spread copies, not the catalog's `mcpTool` object identities

Assembling `{ ...entry.mcpTool, title, annotations }` inside the catalog changes object identity.
Nothing I found depends on it:

- `src/mcp/__tests__/mcp-stdio.e2e.test.ts:849` reads `.name` and `.requiresHumanConfirm` only.
- `src/lib/command-catalog/__tests__/command-catalog.test.ts` walks `commandCatalog` entries directly
  for the default-deny and allowlist-hygiene tests (`:233`, `:266`), and reads names elsewhere.
- `handler` survives as a reference through the spread, so dispatch is unaffected.

Non-blocking. But §7.2 should state it, so nobody later writes an identity comparison against
`entry.mcpTool`.

### C3 — §7.3 exports have no consumer

`src/lib/command-catalog/index.ts` currently re-exports the values
`{ commandCatalog, getExposedMcpTools, getMenuGroupEntries, isLongRunningCommand, MENU_GROUPS }` and
the types `{ CommandCatalogEntry, MenuGroup }`. **`CatalogMcpTool` is not re-exported today**, and
`src/mcp/tools/index.ts:4` imports only the `getExposedMcpTools` *value* — the element type is
inferred. So `RegistrableMcpTool` / `McpToolAnnotations` would be exported to nobody. Name a consumer
or delete §7.3.

### C4 — the boot-time throw has a larger blast radius than §7.2 frames

§7.2 proposes throwing on a missing `MCP_TOOL_PRESENTATION` entry, arguing *"The catalog is loaded by
every CLI invocation, so this is a boot-time failure that CI catches on the first run."* That sentence
is the problem, not the reassurance: `command-catalog.ts` is imported by every command path, so a
table typo takes down **every CLI command**, not just MCP registration.

T1 and T3 already fail in CI on a missing entry, which makes the throw redundant there; its only
marginal value is at runtime, where its cost is maximal. Either drop the throw and rely on T1/T3, or
move it inside `getExposedMcpTools()` so only the MCP server dies.

### C5 — no bundle-guard risk

The plan's R7 mitigation (structural mirror of `ToolAnnotations` rather than importing the SDK type)
is correct and keeps `command-catalog.ts` SDK-import-free, so `u6`/`u7` are untouched. Confirmed: the
catalog's only type import today is `ToolsExecutionResult` from `src/types`.

---

## §5 — The section that is now false against the working tree

**§9, risk R3** — and its restatement as **§10 Follow-up #1**. The false sentences, verbatim:

> **R3 — the argument-binding defect is mistaken for mitigated.**
> `src/lib/tool-handler/tool-handler.ts`'s confirm gate does **not** bind arguments: `resolvedArgs` is
> a pure echo, so approving `env:dev` and re-calling with `confirm:true` and `env:prod` executes prod.

> **Follow-ups (not this ticket).**
> 1. Bind arguments in the confirm gate (`tool-handler.ts` `resolvedArgs` is a pure echo — approving
>    `env:dev` then re-calling `env:prod --confirm` deploys prod). Independent of this work.

Both are stale. `src/lib/tool-handler/confirm-token.ts` exists in the working tree and implements
exactly the binding R3 says is absent:

- `createRequestStateCodec` from `@modelcontextprotocol/server` (`:1`), HMAC-backed.
- `ConfirmCodec` = `{ mint(payload, toolName), verify(token, toolName) }` (`:29-32`) — bound to the
  tool name.
- `ConfirmPayload.args` is the **canonical** JSON of the arguments, via `sortKeysDeep` (`:47`).
- `GATE_KEYS = new Set(['confirm', 'confirmToken'])` (`:19`) — gate-owned keys excluded from the
  signed set.
- `CONFIRM_TOKEN_TTL_SECONDS = 600` (`:22`).
- `ConfirmRefusal = 'absent' | 'malformed' | 'mac' | 'expired' | 'bind' | 'mismatch'` (`:34`).
- The fileoverview (`:12-16`) cites the *same* `env:dev` → `env:prod` substitution hole R3 describes,
  as **closed**.

This is blocking. An approved design document that asserts a live security defect which is already
fixed is worse than silence: the next reader either re-fixes it or discounts the document's other risk
claims. R3's *substance* — annotations are advisory metadata that no part of the gate reads, so this
work mitigates nothing about the gate — remains true and worth keeping, folded into **P1**. Only the
false premise and Follow-up #1 must go.

---

## §6 — Judgement on the D10/D11 fixture-delta approach

**Sound, and the right call — with one caveat that must be written down.**

The D9 precedent reads exactly as the plan describes (`src/mcp/__tests__/mcp-stdio.e2e.test.ts:843-880`):
`gatedToolNames` computed from `getExposedMcpTools()` rather than a literal list; `d9Carriers(list)`
proving the key sits on exactly the gated set; `withoutD9` deleting from a `JSON.parse(JSON.stringify(…))`
deep copy; and the negative half asserted separately in `w1c-pre-d9` (`:1241`). The in-file comment at
`:843-848` states the discipline explicitly — *"so the strip can never be what makes w1c pass."*

D10 (`title`) and D11 (`annotations`) map onto that one-for-one. They are in fact **simpler** than D4
and D9, which reach into `inputSchema.properties`; D10/D11 delete top-level keys from the served tool
object.

**Leaving the fixture byte-identical remains correct, and D9's existence strengthens the case rather
than weakening it.** The file's own comments (`:820-829`) give three reasons that all still hold:
re-capturing destroys evidence taken *before* any dependency change; adding the affected tools to
`SOURCE_CHANGED_DURING_MIGRATION` would leave the most destructive tools permanently unguarded by W1;
and 23 − 3 = 20 trips the `toBeGreaterThan(20)` suite-swallowing guard. With D4 and D9 already in
place, a third and fourth authored delta is a precedent being *followed*, not an improvisation — which
is the strongest available argument for not re-capturing.

**The caveat.** After D10/D11 land, `w1c` and `w1e` compare **nothing** about the new metadata surface.
The whole-object property — the reason the fixture is load-bearing at all — does not extend to the
change this plan makes. T6 becomes the sole e2e guard for annotations. T6 is genuinely
non-tautological (served JSON across a process boundary vs. `commandCatalog` read in-process — two
independent sources), so this is acceptable. But §7.1 currently leaves a reader to infer that `w1c`
covers annotations. It must say plainly that it does not, and that T6 is the guard.

**Housekeeping.** The delta legend at `:790-797` lists D1–D8 and is **already missing D9**. Whoever
lands D10/D11 should add all three lines.

---

## §7 — Synthesis: the concrete improved shape

### S1 — Ship three hints, not four; delete `ADDITIVE_ONLY` entirely

Ship `title`, `readOnlyHint`, `openWorldHint`. **Omit `destructiveHint` and `idempotentHint` from
every tool.**

Per the spec, an omitted `destructiveHint` on a tool whose `readOnlyHint` is `false` **defaults to
`true`**. That default is:

- exactly what the plan wants for all 8 gated tools;
- exactly what the plan wants for `release-desc-edit` and `worktrees-sync`;
- P4's conservative value for `env-load` — which E2 shows should read destructive anyway.

The only tool this "costs" is `worktrees-add`, which would read destructive when it is additive. Over-
warning on one tool has no demonstrated cost on any host the plan measured.

**What it buys.** Deletes the plan's own worst drift vector (`ADDITIVE_ONLY`, a hand-typed per-tool
safety override — the exact artifact §4 condemns Option B for). Removes the `idempotent` column and
every contestable idempotency judgement (`env-clear`'s error-on-second-call, `release-desc-edit`'s
write-same-text). Cuts `MCP_TOOL_PRESENTATION` to `{ title, openWorld }`. Kills T4 and half of T5.

**What it keeps.** The user's stated motivation, in full. After this change, a client reading nothing
but `tools/list` sees `readOnlyHint: false` plus destructive-by-default on every write, and
`readOnlyHint: true` on every read. That *is* the protocol-level visibility of destructiveness that was
asked for. If an explicit `destructiveHint: false` for `worktrees-add` is wanted later, add it then,
against a host measured actually reading it.

### S2 — One named exception set for `readOnlyHint`, instead of shipping a hint the authors believe is false

```
readOnlyHint = !entry.mutating && !NOT_READ_ONLY.includes(name)

/** Tools that modify machine state the catalog's `mutating` predicate deliberately excludes. */
NOT_READ_ONLY = ['reopen']   // spawns editor/cmux windows; `force` closes workspaces first
```

T2 becomes `readOnlyHint === (!entry.mutating && !NOT_READ_ONLY.has(name))` — still exception-free at
the assertion level, still one place, still hand-drift-proof.

This resolves R4 without touching gate semantics, and it deletes Follow-up #2, which proposed editing
`LOW_RISK_MUTATING_ALLOWLIST` (a *gate* artifact) in order to correct a *protocol label*. It also
restores P4 compliance: the spec default for `readOnlyHint` is `false`, and `reopen` is the one tool
the plan itself calls an over-claim.

### S3 — Make `openWorldHint` mechanically checkable, since it is the one hint nothing derives

Add a static-import test in the shape of the existing bundle guards (`u6`/`u7` in
`src/mcp/__tests__/dependency-and-bundle-guards.test.ts` are already assertions of this kind): for
every tool declared `openWorld: false`, assert its command module's transitive import set contains no
`src/integrations/{gh,jira,doppler,aws}` module.

This would have caught **E1** mechanically — `env-token-list.ts:5` imports `probeEnvToken` from
`src/integrations/doppler` in plain sight. It also permanently guards **E3**: the day
`worktrees-remove`'s picker path becomes MCP-reachable, the hint fails loudly instead of silently.

Without something of this shape, §4's argument for Option C over Option A — that declared hints "carry
real information" — is unbacked, and E1/E2 are the evidence for that.

### S4 — If the four-hint shape is kept instead of S1

Fold `ADDITIVE_ONLY` into `MCP_TOOL_PRESENTATION` as a `destructive?: boolean` column, so there is
**one** declared-facts table rather than a table plus a parallel array. Keep the one-line-justification-
per-member discipline of `LOW_RISK_MUTATING_ALLOWLIST`, and add a doc line stating the column is the
sole hand-typed safety override in the file. §5's point that allowlist membership ≠
`destructiveHint: false` argues for one table with a destructive column, not for two lists.

---

## §8 — Required revisions

### Blocking

1. **Rewrite §9 R3 and delete §10 Follow-up #1.** The confirm gate now binds arguments —
   `src/lib/tool-handler/confirm-token.ts` (HMAC over canonical args via `createRequestStateCodec`,
   bound to tool name, 600 s TTL, refusals `absent|malformed|mac|expired|bind|mismatch`). Keep R3's
   substance — annotations are advisory and mitigate nothing about the gate — folded into P1; drop the
   false premise and the follow-up.

2. **Change `env-token-list` to `openWorld: true`** in §5's read-only table, and replace the rationale
   with: *"`check=true` probes Doppler once per environment (`env-token-list.ts:115-131`,
   `probeEnvToken`); the flag is in the MCP inputSchema."*

3. **Remove `env-load` from `ADDITIVE_ONLY`** (or adopt S1, which deletes the array). Its §5 rationale
   is factually wrong: `env-load.ts:192,212` atomically overwrites a deterministic `env-load.sh` under
   `getSessionCacheDir()` — an update, not an append. Note in the plan that this leaves `ADDITIVE_ONLY`
   with one member.

4. **Resolve `reopen`.** Either adopt S2's `NOT_READ_ONLY = ['reopen']`, or state explicitly in R4
   that the plan ships a `readOnlyHint` its authors believe is false, and argue why P4 ("keep the spec
   default" — the default here is `false`) does not apply. Deferring silently to Follow-up #2 is not
   acceptable, because that follow-up fixes a protocol label by editing gate policy.

5. **Decide S1 vs. the four-hint shape on the record**, judged against §6's own evidence standard —
   §6 cuts `icons` for "zero measured host benefit" while `annotations` ships with no host measured
   reading them. If the four-hint shape is kept, **S3's static-import check must land with it**;
   otherwise `openWorldHint` and `idempotentHint` have zero verification and this review found two of
   them wrong.

### Non-blocking, but fix before handing off to implementation

6. **Restate `worktrees-remove`'s `openWorld: false` rationale** as *"GitHub + Jira are reached only on
   the interactive picker path (`worktrees-remove.ts:121-141`), which is TTY-only and unreachable via
   MCP"* — or flip the value to `true` conservatively.

7. **Re-render §7.4's diff** against the real `src/mcp/tools/index.ts:33-46` — `withConfirmToken` inside
   `inputSchema`, `wrapForRegistration` around the handler — and drop the "the only registration change"
   framing. (The change itself composes cleanly; only the printed diff is stale.)

8. **§7.3:** name a consumer for `RegistrableMcpTool` / `McpToolAnnotations`, or delete the section.
   `CatalogMcpTool` is not currently re-exported from `src/lib/command-catalog/index.ts` and nothing
   imports the element type by name.

9. **§7.2:** note that `getExposedMcpTools()` will return spread copies rather than the catalog's
   `mcpTool` object identities.

10. **§7.2 / C4:** move the missing-presentation-entry failure out of module scope, or scope the throw
    inside `getExposedMcpTools()`. As written, a table typo breaks every CLI command, not just MCP
    registration; T1/T3 already cover it in CI.

11. **§7.1:** state that after D10/D11 the `w1c`/`w1e` differential no longer covers annotation content
    and T6 is the sole e2e guard. Add **D9, D10, D11** to the delta legend at `mcp-stdio.e2e.test.ts:790-797`
    (D9 is already missing from it).

12. **§5 / §10 wording:** change "derive the safety hints" to "derive `readOnlyHint`"; acknowledge that
    Option C declares 3 of 4 hints, and that T2 and T4 are refactor detectors rather than correctness
    tests (each asserts the formula that produced the value).

13. **Add an `env-clear` idempotency clause to §5:** the second call errors (*"Errors if no env is
    currently loaded"*, `env-clear.ts:127`) rather than no-opping. `true` remains defensible, but the
    rationale differs from `worktrees-remove`'s "has no further effect".

14. **Fix `command-catalog.ts:515`** while §7.2 is open: the `release-desc-edit` allowlist comment says
    "Edits a GitHub release body only" — it also overwrites the Jira fix-version description
    (`release-desc-edit.ts:180`).
