# [DO] Jira 401 misreported as "project 11713 not found" — diagnosis + hardening plan

Status: **pending approval** (ralplan --deliberate; rev 4, post-Architect + 2 Critic passes). No code changed.
Date: 2026-09-06
Trigger: `ik worktrees list` in `travelist-monorepo` prints two red ERROR lines, then `✓ ok`.

---

## 1. Diagnosis (measured, not inferred)

### 1.1 What actually happens

`worktrees-list.ts:38` → `getJiraDescriptions()` (`release-utils.ts:97`) → `getProjectVersions()` →
`integrations/jira/api.ts:100` `GET {baseUrl}/rest/api/3/project/{projectId}/versions`
with `Authorization: Basic base64(JIRA_EMAIL:JIRA_TOKEN)`.

Probes against the live instance using the exact Doppler `travelist/dev` values. **Row 1 is the request
the CLI actually makes**; the rest are controls.

| # | Request | Result |
|---|---|---|
| 1 | `GET /project/11713/versions` **with the configured creds** | `404`, body `{"errorMessages":["没有找到有ID“11713”的项目。"],"errors":{}}`, **`x-seraph-loginreason: AUTHENTICATED_FAILED`** |
| 2 | `GET /project/11713/versions` **with no creds** | `404`, byte-identical body, **no** seraph header |
| 3 | `GET /project/11713/versions` with a syntactically-bogus token | `404`, identical body, **seraph header present** |
| 4 | `GET /myself` **with the configured creds** | `401`, `x-seraph-loginreason: AUTHENTICATED_FAILED` |
| 5 | `GET /myself` **with no creds** | `401`, **no** seraph header |
| 6 | `GET /project/search` with the configured creds | `200`, `total = 0`, **no seraph header** |
| 7 | `GET /project/search` with no creds | `200`, no seraph header |
| 8 | `GET /serverInfo` with the configured creds | `200`, no seraph header |
| 9 | `GET /serverInfo` with no creds | `200`, no seraph header |
| 10 | `GET /project/11713/versions` with a **malformed** `Authorization` (not base64) | `404`, **no seraph header** |

Config in play: `JIRA_BASE_URL=https://marcom-it.atlassian.net`, `JIRA_EMAIL=a***@uptarget.co`,
`JIRA_PROJECT_ID=11713`, `JIRA_TOKEN` = 192 chars, prefix `ATATT3` (current Atlassian API-token format).

Two consequences worth stating up front, because the plan rests on them:
- **Rows 1 vs 2 are the whole fix.** The 404 the product receives is *distinguishable* from an anonymous
  404 by the seraph header. F2 can therefore classify it `auth`, and AC1 is satisfiable (rev 2 could not
  prove this — the credentialed `versions` call had never been probed).
- **Row 3 means the reproduction survives F1.** `JIRA_TOKEN=bogus` reproduces the exact failure forever,
  before or after rotation.
- **Rows 6-10 bound what the header can and cannot prove, and this is a constraint on the design.**
  `x-seraph-loginreason` is emitted **only** when Jira parsed credentials and *rejected* them. It is absent
  on every `200` — including 200s made with the dead token (row 6) — so it does not mark "auth attempted",
  and it is absent for a **malformed** `Authorization` header (row 10), which is indistinguishable from
  anonymous. Therefore: **its presence is conclusive; its absence proves nothing.** Two consequences —
  (a) F2's `auth` rule must key on the header's *value* (`AUTHENTICATED_FAILED`), never on its presence;
  (b) `not-found-or-forbidden` covers **three** readings, not two (see F2).
  *Not directly measured:* an authenticated 404 (no live token exists yet). But since the header rides on
  credential *rejection*, and a successful auth rejects nothing, it follows from the mechanism that an
  authenticated 404 carries no header. F1 makes this measurable for free — see F1's verification leg.

### 1.2 Root cause

**The Atlassian API token in Doppler `travelist/dev → JIRA_TOKEN` is rejected by Jira.**
`x-seraph-loginreason: AUTHENTICATED_FAILED` appears on every credentialed request and on none of the
anonymous ones — Jira saw credentials and refused them. The call degrades to **anonymous**, and Jira Cloud
answers a missing-*permission* project read with `404`, never `403`, so it does not leak project existence.
`project/search → total = 0` is the same fact from the other side.

