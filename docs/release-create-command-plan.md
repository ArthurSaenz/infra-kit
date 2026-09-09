# `/infra-kit:release-create` — the first plugin command, and the form that feeds it

**Status: `pending approval`** · Mode: RALPLAN deliberate · Drafted 2026-09-09

**This document is an increment on `docs/infra-kit-slash-commands-plan.md`, not a replacement.** That
plan's §0.11 (M0–M6), §0.12, §0.13, §4.2–4.4, §6.12 and §8 are load-bearing here and are cited rather
than restated. Every departure from it is marked **DEPARTURE** with its evidence.

All file:line citations are against `main` @ `200be11`. The CLI package root is
`apps/infra-kit/cli/` — abbreviated `«cli»` below; there is no `src/` at the repo root.

### Round-1 review disposition

Accepted and applied: **B1** (§2.3a — the batch predicate, with the reviewer's correct rejection of the
insufficient `hasNextToken`-only form), **B2** (§2.3 — candidate resolution replaces the impossible
decision table; complexity re-derived), **B3** (§2.2, §2.4, §2.5 — both `inputResponse` _and_
`acceptedContent`, schema returned as zod, `toArgs` contract), **B4** (§2.6 — argsSchema omitted,
asymmetry recorded; §3.4 I5/I6), **B5** (§3.5 — the e2e helper must answer `elicitation/create`, not
merely declare it), **S3** (§4 PM-C — version floor + CI check replace a prose rule), **PM-D** (§4),
the **D2** rewording and the §1.3 re-derivation, **M-1**, **M-3**, **M-4**, **M-5**.

**One finding rejected, with evidence — M-2.** The review states that `manifest.test.mjs:460` is the
`entry` lookup and that the no-version assertion is at `:464`. Read against the file: `:454`
`test('U8: …`, `:455` `assert.match(readPluginJson().version, …)`, `:456` `const marketplace = …`,
`:457` `assert.ok(existsSync(marketplace) …)`, `:458` `const entry = …` ← _the lookup_, `:459`
`assert.ok(entry, …)`, **`:460` `assert.ok(!('version' in entry), 'the marketplace entry must not pin a
version')`** ← _the assertion_. The test body ends at `:461`; `:464` is inside the `U12` comment banner
and contains no assertion. **The original citation was correct and is retained**; the surrounding
sentence now also names the enclosing test (`:454`) so the reference is unambiguous.

**One citation silently corrected in the review's own text.** P5 is at
`infra-kit-slash-commands-plan.md:317-318`, not `:319` (`:319` is the _"Retained deliberately"_
paragraph). §0 cites `:317-318`. P4 at `:313` was correct.

**Round-1 addendum (Critic, ITERATE).** **B1a** — the array-length predicate did not close the
_field-level_ hole; §2.5's `toArgs` constructed a fresh entry, silently converting a hotfix to a
regular release. Fixed by a merge, and by **removing every `default` from the form schema** — see
§2.5a, which explains why the merge alone is insufficient. **M-5 completed** — the precedence rule is
now stated, not inferable (§2.7a). **Criterion 2** — §1.3 now carries the capability declaration as a
named open risk on Option 1, gating PR C, with the measurement result recorded. **Criterion 4** — F6
now asserts bounded elapsed time rather than reddening by hanging; U14's slack is removed at the
assertion level. B4's coverage gap was closed in this same round by I5/I6.

**Round-2 disposition (Architect, ITERATE).** Adopted: the **chokepoint non-narrowing check**
(§2.3b) — which _supersedes_, not supplements, the earlier framing that a per-provider AC table is the
only control on B1; the **`readAcceptedArgs` wrap plus a synchronous-validation contract** (§2.3, §2.4)
closing the async-`TypeError` hazard the B3 fix reopened; the **execution-model correction** in §2.5
(`params` is already parsed _and_ transformed) and the two vacuous V6 rows it exposed; the **filtered
merge**, framed as totality rather than as a threat control (§2.5a); the JSON round-trip in F11/V8; and
the four citation fixes. Added on the Architect's truncated item 4: the human is now **told** when their
selection was dropped (§2.3, F9), not merely logged at. Its item 5 is recorded as _nothing reported_.

**Round-2 addendum.** The discard notice now has an exact shape — message clause **plus**
`formDiscarded: true` **plus** an AC on both (§2.3, F9) — because a validation failure otherwise presents
the _agent's guess_ for approval unlabelled, a whole-selection substitution worse in kind than B1a.
R-CAP upgraded: the probe is **load-bearing**, since an undeclared capability yields a wire-level
refusal (`«d.mts»:2957-2958`), not a silent no-op (§1.3a). Architect item 5 closed: **no further
defects**, and B2's split and B3's dual-call recorded as improvements. PR decomposition independently
verified — D touches only `resources/index.ts` and `prompts/index.ts`, E is one markdown file plus three
manifest ACs, neither imports `tool-handler.ts`, and A/B are inert because candidate 1 needs
`hasProvider` and candidate 2 needs `responses !== undefined`.

**Round-3 disposition (Critic, 4 blockers — all in material added in round 2).** **Blocker 4:**
§2.3b's `canonicalArgs` reuse claim was false in both halves — it returns a _string_, is a signing
primitive, and `sortKeysDeep` is module-private (`confirm-token.ts:49`, no `export`). The citation is
**dropped**, the check is written as its own function, and the size estimate is re-derived at
**~15-18 lines**, not ~10. An estimate resting on imaginary reuse is a review surprise waiting to
happen. §2.3b's
_"structurally impossible"_ is **scoped down** to top-level key removal and array truncation, with the
uncovered residue named (§2.3b). **V10 deleted** — it was vacuous on three of four rows and its named
mutation could not flip it, which is the exact defect it was added to prevent. **F13 respelled as two
phases**, because as written it never reached the wrap it names. F8's fixture made concrete. New
**§3.0** records the standing rule these three violated.

**Sweep coverage, recorded rather than implied.** The reviewers' AC sweep covered the unit and
integration rows (F10, F11, V5-V9, I5, I6, F12 all cleared; `inputResponse` cleared as documented-total,
`«d.mts»:1493-1503`). **§3.5's E-lanes were NOT swept.** Applying §3.0's rule to them here found two
defects in E-A — a "_Red:_ any of the three legs" that named no mutation, and a frame **count**
assertion with nothing about the frame's **content**, so a form with wrong fields or a live `default`
passed it. Both repaired; every E-lane now carries a traced mutation. **V6's two survivors remain thin
but honest** (reachable only from unit and future non-MCP callers, as stated).

**Note the pattern, because it is the second instance.** Round 2's §2.3b _appeared_ to add a control
while quietly retiring one: it demoted `isFormable` and V5/V6 from safety to "intent" on the strength
of a chokepoint check that does not cover the nested case those tests were the only guard for. The
first instance was round 1's B3 fix, which wrapped `elicit()` and left the identical `acceptedContent`
hazard unwrapped. **A strengthening that reclassifies an existing control is a net change, not an
addition, and must be argued as one.**

**Citation audit — two rounds, five errors, three of them mine. Now closed.** Every previously
unchecked citation was independently re-verified this round with nothing outstanding. Reviewers found `«d.mts»:1470`
(retargeted: `:1465-1466` is the undefined-on-decline substance, `:1468-1470` the async-`TypeError`
sentence) and `«d.mts»:2968-2973` (→ `:2970-2975`, with the _"gates refuse there"_ sentence at `:2974`).
**Auditing the three nobody had checked, I found two more of my own:** `command-catalog.ts:17-21` was
cited for the `requiresHumanConfirm` rationale and is actually **imports** — the docblock is `:41-45`
and the field `:46`, with `CatalogMcpTool` spanning `:36-49`, not `:37-49`; and the entry `.transform`
is `release-create.ts:463-471`, not `:466-476`. All corrected in place. Verified clean this round and
needing no change: `load-existing-versions.ts:41-45`, `:47-57`, `:68-84`;
`agent-guidance/resources.ts:1-13`, `:2-7`, `:36-40`; `mcp/tools/index.ts:13`, `:37-40`, `:49-53`,
`:69-73`; `release-create.ts:390`, `:451`, `:448-452`; `scripts/build.js:61`; `md.d.ts:12`.

**One citation corrected in the round-2 brief.** The existing `.default('regular')` is at
`release-create.ts:451`, with the `type` field spanning `:448-452` — not `:447-450`, which lands on the
tail of the preceding `name` field. The substance of the finding is accepted in full (§2.5a).

**One new hazard surfaced while fixing B3**, not raised by either reviewer:
`inputRequired.elicit()` throws a `TypeError` **synchronously** for schema shapes the restricted wire
form cannot express (`«d.mts»:1405`). Uncaught, that becomes a tool error where a gate was owed. §2.3
wraps it; §3.1 F6 names the mutation.

---

## 0. What ships

One Claude Code plugin command, `/infra-kit:release-create`, whose body defers to an MCP resource; and
the elicitation machinery that moves "which release do you want to cut?" out of the agent's
`AskUserQuestion` improvisation and into the MCP server, where the real candidate versions live.

Settled by the user today and **not re-litigated here**: exactly one command; `commands/`, not
`skills/`; `argument-hint` is exactly `[--hotfix] [--desc <text>] [<version|next|name>]`; the form
collects **arguments only** — no `confirm` field of any type in `requestedSchema` (§0.13, §4.4
Decision 2); the MCP-side form is generic and will light up all 8 gated tools.

**Two predecessor principles are superseded, and one is contested.** The user's `commands/` decision
overrides P5's explicit rejection of _"the `commands/` budget layer"_
(`infra-kit-slash-commands-plan.md:317-318`) — recorded, not argued. And P4 (`:313`) —
_"Human discoverability is the only thing being bought. An agent already calls
`mcp__infra-kit__release-create` unaided"_ — is **not** this document's theory of the purchase. D1
below says the purchase is that the human-facing question leaves the agent, which P4 does not
contemplate because P4 predates the elicitation track. Where they conflict, D1 governs this increment
and P4 continues to govern the _naming_ argument it was written for.

---

## 1. RALPLAN-DR summary

### 1.1 Principles

**P-A — The chokepoint stays domain-blind.** `«cli»/src/lib/tool-handler/tool-handler.ts` wraps every
exposed tool (it is the sole consumer of the single `server.registerTool` call at
`«cli»/src/mcp/tools/index.ts:13`). It may learn _that_ a tool can offer a form; it must never learn
what a release is. Rejects: a `switch (toolName)` in the handler.

**P-B — Real values, or no form — scoped to `version`.** A `version` option that is a model guess is
strictly worse than the gate, because it launders a guess through a human-looking dialog. If the
candidate versions cannot be computed — network down, `NoPriorVersionsError`, deadline exceeded — the
form is not offered and the call falls to today's gate. **P-B binds `version` only.** `type` is a
two-member enum with a schema default and `description` is free text; neither is computed from the
world, so neither can be "real" or "guessed" in P-B's sense. They ride along because they are the rest
of the same one-entry decision, and saying so is cheaper than pretending the principle covers them.

**P-C — A form is not a gate** (inherited verbatim from §0.13). Consent lives in the second
`tools/call` with `confirm:true` plus the HMAC token minted by `confirm-token.ts`. Nothing in this
increment removes, weakens, or duplicates that.

**P-D — Two channels, one constant.** An agent cannot fetch an MCP prompt (host UI affordance only);
it can read a resource. The procedure prose is therefore registered twice — as a prompt and as a
resource — from **one** imported constant, so drift needs two sources and there is one.

**P-E — Every new guard must be able to fail on its own named mutation.** Inherited from §6.0. Applied
below by naming the mutation for each acceptance criterion.

### 1.2 Decision drivers (top 3)

**D1 — The question must leave the agent.** Today the agent invents an `AskUserQuestion` with versions
it guessed. The server can compute the actual next version from the union of remote `release/v*`
branches and Jira fix versions (`«cli»/src/lib/version-utils/load-existing-versions.ts:68`). Any option
that leaves the question in the agent fails this driver outright.

**D2 — No new _approval_ surface.** §0.12's TOCTOU fix stands untouched and the two-call
`confirm:true` + token protocol is the only place consent lives; this increment adds no second consent
moment. It does add a human _refusal_ point — state 2 is terminal — which is strictly additive to the
gate and is not consent: on the accepted path the human has answered "which release?", never "shall I
execute?", and `confirm:true` is still supplied by the agent alone.

**D3 — Independently shippable, small diffs.** The repo gate is `pnpm run qa` with sonarjs
cognitive-complexity ≤ 15, and `tool-handler.ts` is a 171-line file whose gate logic already carries
three states. Candidates 1 and 2 must land without pushing any function over the ceiling — which,
after B2's restructure, is achieved by splitting rather than by keeping one function small (§2.3).

### 1.3 Viable options

**Option 1 — Per-tool `formProvider` on the catalog tool; generic state machine at the chokepoint;
the command body defers to a one-body MCP resource. — CHOSEN.**
_Pros:_ mirrors exactly how `requiresHumanConfirm` already travels (declared on `McpTool`
(`«cli»/src/types.ts:28`), mirrored non-generically on `CatalogMcpTool`
(`«cli»/src/lib/command-catalog/command-catalog.ts:46`), forwarded at the one registration site
(`«cli»/src/mcp/tools/index.ts:52`)) — so it is a pattern the repo already enforces, not a new one.
`tool-handler.ts` gains one nullable field and zero domain imports. The release form lives beside
`releaseCreateMcpTool`, where `loadExistingVersions`/`computeNextVersion` are **already imported**
(`«cli»/src/commands/release-create/release-create.ts:21-29`).
_Cons:_ touches four layers (`types.ts`, catalog, registration, handler) for one feature; the widened
`ToolsExecutionResult | InputRequiredResult` return type ripples into the wrapper's signature.
**And the decisive one — open risk R-CAP: this option's entire benefit is contingent on a fact this
repo has not measured, where Option 4's is not.** Option 1 delivers **nothing** to a client that does
not declare `elicitation.form`: the probe fails, every call falls to today's gate, and at the SDK level
below that the backstop is predecessor M3 — a clean in-band `isError` with **zero wire traffic**, so the
form simply never appears. **No host the user actually runs has been measured as declaring it.** The
changelog shows Claude Code _renders_ elicitation (form and url mode); that is **not** the same
proposition as _declaring_ `elicitation.form` on `initialize`, which is the one the probe reads (M4) and
the only one that gates this feature. The declaration is not recoverable from any existing artifact, and
nothing in-repo exercises the positive path. **Full statement, evidence and the PR-C precondition:
§1.3a.**

**Option 2 — A form registry keyed by tool name under `src/mcp/`.**
_Pros:_ zero edits to `types.ts` and the catalog; the whole feature is one new module.
_Cons:_ splits a tool's definition from its form across two directories, so the catalog's default-deny
coverage test cannot see the pairing, and a tool renamed in the catalog silently loses its form. Fails
P-A's spirit (the domain knowledge merely moves one directory over) without buying anything Option 1
does not already have.

**Option 3 — No elicitation. Ship only the command, with the procedure inline in the body.**
_Pros:_ one file, one PR, no SDK dependency on undocumented `^2.0.0` behavior (§0.11 M1's standing
PM-6 risk).
_Cons:_ fails **D1** — the question stays in the agent. Also fails the user's Decision 2 (body must
defer to a resource so it cannot rot against the catalog, §5 PM-1).

