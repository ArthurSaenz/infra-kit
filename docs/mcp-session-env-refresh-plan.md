# The MCP server sees the session's `env-load` — in-process session-env refresh at the tool chokepoint

**Status: implemented** (2026-09-15, row (b) — the base design without §2.4-opt; the user said
"do it" and picked no row). Commits, in §4 order: `9a4eecd` (step 7, skills + plugin 0.7.11 —
landed first because it is independent), `b7e1cbc` (step 1), `aa668e7` (step 2), `9db62dc`
(step 3), `e8844ee` (step 4). Steps 5 (the gate) and 6 (publish + the exact-version global
install) and V0 (§6.6) are NOT done. Deviations recorded in §12.
Planned as RALPLAN-DR, deliberate mode — Planner revision 2; consensus reached, see §11 — after
`docs/mcp-session-env-refresh-plan.architect-review.md` (rounds 1 and 1b) and
`docs/mcp-session-env-refresh-plan.critic-review.md` (ITERATE, blocking 1–12). Every blocking item
and every required Architect amendment is applied; §11 lists them by number.

**The defect.** `/infra-kit:session dev` → MCP `env-load` writes 16 Doppler vars to
`~/.cache/infra-kit/<INFRA_KIT_SESSION>/env-load.sh`. `/infra-kit:release-create …` → gate → confirm →
refused on the Jira precondition, because `loadJiraConfig` reads `process.env.JIRA_*`
(`src/integrations/jira/api.ts:237-240`) and the long-lived `infra-kit mcp` process inherited its
environment from Claude Code, which inherited it from the terminal at launch. The human must exit
Claude Code and relaunch. **A credential loaded mid-session via `env-load` must be visible to the same
session's MCP tools without restarting Claude Code.**

**Scope (A8).** The fix applies to a server that inherited `INFRA_KIT_SESSION` — Claude Code launched
from a terminal that runs the `infra-kit setup` init rc. Launched from the desktop app, an IDE
extension or a shell without the rc, the server has no session id: the overlay logs one line and
no-ops for the life of the process, and the defect persists there — consistently, since `env-load`
over MCP throws `INFRA_KIT_SESSION is not set` in the same situation (`constants.ts:225-231`).

Sibling of `docs/session-zshenv-plan.md` (which fixed the same class of problem for every zsh child
of that terminal — the `Bash` tool included — and explicitly left the MCP server out, `:516`
"No fix for the MCP `env-status` staleness") and of `docs/mcp-proxy-generalization-plan.md` (the
`ik-mcp` shim the user asked about). Where they decided something this document does not re-decide it.

All paths below are relative to `apps/infra-kit/cli/` unless they start with `plugins/` or `docs/`.

## 0. Facts verified (corrections to the brief in bold)

- **F1 — one chokepoint.** `src/mcp/tools/index.ts:62` is the only `createToolHandler(` call site
  outside tests, and `registerTool` is called nowhere else. The returned closure
  (`src/lib/tool-handler/tool-handler.ts:562-604`) runs, in order: `ensureUserProjectConfig()` (`:574`),
  `commandEcho.reset()` (`:580`), `resolveStop` (`:587`, gate/form/verify), the `stop` early return
  (`:589`), then `handler({...params, confirmedCommand: true})` (`:591`). One read of `process.env`
  happens inside `resolveStop`: the `env-load` form provider reads `INFRA_KIT_ENV_TOKEN`
  (`src/lib/env-load-form/env-load-form.ts:46`) — a name the file never carries (F5). The gate itself
  is decided from `params`, `ctx` and client capabilities only.
- **F2 — the server process is the writer AND the non-reader.** `env-load` over MCP writes to
  `getSessionCacheDir()/env-load.sh` (`src/commands/env-load/env-load.ts:214-222`), and
  `getSessionCacheDir()` is `getCacheRoot()/$INFRA_KIT_SESSION` (`src/lib/constants/constants.ts:224-233`)
  read from the server's OWN `process.env`. So the file the server writes is in a directory the server
  can always resolve; the loop is closed inside one process. The only thing missing is the read.
- **F3 — what "loaded now" means on disk, per the shell.** Two readers exist and they agree:
  the `~/.zshenv` block (`src/commands/init/init.ts:1206-1210`): source `env-load.sh` iff it is readable
  and `env-clear.sh` is NOT newer (`! clear -nt load`, a tie goes to load); else source `env-clear.sh`
  if readable. The precmd hook (`init.ts:1068-1078`) uses the same `load_mtime >= clear_mtime` tie rule.
  `env-clear` writes `env-clear.sh` (`src/commands/env-clear/env-clear.ts:100`) THEN **deletes**
  `env-load.sh` (`:104`, `rmSync(…, {force:true})`), so on a clean machine "cleared" is simply "no load
  file, a clear file". `env-autoload.ts:433-448` (`isClearedOnDisk`) uses `>=` for clear — the opposite
  tie-break — but it only guards the auto-loader's own write, never what a shell sources. The
  in-process reader adopts the zshenv rule because that is what every zsh child of the terminal sees.
- **F4 — the parsers exist.** `parseVarsFromEnvFile` (`constants.ts:202-210`) and
  `parseVarNamesFromEnvFile` (`:188-196`) share one walk (`forEachAssignment`, `:131-185`) that handles
  single-quoted multiline values and CRLF, and skips `set -a`/`set +a`/`unset …`/`export …` lines
  (`ENV_VAR_LINE_PATTERN = /^([A-Z_]\w*)=/i`, `:74`). **Nothing parses `env-clear.sh`** — its lines are
  `unset NAME` and one `export INFRA_KIT_ENV_CLEARED='1'` (`env-clear.ts:58-71`), neither of which the
  pattern matches. The same skip means the e2e harness's seed `export FOO=bar`
  (`mcp-harness.ts:85`) parses to ZERO vars (A10 — §6.4 seeds the assignment form).
- **F5 — what the file carries.** Besides the Doppler pairs (minus `DOPPLER_TOKEN`/`INFRA_KIT_ENV_TOKEN`,
  `env-load.ts:115`), `buildEnvLoadFileLines` writes the markers `INFRA_KIT_ENV`, `INFRA_KIT_ENV_CONFIG`,
  `INFRA_KIT_ENV_PROJECT`, `INFRA_KIT_ENV_PROJECT_ROOT`, `INFRA_KIT_ENV_LOADED_AT` (`:169-173`) and either
  `INFRA_KIT_ENV_AUTOLOADED='1'` or `unset INFRA_KIT_ENV_AUTOLOADED` + `unset INFRA_KIT_ENV_CLEARED`
  (`:90-100`). So an overlay of the file's assignments makes `env-status`'s marker reads
  (`src/commands/env-status/env-status.ts:38-42`) truthful for free; the two `unset` lines are the only
  semantics the assignment parser drops (handled in §2.2).
- **F6 — read sites at call time** (grep `process.env` under `src/`, tests excluded): Jira
  (`api.ts:237-240`, consumed by `release-create`, `release-remove`, `release-desc-edit`,
  `gh-release-deliver`); `INFRA_KIT_ENV_TOKEN` (`token-resolver.ts:49,82`, `env-list.ts:104`,
  `env-token-list.ts:111`, `doctor.ts:548`, `env-load-form.ts:46` — rc-provided at launch, never in the
  file per F5); the `INFRA_KIT_ENV_*` markers (`env-status.ts:38-42`, `env-autoload.ts:387-390`);
  `DOPPLER_PROJECT`/`DOPPLER_ENVIRONMENT` (`dev-server.ts:1043`, not MCP-exposed). Child processes the
  tools spawn (`gh`, `git`, `doppler`, the cmux workspace `reopen` opens via `open-dev-workspace.ts:37`
  `{...process.env}`) inherit `process.env` at spawn time. In-process WRITERS of `process.env` outside
  the overlay: `dev-wizard-run.ts:449` and `dev-server.ts:1206-1207` (`??=`) — neither is MCP-exposed,
  and `program.ts:400` lists `mcp` in `AUTO_LOAD_EXCLUDED`, so the auto-loader never
  runs inside the server.
- **F7 — `env-load` is NOT gated on protected configs. Correction to the brief.** The
  `protectedEnvs` policy (`'disallow'|'allow'|'cli-only'`, `src/lib/workflow-envs/protected-env-access.ts:29-45`,
  documented as deploy access, `:8-10`) is consulted only by the deploy commands
  (`gh-release-deploy-all.ts:52,72`, `gh-release-deploy-selected.ts:59,76`, `local-deploy.ts:325`,
  `local-deploy/preflight.ts:145`, `deploy-form.ts:162`). Nothing under `src/commands/env-load/` or
  `src/lib/env-load-form/` mentions `prod` or the policy. `ik env-load -c prod` in the terminal and
  `env-load {config:'prod'}` over MCP both write the file. `resolveProtectedEnvAccess` is `async`
  (awaits `getInfraKitConfig`, `:29-35`); no synchronous config accessor exists.
