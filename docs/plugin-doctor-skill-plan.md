# [DO] `/infra-kit:doctor` — a plugin-side doctor modelled on `/oh-my-claudecode:omc-doctor`

Status: **pending approval** (ralplan `--deliberate`, round 3 — revised after Architect + Critic)

## 0. Findings that shape the design

**F1 — `ik doctor` already owns the plugin surface.** `report.ts:81-84` ships `SECTION_PLUGIN`:
`claude CLI` (`doctor.ts:993`), `marketplace registered` (`:1013`), `plugin installed` (`:947`),
`plugin version` (`:930`), `CLI version` (`:1022`), `MCP server key` (`:1057`); plus
`CLAUDE.md block` (`:889`, in `SECTION_SHELL`). A literal port re-implements six of omc-doctor's
nine checks in markdown against tested TypeScript.

**F2 — the `release-create` command shape is unavailable.** `doctorMcpTool` *does* exist
(`doctor.ts:1489-1509`), wired as `mcpTool: doctorMcpTool, mcpExposed: false`
(`command-catalog.ts:467-474`) and held by a test named *"keeps doctor UNEXPOSED even though it
has a tool"* (`command-catalog.test.ts:122`). Contrast `env-token-set`, which carries
`mcpTool: null` (`:509-517`) so there is nothing to flip. See §3 B for the honest rejection.

**F3 — `ik doctor` has no WARN tier.** `CheckResult.status` is `'pass' | 'fail'`
(`doctor.ts:67`); `grep -rn "'warn'"` over the doctor tree returns nothing. **Five of
omc-doctor's nine checks are WARN-level advisories.** Moving any of them into the CLI converts
an advisory into a hard FAIL counted in the summary (`report.ts:346-359`). "Port the checks"
was never a like-for-like operation.

**F4 — the target bug is live on this machine right now.**

```
~/.claude/plugins/cache/infra-kit/infra-kit/   -> 0.1.0
plugins/infra-kit/.claude-plugin/plugin.json   -> 0.2.0
```

and no `/infra-kit:*` skill is loaded in this session. `ik doctor`'s `plugin version` row reads
the install record, not what the session loaded, so it cannot report either fact. This is the
check that justifies the whole skill, and it fires today.

**F5 — `CLAUDE_CONFIG_DIR` is honored nowhere in the CLI.** Zero hits across
`apps/infra-kit/cli/src`; `install-state.ts:24` hardcodes `['.claude','plugins']` under
`os.homedir()`. omc-doctor honors it in every path. On a machine that sets it, all four
infra-kit plugin rows read the wrong directory and report a working install as missing.

## 1. Principles

1. **A mechanical check belongs in tested code — CLI or bundled script — never in prose.** Model
   introspection is not a check.
2. **`doctor` stays off the MCP surface**, and no fix rung may become a weaker version of the
   gate that decision protects.
3. **One inventory, not two.** Nothing here re-encodes a list another surface owns.
4. **Fixes are proposed with their exact command; anything mutating passes a real human gate.**
5. **The plugin ships as data, so every guard is a scan** — anything under `plugins/` is held by
   `__tests__/manifest.test.mjs` or it is unguarded.

## 2. Decision drivers

- **D1 — Non-duplication** (F1).
- **D2 — The MCP boundary** (F2): leave it intact, do not route around it.
- **D3 — Testability**: the plugin already ships and tests a script
  (`comment-verifier/scripts/lint-comments.mjs`, `README.md:94-97`), so "skills can't be tested"
  cannot justify a design.
- **D4 — No false failures** (F3): with no WARN tier, any advisory placed in the CLI becomes a
  hard FAIL. This alone disqualifies most of what round 2 wanted to put there.

## 3. Options

### A — port omc-doctor's bash body into a self-contained skill

- **Steelman (conceded in part).** It works on the broken machine: the chosen option's ladder
  stops when the CLI won't run, and no local install / wrong binary / corrupt Layer-3 config
  (`layer3-config-autoseeds-on-every-command`) is the likeliest consumer failure. A needs only
  bash and `~/.claude`. Also, CLI-side checks reach consumers only via npm publish, which this
  repo's memory documents as unreliable, while the plugin ships from git on commit.
- **Rejected** for the second inventory it creates — but its "works on the broken machine"
  argument is adopted wholesale in §4.3, and its "ships faster" argument is what makes §3 E
  plugin-only.

### B — a `commands/doctor.md` in the `release-create` shape

