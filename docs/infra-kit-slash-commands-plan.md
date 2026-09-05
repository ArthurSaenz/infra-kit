# infra-kit slash commands

**Status: pending approval**

Give `infra-kit` namespaced, discoverable slash commands in the Claude Code `/` menu, built on the
MCP surface the CLI already ships.

**Iteration 4.** Architecture unchanged across four adversarial passes: MCP prompts carry the content,
**six at launch**, deferrals chosen by blocker rather than count. Iteration 3 closed three blockers
downstream of one finding — **an agent cannot fetch an MCP prompt** — which turned resources from a
deferred option into core work and deleted a generated artifact rather than repairing it.

**Iteration 4 folds in the elicitation track**, which was briefly drafted as a second document and is
merged here instead: a separate document would have required a 17-row delta table that no test can
check, against a plan its author would have to re-read in full to keep accurate — which **P2 forbids by
name**, and which had already rotted before either document was implemented. There is one plan. It
adds: how the server asks a human for input (§0.11, §4.4, PR 4), the renaming of the six to match
the tools they front (§4.2), and **a live defect in shipped code** found while designing it — the
confirm gate never compares round-2 arguments to round-1 (§0.12, PR 1).

**Three user decisions were applied after review** and are recorded in §8's *User decisions (2026-09-03)*
block: `dev-status` is cut from the launch set (six, not seven); the form collects **arguments only**,
never a confirm checkbox; and the work executes as **thin independent PRs** rather than numbered phases.
They were chosen by the user, not derived from review, and §8 records the stated reason for each.

---

## 0. Measured facts and corrections

### 0.1 The catalog numbers

- **23 exposed MCP tools.** Assertion at `command-catalog.test.ts:85` (`toHaveLength(23)`); the `it()`
  title is at `:77`. Path: `apps/infra-kit/cli/src/lib/command-catalog/command-catalog.ts`.
- **`cliName` is not the MCP tool name.** `describe('command catalog — CLI/MCP name parity')` at
  `command-catalog.test.ts:268` holds an authoritative `EXPECTED_PARITY` map calling the divergences
  "INTENTIONAL and grandfathered": `merge-dev`→`gh-merge-dev`, `release-list`→`gh-release-list`,
  `release-deploy-all`/`-selected`→`gh-release-deploy-*`, `release-deliver`→`gh-release-deliver`.

**Which field does anything key on?** Since §4.2, the six prompts are named after **the tools they
front**, so three of the six (`release-create`, `env-load`, `audit`) are exactly exposed
tool names and three (`worktrees`, `release-deploy`, `commands`) are deliberately not. Only `commands`
reads the catalog, rendering two fields: `groupPath.join(' ')` for the terminal form and
`entry.mcpTool.name` for the agent-callable form. `cliName` is an internal id and is never rendered.

### 0.2 Reach: prompts are for humans, resources are for agents

**The finding that drives iteration 3.** MCP prompts are a **host UI affordance** — they surface as
`/mcp__server__prompt` in the `/` menu and are invoked by a person. There is no prompts equivalent of
`ListMcpResourcesTool` / `ReadMcpResourceTool`, so **an agent has no mechanism to fetch a prompt**, and
a `SKILL.md` cannot invoke a slash command. Resources, by contrast, were confirmed agent-reachable
end-to-end against this repo's project-scope server: `ListMcpResourcesTool(server:"infra-kit")` returns
both resources with titles and descriptions, and `ReadMcpResourceTool` returns
`infra-kit://dev-context`'s body.

**But resource-tool availability varies by session; the cause is not established.** Four observed
sessions:

| Session | infra-kit tools | resource tools |
|---|---|---|
| Team lead | present | **present** (verified live) |
| Critic subagent | all 23 present | **absent** |
| Architect subagent | present | **absent** |
| This planner session | all 23 present | **absent** |

An earlier draft recorded the Critic subagent as lacking infra-kit tools and inferred
"subagent tool-restriction". **That inference is falsified**: the Critic subagent listed all 23 and ran
the D1 check against them — only the *resource* tools were missing. Across four sessions the
`mcp__infra-kit__*` tools come through every time while the host's MCP resource-reading tools usually do
not. Say "varies by session, cause not established" — which is now right for a better reason, since the
corrected data point rules out the tool-restriction explanation rather than merely lacking evidence
against it.

Three consequences, all load-bearing below:

1. PR 3 must serve bodies as resources (§7) — resources are the *only* agent-reachable channel that
   can carry a body. The justification was never universality, and patchy availability strengthens it:
   without them there is no agent-reachable channel at all.
2. Any pointer written into a consumer repo must name a fallback that works with tools alone (PR 5).
3. **That fallback is a degraded path, not an equivalence.** Resource tools were present in **1 of 4**
   observed sessions, so PR 5's agent-facing pointer will *usually* fall through to the tool-only
   fallback — and the fallback yields **the tool list, not the procedure**, discarding the ordering, the
   confirm protocol, and the prohibitions that §4 argues a body exists to carry. PR 5 remains clearly
   net-positive regardless: it deletes a wrong artifact, and the `/` menu is what the user asked for.

### 0.3 Measured against this repo's zod 4.4.3 and SDK v2.0.0

F1 and F3 reproduced independently before designing against them; both hold.

| # | Fact | Consequence |
|---|---|---|
| **F1** | `prompts/get` with `arguments` **absent** throws on a bare `z.object({...})`: `Invalid input: expected object, received undefined`. `.default({})` returns `{}`. `arguments` is optional on the wire. | Every `argsSchema` must be `.default({})`-wrapped. **Five of the six** launch prompts can legitimately be invoked with `arguments` absent — only `env-load` declares a required argument (§4.2). |
| **F2** | `.default({})` preserves the `arguments[]` rows in `prompts/list` with correct `required` flags. | The fix costs nothing in discoverability. |
| **F3** | `.default({})` yields a `ZodDefault` whose `.shape` is **`undefined`**. Measured: `typeof dflt.shape === 'undefined'`; `Object.keys(dflt._def.innerType.shape) === ['version','count']`. `dflt['~standard']` survives with its `jsonSchema`, so the preferred SDK overload is still reached. | **The F1 fix voids the naive arg-type guard**; `schema.shape ?? {}` inspects zero keys and a `z.number()` passes green. Unwrap via `_def.innerType.shape`. Same family as this repo's `never .default() in infraKitConfigObject` scar. |
| **F4** | `prompts/list` argument rows carry `{name, description?, required}` and **no type field**. | Old rationale was wrong in mechanism: the type is invisible, the host sends a string, validation throws at `get` time. Right guard, corrected reason. |
| **F5** | An argument's `description` comes **only** from `.describe()`; a snapshot asserting `description: undefined` passes silently. | Require `.describe()`; assert each is a **non-empty string** (cf. `picker-descriptions-keyed-by-jira-name`). |
| **F6** | `title` is emitted as its own field, distinct from `name` and `description`. | Set `title` explicitly per prompt and snapshot it. |
| **F7** | Shipped 0.3.16 **already** answers `prompts/list` with `{prompts: []}` and advertises `{"prompts":{"listChanged":true}}`. | The handshake half of PR 2's experiment is proven; only host *surfacing* is unknown, testable with **zero infra-kit changes**. |
| **F8** | `mcp-stdio.e2e.test.ts` already builds hermetically into `node_modules/.cache` (`:28`, `built.mcpPath` at `:145`), since `buildOptions` leaves deps external and a tmpdir build dies on `ERR_MODULE_NOT_FOUND`. | The PM-3 mitigation is existing-helper work. |
| **F9** | `completable()` works through `z.object()`; capabilities would gain `completions: {}`, changing the initialize surface asserted at `mcp-stdio.e2e.test.ts:590`. | Positional strings are **not** a hard constraint. Named follow-up 2c (§7.7); default no for v1. |

### 0.4 The reference does not use MCP prompts — and why that does not transfer

OMC v4.15.7 registers **zero** MCP prompts; its servers declare `{capabilities:{tools:{}}}` and its
entire slash surface is markdown (41 skills + 28 thin dispatchers), with MCP as the tool engine only.

> OMC's plugin directory `.../oh-my-claudecode/4.15.7/` contains `plugin.json`, `.mcp.json`, **and**
> `bridge/mcp-server.cjs` alongside all 41 `SKILL.md` files; its manifest's `"mcpServers": "./.mcp.json"`
> points at a server *inside the same versioned directory*. Skills and the tools they name ship as one
> atomic unit and cannot skew.
>
> infra-kit cannot replicate this. Its server is the globally installed CLI, launched from the
> **consumer repo's** `.mcp.json`, on a channel that **self-updates silently**. A plugin bundling its
> own server double-registers it (§0.5); one not bundling it is versioned independently of its tools.

So OMC's choice is evidence about OMC's packaging. What it *does* prove — the thin-dispatcher /
fat-body split — this plan copies, relocating the body into the CLI bundle.

### 0.5 A plugin declaring `mcpServers` breaks existing permission allowlists

Tool naming is `mcp__plugin_<plugin>_<alias>__<tool>`. infra-kit's are `mcp__infra-kit__audit`, from the
project `.mcp.json`. A plugin declaring `mcpServers` registers the same server twice, producing two
complete 23-tool sets under two prefixes and silently invalidating every allowlist entry keyed to
`mcp__infra-kit__*`.

**Binding on PR 6: the plugin ships NO `mcpServers` key.** Each dispatcher therefore carries three
graceful-failure clauses: **server absent**, **resource missing**, and — per §0.2 — **resource tools
unavailable in this session**, in which case it names the tool-only fallback rather than dead-ending.

### 0.6 Most of OMC's frontmatter is OMC's own runtime, not Claude Code

`level` (32 of 41 skills) is dead metadata, consumed nowhere and not a host field. `aliases`,
`pipeline`/`next-skill`/`handoff`/`handoff-policy` are parsed by OMC's own line-by-line splitter
(`src/utils/frontmatter.ts`). Supporting-file auto-listing is `renderSkillResourcesGuidance()` in OMC's
`src/utils/`, not a host feature. A plain plugin gets `name`, `description`, `argument-hint`,
`allowed-tools`, `disallowed-tools` — nothing else.

### 0.7 Packaging asymmetry

`package.json` has `"files": ["dist"]`; `scripts/build.js` is 89 lines with `export const buildOptions`
at `:36` and one `esbuild.build(buildOptions)` at `:72` — **no asset-copy step, no `.md` loader**. TS
string constants bundle free (what `agent-files.ts:buildAgentsBody()` already does); loose `.md` in the
tarball needs both a `files` entry and a build step, neither tested. This does not penalize a *plugin*,
distributed from git rather than the tarball.

### 0.8 Native-command names

The six launch names collide with no native command today, re-checked against the §4.2 names. The
`mcp__infra-kit__` prefix makes a literal collision impossible in any case; what was checked is
**reader-level shadowing** in a filtered `/` menu. One finding: **`/release` would have sat beside
`oh-my-claudecode:release`**, which is why §4.2 takes `release-create` rather than the bare area word.
`commands`, `worktrees`, `env-load`, `audit`, `release-deploy` shadow nothing.

The pinning test is a **tripwire against our own future additions** — it can never fail when *Claude
Code* later ships a colliding name.

### 0.9 Reader-facing name collision

`src/lib/prompts/` already exists (`release-picker.ts`, `env-picker.ts`, `stdin-ref.ts`) and holds
inquirer terminal prompts. The new `src/mcp/prompts/` is a different thing with the same word. Both get
a one-line header comment disambiguating them.

**Sharpened by §4.2:** three of the six prompt names are now *also* exposed tool names. That is safe on
the wire (§0.11 M0) but it means the disambiguating header comment matters more, not less, and §6.2's
extractor union (rule 3) is doing more work than when the sets were disjoint.

### 0.10 The era gate is the transport, not the version table

**A correction to an earlier measurement in this track, recorded because the wrong version of it is
persuasive.** An earlier probe read `SUPPORTED_PROTOCOL_VERSIONS` — `["2025-11-25","2025-06-18",
"2025-03-26","2024-11-05","2024-10-07"]` — and concluded SDK 2.0.0 ships no 2026 era at all. **That is
false.** The modern era lives in a *different* constant, reached through a *different* method:

```
dist/src-CX2iR2pK.mjs:544  const FIRST_MODERN_PROTOCOL_VERSION = "2026-07-28";
dist/src-CX2iR2pK.mjs:551  const SUPPORTED_MODERN_PROTOCOL_VERSIONS = [FIRST_MODERN_PROTOCOL_VERSION];
```

`server/discover` — not `initialize` — is the modern opening, and it appears 10× in that file. A probe
that asks over `initialize` is asking on the one channel the SDK guarantees can never answer with a
modern revision. **Any era claim measured through `initialize` alone is unsound.**

| # | Probe (real spawned child, real pipes) | Result |
|---|---|---|
| **E1** | `server.connect(new StdioServerTransport())` + `initialize(2026-07-28)` | negotiates `2025-11-25`, **no error** |
| **E2** | `server.connect(new StdioServerTransport())` + `server/discover` | **`-32601 Method not found`** |
| **E3** | `serveStdio(...)` + `server/discover` + full modern `_meta` envelope | `{"supportedVersions":["2026-07-28"]}` |
| **E4** | …then `tools/call` on a gated tool | `{"resultType":"input_required","inputRequests":{…}}` |
| **E5** | …then `tools/call` again carrying `inputResponses` + `requestState` | `{"resultType":"complete",…}` — native flow works |

**Two consequences, and the second is the one that matters.**

1. `connect(new StdioServerTransport())` is **legacy by construction** (E2). The era is not a version
   the client can talk us into; it is a transport we have not adopted.
2. The 2026 era **is reachable** — `serveStdio` gets there today (E3–E5). So adopting `serveStdio` is a
   **live** hazard, not an inert one, and §3's elimination of it rests on **P2 alone**: `legacy` is only
   `'serve' | 'reject'`, there is no "stay put", and infra-kit self-updates silently and globally.

