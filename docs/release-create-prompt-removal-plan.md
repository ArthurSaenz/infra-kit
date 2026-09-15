# `[DO]` release-create: retire the MCP prompt, keep the plugin command

**Status:** pending approval · ralplan `--deliberate` · 2026-09-14 · rev 3 · Architect + Critic passes applied · Critic verdict APPROVE

## 0. The defect

The Claude Code `/` menu shows the release procedure twice:

| Row | Source | Landed in |
|---|---|---|
| `/infra-kit:release-create` — *Cut one or more release branches through the infra-kit MCP server.* | plugin command `plugins/infra-kit/commands/release-create.md` | `f31db55` |
| `/infra-kit:release-create (MCP)` — *The procedure for cutting a release with infra-kit: preconditions, the two-call confirm protocol…* | MCP prompt `apps/infra-kit/cli/src/mcp/prompts/index.ts` (`server.registerPrompt('release-create', …)`) | `ba0a72f` |

Both serve `WORKFLOW_BODIES['release-create']`. The prompt was the human channel *before* the plugin
command existed; once the command landed, the prompt became a duplicate `/` row rather than a second
reader. `setup` and `session` already follow the target shape — resource-only, with a plugin
command/skill as the human surface — and `workflow-bodies.ts` says so in its own words: *"a second `/`
entry carrying the same text would be a duplicate of it rather than a second reader."*
`release-create` is the one workflow that still contradicts that sentence.

**User decision:** keep the command, remove the MCP prompt. ("only command and no mcp")

## 1. RALPLAN-DR

### Principles

1. **One `/` row per procedure.** A human picks the procedure from one place; the agent reads it from
   the resource. Two rows with one body is a UX defect, not redundancy.
2. **One constant, every channel.** `WORKFLOW_BODIES` stays the single source; removing a channel must
   not add a second copy of the prose anywhere.
3. **Decisions are pinned by tests, not comments.** The tests that today assert "exactly one prompt"
   must be replaced by tests that assert "no prompt channel" — a comment that says "deliberately none"
   is what let this duplicate ship in the first place.
4. **No vestigial wire surface.** Do not advertise a capability the server never exercises.
5. **Ship-ready means the row is gone on the user's machine**, which needs a published CLI and a
   refreshed global install — not just a green test run.

### Decision drivers

1. The plugin command is strictly more capable than the prompt: it accepts `$ARGUMENTS`
   (`--hotfix`, `--desc`, `<version|next>`), carries the no-resource-tools fallback and the
   "server not connected → stop" clause. The prompt takes no arguments by construction (argsSchema
   omitted, see `docs/release-create-command-plan.md` B4).
2. Consistency with `setup`/`session` (already resource-only + plugin surface).
3. Blast radius: the prompt has exactly one registration site, one unit test file, three wire tests
   in `server.test.ts`, and one differential-delta row (D1) in the e2e suite.

### Options

**A — Remove the prompt module AND the `prompts` capability (CHOSEN).**
Delete `src/mcp/prompts/`, drop `initializePrompts` + `prompts: {}` from `server.ts`, rewrite the
affected tests to pin the absence.
- Pros: no dead module, no advertised-but-empty capability (docs/mcp-stateless-migration-plan D1
  already called the empty capability "a capability we never exercise"); host stops issuing
  `prompts/list` at every connect; the absence is testable positively.
- Cons: `initialize.capabilities` changes shape → the e2e differential (w1b/D1) must be re-authored
  as a named, AUTHORED delta; slightly larger diff.

**B — Remove only the registration, keep `prompts: {}` capability.**
- Pros: e2e D1 untouched (`prompts: {}` → `{listChanged:true}` is what SDK v2 emits with zero prompts,
  exactly what shipped 0.3.16 did — plan F7). Smallest diff.
- Cons: no stub is needed (the SDK v2 `McpServer` constructor installs the `prompts/*` handlers from a bare
  `prompts: {}` on its own — `@modelcontextprotocol/server` dist `mcp-*.mjs:1351`), but that is the
  problem: `prompts/list` keeps answering `[]` forever for nothing, the host keeps asking at every connect,
  and the open slot invites "there's a slot, let's register something" — the exact path that produced the
  duplicate (`docs/release-deploy-command-plan.md:866-868` and `docs/session-command-plan.md:216` already
  read as instructions to keep/add prompts).