**Rejected, honestly.** Not impossible: flipping `mcpExposed` is one boolean, whereupon
`command-catalog.test.ts:235-247` forces either `requiresHumanConfirm` or a greppable
`LOW_RISK_MUTATING_ALLOWLIST` entry (`:243-245`). Rejected because an MCP doctor **still cannot
see the session** — the only thing the CLI is missing (F4) — so it spends a recorded safety
decision and a confirm gate to buy nothing.

### C (round 1) — `--json`-driven, three model-introspection checks

**Rejected.** `--json` emits a flat `{name,status,message}` array with no section labels
(`doctor.ts:1495-1505`; report suppressed at `program.ts:557-559`), so consuming it forces the
skill to re-encode `SECTION_MEMBERS` — the second inventory principle 3 forbids, and
`report.ts:14-17` records that ungrouped output is exactly why a single FAIL was invisible in a
wall of PASS. Its S1/S2 checks were model introspection, violating principle 1.

### E (chosen) — plugin-only: human report verbatim + one tested probe

Round 2 also proposed a CLI-side check (C1, stale plugin cache). **Dropped**, on evidence:

- Multiple cached version dirs are the *normal* steady state — measured on this machine:
  `playwright` 9, `atlassian` 8, `context7` 8, `commit-commands` 8, `frontend-design` 8,
  `superpowers` 2, `context-mode` 2. "Fail on more than one" fails on almost every plugin.
- With no WARN tier (F3) there is no honest way to express it in the CLI anyway.
- The actionable signal is not "how many are cached" but "is the cached/loaded copy the one the
  records name" — which is the probe's job (F4), and the probe is not bound by `CheckResult`.

**Consequence: this change touches no CLI code.** No publish dependency (round 2's PM-2 is
gone), no edits to `report.test.ts:90-91`, `report.test.ts:95`, `claude-plugin-checks.test.ts:263`,
or `report-inventory.test.ts:147-148`. The work is one skill, one script, one test file, and one
line in the plugin suite.

## 4. Design

### 4.1 Shape

`plugins/infra-kit/skills/doctor/SKILL.md` + `scripts/session-probe.mjs` + `__tests__/`, invoked
as `/infra-kit:doctor`.

### 4.2 Body — four steps

0. Run the probe's `config dir` check **first** (§4.4). This is a correctness precondition, not a
   caveat: `CLAUDE_CONFIG_DIR` is honored nowhere in the CLI (F5), so when it is set the report
   in step 1 is reading `~/.claude` rather than the configured tree and four of its rows are
   simply wrong. Label the report accordingly *before* printing it — a warning issued afterwards
   arrives once the reader has already absorbed the wrong rows.
1. Resolve the CLI (§4.3) and run `infra-kit doctor`. **Show its report verbatim.** It already
   groups (`groupChecks:122`), rolls up, and prints the `--fix` hint driven by `FIXABLE_NAMES`
   (`report.ts:345-355`), so the skill holds zero row knowledge.
   **Exit code 1 is a diagnosis, not a failed run** — `program.ts:565-571` sets it whenever
   `plugin installed` fails, i.e. on exactly the machine being diagnosed.
2. Run the probe (§4.4) and append its rows.
3. Interpret: name each failing row. Add one sentence on MCP connectivity — it can only be
   interpretation, because T1 (`manifest.test.mjs:501-506`, pinned by T1b at `:564-582`) forbids
   a skill naming any `mcp__infra-kit__` tool.
4. Offer fixes (§4.5).

### 4.3 CLI resolution and the broken-machine fallback

First hit wins: (1) `infra-kit` on `PATH` — the global pnpm install, the consumer-repo case
(`consumer-repos-run-the-global-infra-kit`); (2) `node <repo>/apps/infra-kit/cli/dist/cli.js`
when present. **Never `pnpm exec`** (`portless-blocked-by-npm-command-env`).

If neither resolves, **do not stop** — run the probe anyway and say plainly that the CLI half is
unavailable and why. This is Option A's A1 argument, honored.

### 4.4 The probe — `session-probe.mjs`

Read-only. Emits its own rows with its own severity vocabulary (`ok` / `warn` / `fail`), which is
legitimate precisely because it is *not* a `CheckResult` (F3).

