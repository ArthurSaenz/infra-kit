# Grafana MCP — port plan (RALPLAN-DR, deliberate)

> Status: **pending approval** — planning artifact only, nothing implemented.
> Date: 2026-09-10 · Revision 4 — **consensus reached.** Critic verdict: APPROVE (rev 1 ITERATE →
> rev 3 APPROVE-with-three-corrections → applied here). Architect r2: sound with conditions, all
> six applied. Awaiting the human go/no-go described in phase 0.
> Predecessors: `docs/grafana-mcp-plan.md` (design + measured facts),
> `docs/grafana-mcp-prototype.mjs` (369-line prototype, verified outside this repo).

Revision 2 changed the **architecture**, not just the wording: the http hop is dropped
(Option D) and the GUI-launch justification is withdrawn as false. Revision 3 applies the
Architect's six conditions — most consequentially, it stops claiming three killer probes when
only one (P0-c) can move the decision, and it books the two defects Option D *creates* (N1, N2)
against the four it deletes.

---

## Principles

1. **The shim may never fail a handshake.** Every failure degrades to a live, toolless session
   that can recover — never to a dead server. *(Scoped honestly: a server that never spawned
   never accepted a handshake. A missing binary costs one absent MCP server, not a broken
   session. The principle governs the shim's own behaviour once it is running.)*
2. **Never a second parser, and never a second writer.** `env-load.sh` is parsed by
   `constants.ts`; files are written by `atomicWriteFileSync`. The shim reuses both.
3. **The shim writes no new credential to disk.** Rev 1 said "is removed at session end", which
   required a reap sweep whose liveness check could kill a sibling session (P1 vs P3, the tension
   the Critic named). Option D removes the sweep: the token goes inline in the child's
   environment and the shim creates no token file.
   *Stated honestly — this is a trade, not a pure win:* the shim still **reads** the token from
   `env-load.sh`, which is on disk already, and an inline env var is readable by any same-user
   process via `ps eww` / `/proc/<pid>/environ`, whereas the 0600 file it replaces was not. What
   is bought is the deletion of the reap sweep (and with it the P1/P3 tension), not secrecy.
4. **Prove client and host behaviour before building on it** — and be honest about which proof
   can actually change the answer. Exactly one probe is a gate (P0-c); P0-d shapes the lifetime
   policy; P0-a was demoted out of phase 0 in rev 3 because it cannot move the go/no-go.
5. **Don't grow the machine path.** `dist/cli.js` and `dist/mcp.js` gain no weight, no imports,
   and no new top-level side effects because a Grafana shim exists.

## Decision drivers

1. **How narrow is the real problem?** After the correction below, the answer is *one workflow*.
   The ADR must justify a new process class against one workflow, or not build it.
2. **Verifiability without Doppler credentials.** `GRAFANA_*` is not in `hulyo/dev`, so every
   test runs against a mock Grafana or it cannot run.
3. **Blast radius on a dirty tree.** `dependency-registry.ts`, `doctor.ts`, `converge.ts` and six
   test files are uncommitted (the `setup` output workstream). Phases 1–3 touch none of them.

---

## Correction: the justification is one row, not five

Rev 1 claimed the shim serves a GUI-launched Claude. **That is false, and the correction is the
most important content of this revision.**

`src/commands/init/init.ts:777` mints the session id only when it is absent:

```zsh
if [[ -z "${INFRA_KIT_SESSION}" ]]; then
  export INFRA_KIT_SESSION=$(head -c 4 /dev/urandom | xxd -p)
fi
```

`ik env-load` writes to `getSessionCacheDir()` (`env-load.ts:212-213`), which is
`<cacheRoot>/<that-8-hex-id>/env-load.sh`. A GUI-launched Claude inherits no id, so the shim
resolves the literal `no-session` dir — **which nothing ever writes.** This holds under either
shell model: one persistent shell (a single stable random id) or a fresh shell per tool call (a
new id each call). The chain is `init.ts:777` → `constants.ts:123-132` → `env-load.ts:213`.

*Confidence:* read from source, high, **pending P0-c**, which observes it end-to-end rather than
deriving it. The plan acts on it now because every option below is safer under it than against
it; P0-c stays a gate because a refutation would restore a row and change the ADR's arithmetic.

Corrected table:

| case | stock `mcp-grafana` | shim |
| --- | --- | --- |
| terminal launch, `envAutoLoad` on, warm file fresh | **works** | works (no gain) |
| first shell after `ik setup` (no warm file yet) | fails once, then works | works |
| warm file past the 2 h TTL | fails once, then works | works |
| project without `envAutoLoad` | fails once, then works | works |
| **GUI launch (Desktop / IDE) — no shell ever runs** | fails | **also fails** |
| **mid-session `ik env-load -c <other>` switch, terminal launch** | fails | **works — nothing else does** |

All three middle rows are "restart Claude once" — including the no-`envAutoLoad` row, since the
interactive shell that ran `env-load` keeps its exports and relaunching Claude from it works —
and rev 1's own pre-mortem conceded the tool cache papers over them permanently after that. **So the shim is bought for one row.** That is
stated here so the approval decision is made against the real payoff, and it is why phase 0 can
end the project rather than merely reshape it.

*(Related, out of scope: the GUI row means `ik env-load`'s session-file channel is unreachable
from a GUI-launched Claude for every consumer, not just Grafana. Worth its own ticket.)*

---

## Viable options

### Option A — Port the prototype as designed (http hop, new bin, one pass)
- **Pros:** matches `grafana-mcp-plan.md` exactly; the prototype is proven end-to-end.
- **Cons:** ships ~150 lines of transport machinery that Option D shows is unnecessary; carries
  M1/M5/D4/D5 with it. Its one real advantage over D is absorbing a token rotation with no child
  restart, and it avoids N1 and N2 by construction — which is why it stays on the table as the
  fallback if the id remap proves harder than estimated.

### Option C — No shim; guarantee credentials at spawn
Make `envAutoLoad` cover the cold-start rows (`env-load.ts:230` already calls `writeWarmCache`,
so no TTL change is needed) and register stock `mcp-grafana`.
- **Pros:** zero new code, no new process class, no tool cache to invalidate.
- **Cons:** loses exactly one row — the mid-session switch. Rev 1 rejected C on two rows and a
  TTL argument; **one row was false and the TTL argument was a misreading.** C is now a serious
  contender and is rejected only if that one row is worth the cost.

### Option D — stdio↔stdio respawning shim, no http hop *(recommended)*
Fact 1 (per-request token re-read, http only) is load-bearing **only if you refuse to restart
the child** — and the prototype already restarts on a `GRAFANA_URL` change
(`prototype.mjs:135-140`), from the same `env-load` write, at the same frequency. Restart on
*either* change and the entire http layer is dead code: no `freePort` (:87), no `waitForPort`
(:97), no SSE frame parser (:208-238), no `Mcp-Session-Id`, **no token file**. The token goes
inline in the child env, which measured fact 3 says takes precedence.

Fact 5 ("a session bound to a killed upstream 404s") is an *http-session* property; stdio has no
session id, and the handshake replay the shim already performs (`clientInitParams`, :125/:188)
is exactly what a fresh child needs.

- **Pros:** deletes D4, D5's token half, M1, M5 and D6's port half; removes the reap sweep that put
  principles 1 and 3 in tension; readiness becomes the handshake response on the pipe instead of a
  port poll, which removes the *port* race (though not the publish-before-await shape — see N2);
  relays server-initiated messages, which the prototype **silently drops today** (it never opens a
  GET SSE stream).
- **Cons:** a token rotation now costs a child restart plus a handshake replay mid-session
  (Option A absorbs it invisibly). In-flight requests during a swap must be tracked and errored —
  true of both designs, untreated in both. And "an stdio child exits when its parent is
  SIGKILLed" is **plausible, not measured** for `mcp-grafana` v1.3.0 → probe P0-d.
  Two costs the transport deletion **creates**, both new defect rows below: the replayed
  handshake now shares one pipe with client traffic (N1), and dropping `waitForPort` drops the
  only readiness deadline (N2). Neither is fatal, but "D is strictly simpler" is false until
  both are built — the id remap in particular is real machinery, and it is what the
  server-initiated-message relay rides on, so that bonus is cheap only *after* N1 exists.

**Chosen: D**, gated on phase 0. If P0-d fails, D survives with an explicit kill-on-exit plus a
parent-liveness guard — the same guard Option A needed anyway, so P0-d reshapes D rather than
killing it. **A** is not chosen because it pays transport complexity for a rotation-cost saving
measured in one child restart. **C** is not chosen *if and only if* the mid-session switch is
judged worth a new process class — that judgement belongs to the approver, not to this plan.

---

## Defects to fix in the port

Rev 1's D-rows plus the five the Architect and Critic found. Struck rows dissolve under Option D
and are kept visible so a fallback to Option A knows what returns.

| # | defect | consequence | fix |
| --- | --- | --- | --- |
| D1 | Cache root hardcoded `~/.cache/infra-kit` (:26) | on any box with `XDG_CACHE_HOME` set, reads a path `env-load` never writes — silently credential-less forever | `getCacheRoot()` |
| D2 | Credentials parsed with `/^([A-Z_][A-Z0-9_]*)='(.*)'$/` (:46) | `constants.ts` tracks quote state **across lines** because values can be multiline; the regex can read a continuation line of an unrelated secret as an assignment | extend `advanceSingleQuoteState` to capture values; export `parseVarsFromEnvFile` beside `parseVarNamesFromEnvFile` |
| D3 | `getSessionCacheDir()` **throws** when `INFRA_KIT_SESSION` is unset | a throw at startup is a dead server (P1) | non-throwing resolution; `no-session` fallback |
| D6 | `ensureUpstream` returns the in-flight `starting` promise without comparing the URL (:133) | a URL change racing a first spawn binds to the wrong Grafana | compare url before returning the in-flight promise |
| D7 | Doc says "spawned on the first Grafana call"; code spawns during `initialize` when credentials exist (:305) | the lazy-start argument answering the daemon's resource objection is not what ships | make code and doc agree |
| D8 | `tools.json` keyed by nothing (:28) | an `mcp-grafana` upgrade serves a stale tool list | key by binary version |
| D9 | New entry needs a hashbang | `ik-grafana` is exec'd directly; without `#!` the shell parses ESM | **Re-scoped:** `dist-shebang.test.ts` enumerates `dev-server.js`/`mcp.js`/`update-check.js` **by name** and asserts `bin` with `toMatchObject`, so **nothing currently fails and nothing would catch this.** Fix = add the hashbang **and** a new positive case |
| D10 | Filter correctness untested | the file holds **every** production secret; a filter bug leaks them into a child env | fixture with non-`GRAFANA_` secrets; assert none reach the child env |
| M1 | `upstream`/`upstreamUrl`/`upstreamPort` published **before** `await waitForPort` (:180-184) | a second message in the ≤15 s window short-circuits at :132 and POSTs to an unlistening port with `upstreamSid === null` — fires on **every** cold start with two requests, far more often than D6 | dissolves under D: readiness is the handshake response, not a port poll |
| M2 | `:313` echoes the client's `protocolVersion` before any upstream exists | the later replayed handshake (:187, body discarded at :192) may negotiate a different version — silent protocol mismatch | negotiate against the cached upstream version; never echo blindly |
| M3 | `:314` hardcodes capabilities | MCP has **no** capability-change notification, so a tool-subset flag change cannot be re-announced | the tool subset is a **deferred-`initialize` input**, not an independent flag decision → P0-b moves to phase 3. **Conflicts with D7** — see below |
| M4 | `:28` hardcodes a **second** path under `~/.infra-kit` — which is `USER_CONFIG_DIR_NAME` (`infra-kit-config.ts:19`), the auto-seeded **config registry**, not a cache — and `:263` writes `tools.json` with plain `writeFileSync` while `atomicWriteFileSync` exists (`constants.ts:162`) | concurrent sessions interleave a partial file; `cachedTools()` swallows the parse error (:243) → **silently toolless** (P1 breach via a P2 breach) | move state under `getCacheRoot()`; write atomically |
| M5 | `waitForPort` proves `127.0.0.1` (:102), `upstreamPost` dials `localhost` (:115) | same class as the `::1` bug this repo already shipped in the portless path | dissolves under D (no socket) |
| N1 | **New in Option D.** The replayed `initialize` is written to the child's **stdin — the same pipe the client's traffic is multiplexed onto** — and its answer returns on the stdout the shim relays verbatim. Under Option A the replay was a separate POST with a private response body (:187-192), so its `id: 0` could not collide | the replay's response is forwarded to a client that already answered its own `initialize`, and any client message using id `0` (JSON-RPC permits it; MCP clients commonly emit it) is indistinguishable from the shim's own | **the shim owns an id namespace distinct from the client's**: remap client ids outbound, map back inbound, pass notifications through untouched. This is also the machinery the server-initiated-message relay rides on |
| N2 | **New in Option D.** Deleting `waitForPort` (:97-112) deleted the 15 s `READY_TIMEOUT_MS` with it, and `spawn()` returns a writable stdin synchronously while ENOENT/EPIPE arrive asynchronously | a child that spawns and never answers `initialize` hangs `ensureUpstream` forever, and every later request awaits it — a **hung** session, not a toolless one. Strictly worse than Option A's failure and a direct P1 breach | bounded deadline on the handshake response; on expiry, error and stay alive. M1's *publish-before-await* shape is still re-writable under D, so the readiness rule ("publish only after the handshake answers") is an explicit test, not an emergent property |
| ~~D4~~ | ~~`token-<pid>` written 0600, never unlinked~~ | ~~a live token survives the session on disk~~ | **dissolves under D** — no token file exists |
| ~~D5~~ | ~~`SIGKILL` orphans `mcp-grafana` with idle-timeout 0~~ | ~~an orphan holds a port and a token forever~~ | **merged into the lifetime item** below |

### Decided: D7 vs M3 (lazy spawn vs honest capabilities)

These two fixes pull against each other and rev 2 listed both without noticing. D7 makes the
spawn genuinely lazy; M3 requires the deferred `initialize` to report the upstream's **real**
capabilities for the configured tool subset — which cannot be known without spawning it.

**Decided:** cache the capability payload alongside the version-keyed tool cache (D8), keyed the
same way, and keep the spawn lazy. A first-ever session on a machine answers `initialize` from a
conservative hardcoded payload and is corrected on the first live handshake; every later session
answers from cache. This accepts one cache-cold session rather than spawning a child in every
session that never touches Grafana — which is the resource argument Option D inherited from the
stdio-vs-daemon decision.

### Decided: upstream + credential lifetime (was D4 + D5 + open item 3)

Rev 1 deferred this to "resolve against open item 3", which the Critic correctly called a
placeholder. Decided:

- **Keep `-session-idle-timeout-minutes 0`** — irrelevant under D (no http sessions), and under a
  fallback to A it is right, because measured fact 5 makes a reaped session unrecoverable.
  Session lifetime and *process* lifetime are different problems.
- **Bind process lifetime to the parent.** Under D this is stdin EOF on the child's pipe, free
  and with no liveness heuristic to get wrong — which is what dissolves the P1-vs-P3 tension: no
  reap sweep exists, so no sweep can kill a sibling session's upstream.
- **No credential on disk**, so nothing needs sweeping (principle 3).
- P0-d measures the EOF claim. If it fails: explicit `kill()` on `exit`/`SIGTERM`/`SIGINT` plus a
  parent-pid poll inside the shim's own lifetime — no cross-session state either way.

## Open questions

**Q1 — bin shape. DECIDED: a third bin, `ik-grafana` → `dist/grafana-stdio.js`.**

Both reviewers recommended the opposite (no new bin; short-circuit inside `cli.ts` on
`argv[2] === 'grafana-stdio'`), on the grounds that a committed `.mcp.json` naming a bin that a
stale global install lacks is `spawn ENOENT`. That risk is real. The recommendation is still
rejected, on evidence neither reviewer checked:

- ESM evaluates **every** top-level import of `cli.ts` before any statement in its body, so a
  "first statement" short-circuit cannot avoid loading commander, inquirer and the full command
  catalog into a long-lived MCP server. That is precisely principle 5.
- `cli.ts:29-34` runs `suppressTypelessPackageJsonWarning()`, `captureSessionReportPath()` and
  `buildProgram()` at module top level. **`captureSessionReportPath()` reads and deletes an env
  var and claims the session-shell report path.** A shim inheriting `INFRA_KIT_SESSION_REPORT`
  from a session shell would consume the report path meant for the interactive command. Injecting
  that into an MCP server is a worse defect than the ENOENT it avoids.
- ENOENT degrades to one absent MCP server — under principle 1 as scoped above, a server that
  never spawned never failed a handshake. The session is intact.

The Architect confirmed (a), (b) and (c) against the source on re-review and withdrew its own
recommendation. It named a **third shape** worth recording rather than rejecting: make
`src/entry/cli.ts` a thin dispatcher (hashbang + `argv[2]` check + `await import()`), moving
today's body and its side effects into `src/cli/main.ts`. That would buy one proven PATH name
*and* zero commander/inquirer/report-path exposure, via the same dynamic-import-to-lazy-chunk
mechanism `build.js` documents for the Ink TUI. It is **not** chosen now: it restructures the
repo's most sensitive entry while sixteen files of the `setup` workstream are dirty, and it adds
a chunk load to every CLI invocation (principle 5). **Follow-up, not a rejected idea.**

Mitigations for the ENOENT window, which are cheap: the consumer `.mcp.json` line lands in the
same change as the infra-kit version bump the consumer installs anyway; `ik doctor` gains a row
naming the missing bin and the fix. **Ordering is load-bearing, not incidental:** S4 treats
"no error, no log line, just a session with no Grafana" as a blocker worth a guard, and a missing
bin has exactly that signature — so **the doctor row must land before the consumer `.mcp.json`
line is committed**, not merely in the same phase. Sequenced in phase 4 accordingly.

**Q2 — `mcp-grafana` provisioning.** `DependencyId` has no `go` manager and `install-manager`
cannot classify a `GOBIN` binary. Options: a brew formula if one exists, a `go install` recipe,
or doctor-warns-and-prints-the-command with no installer. Deferred to phase 4 — it edits the
dirtiest file in the tree.

**Q3 — Doppler provisioning.** `GRAFANA_URL` / `GRAFANA_SERVICE_ACCOUNT_TOKEN` do not exist in
`hulyo/dev`. Not a code task; phase 5.

---

## Pre-mortem — four ways this fails

**S1 — `list_changed` is ignored, discovered after merge.** Claude receives the notification and
does not re-list. Every first-ever session is toolless until restart; the tool cache then hides
it, so it looks fixed. *Guard:* P0-a, **in phase 3 — not before any code.** Rev 3 demoted it out of the gate because it
cannot move the go/no-go (the surviving row changes the URL and token, not the tool list, so the
client never re-lists). It is scheduled after phases 1 and 2 deliberately: what it decides is
whether the credential watcher's `list_changed` emission earns its keep. **If it fails, the
cold-start rows collapse to "restart once" — Option C's position — and the payoff reduces to the
mid-session row alone. The concrete consequence, applied at that point: re-open the A/C/D
comparison with that row as the sole payoff, and expect C to win.** (Rev 1's guard said "the plan is re-run", which the
Critic called circular; this names the outcome.)

**S2 — the credential filter leaks.** D2's naive parser reads a continuation line of a multiline
production secret as `GRAFANA_SOMETHING='…'`, or a refactor drops the prefix check. The value
enters `mcp-grafana`'s environment. Nothing observable fails — a silent, total loss of the
isolation the shim advertises. *Guard:* D10's test is written **first**, against the prototype's
own parser, and seen failing. Filtering is a pure function with a fixture.

**S3 — the port lands under the `setup`/dependency-registry workstream and one is reverted.**
A grafana doctor row on top of uncommitted work, then a revert or rebase, silently drops the row
or resurrects the `aws update` defect that workstream fixed. *Guard:* phases 1–3 touch no
currently-dirty file; the doctor row and registry entry are phase 4, gated on that work landing.

**S4 (new) — runtime failure that presents as "Grafana just doesn't work".** Two concrete paths:
a torn `tools.json` from two concurrent sessions (M4) makes `cachedTools()` swallow a parse error
and serve zero tools; or an orphaned upstream from a previous session holds credentials for an
environment the user has since switched away from. Both are invisible — no error, no log line,
just a session with no Grafana. *Guard:* atomic writes (M4) plus the decided lifetime policy
above; and the startup log line added under Observability, which makes the resolved env-file path
and the upstream's identity readable in Claude's MCP log pane instead of inferable.

---

## Phases

**Phase 0 — probes. No source changes. The whole plan is gated here.**

*`P0-a` is deliberately **not** here.* Rev 1 and rev 2 both treated "does Claude Code honour
`notifications/tools/list_changed`?" as a killer probe. It cannot be: the surviving row is a
mid-session `env-load -c <other>` switch, and a config switch changes the **URL and token, not
the tool list** — the client never needs to re-list. P0-a governs only the three rows the
Correction has already conceded to "restart once", so it cannot move the go/no-go. It moves to
phase 3, where it is a real input to the deferred-`initialize` and tool-cache design.

- **P0-c (gate):** from each target launch mode (terminal, GUI), run `ik env-load` in a tool call
  and diff the path it wrote against the path the shim resolves. Record which shell model the
  client uses — one persistent shell, or a fresh shell per call. This confirms or refutes the
  Correction above and decides whether a "newest dir under `getCacheRoot()`" resolution is even
  sound (it is not, under the per-call model).
- **P0-d:** SIGKILL a parent holding an `mcp-grafana` **stdio** child; confirm the child exits on
  stdin EOF. Decides whether Option D needs an explicit liveness guard.
- *Exit:* P0-c and P0-d answered in writing in `grafana-mcp-plan.md`; Q1 confirmed or
  overturned; **and an explicit go/no-go against the one-row payoff.** The gate rests on P0-c
  plus a judgement call, not on three probes — stated plainly so nobody mistakes probe count for
  rigour.

**Phase 1 — credential parsing (`src/lib/grafana/credentials.ts`).** D2's value-capturing
extension of the quote-state machine; D1's `getCacheRoot()`; D3's non-throwing fallback; the
`GRAFANA_*` filter. Pure functions — no process, no network.
- *Exit:* unit tests incl. D10's leak fixture; `pnpm run qa` green in the CLI package.

**Phase 2 — upstream lifecycle (`src/lib/grafana/upstream.ts`).** Lazy spawn (D7), respawn on
url **or token** change with D6's race fixed, handshake replay, the decided lifetime policy,
D8's version-keyed and M4's atomically-written tool cache under `getCacheRoot()`.
- *Exit:* integration tests against a mock `mcp-grafana` covering: spawn-once; same-url no
  respawn; url-change replaces; **token-change replaces** (new under D); handshake replayed
  before any `tools/call`; a second request during a cold start does not race readiness (M1);
  in-flight requests are errored, not dropped, across a swap; the shim writes no credential to
  disk; **a client request carrying `id: 0` is not confused with the shim's own replayed
  handshake, and the replay's response is never forwarded to the client (N1)**; **a child that
  spawns but never answers `initialize` hits a bounded deadline and errors rather than hanging
  every subsequent request (N2)**.

**Phase 3 — the entry (`src/entry/grafana-stdio.ts`) and packaging.** Hashbang (D9), the
JSON-RPC relay in both directions (including server-initiated messages, which Option A drops),
the deferred-`initialize` path with M2's negotiated version and M3's real capabilities, the
credential watcher, and the client/upstream id remap (N1). Add the `bin` key per Q1.
**P0-a and P0-b both land here**, not in phase 0: P0-b's tool subset is an input to the
deferred-`initialize` capability payload (M3), and P0-a decides whether the credential watcher's
`list_changed` emission earns its keep or is a courtesy the client ignores.
- *Exit:* the D9 positive hashbang case; a **string-presence chunk-isolation test** modelled on
  `dist-shebang.test.ts`'s `update-check worker isolation` block (asserting `commander` and the
  `warnIfLocalInstall` marker string are absent from `grafana-stdio.js`) — replacing rev 1's
  unenforceable "confirm the entry pulls no shared chunk"; and an e2e driving the **built**
  `dist/grafana-stdio.js` through the four-step sequence in `grafana-mcp-plan.md`.