The Chinese error text is the site-default locale used for anonymous requests — a *symptom of being
unauthenticated*, not a locale bug.

**Project 11713 is fine. The ID is fine. The token is dead** (revoked, or expired — Atlassian enforces
API-token expiry).

### 1.3 Why the message misled

- **D1 — the 404 is reported verbatim as the cause.** `assertJiraOk` (`api.ts:23`) logs the upstream body
  at `:30` and throws `HTTP 404: Not Found` at `:39`. **The seraph header was on the response and was
  never read** — the classification was available for free.
- **D2 — a tolerated failure logs at ERROR.** `getJiraDescriptions` (`release-utils.ts:112`) *deliberately*
  swallows the throw — descriptions are optional decoration on `worktrees list`. But both logs already
  fired at `error`, so a read-only command paints two red blocks and then prints `✓ ok`.
- **D3 — the failure is logged repeatedly.** `assertJiraOk:30` logs, then `api.ts` re-logs its own rethrow
  at `:88`, `:121`, `:143`, `:193`, `:234`. `worktrees list` shows 2 lines; `release deliver` with a dead
  token logs the same fault up to **5×**. (`api.ts:218` is *not* one of these — it is inside the `try`;
  see F3, which drops it for a different reason.)
- **D4 — the redundant lines carry no information.** They print `error: {}` because pino renders an
  `Error` under a non-`err` key as `{}`. Same key defect at `api.ts:298` and `load-existing-versions.ts:79`.

### 1.4 Adjacent finding (not the cause)

`infra-kit.json → taskManager.config.{baseUrl, projectId}` is **validated by the schema
(`infra-kit-config.ts:65-74`, `:220`) and read by nothing** — repo-wide grep returns zero read sites;
every hit is schema, template comment, or test. Jira config comes exclusively from
`JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_TOKEN` / `JIRA_PROJECT_ID` (`api.ts:246-249`), identical in the
shipped `infra-kit@0.4.0` dist. `11713` in `travelist-monorepo/infra-kit.json` is a coincidence of it also
being set in Doppler — editing that JSON would have changed nothing, which is its own trap.

---

## 2. RALPLAN-DR

### Principles
1. **An error message must name the cause it can prove, and disclose the ambiguity it cannot resolve.**
2. **Log severity belongs to whoever decides tolerance** — and in this repo that is *not* every caller:
   `entry/cli.ts:54-57` already logs any uncaught error at ERROR and exits 1, and `tool-handler.ts:161-168`
   does the equivalent for MCP. Only sites that **catch** decide tolerance.
3. **A tolerated failure is logged at the severity of its residue, not of its cause.** Three-way, and this
   replaces rev 2's binary "optional integrations degrade quietly", which F4 could not satisfy:
   - **silent** — no residue (a retry succeeded, the value was optional and unused);
   - **WARN** — cosmetic residue (missing decoration; `worktrees list` descriptions);
   - **non-fatal ERROR** — durable, user-visible residue the user must act on (a Jira fix version left
     unmarked by `release deliver`), even though the command continues.
4. **Config that is parsed must be consumed, or removed.**

### Decision drivers
1. Time-to-cause for the next person (today: unbounded — the message points at the wrong noun).
2. No new silence *and no new duplication* on the mandatory paths (`release create`, `release deliver`).
3. Blast radius: `infra-kit` is consumed by hulyo + travelist **off a published version** — so merging to
   `main` does not discharge driver 1 (see F8).

### Viable options

**Option A (rev-1 proposal) — classify at transport, delete transport logging, log at every caller.**
*Rejected on one defect, not two.* Adding caller logs to throwing sites duplicates `entry/cli.ts:56` —
re-creating D3 one layer up. (Rev 2 also charged A with erasing the message via `OperationError`; that is
not fatal to A, since `release-create.ts:299` has the raw `error` in scope and could log `{err: error}`.
It *is* a real hazard, and F5 fixes it under any option.)

**Option B — reword in place, demote `getProjectVersions` to `warn`.**
*Rejected.* Rev 1's reason ("release create would go silent") was factually wrong and is retracted: the
entry handler logs and exits regardless. B's real defect is that severity stays fixed in the transport, so
the tolerant and mandatory paths still cannot differ — which is precisely D2.