| row | comparison | why only the probe can do it |
| --- | --- | --- |
| `plugin root` | `${CLAUDE_PLUGIN_ROOT}` resolves and holds `.claude-plugin/plugin.json` | the CLI has no notion of the session's loaded tree |
| `session vs records` | `${CLAUDE_PLUGIN_ROOT}` vs `<installPath>` from `installed_plugins.json` | `plugin version` reads the record, not the session (F4) |
| `outdated plugin` | newest version dir under the cache vs `${CLAUDE_PLUGIN_ROOT}`'s manifest | omc-doctor Step 1's analogue; **no CLI equivalent exists** — `claudePluginVersionCheck` (`doctor.ts:929-941`) compares to nothing. Fires today: 0.1.0 vs 0.2.0 |
| `skills present` | the six `EXPECTED_SKILLS` dirs exist under the loaded root | catches a truncated cache |
| `config dir` | `CLAUDE_CONFIG_DIR` set and ≠ `~/.claude` | **F5**: when set, every CLI plugin row is reading the wrong tree, so this row tells the reader the report above it is unreliable |

**Version comparison must use manifests, not the record's `version` field.**
`installed_plugins.json` records a **git-commit sha** as `version` for repo-served marketplaces
(`install-state.ts:170-174`) — which is infra-kit's case — so comparing it to `0.3.0` reports
drift on every healthy machine. Compare
`${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` against
`<installPath>/.claude-plugin/plugin.json`, mirroring `readInstalledPluginVersion`.

**`CLAUDE_PLUGIN_ROOT` unset is a named row, never a stack trace.** An unset variable expands to
empty, making step 2 `node /skills/doctor/scripts/session-probe.mjs` → `MODULE_NOT_FOUND`, on
exactly the machine §4.3 exists for. The probe reports `plugin root: unresolved` and continues
with the rows it can still compute. See §5 Phase 0.

Per U12 the probe resolves nothing from `import.meta.url` and writes nothing.

**Not ported from omc-doctor:** legacy hooks in `settings.json`, legacy bash hook scripts,
legacy curl-installed agents/commands/skills. `manifest.test.mjs:435-441` proves the plugin
declares no hooks or `mcpServers`, and `README.md:31-46` shows no curl era — all three would
check for a history that does not exist. CLAUDE.md freshness is already `checkAgentFiles` +
`ik audit --fix`.

### 4.5 Fix ladder — every rung is unfenced prose

| symptom | fix |
| --- | --- |
| `portless routes` / `tokens.json perms` | `infra-kit doctor --fix` |
| `marketplace registered` / `plugin installed` / `CLAUDE.md block` | `infra-kit init` |
| stale package guidance | `infra-kit audit --fix --all` |
| `MCP server key` | edit `.mcp.json`; key must be `infra-kit` |
| probe reports drift / outdated | reinstall the plugin, then restart Claude Code |

**Why unfenced.** Round 2 claimed these rungs sat behind "a real Bash permission prompt". That
was false: `README.md:26-27` promises `allowed-tools` whitelists exactly what the body runs *so
it executes without a permission prompt*, and `manifest.test.mjs:186-201` makes that mandatory
both ways. A fenced `infra-kit doctor --fix` **must** be whitelisted and therefore prompts
nobody. Round 2's comparison was doubly wrong: the MCP gate is no longer auto-confirm either —
`mcp/tools/index.ts:37-39` wraps gated tools with `withConfirmToken`, a two-round HMAC confirm.

So the fix commands stay **in prose, never in a fence**. No rule matches them, so the model must
construct the Bash call itself and the grant does not come from this plugin.
`manifest.test.mjs:463-475`'s `u6-prose-invocation` fixture already pins that a prose mention
leaves the corpus, so this keeps U6 green by a mechanism the suite documents.

**State the guarantee precisely: the skill grants nothing — not "a human always sees the argv".**
`allowed-tools` is not the only permission source. A user's own `settings.json` allow-list, or a
session running with permission prompts disabled, satisfies the call without a prompt. Those are
the user's decisions to make and this plan neither relies on them nor works around them; what it
guarantees is that the plugin itself never carries the grant for a mutating command.

Only two things are ever fenced and whitelisted: `infra-kit doctor` and the probe — both
read-only. The skill itself runs no `rm`, writes no `.mcp.json`, and deletes nothing.

### 4.6 Plugin-tree guards

- **U3** — add `'doctor'` to `EXPECTED_SKILLS` (`manifest.test.mjs:19-26`).
- **U2/U4/U5/T5** — `name: doctor` + `description`; no banned keys; `scripts/` rooted at
  `${CLAUDE_PLUGIN_ROOT}`; no consumer-repo names.
