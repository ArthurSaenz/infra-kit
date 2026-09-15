> Archived 2026-09-15 — the infra-kit MCP server is being retired; see .omc/plans/mcp-to-cli-skills-migration.md.

# [DO] Deliver the infra-kit MCP server through the Claude Code plugin

Status: approved 2026-09-14 ("do it") — spike S0 run, step 0 implemented on branch `do/mcp-via-plugin-step0`;
**§8.2 does NOT proceed: Gate G is red on S0-2 (a project-scope plugin is not loaded from a subdirectory; see §6.1)** —
the T1 decision is back with the user. T2-a closed as done.
Revision: 5.1 (rev 1 reviewed by Architect + Critic; rev 2, rev 3 and rev 4 re-reviewed by Architect; rev 3.1 and rev 4.1 reviewed by Critic; dispositions in §14)
Date: 2026-09-14
Mode: ralplan (deliberate) — Planner draft
Fact sheet: `scratchpad/facts.md` (every measurement cited below as F-n comes from it; anything not
measured is labelled **S0-n** = to measure in the spike before the shape is committed)
Reverses: `.omc/plans/infra-kit-claude-plugin.md` §5 **D4-i** (plugin ships no `mcpServers`)

## 0. TL;DR

- **T1 — chosen: T1-i, on two conditions.** The plugin ships a root `.mcp.json` registering one stdio
  server, key `infra-kit`, `command: "infra-kit"`, `args: ["mcp"]`, `cwd: "${CLAUDE_PROJECT_DIR}"`.
  The consumer `.mcp.json` entry is retired repo by repo by humans, never auto-deleted. Tool prefix
  becomes `mcp__plugin_infra-kit_infra-kit__<tool>` (F-20.2, S0-4).
  - **Condition 1 — a delivery mechanism ships first (§8 step 0).** Measured on the author's own
    machine: the plugin channel is NOT delivering — every install record and the marketplace clone
    sit at plugin 0.3.0 while `main` is at 0.7.0, four releases missed in four days of sessions
    (§3(e)). Today `.mcp.json` via `git pull` is the FASTER channel. T1-i therefore only wins if the
    CLI's existing silent self-update child also runs `claude plugin update infra-kit@infra-kit` on
    EVERY run past its throttle (not only when the CLI itself has a newer version), and `setup`
    updates an already-installed plugin. **That child is triggered by a user-typed `infra-kit …`
    command on a TTY** (`entry/cli.ts:112`, 20-min throttle) — never by shell start, never by the
    MCP server process, never by Claude Code use. The server BINARY is already bound to that same
    channel, so T1-i adds no new staleness surface in steady state; but a Claude-Code-only teammate
    advances neither channel, and §7 PM-1b names what they see. Step 0 is a prerequisite with its
    own AC (AC-0), not a contingency.
  - **Condition 2 — worktrees load the plugin (S0-6(a)).** Project-scope install records are keyed by
    exact path (`install-state.ts:141-146`); whether Claude Code loads the plugin in a linked worktree
    is unmeasured. Red → the recommended worktree shape is `claude mcp add --scope local` from
    `worktrees add` (§4.1), and the plan returns to the user.
  - Both conditions, and the rest of the spike, are one gate: **Gate G** (AC-1, §11). §8.2 begins
    only when G is satisfied; anything else returns to the user with the branch named in that row.
- **Release order is what merging does:** step 0 shipped and observed → merge (plugin 0.8.0 live,
  because the marketplace IS this git repo) → registry publish of CLI 0.8.0 → consumer PRs, with this
  repo's own key removal as the FIRST consumer PR. Two windows without a server exist (§7 PM-1a/1b);
  the detector is a `doctor` row whose CAPABILITY verdict is "does the served plugin copy carry the
  `infra-kit` server" (never a CLI-vs-plugin version comparison) plus, only where S0-7(b) shows the
  session loads from a copy other than the marketplace clone, an advisory "fetched but not applied"
  line comparing served copy vs clone.
- **T2 — chosen: T2-a (status quo, close as done).** The grafana proxy's parameters ALREADY live in
  root `infra-kit.json` (`mcp.grafana`); the `.mcp.json` argv is a derived, drift-guarded artifact
  (F-12). **The generated line in travelist/hulyo `.mcp.json` stays** — build output, not a
  hand-maintained pass-through — and §5 says why shrinking it (T2-b) is not worth a second config
  reader. Moving the proxy into the plugin is rejected on a platform fact (F-20.7) and on cost.

## 1. Principles

- **P1 — One source of truth is a git path.** The server binary is the global CLI; the plugin holds a
  pointer to it, exactly the pointer `.mcp.json` held (plugin plan Q1/Q2). No second CLI copy (D4-iii
  stays rejected; memory: silent self-update makes two copies strictly worse than one).
- **P2 — Enforcement unconditional, capability opt-in (Q5, restated for tools).** The deploy GUARD is
  the `.claude/hooks/block-deploy.mjs` hook in each consumer repo and stays there. Losing the MCP
  server loses the sanctioned *capability* to deploy, never the *prohibition*; the guard fails closed.
- **P3 — Never delete what a human may have typed.** `.mcp.json` is hand-maintained and holds other
  people's servers (`mcp-registration.ts` header). Retirement of the `infra-kit` key is reported and a
  command is offered; no writer in the CLI removes it (confirm-gated `doctor --fix`: §13 Q1).
- **P4 — Every claim about the platform is measured, not read.** Undocumented behaviours this plan
  depends on are gated behind spike S0 with pass/fail criteria. Auto-update latency ("≤10 min",
  plugin plan D6-b) is **unmeasured** (F-20.9) and, on this machine, **contradicted** (§3(e)); it is
  never load-bearing here.
- **P5 — A delivery channel must be at least as fresh as the one it replaces.** `.mcp.json` is
  delivered by `git pull`; the plugin route may not be slower than that in practice, or the
  migration is a regression however clean the design. This is the principle §3(e) enforces.
- **P6 — A detector that is red at every release is a detector nobody reads.** The one row that
  guards PM-1b must be green in the ordinary state — including the ordinary window between a
  lockstep commit and the separate plugin-bump commit — and red only when the plugin genuinely
  cannot serve. This is why the capability verdict is a file check, not a version comparison (§8.2
  step 7) — and why **no CLI-version-vs-plugin-version comparison exists anywhere in the row or in
  Gate G**: the two numbers legitimately drift around every release, so any such comparison is
  spurious on the very release that ships it (Critic r4 blocking 1).
- **P7 — Reversible in one commit per repo (P7 of the plugin plan).** Plugin 0.8.1 without the
  `.mcp.json` file, `git revert` of each per-repo removal commit, CLI prefix constant flipped back.

## 2. Decision drivers (top 3)

1. **Install-scope reality changed.** D4 was decided when the plugin install defaulted to `user`
   scope. It is now `--scope project` and `enabledPlugins["infra-kit@infra-kit"]: true` is COMMITTED in
   every family repo (F-9). The plugin is a repo-declared dependency with a loud "not installed"
   signal at startup (F-20.3).
2. **"Zero setup" was never true — but "setup once" is not enough either.** `.mcp.json`
   `command: "infra-kit"` requires the global CLI (F-10). Both routes need `infra-kit setup` once.
   However `installPluginForProject` returns `already-installed` WITHOUT updating when a record
   exists (`install-plugin.ts:159`), so a machine on plugin 0.3.0 that runs `setup` stays on 0.3.0.
   Step 0 makes `setup` update an already-installed plugin; until it ships, every message in this
   plan says "`setup`, then `claude plugin update infra-kit@infra-kit`".
3. **One registration surface, not two.** The family carries 9 copies of the same three-field entry
   (measured: bridge, GLV-Backend, hulyo, infra-kit, nomadream, nomadream-ota-n-level, sandbox,
   starter, travelist) plus a writer, a reader, doctor rows and a skill paragraph whose only job is to
   keep the key spelled `infra-kit`. The plugin can carry that once — IF its channel delivers (P5).

## 3. D4 premises — what still holds, what is invalidated, what is open

| D4 premise | Verdict | Evidence |
| --- | --- | --- |
| (a) A teammate without `claude plugin install` loses the server incl. gated deploy tools; `.mcp.json` gives every cloner those tools with zero setup | **Invalidated in its strong form, holds in a narrow form.** Zero setup is false: the server needs the global CLI (F-10). Residual population: "has the global CLI, never ran `setup` since the plugin era" — sees Claude Code's own "plugin not installed" line at startup (F-20.3) and `doctor` `plugin installed` fail. | F-9, F-10, F-20.3, doctor.ts:1029-1057 |
| (b) Prefix becomes `mcp__plugin_infra-kit_infra-kit__<tool>` requiring edits in `block-deploy.mjs:100-101`, `bash-guard.mjs:165-168`, PR3 bodies | **Holds, but cheaper than recorded.** No hook *matcher* in the family names an `mcp__` tool; the prefix appears only in advisory text and tests. `bash-guard.mjs` no longer contains it. Runtime blast radius here: 17 files with the literal (grep, `docs/`+`.omc/` excluded) + `doctor.ts:1109-1114` (template) + `skills/doctor/SKILL.md:69,86` (prose); 3 files per consumer (§8). | F-16, grep 2026-09-14 |
| (c) `/plugin disable` becomes a way to lose deploy tooling with no signal | **Holds as a capability loss, not an enforcement loss.** The guard hook is repo-local and unconditional (P2). Accepted. | P2, block-deploy.mjs:93-108 |
| (d) **Worktrees.** Project-scope install records are keyed by exact `projectPath` (`coversProject`, `install-state.ts:141-146`); `~/.claude/plugins/installed_plugins.json` holds records for infra-kit, travelist-monorepo, hulyo-monorepo — none for any worktree path. `installPluginForProject` has one caller (`init.ts:741`); `worktrees add` (`commands/worktrees-add/worktrees-add.ts:330`) never calls it. travelist has main + 6 REGISTERED worktrees (`release/return-different-destination`, `ux-improvements`, `v1.51.0`, `v1.58.0`, `v1.69.0`, `vike-to-tanstack-start`); **all 6 carry both `.mcp.json` and `.claude/settings.json` with `enabledPlugins`** (measured 2026-09-14). Two unregistered leftover directories (`v1.84.0`, `flexible-dates`) sit beside them — ENOTEMPTY-race residue (memory), not worktrees; S0-6(a) runs in a registered one. | **OPEN — S0-6(a) decides.** If Claude Code loads a project-scope plugin in a linked worktree of the recorded project, T1-i holds. If it matches by exact path like the CLI does, worktree sessions lose the server → §4.1 (recommended: `--scope local` registration from `worktrees add`). | install-state.ts:141-146; `git worktree list` (travelist) |
| (e) **Delivery channel freshness.** On the author's machine (2026-09-14): all three `scope: project` records are `version: 0.3.0`, `installPath cache/infra-kit/infra-kit/0.3.0`, `lastUpdated` 2026-09-09/10; the marketplace clone `~/.claude/plugins/marketplaces/infra-kit` is at 1e9dcc4 (2026-09-10), plugin.json 0.3.0; the cache holds 0.1.0 and 0.3.0 only; `main` plugin.json is 0.7.0. **Four plugin releases in four days of daily sessions reached nobody.** The README's "auto-update within ten minutes" is false in practice here. `.mcp.json`, delivered by `git pull`, is live on the next session. | **A first-class premise for the status quo, and the strongest one.** T1-i moves the server from the faster channel to a channel that is measurably not moving. It survives ONLY with §8 step 0: the CLI's silent self-update child runs `claude plugin update` on every throttled run, and `setup` updates an installed plugin. Without step 0 shipped and observed (AC-0), **D4-i wins** and this plan stops at T2-a. | `installed_plugins.json`, `known_marketplaces.json`, marketplace clone, cache dir (orchestrator-verified) |
| Q3 "nothing in the plugin depends on a path outside the plugin" | **Amended, not violated anew.** `.mcp.json` already depended on PATH. Q3 is rewritten in the README as "the plugin may hold the one pointer `.mcp.json` held: the global CLI on PATH". | F-37 |
| Q4 "plugin versioned; CLI not versioned by it" | **A new coupling appears and is tested.** The prefix's halves are owned by plugin.json `name` and the plugin `.mcp.json` key; the CLI spells it. §10 adds a cross-unit test deriving the expected prefix from those files on disk; the live doctor row checks the served copy (§8.2 step 7). | Architect r1 1b |
| P7 "never adopt an irreversible mechanism" | **Satisfied.** Reversal per P7 (§1). | — |

