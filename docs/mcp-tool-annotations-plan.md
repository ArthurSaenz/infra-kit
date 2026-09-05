# [DO] MCP tool annotations & titles

**Status: pending approval**
Revision 2 — addresses Architect items 1–14 and Critic items 15–25.
Package: `apps/infra-kit/cli` (paths relative to it unless prefixed `docs/`)
Date: 2026-09-05

---

## 0. Problem

infra-kit's MCP tools carry only `description`, `inputSchema` and `outputSchema` — no `title`, no
`annotations`. The user's framing:

> Тули не мають сучасних метаданих. Немає `title`, немає `annotations`. Найважливіше —
> `requiresHumanConfirm` це наш власний гейт, а в протоколі для цього є стандартний
> `annotations.destructiveHint: true`. Зараз хост не бачить деструктивності тула на рівні протоколу.

The operative word is **бачить** — *sees*. `env-clear`, `gh-merge-dev` and `local-deploy-all` present
to a client with byte-identical protocol metadata to `version` and `config-get`. Every host affordance
keyed off `readOnlyHint`/`destructiveHint` is unavailable to infra-kit users. Our own resources already
pass `title` (`src/mcp/resources/index.ts:55,72`); the tools do not.

---

## 1. Principles

**P1 — Annotations are advisory; the gate is authority.**
The spec states annotations are *hints* clients must not trust for security decisions. This work is
strictly **additive**. Nothing here reads, weakens or reroutes the confirm gate — which, since
`src/lib/tool-handler/confirm-token.ts` landed, HMAC-binds round 2 to round 1 over canonical arguments
(`createRequestStateCodec`, bound to tool name, 600 s TTL, refusals
`absent|malformed|mac|expired|bind|mismatch`). **Adding `destructiveHint` mitigates nothing about the
gate and must never be cited as having done so**; no part of the gate reads annotations. Both ship;
neither substitutes for the other.

**P2 — One source of truth per fact, and it is the catalog.**
`command-catalog.ts` owns `mutating` and `requiresHumanConfirm`. Anything derivable from `mutating` is
**derived**, never re-typed.

**P3 — Declare only what nothing else encodes, and cite evidence for every declared value.**
Exactly one fact survives derivation — `openWorldHint` — plus display titles. Every declared
`openWorldHint` row carries a `file:line` naming the call site. A rationale without a citation is what
produced error E1 (§3.1); the citation requirement is the control that replaces it.

**P4 — Where a hint is uncertain, keep the spec default.**
Defaults: `destructiveHint` **true**, `readOnlyHint` **false**, `idempotentHint` **false**,
`openWorldHint` **true**. Revision 1 stated P4 and then violated it in three places (Critic C2). This
revision is P4-compliant **by construction**: every derivation below moves toward the conservative
value, and §2.1 tabulates each assignment against its default. No explicit under-claim survives.

**P5 — Say what a test can and cannot detect.**
A derivation and a test of that derivation are not independent evidence. Every acceptance criterion in
§8 is labelled *refactor detector* or *real content*, and where a hint has no possible mechanical
guard, the plan says so rather than implying coverage.

---

## 2. Decision drivers

1. **Protocol-level visibility of destructiveness** — the ask, read literally: the bytes on the wire
   must change.
2. **`getExposedMcpTools()` discards `entry.mutating`**, so the single `registerTool` call site cannot
   see the field that should drive `readOnlyHint`. Any option must say how the loop gets it.
3. **The `w1c`/`w1e` differential compares against a frozen committed fixture** — two new served keys
   are a guaranteed failure, not a risk (§7.1).

### 2.1 Every assignment against its spec default (answers Critic C2 / item 18)

| Hint | Rule | Spec default | Direction of error | P4 |
|---|---|---|---|---|
| `readOnlyHint` | `!mutating && !NOT_READ_ONLY` | `false` | toward `false` for `reopen`; never away | ✅ |
| `destructiveHint` | `readOnlyHint ? undefined : true` | `true` | always the default; `worktrees-add` is the one genuine over-claim | ✅ |
| `openWorldHint` | **declared**, evidence-cited | `true` | 10 rows hand-typed `false` — the **loosening** direction | ⚠ by evidence, not by construction |
| `idempotentHint` | **not shipped** | `false` | n/a — never claimed | ✅ |

**Scope this claim precisely.** For the two **derived** hints — `readOnlyHint` and `destructiveHint` —
no row under-claims, and none can: the derivation admits no hand-typed value, and the one override
(`NOT_READ_ONLY`) can only tighten. The `ADDITIVE_ONLY` array, revision 1's sole under-claim in a
derived hint and the artifact both reviewers condemned, is gone.

`openWorldHint` is the exception and must not be described otherwise. It is **declared** on all 23
tools, and the ten `false` values are hand-typed in the loosening direction against a spec default of
`true`. Nothing in the derivation, and no CI test, prevents one of them being wrong — §4.3 explains why
both candidate mechanical checks are unsound, §8.2 states the coverage gap, and R3 carries it as
accepted residual risk. Its guard is the mandatory `file:line` citation plus review, not construction.

---

## 3. Ground truth (verified 2026-09-05)

