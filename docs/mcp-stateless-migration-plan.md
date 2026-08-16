# MCP v1 → v2 migration & 2026-07-28 ("stateless") protocol adoption

**STATUS: pending approval — no execution authorized.**
No file in this repo may be modified on the basis of this document until the user approves it.

Mode: `ralplan --consensus --deliberate` (high-risk: this ships to npm as `infra-kit`).
Ground truth: `scratchpad/mcp-facts.md` — sections **G, H, I, J, K, L, M, N, O, P** are verified
corrections that supersede earlier sections of that brief and are treated as authoritative here.
**§P is the newest and most authoritative**; it was measured head-to-head against a real Option-E
server after the Critic's review and supersedes any earlier wire claim, including the Critic's own.

Revision 3 (post-Critic APPROVE-with-conditions). Conditions C1–C8 are applied; §9 lists their exit
checks. **The chosen option changed in revision 2: B → E.** Revision 3 does not change the option;
it corrects the wire claim, strikes Phase 6b, and hardens the test lane.

---

## 0. The premise, stated honestly

The user's request was: *"MCP went stateless — move our MCP to the latest version that supports it."*

That premise is **half right**, and the plan is only defensible if we say which half.

| Claim | Verdict | Evidence |
|---|---|---|
| MCP officially went stateless | **Correct** | Spec revision `2026-07-28` removes the `initialize`/`initialized` handshake; protocol version + clientInfo travel in `_meta` per-request; no `Mcp-Session-Id`. |
| There is a newer version of our dep to update to | **Incorrect** | `@modelcontextprotocol/sdk` dist-tag `latest` = **1.30.0**, published 2026-07-27. We depend on `^1.30.0`. **We are already on the newest release of the package we depend on.** |
| A version bump gets us statelessness | **Incorrect** | v2 shipped as a **package split** (`@modelcontextprotocol/server` / `core` / `client`, all `2.0.0`). The 2026-07-28 support guide is explicitly scoped *"for code already on the v2 packages"* — **v1 can never speak 2026-07-28.** |
| "Stateless/serverless" buys us scaling | **Not for us** | Stateless-HTTP (`sessionIdGenerator: undefined`, `createMcpHandler`) is about horizontally-scaled HTTP endpoints. Our MCP is **stdio, spawned per client as a child process** (`src/commands/mcp/mcp.ts`). One process serves exactly one client. Statelessness buys us **zero** scaling. |

So "update to the latest version with stateless support" necessarily means a **package migration**, not a version bump.

Two things follow, and the plan turns on the second one:

1. Migrating packages is worth doing on its own merits — **93 transitive packages → 3** in the
   published `dependencies` closure of a *globally installed* CLI (§F of the brief), plus it is the only
   line that can ever serve 2026-07-28.
2. Migrating packages and **turning the 2026 protocol on** are separable, and they have wildly
   different risk. Nothing puts a 2026-07-28 byte on the wire until we call
   `serveStdio(() => buildServer())` from `@modelcontextprotocol/server/stdio`. Revision 1 bundled
   both into one release. Revision 2 split them, and this revision keeps them split.

---

## 0b. Known and accepted wire deltas (measured, §P)

This table is the corrected replacement for every earlier "zero new bytes on the wire" claim. It was
produced by building a real v2 Option-E server (`@modelcontextprotocol/server@2.0.0` + `zod@4.4.3`,
hand-wired `new StdioServerTransport()` + `server.connect()`) declaring the **same** capabilities as
`src/mcp/server.ts`, and probing it head-to-head against our shipped `dist/mcp.js`.

| # | Surface | v1 (shipped today) | v2 (Option E) | Assessment |
|---|---|---|---|---|
| **D1** | `initialize.capabilities.prompts` | `{}` | `{"listChanged": true}` | v2 auto-declares `listChanged` from the same bare `prompts: {}` input. `src/mcp/prompts/index.ts` registers **zero** prompts, so we advertise a capability we never exercise. Harmless, but it is a wire change. |
| **D2** | `$schema` on every tool `inputSchema`/`outputSchema` | `http://json-schema.org/draft-07/schema#` | `https://json-schema.org/draft/2020-12/schema` | A JSON Schema **dialect URI** change across 23 tools × 2 schemas. |
| **D3** | `tools[].execution` | `{"taskSupport":"forbidden"}` on **all 23** | **absent on all 23** | v1's `registerTool` hard-codes the block; v2 emits none. **Inert:** v1's own `ToolExecutionSchema` documents that an absent block DEFAULTS to `"forbidden"`, so the advertised semantics are unchanged. |

**A fourth difference that is NOT a delta: JSON key ORDER.** v2 serializes object keys in a
different order than v1 (e.g. a tool's `inputSchema` goes `$schema,type,properties` →
`type,$schema,properties`, and the tool object loses `execution` from the middle). Measured across
all 22 comparable tools: **key-order-only differences 22, real content differences 0.** Key order
carries no meaning in JSON and no MCP client can depend on it — every payload is parsed into an
object before anything reads it. This is why W1 compares with `toEqual` (structural, order-
insensitive) rather than string equality, and why the claim below says the payloads are identical
rather than literally byte-identical. Anyone re-running a raw `JSON.stringify` diff will see 22
"differences" that are nothing of the sort — canonicalize key order first.

**Non-delta (the reassuring part, also measured).** Both servers declare the same
`capabilities: { resources: {listChanged: true}, tools: {}, prompts: … }` — `resources` and `tools`
are **identical**. Schema **body** conventions are identical: `type: 'object'`, `properties`,
per-property `type` + `description`, `required: [...]`, `additionalProperties: false`, optional fields
omitted from `required`. **The change is confined to the dialect URI, not to schema semantics.**

> **D3 was found by the completion reviewer, not by the first cut of W1.** The original W1c
> compared three hand-picked fields per tool (`description`, `inputSchema`, `outputSchema`) and was
> therefore structurally blind to a field being ADDED or REMOVED — which is exactly what D3 is. The
> lesson is in the test now: W1c does a WHOLE-OBJECT comparison with only the known deltas
> normalized away, plus key-set assertions on `initialize` and `tools/list`. A guard that names the
> fields it checks can only ever find the drift you already imagined.

**The sentence this plan uses everywhere (§1, §7, §9):**

> Release 1 changes exactly three things on the wire, all measured and all asserted by W1:
> (D1) `initialize.capabilities.prompts` gains `listChanged: true` — v2 auto-declares it from the
> same bare `prompts: {}` input; (D2) every tool's `inputSchema`/`outputSchema` re-serializes from
> JSON Schema `draft-07` to `draft-2020-12`; and (D3) the `tools[].execution` block
> (`{"taskSupport":"forbidden"}`) is no longer emitted, which is inert because an absent block
> already defaults to `"forbidden"`. Schema semantics — properties, types, descriptions, `required`,
> `additionalProperties` — are unchanged, and everything else in `initialize`, `tools/list` and
> `resources/list` is byte-identical. W1 asserts all three deltas POSITIVELY, compares whole objects
> rather than named fields, and blocks the release on any fourth difference.

**Why "positively" is load-bearing.** W1 must assert that D1's and D2's *new values are present*, not
normalize them away. A normalization that swallows D1/D2 is the same hole a third, unnoticed delta
would slip through. Only `serverInfo.version` is normalized, because it changes on every release bump.

**Residual unknown — do not assert either way.** Whether v2's `~standard.jsonSchema` path emits
byte-identical output to `z.toJSONSchema(schema, { target: 'draft-2020-12' })` for our shapes.
**Do NOT pre-assert this in the plan or in a test.** W1 is what establishes v2's actual output; it
compares against the captured v1 baseline plus the two named deltas, not against a re-derivation.
Whether any host branches on the `$schema` URI or on `prompts.listChanged` is answered by Phase 6.

---

## 1. RALPLAN-DR

### Principles

1. **Confidence is the deliverable, not the migration.** The user wants to ship a release without fear. A migration that lands but cannot be proven working is a net negative.
2. **Compatibility beats modernity.** Our MCP server exists to be *reachable by hosts*. A more modern server no host can talk to is strictly worse than an old one every host can.
3. **No false greens.** Per SDK docs, `InMemoryTransport.createLinkedPair()` connects 2025-era instances only — a test claiming to prove 2026-era behavior through it is a lie in the suite. Real 2026-era coverage means driving a real `serveStdio` instance over real streams or a real child process.
4. **Preserve the confirm gate above all.** The destructive-tool gate protects `env-clear`, `gh-merge-dev`, `gh-release-deploy-all`, `gh-release-deploy-selected`, `local-deploy`, `release-create`, `worktrees-remove`. A regression there mutates real infrastructure.
5. **One change at a time, isolated from the dirty tree.** The working tree currently carries unrelated dev-server/TUI work. This migration must not be entangled with it.

### Decision drivers (top 3)

1. **Irreversibility asymmetry.** A dependency swap whose only wire deltas are the two named, asserted ones is revertable by `git revert` before publish and by a patch release after. Flipping the protocol era is **not** revertable without republishing (§K: `legacy?: 'serve' | 'reject'` — there is no legacy-only value, no kill switch), and `infra-kit` silently auto-updates globally.
2. **Dependency weight in a globally installed CLI.** 93 transitive packages → 3 in published `dependencies`; the entire Express/Hono/JOSE/AJV/CORS/pkce stack leaves the published runtime dependency closure of a stdio-only server that never opens a socket (§F). This benefit is **fully realized without touching the protocol era.**
3. **Protocol-era lock-in.** v1 is terminal for 2026-07-28. Every month on v1 accumulates obsolescence with no upgrade path other than this one — but the *package* migration is what unlocks it, and the *era flip* is a separate, later, **conditional** decision.

### Options considered

#### A. Do nothing — stay on `@modelcontextprotocol/sdk@^1.30.0` (2025 era)

| Pros | Cons |
|---|---|
| Zero risk, zero cost, zero release exposure. | Permanent 2025-era lock-in; v1 will never speak 2026-07-28. |
| Every current host demonstrably works today. | Keeps 93 transitive packages (express/hono/jose/ajv/cors) in the published `dependencies` of a **globally installed** CLI as pure dead weight. |
| The user's stated *goal* (a confident release) is trivially met. | Does not answer the user's question; defers it at rising cost. |
| Honest baseline — and a legitimate answer. | When a host eventually requires 2026-era, we migrate under time pressure instead of calmly. |

**Verdict: viable, and it is our rollback.** Not chosen: the dependency win alone justifies moving, and it is available at near-zero protocol risk under E.

#### B. Migrate to v2 packages **and** adopt default dual-era `serveStdio(factory)`

| Pros | Cons |
|---|---|
| `serveStdio` with no `legacy` option serves 2025-era clients from the same factory by default, so a legacy-only host still connects. | **It is a live era flip, not latent optionality (§I1).** `classifyOpeningMessage` pins a connection to `modern` the moment an opening carries a valid modern `_meta` envelope. Our v1 server answers that probe `-32601` today, so `auto` hosts fall back to legacy — **adopting `serveStdio` flips every already-`auto`-capable host onto the 2026 code path on upgrade.** |
| One release instead of two. | **No kill switch (§K).** `legacy?: 'serve' \| 'reject'` has no legacy-only value. Once shipped, the modern path cannot be turned off without republishing — and `infra-kit` auto-updates globally and silently, so post-publish exposure is hours-to-days, not one `git revert`. |
| Ships the dependency win at the same time. | The set of hosts that flip is **unenumerated at the moment of publish**. We would be measuring the blast radius after detonation. |
| | Every 2026-path behavior (`getClientCapabilities()`/`getClientVersion()` → `undefined`, per-request identity from `ctx.mcpReq.envelope`, per-request opt-in logging) becomes live in the field on first contact. |
| | Requires the mandatory `onerror` amendment (Appendix B) or the process degrades to a silent zombie answering `-32603` forever. |

**Verdict: viable, and it is Release 2 — but Release 2 is conditional and unscheduled.** Under
Principle 2, correctly applied, B ships an unmeasured era flip. It becomes correct only when one of the
trigger conditions T1–T3 (Appendix B) holds, and only after a fresh dated host-era matrix.

#### C. Migrate to v2 and pin modern-only (`serveStdio(factory, { legacy: 'reject' })`)

| Pros | Cons |
|---|---|
| Maximum "stateless": every connection is 2026-era, no dual-era code paths to reason about. | **Refuses every 2025-era client opening.** If no host speaks 2026-07-28 yet, we ship an MCP server that nothing can connect to — including Claude Code in this very repo (`.mcp.json` registers `infra-kit mcp`). |
| Forces the codebase to confront 2026 semantics immediately. | Zero user-visible benefit over B for a per-client-spawned stdio server. |
| | The stated goal is *confidence before a release*; this is the single highest-variance choice available. |

**Verdict: rejected for this release and the next.** Strict superset of B's risk, no offsetting benefit
for stdio. Revisit only if a dated matrix shows **every** host we support negotiates 2026-07-28.

#### D. Add a stateless HTTP transport (`createMcpHandler` / `@modelcontextprotocol/node`) alongside stdio

| Pros | Cons |
|---|---|
| Genuinely exercises "serverless"/stateless-HTTP as the user described it. | **Solves a problem we do not have.** No HTTP surface, no deployment target, no multi-client requirement. |
| Would allow a hosted infra-kit MCP endpoint someday. | Adds auth, transport, lifecycle, and a whole new attack surface to a CLI that shells out to `git`, `gh`, `aws`, and deploy scripts. |
| | Official guidance does **not** tell stdio servers to move to HTTP; stdio is first-class in 2026-07-28. |
| | Re-imports the express/hono/jose stack we just deleted. |

**Verdict: invalidated.** Not "risky" — *unmotivated*. Scope invention. If a hosted infra-kit MCP is ever
wanted, that is its own product decision with its own security review.

#### E. Migrate to v2 packages, **keep** `new StdioServerTransport()` + `await server.connect(transport)` — **CHOSEN**

Verified viable: `McpServer` is exported by `@modelcontextprotocol/server`, `StdioServerTransport` by
`@modelcontextprotocol/server/stdio` (§E of the brief, read from the real 2.0.0 tarball). This is the
SDK's own documented hand-constructed example, and the migration guide states it verbatim:

> *"A hand-constructed `Server`/`McpServer` connected directly to a `StdioServerTransport` serves
> only the 2025-era protocol — **upgrading the SDK changes nothing about what it puts on the wire**."*

§L adds direct source evidence: `@modelcontextprotocol/core@2.0.0` declares
`LATEST_PROTOCOL_VERSION = "2025-11-25"` and a `SUPPORTED_PROTOCOL_VERSIONS` list with **no 2026
entry**. The modern-revision table lives in `@modelcontextprotocol/server`'s `stdio.mjs` and is
reachable **only** through `serveStdio`'s opening classifier. Option E's 2025-era ceiling is therefore
structural, not a policy we are trusting.

| Pros | Cons |
|---|---|
| **Exactly two measured wire deltas, both named and both asserted (§0b).** `capabilities.prompts` gains `listChanged: true`; tool schemas re-serialize `draft-07` → `draft-2020-12`. Schema semantics unchanged. Everything else in `initialize` is byte-identical. W1 turns that from a claim into an assertion and blocks on any third difference. | Does not deliver 2026-07-28 in this release. The user's headline ask lands in Release 2, which is conditional. |
| **Delivers the entire dependency win now**: published `dependencies` closure 93 → 3 transitive packages; express/hono/jose/ajv/cors/pkce gone from a globally installed CLI (§F). | Two releases instead of one — more process, two changelogs, two smoke tests. |
| **No era flip.** §I1's failure mode is structurally impossible: `classifyOpeningMessage` only exists inside `serveStdio`, which we do not call. §L makes that structural, not incidental. | The v2 packages themselves are new code in our runtime path; "two known wire deltas" is not "no code change". Mitigated by the full four-lane suite plus the differential wire test. |
| **No `onerror` cliff (§I4).** `serveStdio`'s swallowed-rejection hazard does not exist; the existing `try/catch` → `logger.error` → `process.exit(1)` paths in `src/entry/mcp.ts` survive verbatim. | The `serveStdio`/`onerror`/lifecycle work is deferred, not deleted — Appendix B carries it pre-verified. |
| **Rollback stays cheap.** No host renegotiates protocol in either direction; tool schemas revert to the `draft-07` form every host already accepted. | |
| Puts us on the only package line that can ever serve 2026-07-28, so Release 2 — if its trigger ever fires — is a small, isolated, well-instrumented diff instead of a bundled one. | |
| E8-R1 pins the 2025-era ceiling in the suite, so an accidental future `serveStdio` cannot land silently. | |

#### F. Ship E as the default, `serveStdio` behind an env flag (e.g. `INFRA_KIT_MCP_MODERN=1`)

| Pros | Cons |
|---|---|
| Would collect real host-era data from the field without a second publish. | **Two live code paths in the shipped artifact**, both of which must be tested, forever. The four-lane suite doubles at the e2e layer. |
| Gives an escape hatch that §K otherwise denies: a modern-path bug is disabled by unsetting an env var rather than republishing. | **A user-facing flag is a permanent support surface.** Env vars in a globally installed CLI get set once, forgotten, and inherited by unrelated sessions; the next bug report arrives with an unknown flag state. |
| Would let a motivated user opt into 2026 early. | **A flag nobody exercises is dead code** — and per §I1 the population that would exercise it is exactly the population we cannot enumerate, so uptake is unknowable. |
| | **Its entire justification is data we can obtain more cheaply.** F's only unique benefit is real host-era data, and that data comes from a **local unpublished spike build with `.mcp.json` repointed — runnable on demand, and specifically as the opening step of whenever Release 2 is planned.** No flag, no shipped second path, no support surface. This is the decisive objection, and it does not depend on any phase of this plan. |
| | Ships modern-path code to every user while claiming the release changes only two known things on the wire — W1 would pass while a second, untested-in-the-field path sits in the bundle. |

**Verdict: invalidated by cheaper substitute.** The substitute is a throwaway local spike, available on
demand; it is not a scheduled phase of this plan and does not depend on one.

### Chosen option and invalidation rationale (re-derived over {A, B, C, D, E, F})

**Chosen: E.** Migrate to `@modelcontextprotocol/server` (+ `core` only if directly imported) v2 and
**keep** the hand-wired `new StdioServerTransport()` + `await server.connect(transport)` in
`src/entry/mcp.ts`. Ship as **Release 1**. `serveStdio` is **Release 2 — conditional and unscheduled**
(Appendix B, triggers T1–T3).

- **A invalidated (as an end state, not as a fallback):** it forgoes a measured 93→3 dependency
  reduction in a globally installed CLI for no benefit, and it is an implicit decision to never adopt
  2026-07-28. **Retained as the rollback target**, and it remains correct if Phase 6 reveals an
  unexpected cliff.
- **B deferred, not invalidated:** B is the right *eventual* release. It is wrong as the *first* one
  because §I1 makes it a live era flip over an unenumerated host population and §K denies any kill
  switch. §D proves **there is no live breakage today** — a 2026-era `auto` client probing our current
  server gets a clean `-32601` and falls back to legacy — so there is nothing to fix.
- **C invalidated for both releases:** we cannot pin modern-only before a dated matrix empirically
  establishes that at least one host we care about speaks 2026-07-28 — and even then, "at least one"
  is not the bar; "all of them" is.
- **D invalidated permanently for this scope:** no HTTP surface exists, none is required by the spec
  for stdio servers, and it would re-import the dependency stack E deletes.
- **F invalidated:** its sole unique benefit — real host-era data without a second publish — is
  obtainable from a local unpublished spike run on demand, including as the opening step of Release 2
  planning. F would pay a permanent shipped code path and a user-facing support surface for something a
  throwaway branch already provides.

**Release map**

| | Release 1 (this plan's critical path) | Release 2 (conditional, unscheduled — Appendix B) |
|---|---|---|
| Option | **E** | **B** |
| Packages | v2 `server` (+`core` iff imported); `sdk` + `client` → devDeps | unchanged |
| Entry | `new StdioServerTransport()` + `server.connect()` | `serveStdio(() => createMcpServer(), { onerror })` |
| Wire | exactly two known deltas (§0b), asserted by W1 | 2026-07-28 available; dual-era |
| Reversible? | yes — `git revert` pre-publish, ordinary patch post-publish | **no** — modern path cannot be disabled without republishing (§K) |
| Gate | Phase 6 host matrix | one of T1–T3 must hold, then **its own ralplan pass, which must open by collecting a dated host-era matrix** |

---

## 2. Pre-mortem — 3 failure scenarios

*(PM-4, the `serveStdio` zombie, is a Release-2 hazard. It is pre-verified and preserved in
**Appendix B** so it can never be rediscovered the hard way.)*

### PM-1 — We ship an MCP server no host can connect to

**The failure.** `infra-kit@0.3.15` publishes. A user upgrades, their host relaunches `infra-kit mcp`,
and the connection never establishes — empty tool list, or the server reported as failed.

**Why Release 1 (E) shrinks this to near-zero.** Under E the negotiated protocol is unchanged — by
upstream's own statement and by §L's source evidence — and §0b enumerates the only two measured wire
deltas, both of which W1 asserts positively. The residual risk is not protocol at all — it is "the v2
`McpServer` implementation behaves differently inside an unchanged handshake", which the unit /
integration / e2e lanes cover directly. The one genuinely host-visible delta is D2 (the `$schema`
dialect), which Phase 6's **"tool arguments validate / schemas accepted"** column exists to measure.

**Earliest signal.** Phase 4's W1 + E-lane; then Phase 6, *before* publish: MCP Inspector
(`pnpm run inspector`) fails to enumerate tools or rejects tool arguments against the built
`dist/mcp.js`, **or** this repo's own `.mcp.json` stops resolving tools when repointed at the local
build. This repo is its own free canary.

**Mitigation baked into the plan.**
- No era flip in Release 1 (that is the whole point of choosing E).
- `@modelcontextprotocol/sdk@^1.30.0` is retained as a **devDependency**, so the existing
  `fail-honestly-outside-project.integration.test.ts` (v1 `Client` + `StdioClientTransport` against the
  real spawned `dist/mcp.js`) keeps running unchanged and becomes a permanent 2025-era regression guard.
- Phase 6 is a hard release gate with a written matrix. No publish without it filled in.

**Rollback.** Revert the migration commit range → Option A. Post-publish, an ordinary patch release:
**no host renegotiates protocol in either direction; tool schemas revert to the `draft-07` form every
host already accepted.**

---

### PM-2 — The destructive-tool confirm gate silently degrades

**The failure.** The gate in `src/lib/tool-handler/tool-handler.ts` relies on the SDK skipping
`outputSchema` validation when a result carries `isError: true`. The gate payload deliberately does not
match any tool's declared `outputSchema`. If v2 changed that rule:
- **Loud:** call 1 to a gated tool throws an output-validation error instead of returning the gate.
  Annoying, obvious, safe.
- **Silent and severe:** the gate is bypassed and call 1 *executes*. `local-deploy`,
  `gh-release-deploy-all`, `gh-release-deploy-selected`, `gh-merge-dev`, `release-create`,
  `worktrees-remove`, `env-clear` mutate real state. An agent that "just tried a tool" would deploy.

**Status: veto CLEARED, obligation retained (§H2).** v2's `validateToolOutput` still contains
`if (result.isError) return;` — verified verbatim in the real 2.0.0 tarball. The mechanism
`buildConfirmGate` depends on is intact. **No restructuring is required by this migration.**

This is therefore no longer an *investigation*; it is a **pin-by-test** obligation. Behavior being
currently correct is not the same as being pinned by our suite.

**Earliest signal.** Phase 4's E4/E5 against the hermetically built `mcp.js`, automated-mutation-checked (§4).

**Mitigation baked into the plan.**
- E4/E5 exercise the gate on `worktrees-remove` against a **disposable fixture** (§4), never a real deploy.
- **E4's non-execution is asserted via a filesystem side-effect proxy, not the response shape.**
- The gate tests are in `pnpm run qa`, so they can never be skipped.
- `tool-handler.ts`'s explanatory comment is updated to cite the **method name** `validateToolOutput`
  and nothing else. It currently cites `server/mcp.js`; in v2 the method kept its name but now lives in
  a hashed bundle chunk (`mcp-DXXb3Vv3.mjs`) that churns every SDK release. **Never write a hashed
  chunk filename into a source comment.**

**Residual veto.** The veto condition survives in one narrow form: **if E4 ever goes red, the migration
does not ship.** Full stop. It is not a trade-off.

*(Note: v2 adds a new short-circuit ahead of ours, `isInputRequiredResult(result)`, for the 2026
`input_required` flow. We do not use it; no action.)*

---

### PM-3 — The published tarball is broken by the dependency swap

**The failure.** `scripts/build.js` derives esbuild's externals from the manifest:

```js
external: [...Object.keys(packageJson.dependencies), 'react/jsx-runtime', 'react/jsx-dev-runtime']
```

Three ways this bites:
- We put a v2 package in `devDependencies` (or forget it) → not in the external list → esbuild
  **silently inlines the whole SDK into `dist/mcp.js`**. The build succeeds. Nothing errors. It may
  even work locally.
- We remove `@modelcontextprotocol/sdk` from `dependencies` **while `src/` still imports it** → same
  silent inlining, now of the *old* SDK. **And because the e2e lane builds hermetically in-test, a
  v1-inlined bundle would be built and exercised by `pnpm run qa` — which would likely PASS.** This is
  the specific trap that dictates Phase ordering (§3).
- Repo memory flags a **recurring** bug where `catalog:` leaks into published runtime deps and breaks
  install on both npm and pnpm.

**Earliest signal.** Phase 5's binary externalization assertions on the emitted bundle text (§4, B1–B3)
and Phase 7's `pnpm pack` inspection — the tarball's `dependencies` are read from the *packed* manifest,
not the source tree.

**Mitigation baked into the plan.**
- Every `@modelcontextprotocol/*` package imported from a **non-test** file under `src/` goes into
  **`dependencies`**. Packages we do not import from non-test source (`core`, if it turns out to be
  transitive-only; `client`, which is tests-only by design) are **not** in `dependencies` — an unused
  direct runtime dep is its own defect, and `client` in `dependencies` would re-import
  jose/cross-spawn/eventsource/pkce-challenge into the published closure we are trying to shrink.
- **Phase ordering guarantees `pnpm run qa` is green at every boundary and never runs against a
  half-swapped manifest** (§3).
- `@modelcontextprotocol/sdk` moves to `devDependencies` **in the same commit** that lands the U6 grep
  guard green.
- **Binary externalization assertions** (not size heuristics) on the emitted bundle — §4, B1–B3.
- Phase 7 pack-and-inspect: assert no `catalog:` in the packed manifest's `dependencies`.

**Rollback.** Unpublish is not routine; the mitigation is that Phase 7's pack inspection happens
**before** `npm publish`, and publishing is the last step after Phase 6's gate.

---

## 3. Phased implementation plan

> **Ordering invariant (non-negotiable).** `pnpm run qa` must be **green at every phase boundary.**
> There is no deliberately-red interval. In particular, `@modelcontextprotocol/sdk` stays in
> `dependencies` until `src/` no longer imports it — otherwise esbuild silently inlines it, the
> in-suite hermetic build builds that inlined bundle, and `pnpm run qa` passes while shipping v1
> welded into `dist/mcp.js`.

> **Verified deltas from the brief** (see Appendix A):
> 1. **All tool definitions flow through one factory**, `defineMcpTool` in `src/types.ts` —
>    **25 call sites across 24 files**, zero hand-rolled literals. And per §I2, **v2 still accepts raw
>    Zod shapes and auto-wraps them** via a `@deprecated` `registerTool` overload, so this is
>    deprecation hygiene, **not a migration blocker**. It is a follow-up, off the critical path.
> 2. **A protocol-level test already exists.** `src/commands/__tests__/fail-honestly-outside-project.integration.test.ts`
>    builds hermetically via the exported `buildOptions`, spawns the real `dist/mcp.js`, and drives it
>    with a v1 `Client` + `StdioClientTransport`.
> 3. **Counts:** **23** exposed MCP tools (`mcpExposed: true`); **25** `defineMcpTool` call sites across
>    **24** files; **5** non-test source files import `@modelcontextprotocol/*`.
> 4. **Gated tools, enumerated and verified — exactly 7:** `env-clear`, `gh-merge-dev`,
>    `gh-release-deploy-all`, `gh-release-deploy-selected`, `local-deploy`, `release-create`,
>    `worktrees-remove`. **`worktrees-sync` is NOT gated** — do not use it as a gate fixture.

### Phase 0 — Isolate and baseline

**Files:** none (branch hygiene + one decision + three captured fixtures).

1. Branch off `main` into a clean worktree. The current tree is dirty with unrelated dev-server/TUI work
   plus an untracked `json-output-purity.test.ts`; this migration must not entangle with it.
2. Record a green baseline: `pnpm run qa` on the clean branch. **Flaky-test protocol:** if `lock.test`
   or `portless-driver.test` fail, re-run each **in isolation** before calling it a regression — repo
   memory flags both as flaky under full-suite load. Do not call a load flake a regression, and do not
   call a real regression a flake.
3. ~~Read the v2 docs and answer (a) the client-side 2026 opt-in and (b) the `isError` question.~~
   **STRUCK — both closed with primary evidence.** (a) is `ClientOptions.versionNegotiation` +
   `client.getProtocolEra()` (§H1); (b) is `if (result.isError) return;`, preserved in v2 (§H2).
   Nothing here to investigate.
4. **KEEP: the `@modelcontextprotocol/codemod` decision.** Read v2's documented transforms and decide
   **use / don't use**. Measured exposure is near-zero (`McpError`, `RequestHandlerExtra`,
   `setRequestHandler`, `.tool()`/`.prompt()`/`.resource()` shorthand: **0 occurrences each**).
   Default expectation: **run it, review the diff, keep almost nothing.** Record the decision either way
   so the next person does not re-litigate it.
