# Critic review — in-process session-env refresh at the MCP tool chokepoint

Reviewer: critic pass of a ralplan `--deliberate` consensus loop (iteration 1). Read-only with respect
to `docs/mcp-session-env-refresh-plan.md` (revision 1, `pending approval`),
`docs/mcp-session-env-refresh-plan.architect-review.md` (SOUND WITH AMENDMENTS; required A1, A3, A4,
A6, A8) and all source. This file is the only artefact written. Tree: `main` @ `388ec26`, two
untracked docs. `«cli»` = `apps/infra-kit/cli/`. Every line number below was read from that tree.

The plan is evaluated **as written** — the Planner has not applied the Architect's amendments, and an
unapplied required amendment is by itself grounds for ITERATE. The Architect's five required items are
correct and are not re-argued; I extend three of them (A4, A6, A10) and add findings of my own. The
decision — Option B, the overlay at `tool-handler.ts:591` — is right and nothing below overturns it.

What blocks approval is narrower than the length of this file suggests: one design contradiction the
Architect's A4 exposes but does not resolve (§2.4 cannot be synchronous, because `getInfraKitConfig`
is `async`-only), one false claim at the centre of §2.4 (the withheld-prod `env-status` is not
"self-explaining" — its warning names two wrong remedies and sends an agent into the exact
refusal-with-no-exit loop `release-remove.ts:226-231` was written to avoid), and three acceptance
criteria that are not observables (AC1 is negative-only and false-greens on the plan's own fixture
caveat; AC9 compares against a HEAD that no test can run; AC3 will red on the URL sentinel).

## 0. Claim verification (beyond the Architect's table)

| Claim | Verdict | Evidence |
|---|---|---|
| F1 "nothing before `:591` reads a session variable" | **INEXACT** | `env-load-form.ts:46` reads `process.env[INFRA_KIT_ENV_TOKEN_VAR]` on the FORM path, i.e. inside `resolveStop`. The plan's own F6 lists it. The name is never in the file (F5) so the overlay cannot change it, but the sentence the §2.5 placement rests on is not true as stated — one more reason to take A5 |
| §2.1 "`applySessionEnv` is `async` … every other call is a synchronous stat + compare behind a `Promise`" vs Architect A4 "the design is safe because `applySessionEnv` is synchronous … pin: the return value is not a thenable" | **CONTRADICTION, unresolvable as designed** | `resolveProtectedEnvAccess` is `async` and awaits `getInfraKitConfig()` (`protected-env-access.ts:29-35`); `infra-kit-config.ts` exports no synchronous accessor (`:471,519` are both `async`). §2.4's per-file policy read therefore forces an `await` inside the apply on the protected path. A4's unit lane ("not a thenable") fails against §2.1's declared return type `Promise<…>` |
| §2.5 injectable type `applySessionEnv?: () => void` | **INCONSISTENT with §2.1** | §2.1 returns `Promise<{set,unset,withheld,changed}>`; the seam's own parameter type says `() => void`. One of the two is wrong; the choice is the A4 decision |
| §2.4 "`env-status` over MCP reports `prod: 0 of <n> vars loaded` and its existing warning — a truthful, self-explaining answer" | **FALSE** | The warning text is `"<n> cached var(s) are not present in the current process — env-load needs to be re-sourced, or vars were unset manually."` (`env-status.ts:63-65`). Under withholding neither remedy is true or possible over MCP; the line before it says `(manually loaded, …)`. And the `env-load {config:'prod'}` result that preceded it reported success with `<n>` vars. See §7 |
| AC1's e2e can only fail "after `loadJiraConfig`" | **NOT GUARANTEED** | `assertManagementContext` (`git-guard.ts:145-157`) runs first and refuses a dirty tree; the plan's E-SE4 note admits the `git init`'d fixture (`env-picker-fixture.ts`, no commit, no `origin`) is dirty until committed. A refusal there is ALSO "not `Jira configuration is required but incomplete`", so AC1 as worded passes without the overlay ever having run. See §4 |
| `mcp` command never runs the auto-loader (S1 exposure) | **VERIFIED** | `program.ts:400` `AUTO_LOAD_EXCLUDED` includes `'mcp'`; `:421` `SEED_EXCLUDED` too. No in-process `process.env` writer under `src/mcp/` or `src/lib/tool-handler/` today (grep) — the S1 guard pins a currently-true invariant |
| The e2e needs a prior `pnpm build` | **NO** | `mcp-harness.ts:33-46` builds the bundle hermetically from `scripts/build.js`'s `buildOptions`; §7's commands are correct on that point |
| §7 plugin test command `cd plugins/infra-kit && node --test __tests__/` | **NOT THE HOUSE RUNNER** | No `package.json` under `plugins/infra-kit`; the runner is the root `pnpm run test:claude` (`package.json:24`), whose glob also covers `plugins/infra-kit/skills/*/__tests__/*.test.mjs`. No skill test pins the "frozen" sentences today (grep), so the miss is latent, not red |
| `release-create` step order after the Jira read | **VERIFIED** | `collectEntries` → `assertBaseBranchSwitchable` → `confirmReleases` (auto-skipped) → `executeOne({entry, jiraConfig})` (`release-create.ts:395-425`). In a fixture without `origin` the first failure after `loadJiraConfig` is a git refusal, not a Jira network error — AC1's "whatever the first network/`gh` step raises" is not one named thing |
| Signature `load:<mtimeMs>:<size>` | **CAN BE MADE EXACT FOR FREE** | `atomicWriteFileSync` (`constants.ts:263-270`) writes a new temp file and `renameSync`s it into place, so every write lands a NEW inode. Adding `ino` to the signature closes the Architect's T2 aliasing outright instead of "acceptable, say so" |
| The `/tmp/mcp-infra-kit.log` sink | **VERIFIED world-readable + pino `redact`** | `logger/index.ts:6,11,36`; the `Tool execution started` line already logs `params` (`tool-handler.ts:563`). A names-only string line is safe in both sinks; a `vars` object would not be |