**Option 4 — A new read-only `release-plan` tool returning candidate versions; the agent still asks.**
_Pros:_ no elicitation, no capability probe, no state machine change; the agent's options become real
instead of guessed.
_Cons:_ fails **D1** — the human-facing question is still authored by the model, in the model's words,
with the model free to add a fifth option.
_Con withdrawn (round 1):_ an earlier draft also charged Option 4 with _"adds a 25th tool and a 25th
`MCP_TOOL_PRESENTATION` row."_ That is padding — a row in a table is not a reason to choose an
architecture, and listing it beside a real objection inflates the apparent margin. **It was never the
deciding axis and is struck.** Option 4 loses on authorship alone, and §1.3a states what it wins on.

**Invalidation, re-derived against the corrected D2 and the form's actual reach.** The chosen option's
form covers **one entry, `version` only, no named releases, no batches** (§2.5). So D1 is _partly_
satisfied by Option 1 too: the agent still authors the call for a batch, for a named release, and
whenever the version candidates cannot be computed. That materially narrows the margin and must be on
the record.

- **Option 2** dies on P-A plus the catalog-coverage argument. Unaffected by the rewording; margin
  unchanged.
- **Option 3** (no elicitation, prose inline) still dies, but now on the **user's Decision 2** first
  and D1 second: the body must defer to a resource so it cannot rot, and Option 3 has no resource.
  Its D1 failure is total (the question never leaves the agent) where Option 1's is partial, so the
  ordering survives — but the gap is "partial vs. total", not "satisfied vs. failed".
- **Option 4** (`release-plan` tool + agent asks) is the close one, and the margin **narrowed**.
  Corrected D2 removes an argument Option 4 never lost on anyway — neither option adds an approval
  surface. On D1, Option 4 gives the agent _real_ candidate values for **every** case Option 1 covers
  **and** the three it does not. What it cannot do is author the question in anything but the model's
  words, with the model free to add a fifth option, reorder, or editorialize — and a human answering a
  model-authored question about production infrastructure is the specific thing D1 exists to end.
  **Option 4 still loses, on that single remaining point.** It is no longer a comfortable win, for two
  separate reasons that compound. First, reach: if the form is not extended past one-entry-`version` in
  a follow-up, Option 4's coverage advantage grows while Option 1's authorship advantage does not.
  **Second, and stronger — R-CAP.** Option 4 works on **every** client unconditionally; Option 1 works
  only on one that declares `elicitation.form`, and **no host the user runs has been measured as
  declaring it** (§1.3a). So the comparison is not "always-on but model-authored" versus
  "always-on and server-authored" — it is "always-on but model-authored" versus **"server-authored if a
  fact we have not checked turns out true."** On the corrected record that is the argument most likely
  to overturn this choice, and it is why PR C carries a measurement precondition rather than shipping on
  the changelog's say-so. **If the probe returns `undefined`, PR C delivers a form nobody ever sees and
  Option 4 is the correct choice.**

Option 1 stands — conditionally, on the open risk below.

### 1.3a Open risk R-CAP: Option 1's benefit is contingent on a fact nobody has measured

**The decisive axis, which the comparison above omitted.** Option 4 works on **every** client,
unconditionally. Option 1 delivers a form only to a client that declares `elicitation.form` on
`initialize` — and per M4 the probe reads `caps?.elicitation?.form`, never `caps?.elicitation`. So
Option 1's benefit rests on an unmeasured proposition and Option 4's does not. That belonged in the
comparison and was not there.

**Measurement attempted, and it does not settle the question. Recorded exactly as strong as it is:**

- Claude Code's changelog carries fixes for MCP elicitation forms clipped in fullscreen and for URL
  dialogs over 4096 characters — form mode _and_ url mode. **This is strong evidence the host renders
  elicitation.**
- It is **not** evidence that the host _declares_ `elicitation.form` on `initialize`. These are
  different propositions and this document does not collapse them.
- The declaration is **not recoverable from any existing artifact.** The host's MCP logs under
  `~/Library/Caches/claude-cli-nodejs/-Users-arthur-projects-infra-kit/mcp-logs-infra-kit*/` record only
  the _server's_ surface as the host summarizes it (`hasTools`/`hasPrompts`/`hasResources`/
  `hasResourceSubscribe`/`serverVersion`); nothing there carries the client's `initialize` capabilities.
  Two attempts to read it out of the installed bundle failed (`claude` on PATH resolves to a cmux shim;
  the real bundle is not at a standard install path). Recovering it needs the server instrumented to log
  `getClientCapabilities()` — which is execution, not planning.
- The only clients in this repo declare `capabilities: {}` (`mcp-stdio.e2e.test.ts:103`, `:141`), so
  **nothing in-repo exercises the positive path today.**

**The one hard number this question has, and it is corroborating rather than decisive.** Those same
logs record `"protocolEra":"legacy"` and `"negotiatedProtocolVersion":"2025-11-25"` across three
separate connections (2026-08-31 at `0.3.15`; 2026-09-05 at `0.4.0`). The host negotiates the **legacy**
era in practice — which is exactly the path predecessor M1 measured `inputRequired` working on, via the
SDK's default-on legacy shim (`«d.mts»:2955-2959`). **Keep it separated from the capability question:
it answers whether the _mechanism_ works, not whether the _host will ask for it_.** A working mechanism
nobody invokes is still a form nobody sees, so this fact strengthens the design without moving R-CAP at
all.

**The probe is load-bearing, not an optimization — and this strengthens the precondition.** An earlier
draft read as though a failed probe merely meant "no form appears". It is sharper than that. The legacy
shim's own gate _"consults the initialize-declared capabilities and surfaces violations per family"_
(`«d.mts»:2957-2958`), so returning `inputRequired` to a client that has **not** declared the capability
produces a **wire-level refusal** — a protocol violation surfaced as one — not a silent no-op. Predecessor
M3's clean in-band `isError` is the SDK declining to commit that violation on the server's behalf; it is
a backstop, not a design. **That is why candidate 1 gates on `canForm` rather than optimizing with it:**
without the probe, every gated call under a non-declaring client would take the violation path instead
of the gate. It also means a wrong probe is not a cosmetic bug, which is exactly why F2's url-only
fixture (the only discriminating one, M4) is load-bearing too.

**Precondition on PR C.** Before the release provider ships: instrument the probe, log
`getClientCapabilities()` on a real connection from the host the user actually runs, and confirm
`caps?.elicitation?.form !== undefined`. One line, one run. **PR C does not merge on an assumption.**

**Why this does not reverse the choice — and the trigger on which it would.** The PR structure
(§5) already isolates the contingency: **A, B, D and E are unconditional.** D and E ship the command,
the resource and the prompt — value on every client, no elicitation involved. A and B are seams with no
user-visible change. **Only PR C depends on R-CAP.** So Option 1's contingent half is already a single
held PR rather than a bet on the whole design, and reversing now would mean building Option 4's tool
_and_ discarding work that is contingent on nothing.

**If the measurement comes back negative**, the decision rule is stated in advance rather than
improvised: hold PR C, and **Option 4 becomes the live proposal for the values half** — on a record that
will by then be measured instead of assumed. Its authorship objection stands, but an authorship
objection to a question that gets asked beats a form that is never rendered. **The degradation if R-CAP
is false is clean and already understood:** the probe fails, every call falls to today's gate, and no
user sees a regression — the increment simply delivers nothing for `release-create` beyond what D and E
already gave. That is a wasted PR C, not a broken product, which is why holding it on a measurement is
proportionate and reversing the architecture on an unmeasured fear would not be.

---

## 2. The design

### 2.1 What is actually in the tree today

| Claim                                              | Evidence                                                                                                                                                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR 1 landed: 3-state machine + HMAC token          | `«cli»/src/lib/tool-handler/tool-handler.ts:30,43-49,68-102`; `confirm-token.ts`                                                                                                                     |
| The wrapper **declares** `ctx` and **discards** it | `tool-handler.ts:109` types the return as `(params, ctx?) => …`, but the returned closure at `:112` is `async (params: unknown) =>` — `ctx` is never bound. `mcp/tools/index.ts:69-73` does pass it. |
| PR 3 not landed                                    | `«cli»/src/mcp/prompts/index.ts:3` — `export const initializePrompts = async (_server: McpServer) => {}`                                                                                             |
| Resources exist, with an injectable seam           | `«cli»/src/mcp/resources/index.ts:19-31,50` — `ResourceDeps`, two URIs                                                                                                                               |
| No elicitation anywhere in the CLI                 | no `inputRequired` / `elicitInput` under `«cli»/src`                                                                                                                                                 |
| The plugin ships zero commands                     | `plugins/infra-kit/` contains `skills/`, `__tests__/`, `README.md` only                                                                                                                              |
| `.md?raw` is wired end-to-end already              | `«cli»/src/md.d.ts:12`; `«cli»/scripts/build.js:61` (`loader: { '.md': 'text' }`); live precedent `«cli»/src/lib/agent-guidance/resources.ts:1-13` importing `resources/**/*.md?raw`                 |
| `release-create` is gated, `releases` is required  | `«cli»/src/commands/release-create/release-create.ts:428` (`requiresHumanConfirm: true`), `:432-476` (`z.array(...).min(1)`, `refine` for exactly-one-of, shared `type`)                             |

### 2.2 SDK facts, re-measured against the installed `@modelcontextprotocol/server@2.0.0`

Types file: `«cli»/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-CLhGwQTn.d.mts`
(abbreviated `«d.mts»`).

- `ToolCallback`'s return union is `CallToolResult | InputRequiredResult` — `«d.mts»:3452`. Returning
  `inputRequired(...)` from a registered tool is typed, not a cast.
- `inputRequired.elicit(params: ElicitInputParams): InputRequest` — `«d.mts»:1409`. `requestedSchema`
  accepts a wire-ready elicitation JSON Schema **or** a Standard Schema — `«d.mts»:1372-1375`.
- **Two hazards on that one method, both in its own docblock (`«d.mts»:1404-1407`):**
  (a) _"A Standard Schema `requestedSchema` is converted to the restricted wire shape; shapes it
  cannot express **throw a `TypeError` before anything is sent**"_ — so `elicit()` can throw
  **synchronously** inside state 1, and an uncaught throw exits via `tool-handler.ts:161-168` and
  becomes a tool error where a gate was owed. (b) _"**Responses are not validated against it** — pass
  the same schema to `acceptedContent()` on re-entry for validated, typed content."_
- `ctx.mcpReq.inputResponses?: Record<string, unknown>` — `«d.mts»:2117`, described at `:2110-2114` as
  bare response objects, **not validated by the SDK**; `«d.mts»:1500-1502` repeats the instruction to
  validate with the schema-aware `acceptedContent` overload.
- **CORRECTION (round 1).** An earlier draft of this section said _"Use `inputResponse`, not
  `acceptedContent`."_ That is a false dichotomy and it steered away from the SDK's own validation
  advice. The two answer different questions and **both** are used:
  - `inputResponse(responses,'args')` — `«d.mts»:1489-1512` — for the **action**. This part of the
    original claim stands: `acceptedContent` (`«d.mts»:1470`) returns `undefined` for missing,
    declined _and_ cancelled alike, so discriminating on its falsiness is the M2 trap.
  - `acceptedContent(responses,'args',schema)` — the schema-aware overload — for the **content**,
    because nothing between the client and the handler has checked it.
- `elicitInput` is `@deprecated`, "Throws on a 2026-07-28-era request" — `«d.mts»:2193-2200`. Never
  adopt. Confirms M6.
- **DEPARTURE from §0.14.** That section says _"Threading `ctx` is the one structural change §4.4
  requires."_ That is incomplete. `ServerContext` (`«d.mts»:2181-2227`) carries `log`, `elicitInput`,
  `requestSampling`, `http?` and — via `BaseContext` (`«d.mts»:2081-2135`) — `id`, `method`, `_meta`,
  `envelope?`, `inputResponses?`, `droppedInputResponseKeys?`, `requestState()`. **It carries no client
  capabilities.** `getClientCapabilities()` lives on the `Server` instance (`«d.mts»:3012`), reachable
  as `server.server` (`«d.mts»:3177`, `readonly server: Server`). And `ctx.mcpReq.envelope` — the
  non-deprecated route the deprecation notice at `«d.mts»:3005-3011` steers to — is populated **only on
  2026-07-28-era requests**; this server's measured connection is 2025-11-25. **So the capability probe
  needs a second seam, injected from the registration site.** One structural change becomes two.

### 2.3 The extended state machine

`resolveGateState` (`tool-handler.ts:43-49`) grows from three outcomes to five. First-match-wins, in
the order written, **every condition stated in full** — no row relies on an earlier row having
excluded anything (§4.4's discipline, kept because both bugs found in the prior review were an omitted
precondition one row apart).

Let `gated = requiresHumanConfirm === true`, `confirmed = isConfirmed(params)` (`tool-handler.ts:33`,
unchanged), `responses = ctx?.mcpReq?.inputResponses`, `canForm = caps?.elicitation?.form !== undefined`,
`hasProvider = formProvider !== undefined`, and `formable = formProvider.isFormable(params)` (§2.5).

**CORRECTION (round 1) — this is a candidate resolution, not a decision table.** The earlier draft's
state 3 condition read _"… ∨ schema was null"_, which is knowable only **after** state 1 has run the
provider under a deadline. A five-way pure predicate that includes it cannot exist, so the earlier
"flat chain of five guarded returns" and the complexity claim resting on it were both describing a
function that could not be written. The corrected shape is two steps:

**Step 1 — `resolveGateState(gated, params, responses, canForm, hasProvider, formable)`** is a pure
function of things knowable before any work, returning one of five **candidate** states. First-match-
wins, in the order written, every condition complete:

| #     | Candidate  | Condition (complete, pure)                                                                             |
| ----- | ---------- | ------------------------------------------------------------------------------------------------------ |
| **0** | `run`      | `!gated`                                                                                               |
| **1** | `form`     | `gated ∧ !confirmed ∧ responses === undefined ∧ canForm ∧ hasProvider ∧ formable`                      |
| **2** | `declined` | `gated ∧ !confirmed ∧ responses !== undefined ∧ inputResponse(responses,'args').action !== 'accept'`   |
| **3** | `gate`     | `gated ∧ !confirmed ∧ (responses === undefined ∨ inputResponse(responses,'args').action === 'accept')` |
| **4** | `verify`   | `gated ∧ confirmed`                                                                                    |

**Step 2 — `form` is the only candidate that can decline itself.** `buildArgumentForm` returns either
an `InputRequiredResult` or `null`; on `null` the caller falls to `gate`. It returns `null` when the
provider rejects, exceeds the deadline, or resolves `null` (§2.5), **and** when
`inputRequired.elicit()` throws the `TypeError` documented at `«d.mts»:1405` — the whole call is
wrapped, because that throw would otherwise become a tool error where a gate was owed. No other
candidate falls through: `run`, `declined`, `gate` and `verify` are terminal in their own bodies.

Likewise `gate` reached **from** an accept re-validates the accepted content with
`acceptedContent(responses,'args',schema)` (§2.2 B3), inside a `readAcceptedArgs` helper. **A validation
failure routes to `gate` carrying the round-1 arguments** — never back to `form`, which would be PM-4
through a second door.