**Re-argument of T1-i against the status quo with (e) on the table.** D4-i's original grounds (a)-(c)
are weakened as above; (e) is new and, unlike them, is not a design argument but a measurement of
the channel. The status quo wins outright if the plugin channel cannot be made as fresh as git. It
can be made as fresh as the CLI channel: the CLI already has an accepted, rail-guarded silent
self-update child (`lib/update-check/auto-update.ts:47-53` spawns `run-update-check.ts` detached;
single-flight lock `:162`; cwd pinned to `$HOME`; memory "silent auto-update risk accepted"). Adding
one `claude plugin update infra-kit@infra-kit` spawn to that child, run after the locked check on
every outcome (§8.0 0a), makes the plugin channel exactly as fresh as the CLI channel — **which advances only on
a user-typed `infra-kit …` command on a TTY, past a 20-minute throttle, and never from Claude Code
use** (`entry/cli.ts:112`; `guards.ts:74-79` skips `own-command` incl. `mcp`, `--json`, `not-a-tty`,
`local-install`; `update-cache.ts:33`). That is the channel the SERVER binary already depends on, so
in steady state — the pointer changes rarely, the binary is already CLI-bound — T1-i adds no
staleness surface that does not already exist. The one population it does not reach, a teammate who
touches infra-kit only through Claude Code, is not reached by the CLI channel today either; §7 PM-1b
names what they see. Under that condition T1-i still wins on drivers 1 and 3. Without it, it loses
on P5, and honestly so.

What would have to be true for D4-i to win — each is a named red branch of **Gate G** (AC-1):
(1) step 0 cannot be made to work (S0-7(a)/(c) red: `claude plugin update` needs a TTY, the served
copy does not advance, or the detached child cannot run it); (2) S0-6(a) red AND the §4.1 shapes
judged worse than today; (3) S0-3 destructive same-key collision. (1) is the most likely of the
three and is measured first. Note that install-record advancement alone cannot flip the decision:
S0-7(a) passes on the served copy advancing, and the records only shape where the doctor row reads.

## 4. Options — T1

### T1-i — Plugin ships `.mcp.json` pointing at the global CLI; consumer entry retired. **CHOSEN (conditions: step 0 + S0-6(a); Gate G).**

```json
// plugins/infra-kit/.mcp.json
{ "mcpServers": { "infra-kit": { "type": "stdio", "command": "infra-kit", "args": ["mcp"],
                                 "cwd": "${CLAUDE_PROJECT_DIR}" } } }
```

Pros: one registration per machine, versioned with the plugin (D6-b), removed from 9 repo files; the
writer/reader pair in `plugin-pointer/` shrinks to a stale-detector; `doctor` gains one honest row.
Cons: prefix rename (bounded, §8.3); the narrow population in §3(a); the worktree question (§3(d));
the delivery prerequisite (§3(e), step 0); platform facts to measure (S0). `cwd` is set explicitly
because the default is undocumented (F-20.6) — the CLI resolves the repo via `git rev-parse` from
cwd, so the server MUST run in the project the session opened, worktrees included.

#### 4.1 If S0-6(a) is red — worktree shapes, costed; `--scope local` recommended

- **(wt-1) `worktrees add` writes an `.mcp.json` `infra-kit` entry into the new checkout.** Cost: the
  writer half of `mcp-registration.ts` survives with one caller (`worktrees-add.ts`); two verdict sets
  in the doctor row; both prefixes permanent → served bodies must name tools prefix-agnostically
  (spelling-test regex rewrite). **Plus the dirty-tree cost:** the written file is modified (branch has
  one) or untracked (branch has none); `remove-worktrees.ts:240` runs `git worktree remove` BARE,
  which refuses a tree with modified or untracked files, so every `worktrees remove` would fail or
  need `--force` (memory: the ENOTEMPTY race already bites there); release worktrees are also where
  the dirty-tree deploy refusal runs. Rejected on that cost.
- **(wt-2) `worktrees add` runs `installPluginForProject({ projectRoot: <worktree> })`.** One install
  record per worktree, never pruned; `worktrees remove` would need a matching `claude plugin
  uninstall --scope project` and the record survives an ENOTEMPTY removal. Rejected.
- **(wt-3) `worktrees add` runs `claude mcp add infra-kit --scope local -- infra-kit mcp` with
  `cwd: <worktree>`; `worktrees remove` runs `claude mcp remove infra-kit --scope local`.
  RECOMMENDED if needed.** Nothing enters the checkout (no dirty tree), branch-independent, removable.
  Because `--scope local` resolves the project by cwd, the remove runs BEFORE `git worktree remove`
  (`remove-worktrees.ts:240`) with `cwd: <worktree>`; if that ordering is ever missed — the
  ENOTEMPTY race that leaves unregistered directories behind is the known way — the leftover entry
  in the local store is accepted as harmless (it names a path Claude Code will not open as a
  project). Where local-scope servers are stored (Architect: `~/.claude.json` keyed by project path)
  and whether they need per-server approval are **to measure in S0-9** (only if S0-6(a) is red).
  Cost: two spawns (`claude` binary required — already true for `setup`), the old prefix
  `mcp__infra-kit__` stays live in worktree sessions → served bodies prefix-agnostic (same
  spelling-regex cost as wt-1, without the dirty tree). Still a plan revision that returns to the user.

### T1-ii — Keep D4-i. REJECTED — conditionally.

Wins if step 0 cannot ship (§3 re-argument). Otherwise its remaining virtue — the prefix everyone
has typed — is a one-time sweep with tests that pin the new spelling.

### T1-iii — Plugin ships the server AND `setup` keeps writing `.mcp.json` as a fallback. REJECTED.

Permanent double registration: two `infra-kit mcp` processes per session, two tool sets, and the
confirm-token round-trip split across two processes if the agent alternates prefixes — the HMAC key
is per-process random (`lib/tool-handler/confirm-token.ts:116`). Fails P1 for no capability the
plugin-only route lacks (P7). The transient version is tolerated during migration (§7 PM-2). wt-3 is
NOT this option: it registers only where the plugin cannot reach.

## 5. Options — T2

**Plain statement first:** T2's stated want is already met, with one honest caveat. `mcp.grafana` in
root `infra-kit.json` (tracked, travelist + hulyo) is the ONLY hand-edited spec; `.mcp.json`'s
grafana argv is produced by `deriveMcpEntry` (`src/lib/mcp-proxy/derive.ts:21-27`), written by
`reconcileMcpProxies` (`plugin-pointer/mcp-proxy-registration.ts`) from `ik setup` (init.ts:848)
and `ik audit --root --fix`, and `ik audit` reports drift (F-12). **The line in `.mcp.json` does not
go away under T2-a.** It stays, byte-identical, because Claude Code reads `.mcp.json` and nothing
else for a project server; what went away is the *hand maintenance* of that line.

### T2-a — Status quo; close as done with a clarification. **CHOSEN.**

Changes: (1) `plugins/infra-kit/README.md` paragraph "ik-mcp proxies are configured in
`infra-kit.json`, the `.mcp.json` lines are derived — edit the config, run `ik audit --root --fix`";
(2) the `drifted` message in `mcp-proxy-registration.ts:125` names the source file. ≈ 20 lines.

### T2-b — Slim the derived entry to `ik-mcp --name grafana`; proxy reads `<cwd>/infra-kit.json` via the zod-only `@slip-stream-kit/config` schema. REJECTED (costed).

The proxy plan's rejected **option C** revisited. Of C's two defects: **(ii) is fixed** — `loadLayer`
refuses `mcp` outside layer 1 since a0dfc17 (F-13). **(i) remains** — `getInfraKitConfigPaths`
resolves `<git rev-parse --show-toplevel>/infra-kit.json`; a shim reading `<cwd>/infra-kit.json`
disagrees whenever the session's project dir is not the toplevel, and a walk-up is still not the
loader. Cost: zod enters the 8.5 KB zero-dep shim (bundle delta unmeasured — S0-8 only if revived), a
config read enters a long-lived process, and the entry shrinks from ~12 argv tokens to 2 but does not
vanish. Not worth a second config reader.

### T2-c — Plugin ships one aggregating `ik-mcp` server multiplexing every `mcp.*` upstream. REJECTED (costed).

A real MCP multiplexer (merged `tools/list` with namespacing, resources/prompts/notifications
passthrough, per-upstream lifecycle, error isolation) plus a config read (proxy-plan Q1 A/B's zx
problem returns). 400-800 LOC + tests; runs in the 5 repos with no `mcp` block as a zero-tool server;
loses per-server approval and `/mcp` visibility. Revisit at ≥3 proxies per repo.

### T2-d — Plugin ships a fixed `grafana` server. REJECTED.

Static per plugin version; no per-project conditional (F-20.7). 5/7 repos would spawn a degraded
zero-tool server every session; credentials differ per repo.

## 6. Spike S0 — measure BEFORE committing to the shape

Setup: a scratch repo, plus a **throwaway plugin** (temporary edit of `plugins/infra-kit/.mcp.json`
on a local branch, marketplace pointed at the local checkout) whose server is a 5-line node script
answering `initialize`/`tools/list` and reporting `process.cwd()` and
`process.env.CLAUDE_PROJECT_DIR` in one tool result. **Approval first:** project-scope plugin servers
go through per-server approval (F-20.4) and `claude -p` never shows the dialog, so every measurement
is run interactively once to approve, then repeated with `claude -p '…' --output-format json`.
Record results in §6.1 before §8 starts.