- **U12** — no `import.meta.url`; no writes.
- **U6 — blocker, resolved here.** Verified by running the predicate: with
  `COMMAND_HEADS = {node, python3, pnpm, git}` (`manifest.test.mjs:134`) a fenced `infra-kit`
  line enters no corpus, so declaring `Bash(infra-kit doctor)` makes `clause3Errors` (`:193-201`)
  fire a dead rule and U6 goes red *today*:

  ```
  corpus: []                                   <- infra-kit head not in COMMAND_HEADS
  rules ["infra-kit doctor --json"] -> clause3: dead rule | U6 RED: true
  rules []                          -> clause3: []        | U6 RED: false
  control (node head)               -> clause3: []        | U6 RED: false
  ```

  **So add `infra-kit` to `COMMAND_HEADS`.** Independently confirmed to redden nothing: the only
  fenced `infra-kit`-headed line anywhere is `README.md:66` (`infra-kit init`), outside U6's
  corpus (U6 walks `SKILLS_DIR/*/SKILL.md`) and carrying no `scripts/`. Note this touches **two**
  predicates — `COMMAND_HEADS` also feeds U5's rooting check at `:355`.
- **Token budget** — `README.md:78-84` gates releases on projected always-on token cost, recorded
  **1438**, stamped "plugin version 0.1.0" while `plugin.json` says `0.2.0`. Re-measure and
  update in the same commit. *(The gate itself is prose — grep finds no checklist that runs it;
  §8 follow-up iii.)*
- Bump `plugin.json` 0.2.0 → 0.3.0; add the README table row.

## 5. Phases

### Phase 0 result — RESOLVED 2026-09-09, proceed

Measured, from inside an active plugin-skill invocation:

```
printenv | grep '^CLAUDE_PLUGIN'   -> (nothing)
node -e process.env.CLAUDE_PLUGIN_ROOT -> null
echo "[${CLAUDE_PLUGIN_ROOT}]"     -> []        <- harness does NOT interpolate the literal
echo "[$CLAUDE_PID]"               -> [41381]   <- control: shell expansion works, env is live
```

So `${CLAUDE_PLUGIN_ROOT}` is **not** in the Bash child env and the harness does **not** substitute
it into a Bash tool command. Binary strings confirm the substitution sites are hooks (there is an
explicit *"only `${CLAUDE_PLUGIN_ROOT}` is available for skill hooks"* message) and `mcpServers`
(`^\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/…$`), substituted "per-element as plain strings … no shell".

**The five shipped skills are nonetheless fine, and the earlier "they are broken" reading was
wrong.** Every skill invocation carries a `Base directory for this skill: <abs path>` preamble, and
the model resolves the variable from it when constructing the call. Corroboration: `omc-setup`
writes `${OMC_SETUP_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}` — an escape hatch that only makes sense if
the shell value is unreliable — and OMC's skills declare no `allowed-tools` at all.

**Decision.** `SKILL.md` keeps writing `${CLAUDE_PLUGIN_ROOT}` (U5 requires it, and it is house
style), and adds one explicit line: *if the variable is empty in the shell, substitute this skill's
stated base directory.* That is correct under either mechanism.

**Residual uncertainty, accepted:** whether `allowed-tools` matching expands the variable before
comparing against the concrete path the model typed could not be measured here — the infra-kit
plugin is not loaded in this session (and its cache holds 0.1.0). If it does not expand, the cost is
**one permission prompt**, not a failure. `README.md:26-27`'s no-prompt promise is then optimistic
for every skill in this plugin, which is a pre-existing question, not one this skill introduces.

---

**Phase 0 (original spike definition).** Confirm `${CLAUDE_PLUGIN_ROOT}` is populated for a Bash call
issued *from inside a skill*. It is absent from this session's Bash env, and it could only be
confirmed injected for plugin MCP servers and hook commands. Five shipped skills already depend
on it (`fe-architect`, `comment-verifier`, `e2e-architect`, `fe-patterns`, `full-cycle` — all
declare it in `allowed-tools`), which is strong circumstantial evidence but not proof.

**The spike must test the child environment, not pattern interpolation.** Those five skills prove
only that `allowed-tools` *patterns* interpolate the variable; whether the spawned Bash child
carries it in its env is a different mechanism. Verify by invoking an existing skill that runs a
bundled script and having it print its own `process.env.CLAUDE_PLUGIN_ROOT`. **If it is
unpopulated, five shipped skills are already broken and that is the bug to fix first** — this
plan waits.

**Phase 1.** Probe + tests. **Phase 2.** `SKILL.md`, `COMMAND_HEADS`, U3, README, version bump.

## 6. Pre-mortem