5. **Capture the v1 wire baseline for W1 — all three surfaces.** Build the current `main` and record
   into checked-in fixtures under `src/mcp/__tests__/fixtures/`:
   - `initialize-baseline.v1.json` — the `initialize` result (`protocolVersion`, `capabilities`,
     `serverInfo`), captured for **both** probed request versions (`2025-06-18` and `2026-07-28`).
   - `tools-list-baseline.v1.json` — the full `tools/list` result, all 23 tools with both schemas.
   - `resources-list-baseline.v1.json` — the full `resources/list` result.

   This must happen **before** any dependency change, or the baseline is worthless. `tools/list` is the
   surface that actually changes (D2), so omitting it would mean W1 tests only what stays the same.

**Exit criterion:** clean branch, green `pnpm run qa` baseline recorded, codemod decision written down,
**all three** v1 wire baseline fixtures committed.

---

### Phase 1 — ADD the v2 dependencies (do **not** remove v1)

**Files:** `apps/infra-kit/cli/package.json`.

1. `dependencies`: **add** `@modelcontextprotocol/server@^2.0.0`.
2. `@modelcontextprotocol/core@^2.0.0` goes in `dependencies` **if and only if a non-test file under
   `src/` imports it directly.** The decision command, run at Phase 2:

   ```sh
   grep -rn "@modelcontextprotocol/core" apps/infra-kit/cli/src --include='*.ts' | grep -v __tests__
   ```

   **Empty output ⇒ omit `core` from `dependencies`** (it arrives transitively via `server`). Non-empty
   ⇒ add it. An unused direct dependency is a defect; a directly-imported-but-undeclared one gets
   silently inlined by esbuild. Both failure modes are real; pick the manifest that matches the imports.
   *(Not needed either way: `@modelcontextprotocol/node` — hono/HTTP adapter;
   `@modelcontextprotocol/server-legacy` — SSE/legacy HTTP.)*