| ID | Question | Pass criterion | If fail | Blocking |
| --- | --- | --- | --- | --- |
| S0-7 | **Delivery.** (a) Run `claude plugin update infra-kit@infra-kit` by hand on this machine (records at 0.3.0, main at 0.7.0), from `$HOME` AND from a recorded project dir (does a project-scope record require `cwd` = the recorded project, as `install` does at `install-plugin.ts:169`? — NB-6): do the marketplace clone and the cache advance to 0.7.0? do the three project-scope records? Does it need a TTY? Wall time recorded. (b) Which path does a session actually load the plugin from — the cache `installPath` or the marketplace clone? (compare a file edited in one but not the other) (c) Does the command work from a detached child with cwd `$HOME`, `stdio: 'ignore'` and a stripped `npm_*` env (the rails of `run-update-check.ts:259-264`)? | **(a) = the marketplace clone (or cache) advances non-interactively from `$HOME` in < 60 s AND (b) shows the session loads the advanced copy**; (c) works. Install-record advancement and the cwd requirement are *informational* — they decide where the doctor row reads and whether 0a must iterate recorded projects (§8.0), and can NOT on their own turn this row red | (a)/(b)/(c) red → step 0 is impossible → **D4-i wins; plan stops at T2-a** | **yes, first** |
| S0-6 | **Worktree plugin loading.** Plugin installed at project scope for the MAIN path only. (a) Launch `claude` in the REGISTERED worktree `travelist-monorepo-worktrees/release/v1.69.0` (has both files): plugin skills AND server present? (b) *Informational, synthetic:* a scratch worktree on a branch with `.claude/settings.json` and `.mcp.json` deleted — expected absent by construction (no `enabledPlugins`), and such a checkout has no server today either, so it is not a regression. | (a) both present | (a) red → §4.1 wt-3 and the plan returns to the user | yes — (a) only |
| S0-1 | Bare `command` in a plugin `.mcp.json` resolves via the launching shell's PATH? (echo server as `command: "ik-echo"` symlinked into a PATH dir) | Connects | `command: "sh"`, `args: ["-lc", "exec infra-kit mcp"]` | yes |
| S0-2 | cwd of the plugin server with and without `cwd: "${CLAUDE_PROJECT_DIR}"`, launched from the repo root, a subdirectory, and a linked worktree. | Echo reports the launch project root in all three; worktree reports the worktree path | `${CLAUDE_PROJECT_DIR}` unexpanded → S0-2b: pass as `env`, `chdir` in the `mcp` entry | yes |
| S0-3 | Project `.mcp.json` AND plugin register key `infra-kit`. Both connect? which prefix lists first? does `/mcp` show two `infra-kit` rows? | Two servers, two prefixes, both answer | One wins silently → consumer PR must precede plugin per repo; T1 reverts to D4-i where that cannot be sequenced | yes |
| S0-4 | Exact prefix string; is per-server approval keyed by server NAME (rename re-prompts once)? | Prefix = `mcp__plugin_infra-kit_infra-kit__` (F-20.2); keying recorded | Use the measured string; PR body says "approve once" | yes (string) |
| S0-5 | `claude mcp remove infra-kit --scope project` edits `.mcp.json` leaving siblings + indentation intact? | Yes | Doctor offers a hand edit | no |
| S0-9 | *(only if S0-6(a) red)* Where does `claude mcp add --scope local` store the server; does it need approval; does `--scope local` resolve per worktree path? | Recorded | Falls back to wt-1 with its dirty-tree cost stated to the user | conditional |

S0-7, S0-6(a), S0-1..S0-4 are blocking, in that order; S0-5 shapes a message; S0-9 is conditional.

### 6.1 Results — measured 2026-09-14 (Claude Code 2.1.270, `~/.local/bin/claude`; raw logs in the session scratchpad `s0/`)

Method notes. Nested `claude -p` works from inside a Claude Code session once `CLAUDECODE` is unset
from the env; `--allowedTools` is variadic and swallows a trailing prompt (pass the prompt on stdin);
project-scope plugin servers connected with NO approval prompt at all, while project `.mcp.json`
servers stayed "Pending approval" in `claude mcp list` yet loaded in a `-p` session once
`.claude/settings.local.json` carried `enabledMcpjsonServers`. The throwaway plugin (`infra-kit@spike`,
a 5-line echo server `ik-echo` reporting `cwd`/`CLAUDE_PROJECT_DIR`/`CLAUDE_PLUGIN_ROOT`/argv) was
installed at project scope in a scratch git repo and uninstalled afterwards; no record of it remains.