**Option C — rotate the token only.** Restores the feature today; the next expiry reproduces the identical
misdiagnosis. **Retained as F1, rejected as the whole answer.**

**Option D (chosen) — classify at the transport; keep *one* structured emission there at `debug`; delete
the five redundant catch-logs; fix the lossy `OperationError` passthrough; touch only the five sites that
actually decide tolerance.**
*Pros:* no duplication (A's defect) and severity varies per caller (B's defect); the upstream body stays
recoverable at `debug` — **conditional on F3a**, see below.
*Cons:* one more moving part than B — a new error type, plus F3a as a hard prerequisite.
(Rev 3 listed "touches `lib/errors/operation-error.ts`" here; that describes F5's *rejected* alternative.
The chosen call-site fix touches only `release-create.ts` — `stderrExcerpt` is already a first-class
`OperationErrorContext` field (`operation-error.ts:6`) that already outranks duck-typing (`:33`).)

### Options for the dead `taskManager` config
**E1 — delete from schema.** *Rejected:* `infraKitConfigObject` is `.strict()` (`infra-kit-config.ts:228`)
and `getInfraKitConfig()` is an unconditional guard (`worktrees-list.ts:25`), so removing the key **bricks
every command** in travelist/hulyo until they edit their JSON.
**E2 — wire it: config gives `baseUrl`/`projectId`, env gives `email`/`token`, env always wins.** Preferred
long-term; see P3 — it enables Jira *writes*.
**E3 — defer, with comments in both the schema and the consumer-facing template. Chosen (F7).**

### Pre-mortem
- **P1 — Partial rotation.** `~/.infra-kit/projects/travelist-monorepo/tokens.json` lists seven Doppler
  configs (`dev`, `arthur`, `oriana`, `roman`, `renana`, `eliran`, `prod_observability`). Rotating only
  `dev` leaves every teammate broken until release day. *Mitigation:* F1 is an explicit per-config
  checklist **with its own verification leg** (rev 2 left this as prose with nothing checking it).
  **F6 does not discharge P1** — `loadJiraConfig` reads `process.env` (`api.ts:246-249`), so `ik doctor`
  sees only the config the current shell sourced, exactly like `checkEnvTokenValid` (`doctor.ts:410`).
  F6 is a per-developer check; the fleet gap stays open and is not claimed closed.
