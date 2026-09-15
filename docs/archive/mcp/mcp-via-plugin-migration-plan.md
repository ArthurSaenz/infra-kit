> Archived 2026-09-15 — the infra-kit MCP server is being retired; see .omc/plans/mcp-to-cli-skills-migration.md.

# [DO] MCP via plugin — the migration (§8.2+ of the approved plan, re-planned on the measured facts)

Status: approved ("роби", 2026-09-14) — steps 1–2 IMPLEMENTED on branches: `do/mcp-via-plugin-step0` (+ the PM-9 gate, = CLI 0.7.2 content)
and `do/mcp-via-plugin-migration` (CLI 0.8.0 + plugin 0.8.0 content), verified locally end-to-end (§12 S1-4). Steps 3–5
(publish 0.7.2 → merge → publish 0.8.0 → doctor evidence → canary PR → consumer PRs) are the user's sequence. OQ-1 = A (plugin), OQ-2 = 0.7.2 first.
Revision: 3.2 (rev 1, rev 2 and rev 3 reviewed by Architect, rev 2.1 and rev 3.1 by Critic — APPROVE on 3.1; dispositions in §13)
Date: 2026-09-14
Mode: ralplan (deliberate) — Planner draft
Fact sheets: `scratchpad/facts2.md` (binding; cited as **F1–F17**, options **A–E**), `scratchpad/facts.md`
(cited as **F-…** where a fact only lives there) and `scratchpad/s1/measurements.md` (**S1-1, S1-5, S1-6** —
measured by the orchestrator on 2026-09-14, real travelist-monorepo; facts, not spikes). Parent: `docs/archive/mcp/mcp-via-plugin-plan.md` rev 5.1 — §6.1 (spike),
§8.0 (step 0, DONE on `do/mcp-via-plugin-step0`, commits 3f7eabf/c30c5a2/a9ce8c6), §14 (settled dispositions,
not re-opened here). This document REPLACES rev 5.1 §8.2–§8.7, §10, §11 for the migration itself.
User decision being executed: "давай переносити" — move the server into the plugin despite S0-2 (F5).
Anything unmeasured is labelled **S1-n** with its measurement designed in §12.

## 0. TL;DR

- **Shape:** `plugins/infra-kit/.mcp.json` registers ONE stdio server, key `infra-kit`, `command: "infra-kit"`,
  `args: ["mcp"]`, `cwd: "${CLAUDE_PROJECT_DIR}"` (§3.1). Prefix becomes `mcp__plugin_infra-kit_infra-kit__<tool>`
  (F3), spelled ONCE in the CLI (`MCP_TOOL_PREFIX`) and cross-checked against the two plugin files on disk.
- **The served prefix is launch-aware (§3.3, rev 2).** A plugin-spawned server has `CLAUDE_PLUGIN_ROOT`; a
  `.mcp.json`-spawned one does not (S1-5, measured). `infra-kit mcp` reads it at build and renders every body it
  serves — the resource descriptions and the three `resources/workflow/*.md` — with `MCP_TOOL_PREFIX` or with
  `LEGACY_MCP_TOOL_PREFIX` (`mcp__infra-kit__`). A session therefore never reads a tool name it does not have,
  whichever route spawned the server — **on a CLI ≥ 0.8.0**; a plugin ≥ 0.8.0 spawning an older CLI is the one
  designed-in state where it does (PM-9, closed by a one-branch gate in step 0's child + `setup`). This removes
  the shadow-window malfunction (rev 1 PM-5), turns a leftover consumer key into an advisory instead of a
  failure, and takes every deadline off the consumer PRs.
- **Subdirectory gap (F5): Option A — accept and mitigate; C is the honest runner-up (§3.2).** A session launched
  from `apps/…` has no plugin, therefore no server — and, now measured (S1-6), no repo hook either: the deploy
  guard and the bash guard do not fire from a subdirectory today, under A or under C. Mitigation is a root
  `CLAUDE.md` line (written by `ik audit --fix --root`, F16) that a subdirectory session does read (S1-1, green)
  plus a `doctor` advisory when `cwd ≠ git root`. **C** (user-scope `claude mcp add`, no plugin server, zero
  prefix rename) beats the plugin on D2 and D3; the plugin wins on D1 alone — the driver the user named, a
  repo-declared, versioned, one-unit delivery. On enforcement they are equal. If the user weighs the subdirectory
  path higher than D1, §3.2 says what C costs and the plan shrinks to §3.2-C.
- **Doctor/setup (§3.3):** the `.mcp.json` writer becomes a stale-detector that writes nothing (P3). A leftover key
  is a **`pass` + advisory** row ("legacy route — bodies already name the right prefix; key-deletion PR pending");
  exit code scoped to `plugin installed` (F14). One NEW row, `plugin MCP server`, carries the capability verdict
  "the served plugin copy (the record's `installPath`, F8) carries `.mcp.json` with key `infra-kit`"
  (`report.ts:99-102` `SECTION_MEMBERS` 6 → 7 names).
- **Consumer switch (§3.4):** one human PR per repo — key removal + 3-file prefix sweep + regenerated root
  `CLAUDE.md` block, at each repo's own pace. No CLI writer removes the key (Q1 settled: no). 7 family + 2
  out-of-family (2 PRs each).
- **Order (§5):** merge step 0 → CLI 0.7.2 (already written, plus the one-branch PM-9 gate) → migration PR (CLI 0.8.0 + plugin 0.8.0, plugin bump
  in its own commit, F13) → npm publish 0.8.0 → `doctor` `plugin MCP server` pass on the author's machine (the
  only pre-canary evidence; `claude mcp list` proves nothing under F2) → **this repo's key removal as canary; the
  live proof — `mcp__plugin_infra-kit_infra-kit__version` answering in a session — exists only after it merges**
  → the other 8.
- **Finding, out of scope, recorded (§9 follow-ups):** a subdirectory session has no guard and no client-side
  veto for a raw `gh workflow run` against prod — today, under A and under C alike (S1-6).
- **Not waiting for AC-0 costs this:** the plugin channel's automatic advance has been measured to work by hand
  (S0-7) but never observed happening on its own over a release. The 0.8.0 release is therefore both the first
  dependency on the channel and its first live test; PM-1 (§4) is the failure, the canary gate is the bound, and
  the manual path (`infra-kit setup` / `claude plugin update infra-kit@infra-kit --scope project`) is on every
  message that can reach a machine.

## 1. Principles

- **P1 — One source of truth is a git path** (parent P1). The binary is the global CLI on PATH (F7); the plugin
  holds the pointer `.mcp.json` held. No second CLI copy.
- **P2 — Enforcement unconditional, capability opt-in** (Q5, F16). The deploy guard stays repo-local; losing the
  server loses the sanctioned capability, never the prohibition. The migration must not make any launch path
  MORE capable than it is today; it does not claim to make any path safer either (S1-6: the subdirectory path is
  unguarded before and after, under every option in §3.2).
- **P3 — Never delete what a human may have typed.** No CLI code path removes a `.mcp.json` key (Q1 settled).
- **P4 — Every platform claim is measured.** F1–F17 and S1-1/5/6 are the measured base; each new claim is an S1-n.
- **P5 — A detector is quiet when nothing is wrong and self-sufficient when something is** (parent P6): every
  row that is not plain green names the command to type AND how to keep working until then; no row compares the
  CLI version to the plugin version.
- **P6 — One spelling PER prefix.** Two prefixes exist during the migration: `MCP_TOOL_PREFIX` (composed from
  plugin.json `name` + the `.mcp.json` key, Q4 coupling, TESTED against those files) and `LEGACY_MCP_TOOL_PREFIX`
  (`mcp__infra-kit__`). Each is typed exactly once, in `tool-prefix.ts`; every doctor text, body and test routes
  through the constants, and the negative grep (AC-2) allows exactly those two definitions.

## 2. Decision drivers (top 3)

1. **D1 — The server ships as part of the repo-declared unit.** `enabledPlugins["infra-kit@infra-kit"]` is committed
   in every family repo (F10); Claude Code itself says "not installed" at startup for a plugin that was NEVER
   installed (F-20.3) — an installed-but-stale plugin is silent (PM-1); skills, commands and server version
   together (F13). This is the user's stated ask (T1).
2. **D2 — No session that has tools today loses them silently.** Root and worktree launches are measured green
   (S0-2 root, S0-6(a) worktree, F6); the subdirectory launch is the known loss (F5) and must be visible to the
   person in that session.
3. **D3 — Bounded, reversible blast radius.** Prefix rename limited to the F11 file list; one commit per repo
   reverts it (P7 of the parent).

## 3. Decisions (options ≥ 2 each)

### 3.1 Plugin shape — `cwd` explicit or omitted

| Option | Measured | Verdict |
| --- | --- | --- |
| (a) `cwd: "${CLAUDE_PROJECT_DIR}"` | F4: expands; server cwd = the launch project dir either way | **chosen** |
| (b) no `cwd` | F4: same result on 2.1.270 | rejected |

Why (a): the default is undocumented (F-20.6) and measured on one Claude Code version; `cwd` and
`${CLAUDE_PROJECT_DIR}` are documented fields (F-20.1). (a) pins the contract the CLI depends on — `git rev-parse`
from cwd resolves the project the session opened, worktrees included (F6: a worktree session's
`CLAUDE_PROJECT_DIR` is the worktree). The U7 flip (§7) asserts the field, so a future drop is a test failure.
Residual: if a later Claude Code left the variable unexpanded, spawn would fail with a dead server rather than a
wrong cwd — visible (no tools), never silent; the e2e recipe (§7 E2E) is the tripwire.

Exact file, `plugins/infra-kit/.mcp.json`:

```json
{
  "mcpServers": {
    "infra-kit": {
      "type": "stdio",
      "command": "infra-kit",
      "args": ["mcp"],
      "cwd": "${CLAUDE_PROJECT_DIR}"
    }
  }
}
```

`type: "stdio"` mirrors this repo's `.mcp.json`; if `claude plugin validate --strict` rejects it (S1-0, run before
the first commit) the field is dropped and the U7 flip asserts the file as committed. No inline `mcpServers` in
plugin.json (one place, U7).

### 3.2 The subdirectory gap (F5) — A/B/C/D/E

**What is actually lost.** From `repo/sub`, Claude Code reads `<cwd>/.claude/settings.json` only: no
`enabledPlugins`, so no plugin — no skills, no commands, and after this migration no MCP server. The same rule
means no `hooks` from that file either — **measured, S1-6**: from `travelist-monorepo/apps` a raw `git worktree
add` ran with no bash-guard hook firing, while from the root the guard refused it. So today's subdirectory session
has the 26 `mcp__infra-kit__*` tools (F5) and none of the repo's hooks — the deploy guard included. What the
migration removes from that session is the SANCTIONED path (the gated MCP deploy tools, with the CLI's client-side
`assertDeployable` veto); what stays, under every option here, is the unguarded raw path (`gh workflow run`,
`pnpm exec infra-kit …` in Bash). The subdirectory session is unguarded before and after; no option in this table
changes that (§9 follow-up 5).