| ID | Result | Verdict |
| --- | --- | --- |
| S0-7(a) | `claude plugin update infra-kit@infra-kit` with NO scope flag resolves **user** scope from every cwd (`$HOME` and a recorded project dir alike) and fails: "Plugin infra-kit is not installed at scope user" (exit 1, 1–5 s) — but even that failing run refreshed the marketplace clone (1e9dcc4/0.3.0 → 1c36ec8/0.7.0) as a side effect. With `--scope project -y --json` (the `-y` is required when stdin/stdout is not a TTY): exit 0 in ≈1 s, cache gained `0.7.0/`, and the record advanced — **for the project resolved from cwd when cwd is a recorded project** (travelist from travelist, hulyo from hulyo). From `$HOME` or any non-project dir with `--scope project`, Claude Code silently picked ANOTHER recorded project (infra-kit) — so a single run from `$HOME` updates one record, not all. Idempotent: a second run reports `up_to_date`. All three records are now at 0.7.0 (`lastUpdated` 2026-09-14T15:59–16:00Z). | **pass** — with two hard requirements for step 0: `--scope project -y`, and **iterate the recorded projects with `cwd: <recorded projectPath>`** (NB-6 confirmed: cwd decides the record) |
| S0-7(b) | Marker planted in the body of `skills/update-toolchain/SKILL.md` in the cache copy (`THIS-IS-THE-CACHE-COPY`) and a different one in the marketplace clone; a session in this repo invoked the skill and returned **`THIS-IS-THE-CACHE-COPY`**. Both copies restored; clone `git status` clean. | **sessions load from the record's cache `installPath`, not the clone** → the doctor row reads the record's `installPath`; the clone-vs-served advisory in 0c IS needed; AC-0 measures the cache copy |
| S0-7(c) | `spawnSync('claude', ['plugin','update','infra-kit@infra-kit','--scope','project','-y','--json'], { cwd: <recorded projectPath>, stdio: 'ignore', env: without npm_* and CLAUDECODE, timeout })` — exit 0 in 674/690/692 ms for the three recorded projects; a vanished path gives `error.code === 'ENOENT'` in 0 ms (must be skipped, never fatal). | **pass** |
| S0-6(a) | `claude -p` in the registered worktree `travelist-monorepo-worktrees/release/v1.69.0` (record exists for the MAIN path only): all nine plugin skills present (`infra-kit:release-create, session, comment-verifier, doctor, e2e-architect, fe-architect, fe-patterns, full-cycle, update-toolchain` — the 0.7.0 set), `pwd` = the worktree. | **pass** — a worktree that carries the committed `.claude/settings.json` loads the plugin without its own record; §4.1 wt-* fallbacks are not needed |
| S0-1 | Plugin `.mcp.json` `command: "ik-echo"` (bare, resolved from `~/.local/bin` on PATH): `plugin:infra-kit:echo-nocwd … ✔ Connected`. | **pass** — bare `command: "infra-kit"` will resolve like the consumer `.mcp.json` does today |
| S0-2 | From the repo ROOT: every plugin server reports `cwd` = the project dir **with or without** `cwd: "${CLAUDE_PROJECT_DIR}"`, `CLAUDE_PROJECT_DIR` = the project dir, `CLAUDE_PLUGIN_ROOT` = the plugin dir. From a SUBDIRECTORY (`repo/sub`): **the plugin is not loaded at all — zero `mcp__plugin_*` tools — while the project `.mcp.json` server IS loaded** (its `cwd` and `CLAUDE_PROJECT_DIR` are the subdirectory). Reproduced in the real travelist repo from `apps/`: `.mcp.json` gives all 26 `mcp__infra-kit__*` tools, plugin skills `NONE`. Mechanism pinned by one more probe: copying `.claude/settings.json` into `repo/sub/.claude/` makes the plugin load from the subdirectory — **Claude Code reads project settings (and therefore `enabledPlugins`) from `<cwd>/.claude/settings.json` only, no walk-up, whereas `.mcp.json` is found from a subdirectory.** Worktree cwd was not measured with the echo server (the repo's bash-guard refuses raw `git worktree add`, and the plan says ask rather than bypass); S0-6(a) already shows a worktree session has `pwd` = the worktree and loads the plugin, so `cwd: "${CLAUDE_PROJECT_DIR}"` there is the worktree. | **RED for the subdirectory case, and it is not the failure the row anticipated**: not "wrong cwd" but "no server". A session started in `apps/` (or any subdirectory) keeps every infra-kit tool today and would have NONE under T1-i. The row's named fallback (S0-2b, `${CLAUDE_PROJECT_DIR}` unexpanded) does not apply. **Gate G: returns to the user** (AC-1). Corollary, out of scope but recorded: the same rule means the repo's `.claude/settings.json` hooks — the deploy guard included — do not load from a subdirectory either. |
| S0-3 | Project `.mcp.json` key `infra-kit` AND plugin key `infra-kit` registered together: the session lists `mcp__infra-kit__whoami` + the plugin's OTHER servers, and **`mcp__plugin_infra-kit_infra-kit__whoami` is absent**; remove the project key and it appears. `claude mcp list` shows both rows (`plugin:infra-kit:infra-kit` and `infra-kit`) as connected, which is misleading — only the project one is exposed to the session. | **the project entry shadows the plugin server of the same key, silently** (docs precedence: project > plugin). Not destructive, so T1 does not revert to D4-i; but there is NO dual-registration state (PM-2 as written cannot happen), and the prefix flips at the moment the consumer key is removed — the consumer PR is the switch |
| S0-4 | Exact prefix observed: **`mcp__plugin_infra-kit_infra-kit__<tool>`** (hyphens preserved). Approval: plugin servers needed none; the project `.mcp.json` entry needed `enabledMcpjsonServers` (per server name). | pass |
| S0-5 | `claude mcp remove infra-kit --scope project` removed only that key, but **rewrote the file with 2-space indentation (input had 4) and dropped the trailing newline**. | siblings intact, formatting NOT preserved → doctor offers the CLI's own sibling-preserving writer or a hand edit, not `claude mcp remove` |
| S0-9 | not run (S0-6(a) green). | n/a |

**Gate G status (AC-1):** S0-7 pass · S0-6(a) pass · S0-1 pass · S0-3 pass (shadowing, non-destructive) · S0-4 pass · S0-5 answered · **S0-2 RED (subdirectory launch loses the plugin and with it the server)** → §8.2 does NOT begin; the decision returns to the user. Step 0 (the delivery mechanism) is independent of Gate G and was carried out: the plugin channel was demonstrably stale for every skill regardless of where the MCP server lives.

**What a red S0-2 leaves on the table (for the user, not decided here):**
1. Keep D4-i (server stays in consumer `.mcp.json`); step 0 still ships so the skills stay fresh. Zero regression, T1 closed as "not now".
2. T1-i anyway, accepting that a session launched from a subdirectory has no infra-kit tools (and no plugin skills — already true today) — documented as "launch Claude Code at the repo root", enforced by nothing.
3. Both channels permanently: plugin ships the server AND `.mcp.json` keeps the key — S0-3 shows the project key wins wherever both exist, so this is not dual registration but "plugin as fallback for the root-launch case only", which buys nothing over D4-i.
4. User-scope install of the plugin (loads from any cwd) — rejected by D6 for its skill/context cost in every repo; unchanged.

## 7. Pre-mortem

| # | Scenario | Detection | Mitigation |
| --- | --- | --- | --- |
| PM-0 | **Step 0 ships but the child never runs on a given machine.** The child runs only from a user-typed `infra-kit …` command on a TTY (`entry/cli.ts:112`), past the 20-min throttle, and not for `mcp`/`--json`/non-TTY/local-install (`guards.ts:74-79`), nor with `INFRA_KIT_NO_AUTO_UPDATE`. A machine where nobody types `infra-kit` never advances the plugin — exactly as it never advances the CLI today. Also: `claude` binary absent → the plugin spawn is skipped. | Before 0.8.0: nothing in `doctor` can tell (freshness against `main` is unknowable offline — AC-0 measures it by hand against `origin/main`); the update cache's `plugin:` outcome is absent/`claude-missing`. After 0.8.0: the `plugin version` capability fail (§8.2 step 7 (ii)) — via a typed `infra-kit doctor` OR via the old `/infra-kit:doctor` skill (PM-1b). | `setup` updates an installed plugin (step 0b) as the manual path; AC-0 requires observing an automatic advance on the author's machine before the release merge. |
| PM-1a | **Canary window.** After the release commit merges (plugin 0.8.0 live), sessions in this repo keep serving through `.mcp.json` until the plugin advances + relaunch; if this repo's key-removal PR merges before that, sessions here have NO server. | `doctor` `plugin version` capability fail; no `infra-kit` tools in the session; the deploy guard's deny text names `setup` and `claude plugin update`. | The key removal is a separate PR merged only after the maintainer has observed plugin 0.8.0 loaded in a live session. |
| PM-1b | **Consumer window.** A consumer PR merges; a teammate's plugin is <0.8.0 (child not yet run, or never relaunched) — no `.mcp.json` key, a plugin that cannot serve. Or: not installed at all. **Sub-population — the Claude-Code-only teammate** who never types `infra-kit` on a TTY: neither channel advances for them and Claude Code prints NOTHING for installed-but-old. What the cached 0.3.0 actually carries (measured): ONE command, `commands/release-create.md`, which names `mcp__infra-kit__release-create` at :8 and will fail once the key is removed; and the `doctor` SKILL (`skills/doctor/SKILL.md:4`, `allowed-tools: Bash(infra-kit doctor)` + the session probe), which names NO MCP tool and keeps working — it runs whatever `infra-kit doctor` is on PATH, i.e. the NEW CLI. | Not installed: Claude Code's startup line (F-20.3) + `doctor` `plugin installed` fail. Installed but old: **primary detector, reachable from a Claude-only session — `/infra-kit:doctor` (the OLD skill) runs the NEW CLI's `doctor`, whose `plugin version` capability row fails** reading the served copy (marketplace clone by default, `~/.claude/plugins/marketplaces/infra-kit/plugins/infra-kit/.claude-plugin/plugin.json` + `.mcp.json`; install record as fallback — S0-7(b) confirms which path a session loads from and the row follows it) and names `claude plugin update infra-kit@infra-kit`. Two caveats on that detector: **it detects but never triggers** — `Bash(infra-kit doctor)` from a Claude session is non-TTY, so `guards.ts:74-79` returns `not-a-tty` and the self-update child does not spawn; the fix still has to be typed in a terminal. And **the CLI row text is the authority, not the old skill's prose** — cached 0.3.0's `SKILL.md:70,86` still says "the key must be `infra-kit` in `.mcp.json`", which contradicts the new row; a session reading both may report the contradiction, and the row's message (self-sufficient, names the command) wins. Secondary signals: (2) the deploy guard's deny text (hook, repo-local, unconditional — first line "no infra-kit tools in this session? …", §8.4); (3) the old `/infra-kit:release-create` body's tool call resolving nothing, which the model reports. The 0.8.0 command bodies name `claude plugin update`, but 0.8.0 is the version they do not have; the surfaces that reach them are the old doctor skill (via the new CLI) and the consumer repo's guard text + PR body. | Consumer PR body + guard deny text name both commands (`infra-kit setup`, `claude plugin update infra-kit@infra-kit`) and say "run `/infra-kit:doctor`"; the guard is the one surface every Claude session in that repo loads regardless of plugin version. GLV-Backend / nomadream-ota-n-level: §13 Q2. |
| PM-2 | **Dual registration.** Plugin 0.8.0 live while a consumer `.mcp.json` still has the key → two `infra-kit mcp` processes; an agent alternating prefixes across the two-call confirm protocol gets `confirmation_refused` (per-process key, `confirm-token.ts:116`); the rename itself is harmless (bare tool name bound). Between merge and CLI publish, served bodies name the OLD prefix, which resolves through `.mcp.json`. | `doctor` `MCP server key`: `pass` + ".mcp.json duplicates the plugin server — remove: `claude mcp remove …`"; `setup` and `ik audit --root` echo it. | Bounded by human-merged consumer PRs (§13 Q1 offers a confirm-gated `doctor --fix`). Out-of-family repos that run `setup` enter the same reported state. S0-3 proves it is not destructive. |
| PM-3 | Plugin server spawned with the wrong cwd → `git rev-parse` resolves no repo or the MAIN repo in a worktree session. | S0-2 before shipping. Runtime: `version` tool gains `cwd` and `repoRoot` (§8.2 step 8); doctor SKILL Step 3 compares with `pwd`. | Explicit `cwd`; S0-2b fallback. Detection only, no boot-time behaviour change. |
| PM-4 | A body outside the measured set still names `mcp__infra-kit__*`. | Negative tests in §10 (plugins/, CLI `src/`+`resources/`, consumer hooks); family-wide grep in every consumer PR checklist. | One sweep commit per repo, grep output in the PR body. |
| PM-5 | `/plugin disable infra-kit` — no deploy tools. | Guard unchanged: agent cannot deploy (P2); `doctor` `plugin installed`. | Accepted; README documents fail-closed. |

## 8. Step list (ordered; paths under `/Users/arthur/projects/infra-kit` unless a consumer is named)

### 8.0 Step 0 — the delivery mechanism (prerequisite; own PR, own AC-0; ships and is OBSERVED before §8.2)

`[DO] update-check: keep the Claude Code plugin as fresh as the CLI`

- **0a** `apps/infra-kit/cli/src/lib/update-check/run-update-check.ts` — the plugin update runs on
  **every child run past the throttle, AFTER `runUpdateCheckLocked` has returned, whatever its
  outcome**, as a wrapper in `runUpdateCheck` (`:156-166`):
  `try { outcome = await runUpdateCheckLocked(…); await updatePlugin(deps); return outcome } finally { release() }`.
  It is NOT inserted into `runUpdateCheckLocked`'s early-return chain (`fetch-failed` `:202`,
  `up-to-date` `:204`, `cannot-self-spawn` `:222`, `parent-unknown` `:227`, `parent-still-running`
  `:248`) and NOT placed ahead of the fetch. **Why the wrapper and not "before the early returns":**
  `lastCheckMs` is stamped only by `finish()` after the fetch, and the lock is reaped as stale at
  `LOCK_STALE_MS` = 30 min (`lock.ts:27-35`); a `claude` probe (`CLAUDE_TIMEOUT_MS` = 120 s,
  `install-plugin.ts:41`) plus an update AHEAD of the fetch would delay the throttle stamp on every
  run and eat into the stale window on a slow link. After the locked function returns, the stamp is
  written, the lock is still held (single-flight), and the plugin step runs on EVERY outcome —
  `up-to-date` included, which is what makes a plugin-only bump deliverable. **Budget: probe + update
  ≤ 5 min** (bounded timeouts; well inside the 30-min stale window even after a slow CLI install).
  Gated only by the lock and the `claude` probe (reuse `CLAUDE_VERSION_ARGV`, `install-plugin.ts:161`);
  `canSelfSpawn` is an npm-location question and is NOT consulted; no `waitForParentExit` (it
  replaces nothing under `dist/`). Spawn `claude plugin update infra-kit@infra-kit`,
  `withoutPackageManagerEnv`, `stdio: 'ignore'`, bounded timeout. **cwd:** `install` needed
  `cwd: projectRoot` for scope resolution (`install-plugin.ts:169`); an `update` from `$HOME` with no
  scope flag may resolve USER scope and touch no project-scope record — S0-7(a) measures both
  cwds. If a per-project run is required, iterate the recorded projects from
  `installed_plugins.json` with `cwd: <recorded projectPath>`, and **skip (never fail on) a recorded
  path that no longer exists** (records are append-only stale — memory "registry stores no paths").
  Records its own outcome and stamp in the update cache (`plugin: 'updated' | 'failed' |
  'claude-missing' | 'skipped'`) beside the CLI outcome, so the parent can print "plugin update
  pending — run: claude plugin update infra-kit@infra-kit" the way it prints the manual CLI line.
  **`updatePlugin` never throws:** its whole body is wrapped; any exception (spawn error, timeout,
  cache write failure) is recorded as `plugin: 'failed'` and the wrapper's `return outcome` still
  returns the locked function's outcome unchanged — a plugin failure is recorded, never propagated.
  **Static imports only:** on the `installed` path the wrapper runs AFTER `npm install -g` has
  replaced `dist/`, and the parent-wait comment (`run-update-check.ts` ≈:227) exists because a lazy
  `import()` of a `chunk-*.js` from the replaced dist is unsafe — so `updatePlugin` and everything
  it calls is imported statically at module load, and it adds no new heavy import to the child
  (it needs `node:child_process` + the existing cache writer, both already loaded).
  **Live-session race, named:** on every path the plugin update runs while Claude Code sessions may
  be open. A cache update is safe — cache dirs are version-keyed (`cache/infra-kit/infra-kit/<v>/`),
  so an open session keeps reading its own version dir. A marketplace-clone `git pull` CAN swap a
  `SKILL.md` between a session listing it and invoking it — benign (the body changes, the file
  stays) and no different from `git pull` in a consumer repo today. S0-7(b) decides which of the two
  a session actually loads from, and therefore which of the two races applies.
  Consequence of this placement: a plugin-only bump (no CLI release) IS delivered on the next
  throttled child run, and a plugin bump pushed after a CLI publish (today's pattern: 1c36ec8 after
  4312c49) is delivered without waiting for the next CLI release.
- **0b** `apps/infra-kit/cli/src/lib/plugin-pointer/install-plugin.ts:159` — when `already-installed`,
  run `claude plugin update infra-kit@infra-kit` (new outcome `updated` / `update-failed`) with the
  same cwd rule S0-7(a) establishes (NB-6); `init.ts` `installEntries` prints it. Idempotent:
  "already at the latest version" is `updated`.