## 1. Principle–option consistency — **FAIL** (two principles violated by the chosen design; one principle mis-worded)

- **P1 ("the server sees what the terminal sees") vs §2.4.** For a `prod` file under `'disallow'`
  (the default) or `'cli-only'`, the server deliberately does NOT see what the terminal sees — the
  plan says so itself ("that asymmetry is accepted"). A principle with a carved exception that the
  chosen option introduces is a principle–option inconsistency by definition. Either P1 is amended to
  state the exception, or §2.4 goes (my recommendation — §7).
- **P2 ("zero edits under `src/commands/`") vs §2.7** — Architect A3, unapplied. Three text edits
  under `src/commands/` are in the plan. Required.
- **P3 (pure function of baseline + disk)** holds for the non-protected path; on the protected path
  the result is a function of `(baseline, disk, merged config)` and, because of the `await`, of
  interleaving — see §3.
- **P5 (names, never values)** holds for what the plan writes; it must name the file sink (A6 iii).
- Are the principles the right ones? P1–P5 are, with one missing: **"one environment per call"** is
  argued in §2.5's comment but is not a principle and, as the Architect shows (§3.3), is not delivered
  by the placement. Promote it (and take A5) or drop the comment's claim.

## 2. Fair alternatives — **FAIL as written** (A1 unapplied; A2 suggested)