- **F8 — the proxy's contract, measured.** `readListedVars` returns `null` while ANY listed name is
  empty (`src/lib/mcp-proxy/env-vars.ts:56-70`); the file wins over the inherited env per name
  (`:39-47`). `initialize` is answered without spawning from the profile cache or the pinned fallback
  `FALLBACK_PROTOCOL_VERSION='2025-06-18'`, `FALLBACK_CAPABILITIES={tools:{listChanged:true}}`
  (`src/entry/mcp-proxy.ts:25-26,130-139`); the child's handshake is the proxy's own
  (`upstream.ts:84-94`, `mcp-proxy.ts:168-170`). The respawn key is `JSON.stringify(vars)`
  (`upstream.ts:267,311-312`); the old child is killed and its in-flight work errored (`:122-125`).
  The credential poll is 2 s (`mcp-proxy.ts:16`). infra-kit's server declares
  `resources:{listChanged:true}` (`src/mcp/server.ts:25`) and is detected as
  `command==='infra-kit' && args[0]==='mcp'` (`src/lib/plugin-pointer/mcp-registration.ts:43,67`).
- **F9 — confirm token is per process, but the key is injectable.** `createConfirmCodec({ key?, ttlSeconds? })`
  defaults the key to `randomBytes(32)` (`src/lib/tool-handler/confirm-token.ts:112-116`), TTL 600 s
  (`:22`); `getDefaultConfirmCodec` (`:136`) is the process-wide default. A token minted by one child is
  refused by the next as `mac` — unless a persisted key is injected, a ~10-line change (Option A's
  honest cost, §1.5).
- **F10 — the plugin entry is static.** `plugins/infra-kit/.mcp.json` →
  `{type:'stdio', command:'infra-kit', args:['mcp'], cwd:'${CLAUDE_PROJECT_DIR}'}`; plugin version
  `0.7.10`. `src/entry/mcp.ts` → `serveStdio(buildOrDie)`; the factory is lazy and may run twice
  (`:20-24`), so process-scope state must be idempotent.