| Option | What it is | Cost / risk | Verdict |
| --- | --- | --- | --- |
| **A — accept + mitigate** | Root launch is the contract (it already is for the hooks, S1-6). Mitigate with (1) a root `CLAUDE.md` line written by `ik audit --fix --root` that a subdirectory session does read (S1-1, green), naming the symptom and the fix, (2) a `doctor` advisory when run with `cwd ≠ git root`, (3) the `version` tool exposing `cwd`/`repoRoot`/`projectDir`/`launch` for the doctor skill. | A subdirectory session has no infra-kit tools. Nothing at startup says so — only the `CLAUDE.md` line (model-reported) and a typed `doctor`. | **chosen** |
| B — plugin server + user-scope fallback from `setup` | `claude mcp add --scope user infra-kit -- infra-kit mcp` on every machine that ran `setup`. | Precedence user > plugin: the plugin server is shadowed on EVERY machine that ran `setup`, i.e. all of them; prefix `mcp__infra-kit__` there, `mcp__plugin_…` on the rest → two prefixes across the team, the thing every body sweep exists to avoid. | rejected |
| **C — user-scope only, no plugin server** | `setup` runs `claude mcp add --scope user infra-kit -- infra-kit mcp` (stored in `~/.claude.json`); consumer key removed; plugin ships nothing. | See the steelman below. | runner-up, documented |
| D — plugin at user scope | Loads everywhere incl. subdirs. | Rejected by D6 (skill context in every repo); 9 skills + 2 commands now — heavier than the 347 tokens measured at 0.3.0. Not re-measured: D6's ground is not the number. | rejected (settled) |
| E — make Claude Code walk up | Not available (F5: cwd-only). A `.claude/settings.json` per subdirectory is not a design. | — | rejected |

**Steelman of C (per driver, no rationalising).**

| Driver | C | Plugin (A) |
| --- | --- | --- |
| D1 repo-declared, versioned unit | Loses. The registration is per-machine, invisible in the repo; nothing in a fresh clone declares the server; Claude Code prints no "missing server" line. Not what the user asked for. | Wins — with one honest limit: Claude Code's startup line covers only a plugin that was NEVER installed (F-20.3); an installed-but-stale plugin (< 0.8.0, no server) is as silent under A as a missing user-scope registration is under C. |
| D2 no silent loss | **Wins outright.** Root, worktree and subdirectory all have the tools; same key `infra-kit` at user scope → a leftover consumer key shadows a same-prefix twin (harmless); the old prefix survives, so no body changes and no switch moment. | Loses the subdirectory path (mitigated, not fixed). With the launch-aware prefix (§3.3) A also has no switch moment and no body mismatch — the gap between A and C on D2 is now the subdirectory path alone. |
| D3 blast radius | **Wins.** Zero prefix rename in 9 repos; U7 stays; ~1/5 of this plan (setup writer + doctor row + 9 one-line key removals). Reversal is `claude mcp remove --scope user`. | One-time sweep of the F11 list; reversible per repo; consumer PRs carry no deadline (§3.3). |
| Enforcement (P2) | **Equal.** A subdirectory session has no repo hook under either (S1-6); C keeps the sanctioned MCP path there, A removes it; the unguarded raw path stays under both. | Equal. |
| New cost | 26 tool schemas in EVERY session on the machine, every repo, family or not. Magnitude: S1-2 (§12, a 5-minute measurement to take before the user answers OQ-1). Tools appear in unrelated repos and fail honestly there. `~/.claude.json` is a machine-global file the CLI would have to edit (or `claude mcp add`, whose formatting is F9-like — S1-3). | The prefix everyone has typed changes once; a second prefix constant lives in the CLI until the last consumer PR merges. |

**Verdict.** C is strictly better on D2 and D3; A is strictly better on D1; on enforcement they are equal
(rev 1 claimed an enforcement edge for A — struck: it inverted the picture, see §13 edit 2). The drivers are
ordered and D1 is the user's own ask, so the plugin route stays primary — but the case for it now rests on D1
alone, and the plan says so rather than manufacturing a second reason. Edit 1 (launch-aware prefix) narrows A's
cost, not C's advantage: the ranking is unchanged and the margin is smaller. **If the user values "tools from any
cwd" above "the repo declares its tooling", C is the right call and this plan collapses to:** `setup` gains
`claude mcp add --scope user …` (idempotent; `inspect` first), doctor gains a `user-scope MCP server` row, 9 PRs
each delete one key — no sweep, no U7 flip, no prefix constants. That is §11 OQ-1, with the recommendation to
stay on the plugin and S1-2's number beside it.

### 3.3 The doctor / setup surface

**The served prefix is launch-aware (rev 2, edit 1).** S1-5 measured that a `.mcp.json`-spawned server sees
`CLAUDE_PLUGIN_ROOT` unset and a plugin-spawned one sees the plugin dir. So `infra-kit mcp` knows its own route:

- `src/mcp/tool-prefix.ts`: `MCP_TOOL_PREFIX = 'mcp__plugin_infra-kit_infra-kit__'`,
  `LEGACY_MCP_TOOL_PREFIX = 'mcp__infra-kit__'`, `resolveLaunch(env) → 'plugin' | 'legacy'`
  (`env.CLAUDE_PLUGIN_ROOT !== undefined && !== ''`), `prefixFor(launch)`, `toolName(name, launch)`.
- The launch env is read INSIDE `createMcpServer()` (`server.ts:9`) — `resolveLaunch(process.env)` — never at
  module scope, and passed to `initializeResources(server, launch)`; `resources/index.ts:149,160` descriptions go
  through `toolName(…, launch)`, and the read callback at `resources/index.ts:91` (serves `WORKFLOW_BODIES[key]`
  verbatim today) returns `renderForLaunch(WORKFLOW_BODIES[workflow.key], launch)`. `WORKFLOW_BODIES`
  (`workflow-bodies.ts:37-40`) stays the canonical constant, untouched. **Why not at module scope:** a
  module-scope render is fixed at first import, so §7's doubled `server.test.ts` cases would pass on the
  first-imported spelling both times — a false green of the dist-digest kind (memory: a digest compared across a
  restart passes on the exact bug it targets). `serveStdio` builds the server lazily on the first frame and may
  build twice per connection (memory) — harmless, the render is pure and re-run per build. Pinned by AC-2b.
- The three `resources/workflow/*.md` bodies are AUTHORED in the canonical (plugin) spelling — plain literals,
  prettier-safe (memory: prettier owns the bytes and mangles `{{x}}`; no template token). At serve time the
  legacy launch renders `body.replaceAll(MCP_TOOL_PREFIX, LEGACY_MCP_TOOL_PREFIX)`; the plugin launch serves the
  bytes unchanged. One substitution of one constant; the spelling test (§7) asserts the source bodies contain no
  `mcp__` occurrence that is not `MCP_TOOL_PREFIX`, and the rendered legacy bodies contain none that is not
  `LEGACY_MCP_TOOL_PREFIX`. *Alternative (stated, not chosen):* bodies name tools bare (`env-load`) and a
  render-time wrapper prefixes them — costs a second grammar for tool references in Markdown, a resolver for
  which bare words are tools, and the loss of the literal the spelling test greps for; nothing it buys is needed.