**`readAcceptedArgs` is wrapped, on the same grounds `buildArgumentForm` is (round-2 MAJOR).** The B3
fix introduced a sibling of the hazard it was fixing: `«d.mts»:1468-1470` — _"Only synchronous schemas
are supported (zod schemas without async refinements are synchronous); an asynchronously-validating
schema **throws a `TypeError`**."_ `buildRequestedSchema`'s declared return type
`z.ZodObject<z.ZodRawShape>` freely permits `.refine(async …)`, so a provider author can arm that throw
without writing anything the type system objects to — and it would escape via `tool-handler.ts:161-168`
as a tool error where a gate was owed, which is precisely what `elicit()`'s wrap (`«d.mts»:1405`)
exists to prevent. **Three parts, all required:** the helper is wrapped; `buildRequestedSchema`'s
contract gains **"synchronous validation only"** (§2.4); and F13 names removing the wrap as its
mutation. Wrapping one of two identical hazards and not the other is the shape of bug this document
keeps finding, so it is called out rather than quietly fixed.

**And the human is told, not merely logged at (Architect item 4).** Routing a validation failure to the
gate is right for liveness — a terminal refusal would deny service on a tool whose non-form path works
fine — but the earlier draft's only signal was a log line no human reads. **Name what that costs
precisely: the gate then presents the _agent's guess_ for approval, unlabelled, in place of the values
the human just chose. That is a worse substitution in kind than B1a** — B1a mangled one field, this
swaps the entire selection — and it is the second time in this document that a "safe" fall-back turned
out to be a silent argument substitution. Exact shape, three parts:

1. **`buildConfirmGate`'s `message`** (`tool-handler.ts:81`) states that the submitted values failed
   validation and were **discarded**, and that the arguments shown are the original ones.
2. **`formDiscarded: true`** in the gate's `structuredContent`, so an agent can react programmatically
   rather than by parsing prose — the same reason `status` and `reason` are already fields there.
3. **F9 asserts both**, not the log line.

One string, one field, one assertion, riding the same `message` edit PM-D mitigation (a) already puts
in PR C's scope.

**Actions.** `run` → handler with `confirmedCommand:true`. `form` → `inputRequired({inputRequests:{args:
inputRequired.elicit({message, requestedSchema})}})`, and **no `confirm` field of any type appears in
the schema**. `declined` → terminal `isError`, **never re-prompt**; covers `decline`, `cancel`,
`kind:'missing'`, and a key named in `droppedInputResponseKeys`. `gate` → today's `buildConfirmGate`
(`tool-handler.ts:68-83`) unchanged in shape, carrying `resolvedArgs` = the validated form-collected
args on the accepted path and the round-1 args on every other path, with a `confirmToken` minted over
exactly what it carries. `verify` → today's `verifyConfirmToken` (`tool-handler.ts:146-154`),
unchanged; a refusal happens **inside** `verify`, never as a fall-through.

**Why `!confirmed` is spelled on 1, 2 and 3.** Trace a non-elicitation round 2 (`confirm:true` + token,
`responses === undefined`): without it, candidate 3 matches and re-gates forever, 4 unreachable. That
is §5's PM-5 verbatim. Unchanged by the restructure.

**Implementation note, not a design point.** `inputResponse(responses,'args').action !== 'accept'` in
candidates 2 and 3 needs narrowing to typecheck: `InputResponseView` is a union and `action` exists
only on the `kind:'elicit'` member (`«d.mts»:1493-1503`). Spell it as a `kind === 'elicit' && action ===
'accept'` test with the non-elicit kinds folded into "not accepted". The call itself needs no wrap —
`inputResponse` is documented **total**, with malformed entries reading `{kind:'missing'}`.

**M2, spelled out.** The discriminator between "first call" and "the client came back" is
`inputResponses !== undefined` — candidates 1 and 2 partition on exactly that. It is **never**
`acceptedContent(...)` being falsy (`«d.mts»:1470`): that reads `undefined` for decline _and_ cancel
_and_ absence, which would send a decline back to `form` and re-prompt forever (PM-4).

**Complexity, re-derived against the shape actually specified.** `resolveGateState` is now five guarded
returns over six named booleans and one `inputResponse` call — cognitive complexity ≈ 6, comfortably
under the sonarjs ≤ 15 ceiling. The work that does not fit a predicate lives in `buildArgumentForm`
(deadline race, `TypeError` catch, null-check) and in a `readAcceptedArgs` helper (accept detection,
schema validation, fall-back-to-round-1), each ≈ 4–6, and neither is on `resolveGateState`'s count.
Three small functions, not one large one — the same split PR 1 used for `buildConfirmGate`.

### 2.3a The batch-truncation hole, and the predicate that closes it — **BLOCKER B1**

An earlier draft's state 1 inspected the client and the tool but **never the arguments**, while §2.5's
`toArgs` returned a hard-coded one-entry `{releases:[…]}`. Trace `releases:[A,B,C]` against it:
candidate 1 fires → the form asks for one version → the gate mints a `confirmToken` over the
**truncated** one-entry array → `verify` checks that token against those same truncated arguments and
passes cleanly → **one release is cut instead of three, and every mechanism reports success.** That is
§0.12's argument-substitution class reopened through a new door, and the predecessor's PM-0 verbatim.
The tool's own zod `refine` (`release-create.ts:456-463`) cannot catch it: it validates each entry's
shape and is constitutionally unable to notice that two entries vanished. The prose defence — _"a batch
stays an agent-authored call"_ — was a sentence with no enforcer.

**The predicate.** `formable` is true iff:

```
releases is absent or empty
  ∨ (releases.length === 1 ∧ hasNextToken(releases))
```

It lives on the provider (`isFormable`), not in `tool-handler.ts` — the chokepoint stays domain-blind
(P-A) and merely asks "does this provider want the form for these arguments?".

**Why the length check is not redundant.** `hasNextToken` is `entries.some(...)`
(`«cli»/src/lib/version-utils/next-version.ts:279-283`, verified), so a multi-entry batch satisfies it
as soon as **any one** entry carries the `next` token — position is irrelevant. Without `length === 1`
such a batch is truncated exactly as above. **A predicate of "absent/empty ∨ hasNextToken" is
insufficient and must not be adopted.** (F8 pins the fixture; its binding requirement is `length > 1`
plus at least one `next` entry, not a particular index.)

Everything else — a multi-entry batch, a named release, an explicit semver — goes straight to `gate`
with its arguments intact, i.e. today's behavior.

### 2.3b The non-narrowing check — B1 bounded structurally, B1a only partly

**This supersedes, and does not merely supplement, the earlier control.** An earlier revision closed
B1 with `isFormable` plus a per-provider AC table (V5/V6), and self-reported the residual: `isFormable`
was the first _security-relevant_ member of a provider interface, so a future provider author who
implemented it loosely reopened B1 for their own tool, and no interface could stop them. That residual
is now removed rather than documented.

**The check.** In `tool-handler.ts`, after `toArgs` and **before the token is minted**, compare the
round-1 `params` against the merged result:

- every top-level key present in round 1 is still present, and
- every array-valued key is **neither shorter nor longer**. Growth injects an entry the caller never
  supplied; no legitimate form adds one, just as none withdraws one.

On violation: fall to `gate` with the **round-1** arguments, log, and carry the same
"selections could not be applied" clause the validation-failure path uses.

**It is its own function; the `canonicalArgs` reuse claimed in round 2 does not exist (blocker 4).**
An earlier draft said `canonicalArgs` _"already supplies the stable traversal primitive, so this is a
comparison, not a new serializer."_ Both halves are false, verified:

- `canonicalArgs` (`confirm-token.ts:78-80`) is `JSON.stringify(sortKeysDeep(args))` — it returns a
  **string**. It is a _signing_ primitive, and its docblock says why it exists: key-order-sensitive
  signing _"would refuse legitimate confirmations intermittently, per client."_ It exposes no traversal.
- Nor is the check a comparison of canonical forms. `canonicalArgs(round1) === canonicalArgs(merged)`
  would forbid the human's answer, which is the whole feature.
- `sortKeysDeep` is **module-private** (`confirm-token.ts:49`, no `export`, absent from
  `tool-handler/index.ts`) — and key ordering is not what a keys-and-lengths comparison needs anyway.

**The citation is dropped rather than repaired**, and the check is written as its own small function:

```ts
/** True when `after` removed a top-level key of `before`, or shortened one of its arrays. */
const narrowsArgs = (before: unknown, after: unknown): boolean => {
  if (!isRecord(before)) return false
  // `before` is a record and `after` is not: EVERY argument was narrowed away.
  if (!isRecord(after)) return true

  for (const [key, value] of Object.entries(before)) {
    if (!(key in after)) return true
    if (Array.isArray(value) && (!Array.isArray(after[key]) || after[key].length !== value.length)) return true
  }

  return false
}
```

**Size, re-derived honestly: ~15-18 lines**, not the ~10 the reuse claim implied — the helper above,
a three-line `isRecord`, and the call site. Cognitive complexity ≈ 5, well under the ceiling. Stated
because an estimate resting on imaginary reuse is how a "small" change becomes a surprise in review.

**P-A is untouched.** The check is about _shape_ — keys and lengths — and never about releases,
versions or batches. `tool-handler.ts` still learns no nouns.

**Exactly what it covers, and exactly what it does not (corrected in round 3).** An earlier draft
claimed this made B1 _"structurally impossible"_ and that _"a provider cannot narrow its own tool's
arguments however it is written."_ **Both are false one level down**, and the overclaim was load-bearing
because it was used to demote `isFormable`.

_Covered — and this half genuinely is structural:_

- **Top-level key removal.** `releases` cannot vanish.
- **Array truncation.** `releases` cannot get shorter. This is a **ceiling, not a heuristic**: there is
  no legitimate form, present or future, that shortens an array the caller supplied. A form narrows a
  _choice_; it never withdraws an item the caller asked for. So the check can never need relaxing, and
  a future provider that trips it is wrong by construction rather than merely unusual.

_Not covered — the residue, named rather than glossed:_

- **Nested key removal** — `releases[0].type`, `releases[0].description`. The check reads top-level
  keys only.
- **Equal-length / equal-shape substitution** — `[X]` → `[Y]`, or any value replacement at any depth.

**Both are B1a's class, not B1's** (label corrected in round 3): a field destroyed _inside_ a surviving
entry, not an entry destroyed. The harm is identical — a `hotfix` silently becoming `regular`, the
release cut from `dev` instead of `main`, the token minted over the mutation, `verify` clean — but the
label should be right, because B1's control (the length check) is not the one that applies here.

**The residue is acceptable because it is uncheckable generically, not because it is harmless.**
Replacing a value at equal shape is precisely _what a form is for_; a domain-blind check that forbade
it would forbid the feature.

**And the check is deliberately NOT deepened.** A recursive walk requiring every nested key to survive
would forbid a legitimate form **clearing an optional field** — a human blanking a `description` they
no longer want is a correct interaction, and a deep check would reject it as narrowing. There is no
generic rule that separates "the human cleared this" from "the provider dropped this", so depth would
trade a real defect for a false one. **Top-level-only plus this stated residue is the honest design**,
and it is chosen rather than settled for.

**The sole control over the residue is `toArgs`'s merge plus the no-defaults rule (§2.5a)** — together,
not either alone: the merge preserves untouched fields, and the absence of defaults is what makes
"untouched" detectable. Nothing above the provider backs either of them up.

**The demotion, restated — read this before writing a second provider.** Round 2's wording netted out
as _"the chokepoint has it covered, so a loose `toArgs` is a UX bug."_ **That reading is false, and it
is worse than round 1's**, which at least advertised the provider contract as load-bearing. Round 1 was
right about _who is responsible_; §2.3b only narrows _one_ way of getting it wrong. Correctly:

- **`isFormable` stops being load-bearing for truncation only.** A loose `isFormable` costs a pointless
  dialog, not a shortened batch. It remains the provider's own statement of when a form is appropriate
  at all, and V5/V6 remain real tests of that.
- **`toArgs` is load-bearing, undiminished.** A provider that constructs fresh instead of merging, or
  that reintroduces a schema default, reopens B1a for its own tool, and **the chokepoint will not catch
  it** — the emitted object has the same top-level keys and the same array length. It is caught by
  nothing but that provider's own tests.
- **Therefore every new provider owes a V7 and a V8 of its own** (no-defaults; field-by-field merge).
  Stated as an obligation because it cannot be enforced from here: the interface can require a `toArgs`,
  not a _correct_ one.

**Net effect on provider authors, in one line:** the chokepoint removed one failure mode from your
plate (truncation) and none of the others. Writing `toArgs` is still the security-relevant act.

Roughly fifteen to eighteen lines of code (§2.3b) and one AC (**F12**), removing the truncation class and bounding the
substitution class to what a form legitimately does. That trade is why it is adopted here rather than
filed as a follow-up — but it is a bound, not an elimination.

### 2.4 The seam: how a domain-blind chokepoint gets release-specific options

Add one optional field, travelling the same road `requiresHumanConfirm` already travels.

```ts
// «cli»/src/types.ts — beside RequiredConfirmedOptionArg
export interface ArgumentFormProvider {
  /** Human-facing prompt rendered above the form. */
  message: string
  /**
   * Whether a form is WORTH opening for THESE arguments. Pure, synchronous, never
   * throws; `false` sends the call straight to the gate with its arguments intact.
   * Defaults to `false` on anything it does not recognise.
   *
   * NOT load-bearing for TRUNCATION: the chokepoint's non-narrowing check (§2.3b)
   * catches top-level key removal and any array length change — shortening OR
   * growth — which no provider can weaken. The check is load-bearing for NOTHING
   * ELSE: it does not look at
   * nested keys or at values, so it does NOT cover a form that drops
   * `releases[0].type`. Do not read this as "the chokepoint has it covered": for
   * anything below the top level, `toArgs`'s merge is the only control (§2.3b).
   */
  isFormable: (params: unknown) => boolean
  /**
   * Candidate values for THIS tool's arguments, as a zod object (a Standard
   * Schema — `inputRequired.elicit` accepts one, «d.mts»:1372-1375). Returned
   * rather than inlined so the SAME schema validates the response on re-entry
   * («d.mts»:1406). Contract: never throws, never blocks past the caller's
   * deadline, and returns `null` when it cannot offer real values — which the
   * handler reads as "no form" and falls to the gate. P-B lives here.
   *
   * Also: **validates SYNCHRONOUSLY — no `.refine(async …)` anywhere in the
   * object.** `acceptedContent`'s schema-aware overload throws a `TypeError` on an
   * asynchronously-validating schema («d.mts»:1468-1470), and the declared return
   * type `z.ZodObject<z.ZodRawShape>` cannot express that constraint — so it is
   * stated here and backstopped by the wrap around `readAcceptedArgs` (§2.3).
   */
  buildRequestedSchema: (params: unknown) => Promise<z.ZodObject<z.ZodRawShape> | null>
  /**
   * MERGES validated form content over the round-1 `params` — never constructs a
   * fresh argument object (§2.5a). The form overwrites field-by-field and only
   * where the human supplied a value; untouched fields keep their round-1 value.
   * Contract: TOTAL over anything `buildRequestedSchema`'s own schema accepts,
   * and NEVER THROWS — it is the one member called on client-supplied input, and
   * a throw here escapes via `tool-handler.ts:161-168` as a tool error where a
   * gate was owed. It returns `null` if it cannot map, which the handler treats
   * exactly as a validation failure: gate, with the round-1 arguments.
   */
  toArgs: (content: Record<string, unknown>, params: unknown) => Record<string, unknown> | null
}
```