**Phase 4 — surfacing (gated on the `setup` workstream being committed).** **In this order:**
first the doctor rows (`SECTION_MEMBERS` + `DOCTOR_CHECK_NAMES` in `report.ts:64,117`, or two
tests fail) — binary present, credentials resolvable, Q1 bin present — then the `mcp-grafana`
registry entry per Q2, and only then the consumer `.mcp.json` guidance. The order is the
mitigation for Q1's ENOENT window: a missing bin has S4's exact silent signature, so the row that
names it must exist before anything asks a consumer to spawn it.

**Phase 5 — real credentials.** Doppler service account provisioned (Q3); one live session;
`grafana-mcp-plan.md` status moved off "not yet ported".

---

## Test plan (deliberate)

**Unit** — `credentials.ts`: a multiline single-quoted value straddling a `GRAFANA_`-looking
line; `XDG_CACHE_HOME` set and unset; `INFRA_KIT_SESSION` unset; a fixture of production secrets
asserting **zero** non-`GRAFANA_` keys escape; absent / empty / unreadable file; `process.env`
fallback precedence.

**Integration** — `upstream.ts` against a fixture standing in for `mcp-grafana`: the ten cases
listed in phase 2's exit criteria.

**Protocol** — the deferred-`initialize` payload: capabilities match what the upstream actually
reports for the configured tool subset (M3); `protocolVersion` is negotiated, not echoed (M2);
`tools/list` before credentials returns the cache or `[]` and **never** an error; a torn
`tools.json` yields the empty list plus a log line, not a swallowed exception (M4/S4).