**Note the shape of the modern flow (E5): the *client* re-sends `tools/call` with `inputResponses` and
the echoed `requestState`.** Everything traverses the client. That is why §0.12's binding is not
optional under the chosen design.

### 0.11 Multi-round-trip elicitation, measured

All measured against `@modelcontextprotocol/server@2.0.0`, Node 24.18.0, over spawned children.

| # | Fact | Consequence |
|---|---|---|
| **M0** | A tool named `release-create` and a prompt named `release-create` coexist on one server; `tools/list` and `prompts/list` each return their own, `prompts/get` returns the body, `tools/call` returns the tool result. | Separate namespaces. **The naming objection in §4.2 was stylistic, not technical.** |
| **M1** | A handler returning `inputRequired(...)` **on today's unchanged `server.connect` at 2025-11-25** causes the SDK to emit `elicitation/create`, await the client, re-enter the handler with `inputResponses` populated, and return the handler's real second-round result. | **The modern, non-deprecated API is usable on the legacy wire.** No `serveStdio`, no era flip, no deprecated `elicitInput`. This is the finding the whole track rests on — and it is *undocumented behavior of a `^2.0.0` dependency* (PM-6). |
| **M2** | Decline → `inputResponses = {confirm:{action:'decline'}}`; cancel → `{action:'cancel'}`. Both re-enter the handler; `acceptedContent` is falsy for both. | **The discriminator is `inputResponses !== undefined`, not `acceptedContent`.** The obvious spelling re-prompts forever (PM-4). |
| **M3** | A client that has not declared elicitation gets a clean in-band `isError` — *"the client on this 2025-era connection did not declare the required capability"* — with **zero wire traffic**. No hang, no `method-not-found`. | The spec's "servers MUST NOT send an `inputRequests` the client has not declared" is enforced **by the SDK**. A capability probe is needed to choose a *better* fallback, not for safety. |
| **M4** | `getClientCapabilities()` **normalizes**: `{elicitation:{}}` reads back `{elicitation:{form:{}}}`; `{elicitation:{url:{}}}` reads back unchanged, with `.form === undefined`. | Probe **`caps?.elicitation?.form`**, never `caps?.elicitation`. The url-only shape is the only fixture that can tell the two spellings apart (§6.12 R7). |
| **M5** | `createRequestStateCodec({key, ttlSeconds, bind})` is exported and works **standalone**, outside the protocol `requestState` seam: `mint` → 171-char `v1.<b64url>.<mac>`; `verify` rejects a tampered byte (`mac`), a changed bind (`bind`), and garbage (`mac`). | The integrity obligation is a four-line call, not a hand-rolled HMAC. **Signed, not encrypted** — the payload base64url-decodes in clear, which is fine for arguments the client already sent. |
| **M6** | `elicitInput` is marked `@deprecated`: *"Throws on a 2026-07-28-era request — use `inputRequired` instead… If your factory serves both eras, this only works on the legacy path."* | Never adopt it. It reaches the same wire behaviour as M1 with a scheduled failure attached. |

### 0.12 The confirm gate never compares round-2 arguments to round-1 — a live defect

**This is not a property of any proposed design. It is in shipped code today.** In
`src/lib/tool-handler/tool-handler.ts`, `resolvedArgs` occurs exactly twice — constructed at `:32`,
placed into `structuredContent` at `:44`. It is a **pure echo**. Round 2 is:

```js
if (requiresHumanConfirm === true && !isConfirmed(params)) { return buildConfirmGate(toolName, params) }
const payload = await handler({ ...(params as object), confirmedCommand: true })
```

Nothing compares round-2 `params` to round-1. The code comment states the behaviour plainly: *"a second
call carrying `confirm:true` falls through and executes exactly as an unflagged tool would."*

**So today an agent can gate on `env: dev`, then re-call with `env: prod, confirm: true`, and it runs.**
The human — if a human was ever shown anything — approved a different operation than the one executed.

This is a **time-of-check/time-of-use** hole and it is why §4.4 binds the approved arguments into a
signed token (M5) rather than merely showing a form. It is fixed in **PR 1, which depends on nothing
else in this plan and ships first.**

**E6 — it is a protocol-level property, not an infra-kit repair.** The SDK documents `requestState` as
*"an opaque, server-minted string **echoed back verbatim** by the client"* (`createMcpHandler-…d.mts:672`,
and again at `:687` and `:1382` — *"Opaque server state the client echoes back verbatim on retry"*).
There are **no reconciliation sites between `requestState` and the arguments anywhere in the SDK**: the
protocol re-delivers both and reconciles neither. §0.10 E5 shows the same shape natively — the client
re-sends `tools/call` with its own arguments alongside the echoed state. **So a server that does not
bind them itself has this hole on *both* eras**, and the SDK will never close it. Binding is the
server's job, and this plan is where infra-kit does it.

### 0.13 Client-side auto-fill is protocol-sanctioned

```
dist/src-CX2iR2pK.mjs:754  const FormElicitationCapabilitySchema =
    z.intersection(z.object({ applyDefaults: z.boolean().optional() }), JSONObjectSchema$1);
```

A client may declare form support **and fill the values itself**. That is a *sanctioned configuration*,
not an abuse. And the SDK's own wording is a SHOULD, not an authorization boundary:

```
dist/src-CX2iR2pK.mjs:1582  * The client should present the message and form fields to the user (form mode)
```

**Therefore a form is not a gate.** A design that replaces the confirm gate with a form has, against an
auto-accepting client, *zero* gating — and the fallback never engages, because such a client genuinely
*does* declare the capability. This is what forces §4.4's "form **and** gate" rather than "form instead
of gate", and it is the reason Driver 2 is stated the way it is. **The user's Decision 2 goes one step
further** — the form is not merely insufficient as a gate, it no longer attempts to be one: it carries
arguments only, and consent lives entirely in the second call.

**Not evidence for this, and not to be cited as precedent:** infra-kit's own `confirmedCommand: true`
injection. That flag suppresses *infra-kit's own server-side inquirer prompt* in a non-TTY process — a
server declining to prompt itself, which is the opposite of a client auto-answering on a user's behalf.

### 0.14 Codebase facts the mechanism depends on

- **`src/mcp/prompts/index.ts` is already a wired no-op stub** — `export const initializePrompts = async
  (_server: McpServer) => {}`, already called from `createMcpServer`. PR 3's registration seam exists.
- **`ctx` is discarded at the registration site.** The SDK calls the tool callback as `(args, ctx)`;
  `src/mcp/tools/index.ts` passes `createToolHandler({...})`, whose return type is
  `(params: unknown) => Promise<ToolsExecutionResult>`. **Threading `ctx` is the one structural change
  §4.4 requires** — and it needs zero edits under `src/commands/`.
- **On re-entry the params are the *original* params.** `confirm` is still absent on round 2, so
  `isConfirmed(params)` at `tool-handler.ts:19` is still `false`. Keying the gate on `params.confirm`
  while returning `inputRequired` produces an infinite gate (PM-5).
- **`confirmedCommand: true` must keep being injected on the real call.** `worktrees-remove` keys
  `allowEditorRelaunch` off it, and a non-TTY server would hang on an inquirer prompt without it.

---

## 1. Principles

**P1 — Procedure text ships in the same versioned unit as the tools it names.**
*Rejects:* a plugin carrying workflow bodies while the CLI self-updates underneath it.
*Not a P1 matter:* two renderers of the same catalog data inside one bundle — that is **DRY**; they ship
together and cannot skew.
*Note:* serving one body constant as both a prompt and a resource (§7 PR 3) is not a P1 risk either.
Drift requires two sources; there is one.