- **0c** `doctor` `plugin version` row (shipped here, live from this patch): **capability is a file
  check, never a version comparison** — `<served>/.mcp.json` present with a server key that, with
  plugin.json `name`, composes `MCP_TOOL_PREFIX` ⇒ "can serve the MCP server" (§8.2 step 7 (ii)). A
  version-lag comparison is unsound: plugin.json sat at 0.3.0 while the CLI shipped 0.5.5/0.5.6, and
  at 0.4.0 against CLI 0.7.0 for 2.5 h today (the plugin bump is a separate manual commit after the
  lockstep commit); a row red for most of a week, and at every release, is one nobody reads (P6).
  **No CLI-vs-plugin freshness comparison survives, even as an advisory** — step 0 itself ships as
  a CLI patch with no plugin change, so the served plugin (0.7.0) would be "behind" the CLI the
  moment the patch self-installs, and any such line would print on the very release that ships it
  (Critic r4 blocking 1). The only freshness comparison the row may make is **served copy vs
  marketplace clone** — `clone.version > served.version` ⇒ advisory "plugin <clone.v> is fetched
  but not applied — run: `claude plugin update infra-kit@infra-kit`" — and it exists only if S0-7(b)
  shows the session loads from a copy OTHER than the clone (cache `installPath`); if the session
  loads from the clone there is nothing to compare and the line is dropped entirely. Freshness
  against `main` is unknowable offline and is not the row's job; AC-0 measures it directly. Before
  0.8.0 exists the file check reads "absent" on every machine — so until §8.2 ships, 0c prints
  nothing but the existing version text (plus the clone-vs-served advisory if it exists) and the
  capability verdict is not evaluated (it is switched on by the CLI that knows the prefix, 0.8.0).
- Cost: ~1 spawn + ~60 lines in the child, ~30 in `install-plugin.ts`, tests for both, one CLI patch
  release. Risk: S0-7(a) record/cwd semantics as above.
- **The trigger, stated plainly:** the child is spawned by `maybeAutoUpdate` at `entry/cli.ts:112`
  when a user types an `infra-kit …` command on a TTY and 20 minutes have passed since the last
  check (`update-cache.ts:33`); NOT by shell start (the rc block's `_infra_kit_autoload` /
  `_infra_kit_poll_autoload`, `init.ts:950-995`, only `zstat`+`source` cache files under
  `~/.cache/infra-kit/<session>/`), NOT by the MCP server process (`own-command`), NOT by
  `claude`. Every sentence in this plan that says "ordinary CLI use" means that.
- **AC-0**: on the author's machine, after one user-typed TTY `infra-kit` command past the throttle
  window and one Claude Code relaunch, **the served plugin copy's `plugin.json` version (the path
  S0-7(b) says a session loads from) equals `main`'s `plugins/infra-kit/.claude-plugin/plugin.json`
  version at the time of the check** — the direct, marketplace-delivered fact and NOTHING else: no
  `doctor` verdict, no CLI-version comparison, no advisory line enters AC-0 (the row's capability
  check does not exist before 0.8.0, and a version comparison would fail spuriously on the patch
  that ships step 0). NO manual `claude plugin` command run. Observed over ≥2 plugin releases before §8.2
  merges — **a plugin-only bump (README or skill change, plugin.json version bumped) counts as a
  release for AC-0** (reachable under 0a's placement; the alignment question is §13 Q4), so the
  prerequisite never blocks on unrelated CLI work.

### 8.1 S0 spike (no commits) — §6, S0-7 first, then S0-6(a). Proceed to §8.2 only through Gate G (AC-1).

### 8.2 CLI changes — one PR, `[DO] mcp: serve through the plugin; retire the .mcp.json writer`

1. `apps/infra-kit/cli/src/mcp/tool-prefix.ts` (new): `MCP_TOOL_PREFIX = 'mcp__plugin_infra-kit_infra-kit__'`
   (S0-4 string) + `toolName(name)`. Single source; every other `src/` speller (incl. `doctor.ts`
   `MCP_MESSAGES`) routes through it; §10's negative test greps `src/` and `resources/`.
2. `apps/infra-kit/cli/src/mcp/resources/index.ts:149,160` — descriptions via `toolName(...)`.
3. `apps/infra-kit/cli/resources/workflow/{setup,session,release-create}.md` — literal sweep
   (setup.md:3,122; session.md:4,59,61,86; release-create.md:3). `?raw` Markdown; prettier owns the
   bytes.
4. `apps/infra-kit/cli/src/lib/plugin-pointer/mcp-registration.ts` → **`mcp-registration-stale.ts`,
   `inspectLegacyMcpRegistration`**. Writes NOTHING in any branch (P3). Verdicts: `absent` (the ONE
   healthy name), `stale`, `misfiled`, `missing-file`, `unparseable`. `SERVER_COMMAND`/
   `buildServerEntry` survive as the "ours" predicate. Header rewritten.
5. `apps/infra-kit/cli/src/lib/plugin-pointer/install-state.ts:191-245` — `McpRegistration` gains
   `{ kind: 'stale' }`; `inspectMcpRegistration` returns `stale` where it returned `ok`; comment at
   :213 rewritten.
6. `apps/infra-kit/cli/src/commands/init/init.ts:721-742` — no MCP write; call
   `inspectLegacyMcpRegistration(root)` AFTER the install (comment block :721-728 deleted). `stale` →
   `warned`: "`.mcp.json` still registers `infra-kit`; the plugin now serves it — remove the key:
   `claude mcp remove infra-kit --scope project`" (S0-5).
7. `apps/infra-kit/cli/src/commands/doctor/doctor.ts:1012-1024, 1108-1150` —
   - `claudePluginVersionCheck`: reads the SERVED copy — marketplace clone by default, install
     record as fallback (S0-7(b) may swap that order). **One capability failure, one advisory:**
     **(ii) capability** — `<served>/.mcp.json` absent, or its server key + plugin.json `name` do not
     compose `MCP_TOOL_PREFIX` → **fail** "Plugin <v> does not carry the `infra-kit` MCP server —
     update it: `claude plugin update infra-kit@infra-kit`; if it is already 0.8.0 or newer the
     install is corrupt or renamed — reinstall: `claude plugin uninstall infra-kit@infra-kit &&
     claude plugin install infra-kit@infra-kit --scope project`" (the two remedies are distinguished
     in the message by the served version, without any literal floor in code — the file check IS the
     floor). (ii) is T4(b) re-pointed — the LIVE half of the prefix guard — folded into the existing
     row so `report.ts:101` `SECTION_MEMBERS` needs no edit. **(i) advisory — served copy vs
     marketplace clone ONLY, never vs the CLI:** if S0-7(b) shows the session loads from the cache
     `installPath` (not the clone), then `clone.version > served.version` → appended line "plugin
     <clone.v> is fetched but not applied — run: `claude plugin update infra-kit@infra-kit`" on a
     row that stays `pass` when (ii) passes; if the session loads from the clone, (i) does not exist.
     `packageJson.version` is never read by this row. No `MIN_PLUGIN_VERSION` literal anywhere (P6;
     §10 negative test asserts neither a literal nor a `packageJson.version` read in the row).
     **Exit code unaffected:** exit 1 is scoped to `plugin installed` alone (doctor.ts
     `MCP_NON_FAILING` comment block); the new fail is report-only like today's version fail.
   - `MCP_MESSAGES` via `toolName()`: `absent` → pass "served by the plugin"; `stale` → **`pass` + loud
     message** with the remove command (`CheckResult.status` is `'pass' | 'fail'`, doctor.ts:116;
     precedent `missing-file`, :1109-1110); `missing-file` → pass; `wrong-key` → fail.
     `MCP_NON_FAILING` = `{absent, missing-file, stale}`. Row name unchanged.
   - Transition guard keys on **(ii)**: served copy carries no `.mcp.json` → `MCP server key` keeps
     TODAY's verdicts (the `.mcp.json` entry is still the live route) while `plugin version` fails
     (ii). Never keyed on a version number.
8. `apps/infra-kit/cli/src/mcp/server.ts` (`version` tool) — add `cwd` and `repoRoot` (PM-3). No
   boot-time change; `entry/mcp.ts:30` `process.exit(1)` on build failure stays.
9. Tests (§10). Bump CLI to **0.8.0**.

### 8.3 Plugin changes — same PR (CI enforces the version bump)

1. `plugins/infra-kit/.mcp.json` (new) — §4 T1-i entry.
2. `plugins/infra-kit/.claude-plugin/plugin.json` — `version: 0.8.0`; description drops "bundles no
   server"; no inline `mcpServers`.