- **Invalidated by principle 4.** Kept only as the fallback if A's e2e re-authoring turns out to be
  disproportionate (it is ~15 lines; see §3.4).

**C — Remove the plugin command, keep the prompt.** Rejected: contradicts the user's decision and driver 1
(prompt cannot take arguments, cannot carry the fallback clauses).

**D — Rename the prompt so the two rows differ.** Rejected: still two rows, same text; violates
principle 1 and the repo's own `workflow-bodies.ts` rationale.

## 2. Scope

**In:** the CLI package's MCP prompt channel for `release-create`, its tests, the comments that describe
the two-channel pair, and a one-line supersession note in the plan docs that chose the prompt route.

**Out:** the plugin command (unchanged, no plugin version bump), `WORKFLOW_BODIES` bodies, the resource
channel, the `release-create` tool, the confirm gate, publishing itself (a follow-up `[DO] release`
commit in the usual lockstep flow).

## 3. Changes (all under `apps/infra-kit/cli` unless noted)

### 3.1 Delete the prompt channel
- `rm -r src/mcp/prompts/` (`index.ts`, `__tests__/index.test.ts`). Nothing else imports it
  (grep: only `src/mcp/server.ts:6`).

### 3.2 `src/mcp/server.ts`
- Drop `import { initializePrompts }` and the `await initializePrompts(server)` call.
- Drop `prompts: {}` from `capabilities`. Add a comment in its place: *no `prompts` — every workflow's
  human surface is a plugin command/skill; the agent surface is the resource. Registering a prompt here
  puts a second `/` row next to the command (this happened; see
  `docs/release-create-prompt-removal-plan.md`).*
- Leave `server.ts:11` (`every prompt guard in the process`) alone — that "prompt" is the inquirer/terminal
  guard (`src/lib/prompts`, `mcpMode`), not the MCP channel. Same for `resources/index.ts:39`.

### 3.3 `src/mcp/__tests__/server.test.ts`
- Remove: `serves prompts/get … arguments omitted`, `serves prompts/get … stray arguments`,
  `lists exactly one prompt…`, `serves byte-identical text through the prompt and the resource`.
- Remove the now-unused `promptText` helper (formatter prunes unused imports, not unused consts — delete
  it explicitly or lint reddens).
- Add, in the same `describe`: **`advertises no prompt channel and serves no prompt handler`** — two
  assertions, each pinning one half of Option A over Option B:
  1. `expect(client.getServerCapabilities()?.prompts).toBeUndefined()` — the handshake half
     (`@modelcontextprotocol/client` `dist/index.mjs:3372`).
  2. `await expect(client.getPrompt({ name: 'release-create' })).rejects.toMatchObject({ code: -32601 })`
     — the handler half. The client-side capability gate on `getPrompt` is strict-mode only
     (`dist/src-*.mjs:6066`; `connectedClient()` passes no `enforceStrictCapabilities`), so the request
     reaches the wire and the server answers `Method not found` (`server/dist/src-*.mjs:6401-6403`).
  **Never `listPrompts()`**: on a non-strict client it does NOT throw — it logs and resolves
  `{ prompts: [] }` (`client/dist/index.mjs:3558-3562`), which is byte-identical to what Option B returns,
  so an assertion on it cannot distinguish the chosen design from the rejected one.
  If `toMatchObject({ code: -32601 })` does not match the SDK's error class shape, the executor asserts
  `rejects.toThrow(/Method not found/)` and notes the class in the test comment — never a bare
  `rejects.toThrow()`.
- Keep `serves the same procedure as a markdown resource at its URI` and `renders a body…` unchanged —
  they are the resource channel's proof and are untouched by this change.