**PM-1 — the fix ladder loses its gate.** Someone "tidies" a prose fix command into a fence and
adds the matching `allowed-tools` rule. U6 goes *green* (that is what it asks for), the diff
looks like a cleanup, and `infra-kit doctor --fix` silently becomes promptless.
*Mitigation:* §4.5's rationale is stated in the SKILL.md body itself, not only here, and §7 AC-5
makes it mechanically checkable — a test asserts no mutating command appears in a fence.

**PM-2 — the probe drifts from the format it parses.** `installed_plugins.json`'s shape is not
infra-kit's to control; a change makes the probe report "no install record" and the skill report
drift that does not exist.
*Mitigation:* the probe distinguishes **records absent/unreadable** from **records present and
disagreeing** and never reports drift for the first; both branches are pinned.

**PM-3 — the skill outlives its usefulness.** If the CLI later grows session awareness, or
Claude Code exposes plugin state directly, the probe becomes a duplicate — the exact failure §1
principle 3 exists to prevent, arrived at by drift rather than by design.
*Mitigation:* the probe is one file with one exported function per row, so deleting a row is a
deletion, not a refactor; §8 follow-up (i) names the CLI-side takeover as the intended end state.

## 7. Acceptance criteria — each mechanically checkable

1. `/infra-kit:doctor` exists; the manifest suite passes with `infra-kit` added to
   `COMMAND_HEADS` **and** its new red fixture (a fenced `infra-kit …` line with no rule must
   fail clause 2 — without it the widening is a fail-open).
2. `pnpm run test:claude` green; the probe's unit suite covers every branch in §4.4 plus
   `CLAUDE_PLUGIN_ROOT` unset.
3. The probe writes nothing — asserted against a temp dir.
4. Run against this machine's live state, the probe reports the `outdated plugin` row as failing
   (cache 0.1.0 vs manifest 0.2.0). **F4 is the acceptance fixture.**
5. No mutating command (`--fix`, `init`, `audit --fix`) appears inside a fence in
   `skills/doctor/SKILL.md` — a scan, in the manifest suite.
6. `SKILL.md` contains no doctor row name and no section label — a scan against a literal needle
   list, so the "report verbatim" contract is enforced rather than asserted. That needle list is
   a **deny list, not a source of truth** — it must carry a comment saying so, since drift makes
   it weaker but never wrong, which is why it does not violate principle 3.
7. `plugin.json` at 0.3.0, README table row present, token-budget line re-measured — all three
   diffable in the same commit.
8. `pnpm run qa` green at the root — including `vendor check`, which runs first
   (`vendor-source-of-truth`): **nothing under `vendor/` is edited.**

## 8. ADR

- **Decision:** Add `/infra-kit:doctor` as a plugin-only skill that shows `infra-kit doctor`'s
  own report verbatim, adds a tested `session-probe.mjs` for the five things only a live session
  can see (§4.4), and lists fixes as unfenced prose so the plugin never carries the grant for a
  mutating command. Add `infra-kit` to the plugin suite's `COMMAND_HEADS`. **No CLI code
  changes.**
- **Drivers:** D1 non-duplication; D2 the MCP boundary; D3 testability; D4 no false failures.
- **Alternatives considered:** (A) port omc-doctor's bash body — rejected for the second
  inventory, but its broken-machine argument is adopted in §4.3 and its ship-speed argument is
  why E is plugin-only. (B) `commands/doctor.md` — rejected because an MCP doctor cannot see the
  session, so it buys nothing; *not* because it is impossible. (C, round 1) `--json` + model
  introspection — rejected: no section labels, and introspection is not a check. (Round 2's
  CLI-side C1) — rejected on measurement: multiple cached versions are normal, and F3 leaves no
  WARN tier to express it.
- **Why chosen:** every check sits on the only surface that can both observe it and test it; the
  skill holds no duplicated state; and the change ships from git with no publish dependency.
- **Consequences:** `COMMAND_HEADS` gains a head, changing the contract for future skills —
  deliberately, since the status quo is a blind spot spanning two predicates. The skill diverges
  from omc-doctor by not auto-applying fixes: omc-doctor asks and then runs, this one prints and
  lets the human run. That is the price of keeping the grant out of the plugin (§4.5).
- **Follow-ups:** (i) fold the probe's record-parsing into the CLI once it can be asked for it
  (PM-2/PM-3); (ii) **F5 is a standalone pre-existing bug** — `CLAUDE_CONFIG_DIR` is honored
  nowhere in the CLI, so four plugin rows misreport on any machine that sets it. Worth its own
  ticket; (iii) the README token-budget gate is unenforced prose.