- **P2 — New silence, or new duplication, on a mandatory path.** *Mitigation:* the invariant is **not**
  "every call site logs" (rev 1's error — it mandates D3), and **not** "an AST assertion over `catch`
  blocks" (rev 2's error — two of the sites are not `catch` blocks). It is an **allowlist of the four
  `file:symbol` pairs** that may absorb a `JiraApiError` — `release-utils.ts:112`, `release-create.ts:299`,
  `gh-release-deliver.ts:353`, `load-existing-versions.ts:79` — covering `catch` and `Promise.allSettled`
  rejection branches, with `tool-handler.ts:161` explicitly exempt as a *rethrowing* site. Asserted as
  **at most** this set, never exact equality.
  **F4's five tolerance sites and P2's four absorbers are different sets.** `api.ts:298`
  (`loadJiraConfigOptional`) is in F4 but not P2: it catches only `loadJiraConfig()`, which does no
  network I/O — it reads `process.env` (`api.ts:246-249`) and throws a plain `Error`/`TypeError`. It
  tolerates *config absence* and structurally cannot see a `JiraApiError`.
- **P3 — Wrong-project writes from E2.** A consumer with a stale `infra-kit.json` would have
  `createJiraVersion` write a fix version into the wrong project — a mutation, not a read. *Mitigation:*
  env strictly wins; deferred via E3 regardless.
- **P4 — Losing the reproduction. RETRACTED as a risk (row 3).** Rev 2 asserted F1 destroys the only live
  repro and cut the failure-path e2e leg on that basis. Measured false: `JIRA_TOKEN=bogus` reproduces the
  404 *and* the seraph header indefinitely. The e2e leg is restored.
- **P5 — F3 lands without F3a.** Log level comes only from `process.argv.includes('--debug')`
  (`lib/logger/index.ts:34`, `:44`), and `--debug` is **not registered on the commander program** and there
  is no `allowUnknownOption` — so `ik worktrees list --debug` errors out today. Without F3a, F3's
  "demotion to debug" is a **deletion in the field**, and Option D loses its stated advantage over A.
  *Mitigation:* F3a is a **prerequisite** of F3, not a follow-up.
- **P6 — F3 lands without F2.** Deletions before classification leave a window where the user gets
  `HTTP 404: Not Found` and nothing else. *Mitigation:* F2+F3+F3a ship as one commit.

---

## 3. Plan

**F1 — Rotate the credential.** *[user action; independent of everything else]*
Mint a fresh Atlassian API token for the `@uptarget.co` account. Set `JIRA_TOKEN` in **each** Doppler
`travelist` config that defines it — `dev`, `arthur`, `oriana`, `roman`, `renana`, `eliran`,
`prod_observability` — then audit `hulyo` for the same token.
*Verification (P1):* per config, `GET /rest/api/3/myself` → `200` and no `x-seraph-loginreason`.
*Also capture, with the fresh token (closes AC3's fixture gap — Major 3 of Critic pass 2):*
`GET /rest/api/3/project/<nonexistent-id>/versions` → record status, body, and presence/absence of
`x-seraph-loginreason`. This is the **authenticated 404** — the only case rev 3 proposed to synthesise
from the hypothesis under test. F1 makes it obtainable for free; do not synthesise it.

**F2 — Classify the failure (`integrations/jira/api.ts`).** Add `JiraApiError` as a **typed class with a
guard**, modelled on `EnvAuthError` (class at `lib/errors/env-auth-error.ts:30-44`), whose comment at `:22` says
classification "has to travel WITH the error, not be re-derived by grepping a message". Carries `status`,
`body`, `context`, `kind`. **Header-first**, because §1.1 row 1 proves the header outranks the status. Match on the header's
**value**, never its presence — rows 6-10 show absence is uninformative:
- `auth` — `x-seraph-loginreason === 'AUTHENTICATED_FAILED'` **on any status**, or a bare `401`. Message
  names `JIRA_EMAIL`/`JIRA_TOKEN`. *This is the row-1 case, and the one the user hit.*
- `forbidden` — `403`: authenticated but unauthorised.
- `not-found-or-forbidden` — `404` **without** the header: states **three** readings explicitly —
  the project does not exist, **or** these credentials cannot browse it, **or** the `Authorization`
  header was malformed and the request went out anonymous (row 10). Rev 3 said "both readings"; row 10
  proves that undercounts.
- `transient` — 5xx **and** `fetch` rejections (DNS, timeout). Requires wrapping the `fetch` call, not only
  the response: today a network failure never reaches `assertJiraOk` and is indistinguishable from a dead
  token. `doctor.ts:391-396` already encodes the opposite contract (`unreachable → pass`).

`.message` **must be self-sufficient** (status + first line of the upstream body): `entry/cli.ts:56` prints
only `.message`.

**F3a — Register `--debug` (prerequisite of F3, per P5).** Declare a global `--debug` on the root
program, with a test that `<cmd> --debug` parses and reaches the command. **Registration is the whole
job** — the logger already reads `process.argv` directly (`lib/logger/index.ts:34`, `:44`) and needs no
rewiring; the only defect is that commander rejects the unknown option first. An `INFRA_KIT_LOG_LEVEL`
env var may be added *alongside*, never instead: on its own it leaves `--debug` still erroring and AC7 unmet.

**F3 — One emission, at the transport, at `debug`.** Delete the **five** redundant catch-logs in `api.ts`
(`:88`, `:121`, `:143`, `:193`, `:234`). Demote — do **not** delete — the `assertJiraOk:30` emission to
`logger.debug({ status, body, kind })`. Add **no** logging to the throwing sites.
*`api.ts:218` — delete it too, for a different reason.* It is **not** a catch-log: it sits inside the
`try` of `deliverJiraRelease` and reports a different fact (a version name absent from a **successful
200**). Rev 3 said "keep it at ERROR", which was self-contradictory: `:218` logs → throws at `:219` →
the catch at `:233` rethrows → `gh-release-deliver.ts:353` catches → ERROR at `:354`. That is **two
ERROR lines for one fault at default level** on a mandatory path, violating AC6. Since `:218` does not
catch, it does not decide tolerance (Principle 2). Delete the log and let the `:219` throw carry
`versionName` in its message — F2 already mandates a self-sufficient `.message` — leaving `:354` as the
single emission.

**F4 — Tolerance sites, per Principle 3.** Five sites, one emission each:
| Site | Level | Rationale |
|---|---|---|
| `release-utils.ts:112` (`getJiraDescriptions`) | **WARN** | cosmetic residue — missing descriptions. Replaces the bare `catch {}`. This is the D2 fix and what `worktrees list` will show. |
| `release-create.ts:299` | **ERROR** (existing, at `:305`) | durable residue — **the requested release does not exist at all**, and `failureCount` is non-zero; the user must re-run after fixing credentials. (Rev 3 said "release created with no Jira version" — inverted: `createSingleRelease` does Jira **first** (`createJiraVersion`, `release-utils.ts:67`) and the branch **second** (`createReleaseBranch`, `:82`), so a Jira auth failure creates nothing.) See F5. |
| `gh-release-deliver.ts:354` | **ERROR** (existing) | durable residue — fix version left unmarked. Name the credentials. |
| `load-existing-versions.ts:79` | WARN (existing) | key fix only: `{ error }` → `{ err }`. |
| `api.ts:298` (`loadJiraConfigOptional`) | WARN (existing) | key fix only: `{ error }` → `{ err }`. |
*(`load-existing-versions.ts:75` logs the remote-git-branches rejection, not a Jira path. Fix the key there
too for consistency, but it is out of AC5's scope.)*

**F5 — Fix the lossy wrapper.** `release-create.ts:299-305` wraps the cause in `OperationError`, whose
`buildMessage` (`operation-error.ts:32-40`) renders only `failed to <op> [— stderr: …] [— try: …]`;
`extractStderr` (`:18-23`) duck-types `.stderr`, which a `JiraApiError` lacks — so today the credentials
never reach the user there. **Chosen fix: pass `stderrExcerpt: jiraError.message` at the call site.**
Rejected alternative: teaching `buildMessage` to render `cause.message` whenever no stderr exists — that
changes message shape for every non-zx cause repo-wide. Also make `remediation` conditional on `kind`, so
an auth failure stops recommending "verify the version or name is unique".
*Cost:* confined to `release-create.ts:300-303`; `lib/errors/__tests__/operation-error.test.ts` already
exists and stays green untouched. The zx-`stderr` regression case is belt-and-braces, not a necessity.

**F6 — `infra-kit doctor` gains a Jira row.** `GET /rest/api/3/myself`: not-configured / OK (with account) /
**credentials rejected**. Must adopt `PROBE_VERDICT`'s `unreachable → pass` (`doctor.ts:391-396`) or an
offline developer sees a false "credentials rejected". Requires a `SECTION_MEMBERS` bucket
(`report.ts:59-80`) — none of the five fits (`SECTION_TOKENS` is Doppler-store-scoped), so add a section or
extend one. **Two test edits, both mandatory:** omitting the `SECTION_MEMBERS` entry fails
`report-inventory.test.ts:148` (`DOCTOR_CHECK_NAMES` is derived from it at `report.ts:104`); making the
entry then fails `report.test.ts:89-91`, which asserts the count **twice** — `toHaveLength(24)` at `:90`
and `new Set(DOCTOR_CHECK_NAMES).size).toBe(24)` at `:91`; both become 25.
**Scope note: per-shell, not fleet-wide (P1).**

**F7 — `taskManager` config: defer (E3).** Comment the block as currently unconsumed in **both**
`infra-kit-config.ts:65` (maintainer-facing) **and** `lib/config-templates/config-templates.ts:44` — the
commented `taskManager` block in the template is the surface a *consumer* actually reads, and §1.4's trap
is a consumer editing their own `infra-kit.json`. **This knowingly defers Principle 4**; the follow-up
carries E2 + P3.

**F8 — Publish.** Driver 3: travelist/hulyo run a published `infra-kit`, so AC1's effect in
`travelist-monorepo` is unreachable until a version ships. Bump → publish → confirm the consumer resolves
it. Sequenced last, and required for the plan to have any effect where the bug was seen.

### Sequencing
`F1` is independent (do it first — it unblocks the user today).
`F2 + F3a + F3` ship as **one commit** (P6). `F4`, `F5`, `F6`, `F7` follow in any order. `F8` last.

### Acceptance criteria
1. With an invalid token, `ik worktrees list` prints **zero** ERROR lines at default log level, **exactly
   one** WARN whose text names `JIRA_TOKEN`/`JIRA_EMAIL` as the probable cause, and the worktree list still
   renders. *(Satisfiable via F2's `auth` kind — §1.1 row 1 proves the header is present.)*
2. With an invalid token, `ik release create` emits **exactly one** ERROR at `release-create.ts:305` whose
   text names `JIRA_TOKEN`/`JIRA_EMAIL`; **exit code unchanged (0)** and `failureCount` = 1 — the
   documented "continues on per-release failure" contract (`release-create.ts:395`) is preserved.
3. A 404 **without** the seraph header yields a message stating all three readings (missing project,
   insufficient permission, or a malformed `Authorization`). Asserted against the **real** authenticated-404
   fixture captured in F1 — not a fixture built by deleting the header from row 1.
4. `ik doctor` reports `Jira: credentials rejected` against a dead token, the account email against a live
   one, and **passes** when the host is unreachable.
5. No log line renders `error: {}` on any Jira path — `api.ts:298` and `load-existing-versions.ts:79`
   included.
6. At **default log level**, one fault produces **one** visible line *naming that fault* per command —
   not 2–5×. Excluded by definition: rollup summaries that name no cause — `logFinalSummary`'s
   `❌ N release(s) failed.` (WARN, `release-create.ts:316`) and `❌ All N release branch(es) failed to
   create.` (**ERROR**, `:318`, the branch taken when *every* release fails). By design: 2 on the MCP path
   (tolerance site + `tool-handler.ts:162`); 2 at `--debug` (transport + tolerance site); and 2 on
   `release desc-edit` — a cosmetic WARN from `getJiraDescriptions()` (`release-desc-edit.ts:46`) plus the
   fatal ERROR from the edit itself (`:129` throws uncaught → `entry/cli.ts:56`). Distinct residues, same
   cause: correct under Principle 3. Assertions pin the level.
   *This is why F3 deletes `api.ts:218` — keeping it made `release deliver` emit 2.*
7. `ik worktrees list --debug` parses and reaches the command (F3a).

### Verification
- **Fixtures (capture from §1.1; no longer blocked on F1 — P4 retracted):** credentialed 404 **with**
  seraph header, anonymous 404 **without** it, both `/myself` responses. **Plus a fixture this plan does
  not yet have: an *authenticated* 404** (real missing project, live creds) for AC3 — synthesise it from
  row 1 minus the header if a live token can't produce one.
- **Unit:** `assertJiraOk` over {401, 404+seraph, 404 bare, 403, 500} → asserted `kind` and message;
  asserts it emits at `debug` only.
- **Unit:** the **`fetch` wrapper** (not `assertJiraOk`, which takes a `Response` and by definition never
  sees this) over a rejected `fetch` → `kind: 'transient'`.
- **Unit:** `getJiraDescriptions` on throw → **returns** an empty map (must not re-throw after warning:
  `worktrees-list.ts:38` awaits it inside `Promise.all`, so a re-throw kills the command outright — a hard
  regression out of a cosmetic-severity change), exactly one `warn`, zero `error`.
- **Unit:** `OperationError` with `stderrExcerpt: jiraError.message` renders the credentials; **plus** a
  regression case that the existing zx-`stderr` path is unchanged (F5's blast radius).
- **Unit (F3a):** `<cmd> --debug` parses; logger level resolves to `debug`.
- **Invariant test (P2):** **no site outside** the four-entry allowlist absorbs a `JiraApiError`
  (at-most, not equality); covers `catch` and `allSettled` rejection branches; `tool-handler.ts` exempt.
- **Integration:** `worktrees list` with a stubbed 404+header → zero `ERROR`, one `WARN`, list renders.
- **Integration:** `release deliver` with a stubbed dead token → one emission, not five.
- **Integration:** `release deliver` where Jira returns **200 with the version absent** →
  the condition still surfaces, and does so **exactly once** (at `gh-release-deliver.ts:354`), with
  `versionName` present in the text. Asserts the *count*, not just presence — rev 3's leg asserted
  presence only and so could not have caught the double-ERROR it shipped.
- **e2e (restored by P4's retraction; works before *and* after F1):**
  `JIRA_TOKEN=bogus <node> <abs cli.js> worktrees list` → zero ERROR, exactly one WARN naming the
  credentials, list renders. Discharges AC1 against the real binary, not fixtures.
  **Precondition:** run in a checkout with **≥1 release worktree**. `worktrees-list.ts:29-35` returns early
  with `ℹ️ No active worktrees found` *before* reaching `getJiraDescriptions()` at `:38`, so anywhere else
  this yields zero WARN and "exactly one WARN" fails for the wrong reason. travelist qualifies.
- **Observability:** F6 doctor row across not-configured / OK / rejected / unreachable.
- **Manual, post-F1 + post-F8:** `ik worktrees list` in travelist shows Jira descriptions.

### ADR
- **Decision:** Rotate the credential (F1); classify Jira failures into a typed, **header-first**
  `JiraApiError` with a `transient` kind (F2); register `--debug` (F3a) so F3's demotion is a demotion and
  not a deletion; keep one `debug` emission at the transport and delete the five redundant catch-logs while
  deliberately keeping `api.ts:218` (F3); make the five tolerance sites emit once each at the severity of
  their *residue* (F4); fix `OperationError`'s lossy passthrough at the call site (F5); add a per-shell
  doctor probe (F6); defer the dead `taskManager` config with comments on both surfaces (F7); publish (F8).
- **Drivers:** time-to-cause; no new silence *or duplication* on mandatory paths; consumers run a published
  version.
- **Alternatives:** A (log at every caller) — rejected for duplicating `entry/cli.ts:56`; rev 2's second
  charge against A is withdrawn as non-fatal. B (reword in place) — rejected; severity stays fixed in the
  transport. Rev 1's reason for rejecting B was factually wrong and is retracted. C (rotate only) — retained
  as F1, rejected as the whole answer. E1 (delete `taskManager`) — rejected; `.strict()` + unconditional
  guard bricks every consumer command. E2 (wire it) — deferred under P3, it enables wrong-project *writes*.
- **Consequences:** `assertJiraOk` depends on `x-seraph-loginreason`, an undocumented Atlassian signal.
  §1.1 rows 1-10 bound it precisely: emitted **only** on credential rejection — absent on every 200, absent
  for anonymous, absent for a malformed `Authorization`. So **presence is conclusive, absence proves
  nothing**, and the classifier matches the *value*, not the key. Degradation is one-directional and benign:
  if Atlassian ever drops the header, every 404 falls to `not-found-or-forbidden`, i.e. rev-2 behaviour,
  not a crash; a bare `401` stays independently sufficient. The residual untested direction — a
  *successfully authenticated* 404 — is captured for real in F1 rather than synthesised.
  The tolerance-site allowlist is enforced by test rather than convention, asserted **at most**, and F4's
  five tolerance sites are deliberately a different set from P2's four `JiraApiError` absorbers.
  **F5 does not touch shared error-formatting code** — that was its rejected alternative.
  **Rollback:** F2+F3a+F3 ship as one commit, and F3 deletes six log sites; if the classification proves
  wrong in the field the diagnostic surface is gone and recovery is a revert of that commit. Accepted.
  **Principle 4 is knowingly violated by F7** until the E2 follow-up lands.
  **P1's fleet gap stays open**: nothing verifies all seven Doppler configs except F1's own checklist.
- **Follow-ups:** E2 (`taskManager` as config source, env wins); audit `hulyo`; close the fleet-visibility
  gap P1/F6 leaves open; consider whether `project/search → total = 0` should corroborate `auth` on a 404
  (measured in §1.1 row 6, currently unused by the design); consider a `version-missing` kind on
  `JiraApiError` so `release deliver`'s tolerance site can render the `api.ts:218` condition with full
  context rather than relying on the throw's message text.