- Update the `setup` test's doc comment (`:223-224`, `Resource-only, deliberately: unlike release-create it
  is NOT registered as a prompt…`) — `release-create` is now the same shape; say "like every workflow".
- Update the `session` test's doc comment (`:300-301`, "pinned from the other side by the prompt-count
  assertion above") — that assertion is deleted; point at the new no-prompt-channel test instead.
- Update the file header comment (`so prompts/get, prompts/list and resources/read go through the SDK's
  own request path`) to drop the prompt methods.

### 3.4 `src/mcp/__tests__/mcp-stdio.e2e.test.ts` (w1 differential)
- D1 row in the delta table: `initialize.capabilities.prompts  {} -> absent   (AUTHORED: prompt channel
  retired, docs/release-create-prompt-removal-plan.md)   legacy + modern`.
- `w1b`: rename to *D1 — capabilities.prompts is gone; resources and tools are untouched*; assert
  `before.prompts` `toEqual({})` (baseline still had it), `after.prompts` `toBeUndefined()`, and the key-set
  assertion becomes `Object.keys(after).sort()` equals `Object.keys(before).filter(k => k !== 'prompts').sort()`.
  The differential's contract ("fails on any UNNAMED difference") is preserved because the difference is
  named in the row and asserted positively, same as D4/D12/D13.
- Mirror D4's re-capture guidance (`mcp-stdio.e2e.test.ts:1613-1619`) in the w1b comment: D1 now encodes
  two stacked changes (SDK `{}` → `{listChanged:true}`, then authored → absent) against a `before` state
  that no longer exists on any shipped build. If the v1 baseline fixture is ever RE-CAPTURED, DELETE D1
  entirely — row and test — and let the whole-object key comparison guard `prompts` directly; do NOT edit
  the literals to match. Only `:858` and `:1588-1601` depend on `capabilities.prompts`; `w1a:1521-1522`
  compares top-level result keys only, and the modern lane never reads `discover.capabilities`, so the
  fixture file itself is untouched.
- Line 327-330 (resource ↔ tool-name pairs) and 1233 (resource URI list) are the resource channel —
  unchanged.

### 3.5 Comments that describe the pair
- `src/mcp/workflow-bodies.ts` doc comment: replace the "`release-create` is additionally registered as a
  prompt…" paragraph with: every body is resource-only; the human surface for each is its plugin
  command/skill (`release-create`, `setup` commands; `session` skill); a prompt would be a duplicate `/` row.
- `src/mcp/resources/__tests__/index.test.ts:71-76` — "`release-create`'s prompt half" → drop the phrase.
- `src/mcp/resources/index.ts:20-21` — "the same body is also registered as a prompt (`src/mcp/prompts`)"
  names a path that no longer exists; rewrite as "the only server channel — the human surface is the
  `/infra-kit:release-create` plugin command". `:29` "Resource-only, unlike `release-create`" → "Resource-only,
  like every workflow".

### 3.6 Docs (repo)
- `docs/infra-kit-slash-commands-plan.md` — one line under the top **Iteration 4** banner:
  *Superseded 2026-09-14 for the prompt half: the MCP prompt was retired once the plugin command landed —
  see `docs/release-create-prompt-removal-plan.md`.* (The resource half stands.)
- `docs/release-create-command-plan.md` — same one-liner beside PR 3 / I2.
- `docs/release-deploy-command-plan.md:864-868` (§2.10 "`prompts/list` 1 → 2 … `argsSchema` stays omitted
  on both prompts") and `docs/session-command-plan.md:216` (invariant #5 "`prompts/list` still returns
  exactly `['release-create']`") — both read as live instructions to register or keep a prompt; add the
  same one-liner directly beneath each. `docs/archive/mcp/mcp-setup-dependency-plan.md:94` is a history table row —
  leave it. No other edits: plan docs are history, not living specs.

### 3.7 Memory (outside repo, my own)
- `mcp-prompts-humans-resources-agents.md`: the "register twice from one constant" consequence no longer
  applies when a plugin command is the human surface; the resource is the only server channel.

## 4. Pre-mortem (deliberate mode)

| # | It failed because… | Guard |
|---|---|---|
| 1 | The e2e differential was "fixed" by normalizing `prompts` out of both sides, so a future accidental re-add of the capability passes green. | §3.4 asserts `after.prompts` **undefined** positively and keeps `before.prompts` `{}`; the executor must not add `delete after.prompts`. Reviewer checks the diff for a `delete`/`omit` on `prompts`. |
| 1b | The unit pin was written against `listPrompts()`, which resolves `{prompts: []}` on a non-strict client — green under Option A **and** Option B, so a later `prompts: {}` re-add sails through. | §3.3 forbids `listPrompts()`; the pin is `getServerCapabilities().prompts` undefined **plus** `getPrompt` → `-32601`. Reviewer greps the new test for `listPrompts`. |
| 2 | Tests green, CLI published, but the user still sees the `(MCP)` row. | Consumer repos run the **global** install (`pnpm add -g infra-kit@latest` is a stale-cache hit — pin the exact version). Verification step §5.3 checks `infra-kit --version` by absolute path, then reconnects the server (`/mcp` → reconnect, or restart Claude Code). |
| 3 | The formatter/lint autofix pruned an import when `promptText` went unused, or `sonarjs` flagged an empty `describe` after the deletions, and `rtk`-filtered `vitest` reported exit 0 while red. | Run `pnpm run qa` in the CLI package **and** gate on the raw exit code (`; echo EXIT=$?`); run `eslint --no-cache` once; `git status` for `??` files. |
| 4 | A full root `pnpm run qa` silently REWROTE `apps/infra-kit/*/package.json`, `pnpm-workspace.yaml` or the `vendor/` mirror (recorded recurring hazard) — those show as ` M`, not `??`, and a `??`-only check misses them. | Before commit: `git diff --stat -- vendor/ apps/infra-kit/*/package.json pnpm-workspace.yaml` must print nothing; anything it lists is reverted, never committed with this change. |

## 5. Test plan

### 5.1 Unit (in-memory transport, `server.test.ts`)
- `advertises no prompt channel and serves no prompt handler` (new, §3.3) — the decision's pin.
- Existing resource tests stay green byte-for-byte (they never touched the prompt).

### 5.2 Integration / e2e (`mcp-stdio.e2e.test.ts`, real stdio child)
- w1b/D1 re-authored per §3.4 across both negotiated eras (`2025-06-18`, `2026-07-28`).
- Every other w1 delta unchanged — proves the removal touched nothing else on the wire.

### 5.3 Manual e2e (post-publish, user's machine)
1. `pnpm add -g infra-kit@<exact new version>` (not `@latest`), then
   `node ~/Library/pnpm/…/infra-kit/dist/cli.js --version` shows it.
2. `printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' | node <abs cli.js from step 1> mcp` → one JSON line, exit 0, `result.capabilities` has no `prompts` key. (Verified during review: a bare `initialize` + stdin EOF answers and exits in ~300 ms on both the workspace and the global build — no hang. Absolute path so the probe hits the binary step 1 checked, not whatever `infra-kit` resolves to.)
3. In Claude Code: reconnect the `infra-kit` server; type `/infra-kit:rel` — exactly one row, no `(MCP)` suffix.