**Why `toArgs` needs a contract at all.** `buildRequestedSchema` runs on the server's own data;
`toArgs` runs on whatever the client sent back. Giving the never-throw contract only to the first is
backwards — the second is the attack surface. Belt and braces: the contract is stated, **and** the
call site wraps it, because a contract is a promise and the wrap is the enforcement.

- Declared on `McpTool` (`«cli»/src/types.ts:16-32`) as `formProvider?: ArgumentFormProvider`.
- Mirrored non-generically on `CatalogMcpTool` (`command-catalog.ts:36-49`), with the same rationale
  the existing docblock at `:41-45` gives for `requiresHumanConfirm` (`:46`).
- Forwarded at the one registration site, beside `requiresHumanConfirm`
  (`«cli»/src/mcp/tools/index.ts:49-53`), together with the capability probe:

```ts
createToolHandler({
  toolName: tool.name,
  handler: tool.handler,
  requiresHumanConfirm: tool.requiresHumanConfirm,
  formProvider: tool.formProvider,
  getClientCapabilities: () => server.server.getClientCapabilities(),
})
```

`tool-handler.ts` therefore imports nothing new from the domain. It asks two questions — "is there a
provider?" and "can this client render a form?" — and never learns the answer's meaning.

**On the deprecation.** `getClientCapabilities()` is `@deprecated` at `«d.mts»:3005-3012`, steering to
`ctx.mcpReq.envelope`. The same notice states the accessor "remains functional" and is backfilled
per-request from the validated envelope on 2026-era instances. Recorded as a **known deprecated
dependency with a stated migration**: when this server serves the 2026 era by default, the probe moves
to `ctx.mcpReq.envelope?.capabilities`. Both spellings are behind the one injected closure, so the
migration is a one-line change at the registration site. _Unverified:_ whether the backfill preserves
M4's `{elicitation:{}}` → `{elicitation:{form:{}}}` normalization on the 2026 path.

**M4 is honoured:** the probe reads `caps?.elicitation?.form`, never `caps?.elicitation`. Only a
url-only fixture (`{elicitation:{url:{}}}`) can tell the two spellings apart — a bare `{elicitation:{}}`
normalizes to `{form:{}}` and both spellings pass it.

### 2.5 Where `release-create`'s real values come from

New module `«cli»/src/commands/release-create/release-form.ts`, exporting
`releaseCreateFormProvider: ArgumentFormProvider`, wired onto `releaseCreateMcpTool`
(`release-create.ts:426`).

Confirmed exports (`«cli»/src/lib/version-utils/index.ts:1-18`):

- `loadExistingVersions(): Promise<SemVer[]>` — `load-existing-versions.ts:68-84`. Unions remote
  `release/v*` branches (`git ls-remote`, `:41-45`) with Jira fix versions (`:47-57`) under
  `Promise.allSettled`, logging and continuing past either failure. **It does not throw**; it returns
  `[]` when both sources fail or are empty. Two network calls — the reason for the deadline in §2.3.
- `computeNextVersion(known, type): string` — `next-version.ts:76-96`. **Throws `NoPriorVersionsError`
  (`:62-65`) when `known.length === 0`** (`:77`). Regular → bump minor, reset patch; hotfix → bump
  patch on the highest minor.
- `NoPriorVersionsError` is exported and instance-checkable.

The provider reuses the existing swallow helper `trySuggestNext` (`release-create.ts:40-48`), which
already returns `null` on `NoPriorVersionsError` and rethrows anything else. It is currently
module-private; **PR-C exports it** (no move — leaving it in `release-create.ts` keeps the diff at one
line and keeps `version-utils` free of a `try/catch` its callers own).

`isFormable(params)` implements §2.3a's predicate exactly: `releases` absent or empty, **or**
`releases.length === 1 && hasNextToken(releases)`.

**CORRECTION (round 2) — the execution model.** An earlier draft claimed `isFormable` _"runs before any
zod parse."_ **That is false.** `mcp/tools/index.ts:37-40` registers `inputSchema: z.object(…)`, and
`BaseToolCallback` types the callback's first argument as `StandardSchemaWithJSON.InferOutput<Args>`
(`«d.mts»:3448`) — so by the time `createToolHandler`'s closure runs, `params` has already been parsed
**and `.transform`ed** (`release-create.ts:463-471`). Two consequences, both load-bearing:

- **The malformed shapes an earlier V6 row tested cannot arrive.** `{releases:'next'}` and
  `{releases:[null]}` are rejected by the SDK at validation and never reach the handler. Asserting
  against them is a vacuous lane dressed as a hazard control — and this repo has a recorded history of
  exactly that failure mode (a guard that passes because its target is unreachable). Those rows are
  **deleted**, and V6 is re-targeted at shapes that genuinely can arrive (§3.2).
- **`base` is a parsed `ReleaseInput`, not the raw entry.** So §2.5a's merge composes the form's answer
  onto a transformed value, and re-emitting it means the transform runs a second time. That is benign
  **only because the transform is idempotent** — which nothing currently asserts. **V9 asserts it**
  rather than leaving the merge resting on an unstated property.

`isFormable` still reads `params` defensively and returns `false` on anything it does not recognise —
not against the wire, which the SDK now guards, but because `tool-handler.ts` also calls it from unit
tests and from any future non-MCP caller, where no parse has run.

`buildRequestedSchema` then, in order:

1. `known = await loadExistingVersions()`;
2. `regular = trySuggestNext(known, 'regular')`, `hotfix = trySuggestNext(known, 'hotfix')`;
3. a **zod object** — `oneOf`-free and flat — with `version` (`z.enum` of the non-null suggestions plus
   the literal `"next"`), `type` (`z.enum(['regular','hotfix']).optional()`) and `description`
   (`z.string().optional()`). **Every field optional; no `.default()` anywhere** — see §2.5a for why
   that is a correctness requirement and not a style choice. The round-1 values are carried into the
   field `description`s as displayed hints instead;
4. `null` if both suggestions are null **and** `known` is empty — nothing real to offer, so P-B says
   no form.

A **zod object**, not a hand-built JSON Schema, because `inputRequired.elicit` accepts a Standard
Schema (`«d.mts»:1372-1375`) and the same object is then handed to `acceptedContent(…, schema)` on
re-entry, which is exactly what `«d.mts»:1406` instructs. Two spellings of one shape would be a drift
source; there is one.

`toArgs` **merges** the validated content over the round-1 entry — see §2.5a. One entry is now
**enforced** by `isFormable`, not merely asserted (§2.3a). The tool's own zod `refine`
(`release-create.ts:456-463`) remains the final validator; §3's V3 asserts the mapping parses
against it.

### 2.5a The field-level merge — **B1a**, a second silent substitution

**The bug the array-length predicate did not close.** With `isFormable` satisfied, an earlier draft's
`toArgs` still _constructed a fresh entry_ from the form content. Trace a round 1 of
`{version:'next', type:'hotfix', description:'urgent auth patch'}` — an entirely ordinary
`/infra-kit:release-create --hotfix --desc "urgent auth patch" next`. The form opens; the human accepts
the version and leaves the rest alone. A fresh-entry `toArgs` emits `type:'regular'` (the form's own
default) and **no description**. The gate mints a token over that mutated entry, `verify` checks the
token against those same mutated arguments and passes cleanly, and the release is cut from `dev`
instead of `main` — `getBaseBranch`, used at `release-create.ts:390`.

**This is B1's class with a smaller blast radius and a higher likelihood**: it needs no batch, only the
ordinary single-entry path with the form's defaults untouched — which is the _modal_ interaction, not
an edge one.

**Fix, in two parts. The merge alone is insufficient.**

1. **Merge, don't construct.** `toArgs` already receives `params`. Let `base = params.releases?.[0] ?? {}`.
   The emitted entry is `{ ...base, ...supplied }` where
   `supplied = Object.fromEntries(Object.entries(content).filter(([, v]) => v !== undefined))`.
   Direction stated explicitly: **the form overwrites the round-1 entry field-by-field, and only where
   the human supplied a value; every field the human did not touch keeps its round-1 value.**

   **Why the `undefined` filter, framed correctly — it is hygiene, not a threat control.** The content
   reaching `toArgs` in production is JSON-parsed from `ctx.mcpReq.inputResponses`, and JSON cannot
   carry `undefined`, so on the wire an omitted field is an absent key and a bare spread already
   behaves. The filter is not defending against anything a client can send. It is what makes `toArgs`
   **total over its declared input**: measured on zod 4.5.2, `{type: undefined}` parses to own keys
   `['version','type']` while an omitted `type` yields `['version']` (and `{type: null}` is an
   `invalid_value`). So without the filter, §2.4's contract sentence — _"only where the human supplied
   a value"_ — is **false for one input shape the signature accepts**. That is a documentation defect
   today and a live bug the moment a second in-process caller exists — **including §2.3b's own
   check**, which compares against `toArgs`'s output. Framing it as a wire defence would advertise a
   threat that cannot occur.

2. **No `default`, anywhere in the form schema** (§2.5 step 3). This is what makes part 1 sound. A
   zod `.default('regular')` _materializes_ `regular` during parse, so after validation an untouched
   `type` is indistinguishable from a deliberately-chosen `regular` — and `{...base, ...supplied}`
   then overwrites `hotfix` with the default exactly as the fresh-entry version did. The merge would
   look correct and behave identically. The same is true one layer out: §0.13 records
   `FormElicitationCapabilitySchema`'s `applyDefaults`, so a **client** may fill declared defaults on
   the user's behalf — meaning a `default` in the emitted JSON Schema is also unsafe. Hence: no
   `default` in the zod object and none on the wire; round-1 values appear as **displayed hints** in
   each field's `description`, which informs the human without materializing a value.

   _Citation note:_ `applyDefaults` lives in the **bundle**, not the types —
   `«cli»/node_modules/@modelcontextprotocol/server/dist/src-CX2iR2pK.mjs:754`
   (`FormElicitationCapabilitySchema`), and it is **absent from `«d.mts»`**. Said explicitly because a
   reader who greps the `.d.mts` will find nothing and conclude the claim is unsupported.

**This is a known-shape bug in this repo.** It is the same failure as the recorded config defect where
a zod `.default()` survives `.partial()` and shallow-merges over a committed setting, silently
reverting it. Defaults belong at the read site, not in a schema that will be spread over real data.

**The rule binds the FORM schema only. The tool's own `.default('regular')` at
`release-create.ts:451` (the `type` field, `:448-452`) is assessed and CORRECT — do not delete it.**
Stated because the paragraph above reads like a blanket condemnation and an implementer acting on it
would change tool behaviour. The distinction is which side of the merge a default lands on: the tool's
default materializes into `base`, where it _is_ the round-1 truth — the value the caller's arguments
actually resolved to, and the one a human leaving the form alone should keep. A default in the **form**
schema materializes into `supplied`, where it masquerades as an answer the human never gave and
overwrites `base`. One is the thing being preserved; the other is the thing doing the damage. (It is
also the second half of the own-`undefined` trace above: `base.type` is always populated _because_ of
that default, which is exactly why an unfiltered `{type: undefined}` in `supplied` would be able to
clobber it.)

**Flat, not `oneOf`.** `release-create`'s entry schema is "exactly one of `version` or `name`", which
JSON Schema expresses as `oneOf`. Elicitation `requestedSchema` is a flat primitive-property object in
every client rendering measured so far; a `oneOf` is _unverified_ to render. The form therefore offers
`version` only (including the `"next"` token), and a **named** release stays an agent-authored call —
the same call it is today. Stated so a reader does not read the form as covering the whole schema.

**`process.exit(1)` is untouched.** The three call sites in `release-create.ts` (`:89`, `:104`, `:113`)
are inside `promptForVersionInput` / `promptForNameInput`, reached only from
`promptForReleasesInteractive` (`:119`, at `:169`/`:174`) — the **TTY wizard**. The MCP tool handler
does not reach them, and `release-form.ts` calls neither. **Assessed and out of scope**; the standing
"`process.exit` must stay at the CLI entry" hazard is not aggravated by this increment. `release-form.ts`
adds no `process.exit`.

### 2.6 The minimum PR-3 slice that makes Decision 2 real

Decision 2 requires the command body to defer to an MCP resource. Full PR 3 ships six bodies plus a
six-name partition guard. **The slice is one body, both channels, on infrastructure that already
exists.**

1. `«cli»/resources/workflow/release-create.md` — the procedure prose. Sibling of the existing
   `resources/root/`, `resources/package/`, `resources/design/` trees.
2. `«cli»/src/mcp/workflow-bodies.ts` — `import releaseCreate from '../../resources/workflow/release-create.md?raw'`
   and export `WORKFLOW_BODIES = { 'release-create': releaseCreate.trimEnd() }`. Modelled on
   `«cli»/src/lib/agent-guidance/resources.ts:1-13,36-40`, **including its flat-static-import rule**
   (`resources.ts:2-7`): esbuild inlines only statically visible specifiers, so a glob or dynamic
   `import()` survives into `dist` and throws `ERR_UNKNOWN_FILE_EXTENSION` on a consumer's machine —
   and every test runs from `src/`, where that refactor still works. Only the bundle guard catches it.
3. Register as a resource in the existing `initializeResources` (`«cli»/src/mcp/resources/index.ts:50`):
   URI `infra-kit://workflow/release-create`, `mimeType: 'text/markdown'`, body from the constant.
4. Register the **same constant** as a prompt named `release-create` in `initializePrompts`
   (`«cli»/src/mcp/prompts/index.ts:3`, today a no-op), **with `argsSchema` omitted entirely**.

Why both: an agent cannot fetch a prompt (host UI affordance only) but can read a resource; a human
picks the prompt from the `/` menu. One constant, so P-D holds by construction.