- Static plugin files cannot be rendered: `plugins/infra-kit/commands/{session,release-create}.md:8` name BOTH
  ("call `mcp__plugin_infra-kit_infra-kit__env-list` — or `mcp__infra-kit__env-list` if this repo's `.mcp.json`
  still registers the server"); the legacy half is removed by follow-up (1) after the last consumer PR.
- `version` tool adds `launch` and `toolPrefix` beside `cwd`/`repoRoot` (PM-4), so the doctor skill can say which
  route a session is on without guessing from tool names.
- Launches that are not ours, one sentence each. A user-scope `claude mcp add infra-kit -- infra-kit mcp` (option
  C, or an experiment) spawns with no `CLAUDE_PLUGIN_ROOT` → legacy prefix → correct, because the key is
  `infra-kit`. A user- or project-scope entry under another key (`ik`) → the session's tools are `mcp__ik__*`,
  neither constant spells it, the bodies are wrong by design, and doctor's `wrong-key` row is the only signal. A
  renamed or forked plugin sets the variable but composes a different prefix → the cross-unit test pins
  `MCP_TOOL_PREFIX` to the two plugin files on disk, so that combination cannot ship from this repo.

Consequences: a session on the legacy route (leftover key, F2 shadow) reads bodies that name the tools it has;
rev 1's PM-5 (bodies naming a prefix that does not exist in that session) no longer exists; the leftover key is
a working state, not a broken one — so `stale` is an ADVISORY and the consumer PRs have no deadline. The cost is
one more constant and one more branch in the server, both deleted by follow-up (1).

**What `ensureMcpRegistration` becomes.** `mcp-registration.ts` (writer, add-only, F15) →
`mcp-registration-stale.ts` exporting `inspectLegacyMcpRegistration(root)`. It WRITES NOTHING in any branch.
`buildServerEntry`/`SERVER_COMMAND` survive as the "ours" predicate (shared with `looksLikeInfraKitServer`,
`install-state.ts:261`). `McpRegistration` (`install-state.ts:253-258`) gains `{ kind: 'stale' }`; `ok` is
removed (`absent` is the one healthy verdict — rev 2 NB-2, settled).

**Is `stale` pass+message or fail?** Options: (a) **`pass` + advisory**; (b) `fail`, report-only. Rev 1 chose
(b) because F2's shadow left the session reading bodies for tools it did not have. With the launch-aware prefix
that malfunction is gone: a shadowed session runs the legacy route end to end, bodies included, and works. What
remains is a pending repo chore, and P5 says a chore is not red → **(a) `pass` + advisory.** F14 is respected
(`'pass' | 'fail'` only; exit 1 scoped to `plugin installed`). The advisory names the chore, says whose it is
(a repo PR, not this machine), and — P5's second half — says how to work today.

**Rows** (SECTION_PLUGIN, `report.ts:99-102`):

| Row | Reads | Verdicts |
| --- | --- | --- |
| `plugin MCP server` (**NEW** — `report.ts:99-102` SECTION_PLUGIN 6 → 7 names, after `plugin version`; `claude-plugin-checks.test.ts:394` `slice(-6)` → `-7`; `report.test.ts:79-84` picks it up through `DOCTOR_CHECK_NAMES`) | **The served copy = the install record's `installPath`** (`~/.claude/plugins/cache/infra-kit/infra-kit/<v>/`, F8, S0-7(b)) — `<installPath>/.mcp.json` + `<installPath>/.claude-plugin/plugin.json` `name`. This REVERSES rev 5.1 §8.2 step 7's "marketplace clone by default, record as fallback": the clone is what `claude plugin update` fetches, the record is what a session loads. Step 0c's "fetched but not applied" advisory already reads the same pair the same way round (`doctor.ts:1023-1029`, `readInstalledPluginVersion` = record, `readMarketplacePluginVersion` = clone). | not installed → fail "no plugin installed for this project to serve it" (same fix as `plugin installed`); file absent → **fail** "Plugin <v> does not carry the infra-kit MCP server — update it: `claude plugin update infra-kit@infra-kit --scope project`"; file present but key ≠ `infra-kit` or command ≠ `infra-kit`, or `name` ≠ `infra-kit` → **fail** "…carries a server under `<key>` — install corrupt or renamed; reinstall: `claude plugin uninstall infra-kit@infra-kit && claude plugin install infra-kit@infra-kit --scope project`"; composed prefix === `MCP_TOOL_PREFIX` → pass "Plugin <v> serves the infra-kit MCP server as `mcp__plugin_infra-kit_infra-kit__*`". Never reads `packageJson.version`; no version literal. |
| `plugin version` | unchanged (served version + fetched-not-applied advisory, `doctor.ts:1023-1043`) | unchanged |
| `MCP server key` (name unchanged) | `inspectLegacyMcpRegistration(root)`, **transition-guarded on `plugin MCP server` = pass** | Served plugin carries the server: `absent` / `missing-file` → pass "served by the plugin — `.mcp.json` carries no infra-kit key"; `stale` → **pass + advisory** "`.mcp.json` still registers `infra-kit`, so Claude Code uses that entry and the plugin's copy of the server is shadowed (same key, project scope wins). Until this repo's key-deletion PR merges, sessions here serve `mcp__infra-kit__*` and every body they read already names that prefix — nothing to fix on this machine. The PR: delete the `infra-kit` entry from `.mcp.json` by hand (`claude mcp remove infra-kit --scope project` also works but re-indents the file)"; `wrong-key` → fail "…registers an infra-kit server under `<k>` — a second server process with its own prefix; remove it"; `unparseable` → fail (today's text). Served plugin does NOT carry the server: today's verdicts with today's texts (`ok` → pass "the `.mcp.json` entry is the live route until the plugin advances"), plus on `absent`/`missing-file` → **fail** "no server at all: `.mcp.json` has no `infra-kit` key and plugin <v> does not carry it — `claude plugin update infra-kit@infra-kit --scope project`, then restart Claude Code" (the PM-1 detector reachable from a typed `doctor`). |
| `plugin installed` | + subdirectory advisory. `doctor` cannot know where Claude Code was launched; it can compare two things: (i) when `CLAUDE_PROJECT_DIR` is present — the MCP-served `doctor` tool has it — `CLAUDE_PROJECT_DIR ≠ getProjectRoot()` is the PRECISE test (the session was launched below the root); (ii) the typed CLI has only its own cwd, so `process.cwd() ≠ getProjectRoot()` is a hint, not a verdict (a root-launched session whose model `cd`s into `apps/` and runs `doctor` is not a subdirectory session). | (i) → "this session was launched from `<CLAUDE_PROJECT_DIR>`, below the repo root — the plugin and this repo's `.claude/settings.json` hooks load only from `<root>` (measured); restart Claude Code there"; (ii) → "if Claude Code was launched from `<cwd>` rather than `<root>`, it loaded neither the plugin nor this repo's hooks — launch it at `<root>`". Status unchanged in both (A-2 mitigation). |

`MCP_NON_FAILING` becomes `{ absent, missing-file, stale }` in the post-switch branch. `MCP_MESSAGES` spell both
prefixes via the two constants only (P6).

**`setup` (`init.ts:754`).** `ensureMcpRegistration(root)` call replaced by `inspectLegacyMcpRegistration(root)`
AFTER `installPluginForProject` (which now updates, step 0b); `stale` → step `mcp-registration`, outcome
`ok` at `info` level with the advisory text above (a chore, not a warning); `absent`/`missing-file` → `ok`
"served by the plugin". Comment block
`init.ts:721-728` ("register the MCP server the plugin's skills call") rewritten. `ik audit --root` gains a
report-only line for `stale` beside the proxy check (`audit.ts:191-193`; never `--fix`).

### 3.4 The consumer-side switch

| Option | Verdict |
| --- | --- |
| (a) **One human PR per repo**: delete the key by hand (F9: `claude mcp remove` reformats), 3-file prefix sweep, regenerated root `CLAUDE.md` block (`ik audit --fix --root`), grep output in the body | **chosen** |
| (b) CLI's sibling-preserving writer offers the removal, human-confirmed (`setup`/`doctor --fix`) | rejected — this is Q1 under another command name (§14: "Q1 no — no confirm-gated deletion"); the writer half would survive with one caller for one key that is deleted once per repo, and the confirm prompt inside `doctor` collides with the `confirmOrExit` hazard (memory) |

The PR is the switch (F2): the moment it merges, every session in that repo that has plugin ≥ 0.8.0 flips prefix
— and, because bodies are rendered per launch (§3.3), nothing else changes for it; a session whose plugin is older
has no server (PM-1). Until the PR merges the repo works on the legacy route indefinitely; there is no deadline.

## 4. Pre-mortem

| # | Scenario | Detection | Mitigation / what to type |
| --- | --- | --- | --- |
| PM-1 | **Consumer PR merges; a teammate's served plugin < 0.8.0** (child never ran on that machine — it runs only from a typed TTY `infra-kit` command past the 20-min throttle, F8; or ran but Claude Code not relaunched). No key, no server. Sub-case: the Claude-Code-only teammate — no channel advances for them. | In the session: no `mcp__plugin_infra-kit_infra-kit__*` tools; the old cached `commands/session.md:8` fallback calls `mcp__infra-kit__env-list` → not found. Typed `infra-kit doctor` (any CLI ≥ 0.8.0): `plugin MCP server` **fail** + `MCP server key` "no server at all" **fail**. Claude-only: the deploy guard's deny text first line (`block-deploy.mjs`, repo-local, loads regardless of plugin version) and the root `CLAUDE.md` block line (loaded in every session) both name the fix. | Type in a terminal: `infra-kit setup` (updates an installed plugin, step 0b) or `claude plugin update infra-kit@infra-kit --scope project`, then restart Claude Code. Bound: the canary merges only after the maintainer has seen the plugin server live; PR bodies carry the two commands. **Cost of not waiting for AC-0 lives here:** the first automatic advance is observed on the release that needs it, not before. |
| PM-2 | **Session launched from `apps/` after the switch.** No plugin, no server, no repo hook (S1-6), no skills (F5). | Startup prints nothing. The model reads the root `CLAUDE.md` line "if no `mcp__plugin_infra-kit_infra-kit__*` tools are present you are in a subdirectory session — restart Claude Code at `<repo root>`" (S1-1: the root `CLAUDE.md` IS loaded from a subdirectory). Typed `infra-kit doctor` from that directory: `plugin installed` advisory. | Root launch documented in README + `CLAUDE.md` block. Enforcement is unchanged by the migration: that session had no guard before either (S1-6), and keeps the unguarded raw path (§9 follow-up 5). |
| PM-3 | **A hook or body still names `mcp__infra-kit__*` where it should not** — including the OLD cached plugin copies (< 0.8.0), which cannot be edited in place. | Negative tests: U15 (`plugins/` skills), commands regex (both prefixes present), `tool-prefix.test.ts` (CLI `src/` + `resources/`: no `mcp__` literal outside the two constants and the canonical-spelling bodies), consumer `block-deploy.test.mjs`; family-wide grep pasted in each PR body (AC-5). Old cached copies name the legacy prefix, which resolves on the legacy route and fails on the plugin route → PM-1's detectors. | One sweep commit per repo; old cached copies are retired by the plugin advance, not by edits. |
| PM-4 | **`version.repoRoot` in a worktree ≠ `CLAUDE_PROJECT_DIR`** — the server was spawned in the main checkout while the session sits in a worktree; `release-create`/`local-deploy` would act on the wrong checkout. | `version` tool returns `{ version, cwd, repoRoot, mainRepoRoot, projectDir, launch, toolPrefix }` (`projectDir` = `CLAUDE_PROJECT_DIR`, `repoRoot` = `getProjectRoot()` = `--show-toplevel` of cwd, worktree-local by construction, `git-utils.ts:143`). Doctor SKILL Step 3 asserts `cwd === repoRoot === projectDir === pwd`. Expected equal by F6 + §3.1(a); **proven only by S1-4** (§7 E2E worktree row on the published 0.8.0 plugin) — until then it is an expectation. | Mismatch = platform regression → report, relaunch; `cwd` field is what makes it impossible on 2.1.270. |
| PM-5 | **Shadow window** — plugin 0.8.0 live, consumer key still present. *Rev 1's failure (bodies naming a prefix the session lacks) no longer exists: the server renders bodies for the route that spawned it (§3.3).* Residual: two routes in the family for as long as PRs are pending. | `MCP server key` `stale` advisory; `setup` info line; `ik audit --root` line; `version.launch = 'legacy'`. | No deadline; harmless to the two-call confirm protocol (F12: one process per session). |
| PM-6 | `claude plugin validate --strict` rejects `type` or `cwd` in the plugin `.mcp.json`. | S1-0 before the first commit; plugin-ci U1. | Drop the offending field; U7 asserts the committed shape. |
| PM-7 | Repo set drifts from F10: `sandbox-workspace` carries the key + `enabledPlugins` + 3 prefix files (measured 2026-09-14, this session) — F10 lists 6 family repos, rev 5.1 §8.5 listed 7. | `grep -l '"infra-kit"' ~/projects/*/.mcp.json` before the PR round. | 7 family PRs; the list in §5 is the measured one. |
| PM-8 | First launch after the switch prompts for server approval on some machine. | F1: none observed for project-scope plugin servers. | PR body: "approve once if prompted". |
| PM-9 | **CLI behind the plugin — a state step 0 itself creates.** The child advances the plugin on EVERY run, `cannot-self-spawn` included (`run-update-check.ts:183-186, :271`; Homebrew / unknown install location), so a machine whose CLI cannot self-install reaches plugin 0.8.0 while its CLI stays 0.7.x; `setup` (0b) reaches the same state by hand. Harmless while the repo's key shadows the plugin. After that repo's consumer PR merges, the plugin spawns CLI 0.7.x: tools are `mcp__plugin_infra-kit_infra-kit__*`, but every body and description the 0.7.x server serves says `mcp__infra-kit__*` (no `renderForLaunch`) — rev 1's PM-5 through the reverse door; `version` has no `launch`; 0.7.x `doctor`'s `MCP server key` reads `absent` and FAILS "run: infra-kit setup"; and 0.7.x `setup` still owns the add-only writer, so following that advice RE-ADDS the key to a tracked `.mcp.json` — a dirty tree in the consumer and a silent flip back to the legacy route (which, on a 0.7.x CLI, is in fact the consistent state — the damage is the uncommitted edit, not the session). | (1) The CLI's own manual-update notice on every typed command (`cannot-self-spawn` / `install-stale` outcomes print `<updateCommand>`) — this population is told to update the CLI by hand every time it types. (2) Plugin 0.8.0 `skills/doctor/SKILL.md` Step 3 rule: "`version` has no `launch` field ⇒ the CLI predates 0.8.0 — update it (`<updateCommand>` from the CLI's notice); never run `infra-kit setup` from a CLI older than 0.8.0 in a repo whose `.mcp.json` no longer has the key — it re-adds it". (3) Plugin 0.8.0 commands name both prefixes (§5 step 12), so `/infra-kit:session`'s fallback still resolves. | **Chosen: (c) both, with (b) shipped inside step 0's release.** (b) `run-update-check.ts:176-192` wrapper: skip `updatePlugin` and record `plugin: 'skipped-cli-stale'` (`PluginUpdateOutcome`, `update-cache.ts:40`, +1 member) when **`written.last.latestVersion !== null && isNewerVersion(written.last.latestVersion, currentVersion)`** — the predicate the cache already encodes ("a newer CLI exists and this run did not install it"), not an outcome list: `cannot-self-spawn` (`:271`), `parent-unknown` (`:276`), `parent-still-running` (`:297`), `install-failed` (`:324`) and `install-stale` (`:335`) all stamp a newer `latestVersion` and are all covered, present or future; `installed` clears it (`:338`) and `up-to-date` writes a non-newer one (`:253`), so both still run the plugin step and AC-0's plugin-only-bump semantics on self-spawn machines hold; `fetch-failed` (`latestVersion: null`) cannot be gated and is not — the plugin advances, as today; `already-running` never reaches the wrapper. `setup` (0b): the same predicate — `latestVersion` newer than `packageJson.version` — read from the update cache in `init.ts` (commands → lib; NOT in `install-plugin.ts`, which `update-plugin.ts:24` already imports via `plugin-pointer/install-state`, so `install-plugin.ts` importing `update-check` would be a cycle; cost = `readUpdateCache` + `isNewerVersion`, nothing heavy). **No cache** (opt-out machines: `INFRA_KIT_NO_AUTO_UPDATE` / `NO_UPDATE_NOTIFIER` / `CI`, `guards.ts:9`, never write one) → 0b runs its own bounded `fetchLatestVersion` (`registry.ts:61`) and applies the same predicate; `setup` is interactive, one fetch is fine; fetch failure → update as before (unknowable, like `fetch-failed`). Skip message: "CLI <cur> is behind <latest> — update it first: `<updateCommand>`; the plugin updates on the next typed command after that". **The gate cannot see the merge → publish window** (§5 step 3): while the marketplace serves plugin 0.8.0 and the registry still says 0.7.2, the predicate is false and a `cannot-self-spawn` machine that types a command advances the plugin without a CLI to follow — the PM-9 state, entered automatically. Detection is unchanged (the CLI's manual-update notice starts on that machine's first command after publish; the SKILL rule; both-prefix commands); mitigation is (a) — the PR body's "CLI ≥ 0.8.0, update the CLI first" — plus publishing immediately after the merge so the window is minutes. **Stale-cache false skip is bounded:** the skip needs `latestVersion > packageJson.version`, so a hand-updated CLI is never skipped; a manager change after a stale stamp skips `setup`'s plugin update once, and the next typed command's child installs and advances — one throttle window. One predicate each, a step-0 AMENDMENT that must be in the FIRST CLI whose child advances the plugin at all, i.e. 0.7.2 (OQ-2's second reason): pre-0.7.2 CLIs never auto-advance the plugin, 0.7.2+ CLIs gate it, so the state is reachable only by a hand-typed `claude plugin update` — covered by (a). **Cost to those users** (Homebrew / unknown-location installs): plugin freshness is coupled to CLI freshness — their skills lag until they run the update command they are already shown on every command; the two channels stay at most one CLI release apart on exactly the machines that cannot heal themselves. Self-spawn-capable machines are unaffected (`installed` → plugin advances as before; a plugin-only bump on an `up-to-date` CLI still delivers, AC-0 semantics kept). (a) PR body keeps "CLI ≥ 0.8.0 and plugin ≥ 0.8.0 required; on a Homebrew/manual install update the CLI first". |

## 5. Ordered steps (paths under `/Users/arthur/projects/infra-kit` unless a consumer is named)

### Step 1 — ship step 0 first: CLI 0.7.2 (branch `do/mcp-via-plugin-step0`, implemented; ONE amendment)

**Amendment (PM-9, one branch in each of two files, on the step-0 branch before it ships):**
- `src/lib/update-check/run-update-check.ts:176-192` wrapper — before `recordPluginUpdate`, if
  `written.last?.latestVersion !== null && isNewerVersion(written.last.latestVersion, currentVersion)` then do not
  call `updatePlugin`; record `plugin: { outcome: 'skipped-cli-stale', checkedMs }`. `update-cache.ts:40`
  `PluginUpdateOutcome` gains `'skipped-cli-stale'`. A predicate, not an outcome list (PM-9 says which outcomes
  it covers and why `installed`/`up-to-date` still advance).
- `src/commands/init/init.ts` (0b path, `installPluginForProject` → `already-installed` → update): the cache read
  lives HERE (commands → lib), never in `install-plugin.ts` (`update-plugin.ts:24` → `plugin-pointer` would make
  `install-plugin.ts` → `update-check` a cycle). `readUpdateCache()`; if absent → one bounded
  `fetchLatestVersion()` (`registry.ts:61`; opt-out machines never write a cache, `guards.ts:9`); then the same
  predicate against `packageJson.version` → outcome `skipped-cli-stale` with the message in PM-9; fetch failure
  or no newer version → update as implemented. Imports: `readUpdateCache`, `fetchLatestVersion`,
  `isNewerVersion` (`semver.ts:89`).
- Tests in `run-update-check.test.ts` / `init` tests (§7).

Then merge + lockstep publish (memory: bump → publish config → re-pin → publish cli). Cost: one publish. Gain:
(1) every machine that types an `infra-kit` command between now and the 0.8.0 merge already runs the child, so
0.8.0 arrives automatically instead of one throttle window later; (2) **the PM-9 gate must be in the first CLI
whose child advances the plugin at all** — pre-0.7.2 CLIs have no plugin step, 0.7.2+ gate it, so the only
automatic path into "plugin ≥ 0.8.0 on a CLI < 0.8.0" is the **merge → publish window** of step 3: the
marketplace is already at plugin 0.8.0 while the registry's latest is still 0.7.2, the predicate is false
(no newer CLI exists yet), and a machine that types a command in that window advances the plugin — on a
self-spawn machine the CLI follows on the first command after publish; on a `cannot-self-spawn` machine it does
not, and that machine is in the PM-9 state until its owner runs the update command. Harmless until that repo's
consumer PR merges; the manual rails (PM-9 (a)) are the real bound there, and keeping the window short (publish
right after merge) is the only automatic help. Folding into 0.8.0 would be the same code with one fewer
publish and one extra 20-min window, and would leave no 0.7.x CLI with the gate — moot only because no 0.7.x
CLI would then have the plugin step either; still not recommended (gain 1).

### Step 2 — migration PR `[DO] mcp: serve through the plugin; retire the .mcp.json writer` (CLI 0.8.0 + plugin 0.8.0)

CLI:
1. `apps/infra-kit/cli/src/mcp/tool-prefix.ts` (new): `MCP_TOOL_PREFIX`, `LEGACY_MCP_TOOL_PREFIX`,
   `resolveLaunch(env)`, `prefixFor(launch)`, `toolName(name, launch)`, `renderForLaunch(body, launch)`
   (§3.3). The ONLY file spelling either prefix. Every other speller in `src/` imports it.
2. `src/mcp/server.ts:9` `createMcpServer()` — `const launch = resolveLaunch(process.env)` INSIDE the function
   (never module scope, §3.3), passed to `initializeResources(server, launch)`; `src/mcp/resources/index.ts:149,160`
   — `toolName('release-create', launch)`, `toolName('setup', launch)`; the read callback at `:91` returns
   `renderForLaunch(WORKFLOW_BODIES[workflow.key], launch)`. `workflow-bodies.ts:37-40` `WORKFLOW_BODIES` is NOT
   changed — it stays the canonical constant the spelling and bundle tests read.
3. `apps/infra-kit/cli/resources/workflow/setup.md:3,122`, `session.md:4,59,61,86`, `release-create.md:3` —
   literal sweep to the CANONICAL (plugin) spelling only (`?raw` Markdown, prettier owns the bytes — memory; the
   legacy rendering is a substitution at serve time, never a token in the file).
4. `src/lib/plugin-pointer/mcp-registration.ts` → `mcp-registration-stale.ts` (`inspectLegacyMcpRegistration`;
   header rewritten; `persist`/`createMcpFile`/`registerServer` deleted; `readMcpFile`/`detectIndent` kept only if
   a reader still needs them). `install-state.ts:252-258` `McpRegistration` `ok` → `stale`; comment `:270-277`
   rewritten (prefixes via the constants). **`looksLikeInfraKitServer` (`install-state.ts:261-268`) tightened**
   from `\`${command} ${args}\`.includes('infra-kit')` to `command === 'infra-kit' && args[0] === 'mcp'` — the
   substring test reads a `grafana`-style `ik-mcp --name infra-kit-x` proxy entry as a misfiled server (`wrong-key`,
   a red row for a correct file); the `buildServerEntry` shape is the predicate (edit 8).
5. `src/commands/init/init.ts:721-755` — §3.3.
6. `src/commands/doctor/doctor.ts:1013-1043, 1128-1176` — §3.3 rows; `report.ts:101` `SECTION_MEMBERS` +
   `'plugin MCP server'`.
7. `src/commands/version/version.ts:11-33` — `cwd`, `repoRoot`, `mainRepoRoot`, `projectDir` (nullable),
   `launch`, `toolPrefix` in `structuredContent` + `outputSchema`; `getProjectRoot` failure → `repoRoot: null`
   (never throw from `version`).
8. `src/commands/audit/audit.ts:191` — report-only `stale` line.
9. Tests (§7). `apps/infra-kit/cli/package.json` → 0.8.0 (lockstep with config/eslint-plugin/vite per the
   release script).

Plugin (own commit for the bump, F13; CI `check-plugin-version-bump.mjs` needs the version line in the PR diff):
10. `plugins/infra-kit/.mcp.json` — §3.1 content.
11. `plugins/infra-kit/.claude-plugin/plugin.json` — `version: "0.8.0"`; description: "Engineering skills and
    the infra-kit MCP server for the infra-kit family of monorepos. The server is the global infra-kit CLI on
    PATH; bundles no hooks."
12. `plugins/infra-kit/commands/session.md:8`, `release-create.md:8` — fallback clause names BOTH prefixes
    (static file, cannot be rendered per launch — §3.3): "call `mcp__plugin_infra-kit_infra-kit__env-list`, or
    `mcp__infra-kit__env-list` if this repo's `.mcp.json` still registers the server; if neither exists the plugin
    predates 0.8.0 — say so and stop". The legacy half goes with follow-up (1).
13. `plugins/infra-kit/skills/doctor/SKILL.md:66-90` — Step 3 bullet 1 (`:70`, "registered correctly in
    `.mcp.json`") → "the CLI says the plugin serves the server but no `mcp__plugin_infra-kit_infra-kit__*` tools
    are in this session: stale session, or a leftover `.mcp.json` key shadowing it (the CLI's `MCP server key`
    row says which)"; Step 4 bullet 4 (`:86`, "the key must be `infra-kit`") → "a leftover or misfiled
    `.mcp.json` entry is a hand edit in a PR; never rewrite that file"; add Step 3 checks `version.repoRoot === pwd`
    (PM-4) and `version.launch` (which route this session is on), and the PM-9 rule: "`version` has no `launch`
    field ⇒ the CLI predates 0.8.0 — update it with the command the CLI prints; **never run `infra-kit setup`
    from a CLI older than 0.8.0 in a repo whose `.mcp.json` no longer carries the `infra-kit` key** — that CLI's
    `setup` re-adds it". The skill never restates a CLI verdict.
14. `plugins/infra-kit/README.md:6-16` — paragraph rewritten: ships ONE `mcpServers` entry pointing at the global
    CLI (P1; Q3 amended: "the plugin may hold the one pointer `.mcp.json` held"); **hooks still not shipped (D9
    half kept verbatim)**; "launch Claude Code at the repository root — a project-scope plugin, and this repo's
    hooks, load from `<cwd>/.claude/settings.json` only (measured, F5, S1-6)"; "a repo whose `.mcp.json` still
    registers `infra-kit` keeps working on the old prefix — the server renders its guidance for whichever route
    spawned it"; the `Update` section stays as written by step 0. Remove "it stays on hold (§6.1, S0-2)".
15. `.claude-plugin/marketplace.json` — description only (U8: no version).

Root guidance (the A-1 mitigation, writer = `ik audit --fix --root`, F16):
16. `src/lib/agent-guidance/bodies/root-body.ts` — one line under Conventions: "Launch Claude Code at the repository
    root: the infra-kit plugin (skills, `/infra-kit:*` commands, the `mcp__plugin_infra-kit_infra-kit__*` MCP
    server) and this repo's `.claude/settings.json` hooks load only from there. If those tools are absent, this is
    a subdirectory session — restart Claude Code at the root." The block regenerates in every consumer PR.

### Step 3 — merge + publish

Merge (plugin 0.8.0 live — the marketplace IS this repo, F13); `claude plugin tag ./plugins/infra-kit`; npm
publish CLI 0.8.0 (lockstep order). Between merge and publish `check-workflow-resource-published.mjs` is
expectedly red (plugin-ci.yml:47-55, unchanged). On the author's machine: type any `infra-kit` command, wait for
the child (or `infra-kit setup`), then run `infra-kit doctor` in this repo: **`plugin MCP server` pass is the
only pre-canary evidence that exists.** `claude mcp list` showing `plugin:infra-kit:infra-kit` as connected is
NOT evidence — F2: it shows both rows connected while only the project entry is exposed to the session — and the
session itself still exposes `mcp__infra-kit__*` (shadowed), with `MCP server key` showing the `stale` advisory
and `version.launch = 'legacy'`. Live proof that the PLUGIN's copy serves is impossible while this repo's key
exists; it comes at step 4.

### Step 4 — canary: this repo's consumer PR (merged after step 3's `doctor` evidence; the live proof follows the merge)

`.mcp.json` — delete the `infra-kit` entry by hand (keep `linear-server`, keep 2-space indent + trailing
newline). `.claude/hooks/block-deploy.mjs:100-101`, `.claude/hooks/README.md:68`,
`.claude/hooks/__tests__/block-deploy.test.mjs:408` — prefix sweep; deny text gains the first line "no
infra-kit tools in this session? in a terminal: `infra-kit setup` (updates the plugin) or `claude plugin update
infra-kit@infra-kit --scope project`, then restart Claude Code at the repo root". `ik audit --fix --root`
regenerates `CLAUDE.md`. `docs/*.md`, `.omc/plans/*` untouched (F11). After merge + relaunch: AC-3 observed
live (`mcp__plugin_infra-kit_infra-kit__version` → `repoRoot` = this repo, `launch = 'plugin'`) — the first
live-tool evidence in the whole sequence (AC-9). If it fails, `git revert` this PR (§6): the key re-shadows and
service is back on the legacy route. Only after AC-9 passes, step 5.

### Step 5 — consumer PRs `[DO] mcp: the plugin serves infra-kit; drop the .mcp.json entry`

Order: travelist-monorepo (grafana sibling — the derived `ik-mcp` line stays byte-identical, T2-a), hulyo-monorepo,
starter-workspace (+ `CLAUDE.md` prefix hits), nomadream-monorepo, bridge-monorepo, sandbox-workspace (PM-7).
Each: 1 key deletion + 3-file sweep + `ik audit --fix --root` block + PR body (CLI ≥ 0.8.0 AND plugin ≥ 0.8.0
required — "on a Homebrew or manually installed CLI, update the CLI first (`brew upgrade …` / the command
`infra-kit` prints); do not run `infra-kit setup` from an older CLI in this repo, it re-adds the key" (PM-9);
the two terminal commands; "approve once if prompted"; `grep -rn mcp__infra-kit__ --exclude-dir=node_modules
--exclude-dir=docs --exclude-dir=.omc` output = empty).
Out of family (Q2 settled: in scope, 2 PRs each): **GLV-Backend** (key present, no pointer, 0 prefix files) and
**nomadream-ota-n-level** (key present, `.claude/settings.json` without the pointer, 2 prefix files) — PR-1
`infra-kit setup` writes `enabledPlugins` + `extraKnownMarketplaces` (D6); PR-2 as above.

## 6. Rollback, per step

| Step | Rollback | Cost |
| --- | --- | --- |
| 1 (CLI 0.7.2) | none needed — step 0 is independent of the shape; the PM-9 gate only withholds a plugin advance and never writes `.mcp.json` (it does stamp `plugin: 'skipped-cli-stale'` into the update cache, which the next run overwrites) | — |
| 2/3 (plugin 0.8.0 + CLI 0.8.0, no consumer PR merged yet) | plugin **0.8.1 without `.mcp.json`** (U7 re-flipped, commands/SKILL/README reverted) in one commit; CLI 0.8.1 = `git revert` of the CLI half (writer restored, both prefix constants and the launch branch gone). Consumers still carry the key, and a 0.8.0 CLI left on any machine keeps rendering the legacy prefix for a `.mcp.json` launch, so no session ever lacks a server or reads a wrong tool name. | 1 plugin commit + 1 CLI publish |
| 4/5 (a consumer PR merged) | `git revert` the consumer PR (key back, sweep back) — the key re-shadows the plugin server immediately (F2), no plugin change needed to restore service; THEN the 2/3 rollback if the shape itself is abandoned. `infra-kit setup` on a reverted-CLI ≥ 0.8.1 re-adds the key via the restored writer for a repo whose revert is not yet merged. | 1 commit per repo |

Order matters: revert consumers first (service back), plugin second — never the reverse. **A CLI-only rollback
with consumer PRs left merged is NOT a supported state:** CLI 0.8.1 restores the add-only writer, so the next
`infra-kit setup` in a migrated repo re-adds the key to a tracked `.mcp.json` — the same re-add as PM-9's tail,
now on every machine. If the CLI must be reverted while consumer reverts are pending, revert the writer half
LAST (ship the prefix/render revert without `ensureMcpRegistration`) and restore it only once every consumer
revert has merged.

## 7. Test plan

**Unit**
- `plugins/infra-kit/__tests__/manifest.test.mjs` — **U7 flips**: plugin.json has no `hooks`/`commands`/inline
  `mcpServers`; `plugins/infra-kit/.mcp.json` exists, exactly one server `infra-kit`, `command: 'infra-kit'`,
  `args: ['mcp']`, `cwd: '${CLAUDE_PROJECT_DIR}'`. **U15 (new negative)**: the legacy prefix appears under
  `plugins/` outside `__tests__/` ONLY in `commands/*.md` (the fallback clauses, §5 step 12); the suite's own
  literals are the other permitted spellings. **T1** (`:587-591`, walks `SKILLS_DIR`) keeps its literal — the
  old-prefix negative for skills, stays green; the commands-side assertion at `:723` requires BOTH
  `/mcp__plugin_infra-kit_infra-kit__[a-z-]+/` and `/mcp__infra-kit__[a-z-]+/` in every command (dropped to the
  plugin regex alone by follow-up (1)).
- **Cross-unit** `apps/infra-kit/cli/src/mcp/__tests__/tool-prefix.test.ts`: reads
  `plugins/infra-kit/.claude-plugin/plugin.json` and `plugins/infra-kit/.mcp.json` from disk and asserts
  `MCP_TOOL_PREFIX === \`mcp__plugin_${name}_${Object.keys(mcpServers)[0]}__\``; asserts exactly one key;
  `resolveLaunch({ CLAUDE_PLUGIN_ROOT: '/x' })` → `plugin`, `{}` / `''` → `legacy`; `renderForLaunch(body,
  'legacy')` replaces every `MCP_TOOL_PREFIX` and nothing else; **negative:** every `mcp__` literal under `src/`
  and `resources/` is either one of the two definitions in `tool-prefix.ts` or a `MCP_TOOL_PREFIX`-spelled tool name
  in `resources/workflow/*.md` — no `mcp__infra-kit__` outside `tool-prefix.ts` (test fixtures excluded).
- `src/mcp/__tests__/server.test.ts:140,201,295-299`, `mcp-stdio.e2e.test.ts:330-331` — each body assertion runs
  TWICE, server built with `CLAUDE_PLUGIN_ROOT` set and unset, expecting `MCP_TOOL_PREFIX` / `LEGACY_MCP_TOOL_PREFIX`
  spellings respectively and never the other. **AC-2b (new):** in ONE process, `createMcpServer()` twice with
  `CLAUDE_PLUGIN_ROOT` toggled between the builds → the `infra-kit://workflow/session` bodies differ, each in its
  own spelling — this is the test a module-scope render would fail (§3.3).
  `lib/agent-guidance/__tests__/generated-instruction-spelling.test.ts:54` documents the OLD identity form
  (`mcp__infra-kit__setup`) in its exemption comment; its extraction regex flips to the canonical spelling, and
  source bodies must contain no `mcp__` occurrence that is not `MCP_TOOL_PREFIX`. **`replaceAll` is sound:** the
  prefix cannot occur inside another token (it ends in `__` and every tool name follows it directly), prettier
  never rewrites a plain literal, the `trimEnd()` at `workflow-bodies.ts:38-40` is unaffected (the render runs on
  the trimmed constant), and the `resource-bundle.test.ts:52,73` sentinels are not prefix strings, so the bundle
  test is untouched.
- `lib/plugin-pointer/__tests__/mcp-registration-stale.test.ts` (renamed): every case asserts NO write (mtime +
  bytes identical; `vi.spyOn` cannot intercept named fs imports — memory — use the default import); verdicts:
  key present → `stale`; only `linear-server` → `absent`; no file → `missing-file`; `{"$schema":…}` → `unparseable`;
  key `ik` with `command: infra-kit, args: ['mcp']` → `wrong-key`; **`grafana: { command: 'ik-mcp', args:
  ['--name', 'infra-kit-x', …] }` beside no `infra-kit` key → `absent`, NOT `wrong-key`** (edit 8).
- `install-state.test.ts` — `stale` replaces `ok`; `looksLikeInfraKitServer` positive/negative table.
- `commands/doctor/__tests__/claude-plugin-checks.test.ts` — `plugin MCP server`: not installed / file absent /
  key `ik` / name mismatch / correct → the four verdicts; served `0.7.0` WITH a correct `.mcp.json` (synthetic) →
  pass (capability-keyed, no version floor); rows byte-identical with CLI version injected as `0.6.0` and `0.8.0`;
  negative: no `MIN_PLUGIN_VERSION` literal, no `packageJson.version` read in the row; the served-copy path is
  `installation.installPath` (a fixture whose clone is ahead of the record must NOT change the verdict — edit 7).
  `MCP server key`: post-switch `stale` → **pass** + advisory containing the PR text AND the "until the PR merges
  this session serves `mcp__infra-kit__*`" line (edit 5); `absent` → pass "served by the plugin"; transition
  (served copy lacks the file) → today's texts + `absent` → fail "no server at all". `:394` `slice(-6)` → `-7`;
  `report.test.ts:79-84` coverage via `DOCTOR_CHECK_NAMES`. Exit code: a fixture with only these rows failing exits 0.
- `commands/version/__tests__` — `repoRoot` = `--show-toplevel`; `projectDir` = `CLAUDE_PROJECT_DIR` or null;
  `launch`/`toolPrefix` from the env; git failure → `repoRoot: null`, no throw.
- `commands/init/__tests__` — `setup` with a `stale` key → `ok` + advisory, file byte-identical (AC-6).
- **PM-9 gate (step 1 amendment):** `lib/update-check/__tests__/run-update-check.test.ts` — for EVERY locked
  outcome, the plugin step's behaviour follows the written cache's `latestVersion`, not the outcome name:
  `cannot-self-spawn`, `parent-unknown`, `parent-still-running`, `install-failed`, `install-stale` (each writes a
  newer `latestVersion`) → `updatePlugin` NOT called, `plugin.outcome === 'skipped-cli-stale'`, CLI outcome
  returned unchanged; `installed` (clears it) and `up-to-date` (non-newer) → plugin step runs; `fetch-failed`
  (`null`) → plugin step runs; a synthetic outcome injected with a newer `latestVersion` → skipped (proves the
  predicate, not a list). `commands/init/__tests__` (0b): cache with `latestVersion` > current →
  `skipped-cli-stale`, no `claude` spawn; cache with `latestVersion` ≤ current or `null` → `updated`; **cache
  absent → `fetchLatestVersion` is called once**, newer → `skipped-cli-stale`, not newer or fetch rejects →
  `updated`; a hand-updated CLI (current ≥ cached `latestVersion`) → never skipped.
- `.claude/hooks/__tests__/block-deploy.test.mjs:408` (this repo, step 4) — new prefix + the first line.

**Integration**
- `mcp-stdio.e2e.test.ts`: spawn the server with `cwd` = a temp linked worktree → `version.repoRoot` = the
  worktree, `mainRepoRoot` = the main checkout.
- `claude plugin validate ./plugins/infra-kit --strict --json` (plugin-ci U1) — S1-0 locally first.
- `node scripts/check-plugin-version-bump.mjs origin/main` on the PR branch.

**E2E (live `claude`, not CI) — throwaway-plugin recipe from §6.1, on the real 0.8.0 plugin**
```
# scratch repo with .claude/settings.json {enabledPlugins:{"infra-kit@infra-kit":true}, extraKnownMarketplaces:{infra-kit:{source:{source:"github",repo:"ArthurSaenz/infra-kit"}}}}, NO .mcp.json
cd "$SCRATCH" && git init -q && claude plugin marketplace add ArthurSaenz/infra-kit && claude plugin install infra-kit@infra-kit --scope project
run() { (cd "$1" && env -u CLAUDECODE claude -p --dangerously-skip-permissions --output-format json \
  --allowedTools mcp__plugin_infra-kit_infra-kit__version <<< 'Call mcp__plugin_infra-kit_infra-kit__version and print its structuredContent verbatim. If the tool is absent, print TOOL-ABSENT. In every case list EVERY tool whose name starts with mcp__ , one per line.'); }
run "$SCRATCH"                                  # AC-3: repoRoot == projectDir == $SCRATCH, launch == plugin
git -C "$SCRATCH" worktree add -q "$SCRATCH-wt/x" -b x && run "$SCRATCH-wt/x"   # AC-4: repoRoot == the worktree
mkdir -p "$SCRATCH/sub" && run "$SCRATCH/sub"   # AC-3b: TOOL-ABSENT, no mcp__plugin_* AND no mcp__infra-kit__* line
```
(`--allowedTools` is variadic: prompt on stdin, per §6.1 method notes; this repo's bash-guard refuses raw
`git worktree add` inside the repo — run the recipe outside it. AC-3b's second negative exists because a
user-scope registration left over from an S1-2/S1-3 experiment (option C) would give the subdirectory session
`mcp__infra-kit__*` tools and let 3b pass for the wrong reason — `claude mcp list --scope user` must be empty of
`infra-kit` before the run.)

**Observability** — `doctor` rows above; `version` tool fields; `setup` step outcome; `ik audit --root` line;
update-cache `plugin:` outcome (step 0).

## 8. Acceptance criteria

1. `claude plugin validate ./plugins/infra-kit --strict` passes; plugin.json version 0.8.0 in its own commit;
   `check-plugin-version-bump.mjs` green; plugin-ci green (except the expected PM-C red between merge and publish).
2. `tool-prefix.test.ts` green: constant composed from the two plugin files on disk; `grep -rn mcp__infra-kit__
   apps/infra-kit/cli/src apps/infra-kit/cli/resources plugins/` returns exactly: the one
   `LEGACY_MCP_TOOL_PREFIX` definition in `tool-prefix.ts`, the two `commands/*.md` fallback clauses, and test
   files — nothing else. Both launches serve internally consistent bodies (the doubled `server.test.ts` cases).
   Scope note: this repo's own `.claude/hooks/{block-deploy.mjs,README.md,__tests__/block-deploy.test.mjs}` keep
   the legacy literal until step 4 merges, by design — a repo-root grep between steps 2 and 4 will list them;
   they are AC-5's, not AC-2's.
   2b. Two `createMcpServer()` builds in one process with `CLAUDE_PLUGIN_ROOT` toggled serve differently-spelled
   workflow bodies (the launch is read inside the build, never at module scope).
3. Scratch repo, plugin 0.8.0, no `.mcp.json`, no user-scope registration: root launch →
   `mcp__plugin_infra-kit_infra-kit__version` answers with `repoRoot` = `projectDir` = the repo, `launch =
   'plugin'`. 3b. Subdirectory launch → no `mcp__plugin_*` tool AND no `mcp__infra-kit__*` tool (documented,
   README + `CLAUDE.md` line).
4. Registered linked worktree → skills present, `repoRoot` = the worktree path = `projectDir` (S1-4 — the only
   proof of PM-4's equality).
5. After each consumer PR: `grep -rn mcp__infra-kit__ --exclude-dir=node_modules --exclude-dir=docs
   --exclude-dir=.omc` empty in that repo; `ik audit --root` reports no drift (block regenerated, proxy line intact).
6. `infra-kit setup` in a repo whose `.mcp.json` has only `linear-server` leaves the file byte-identical and
   reports the plugin `updated`; with a leftover key it reports `ok` + advisory and still writes nothing.
7. `infra-kit doctor` post-switch: leftover key → `MCP server key` **pass** + advisory (PR text + "until the PR
   merges this session serves `mcp__infra-kit__*`"), exit 0; key removed → pass "served by the plugin"; a
   `grafana` `ik-mcp` sibling never yields `wrong-key`.
8. `infra-kit doctor` `plugin MCP server`: reads the record's `installPath`; served copy without `.mcp.json` →
   fail naming `claude plugin update`; mismatched key → fail naming reinstall; correct → pass; synthetic served
   0.7.0 + correct file → pass; rows identical under CLI 0.6.0 and 0.8.0 and whatever the clone's version.
9. Canary evidence, in order: (a) BEFORE step 4 merges — `infra-kit doctor` on the author's machine shows
   `plugin MCP server` pass (the only evidence available while this repo's key exists; `claude mcp list` is not
   evidence, F2); (b) AFTER step 4 merges and BEFORE step 5 — the maintainer observes AC-3 in a live session in
   this repo (`launch = 'plugin'`).
10. `pnpm run qa` green (gate on `; echo EXIT=$?`, memory: rtk swallows exit codes); the lockstep publish order
    followed (config → re-pin → cli).
11. 9 consumer PRs merged in §5 order; travelist/hulyo `grafana` entry byte-identical.

## 9. ADR

- **Decision.** The plugin ships `plugins/infra-kit/.mcp.json` (one stdio server `infra-kit` → global CLI
  `infra-kit mcp`, `cwd: ${CLAUDE_PROJECT_DIR}`); the CLI spells each prefix once and renders every body it
  serves for the route that spawned it (`CLAUDE_PLUGIN_ROOT` set → plugin prefix, unset → legacy prefix; S1-5);
  the `.mcp.json` writer becomes a stale-detector whose `stale` verdict is a `pass` + advisory; a new
  `plugin MCP server` doctor row carries the capability verdict, read from the record's `installPath`; consumers
  switch by human PR at their own pace; the subdirectory launch path is accepted as plugin-less and made visible
  through the root `CLAUDE.md` block (loaded there, S1-1) and a `doctor` advisory.
- **Drivers.** D1 (repo-declared unit — the user's ask) decides; D2 (no silent loss) and D3 (bounded reversal)
  favour the alternative and are recorded as such. Enforcement is not a driver: it is equal under every option
  (S1-6).
- **Alternatives.** C user-scope registration (runner-up; wins D2/D3, loses D1, adds an every-session tool cost
  measured by S1-2 — §3.2); B plugin + user fallback (two prefixes, rejected); D user-scope plugin (D6, settled);
  E walk-up (unavailable); `stale` as report-only `fail` (rev 1 — superseded by the launch-aware prefix);
  template token in the Markdown bodies (rejected: prettier); bare tool names + render-time wrapper (rejected:
  second grammar, §3.3); folding the capability verdict into `plugin version` (rev 5.1 — rejected: two failure
  meanings in one row, rev-2 issue 6); CLI-side confirm-gated key removal (Q1 settled: no).
- **Why.** The plugin is the unit the repo already declares; the channel that delivers it is now the CLI's own
  (step 0); the served prefix following the launch route means no session ever reads a tool name it lacks — on
  a CLI ≥ 0.8.0, which the PM-9 gate makes the only CLI a 0.8.0 plugin is auto-delivered beside — so the
  migration has no window in which anything is broken — only a path (subdirectory) on which nothing infra-kit
  loads, a path where nothing of the repo's loaded before either.
- **Consequences.** Prefix changes once (F11 list + 9 repos), with a legacy constant and one server branch that
  live until the last consumer PR; on machines whose CLI cannot self-install (Homebrew / unknown location) the
  plugin no longer advances past a stale CLI — their skills wait for the CLI update they are shown on every
  command (PM-9); subdirectory sessions have no infra-kit tools; `doctor` has one more row and
  one advisory (never red) during each repo's migration window; `setup` writes nothing into `.mcp.json` any
  more; first automatic plugin advance is observed on the release that depends on it (AC-0 not waited for); two
  out-of-family repos get the pointer first.
- **Follow-ups.** (1) After all 9 PRs: delete `LEGACY_MCP_TOOL_PREFIX`, `renderForLaunch`, the commands' legacy
  fallback halves and the transition branch of `MCP server key` (served copy without the file → "update the
  plugin" only). (2) S1-2's number goes into §3.2 so C's cost is a number if the question returns. (3) D4
  addendum line in `.omc/plans/infra-kit-claude-plugin.md` (Q3 settled: yes). (4) If Claude Code ever walks up
  for `.claude/settings.json`, delete the `CLAUDE.md` line and the advisory. **(5) Finding — raw-dispatch gap
  (S1-6):** a session launched from a subdirectory has no `.claude/settings.json` hook, so a raw `gh workflow
  run <deploy-workflow> -f env=prod` from Bash meets neither the deploy guard nor the CLI's client-side
  `assertDeployable` veto (memory: prod is delivered, not deployed — the veto is client-side only; GitHub
  Environment protection gates zero jobs). True today, unchanged by A or C; out of this plan's scope; candidates
  are server-side (GitHub Environment required reviewers on the prod job) or a root-launch guard that does not
  depend on cwd — neither is designed here.

## 10. What to tell the user

The server moves into the plugin as you asked. One thing changes for everyone: Claude Code has to be started at
the repository root. We measured today that this is already the rule for the deploy guard and the bash guard —
from `travelist/apps` neither fires — so a subdirectory session loses the infra-kit tools it had, and nothing
else, because nothing else of the repo's ever loaded there. The root `CLAUDE.md` block (which a subdirectory
session does read — also measured) and `infra-kit doctor` will both say "you are in a subdirectory session,
restart at the root". One finding to keep in mind that this plan does not fix: a subdirectory session can run a
raw `gh workflow run` against prod with no guard and no client-side veto, today, whatever we decide here.

There is a cheaper alternative you should know about: registering the server per machine at user scope
(`infra-kit setup` would do it), which keeps the tools in every directory, needs no prefix rename anywhere, and
reverses with one command — but it is not delivered by the plugin, nothing in the repo declares it, and it puts
the 26 tool definitions into every Claude session on your machine, in every repo. On enforcement the two are
equal. If "tools from any directory" matters more to you than "the repo declares its tooling", say so and the
plan shrinks to that; the plugin route's case rests on that one preference of yours, and I am not adding a
second reason.

Otherwise: the tool prefix becomes `mcp__plugin_infra-kit_infra-kit__…`. The server can tell which way it was
started — the plugin sets an environment variable, a `.mcp.json` entry does not — so it writes its own guidance
with whichever prefix that session actually has — provided the CLI is 0.8.0 or newer. That means a repo whose
`.mcp.json` still has the key keeps working exactly as today, `doctor` shows a note rather than a red row, and
there is no deadline on removing the keys. One thing the review caught in the already-written update child: on
a machine where the CLI cannot update itself (a Homebrew install, say) it would still advance the plugin, and a
0.8.0 plugin driving a 0.7.x CLI is the one combination that reads wrong tool names — worse, that old CLI's
`setup` would put the key back into a tracked file. So the child, and `setup`, now hold the plugin back on such
a machine until the CLI is updated by hand — a one-branch change to ship with 0.7.2. Those users' skills wait
for the CLI update they are already told about on every command; everyone else is unaffected. The CLI never deletes a key itself. The order is: publish the already-written update child as 0.7.2, merge
and publish 0.8.0, check `doctor` says the installed plugin carries the server (that is the only check possible
while this repo's own key still exists — `claude mcp list` saying "connected" proves nothing), remove the key
here first, see the plugin's server answer in a live session, then the other eight repos. Because you chose not
to wait for the update channel to prove itself over two releases, the 0.8.0 release is also its first live test:
if a teammate's plugin has not advanced when their repo's PR merges, they have no server until they type
`infra-kit setup` or `claude plugin update infra-kit@infra-kit --scope project` in a terminal — every PR body,
the deploy guard's message and the `CLAUDE.md` block say exactly that.

## 11. Open questions (recommendation + cost)

- **OQ-1 — Plugin (A) or user-scope (C), now that C is costed (§3.2).** *Recommend: A*, as you decided — on D1
  alone; C wins D2 and D3 and ties on enforcement. Cost of A: subdirectory sessions have no infra-kit tools
  (visible, not silent); a one-time prefix rename in 9 repos plus a legacy constant until the last PR. Cost of
  switching to C: none of this plan's §5 steps 2/4/5 beyond nine one-line key deletions; the tools are in every
  session on the machine (not yet measured — §12 S1-2, five minutes, run if you lean to C), nothing in a repo
  declares them, and the plugin stays "skills only". No answer needed unless you want C.
- **OQ-2 — Publish step 0 as CLI 0.7.2 before the 0.8.0 PR, or fold it in.** *Recommend: 0.7.2 first* — one
  extra lockstep publish (≈ minutes), and 0.8.0 then arrives on every typing machine automatically rather than one
  throttle window later. Second reason (PM-9): the one-branch gate that keeps a plugin advance from outrunning a
  CLI that cannot self-update belongs in the first CLI whose child advances the plugin at all — that is 0.7.2.

## 12. S1 measurements

Measured (orchestrator, 2026-09-14, `scratchpad/s1/measurements.md`) — facts, cited as such above:

| ID | Question | Result |
| --- | --- | --- |
| S1-1 | Does a session launched from `repo/sub` load the ROOT `CLAUDE.md`? | **GREEN** — `claude -p` from `travelist-monorepo/apps` reports the root `CLAUDE.md` ticket prefixes verbatim. The A-1 line reaches subdirectory sessions. |
| S1-5 | Does a `.mcp.json`-spawned server see `CLAUDE_PLUGIN_ROOT`? | **ABSENT** (`null`) for the project-key echo server; set to the plugin dir for every plugin-spawned one. `infra-kit mcp` can tell its route at boot (§3.3). |
| S1-6 | Do the repo's `.claude/settings.json` hooks fire from a subdirectory? | **RED** — from `travelist-monorepo/apps` a raw `git worktree add` ran with no PreToolUse hook; from the root the bash-guard refused it. The deploy guard is in the same file. |

Designed, not yet run:

| ID | Question | How | Pass |
| --- | --- | --- | --- |
| S1-0 | Does `claude plugin validate --strict` accept `type` and `cwd` in a plugin `.mcp.json`? (Acceptance by the validator does NOT prove `${CLAUDE_PROJECT_DIR}` expands in `cwd` — that evidence is F4, measured on 2.1.270; S1-0 gates only the file shape.) | `claude plugin validate ./plugins/infra-kit --strict --json` on the branch | exit 0; else drop the field |
| S1-2 | Context cost of the 26 infra-kit tools at user scope in a NON-family directory (C's every-session cost). **Take it now** — C is a real runner-up and OQ-1 deserves a number, and it is five minutes: | `mkdir -p /tmp/s1-2 && cd /tmp/s1-2 && git init -q`; baseline `env -u CLAUDECODE claude -p --output-format json <<< 'Reply OK'` → record `usage.input_tokens` (+ cache fields); then `claude mcp add --scope user infra-kit -- infra-kit mcp`, repeat the same prompt, record again, and a third run asking "list every tool whose name starts with mcp__infra-kit__" to confirm the 26 are present; finally `claude mcp remove infra-kit --scope user` and re-run the baseline to confirm it returns. Delta = C's per-session cost on that machine; note whether the tool list was deferred (tools listed but schemas not in the count). | a number in §3.2's "New cost" cell; no gate |
| S1-3 | `claude mcp add --scope user` formatting of `~/.claude.json`; user+project same key → one process? | diff before/after; `claude mcp list` + `-p` tool listing | recorded; only if C |
| S1-4 | AC-3/3b/4 on the published 0.8.0 plugin — the proof of PM-4's equality (`repoRoot === projectDir` in a worktree) | §7 E2E recipe | **Local pre-publish run, 2026-09-14, branch build (dist/cli.js via a PATH shim), this checkout's plugin installed at project scope from a throwaway local marketplace (`infra-kit@e2e`, symlinked source), scratch git repo, `claude -p` with CLAUDECODE unset, prompt on stdin, `--dangerously-skip-permissions`.** E2E-1 root, no `.mcp.json`: 24 tools `mcp__plugin_infra-kit_infra-kit__*`, `version` → `launch: "plugin"`, `repoRoot` = `mainRepoRoot` = `projectDir` = `cwd` = the scratch repo, `toolPrefix` = the plugin prefix; served `infra-kit://workflow/setup` body: plugin-prefix hits > 0, legacy hits 0; no `mcp__infra-kit__*` tools. E2E-2 root WITH a scratch `.mcp.json` `infra-kit` key (approved via `enabledMcpjsonServers`): tools are `mcp__infra-kit__*` ONLY (F2 shadow, 0 plugin-prefix tools), `version.launch: "legacy"`, served body legacy-only (plugin hits 0). E2E-3 subdirectory, no `.mcp.json`: NO tools of either prefix, resource unavailable (documented behaviour, F5). Worktree row and the PUBLISHED-plugin re-run remain for AC-9 after step 3. Throwaway plugin + marketplace removed afterwards; real records unchanged (0.7.0 ×3). |

## 13. Review dispositions

### rev 1 → rev 2 (Architect; S1-1/S1-5/S1-6 measured by the orchestrator)

| # | Issue | Disposition | Where |
| --- | --- | --- | --- |
| 1 | Served bodies named one prefix regardless of route; the F2 shadow left a session reading tool names it lacked | Prefix is launch-aware: `resolveLaunch(env)` on `CLAUDE_PLUGIN_ROOT` (S1-5), `toolName(name, launch)`, `renderForLaunch` = one `replaceAll` of `MCP_TOOL_PREFIX` → `LEGACY_MCP_TOOL_PREFIX` on the canonical-spelling Markdown (no template token — prettier; bare-name wrapper stated and rejected). PM-5 struck; `stale` → pass + advisory; consumer PRs lose all time pressure; commands name both prefixes; AC-2's grep allows the single legacy definition. **Ranking A/C unchanged; margin narrower (A's cost fell, C's advantage did not).** | §0, §3.2 D2 row, §3.3, §4 PM-5, §5 steps 1–3/12, §7, §8 AC-2/7, §9 |
| 2 | "Inert vs capable-and-unguarded" tie-breaker inverted the enforcement picture (A removes the sanctioned path, keeps the raw one) | Struck. A wins on D1 alone; A and C equal on enforcement, both leave a subdirectory session unguarded — now measured (S1-6). Raw-dispatch gap recorded as §9 follow-up (5) and in §10. | §1 P2, §3.2, §9, §10 |
| 3 | A's startup signal covers only never-installed | Stated in D1 and in the D1 row of the steelman table: installed-but-stale is silent under A and C alike. | §2 D1, §3.2 |
| 4 | P6 must allow two spellings during the migration | "One spelling PER prefix": `LEGACY_MCP_TOOL_PREFIX` under the same single-definition rule; doctor texts and AC-2 both hold. | §1 P6, §5 step 1 |
| 5 | `MCP server key` advisory lacked the "how to work today" line | Added: "until the PR merges, sessions here serve `mcp__infra-kit__*` and every body they read already names that prefix — nothing to fix on this machine". | §3.3 rows table, §7, AC-7 |
| 6 | `claude mcp list` "connected" is not evidence under F2 | Step 3's evidence is `doctor` `plugin MCP server` pass only; live-tool evidence exists only after step 4 merges. AC-9 split into (a) pre-merge doctor and (b) post-merge live. | §0, §5 steps 3–4, AC-9 |
| 7 | Served-copy source | Stated: the record's `installPath` (F8), reversing rev 5.1's clone-first default; step 0c's advisory reads the same pair the same way (`doctor.ts:1023-1029`). Test: a clone ahead of the record must not change the verdict. | §3.3 row 1, §7, AC-8 |
| 8 | `looksLikeInfraKitServer` substring test misreads `ik-mcp --name infra-kit-x` as `wrong-key` | Tightened to `command === 'infra-kit' && args[0] === 'mcp'`; positive/negative table in `install-state.test.ts`; AC-7 asserts a `grafana` sibling never yields `wrong-key`. | §5 step 2.4, §7, AC-7 |
| 9 | AC-3b could pass for the wrong reason (stray user-scope registration) | Recipe asks for every `mcp__` tool; 3b asserts no `mcp__plugin_*` AND no `mcp__infra-kit__*`; precondition `claude mcp list --scope user` empty of `infra-kit`. | §7 E2E, AC-3b |
| 10 | S1-1/S1-5/S1-6 are now facts; PM-4 stays S1-4-dependent; S1-2 should be a number | §12 split into measured / designed; PM-4 says "expected, proven only by S1-4"; S1-2 designed as a five-minute `claude -p` token-usage delta with a user-scope registration in a non-family dir, to be taken before OQ-1 is answered. | §4 PM-4, §12 |
| — | New doctor row plumbing | `report.ts:99-102` 6 → 7 names; `claude-plugin-checks.test.ts:394` `slice(-6)` → `-7`; `report.test.ts:79-84` via `DOCTOR_CHECK_NAMES` — kept as citations. | §3.3, §7 |

### Changes in rev 2

- §0: launch-aware prefix bullet; subdirectory bullet rewritten on S1-6; doctor bullet (`stale` = advisory, served copy = record `installPath`); order bullet (evidence per step); raw-dispatch finding.
- §1: P2 no longer claims the migration makes any path safer; P5 adds "how to keep working"; P6 = one spelling per prefix.
- §2: D1 qualified (startup line covers never-installed only).
- §3.2: "what is lost" rewritten on S1-6 with the sanctioned-vs-raw distinction; A row cites S1-1 green; steelman table — D1, D2, enforcement and cost rows rewritten; verdict rewritten (A on D1 alone; edit 1 narrows the margin, ranking unchanged).
- §3.3: new opening block (launch-aware prefix, rendering, rejected alternatives, consequences); `stale` decision flipped to pass + advisory; rows table (served-copy source, advisory text with the "work today" line, `MCP_NON_FAILING` + `stale`); `setup` outcome `ok` + info.
- §3.4: no deadline on consumer PRs.
- §4: PM-2 cites S1-6/S1-1; PM-3 covers both prefixes; PM-4 `launch`/`toolPrefix`, S1-4-dependent; PM-5 rewritten as residual only.
- §5: steps 2.1–2.3 (constants, `server.ts` launch, `workflow-bodies.ts` rendering, canonical spelling in the `.md`); step 2.4 tightens `looksLikeInfraKitServer`; step 2.7 `launch`/`toolPrefix`; step 12 both prefixes; step 13 `version.launch`; step 14 README sentence; step 3 evidence corrected; step 4 header and AC-9 hand-off.
- §7: U15 scope, commands regex both prefixes, cross-unit test cases (`resolveLaunch`, `renderForLaunch`, negative grep), doubled `server.test.ts` cases, `wrong-key` negative for `ik-mcp`, doctor cases (installPath, advisory text), `version` and `init` tests, E2E recipe (list all `mcp__` tools; 3b double negative; user-scope precondition).
- §8: AC-2, AC-3, AC-3b, AC-4, AC-6, AC-7, AC-8, AC-9 rewritten.
- §9: decision/drivers/alternatives/why/consequences/follow-ups rewritten; follow-up (5) raw-dispatch gap.
- §10: measured facts, the gap finding, the launch-aware prefix and the corrected evidence order, in plain English.
- §11 OQ-1: recommendation rests on D1 alone; S1-2's number beside it.
- §12: measured vs designed; S1-2 measurement designed.
- §6 rollback row 2/3: "prefix constants back" (two constants now).

### rev 2 → rev 2.1 (Architect rev-2 pass: mechanism sound, four fixes)

| # | Issue | Disposition | Where |
| --- | --- | --- | --- |
| 1 | Launch env read at module scope would freeze the render at first import; the doubled `server.test.ts` cases would false-green | `resolveLaunch(process.env)` inside `createMcpServer()` (`server.ts:9`), passed to `registerResources`; the `:91` read callback renders `WORKFLOW_BODIES[key]` per build; `WORKFLOW_BODIES` (`workflow-bodies.ts:37-40`) unchanged; build-twice-per-connection harmless (pure render). New **AC-2b**: two builds in one process with the var toggled → different bodies. | §3.3, §5 step 2.2, §7, AC-2b |
| 2 | `generated-instruction-spelling.test.ts:54` documents the old identity form; `replaceAll` soundness unstated | Regex flips to the canonical spelling; soundness argued (prefix cannot nest, prettier leaves plain literals, `trimEnd` at `:38-40` unaffected, `resource-bundle.test.ts:52,73` sentinels are not prefix strings). | §7 |
| 3 | Not-ours launch cases unstated | Three sentences: user-scope `infra-kit` key → legacy → correct; another key (`ik`) → bodies wrong by design, `wrong-key` row the only signal; renamed/forked plugin → pinned by the cross-unit test, cannot ship. | §3.3 |
| 4 | OQ-1 implied S1-2 had been taken | "not yet measured — §12 S1-2 (five minutes, run if you lean to C)". | §11 OQ-1 |

### Changes in rev 2.1

- §3.3: launch resolved inside `createMcpServer()`, rationale (module-scope = false green of the dist-digest kind), not-ours launch cases.
- §5 step 2.2: exact call sites (`server.ts:9`, `resources/index.ts:91`, `WORKFLOW_BODIES` untouched).
- §7: AC-2b build-twice test; spelling test regex flip; `replaceAll` soundness.
- §8: AC-2b.
- §11 OQ-1: S1-2 wording.

### rev 2.1 → rev 3 (Critic verdict: ITERATE — one blocking, five non-blocking; load-bearing code claims verified)

| # | Issue | Disposition | Where |
| --- | --- | --- | --- |
| B1 | **CLI behind the plugin.** Step 0's child advances the plugin on every run, `cannot-self-spawn` included (`run-update-check.ts:183-186, :271`), so a Homebrew/unknown-location machine reaches plugin 0.8.0 on CLI 0.7.x; after that repo's consumer PR merges, the plugin spawns a CLI without `renderForLaunch` (bodies name `mcp__infra-kit__*`, no `launch`, 0.7.x `doctor` fails "run setup", 0.7.x `setup` re-adds the key to a tracked file). §0/§9 claimed "never reads a tool name it lacks" unqualified. | **PM-9 added** with detection (CLI manual-update notice; 0.8.0 doctor SKILL rule "no `launch` ⇒ CLI < 0.8.0, never `setup` from an old CLI in a migrated repo"; commands name both prefixes) and mitigation **(c) both**: (b) a one-branch gate in the child (`cannot-self-spawn` / `install-stale` → `plugin: 'skipped-cli-stale'`) and in `setup` 0b (update-cache read), shipped as a step-0 amendment in 0.7.2 — the first CLI with a plugin step — so no automatic path creates the state; (a) PR body + SKILL rule cover the hand-typed `claude plugin update`. Cost to Homebrew users stated (skills wait for the CLI update they are shown every command). §0/§3.3/§9 qualified "on a CLI ≥ 0.8.0". OQ-2 gains its second reason. | §0, §3.3, §4 PM-9, §5 step 1 (amendment) + step 5 body + step 13, §6, §7 (gate tests), §9, §10, §11 OQ-2 |
| NB-1 | Subdirectory advisory claimed to know the launch dir | Two tests stated: `CLAUDE_PROJECT_DIR ≠ getProjectRoot()` is the precise one (MCP-served doctor has the var); the typed CLI compares only its own cwd and says "if Claude Code was launched from `<cwd>`…". | §3.3 rows table |
| NB-2 | `registerResources` is not the function | `initializeResources(server, launch)` (`server.ts:36`) everywhere. | §3.3, §5 step 2.2, §13 |
| NB-3 | AC-2's grep scope vs this repo's own `.claude/hooks` between steps 2 and 4 | Scope note beside AC-2: the hooks keep the legacy literal until step 4 by design; they are AC-5's. | §8 AC-2 |
| NB-4 | CLI-only rollback with consumers merged | Stated unsupported in §6 (restored writer re-adds keys — PM-9's tail on every machine); if unavoidable, revert the writer half LAST. | §6 |
| NB-5 | S1-0 acceptance ≠ `${CLAUDE_PROJECT_DIR}` expansion | Noted beside S1-0: expansion evidence is F4 (2.1.270); S1-0 gates the file shape only. | §12 S1-0 |

### Changes in rev 3

- §0: launch-aware bullet qualified "on a CLI ≥ 0.8.0"; order bullet names the PM-9 gate in 0.7.2.
- §3.3: qualification + PM-9 pointer; `initializeResources`; subdirectory advisory reworded with its two tests.
- §4: PM-9 (detection + chosen mitigation (c), costed).
- §5: step 1 amendment (two one-branch gates, tests, why 0.7.2); step 5 PR body; step 13 SKILL rule.
- §6: row 1 note; CLI-only rollback with merged consumers declared unsupported, ordering rule.
- §7: gate tests for the child and `setup`.
- §8 AC-2: scope note.
- §9: "Why" qualified; consequences name the Homebrew-user cost.
- §10: the PM-9 paragraph in plain English.
- §11 OQ-2: second reason.
- §12 S1-0: F4 citation.

### rev 3 → rev 3.1 (Architect rev-3 pass: the PM-9 outcome enumeration was incomplete)

| # | Issue | Disposition | Where |
| --- | --- | --- | --- |
| 1 | Two-outcome list missed `install-failed` (`:324`), `parent-unknown` (`:276`), `parent-still-running` (`:297`); `fetch-failed` ungateable; `already-running` never reaches the wrapper | Replaced everywhere by the predicate the cache encodes: skip when `written.last.latestVersion !== null && isNewerVersion(latestVersion, currentVersion)`; `installed` clears it (`:338`), `up-to-date` writes non-newer (`:253`) → plugin step still runs, AC-0 semantics hold; `fetch-failed` advances as today. Same predicate in 0b. Tests assert the predicate via a synthetic outcome. | §4 PM-9, §5 step 1, §7 |
| 2 | Where the cache read lives | `init.ts` (commands → lib); `install-plugin.ts` → `update-check` would cycle through `update-plugin.ts:24` → `plugin-pointer/install-state`. Cost: `readUpdateCache` + `isNewerVersion`. | §4 PM-9, §5 step 1 |
| 3 | Stale-cache false skip | Bounded and stated: the skip needs `latestVersion > packageJson.version`, so a hand-updated CLI is never skipped; a manager change after a stale stamp skips 0b once, the next child installs and advances — one throttle window. | §4 PM-9, §7 |
| 4 | Opt-out machines (`guards.ts:9`) never write a cache → 0b would advance blind | 0b does one bounded `fetchLatestVersion` (`registry.ts:61`) when the cache is absent and applies the same predicate; fetch failure → update (unknowable). Test added. | §4 PM-9, §5 step 1, §7 |

### Changes in rev 3.1

- §4 PM-9, §5 step 1, §7: outcome list → cache predicate; `init.ts` placement and the cycle reason; stale-cache bound; no-cache fetch in 0b with its tests.

### rev 3.1 → rev 3.2 (Critic: APPROVE on 3.1; two residual wording fixes)

| # | Issue | Disposition | Where |
| --- | --- | --- | --- |
| 1 | "no automatic path ever produces plugin ≥ 0.8.0 on a CLI < 0.8.0" overstated: in the merge → publish window the marketplace is at 0.8.0 while the registry's latest is 0.7.2, the predicate is false, and a `cannot-self-spawn` machine can enter the PM-9 state automatically | Reworded: the window is named as the one automatic path; harmless until that repo's consumer PR; manual rails (a) are the real bound; publish right after merge keeps it to minutes. Added to PM-9's detection/mitigation text. | §5 step 1, §4 PM-9 |
| 2 | Rollback row 1 "never writes anything" — the gate writes the cache outcome | "never writes `.mcp.json`; it does stamp `plugin: 'skipped-cli-stale'` into the update cache, overwritten by the next run". | §6 |

### Changes in rev 3.2

- §5 step 1 and §4 PM-9: the merge → publish window named as the one automatic path into the PM-9 state, with its bound.
- §6 row 1: precise statement of what the gate writes.