- **Option A.** The plan's row (1) "D2 fails outright" is overstated — the shim's all-or-nothing rule is
  ~20 lines to relax (`mcp-proxy.ts:223,285`); row (2) omits that `createConfirmCodec` accepts an
  injected `key` (`confirm-token.ts:112-116`), so the `mac` refusal across a respawn is ~10 lines. The
  Architect is right that the true killer is structural: **infra-kit's server is the file's writer**,
  and a respawn-on-change proxy kills the child that wrote the file (`upstream.ts:122-125`, 2 s poll)
  — a race no proxy option cures without learning which tool writes. Rows (3) era/capability
  passthrough (the env picker's elicitation is unmeasured through the proxy) and (4) detector +
  manifest lockstep stand. Rewrite the row on those grounds (A1). With A1 applied the steelman is
  honest and the rejection is sustained.
- **Option C.** The row rejects C on blast radius ("every read site … every child spawn"). The honest
  ground is the user's fixed decision: ALL vars, children included, means one definition of "loaded"
  in-process AND for `gh`/`git`/`doppler` children; a threaded object gives two. Say so (A2). The
  plan's row is not dishonest, it just argues from convenience where a user decision exists.
- **B′/B″/B‴** are fairly dismissed. B‴'s record of the user's decision is the load-bearing sentence of
  the plan and is correctly quoted.

## 3. Risk mitigation clarity — **FAIL** (concurrency argument false; §2.4 makes the fix non-atomic)

| Risk | Plan's mitigation | Verdict |
|---|---|---|
| Concurrent handlers | §2.6 "the plugin skills issue tool calls sequentially" | **FALSE premise** (Architect §3.2, A4 required, unapplied). The v2 SDK dispatches each request in its own microtask; Claude Code parallelises a turn's tool calls |
| … and the sync-atomic replacement argument | A4: "`applySessionEnv` is synchronous, therefore atomic per event-loop turn" | **Not achievable with §2.4 as designed.** The protected path awaits `resolveProtectedEnvAccess()` → `getInfraKitConfig()` (async-only). Sequence: call X stats `prod`, awaits config; `env-load dev` completes; call Y applies `dev` synchronously; X resumes and applies its stale `prod`-withheld state over Y's — `process.env` now says `prod, 0 loaded` while disk says `dev`. Self-corrects on the next call (the signature differs), so the exposure is bounded to one call — but that is a second, weaker guarantee for one seam, and it is exactly the "two code paths through one seam" the lead asked about. It is a defect, not a style choice |
| Long-lived children keep a stale env | not mentioned | **MISSING** — `reopen` → cmux (`open-dev-workspace.ts:37`, `{...process.env}`) keeps the spawning call's env across later clears. Consequence to state (A6 ii); same as a terminal, not a regression |
| Prod file reaches MCP tools ungated (T1) | §2.4 reader-side withholding | **Incoherent** — see §7. The Architect's synthesis (gate possession at the writer: `env-load` of a protected config over MCP under `'cli-only'`/`'disallow'` refuses) is the one-site fix that keeps P1 whole; the plan lists it only as a §9 follow-up |
| World-readable log sink | P5 "names in logs, never values" | **PASS with A6 iii** — name `/tmp/mcp-infra-kit.log` so nobody adds a `vars` field to the log object |
| mtime-tick aliasing of the signature | not stated | **Cheap exact fix available**: add `ino` (atomic rename ⇒ new inode per write). Replaces A11's "state the bound" with "there is no bound" |
| `INFRA_KIT_SESSION`-absent launch | §2.1 `no-session`, one log line, no-op | **PASS mechanically; scope claim missing** (A8): desktop-app / IDE-extension / no-init-rc launches keep the defect. State it in §0 or §1.4 |
| Baseline captured after another writer | S1 + guard test | **PASS**; extend the regex to `??=` (A9). Verified: no such writer exists under `src/mcp/` or `src/lib/tool-handler/` today |
| Torn read (S3) | atomic rename; ENOENT → `''` → zero-var `load`, corrected next call | **PASS**, but no test is named for the "vanishes between stat and read" branch — add one unit lane (mock `readFileSync` to throw once) or drop the claim that it is "bounded to one call" from the pre-mortem |

## 4. Testable acceptance criteria — **FAIL** (AC1, AC3, AC9, AC12 are not sound observables; AC11 is garbled)

| AC | Verdict | Why |
|---|---|---|
| AC1 | **FALSE-GREEN RISK** | Negative-only: "no longer `Jira configuration is required but incomplete`". A refusal from `assertManagementContext` (dirty fixture — the plan's own E-SE4 caveat), from `assertBaseBranchSwitchable`, or from a missing `origin` all satisfy it with the overlay never having run. Pin a POSITIVE identity reachable only after `loadJiraConfig` returned (trace the fixture: name the exact git/`gh` refusal, assert `toMatch(<that>)` AND `not.toMatch(/incomplete/)`), and keep §6.2b as the in-process positive proof it already is |
| AC2 | PASS | Three named `structuredContent` fields across load/clear/reload, one connection |
| AC3 | **WILL RED or is vacuous** | `JIRA_BASE_URL='http://127.0.0.1:1'` is a value that legitimately surfaces in a connection error (`ECONNREFUSED 127.0.0.1:1`) and the tool-handler logs `err` (`:597-601`). Scope the no-value assertion to secret-shaped sentinels (`JIRA_TOKEN`, `JIRA_EMAIL`) with unmistakable values, and say the URL is exempt |
| AC4 | PASS | Two named lines, two observables (`PATH` unchanged, session dir unchanged) |
| AC5 | PASS | Add the `Bash`-child parallel as the justification for "present again after `none`" (A7) |
| AC6 | PASS as an ordering test; becomes simpler under A5 ("once per call, before `resolveStop`") | |
| AC7 | PASS; note the `sec` lane's meaning shifts from "not read" to "not echoed" (`sessionLoadedCount` 0→1) | |
| AC8 | PASS | Grep with `EXIT=1` expected — a real observable. Add the `release-remove` skill's `A server spawned by a host does not inherit` sentence to the grep, it is the third literal |
| AC9 | **NOT AN OBSERVABLE** | "Byte-for-byte the same `env-status` result as HEAD" — no test runs HEAD. Replace with a hand-pinned expected payload (deterministic: `sessionConfig`, counts, `autoLoaded`, `cleared`, `sessionLoadedAt` from the file's marker) and keep "`changed:true`, every name already equal, `process.env` deep-equal before/after" as the unit half |
| AC10 | PASS | |
| AC11 | **GARBLED** | "equal on every field except `sessionId`-independent ones that are equal by construction" does not parse. Intended: equal on every field; `sessionId` is equal because both servers get the same `INFRA_KIT_SESSION`. Add: S1's launch env MUST be built by `parseVarsFromEnvFile` over the same file, not by hand, or `sessionLoadedAt` drifts and the equality is a fixture accident |
| AC12 | **ASSERTS A MISLEADING OUTPUT** | It pins the warning "not present in the current process — env-load needs to be re-sourced, or vars were unset manually" as the expected behaviour. See §7; the AC survives only if §2.4 survives in a form whose `env-status` output is truthful |
| E-SE5 seeding | **BUG** (A10) | `makeDisposableSession` writes `export FOO=bar` (`mcp-harness.ts:85`), which `ENV_VAR_LINE_PATTERN` skips → the names line under test is `set []`. Seed the `sec` form `FOO='…'` (`mcp-stdio.e2e.test.ts:1263` already shows the exact shape) |

## 5. Concrete verification steps — **PASS with two corrections**

- `; echo EXIT=$?` is on every line and the memory rule is cited. Good.
- Targeted vitest files are right; the e2e builds hermetically (no `pnpm build` needed).
- **Correct:** the plugin runner is the root `pnpm run test:claude ; echo EXIT=$?`, not `node --test
  __tests__/` in a directory with no `package.json`.
- **Missing:** after step 5 (publish), the consumer machines run the GLOBAL infra-kit (memory: consumer
  repos run the global; `pnpm add -g …@latest` is served from a stale metadata cache). Add
  `pnpm add -g infra-kit@<exact version>` + `infra-kit version` as the step between CLI publish and
  the V0 manual run, or V0 runs against the old binary and "proves" nothing.
- Publish order (CLI, then plugin) is right and the reason given is right.

## 6. Deliberate mode — **PASS, thin**

- Pre-mortem: S1–S4 are concrete; S1→guard test, S3→design (no test named), S4→AC4, S2 is
  consciously not mitigated. Add S5: the async-protected interleave of §3 (or make it vanish by
  resolving §7). Add S6: `no-session` scope (A8).
- Test plan covers unit (§6.1), integration (§6.2, §6.2b), bundle guard (§6.3), e2e (§6.4),
  observability (§6.5). The observability assertion lives in E-SE5, which is seeded wrongly (A10).
- §6.2b is the strongest lane in the plan — in-process, deterministic, and positive. Keep it as the
  primary proof and let the e2e be the "through the real process" corroboration it is.

## 7. Protected-config proposal (§2.4) — **FAIL as designed**

Three independent reasons, any one of which is enough:

1. **The output it produces is misleading, and the plan claims the opposite.** After `env-load
   {config:'prod'}` over MCP returns success with `<n>` vars, `env-status` prints `prod: 0 of <n>
   vars loaded (manually loaded, …)` followed by `"<n> cached var(s) are not present in the current
   process — env-load needs to be re-sourced, or vars were unset manually."` Both remedies are wrong;
   the first is not even possible over MCP. An agent reading that will call `env-load` again, which
   succeeds again, which withholds again — the refusal-with-no-exit loop that
   `release-remove.ts:226-231` documents as the shape to avoid. "Truthful, self-explaining" is not a
   property of this output; it would need a new `withheld`/`policy` field in `structuredContent` and
   a new warning branch in `env-status.ts` — i.e. edits under `src/commands/` that are behavioural,
   which P2 (even as amended by A3) forbids.
2. **It does not bind the paths it claims to.** Flow 1 (terminal `ik env-load -c prod`, then launch)
   hands the server prod in full — admitted. `Bash(ik …)` sees prod via zshenv — admitted. So the
   rule withholds on exactly one path, the agent's own `env-load prod` over MCP — which is the
   writer-side gate the Architect names, implemented at the wrong end (the reader), with a policy
   enum whose documented meaning is deploy access ("may reach the delivery-shaped environments",
   `protected-env-access.ts:8-10`; memory: the flat enum was approved for deploy gating), now
   re-read as possession.
3. **It is what makes the seam non-atomic** (§3): the only `await` in `applySessionEnv` exists to
   serve this table.

The simpler alternative — apply every file, `prod` included; the deploy gates (`assertDeployable`,
reading the setting + `isMcpMode()`, not `process.env`) hold either way — IS recorded in §2.4's last
paragraph, fairly but as the option the plan ships against. It is also the option the user's decision
already covers ("when we load from Doppler, everything loads"); the plan carved a per-file exception
the user did not ask for and then flagged it as "the one item the user has not weighed in on".

**Recommendation:** ship apply-all (fully synchronous `applySessionEnv`, A4 satisfied, P1 whole, AC12
dropped), and present the user ONE policy question, separately: "should `env-load` of a protected
config over MCP refuse under `'disallow'`/`'cli-only'` (writer-side, one check at one site, §9)?" If
the user wants the reader-side table anyway, the plan must (a) resolve the policy OUTSIDE the apply
— read `resolveProtectedEnvAccess()` once at server bootstrap or in the chokepoint before a
synchronous `applySessionEnv(state, access)` — so the mutation stays atomic, and (b) add the
`withheld` field + a truthful warning branch to `env-status`, and re-word P2 to allow it.

## 8. Scope creep / missing scope — **PASS with additions**

- Skill texts: `session/SKILL.md:52-54` and `:137` (verified), `release-remove/SKILL.md:32-36`
  (verified), `release-create/SKILL.md:27-29` (verified) — all in scope. `doctor/scripts/
  session-probe.mjs:243` "restart Claude Code" is about plugin reinstall — correctly untouched.
- `release-remove.ts:226-236` — in scope; the replacement remediation is right. Its
  `assertMcpRemoveInput` refusal of `skipJira` is unchanged, so the loop the comment describes stays
  closed.
- Plugin bump 0.7.10→0.7.11 with `.mcp.json` unchanged — right; the skew report surfaces the pair.
- Memory-noted rules: no counter loops (A12 — write the restore/overlay walks as `for…of`); why-comments
  (the §2.5 comment is why-flavoured; the `applySessionEnv` JSDoc's "Idempotent" sentence restates
  the type — drop it); no zod `.default()` — not touched; `process.exit` — module never exits or
  throws, correct for the long-lived server.
- **Missing:** the §5 publish step's global install (above); root `pnpm run test:claude`; `ino` in
  the signature; `??=` in the S1 regex (A9); the third grep literal for AC8.
- **Creep:** none. The module is the right size; the `parseUnsetNamesFromEnvFile` helper in
  `constants.ts` beside its siblings is the right home.

## VERDICT: ITERATE

The design is right and the evidence base is unusually good. It cannot be approved with five required
amendments unapplied, one of which (A4) cannot be applied at all until §2.4 is resolved, and with four
acceptance criteria that would pass against a broken implementation.

### BLOCKING — numbered, deduplicated with the Architect's REQUIRED set (round 1 + 1b)

Item 4 is rewritten after the Architect's round-1b (A13–A15, see the section at the end of this file);
items 4a–4b are new.

1. **A1** — §1.5 row A: reword (1) ("all-or-nothing rule, ~20 lines to relax"), extend (2) with
   `createConfirmCodec({key})` (`confirm-token.ts:112-116`, ~10 lines), add (5′) the writer-vs-reader
   self-kill race (`upstream.ts:122-125`); ground the rejection on (5′)+(3)+(4).
2. **A3** — P2 → "one behavioural seam; no command's logic changes". §2.7's three text edits stop
   being a self-violation.
3. **A4 + §3 above** — §2.6: delete the "skills issue calls sequentially" premise; state the v2 SDK
   microtask dispatch + Claude Code parallelism; ground safety on `applySessionEnv` being
   SYNCHRONOUS (non-thenable return, unit lane pins it). This is only satisfiable once item 4 is
   decided; §2.1's `Promise<…>` return and §2.5's `() => void` injectable type must agree.
4. **§2.4 / A15 (crit. 7)** — drop reader-side withholding from the plan entirely; the overlay
   applies every file in full (the user's ALL decision; deploy gates hold) and `applySessionEnv` is
   synchronous. Put ONE policy question to the user, recommended answer YES: "`env-load` over MCP
   refuses a protected config under `'disallow'`/`'cli-only'` (writer-side gate, own commit, own AC
   + e2e lane, one skill sentence, picker filters protected configs)". The alternative on the menu
   is "no gate — F7 stays as today", NOT reader-side withholding. Delete the "truthful,
   self-explaining" sentence; AC12/E-SE9 become the gate's lanes or are removed. (My endorsement and
   its conditions: round-1b section below.)
4a. **A13** — §2.8/§10: "fewer stale secrets, never more" is backwards. Add the flow-1
   clear→`env-load arthur` row (server restores the `dev` pairs from the baseline; the interactive
   terminal does not have them; the `Bash` tool does) and state the comparator precisely: the
   server equals a zsh CHILD OF CLAUDE CODE (the `Bash` tool), which can hold MORE or FEWER than the
   interactive terminal. Pin P1's wording to that comparator; add the AC5 lane.
4b. **A14** — if any `await` remains in the apply (it does not under item 4's recommendation), split
   into an async pure `plan` phase and a synchronous `commit` phase with the signature/`touched`
   bookkeeping in the commit; drop "awaited ONLY when …"; add the two-overlapping-applies unit lane
   asserting `process.env` equals one full result, never a mix.
5. **A6** — §10 Consequences: (i) T1 stated as a tension (P1 chosen, least-privilege deferred to the
   writer-side gate); (ii) a long-lived child spawned by an MCP tool (`reopen` → cmux,
   `open-dev-workspace.ts:37`) keeps the env of the call that spawned it across later clears;
   (iii) P5 names `/tmp/mcp-infra-kit.log` as the second sink.
6. **A8** — scope line in §0 or §1.4: the fix applies where the server inherited `INFRA_KIT_SESSION`
   (terminal-launched Claude Code with the init rc); elsewhere it no-ops with one log line and the
   defect persists.
7. **AC1** — replace the negative-only observable with a positive identity reachable only after
   `loadJiraConfig` returned (trace the fixture's first post-Jira refusal and name it), plus
   `not.toMatch(/incomplete/)`. The fixture commit + `origin` needs are stated in the lane, not
   "verify in the lane".
8. **AC9** — replace "byte-for-byte the same as HEAD" with a hand-pinned expected `structuredContent`;
   keep the unit half (`changed:true`, all names equal, deep-equal before/after).
9. **AC3** — restrict the no-value assertion to secret-shaped sentinels (`JIRA_TOKEN`, `JIRA_EMAIL`);
   say the URL may surface in a connection error.
10. **AC11** — rewrite the garbled sentence; require S1's launch env to be built by
    `parseVarsFromEnvFile` over the same file.
11. **A10 / E-SE5** — seed `FOO='…'` (assignment form), not the harness's `export FOO=bar`, or the
    names line under test is `set []`.
12. **§7 commands** — plugin tests via root `pnpm run test:claude ; echo EXIT=$?`; add
    `pnpm add -g infra-kit@<exact>` + `infra-kit version` between CLI publish and V0.

### NON-BLOCKING

13. **A5** — move `applySessionEnv()` to after `commandEcho.reset()` (`:580`), before `resolveStop`;
    AC6 → "once per call, before `resolveStop`". F1's "nothing before `:591` reads a session
    variable" is inexact (`env-load-form.ts:46`); fix the sentence whichever placement wins.
14. **Signature** — `load:<mtimeMs>:<size>:<ino>`; atomic rename guarantees a new inode per write,
    so T2 disappears instead of being bounded (supersedes A11).
15. **A2** — §1.5 row C: one clause naming the ALL-vars decision as the ground.
16. **A7** — §2.1 baseline bullet: why state `none` restores pre-launch vars (the `Bash` child does
    the same).
17. **A9** — S1 guard regex includes `??=`.
18. **A12** — `for…of` over `touched` / parsed entries; no counter loops.
19. **S3** — name the unit lane for "file vanishes between stat and read" or drop "bounded to one
    call" from the pre-mortem.
20. **AC8** — add the `release-remove` skill's "does not inherit an `ik env-load`ed shell" literal to
    the grep.
21. **§2.1 JSDoc** — "Idempotent; a no-op when the signature has not changed" restates the return
    type's `changed` field; keep only the why (the stat pair is the cost model).
22. **§6.2b** — call it out as the primary positive proof; the e2e corroborates through the real
    process.

## Round 1b — the Architect's A13–A15, verified, and my position on A15

All three are correct against the tree and all three land where my §3 and §7 already pointed.

### A13 — confirmed; and it exposes that P1's comparator is ambiguous

Traced: flow 1 (`ik env-load -c dev` → launch; baseline holds `dev`) → `env-clear` (server deletes the
`dev` names, records them in `touched`) → `env-load arthur` (server restores `touched` from the
baseline — the `dev` pairs come BACK — then overlays `arthur`). The interactive terminal unset `dev`
at the clear and `source arthur` does not bring it back. The `Bash` tool (Claude Code's frozen env +
zshenv sourcing only `arthur`) agrees with the server. So the plan's "the server holds fewer stale
secrets, never more" is stated backwards, and the deeper defect is that P1's "what a zsh spawned from
the terminal sees" names two different things: a child of the interactive terminal (no `dev`) and a
child of Claude Code (`dev` present). Only the second is what the server can equal. P1 must say "a
zsh child of Claude Code — the `Bash` tool" and the §2.8 table needs the row. Required.

### A14 — confirmed; subsumed by A15 if the user takes the writer-side gate

The tear the Architect describes is the one I traced in §3 (stale `prod`-withheld state committed
over a fresh `dev` apply), plus the worse half-applied case if `lastSignature` is updated before the
`await`. The plan/commit split is the right shape IF a policy read stays in the apply. Under A15 there
is no policy read in the apply, no `await`, and A14 reduces to "keep it synchronous and pin it" — which
is A4. I list A14 as conditional (item 4b) rather than unconditional so the Planner does not build the
split for a path that no longer exists.

### A15 — ENDORSED as the recommendation the user is asked to confirm, with conditions

This is a user-facing policy change: `env-load` over MCP gains a refusal it does not have today (F7).
It cannot be decided by the planning loop; it must be a decision the user makes on a clear statement.
My position is that the plan should RECOMMEND it and ask, for four reasons the reader-side table cannot
match:

1. **It protects the thing that matters.** Reader-side withholding keeps `prod` out of the MCP process
   while the same agent's `env-load prod` still writes the file and zshenv hands `prod` to every
   `Bash` child one turn later. The writer gate is the only placement that stops the agent from
   putting `prod` anywhere in the session.
2. **It reads the policy where the policy is defined.** `env-load` already reads the CURRENT repo's
   `infra-kit.json` for the Doppler project, so keying the refusal on that repo's `protectedEnvs` is
   coherent. The reader-side rule keys on the cwd repo while the session file (per terminal, not per
   project — `INFRA_KIT_ENV_PROJECT_ROOT` says whose) may belong to another repo.
3. **It costs nothing in the seam.** `applySessionEnv` stays synchronous (A4/A14 trivially
   satisfied), `env-status` needs no change (§2.7 holds), P1 and P2 hold without exceptions.
4. **It matches the enum's semantics rather than re-reading them.** `'cli-only'` already means "the
   human may, the agent may not" — extended from acting on prod to acquiring prod for the agent's
   session. `'disallow'` at the reader would have meant "the agent's process holds nothing the
   `Bash` tool freely has" — a distinction nobody can defend. At the writer it means "the agent
   cannot load prod at all", which is at least a statement of intent. The CLI path (`ik env-load -c
   prod`, human at a prompt) is untouched under both values — the flow-1 concession §2.4 already
   makes.

Conditions for the endorsement, which the Planner should write into the plan:

- **The gate is its own commit**, after the overlay lands and is proven (commits 1–4), so the user
  can decline it without touching the fix. Its absence changes nothing about the bug being fixed.
- **The menu shown to the user has two rows, not three:** (a) writer-side gate (recommended),
  (b) no gate — F7 stays. Reader-side withholding is withdrawn, with §7 above as the reason, so the
  user is not asked to weigh a design both reviewers found incoherent.
- **The refusal has the standard shape**: `PROTECTED_ENV_DENIED` / `mcp-blocked` reason + a
  remediation naming `ik env-load -c <config>` at the human's prompt; NO file is written on refusal
  (an e2e lane asserts the session dir is unchanged after the refused call).
- **The env picker form filters protected configs** under the gate — `deploy-form.ts:162` already
  consults the policy for the deploy picker, so this is the existing pattern, and offering `prod`
  only to refuse it after the human picked it is the refusal-with-no-exit shape again.
- **One skill sentence** (session skill): a protected config is refused over MCP and is loaded by the
  human in the terminal; plus the `release-create`/`release-remove` skills need nothing, since their
  Jira vars live in non-protected configs.
- **AC + lanes**: `env-load {config:'prod'}` over MCP under absent/`'disallow'` → refused, dir
  unchanged; under `'cli-only'` → refused with `mcp-blocked`; under `'allow'` → written. Unit at the
  command, one e2e lane through the real process. AC12/E-SE9 are replaced by these.

If the user declines the gate, the plan ships apply-all with F7 unchanged and records the declined
gate in §9 with this reasoning, so it is not re-proposed as reader-side withholding.

## Round-1b verdict

Unchanged: **ITERATE**. Items 1–12 (with 4 rewritten and 4a–4b added) are the blocking set; 13–22
non-blocking. Round 2 should be short if the Planner takes item 4 as recommended — most of the
remaining items are wording and observables.

## Round 2 — revision 2 re-evaluated

Re-read in full (771 lines). Every new load-bearing citation was verified against the tree; the
disposition of each blocking item follows.

### Blocking items 1–12, 4a, 4b — all applied in substance

| # | Applied at | Verified |
|---|---|---|
| 1 / A1 | §1.5 row A (`:210`): (1) and (2) costed and explicitly "NOT the ground"; (5′) writer self-kill race; rejection on (5′)+(3)+(4) | ✓ |
| 2 / A3 | P2 `:151-154` "one behavioural seam; no command's logic changes" | ✓ |
| 3 / A4 | §2.1 `:240` sync signature; §2.5 `:366-368` types agree; §2.6 `:372-387` SDK microtask premise; AC6 non-thenable; §6.1 two-overlapping-applies lane | ✓ |
| 4 / A15 | §2.4 `:293-347`: base = apply-all; two-row menu (`:305-308`), reader-side withdrawn as B⁗ (`:217`, §8 `:684`); gate spec with own commit (§4 step 5 `:499`), no file written (check precedes `writeEnvLoadFile` `:297`, which is what calls `downloadDopplerSecrets` `:208` — verified), picker filters via `buildRequestedSchema` (`env-load-form.ts:77-78`, `deployableEnvs` `protected-envs.ts:97-103` — verified), standard remediations (`protected-envs.ts:126-141` — verified), one skill sentence, AC13 + E-SE10 as its only lanes; "truthful, self-explaining" gone | ✓ |
| 4a / A13 | §2.8 row `:418`, two-directional note `:433-438`, P1 comparator `:146-148`, ADR `:718-721`, AC5 `:539-540`; "never more" absent | ✓ |
| 4b / A14 | Moot by construction: no `await` in the apply (`:385-387`); the non-thenable lane keeps it that way | ✓ |
| 5 / A6 | ADR `:709-723`: T1 tension, cmux child, both sinks; P5 `:160-162`; F13 `:124` | ✓ |
| 6 / A8 | Scope line `:16`; S5 `:485-487`; ADR `:728` | ✓ |
| 7 | AC1 `:514-523` + F14 `:127`: positive identity. Verified end-to-end: explicit `version` never calls `ensureKnown` (`release-create.ts:251`, only for `next`); `assertBaseBranchSwitchable` (`git-guard.ts`) is local-only (`getCurrentBranch` + `listWorktrees`); `executeOne`'s first step `prepareGitForRelease` → `git fetch origin` (`release-utils.ts:72`) is inside the `try` (`release-create.ts:336-355`) and lands in `failedReleases[0].error` as `failed to create release v1.2.5 (regular) — stderr: fatal: 'origin' …` via `extractStderr`; without the overlay `loadJiraConfig` (`:386`) throws OUTSIDE that `try`, so a `failedReleases` entry is reachable only after the Jira read succeeded | ✓ |
| 8 | AC9 `:551-557` hand-pinned payload + unit half | ✓ |
| 9 | AC3 `:528-532` secret-shaped sentinels, URL exempt | ✓ |
| 10 | AC11 `:562-567` rewritten; S1 env via `parseVarsFromEnvFile` | ✓ |
| 11 / A10 | §6.4 `:629-630` assignment form everywhere; F4 note | ✓ |
| 12 | §7 `:667` root `pnpm run test:claude ; echo EXIT=$?`; §4 step 6 `:500-503` exact-version `pnpm add -g` + `infra-kit version` before V0 | ✓ |

Non-blocking 13–22: all applied (§11 `:750-754`); A11 declined in favour of `ino` — correct.

### Round-1 failing criteria, re-checked

- **Principle–option consistency — PASS.** P1 now names the comparator; P2 permits text edits; P6
  ("one environment per call") is a principle and the §2.5 placement (`:351`, before `resolveStop`)
  delivers it; no principle has a carved exception.
- **Observables — PASS.** AC1/AC3/AC9/AC11 are observables (table above). AC6's six `GateState`
  values match `tool-handler.ts:79` exactly. AC12's deploy refusal is reachable before any `gh` call
  (`gh-release-deploy-all.ts`: `resolveProtectedEnvAccess` → `deployableEnvs` → `assertDeployable`
  precede `fetchAllReleasePRs` — verified).
- **Verification commands — PASS.** Every line carries `; echo EXIT=$?`; the plugin runner is the
  house one; publish order CLI → exact-version global → V0 → plugin.
- **Pre-mortem + test plan — PASS.** S1–S5 each map to a lane (S3 now has one); unit / integration /
  §6.2b primary proof / bundle guard / e2e E-SE1–E-SE10 / observability lines.
- **§2.4 — PASS.** Two-row menu; reader-side withholding withdrawn and listed as a non-goal; the
  §2.4-opt conditions (own commit, no file on refusal, picker filtering, one rule at two sites R2-1,
  skill sentence, own lanes) are all present.

### New defects found — two, both non-blocking

- **N1 — S1 guard regex over-matches.** `process\.env(\[[^\]]+\]|\.\w+)\s*(\?\?)?=` (`:465`) also
  matches `process.env.X === 'y'` (the first `=` of `===`). Nothing under `src/mcp/` or
  `src/lib/tool-handler/` matches today (verified by grep), so it is latent; use `=(?!=)` so the guard
  cannot turn red on a future comparison.
- **N2 — AC13's `'allow'` case over the wire.** "With `'allow'` it writes" (`:576`) cannot be observed
  in E-SE10: the fixture deliberately does NOT stub `doppler` and deletes `INFRA_KIT_ENV_TOKEN`
  (`env-picker-fixture.ts` header), so an allowed load fails on the token before any write. Word the
  e2e observable as "the refusal is NOT raised — the failure is the token/doppler error" and leave
  "it writes" to the §6.1 unit table, where `resolveProtectedEnvAccess` is mocked.

## VERDICT: APPROVE

Revision 2 discharges every blocking item from round 1 and 1b and the Architect's round 2/2b. The
two new findings are wording-level and can be applied during implementation without another planning
round. The one open input is the user's row (a)/(b) choice in §2.4; the plan is correct under either.
