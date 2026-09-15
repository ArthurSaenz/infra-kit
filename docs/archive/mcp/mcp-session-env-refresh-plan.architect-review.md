> Archived 2026-09-15 — the infra-kit MCP server is being retired; see .omc/plans/mcp-to-cli-skills-migration.md.

# Architect review — in-process session-env refresh at the MCP tool chokepoint

Reviewer: architect pass of a ralplan `--deliberate` consensus loop. Read-only with respect to
`docs/archive/mcp/mcp-session-env-refresh-plan.md` and all source; this file is the only artefact written.

Subject: `docs/archive/mcp/mcp-session-env-refresh-plan.md` (504 lines, revision 1, Status: `pending approval`).
Tree: `main` @ `388ec26`, one untracked file (the plan). Every line number below was read from that
tree. `«cli»` = `apps/infra-kit/cli/`.

The plan is well-evidenced: F1–F12 were re-read and every load-bearing citation holds. The decision
(Option B) is right and the review does not overturn it. What follows is (1) the honest steelman the
brief asked for, which the plan's §1.5 row for Option A overstates in one place, (2) one factual error
in §2.6 that the plan leans on for its concurrency story, (3) one ordering choice at the seam that
contradicts the plan's own principle, and (4) a set of wording/scope amendments.

## 1. Claim verification

| Claim | Verdict | Evidence |
|---|---|---|
| F1 — one chokepoint, order `ensureUserProjectConfig` → `commandEcho.reset()` → `resolveStop` → stop-return → `handler(...)` | **VERIFIED** | `«cli»/src/lib/tool-handler/tool-handler.ts:574,580,587,589,591`; `src/mcp/tools/index.ts:62` is the sole `createToolHandler(` outside tests |
| F2 — writer and non-reader are one process; `getSessionCacheDir()` throws without `INFRA_KIT_SESSION` | **VERIFIED** | `constants.ts:224-233`; `env-load.ts:111-119` (`writeEnvLoadFile`) |
| F3 — zshenv rule `-r load && ! clear -nt load`, precmd `load_mtime >= clear_mtime` / `clear_mtime > load_mtime`; `env-clear` writes clear THEN `rmSync` load | **VERIFIED** | `init.ts:1206-1210`; `init.ts:1068-1078`; `env-clear.ts:100-104` (`rmSync(..., {force:true})`, not `unlinkSync`) |
| F4 — parsers skip `export …`/`unset …` lines | **VERIFIED** | `ENV_VAR_LINE_PATTERN`, `constants.ts:74`; note the e2e harness seeds `export FOO=bar` (`mcp-harness.ts:85`), which the parser yields ZERO vars from — see §5 |
| F6 — Jira reads `process.env.JIRA_*` at call time; `loadJiraConfig` is `release-create`'s second statement | **VERIFIED** | `api.ts:237-240`; `release-create.ts:384-386` |
| F7 — `env-load` is NOT gated on protected configs | **VERIFIED** | policy consumers are the four deploy commands + `deploy-form.ts`; nothing under `src/commands/env-load/` or `src/lib/env-load-form/` |
| F8 — proxy refuses everything but `initialize`/`tools/list` while any listed var is empty; respawn key `JSON.stringify(vars)`; in-flight work errored on respawn | **VERIFIED** | `mcp-proxy.ts:223,285`; `upstream.ts:267` (`key: JSON.stringify(vars)`), `:122-125` |
| F9 — confirm codec keys on `randomBytes(32)`, per process | **VERIFIED, with an addendum the plan omits** | `confirm-token.ts:116` — `createConfirmCodec({ key?, ttlSeconds? })` ALREADY accepts an injected key. A persisted key is a ~10-line change, not a redesign. Matters for the Option A steelman (§2.1) |
| F10 — lazy factory, may run twice | **VERIFIED** | `entry/mcp.ts:20-24` |
| F12 — `sec` lane writes `FOO='s3cr3t-value'`, asserts no value leak via `env-status`/`env-list`; matches only `sessionConfig` + `sessionTotalCount` | **VERIFIED** | `mcp-stdio.e2e.test.ts:1263,1276-1281` |
| §2.6 — "the plugin skills issue tool calls sequentially" as the reason overlapping applies are safe | **FALSE as a guarantee** | The v2 SDK dispatches every request as `Promise.resolve().then(() => handler(request, ctx))` with no queue (`@modelcontextprotocol/server@2.0.0`, `dist/src-CX2iR2pK.mjs`, `_onrequest`), and Claude Code runs the tool calls of one assistant turn concurrently. Two MCP calls DO overlap. See §3.2 for why the design is nonetheless safe and what the plan must say instead |
| Only in-process `process.env` writer outside tests is `dev-wizard-run.ts:449` | **PARTIAL** | Also `dev-server.ts:1206-1207` (`POWERTOOLS_DEV ??=`, `LOG_LEVEL ??=`). Neither is MCP-exposed, so S1's conclusion stands; the S1 guard test should match `??=` too |
| Children inherit `process.env` at spawn | **VERIFIED** | 32 execa/spawn sites; 4 build `{...process.env, …}` explicitly (`open-dev-workspace.ts:37` for cmux, `ui-dev.ts:367`, the proxy); the rest pass no `env` and inherit. `doppler secrets download` passes `--project/--config` explicitly (`env-load.ts:383`), so a stale `DOPPLER_CONFIG` in the overlay cannot redirect the next download |