3. `devDependencies`: **add** `@modelcontextprotocol/client@^2.0.0`. It is used **only** by the e2e
   lane (E8-R1's pinned subject and bare negative control). It must **not** go in `dependencies`:
   `client@2.0.0` pulls jose / cross-spawn / eventsource / pkce-challenge, which would re-import into
   the published closure the exact weight this migration removes. *(Verified: `client@2.0.0` exports
   `./stdio`, so `StdioClientTransport` imports fine.)*
4. `dependencies`: **leave `@modelcontextprotocol/sdk@^1.30.0` exactly where it is.** It is still
   imported by 5 source files. Moving it now would silently inline v1 (PM-3).
5. No change needed in `scripts/build.js`: `external` is derived from `Object.keys(packageJson.dependencies)`,
   so the new runtime dep externalizes automatically.
6. Preconditions already satisfied (no action): `zod@^4.4.3` ⊇ v2's `zod ^4.2.0`; `engines.node >=24.x`
   ⊇ v2's `node >=20`; we are already `type: module`, so v2's ESM/CJS duality is moot.
7. `pnpm install`; confirm the lockfile resolves `@modelcontextprotocol/server@2.0.0` and
   `@modelcontextprotocol/client@2.0.0`, and that no `catalog:` protocol appears anywhere in
   `dependencies`.

**Exit criterion:** `pnpm install` clean. **`pnpm run qa` GREEN** — nothing in `src/` changed yet.

---

### Phase 2 — Repoint the 5 source files to v2, keeping the hand-wired transport

**Files:** `src/entry/mcp.ts`, `src/mcp/server.ts`, `src/mcp/tools/index.ts`, `src/mcp/resources/index.ts`,
`src/mcp/prompts/index.ts`. Plus `src/mcp/__tests__/server.test.ts`, `src/mcp/resources/__tests__/index.test.ts`
if their imports follow.

1. Repoint `McpServer` type/value imports from `@modelcontextprotocol/sdk/server/mcp.js` to
   `@modelcontextprotocol/server`, and `StdioServerTransport` from
   `@modelcontextprotocol/sdk/server/stdio.js` to `@modelcontextprotocol/server/stdio`.
   Run Phase 1 step 2's `core` decision command now and reconcile `dependencies` accordingly.
2. **`src/entry/mcp.ts` keeps its current shape.** `new StdioServerTransport()` +
   `await server.connect(transport)` stay. Both `try/catch` blocks — `Failed to create MCP server` and
   `Failed to initialize server`, each `logger.error(...)` + `process.exit(1)` — stay **verbatim**.
   This is the entire safety argument for Option E; do not "tidy" it.
   `suppressTypelessPackageJsonWarning()` stays and stays first.
3. `createMcpServer()` in `src/mcp/server.ts`: `mcpMode.enabled = true` stays inside it. The existing
   test in `src/mcp/__tests__/server.test.ts` is the only proof that flag is ever set — preserve it and
   its rationale comment verbatim.
4. Keep the declaration `capabilities: { resources: { listChanged: true }, tools: {}, prompts: {} }`
   **unchanged**. Per §P, v2 auto-upgrades the `prompts` declaration to `{"listChanged": true}` on the
   wire from this same input — that is delta D1, expected and accepted. Do **not** "fix" the source to
   match the wire. W1 asserts D1 positively.
5. **Raw Zod shapes stay as they are.** Per §I2, v2 ships a `@deprecated` raw-shape `registerTool`
   overload that auto-wraps with `z.object()`. `defineMcpTool`/`CatalogMcpTool` compile and run
   unchanged. **No edits under `src/commands/**`.** Deprecation hygiene is a follow-up.
6. **Non-issues, verified — no work:** `getClientCapabilities()` / `getClientVersion()` /
   `getNegotiatedProtocolVersion()` have **0 occurrences** in `src/`. `requestState` is not needed.
   The removed experimental **tasks** feature is unused. Deprecated roots/sampling/logging are unused.

**Exit criterion:** `pnpm run ts-check` green; existing MCP unit tests green. **`pnpm run qa` GREEN.**
`@modelcontextprotocol/sdk` is still in `dependencies` and still imported by the **tests** — that is
correct and intentional at this boundary.

---

### Phase 3 — Pin the confirm gate by test; fix the stale comment

**Files:** `src/lib/tool-handler/tool-handler.ts` (comment only), tests.

1. **PM-2 is pin-by-test, not investigate.** §H2 established that v2's `validateToolOutput` retains
   `if (result.isError) return;`. No restructuring. The work is to make our suite *prove* it (E4/E5,
   §4) rather than assume it.
2. Update the comment at `tool-handler.ts` lines ~25-28. It currently reads
   *"(server/mcp.js `validateToolOutput`)"*. Rewrite it to cite **only the method name**
   `validateToolOutput` and the behavior, with **no file path**. In v2 the method kept its name but
   lives in a hashed bundle chunk that churns on every SDK release; a hashed filename in a source
   comment is a guaranteed future lie.
3. Residual veto, stated in the code comment and in AC: **if E4 ever goes red, the migration does not ship.**

**Exit criterion:** **`pnpm run qa` GREEN.** Comment cites a method name, not a path.

---

### Phase 4 — Test lanes (detailed in §4)

**Files:** one new e2e file `src/mcp/__tests__/mcp-stdio.e2e.test.ts`; new unit/integration guards
alongside the existing MCP tests.

All four lanes land here, including W1 (differential wire), the automated E4 mutation check, O6 (signal
exit), and the E8-R1 era negative control. `@modelcontextprotocol/sdk` is still in `dependencies` at the
start of this phase and still available to tests; `@modelcontextprotocol/client` is available as a
devDep from Phase 1.

**Exit criterion:** all lanes implemented and green. **`pnpm run qa` GREEN.** W1 passes: the migrated
build's `initialize` / `tools/list` / `resources/list` match the Phase 0 v1 baselines **modulo exactly
the two named deltas D1 and D2, both asserted positively**, and modulo `serverInfo.version`.

---

### Phase 4b — Demote v1 to a devDependency **and** land the grep guard, in ONE commit

**Files:** `apps/infra-kit/cli/package.json`, new guard test.

1. `dependencies`: **remove** `@modelcontextprotocol/sdk`. `devDependencies`: **add**
   `@modelcontextprotocol/sdk@^1.30.0`, with an adjacent comment stating it is retained solely as the
   **2025-era client fixture** for the e2e lane. `@modelcontextprotocol/client@^2.0.0` is already in
   `devDependencies` from Phase 1, retained solely as the **2026-era-capable client fixture**.
2. **In the same commit**, land guard test **U6**: zero `@modelcontextprotocol/sdk` imports under `src/`
   outside `__tests__/` directories — and it must be **green on landing**. Phase 2 already removed every
   source import, so it is green immediately. There is no red interval.
3. `pnpm install`; re-verify the lockfile and that no `catalog:` protocol appears in `dependencies`.

**Why one commit:** demoting the dep without the guard leaves the "a stray source import gets silently
inlined and `qa` passes anyway" hole open for exactly as long as the two commits are apart. Landing the
guard first would be red (the dep is still runtime). One commit is the only ordering with no window.

**Exit criterion:** **`pnpm run qa` GREEN**, cold, with `eslint-check --no-cache`, and `git status`
showing no untracked `??` files.

---

### Phase 5 — Build and packaging guards

**Files:** new guard tests; possibly `scripts/build.js`.

1. Land the **binary externalization assertions** B1–B3 (§4) against the hermetically built bundle text.
2. **If B2 fails, B1 will fail too** — esbuild externalizes subpaths of a package specifier that is
   already in `external` (see step 3). A B2-only failure is therefore not a real signal about subpaths;
   it means the `external` derivation itself is wrong. **Diagnose the `external` derivation (is
   `@modelcontextprotocol/server` actually in `dependencies` at build time?). Do not patch the
   `external` array to make the assertion pass** — that would contradict step 3 and AC17.
3. **Correct the misleading comment at `scripts/build.js:53-54`.** It currently reads:

   > *"Externalize deps + the React JSX runtime subpaths (the `react` key alone does not cover subpaths
   > in esbuild's external matching)."*

   That generalization is wrong: esbuild **does** externalize subpaths of a real package specifier
   present in `external`. The React entries are needed because esbuild **auto-injects**
   `react/jsx-runtime` under `jsx: 'automatic'` and `react` is not itself a dependency key here. Reword
   the comment to say that, so nobody "fixes" the array on a false premise.
4. `pnpm run build` succeeds and emits `dist/mcp.js` as a sibling of `dist/cli.js`.

**Exit criterion:** **`pnpm run qa` GREEN.** B1–B3 green. Build comment accurate.

---

### Phase 6 — Empirical client-compatibility gate for **Release 1** (release blocker)

**Files:** this document (matrix filled in). `.mcp.json` temporarily, then reverted.

PM-1 cannot be mitigated by reasoning — only by measurement. Fill in this matrix against the **built**
`dist/mcp.js` from the migration branch.

**The repoint, literally.** Edit `/Users/arthur/projects/infra-kit/.mcp.json` and replace the
`infra-kit` server entry's `command`/`args` with absolute paths:

```json
{
  "mcpServers": {
    "infra-kit": {
      "type": "stdio",
      "command": "/absolute/path/to/node",
      "args": ["/Users/arthur/projects/infra-kit/apps/infra-kit/cli/dist/mcp.js"]
    }
  }
}
```

- Use `process.execPath`'s absolute value for `command`. Do **not** use `pnpm exec` — repo memory:
  a global copy can share a version string with the workspace while differing in code; verify via
  `dist/mcp.js` by absolute path.
- **Claude Code must be restarted** for an `.mcp.json` change to take effect. A stale connection is the
  most likely way to record a false row in this matrix.
- **`.mcp.json` is a TRACKED file.** It **must be reverted to `{"command":"infra-kit","args":["mcp"]}`
  before the migration commit range is finalized**, or AC14 (single revertable range, no unrelated
  changes) is unsatisfiable and every consumer of this repo gets a machine-specific absolute path.
  This is not zero-cost; it is a tracked-file edit with a mandatory undo.

**RESULT — run 2026-08-16 against the built `dist/mcp.js` at commit `d1924c0`.**

| Host | Connects | `tools/list` returns the full exposed set | **Tool arguments validate / schemas accepted** | One read-only tool call succeeds | Both resources readable | Negotiated version |
|---|---|---|---|---|---|---|
| MCP Inspector `inspector-cli` 2.2.0 | ✅ | ✅ 23, `doctor` absent | ✅ required + optional-omitted both accepted | ✅ `version` → `0.3.14` | ✅ both listed | **2025-11-25** |
| Claude Code 2.1.233 | ✅ | ✅ 23 | ✅ required + optional-omitted both accepted | ✅ `version` → `0.3.14`, `env-token-list` ok | ✅ both listed, `dev-context` read → `session:"none"` | **2025-11-25** |
| Cursor | **untested** | untested | untested | untested | untested | untested |
| Zed | **untested** | untested | untested | untested | untested | untested |

**How it was run — no `.mcp.json` edit was needed.** `claude -p --strict-mcp-config --mcp-config <temp>`
drives Claude Code's real MCP client against an arbitrary server, so the tracked file was never
touched and AC13's mandatory revert is moot (`git diff .mcp.json` → clean). The Inspector was driven
through its non-interactive `--cli` mode. Negotiated versions were read off the wire via a
transparent stdio tee proxy rather than inferred.

**Cursor and Zed are installed but recorded as untested**: both are GUI hosts, and neither `cursor`
nor `zed` exposes a CLI that drives an MCP server, so there is no non-interactive way to fill their
rows. Per this phase's own rule they are **untested, not assumed working**.

**Neither host probes.** `server/discover` frame count was **0** for both. Combined with the
negotiated `2025-11-25`, this is direct wire evidence that Option E was implemented: a `2026-07-28`
row would have meant a stray `serveStdio` call.

**D1 is visible to real hosts and accepted.** Both saw
`capabilities.prompts: {"listChanged": true}` in the `initialize` result and neither complained.
**D2 is accepted too** — both hosts validated arguments against the `draft-2020-12` schemas, with a
required argument (`worktrees-remove versions=…`) and an optional-omitted one (`env-token-list`).

**⚠️ Host-dependent finding on the confirm gate — PRE-EXISTING, proven against a real host.**
The Inspector's client rejects the gate payload:

> `data must have required property 'removedWorktrees', data must have required property 'count',
> data must NOT have additional properties, …`

**Claude Code does NOT** — it receives the full `{status:'confirmation_required', tool, resolvedArgs,
message}` payload and reports it correctly. So this affects Inspector-class (v1-SDK-validating)
clients only, not this repo's primary host.

It is **not** caused by the migration. Running the **identical** Inspector call against the
**published v1 global build** (`~/Library/pnpm/global/.../infra-kit@0.3.14/dist/mcp.js`, verified
`imports sdk v1: true`, `imports server v2: false`) produces the **byte-identical** error. The
earlier schema-level derivation is now confirmed empirically end-to-end. It fails safe — the log
shows `Tool execution gated (awaiting confirm)` and the tool never runs — and the required argument
was accepted and reached the handler, which is what this column measures.

Notes:
- **The "tool arguments validate / schemas accepted" column is mandatory, not decorative.** Delta D2
  (§0b) changes the `$schema` dialect on all 23 tools × 2 schemas. Without this column, Phase 6
  measures connection and enumeration but **not the one surface the migration actually changes**.
  To fill it: invoke at least one tool with a **required** argument and at least one with an
  **optional-omitted** argument, and confirm the host neither rejects the call client-side nor reports
  a schema error. If a host surfaces schema-validation diagnostics, record them verbatim.
- The exposed-tool count is **23 today**. Read it from `getExposedMcpTools()`; do not memorize it.
- Under Release 1 the expected negotiated version is the **same one v1 negotiates** (2025-11-25 for a
  2026-requesting client, 2025-06-18 for a 2025-06-18 client). **Any row showing 2026-07-28 means Option
  E was not actually implemented** — stop and find the `serveStdio` call.
- Hosts we cannot test are recorded as **untested**, not assumed working.

**Exit criterion:** every cell of the Inspector and Claude Code rows filled and passing — **including
the schema-acceptance column**; `.mcp.json` reverted. Any failure → do not publish; diagnose or revert.

---

### Phase 7 — Release 1

**Exit criterion:** see §6.

---

## 4. Expanded test plan (deliberate mode)

### Hard constraint that shapes every era-sensitive lane

> *"There is no in-memory serving entry — `InMemoryTransport.createLinkedPair()` connects 2025-era
> instances only. … For stdio-era coverage, spawn `serveStdio` as a child process."*

Therefore: **no test in this plan may claim to prove 2026-era behavior through an in-memory transport
pair.** Any such test is a false green and must be rejected in review. `InMemoryTransport` **is still
exported by v2** — its presence in the API is a trap. We have 0 occurrences today, so there is nothing
to un-learn, but this constraint must be written into the era-sensitive test files' comments so a future
contributor does not "simplify" the e2e lane into an in-memory pair and delete the guarantee.

*(§E4 of the brief notes a stream-backed `StdioServerTransport` over `PassThrough` pairs is a legitimate
in-process 2026-era mechanism. That is a Release 2 option, recorded in Appendix B so it is not
rediscovered.)*

### Harness rules — timeouts, file layout, and spawn budget

`vitest.config.ts` sets **no `testTimeout`**, so the default is **5 s** — far below what a hermetic
build plus a child spawn needs. `pool: 'forks'` is **pinned** (with a comment in the config explaining
why); do not change it to work around this lane.

| Rule | Value | Rationale |
|---|---|---|
| Build `beforeAll` timeout | `beforeAll(async () => { … }, 120_000)` | In-repo precedent: `fail-honestly-outside-project.integration.test.ts:164`. |
| Per-test timeout, any test that spawns a child | `45_000` | In-repo precedent: same file, lines 296 and 417. |
| File layout | **The entire Release-1 e2e lane lands in ONE file:** `src/mcp/__tests__/mcp-stdio.e2e.test.ts` — E1–E7, W1, O1, O2, O6, E8-R1, and the mutant build. | One file = one fork = serialized. Splitting it across files lets vitest run several spawning suites concurrently in separate forks, which is how this lane would become the repo's next timing flake. |
| Cleanup | An `afterAll` **force-kills any surviving child** (`child.kill('SIGKILL')` for every spawned pid still alive, plus `await transport.close()` for every client transport) and removes every disposable fixture directory. | A wedged child outlives the fork and poisons the rest of the run. |

**Builds are NOT rationed.** The hermetic esbuild build was measured at **~23–45 ms**, and the suite
already performs five. Do not add build-sharing complexity for a cost that is not there.

**Spawn ledger — the thing that actually costs.** Child processes, not builds, are the expense.

*Long-lived (a `Client` connects and stays connected) — **hard cap 4**:*

| # | Spawn | Serves |
|---|---|---|
| 1 | v2 **bare** `Client` (no `versionNegotiation`) + server from the clean hermetic build | E1, E2, E3, E6, O1, O2, **and E8-R1's negative control** (`getProtocolEra() === 'legacy'` on this very connection) |
| 2 | v1 `Client` (`@modelcontextprotocol/sdk` devDep) + the same clean build | E7 — the full E1–E6 surface driven 2025-era |
| 3 | v2 client + clean build, against the **disposable worktree fixture** | E4, E5 (the fixture is mutated, so it cannot share spawn 1) |
| 4 | v2 client + the **mutant build**, against a **fresh** disposable worktree fixture | E4's mutation check (under the mutant the gated tool really executes) |

*Short-lived (spawned, probed, and exited within the same test) — **hard cap 4**:*

| # | Spawn | Serves |
|---|---|---|
| 5 | raw JSON-RPC over piped stdio: `initialize` requesting `2025-06-18` + `tools/list` + `resources/list` | W1 (a) |
| 6 | raw JSON-RPC: `initialize` requesting `2026-07-28` + `tools/list` + `resources/list` | W1 (b) |
| 7 | v2 client **pinned** to `2026-07-28`; `connect()` rejects promptly | E8-R1 subject |
| 8 | clean build, signalled `SIGINT` (and a second run signalled `SIGTERM`) | O6 |

Reusing spawn 1 as E8-R1's negative control is deliberate: it removes a whole spawn *and* makes the
control genuinely load-bearing rather than a formality.

### Lane 1 — Unit

Location: `src/mcp/__tests__/`, `src/mcp/resources/__tests__/`, `src/lib/tool-handler/__tests__/`, plus new guards.

| # | Test | Proves |
|---|---|---|
| U1 | `createMcpServer()` sets `mcpMode.enabled` (existing — **preserve verbatim**, incl. its rationale comment) | The one assignment that closes the MCP prompt hole still happens under v2. |
| U2 | Server advertises the real `package.json` version (existing) | v2's `serverInfo` still round-trips our version, not `'1.0.0'`. |
| U3 | Resource registration (existing, `ResourceDeps`-injected) | Both resources register and both swallow reader failures into `{ error }` rather than throwing. |
| U4 | `createToolHandler` returns the gate on call 1, executes on call 2 (existing) | Gate logic itself, independent of transport. |
| U5 | **New** — every `getExposedMcpTools()` entry's raw shape is accepted by v2's `registerTool` without throwing | §I2's auto-wrap holds for **all** tools, not just the ones e2e happens to call. |
| U6 | **New (guard)** — zero `@modelcontextprotocol/sdk` imports under `src/` outside `__tests__/`. Lands in Phase 4b, green on landing. | PM-3: no stray v1 import silently inlined into the bundle. |
| U7 | **New (guard)** — three independent clauses, see below | PM-3 + the recurring `catalog:`-in-runtime-deps bug + the `client` devDep boundary. |

**U7, stated precisely (the earlier wording was too loose to be checkable):**

1. **Dependencies clause.** `package.json` `dependencies` contains **every `@modelcontextprotocol/*`
   package that is imported from a NON-TEST file under `src/`** — computed by scanning `src/**/*.ts`,
   excluding any path segment `__tests__`, for `@modelcontextprotocol/<pkg>` specifiers — and contains
   **no other** `@modelcontextprotocol/*` package.
2. **Fixture-devDep clause.** `@modelcontextprotocol/sdk` and `@modelcontextprotocol/client` are both in
   `devDependencies`, and **neither appears in `dependencies`**.
3. **Catalog clause.** No value in `dependencies` uses the `catalog:` protocol.

Clause 1 alone would be satisfied by a manifest that also lists `client` in `dependencies` if some test
file imported it, which is exactly the mistake clause 2 exists to catch. They are separate assertions on
purpose.

### Lane 2 — Integration

Location: `src/mcp/__tests__/`. In-process, no child spawn, **2025-era only** (and labelled as such).

| # | Test | Proves |
|---|---|---|
| I1 | Build the full server via `createMcpServer()`; assert the registered tool set matches `getExposedMcpTools()` **computed, never hard-coded** | The catalog→registration wiring survived Phase 2. |
| I2 | Assert declared capabilities shape (`resources.listChanged`, `tools`, `prompts`) | v2 capability declaration didn't silently change meaning. |
| I3 | Assert `outputSchema` is attached for every tool that declares one | v2's auto-wrap didn't drop output schemas. |

**Explicitly out of scope for this lane:** anything about protocol eras. The comment must say so.

### Lane 3 — E2E (the load-bearing lane)

Location: **one file**, `src/mcp/__tests__/mcp-stdio.e2e.test.ts`, extending the harness pattern proven
by `src/commands/__tests__/fail-honestly-outside-project.integration.test.ts`.

**Harness (already proven in-repo — reuse, don't reinvent):**
- Hermetic build in-test: `await esbuild.build({ ...buildOptions, outdir })` importing the **exported**
  `buildOptions` from `scripts/build.js`. Repo memory: *"dist-reading tests are vacuous"* — `qa` has no
  build step, turbo's `test` depends on `^build` (dependencies, not self), and `dist` is gitignored.
  **Never read a checked-out `dist/`.**
- Build into this package's `node_modules/.cache`, **not** `os.tmpdir()` — `buildOptions` leaves deps
  external, so the bundle only resolves `zx`/`pino`/`@modelcontextprotocol/*` by walking up to a
  `node_modules` that exists above it.
- Spawn `process.execPath` with the built `mcp.js`, explicit `cwd` and env kill switches
  (`INFRA_KIT_NO_SEED`, `INFRA_KIT_NO_AUTO_UPDATE`, `INFRA_KIT_NO_LOCATION_WARN`).
- Timeouts and spawn budget per the harness-rules table above.

| # | Test | Client | Proves |
|---|---|---|---|
| E1 | `tools/list` returns **exactly the computed exposed set**; `doctor` absent; size floor | v1 + v2 | Registration survives the real transport. **See the literal assertion below — never hard-code the count.** |
| E2 | Read-only tool call (`version`) succeeds and returns parseable `structuredContent` | v1 + v2 | Round-trip through v2's serialization + output validation. |
| E3 | `resources/list` + `resources/read` for `infra-kit://config` **and** `infra-kit://dev-context` | v1 + v2 | Both resources; `dev-context` with no active session must resolve to an empty `session: 'none'` payload, **not** an error. |
| E4 | **Confirm gate, call 1**: `worktrees-remove` invoked without `confirm` returns `isError: true` with `status: 'confirmation_required'`, echoes resolved args minus `confirm`, and **does not execute — asserted via the filesystem proxy** | v1 + v2 | PM-2's severe branch. |
| E5 | **Confirm gate, call 2**: same tool with `confirm: true` executes — asserted via the filesystem proxy | v1 + v2 | The gate is a gate, not a wall. |
| E6 | Server survives a failing tool call and answers a subsequent one | v1 + v2 | `tool-handler`'s catch→log→rethrow still degrades to an ordinary tool error on the long-lived server. |
| E7 | **Legacy-client regression guard**: E1–E6 driven by a **v1** `Client`/`StdioClientTransport` from the retained `sdk` devDep | v1 | A permanent guard that the 2025-era client experience never regresses. *(Not a Release-1 differentiator — under Option E the wire deltas are D1/D2 only, so this proves continuity, not dual-era serving. It becomes the dual-era proof in Release 2.)* |
| E8-R1 | **Era ceiling + negative control** — mandatory in Release 1 | v2 | Documents and pins that Release 1 is 2025-era. See literal harness below. |
| W1 | **Differential wire compatibility** across `initialize` + `tools/list` + `resources/list` | raw JSON-RPC | The corrected §0b claim, as an assertion, with both deltas asserted positively. |

*(E8 — the actual 2026-era proof — is a Release-2 test and lives in Appendix B.)*

#### E1 — the literal assertion (never hard-code the count)

```ts
const expected = new Set(getExposedMcpTools().map((t) => t.name))
const actual   = new Set(listed.tools.map((t) => t.name))

expect(actual).toEqual(expected)
expect(actual.has('doctor')).toBe(false)   // host-inspecting, deliberately not mcpExposed
expect(actual.size).toBeGreaterThan(20)    // catalog-deletion floor
```

A hard-coded literal (23, or the wrong 24) fails on first run for the wrong reason, and the natural
"fix" is to loosen the assertion — destroying the drift guard it exists to provide.

#### E4 / E5 — the gated-tool subject, and how non-execution is proven

**Subject: `worktrees-remove`.** The gated set is exactly seven — `env-clear`, `gh-merge-dev`,
`gh-release-deploy-all`, `gh-release-deploy-selected`, `local-deploy`, `release-create`,
`worktrees-remove`. Two candidates that earlier drafts proposed are **invalid and must not be used**:

- ❌ **`worktrees-sync` — NOT GATED.** It has no `requiresHumanConfirm`. Using it would produce a test
  that passes for the wrong reason (no gate to observe) and reports a gate that does not exist.
- ❌ **`worktrees-remove` "against a temp repo with no matching worktrees" — VACUOUS.** With no matching
  worktree the tool **errors without removing anything**. E5's "call 2 executes" assertion could never
  pass, and there would be **no observable side effect in either direction** — so E4's non-execution
  assertion would be unfalsifiable.

**The fixture must be a real infra-kit project WITH an actually matching active worktree.** Reuse the
existing scaffold in `src/commands/__tests__/fail-honestly-outside-project.integration.test.ts` — its
`describe('non-regression: real project and its linked worktree', …)` block (line ~271) already builds
exactly this, including `git worktree add -q -b feature-x`. Lift that setup; do not re-invent it.

Invoke with `versions: "<worktree-name>"`. **Do not pass `all: true`** — it is rejected over MCP by
design, so a test using it measures the rejection, not the gate.

**Primary proxy — filesystem, load-bearing:**

```
after call 1 (no confirm):   the worktree directory still EXISTS on disk
                             AND still appears in `git worktree list`
after call 2 (confirm:true): the directory is GONE
                             AND it no longer appears in `git worktree list`
```

**Secondary proxy — log, cheap:** after call 1 the pino log contains
`Tool execution gated (awaiting confirm): worktrees-remove` and does **not** contain
`Tool execution successful: worktrees-remove`.
*(These two literals are taken from `tool-handler.ts`'s gate/success paths. Re-read them from the source
at implementation time and assert whatever the source actually emits — a paraphrase written here must
never become the reason the test gets loosened.)*

The log proxy is a **secondary** signal. It is cheap and diagnostic, but a logging refactor could
silence it without the gate failing, so it never substitutes for the filesystem proxy.

**Hard precondition.** The fixture repo and its worktree must be **disposable and created fresh per
test**, under `node_modules/.cache` or an `os.tmpdir()` scratch dir, never inside the real repo.
Under the mutant build (below) the gated tool **genuinely executes and genuinely deletes the
worktree** — that is the entire point of the mutation, and it is safe *only* because the fixture is
disposable. This is a hard precondition, not a nicety. `afterAll` removes every fixture directory.

**Documented fallback.** If the worktree scaffold proves too heavy to lift into this file, use
**`env-clear`** instead: it is genuinely gated and its side effect is a local file, so the same
two-proxy structure applies (file present after call 1, absent after call 2). Record the substitution
in the test file's header comment with the reason.

#### Mutation check for E4 — **automated**, not a manual ritual

A gate test that stays green when the gate is removed is worthless, and a manual "delete the branch,
check red, restore" ritual is performed exactly once and never again.

Automate it inside the suite with a **test-only second hermetic build** that neuters the gate via an
esbuild `onLoad` plugin doing a source-level replacement — the mutation never touches the shipped
bundle and there is **no backdoor in production source**.

**The filter and the token must be paired correctly.** Verified in the working tree:
`tool.requiresHumanConfirm` appears in non-test source **only** at `src/mcp/tools/index.ts:21`;
`src/lib/tool-handler/tool-handler.ts:87` uses the **destructured local**, `requiresHumanConfirm === true`.
A plugin that filters `tool-handler.ts` while replacing `tool.requiresHumanConfirm` finds nothing and
trips its own no-op guard on first run. Use the **preferred** pairing — filter `tool-handler.ts`,
replace the destructured predicate:

```ts
const breakGate = {
  name: 'break-confirm-gate',
  setup(b) {
    b.onLoad({ filter: /tool-handler\.ts$/ }, async (args) => {
      const src = await fs.readFile(args.path, 'utf8')
      const mutated = src.replace(/requiresHumanConfirm === true/g, 'false')
      if (mutated === src) throw new Error('mutation no-op: the gate predicate moved — fix this test')
      return { contents: mutated, loader: 'ts' }
    })
  },
}
await esbuild.build({ ...buildOptions, outdir: mutantDir, plugins: [...(buildOptions.plugins ?? []), breakGate] })
```

**What the mutation check asserts.** Against a **fresh disposable fixture**, call `worktrees-remove`
**without** `confirm` on the mutant build, then assert **the filesystem proxy**:

```ts
// Under the mutant the gate is gone: call 1 really executes.
await callWorktreesRemoveWithoutConfirm(mutantClient)
expect(existsSync(worktreeDir)).toBe(false)                  // ← the proxy E4 asserts stays TRUE
expect(await gitWorktreeList(fixtureRepo)).not.toContain(worktreeDir)
```

**Do not assert on the response shape here.** A mutant that returns a differently-shaped response would
satisfy a shape assertion for reasons unrelated to the gate. The filesystem proxy is the same signal E4
asserts in the opposite direction, which is what makes the pair meaningful.

The `mutation no-op` throw is load-bearing: if the predicate is ever renamed, this test tells you the
mutation stopped mutating instead of silently passing.

#### E8-R1 — the literal harness, with the mandatory negative control

The negative control is **not optional**. Without it you cannot distinguish "the pin worked" from
"`getProtocolEra()` always returns `'modern'`". `ClientOptions.versionNegotiation.mode` **defaults to
`'legacy'`** (§H1), so the bare client is a genuine control, not a formality — and per the spawn ledger
it is the **same** client that drives E1–E3/E6/O1/O2, so the control is exercised by everything.

```ts
import { Client, SdkError, SdkErrorCode } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

// --- NEGATIVE CONTROL: no versionNegotiation → mode defaults to 'legacy' ---
// (this is spawn #1, shared with E1/E2/E3/E6/O1/O2)
expect(bare.getProtocolEra()).toBe('legacy')

// --- SUBJECT: pinned to the modern revision (spawn #7, short-lived) ---
const pinned = new Client(
  { name: 'e2e-modern', version: '0.0.0' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
)
const transport = new StdioClientTransport({ command: process.execPath, args: [builtMcpJs], env })

await expect(pinned.connect(transport)).rejects.toSatisfy(
  (e) => e instanceof SdkError && e.code === SdkErrorCode.EraNegotiationFailed,
)
```

**The rejection shape is the assertion — there is no "or" branch.** Primary source: *"`mode: { pin: … }`
— modern only; no fallback, `connect()` **rejects** with `SdkError(EraNegotiationFailed)` against a
2025-only server."* Against an Option-E server `connect()` **never returns**, so any assertion written
after an `await client.connect(...)` is unreachable code that fails as an unhandled rejection and looks
like a broken harness. Earlier drafts offered a `getProtocolEra() !== 'modern'` alternative; that
disjunct is **deleted** — it is the unreachable branch, and offering it invites the wrong test.

The rejection is prompt and deterministic (not timeout-bound): §D measured our server answering
`server/discover` with `-32601` immediately, and a `pin` has no legacy fallback to wait for.

Combined with the passing negative control, E8-R1 **pins the 2025-era ceiling** and goes red the day
someone quietly introduces `serveStdio`. That is exactly the guard Release 1 needs, and it is why
**E8-R1 stays in Release 1** even though every other Release-2 item moved to Appendix B.

#### W1 — differential wire compatibility, with both deltas asserted positively

Not a bare assertion in prose — an assertion in the suite. W1 covers **`initialize` + `tools/list` +
`resources/list`**; Phase 0 step 5 captured all three from a pre-migration build.

1. Spawn the hermetically built migrated `mcp.js` with raw piped stdio (no `Client`), write the same
   raw JSON-RPC lines used to capture the baseline, and collect all three responses. Do this twice —
   once requesting `2025-06-18`, once requesting `2026-07-28` (spawns #5 and #6).
2. **Assert the two known deltas POSITIVELY.** Not as normalizations — as required facts:

   ```ts
   // D1 — v2 auto-declares listChanged on the bare prompts capability
   expect(init.result.capabilities.prompts).toEqual({ listChanged: true })

   // D2 — every tool schema re-serializes to the 2020-12 dialect
   for (const tool of toolsList.result.tools) {
     expect(tool.inputSchema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
     if (tool.outputSchema) {
       expect(tool.outputSchema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
     }
   }
   ```

3. **Then deep-equal everything else against the baseline**, applying exactly these transforms to the
   v1 baseline before comparison — and no others:
   - `capabilities.prompts`: `{}` → `{ listChanged: true }` (delta D1)
   - every `$schema`: `http://json-schema.org/draft-07/schema#` → `https://json-schema.org/draft/2020-12/schema` (delta D2)
   - `serverInfo.version`: normalized — assert it is present and equals the package's own version rather
     than the baseline's literal, since it changes on every release bump.

   **Any third difference fails the test.** That is the whole point: the transform list is a closed
   enumeration, so an unnoticed delta cannot hide inside a generic normalizer.
4. **Do NOT compare v2's schema output against `z.toJSONSchema(schema, { target: 'draft-2020-12' })`.**
   Whether those agree byte-for-byte is an open question (§0b, residual unknown). W1 establishes what v2
   actually emits by diffing against the captured baseline; pre-asserting a re-derivation would replace
   a measurement with a guess.
5. `protocolVersion` must match the baseline for both probes: `2025-06-18` → `2025-06-18`;
   `2026-07-28` → the down-negotiated `2025-11-25`.

**Why W1 must never be trimmed to "tools/list only".** W1's `initialize` coverage is the *only* thing
that pins v2's `registerResource` still auto-declaring `resources.listChanged`. Drop the `initialize`
comparison and that capability could silently disappear — a real host-visible regression — with a fully
green suite. Both halves are load-bearing for different reasons: `initialize` pins the capability
declarations, `tools/list` pins the surface that actually changed.

If W1 is red, Option E was not implemented as specified. It is the single strongest evidence for the
"What to tell the user" claim in §8, and it is what makes a post-publish revert boring.

### Lane 4 — Observability

The MCP server logs via pino to `LOG_FILE_PATH`.

| # | Check | Proves |
|---|---|---|
| O1 | E2E asserts the spawned `mcp.js` writes **nothing** to `stdout` other than valid JSON-RPC frames (rides on spawn #1) | The single most dangerous stdio failure mode. `src/entry/mcp.ts` calls `suppressTypelessPackageJsonWarning()` for exactly this reason; v2 must not reintroduce a stdout write. |
| O2 | E2E asserts the pino log file receives `Tool execution started/successful` lines for a real call (rides on spawn #1) | Logging survived the package swap; a silent server is not diagnosable in the field. |
| O3 | Record in the migration commit message that protocol-level logging (`notifications/message`) is **opt-in per request** under 2026-07-28 (`io.modelcontextprotocol/logLevel` `_meta` key; absent key = silence, not "unfiltered") | Prevents a future contributor adding `sendLoggingMessage` and being baffled by silence. We emit 0 `sendLoggingMessage` calls today, so this is a *forward* hazard. |
| O4 | Phase 6 records, per host, the negotiated version **and the schema-acceptance result** | Turns "does it work?" into a durable artifact instead of a memory. |
| O6 | **New (signal exit), mandatory in Release 1** — see below | The migrated entry still dies when asked to. |

*(O5, the anti-zombie test, is a Release-2 gate and lives in Appendix B.)*

#### O6 — clean exit on `SIGINT` / `SIGTERM` (Release 1, mandatory)

```
GIVEN the hermetically built mcp.js from the migration branch, spawned as a child
WHEN  the process receives SIGINT
THEN  it exits within a bounded timeout (assert < 5 s, well inside the 45 s test timeout)
AND   the same holds for a second run signalled with SIGTERM
```

**Why this is new and why it is not optional.** The v2 packages are new code holding our stdio handles.
If a handle is kept referenced and the existing `SIGINT`/`SIGTERM` → `process.exit(0)` path is
disturbed, the failure mode is not a red assertion — it is **a child that never exits, which converts
this lane's timeout into a wedged fork** and poisons the rest of the run. A test that proves the process
dies on demand is also what keeps the suite's own `afterAll` cleanup honest.

Release 1 changes nothing about lifecycle (the bare `process.exit(0)` stays, per AC6); O6 exists to
prove that "nothing changed" is true rather than assumed.

#### O1 vs the untracked `json-output-purity.test.ts` — decided

The working tree carries an **untracked**
`apps/infra-kit/cli/src/dev/__tests__/json-output-purity.test.ts` from the unrelated dev-server/TUI work.

**Decision: ignore it entirely, and write O1 fresh.**
- The migration branch is cut from clean `main`, where that file **does not exist**. Depending on it
  would couple this migration to unmerged work — a direct violation of Principle 5.
- Its location (`src/dev/__tests__/`) says it targets the **dev server's** stdout, not `mcp.js`.
  Different subject, different process, different failure mode.
- If the dev-server work merges first, **keep both.** Do not dedupe. They assert stdout purity for two
  unrelated binaries; collapsing them would delete one of the guarantees.
- Do not block on, wait for, or import from it. Record this decision in O1's file comment.

---

## 5. Acceptance criteria

Each item is objectively verifiable by a command or a filled-in artifact. **R1 = Release 1 (Option E,
this plan's critical path). R2 = Release 2 (Option B — conditional and unscheduled, Appendix B).**

1. **[R1]** `apps/infra-kit/cli/package.json` `dependencies` contains `@modelcontextprotocol/server@^2.0.0`,
   does **not** contain `@modelcontextprotocol/sdk`, does **not** contain `@modelcontextprotocol/client`,
   and contains `@modelcontextprotocol/core@^2.0.0` **if and only if** the decision command returns
   non-empty:

   ```sh
   grep -rn "@modelcontextprotocol/core" apps/infra-kit/cli/src --include='*.ts' | grep -v __tests__
   ```

   **Empty ⇒ omit `core`.** Non-empty ⇒ add it.
2. **[R1]** `devDependencies` contains **both** fixture packages, each with a stated purpose in an
   adjacent comment or changelog note:
   - `@modelcontextprotocol/sdk@^1.30.0` — the **2025-era client fixture** (E7, and the existing
     `fail-honestly-outside-project.integration.test.ts`).
   - `@modelcontextprotocol/client@^2.0.0` — the **2026-era-capable client fixture** (E8-R1's pinned
     subject and bare negative control). Tests-only; in `dependencies` it would re-import
     jose / cross-spawn / eventsource / pkce-challenge into the published closure.
3. **[R1]** `grep -rn "@modelcontextprotocol/sdk" apps/infra-kit/cli/src` returns matches **only** under
   `__tests__/` directories. Enforced by test U6, landed green in the same commit as AC1's demotion.
4. **[R1]** No `catalog:` protocol appears in the packed tarball's `dependencies` (verified by
   `pnpm pack` + reading the **packed** `package.json`, not the source tree). Enforced by U7 clause 3.
5. **[R1]** `src/entry/mcp.ts` **retains** `new StdioServerTransport()` and `await server.connect(transport)`,
   now imported from `@modelcontextprotocol/server/stdio` / `@modelcontextprotocol/server`, and **retains
   both `try/catch` → `logger.error(...)` → `process.exit(1)` paths verbatim**. It contains **no**
   `serveStdio`. (E8-R1 enforces this at the protocol level; U6/U7 enforce the manifest side.)
6. **[R1]** Lifecycle is **unchanged**: the existing bare `process.exit(0)` on `SIGINT`/`SIGTERM` stays,
   and **O6 proves the process actually exits on both signals within a bounded timeout.**
   *(The bounded-teardown criterion for `StdioServerHandle.close()` is a Release-2 item — Appendix B, AC6.)*
7. **[R1]** `pnpm run ts-check` passes with **zero edits under `src/commands/**`** — expected, since
   §I2's auto-wrap keeps raw shapes valid. Any edit there means something unexpected happened; explain it.
8. **[R1]** `pnpm run qa` passes on a cold run **at every phase boundary**, not only at the end.
   `eslint-check` is re-run with `--no-cache` (repo memory: `--cache` can exit 0 while a cold run finds
   real errors), and `git status` shows no untracked `??` files from the migration.
9. **[R1]** E7 passes: the full E1–E6 surface driven by a **v1** client against the migrated server.
10. **[R1]** E4 and E5 pass, **and E4 asserts non-execution via the named filesystem side-effect proxy,
    not the response shape alone**, **and the E4 mutation check is automated in-suite** (§4): a test-only
    gate-neutered build makes the **filesystem proxy** flip (the worktree really gets removed on the
    unconfirmed call), and the mutation plugin throws if its replacement becomes a no-op.
    The gated subject is `worktrees-remove` against a disposable fixture with a real matching worktree
    (documented fallback: `env-clear`); **`worktrees-sync` is not gated and must not be used.**
11. **[R1]** O1 passes: the spawned `mcp.js` emits nothing on stdout but valid JSON-RPC frames.
    O1 is written fresh and is independent of the untracked `json-output-purity.test.ts`.
12. **[R1]** **E8-R1 passes with its negative control**: a bare v2 client (no `versionNegotiation`)
    reports `getProtocolEra() === 'legacy'`, **and** a client pinned to `2026-07-28` **rejects on
    `connect()`** with the typed error:

    ```ts
    await expect(pinned.connect(transport)).rejects.toSatisfy(
      (e) => e instanceof SdkError && e.code === SdkErrorCode.EraNegotiationFailed,
    )
    ```

    There is **no** `getProtocolEra() !== 'modern'` alternative — against an Option-E server `connect()`
    never returns, so that branch is unreachable. *(E8, the Release-2 modern-era proof, is in Appendix B.)*
13. **[R1]** Phase 6's matrix has the MCP Inspector and Claude Code rows completely filled and passing
    against the migration build — **including the "tool arguments validate / schemas accepted" column** —
    **and `.mcp.json` is reverted to its committed form**.
13b. **[R1 + R2]** If **any** host in Phase 6 negotiates `2026-07-28`, the **full E1–E6 tool surface
    is re-verified against that host** — not merely "it connects". A modern connection with an
    unverified confirm gate blocks the release.
14. **[R1]** The migration lands as a **single revertable commit range** on a branch cut from clean
    `main`, containing no dev-server/TUI changes and **no `.mcp.json` diff**.
15. **[R1]** **Binary externalization assertions** on the emitted bundle text (not a size heuristic):
    - **B1** — `mcp.js` contains the bare specifier `@modelcontextprotocol/server` in an import
      statement (i.e. it survived as an external, not inlined).
    - **B2** — `mcp.js` contains the bare specifier `@modelcontextprotocol/server/stdio` in an import
      statement. **If B2 fails, B1 will fail too** — esbuild externalizes subpaths of a package key
      already in `external`. Diagnose the `external` derivation; **do not patch the array** (Phase 5
      step 2; patching it would contradict AC17).
    - **B3** — `mcp.js` contains **neither the string literal `'2026-07-28'` nor `'2025-11-25'`**.
      *(The earlier form asserted the absence of the v2-internal identifier
      `SUPPORTED_MODERN_PROTOCOL_VERSIONS`. That was a false green: `scripts/build.js:44` sets
      `minify: true`, and an identifier is renamed by minification, so the assertion passed clean even
      on a fully-inlined bundle. Minification **preserves string literals**, so the protocol-revision
      strings are the sound marker. Do not "improve" this back into an identifier check.)*
16. **[R1]** W1 passes across **`initialize` + `tools/list` + `resources/list`**, for both probed request
    versions: the two known deltas D1 and D2 are asserted **positively**, `serverInfo.version` is
    normalized, and **every other field is deep-equal to the Phase 0 v1 baselines**. Any third
    difference fails.
17. **[R1]** `scripts/build.js`'s `external` comment no longer claims that a package key fails to cover
    its subpaths; it correctly attributes the React entries to esbuild's auto-injected JSX import.
18. **[R1]** The e2e lane lives in **one file** (`src/mcp/__tests__/mcp-stdio.e2e.test.ts`), uses
    `120_000` for the build `beforeAll` and `45_000` for every spawning test, stays within **≤4
    long-lived + ≤4 short-lived child spawns** per the ledger, and force-kills survivors in `afterAll`.

---

## 6. Rollback plan and release sequencing

*(The Release-2 post-publish analysis — the irreversible one — lives in **Appendix B**.)*

### Rollback — **pre-publish** vs **post-publish** are different animals

#### Pre-publish (cheap, always available)

**Trigger conditions (any one → stop):**
- Phase 6's Inspector or Claude Code row fails — **including the schema-acceptance column**.
- E4 goes red (PM-2's residual veto).
- W1 goes red (a third wire delta appeared, or D1/D2 are not what §0b measured — Option E was not
  implemented as specified).
- The packed tarball's `dependencies` are wrong at Phase 7's pack inspection.

**Mechanism:** `git revert` the migration commit range. Because the work lands as one isolated range on
a branch from clean `main`, this restores `@modelcontextprotocol/sdk@^1.30.0` and the v1 entry exactly.
**That reverted state is Option A**, an established legitimate end state, not a broken one. There is no
half-migrated state to nurse. **Cost: minutes.**

#### Post-publish — Release 1 (Option E): ordinary, because the wire barely moved

Publish `0.3.16` reverting the package swap. **No host renegotiates protocol in either direction; tool
schemas revert to the `draft-07` form every host already accepted.** The only moving parts are which npm
packages get installed and which JSON Schema dialect label the tool schemas carry.

**Exposure window:** bounded by npm propagation plus infra-kit's silent global auto-update cycle (repo
memory: `silent-auto-update-risk-accepted` — users are updated without a prompt), so realistically
**minutes to hours**, and the failure mode during that window is a dependency-resolution or bundling
problem, or a host that is unexpectedly strict about the `$schema` dialect — not a protocol outage.

### Release sequencing (Release 1)

1. `pnpm run qa` on the migration branch — cold, with `eslint --no-cache`, `git status` clean.
2. Re-run `lock.test` and `portless-driver.test` **individually** if they failed under load — repo memory
   flags both as known-flaky under full-suite pressure. Do not call a load flake a regression, and do not
   call a real regression a flake.
3. `pnpm run build`; verify `dist/mcp.js` exists and passes B1–B3 (AC15) and W1 (AC16).
4. **Phase 6 gate.** Matrix filled — schema-acceptance column included — `.mcp.json` reverted. No
   publish without it.
5. `pnpm pack`; unpack the tarball; read the **packed** `package.json` — assert AC1, AC2, and AC4
   against it.
6. Merge to `main`.
7. Version bump. **This change touches only `infra-kit`, not `@slip-stream-kit/config`** — it is confined
   to `apps/infra-kit/cli`. Therefore the cli↔config lockstep dance (*bump → publish config → re-pin →
   publish cli*) is **not** triggered. **Verify this before bumping**: if the config package's manifest
   is untouched by the diff, publish `infra-kit` alone.
8. Publish `infra-kit`.
9. Smoke-test the **published** artifact: `pnpm add -g infra-kit@latest`, then re-run Phase 6's Inspector
   row against the globally installed binary. Repo memory: consumer repos run the **global** install, and
   a global copy can share a version string with the workspace while differing in code — verify via
   `dist/mcp.js` by absolute path, never `pnpm exec`.
   **Failure here is a patch release, not an unpublish** — step 5's pack inspection is the gate that
   makes this recoverable, which is why it precedes publish rather than following it.

---

## 7. ADR — Migrate infra-kit's MCP server to SDK v2, wire held to two known deltas (Release 1)

**Status:** Proposed — pending approval.
**Date:** 2026-08-16 (revision 3; supersedes revision 2's wire claim and its Phase 6b).
**Context:** `infra-kit@0.3.14` ships an MCP server over stdio, spawned per client as a child process,
built on `@modelcontextprotocol/sdk@^1.30.0`.

### Decision

Migrate to `@modelcontextprotocol/server@2.0.0` (+ `@modelcontextprotocol/core@2.0.0` only if directly
imported from non-test source) and **keep the hand-constructed `new StdioServerTransport()` +
`await server.connect(transport)` entry** in `src/entry/mcp.ts`. Retain
`@modelcontextprotocol/sdk@^1.30.0` and add `@modelcontextprotocol/client@^2.0.0` as **devDependencies**,
the 2025-era and 2026-era-capable client fixtures for the e2e suite. Do **not** adopt `serveStdio` in
this release. Do **not** add an HTTP transport. Do **not** pin modern-only.

`serveStdio` (Option B) is planned as **Release 2 — conditional and unscheduled**, gated on trigger
conditions T1–T3 (Appendix B), a fresh dated host-era matrix, and its own ralplan pass.

> **The wire claim, stated exactly.** Release 1 changes exactly two things on the wire, both measured and
> both asserted by W1: `initialize.capabilities.prompts` gains `listChanged: true` (v2 auto-declares it
> from the same `prompts: {}` input v1 left bare), and every tool's `inputSchema`/`outputSchema`
> re-serializes from JSON Schema `draft-07` to `draft-2020-12`. Schema semantics — properties, types,
> descriptions, `required`, `additionalProperties` — are unchanged. Everything else in `initialize` is
> byte-identical. W1 asserts both deltas POSITIVELY and blocks the release on any third difference.

### Drivers

1. **Irreversibility asymmetry.** A package swap whose wire deltas are two named, asserted, semantically
   inert ones reverts cheaply in both directions. An era flip does not: `ServeStdioOptions.legacy` has no
   legacy-only value (§K), so the modern path cannot be disabled without republishing — into a silent
   global auto-update channel.
2. **Dependency weight in a globally installed CLI.** Published `dependencies`: 93 transitive packages →
   3; the whole Express/Hono/JOSE/AJV/CORS/pkce stack leaves the runtime closure of a stdio-only server
   that never opens a socket. **This benefit is fully realized without touching the protocol era.**
3. **Blast radius is small but behavioral.** 5 non-test source files import the SDK; 0 uses of
   `McpError`/`RequestHandlerExtra`/`setRequestHandler`; 25 `defineMcpTool` call sites across 24 files
   all funnel through one factory, and v2 still auto-wraps their raw shapes. The risk lives in
   semantics — chiefly the confirm gate's dependence on `isError` skipping output validation — not in
   line count.

### Alternatives considered

- **A. Stay on v1.30.0.** Zero risk, zero cost, a legitimate end state — but it forgoes a measured 93→3
  dependency reduction in a globally installed CLI and is an implicit decision to never adopt 2026-07-28.
  **Retained as the rollback target.**
- **B. v2 + default dual-era `serveStdio`.** *(Revision 1's choice.)* Correct eventually, wrong now.
  §I1 verified that `classifyOpeningMessage` pins a connection to `modern` on any valid modern `_meta`
  envelope, and our current server answers that probe `-32601` — so adopting `serveStdio` **flips every
  already-`auto`-capable host onto the 2026 path on upgrade**, over a population we cannot enumerate at
  publish time, with no kill switch (§K). §D proves there is **no live breakage today**, so nothing
  forces the flip. **Deferred to a conditional Release 2** (Appendix B, triggers T1–T3).
- **C. v2 + `legacy: 'reject'`.** Refuses every 2025-era opening. Strictly more risk than B with no
  offsetting benefit for stdio. **Rejected for both releases**; revisit only if every supported host
  negotiates 2026-07-28.
- **D. Add a stateless HTTP transport (`createMcpHandler`).** **Invalidated as unmotivated:** no HTTP
  surface exists, official guidance does not push stdio servers to HTTP, it would add auth/transport/
  lifecycle attack surface to a CLI that shells out to `git`/`gh`/`aws`/deploy scripts, and it would
  re-import the very dependency stack E deletes.
- **F. E by default + `serveStdio` behind `INFRA_KIT_MCP_MODERN=1`.** **Invalidated by a cheaper
  substitute:** its only unique benefit is real host-era data without a second publish, and that data is
  obtainable at any time from a **local unpublished spike build with `.mcp.json` repointed** — in
  particular as the opening step of whenever Release 2 is planned. F would pay a permanent second shipped
  code path and a user-facing support flag for nothing incremental, and a flag nobody exercises is dead
  code in the bundle of a globally installed CLI.

### Why E was chosen

Because it **separates the two things the user's request conflated.** "Move to the version that supports
stateless" is really (i) get onto the package line that *can* support it and (ii) turn it on. (i) is a
measured, one-directional win with a revertable footprint and two semantically inert wire deltas. (ii) is
an irreversible, unmeasured flip over an unknown host population, with nothing currently broken to
justify it.

E ships (i) with the wire pinned to exactly two named deltas — a claim **asserted in the suite** by W1,
not merely stated — and leaves (ii) to a release that starts with data instead of ending with it. Under
Principle 2 (*compatibility beats modernity*), E is the option that actually applies the principle;
revision 1's Option B did not, because its stated "worst realistic outcome" was inverted.

### Consequences

**Positive**
- **A real, user-visible win ships in Release 1:** the published `dependencies` closure of a *globally
  installed* CLI drops from 93 transitive packages to 3, removing the entire
  Express/Hono/JOSE/AJV/CORS/pkce stack — install size, install time, and third-party attack surface all
  fall. This is not optionality; it is delivered value.
- `infra-kit` is on the only package line that can ever serve 2026-07-28, so Release 2 — if its trigger
  fires — becomes a small, isolated, well-instrumented diff rather than a bundled one.
- We gain a genuine protocol-level e2e suite (unit / integration / e2e / observability) plus a
  differential wire test across all three list surfaces, where none was formalized.
- Two client fixtures (v1 `sdk`, v2 `client`) become permanent, cheap regression guards in both eras.
- E8-R1 pins the era ceiling, so an accidental future `serveStdio` cannot land silently.

**Negative / accepted**
- Two releases instead of one — and the second is **conditional**, so the user's headline ask
  ("stateless") may not land at all unless T1, T2, or T3 fires.
- **The wire is not untouched.** Two measured deltas ship: `prompts.listChanged`, and the
  `draft-07` → `draft-2020-12` schema dialect. Both are semantically inert and hosts overwhelmingly treat
  the dialect URI as advisory, but "zero new bytes" would have been a false claim and is not made.
  Phase 6's schema-acceptance column is the measurement that backs this.
- The v2 packages are new code in our runtime path. "Two known wire deltas" is not "no code change"; it
  is upstream's own statement, §L's source evidence, and W1's assertion — none of which proves behavioral
  identity *inside* the handshake. The four lanes exist to cover that gap.
- **Two devDependencies are retained/added indefinitely as test fixtures.** The 93→3 claim is scoped to
  published `dependencies`; `sdk` + `client` do pull jose / eventsource / pkce-challenge / cross-spawn
  into the **dev** tree only. Consumers never install them. Accepted: they are the cheapest available
  two-era regression guards.
- The esbuild `external` list is derived from `dependencies` — a manifest mistake silently inlines an SDK
  rather than erroring, and the in-suite hermetic build would happily test the inlined bundle. Mitigated
  by phase ordering, U6/U7, and the binary externalization assertions B1–B3.
- `tool-handler.ts`'s confirm gate depends on SDK output-validation semantics. §H2 verified v2 preserves
  it; if E4 ever goes red, the migration does not ship.
- **Lifecycle does not improve in Release 1.** The bare `process.exit(0)` on `SIGINT`/`SIGTERM` stays;
  O6 proves it still works rather than improving it. The bounded-teardown work is a Release-2 item.
- **Release 2, if ever taken, carries an irreversibility we cannot mitigate technically**, only
  procedurally (Appendix B). That is a permanent property of `serveStdio`, not a gap in this plan.

**Neutral**
- Statelessness confers no scaling benefit here — one process still serves one client. That was never
  the point, and the changelog must not imply otherwise.

### Follow-ups

1. **Release 2 (Option B) — conditional and unscheduled.** See **Appendix B**: triggers T1–T3, the
   pre-verified hazards (PM-4, AC5-R2, AC6, O5, E8), and the requirement that it open by collecting a
   fresh dated host-era matrix. **Its own ralplan pass.**
2. **Deprecation hygiene (off the critical path):** migrate `defineMcpTool`/`CatalogMcpTool` from
   `z.ZodRawShape` to `z.object()`. Per §I2 v2 still auto-wraps raw shapes via a `@deprecated`
   `registerTool` overload, so this is not a blocker. Preferred landing site is the single `registerTool`
   call in `src/mcp/tools/index.ts` (~4 lines, zero edits under `src/commands/**`).
3. If protocol-level logging is ever added, remember `notifications/message` is **opt-in per request**
   under 2026-07-28 via the `io.modelcontextprotocol/logLevel` `_meta` key — an absent key means silence,
   not "unfiltered".
4. Revisit `requestState` only if we ever multiplex clients in one process. Today we do not, and it is
   untrusted (client-round-tripped) input by design.
5. The process-scope mutable singletons (`mcpMode`, `jsonOutput`, `commandEcho`, `config-bootstrap.seeded`,
   config `cached`/`cachedPaths`) are safe **only** because one process serves one client. If that ever
   changes they become a correctness problem before a performance one. Note it near `createMcpServer()`.
6. Separately tracked latent bug (memory `config-cache-keyed-on-mtimes-only`): the merged-config cache
   hit-tests on mtimes with no path/cwd key. **Out of scope here; do not fold it in.**

---

## 8. What to tell the user

Plain language, no hedging:

> **Your premise was right about the spec and wrong about the package.** MCP really did go stateless —
> spec revision `2026-07-28` deletes the `initialize` handshake and moves protocol version and client
> identity into per-request `_meta`. But there is no newer version of the package we depend on:
> `@modelcontextprotocol/sdk` is at `1.30.0` and we're already on it. v2 shipped as a **package split**
> (`@modelcontextprotocol/server` / `core` / `client`), and the 2026 support guide is explicitly scoped
> to code already on those packages. So this is a package migration, not a version bump.
>
> **Release 1 changes two things on the wire and nothing else, and we assert both with a test that
> diffs against a baseline captured from today's build.** First, the server now advertises
> `prompts.listChanged` where before it advertised an empty prompts capability — we register no
> prompts either way. Second, the JSON Schemas we publish for all 23 tools move from JSON Schema
> draft-07 to draft-2020-12. Same fields, same types, same required keys — the dialect label changes,
> and hosts treat it as advisory. Any third difference stops the release.
>
> Moving to v2 and turning the 2026 protocol on are two separate switches, and Release 1 flips only the
> first. We keep the hand-wired stdio transport, which by upstream's own statement — and by the v2
> source itself, whose legacy negotiation table contains no 2026 entry — serves exactly the protocol era
> we serve today. We also verify with real hosts that the new schema dialect is accepted before anything
> publishes.
>
> **What Release 1 genuinely delivers:**
> - The published dependency closure drops from **93 transitive packages to 3.** The entire
>   Express + Hono + JOSE + AJV + CORS + pkce stack leaves a **globally installed** CLI where it was
>   pure dead weight — our MCP server is stdio-only and never opens a socket. Smaller install, faster
>   install, less third-party attack surface. (Two test-only devDependencies stay behind for the
>   two-era regression suite; consumers never install those.)
> - We land on the **only package line that can ever serve 2026-07-28.** Staying on v1 is a permanent
>   decision to stay in the 2025 protocol era.
> - A real protocol-level test suite where we had almost none, including a permanent guard on the
>   destructive-tool confirmation gate.
>
> **Release 2 — the one that actually turns the protocol on — is conditional, not scheduled.** Nothing
> is broken today: we measured it, and a 2026-era client probing our current server degrades cleanly and
> connects. So we do it only when one of three things happens: **(T1)** a host we support demonstrably
> drives modern-envelope connections and gains something measurable from it; **(T2)** upstream
> deprecates or end-of-lifes the 2025-era negotiation path; or **(T3)** we need a capability that only
> exists in 2026 — `input_required`, `requestState`, per-request identity. **None of those hold today.**
> And the flip isn't reversible without republishing: any host that already probes with a modern
> envelope gets pinned to the 2026 code path the moment it connects, and the SDK offers no way to turn
> that off short of shipping a new version. Since infra-kit auto-updates globally and silently, a bad
> flip is hours-to-days of exposure we can't observe. When a trigger does fire, that release starts by
> measuring which hosts actually flip — against a local, unpublished build, on your machine, costing
> nothing — and then decides with data instead of hoping.
>
> If you'd rather have the protocol flip sooner and accept that exposure, say so and we'll merge the two
> releases. That's a real option; it just isn't the default I'd pick for something that ships to a
> global install.

---

## Appendix A — Verified deltas from the ground-truth brief

**A1. The tool-schema change collapses to one choke point — and is not a blocker at all.**
Every `*McpTool` definition is constructed through a single factory:

```ts
// src/types.ts
export const defineMcpTool = <TIn extends z.ZodRawShape, TOut extends z.ZodRawShape>(
  tool: McpTool<TIn, TOut>,
): McpTool<TIn, TOut> => tool
```

**25 `defineMcpTool({` call sites across 24 files; zero hand-rolled `McpTool` object literals.**
Combined with `src/mcp/tools/index.ts` holding the repo's **only** `registerTool` call, the wrap could
land in ~4 lines with no edits under `src/commands/**`. More importantly, §I2 verified that v2 ships a
`@deprecated` raw-shape `registerTool` overload that auto-wraps with `z.object()` — so our raw shapes
compile and run unchanged. **This is deprecation hygiene, moved off the critical path to a follow-up.**

**A2. A protocol-level test already exists.**
`src/commands/__tests__/fail-honestly-outside-project.integration.test.ts` imports `Client` from
`@modelcontextprotocol/sdk/client/index.js` and `StdioClientTransport` from
`@modelcontextprotocol/sdk/client/stdio.js`, builds hermetically via the exported `buildOptions`, and
drives the real spawned `dist/mcp.js`.

Consequences:
- The e2e lane **extends existing, proven infrastructure** rather than inventing it — including its
  `beforeAll(…, 120_000)` build timeout and `45_000` per-spawning-test timeouts, which §4 adopts as rules.
- Its `describe('non-regression: real project and its linked worktree', …)` block (line ~271) already
  scaffolds a real infra-kit project **with a linked worktree** via `git worktree add -q -b feature-x`.
  **That scaffold is the E4/E5 fixture.** Lift it; do not re-invent it.
- **It does not break on the dependency swap.** Because `@modelcontextprotocol/sdk` is retained as a
  `devDependency` (AC2), this test's v1 client imports keep resolving. *(Revision 1 claimed it "will
  break and must be migrated" — that was wrong, and the devDep retention is exactly why.)*
- It is the source of E7's harness pattern, though E7 itself lands in the single e2e file per AC18.

**A3. This repo is its own MCP client.**
`/Users/arthur/projects/infra-kit/.mcp.json` registers `infra-kit` → `infra-kit mcp` (stdio). Repointing
that entry at the migration build makes this repo a realistic Phase 6 canary — at the cost of a
**tracked-file edit that must be reverted before the commit range is finalized** (AC13, AC14).

**A4. Counts, corrected.**
- **23** exposed MCP tools (`mcpExposed: true`); 15 not exposed; 39 total `mcpExposed:` lines including
  the interface declaration.
- **25** `defineMcpTool(` call sites across **24** files.
- **5** non-test source files import `@modelcontextprotocol/*`: `src/entry/mcp.ts`, `src/mcp/server.ts`,
  `src/mcp/tools/index.ts`, `src/mcp/resources/index.ts`, `src/mcp/prompts/index.ts`.
- **7** gated (`requiresHumanConfirm`) tools: `env-clear`, `gh-merge-dev`, `gh-release-deploy-all`,
  `gh-release-deploy-selected`, `local-deploy`, `release-create`, `worktrees-remove`.
  **`worktrees-sync` is not among them.**
- `tool.requiresHumanConfirm` appears in non-test source exactly once, at `src/mcp/tools/index.ts:21`.
  `src/lib/tool-handler/tool-handler.ts:87` uses the destructured local `requiresHumanConfirm === true`.
  This pairing dictates the E4 mutation plugin's filter/token (§4).
- Revision 1's "24 exposed tools" conflated the file count with the tool count. **Never hard-code any of
  these numbers in a test** — E1 computes the expected set from `getExposedMcpTools()` and adds a `> 20`
  deletion floor.

---

## Appendix B — Release 2: trigger conditions and pre-verified hazards

**This appendix is unnumbered and unscheduled. Nothing in it is authorized by this document.**
It exists so the work already verified for `serveStdio` is not re-derived — and so the reasons it is
*not* being done are not forgotten either.

### B.0 Trigger conditions — Release 2 is not planned until one of these holds

| # | Trigger | Holds today? |
|---|---|---|
| **T1** | A host we support **demonstrably drives modern-envelope connections** and gains something **measurable** from 2026-era serving. | **No.** §D measured a 2026-era `auto` probe against our current server: `server/discover` → clean `-32601`, process alive, client falls back to legacy and connects normally. |
| **T2** | Upstream **deprecates or end-of-lifes** the 2025-era negotiation path. | **No.** `@modelcontextprotocol/core@2.0.0` still ships the full `SUPPORTED_PROTOCOL_VERSIONS` list (`2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07`) and `serveStdio` serves legacy openings **by default**. |
| **T3** | We need a **2026-only capability**: `input_required` multi-round-trip flows, `requestState`, or per-request client identity from `ctx.mcpReq.envelope`. | **No.** We use none of them; `requestState` is only relevant if we ever multiplex clients in one process, which we do not. |

**None hold today. §D proves there is no live breakage.** Release 2 is therefore forward-looking
optionality, not remediation, and it is correct to leave it unscheduled.

**Release 2 opens by collecting a fresh dated host-era matrix; an earlier matrix is not evidence.**
Under Option B a host can flip its own era on *its* next update with no `infra-kit` release at all. A
matrix dated today says something about today only. The matrix is collected from a **local, unpublished
spike build** with `.mcp.json` repointed (same literal procedure as Phase 6, same restart requirement,
same mandatory revert), on a throwaway branch deleted afterwards — this is also the substitute that
invalidates Option F, and it is available on demand rather than being a phase of this plan.

| Host | Era observed against the `serveStdio` spike | Date | Tool surface re-verified (AC13b) |
|---|---|---|---|
| MCP Inspector | | | |
| Claude Code | | | |
| Cursor | | | |
| Zed | | | |

### B.1 PM-4 — The zombie server (pre-verified hazard)

**The failure.** Release 2 adopts `serveStdio` without `options.onerror`. Verified verbatim (§I4):

```js
const reportError = (error) => { try { options.onerror?.(error); } catch {} };   // SOLE error channel
...
const started = wire.start().catch((error) => { reportError(toError(error)); throw error });
started.catch(() => {});                        // ← the rethrow is swallowed here
return { close: async () => { await started.catch(() => {}); await closeAll(); } };
```

With `onerror` omitted, `reportError` is a no-op (`?.` on undefined) and the rethrown rejection is
swallowed. A transport-start failure produces **no log, no exit, no crash.** Worse: because `serveStdio`
re-invokes the factory per message, a **throwing factory** yields a live process that answers `-32603`
to every request forever, with an **empty log file**, while the host reports the server as "connected".

Today `src/entry/mcp.ts` logs and `process.exit(1)`s on both failure modes. Adopting `serveStdio`
without `onerror` is a strict, silent regression in field diagnosability — and the *only* thing that
distinguishes a zombie from a healthy server is the log line that no longer exists.

**Earliest signal.** Test **O5** (below) — mandatory before Release 2 ships.

**Rollback.** None available post-publish beyond a patch release (§K: no kill switch). This is precisely
why B is not Release 1.

### B.2 AC5-R2 — mandatory `onerror` + fatal factory guard

**[R2, mandatory]** Wherever `serveStdio` appears, `options.onerror` is passed and logs at `error` level
with a `logger.flush()`; **and** the factory is wrapped so a construction failure logs and calls
`process.exit(1)` rather than degrading to a repeating `-32603`.
**`serveStdio` without `onerror` is a blocking review defect, not a style note.**

```ts
const buildOrDie = async () => {
  try {
    return await createMcpServer()
  } catch (error) {
    logger.error({ err: error, msg: 'Failed to create MCP server' })
    logger.flush()
    process.exit(1)   // must not degrade to a repeating -32603
  }
}

const handle = serveStdio(buildOrDie, {
  onerror: (error) => {
    logger.error({ err: error, msg: 'MCP stdio entry error' })
    logger.flush()
  },
})
```

Note `serveStdio` returns **synchronously** (`StdioServerHandle`, not a Promise) — §E1. The current
`await server.connect(transport)` shape does not survive verbatim, and the existing `try/catch` no
longer catches transport-start failures. That is what `onerror` is for. **Do not silently drop error
reporting here.**

### B.3 AC6 — bounded teardown on `SIGINT`/`SIGTERM`

**[R2]** The signal path performs a **bounded best-effort** teardown:

```ts
await Promise.race([handle.close(), setTimeout(1500)])
process.exit(0)   // regardless of which won
```

A hung `close()` must never prevent the process from exiting: an unbounded `await close()` on a wedged
transport converts a clean exit into a hang, which is worse than the bare `process.exit(0)` we have
today. *(Release 1 changes nothing about lifecycle; O6 proves the existing path still exits.)*

### B.4 O5 — anti-zombie test (Release 2 gate)

```
GIVEN the built mcp.js from the serveStdio branch
AND   an env-injected factory that throws on construction
       (e.g. INFRA_KIT_TEST_FORCE_FACTORY_THROW=1, honored only in a test-only build variant
        produced by the same onLoad-plugin technique as the E4 mutation check —
        never a runtime backdoor in shipped source)
WHEN  the process is spawned
THEN  the process exits with a NON-ZERO code within a bounded timeout
AND   the pino log file contains at least one `error`-level line naming the failure
AND   the process does NOT stay alive answering -32603
```

Both assertions are required. Non-zero exit without a log line is undiagnosable; a log line without an
exit is the zombie.

### B.5 E8 — the actual 2026-era proof (Release 2 gate)

```ts
// Against the serveStdio build:
expect(pinned.getProtocolEra()).toBe('modern')   // subject
expect(bare.getProtocolEra()).toBe('legacy')     // control — proves dual-era from the same factory
```

Then **re-run E1–E6 over the pinned connection** — that is AC13b in test form. A modern connection with
an unverified confirm gate blocks the release.

*(In-process alternative, recorded so it is not rediscovered: `ServeStdioOptions.transport` accepts any
`Transport`, and `StdioServerTransport`'s constructor takes `(stdin?, stdout?)`. A `PassThrough` pair
therefore carries real 2026-era bytes in-process — §E4. This does **not** contradict the no-false-greens
rule, which bans `InMemoryTransport.createLinkedPair()` specifically, because that helper is hardwired
to 2025-era instances.)*

### B.6 §K — there is no kill switch (the reason all of the above is deferred)

`ServeStdioOptions.legacy` accepts only `'serve'` or `'reject'`. **There is no legacy-only value.**
Once `serveStdio` ships:

- The modern path **cannot be disabled without republishing.** No env var, no config key, no flag —
  Option F was considered and invalidated precisely because buying one would cost a permanent shipped
  code path.
- The affected population is **unenumerated at publish time** (§I1): every already-`auto`-capable host
  flips to the 2026 path on first connect after the upgrade. We learn who they were from bug reports.
- Because global auto-update is **silent**, the fix does not reach users when *we* publish it; it reaches
  them when *their* next auto-update fires. **Named exposure window: from the first field connect until
  the corrective release has propagated through silent global auto-update — realistically hours to days,
  and not directly observable by us.**
- During that window every affected user is on a code path that, per PM-4, can fail *silently* if the
  `onerror` amendment is imperfect.

**Mitigation is entirely front-loaded:** a fresh dated host matrix, AC13b's full-surface re-verification
on any modern-negotiating host, O5's anti-zombie test, AC5-R2, AC6, E8 with its negative control, and a
dedicated ralplan pass.

---

## 9. Conditions C1–C8 — exit checks

Each condition has a one-line, grep-checkable test against this document. All eight must pass for the
plan to be considered finalized. Run from the repo root against `docs/mcp-stateless-migration-plan.md`.

| # | Condition | Exit check |
|---|---|---|
| **C1** | The wire claim is the §P two-delta statement — never "byte-identical to v1's" and never "zero new bytes". W1 asserts both deltas positively, covers all three list surfaces, and does not pre-assert `z.toJSONSchema` equivalence. | `grep -n "zero new bytes" \| grep -v "corrected replacement\|false claim and is not made\|C1"` → **no hit** — the phrase survives only as an explicit repudiation in §0b and §7 (3 hits total, including this row). `grep -n "byte-identical"` → every hit is the scoped *"Everything else in `initialize` is byte-identical"*, §0b's residual-unknown note, or this row — **never** a claim of full identity. `grep -c "asserts both deltas POSITIVELY"` → **3** (§0b + §7 + this row). §0b's table lists exactly **D1** (`prompts.listChanged`) and **D2** (`draft-07` → `draft-2020-12`), and nothing else. AC16 names `initialize` + `tools/list` + `resources/list`. `grep -n "toJSONSchema"` → §0b's *"do not assert either way"* and §4 W1 step 4's *"Do NOT compare"* — no positive assertion anywhere. |
| **C2** | Phase 6b struck and 6a renumbered to 6; PM-4 / AC5-R2 / AC6 / O5 / E8 and the Release-2 half of §6 moved to Appendix B with §I4's verbatim snippet and §K's no-kill-switch finding; triggers T1–T3 stated with "none hold today"; Option F's invalidation re-anchored off the struck phase; release-map gate row updated; E8-R1 kept in R1; §8 conditional and the merge offer verbatim. | `grep -c "Phase 6a"` → **1**, and it is this row's own check text. `grep -n "Phase 6b"` → **3**: the revision header, the ADR date line, and this row — i.e. it appears only as *"struck"* / *"supersedes"* history, never as a phase anyone executes. `grep -c "^### Phase 6 —"` → **1**. Appendix B contains T1/T2/T3 and *"None hold today"*, the verbatim `reportError`/`started.catch` snippet (B.1), and §K (B.6). Option F's decisive con reads *"runnable on demand, and specifically as the opening step of whenever Release 2 is planned"* — no phase reference. Release-map R2 gate cell reads *"its own ralplan pass, which must open by collecting a dated host-era matrix"*. `grep -n "E8-R1"` → present in §4 Lane 3 and AC12 marked **[R1]**. §8 names T1–T3 and closes with *"If you'd rather have the protocol flip sooner…"* unchanged. |
| **C3** | Confirm-gate subject is `worktrees-remove` against a fixture with a real matching worktree; `worktrees-sync` removed as a candidate; the no-matching-worktree variant rejected as vacuous; filesystem proxy primary, log proxy secondary; mutation check asserts the filesystem proxy; disposable-fixture precondition stated as hard; `env-clear` documented as fallback; AC10 extended. | `grep -n "worktrees-sync"` → every hit says **NOT gated / must not be used**. `grep -n "git worktree list"` → hits in E4/E5 **and** in the mutation check. `grep -n "all: true"` → the hit is a prohibition (*"Do not pass"*). `grep -n "versions:"` → the invocation shape is stated. `grep -c "Hard precondition"` → **2** (the E4/E5 subsection + this row); the subsection hit names the disposable fixture. AC10 contains *"via the named filesystem side-effect proxy, not the response shape alone"*. `grep -n "env-clear"` → includes the **Documented fallback**. |
| **C4** | The E4 mutation plugin filters `tool-handler.ts` and replaces the **destructured** predicate; the no-op throw is kept. | `grep -n "requiresHumanConfirm === true"` → appears inside `src.replace(/requiresHumanConfirm === true/g, 'false')`. `grep -n "tool\.requiresHumanConfirm"` → appears **only** as the rejected pairing and the `src/mcp/tools/index.ts:21` fact — never inside a `src.replace`. `grep -n "mutation no-op"` → ≥ 1 hit. `grep -c "filter: /tool-handler"` → **2** (the plugin + this row). |
| **C5** | B3 asserts absence of the **string literals**, with a `minify: true` parenthetical. | `grep -n "SUPPORTED_MODERN_PROTOCOL_VERSIONS"` → appears only in §1's §L context and in B3's *"the earlier form was a false green"* note, **never as the assertion**. AC15's B3 line contains `'2026-07-28'` **and** `'2025-11-25'`. The parenthetical names `scripts/build.js:44` and `minify: true`. B1 and B2 unchanged in substance. |
| **C6** | `@modelcontextprotocol/client@^2.0.0` is a **devDependency**; AC2 lists both devDeps with purposes; U7's dependencies clause scopes to non-test source and a separate clause asserts both are devDeps and neither is in `dependencies`. | `grep -n "@modelcontextprotocol/client"` → every manifest mention says `devDependencies`; AC1 explicitly excludes it from `dependencies`. AC2 lists `sdk` (2025-era fixture) and `client` (2026-era-capable fixture) with purposes. U7 clause 1 reads *"imported from a NON-TEST file under `src/`"*; clause 2 asserts both in `devDependencies` and **neither** in `dependencies`. |
| **C7** | AC12 [R1] states the rejection shape with `SdkError` / `SdkErrorCode.EraNegotiationFailed`; the `getProtocolEra() !== 'modern'` disjunction is deleted. | `grep -n "EraNegotiationFailed"` → hits in §4's E8-R1 harness **and** AC12. `grep -n "!== 'modern'"` → **no hit** as an assertion; only the sentences explaining the branch is unreachable and deleted. `grep -n "rejects.toSatisfy"` → ≥ 2 hits. |
| **C8** | The suite is rationed by **spawns**, not builds: timeouts stated, one e2e file, shared spawns, ≤4 long-lived + ≤4 short-lived, `afterAll` force-kill. | `grep -n "120_000"` and `grep -n "45_000"` → both in §4's harness table and AC18. `grep -n "Builds are NOT rationed"` → 1 hit. `grep -n "mcp-stdio.e2e.test.ts"` → named as the single home of E1–E7, W1, O1, O2, O6, E8-R1, mutant build. The spawn ledger enumerates 8 spawns, 4 long-lived + 4 short-lived, with hard caps stated. `grep -n "afterAll"` → names a force-kill (`SIGKILL`). `grep -n "pool: 'forks'"` → noted as pinned, not to be changed for this lane. |

### Also-required gaps (Critic-flagged as surviving — verified present)

| Gap | Where it lives |
|---|---|
| Clean exit on `SIGINT`/`SIGTERM` | **O6** in Lane 4; **AC6 [R1]**; spawn #8 in the ledger. |
| AC1 decision command for `core` | **AC1** and **Phase 1 step 2**: `grep -rn "@modelcontextprotocol/core" apps/infra-kit/cli/src --include='*.ts' \| grep -v __tests__` → *empty ⇒ omit `core`*. |
| W1's `initialize` pins `registerResource`'s `resources.listChanged` | §4, **"Why W1 must never be trimmed to 'tools/list only'"**. |
| Phase 6 schema-acceptance column | Phase 6 matrix column **"tool arguments validate / schemas accepted"**; AC13 requires it filled; §6's pre-publish trigger list names it. |
| **S2** — 93→3 scoped to `dependencies` | §0 item 1, §1 driver 2, §7 driver 2, §7 Consequences (*"scoped to published `dependencies`; sdk + client pull jose / eventsource / pkce-challenge / cross-spawn into the dev tree only"*), §8. |
| **S3** — narrowed R1 post-publish rollback wording | §6 and PM-1: *"no host renegotiates protocol in either direction; tool schemas revert to the `draft-07` form every host already accepted."* |
| **S4** — Phase 5 step 2's B2 remedy | Phase 5 step 2 and AC15/B2: *"If B2 fails, B1 will fail too — diagnose the `external` derivation; do not patch the array."* |
| **S5** — Phase 7 step 9 framing | §6 sequencing step 9: *"Failure here is a patch release, not an unpublish — step 5's pack inspection is the gate that makes this recoverable."* |