| Claim | Evidence |
|---|---|
| `registerTool` config accepts `title?`, `annotations?`, `icons?`, `_meta?` | `dist/createMcpHandler-CLhGwQTn.d.mts:3300` |
| `ToolAnnotationsSchema` byte-identical across both era chunks | `dist/src-CX2iR2pK.mjs:1138`, `:2698` |
| **Every annotation field is `.optional()` with NO `.default()`** | `dist/src-CX2iR2pK.mjs:1138-1144`, `:2698-2704` |
| **The SDK never reads `destructiveHint`** — `grep -rn '\.destructiveHint' dist/*.mjs` is empty; the only hits are the two schema definitions | verified |
| `title` on `BaseMetadataSchema` = `{ name, title? }` — distinct from `annotations.title` | `dist/src-CX2iR2pK.mjs:2515-2519` |
| `IconSchema` = `{ src, mimeType?, sizes?, theme? }` | `dist/src-CX2iR2pK.mjs:726`, `:2509` |
| Single `registerTool` call site | `src/mcp/tools/index.ts:12-48` |
| `getExposedMcpTools()` drops every entry-level field | `command-catalog.ts` |
| 23 exposed tools; `LOW_RISK_MUTATING_ALLOWLIST` = 4 members | `command-catalog.ts:513-522` |
| `w1c`/`w1e` baseline is a committed fixture, per-tool keys `["name","description","inputSchema","execution","outputSchema"]` | `fixtures/tools-list-baseline.v1.json`, loaded `mcp-stdio.e2e.test.ts:810` |
| Delta legend lists D1–D8 and is **already missing D9** | `mcp-stdio.e2e.test.ts:790-797` |
| `e1`/`e1m` compare tool **names** only | `mcp-stdio.e2e.test.ts:236-255` |
| catalog snapshot records `{name, input[], output[]}` only | `__snapshots__/command-catalog.test.ts.snap` |
| `server.test.ts` (46 lines) and `mcp-confirm-gate-mutation.test.ts` reference no registration config | zero matches |
| `scripts/build.js` has no `loader`, `assetNames` or `publicPath` | `scripts/build.js:36-70` |
| The confirm gate binds arguments | `src/lib/tool-handler/confirm-token.ts` |

### 3.1 The decisive finding: an omitted `destructiveHint` is invisible

The Architect's S1 proposed omitting `destructiveHint` everywhere and relying on the spec default of
`true`. Tested against the shipped SDK, that default does not exist in code:

```js
// dist/src-CX2iR2pK.mjs:1138-1144 and :2698-2704 — both era chunks, identical
const ToolAnnotationsSchema$1 = z.object({
  title: z.string().optional(),
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),   // .optional(), NO .default()
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional()
});
```

`grep -rn '\.destructiveHint' node_modules/@modelcontextprotocol/**/dist/*.mjs` returns **nothing** —
no reader, no default-application, no helper. A client parsing `tools/list` with the reference schema
gets `annotations.destructiveHint === undefined`. A host wanting the spec default must hand-write
`?? true`; the far more natural `=== true` yields `false`.

**Consequence: under S1 the destructiveness bytes on the wire are identical before and after the
change** — which is the exact state the ticket opens with. S1 satisfies a spec lawyer and fails the
person who filed the ticket. It is also internally inconsistent: it keeps `openWorldHint: true`
explicit on the open-world tools, where `true` *is* the spec default — so "omitted means default,
don't send it" is not applied to its own second hint.

**S1 is rejected on this evidence.** This paragraph exists so the omission cannot be re-proposed
without first refuting the grep.

---

## 4. Option chosen

**Option C′ — derive every hint; declare only titles and `openWorldHint`.**

```
readOnlyHint    = !entry.mutating && !NOT_READ_ONLY.includes(name)
destructiveHint = readOnlyHint ? undefined : true
openWorldHint   = MCP_TOOL_PRESENTATION[name].openWorld     // declared, evidence-cited
idempotentHint  = not shipped
title           = MCP_TOOL_PRESENTATION[name].title
```