### 5.4 Observability
- Nothing to add: the server has no log line for prompt registration today, and the absence is asserted
  at the handshake (5.3 step 2), which is the only place it is observable.

## 6. Acceptance criteria

- AC1 `src/mcp/prompts/` does not exist; `grep -rn 'registerPrompt\|initializePrompts' apps/infra-kit/cli/src` → 0 hits.
- AC2 `initialize` result carries no `capabilities.prompts` (unit + e2e, both eras), AND `prompts/get`
  answers `-32601` over the in-memory transport (unit). The new unit test contains no `listPrompts` call.
- AC3 `resources/read infra-kit://workflow/release-create` still returns `WORKFLOW_BODIES['release-create']` byte-for-byte.
- AC4 `plugins/infra-kit/**` diff is empty.
- AC5 Full CLI `pnpm run qa` exit 0 on the raw exit code; `pnpm run qa` at the root still passes `vendor check`;
  `git diff --stat -- vendor/ apps/infra-kit/*/package.json pnpm-workspace.yaml` prints nothing.
- AC6 After publish + global refresh: one `/infra-kit:release-create` row in Claude Code.

## 7. ADR

- **Decision:** retire the `release-create` MCP prompt and the server's `prompts` capability; the plugin
  command is the sole human surface, the MCP resource the sole agent surface.
- **Drivers:** duplicate `/` row; the command is strictly more capable; parity with `setup`/`session`.
- **Alternatives:** B keep-empty-capability (vestigial), C drop-the-command (reverses the user's call, loses
  `$ARGUMENTS`), D rename (still two rows).
- **Why chosen:** removes the surface rather than hiding it; the absence becomes a tested invariant.
- **Consequences:** `initialize` wire shape changes (one named delta); the memory rule "register twice
  from one constant" is narrowed to "resource once; a plugin command is the human channel".
- **Follow-ups:** `[DO] release` lockstep publish (config first, then re-pin, then CLI — per memory);
  refresh the global install with an exact version; the `manifest.test.mjs` U17 hint↔body binding is
  unaffected but worth a glance in the same PR.