**E2E** — the built `dist/grafana-stdio.js` over real stdio with a mock Grafana recording
`Authorization` headers: no-credential `initialize` answers within the deadline and the process
stays alive; writing an `env-load.sh` produces `notifications/tools/list_changed`; the next
`tools/list` returns the live surface; rewriting with a second URL routes the next call to the
second mock; rewriting with a second **token** routes with the new bearer (the Option-D path
Option A got for free).

**Observability** — existing stderr transitions (`serving <url>`, `GRAFANA_URL changed`,
`no Grafana credentials … yet — deferring`, `credentials appeared`) land in Claude's MCP log
pane. Add: the resolved env-file path at startup (D1's failure mode is otherwise invisible), the
`mcp-grafana` version behind the tool cache (D8), and a line when the cache is unreadable (S4).

**Known gaps, deliberately uncovered:** concurrency under load (`grafana-mcp-plan.md` open item
4) — the shim serialises nothing and this was never load-tested.

---

## ADR

**Decision.** Build the shim as an **stdio↔stdio respawning proxy** (Option D) shipped as a
third bin, in six phases, gated on a phase-0 go/no-go that weighs one workflow against a new
process class.

**Drivers.** (1) The payoff is **one row** — a mid-session environment switch in a
terminal-launched Claude. Rev 1 claimed five; the GUI row is provably unreachable and three
others are "restart once". (2) No Doppler credentials exist, so everything is mock-tested.
(3) Three of the files the finished feature touches are uncommitted, so phases 1–3 avoid them.

**Alternatives considered.** *Option A* (http hop, as designed) — rejected: its only advantage
over D is absorbing a token rotation without a child restart, paid for with ~150 lines of
transport and four defects (D4, D5, M1, M5). *Option C* (no shim; guarantee credentials at
spawn) — genuinely simpler, zero new code, and rev 1's rejection of it was wrong on both counts
(one row was false, the TTL argument was a misreading of `env-load.ts:230`). It is rejected only
if the mid-session switch is worth a new process class, which is the approver's call. *The
reviewers' subcommand-instead-of-bin recommendation* — rejected on `cli.ts:29-34` evidence, with
the counter-evidence recorded above so it can be re-argued. Previously rejected and not
re-litigated: `${VAR}` expansion, `envFile`, `doppler run` wrapping, the official `grafana-mcp`
plugin, off-the-shelf stdio↔http proxies, path-routing fronts — see `grafana-mcp-plan.md`.

**Consequences.** infra-kit gains a third binary and a second long-lived server class, bought for
one workflow. Eleven prototype defects are fixed rather than inherited (D1, D2, D3, D6, D7, D8,
D9, D10, M2, M3, M4); four dissolve with the transport (D4, D5, M1, M5); and the transport
deletion **creates two of its own** (N1, N2) — the honest accounting is that D is simpler in
transport, not simpler overall. The shim writes no new credential to disk, at the cost of making
the token visible in the child's environment. The 72-tool surface becomes a decision made
inside the deferred-`initialize` design (M3), not a default. Consumer repos gain one committed
`.mcp.json` line and a `mcp-grafana` prerequisite `ik setup` does not yet install. Measured fact
1 stops being load-bearing, so a future `mcp-grafana` that changes its http token behaviour
cannot break this.

**Follow-ups.** `ik env-load`'s session-file channel is unreachable from a GUI-launched Claude
for *every* consumer — its own ticket. Concurrency load test (open item 4). Q2 provisioning.
Q3 Doppler. Whether `env-load` should publish a bare token file for other consumers — deferred,
and now unnecessary for the shim.