**The argsSchema decision, made and recorded (B4).** `registerPrompt`'s config types `argsSchema?: Args`
— **optional** (`«d.mts»:3345-3351`). The recorded hazard is that a bare `z.object({…})` argsSchema
throws when a client calls `prompts/get` with `arguments` omitted, and that the obvious `.default({})`
repair voids `.shape`. **This increment does not treat that hazard; it avoids it** — the prompt is
registered with no `argsSchema` at all, which is the one shape on which "arguments omitted" cannot
throw, and the callback takes only `ctx` (`LegacyPromptCallback`'s no-args form, `«d.mts»:3447`).

**Consequence, stated rather than discovered: the two channels are deliberately NOT equivalent.** The
command carries `argument-hint` and passes `$ARGUMENTS`; the prompt takes nothing, so a human picking
`release-create` from the `/` menu gets the procedure and then types the version in chat. That is a real
asymmetry, it is accepted for v1, and the reason is that giving the prompt a version argument means
solving the `.default({})`/`.shape` hazard — a piece of work with its own test surface that has nothing
to do with this increment. **Named follow-up**, not a silent gap.

**Why the slice, not PR 3.** PR 3's value is six bodies and the naming partition over six names; this
increment needs one. Shipping one first is thinner, independently useful, and forecloses nothing — the
partition guard (§3, I3) is written in a form that generalizes to six by adding names to two literal
sets.

**Prettier owns these bytes** (recorded hazard): it rewrites `*outside*`, mangles `{{x}}` in front
matter, and adds a line beside a bare placeholder. The body therefore carries no front matter and no
`{{…}}` placeholders, and every assertion about it is a **rendered line count or a substring**, never
file cleanliness.

### 2.7 The command file

`plugins/infra-kit/commands/release-create.md` — 9 lines:

```markdown
---
name: release-create
description: Cut one or more release branches through the infra-kit MCP server.
argument-hint: [--hotfix] [--desc <text>] [<version|next|name>]
---

Read the MCP resource `infra-kit://workflow/release-create` and follow it exactly, treating $ARGUMENTS as the release the user asked for.
If that resource cannot be read, call the `mcp__infra-kit__release-create` tool directly and let its confirm gate drive the rest.
If the infra-kit MCP server is not connected in this session, say so and stop — do not improvise with git or gh.
```

Frontmatter is `name`, `description`, `argument-hint` and nothing else (§0.6). **No `allowed-tools`**,
deliberately: `manifest.test.mjs`'s U6 walks `skillDirs()` only (`manifest.test.mjs:387`), so an
`allowed-tools` on a command would be entirely unguarded — the rule would exist and nothing would hold
it to the body. Omitting it keeps the invariant honest rather than decorative.

The three lines are the three failure clauses §7.6 requires: resource missing, server absent, and the
tool-only fallback.

**What the flags mean once a form exists (M-5).** `argument-hint` is settled at
`[--hotfix] [--desc <text>] [<version|next|name>]`, and the form also offers `type` and `description`.
They are not in competition: **`$ARGUMENTS` is what the agent puts in the tool call, and the form is
what the human corrects.** Three cases, and they are exhaustive:

| The user typed                              | `isFormable`?                 | What happens                                                                                                                                                          |
| ------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| nothing                                     | yes (`releases` absent)       | the form asks; `--hotfix`/`--desc` were never supplied, so `type`/`description` default in the form                                                                   |
| `next`, optionally with `--hotfix`/`--desc` | yes (one entry, `next` token) | the form opens **pre-scoped by the flags** — the agent's `type`/`description` land in the call, and the form's own fields let the human override them before the gate |
| an explicit `1.64.0`, a name, or a batch    | no                            | straight to the gate with the arguments intact — today's behavior                                                                                                     |

So the flags never become dead: they steer the agent's call, and in the one case where a form also
opens they are the form's starting point rather than a second, competing input. The form's `type` and
`description` fields exist precisely so a human who typed `next` with no flags is not forced back to
the chat to add `--hotfix`.

### 2.7a Precedence when the form contradicts `$ARGUMENTS` — **M-5, completed**

Stated rather than left inferable: **the form wins, field-by-field, wherever the human supplied a
value; the round-1 arguments win everywhere else.** A human who typed `--hotfix` and then picks
`regular` in the form gets `regular` — they saw the field, they changed it, they meant it. A human who
typed `--hotfix` and leaves `type` untouched gets `hotfix`.

This is exactly why §2.5a's distinction matters and why it is a correctness fix rather than a polish
item: **"form wins" must mean "form wins where the human supplied a value", never "form replaces the
entry."** The second reading is B1a — it converts every untouched field into a silent overwrite by a
default the human never saw, and it is the reading a naive `{...form}` construction implements. The
rule and the no-`default` requirement are one decision, not two.

### 2.8 What `manifest.test.mjs` does when `commands/` appears — read, not guessed

The suite walks the whole plugin tree, so this was checked test by test
(`plugins/infra-kit/__tests__/manifest.test.mjs`).

| Test          | Walk root                                                                         | Verdict                                                                                                                                                                                                                                                                                                         |
| ------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U3 `:308`     | `skillDirs()` → `SKILLS_DIR`                                                      | **green** — `commands/` is invisible to it. `EXPECTED_SKILLS` (`:19-26`) needs no edit.                                                                                                                                                                                                                         |
| U2 `:312`     | `skillDirs()`                                                                     | **green**                                                                                                                                                                                                                                                                                                       |
| U4 `:327`     | `walkFiles(PLUGINS_DIR)`, all `.md`                                               | **scans the new file.** `name`/`description`/`argument-hint` are absent from `BANNED_FRONTMATTER_KEYS` (`:29-38`) → **green**. A future `version:` on the command would correctly redden it.                                                                                                                    |
| U5 `:363`     | `walkFiles(PLUGINS_DIR)`                                                          | **scans the new file.** Needles are `.claude/skills/` and `.claude/hooks/` (`__fixtures__/scan-patterns.json`); the body has neither, and the `scripts/`-in-a-fence rule is vacuous (no fences) → **green**                                                                                                     |
| U6 `:385`     | `skillDirs()`                                                                     | **green — and this is a coverage gap**, see §2.7 and G-U6 below                                                                                                                                                                                                                                                 |
| U7 `:445`     | `plugin.json` keys                                                                | **green, conditionally**: it asserts `commands` is **not** a manifest key. Claude Code auto-discovers `commands/`, so **do not add one**. Current `plugin.json` declares none.                                                                                                                                  |
| U8 `:454`     | `plugin.json` + `marketplace.json`                                                | untouched → green                                                                                                                                                                                                                                                                                               |
| U12 `:475`    | `scriptFiles()` ← `skillDirs()`                                                   | **green** — commands ship no scripts; also a coverage gap                                                                                                                                                                                                                                                       |
| **T1 `:501`** | `walkFiles(SKILLS_DIR)` — _"no skill under plugins/ names an infra-kit MCP tool"_ | **green, and load-bearing.** The walk root is `SKILLS_DIR`, not `PLUGINS_DIR`. That scoping is the only reason a command may legally write `mcp__infra-kit__release-create`. Widening T1 to `PLUGINS_DIR` — an entirely reasonable-looking future tidy-up — would silently break the command's fallback clause. |
| T5 `:508`     | `walkFiles(PLUGINS_DIR)`                                                          | **scans the new file.** Denylist is three consumer-repo names; the body names none → **green**                                                                                                                                                                                                                  |

**Conclusion: nothing breaks — and that is the finding.** Three of the plugin's strongest guards (U6,
U12, T1) do not see `commands/` at all. §3 adds U13, U14 and T1b to close that, and T1b in particular
pins T1's scope so the tidy-up above turns a test red instead of a shipped command.

---

## 3. Test plan

Every criterion below is written so it **can fail**, with the mutation named (P-E / §6.0).

### 3.0 The standing rule for this document — and the evidence it was needed

**An AC is not accepted until its named mutation has been traced to the specific assertion it flips.**
Not "sounds like it would fail" — traced: _this mutation changes this value, which this assertion
compares, which then fails._ If the trace cannot be written in one sentence, the AC is not ready.

This is not a stylistic preference. **Three of round 3's blockers were ACs added in round 2, and two of
them failed exactly this rule:**

- **V10** asserted top-level key survival and array length over the _formable_ table. Three of its four
  rows had no keys and no arrays (`undefined`, `{}`) or compared 0 to 0 (`{releases:[]}`); the fourth
  emitted one key and one entry either way. Its named mutation — "reintroduce the fresh-object
  construction" — drops _nested_ fields, which V10 never looked at. **V10 could not fail.** It was
  added to prevent vacuous ACs and was one. Deleted.
- **F13** named a mutation on `readAcceptedArgs`'s wrap but drove a **single call**, and the
  `TypeError` it targets fires only on re-entry. **It passed identically with the wrap removed.**
  Respelled as two phases.

- **§2.3b's `canonicalArgs` reuse claim** is the third worked example, and it is not an AC — which is
  the point. _"Already supplies the stable traversal primitive"_ was accepted without tracing it to the
  thing it asserted: the function returns a **string**, its only walk (`sortKeysDeep`) is module-private,
  and comparing canonical forms would forbid the human's answer. **The rule applies to any load-bearing
  claim, not only to ACs** — and this one carried a size estimate (§2.3b, ~10 → ~15-18 lines) that fed
  D3, one of the three decision drivers.

Both ACs were caught downstream by review rather than at authorship, which is the expensive way. The rule
above is what authorship owes; §6.0's meta-guard is the backstop, not the substitute. **Where an AC's
trace depends on a fact about a dependency, measure the fact** — F13's respelling rests on a measured
result (`z.toJSONSchema` on a `.refine(async …)` object converts cleanly, no throw), not on the
inference that it probably would.

### 3.1 Unit — `«cli»/src/lib/tool-handler/__tests__/tool-handler.test.ts`

| #                                                       | Assertion                                                                                                                                                                                                                                                                                                                                                                                                                                | Mutation that must redden it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F0**                                                  | An **ungated** tool with a `formProvider` present and a form-capable client runs on call 1: handler entered once, no `inputRequired` returned, no gate payload.                                                                                                                                                                                                                                                                          | Delete state 0 / reorder it below state 1 → an ungated tool returns a form.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **F1**                                                  | Gated + provider + `{elicitation:{form:{}}}` → returns an `InputRequiredResult`; handler body **not** entered; and `Object.keys(requestedSchema.properties)` contains **no** `confirm`, of any type.                                                                                                                                                                                                                                     | Add `confirm: {type:'boolean'}` to the built schema → the key-set assertion fails.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **F2**                                                  | Gated + provider + **`{elicitation:{url:{}}}`** → no form; today's gate payload; handler not entered.                                                                                                                                                                                                                                                                                                                                    | Probe `caps?.elicitation` instead of `caps?.elicitation?.form`. **The url-only fixture is the only one that can discriminate** — `{elicitation:{}}` normalizes to `{form:{}}`, and the normalization is not folklore: `ElicitationCapabilitySchema` is a `z.preprocess` that maps an empty object to `{form:{}}` at `«cli»/node_modules/@modelcontextprotocol/server/dist/src-CX2iR2pK.mjs:755-757`. Both spellings pass that fixture; only url-only separates them.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **F3**                                                  | `inputResponses` present with `action:'decline'` → terminal `isError`; handler never entered; **exactly one** `inputRequired` produced across the exchange. Repeated for `'cancel'`, for `kind:'missing'`, and for a key named in `droppedInputResponseKeys`.                                                                                                                                                                            | Re-issue the form in state 2 → a second `inputRequired` comes back. Separately: discriminate on `acceptedContent(...)` being falsy → the decline re-prompts (PM-4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **F4**                                                  | Accept → gate payload whose `resolvedArgs` are the **form-collected** values, and whose `confirmToken` verifies against **those**.                                                                                                                                                                                                                                                                                                       | Mint the token over the round-1 guessed params → a round 2 carrying the collected values is refused as `mismatch`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **F5**                                                  | Gated, **no provider**, form-capable client → gate on call 1, zero `inputRequired`.                                                                                                                                                                                                                                                                                                                                                      | Drop `hasProvider` from candidate 1's condition → an empty form is emitted for the other seven gated tools (**PM-A**).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **F6**                                                  | A provider whose `buildRequestedSchema` rejects; one that exceeds the deadline; and one whose schema makes `inputRequired.elicit()` throw the `TypeError` of `«d.mts»:1405` → **all three** return the gate, no form, **no thrown error**, handler not entered. **The deadline lane asserts bounded elapsed time**: with a fake timer (or an injected clock) the call resolves within the budget + a small margin, asserted as a number. | Remove the deadline wrapper → the elapsed-time assertion **fails**, rather than the suite hanging until vitest's own timeout. _Corrected in round 1:_ the earlier spelling reddened by hanging, which is a worse signal than a failure (it looks like infrastructure flake, and under the recorded full-suite timing flakiness it would be triaged as one). Separately, un-wrap the `elicit()` call → the `TypeError` case surfaces as a tool error instead of a gate (**PM-B**).                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **F7**                                                  | Round 2 (`confirm:true`, `inputResponses === undefined`) reaches `verify`, not `gate`.                                                                                                                                                                                                                                                                                                                                                   | Drop `!confirmed` from candidate 3 → `verify` unreachable, the tool can never run (PM-5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **F8 (B1; fixture made concrete round 3)**              | **Fixture, stated exactly** — `releases: [{version:'1.64.0'}, {version:'next'}, {version:'1.66.0'}]`, all `type:'regular'`. Under a form-capable client with the release provider → **no form**; the gate carries **all three** entries; the `confirmToken` verifies against all three and **refuses** a round 2 carrying one.                                                                                                           | **Delete the `length === 1` check specifically, keeping absent/empty ∨ `hasNextToken`.** The weakened predicate then returns `true` here, the form fires, and the gate is minted over one entry. **The fixture's binding requirement is `length > 1` AND at least one entry carrying the `next` token** — `hasNextToken` is `entries.some(…)` (`next-version.ts:279-283`), so **position is irrelevant** and an earlier draft's "_second_ entry" was rhetorical, not a constraint. What _is_ a constraint is presence: a three-entry batch with **no** `next` leaves the weakened predicate `false`, the mutation invisible, and the AC vacuous — which is why the fixture is now spelled out rather than written `[A,B,C]`. The `next` sits second only to show the surviving token need not be the entry a form would edit. _Deleting the whole predicate is a strictly weaker mutation and is not the one named here._ |
| **F9 (B3)**                                             | An accept whose content **fails** the schema (wrong type, unlisted enum member) → the **gate**, carrying the **round-1** arguments, a distinguishable log line, **a gate `message` naming the values as failed-validation and discarded, and `formDiscarded: true` in `structuredContent`**. Never a second form.                                                                                                                        | Route a validation failure back to `form` → a second `inputRequired` (PM-4 through a second door). Skip `acceptedContent`'s schema overload → the bad value reaches `toArgs` and the `resolvedArgs` assertion fails. **Emit the unmodified gate message** → the message assertion fails. **Drop `formDiscarded`** → the structured assertion fails. _Both signal assertions are required: without them the gate presents the agent's guess for approval unlabelled, which is a whole-selection substitution and strictly worse than B1a's single-field one._                                                                                                                                                                                                                                                                                                                                                              |
| **F10**                                                 | A `toArgs` that throws, and one that returns `null` → the gate with round-1 arguments; **no** tool error.                                                                                                                                                                                                                                                                                                                                | Remove the call-site wrap → the throw escapes via `tool-handler.ts:161-168`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **F11 (B1a)**                                           | Round 1 `{releases:[{version:'next', type:'hotfix', description:'urgent auth patch'}]}`; the human accepts supplying **only** `version:'1.63.1'`, fed through `JSON.parse(JSON.stringify(content))`. The gate's `resolvedArgs` must carry `type:'hotfix'` **and** `description:'urgent auth patch'` **and** `version:'1.63.1'`, and the `confirmToken` must verify against exactly that.                                                 | **Replace the merge with a fresh-object construction** in `toArgs` → `type` comes back `regular` (or absent) and the description is gone, so a hotfix would be cut from `dev`. A second lane: the human explicitly picks `type:'regular'` → `regular` must win, proving the merge is not simply "round-1 always wins" (§2.7a). _The JSON round-trip pins the shape the wire actually produces, and makes the `undefined` filter visibly a belt rather than the thing holding this AC up — which is the correct relationship (§2.5a)._                                                                                                                                                                                                                                                                                                                                                                                     |
| **F12 (§2.3b)**                                         | The non-narrowing check, exercised with a **deliberately malicious provider** whose `toArgs` is driven through **four** shapes — drops a key, **shortens** an array, **grows** an array, and returns a **non-record** — each yielding the **gate with round-1 arguments**, a token that verifies against those, and a handler that never sees the mutated form. Asserted with a **generic** fake tool, no releases anywhere.             | Delete the key-presence half → the dropped key survives to the token. Change `!==` back to `<` → the **grown** array survives, injecting an entry the caller never supplied; this is the silent one, since it stays schema-valid and executes. Collapse the split guard back to a single `return false` on either non-record → the non-record survives (loud, not silent: `z.object` rejects it on round 2, so it fails closed). _This AC removes the truncation and growth classes; it does NOT cover nested removal or equal-length substitution (§2.3b), for which the merge in `toArgs` is the only guard. V5 only tests that one provider intends well._                                                                                                                                                                                                                                                             |
| **F13 (round-2 MAJOR, respelled round 3 — TWO phases)** | A `buildRequestedSchema` returning an object with `.refine(async …)`. **Phase 1** (no `inputResponses`): returns an `InputRequiredResult` — the form is emitted normally. **Phase 2** (re-entry with `inputResponses` carrying `action:'accept'`): the **gate** with round-1 args, `formDiscarded: true`, **no thrown error**, handler not entered.                                                                                      | **Named against phase 2 only:** remove the wrap around `readAcceptedArgs` → `acceptedContent`'s `TypeError` (`«d.mts»:1468-1470`) escapes via `tool-handler.ts:161-168` as a tool error where a gate was owed. _The earlier single-call spelling asserted phase 1's outcome and **passed identically with the wrap removed** — an async refinement is not a wire-shape violation, so `elicit()` (`«d.mts»:1405`) does not throw and round 1 never reaches `acceptedContent`. Measured, not inferred: `z.toJSONSchema` on a `.refine(async …)` object returns a clean schema and throws nothing (zod 4.5.2, this repo's install). §3.0._                                                                                                                                                                                                                                                                                   |

**Must stay green, unmodified:** all **18** existing cases at `tool-handler.test.ts:86-339` (the file
is 349 lines) — the seed lane (5 cases, `:86-142`), the gate lane (5, `:159-223`), and the whole
token-binding lane (8, `:258-339`). _An earlier draft said "21 … `:258-350`"; both were wrong and are
corrected here._ Also
`«cli»/src/mcp/__tests__/mcp-confirm-gate-mutation.test.ts`, which neuters `requiresHumanConfirm === true`
at build time (see the comment at `tool-handler.ts:44-45`) — the added states must not give it a second
path to green.

### 3.2 Unit — `«cli»/src/commands/release-create/__tests__/release-form.test.ts` (new)

| #                             | Assertion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Mutation                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **V1**                        | Known `[1.63.0, 1.63.2]`, `regular` → the offered enum contains `1.64.0`; `hotfix` → contains `1.63.3`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Swap the type argument → both expectations fail.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **V2**                        | `loadExistingVersions` resolving `[]` → `buildRequestedSchema` returns `null` and **does not reject**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Call `computeNextVersion` without `trySuggestNext` → `NoPriorVersionsError` (`next-version.ts:62-65`) escapes and the promise rejects.                                                                                                                                                                                                                                                                                                                                                |
| **V3**                        | `toArgs({version:'1.64.0', type:'regular'})` produces a value that **parses** against `z.object(releaseCreateMcpTool.inputSchema)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Rename `version`→`ver` in `toArgs`, or drop the array wrapper → `releases` fails `.min(1)` / the exactly-one-of `refine` (`release-create.ts:456-463`).                                                                                                                                                                                                                                                                                                                               |
| **V4**                        | The provider performs **no** `process.exit` and no inquirer prompt: a spy on `process.exit` records zero calls.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Reuse `promptForVersionInput` (`release-create.ts:74-93`) inside the provider → the spy fires on the empty-answer path.                                                                                                                                                                                                                                                                                                                                                               |
| **V5**                        | `isFormable` is `true` for `undefined`, `{}`, `{releases:[]}` and `{releases:[{version:'next'}]}`; `false` for a 2-entry batch, a **3-entry batch whose second entry is `{version:'next'}`**, `{releases:[{version:'1.64.0'}]}` and `{releases:[{name:'checkout-redesign'}]}`.                                                                                                                                                                                                                                                                                                                                                                                   | Drop the `length === 1` conjunct → the 3-entry `next` case flips to `true` (§2.3a). _The 3-entry case is the load-bearing row; a table without it passes against the insufficient predicate._                                                                                                                                                                                                                                                                                         |
| **V6 (re-targeted, round 2)** | `isFormable` returns `false` — and does **not throw** — on `undefined` and `{}` (both **reachable**: `releases` is required by the tool schema but `isFormable` is also called from unit tests and from any future non-MCP caller, where nothing has parsed).                                                                                                                                                                                                                                                                                                                                                                                                    | Reach into `params.releases.length` without a presence check → a `TypeError` on both. **Two rows deleted:** `{releases:'next'}` and `{releases:[null]}` were **unreachable in production** — the SDK validates `inputSchema` before the callback runs (`«d.mts»:3448`; §2.5), so they can never arrive. A guard whose target cannot occur is the vacuous-AC failure this repo has a recorded history with, and keeping it because it looks defensive is how that history was written. |
| **V7 (B1a)**                  | The schema `buildRequestedSchema` returns has **no** `default` on any field, at the zod level **and** in its emitted JSON Schema: `Object.values(shape).every(f => !(f instanceof z.ZodDefault))`, and the JSON Schema carries no `default` key.                                                                                                                                                                                                                                                                                                                                                                                                                 | Restore `.default('regular')` on `type` → both halves fail. _Both halves are needed:_ the zod check alone misses a `default` injected when the schema is converted for the wire, and the JSON-Schema check alone misses one that only affects server-side parsing.                                                                                                                                                                                                                    |
| **V8 (B1a)**                  | `toArgs` is a **pure merge**: for every field, `result[f] === content[f]` when `content[f] !== undefined`, else `result[f] === base[f]`. Asserted over a table including the all-untouched case (result deep-equals `base`) and, separately, an **own-`undefined`** case (`{type: undefined}` must NOT clobber `base.type`). Wire-shaped rows go through `JSON.parse(JSON.stringify(content))`.                                                                                                                                                                                                                                                                  | Spread in the other order (`{...supplied, ...base}`) → the human's explicit change is discarded, which V8's "explicit `regular`" row catches and F11's first lane does not. Drop the `undefined` filter → only the own-`undefined` row fails, which is the correct blast radius: it is a totality defect, not a wire hazard (§2.5a).                                                                                                                                                  |
| **V9 (round 2)**              | The tool's entry `.transform` (`release-create.ts:463-471`) is **idempotent**: `transform(transform(x))` deep-equals `transform(x)`, over a table covering a version entry, a `next` entry, a named entry, and each with and without `description`.                                                                                                                                                                                                                                                                                                                                                                                                              | Make the transform non-idempotent (e.g. have it wrap `description` a second time) → the assertion fails. _Without this, §2.5a's merge silently rests on an unstated property: `base` is already transformed (`«d.mts»:3448`), so re-emitting it runs the transform twice._                                                                                                                                                                                                            |
| ~~**V10**~~                   | **DELETED in round 3.** It asserted top-level key survival and array length over the _formable_ table, where three of four rows are vacuous (`undefined` and `{}` have no keys and no arrays; `{releases:[]}` compares 0 to 0) and the fourth emits one key and one entry under both the merge and the fresh-object construction. **Its named mutation could not flip it** — fresh construction drops _nested_ fields, which V10 never inspected. It covered nothing F12 (chokepoint enforcement, adversarial provider) and V8 (field-by-field merge, real provider) do not already cover, and it was the exact vacuous-AC defect it was added to prevent. §3.0. |

### 3.3 Unit — `plugins/infra-kit/__tests__/manifest.test.mjs` (added)

- **U13** — the file list under `plugins/infra-kit/commands/` equals `['release-create.md']` exactly.
  _Red:_ add a second command without updating the literal.
- **U14** — the command's frontmatter key set equals exactly `{name, description, argument-hint}`;
  `name` equals the filename stem; and the body has **exactly 3 non-empty lines**. _Red:_ add a 4th
  key, rename the file, or add a fourth instruction line.
  **The ≤10-line slack is removed at the assertion level, deliberately.** ≤10 is the _decision_ (the
  user's surface budget) and it stays recorded in §2.7; asserting it against a 3-line body leaves 7
  lines of drift that no test would notice — a command could double in length and stay green, which is
  precisely the rot Decision 2 exists to prevent. The budget documents intent; the assertion pins
  reality. A deliberate 4th line is a one-character test edit and a visible diff, which is the point.
- **T1b** — asserts both halves of the boundary: T1's corpus is `walkFiles(SKILLS_DIR)`, **and**
  `commands/release-create.md` **does** contain `mcp__infra-kit__`. _Red:_ widen T1 to `PLUGINS_DIR`
  → T1 and T1b become mutually unsatisfiable and both go red, instead of the command silently losing
  its fallback clause (§2.8).
- **G-U6** — recorded as a **known gap, not closed here**: U6 and U12 do not cover `commands/`. Closing
  them is a named follow-up (§5), not scope. Stated so a reader does not mistake silence for coverage.

### 3.4 Integration — `«cli»/src/mcp/__tests__/server.test.ts`

- **I1** — `initializeResources` registers `infra-kit://workflow/release-create` with
  `mimeType: 'text/markdown'` and a body **byte-identical** to `WORKFLOW_BODIES['release-create']`.
  _Red:_ register a hand-typed string instead of the constant.
- **I2** — `initializePrompts` registers exactly one prompt, named `release-create`, whose text is
  **byte-identical** to the same constant. _Red:_ fork the prose into a second literal → I1 and I2
  can no longer both pass.
- **I3 (the partition, generalized from §6.2 R6)** — partition the declared prompt names against
  `getExposedMcpTools()` (`command-catalog.ts`) and assert **equality of both halves**:
  `names.filter(n => exposed.has(n))` deep-equals `['release-create']`, `names.filter(n => !exposed.has(n))`
  deep-equals `[]`, and `names.length === 1`. _Red:_ rename the prompt → the first half loses its
  member and the second gains one, so **both** assertions fail. Asserting only a size, or only that
  `release-create` is a tool name, would survive that rename.
- **I4** — the rendered body's line count is a stable number, asserted as a number. _Red:_ prettier
  reflows the file. **Deliberately not** an assertion that the file is prettier-clean — prettier owns
  these bytes (§2.6).
- **I5 (B4) — the prompt is actually fetchable.** `prompts/get` for `release-create` **with
  `arguments` omitted entirely** resolves, and its message text is byte-identical to the constant.
  _Red:_ register the prompt with a bare `z.object({version: z.string()})` argsSchema → the omitted-
  `arguments` call throws and I5 fails. This is the AC the earlier draft lacked: I1/I2/I3 assert name,
  bytes and partition, and **every one of them passes against a prompt that cannot be fetched**,
  because none of them fetches it. A second lane calls `prompts/get` **with** a stray `arguments`
  object and asserts it also resolves — an argsSchema-free prompt must ignore, not reject.
- **I6** — `prompts/list` returns exactly one entry and its `arguments` field is absent or empty,
  pinning the §2.6 decision as an assertion rather than a paragraph. _Red:_ add an argsSchema later
  without revisiting the recorded asymmetry.

### 3.5 E2E — `«cli»/src/mcp/__tests__/mcp-stdio.e2e.test.ts`, spawned children against the built bundle

**CORRECTION (round 1) — the helper must answer, not merely declare (B5).** An earlier draft specified
`connectElicitationCapable()` as "a client declaring `{elicitation:{}}`" and stopped there. That client
hangs on E-A leg 2. On this server's measured 2025-11-25 connection an `inputRequired` **return** is
_"fulfilled by the default-on legacy shim"_ (`«d.mts»:2955-2959`), i.e. it becomes a real server→client
`elicitation/create` **request** that the client must answer; the shim's own gate consults the
initialize-declared capabilities, and a per-request instance that never saw an initialize _"holds
nothing, so gates refuse there"_ (`«d.mts»:2970-2975`). The existing clients declare `capabilities:{}`
(`mcp-stdio.e2e.test.ts:103`, `:141`) and register **no** request handler, so they can neither trigger
the shim nor respond to it.

The helper therefore (a) declares `{elicitation:{}}` at construction and (b) **registers an
`elicitation/create` request handler** returning a scripted `{action:'accept'|'decline'|'cancel',
content?}`, per lane. It is added beside `connectV2` (`:140`). The era itself is not a defect — M1
established that `inputRequired` works on the unchanged 2025 wire, and the shim is why.

_Red for the helper itself:_ a lane whose scripted handler is removed must **time out**, not silently
pass — so each lane asserts a completed round trip, never merely "no error".

**Sweep status, stated honestly (round 3): the E-lanes were NOT covered by the reviewers' AC sweep.**
The unit and integration rows were; these were explicitly left unswept. Rather than let that read as
cleared, §3.0's rule is applied to them here — and it found two defects, both in E-A.

- **E-A (positive, three legs; repaired round 3)** — a form-capable client calls `release-create` with
  `releases:[{version:'next', type:'hotfix'}]`. Leg 1: the tee log shows **exactly one**
  `elicitation/create` frame, **and that frame's `requestedSchema.properties` key set equals
  `{version,type,description}` and carries no `default` on any property.** Leg 2: an accept supplying
  only `version` returns `status:'confirmation_required'` with a `confirmToken`, and `resolvedArgs`
  carries **`type:'hotfix'`** — the merge, observed on the wire. Leg 3: `confirm:true` + that token +
  those args reaches the handler.
  _Red, traced per §3.0:_ **leg 1** — add a `default` to the schema and the no-`default` assertion
  flips (the wire-level counterpart of V7, which only inspects the zod object). _A capability-probe
  mutation was listed here until round 3 and is deleted: E-A's own client declares the capability, so
  removing the gate leaves the count at 1 and it cannot flip. It belongs to E-B, where it already is._ **Leg 2** — replace the merge with fresh
  construction and `resolvedArgs.type` reads `regular`, flipping that assertion. **Leg 3** — mint the
  token over round-1 args and `verify` refuses.
  _Two defects this trace found:_ the earlier spelling said only _"Red: any of the three legs"_, which
  names no mutation at all; and it asserted a frame **count** but nothing about the frame's **content**,
  so a form with the wrong fields — or with a default that a client's `applyDefaults` would fill —
  passed it. Both are now assertions.
- **E-B (negative, unchanged clients)** — `connectV2` (no capabilities) calls `release-create` with the
  **formable** fixture `releases:[{version:'next'}]` (a batch would leave the mutation invisible, F8's
  lesson) → **zero**
  `elicitation/create` frames and the gate on call 1. **This lane exists in substance today and must
  stay green unmodified** — it is the proof the increment is additive.
  _Red:_ delete the `canForm` conjunct from candidate 1 → a frame appears on the tee log and the count
  assertion flips. Per §1.3a this is not merely cosmetic: the shim would surface a capability violation.
- **E-C (decline)** — a form-capable client calls `release-create` with the **formable** fixture
  `releases:[{version:'next'}]`; one `elicitation/create`, then a terminal `isError`, then **no second**
  `elicitation/create` on the tee log. The wire-level counterpart of F3.
  _Red:_ re-issue the form from candidate 2 → a second frame appears and the "exactly one" assertion
  flips.
- **E-D (bundle + PM-C detector)** — `resources/list` **on the built bundle** contains
  `infra-kit://workflow/release-create`, and `resources/read` returns non-empty `text/markdown`.
  _Red:_ replace the static `?raw` import with a glob or dynamic `import()` → the specifier survives
  into `dist` and the read fails on the consumer path (`agent-guidance/resources.ts:2-7`).
- **E-E (ungated, wire level)** — a form-capable client calls a **non-gated** tool (`version`) → zero
  `elicitation/create` frames, real result on call 1. The wire counterpart of F0/F5.
  _Fixture:_ `version`, which takes no arguments and is not gated.
  _Red:_ delete **candidate 1's `gated` conjunct** → `version` reaches candidate 1 and a frame appears
  for a tool that should never form (PM-A), flipping the count assertion. _The two mutations listed
  here until round 3 could not flip it: `run` is the fallthrough return and candidates 1-4 all require
  `gated` (`tool-handler.ts:43-49`), so an ungated `version` emits zero frames either way. Deleting
  candidate 0 removes the trailing `return 'run'`, which is a tsc error, not a red test._

**E-lanes are independent of R-CAP.** The e2e client is this repo's own, so its capability declaration
is a fixture we control; these lanes prove the _mechanism_ on the legacy wire (§1.3a) and say nothing
about whether Claude Code declares the capability. Recorded so a green E-A is not mistaken for R-CAP
being resolved.

**Baselines that change, and must be reviewed as content rather than regenerated:**
`«cli»/src/mcp/__tests__/fixtures/resources-list-baseline.v1.json` gains one URI.
`initialize-baseline.v1.json` — _unverified_ whether registering the first prompt alters
`capabilities.prompts` (the D1 row already tracks `{}` → `{listChanged:true}` across eras); if it does,
the diff is one key and must be asserted, not accepted. `tools-list-baseline.v1.json` **must not
change** — no tool's `inputSchema` is touched by this increment.

### 3.6 Observability

Two `logger.info` lines in `tool-handler.ts`, siblings of the existing
`Tool execution gated (awaiting confirm)` (`:141`) and `Tool execution refused (…)` (`:150`):

- `Tool execution form requested: <tool>` — emitted on entering state 1 with a non-null schema.
- `Tool execution form declined (<action>): <tool>` — emitted on entering state 2, carrying the
  discriminated `action`.

Destination: the same pino stream the MCP server already writes to (stderr for a stdio server).
**Asserted by a spy in the unit tests, never by grepping stderr** — a stderr grep would couple the
assertion to the transport's framing. _Red:_ delete a line → the spy's call count drops.

### 3.7 Gate

`pnpm run qa` from the repo root, green, with `eslint-check` run **cold** (`--no-cache`) at least once —
a cached run can exit 0 while a cold run finds real errors — and `git status` checked for untracked
`??` files before calling it done. sonarjs cognitive-complexity ≤ 15 on `resolveGateState` and on the
new `buildArgumentForm`. `tsc` is the one that catches what vitest misses, notably the
`ToolsExecutionResult | InputRequiredResult` widening.

---

## 4. Pre-mortem — four scenarios specific to this increment

These are **not** §5's PM-0..PM-6. Those remain in force; these are what this increment adds.

### PM-A — The form is generic, so seven tools get an empty one

_How it happens._ The user accepted that the chokepoint form lights up all 8 gated tools. State 1's
condition is written with `canForm` but the author forgets `hasProvider` — or a later refactor drops it
as "redundant". `worktrees-remove`, `local-deploy-all` and five others now emit an `inputRequired` whose
`requestedSchema` has no properties. A form-capable client renders an empty dialog with an OK button; the
human clicks it having been told nothing; the gate then fires as normal. **Nothing errors.** The failure
is a dialog that trains the user to click through, which is the exact habit the gate depends on them not
having.

_Detection._ **F5** at unit level, and **E-E** on the wire: a form-capable client calling a gated
provider-less tool must produce **zero** `elicitation/create` frames on the tee log. A frame count of
zero is the only assertion that cannot be satisfied by an empty-but-present form.

_Mitigation._ `hasProvider` is part of state 1's condition, written in full per §2.3's discipline, and
F5 names its deletion as the mutation. Additionally: only `release-create` carries a provider in this
increment, so the blast radius until a second one is added is exactly the assertion.

### PM-B — The form waits on the network and the call hangs

_How it happens._ `buildRequestedSchema` calls `loadExistingVersions()`, which is two network round
trips: `git ls-remote --heads origin 'release/v*'` (`load-existing-versions.ts:42`) and a Jira HTTP
fetch (`:47-57`). They are `Promise.allSettled`-wrapped, so neither _fails_ the call — they just take
as long as they take. On a slow remote, a VPN-less laptop, or an SSH key prompt, `tools/call` returns
nothing at all: no form, no gate, no error. The agent sits. The prior design never had a network call
inside the gate path, so this hazard is new to this increment.

_Detection._ **F6** — a provider whose `buildRequestedSchema` never resolves must produce a gate within
the deadline; without the wrapper that test times out rather than failing, which is itself the signal.
In production: the `Tool execution form requested` log line with no matching `gated`/`form declined`
line within the deadline window.

_Mitigation._ State 1 races the provider against a fixed deadline (proposed 3 s) and treats
timeout, rejection and `null` identically: fall to state 3, log, gate. **P-B by construction** — a form
that cannot be built on time is simply not offered, and the user gets today's behavior. The
`NoPriorVersionsError` case (`next-version.ts:77`) rides the same path via `trySuggestNext`
(`release-create.ts:40-48`), which is why V2 asserts `null` rather than a rejection.

### PM-C — The command and the resource ship in different release units

_How it happens._ `plugins/infra-kit/` reaches a user through the marketplace entry, which sources
`./plugins/infra-kit` **from git** and deliberately pins **no version** — asserted at
`manifest.test.mjs:460`, inside the U8 test that opens at `:454`. `infra-kit://workflow/release-create`
reaches them through the separately published npm package (`«cli»/package.json:2,4` — `infra-kit`,
`0.4.0`, shipping `files: ["dist"]` at `:5`), under the lockstep bump → publish config → re-pin →
publish cli sequence. **These are two clocks, and they run at different speeds:** merging E reaches
every consumer on their next plugin sync, while D reaches them only when they next update a _global_
npm install. So the broken window is not an edge case — **it is the default for every user**, for
however long they go without updating the CLI. A user in it gets a command whose entire first
instruction is to read a resource that does not exist. Because §2.6 removed the prose from the command
body (Decision 2, PM-1), the command has **nothing else to say**. This is P1 — "procedure text ships in
the same versioned unit as the tools it names" — inverted by the very decision that protects against
rot.

_Detection._ **E-D** pins the server half: the URI must be present in `resources/list` on the **built
bundle**, so a body that fails to inline never reaches a publish. The client half has no automated
detector and is honestly labelled **manual**: install the plugin against a CLI one minor behind and
confirm the fallback clause fires.

_Mitigation, now a mechanism rather than a rule._ An earlier draft said only _"E must not merge before
D is published"_ — prose with no enforcer, which is the same defect B1 exposed in §2.5. Three parts:

1. **The command body's fallback line** — `call the mcp__infra-kit__release-create tool directly and
let its confirm gate drive the rest` — is why the body is three lines rather than one. Under a
   missing resource the user still gets a working, gated release-create: they lose the procedure, not
   the operation.
2. **A version floor stated in that same line**, naming the first CLI version that serves the resource
   (`requires infra-kit ≥ <x.y.z>; if the resource is missing, your CLI is older — …`). It converts a
   silent 404 into a message that names the fix.
3. **A CI check gating PR E**: `npm view infra-kit@latest version` must be ≥ the floor **and** a
   spawned `npx infra-kit@latest mcp` must answer `resources/list` with
   `infra-kit://workflow/release-create`. _Red:_ run it before D publishes → the check fails and E
   cannot merge. This is the only part that actually enforces the ordering; 1 and 2 are what make the
   residual window survivable rather than confusing.

This is also the reason **T1b** exists: T1's `SKILLS_DIR` scoping is what permits the fallback line to
name the tool at all, and a future widening would delete the mitigation while every test stayed green.

### PM-D — The dialog appears for one tool in eight, and its absence reads as safety

_How it happens._ Nothing goes wrong. PR C ships exactly one provider, and PM-A's mitigation
**guarantees** the other seven gated tools show nothing — that is the design, working. But a user who
cuts three releases through `/infra-kit:release-create` learns, correctly, that _infra-kit asks me
before it does this_. Then they run `local-deploy-all` or `worktrees-remove`. No dialog appears. The
learned rule says "no dialog ⇒ nothing is about to happen", and the true rule is "no dialog ⇒ this tool
has no provider, and it is about to mutate cloud infrastructure behind a gate the model answers." The
gate is still there and still works; what has degraded is the user's model of what its absence means.
**This is the cost of the accepted decision that the form is generic but the providers are not** — and
it is a cost the increment creates, not one it inherits: before PR C, no infra-kit tool ever showed a
dialog, so there was no asymmetry to misread.

_Detection._ **None automated, and that is the honest form of this row.** A habituation failure has no
test: every assertion in §3 passes in exactly the world where PM-D is happening, because PM-D _is_ the
specified behavior being learned wrongly. There is no log line for a user's inference. Claiming a
detector here would be worse than admitting there is none — it would be a green light on an unmonitored
lane. The nearest real signal is a support report ("I didn't get asked, so I thought it was a dry run"),
which arrives after the deploy.

_Mitigation — one of two, and the choice is the user's._ Both are honest; they differ in cost.

- **(a) Say it in the gate.** For a gated tool with **no** provider, `buildConfirmGate`'s `message`
  (`tool-handler.ts:81`) gains one clause: _"This tool does not prompt for its arguments; you are being
  asked to approve the values shown above."_ Cost: one string, one assertion (a unit AC that a
  provider-less gate's message differs from a provider-backed one; _red:_ emit one message for both).
  It removes the asymmetry's silence without removing the asymmetry.
- **(b) Close the asymmetry.** Providers for the remaining seven gated tools. **If this is chosen it
  needs a date, not an aspiration** — an undated "we'll add the rest" is exactly how a one-of-eight
  asymmetry becomes permanent. Proposed: the two deploy tools (`local-deploy-all`,
  `local-deploy-selected`) within one release of PR C, the rest within three.

**Recommendation: (a) now, unconditionally, because it is nearly free and works even if (b) never
happens; (b) as a dated follow-up.** (a) is written into PR C's scope below.

---

## 5. PRs — thin, independently shippable

| PR    | Content                                                                                                                                                                                                                                                                                                                                                                                                            | Depends on                                                 | User-visible change                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **A** | Seams only. `ArgumentFormProvider` (with `isFormable` and the `toArgs` contract) on `McpTool` (`types.ts`) and `CatalogMcpTool` (`command-catalog.ts`); forward `formProvider` + `getClientCapabilities` at `mcp/tools/index.ts:49-53`; **bind `ctx` in the returned closure** (`tool-handler.ts:112` currently drops it); widen the return to `ToolsExecutionResult \| InputRequiredResult`. No provider defined. | — (PR 1 landed)                                            | **none**                                                                                                      |
| **B** | Candidates 1 and 2, the capability probe, `buildArgumentForm` (deadline race + `elicit()` `TypeError` catch), `readAcceptedArgs` (accept detection + schema validation + fall-back-to-round-1, **wrapped**), **the §2.3b non-narrowing check**, the `toArgs` call-site wrap, the extended gate message, the log lines. Still no provider in the tree.                                                              | A                                                          | **none in production**; fully exercised by injected fakes (F0–F13)                                            |
| **C** | `release-form.ts` (`isFormable`, `buildRequestedSchema` with **no defaults**, merging `toArgs`) + `formProvider` on `releaseCreateMcpTool`; export `trySuggestNext`; **PM-D mitigation (a)** — the provider-less clause in `buildConfirmGate`'s message.                                                                                                                                                           | B, **and R-CAP measured** (§1.3a)                          | **first form** — `release-create` under a form-capable client, plus a clearer gate message on the other seven |
| **D** | `resources/workflow/release-create.md`, `src/mcp/workflow-bodies.ts`, resource + prompt registration (no `argsSchema`).                                                                                                                                                                                                                                                                                            | — (independent of A–C)                                     | a new resource and the server's first prompt                                                                  |
| **E** | `plugins/infra-kit/commands/release-create.md` incl. the version floor; U13, U14, T1b; **the PM-C CI check**.                                                                                                                                                                                                                                                                                                      | **D, published** — enforced by that check, not by this row | `/infra-kit:release-create`                                                                                   |

Two independent chains — A→B→C and D — meeting only at E. Each of A, B and D is mergeable alone and
green alone. E's dependency on D is on the **published** package, not the merged commit, and PM-C's CI
check is what enforces it; this table row is documentation of that check, not a substitute for it.

**Only PR C is contingent — independently verified, not merely asserted.** D touches only
`mcp/resources/index.ts` and `mcp/prompts/index.ts` (stub at `prompts/index.ts:3`); E is one markdown
file plus three manifest ACs; **neither imports `tool-handler.ts`.** A and B are genuinely inert with no
provider in the tree, because candidate 1 requires `hasProvider` and candidate 2 requires
`responses !== undefined` — both unreachable until C. Without C, D+E still deliver procedure prose plus
a gated tool call, which beats today's improvisation. So if R-CAP (§1.3a) resolves negative the loss is
one held PR, and §1.3a's stated decision rule takes over rather than a fresh argument.

**Follow-ups, not PRs.** Undated unless stated:

- Close **G-U6** (extend U6 and U12 to walk `commands/`).
- The remaining five PR-3 bodies.
- Migrate the capability probe from `getClientCapabilities()` to `ctx.mcpReq.envelope` when this server
  serves the 2026 era by default (§2.4).
- **Give the prompt a `version` argument**, which requires treating the bare-`z.object`/`.default({})`
  hazard §2.6 avoids. Until then the prompt and the command are not equivalent channels.
- **Extend the form's reach past one-entry-`version`** — batches, named releases, explicit semvers.
  §1.3 records that Option 4's coverage advantage compounds if this never happens.
- **PM-D mitigation (b)** — providers for the remaining seven gated tools. **Dated if adopted:** the
  two `local-deploy-*` tools within one release of PR C, the rest within three. Adopting it undated is
  explicitly not an option (§4 PM-D).

---

## 6. ADR

**Decision.** Collect `release-create`'s arguments from the human with an MCP elicitation form built by
a per-tool `ArgumentFormProvider` declared on the catalog tool and consumed by a domain-blind state
machine in `tool-handler.ts`; keep the two-call `confirm:true` + HMAC-token gate exactly as it is; and
ship a ≤10-line plugin command whose body defers to a new `infra-kit://workflow/release-create`
resource registered from the same constant as a same-named prompt.

**Drivers.** D1 — the question must leave the agent, and only the server can compute real candidate
versions. D2 — no new authorization surface; §0.12's fix stands untouched. D3 — small, independently
shippable diffs under a sonarjs ≤ 15 ceiling.

**Alternatives considered.** (2) a form registry keyed by tool name under `src/mcp/` — rejected: it
moves the domain knowledge one directory over without removing it, and severs the pairing from the
catalog's coverage test. (3) no elicitation, procedure inline in the command body — rejected on D1 and
on the user's Decision 2. (4) a read-only `release-plan` tool feeding the agent's own question —
rejected on D1: the human-facing question would still be authored by the model.

**Conditional on R-CAP (§1.3a).** No host the user actually runs is _measured_ as declaring
`elicitation.form`; the declaration is not recoverable from any existing artifact, and the changelog
evidence establishes that the host **renders** elicitation, not that it **declares** the capability.
Option 4 works unconditionally where Option 1 does not. The choice is not reversed, because the PR
structure confines the contingency to PR C alone — but PR C does not merge until the probe is
instrumented and confirms, and §1.3a states in advance what happens if it does not.

**Why chosen.** The provider field travels the road `requiresHumanConfirm` already travels — declared
on `McpTool`, mirrored on `CatalogMcpTool`, forwarded at the single `registerTool` site — so it is an
existing, enforced pattern rather than a new one. The chokepoint learns two booleans and no nouns. The
`.md?raw` resource slice reuses infrastructure that is already wired and already has a live consumer,
so the one genuinely new thing in the whole increment is the two elicitation states.

**Consequences.** The form schema carries **no defaults**, at the zod level or on the wire, and
`toArgs` merges rather than constructs (§2.5a) — without both, an untouched form field silently
overwrites a `--hotfix` with `regular` and cuts the release from the wrong branch. The tool's own
`.default('regular')` (`release-create.ts:451`) is unaffected and must stay. A **domain-blind
non-narrowing check** at the chokepoint (§2.3b) makes **top-level key removal and array truncation**
structurally impossible — a ceiling no legitimate form can need relaxed — which demotes `isFormable`
for that class alone. It does **not** cover nested key removal or equal-length value substitution,
where `toArgs`'s merge is the only control; so every future provider owes a V8-equivalent of its own,
and the plan says so rather than claiming cover it does not have. Both schema
helpers are wrapped, because `acceptedContent` and `elicit` carry the _same_ throw hazard and wrapping
one of a matched pair is this document's recurring near-miss. `tool-handler.ts`
grows two candidate states and **two** helpers
(`buildArgumentForm`, `readAcceptedArgs`), with the complexity budget re-derived against that split
(§2.3). The return type widens, which `tsc` will surface at the registration site. Seven other gated
tools become _capable_ of forms without gaining one — a deliberate, tested-for no-op (F5, E-E) whose
**user-facing cost is PM-D**, mitigated by a clause in the provider-less gate message. The form's reach
is deliberately narrow — one entry, `version` only — and `isFormable` **enforces** that narrowness
rather than asserting it (§2.3a); the price is that D1 is only partly satisfied and Option 4's margin
narrowed (§1.3). The server acquires its first prompt, deliberately argument-less, so the two channels
are not equivalent (§2.6). A deprecated SDK accessor enters the codebase behind a one-line seam, with
its migration stated. And the command becomes dependent on the published CLI shipping a resource —
PM-C, whose broken window is the **default** for a user who has not updated, mitigated by a fallback
clause, a version floor, and a CI check.

**Follow-ups.** As listed in §5 — G-U6; the five remaining bodies; the envelope migration; a `version`
argument on the prompt; the form's reach past one entry; and PM-D mitigation (b), dated if adopted.
Separately: reconsider `oneOf` in `requestedSchema` — and therefore named releases in the form — once
a client's rendering of it has actually been measured.

---

## 7. Must-fix at implementation — the conditions of approval

The round-3 consensus verdict is **APPROVE, conditional on these six edits**. They are carried
forward verbatim from the reviewing Critic. Every one is sub-line; none is architectural. They are
conditions, not suggestions: the approval does not hold without them.

1. **§2.3b:550 — `<` → `!==`.** Reword `:525` to match, name array **growth** in the residue, and add
   a growth row to F12's mutations. _Why:_ `after[key].length < value.length` catches only shortening
   while `:525` claims _"same length"_, so a provider emitting two entries where the caller supplied
   one passes the check, mints a clean token over an **injected** release, and **executes**. This is
   the silent one — it stays schema-valid all the way through round 2.
2. **§2.3b:545 — split the guard.** `!isRecord(before)` → `false`; `before` a record ∧ `!isRecord(after)`
   → `true`. _Why:_ as written the function reports "no narrowing" on total narrowing. `null` is dead
   at this call site (§2.4's contract and F10 route it to the gate first), but a non-null non-record
   is reachable via exactly the type violation this check exists to police, and **F12 does not catch
   it** — its adversarial provider drops a key and shortens an array, a record both times. Measured as
   failing **closed** (`z.object` rejects `[]`, `'str'`, `42`, `null`, so the wreckage cannot survive
   round 2) — fix it, but rank it below growth.
3. **§3.5 E-A leg 1 — delete the capability-probe mutation.** It is vacuous on a form-capable client:
   E-A's own client declares the capability, so removing the gate leaves the frame count at 1 and the
   mutation cannot flip. It belongs to E-B, where it is already correctly placed. Keep leg 1's
   no-`default` mutation.
4. **§3.5 E-E — replace both mutations.** Neither flips the frame-count assertion: `run` is the
   fallthrough return and candidates 1–4 all require `gated` (`tool-handler.ts:43-49`), so an ungated
   `version` emits zero frames either way. The only mutation that emits a frame for `version` is
   deleting candidate 1's `gated` conjunct.
5. **§3.5 E-B and E-C — state the fixture.** Both mutations need formable arguments to fire; a batch
   call leaves them invisible. This is F8's lesson recurring one section down.
6. **§2.4 docblock — `"**It** is load-bearing for NOTHING ELSE"` → `"The check is…"`.** The
   grammatical antecedent currently reads as `isFormable`, which reverses §2.3b's conclusion in the
   one artifact a provider author actually reads.

**The pattern these close, stated once.** Items 1 and 2 are the same defect in opposite directions:
`narrowsArgs` implements something **narrower than the rule §2.3b states**. Items 3–5 are §3.0's rule
failing on its second application, by its own author. Both belong in §0's record: §2.3b has now
mis-ranked or under-implemented its own residue three times (the nested case relabelled in round 3,
growth, and the non-record guard), which makes it the section to re-read hardest at review time.

**Not a must-fix, but the gate on PR C:** R-CAP (§1.3a) — whether the host declares
`caps?.elicitation?.form` — is still unmeasured, and measuring it needs instrumentation, i.e.
execution. If the probe returns `undefined`, PR C ships a form nobody sees and Option 4 becomes the
correct choice on the corrected record. PRs A, B, D and E do not depend on it.

---

## 8. Found at implementation — corrections the review rounds did not catch

Recorded here rather than silently patched, on the same principle as §0: a plan that is edited without
saying what was wrong teaches nothing.

**8.1 — PR A's two acceptance criteria are in direct conflict, measured.** §5's PR A row requires
widening `createToolHandler`'s return to `ToolsExecutionResult | InputRequiredResult`, and its AC
requires that every existing `tool-handler.test.ts` case pass **unmodified**. These cannot both hold:
`InputRequiredResult` has no `content`, so it is not assignable to `ToolsExecutionResult`, and the
union breaks **16 spots** in that file — the local `gateToken`/`refusalOf` helpers, which take
`ToolsExecutionResult`, plus the `result.content[0]?.text` access at `:177`.

**Resolution: widen unconditionally and adapt the three spots — but narrow them with a real check**
(`'content' in result`, failing with a message that says an `InputRequiredResult` arrived where a gate
was expected), never with a loosened type. The tests come out stronger than they went in.

_A conditional overload was implemented first and rejected._ It typed provider-less callers narrowly
and the registration site widely, which is sound **today** and only because candidate 1 requires
`hasProvider`. TypeScript does not verify overload soundness against the implementation, so the day
PR B relaxes that conjunct the narrow signature becomes a silent lie with nothing to catch it. That is
the same shape as every claim §0 records this document having had to delete — a guarantee enforced by
nothing — and it is not worth a saved test-file edit. The AC should read "no existing **assertion**
changes", which is the property actually worth protecting.

**8.2 — §2.4 declares four members, not three.** It also gives `message: string`, which PR B needs for
`inputRequired.elicit({message, requestedSchema})`. Any brief that enumerates three is wrong.

**8.3 — binding `ctx` requires _using_ it.** `noUnusedParameters` rejects a bound-but-unread parameter,
so PR A carries one observable delta: the entry `logger.info` gains `sessionId: ctx?.sessionId`. A log
field, not a branch. Stated because §5's PR A row promises "**none**" under user-visible change, and a
new log field is a small but real exception to that.

**8.4 — the PM-C check is red on arrival, by design.** `scripts/check-workflow-resource-published.mjs`
reads the floor out of the command body and compares it to `infra-kit@latest`. Today that is 0.5.0
against a published 0.4.0, so it fails — which is the mechanism working, not a broken build. It goes
green when the CLI serving `infra-kit://workflow/release-create` is published. **Consequence for
whoever holds this branch: the plugin reaches users from git, so the command must not be _pushed_
before that publish.** Committing locally is safe; pushing opens PM-C's window for everyone.

**8.5 — §2.6's predicted file footprint for PR D is wrong; the independence claim survives it.** Round
2 verified PR D as touching "only `resources/index.ts` and `prompts/index.ts`", and used that to argue
PR D is independent of A–C. The independence holds — PR D touched no file PR A, B or C touches — but the
**list** does not. Two further files were forced, not chosen:

- **`mcp-stdio.e2e.test.ts`.** `w1d` and `w1e` compare `resources/list` byte-for-byte against
  `fixtures/resources-list-baseline.v1.json`, a **pre-migration** fixture, so a third resource reddens
  them. Re-capturing the fixture would retire the differential in the act of making it pass, so the
  file's own tool-side idiom (`withoutAuthoredDeltas`) is mirrored as `withoutAuthoredResources`,
  keyed on `AUTHORED_RESOURCE_URIS` and carrying an assertion that the strip **actually removed
  something**, so it cannot go inert on a rename. Stripping owes positive coverage, so
  `assertResourcesAreListedAndReadable` now lists **and reads** the workflow resource on every lane.
- **`resource-bundle.test.ts`.** §2.6 names the bundle guard as the only net for the
  flat-static-import rule, but PR D as specified ships no such guard: that file is keyed to
  agent-guidance's own `SENTINELS`, so a dynamic-import refactor of `workflow-bodies.ts` passes every
  test in this PR — they all run from `src/` — and throws `ERR_UNKNOWN_FILE_EXTENSION` in `dist`.

**Rule for future PR rows: a verified file footprint is evidence about _coupling_, not a complete
list.** Shared fixtures and shared build guards are reached by any change that alters what the server
serves, and neither shows up in an import graph.

**8.6 — where the plan and a task brief disagree, the plan is the artifact to trust.** The PR D brief
specified `src/mcp/resources/workflow/release-create.md`; §2.6 says `«cli»/resources/workflow/…`, which
is also what item 2's `'../../resources/workflow/…'` specifier resolves to from `src/mcp/`, and what the
existing `resources/root/`, `resources/package/`, `resources/design/` siblings establish. The plan was
right. (Checked before relying on it: `resources.test.ts:24` walks only `['root','package','design']`,
so the new sibling does not trip its one-entry-per-file reconciliation.)

**8.7 — the PR A widening breaks four spots, not three.** The fourth is `expectRefusal` at
`tool-handler.test.ts:271`, a helper nested inside the token-binding `describe` and absent from the
first error dump. Recorded because the "three spots" figure in §8.1 came from a first pass and was an
undercount — the same class of error as a file-footprint claim taken as complete.

**8.8 — the PM-C check's second assertion is unexercised, and saying so is the point.**
`scripts/check-workflow-resource-published.mjs` makes two assertions: that `infra-kit@latest` is at or
above the floor named in the command body, and that the published build actually answers
`resources/list` with the URI. Only the **first** has ever run — the second is unreachable until a
version at or above the floor is published, because the first fails and exits before it.

So by §3.0's own rule the second assertion is **not yet accepted**: its named mutation has never been
traced to a flipped assertion. It is not vacuous — its positive path was exercised against the local
built bundle, which lists the URI, reads back 6080 bytes of `text/markdown` naming
`mcp__infra-kit__release-create`, serves `prompts/get` with `arguments` omitted, and returns
byte-identical text on both channels — but that is a _different artifact_ reached by _different code_.

**Whoever publishes the CLI owes this check one run in its passing direction**, and one deliberate
failure (publish, then point it at a build with the resource removed, or at the prior version) before
the assertion may be called guarded. Recorded here rather than left to be assumed green on its first
real invocation, which is exactly how V10 and F13 got in.

**8.9 — F5's named mutation cannot flip an end-to-end assertion. Third of its class.** §2.3 writes the
form predicate as `formable = formProvider.isFormable(params)`, which presumes a provider and is
therefore unwritable in TypeScript without the very `hasProvider` guard it is meant to justify. Written
honestly it is `formProvider?.isFormable(params) === true`, already `false` with no provider, and
`buildFormOrGate` narrows on the provider a second time before building. **Measured: dropping
`hasProvider` from row 1 leaves the observable outcome unchanged.**

`resolveGateState` is therefore exported and F5 gains a second lane driving the predicate directly —
the only assertion that deletion reddens. Note the export is from the module, **not** from
`tool-handler/index.ts`: the production surface is unchanged.

**This is the third AC in this document whose mutation could not flip it** — after V10 (deleted) and
F13 (respelled) — and the third caught only by _running_ the mutation rather than reading the AC. §3.0
is not ceremony; it is the only thing that has ever caught this class here.

**8.10 — F0's predicted outcome is wrong, though the AC still flips.** Deleting row 0 does not emit a
form: row 1 spells `gated` in full, so an ungated call falls through to `verify` and is refused as
`absent`. The AC reddens either way, but for a different reason than stated — worth correcting, since an
AC whose _predicted_ red is wrong invites the next reader to "fix" the code toward the wrong outcome.

**8.11 — `droppedInputResponseKeys` needs no branch.** A dropped entry is _removed_ from
`inputResponses`, so `inputResponse` reads it as `{kind:'missing'}`, which is already not-an-accept and
lands in the `declined` row. F3's fourth lane passes with **zero code reading the field**. It stays
declared on `ToolCallContext` and documented, but §2.3's implication that it needs handling of its own
is wrong.

**8.12 — PR B is not "inert in production", and §5's row says it is.** §5 scopes PM-D(a) — the
provider-less clause in `buildConfirmGate`'s message — to **PR C**, and its PR B row promises "none in
production". The implementation brief put PM-D(a) in PR B instead, and it shipped there. So as landed,
PR B changes what **every gated tool** returns on round 1:

- the gate payload gains `formDiscarded` (`false` on every provider-less tool), and
- the seven provider-less gated tools gain PM-D(a)'s clause in `message`.

**Nothing is red and nothing is broken.** The e2e byte-for-byte fixture is keyed to `resources/list`,
not to gate payloads; and the gate payload already fails the tool's `outputSchema` by construction
(that is why it sets `isError`), so one more field changes no contract it was meeting. But "inert for
users" is now false in exactly one respect, and the PR row should not be left claiming otherwise.

**This is §8.5's rule finding its second instance in the same document.** A PR row's promise about
user-visible change is, like its file list, a claim about the _code path_ — and it goes stale the moment
scope moves between PRs. The executor flagged it rather than leaving it to be discovered, which is the
behaviour the rule is meant to produce.