## 2. Steelman antithesis to Option B

### 2.1 Option A (`ik-mcp` in front of `infra-kit mcp`) — the plan's rejection is right, but row (1) is overstated

The strongest case FOR A is not the one the plan argues against. It is:

- **One mechanism for "a stdio server whose credentials arrive from a file".** The proxy already
  encodes the file-wins-per-name rule (`env-vars.ts:39-47`), the protected-name set, the respawn-on-
  change semantics, and a tested handshake replay. B re-implements the first two in a second module
  (`session-env.ts`) with a *different* rule (zshenv's clear/load tie-break, which the proxy does not
  know — the plan's own §9 follow-up admits the two readers would disagree). Two readers of one file
  with two rules is the exact shape P1 exists to forbid.
- **No in-process mutation.** Under A the invariant "process env = file" is enforced by the kernel at
  spawn; there is no baseline snapshot, no `touched` set, no restore-then-overlay, no "was the baseline
  captured before something else wrote `process.env`" pre-mortem (S1). The process is disposable, so
  none of the idempotency/twice-running-factory reasoning (F10) is needed.
- **Credential isolation by construction.** The server process only ever holds what the proxy hands
  it; a `prod` file becomes a `prod` *child*, killed the moment the file changes. B makes the one
  long-lived process the union over time of every config the session ever loaded (restored per call,
  but resident in the same address space, same `/tmp/mcp-infra-kit.log` writer, same crash-dump).

What A would need, honestly costed:

1. **Optional-vars mode** — spawn with whatever the file has, refuse nothing. ~20 lines in
   `mcp-proxy.ts:223,285` + `readListedVars`. This cures D2. The plan's "(1) D2 fails outright" is
   true of the shim *as built*, not of the design.
2. **Persisted confirm key** — `createConfirmCodec` already takes `key` (`confirm-token.ts:112-116`);
   `getDefaultConfirmCodec` would read it from a 0600 file in the session dir or an env var the proxy
   sets. ~10 lines. This cures D1's `mac` refusal across a respawn. TTL and args-binding are unaffected.
3. **Capability/era passthrough** — the proxy answers `initialize` from cache or the pinned
   `2025-06-18 / {tools}` fallback (`mcp-proxy.ts:25-26,130-139`), and the child's handshake is the
   proxy's own (`upstream.ts:84-94`). Whether the client's elicitation capabilities survive to
   `getClientCapabilities` (`tools/index.ts:75-79`, envelope-first) is unmeasured. This is the one cost
   that is NOT small: the env picker form (`docs/session-env-picker-plan.md`) depends on it, and the
   proxy was designed for servers that never elicit.
4. **Detector + manifest lockstep** — `isInfraKitServerEntry` (`mcp-registration.ts:67`), the doctor
   row, `audit`'s check, and `plugins/infra-kit/.mcp.json` all move together: a plugin+CLI version pair.
5. **The self-kill race** — `env-load` runs *inside* the child, writes the file, and the 2 s poll then
   kills that child (`upstream.ts:122-125`). The response is usually out before the poll fires, but
   nothing orders it. A server killed by the side effect of its own tool is a defect the proxy cannot
   fix without learning which tool changes the file.

Verdict on the steelman: (1) and (2) are cheap and the plan should stop calling (1) "outright";
(3), (4), (5) stand and are together heavier than B's 120 lines. The uniformity argument fails on a
different ground than the plan gives: **infra-kit's server is the file's *writer*; the proxy was built
for servers that only *read* it.** A writer behind a respawn-on-change proxy is the self-kill race by
construction. `ik-mcp` stays for foreign servers. Rejection sustained; §1.5 row (1) needs rewording
and rows (2)/(5) should be extended with the key-injection fact and the self-kill race (amendment A1).

### 2.2 Option C (threaded env object) — dominated, and by a decision the user has already made

C-lite — `loadJiraConfig(env = process.env)` fed from a resolved `SessionEnv` on `ToolCallContext`,
`env-status` reading the same object — would touch ~4 read sites and mutate nothing. It is the
"cleanest" design by the mutation-free criterion. It is dominated because the user fixed "overlay ALL
file vars": under C every child spawn (32 sites, 4 of which already build `{...process.env}`) must
receive the threaded env or the plan's own `GH_TOKEN`-in-Doppler example breaks — and that is two
definitions of "loaded" (in-process vs children), which P1 forbids. The plan's §1.5 row for C is
correct; it just should say that the threaded object is the *natural* design for a reads-only fix and
that the ALL-vars decision is what rules it out (amendment A2, one clause).

### 2.3 Attacks on B itself

- **Mutating `process.env` in a long-lived server that spawns children.** Every child spawned during
  a call inherits the overlay — `gh`, `git`, `doppler`, and the cmux workspace `reopen` opens
  (`open-dev-workspace.ts:37`, `{...process.env}`), which is long-lived and keeps the secrets after a
  later `env-clear`. **Attack rejected as a regression**: a terminal's cmux child does exactly this.
  But it is a consequence the ADR must list by name (amendment A6): "a long-lived child spawned by an
  MCP tool keeps the environment of the call that spawned it".
- **Baseline-restore resurrects pre-launch vars.** Old flow: terminal `env-load` → launch → baseline
  holds `JIRA_*`. Later `env-clear --purge`/manual dir removal → state `none` → overlay restores the
  baseline → `JIRA_*` are back in the server while the terminal has unset them. **Attack rejected**:
  a `Bash` child of Claude Code inherits Claude Code's launch env (which has `JIRA_*`) and zshenv in
  state `none` sources nothing — so the `Bash` tool resurrects them too. P1 holds exactly. Worth one
  sentence in §2.1 so the next reader does not "fix" it (amendment A7).
- **A `prod` file now reaches every MCP tool and child.** See §4 (tension T1). Not a blocker; the
  plan's §2.4 reasoning is sound and the widening is smaller than it looks, because an agent-driven
  `env-load prod` over MCP already hands `prod` to every `Bash` child via zshenv today.
- **`no-session` silently disables the fix.** Claude Code launched from the desktop app, an IDE
  extension, or any shell without the init rc has no `INFRA_KIT_SESSION`; the overlay logs once and
  no-ops forever. Consistent (`env-load` over MCP throws there too) but the plan claims the defect is
  fixed without scoping it to terminal-launched sessions (amendment A8).

## 3. Principle-violation flags (deliberate mode)

### 3.1 P2 says "zero edits under `src/commands/`"; §2.7 edits three files there — **VIOLATED (wording)**

`env-status.ts` (description), `env-load.ts:541-543` (description), `release-remove.ts:226-236`
(comment + remediation) are all under `src/commands/`. The edits are text, not behaviour, and they are
right — the principle is what is wrong. Amend P2 to "one behavioural seam; no command's *logic* changes"
(amendment A3).

### 3.2 §2.6 rests on a false premise — **VIOLATED (evidence over assumption)**

"The plugin skills issue tool calls sequentially" is not a property the code can rely on: the SDK
fires every handler with `Promise.resolve().then(...)` and never awaits the previous one, and a single
assistant turn with two `mcp__…` blocks runs both at once. The design IS safe, for a reason the plan
does not state: `applySessionEnv` is **synchronous** (stat, read, parse, assign — no `await`), so an
apply is atomic with respect to the event loop; two overlapping calls cannot interleave their
restore/overlay halves, and the only exposure is an in-flight call whose *later* `process.env` read
sees a newer state — the terminal's behaviour too. Replace the premise with that argument and pin it:
the return type is non-Promise and the unit test asserts `applySessionEnv` never yields (amendment A4).

### 3.3 §2.5 applies the overlay AFTER `resolveStop` — **contradicts the plan's own "one environment per call"**

`process.env` is never restored *between* calls; it is left as the last apply left it. So the gate and
the form of call N+1 already run under call N's overlay — the "must not depend on disk state" rationale
in the inserted comment is not achieved by the placement, it is merely not *refreshed*. Either the
stop paths are env-independent (then a stat pair before them costs microseconds and buys "every path in
a call sees one environment"), or they are not (then they currently run on stale state). Move the call
to immediately after `commandEcho.reset()` (`:580`), before `resolveStop`; AC6 becomes "called once per
call, before `resolveStop`", which is also the simpler ordering test (amendment A5). Non-blocking if
the Planner can name a stop-path read that must NOT see the file; none was found.

### 3.4 Repo rules — no violation found

- Comment-the-why: the §2.5 comment is why-flavoured; the module JSDoc in §2.1 is fine.
- zod `.default()` in `infraKitConfigObject`: not touched.
- Counter-style loops: none specified; the Planner should write the restore/overlay walks as
  `for…of` over `touched`/`Object.entries` (reminder only).
- `process.exit` at entry: the module never exits or throws; correct for the long-lived server.
- MCP auto-confirm: no new confirm; the gate is untouched.

## 4. The real tradeoff tension

### T1 — "the server sees what the terminal sees" (P1) vs least privilege for an agent-driven process

P1 makes the server's view a *derived* fact with one definition, which is what kills the allowlist
(B‴) and the second reader-rule. Its price is that the definition includes `prod`: F7 shows `env-load`
is ungated, so the agent can call `env-load {config:'prod'}` and the next tool — and every `gh`,
`git`, `cmux` child — carries prod secrets, with no human in the loop. Least privilege would say the
MCP process should hold the *minimum* the current tool needs (an allowlist, or Option C's threaded
object), which is exactly what P1 forbids. Both cannot be maximised: every name you refuse to overlay
is a name whose "loaded" status now has two answers.

The plan resolves T1 for P1 and defers the privilege side to §9. That is the right resolution *for
this bug* — the widening is real but marginal (the `Bash` tool already hands `prod` to children) — but
the deferral must be stated as a tension in the ADR consequences, not as "a policy decision, not this
bug" (amendment A6). Synthesis that keeps P1 whole: gate *possession* at the writer, not the reader —
`env-load` of `isProtectedEnv(config)` under `'cli-only'` refuses over MCP. One check at one site,
P1 untouched, and it is the follow-up the plan already lists.

### T2 — signature short-circuit (P3 purity) vs exactness

`load:<mtimeMs>:<size>` skips the read when unchanged; two same-length writes inside one mtime tick
would alias. On APFS/ext4 (ns mtime) this is theoretical; on a coarse-mtime filesystem it is a stale
overlay for one call. Acceptable — say so in the §2.1 bullet rather than leave it implicit.

## 5. Additional findings

- **The harness seeds a file the parser ignores.** `makeDisposableSession` writes `export FOO=bar`
  (`mcp-harness.ts:85`); under the overlay this is state `load` with zero vars — the lanes on that
  fixture will see `session-env applied: set [] … (load, 0 vars)`. Harmless, but E-SE5's stderr
  assertions should use the `sec`-style `FOO='…'` form, not the harness default.
- **`sec` lane under the overlay.** After the overlay `FOO` IS in the server's `process.env`; the lane
  still passes because `env-status` never echoes values and matches only `sessionConfig`/
  `sessionTotalCount`. `sessionLoadedCount` flips 0→1 there. AC7 "byte-for-byte unchanged" holds; the
  plan should note that the lane's *meaning* shifts from "the file is not read" to "the value is not
  echoed", which is the stronger property anyway.
- **S1 guard regex.** Pin `process.env[…] =`, `process.env.X =`, AND `??=` (the `dev-server.ts`
  forms) under `src/mcp/` and `src/lib/tool-handler/`.
- **Log sinks.** MCP mode has two: stderr (`destination: 2`) and the world-readable
  `/tmp/mcp-infra-kit.log` (`logger.ts:6,36`). Names-only lines are fine in both; the plan's P5 should
  name the file sink explicitly so nobody later adds a `vars` field to the log object.
- **AC5's `none` clause** ("present again after `none`") is correct per §2.3 above but reads as a bug
  to a cold reader; add the `Bash`-child parallel as its justification.

## 6. Synthesis — what to keep, what to borrow

Keep from B: the seam, the zshenv rule, the never-overlaid set reused from the proxy, the
signature short-circuit, the injectable `applySessionEnv` for tests, the lazy baseline.

Borrow from A: nothing structural. Record the persisted-key fact (F9 addendum) so the next person who
proposes A does not re-derive it.

Borrow from C: one sentence — the threaded object is the mutation-free shape for a reads-only fix;
the ALL-vars decision is what rules it out.

## VERDICT: SOUND WITH AMENDMENTS

### REQUIRED (blocking)

- **A1 — §1.5 row A.** Reword (1) from "D2 fails outright" to "fails under the shim's all-or-nothing
  rule; an optional-vars mode is ~20 lines". Extend (2) with "`createConfirmCodec` already accepts a
  `key` (`confirm-token.ts:116`); a persisted key is ~10 lines". Add (5′): the self-kill race — the
  server is the file's writer, and a respawn-on-change proxy kills the child that wrote it. State the
  ground of rejection as writer-vs-reader plus (3)+(4), not (1).
- **A3 — P2.** "One behavioural seam; no command's logic changes" — §2.7's three text edits under
  `src/commands/` stop being a self-violation.
- **A4 — §2.6.** Delete "the plugin skills issue tool calls sequentially". Replace with: the v2 SDK
  dispatches handlers without serialisation and Claude Code parallelises a turn's tool calls; the
  design is safe because `applySessionEnv` is synchronous and therefore atomic per event-loop turn;
  the residual exposure is an in-flight call's later read, as in a terminal. Add a unit lane: the
  return value is not a thenable.
- **A6 — §10 Consequences.** Add: (i) T1 stated as a tension — P1 chosen, least-privilege deferred to
  the writer-side gate in §9; (ii) a long-lived child spawned by an MCP tool (`reopen` → cmux) keeps
  the environment of the call that spawned it across later clears; (iii) P5 names the
  `/tmp/mcp-infra-kit.log` sink.
- **A8 — scope line in §0 or §1.4.** The fix applies to sessions where the server inherited
  `INFRA_KIT_SESSION` (terminal-launched Claude Code with the init rc); elsewhere it no-ops with one
  log line and the defect persists, consistent with `env-load` over MCP throwing there.

### SUGGESTED (non-blocking)

- **A2 — §1.5 row C.** One clause: threaded env is the natural mutation-free shape for a reads-only
  fix; the user's ALL-vars decision (children included) is what rules it out.
- **A5 — §2.5 placement.** Move `applySessionEnv()` to after `commandEcho.reset()` and before
  `resolveStop`; AC6 → "once per call, before `resolveStop`". Keep the current placement only if a
  stop-path read that must NOT see the file is named.
- **A7 — §2.1 baseline bullet.** One sentence on why state `none` restores pre-launch vars (the
  `Bash` child does the same via Claude Code's launch env + a silent zshenv).
- **A9 — §3 S1 / §6.3.** Guard regex includes `??=`.
- **A10 — §6.4 E-SE5.** Seed `FOO='…'` (assignment form), not the harness's `export FOO=bar`, or the
  names line under test is `set []`.
- **A11 — §2.1 signature bullet.** State the mtime-tick aliasing bound (T2) explicitly.
- **A12 — §4.** Reminder for the implementer: iterate `touched` and the parsed entries with `for…of`;
  no counter loops.

# Round 1b — the plan moved under the review (§1.5, §2.1, §2.4, §2.8, AC9–12, E-SE6–9)

Re-read in full (607 lines). Round-1 amendments A1–A12 all still apply; A4 becomes MORE urgent
because the new §2.1 makes `applySessionEnv` async (see (b)). The three items the lead asked for:

## (a) Deleting baseline-held names on `env-clear` — SOUND, but the ADR's "never more" claim is now false

The `clear` branch subtracting the clear file's names from a baseline that holds them is exactly
what the shell does (`env-clear.sh` is the same `unset` list), and it is NOT irreversible: the names
go into `touched`, so the next apply restores them from the baseline before overlaying. That is P3
working as designed. Where it bites is the row §2.8 does not have — **flow 1, clear, then a load of a
different config**: `env-load dev` (terminal) → launch → `env-clear` → `env-load arthur`. Server:
restore `touched` (the `dev` pairs come BACK from the baseline) → overlay `arthur`. Interactive
terminal: `dev` was unset by the clear and `source arthur` does not bring it back. So the server holds
`dev`-only secrets the terminal no longer has. The `Bash` tool agrees with the server (Claude Code's
frozen env + a zshenv that sources only `arthur`), so P1-as-defined holds — but the §2.8 note and the
§10 sentence "the server holds fewer stale secrets, never more" are wrong in this direction. Amend to:
"the server equals a fresh zsh child of Claude Code, which can hold MORE (flow 1, clear→load) or
FEWER (flow 2, `dev`→`arthur`) than the interactive terminal" (amendment **A13**, required — it is an
ADR consequence stated backwards). Add the row to the §2.8 table and a unit lane to AC5.

## (b) Async-on-protected-only — UNSOUND as specified; the tear it opens is the one §2.6 claims cannot happen

`resolveProtectedEnvAccess` is `async` (`protected-env-access.ts:29-32`, awaits `getInfraKitConfig`).
§2.1 awaits it *inside* apply, only on a changed protected load. The SDK runs handlers concurrently
(round 1, §3.2), so during that `await` a second tool call enters `applySessionEnv`:

- if `lastSignature` was updated before the await, call 2 sees "unchanged", returns, and runs its
  handler on a **half-applied** environment (touched names restored to baseline, overlay not yet
  written) — `env-status` reports nothing loaded, a Jira read fails as "incomplete";
- if it was updated after, call 2 re-enters restore-then-overlay while call 1 is mid-flight, and the
  two interleave on `touched` (call 2 clears the set call 1 is about to add to), leaving names that
  are never restored on the next apply — a P3 violation that survives the session.

Either is a real bug, and it exists only because the policy read sits between the two mutation halves.
Fix (amendment **A14**, required): split apply into a pure async *plan* phase and a synchronous
*mutate* phase — `const plan = await planSessionEnv(state)` (stat, parse, policy; touches nothing) then
`commitSessionEnv(plan)` (restore + overlay, no `await`, one event-loop turn). The signature/`touched`
bookkeeping lives in the commit. Concurrency then reduces to "two commits of possibly different plans;
the later wins for both", which is the terminal's semantics and what §2.6 already accepts. Pin it: a
unit lane that starts two applies of different states without awaiting the first and asserts
`process.env` equals ONE of the two full results, never a mix.

On "two code paths through one seam": with the split there is one path (`await plan; commit`) whose
plan phase happens to be cheap for non-protected loads — that is fine. What would NOT be fine is the
plan's current wording "awaited ONLY when …", which is an implementation of the policy check leaking
into the contract; drop it.

## (c) "Withhold the pairs, apply the markers" — the env-status it produces IS misleading, and the protection it buys is porous

`env-status` under AC12 prints `prod: 0 of 16 vars loaded` and then the existing warning
(`env-status.ts:61-66`): *"16 cached var(s) are not present in the current process — env-load needs
to be re-sourced, or vars were unset manually."* Neither clause is true: nothing needs re-sourcing
and nothing was unset — the server withheld them by policy. An agent reading that will re-run
`env-load` (the skill tells it `env-status` "confirms the file the server will use"), see the same
line, and loop. So §2.4's "truthful, self-explaining" claim fails on the shipped text, and fixing it
means `env-status` DOES need a code change (a `withheld: 'protected-config'` field + a different
warning), which §2.7 says it does not.

The deeper problem is what the withholding protects. The agent's `env-load {config:'prod'}` over MCP
still writes the file (F7), and zshenv hands `prod` to every `Bash` child of the same session on the
next call. Reader-side withholding therefore keeps prod out of the MCP *process* while the same agent
can `Bash(printenv JIRA_TOKEN)` one turn later. It costs an async seam (b), a misleading `env-status`,
a policy read that keys on the CURRENT repo's `protectedEnvs` while the file may belong to another
repo (the session dir is per terminal, not per project — `INFRA_KIT_ENV_PROJECT_ROOT` says which),
and a fail-open in flow 1 (baseline-held prod pairs are restored on every apply, so "withheld" values
are silently the possibly-stale launch values) — and buys no isolation the agent cannot bypass.

Recommendation (amendment **A15**, required, and the resolution of round-1 T1): **gate possession at
the writer, not the reader.** `envLoad` over MCP refuses a protected config under `'disallow'`/
`'cli-only'` via the same `isProtectedEnv` + `resolveProtectedEnvAccess` (already async there; the
command is async) with the standard `PROTECTED_ENV_DENIED`/`mcp-blocked` remediation. Then: the
overlay applies every file in full (the user's "overlay ALL" decision, §1.5 B‴, holds for prod too),
`applySessionEnv` stays synchronous (b disappears), `env-status` needs no change (§2.7 holds), the
policy is read once at the one site that already knows the config, and the agent cannot put prod into
the `Bash` tool's env either. Flow 1 with prod (human typed `ik env-load -c prod`, then launched) is
untouched, exactly as §2.4 already concedes for the baseline. §2.4's table collapses to the row the
plan itself calls "the alternative the user may prefer", plus one sentence pointing at the writer gate.
If the user wants BOTH (writer gate and reader withholding), the reader side must still ship as (b)'s
plan/commit split and with a `withheld` field on `env-status` — but it is belt on top of braces.

## Round-1b verdict

Still **SOUND WITH AMENDMENTS**, with three new required items:

- **A13** — §2.8/§10: replace "fewer stale secrets, never more" with the two-directional statement;
  add the flow-1 clear→load row and an AC5 lane.
- **A14** — §2.1: split `applySessionEnv` into an async pure plan phase and a synchronous commit;
  drop "awaited ONLY when"; add the two-overlapping-applies unit lane.
- **A15** — §2.4: move the protected-config decision to `envLoad` over MCP (writer-side refusal);
  the overlay applies every file in full; `env-status` unchanged. If reader-side withholding is kept
  regardless, `env-status` gains a `withheld` reason and its warning text branches on it (§2.7 must
  then say "one code change"), and AC12 asserts the new text, not the re-source warning.

# Round 2 — re-review of revision 2

Re-read in full (717 lines, §11 lists the applied items). Every load-bearing citation added in
revision 2 was re-checked: `env-load.ts:297` is the `writeEnvLoadFile` call the gate would precede;
`PROTECTED_ENV_DENIED` is `{allowed:false, reason:'disallow'}` (`protected-envs.ts:51`);
`resolveProtectedEnvAccess` is async and its `'cli-only'` branch reads `isMcpMode()` at call time
(`protected-env-access.ts:29-45`); `failedReleases` is the structured field (`release-create.ts:440,521`);
`atomicWriteFileSync` is temp-file + `renameSync` (`constants.ts:263-270`), so `ino` moves per write.

## R2.1 Required amendments — disposition

| Item | Applied in substance? | Where |
|---|---|---|
| A1 row A | **Yes** — writer-vs-reader is the stated ground; injectable key and optional-vars cost recorded | §1.5:209 |
| A3 P2 | **Yes** — "one behavioural seam; no command's logic changes" | §1.1:150 |
| A4 §2.6 | **Yes** — SDK microtask dispatch + Claude Code parallelism named; synchronous apply is the safety property; non-thenable + overlap lanes | §2.6:342-354, §6.1:558-560 |
| A6 ADR | **Yes** — T1 as a tension, long-lived child, both sinks | §10:667-687 |
| A8 scope | **Yes** — under the defect statement, plus S5 | :16-19, §3 S5 |
| A13 | **Yes** — two-directional note, the clear→load row is in the §2.8 prose and the ADR; AC5 lane | §2.8:400-403, §10:677-680 |
| A14 | **Satisfied by construction** — with no `await` on the seam there is nothing to split; the plan/commit shape was only ever the cure for the async policy read, which is gone | §2.1:234-239 |
| A15 | **Yes** — reader-side withholding is B⁗ (rejected), base design applies all, writer gate optional | §1.5:216, §2.4 |

## R2.2 Synchronicity — VERIFIED

`readSessionEnvState` and `applySessionEnv` are typed as plain returns (§2.1:232,239); §2.5 calls
`applySessionEnv()` with no `await`; the injectable is `() => void`; every dependency on the path is
sync (`getSessionCacheDir`, `statSync`, `readEnvFileContent`, the two parsers, pino's `logger.info`).
The §2.6 argument is now correct: atomicity per event-loop turn is exactly the property a
microtask-dispatched handler set needs, and the residual (an in-flight call's later read) is stated.
One note for the implementer, not the plan: the "two applies started back-to-back without awaiting"
lane is tautological once the function is sync — keep it anyway as the guard that fails the day someone
adds an `await`.

## R2.3 §2.4-opt — three of the Critic's four conditions hold; the picker condition is CONTRADICTED

Own declinable commit (§4 step 5) — yes. OFF by default — yes (§2.4:302, "OFF unless the user says
on"). No file written on refusal — yes: the check sits before `writeEnvLoadFile` at `env-load.ts:297`,
and the `OperationError` shape mirrors `assertDeployable`'s two remediations (`protected-envs.ts:126-141`).
AC13 + unit table — yes (§5:539-542, §6.1:562-563); the e2e lane §2.4-opt promises ("one e2e lane")
is not listed in §6.4 — E-SE9 is now AC12, and §4 step 4 says "E-SE1–E-SE8" while §6.4 defines E-SE9.

**Picker:** §2.4:311 says the form provider "keeps listing `prod` so the refusal, not the list,
teaches the rule". That is the opposite of the condition, and the repo precedent is against it:
`deploy-form.ts:162` already filters its env list through `deployableEnvs(…, await resolveProtectedEnvAccess())`
— the deploy picker never offers an env the gate would refuse. A gate that is ON with a picker that
still offers `prod` produces a round trip whose only outcome is a refusal, and it makes the
elicitation form (a HUMAN answering) refuse what a human chose, which reads as a bug rather than a
rule. When the gate is on, `env-load-form.ts` must filter with the same `resolveProtectedEnvAccess`
under `isMcpMode()`, mirroring `deploy-form.ts:162`; the refusal stays as the backstop for a typed
`config` argument that bypasses the form (**R2-1**, required if §2.4-opt ships).

## R2.4 A5 placement — traced, does not break the gate or the form

`tool-handler.ts` closure order after the edit: `ensureUserProjectConfig()` (:574) → `commandEcho.reset()`
(:580) → `applySessionEnv()` → `resolveStop` (:587) → stop-return (:589) → `handler` (:591).
`resolveStop`'s three stop paths read nothing the overlay writes: the gate mints from `toolName` +
canonical params (`confirm-token.ts:164-190`); verify checks the token; the form calls
`buildArgumentForm(formProvider, params, deadline)` whose only env read is `INFRA_KIT_ENV_TOKEN`
(`env-load-form.ts:46`) — never in the load file (`CREDENTIAL_SECRET_KEYS`), hence never in a clear
file's `unset` list, hence untouched by any apply. Round 1 (gate) and round 2 (confirm) each apply;
the second is a signature no-op unless a load landed, which is S2 and accepted. The mutation build
injects the no-op. P6 holds. Nothing to amend.

## R2.5 New defects introduced by the revision

- **`ino` in the signature** — sound: rename always lands a new inode on the same filesystem; an
  ext4 inode reuse would also need identical `mtimeMs` and `size`, which is not a state worth naming.
  A11's decline is accepted.
- **Lane numbering drift** — §4 step 4 "E-SE1–E-SE8" vs §6.4's E-SE9, and §2.4-opt's promised e2e
  lane has no E-SE number (**R2-2**, editorial).
- No other new defect found. The revision removed the only non-atomic step and did not add a
  process-scope side effect, a `.default()`, a counter loop, or an exit outside the entry.

## VERDICT: SOUND WITH AMENDMENTS

### R2-REQUIRED (blocking only if §2.4-opt is switched on)

- **R2-1** — §2.4-opt: the env picker filters protected configs through `resolveProtectedEnvAccess()`
  under `isMcpMode()` (the `deploy-form.ts:162` precedent); the refusal remains for a typed `config`.
  Replace the "keeps listing `prod`" sentence; add the picker case to AC13 and the unit table.

### R2-SUGGESTED (non-blocking)

- **R2-2** — §4 step 4 → "E-SE1–E-SE9"; give §2.4-opt's e2e lane a number (E-SE10, optional) in §6.4.

With R2-1 applied (or §2.4-opt left off), the base design is SOUND.

# Round 2b — the §2.4 addendum (759-line revision 2)

Citations re-verified against the tree: `env-load-form.ts:77-78` is `buildRequestedSchema` calling
`listProjectEnvs()`; `env-load.ts:297` is the `writeEnvLoadFile` call the refusal precedes (and the
Doppler download happens inside it, so "no file, no Doppler call" holds); `deploy-form.ts:162` is the
filtering precedent; `protected-envs.ts:51` is `PROTECTED_ENV_DENIED`; P1 (:146-150) now names the
`Bash` tool as the comparator, which is the definition the §2.8 two-directional note needs; §2.6:380
states the plan/commit split is unnecessary under a sync apply — agreed, that was A14's whole point.

- **R2-1 — APPLIED.** The picker filters protected envs under `!access.allowed`, mirroring
  `deploy-form.ts:162`; the refusal stays as the backstop for a typed `config`; AC13 asserts the
  form's choices and the byte-identical session dir. The `await resolveProtectedEnvAccess()` lives in
  `buildRequestedSchema` (the form path inside `resolveStop`), not in the apply — the seam stays sync.
  One consequence the plan already covers by construction: when filtering leaves zero envs,
  `buildRequestedSchema` returns `null` (`env-load-form.ts:82-86`) and the call degrades to the gate,
  which is the documented "no options" behaviour, not a new path.
- **R2-2 — APPLIED.** E-SE10 numbered; §4 step 5 lists every file the gate touches.
- The two-row menu is the right shape: reader-side withholding is withdrawn (B⁗), so the user
  chooses between the writer gate and F7-as-is, and neither choice touches the overlay.

## VERDICT: SOUND

No open amendments. Row (a) is the architect's recommendation, for the reason §2.4 now states: it is
the only site that can gate possession without a second definition of "loaded", and it is the only
one that keeps `prod` out of the `Bash` tool's env as well as the MCP process.