- **F11 — the texts that say "frozen".** `plugins/infra-kit/skills/session/SKILL.md:52-54` ("Never
  verify a load with `env-status` over MCP: it reads the long-lived server's own environment, frozen
  when Claude Code launched") and `:137`; `plugins/infra-kit/skills/release-remove/SKILL.md:32-36`
  ("must be in the environment the MCP server was launched with … A server spawned by a host does not
  inherit an `ik env-load`ed shell"); `plugins/infra-kit/skills/release-create/SKILL.md:27-29` ("load
  them with `ik env-load` and source the file it returns"); `src/commands/release-remove/release-remove.ts:226-236`
  (comment + MCP remediation "in the environment the MCP server was launched with");
  `src/commands/release-create/release-create.ts:348` is the dead-token remediation and does NOT
  mention the launch env — **it needs no change**; `docs/session-zshenv-plan.md:411,516,879` record the
  staleness as a residue. The literal in the user's screenshot ("frozen at Claude Code launch … until
  Claude Code is restarted") is the agent paraphrasing `session/SKILL.md:52-54`, not a string in `src/`.
  `plugins/infra-kit/__tests__/manifest.test.mjs:771` pins only the `Terminal status at invocation`
  line of the session skill; no skill test pins the frozen sentences.
- **F12 — the e2e harness already sandboxes the session dir.** `makeDisposableSession`
  (`src/mcp/__tests__/helpers/mcp-harness.ts:77-92`) redirects `XDG_CACHE_HOME` + `INFRA_KIT_SESSION`
  into a temp dir; the bundle is built hermetically (`:33-46`, no prior `pnpm build`). The `sec` lane
  (`mcp-stdio.e2e.test.ts:1241-1296`) hand-writes `env-load.sh` with `FOO='s3cr3t-value'` and asserts
  the value never leaks through `env-status`/`env-list`, matching only `sessionConfig` +
  `sessionTotalCount`. It must keep passing unchanged (§6.4).
- **F13 — the sinks.** MCP mode logs to stderr AND to the world-readable `/tmp/mcp-infra-kit.log`
  (`src/lib/logger/index.ts:6,36`); the `Tool execution started` line already logs `params`
  (`tool-handler.ts:563`).
- **F14 — the release-create step order after the Jira read** (for AC1): `loadJiraConfig` (`:386`) →
  `collectEntries` (`:395`, no Jira/gh call when every entry is explicit) → `assertBaseBranchSwitchable`
  (`:411-414`, returns when no worktree holds the base) → `confirmReleases` (auto-skipped under
  `confirmedCommand`) → `executeOne` (`:423`) → `assertCleanCheckout` → `prepareGitForRelease`
  (`release-utils.ts:68-72`: `git fetch origin` is its first command). Per-entry failures are CAUGHT
  (`:336-355`) and returned as `structuredContent.failedReleases[{version, error}]` with the
  operation label `create release v<x> (regular)`, not thrown.
- **Assumed, not re-measured (reported by the lead):** Claude Code's `/mcp` reconnect respawns the
  server with Claude Code's own environment, itself frozen at Claude Code's launch; no plugin in
  `~/.claude/plugins/cache` solves mid-session credential arrival for a stdio server. Neither changes
  the decision below.
- **Out of scope, mention only:** `JIRA_TOKEN` in Doppler `dev`/`arthur` returned 401 on 2026-09-05
  (`docs/jira-401-misreported-as-404-plan.md`). After this fix a dead token fails as `auth`, with
  `release-create.ts:348`'s remediation, instead of as "not configured".

## 1. RALPLAN-DR summary

### 1.1 Principles

- **P1 — the server sees what a zsh child of Claude Code — the `Bash` tool — sees.** Not "the
  terminal": the interactive terminal and a fresh zsh child are two different things (§2.8), and the
  comparator is the child. "Loaded now" has one definition on this machine: the zshenv rule (F3). The server derives its view from the same two files with the same
  rule, never from a copy of the shell's state. No per-name exception, no per-file exception (the
  user's decision: overlay ALL — "when we load from Doppler, everything loads").
- **P2 — one behavioural seam; no command's logic changes.** Every tool call passes
  `tool-handler.ts:580-591` (F1); the behaviour lives there and the 27 tool definitions and their
  `process.env` reads stay as they are. Text edits under `src/commands/` (descriptions, one
  remediation) are not logic.
- **P3 — a pure function of (launch baseline, disk).** The overlay is recomputed from the process's
  launch environment and the current files on every call; it never accumulates. Two calls with the
  same disk state see the same environment.
- **P4 — the typed CLI path is untouched.** `ik release create` in a terminal already sees the vars
  through the shell; nothing here runs outside the MCP chokepoint.
- **P5 — names in logs, never values.** The overlay logs which names it set and unset, as a string
  line, to stderr and to `/tmp/mcp-infra-kit.log` (F13) alike; no log object ever carries a `vars`
  field; a value appears nowhere in a log line or a tool result.
- **P6 — one environment per call.** Every path of a call — gate, form, verify, handler — runs under
  the environment derived at the call's entry, and that derivation is atomic with respect to the event
  loop (synchronous, §2.6).

### 1.2 Decision drivers

- **D1 — no restart, no respawn.** The confirm gate is a two-round protocol with a per-process key
  (F9); any design that replaces the process between round 1 and round 2 refuses the confirm unless it
  also persists the key. The fix must keep the process.
- **D2 — the writer is the server.** `env-load` — the tool that creates the file — is itself an MCP
  tool of this server; `env-list`, `doctor`, `setup` must work with NO credentials. A design that
  withholds requests until credentials exist, or that replaces the process when the file changes,
  fights the tool that writes the file.
- **D3 — blast radius and lockstep.** The defect is in the CLI; the plugin's `.mcp.json` (F10), the
  doctor/audit detectors (F8) and the consumer repos should not need to change for the fix to land.

### 1.3 Options

| | Option | Verdict |
|---|---|---|
| A | Put `infra-kit mcp` behind `ik-mcp` (the user's question) | **Rejected** — §1.5 |
| B | In-process session-env overlay at the chokepoint | **Chosen** — §2 |
| C | Resolved-env object threaded through `ToolCallContext`; Jira and friends read from it | Rejected — §1.5 |
| D | Route credentialed work through the `Bash` tool (zshenv already fixes that path) | Rejected — §1.5 |
| E | Documentation only: tell the agent to restart | Rejected — §1.5 |

### 1.4 Chosen: Option B

At the entry of every tool call (after `commandEcho.reset()`, `tool-handler.ts:580`, before
`resolveStop`), recompute `process.env` as `launchBaseline ⊕ sessionState(disk)` where `sessionState`
is the zshenv rule (F3): the assignments of `env-load.sh` when the load wins, the `unset` names of
`env-clear.sh` plus `INFRA_KIT_ENV_CLEARED='1'` when the clear wins, nothing when neither file exists.
Every downstream `process.env.X` read (F6) and every child the tool spawns then sees exactly what a
zsh spawned from the terminal at that instant would see. **Every file is applied in full, `prod`
included** — the user's overlay-ALL decision; the deploy gates (`assertDeployable`, reading the
setting + `isMcpMode()`, not `process.env`) hold identically. `applySessionEnv` is synchronous
(§2.6). The pre-launch flow (`ik env-load` in the terminal, THEN launch Claude Code) is unchanged by
construction (§2.8). `env-status` over MCP becomes a truthful reading (F5) and the "frozen"
paragraphs (F11) are rewritten. Cost: one new ~120-line module, one `statSync` pair per tool call,
one four-line insertion at the chokepoint, no plugin manifest change, no detector change. An
OPTIONAL writer-side gate for protected configs is specified in §2.4 for the user to switch on with
one word; the base design ships without it if the user says nothing.

### 1.5 Rejected alternatives

| Option | Why rejected |
|---|---|
| **A — `ik-mcp --name infra-kit --env JIRA_… -- infra-kit mcp`** | The honest steelman: one mechanism for "a stdio server whose credentials arrive from a file", enforced at spawn by the kernel, no in-process mutation, no baseline bookkeeping, and a `prod` file becomes a disposable `prod` child. What it would cost, and why it still loses: (1) the shim's all-or-nothing rule (`mcp-proxy.ts:223,285`, F8) refuses every request but `tools/list` until every listed var exists, so `env-load` itself is refused — ~20 lines to add an optional-vars mode, so NOT the ground of rejection. (2) The respawn on any var change (F8) refuses a confirm minted by the old child as `mac` — `createConfirmCodec` already takes a `key` (F9), so a persisted key is ~10 lines, also not the ground. (3) Cold-cache `initialize` claims `2025-06-18` and `{tools}` only (F8) while the real server declares `resources` and speaks the 2026 era; the child's handshake is the proxy's, not the client's (`mcp-proxy.ts:168`), so whether elicitation capabilities reach `getClientCapabilities` (`tools/index.ts:75-79`, envelope-first) through the proxy is unmeasured — the env-picker form (`docs/session-env-picker-plan.md`) cannot carry that risk. (4) `isInfraKitServerEntry` (`mcp-registration.ts:67`), the doctor row and `audit`'s check key on `command:'infra-kit', args:['mcp']` and would need a second shape shipped in lockstep with a plugin `.mcp.json` edit. (5′) **The structural ground: infra-kit's server is the file's WRITER.** `env-load` runs inside the child, writes the file, and the 2 s poll then kills that child (`upstream.ts:122-125`) — usually after the response is out, but nothing orders it; a server killed by the side effect of its own tool is a race no proxy option cures without learning which tool writes. The proxy was built for servers that only READ the file. Rejected on (5′)+(3)+(4). **`ik-mcp` stays for foreign stdio servers.** |
| **C — resolved env via `ToolCallContext`** | The natural mutation-free shape for a reads-only fix (`loadJiraConfig(env)` + `env-status` reading one object, ~4 sites). What rules it out is the user's ALL-vars decision, children included: every child spawn (32 execa/spawn sites, 4 already building `{...process.env}`) would need the threaded env or `GH_TOKEN`-in-Doppler breaks — two definitions of "loaded" (in-process vs children), which P1 forbids. `mcpMode` (`src/lib/mcp-mode/mcp-mode.ts`) already proved the process-global pattern for a fact that must be read late; `process.env` IS that global. |
| **D — do credentialed work through `Bash`** | The zshenv block (`docs/session-zshenv-plan.md`) makes `Bash(ik release create …)` see the vars today. But it bypasses the confirm gate, the argument form, the MCP-only refusals (`assertMcpRemoveInput`) and the skills, which are MCP-first by decision (`docs/session-env-picker-plan.md` Phase 2). It is the workaround the user is escaping from, not a fix. |
| **E — docs only** | The user's report is the cost: exit, relaunch, lose the conversation. The residue was recorded once already (`session-zshenv-plan.md:516`) and it came back as a bug. |
| **B′ — overlay in `serveStdio`'s factory / at server start** | The factory runs once per connection (twice on the probe path, F10) — the file changes AFTER that. Per-call is the only granularity that tracks `env-load` → next tool. |
| **B″ — fs watcher + `notifications/tools/list_changed`** | Tools do not change; their inputs do. A watcher adds a timer and a race for nothing the per-call stat does not already give. |
| **B‴ — allowlist (JIRA_* only)** | **Decided by the user: overlay ALL variables, no allowlist** — "when we load from Doppler, everything loads"; the server must see exactly what the terminal sees. An allowlist is a second, hidden definition of "loaded" that diverges the moment a tool reads a new var. The never-overlaid set (§2.3) is the inverse — a short list of process plumbing — and is the only filtering that survives. |
| **B⁗ — reader-side withholding of a protected config's secrets (revision 1 §2.4)** | Dropped (Critic 4, Architect A15). It needed an `await` on `resolveProtectedEnvAccess` inside the apply (F7) — the only thing that made the seam non-atomic; its `env-status` output (`prod: 0 of N` + "env-load needs to be re-sourced, or vars were unset manually", `env-status.ts:63-65`) named two false remedies and sent an agent into a re-load loop; it read the CURRENT repo's `protectedEnvs` against a file that may belong to another repo (the session dir is per terminal); and it withheld on exactly one path — the agent's own `env-load prod` over MCP — while the same agent gets prod in every `Bash` child via zshenv one turn later. Possession is gated at the WRITER if at all (§2.4). |

## 2. Design — `src/lib/session-env/`

### 2.1 Module and API

New `src/lib/session-env/session-env.ts` (+ `index.ts`, + `__tests__/session-env.test.ts`):

```ts
export type SessionEnvState =
  | { kind: 'load'; vars: Record<string, string>; unset: string[]; signature: string }
  | { kind: 'clear'; unset: string[]; signature: string }
  | { kind: 'none'; signature: 'none' }
  | { kind: 'no-session' }

/** The zshenv rule (init.ts:1206-1210) over the session dir: load wins unless clear is strictly newer. */
export const readSessionEnvState = (dir = getSessionCacheDir()): SessionEnvState

/**
 * Make `process.env` equal `launchBaseline ⊕ state`. SYNCHRONOUS on purpose: the SDK dispatches tool
 * handlers concurrently (§2.6), and a restore+overlay that cannot yield cannot interleave. The
 * stat pair is the whole per-call cost; the file is parsed only when its signature moved.
 */
export const applySessionEnv = (state = readSessionEnvState()): { set: string[]; unset: string[]; changed: boolean }

/** Test seam: reset the once-captured baseline. Not exported from index.ts. */
export const resetSessionEnvForTests = (): void
```

- **Baseline capture.** On the first `applySessionEnv` call the module snapshots `{...process.env}`
  once (module-scope `let baseline: NodeJS.ProcessEnv | null`). Captured lazily rather than at import
  so unit tests that build the environment before the first call see their own baseline, and so the
  twice-running factory (F10) cannot capture twice. **State `none` restores pre-launch vars (A7):** a
  terminal that had `dev` loaded when Claude Code launched, then `env-clear --purge`d or removed the
  session dir, leaves the server with its baseline `JIRA_*` — and a `Bash` child of Claude Code does
  the same (it inherits Claude Code's launch env, and zshenv in state `none` sources nothing). That is
  P1 holding, not a bug to "fix".
- **Apply = restore then overlay, in one event-loop turn.** Keep `touched: Set<string>` of every name
  the previous apply set or deleted. Each apply: `for (const name of touched)` put back the baseline
  value (set it, or `delete` when the baseline lacked it); clear `touched`; then apply the state:
  `load` → `for (const [name, value] of Object.entries(vars))` assign, then delete every `unset` name;
  `clear` → delete every `unset` name, assign `INFRA_KIT_ENV_CLEARED='1'`; `none` → nothing. Record
  every name written or deleted into `touched`. This is P3: the result depends on `(baseline, state)`
  only, never on call history. No counter loops (A12).
- **Signature short-circuit.** `signature` = `load:<ino>:<mtimeMs>:<size>` / `clear:<ino>:<mtimeMs>` /
  `none`. `atomicWriteFileSync` (`constants.ts:263-270`) writes a temp file and `renameSync`s it into
  place, so every write lands a NEW inode — `ino` makes the signature exact, with no mtime-tick
  aliasing bound to state (Critic 14 supersedes A11). When equal to the last applied signature, return
  `{changed:false}` without parsing or touching `process.env`.
- **`no-session`.** `getSessionCacheDir()` throws without `INFRA_KIT_SESSION` (`constants.ts:225-231`).
  The module catches once, logs `session-env: INFRA_KIT_SESSION unset — no overlay` once per process,
  and every later call is a no-op. Unlike the proxy's `NO_SESSION` fallback (`env-vars.ts:11`) it does
  NOT read a `no-session` directory: `env-load` over MCP throws in the same situation, so nothing ever
  writes one.

### 2.2 The two parsers

- `parseVarsFromEnvFile` (F4) for the load file — unchanged, reused.
- **New** `parseUnsetNamesFromEnvFile(filePath): string[]` in `src/lib/constants/constants.ts`, next to
  the other two: the `NAME` of every `^unset ([A-Z_]\w*)$` line outside a quoted value. Used for BOTH
  files: on `env-load.sh` it yields the manual-load lines `unset INFRA_KIT_ENV_AUTOLOADED`,
  `unset INFRA_KIT_ENV_CLEARED` (F5) so a manual load clears a stale `INFRA_KIT_ENV_CLEARED` from the
  baseline exactly as sourcing does; on `env-clear.sh` it yields every loaded name plus the markers
  (`env-clear.ts:58-70`). Lives in `constants.ts` so it goes through `readEnvFileContent`
  (`:118-123`, absent → `''`) and the same CRLF strip, and is tested beside its siblings.

### 2.3 Never overlaid

`NEVER_OVERLAID = PROTECTED_CHILD_ENV_NAMES ∪ {INFRA_KIT_SESSION, XDG_CACHE_HOME, CLAUDE_PROJECT_DIR, CLAUDE_PLUGIN_ROOT}`.
`PROTECTED_CHILD_ENV_NAMES` (`src/lib/mcp-proxy/protected-env.ts:9-24`: `PATH`, `HOME`, `TMPDIR`,
proxies, TLS) is reused, not copied — it already states why those names are plumbing. The four
additions are the names that decide WHICH session dir this process reads (`INFRA_KIT_SESSION`,
`XDG_CACHE_HOME`) and where the plugin is (`CLAUDE_*`): a Doppler config that defined
`INFRA_KIT_SESSION` would otherwise redirect the reader to another session on its next call.
Names in this set are skipped on assign AND on unset, with one stderr line naming them.

### 2.4 Protected configs — base design applies all; OPTIONAL writer-side gate (user decision pending)

**Base design (ships if the user says nothing):** the overlay applies every file in full, `prod`
included. Reasons: the user's overlay-ALL decision; F7 — `env-load` is ungated on either path today,
so the file's existence is already a decision the human (terminal) or the agent (MCP) has made; the
`protectedEnvs` policy gates *actions* (`assertDeployable` reads the setting + `isMcpMode()`, never
`process.env`) and holds identically after the overlay; and P1 — a human-typed `ik env-load -c prod`
is what every `Bash` child sees via zshenv, so the MCP process agreeing with it is the point.
**Honest limit, kept:** a human-loaded `prod` file IS overlaid into the MCP process, same as the shell.

**The user's menu — exactly two rows** (reader-side withholding is WITHDRAWN, not offered — B⁗):

| | Row | What the user says |
|---|---|---|
| (a) | **Writer-side gate — recommended** (Architect A15, Critic endorsed): `env-load` over MCP refuses a protected config unless the project allows agents on it | "gate on" |
| (b) | No gate — F7 stays as it is; the base design alone | nothing, or "no gate" |

**§2.4-opt — the writer-side gate (row (a)).** Its own commit (§4 step 5), landed AFTER the overlay
is proven by §6.1–§6.4, so it is declinable without touching the fix. Specification:

- **Refusal.** In `src/commands/env-load/env-load.ts`, after `selectedConfig` is known and before
  `writeEnvLoadFile` (`:297`): `if (isMcpMode() && isProtectedEnv(selectedConfig))` →
  `const access = await resolveProtectedEnvAccess()` (the command is already `async`; the policy is
  read once, at the one site that knows the config) → when `!access.allowed`, throw the standard
  `OperationError` — `reason: 'disallow'` → "this project sets `protectedEnvs` to disallow; to load
  it, set `protectedEnvs` to \"allow\" or \"cli-only\" in infra-kit.json"; `reason: 'mcp-blocked'` →
  "run `ik env-load -c prod` yourself in a terminal — this project sets `protectedEnvs: \"cli-only\"`"
  — the same two remediations `assertDeployable` already words (`protected-envs.ts:126-141`). **No
  file is written**: the check precedes the Doppler download, so the session dir is byte-identical
  before and after (the e2e asserts it).
- **The picker filters, so the refusal has an exit.** `createEnvLoadFormProvider`'s
  `buildRequestedSchema` (`env-load-form.ts:77-78`, `listProjectEnvs()`) filters protected envs out
  of the form's choices under `!access.allowed`, exactly as `deploy-form.ts:162` does with
  `deployableEnvs(…, await resolveProtectedEnvAccess())` (`protected-envs.ts:97-103`). Without this a
  human could pick `prod` from the form and be refused for picking it — refusal-with-no-exit again.
  Under `'allow'` the form lists it.
- **One rule, two sites (R2-1).** Under `isMcpMode()` and `!access.allowed`: the PICKER (the
  `env-load` form) filters protected configs out, and the REFUSAL in `envLoad` is the backstop for a
  typed `config` argument that bypassed the form. Both read the same `resolveProtectedEnvAccess()`;
  neither can disagree with the other. `env-list` is a report, not a picker — it keeps listing every
  env that exists (with its token status), as `readWorkflowEnvOptions` keeps listing `prod` for the
  deploy form to filter.
- **Unchanged.** The typed CLI path (`isMcpMode()` false → no check, no filtering); flow 1 with
  human-loaded prod (§2.8); the overlay (§2.1–§2.3) — the gate never reads the file.
- **Skill text.** One sentence in `plugins/infra-kit/skills/session/SKILL.md` Requirements: "A
  protected environment (`prod`) is refused over MCP unless the project's `protectedEnvs` allows
  agents on it; a human loads it with `ik env-load -c prod` in the terminal."
- **Cost:** ~12 lines in `env-load.ts`, ~6 in `env-load-form.ts`, one unit table, one e2e lane, one
  skill sentence; one more `getInfraKitConfig` read on the protected path only. **Benefit:** the
  agent cannot put prod into THIS session — neither the MCP process nor the `Bash` tool's env —
  without a human typing it, and the enum keeps its one documented meaning (F7).
- **Lanes:** AC13 (refusal + picker cases), §6.1 (unit tables for `env-load` and `env-load-form`), §6.4 E-SE10. They are the gate's ONLY lanes; the rev-1
  withheld-prod lanes (AC12/E-SE9 of that revision) are gone, not replaced by these.

If the user says nothing, row (b) ships: the base design, and §2.4-opt stays in §9.

### 2.5 The chokepoint edit — `src/lib/tool-handler/tool-handler.ts`

Insert after `commandEcho.reset()` (`:580`) and before `resolveStop` (`:587`) (A5):

```ts
      // The env-load file lands mid-session, and every read from here on is `process.env` at call
      // time (Jira, the INFRA_KIT_ENV_* markers, the env children inherit). Applied at the call's
      // ENTRY so the gate, the form and the handler all run under one environment; synchronous so
      // a concurrently dispatched call cannot see a half-applied one.
      applySessionEnv()
```

`applySessionEnv` never throws (every fs call is inside its own try; a corrupt file parses to
whatever assignments survive, as `source` would). It logs through the existing `logger`, one string
line: `session-env applied: set [JIRA_BASE_URL, …] unset [] (load, 16 vars)` on `changed:true`,
nothing on `changed:false`. **Names only, never values, in both sinks (P5, F13).**

`createToolHandler` gains an optional `applySessionEnv?: () => void` in `ToolHandlerArgs` defaulting
to the real one — the types agree: the real function returns a plain object, which `() => void`
accepts, and the unit lane pins that the return is not a thenable (AC6). Injectable for the same
reason `confirmCodec` is (`:41-42`): the ordering tests use a spy, and the mutation build must not
touch the real session dir.

### 2.6 Concurrency — why synchronous is the safety property

The v2 SDK dispatches every request as `Promise.resolve().then(() => handler(request, ctx))` with no
queue (`@modelcontextprotocol/server@2.0.0`, `_onrequest`), and Claude Code runs the tool calls of one
assistant turn concurrently — two MCP calls DO overlap. The design is safe because `applySessionEnv`
is synchronous: stat, read, parse, restore, assign — no `await` — so one apply is atomic with respect
to the event loop; two overlapping calls cannot interleave their restore/overlay halves, and
`process.env` is always ONE full result of `apply(baseline, state)`, never a mix. The residual
exposure is an in-flight call whose *later* `process.env` read sees a newer apply from the other call
— the terminal's behaviour when a load lands between two commands, and bounded because the Jira
reads (F6) happen at the start of each command (`release-create.ts:386`). Pinned by two unit lanes
(§6.1): the return value is not a thenable; and two applies of different states started without
awaiting leave `process.env` deep-equal to one of the two full results. No lock, no queue. The
Architect's A14 plan/commit split is needed only if an `await` survives inside the apply; under
apply-all (§2.4) none does — the only candidate was the policy read of the withdrawn B⁗ — so the
module keeps ONE synchronous function, and the non-thenable lane is what keeps it that way.

### 2.7 `env-status` over MCP, `env-load`'s description, one remediation

- `env-status` needs **no code change**: after the overlay its marker reads (`env-status.ts:38-42`)
  and its `v in process.env` count (`:49-51`) describe the file. Its tool description gains one clause:
  "Over MCP this reflects the session file as of this call — the server re-reads it before every tool."
- `env-load`'s description (`env-load.ts:541-543`) keeps "Does NOT mutate the calling process" (true:
  it mutates nothing during the call) and adds: "This server picks the file up on its next tool call,
  so a tool that needs the variables can be called right after."
- `release-remove.ts:226-236`: the comment's "an MCP server spawned by a host does not inherit an
  `ik env-load`ed shell" and the remediation "in the environment the MCP server was launched with"
  become: "call `env-load` for a config that carries JIRA_BASE_URL / JIRA_TOKEN / JIRA_PROJECT_ID /
  JIRA_EMAIL, then re-call; or ask a human to run `infra-kit release remove --skip-jira` from a
  configured shell". `assertMcpRemoveInput`'s `skipJira` refusal is unchanged, so the loop the comment
  describes stays closed. `release-create.ts:348` unchanged (F11).

### 2.8 The two flows — the old one keeps working unchanged (user decision)

**Flow 1 (old, must not change):** `ik env-load -c dev` in the terminal → the shell sources the file
→ launch Claude Code → the server inherits the vars. **Flow 2 (new):** launch Claude Code →
`/infra-kit:session dev` → the next tool sees the vars. Both go through the same function
`apply(baseline, state)`; the table is what it yields at each moment. The right-hand column is what a
FRESH zsh child of Claude Code sees at the same moment (the zshenv rule, F3) — which is the `Bash`
tool, and which is NOT always the interactive terminal (see the two-directional note below).

| Moment | Baseline | Disk (session dir) | Server after apply | Fresh zsh child (`Bash`) |
|---|---|---|---|---|
| Flow 1, first tool call | has `dev` vars + markers | `env-load.sh` (same values, written before launch) | baseline ⊕ same values ⇒ **unchanged** (every assignment already holds) | `dev` — **same** |
| Flow 1, then `ik env-load -c arthur` in the terminal | `dev` | `env-load.sh` = `arthur` (newer) | `dev` names not in `arthur` restored from baseline (still `dev` values), `arthur` names assigned | Claude Code's launch env (`dev`) + `source arthur` — **same** |
| Flow 1, then `env-clear` in the terminal AFTER launch | `dev` | `env-clear.sh` written (`unset` of every name the load file held + markers, `env-clear.ts:58-70`), `env-load.sh` deleted (`:104`) | `clear` branch: every `unset` name deleted from `process.env` **including the ones the baseline holds**, `INFRA_KIT_ENV_CLEARED='1'` set | launch env + the same `unset` lines sourced — **same** |
| **Flow 1, clear, then `ik env-load -c arthur` (A13)** | `dev` | `env-load.sh` = `arthur`, newer than the clear | restore `touched` (the `dev` pairs come BACK from the baseline), then overlay `arthur` ⇒ `dev`∪`arthur` | launch env (`dev`) + `source arthur` ⇒ `dev`∪`arthur` — **same**; the INTERACTIVE terminal has `arthur` only (its `dev` was unset by the clear and `source arthur` does not bring it back) |
| Flow 1, `env-clear` when the terminal had only a WARM-sourced env and no session file | `dev` (warm) | nothing — `env-clear` throws "No loaded environment found" (`env-clear.ts:86`) and writes no clear file | `none` ⇒ baseline stands | launch env — **same** (the clear failed in the terminal too) |
| Flow 2, before any load | no `dev` vars | nothing | `none` ⇒ baseline | none — **same** |
| Flow 2, after `/infra-kit:session dev` | no `dev` vars | `env-load.sh` | `load` ⇒ `dev` assigned | `dev` — **same** |
| Flow 2, `dev` then `arthur` | no `dev` vars | `env-load.sh` = `arthur` | `dev`-only names absent (restored to "absent"), `arthur` assigned | `arthur` only — **same**; the INTERACTIVE terminal that sourced `dev` first still holds `dev`-only names |
| Flow 2, then `env-clear` (MCP or terminal) | no `dev` vars | clear newer, load deleted | `clear` ⇒ `dev` names deleted | cleared — **same** |

The clear case is why the module keeps the `unset` NAMES rather than "restore to baseline": a
baseline that already held the vars can only be brought to the shell's state by subtracting the
names the clear file lists, and `env-clear` writes exactly the names the shell will unset (from the
load file that existed at clear time, `env-clear.ts:92`). The subtraction is NOT irreversible: the
names go into `touched`, so the next apply restores them from the baseline before overlaying — which
is what produces the A13 row. The `INFRA_KIT_ENV_CLEARED` guard that makes the shell's auto-loader
skip until an explicit load (`env-load.ts:100`) needs no server equivalent: the server never auto-loads.

**Two-directional note (A13).** The server equals a FRESH zsh child of Claude Code — the `Bash`
tool — at every row. It does not always equal the INTERACTIVE terminal, in either direction: in flow
1 (clear → load of another config) the server and the `Bash` tool RESURRECT the pre-launch pairs from
the baseline and hold MORE than the terminal; in flow 2 (`dev` → `arthur`) they hold FEWER (no
`dev`-only leftovers). P1 as written — "what a zsh child of the terminal sees" — holds exactly; "the
terminal" in the loose sense does not, and the ADR says so.

### 2.9 Skill and doc text

- `plugins/infra-kit/skills/session/SKILL.md:52-54` — replace the "Never verify a load with
  `env-status` over MCP … frozen" sentences with: "`env-status` over MCP reads the session file as of
  that call — the server re-applies it before every tool — so it is a truthful check that the load
  landed for THIS session id, though never of what the terminal prompt shows yet (C4)." `:137` bullet
  → "`env-status` over MCP confirms the file the server will use; it does not confirm the terminal."
  Requires CLI ≥ the version that ships §2.5; the skill states the floor once in its Requirements.
- `plugins/infra-kit/skills/release-remove/SKILL.md:32-36` — "must be in the environment the MCP
  server was launched with … A server spawned by a host does not inherit an `ik env-load`ed shell" →
  "must be loaded for this session (`/infra-kit:session <env>` or `ik env-load` in the terminal that
  launched Claude Code); the server reads the session file before every tool, so a load made a moment
  ago counts."
- `plugins/infra-kit/skills/release-create/SKILL.md:27-29` — same sentence.
- `docs/session-zshenv-plan.md` — no edit (historical); this plan supersedes its `:516` residue.
- Plugin version `0.7.10` → `0.7.11` (`plugins/infra-kit/.claude-plugin/plugin.json`); `.mcp.json`
  unchanged (D3).

## 3. Pre-mortem

- **S1 — the baseline is captured AFTER something else mutated `process.env`.** `dev-wizard-run.ts:449`
  and `dev-server.ts:1206-1207` write `process.env` — not MCP-exposed (F6), but any future in-process
  writer before the first tool call would be frozen into the baseline and "restored" forever.
  *Mitigation:* capture lazily (F10 forbids the factory), assert in the unit test that the baseline
  equals `process.env` at first call, and pin in `dependency-and-bundle-guards.test.ts` that no module
  under `src/mcp/` or `src/lib/tool-handler/` matches `process\.env(\[[^\]]+\]|\.\w+)\s*(\?\?)?=(?!=)` (A9:
  the `??=` form included; the `(?!=)` keeps `===` comparisons out — N1). The overlay's own writes are restored before every apply, so they can
  never leak into a later baseline.
- **S2 — a load lands between round 1 (gate) and round 2 (confirm) and the arguments the human
  approved now run under different credentials.** The token binds tool name + canonical args
  (`confirm-token.ts:164-190`), not the environment, so round 2 verifies. *Mitigation:* this is the
  terminal's behaviour too (`ik env-load` between typing a command and pressing Enter), and the gate
  text already says which tool and which args; not a regression. Stated in the ADR consequences, not
  engineered around.
- **S3 — the file is half-written or vanishes mid-read.** `atomicWriteFileSync` renames, so a reader
  sees the old file or the new one, never a torn one; `env-clear` writes `env-clear.sh` THEN deletes
  `env-load.sh` (`env-clear.ts:100-104`), and in that window the clear is newer → the reader takes the
  clear branch, the state the shell converges to one prompt later. If `env-load.sh` vanishes between
  `statSync` and `readFileSync`, `readEnvFileContent` returns `''` (`constants.ts:118-123`) and the
  apply yields zero vars under a `load` signature whose inode no longer exists; the next call re-stats
  and corrects. *Pinned* by a unit lane (§6.1: `readFileSync` mocked to throw `ENOENT` once — bounded
  to one call, no exception, corrected on the next).
- **S4 — a Doppler config defines a plumbing name.** `PATH=` in the file would ENOENT every `gh`
  spawn. *Mitigation:* §2.3, with the proxy's set reused so the two overlays cannot disagree about
  what plumbing is.
- **S5 — no session id.** Desktop-app / IDE / no-rc launches keep the defect (scope line, A8).
  *Mitigation:* one stderr line per process; `doctor`'s `INFRA_KIT_SESSION` row already names the
  cause; the skill's `Terminal status at invocation` block surfaces `{"error":…}` first.

## 4. Execution — files, ordered commits

1. `[BE] constants: parseUnsetNamesFromEnvFile` — `constants.ts` + `constants.test.ts` (unit, §6.1).
2. `[BE] session-env: the zshenv rule as an in-process overlay` — `src/lib/session-env/{index,session-env}.ts`
   + `__tests__/session-env.test.ts` (§6.1, §6.2b). No caller yet; ships dark.
3. `[BE] tool-handler: apply the session env at every call's entry` — `tool-handler.ts` (§2.5),
   `tool-handler.test.ts` ordering lanes (§6.2), `env-status`/`env-load` descriptions, `release-remove.ts`
   comment + remediation (§2.7), `dependency-and-bundle-guards.test.ts` pins (S1, §6.3).
4. `[BE] mcp e2e: a mid-session load is visible to the next tool` — `mcp-stdio.e2e.test.ts` lanes
   E-SE1–E-SE9 (§6.4); the fixture gains one `git commit` (§6.4).
5. *(optional, §2.4-opt row (a), only on the user's word)* `[BE] env-load: refuse a protected config over MCP unless the project allows agents on it` — `env-load.ts`, `env-load-form.ts`, their tests, E-SE10, the session-skill sentence. Its own commit AFTER step 4 is green, so declining it touches nothing above.
6. Publish the CLI (memory: user runs each `pnpm publish` via `!`; verify with `pnpm view`), then on
   the consumer machine `pnpm add -g infra-kit@<exact version> ; infra-kit version` — the exact
   version, because `@latest` is served from a stale metadata cache (memory), and consumer repos run
   the GLOBAL binary, so V0 against an un-updated global proves nothing.
7. `[DO] plugin: skills stop calling the server's environment frozen` — the three SKILL.md edits (§2.9),
   `plugin.json` 0.7.11, `manifest.test.mjs` if a pinned literal moves.
8. Stamp this document `implemented` with the commit list.

Release order is CLI first, plugin second: a plugin that says "the server re-reads the file" against
a straggler CLI would be lying; the reverse (new CLI, old skill text) is merely over-cautious. The
doctor skew report (`plugins/infra-kit/__tests__/skew-report.test.mjs`) already surfaces the pair.

## 5. Acceptance criteria

- **AC1 (positive identity, F14)** — Given a running `infra-kit mcp` launched WITHOUT `JIRA_*` into
  the env-picker fixture repo (committed, no `origin`), when the client writes an `env-load.sh`
  carrying `JIRA_BASE_URL='http://127.0.0.1:1'`, `JIRA_TOKEN='jira-sentinel-8f3a'`, `JIRA_PROJECT_ID='1'`,
  `JIRA_EMAIL='sentinel@example.invalid'` into the sandboxed session dir and then completes a
  gate+confirm `release-create {releases:[{version:'1.2.5', type:'regular'}]}`, the result is NOT an
  error: `structuredContent.failureCount === 1` and `failedReleases[0].error` matches
  `/create release v1\.2\.5 \(regular\)/` AND `/origin/` (the `git fetch origin` refusal caught by
  `executeOne`, `release-create.ts:336-355`) and `not.toMatch(/incomplete/)`. That payload shape is
  reachable ONLY after `loadJiraConfig` (`:386`) returned — without the overlay the call is a thrown
  tool error, never a `failedReleases` entry. The in-process positive proof is §6.2b.
- **AC2** — Same server, `env-status` after the write reports `sessionConfig` from the file's
  `INFRA_KIT_ENV_CONFIG` line and `sessionLoadedCount === sessionTotalCount`; after writing
  `env-clear.sh` and deleting `env-load.sh`, `env-status` reports no env loaded with `cleared: true`;
  after a fresh `env-load.sh` (newer than the clear), loaded again. No restart between the three.
- **AC3** — Across AC1–AC2 no serialized tool result and no stderr line contains the secret-shaped
  sentinels `jira-sentinel-8f3a` or `sentinel@example.invalid`; the URL `127.0.0.1:1` is exempt (it
  legitimately surfaces in a connection error and in the `err` the handler logs, `tool-handler.ts:597`).
  stderr contains `session-env applied: set [` with the NAMES on each change and nothing on an
  unchanged call.
- **AC4** — A file line `PATH='/nowhere'` or `INFRA_KIT_SESSION='other'` is skipped (stderr names it)
  and the server's `PATH`/session dir are unchanged.
- **AC5** — Unit: `applySessionEnv` is a pure function of `(baseline, state)`: apply(load A) →
  apply(clear) → apply(none) leaves `process.env` deep-equal to the baseline (the `Bash`-child
  parallel of §2.1 is why `none` restores); apply(load A) twice with the same signature parses once;
  a baseline var named in the clear's `unset` list is absent after the clear and present again after
  `none`; **(A13)** with a baseline holding `dev`, apply(clear of `dev`) → apply(load `arthur`) yields
  `dev`∪`arthur` with `arthur` winning per name.
- **AC6** — Unit: the chokepoint calls `applySessionEnv` exactly once per call, before `resolveStop`,
  on every `GateState` path (`run`, `form`, `gate`, `verify`, `declined`, `run-form`); its return
  value has no `then` (not a thenable).
- **AC7** — The existing `sec` lane (`mcp-stdio.e2e.test.ts:1241-1296`) passes unchanged; its meaning
  shifts from "the file is not read into the process" to "the value is not echoed"
  (`sessionLoadedCount` 0→1, which the lane does not match on). The confirm-gate mutation build
  (`mcp-confirm-gate-mutation.test.ts`) passes with the injected no-op overlay.
- **AC8** — `grep` for the three literals "frozen when Claude Code launched", "the environment the MCP
  server was launched with", "does not inherit an `ik env-load`ed shell" over `plugins/infra-kit` and
  `apps/infra-kit/cli/src` exits 1.
- **AC9 (old flow unchanged)** — A server spawned with `env` = `{...harness env, ...parseVarsFromEnvFile(file)}`
  (the same file that is on disk, values + markers, never hand-typed) reports on its first
  `env-status` the hand-pinned payload `{ sessionConfig: 'dev', sessionProject: 'env-picker-project',
  sessionLoadedCount: 2, sessionTotalCount: 2, autoLoaded: false, cleared: false, sessionLoadedAt: <the file's INFRA_KIT_ENV_LOADED_AT> }`
  — the same object the pre-fix server reports for that launch, because every marker comes from the
  inherited env. Unit half: the first apply reports `changed:true` with every name already equal and
  `process.env` deep-equal before and after.
- **AC10 (clear after launch, old flow)** — Same server; the test then writes `env-clear.sh` (the
  real `buildEnvClearLines` over the file's names) and deletes `env-load.sh`. The next `env-status`
  reports no env loaded with `cleared: true`, and `loadJiraConfig` (via `release-create`, or §6.2b)
  rejects as "incomplete" — the inherited vars are gone from the server, as they are from the shell.
- **AC11 (the two flows agree)** — Two servers over the same session dir and the same file: S1
  launched flow-1 style (`env` built by `parseVarsFromEnvFile` over that file, as in AC9), S2 launched
  flow-2 style (nothing from the file in `env`), the file present before S2's first call. After one
  `env-status` each, the two `structuredContent` payloads are deep-equal on every field —
  `sessionId` included, since both inherit the same `INFRA_KIT_SESSION`. After the clear of AC10
  applied to both, deep-equal again.
- **AC12 (prod is applied like any file)** — A file whose `INFRA_KIT_ENV_CONFIG='prod'` is overlaid
  in full regardless of `protectedEnvs`; `env-status` reports `prod: N of N`; a
  `gh-release-deploy-all {env:'prod'}` gate+confirm on the same server is still refused by
  `assertDeployable` (`protected-envs.ts:117-141`) — the possession/action split, observed.
- **AC13 (optional, §2.4-opt — only if the user picks row (a))** — `env-load {config:'prod'}` over
  MCP on a project with no `protectedEnvs` key is refused with `reason: 'disallow'`; with
  `protectedEnvs: 'cli-only'` refused with `'mcp-blocked'` naming `ik env-load -c prod`; in both cases
  the session dir's listing and every file's `ino`+`mtime` are identical before and after (no file
  written, no Doppler call — the fixture's stub records none). With `'allow'` it writes. The `env-load`
  form's choices omit `prod` under `'disallow'`/`'cli-only'` and include it under `'allow'`.
  A typed `config:'prod'` that bypasses the form is refused by the same backstop (R2-1).
  `ik env-load -c prod` (typed CLI, `isMcpMode()` false) writes under every setting. **N2:** "with
  `'allow'` it writes" is asserted only in the mocked §6.1 unit table; in E-SE10 the fixture stubs no
  `doppler` and holds no `prod` token, so the observable there is "the protected-env refusal is NOT
  raised — the failure is the token/doppler error", and the session dir still gains no file.

## 6. Test plan

### 6.1 Unit

- `constants.test.ts`: `parseUnsetNamesFromEnvFile` on a real `buildEnvClearLines` output and a real
  manual-load `buildEnvLoadFileLines` output (the two `unset` lines), CRLF, absent file → `[]`, a
  quoted value containing the text `unset X` on a continuation line is NOT a match.
- `session-env.test.ts` (temp dir + `XDG_CACHE_HOME`/`INFRA_KIT_SESSION` like `makeDisposableSession`):
  the state table — no files → `none`; load only → `load`; clear only → `clear`; both with load newer
  → `load`; both with clear newer → `clear`; equal mtimes → `load` (the zshenv tie, F3);
  `INFRA_KIT_SESSION` unset → `no-session` and one log line. The §2.8 rows: flow-1 idempotence (AC9
  unit half), clear-subtraction (AC10), clear→load resurrection (A13, AC5). AC5, AC4. "Signature
  unchanged → `changed:false` and `parseVarsFromEnvFile` not called" and "same content rewritten
  atomically → new `ino` → re-parsed" (spy via `vi.mock` of the constants module — memory: `vi.spyOn`
  cannot intercept named imports). **Concurrency (A4/A14):** `typeof applySessionEnv(...).then === 'undefined'`;
  and two applies of different states started back-to-back without awaiting anything leave
  `process.env` deep-equal to exactly one of the two full results (never a mix). **S3:**
  `readFileSync` mocked to throw `ENOENT` once → zero-var `load`, no throw, corrected on the next
  apply. *(optional, §2.4-opt row (a))* `env-load.test.ts`: the three-setting × two-mode table of
  AC13 with `resolveProtectedEnvAccess` mocked at the module boundary, asserting `writeEnvLoadFile`
  is never reached on a refusal; `env-load-form.test.ts`: the choices omit/include `prod` per setting.

### 6.2 Integration — `tool-handler.test.ts`

New `describe('createToolHandler — session env')`: inject `applySessionEnv` as a spy; one lane per
`GateState` asserting AC6 (called once, before the codec/provider/handler spies, on every path).

### 6.2b Integration — the read site, in-process (`session-env.test.ts`) — THE primary positive proof

Launch-less proof that the overlay reaches a real consumer: with no `JIRA_*` in `process.env`,
`loadJiraConfig()` rejects with `Jira configuration is required but incomplete`; after writing an
`env-load.sh` with the four names and calling `applySessionEnv()`, it resolves to the file's values;
after `env-clear.sh` + delete + `applySessionEnv()`, it rejects again. Deterministic, no spawn, no
network. The e2e (E-SE4) corroborates the same fact through the real spawned process.

### 6.3 Bundle guard

`dependency-and-bundle-guards.test.ts`: `src/lib/session-env` is in the `mcp.js` bundle and
`src/lib/tool-handler/tool-handler.ts` imports it (a delete of the four-line insertion is a red test,
not a silent regression); the S1 writer regex (incl. `??=`) matches nothing under `src/mcp/` and
`src/lib/tool-handler/`.

### 6.4 e2e — `mcp-stdio.e2e.test.ts`

New `describe('e-se — a mid-session load is visible to the next tool')` on `makeEnvPickerFixture`
+ `makeDisposableSession` style sandboxing, one long-lived modern client. The fixture gains one
`git add -A && git commit -m fixture` in `makeEnvPickerFixture` so `assertCleanCheckout` passes
(stated here, not "verify in the lane"); it has no `origin`, which is what AC1's identity relies on.
Every hand-written file uses the ASSIGNMENT form (`FOO='…'`, `mcp-stdio.e2e.test.ts:1263`), never the
harness's `export FOO=bar` (A10, F4).

- E-SE1 (AC2 load), E-SE2 (AC2 clear), E-SE3 (AC2 reload), E-SE4 (AC1 through gate+confirm on the
  same connection — the gate is taken BEFORE the file is written and the confirm AFTER, so the round-2
  token minted under the old environment must still verify: the D1 claim as a test), E-SE5 (AC3/AC4
  over stderr via the existing `stderrSince` helper).
- E-SE6 (AC9, flow 1): a second server whose `env` is built by `parseVarsFromEnvFile` over the file on
  disk; `env-status` equals the hand-pinned payload; E-SE7 (AC10): clear file written + load deleted →
  `env-status` cleared and `release-create` refused as incomplete; E-SE8 (AC11): the S1/S2
  `structuredContent` deep-equality, loaded and cleared; E-SE9 (AC12): a `prod` file applied in full,
  `gh-release-deploy-all {env:'prod'}` still refused. *(optional, row (a))* E-SE10 (AC13): the
  three-setting refusal/write table over the wire, the session dir snapshot (listing + `ino`/`mtime`)
  equal before and after each refusal, the `gh`/`doppler` stubs recording no call, and the form's
  choices with and without `prod`.
  Memory: the file is serialized in one fork on purpose (`:29-31`); lanes are appended, not split out.

### 6.5 Observability

String lines, names only, in both sinks (F13): `session-env: INFRA_KIT_SESSION unset — no overlay`
(once); `session-env applied: set [A, B] unset [C] (load, <n> vars)` / `(clear)` / `(none)`;
`session-env: skipped protected names [PATH]`. Nothing on an unchanged signature.

### 6.6 Manual — V0 (recorded in `docs/reviews/mcp-session-env-v0.md`)

After step 6 of §4 (`infra-kit version` prints the published version). Fresh terminal with NO env
loaded → launch Claude Code → `/infra-kit:session dev` → `/infra-kit:release-create <name>` → gate →
confirm → the Jira step runs (or fails as `auth` on the dead token, out of scope — either proves the
read). Then `env-clear` in the terminal → `env-status` over MCP says cleared. Record the stderr names
line.

## 7. Verification commands

```
cd apps/infra-kit/cli
pnpm exec vitest run src/lib/constants src/lib/session-env src/lib/tool-handler ; echo EXIT=$?
pnpm exec vitest run src/mcp/__tests__/mcp-stdio.e2e.test.ts src/mcp/__tests__/mcp-confirm-gate-mutation.test.ts src/mcp/__tests__/dependency-and-bundle-guards.test.ts ; echo EXIT=$?
pnpm run qa ; echo EXIT=$?
cd ../../.. && pnpm run test:claude ; echo EXIT=$?
grep -rn 'frozen when Claude Code launched\|environment the MCP server was launched with\|does not inherit an `ik env-load`ed shell' plugins/infra-kit apps/infra-kit/cli/src ; echo EXIT=$?   # expect 1
```

Gate on the echoed `EXIT=` (memory: rtk swallows exit codes). Re-run `lock.test`/`portless-driver.test`
alone before calling a full-suite red a regression (memory: pre-existing timing flakes). No root
`pnpm run qa`, no `vendor/` edits.

## 8. Non-goals

- The dead `JIRA_TOKEN` in Doppler (`docs/jira-401-misreported-as-404-plan.md`).
- `ik-mcp` stays for foreign servers; no change to its all-or-nothing rule, its fallback profile or
  its detectors. No `infra-kit` entry behind it.
- `env-status` reporting what the *interactive terminal* shows (C4 of the zshenv plan) — the server
  cannot know that and the skill keeps saying so.
- The auto-loader (`env-autoload.ts`) and its `isClearedOnDisk` tie-break — a writer's guard, untouched.
- Any Claude Code hook, `CLAUDE_ENV_FILE`, or `/mcp` reconnect trick.
- Reader-side withholding of any name or file (B‴, B⁗).

## 9. Follow-ups

- §2.4-opt, if the user switches it on later rather than now.
- Whether `ik-mcp` should adopt `parseUnsetNamesFromEnvFile` so its own "credentials cleared" reading
  agrees with the zshenv rule (today it only watches the load file's listed names).

## 10. ADR

- **Decision.** The MCP tool chokepoint (`tool-handler.ts:580`, at the call's entry) synchronously
  re-derives `process.env` from the launch baseline plus the session's `env-load.sh`/`env-clear.sh`
  under the zshenv rule before every tool call; every file is applied in full; `env-status`, the Jira
  reads and every child spawn see the current session env with no restart. `ik-mcp` is not used for
  infra-kit's own server.
- **Drivers.** D1 the process must survive (confirm token, F9); D2 the server is the file's writer;
  D3 CLI-only blast radius.
- **Alternatives considered.** A `ik-mcp` wrapper (writer-vs-reader self-kill race + era/capability
  fallback + detector lockstep; the all-or-nothing rule and the per-process key are cheap to fix and
  are NOT the ground); C threaded env object (the ALL-vars decision, children included, rules it out);
  D Bash routing (bypasses the gate and the skills); E docs (the reported cost); B′/B″/B‴/B⁗ variants.
- **Why chosen.** One seam already exists and is exclusive (F1); the writer and the reader are the same
  process (F2); the parsers exist (F4); the rule for "loaded now" exists and is pinned by the shell
  (F3); the fix is ~120 lines plus four at the seam, dark until commit 3, and needs no manifest change.
- **Consequences.**
  - *T1 — P1 over least privilege.* "Loaded" has one definition, so the MCP process holds every
    variable of every file the session loads, `prod` included; least privilege for an agent-driven
    process is deferred to the writer-side gate (§2.4-opt), the one site that can gate possession
    without a second definition. A human-loaded `prod` file is overlaid — same as the shell.
  - A long-lived child spawned by an MCP tool (`reopen` → the cmux workspace, `open-dev-workspace.ts:37`)
    keeps the environment of the call that spawned it across later clears — as a terminal's children do.
  - A load landing between a gate and its confirm changes the credentials the confirmed call runs
    under, as in a terminal (S2). Overlapping tool calls share one environment, each apply atomic;
    an in-flight call's later read may see the newer one (§2.6).
  - The server equals a FRESH zsh child of Claude Code — the `Bash` tool — and not always the
    interactive terminal, in BOTH directions: after a flow-1 clear → load of another config it
    resurrects the pre-launch pairs from the baseline (holds MORE than the terminal); after a flow-2
    `dev` → `arthur` it drops `dev`-only leftovers (holds FEWER). (A13, §2.8.)
  - P5's two sinks: stderr and the world-readable `/tmp/mcp-infra-kit.log` (F13) — the overlay's log
    is a names-only string line; no log object ever gets a `vars` field.
  - The old pre-launch flow is unchanged: the overlay is idempotent over an environment that already
    holds the file's values, and a terminal `env-clear` after launch subtracts the clear file's names
    from the inherited baseline (§2.8, AC9–AC11).
  - The "never verify with `env-status` over MCP" rule flips to "it verifies the file, not the prompt".
  - Sessions without `INFRA_KIT_SESSION` are out of scope and say so once on stderr (A8, S5).
- **Follow-ups.** §9; V0 recorded in `docs/reviews/mcp-session-env-v0.md`; this document stamped
  `implemented` with the commit list.

## 11. Revision 2 changes

Blocking (Critic numbering; Architect letters where they coincide): **1/A1** §1.5 row A rewritten on
writer-vs-reader + (3)+(4), with F9's injectable key and the optional-vars cost stated;
**2/A3** P2 reworded; **3/A4** §2.6 rewritten on SDK microtask dispatch + Claude Code parallelism,
`applySessionEnv` fully synchronous, §2.1/§2.5 types agree (`() => void`), non-thenable lane;
**4** reader-side withholding dropped (now B⁗ in §1.5), base design applies all, §2.4-opt writer-side
gate with AC13 + lanes + cost/benefit, "truthful, self-explaining" deleted, AC12/E-SE9 rewritten as
"prod applied like any file, deploy gate still holds"; **5/A6** ADR consequences: T1 tension,
long-lived child, log sink; **6/A8** scope line under the defect; **7** AC1 is a positive identity
(`failedReleases[0].error` after `loadJiraConfig`, F14) with the fixture commit stated in §6.4;
**8** AC9 hand-pinned payload + unit half; **9** AC3 sentinels are secret-shaped, URL exempt;
**10** AC11 rewritten, S1's env built by `parseVarsFromEnvFile`; **11/A10** assignment-form seeding
in §6.4 and F4; **12** §7 uses root `pnpm run test:claude`; §4 step 6 adds the exact-version global
install before V0. **A13** two-directional statement in §2.8 note + ADR, the clear→load row, the AC5
lane. **A14** satisfied by the synchronous apply (no plan/commit split needed once no `await` exists);
the two-overlapping-applies lane is in §6.1.

Non-blocking applied: **13/A5** overlay moved before `resolveStop`, P6 added, F1's sentence corrected
(`env-load-form.ts:46`); **14** `ino` in the signature (supersedes A11); **15/A2** row C clause;
**16/A7** state-`none` sentence in §2.1; **17/A9** `??=` in the S1 regex; **18/A12** `for…of` in §2.1;
**19** S3 unit lane; **20** third AC8 literal; **21** the "Idempotent" JSDoc sentence replaced by the
why; **22** §6.2b marked the primary positive proof; S5 added to the pre-mortem.

Addendum (Critic's conditions on A15, relayed by the lead): §2.4 now carries the two-row menu
(writer gate recommended / no gate; reader-side withholding withdrawn), the gate is its own commit
after the overlay is proven (§4 step 5), refuses with the standard `PROTECTED_ENV_DENIED`/`mcp-blocked`
remediation and writes NO file (AC13 asserts the session dir unchanged), the env picker filters
protected configs per the `deploy-form.ts:162` precedent, one session-skill sentence, and its lanes
are the gate's only lanes. P1's comparator pinned to "a zsh child of Claude Code — the `Bash` tool".
A14: stated in §2.6 that no `await` survives under apply-all, so the single synchronous function stays.

Round-2 fixes (Architect round 2): **R2-1** §2.4-opt states one rule at two sites — the `env-load`
form filters protected configs under `isMcpMode()` per `deploy-form.ts:162`, the `envLoad` refusal is
the backstop for a typed `config`; `env-list` is named as a report, not a picker; AC13 and §6.1 carry
the picker case. **R2-2** §4 step 4 reads E-SE1–E-SE9; the gate's lane is E-SE10 everywhere it is
referenced (§2.4-opt, §4 step 5, §6.1, §6.4).

Implementation notes (Critic round 2, non-blocking, folded without re-review): **N1** the S1 guard
regex ends `=(?!=)` so `===` comparisons do not match; **N2** E-SE10's `'allow'` case observes
"refusal not raised; failure is the token/doppler error", and "writes" is the §6.1 unit table's claim.

**Consensus: Architect round 2b SOUND, Critic round 2 APPROVE, 2026-09-15.**

Declined: **A11** as worded ("state the aliasing bound") — superseded by item 14, which removes the
bound instead of stating it. Nothing else declined.

## 12. Implementation deviations (recorded at stamp time)

- §2.1: `applySessionEnv`'s default state is read through the signature check
  (`readSessionEnvStateIfMoved()`), not `readSessionEnvState()` — the plan's literal default parses
  before comparing, which makes "unchanged signature → not parsed" unsatisfiable. `readSessionEnvState`'s
  default dir comes from a catching `resolveSessionDir()` so a missing `INFRA_KIT_SESSION` never
  propagates as a throw.
- §2.8 / `(clear)` log line: the real `buildEnvClearLines` lists the five `INFRA_KIT_ENV_*` marker
  names twice; the overlay mirrors the file rather than deduplicating, and the unit test pins that.
- §3 S1 guard regex is spelled with non-capturing groups (`(?:…)`) — the same match set — because
  `regexp/no-unused-capturing-group` is an eslint error in this package.
- §6.4: the fixture's `git commit` lives in the e-se lane (`commitFixtureRepo`), not in
  `makeEnvPickerFixture` — the fixture file was dirty in another session's hands at implementation
  time; the lane also strips `JIRA_*` from its own spawn env (`withoutJira`) for the same reason.
- AC9's pinned counts are `9 of 9`, not `2 of 2`: `parseVarNamesFromEnvFile` counts the five marker
  assignments `buildEnvLoadFileLines` appends alongside the four Jira pairs.
- E-SE9 passes an explicit `version` with `env:'prod'`: without one the handler enters the release
  picker (gh + Jira + a form) before `assertDeployable`, so the veto would not be the thing under test.
- The w1 differential block gained delta D21 (the `env-status` description) and the D18 literal moved
  to the new `env-load` text — both AUTHORED deltas of the §2.7 description edits.