3. `plugins/infra-kit/commands/release-create.md:8`, `session.md:8` — prefix sweep; each fallback
   clause also says "if the tool is missing, the plugin is older than 0.8.0: `claude plugin update
   infra-kit@infra-kit`" (reaches only machines already on 0.8.0 — PM-1b says why the consumer-side
   text is the one that matters).
4. `plugins/infra-kit/skills/doctor/SKILL.md:66-90` — Step 3/4 bullets rewritten (plugin carries the
   `infra-kit` server and it connected; leftover `.mcp.json` entry is a duplicate — offer the
   command, never run it; stale plugin → `claude plugin update`). **Explicitly in the sweep:** the
   two prose lines at `:70` ("the CLI says the server is registered correctly in `.mcp.json`") and
   `:86` ("the key must be `infra-kit`, because tool names are derived from it") contradict the new
   CLI row and are replaced; the skill body must never restate a verdict the CLI row already
   carries — it says "the CLI's row text is the authority".
5. `plugins/infra-kit/README.md:6-12` — ships ONE server pointing at the global CLI; why; Q3
   amendment; hooks still not shipped; **the "auto-update within ten minutes" sentence is replaced
   by "the CLI's self-update child (run from any typed `infra-kit` command on a TTY, at most every
   20 minutes) also updates the plugin; `claude plugin update infra-kit@infra-kit` is the manual
   path"**; T2-a paragraph; fail-closed direction.
6. `.claude-plugin/marketplace.json` — description/tags; no version (U8).

### 8.4 This repo as a consumer — SEPARATE, later PR (first consumer PR, §8.7 step 4)

- `.mcp.json` — remove the `infra-kit` key (keep `linear-server`).
- `.claude/hooks/block-deploy.mjs:100-101`, `.claude/hooks/README.md:68`,
  `.claude/hooks/__tests__/block-deploy.test.mjs:408` — prefix sweep; deny text gains a first line
  "no infra-kit tools in this session? in a terminal: `infra-kit setup` (updates the plugin), or
  `claude plugin update infra-kit@infra-kit`, then restart Claude Code" — **this hook is the one
  surface every Claude session in the repo loads regardless of plugin version** (PM-1b). `setup` in a
  worktree registers the worktree path (`install-plugin.ts:169`) — material only if S0-6(a) is red
  (§4.1).
- `docs/*.md`, `docs/reviews/*.md` (10 files, F-16) and `.omc/plans/*` are **NOT edited** (D4
  addendum: §13 Q3).

### 8.5 Consumer PRs — one per repo, after §8.7 step 4

Family: **travelist-monorepo, hulyo-monorepo, bridge-monorepo, nomadream-monorepo,
starter-workspace, sandbox-workspace** (+ this repo = 7). Each PR, `[DO] mcp: the plugin serves
infra-kit; drop the .mcp.json entry`:
1. `.mcp.json` — delete the `infra-kit` key only.
2. `.claude/hooks/{block-deploy.mjs,README.md,__tests__/block-deploy.test.mjs}` — prefix sweep + the
   §8.4 first line (starter: +2 in `CLAUDE.md`).
3. PR body: "requires infra-kit CLI ≥ 0.8.0 and plugin ≥ 0.8.0. The plugin updates itself the next
   time you type any `infra-kit` command in a terminal (at most every 20 minutes) — it does NOT
   update from Claude Code use alone. If you see no infra-kit tools: in a terminal run `infra-kit
   setup` (updates an installed plugin) or `claude plugin update infra-kit@infra-kit`, then restart
   Claude Code; approve the server once if prompted (S0-4)". Grep output pasted.
Out of family: **GLV-Backend, nomadream-ota-n-level** — §13 Q2 (cost: 2 PRs each).

### 8.6 The retired writer — "report + offer remove", nothing more

Reports `stale` from `setup`, `doctor`, `ik audit --root`; never deletes (P3). Offered command is
Claude Code's own (S0-5). Confirm-gated `doctor --fix` deletion: §13 Q1 (`report.ts:131` list exists).

### 8.7 Release order — mechanical, and why

0. **Step 0 ships as a CLI patch and is OBSERVED (AC-0)** — the plugin channel is proven to move on
   the author's machine over ≥2 plugin releases before anything depends on it.
1. **Merge the PR (§8.2 + §8.3).** The marketplace IS this git repo, so merging publishes plugin
   0.8.0; step 0's child delivers it to each family machine on that machine's next typed
   `infra-kit` command past the throttle, plus a Claude Code relaunch. Consumer `.mcp.json` still
   serves the old prefix: both prefixes exist on any machine that has updated; every named prefix
   resolves. Tag `infra-kit--v0.8.0`. (The plugin is briefly AHEAD of the published CLI here; nothing
   in the row compares the two, so nothing prints.)
2. **Registry-publish CLI 0.8.0** (config pkg first if touched — lockstep order). Global CLIs
   self-update on their next typed command; running server processes keep their bundle until
   relaunch. Served bodies now name the plugin prefix; the old one still resolves via `.mcp.json`.
3. **Wait one throttle window + observe** `doctor` `plugin version` pass (capability) on the author's
   machine and at least one teammate's who has typed an `infra-kit` command since.
4. **This repo's key removal** (§8.4) as the first consumer PR (closes PM-1a).
5. **Consumer PRs** (§8.5): travelist first (grafana sibling), hulyo, then the four others.
Why not "key removal in the release commit": it opens PM-1a with no delivery evidence. Why step 0
before everything: without it §8.7 step 1's "both prefixes exist" is exactly the sentence §3(e)
measured false.

## 9. ADR

- **Decision.** Ship `plugins/infra-kit/.mcp.json` registering stdio server `infra-kit` = global CLI
  `infra-kit mcp`, `cwd: ${CLAUDE_PROJECT_DIR}` — **after** the CLI's silent self-update child also
  keeps the plugin current on every throttled run (step 0, AC-0) and **if** S0-6(a) shows worktrees
  load the plugin (Gate G). Consumer entries retired by human PRs; the CLI reports leftovers and
  never deletes them. The `ik-mcp` proxy configuration stays where it is; the derived line remains.
- **Drivers.** §2; P5 (channel freshness) as the gate; P6 (a detector must be quiet when nothing is
  wrong) for the doctor row's shape.
- **Alternatives.** T1-ii status quo (rejected conditionally — wins if step 0 cannot ship), T1-iii
  permanent dual registration (rejected), worktree shapes wt-1/wt-2 (rejected on dirty-tree /
  unpruned records), wt-3 `--scope local` (held for S0-6(a) red), D4-iii plugin-carried CLI
  (rejected); T2-b/c/d (rejected, §5); a version-lag capability rule (rejected, P6, §8.0 0c).
- **Why chosen.** The plugin is the repo-declared unit the skills, commands and server ship in
  together; the CLI remains the one versioned binary; enforcement is untouched; and the plugin
  channel is made exactly as fresh as the CLI channel the server already depends on — a channel
  that advances on typed TTY commands only, which is already the binary's situation.
- **Consequences.** Tool prefix changes once; `doctor` gains `stale` and a file-check capability
  fail (plus a clone-vs-served "fetched but not applied" advisory only if S0-7(b) makes it
  meaningful); `setup` updates an installed plugin and stops writing the server
  entry; the self-update child spawns `claude` on every throttled run — one more thing it does
  silently (memory: silent auto-update accepted; the rails are reused, not widened); two windows
  without a server exist and are detected for typing users, and for Claude-only users the consumer
  repo's guard text is the signal; two repos outside the family await §13 Q2. Reversal per P7 (+ the
  child's plugin spawn behind the same `INFRA_KIT_NO_AUTO_UPDATE` kill switch as the CLI update).
- **Follow-ups.** (1) Keep the `stale` text after all consumer PRs land. (2) Revisit T2-c at ≥3
  proxies/repo. (3) §13 Q3. (4) If S0-7(a) shows `claude plugin update` refreshes marketplace/cache
  but not project-scope records, cost the per-record re-install in the child.

## 10. Test plan

**Unit (this repo)**
- Step 0: `lib/update-check/__tests__/run-update-check.test.ts` — the wrapper runs `updatePlugin`
  AFTER `runUpdateCheckLocked` returns, for EVERY outcome: `up-to-date`, `fetch-failed`,
  `cannot-self-spawn`, `parent-unknown`, `parent-still-running`, `installed`, `install-stale` — one
  case each asserting (a) the locked function's outcome is returned unchanged, (b) the plugin spawn
  happened, (c) `lastCheckMs` was stamped BEFORE the plugin spawn, (d) the lock was released after
  it (`finally`). `updatePlugin` throwing (spawn error / timeout / cache-write failure injected) →
  outcome still returned unchanged, `plugin: 'failed'` recorded, no rejection escapes `runUpdateCheck`.
  A static-analysis test asserts the child bundle has no dynamic `import()` reachable from
  `updatePlugin`. `already-running` (lock not acquired) → no plugin spawn. `claude` probe failing →
  skipped, records `claude-missing`. A recorded project path that no longer exists → `skipped`, no
  throw. Never waits for the parent. The CLI `install-stale` line still prints plus the plugin line.
  `lib/plugin-pointer/__tests__/install-plugin.test.ts` — `already-installed` path now runs the
  update argv (cwd per S0-7(a)) and reports `updated`/`update-failed`.
- `plugins/infra-kit/__tests__/manifest.test.mjs`: **U7** flips (no `hooks`/`commands`/inline
  `mcpServers`; `plugins/infra-kit/.mcp.json` exists with exactly one server `infra-kit`, `command:
  infra-kit`, `args: ['mcp']`, `cwd: ${CLAUDE_PROJECT_DIR}`). **U15**: no file under `plugins/`
  contains `mcp__infra-kit__` (T1's literals at :589/:723 move to the measured prefix).
- **Cross-unit** `apps/infra-kit/cli/src/mcp/__tests__/tool-prefix.test.ts`:
  `MCP_TOOL_PREFIX === \`mcp__plugin_${pluginJson.name}_${Object.keys(pluginMcpJson.mcpServers)[0]}__\``
  read from `plugins/infra-kit/` on disk.
- `server.test.ts:140,201,295-299`, `mcp-stdio.e2e.test.ts:330-331`,
  `agent-guidance/__tests__/{resource-bundle,generated-instruction-spelling}.test.ts` — via
  `MCP_TOOL_PREFIX`; negative: `src/` + `resources/` contain no `mcp__infra-kit__`.
- `lib/plugin-pointer/__tests__/mcp-registration-stale.test.ts` — every case proves NO write; new:
  `.mcp.json` with only `linear-server` → `absent`.
- `install-state.test.ts` — `stale`; `absent` healthy.
- `commands/doctor/__tests__/claude-plugin-checks.test.ts:206,215` — `stale` → `pass` + remove
  command; `plugin version` with the CLI version injected as `0.8.0` AND as `0.6.0` (both runs
  must produce identical rows — the CLI version is not an input): (ii) served copy with no
  `.mcp.json` → fail naming `claude plugin update`; (ii') served `0.8.0` with key `ik` (mismatch) →
  fail naming reinstall; served `0.8.0` correct → pass; served `0.7.0` WITH a correct `.mcp.json`
  (synthetic — proves the row is capability-keyed) → pass, no lag text; served `0.9.0` → pass; (i)
  only if S0-7(b) keeps it: served `0.7.0` correct + clone `0.8.0` → pass + "fetched but not
  applied"; clone == served → no line; served-copy precedence (clone vs record) per S0-7(b);
  transition guard keyed on (ii): served copy without `.mcp.json` → `MCP server key` old verdicts.
  Exit code: a fixture with only these rows failing exits 0. Negative tests: no `MIN_PLUGIN_VERSION`
  literal under `src/`, and `claudePluginVersionCheck` does not read `packageJson.version`.
- `.claude/hooks/__tests__/block-deploy.test.mjs:408` — new prefix + the terminal-command first line
  (§8.4 PR).

**Integration (local, measurable)**
- `mcp-stdio.e2e.test.ts`: spawn with `cwd` = a temp linked worktree; `version.repoRoot` = that
  worktree (PM-3).
- `claude plugin validate ./plugins/infra-kit --strict --json` (plugin-ci U1) validates `.mcp.json`.

**E2E (live `claude` only — not in CI)**
- S0-7, S0-6(a), S0-1..S0-5 (§6); re-run S0-1..S0-4 on the published plugin 0.8.0 for AC-3/AC-4 —
  interactive approval first, then `-p`. AC-0 is observed over real time, not simulated.

**Observability**
- `doctor`: `plugin version` (served copy; capability fail; clone-vs-served advisory if S0-7(b)
  keeps it), `MCP server key` (`stale`
  pass + loud); update-cache outcome for the plugin spawn; `ik audit --root` echoes `stale`;
  `version` tool exposes `cwd`/`repoRoot`.

## 11. Acceptance criteria

0. **AC-0 (step 0):** on the author's machine, after one user-typed TTY `infra-kit` command past the
   20-min throttle and a Claude Code relaunch, **the served plugin copy's `plugin.json` version
   equals `main`'s `plugins/infra-kit/.claude-plugin/plugin.json` version at the time of the check**
   (`git fetch origin main && diff <(jq -r .version <served>/.claude-plugin/plugin.json) <(git show FETCH_HEAD:plugins/infra-kit/.claude-plugin/plugin.json | jq -r .version)`),
   where **`<served>` = the load path recorded for S0-7(b) in §6.1 (the marketplace clone, or the
   record's `installPath`)** — exactly as §8.0 defines it. If (b) = record `installPath`, AC-0 is
   therefore measuring whether the RECORD advances; that is consistent with S0-7(a) marking record
   advancement informational, because S0-7 runs before step 0 exists and AC-0 is observed after it
   ships. No manual `claude plugin` command; no `doctor` verdict and no CLI-version comparison is
   part of this criterion; observed over ≥2 plugin releases, where a plugin-only bump counts as a
   release. Recorded in §6.1 with dates and the command that triggered each run.
1. **Gate G — §8.2 begins only when AC-0 = pass ∧ S0-7(a,b,c) = pass ∧ S0-6(a) = pass ∧ S0-3 = pass
   ∧ S0-1/2/4 = pass-or-named-fallback; any other outcome returns to the user with the branch named
   in that row.** All outcomes are recorded in §6.1 before any commit in §8.2.
2. `claude plugin validate ./plugins/infra-kit --strict` passes; plugin.json `version` = 0.8.0;
   `check-plugin-version-bump.mjs` green.
3. Scratch repo, plugin 0.8.0 at project scope, NO `.mcp.json`, server approved interactively:
   `claude -p` lists `mcp__plugin_infra-kit_infra-kit__*` and `…__version.repoRoot` = the repo.
4. Same repo from a registered linked worktree: skills present, `repoRoot` = the worktree path.
5. `grep -r mcp__infra-kit__ --exclude-dir=docs --exclude-dir=.omc --exclude-dir=node_modules` empty
   in this repo (after §8.4) and in each migrated consumer.
6. `infra-kit setup` in a repo whose `.mcp.json` has only `linear-server` leaves the file
   byte-identical and, with the plugin already installed, runs the update (reports `updated`).
7. `infra-kit doctor` with a leftover `infra-kit` key: `MCP server key: pass` + remove command; exit
   code unaffected; key removed: pass "served by the plugin".
8. `infra-kit doctor` `plugin version`: served copy without `.mcp.json` → fail naming `claude plugin
   update`; served 0.8.0 with a mismatched key → fail naming reinstall; served 0.8.0 correct → pass;
   served 0.7.0 with a correct `.mcp.json` (synthetic) → pass with no lag text; the rows are
   byte-identical whether the CLI is 0.6.0 or 0.8.0; if S0-7(b) keeps the clone-vs-served advisory:
   served 0.7.0 + clone 0.8.0 → pass + "fetched but not applied". Exit code 0 in all cases when
   `plugin installed` passes.
9. `pnpm run qa` green (gate on `echo EXIT=$?`); plugin-ci green; cross-unit prefix test green.
10. Consumer PRs (6) each show the 3-file sweep + 1-key deletion; travelist/hulyo keep the derived
    `grafana` entry byte-identical (by design, §5).
11. T2: README states proxy specs live in `infra-kit.json`, the argv is derived and stays; `ik audit
    --root` on travelist reports no drift.

## 12. What to tell the user

The MCP server can be delivered by the plugin, as asked — but one measurement on your own machine
changes the order of work. Your Claude Code has never picked up a plugin release: every install
record and the marketplace copy are at plugin 0.3.0 while the repo is at 0.7.0, four releases in
four days that reached nobody. Today the `.mcp.json` line, which arrives with `git pull`, is the
faster channel. So the first deliverable is not the server in the plugin; it is making the plugin
update itself — the CLI's existing silent self-update child will also run `claude plugin update`
every time it runs, and `setup` will update an installed plugin instead of saying "already
installed". One honest limit: that child only runs when someone types an `infra-kit` command in a
terminal (at most every 20 minutes) — never from Claude Code use alone — which is already how the
CLI itself updates, so the server binary has always lived on that channel. A teammate who only ever
uses Claude Code will see the fix in the deploy guard's message inside the repo, not from the
plugin. Only after the plugin channel is seen working across a couple of releases does the server
move into the plugin; if that cannot be made to work, the honest answer is to keep `.mcp.json` and
stop there. The second check is worktrees: a project-scope plugin is recorded against one exact
path, and nobody has verified that a session in a release worktree sees it; if it does not, the
recommended shape is a per-worktree local registration done by `worktrees add` (nothing written
into the checkout), and the plan comes back to you. The `doctor` row that guards all this checks
whether the installed plugin actually carries the server — not whether its version number matches
the CLI's, because those two numbers legitimately drift for hours or days around every release and
a row that is red every week is one nobody reads. The rest is a one-time prefix rename in a listed
set of files, a release order that follows what merging does, and no automatic deletion from any
repo's `.mcp.json` — whether a confirm-gated `doctor --fix` may do it is your call, as is whether a
plugin-only release may leave the plugin version ahead of the CLI's. On the grafana proxy: what you
asked for is already in place — the settings live in `infra-kit.json`, the `.mcp.json` line is
generated from them and drift-checked by `ik audit`, and it stays; shortening it or moving it into
the plugin costs more than it returns.

## 13. Open questions for the user (recommendation + cost)

> Resolved on "do it" (2026-09-14) with the recommendations below: Q1 no (no confirm-gated deletion), Q2 in scope
> (2 PRs per out-of-family repo, when §8.2 ever proceeds), Q3 yes (addendum written under D4-i), Q4 accept
> (memory rule updated: aligned at lockstep releases, plugin may run ahead between them). Q2 is moot while
> Gate G is red.

1. **Confirm-gated `doctor --fix` removal of the consumer `.mcp.json` key** (waives P3 for one key
   the CLI itself wrote). *Recommend: no* — the human-merged PR is the bound and `claude mcp remove`
   is one command. Cost if yes: `report.ts:131` list + confirm prompt + sibling-preserving writer
   (the retired `persist` can be kept), ≈ 80 lines + tests.
2. **Out-of-family repos (GLV-Backend, nomadream-ota-n-level)** — in scope or left on `.mcp.json`?
   *Recommend: in scope.* Cost: **2 PRs per repo** — first the plugin-pointer PR (`setup` writes
   `enabledPlugins` + `extraKnownMarketplaces` into a new committed `.claude/settings.json`, D6), then
   the §8.5 PR. Leaving them: the old prefix runs there forever with `setup` reporting `stale` on
   every run.
3. **D4 addendum** — one line in `.omc/plans/infra-kit-claude-plugin.md` §5 D4 pointing here?
   *Recommend: yes* (addendum, not rewrite). Cost: one line in a history file otherwise untouched.
4. **Plugin-only releases vs the "plugin.json aligned with every release" rule** (memory:
   plugin-version-bumps-with-release). AC-0 counts a plugin-only bump (e.g. 0.7.1 with no CLI 0.7.1)
   as a release, which desynchronises the two numbers by design until the next lockstep bump.
   *Recommend: accept* — once 0c stops comparing the numbers (P6) nothing in code depends on
   alignment, and plugin CI already enforces the bump per plugin change. Cost: none in code; the
   memory rule becomes "aligned at every lockstep release; plugin may run ahead between them". If
   declined: AC-0 counts lockstep releases only and the prerequisite takes as long as two CLI
   releases.

## 14. Review dispositions

### rev 1 → rev 2 (Architect + Critic)

| Issue | Disposition | Where |
| --- | --- | --- |
| Blocking 1 — worktree loading unmeasured | S0-6 blocking; D4 row (d) OPEN; fallback costed | §3(d), §4.1, §6 |
| Blocking 2 — `warn` does not exist | `stale` → `pass` + message | §8.2 step 7, AC-7 |
| Blocking 3 — release order | merge → publish CLI → consumer PRs; this repo's removal first consumer PR; windows named | §0, §7, §8.7 |
| Blocking 4 — neither-server window | detector row in `claudePluginVersionCheck` (rule reshaped in rev 4) | §8.2 step 7, AC-8 |
| Architect edits 1-10 | all applied in the Critic's ruled form | §3, §4.1, §6, §7, §8, §10, §13 |
| NB-1 boot-time degradation | dropped; detection via `version` fields | §8.2 step 8 |
| NB-2 two names for healthy / `ensure…` misnamed | `absent` sole healthy; module + function renamed | §8.2 step 4 |
| NB-3 auto-update mechanics unobserved | S0-7 | §6 |
| NB-4 `-p` masks approval | approval-first step; S0-4 keying | §6 |
| NB-5 confirm-token citation | `lib/tool-handler/confirm-token.ts:116` | §4 T1-iii |
| NB-6 grafana line stays | stated | §0, §5, §12 |
| NB-7 doctor.ts second speller | via `toolName()`; negative test greps `src/` | §8.2 steps 1, 7 |
| NB-8 near-miss claim | dropped | PM-4 |
| NB-9 "≤10 min" as fact | unmeasured everywhere | P4 |
| Missed: branch-content worktrees / boot-time / installPath rewrite / `MCP_MESSAGES` | struck as measured / dropped / S0-7(b) / `toolName()` | §3(d), §8.2, §6 |

### rev 2 → rev 3 (Architect re-review, orchestrator-verified items 1, 3, 7)

| # | Issue | Disposition | Where |
| --- | --- | --- | --- |
| 1 | `release/v1.84.0` does not exist; all 6 travelist worktrees carry both files | Struck; worktree list recorded as measured | §3(d) |
| 2 | S0-6(b) unattainable and mis-gated | (b) synthetic + informational; gate = (a) only; not a regression | §6 S0-6 |
| 3 | Plugin channel measurably not delivering; `.mcp.json` via git is faster | Promoted to D4 premise (e) and principle P5; T1-i re-argued; step 0 prerequisite with AC-0; S0-7 first; red → D4-i wins | §0, §1, §3(e), §6, §7, §8.0, §8.7 |
| 4 | `setup` returns `already-installed` without updating (`install-plugin.ts:159`) | Driver 2 rewritten; step 0b; messages say "setup (updates) or `claude plugin update`" | §2, §8.0 0b, §8.4, §8.5, AC-6 |
| 5 | wt-1 omits dirty-tree cost; `--scope local` third fallback | Dirty-tree cost added; wt-3 recommended; S0-9 | §4.1, §6 |
| 6 | Folded row has two failure meanings; exit code unstated | Two remedies distinguished in the message; exit 1 scoped to `plugin installed` | §8.2 step 7, §10, AC-8 |
| 7 | PM-1b detector reads the install record, which is not rewritten | Row reads the marketplace clone by default, record fallback; S0-7(b) confirms | §7 PM-1b, §8.2 step 7 |
| 8 | §13 Q2 cost contradicts §8.5 mechanics | 2 PRs per out-of-family repo | §13 Q2 |

### rev 3 → rev 3.1 (Architect rev-3 pass, five edits)

| # | Issue | Disposition | Where |
| --- | --- | --- | --- |
| 1 | S0-7(a) pass criterion let record non-advancement flip to D4-i | Pass = served copy advances AND (b) session loads it; records informational | §6 S0-7, §3 |
| 2 | `MIN_PLUGIN_VERSION_FOR_MCP` would be a 7th version field | Dropped (rule further reshaped in rev 4, see below) | §8.0 0c, §8.2 step 7 |
| 3 | wt-3 remove ordering vs `git worktree remove` | Remove runs BEFORE; stale entry harmless | §4.1 wt-3 |
| 4 | AC-0 "≥2 releases" could block on unrelated CLI work | Plugin-only bump counts (now §13 Q4) | §8.0 AC-0, §11 AC-0 |
| 5 | Gate condition restated in prose | Gate G verbatim in AC-1; §0, §3, §8.1 cite it | §0, §3, §8.1, §11 |
| minor | "ordinary CLI invocation" ambiguous | rev 3.1 said "any new terminal" — **that was false** (Critic rev-3 blocking 2); corrected in rev 4 | §8.0 trigger paragraph |

### rev 3.1 → rev 4 (Critic verdict on rev 3.1; all three blocking items code-verified)

| # | Issue | Disposition | Where |
| --- | --- | --- | --- |
| B1 | 0a placed the plugin spawn after early returns (`up-to-date` ≈:202, `cannot-self-spawn` :222, `parent-unknown` :227, `parent-still-running` :248) — a plugin-only bump never reached it; AC-0 unsatisfiable | Plugin spawn runs on every child run past the throttle, inside the lock (`:162`) and BEFORE the `isNewerVersion` return; gated by lock + `claude` probe only; no `canSelfSpawn`, no `waitForParentExit`; own outcome + stamp; AC-0/PM-0 re-derived; unit tests for each early-return path | §8.0 0a, AC-0, §7 PM-0, §10 |
| B2 | "child triggered by the zshrc init block on shell start" is false — rc block only sources cache files (`init.ts:950-995`); sole call site `entry/cli.ts:112`, TTY typed command, `guards.ts:74-79` skips `mcp`/`--json`/non-TTY/local-install, 20-min throttle (`update-cache.ts:33`) | Trigger stated plainly in §8.0; §0, §3(e) re-argument ("advances only on typed TTY commands, never from Claude Code use"), PM-0, AC-0, §8.5 PR body, §8.7 step 1, README text and §12 reworded; Claude-Code-only population added to PM-1b with its real signals (consumer guard text; old command bodies failing) and the note that 0.8.0's bodies cannot reach them | §0, §3, §7 PM-0/PM-1b, §8.0, §8.3, §8.4, §8.5, §8.7, §12 |
| B3 | "served plugin < CLI version → cannot serve" unsound: plugin.json sat at 0.3.0 through CLI 0.5.5/0.5.6 and at 0.4.0 vs CLI 0.7.0 for 2.5 h; red at every release | Capability = (ii) alone (served `.mcp.json` composes the prefix); (i) is an advisory freshness line that never claims incapacity; transition guard keys on (ii); principle P6 added; synthetic "0.7.0 with correct `.mcp.json` → pass + advisory" test proves the keying; `MIN_PLUGIN_VERSION` negative test kept | §1 P6, §8.0 0c, §8.2 step 7, §10, AC-8 |
| NB-1 | AC-0 plugin-only bump vs "aligned" memory rule | §13 Q4 with recommendation (accept) + cost (none in code once 0c stops comparing) and the declined path | §13 Q4 |
| NB-2 | S0-7(a) has no time threshold | < 60 s non-interactive from `$HOME` is gated; wall time recorded | §6 S0-7 |
| NB-3 | Claude-only population must be in the pre-mortem table | Added to PM-1b explicitly | §7 PM-1b |
| NB-4 | rev-1 NB row lumped nine items | Split into one row per item | §14 rev 1 → rev 2 |
| NB-5 | Stale unregistered worktree dirs (`v1.84.0`, `flexible-dates`) | §3(d) records them as ENOTEMPTY residue; S0-6(a) runs in a REGISTERED worktree (v1.69.0); wt-3's "stale entry harmless" cites the same pattern | §3(d), §6 S0-6, §4.1 |
| NB-6 | 0b: whether `claude plugin update` needs `cwd` = the recorded project is unmeasured | Folded into S0-7(a) (run from `$HOME` AND from a recorded project dir); 0a/0b follow the result | §6 S0-7, §8.0 0a/0b |

### Changes in rev 2
- S0-6, S0-7, echo-server spike, interactive approval, release order, `stale` → pass, minimum-version
  row, cross-unit prefix test, rename of the retired writer, boot-time degradation dropped, T2 line
  stays, §13 Q1-Q3.

### Changes in rev 3
- D4 premise (e) + P5; step 0 prerequisite with AC-0; S0-7 first; S0-6 corrected (v1.84.0 struck,
  (b) informational); wt-3 recommended with dirty-tree cost on wt-1; doctor row two failure meanings;
  served copy = clone by default; §13 Q2 cost = 2 PRs.
- rev 3.1: S0-7(a) keyed on the served copy; no `MIN_PLUGIN_VERSION_FOR_MCP` constant; wt-3 remove
  ordering; plugin-only bumps count for AC-0; Gate G stated once.

### Changes in rev 4
- **Step 0a placement fixed:** the plugin update runs on every throttled child run, inside the lock,
  gated by the `claude` probe only; AC-0 and PM-0 re-derived; tests for each outcome path. (rev 4
  put it BEFORE the early returns; rev 4.1 moves it to a wrapper AFTER `runUpdateCheckLocked` — see
  below.)
- **Trigger corrected:** the child runs from a user-typed TTY `infra-kit` command (`entry/cli.ts:112`,
  20-min throttle), never from shell start, the MCP process or Claude Code; the false "any new
  terminal" wording removed from every place; §3(e) re-argument now states the channel's real
  trigger and why T1-i still holds in steady state; the Claude-Code-only teammate added to PM-1b with
  the consumer guard text as the signal that reaches them.
- **Doctor row reshaped (P6):** capability = served `.mcp.json` composes the prefix (file check, no
  version literal); version lag is advisory only; transition guard keys on the file check; AC-8 and
  §10 rewritten with a synthetic test that proves the keying.
- S0-7(a): < 60 s threshold; run from `$HOME` and from a recorded project (cwd question, NB-6).
- §3(d): unregistered leftover worktree dirs recorded; S0-6(a) in a registered worktree.
- §13 Q4 (plugin-only releases vs alignment rule); §14 rev-1 rows split one per item.

### rev 4 → rev 4.1 (Architect rev-4 pass; trigger chain, rc block and repo-local guard verified)

| # | Issue | Disposition | Where |
| --- | --- | --- | --- |
| 1 | Placing the plugin step before the early returns delays the `lastCheckMs` stamp (written only by `finish()` after the fetch) and eats into `LOCK_STALE_MS` = 30 min (`lock.ts:27-35`) by up to a 120 s `claude` probe (`install-plugin.ts:41`) + update on every run | Moved OUT of `runUpdateCheckLocked`: wrapper in `runUpdateCheck` (`:156-166`) — `try { outcome = await runUpdateCheckLocked(); await updatePlugin(); return outcome } finally { release() }`; runs on EVERY outcome after the stamp, single-flight; budget probe + update ≤ 5 min; §10 tests assert the wrapper runs after each outcome, stamp-before-spawn, release-after | §8.0 0a, §3 re-argument, §10, "Changes in rev 4" note |
| 2 | Live-session race unnamed | Named: version-keyed cache dirs make a cache update safe; a marketplace-clone `git pull` can swap a `SKILL.md` between listing and invocation — benign; S0-7(b) decides which race applies | §8.0 0a |
| 3 | PM-1b false claim: cached 0.3.0 has one command (`release-create.md`, names `mcp__infra-kit__release-create` at :8); `doctor` is a SKILL (`SKILL.md:4`, `Bash(infra-kit doctor)` + probe), names no MCP tool | Struck; the old doctor skill running the NEW CLI's `doctor` is the PRIMARY detector for the Claude-only population (capability row reachable); guard text and old `release-create` body demoted to secondary; consumer PR body says "run `/infra-kit:doctor`" | §7 PM-1b |
| 4 | `update` from `$HOME` with no scope flag may resolve user scope (`install` needed `cwd: projectRoot`, `install-plugin.ts:169`) | Kept in S0-7(a); the iterate-recorded-projects fallback runs with `cwd: <recorded projectPath>` and skips (never fails on) a path that no longer exists; `skipped` outcome recorded | §8.0 0a, §10 |

### Changes in rev 4.1
- 0a is a wrapper around `runUpdateCheckLocked`, not an insertion into its early-return chain;
  budget ≤ 5 min; live-session race named; cwd/scope handling for project-scope records with
  skip-on-missing-path.
- PM-1b corrected: the old doctor skill via the new CLI is the primary detector for Claude-only
  teammates.

### rev 4.1 → rev 5 (Critic verdict on rev 4.1; B1/B2/B3 and the PM-1b correction verified resolved)

| # | Issue | Disposition | Where |
| --- | --- | --- | --- |
| B1 | AC-0 required "no advisory lag" — a CLI-vs-plugin comparison P6 rejects, and it fails spuriously on the CLI patch that ships step 0 (served 0.7.0 < CLI 0.7.x+1), flipping Gate G to D4-i | AC-0 gates ONLY on "served copy's `plugin.json` version == `origin/main`'s at check time" (command given); no `doctor` verdict, no CLI comparison in the gate. The (i) advisory is redefined as served copy vs marketplace clone ("fetched but not applied"), exists only if S0-7(b) shows sessions load from a non-clone path, and never reads `packageJson.version`; P6 says so; §10 runs the row under two injected CLI versions and asserts identical output + a negative test on `packageJson.version` reads; PM-0 detection reworded | §0, §1 P6, §7 PM-0, §8.0 0c, §8.0 AC-0, §8.2 step 7, §8.7, §9, §10, §11 AC-0/AC-8 |
| NB-1 | `updatePlugin` must never throw | Whole body wrapped; exception → `plugin: 'failed'`, locked outcome returned unchanged; §10 case | §8.0 0a, §10 |
| NB-2 | Static imports only / no heavy import in the child | Stated: `updatePlugin` and callees statically imported at module load; uses only `node:child_process` + the existing cache writer; static-analysis test | §8.0 0a, §10 |
| NB-3 | Old 0.3.0 doctor SKILL prose (`SKILL.md:70,86`) contradicts the new row | Added to the §8.3 sweep explicitly (both lines replaced; skill body never restates a CLI verdict); PM-1b says the CLI row text is the authority for that population | §8.3 step 4, §7 PM-1b |
| NB-4 | `Bash(infra-kit doctor)` is non-TTY → detects, never triggers the child | Stated in PM-1b ("detects but never triggers"; `guards.ts:74-79` `not-a-tty`) | §7 PM-1b |

### Changes in rev 5
- AC-0 is the direct marketplace-delivery fact (served `plugin.json` == `origin/main`'s), nothing
  else; the CLI-vs-plugin advisory is gone everywhere, replaced by an optional clone-vs-served
  "fetched but not applied" line whose existence S0-7(b) decides.
- 0a: `updatePlugin` never throws; static imports only.
- §8.3: doctor SKILL `:70/:86` prose in the sweep; PM-1b: authority + non-TTY caveats.

### rev 5 → rev 5.1 (Architect rev-5 pass; AC-0 measurable, zero CLI-vs-plugin comparison confirmed)

| # | Issue | Disposition | Where |
| --- | --- | --- | --- |
| 1a | `<served>` undefined in §11 AC-0 | Defined as the S0-7(b) load path recorded in §6.1 (clone or record `installPath`), matching §8.0; if (b) = record `installPath`, AC-0 measures record advancement — consistent with S0-7(a) marking it informational (S0-7 runs before step 0 exists, AC-0 after it ships) | §11 AC-0 |
| 1b | AC-0 command could read a stale local `origin/main` | Prefixed with `git fetch origin main &&`, compares against `FETCH_HEAD` | §11 AC-0 |

### Changes in rev 5.1
- §11 AC-0: `<served>` defined; record-`installPath` case stated; fetch-before-compare.