**P2 — Nothing is generated into a consumer repo that restates what the CLI can serve on demand.**
Rewritten this iteration, and the rewrite matters: the previous phrasing ("no artifact whose staleness
has no signal") was *earned by a repair that is now withdrawn* (PR 5's `audit` check — see §7), so it
must not survive unchanged. P2 now forbids the **artifact**, not the missing signal.

The reason is structural: **the CLI cannot update a file it wrote into someone else's repo.** Any
restatement rots with no mechanism to fix it, and the only available staleness signal would break every
consumer's CI (§7 PR 5). This is §4's own argument one level up — §4 rejects 23 wrapper prompts
because one generated index beats 23 rotting copies; the hardcoded CLAUDE.md command list *is* that
rotting copy, in a file the CLI cannot reach.

*Rejects:* fat command bodies in `.claude/`; the hardcoded command list in the CLAUDE.md managed block.
*Permits:* a **pointer**, which names where to look and has nothing to go stale.

**P3 — Any surface that can name a tool is checked against the catalog.**
*Rejects:* free-text bodies with no membership test; a plugin shipping its own `mcpServers` (§0.5).

**P4 — Human discoverability is the only thing being bought.**
An agent already calls `mcp__infra-kit__release-create` unaided.
*Rejects:* 1:1 wrappers over the 23 tools.

**P5 — Don't import complexity the scale doesn't demand.**
*Rejects:* the `commands/` budget layer, hooks, and any state store (§3.5).
*Retained deliberately.* An earlier draft justified P5 partly with a **false claim** — that a
`prompts/get` body is a "one-shot context cost, not session-resident". It is not: the result is injected
as a user message and persists in the transcript exactly like a skill body. **Both bullets carrying that
claim are struck.** P5 as actually written — about complexity, not tokens — is true and solely supports
§3.5's three rejections.

**P6 — A form collects values; it does not carry warnings.**
A form is rendered to the **human**, at the moment a tool is already being invoked. The safety prose in
§4.3 exists to reach the **agent**, *before* it decides which tool — or whether to bypass MCP entirely
and shell out to `gh workflow run`. Those are different readers at different times.

> **A form cannot warn an agent off a path it is about to choose.**

*Rejects:* deleting any §4.3 safety paragraph on the grounds that "the form will say it"; and, with
§0.13, any design that treats a rendered form as an authorization boundary.

**The user's Decision 2 (§8) strengthens P6 rather than weakening it:** once the form carries *arguments
only* and no consent control, the claim above stops being a caution about an over-loaded form and becomes
a description of what the form now is — a value picker. Every warning P6 protects is carried by the body
and by the agent's transcript-visible second call, and by nothing the form renders.

**P7 — Never adopt an irreversible mechanism to gain a capability that is already reachable.**
*Rejects:* `serveStdio` (§0.10) — its only era control is `legacy: 'serve' | 'reject'`, there is no
"stay put", and infra-kit self-updates silently and globally, so the flip would reach every consumer
with no announcement and no rollback short of republishing. §0.11 M1 shows the capability without it.
*Rejects:* `elicitInput` (§0.11 M6) on the same logic one step removed — a mechanism with a documented
expiry is not adopted for a permanent surface.

**Confirmed: no rejection rests on the struck claim.** Option B dies on distribution asymmetry (P1)
alone; Option C on namespace (and now independently on P2); 1:1 wrappers on P4 alone.

---

## 2. Decision drivers

1. **Distribution asymmetry** (§0.4) — decides where procedure text can safely live.
2. **The eight gated tools must stay gated on every client** (§0.13). A mechanism that gates well on
   Claude Code and not at all on an auto-accepting client is a regression however good the form looks.
   This driver is what selects §4.4's Option F over the form-only alternative.
3. **Reach** (§0.2) — prompts serve humans, resources serve agents; a design that ignores the split
   points readers at things they cannot retrieve.
4. **Namespace** — only a plugin yields `/infra-kit:x`. Cosmetic, and §7 PR 3 shrinks its value
   further by making every body agent-reachable without it.

*(Asymmetric cost of error is assumed throughout rather than listed: a wrong name costs a rename, a
wrong gate costs an unconfirmed production deploy.)*

---

## 3. Options

### A. MCP prompts (plus resources, per §0.2) — **CHOSEN for content**

*Pros* — TS constants bundle free (§0.7); text and tools are one build, so skew is structurally
impossible (P1); reuses the declared `capabilities.prompts` and the `mcp/tools/index.ts` single-call-site
pattern; portable to Inspector and Cursor; testable against `getExposedMcpTools()` in-process (P3).

*Cons* — the `mcp__infra-kit__` prefix; positional string arguments unless F9 is adopted; text changes
require a CLI release (also a pro, per P1); **prompts alone are agent-unreachable** (§0.2), which is why
the same constants are also served as resources; and it is the least-travelled path, which PR 2 buys
down before content is written.

### B. Plugin with fat `SKILL.md` bodies

*Cons* — **the property that makes it safe for OMC is unavailable** (§0.4): without bundling the server
(impossible without §0.5's double-registration) the body is versioned independently of the tools it
names, against a silently self-updating CLI. Direct P1 violation. Claude-Code-only.

*Verdict:* rejected as a content carrier; adopted as a name-only veneer (Option D).

### C. `infra-kit init` generates `.claude/commands/` or `.claude/skills/`

*Verdict:* **eliminated on namespace** — `.claude/commands/foo.md` → `/foo`, unnamespaced; only *nested*
skills get a path prefix, a directory artifact rather than `infra-kit:`. **Independently eliminated by
P2**: fat bodies in a consumer repo restate what the CLI serves and cannot be updated by it.

The `agent-files.ts` machinery is still used, in PR 5 — now to *delete* a restatement, not add one.

### D. Hybrid — prompts and resources carry content, a thin plugin carries only the name — **CHOSEN shape**

The plugin's every `SKILL.md` is a ≤10-line dispatcher reading the named **resource**. OMC's
architecture with the fat body relocated.

*Pros* — pretty namespace, zero content fork, P1 holds; degrades correctly without the plugin; ships no
`mcpServers` (§0.5). *Cons* — a second distribution channel, forever, per machine — and after PR 3
that channel buys **only the name**, since every body is already agent-reachable as a resource.

### 3.5 Not imported from OMC

- **The `commands/` budget layer.** OMC's 25 `description: ""` dispatchers and its
  `plugin-skill-budget.test.ts` exist because 41 fat skill descriptions load eagerly. At six short
  descriptions the saving is not worth a second layer. *(An earlier draft put a token figure here; it
  was an unsourced estimate presented as a measurement, and is removed rather than guessed again.)*
  Premature (P5); revisit past ~25 entries.
- **Hooks.** `hooks/hooks.json`, the `run.cjs` ESM shim, and the 1858-line keyword detector (with
  `stripSystemEchoes()` to stop the model's own echo re-triggering a mode) exist for free-prose magic
  keywords. infra-kit's commands are explicitly invoked. Nothing to solve.
- **The state layer.** `.omc/state/*.json` with `0o600`, locked writes, and session-ownership checks
  serve resumable long-running modes. Every infra-kit command is stateless request/response; the only
  cross-invocation state — the confirm gate — already rides in the tool arguments. **No state layer.**

### 3.6 Copied from OMC

- The thin-dispatcher / fat-body split (PR 6).
- **The explicit deferred-tool preload block** (`skills/cancel/SKILL.md:41-48`): one batched
  `ToolSearch(query="select:...")` plus a bash fallback *with explicit carve-outs*. Every body opens with
  the preload, and the carve-out maps onto the confirm gate: **do not fall back to `Bash` for gated
  tools — the two-call confirm is the mechanism.**
- **Prose contracts backed by code enforcement** (`merge-readiness` states an authority boundary in prose
  *and* enforces it in `STATE_WRITE_MODES`). Our equivalent is bodies stating exclusions in prose while
  §6.2's guard enforces them.
- **`skills[]` is an explicit array, not a glob** — unlisted skills silently do not ship (PR 6 test).

---

## 4. What the commands are

**Workflow bodies, not 1:1 wrappers, plus one catalog-generated index.** A wrapper for `release-create`
would say "call `release-create`" — the agent already sees that tool, its description, and its schema.
It adds a menu row and a rotting duplicate description (P4 + P1). None of OMC's 28 dispatchers wraps a
single tool.

What a `tools/list` entry structurally cannot express, and this codebase has all four: ordering and
preconditions; the two-call confirm protocol (eight tools return
`{status:'confirmation_required', isError:true}` on call 1, and an agent that has not seen it reads
`isError` as failure or falls back to `Bash` and bypasses the gate); prohibitions; and hard-won
environment semantics.

### 4.1 Launch set — six. The reviewers disagreed; here is the call, plus the user's cut.

The Architect proposed cutting to four; the Critic argued for six or seven with repaired bodies.
**The Critic's position is adopted, on cost structure:** the fixed cost — registration infrastructure,
the guards, the E2E, the snapshot — is paid once regardless, while the marginal cost of one more body is
a TS constant plus a snapshot row. Cutting three bodies saves a fraction of the work while removing most
of the surface the request was about. The Architect's cut list was also **inverted**, keeping `merge-dev`
(the one entry with a documented architectural blocker) while cutting the two lowest-risk. Deferrals are
chosen by blocker, not by count.

**Then the user cut one more — `dev-status` — and the launch set is six** (§8, *User decisions*). The
stated reason is that a headless "interpret" body is thin: its value was **explaining what the panel's
rows mean**, and explaining panel semantics does not need a menu row. That is a judgement about what
earns a `/` entry, not a blocker of the §4.1 kind, which is why it is recorded as a user decision rather
than a deferral. The `dev-status` **tool is untouched** and stays exposed.

**Deferred, each with a stated unblocking condition** (see §7.7, named follow-up 2b):

- **`merge-dev`** — `docs/gh-merge-dev-hardening-plan.md` concludes the worktree failure is
  *architectural* (`git switch` **is** the defect). A v1 body could only honestly carry the one verified
  signal (`MERGE_HEAD` present + zero unmerged paths ⇒ hook refusal). Unblocks when the hardening plan
  lands, or ships early scoped to that single signal.
- **`local-deploy`** — strongest missing candidate on paper (exposed, mutating, gated), but a body
  **cannot** fix `local-deploy.ts:333`, and prod is absent from `SHARED_ENVS` so
  `assertCleanTreeForSharedEnv` never runs. Describing its safety would teach exactly the false safety
  condemned in §4.3. Unblocks when `:333` is fixed; may ship earlier only if the body states the gap.

### 4.2 The six

Earlier iterations hand-named these after *workflows* (`release-cut`, `env-prepare`, `worktree-setup`,
`audit-repo`) on the assumption that a prompt sharing a tool's name would read as a
duplicate. **§0.11 M0 measures that assumption false** — prompts and tools are separate namespaces on
the wire — and the user prefers names matching the tools they already know.

**Is a shared name confusing to a human reading the `/` menu?** No: the menu contains **only prompts**.
A tool never renders beside them, so there is no side-by-side duplicate. The confusion surface is prose
and logs — "run `release-create`" being ambiguous between a slash command that lists, creates, and
describes, and a single tool call that only creates. **One clause bounds exactly that, and it is the
clause §6.12 R6 tests:**

> A prompt name **may** equal a tool name. It must **never** equal a tool it does not primarily run.

*(An earlier draft wrapped this in a four-category taxonomy — 1:1 / primary+surround / orchestrator /
index. The fourth category was invented for `release-deploy` and was inconsistent with `worktrees` of
identical shape, which made the rule unfalsifiable. The taxonomy is dropped; the clause above is the
whole rule.)*

| Name | `title` (F6) | Args | `description` — the `/` menu line |
|---|---|---|---|
| `release-create` | Cut a release | `version?` | Review existing releases, create the branch and tag, then set the description |
| `release-deploy` | Deploy a release | `release?`, `env?` | Deploy an existing release to a non-prod environment, with the confirm gate and the real prod boundary explained |
| `worktrees` | Set up worktrees | `release?` | Create or reconcile release worktrees for this repo |
| `env-load` | Prepare a Doppler env file | `config` | Write a Doppler env file for a config and explain how to apply it to your shell |
| `audit` | Audit this repo | — | Run the infra-kit config and vendor audit and explain every finding |
| `commands` | infra-kit command index | — | List every infra-kit command and MCP tool available in this repo, grouped by area |

Three names (`release-create`, `env-load`, `audit`) are exactly exposed tool names — each
prompt is the procedure for running that tool correctly. Three are deliberately not: `worktrees` and
`release-deploy` span co-equal tools with no single primary (`worktrees-add`/`-sync`;
`gh-release-deploy-all`/`-selected`), and **`commands` fronts no tool at all**, which is why it is the
one bare plural — the plural says "listing", the missing verb says "not an operation". Its resource URI
was already `infra-kit://commands`, so the rename makes prompt and URI agree.

Each is registered **twice from one constant** (§7 PR 3): as a prompt for the `/` menu and as a
resource for agent reach. Every body opens with the §3.6 batched preload and, where a gated tool is
involved, the two-call confirm protocol and the no-`Bash` carve-out — **both of which survive §4.4
unchanged**, because the form is added *beside* the gate, not in place of it. Every argument carries
`.describe()` (F5); every `argsSchema` is `.default({})`-wrapped (F1).

### 4.3 Body-level requirements

- **`release-deploy` — the prod boundary is a safety defect if stated the way iteration 1 stated it.**
  The prod veto (`assertDeployable` / `PROTECTED_ENVS`) is **client-side only**; a raw `gh workflow run`
  bypasses it, and GitHub Environment protection gates zero jobs today. The body must say plainly that
  **prod is not protected by anything the agent can rely on**, and that `gh-release-deliver`'s absence
  from MCP is an *agent-reach limitation, not a safety guarantee*.
- **`env-load`** — twice renamed: `env-switch` promised an effect a child process cannot have, and
  `env-prepare` was invented vocabulary. The name now equals the tool, so it cannot over-promise
  *relative to the tool*; the honesty burden moves entirely into the body, which carries the
  `sessionEnvNotice` semantics: **the file must be sourced by the caller.**
- **`audit`** — carries the vendor trap: `pnpm update -r <pkg>` silently rewrites the guarded
  `vendor/` mirror and reddens `vendor check`; revert the mirror, then
  `pnpm install --no-frozen-lockfile`.

**No `dev-status` body ships, and the knowledge it would have carried is not lost** — `⚠ 0` being
legitimate for a UI that died before its first parseable line, `turbo run dev` having no `--continue` so
a UI can never paint `● failed`, and the dev-context `$HOME` fallback firing by default at this repo's
root all live in project memory and in the code that produces them; what the user cut is a menu entry,
not a fact, and the `dev-status` **tool** is untouched.

Everything else the catalog exposes stays tool-only: single calls, no procedure.

**How much of this a form replaces: argument collection, and nothing else.** §4.4 lets the server render
a real terminal form with a dropdown of *actual* values (the real env list, the real releases) instead
of the model guessing a string, and that genuinely retires the "ask the user which env" prose. Ordering,
preconditions, prohibitions, the prod-is-not-protected warning, the vendor trap,
and the must-be-sourced notice are **all irreducible**, per **P6**. The two-call confirm protocol is
*also* irreducible, because §4.4 keeps the gate — and under the user's Decision 2 (§8) the form does not
even attempt consent, so the protocol prose is not merely retained: it is the **only** place consent is
described at all. **No body is deleted for form-related reasons and no body shrinks materially; the
launch set is six**, and that one cut was the user's editorial call about `dev-status` (§4.1), not a
form substitution. §4.1's deferrals are an architectural defect and `local-deploy.ts:333` —
neither is an input-collection problem and a form fixes neither.

### 4.4 How the server asks the human — an **argument form**, and the gate

**The mechanism, in one sentence:** for the eight gated tools, collect the tool's **arguments** from the
human with a real form via the SDK's non-deprecated `inputRequired` on the **unchanged** connection,
**and** keep the two-call `confirm:true` gate as the consent step, **and** bind the collected arguments
into a signed token so round 2 cannot substitute different ones.

**Decision 2 (§8): the form collects arguments only — never a confirm checkbox.** This *refines* Option F
rather than rejecting it. Under F as originally written the human ticked "confirm" in the form, submitted
it, and **nothing happened** — the operation waits on the agent's second call — so one action carried two
confirm moments and the first was visibly inert. That is a UX defect the earlier draft did not name.
Consent lives in exactly one place: the agent's transcript-visible second call, plus Claude Code's own
permission prompt on it.

**The security posture is exactly today's, plus the binding.** The form adds real-value collection and
nothing else; it removes no check and adds no authorization boundary. Two consequences follow directly:

- **Defect 4 — a client that auto-accepts forms — is closed by construction**, not by mitigation. §0.13's
  auto-filling client can accept an argument form all it likes; the human's consent was never in the form
  to be forged. What such a client still has to do is what it has to do on `main` today: make a
  deliberate, transcript-visible second `tools/call` with `confirm:true`, which Claude Code surfaces to
  the user as a permission prompt. **PM-0's residue is unchanged in kind but narrower in reach** — the
  auto-fill can no longer even appear to be a human approving.
- **The human sees one form and one question.** Values in the form; consent in chat. Never two confirms,
  and never an inert one.

**Non-gated tools get no form at all.** There is no round trip to hang one on — an ungated tool runs on
its first call (state 0) — and manufacturing one would be new scope, a new code path, and a new test
axis for tools the plan never argued need human input. Stated so a later reader does not read the form as
a general argument-collection feature that was simply not finished.

**Why not form-only.** §0.13: a client may declare form support and auto-fill it (`applyDefaults`), and
the SDK's own wording is a SHOULD. Against such a client a form-only design has *zero* gating — and the
capability fallback never engages, because the client genuinely does declare the capability. That
violates **Driver 2** outright. Form-and-gate is instead a strict improvement on the status quo: every
client keeps at least today's behaviour, and elicitation-capable clients additionally let a person pick
the real values — from the actual env list, the actual releases — instead of the model guessing a string.
Under Decision 2 this argument is not merely satisfied but moot: the form was never asked to gate.

**Why not gate-only (i.e. change nothing).** The gate's decision is made by the *model* interpreting a
JSON message, on operations that deploy infrastructure. A form puts it in front of a person.

**Why the binding is mandatory, not a nicety.** §0.12 — round 2 is unchecked **today**. Adding a form
without binding would be a *regression*: the human would now have chosen specific **values**, and the
agent could still execute the operation with different ones — the picked env silently swapped between
the form and the call. Under this design the token traverses the client
immediately (it rides in `structuredContent` and comes back in round-2 arguments), so it is
attacker-controlled input from day one. **That is by design, not by accident** — and §0.10 E5 shows the
same is true of the protocol's own `requestState` the moment the era ever advances.

**The state machine.** `createToolHandler` is the sole chokepoint. State 0 is the ungated case; states
1–4 all additionally require `requiresHumanConfirm === true`.

**Evaluation is first-match-wins, in the order written, and every condition below is stated in full —
no row relies on an earlier row having excluded something.** That discipline is not decoration: the two
bugs found in review were both an *omitted precondition*, one row apart.

| State | Condition (complete, not residual) | Action |
|---|---|---|
| **0** | `requiresHumanConfirm !== true` | **Run the handler.** No form, no gate, no token. *Stated explicitly because omitting it is the exact bug two reviewers found in an earlier draft — an ungated tool returning a `confirmation_required` payload instead of running.* |
| **1** | gated **∧** `confirm !== true` **∧** `inputResponses === undefined` | If `caps?.elicitation?.form` → return `inputRequired` whose `requestedSchema` contains **only the tool's own arguments**, each offered as a dropdown of **real values** (the actual env list, the actual releases). **No `confirm` field, of any type, appears in the schema** (Decision 2). Else → fall to state 3. |
| **2** | gated **∧** `confirm !== true` **∧** `inputResponses !== undefined` **∧** not accepted | **Terminal `isError`.** Never re-prompt. (PM-4 — unchanged by Decision 2: decline on the *argument* form is still terminal, and the discriminator is still `inputResponses !== undefined`, never `acceptedContent`.) |
| **3** | gated **∧** `confirm !== true` **∧** (form accepted **∨** form unavailable) | Return the gate payload — today's shape, carrying **the arguments as collected** plus `confirmToken`, an HMAC over exactly those arguments minted with `createRequestStateCodec` (§0.11 M5), `isError: true`. On the form-accepted path the collected values, not the originally-guessed ones, are what is signed and what round 2 must match. |
| **4** | gated **∧** `confirm === true` | **Verify `confirmToken` against the round-2 args.** Absent, mismatched, tampered, expired, or wrong bind → refuse, do not run. Valid → run the handler with `confirmedCommand: true` injected exactly as today. |

**Why `confirm !== true` appears on states 1, 2 and 3 rather than being left implicit.** Without it,
trace a **non-elicitation** client's round 2 — `confirm:true` + token, `inputResponses === undefined`:
state 0 no, state 1 no (`confirm` present), state 2 no (`inputResponses` undefined), and then **state 3
matches on "form unavailable"** and returns the gate a second time. State 4 becomes unreachable and the
tool can never run — **PM-5 verbatim, on the path this section calls universal.** It fails loudly
(`tool-handler.test.ts:165` and `e5` both redden) rather than silently, but the plan's own discipline
is that a precondition is written, not inferred.

Note state 4 does **not** condition on `confirmToken` being present — absence is a *refusal inside*
state 4, never a fall-through to another state. Making presence part of the condition would let a
token-less round 2 slide to state 3 and reopen §0.12.

`isConfirmed(params)` survives, keyed as today; what changes is that state 4 **also** verifies. Uniform
across all eight gated tools — **not** split by blast radius, which would add a third code path and a
test axis against the sonarjs ≤ 15 ceiling for a distinction `requiresHumanConfirm` already expresses
(P5).

**§3.5 is not violated.** `requestState` never persists, never crosses a process, and never leaves the
SDK; the `confirmToken` rides in the tool arguments, which is the one form of cross-invocation state
§3.5 explicitly carves out. **No state layer.**

**The cost, stated rather than discovered.** Keeping the gate means keeping the
`structuredContent` payload that v1-SDK clients reject (the recorded Inspector defect). Under Decision 2
the sting is smaller than the earlier draft claimed: the rejection still lands **after the human has
filled in the form**, but what they committed there is a set of **values**, not their consent, so the
loss is a discarded selection rather than an approval that went nowhere. It remains a real edge and it is
not free — the intersection of clients that declare elicitation *and* validate `structuredContent`
ignoring `isError` is plausibly empty today. A form-only design would have eliminated that payload; this
design gives it back, deliberately, to satisfy Driver 2. **The finding stands; only its severity is
softened.**

---

## 5. Pre-mortem

**Read §6.0b before adding to this list.** Every scenario below is a *liveness* failure — something
stops working. The two most serious findings in iteration 4 (§0.12, §0.13) are **authorization**
failures, where the mechanism works exactly as designed for the wrong principal, and no amount of
liveness-hunting would have produced them. A pre-mortem set without at least one authorization scenario
is incomplete by construction.

**PM-0 is that scenario, worked, so the next author has a pattern rather than only a pointer.**

### PM-0 (authorization): The deploy is approved by nobody, and every mechanism reports success

A consumer runs a client configured with `elicitation: { form: { applyDefaults: true } }` — a
**sanctioned** configuration (§0.13), not an abuse. The agent calls `gh-release-deploy-all` for
`env: prod`. The argument form is emitted, the client fills it from defaults and returns
`action:'accept'` **without rendering anything to a person**, the gate payload comes back, the agent
re-calls with `confirm:true` and a valid token, and the deploy runs.

*Narrowed, not removed, by Decision 2 (§4.4).* Since the form now carries **arguments only**, the
auto-fill never even resembles a person approving — it supplies values, which is all it was ever asked
for. What remains is the pre-existing question below, which is about the second call and Claude Code's
permission prompt on it, and which the form never governed either way.

**Nothing failed.** The form was shown, per the protocol. The gate held, per its contract. The token
verified, per §0.12. Every log line says success and every test in §6.12 is green — because each one
asks whether the mechanism *ran*, and it ran perfectly. What no assertion asks is **whether a human was
ever on the other end**, and the honest answer is that the server **cannot know**: the SDK's
presentation language is a SHOULD, so client-side auto-fill is a conforming implementation.

*Mitigated only partially, and the residue is stated rather than hidden.* §4.4's gate means such a
client is no worse off than today — it still needs the deliberate second call — which is precisely why
Driver 2 forces form-**and**-gate. But **no mechanism available to an MCP server establishes human
presence**, and §4.3's prod paragraph is load-bearing for exactly this reason: the veto is client-side
only, so the last real defence is the *agent* having read a body that says so (**P6**).

**The pattern to copy:** ask *who was on the other end, and what did they actually do* — not *did it
work*. Then ask which of your assertions could tell the difference. If none can, say so.

### PM-1: The bodies rot against the catalog, silently

A tool is renamed, un-exposed, or gains a required argument. Bodies name tools as prose strings; nothing
validates them; the golden snapshot covers `tools/list` only; `qa` stays green. The failure surfaces as
a mid-workflow JSON-RPC error, having walked the agent into a dead end. §0.1 makes it concrete: five
tool names already diverge permanently from their `cliName`. *Mitigated by §6.2 and its four-case red
corpus.*

### PM-2: The prefix loses, and a plugin either forks the content or double-registers the server

*Fork:* someone copies the bodies into `SKILL.md`. Two cadences, one silently auto-updating;
`/infra-kit:release-create` gives confidently stale instructions while the prompt route is correct.
*Double-registration:* the plugin declares `mcpServers` — the natural thing, and what OMC does — so two
tool sets appear under two prefixes and every allowlist entry keyed to the old prefix stops matching
(§0.5). *Mitigated by PR 6's tests (§6.9).*

### PM-3: The bodies are correct in tests and absent in production

Unit tests construct `new McpServer(...)` directly. That proves registration works; not that
`server.ts` calls it, that esbuild pulls `prompts/definitions/` into the bundle, or that `prompts/list`
answers over real stdio. An unimported definitions file builds to nothing — and the tree-shaken bundle
is smaller and green. Compounded by the recurring `catalog:`-in-published-deps release failure (0.3.15).
*Mitigated by the F8 E2E — existing-helper work.*

### PM-4: The decline loop traps the user

A person runs `/mcp__infra-kit__env-load`, the agent calls `env-clear`, the argument form appears, and
they click **Decline**. The handler is re-entered with `inputResponses = {confirm:{action:'decline'}}`;
`acceptedContent` returns falsy; code spelled the obvious way — and the way the SDK's own canonical
example reads at a glance — returns `inputRequired(...)` again. **The form reappears. Forever.** The
user's only way to say no is the thing that re-asks, and the only escape is killing the session.

**This is demonstrated, not hypothesised: the loop is the SDK's own canonical example, verbatim.** The
JSDoc on `inputRequired` reads

```ts
const confirmed = acceptedContent<{ confirm: boolean }>(ctx.mcpReq.inputResponses, 'confirm');
if (!confirmed) { return inputRequired({ inputRequests: { confirm: inputRequired.elicit({ … }) } }); }
```

— with **no** `inputResponses !== undefined` check. On decline, `acceptedContent` is falsy, `!confirmed`
is true, and the example re-issues the request. An implementer copying the documentation lands the bug.
*Mitigated by §4.4 state 2 and §6.12 R1.* **Decision 2 does not touch this.** The SDK example happens to
elicit a `confirm` field and ours elicits arguments, but the loop is a property of the *discriminator*,
not of what the form asks: `acceptedContent` is falsy on decline whatever the field is called.

### PM-5: The half-migration produces a gate that no longer gates

`createToolHandler` gates on `isConfirmed(params)`, and on re-entry the params are the **original**
params (§0.14) — `confirm` still absent — so a partial migration gates twice and the tool never runs.
The plausible fix under time pressure is to relax or delete the `requiresHumanConfirm` condition rather
than re-key it, which silently ungates all eight destructive tools. The failure is **invisible on Claude
Code**, where the form still appears and the human still clicks. *Mitigated by §6.12 R3/R5 and the
filesystem-side-effect lanes in §6.7 — response shape alone cannot distinguish "gated" from "gated but
the handler ran anyway".*

### PM-6: The SDK drops the down-conversion, and every green test stays green

§0.11 M1 — `inputRequired` being bridged to `elicitation/create` on a legacy connection — is
**undocumented behaviour of a `^2.0.0` dependency**, and the single fact §4.4 rests on. If a minor
removes or changes it, every gated tool becomes permanently unrunnable in production. **R1, R3, R5 and
the negative side-effect lanes all stay green** — R8 hardest of all, because "no side effect occurred"
is exactly what it asserts, and it will assert it perfectly while nothing works.

*Not the risk an earlier draft named.* That draft claimed a floating caret would silently flip the
protocol era. It cannot: §0.10 E2 shows `connect(new StdioServerTransport())` answers `server/discover`
with `-32601` — it is legacy **by construction**, and reaching the modern era requires an infra-kit
commit adopting `serveStdio`. The era flip is a decision, not a drift. *Mitigated by §6.12 R4 (the era
assertion, re-aimed) and — the one that actually matters — §6.7's **positive** accept-path lane, which
is the only test that fails when the down-conversion disappears.*

---

## 6. Test plan

### 6.0 The meta-guard, in its general form

Every false green found across three iterations has one shape:

> **A guard that must first find something in order to check it will report success when it finds
> nothing.**

That general form caught F3 (a `ZodDefault` unwrap inspecting zero keys), caught the extraction hole in
§6.2 (a body without backticks yielding zero tokens), and will catch the next one. It is stated here
rather than as a per-guard footnote precisely so the next author applies it without being told.

**Therefore: every guard that extracts before asserting must assert on what it found.** Not merely
`count > 0` — where a stronger anchor exists, bind to it:

- **Schema guards (N3):** the inspected key set must **equal that prompt's `prompts/list` argument
  names**, not merely be non-empty. `Object.keys(dflt._def).length === 3`, so a guard unwrapping to the
  wrong object still passes a `> 0` check. §6.4 already computes `prompts/list`, so this is free — and
  it anchors to the wire surface rather than a private path a zod minor can move.
- **Extraction guards:** `tokensExtracted > 0` per body (every body names at least one tool by
  construction), and for `commands` the extracted count must **equal the number of exposed tools
  rendered** — not merely that the tokens found are valid.

And the companion rule, unchanged: **every guard ships with a red-test that fails on the precise
scenario named in the pre-mortem, and the plan specifies the failing case rather than leaving it to the
implementer.**

**A third rule, added in iteration 4, and the mutation must be checked against the assertion.** Three of
this track's first-draft guards named a red test that could not fail: a mutation that flips
`=== true` to truthiness does not change the behaviour of `false`; a fixture declaring bare
`elicitation: {}` cannot tell `caps?.elicitation` from `caps?.elicitation?.form` because it normalizes
to both (§0.11 M4); and a set-membership assertion written over hardcoded literals passes whatever the
declared set actually contains. **Naming a mutation is not the same as checking that the mutation
breaks the assertion.**

Therefore, two obligations, because the three failures above are of two different kinds:

- **Mutation adequacy** (the first two): **every named mutation must be *executed* against the
  assertion, not merely described.** A mutation that reads as destructive on the page — truthiness for
  `=== true`, a "weaker" fixture — can be a no-op in fact. The plan may name the mutation; the
  implementer must run it and see red before the guard is considered to exist.
- **Assertion binding** (the third): where a guard asserts over a declared set, partition **the declared
  set itself** and assert equality of both halves — never assert facts about literals you wrote by hand,
  which are true independently of the thing under test.

### 6.0b The fourth standing rule — pre-mortems must ask the authorization question

Every pre-mortem in iteration 3, and the first three of iteration 4, hunt **liveness** failures: a loop,
a drift, a gate that stops gating, a body that rots. That is why §0.13 — a client that auto-fills a form
— was missed by a pre-mortem specifically hunting silent failure, and why §0.12's substitution hole sat
unnoticed in shipped code.

> **A pre-mortem that only asks "what stops working" will never find "what works exactly as designed,
> for the wrong principal."**

Therefore every pre-mortem set must contain at least one scenario asking **who is on the other end, and
what did they actually do** — not whether the mechanism ran, but whether the party it ran on behalf of
was the one intended. PM-4/5/6 are liveness scenarios; §0.13 and §0.12 are the authorization findings
they would not have produced, and they are recorded in §0 rather than §5 because they are **measured
facts about shipped code**, not hypotheticals.

### 6.1 Argument-shape guard — `src/mcp/prompts/__tests__/index.test.ts`

DI style copied from `mcp/resources/__tests__/index.test.ts`, reaching `_registeredPrompts` the way that
file reaches `_registeredResources`.

- **Unwrap explicitly (F3):** read the shape as `schema._def.innerType.shape`, never `schema.shape`.
  Then apply §6.0's schema anchor: the key set must equal the prompt's `prompts/list` argument names.
- Every argument is `z.string()` / `z.string().optional()`. **Reason, corrected per F4:** the type is
  invisible in `prompts/list` rows, the host sends a string regardless, and a non-string throws at `get`
  time.
- **Red case:** a `z.number()` **wrapped in `.default({})`** — the shipped shape. A bare-object fixture
  passes today and proves nothing.
- Every argument has a `.describe()` whose value is a **non-empty string** (F5).
- Every prompt has a non-empty `title` distinct from `name` (F6).
- Names unique, kebab-case, no spaces; pinned against native commands as a tripwire (§0.8).

**Deliberately NOT here:** an "`arguments` absent resolves" check. F1's throw originates in the SDK's
`prompts/get` **request handler**, not the registered callback, so a DI test that invokes the callback
directly bypasses schema validation and passes with or without `.default({})` — a false green of exactly
the §6.0 shape. The SDK exposes no `./inMemory` subpath (`.`, `./stdio`, `./validators/*`, `./_shims`),
so an in-memory pair is not available either. **§6.6's real-stdio E2E is the only place this can be
tested, and it is tested there.**

### 6.2 Tool-reference integrity guard — the extraction rule is the spec

**Bodies must write every agent-callable tool reference in one canonical form: an inline-code span
containing the full prefix, `` `mcp__infra-kit__<tool>` ``.** That style rule makes extraction decidable.
The extractor:

1. **Scans inline-code spans only.** Prose is never scanned — this is what stops `release-create`,
   `audit`, or `worktrees` (themselves body names) from tripping the guard as English.
2. A span matching `` `infra-kit <...>` `` is a **terminal command**: allowed, validated against
   `groupPath`.
3. A span matching `mcp__infra-kit__X` → `X` must be in **`getExposedMcpTools() ∪ declaredPromptNames`**
   and not in the forbidden set.

   **Why the union (D1).** Prompts and tools share the `mcp__infra-kit__` prefix and the extractor has
   no concept of a prompt namespace, so without it the canonical form
   `` `/mcp__infra-kit__commands` `` — which PR 5's pointer *mandates* — extracts `commands`, finds
   it ∉ `getExposedMcpTools()`, and is flagged. It also hits `commands`' own body and any body
   cross-referencing another.

   **The union is still required after the §4.2 rename, for a narrower reason.** An earlier draft
   justified it with "none of the prompt names is a tool name" — **now false**: three of the six
   are exactly tool names and pass rule 3 through `getExposedMcpTools()` alone. The union is what carries
   the other three — `worktrees`, `release-deploy`, and `commands` — which are deliberately not tool
   names (§4.2) and would otherwise be flagged.

   **Build the union from the EXPOSED set only — 23, per `command-catalog.test.ts:85`.** An earlier
   count of 25 registered tool names was wrong: it included the two *unexposed* registrations
   (`doctor`, `gh-release-deliver`). Union with the registered-but-unexposed set and the guard silently
   permits `gh-release-deliver`, which this section forbids by name.

   **Red case:** a *nonexistent* prompt name must fail, so the union does not become a blanket amnesty.
4. A span whose content is a bare kebab token matching any catalog `cliName` or `mcpTool.name`
   **without** the prefix → violation ("write the prefixed form").
5. **Catch-all (N4b):** any span containing `mcp__` that is **not** the canonical `mcp__infra-kit__`
   prefix → violation. This closes the wrong-prefix hole (`mcp__infra_kit__…`, underscore for hyphen)
   that matches neither rule 3 nor rule 4 — exactly the typo an author makes and a reader cannot see.
6. **Per §6.0:** assert `tokensExtracted > 0` for every body, counting **rule-3 tokens only**. This is
   the "named nothing at all" tripwire and nothing more — see rule 7 for the case it cannot catch.

   *Why no body fails this spuriously (D4):* every one of the six names at least one agent-callable
   tool by construction — the `audit` body names `audit` and
   `vendor-check`, `env-load` names `env-load` and `env-list`, `release-create` names `gh-release-list`,
   `release-create` and `release-desc-edit`, and so on. **A future body author must
   preserve that invariant**; a body that legitimately names no tool would need this rule relaxed for
   it explicitly, not silently.
7. **Every literal occurrence of `mcp__infra-kit__` in the RAW body must lie inside a code span.**

   Rules 1–6 scan spans only, so the realistic failure — a body that correctly backticks most
   references and **forgets on one** — has `tokensExtracted > 0`, satisfies rule 6, and its bare
   reference is never scanned. It passes green. The same argument defeats any claim that rule 6 covers
   fenced blocks: one valid inline span plus a fence containing `mcp__infra-kit__merge-dev` also has
   `tokensExtracted > 0` with the fence unscanned. **Fenced blocks are not covered by rule 6; rule 7 is
   what covers them.**

**Red corpus — all four required:**

| Case | Fixture | Expected |
|---|---|---|
| (a) prefixed misname | `` `mcp__infra-kit__merge-dev` `` (real tool is `gh-merge-dev`) | **FAIL** |
| (b) bare token | `` `merge-dev` `` in a code span | **FAIL** |
| (c) legitimate prose + terminal form | "run `infra-kit doctor` in your terminal", plus prose using the words release-create and worktrees | **PASS** |
| (d) forgotten backticks | **one valid span** plus one bare `mcp__infra-kit__merge-dev` occurrence | **FAIL** (rule 7) |

Fixture (d) is written as *valid span plus bare occurrence* deliberately. A fixture with no valid span
at all would be caught by rule 6's count check and would therefore prove nothing about rule 7 — it is
the mixed case that actually happens.

**The forbidden set is scoped to tool-call form, not to the word.** `doctor` as `` `infra-kit doctor` ``
is legitimate in any body that recommends running it in a terminal; `` `mcp__infra-kit__doctor` `` is
forbidden, because `doctor` is registered but **not exposed**. Same
for `gh-release-deliver`, `env-token-set`, `env-token-remove`, `self-update`.

Additionally: any body naming a gated tool must contain `confirm` **and** the no-`Bash` carve-out.
**Both survive §4.4** — the gate is kept, so this requirement is unchanged, not relaxed.

### 6.3 `commands` guard — negative and counted, not presence

An earlier draft asserted the output "contains a grouped path AND a divergent tool name" — a **presence**
assertion a generator emitting *both* `cliName` and the correct string satisfies while shipping the bug.

- **Negative:** the output contains **no** `mcp__infra-kit__<cliName>` for any of the five divergent
  entries.
- **Counted (§6.0):** the extracted token count **equals** the number of exposed tools rendered. Without
  this, a renderer emitting plain table cells with no backticks makes both the negative and the
  membership assertion pass on *any* output, including one keyed entirely on `cliName` — resurrecting
  the very bug this guard fixes, through the shared extractor.
- **Membership:** every rendered `mcp__infra-kit__X` has `X ∈ getExposedMcpTools() ∪ declaredPromptNames`
  (rule 3's union — the `commands` body cross-references prompt names).
- **Terminal form (N4c):** rendered CLI lines must carry the `infra-kit ` prefix. Rule 4's bare-kebab
  test otherwise collides with single-word `groupPath` renderings such as `audit`.
- **Red case:** a fixture generator keyed on `cliName` must fail.

### 6.4 Golden `prompts/list` snapshot

Name, `title`, description, argument names, `required` flags, **and argument descriptions asserted
non-empty before snapshotting** (F5 — a snapshot alone would happily record `undefined`). Sibling of the
existing `matches the golden MCP tools/list surface`.

### 6.5 Resource surface

A `resources/list` snapshot covering the **six new URIs** — five `infra-kit://workflow/<name>` (one per
hand-authored body) plus `infra-kit://commands` (the index). The index prompt is **not** double-served
under a `workflow/` URI. Counts are stated identically in §6.6 and the release checklist (§7.8):
**6 prompts, 6 new resources, 8 registered resources in total** (the six plus the pre-existing
`infra-kit://config` and `infra-kit://dev-context`).

**The §4.2 rename changes four of the six URIs.** Counts are unaffected; the snapshot rows are not:

| Was | Now |
|---|---|
| `infra-kit://workflow/release-cut` | `infra-kit://workflow/release-create` |
| `infra-kit://workflow/worktree-setup` | `infra-kit://workflow/worktrees` |
| `infra-kit://workflow/env-prepare` | `infra-kit://workflow/env-load` |
| `infra-kit://workflow/audit-repo` | `infra-kit://workflow/audit` |
| `infra-kit://workflow/release-deploy` | **unchanged** |
| `infra-kit://commands` | **unchanged** — and it now *matches* its prompt name, which it did not before |

**Bodies are `(args) => string`, not bare constants (D2).** The resource serves `render({})`. This is
what makes the sameness assertion testable *and* settles whether advertised arguments are silently
discarded: the four argument-carrying bodies (`release-create`, `release-deploy`, `worktrees`,
`env-load`) do interpolate.

**The companion assertion below stays satisfiable, and this was in doubt.** An earlier elicitation draft
proposed dropping all four arguments from `argsSchema` on the grounds that a form would collect them —
which would have made "at least one argument-carrying body returns different text when an argument is
supplied" not merely vacuous but **unsatisfiable**, with no argument-carrying body left to satisfy it.
§4.4 keeps the arguments (the form supplements the gate rather than replacing the invocation path), so
the assertion stands as written.

**The sameness assertion — invoke both handlers, do not compare a constant to itself.** An earlier draft
specified "identity of the imported constant, not string comparison of two independently rendered
outputs." That is backwards, and it is a tautology: with both sides imported from one module it asserts
`X === X` and is structurally incapable of failing whatever the registration code does. The risk it
exists to catch is that the **resource handler returns something other than what the prompt handler
returns** — a different constant, a re-render, a stale copy. So, per §6.0 (assert on what you found):

- Invoke **both registered handlers** and compare their outputs **to each other**, and
- anchor both to `render({})` from the imported module.
- **Companion assertion:** at least one argument-carrying body returns **different** text when an
  argument is supplied. Without it the no-arg comparison is satisfied by a body that ignores its
  arguments entirely — the same false-green shape §6.0 names.

PR 3's AC already stated the stronger form; §6.5 now matches it rather than contradicting it.

### 6.6 Integration — `src/mcp/__tests__/server.test.ts`

`server.ts:24-30` **already** declares `prompts: {}` and **already** calls `await initializePrompts(server)`
against the stub, so a capability-clause assertion is green today and has no teeth. Only
**"registers exactly 6 prompts and 8 resources, whose names equal the declared sets"** tests anything —
6 new resources (5 × `infra-kit://workflow/<name>` + 1 × `infra-kit://commands`) plus the two
pre-existing (`infra-kit://config`, `infra-kit://dev-context`). Stated identically in §6.5 and the
release checklist (§7.8).

### 6.7 E2E — `src/mcp/__tests__/mcp-stdio.e2e.test.ts`

Real `prompts/list`, `resources/list`, one `resources/read`, and two `prompts/get` calls — one with
`arguments` present, one with it **absent** (F1, and per §6.1 the only place that can be tested) —
against the bundle the file already builds hermetically into `node_modules/.cache` (F8). The only test
that can fail PM-3.

**Two standing rules in that file are load-bearing for the §4.4 lanes and must not be "simplified".**
`InMemoryTransport.createLinkedPair()` connects 2025-era instances only, so **every era assertion runs
over a spawned child** or it is a false green — and the `inputRequired` down-conversion *is* an
era-boundary behaviour. The file is deliberately one file with a small spawn ledger because
`pool: 'forks'` parallelises per-file.

**New lanes for §4.4:**

| # | Assertion |
|---|---|
| **R4** | `server/discover` over the shipped `dist/mcp.js` answers **`-32601 Method not found`**. This is the tripwire half: it pins "we are legacy by construction" and goes red if anyone adopts `serveStdio`, which is the only way the era can move. **The second half — `initialize(2026-07-28)` → `2025-11-25` without error — is architecturally always-green** and is kept only as executable documentation of §0.10 E1. *A future editor must not mistake it for the tripwire, or for evidence that the era cannot move: it would stay green through a `serveStdio` adoption.* |
| **R8a — POSITIVE, and the most important lane in this section** | **Accept path over a spawned child, all three legs.** A gated tool; an elicitation-capable client that answers `accept` **with argument values** (no `confirm` field exists in the schema to answer — Decision 2); the gate payload comes back carrying **those** collected arguments plus the token; the agent re-calls with `confirm:true` + the token; assert the tool **actually ran**, by its filesystem side effect, **and that it ran with the values collected in the form** rather than the ones round 1 was called with. **R8a is the only test that fails if the SDK's down-conversion disappears** (PM-6). |
| **R8b** | Negative side-effect lanes: `env-clear` leaves **no** filesystem side effect under (i) a client with no elicitation capability that never completes round 2, (ii) decline, (iii) cancel, (iv) round 2 carrying **substituted arguments**. |
| **R9** | The existing v1-client lane (E7) asserts the v1 path explicitly rather than inheriting it: no elicitation capability → gate path → the **pre-existing** `structuredContent` rejection, unchanged. Prevents "we improved Claude Code and further broke Inspector" going unnoticed. |

**Why R8a is not optional, and why an earlier draft was wrong to omit it.** That draft specified three
*negative* directions and no positive one. **PM-6 kills every one of them silently**: if a `^2.0.0`
minor drops the down-conversion, every gated tool becomes permanently unrunnable, and R1, R3, R5 and all
of R8b stay green — R8b hardest of all, because "nothing happened" is precisely what it asserts. A suite
that can only prove the tool *didn't* run cannot notice that it can *never* run. R8a is the only
assertion in the plan that fails in that scenario.

Spawn ledger impact: **+1 long-lived** (an elicitation fixture shared by R8a and R8b's four cases) and
**+1 short-lived** (R4's raw era probe). Stay inside the existing budget; do not split into new files.

### 6.8 Bundle guards

Extend `dependency-and-bundle-guards.test.ts` (U6/U7) with the prompt and resource counts, catching a
tree-shaken definitions tree at bundle level.

### 6.9 PR 6 only

`SKILL.md` ≤10 lines and names a `infra-kit://` resource URI; `plugin.json` has **no** `mcpServers` key;
every `skills/` directory appears in the explicit `skills[]` array.

### 6.10 Observability — destination stated

Handlers log through `src/lib/logger`, which writes via `pino.destination({dest: LOG_FILE_PATH})`
(`/tmp/mcp-infra-kit.log`, `logger.ts:6,36`) and pretty-prints to `destination: 2` — **stderr, never
stdout**. Load-bearing for an stdio server: a stdout write corrupts JSON-RPC framing.

### 6.11 Gate

Full `pnpm run qa`; sonarjs cognitive-complexity ≤ 15. A cached `eslint-check` can exit 0 while a cold
`--no-cache` run finds real errors, and untracked `??` files hide from it — check `git status` too.

### 6.12 Confirm-gate and form guards — `src/lib/tool-handler/__tests__/tool-handler.test.ts`

Per §6.0, each row names the mutation that must turn it red — **and the mutation has been checked
against the assertion**, which is the third standing rule.

| # | Assertion | Red test — the mutation that must fail it |
|---|---|---|
| **R0** | **An ungated tool** (`requiresHumanConfirm` absent or `false`) runs on the first call under **every** client-capability shape: no form request, no gate payload. | Remove §4.4 state 0 → an ungated tool returns `confirmation_required` instead of running. *(This is the exact bug two reviewers found in the earlier state machine, in both its branches.)* |
| **R1** | Decline → a **terminal `isError`**, handler body never entered, and **exactly one** `inputRequired` result returned across the exchange. Same for cancel. *(Wording corrected: an earlier draft said "counted **on the wire**", but this row is sited in `tool-handler.test.ts`, a unit file with no transport. The wire-level count belongs to R8b's spawned fixture; the unit-level assertion here is what PM-4 actually needs, and is adequate for it.)* | Replace state 2 with a re-issued `inputRequired` → a second `inputRequired` comes back instead of a terminal result. |
| **R2** | Accept (of the **argument** form) → the gate payload is returned, carrying the **collected arguments** and a `confirmToken` minted over them; the handler body has **not** run yet. | Run the handler directly on form-accept → the body runs one round early. *(This is also the row that catches a `confirm` field creeping back into `requestedSchema` and being treated as consent: state 3 must return a gate regardless of anything the form said.)* |
| **R3** | Round 2 with `confirm:true` and a **matching** token → handler runs **exactly once**, with `confirmedCommand: true` present in the args it received. **The positive lane runs all three legs under Decision 2**: form accept carrying argument values → gate returned with those args + token → round 2 with `confirm:true` + token → handler ran, with the **collected** values. | Drop the `confirmedCommand` injection → the received-args assertion fails. Separately: mint the token over the round-1 guessed args instead of the form-collected ones → round 2 carrying the collected values is refused, and the lane goes red. |
| **R5** | A client with **no** `elicitation.form` never receives a form; it gets today's two-call gate payload, and the handler does not run. | **Delete the `requiresHumanConfirm` condition** — *not* "truthiness instead of `=== true`", which is a no-op mutation since `false` is falsy under both spellings. The deletion is the mutation that actually breaks this, and it is the live risk named in PM-5. |
| **R7** | The capability probe reads `caps?.elicitation?.form`, not `caps?.elicitation`. | **Fixture must be url-only: `{elicitation: {url: {}}}`** — where `caps?.elicitation` is truthy and `.form` is `undefined` (§0.11 M4). A bare `{elicitation: {}}` fixture **cannot** discriminate: it normalizes to `{form:{}}` and both spellings pass. |
| **R10** | **Argument substitution is refused** (§0.12). Round 1 on `{env:'dev'}`, round 2 on `{env:'prod', confirm:true}` carrying round 1's token → refused, handler never runs. Also refused: tampered token, **expired** token, wrong bind, and **absent** token. **Expiry needs a stated mechanism** — `ttlSeconds` defaults to 600 and the key is per-process random, so mint that fixture with **`ttlSeconds: 1`** (or inject a clock). Unstated, the likely outcome is that the expiry case is quietly dropped. | **R10 fails against `main` today with no mutation at all** — `main` already *is* the echo (§0.12). That is the red test: run it against `main` and watch `env:'prod'` execute. A regression test for a live defect, not a hypothetical one. |

**R6 — the naming guard, `src/mcp/prompts/__tests__/index.test.ts`.** Partition **`declaredPromptNames`
itself** and assert **equality** of both halves against `getExposedMcpTools()`:

```
declaredPromptNames.filter(n => exposed.has(n))   ===  {release-create, env-load, audit}
declaredPromptNames.filter(n => !exposed.has(n))  ===  {worktrees, release-deploy, commands}
```

Both halves are size 3 and the declared set is **exactly size 6**. Assert the total too: a prompt added
without being placed in one of the two literal sets would otherwise widen only the half it lands in, and
a reader could not tell which invariant broke.

*Red test:* rename any prompt — `audit` → `audit-repo`, say — and the first set loses a member while the
second gains one, so **both** equality assertions fail.

**Why it is written this way.** An earlier draft asserted three facts over hardcoded literals: that the
set has the right size, that `audit` is an exposed tool name, and that `worktrees` is not. Renaming the
prompt `audit` → `audit-repo` leaves **all three true** — the size is unchanged, `audit` is still a tool name
(the tool did not move), and `worktrees` still is not. The guard could not fail on its own named
mutation: it asserted facts about the *catalog* and about *literals the author typed*, and never once
looked at what the prompts were actually called. Partitioning the declared set is what binds it to the
thing under test.

*This also enforces §4.2's operative clause* — a future tool named `worktrees`, `release-deploy`, or
`commands` moves that name across the partition and turns the guard red at build time.

---

## 7. Execution — thin, independent PRs

**Decision 3 (§8): the numbered phases are replaced by a PR sequence.** Each PR is self-contained,
carries its own acceptance criteria, and is mergeable alone. **Every acceptance criterion from the phase
plan is retained** — re-homed, never dropped or weakened.

| PR | Was | Content | Depends on |
|---|---|---|---|
| **PR 1** (§7.1) | Phase 0b | Gate binding: thread `ctx`, mint and verify `confirmToken`, canonical sorted-key serialization, refuse-on-absence *inside* state 4 | **nothing** |
| **PR 2** (§7.2) | Phase 0 | Rendering + elicitation experiment on a throwaway server. **Zero infra-kit code** | nothing |
| **PR 3** (§7.3) | Phases 1 + 2 | Prompt infrastructure, the six bodies, each registered as prompt **and** resource, and every §6 guard | PR 1 |
| **PR 4** (§7.4) | Phase 1b | The argument-collection form for the eight gated tools (§4.4 states 1–2), per Decision 2 | PR 1 **and** PR 2's evidence |
| **PR 5** (§7.5) | Phase 3 | Delete the hardcoded command list from `buildAgentsBody()`; leave a two-line pointer | PR 3 |
| **PR 6** (§7.6) | Phase 4 | The plugin veneer — **optional**, and only after living with the `mcp__infra-kit__` prefix | PR 3 **and** a user decision |
| *every publish* | Phase 5 | The release checklist (§7.8) | — |

**Why this order.** **PR 1 closes a live defect and is independent of every other decision in this plan —
it ships even if the user rejects everything else.** §0.12 is broken in shipped code today, and the fix
touches only `tool-handler.ts` plus the `ctx` thread; nothing in it presumes a single prompt is ever
written. **PR 2 costs nothing** — a throwaway server in a scratch repo, no infra-kit code at all — and it
de-risks PR 4, which is the one piece resting on an undocumented SDK behaviour (PM-6) and on host UI no
local measurement can reach. **PR 3 is the actual feature**, and the only PR whose absence means nothing
shipped. **PR 4, PR 5 and PR 6 are each optional on their own evidence** — PR 4 on PR 2's observations,
PR 5 on P2, PR 6 on whether the pretty namespace is worth a per-machine install forever — and none of
them blocks another.

### 7.1 PR 1 — close the argument-substitution hole. Depends on nothing; ships first.

> **Status (2026-09-05): implemented in the working tree, uncommitted.** `lib/tool-handler/confirm-token.ts` + `tool-handler.ts` (state helper, `confirmation_refused` terminal payload), `confirmToken` added to gated tools' `inputSchema` at registration in `mcp/tools/index.ts` (needed: `z.object` strips undeclared keys), `ctx` threaded through the registration wrapper. Tests: `tool-handler.test.ts` (R3 positive, canonical key order, R10 refusals: absent/mismatch/tamper/garbage/expired/bind/foreign key), `worktrees-remove-mcp-guards` and e2e `assertConfirmedCallExecutes` rewritten to a real round 1 → round 2, the w1 differential gained **D9** (authored: `confirmToken` on exactly the gated set). Deviation from the text above: the token is bound by tool name via a `{ toolName }` bind context (the SDK types `ctx` as `ServerContext`), and the mutation test's literal predicate `requiresHumanConfirm === true` is preserved inside a named state helper.

**§0.12 is a live defect in shipped code.** It is not contingent on any decision in this plan — including
all three of the user's — and it is the one PR here that fixes something already broken rather than
adding something new.

- `src/mcp/tools/index.ts` — pass the SDK callback's second argument (`ctx`) through. **`ctx` is not
  needed by this PR's own logic** — the codec's `bind` can close over `toolName`, which
  `createToolHandler` already has in scope. It is **PR 4's** requirement (the capability probe and
  `inputResponses`). Threaded now so the signature change lands once (§0.14).
- `src/lib/tool-handler/tool-handler.ts` — `createToolHandler` returns `(params, ctx) => …`. The inner
  `handler` signature stays `(params) => …`, so **zero edits under `src/commands/`**, matching the design
  intent already recorded in that file's registration comment.
- Mint a `confirmToken` over `{tool, args}` with `createRequestStateCodec` (§0.11 M5) into the gate
  payload; verify it on round 2 against the round-2 arguments. Refuse on mismatch, tamper, expiry, wrong
  bind, **or absence**.
- **What "the round-2 arguments" means, exactly.** Round 2 is round 1's arguments **plus `confirm:true`
  plus `confirmToken`**. Verifying against the raw round-2 params therefore refuses **every legitimate
  round 2**. Verify against round-2 args with **`confirm` and `confirmToken` removed**.
  *Precedent already in the file:* `buildConfirmGate` (`tool-handler.ts:32-38`) constructs `resolvedArgs`
  by filtering exactly `key !== 'confirm'`. Extend that filter; do not invent a second one.
- **Canonicalize before signing AND before verifying. This one is not optional.** `JSON.stringify` is
  key-order-sensitive — `{a:1,b:2}` and `{b:2,a:1}` produce different strings — and round-2 arguments
  are re-serialized by the client, so key order is whatever the host emitted. An HMAC over unsorted keys
  **refuses a legitimate confirmed deploy, intermittently and per-client**, and *no test in this plan
  would catch it*: R10 and R8b assert refusals only, and every fixture will naturally use one key order.
  The symptom is "my deploy is sometimes refused" and the blame lands on the wrong component. **Sort keys
  recursively before signing and before verifying**, or use an explicit stable canonical form; state
  which in a comment.
- Key: ≥32 bytes. A per-process random key is **sufficient and correct here** because one stdio process
  serves every round — state that in a comment, because it stops being true on any HTTP transport.
- `bind` to the tool name at minimum.
- **Refuse-on-absence lives *inside* state 4, never as a fall-through to state 3** (§4.4). A token-less
  round 2 that slid to state 3 would return a second gate and reopen §0.12 whole.
- **Extract the state discrimination into a named helper in this PR**, not in PR 4. This PR alone adds
  four refusal conditions plus minting to a function currently around 4–6 cognitive complexity, and PR 4
  does not exist yet. sonarjs ≤ 15.

**AC (can fail) — refusals *and* the accept path:**

- §6.12 **R10** in all its directions, plus §6.7 **R8b(iv)**.
- **§6.12 R3** — round 2 with `confirm:true` and a **matching** token runs the handler **exactly once**,
  with `confirmedCommand:true`. **This is the PR's only positive assertion and it is mandatory here.**
  Without it PR 1 — which ships first and alone — could meet its stated AC in full with the accept
  path completely dead: an implementation that refuses *everything* passes every refusal assertion.
  That is §6.0's own false-green shape, one level up, in the AC rather than in a guard.
  *(R3's three-leg form in §6.12 belongs to PR 4; PR 1 asserts the two legs that exist without a form —
  gate returned with a token, then a matching round 2 that runs.)*
- R10's red test is **R10 itself failing against `main`** — `main` already *is* the echo, so no mutation
  is needed to demonstrate it. Show that run, so the guard is proven against the real defect rather than
  a hypothetical one. *(An earlier wording said the red test was "restoring the echo"; that was
  backwards.)*
- `pnpm run qa` green.

**Two existing tests break, deliberately, and the red is correct:**

| Test | Why it breaks |
|---|---|
| `tool-handler.test.ts:165` — *"runs the handler with confirmedCommand:true when a flagged tool is called WITH confirm:true"* | Calls round 2 as `tool({ confirm: true, version: '1.2.5' })`. There was no round 1, so there is no token. **Breaks by construction.** |
| `mcp-stdio.e2e.test.ts:411` (`e5`) — *"call 2 with `confirm: true` actually executes (file appears)"* | `callTool({ name: 'env-clear', arguments: { confirm: true } })` — again no token. **Breaks by construction.** |

Both are **deliberate updates**: each must be rewritten to perform a real round 1 and carry the returned
token into round 2.

*Not affected, and not to be cited as breakage:* `tool-handler.test.ts:157-161` uses `toMatchObject`, a
subset match, so adding `confirmToken` to `structuredContent` leaves it green.

> **Refuse-on-absence is not negotiable.** Weakening it to "verify only if a token is present" reopens
> §0.12 completely — an agent simply omits the token and substitutes arguments freely. Note the shape of
> the temptation: this is **PM-5's own dynamic** (*the plausible fix under time pressure is to relax the
> condition rather than re-key it*) aimed squarely at the PR that exists to close the hole, and the
> attractor is strong because one of the two reds is the flagship *"confirmed call MUST have executed
> the handler."* The correct response to both reds is to update the tests, never the rule.

*Note the token is signed, not encrypted (§0.11 M5): the client can base64url-decode and read the
arguments. That is fine — they are arguments the client itself sent — but no secret may go in the
payload.*

### 7.2 PR 2 — a rendering and elicitation experiment. Zero infra-kit changes.

Per F7 the handshake is proven; only **host surfacing** is unknown. Stand up a throwaway stdio server —
roughly twenty lines — register it in a scratch repo's `.mcp.json`, and look at the `/` menu. **No
infra-kit file is touched by this PR**; what it produces is recorded observations, which is why it can
run in parallel with everything else.

**Register three prompts, not two** — the third is what makes observation 3 mean anything:

1. one with a required arg,
2. one all-optional with `argsSchema` **`.default({})`-wrapped**,
3. one all-optional with a **bare `z.object`**.

Three observations:

1. **Which field renders as the row label** — `title` or `name` (F6)?
2. **How a required vs optional argument is entered**, and what the row shows.
3. **Invoke (2) and (3) with the argument omitted.** The decision is only tested if the bare shape
   **throws through the real host** while the wrapped one succeeds. Registering one shape would merely
   confirm whichever was arbitrarily chosen — the same "specify the failing case" rule as §6.0.

**AC (can fail):** a screenshot of the prompt row plus recorded answers to all three, including the
observed divergence between (2) and (3). **If no row appears at all, Option A is invalidated and the
plan returns to review.**

**The elicitation probe folds in here** — same throwaway server, same zero-infra-kit-changes property.
Add one tool returning `inputRequired` and one reporting `getClientCapabilities()`. It answers the one
question no local measurement can: *what does the real Claude Code client actually do?* **Per Decision 2
the probe elicits an argument value from an enum, not a confirm checkbox** — probing the shape the
design will actually ship.

Three further observations, each able to fail:

4. **`getClientCapabilities()` against the real host** reports a shape containing `elicitation.form`
   (§0.11 M4 — record the exact normalized object, not a boolean). *If it does not, §4.4 degrades to
   gate-only everywhere and **PR 4 is cancelled — PR 1 is unaffected and still ships**.*
5. **The form renders as a real terminal control** (dropdown / text field) and **the turn blocks** until
   it is answered.
6. **Is Decline reachable in the real UI**, and does it produce `action:'decline'` — not a hang, not a
   silent accept? *If decline is unreachable, PM-4 is unavoidable through the UI and §4.4 must render the
   argument form for the gated set read-only, or not at all.*

**PR 2 gates PR 4 only.** PR 1, PR 3, PR 5, PR 6 and the release checklist do not depend on it.

One question to the user, asked *with the screenshot in hand*: the pretty `/infra-kit:` name costs a
plugin install on every machine, forever — and after PR 3 it buys **only the name**, since every body
is agent-reachable as a resource without it. Worth it? **That answer is what unblocks PR 6.**

### 7.3 PR 3 — prompt infrastructure and the six bodies. Depends on PR 1.

**PR 3 lands what were Phase 1 and Phase 2 as one PR.** The registration seam ships nothing observable
without bodies, and the bodies cannot register without the seam, so splitting them would produce a PR
whose only evidence is a snapshot of an empty list. It **depends on PR 1** because the bodies describe
the confirm-gate protocol *including the token*, and a body describing a protocol the code does not
implement is exactly the rot P1 exists to prevent.

#### 7.3a — infrastructure (was Phase 1)

- `src/mcp/prompts/index.ts` — replace the stub with a `PromptDefinition[]` and one `registerPrompt`
  loop, mirroring `mcp/tools/index.ts`: single call site, `argsSchema: z.object(...).default({})` (F1).
  The `.default({})` still carries `~standard` with a `jsonSchema`, so the preferred non-deprecated
  overload is still reached — verified. Carry a comment pointing at `tools/index.ts`'s zod-4 raw-shape
  explanation, and a second recording the F3 unwrap.
- `src/mcp/prompts/definitions/` — one TS file per body (§0.7). Header comment disambiguating from
  `src/lib/prompts/` (§0.9).
- **Bodies are authored as `string[]` joined with `'\n'`**, matching `agent-files.ts:59,61` — not
  template literals. §6.2 makes backticks load-bearing, and a template literal cannot hold a raw
  backtick unescaped.
- Guards §6.1, §6.4 and **§6.12 R6**; extend `server.test.ts` per §6.6.

**AC (can fail):** `prompts/list` over a live server returns **exactly the declared set** — count and
names both asserted — and the snapshot has one row per prompt, each with a non-empty `title`, a
non-empty description, and non-empty descriptions on every argument. R6's partition holds in both
directions. `pnpm run qa` green.

#### 7.3b — the six bodies, served on both channels, and the integrity guard (was Phase 2)

**Resources are core work here, not a PR 6 option**, because §0.2 establishes that an agent cannot
fetch a prompt and PR 5's pointer depends on a resource existing.

**Sequencing — three things land before any body is written**, because each one changes what the code
must look like rather than merely how it is checked:

1. **§6.5's `(args) => string` body shape and the invoke-both-handlers comparison.** Bodies authored as
   bare constants would have to be rewritten.
2. **§6.2 rule 7** (every literal `mcp__infra-kit__` occurrence inside a code span). Authoring the
   bodies against rules 1–6 and adding rule 7 afterwards means re-auditing all six.
3. **§6.2 rule 3's membership union.** Without it the guard rejects the pointer PR 5 mandates and
   the `commands` body itself, so bodies written first would fail a guard that is itself wrong.

- **Five** hand-authored bodies to §4.3, plus `commands` generated from `commandCatalog` reading
  `entry.mcpTool.name` — six in total, `dev-status` having been cut by the user (§4.1).
- **Register each body twice from one renderer:** a prompt (host `/` menu) and a resource serving
  `render({})` (agent reach). Bodies are `(args) => string` (§6.5). P1 is intact by construction and
  §6.2 covers the renderer once, covering both channels. This is a bonus, not a new drift surface —
  **drift requires two sources, and there is one.**
- **Counts, stated identically in §6.5, §6.6 and §7.8:** **6 prompts; 6 new resources** — five
  `infra-kit://workflow/<name>` plus `infra-kit://commands`, with the index **not** double-served
  — and **8 registered resources in total** including the two pre-existing. **The §4.2 rename changes
  four of the five `workflow/` URIs (§6.5's table) and leaves every count untouched.**
- The `workflow/` sub-path is deliberate, and the reason is a kind distinction rather than a collision
  count: the two existing resources are **state** (live config, live dev-context) while the new ones are
  **documents**. Different kinds should not share a flat namespace regardless of collision risk, and the
  prefix gives §6.5's snapshot and §6.8's count something to filter on.
- Follow `mcp/resources/index.ts`'s existing injectable `ResourceDeps` pattern and error-swallowing
  handlers.
- **One shared render/extract module** used by `commands` and the §6.2 extractor — justified as DRY
  (P1 note). *(It has two consumers, not three: PR 5 no longer generates a command list.)*
- Guards §6.2, §6.3, §6.5 with their full red corpora.

**AC (can fail):** each of the specified red cases fails when introduced and passes when removed —
demonstrated, not asserted. `resources/read` on every `infra-kit://workflow/<name>` **equals
`render({})`** and equals the output of that body's prompt handler, and at least one argument-carrying
body returns different text when an argument is supplied (§6.5). `pnpm run qa` green.

**AC — the E2E, over the hermetically built bundle** (§6.7, F8; the only thing that can fail PM-3):
`prompts/list`, `prompts/get` **with `arguments` absent** (F1 — per §6.1 the only place this is testable
at all), and one `resources/read`, all against the bundle the file already builds into
`node_modules/.cache`.

### 7.4 PR 4 — the argument-collection form. Depends on PR 1, and on PR 2's evidence.

`src/lib/tool-handler/tool-handler.ts` only — §4.4's state machine, states 0 through 4, with state 0
written explicitly. States 3 and 4 already exist after PR 1; **this PR adds states 1 and 2 and the
capability probe**, and per **Decision 2** the `requestedSchema` it builds contains **the tool's
arguments only — no `confirm` field of any kind**.

**AC (can fail):** §6.12 R0, R1 (decline is terminal — asserted at unit level, *not* "on the wire"; the
wire-level count belongs to R8b), R2, R5, R7 (the url-only `{elicitation: {url: {}}}` fixture, the only
one that can discriminate `.form` from `.elicitation`), and §6.7's lanes: **R8a — the positive
accept-path lane over a spawned child, driving all three legs (form accept with argument values → gate
returned carrying those args and the token → round 2 with `confirm:true` + token → the tool actually
ran)** — green; **R8b**'s four negative lanes green; **R4** (`server/discover` → `-32601`) green; and
**R10's expiry direction** exercised with `ttlSeconds: 1`. **E4's** gated-call filesystem proof still
green unmodified. sonarjs cognitive-complexity ≤ 15, in the helper PR 1 already extracted.

*E5 is deliberately **not** in that list.* An earlier draft required "the existing E4/E5 filesystem gate
proof still green **unmodified**", which is **unsatisfiable** once refuse-on-absence lands in PR 1 —
E5 calls round 2 with no token by construction. E5 is rewritten in PR 1 and must be green **as
rewritten**; only E4, which asserts the *gated* call did not execute, survives untouched.

### 7.5 PR 5 — delete the restatement; do not repair it. Depends on PR 3.

`buildAgentsBody()` hardcodes a prose command list that has already drifted. **Delete it.**

**Why deleting beats signalling.** The previous draft proposed teaching `infra-kit audit` to read the
`<!-- infra-kit:version -->` marker. That is withdrawn, and the reason is decisive rather than
stylistic: **`audit` has no severity concept.** `audit.ts:109` is
`const allPassed = results.every((result) => result.passed)`, and a search for `severity|warn|level`
across `commands/audit/` returns nothing but an unrelated comment at `:147`. So the choice is binary — a
CI-breaking check or no check — and a CI-breaking one *would* break CI: root `qa` runs
`turbo run … infra-kit-check`, `infra-kit-check` is `pnpm exec infra-kit audit`, and `audit.ts`'s own doc
comment states `allPassed` "lets the CLI set a non-zero exit code so the audit fails CI". Composed with
the accepted silent self-update, **every consumer repo's `qa` would go red the moment infra-kit updates,
with no change to the repo.** Strictly worse than the invisible staleness it repairs.

Deleting is also what P2 now says, and what §4 already argued one level up: one generated index beats
many rotting copies, and this copy sits in a file the CLI cannot reach.

**The change:**

- Remove the hardcoded command list **and** the `` ## Commands (`ik` = `pnpm exec infra-kit`) `` header
  from `buildAgentsBody()`.
- **Keep** the Conventions section (genuinely static) and the `<!-- infra-kit:version -->` marker
  (harmless, and useful to a human reading the file).
- Leave a **two-line pointer**, one per audience:
  - *agent-facing* — the `infra-kit://commands` resource URI, **plus a tool-only fallback**. Per §0.2,
    resource tools were present in only 1 of 4 observed sessions, so a pointer naming only the URI would
    dead-end most of the readers it is written for. The fallback names the `mcp__infra-kit__*` tools,
    which were present in **all four** observed sessions — the strongest claim the evidence supports;
    not "always".
  - *human-facing* — `/mcp__infra-kit__commands` for the `/` menu. **(Renamed by §4.2; AC 3b below is
    exactly the guard that catches a pointer left naming the old `command-index`.)**

  **The fallback is a degraded path, not an equivalence** (§0.2.3): it yields the tool *list*, not the
  procedure, so an agent taking it loses the ordering, the confirm protocol, and the prohibitions the
  body carries. PR 5 is still net-positive — it deletes a wrong artifact, and the `/` menu is what
  was asked for — but the pointer should not be described as preserving what the list provided.

The managed-block writer, symlink refusal, backups, byte-identical skip, and legacy-`AGENTS.md`
migration are untouched.

**Worktree note:** `getInfraKitConfigPaths().main` is `path.join(projectRoot, ...)` and is
**worktree-local**, while `userProject` keys off `getMainRepoRoot`. `init` inside a linked worktree
writes *that worktree's* `CLAUDE.md` — a git-tracked file, so the block lands on that branch. Existing
behavior, unchanged; called out because it surprises people.

Then run `infra-kit init` in **this** repo, which has no managed block — closing the dogfooding gap.

**Two ACs, both able to fail:**

- **3a — the restatement is gone.** The generated block contains no `pnpm exec` and **zero**
  terminal-command spans, asserted by the §6.2 extractor. Zero, not "none but the pointer's": the
  pointer names a resource URI and a `/`-menu prompt, neither of which is a terminal command, so the
  simpler assertion is also the correct one. *(`ik` is dropped from the permitted terminal forms
  entirely: an extractor checks form, not runnability, and `ik` is not runnable without an alias —
  defined by the very header this PR deletes.)*
- **3b — the pointer does not rot.** The resource URI and the prompt name it names both exist in the
  registered resource and prompt sets. Fails if either is renamed. *(This replaces the old derivation
  AC, which is moot once nothing is derived, and guards the one residual risk of pointing.)*
  **This AC is why PR 5 could not be left untouched by the §4.2 rename** — it fails by construction
  against a pointer naming `command-index`, which is the correct behaviour and the reason the rename
  must reach this PR rather than stopping at §4.2.

### 7.6 PR 6 — the plugin veneer. **Optional.** Depends on PR 3 and on a user decision.

Contingent on PR 2's rendering evidence and the user's answer to the one distribution question — asked
**after living with the `mcp__infra-kit__` prefix for a while**, not before, since the whole question is
whether the prefix is annoying enough in daily use to be worth a per-machine install forever.
**After PR 3 its remaining value is purely cosmetic**, since every body is agent-reachable as a
resource without it — which strengthens rather than weakens the §2.3 concession that the namespace is
cosmetic.

- `.claude-plugin/plugin.json` with an explicit `skills[]` array and **no `mcpServers`** (§0.5);
  `.claude-plugin/marketplace.json` alongside.
- `skills/<name>/SKILL.md` ≤10 lines: **read the `infra-kit://workflow/<name>` resource and follow it**,
  treating args as `$ARGUMENTS`. Three failure clauses (§0.5): server absent, resource missing, and
  resource tools unavailable in this session — the last naming the tool-only fallback.
- Frontmatter limited to `name`, `description`, `argument-hint` (§0.6).
- Tests §6.9.

**AC — MANUAL (can fail):** for each body, the text **fetched** via `/infra-kit:<name>` and via
`resources/read` is byte-identical. Asserted on the **fetched body**, not the transcript: the plugin
route additionally injects the dispatcher's own text, so transcripts differ by construction and a
transcript comparison could never pass. Labelled manual because "invoking in one session" is not
automatable. Separately: the session's tool list contains no tool under a second prefix
(`mcp__plugin_infra-kit_*`).

### 7.7 Named follow-ups — not PRs

These keep their original names deliberately, so that references elsewhere in this document and in the
review history still resolve. Neither is part of any PR's acceptance criteria.

**Phase 2b — the two deferred bodies.** `merge-dev` and `local-deploy` ship when their §4.1 conditions
are met: the merge-dev hardening plan landing (or a body scoped to the one verified `MERGE_HEAD`-present
signal), and `local-deploy.ts:333` being fixed (or a body that states the gap outright). Not part of the
launch AC.

**Phase 2c — decide `completable()` (F9).** `release` and `env` are exactly the completable kind. Cost:
capabilities gain `completions: {}`, changing the initialize surface asserted at
`mcp-stdio.e2e.test.ts:590` and the D1 capabilities test. **Default: no for v1**, keeping that surface
frozen. A recorded decision with a stated cost, not a hard constraint.

### 7.8 Every publish — the release checklist

This is not a PR; it is the checklist that runs on **every** publish that carries any of the above.

`shasum` every manifest and the vendor mirror before and after `pnpm run qa`, diff before committing (a
full `qa` rewrites them); confirm no `catalog:` protocol reaches published runtime deps. Nothing changes
in `"files": ["dist"]` — which is why PR 3's E2E must exercise the built bundle.

**Pin `@modelcontextprotocol/server` to `~2.0.0`** (and `@modelcontextprotocol/client` likewise). Not
for the reason an earlier draft gave — the protocol era cannot drift under a caret (§0.10 E2) — but for
**PM-6**: the `inputRequired` → `elicitation/create` down-conversion is undocumented behaviour that
§4.4 depends on absolutely, and a minor is exactly where it would change. **The pin guards the
down-conversion, not era drift.** It makes an SDK upgrade a deliberate edit that runs §6.7 R8a rather
than a silent install.

**AC (can fail), once PR 3 has shipped:** the published tarball's `dist/mcp.js` answers `prompts/list`
with a count equal to the declared definitions array, and `resources/list` with that array's **five**
workflow entries plus `infra-kit://commands` plus the two pre-existing — **6 prompts, 8 resources**,
stated identically in §6.5 and §6.6. Responses match PR 3's snapshots. Counts derive from the declared
sets; no number is hardcoded in the assertion.

---

## 8. ADR

**Title:** infra-kit slash commands are MCP workflow bodies served as prompts and resources, with a
scheduled name-only plugin veneer

**Status:** pending approval

**Decision.** Implement the slash commands as MCP prompts registered by the CLI's own server, authored
as TypeScript string constants, **and register each body additionally as a resource** so agents can
reach it. Launch six: five hand-authored workflows and one catalog-generated index, with `merge-dev`
and `local-deploy` deferred behind stated conditions. No body per exposed tool. Delete the hardcoded
command list from the generated `CLAUDE.md` block rather than repairing it. Schedule a name-only plugin
veneer declaring no `mcpServers`.

**Name the six after the tools they front** (§4.2), on the measured finding that prompt and tool
namespaces are disjoint on the wire.

**For the eight gated tools, collect the arguments with a form and keep the gate as the consent step**
(§4.4): return the non-deprecated `inputRequired` on the **unchanged** `server.connect` transport with
**only the tool's arguments** in its schema, keep the two-call `confirm:true` protocol as the sole
consent moment, and **bind the collected arguments into a signed token** so round 2 cannot substitute
different ones. Do not adopt `serveStdio`; do not use `elicitInput`. **Close the argument-substitution
hole first, in its own PR** — it is a live defect in shipped code (§0.12).

### User decisions (2026-09-03)

Three decisions were made by the user after reviewing the approved plan. They are recorded here as
**decisions, not review findings**: a future reader should know they were chosen, not derived.

1. **`dev-status` is removed from the launch set — six commands, not seven.** Final set:
   `release-create`, `release-deploy`, `worktrees`, `env-load`, `audit`, `commands`. Deferrals unchanged
   (`merge-dev`, `local-deploy`). *Stated reason:* a headless "interpret" body is thin — its value was
   **explaining what the panel's rows mean**, and explaining panel semantics does not need a menu row.
   The knowledge is not lost (§4.3) and the `dev-status` **tool is untouched**.
2. **The elicitation form collects arguments only — never a confirm checkbox — and the gate stays as the
   agent's second call.** This *refines* Option F rather than rejecting it. *Stated reason:* under F as
   written, the human ticks "confirm" in the form, submits, and **nothing happens** until the agent
   re-calls — two confirm moments for one action, the first visibly inert. That is a UX defect the plan
   had not named. The security posture becomes **exactly today's, plus the binding**; the form adds
   real-value collection and nothing else (§4.4).
3. **Execution is a sequence of thin, independent PRs rather than numbered phases** (§7). Each PR is
   self-contained with its own AC and is mergeable alone; every AC from the phase plan is re-homed, none
   dropped. *Stated reason:* PR 1 closes a live defect and is independent of every other decision here,
   so it must be able to ship even if everything else is rejected; the rest are each optional on their
   own evidence.

**Drivers.** (1) Distribution asymmetry: infra-kit's server is a globally installed, silently
self-updating CLI launched from the consumer repo's `.mcp.json`, whereas OMC's ships inside its own
versioned plugin directory. (2) Reach: prompts are a host UI affordance and agents cannot fetch them;
resources are the only agent-reachable channel, and are themselves not universally available.
(3) Namespace is the sole axis on which a plugin wins.

**Alternatives considered.**

- *Plugin with fat skill bodies (what the cited reference does)* — rejected: OMC is safe because its
  plugin bundles its MCP server, making skills and tools atomic. infra-kit cannot bundle a globally
  auto-updating CLI without double-registering and invalidating every `mcp__infra-kit__*` allowlist entry.
- *`infra-kit init` generating `.claude/` command files* — rejected on namespace (unnamespaced `/foo`)
  and independently on P2 (a restatement the CLI cannot update).
- *1:1 body per exposed tool (23)* — rejected on P4; replaced by one generated index.
- *Repairing the CLAUDE.md command list with an `audit` staleness check* — **considered and rejected on
  measurement.** `audit` has no severity concept (`audit.ts:109`; no `severity|warn|level` anywhere in
  `commands/audit/`), so the check could only be CI-breaking, and root `qa` runs it via
  `turbo run … infra-kit-check` → `pnpm exec infra-kit audit`, whose non-zero exit exists expressly to
  fail CI. Under silent self-update that turns every consumer's `qa` red with no repo change — worse
  than the staleness it repairs. Deleting the list is the fix.
- *Pointing `CLAUDE.md` at the `commands` **prompt*** — rejected: `CLAUDE.md` is read by agents, and
  agents cannot fetch prompts (§0.2). The pointer names the **resource**, with a tool-only fallback.
- *OMC's `commands/` budget layer, hooks, and state store* — rejected as premature at six entries (P5).
- *Cutting the launch set to four (Architect) vs six-to-seven (Critic)* — the reviewers disagreed and the
  Critic's position was adopted on cost structure; the Architect's cut list was inverted, retaining the
  one entry with a documented architectural blocker while cutting the two lowest-risk. **The user then
  cut `dev-status`** on the separate editorial ground recorded above, landing at six.
- *Do nothing (tools only)* — rejected: leaves the confirm protocol and the deliberate exclusions
  untaught, with `Bash` as the fallback.
- *Keeping the workflow-invented names (`release-cut`, `env-prepare`, …)* — rejected on measurement: the
  justification was that a prompt sharing a tool's name would read as a duplicate, and §0.11 M0 shows
  the namespaces are disjoint. The `/` menu contains only prompts, so no duplicate is ever rendered.
- *`elicitInput` on the current era* — rejected on P7: explicitly deprecated, throws on a 2026-era
  request, and **strictly dominated** — §0.11 M1 reaches the same wire behaviour on the same connection
  with no scheduled failure.
- *`serveStdio` + the 2026 `input_required` era* — rejected on **P7 alone**, and the grounds matter.
  An earlier draft rejected it as an *inert* trade, having measured `SUPPORTED_PROTOCOL_VERSIONS` and
  concluded the SDK shipped no 2026 era. **That measurement was unsound** (§0.10): the modern era lives
  in `SUPPORTED_MODERN_PROTOCOL_VERSIONS` and is reached via `server/discover`, and `serveStdio` gets
  there today — verified end to end. So it is a **live** hazard: `legacy` is only `'serve' | 'reject'`,
  there is no "stay put", and infra-kit self-updates silently and globally.
- *A form instead of the gate* — rejected on **Driver 2** and §0.13: a client may declare form support
  and auto-fill it (`applyDefaults` is a sanctioned configuration, and the SDK's presentation language
  is a SHOULD). Against such a client a form-only design gates nothing, and the capability fallback
  never engages because the client genuinely does declare the capability. Its one real benefit —
  eliminating the `structuredContent` payload that v1 clients reject — is given up knowingly.
- *Option F with the confirm **inside** the form* — **rejected by the user on UX** (User decision 2):
  two confirm moments for one action, the first of them inert. The human ticks "confirm", submits, and
  nothing happens until the agent's second call. The form now carries arguments only.
- *Applying the form per-tool by blast radius* — rejected on P5: a third code path and a test axis for a
  distinction `requiresHumanConfirm` already expresses, against the sonarjs ≤ 15 ceiling.

**Why chosen.** Bodies ride the existing distribution channel with zero packaging change and make
version skew structurally impossible — text and tools are one build. Serving one constant on two
channels covers both audiences without creating a second source. Where OMC's design is genuinely better
— the thin-dispatcher / fat-body split — the plan copies the pattern and relocates the body.

**Consequences.**

- Wording changes require a CLI release — the property that keeps text and tools in lockstep.
- The `/` menu shows `/mcp__infra-kit__<name>` until PR 6 ships, and PR 6 now buys only the name — which
  is exactly why the decision to ship it is deferred until the prefix has been lived with.
- Arguments are positional strings unless named follow-up 2c (§7.7) adopts `completable()`.
- Every `argsSchema` is `.default({})`-wrapped, so schema guards must unwrap via `_def.innerType.shape`
  and anchor to the `prompts/list` argument names.
- The generated `CLAUDE.md` block shrinks to Conventions plus a two-line pointer. Consumers lose an
  inline command list and gain one that cannot go stale — at the cost of one indirection, and of a
  fallback path for sessions without resource tools.
- Resource-tool availability varies by session, cause not established — present in 1 of 4 observed
  sessions, while the `mcp__infra-kit__*` tools came through in all 4. Nothing may assume it, and
  PR 5's agent-facing pointer will usually take the degraded tool-only fallback (§0.2).
- **Three prompt names now equal tool names.** Safe on the wire, but §6.2's extractor union is doing more
  work than when the sets were disjoint, and §0.9's disambiguating header comment matters more.
- **The `structuredContent` gate payload survives, and its v1-client rejection lands after the human has
  filled in the argument form** rather than before it. Under user decision 2 what is lost there is a set
  of chosen **values**, not an approval — the finding stands, softened. Accepted deliberately to satisfy
  Driver 2; the affected intersection — clients that declare elicitation *and* validate
  `structuredContent` ignoring `isError` — is plausibly empty today.
- **The form is an argument picker, not an authorization boundary.** Consent is the agent's second call
  and the host's permission prompt on it, exactly as today; a client that auto-accepts forms therefore
  gains nothing it did not already have (§4.4, PM-0).
- **`ctx` becomes part of the tool-handler contract.** No `src/commands/` file changes.
- **§4.4 rests on one undocumented SDK behaviour** (the down-conversion, §0.11 M1). The dependency is
  pinned to `~2.0.0` and §6.7 R8a is the assertion that fails if it disappears — the only one that does.
- **The `confirmToken` is attacker-controlled input from day one**, by design: it rides in
  `structuredContent` and returns in round-2 arguments. It is HMAC-verified, fail-closed, and signed
  rather than encrypted, so no secret may go in its payload.

**Follow-ups.**

- Fix the `cliName` doc comment in `command-catalog.ts` — it claims `cliName` is the registered MCP tool
  name, contradicted by a five-entry `EXPECTED_PARITY` divergence map.
- Consider promoting the §6.2 extractor into a general guard for any generated text naming a tool.
- Revisit after one release cycle using the logs: retire any of the six nobody invokes.
- Revisit the `commands/` budget layer only past ~25 entries.
- Re-evaluate named follow-up 2b (§7.7) once `local-deploy.ts:333` and the merge-dev hardening plan land.
- If `audit` ever gains a severity tier, the withdrawn staleness check becomes viable for other
  generated artifacts — but not for a command list, which P2 forbids regardless.