Changes from revision 1: `ADDITIVE_ONLY` deleted (Critic #15); `idempotentHint` dropped (§4.2);
`NOT_READ_ONLY` added (§4.1); `MCP_TOOL_PRESENTATION` collapses to `{ title, openWorld }` with a
mandatory evidence citation per row.

Options A (derive all four from `mutating`) and B (declare on each of 23 `*McpTool` definitions) were
weighed in revision 1 and remain rejected — A because `openWorldHint` is not a function of `mutating`,
B because it re-types `readOnlyHint` in a different file from the `mutating` it must agree with and
touches 23 files under `src/commands/`, undoing a stated property of the v2 migration.

### 4.1 `reopen` — position taken: `NOT_READ_ONLY = ['reopen']` (Architect item 4, Critic #23)

`reopen` is `mutating: false` (`command-catalog.ts:296`) yet, **via MCP**, closes windows:

- `reopen.ts` MCP `inputSchema` declares `force: z.boolean().optional()` — *"Close each cmux workspace
  first, then reopen (disruptive)"*. Agent-reachable, not CLI-only.
- The output schema carries `cmuxClosed` — *"Titles of cmux workspaces closed first (force mode only)"*.
- Its description says *"Non-destructive **to git** — only cmux/editor view state is touched"* — an
  explicit admission that something *is* touched.

So `readOnlyHint: true` would be a hint the authors know to be false, in the direction P4 calls
dangerous (the spec default is `false`).

**I adopt S2 and reject Critic C9's preferred remedy (reclassify `mutating: true`).** Reason: the
catalog documents `mutating` narrowly — *"Whether running this command writes
git/remote/consumer-repo/Doppler-env/fs-outside-cache state"* — and `reopen` writes none of those.
`mutating: false` is **correct by the field's own definition**; C9's premise that it is "arguably
wrong" does not survive reading the doc comment. `readOnlyHint`'s spec meaning is broader ("does not
modify its environment"). Two predicates that genuinely differ need two expressions, not a redefinition
of the narrower one to serve the broader. Flipping `mutating` would make the field contradict its
documentation and would perturb gate policy (`LOW_RISK_MUTATING_ALLOWLIST`) to fix a display label.

**Why `NOT_READ_ONLY` is not the artifact `ADDITIVE_ONLY` was.** Both reviewers treat them as the same
class; they are not, and the distinction is the load-bearing one:

| | `ADDITIVE_ONLY` (deleted) | `NOT_READ_ONLY` (added) |
|---|---|---|
| Direction | moves a hint **away** from the conservative default | moves a hint **toward** it |
| Worst case of a wrong entry | a destructive tool advertises `destructiveHint: false` | a harmless tool advertises `readOnlyHint: false` |
| Failure mode | under-claim → host under-warns | over-claim → host over-warns |

An override that can only tighten is categorically safer than one that can only loosen. Its doc comment
states that constraint, and **T7** pins that every member is a real, exposed, `mutating: false` entry —
so it cannot hold stale names or silently grow into a loosening mechanism.

Consequence: `reopen` gets `readOnlyHint: false` and therefore `destructiveHint: true`. Given `force`
closes workspaces, that is defensible on its own terms rather than merely an over-claim.

Follow-up #2 from revision 1 (reclassify `reopen` in the catalog) is **deleted**, per Architect item 4.

### 4.2 `idempotentHint` — decision: **not shipped** (Critic C3 / item 16, weighed against P4)

The Critic's ground is stronger than "the judgements are contestable": `idempotentHint` is the one hint
whose affordance is **retry**. Over-claiming it does not make a host warn more — it licenses a host to
re-issue a write the user did not ask for. Revision 1 declared it `true` on five tools, three of which
write to GitHub/Jira. P4 gives no cover, because P4's premise ("over-claiming is merely noisy") is true
for `destructiveHint` and `openWorldHint` and **false** for this one.

So no tool may claim `true`. That leaves "ship `false` everywhere" versus "omit". **I add the argument
that settles it, which neither review states:**

> Given no tool claims `true`, an explicit `idempotentHint: false` is indistinguishable from omission
> under *both* host-reading conventions — `annotations?.idempotentHint === true` yields `false` either
> way, and `annotations?.idempotentHint ?? false` (the spec default) yields `false` either way. It
> changes no host behaviour, and costs a field and a maintenance surface.

This is precisely the asymmetry with `destructiveHint`, where explicit `true` versus omitted **is** the
difference (§3.1) — and that difference is the ticket. Ship one, drop the other, for the same reason.

If `idempotentHint` returns later it needs a per-tool argument that *retrying is safe*, not that the
tool converges.

Architect item 13 (add an `env-clear` idempotency clause — its second call errors,
`env-clear.ts:127`) is thereby **moot** and dropped: no idempotency claim is made about any tool.

### 4.3 `openWorldHint` — declared with mandatory evidence; **no static check** (Critic #17)

Architect S3 proposed asserting that every `openWorld: false` tool's module imports no
`src/integrations/{gh,jira,doppler,aws}`. **Rejected.** The Critic found two false positives
(`env-list.ts:4` imports the pure config reader `getDopplerProject`; `worktrees-remove.ts:3` imports
`getReleasePRsWithInfo` on a path MCP cannot reach), each of which would force an exception list — the
override the whole exercise exists to delete.

Critic C4(a) proposed inverting it: *derive* `openWorldHint` from the import graph and collapse the
table to `{ title }`. **Also rejected, on evidence neither review had.** The four CI-deploy and
local-deploy tools shell out through `zx` and import **zero** `src/integrations/*` modules:

```
src/commands/gh-release-deploy-all/gh-release-deploy-all.ts:2   import { $ } from 'zx'
   → imports from src/lib/* only; dispatches the workflow via the `gh` CLI
src/commands/local-deploy/local-deploy.ts                       → src/lib/* only; runs devops/scripts/deploy-*.sh
src/commands/release-create/release-create.ts:7                 → only src/integrations/jira
```

An import-graph derivation would therefore stamp `openWorldHint: false` on
`gh-release-deploy-all`, `gh-release-deploy-selected`, `local-deploy-all` and `local-deploy-selected` —
**a false negative on the four most dangerous tools in the catalog**, exactly inverting the hint's
purpose. C4(a) is not merely noisy; it is wrong in the dangerous direction. The stated residual risk
("it depends on the convention that network calls live under `src/integrations`") is not a residual
risk here — the convention is **already broken by those four tools**, each of which reaches the network
through `zx` with no `src/integrations/*` import at all.

**Adopted: C4(b).** `openWorld` is declared in `MCP_TOOL_PRESENTATION`, and **every row carries a
`file:line` citation naming the call site** (§5). Reviewed with the same discipline as
`LOW_RISK_MUTATING_ALLOWLIST`.

**Stated plainly, per Critic C5/C6: no CI test can catch a wrong `openWorldHint`. Its correctness rests
on the cited evidence, on review, and on the real-host step (§8.3) — not on the test suite.** The
citation requirement is the control, and it is the one that would have caught E1: revision 1's row read
*"reads the local token store; never calls Doppler"* with no line reference, and no one can write that
sentence next to `env-token-list.ts:115-131`.

---

## 5. Per-tool table (23 tools)

`destructiveHint` is `true` for every `readOnlyHint: false` row and omitted for every
`readOnlyHint: true` row — a consequence of §4, not per-tool data, so it is not a column.
`idempotentHint` is not shipped.

### Read-only (10) — `readOnlyHint: true`, `destructiveHint` omitted

| tool | title | openWorld | evidence |
|---|---|---|---|
| `dev-status` | Dev server status | `false` | `dev-status.ts:178` — reads on-disk dev-context fragments; the TCP liveness probe is loopback-only |
| `gh-release-list` | Open releases | **`true`** | `gh-release-list.ts:13` `await getReleasePRsWithInfo()`; `getJiraDescriptions` imported `:6` |
| `worktrees-list` | Release worktrees | **`true`** | `worktrees-list.ts:38` `Promise.all([getReleasePRsWithInfo(), getJiraDescriptions()])` |
| `env-status` | Loaded environment | `false` | `env-status.ts:94` — *"Pure local introspection — makes NO Doppler call"* |
| `env-list` | Available environments | `false` | `env-list.ts:147` — *"never a live Doppler probe"*. The `src/integrations/doppler` import at `:4` is `getDopplerProject`, which reads `getInfraKitConfig()` and returns a name (`doppler-project.ts:23-27`) — no network |
| `env-token-list` | Doppler service tokens | **`true`** | `env-token-list.ts:115-131` `probeEnvToken` per environment; `check` is in the **MCP inputSchema** (`:173-176`), so this is agent-reachable — corrects revision 1 (Architect E1) |
| `config-get` | Merged infra-kit config | `false` | `config-get.ts:58` — *"Read-only introspection … use `config edit` (CLI-only) to modify"* |
| `vendor-check` | Vendor checksum check | `false` | `vendor-check.ts:120` — *"Self-contained (no source repo or config needed)"* |
| `audit` | Package audit | `false` | `audit.ts:242-255` — reads workspace manifests; `--fix`/`--design` unreachable through the MCP schema |
| `version` | CLI version | `false` | `version.ts` — reads `packageJson.version`; no registry check |

### Mutating + gated (8) — `readOnlyHint: false`, `destructiveHint: true`, `requiresHumanConfirm: true`

| tool | title | openWorld | evidence |
|---|---|---|---|
| `gh-merge-dev` | Merge dev into release branches | **`true`** | `gh-merge-dev.ts:355` `getReleasePRsWithInfo()`; pushes to remote release branches |
| `release-create` | Create releases | **`true`** | `release-create.ts:7` `loadJiraConfig` from `src/integrations/jira`; creates branches and PRs |
| `gh-release-deploy-all` | Deploy all services (CI) | **`true`** | `gh-release-deploy-all.ts:2` `import { $ } from 'zx'` — dispatches `deploy-all.yml` via the `gh` CLI. **Imports no `src/integrations/*`**, which is why §4.3 rejects an import-graph derivation |
| `gh-release-deploy-selected` | Deploy selected services (CI) | **`true`** | same shape — `deploy-selected-services.yml` via `zx`/`gh` |
| `local-deploy-all` | Deploy all services from this machine | **`true`** | `local-deploy.ts` — runs `devops/scripts/deploy-*.sh` against AWS via `zx`; no `src/integrations/*` import |
| `local-deploy-selected` | Deploy selected services from this machine | **`true`** | same |
| `worktrees-remove` | Remove release worktrees | `false` | The only network path is `worktrees-remove.ts:130` (`getJiraDescriptions` + `getReleasePRsWithInfo`) inside the picker `else` branch at `:129-141`. That branch is **unreachable via MCP twice over**: (a) the inputSchema declares `versions` as **required** and omits `all` entirely; (b) `assertMcpRemovalInput` (`worktrees-remove.ts:39-57`, called at `:97`) throws under `isMcpMode()` on `all` and on missing `versions`. The runtime guard is the self-evident one — reading (a) alone requires reasoning about `z.object` stripping. (Critic C8; corrects Architect E3's *"nothing enforces"*) |
| `env-clear` | Clear environment variables | `false` | Emits `unset` statements into a local shell script and returns its path; its whole output surface (`filePath`, `unsetStatements`, `variableCount`, `purged`) is local-file shaped, with no remote to contact |

### Mutating + ungated (4) — `LOW_RISK_MUTATING_ALLOWLIST` members; `readOnlyHint: false`, `destructiveHint: true`

Allowlist membership is a **gate** decision (is a confirm prompt warranted?) and is deliberately
independent of `destructiveHint` (does this tool perform destructive updates?). All four read
destructive:

| tool | title | openWorld | evidence + why destructive |
|---|---|---|---|
| `release-desc-edit` | Edit release description | **`true`** | `release-desc-edit.ts:180` `updateJiraVersion({ versionId, description })`, `:185` `updateReleasePRBody`. Overwrites existing text in two systems |
| `worktrees-add` | Add release worktrees | **`true`** | `worktrees-add.ts:82` `getReleasePRsWithInfo()`; `:301` `` $({cwd})`pnpm install` ``. **Additive in fact** (existing worktrees are skipped, not errored) — reads destructive under the uniform derivation. A single-tool over-claim, which is what P4 endorses; see §9 R2 |
| `worktrees-sync` | Prune stale worktrees | **`true`** | `worktrees-sync.ts:45` `getReleasePRs()`. *"Only removes — never creates"* |
| `env-load` | Load environment variables | **`true`** | `env-load.ts:17` imports `src/integrations/doppler` and downloads secrets. **Destructive**: `:192` *"atomically write env-load.sh"* into `getSessionCacheDir()` (`:212`) — a path deterministic per terminal session, so loading `dev` after `prod` **overwrites**. Revision 1's *"writes a new script"* was factually wrong (Architect E2) |

### Not-read-only exception (1) — §4.1

| tool | title | readOnly | destructive | openWorld | evidence |
|---|---|---|---|---|---|
| `reopen` | Reopen project windows | **`false`** | `true` | `false` | **Not read-only:** `force` is in the MCP inputSchema — *"Close each cmux workspace first, then reopen (disruptive)"* — and `cmuxClosed` is in the output schema, so an agent can close workspaces. Its own description's *"Non-destructive **to git**"* is the admission that something else is touched. **Closed-world:** it spawns local editor and cmux processes on this machine; every output field (`worktreePaths`, `ideProviders`, `cmuxOpened/Skipped/Closed`) describes local window state, and it contacts no remote |

**Totals:** 23 tools = 10 read-only + 8 gated + 4 ungated-mutating + 1 exception.
`readOnlyHint: true` ×10 · `readOnlyHint: false` + `destructiveHint: true` ×13 · `openWorldHint: true`
×13 · `openWorldHint: false` ×10.

### Title style

Sentence-case display strings; never a restatement of `name`, never an `infra-kit` prefix (the server
carries that). The four deploy rows are disambiguated in the title itself, because in a host's tool
picker they are otherwise indistinguishable. Per Critic #24: set **top-level `title` only** — leave
`annotations.title` unset, since some hosts prefer the latter when present and two titles is a
divergence waiting to happen. T1 asserts it.

---

## 6. Decision on `icons` — **OUT OF SCOPE**

- `IconSchema.src` is a bare string, so there is no type-level blocker.
- **No asset pipeline exists.** `scripts/build.js:36-70` sets `bundle`, `platform`, `format`,
  `splitting`, `jsx`, `external` — no `loader` map, no `assetNames`, no `publicPath`. Icons would ship
  as inlined `data:` URIs.
- `mcp.js` is an **eager** entry loaded on every invocation; the repo has an explicit
  "no React on machine paths" bundle-weight discipline that inlined base64 cuts against.
- Hosting instead means a URL infra-kit does not own plus a network fetch for a CLI tool.
- Neither measured host (Claude Code 2.1.261, MCP Inspector 2.5.0, 2026-09-05) was observed rendering
  tool icons.

Ship `title` + `annotations`; revisit `icons` only against a host measured rendering them, and then as
one server-level icon rather than 23. **Per Critic C7, the same evidence standard is now applied to
`annotations` themselves** — §8.3 puts them through the identical rig, and records a null result as a
legitimate outcome.

---

## 7. Files touched

### 7.1 `src/mcp/__tests__/mcp-stdio.e2e.test.ts` — the load-bearing change

Without this, `w1c` and `w1e` fail on all 20 comparable tools: `assertToolsMatchBaseline` ends in
`expect(normalized).toEqual(beforeRest)` (`:1448`) against a fixture whose tools carry neither key, and
`toEqual` is exact on extra keys.

Follow the existing **D9** precedent verbatim (`:843-880`, `:1241`), which the file's own comment at
`:843-848` justifies — *"so the strip can never be what makes w1c pass"*. Add **D10 (`title`)** and
**D11 (`annotations`)**:

1. Assert positively on the served side, inside `assertToolsMatchBaseline`, before any strip:
   - every served tool carries a non-empty `title` and an `annotations` object;
   - the `readOnlyHint === true` carrier set equals the catalog-computed read-only set;
   - the `destructiveHint === true` carrier set equals the catalog-computed complement;
   - `annotations.title` is unset on every tool (Critic #24).
   All sets computed from `getExposedMcpTools()`, never literals — the `gatedToolNames` discipline at
   `:849`.
2. Assert **negatively on the baseline**: `v1Tools.tools` carries neither key on any tool (the
   `w1c-pre-d9` analogue), so the strip decays loudly if the fixture is ever re-captured.
3. Only then strip both keys from the served deep copy. Extend `withoutD9` into one shared
   `withoutAuthoredDeltas` so `w1c` and `w1e` cannot diverge.
4. **Do not re-capture `tools-list-baseline.v1.json`** — its comments at `:820-829`, `:991` give three
   still-valid reasons, and with D4 and D9 already in place a third and fourth authored delta is a
   precedent being followed, not an improvisation.
5. **Add D9, D10 and D11 to the delta legend at `:790-797`** — it currently lists D1–D8 and is already
   missing D9 (Architect item 11).

**Stated plainly (Architect §6 caveat / item 11): after D10/D11 land, `w1c` and `w1e` compare nothing
about annotation content.** The whole-object property that makes the fixture load-bearing does not
extend to this change. **T6 becomes the sole e2e guard**, and T6 proves transport fidelity — that what
the catalog derived is what crossed the process boundary — **not semantic correctness**, since both
sides derive from the same catalog (Critic C5).

`w1d` (`resources/list` byte-identical) is unaffected.

### 7.2 `src/lib/command-catalog/command-catalog.ts`

```ts
/** Structural mirror of the SDK's ToolAnnotations — not imported, so the catalog stays SDK-free. */
export interface McpToolAnnotations {
  readOnlyHint: boolean
  destructiveHint?: boolean          // omitted when readOnlyHint is true (spec: meaningless there)
  openWorldHint: boolean
}

export interface RegistrableMcpTool extends CatalogMcpTool {
  title: string
  annotations: McpToolAnnotations
}

/**
 * Display title + the one hint nothing derives. `openWorld` is true iff the tool reaches a network
 * peer on an MCP-reachable path; every entry cites its call site. Advisory hints — the authority for
 * destructive operations is `mcpTool.requiresHumanConfirm` and `lib/tool-handler`.
 */
const MCP_TOOL_PRESENTATION: Record<string, { title: string; openWorld: boolean }> = { /* §5 */ }

/**
 * Tools that modify machine state `mutating` deliberately excludes (it covers only
 * git/remote/consumer-repo/Doppler-env/fs-outside-cache). May ONLY ever tighten a hint toward the
 * spec default of `readOnlyHint: false` — never loosen one. Pinned by T7.
 */
const NOT_READ_ONLY: readonly string[] = ['reopen']   // `force` closes cmux workspaces (MCP-reachable)
```

`getExposedMcpTools()` returns `RegistrableMcpTool[]`, assembling per entry:

```ts
const readOnlyHint = !entry.mutating && !NOT_READ_ONLY.includes(name)
annotations = { readOnlyHint, openWorldHint, ...(readOnlyHint ? {} : { destructiveHint: true }) }
```

Notes required in the file:

- **Spread copies (Architect item 9):** the returned objects are `{ ...entry.mcpTool, title, annotations }`,
  so they are *not* the catalog's `mcpTool` object identities. `handler` survives as a reference, so
  dispatch is unaffected; nothing today compares identities (`mcp-stdio.e2e.test.ts:849` reads `.name`
  and `.requiresHumanConfirm`; the catalog tests walk `commandCatalog` directly). Documented so nobody
  later writes an identity comparison.
- **Missing-entry failure scoped inside `getExposedMcpTools()` (Architect item 10 / C4):** *not* at
  module scope. `command-catalog.ts` is imported by every command path, so a module-scope throw on a
  table typo would take down **every CLI command**, not just MCP registration. T1/T3 already fail in CI.
- Keep `MCP_TOOL_PRESENTATION` adjacent to `LOW_RISK_MUTATING_ALLOWLIST`, with a line stating that
  allowlist membership and `destructiveHint` are independent — all four allowlisted tools are
  destructive.

**Free adjacent fix (Architect item 14):** `command-catalog.ts:515` justifies `release-desc-edit` as
*"Edits a GitHub release body only"*. It also overwrites the Jira fix-version description
(`release-desc-edit.ts:180`). Correct the comment while the file is open.

### 7.3 `src/lib/command-catalog/index.ts` — **deleted from the plan** (Architect item 8)

`CatalogMcpTool` is not re-exported today and `src/mcp/tools/index.ts:4` imports only the
`getExposedMcpTools` *value*, inferring the element type. `RegistrableMcpTool` and `McpToolAnnotations`
would be exported to nobody. Export them only if a consumer appears; none does in this change.

### 7.4 `src/mcp/tools/index.ts` — re-rendered against the real file (Architect item 7)

Two keys added to the config object literal. `withConfirmToken` operates on `tool.inputSchema` only and
`wrapForRegistration` is the third positional argument — neither interacts with the added keys:

```diff
     server.registerTool(
       tool.name,
       {
+        // Display label; hosts fall back to `name`. Top-level `title` only — `annotations.title` is
+        // deliberately left unset (two titles diverge).
+        title: tool.title,
         description: tool.description,
         inputSchema: z.object(
           tool.requiresHumanConfirm === true ? withConfirmToken(tool.inputSchema) : tool.inputSchema,
         ),
         outputSchema: z.object(tool.outputSchema),
+        // ADVISORY protocol hints, derived in the catalog. The authority for destructive operations
+        // remains `requiresHumanConfirm` + `lib/tool-handler`; nothing in the gate reads these.
+        annotations: tool.annotations,
       },
       wrapForRegistration(
         createToolHandler({
           toolName: tool.name,
           handler: tool.handler,
           requiresHumanConfirm: tool.requiresHumanConfirm,
         }),
       ),
     )
```

`RegistrableMcpTool extends CatalogMcpTool`, so `requiresHumanConfirm` still reaches both `:34` and
`:44`. This is not "the only registration change" — it is the only *source* change outside the catalog.

### 7.5 `src/lib/command-catalog/__tests__/command-catalog.test.ts`

T1–T5, T7 (§8). The existing snapshot records `{name, input[], output[]}` and needs no update.

**Not touched:** anything under `src/commands/`; `src/lib/tool-handler/`; `src/mcp/resources/`;
`fixtures/tools-list-baseline.v1.json`; `package.json`; `scripts/build.js`.

---

## 8. Test plan

### 8.1 Existing tests

| Test | Risk | Resolution |
|---|---|---|
| `w1c` / `w1e` | **Will fail — certain** | §7.1 D10/D11 via the D9 pattern; fixture untouched |
| `e1` / `e1m` | Safe — name sets only (`:236-255`) | re-run |
| catalog `__snapshots__` | Safe — `{name, input[], output[]}` | re-run |
| default-deny invariant (`:233`) | Safe — reads fields this change does not modify | T5 pins it still passes |
| `u6`/`u7` bundle guards | Safe — no new imports; structural mirror keeps the catalog SDK-free | re-run |
| `server.test.ts`, `mcp-confirm-gate-mutation.test.ts` | Safe — no registration-config references | re-run |

### 8.2 New criteria, labelled by what each can and cannot detect (Critic #20)

| # | Assertion | Class | Catches | Cannot catch |
|---|---|---|---|---|
| **T1** | Every exposed tool has a non-empty `title !== name`, an `annotations` object with boolean `readOnlyHint`/`openWorldHint`, and **no `annotations.title`** | **real content** | a missing table entry; an implementer setting `annotations.title` (Critic #24) | a *wrong* title or hint value |
| **T2** | `readOnlyHint === (!entry.mutating && !NOT_READ_ONLY.includes(name))` | **refactor detector** — asserts the formula that produced the value | the derivation being replaced by hand-typed literals | anything about correctness |
| **T3** | `MCP_TOOL_PRESENTATION` key set equals the exposed tool-name set, both directions | **real content** — strongest unit test of the set | a renamed/unexposed tool leaving a stale row; a new tool with no row | a wrong `openWorld` value |
| **T4** | Read-only tools carry no `destructiveHint`; every `readOnlyHint: false` tool carries `destructiveHint: true`; **no tool carries `idempotentHint`** | **real content** for the omission halves; the destructive half is a theorem given §4 | a meaningless hint leaking onto a read-only tool; `idempotentHint` being reintroduced without the §4.2 argument | — |
| **T5** | Every `requiresHumanConfirm: true` tool has `destructiveHint: true`, **and** the converse does not hold (`release-desc-edit`, `worktrees-sync` are destructive yet ungated) | **real content** — crosses to independently-authored per-command data | a `requiresHumanConfirm` set on a `mutating: false` tool (the two artifacts would disagree); a future reader collapsing the two sets | — |
| **T6** | e2e: served `readOnlyHint`/`destructiveHint` carrier sets equal the catalog-computed sets, in **both** lanes, before the D10/D11 strip | **real content** — crosses a process boundary | serialization/registration dropping or mangling a hint | **semantic correctness — both sides derive from the same catalog** |
| **T7** | Every `NOT_READ_ONLY` member is a real, exposed, `mutating: false` catalog entry | **real content** | a stale name; the array being used to loosen rather than tighten | — |

**Coverage per shipped hint, stated honestly:**

- `title` — T1 (presence, shape), T3 (hygiene), **V1** (renders on a real host).
- `readOnlyHint` — T2 (detector) plus **T5**, which is genuinely independent: `requiresHumanConfirm` is
  authored per-command under `src/commands/`, `readOnlyHint` is derived from catalog `mutating`, so a
  disagreement fires.
- `destructiveHint` — T4 + T5, same independence.
- `openWorldHint` — **no mechanical guard exists, and none is proposed.** §4.3 records why both
  candidate checks are unsound (S3 has false positives; C4(a) has false negatives on the six deploy
  tools). Its controls are the mandatory `file:line` citation, review, and V1/V2.

Revision 1's criteria could not have failed on E1, E2 or E3 (Critic C5). T3 + the citation requirement
now catch a missing or stale row; the citation requirement is what makes E1's rationale unwritable.
E2 and the `worktrees-add` question are resolved structurally — `ADDITIVE_ONLY` no longer exists.

### 8.3 Real-host verification (Critic C7 / #19) — required before "done"

§6 cuts `icons` for "zero measured host benefit". The same rig, applied to this change's own
deliverable:

- **V1 — MCP Inspector 2.5.0:** connect to the built `dist/mcp.js`, call `tools/list`, confirm (a)
  `title` renders as the display label rather than `name`, and (b) `annotations` is present on the tool
  detail view for a read tool and a write tool.
- **V2 — Claude Code 2.1.261:** a yes/no observation, so two people running it cannot disagree.
  Invoke `version` (`readOnlyHint: true`) and record: **does a permission prompt appear — yes or no?**
  Then invoke `env-clear` (`readOnlyHint: false`, `destructiveHint: true`) and record the same, plus
  whether the prompt's wording or options differ from `version`'s. The result is one of: *no prompt for
  `version`, prompt for `env-clear`* (the hint is being read); *both prompt identically* (it is not);
  *neither prompts* (auto-approve is on and the hint is not gating it).
- **V3 — Record the outcome in §6's table format, including a null result.** *"Measured; no host
  affordance observed"* is a legitimate outcome that still ships the change — the protocol field is the
  deliverable — but it must be on the record so the next `icons`-style decision is judged consistently.

The `tools/list` capture alone is **server-side** and cannot fail independently of T6; V1–V3 are what
make the evidence standard symmetric.

### 8.4 Commands

```
pnpm run ts-check && pnpm run eslint-check && pnpm run test    # apps/infra-kit/cli
pnpm run qa                                                     # repo root — the gate
```

`lock.test` and `portless-driver.test` flake under full-suite load; re-run a suspect file alone before
calling it a regression.

**Done means:** all 59 pre-existing MCP e2e tests green (including `w1c`/`w1e` with D10/D11); T1–T7
green; root `pnpm run qa` green; V1–V3 performed and recorded.

---

### 8.5 Measured outcome (V1 — recorded per V3)

Captured 2026-09-05 by driving the BUILT `dist/mcp.js` over raw stdio JSON-RPC (no SDK client, so what
is recorded is literally what crossed the wire). Negotiated `2025-11-25`, as the Phase 6 matrix
predicts.

| Observation | Result |
|---|---|
| tools served | 23 |
| carrying `title` | 23 |
| carrying `annotations` | 23 |
| `annotations.title` set | **0** |
| `readOnlyHint: true` | 10 |
| `destructiveHint: true` | 13 |
| `openWorldHint: true` | 13 |
| `idempotentHint` present | **0** |

Spot checks: `version` `{readOnlyHint: true, openWorldHint: false}` · `env-clear`
`{readOnlyHint: false, destructiveHint: true, openWorldHint: false}` · `reopen`
`{readOnlyHint: false, destructiveHint: true, openWorldHint: false}` (the §4.1 exception, live) ·
`env-token-list` `{readOnlyHint: true, openWorldHint: true}` (E1's correction, live).

**V2 is NOT yet performed** and is owed. It cannot be self-served from an agent session: it requires a
human to invoke `version` and then `env-clear` in Claude Code and record whether a permission prompt
appears for each, and whether the two prompts differ. Until it is run, the honest status of this
change is *"the protocol field is on the wire; no host has been observed reading it."* Per V3 that is a
legitimate outcome that still ships — but it must not be recorded as a positive host result.

---

## 9. Risks and mitigations (rewritten as actions — Critic #21)

**R1 — `w1c`/`w1e` fail and the "fix" is to loosen the comparison.**
The tempting repair is stripping unknown keys before comparing — a normalization broad enough to
swallow a delta nobody noticed, the exact hole the file warns about at `:1240`.
*Action:* named per-key strips (D10, D11) with a positive assertion first and a negative assertion on
the baseline. Never a generic unknown-key filter. Reviewer instruction: reject any diff that adds one.

**R2 — a host auto-approves on a hint.**
*Concrete instances, not principles:* (a) `worktrees-add` reads `destructiveHint: true` while being
additive in fact — a host over-warns on a safe tool, accepted as P4's endorsed direction of error;
(b) `reopen` reads `readOnlyHint: false` and would previously have read `true` while closing cmux
workspaces — §4.1 fixes exactly that.
*Action:* the gate is untouched, so the worst outcome of any wrong hint is a warning, never an
execution. T5 pins that every gated tool is also labelled destructive.

**R3 — a wrong `openWorldHint` ships and nothing catches it.**
This is the change's one genuinely uncovered surface, and revision 1's mitigation ("each row carries
its justification") is the control that already failed: E1's row carried a justification and was wrong.
*Action:* the justification is no longer free prose — every row cites a `file:line` (§5), which is
reviewable against the source in one step, and V1/V2 exercise the values on a real host. §8.2 states
that CI cannot catch this. Accepted residual risk, on the record.

**R4 — table drift as tools are added.**
*Action:* T1 and T3 fail in CI on a missing or stale row; the scoped throw inside
`getExposedMcpTools()` fails the MCP server (only) at runtime. A new exposed tool cannot register
without a decided title and `openWorld` value.

**R5 — the derivation's loosening surface is `entry.mutating` itself.**
`NOT_READ_ONLY` can only tighten (§4.1), so it is not the exposure. The exposure is the input: a
catalog entry wrongly marked `mutating: false` now does **two** things at once — it sets
`readOnlyHint: true` *and* suppresses `destructiveHint` entirely — and nothing fires. The existing
default-deny test keys off `entry.mutating === true`, so a mutating tool mis-typed as `mutating: false`
is invisible to it; and **T5 covers the gated eight only**, not all thirteen, so an ungated tool with a
wrong `mutating: false` is unguarded end to end.
**This hole is pre-existing** — a wrong `mutating` already defeats the confirm gate today. What this
change does is *amplify its consequence*: the same single wrong boolean now also mislabels the tool on
the wire, in the loosening direction, to every host.
*Action:* no new mechanism is proposed here (correcting `mutating` classification is out of scope), but
the amplification is recorded so a future `mutating` edit is understood to be a protocol-visible change,
not only a gate-policy one. T7 additionally pins every `NOT_READ_ONLY` member to a real, exposed,
`mutating: false` entry; any future member that loosens a hint is a review rejection.

**R6 — bundle / dependency drift.**
*Action:* the catalog uses a structural mirror of `ToolAnnotations` rather than importing the SDK type,
so `u6`/`u7` are untouched and `command-catalog.ts` stays SDK-import-free.

**Deleted from revision 1:** R3's argument-binding claim. `src/lib/tool-handler/confirm-token.ts`
implements exactly the binding it said was absent (HMAC over canonical args via
`createRequestStateCodec`, bound to tool name, 600 s TTL). Its *substance* — annotations are advisory
and mitigate nothing about the gate — is folded into **P1**, per Architect item 1.

---

## 10. ADR

**Title:** Derive every MCP tool safety hint from the catalog; declare only titles and `openWorldHint`.

**Status:** pending approval.

**Decision.** Register `title` and `annotations` on all 23 exposed MCP tools.
`readOnlyHint = !mutating && !NOT_READ_ONLY(name)`; `destructiveHint = readOnlyHint ? undefined : true`
— emitted explicitly on all 13 non-read-only tools, with no opt-out array. `openWorldHint` is declared
in `MCP_TOOL_PRESENTATION` with a mandatory `file:line` citation per row and **no** static check.
`idempotentHint` is not shipped. `icons` is out of scope. The confirm gate is untouched.

**Drivers.** (1) The wire bytes describing destructiveness must actually change. (2)
`getExposedMcpTools()` discards `entry.mutating`. (3) The `w1c`/`w1e` differential compares against a
frozen fixture, making two new served keys a guaranteed failure.

**Alternatives considered.**

- **Architect S1 — omit `destructiveHint`, rely on the spec default of `true`.** *Proposed, tested
  against the SDK source, invalidated on evidence.* `dist/src-CX2iR2pK.mjs:1138-1144` and `:2698-2704`
  declare it `.optional()` with **no `.default()`**, and `grep -rn '\.destructiveHint'` over the SDK
  dist returns zero non-schema hits — nothing materializes the default. Under S1 the destructiveness
  bytes on the wire would be identical before and after, i.e. the ticket's opening state. S1 is also
  internally inconsistent, keeping `openWorldHint: true` explicit where `true` is likewise the default.
  **This exchange is the strongest part of the audit trail: the omission cannot be re-proposed without
  first refuting the grep.**
- **Option A — derive all four hints from `mutating`.** Invalidated: `openWorldHint` is not a function
  of `mutating`.
- **Option B — declare hints on each of 23 `*McpTool` definitions.** Viable, rejected: touches 23 files
  under `src/commands/` (undoing a stated v2-migration property) and re-types `readOnlyHint` in a
  different file from the `mutating` it must match.
- **`ADDITIVE_ONLY` (revision 1).** Deleted: the sole under-claim in the plan, contradicting its own P4,
  and a hand-typed per-tool safety override that could only loosen.
- **Architect S3 — static import check on `openWorld: false` tools.** Rejected: two false positives
  (`env-list`, `worktrees-remove`) force an exception list.
- **Critic C4(a) — derive `openWorldHint` from the import graph.** Rejected on evidence neither review
  had: `gh-release-deploy-all`, `gh-release-deploy-selected`, `local-deploy-all` and
  `local-deploy-selected` shell out via `zx` and import **zero** `src/integrations/*` modules, so the
  derivation would stamp `openWorldHint: false` on the four most dangerous tools in the catalog —
  wrong in the dangerous direction.
- **Critic C9 — reclassify `reopen` as `mutating: true`.** Rejected: `mutating` is documented narrowly
  (git/remote/consumer-repo/Doppler-env/fs-outside-cache) and `reopen` writes none of those, so
  `mutating: false` is correct by the field's own definition. Flipping it would make the field
  contradict its documentation and perturb gate policy to fix a display label.
- **Re-capturing the e2e baseline fixture.** Rejected — it is evidence captured before any dependency
  change; D4 and D9 established the authored-delta pattern instead.
- **Shipping `icons`.** Rejected — no asset loader, `mcp.js` is an eager bundle, no host measured
  rendering them.

**Why chosen.** It makes the wire visibly carry destructiveness (the literal ask), while leaving
**zero hand-typed values in the two derived hints** — `readOnlyHint` and `destructiveHint` admit no
per-tool literal, and their one override (`NOT_READ_ONLY`) can only tighten. That guarantee does **not**
extend to `openWorldHint`, which is declared, hand-typed `false` on ten rows in the loosening direction,
and guarded by citation and review rather than by construction (§2.1, §4.3, §8.2, R3).
`readOnlyHint` cannot disagree with `mutating` by construction, and
the one place the two predicates genuinely diverge (`reopen`) is expressed as a tighten-only exception
pinned by a test rather than by redefining the catalog's gate field.

**Consequences.**
- Hosts can distinguish reads from writes at the protocol level; 13 tools now carry an explicit
  `destructiveHint: true`.
- `worktrees-add` is the one genuine destructiveness over-claim — accepted; P4's endorsed direction.
  `env-load` and `reopen` are destructive in fact (a deterministic per-session overwrite,
  `env-load.ts:192,212`; `force` closing cmux workspaces), so their `true` is earned, not conceded.
- `idempotentHint` is absent, so no host is ever licensed to retry an infra-kit tool.
- `openWorldHint` correctness rests on cited evidence and review, not CI — stated in §8.2, not implied.
- The e2e differential gains D10/D11 and **stops covering annotation content**; T6 is the sole e2e
  guard, and it proves transport fidelity rather than semantic correctness.
- `destructiveHint` and `requiresHumanConfirm` are deliberately different sets; T5 pins the divergence.

**Follow-ups (not this ticket).**
1. Revisit `icons` only if a host is measured rendering them; prefer one server-level icon.
2. Consider `_meta` for infra-kit-specific hints (e.g. surfacing gate status) once a host consumes it.
3. If V2 shows a host acting on `idempotentHint`, revisit §4.2 — but only with a per-tool argument that
   *retrying is safe*, never that the tool converges.

*(Revision 1's follow-up "bind arguments in the confirm gate" is deleted — already implemented in
`src/lib/tool-handler/confirm-token.ts`. Revision 1's follow-up "reclassify `reopen`" is deleted —
resolved in §4.1.)*
