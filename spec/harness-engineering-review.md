# Harness Engineering Review — `infra-kit`

> Review date: 2026-05-10
> Scope: Audit `infra-kit`'s MCP/CLI surface against current harness-engineering practice for parallel multi-agent workflows (Doppler + git worktrees + custom CLI utils), and produce a prioritized backlog.

## Context

`infra-kit` is a pnpm monorepo (`apps/infra-kit/cli`) that ships a Commander CLI **and** an MCP stdio server (`src/entry/cli.ts`, `src/entry/mcp.ts`) exposing tools for:

- **Doppler** env load/clear/list/status (`src/commands/env-*`)
- **Git worktrees** add/list/open/remove/sync (`src/commands/worktrees-*`)
- **GitHub releases** create/deliver/deploy/list + dev merges (`src/commands/gh-*`, `release-create`)

The DX surface needs to be reliable for **parallel multi-agent workflows** — multiple Claude/Cursor/cmux sessions running side-by-side in worktrees, all going through the same MCP tools. This document scores the project against current harness-engineering practice (Anthropic "Writing tools for agents", MCP spec 2025-11-25, Cognition/Devin, Augment, recent Cursor/Replit incidents) and produces a prioritized backlog.

**How to use this doc:** read the audit per subsystem to understand the WHY, then pick tickets off the backlog. Tickets are independent unless noted.

---

## What's already strong

Worth naming up front so we don't regress these:

- **Dual-channel tool output.** Every MCP tool returns `{ content: [{type:'text', text: JSON}], structuredContent }` — human prose **and** machine JSON. (`src/types.ts`, every command's MCP registration.)
- **Zod input + output schemas with rich `.describe()`** — descriptions explicitly call out MCP-vs-CLI differences ("required for MCP", "interactive picker is unreachable without a TTY"). Better than 80% of MCP servers in the wild. See `worktreesAddMcpTool` description at `worktrees-add/worktrees-add.ts:343-376` and `envLoadMcpTool` at `env-load/env-load.ts:191-208`.
- **`confirmedCommand` pattern** auto-skips interactive prompts when invoked via MCP (`worktrees-add.ts:113-131`, mirrored across destructive commands).
- **Doppler subprocess hardening** — 30s timeout, 1MB output cap, KEY=VALUE format validation (`env-load.ts:116-189`). Refuses to write garbage to disk; error messages tell the agent exactly what was malformed.
- **Atomic env-file writes** with pid-suffixed temp + rename (`src/lib/constants.ts:65-76`), 0o600 perms, session-scoped cache dir.
- **Defense-in-depth Claude Code hooks** in `.claude/settings.local.json`:
  - `PreToolUse`: `protect-files.sh`, `block-destructive.sh`, `cmux-check.sh`, `suggest-commands.py`
  - `PostToolUse`: `auto-format.sh`, `typecheck.sh` (30s), `run-tests-async.sh` (300s, async)
  - `TaskCompleted`: `quality-gate.sh` (120s)
  - `SessionStart`: `setup-env.sh`
  - This is a real harness around the LLM loop, not just prompt rules.
- **Permissions allowlist** is granular and conservative; no blanket `Bash(*)`.
- **`commandEcho` pattern** prints the equivalent CLI command for every MCP run — invaluable for debugging and for users learning the CLI.

---

## Subsystem audit

Each subsystem is scored **Strong / OK / Weak / Missing** against the four focus axes: parallel-agent reliability, AI tool ergonomics, observability/feedback, safety/secrets hygiene.

### 1. MCP tool design & ergonomics — Strong overall, with gaps

| Aspect | Score | Notes |
|---|---|---|
| Input schema clarity | Strong | Zod v4, descriptive, MCP-vs-CLI behaviour spelled out. |
| Idempotency | OK | `worktrees-add` filters `branchesToCreate` (`worktrees-add.ts:281-293`) so re-runs are safe; `env-load` is naturally idempotent. But there's no explicit `already_exists` status returned — count just comes back lower. |
| Blast-radius annotation | Missing | No `read | write | destructive` classification on tools. Agents can't reason about safety from the tool list alone. |
| Dry-run mode | Missing | No `--dry-run` on any tool. `gh-release-deploy-*` and `release-create` are highest-blast and have no preview affordance. |
| Tool descriptions for picker accuracy | Strong | Long, specific, include "when invoked via MCP" caveats. |
| Token-efficient output | OK | JSON is compact; no `response_format: concise|detailed` toggle yet, but current outputs are small. |

### 2. Parallel-agent workflows (worktrees) — Weak — biggest single risk

The worktree *creation* is fine; the *runtime isolation* needed for multiple agents is largely absent. This is the section with the highest delta vs. best practice.

| Aspect | Score | Notes |
|---|---|---|
| Worktree path/name convention | Strong | `${PROJECT_ROOT}-worktrees/{release,feature}/<branch>` (`constants.ts:78`, `worktrees-add.ts:50-53`). Predictable, parseable. |
| Concurrent `git worktree add` for same branch | Weak | No lockfile/registry. Two agents racing to create the same branch will both call `git worktree add`; one wins, the other gets a confusing git error. `Promise.allSettled` (`worktrees-add.ts:299`) hides which branch failed under what condition. |
| Per-worktree port allocation | **Missing** | Multiple `pnpm dev` instances will collide on default ports. `cmux-check.sh` exists but doesn't allocate. |
| Per-worktree env / Doppler config | **Missing** | `env-load` writes to a single `~/.cache/infra-kit/<session>/env-load.sh`. Multiple agents in parallel worktrees may overwrite each other unless `<session>` truly differs per worktree (verify `getSessionCacheDir` in `src/lib/constants.ts`). All worktrees default to the *same* Doppler config (`dev`); no convention for `dev_<branch>`. |
| Cleanup symmetry | OK | `worktrees-remove.ts` deletes dirs and prunes git, but does not free ports. When isolation lands, extend cleanup. |
| Agent discoverability of own worktree | Missing | An agent has no easy way to ask "which worktree am I in, what ports/DB are mine?" — there's no `worktrees-info` / `worktrees-whoami` tool returning the current worktree's allocations. |

### 3. Doppler / secrets hygiene — OK, with a clear hardening path

| Aspect | Score | Notes |
|---|---|---|
| CLI auth validation upfront | Strong | `validateDopplerCliAndAuth` runs at the top of `env-load` (`env-load.ts:32`). Fails fast with clear message. |
| Output sanity checks | Strong | Size cap + format check (`env-load.ts:143-189`). |
| Token scoping | Unclear / likely Weak | Repo uses the developer's personal Doppler login (`doppler me`). Agents inherit that scope. No service-token / read-only path documented. For multi-agent, you want a per-agent scoped service token. |
| Secret-value leakage in tool output | Strong | Tool returns `variableCount`, never values. |
| Per-branch config mapping | Missing | `infra-kit.json` declares only `[dev, arthur]`. No convention/automation for `dev_<branch>` configs that inherit from `dev`. |
| Fallback on Doppler outage | Weak | No cached encrypted snapshot; tool errors out. Acceptable for now, but for resilience: cache last-known-good with TTL + degraded-mode warning. |
| Prod write-protection | OK (declared) | `prod` is intended to be "protected from manual CLI commands" (it is omitted from the `environments` allowlist in `infra-kit.json`) — verify this is enforced in code (search the env commands), not just on the honour system. |

### 4. Feedback loops — Strong on enforcement, weak on agent-readability

| Aspect | Score | Notes |
|---|---|---|
| typecheck / lint / test as PostToolUse hooks | Strong | They run automatically. Gold-standard pattern. |
| Quality gate on `TaskCompleted` | Strong | `pnpm qa` blocks "done" claims. |
| Structured failure output | Weak | Hooks shell out to `pnpm typecheck/test/eslint`. Output is human prose. An agent reading a 200-line eslint dump has to re-parse it. Best practice: emit a *summary* line (file:line:col, rule, fix-hint) the agent can pattern-match. |
| Deterministic exit codes by category | Missing | Today: 0 / 1 / sometimes `process.exit(0)` on user-cancel (`worktrees-add.ts:125`). Best practice: 0 success, 1 user-error, 2 validation, 3+ infra. |
| `eslint-disable` / `@ts-ignore` policing | Unknown | Worth banning in agent-touched code unless explicitly approved (`eslint-comments/no-use`). |
| Long-op streaming | Weak | `pnpm install`, `gh-release-deploy-*` produce no progress events. Agents either wait blindly or assume success. |

### 5. Observability — Weak

| Aspect | Score | Notes |
|---|---|---|
| Logging | OK | Pino → `/tmp/mcp-infra-kit.log`. Searchable post-hoc. |
| Tool-call tracing | Missing | No span/trace per MCP tool call. No durations recorded in structured form. |
| OTel GenAI conventions | Missing | No OpenTelemetry instrumentation. As of 2025 the GenAI semantic conventions are stable — right format if you want to plug into Datadog/Honeycomb/Langfuse later. |
| Error categorisation | Missing | All errors throw raw — no `auth | not_found | precondition | conflict | upstream | timeout | internal` enum. Hard to alert on, hard for the agent to branch on. |
| `--verbose` flag | Missing | No way to bump log level for one call. Useful when an agent's tool call fails and you want to re-run with more detail. |

### 6. Safety / blast radius — OK at the harness layer, Weak inside the tools

The Claude Code hook layer (`block-destructive.sh`, `protect-files.sh`) is doing real work. The MCP tools themselves are less defensive.

| Aspect | Score | Notes |
|---|---|---|
| `confirmedCommand` flag for MCP | Strong | Skips inquirer prompts cleanly. |
| Hard guards outside LLM loop (hooks) | Strong | Pre-tool-use destructive blocker, file protector. |
| Per-tool blast classification | Missing | Tools should declare `destructive: true` so the harness can require an extra confirm out-of-band. |
| Dry-run / preview | Missing | `release-create`, `gh-release-deploy-all`, `gh-release-deploy-selected`, `gh-merge-dev` are high-blast and have no `--dry-run` returning the planned changeset. |
| Rollback tokens | Missing | After a destructive op, no `revert_token` is returned. If a release was wrong, recovery is manual. |
| Refusal of prod actions from non-`main` | Unclear | The `prod`-protection intent (`prod` excluded from `infra-kit.json`'s `environments`) needs to be backed by code that refuses, not by convention. |

### 7. Documentation — Weak

| Aspect | Score | Notes |
|---|---|---|
| Top-level README | Missing | `README.md` is one line: `# infra-kit`. |
| CLAUDE.md | Weak | 16 lines, only ticket prefixes. No worktree convention, no MCP-tool guidance, no parallel-agent rules. |
| AGENTS.md | Missing | The cross-vendor convention (Cursor, Aider, others) is `AGENTS.md`. CLAUDE.md should be the Claude-specific delta. |
| Per-tool examples | Missing | Schema descriptions are good; concrete worked examples would let agents pattern-match faster. |
| Architecture overview (worktree strategy, parallel-agent assumptions) | Missing | Lives only in code. |

---

## Prioritized backlog

Ordered by impact-per-effort across the four axes. File paths are starting points, not prescriptions.

### P0 — Do first (parallel-agent correctness + cheap wins)

#### P0.1 — [DO] Per-worktree port allocation
Add `src/lib/worktree-runtime/ports.ts` that, given a worktree path, deterministically computes a port range from a hash of the branch name (e.g. `30000 + hash(branch) % 10000`, stride of 10) and writes them to a gitignored `.env.local` in the worktree. Wire into `worktrees-add` after `pnpm install`. Add a `worktrees-info` MCP tool returning `{ branch, path, ports, dopplerConfig }` so an agent can self-orient.
- Files: `worktrees-add.ts:298-308` (extend `createWorktrees`), new `src/commands/worktrees-info/`.
- Acceptance: two parallel `pnpm dev` runs in different worktrees do not collide.

#### P0.2 — [DO] Worktree-creation locking
Wrap `git worktree add` in a flock-style lock file under `${projectRoot}-worktrees/.locks/<branch>.lock` to prevent two agents racing on the same branch. Surface `already_being_created` as an explicit error category.
- File: `worktrees-add.ts:298-308`.

#### P0.3 — [DO] Blast-radius metadata + dry-run on every destructive tool
Add a `meta.blast: 'read'|'write'|'destructive'` field to each MCP tool registration (extend `src/types.ts`'s tool-registration interface). Add `--dry-run` (default false) to `release-create`, `gh-release-deliver`, `gh-release-deploy-all`, `gh-release-deploy-selected`, `gh-merge-dev` that returns the planned changeset without executing.
- Files: `src/types.ts`, every `gh-*/index.ts`, `release-create/index.ts`.

#### P0.4 — [DO] Structured error envelope
Replace raw thrown errors with `{ category: 'auth'|'not_found'|'precondition'|'conflict'|'upstream'|'timeout'|'internal'|'user_cancelled', message, remediation, retryable: boolean }`. Wire through `src/lib/tool-handler/tool-handler.ts`. Doppler is the exemplar — propagate that pattern.
- Acceptance: every MCP error result has the four fields.

#### P0.5 — [ROOT] Promote CLAUDE.md → AGENTS.md and fill it in
Sections to add: `Worktree convention`, `How to use the MCP tools (when to pick which)`, `Parallel-agent rules` (one agent per worktree, ports/DB isolation contract), `Doppler config naming`, `Forbidden actions` (no force-push, no `prod` writes from agents). Keep CLAUDE.md as a thin pointer file: `Read AGENTS.md.` Target ≤200 lines.

#### P0.6 — [BE] Verify and codify prod write-protection
The `prod` write-protection intent ("prod is protected from manual CLI commands") must be enforced in code: env commands should reject `selectedConfig === 'prod'` unless an explicit `--break-glass` flag + interactive TTY. Add a snapshot test for the refusal.
- Files: `env-load.ts:38-57`, `env-clear/`, `env-list/`.

### P1 — Should do (observability + agent ergonomics)

#### P1.7 — [DO] OpenTelemetry GenAI tracing on every MCP tool call
Wrap `tool-handler.ts` with an OTel span: attributes `gen_ai.tool.name`, `gen_ai.tool.call.id`, `infra_kit.blast`, `infra_kit.dry_run`, duration, exit code, error category. Export via `OTEL_EXPORTER_OTLP_ENDPOINT`; no-op when unset. Plugs into Datadog/Honeycomb/Langfuse later for free.

#### P1.9 — [DO] Per-branch Doppler config convention
Document and (optionally) auto-create `dev_<branch>` configs that inherit from `dev` when a worktree is added. `env-load` should resolve a worktree-aware default config: if `dev_<currentBranch>` exists, use it; else fall back to `dev`.
- Files: `env-load.ts:38-57`, `src/integrations/doppler/`.

#### P1.10 — [DO] Streaming progress for long ops
`pnpm install` (in `worktrees-add`) and `gh-release-deploy-*` should emit incremental log lines via `commandEcho` or a dedicated `progress.event(...)` helper. At minimum, log start + each subtask + summary so an agent sees forward motion.

#### P1.11 — [DO] Deterministic exit codes
Replace ad-hoc `process.exit(0)` on user-cancel (`worktrees-add.ts:125`) with a small enum: `0` ok, `1` user-cancel, `2` validation, `3` upstream/network, `4` infra. Document in AGENTS.md.

#### P1.12 — [ROOT] Snapshot tests for MCP tool output schemas
Today there's only one test file (`env-load.test.ts`). Add a `*.mcp.test.ts` per tool that calls the handler with a fixture input and snapshots the `structuredContent`. Catches regressions when a refactor accidentally changes the JSON shape an agent relies on.

#### P1.13 — [ROOT] `--verbose` flag + log-level env var
A flag on the CLI and an `INFRA_KIT_LOG_LEVEL` env that bumps Pino from `info` to `debug` for one call. Useful when re-running a failed agent tool call.

### P2 — Nice to have (resilience + polish)

#### P2.15 — [BE] Doppler offline cache
Encrypted last-known-good snapshot per (project, config) under `~/.cache/infra-kit/snapshots/`, with TTL (e.g. 24h). When Doppler is unreachable, surface a clear degraded-mode warning and use the cache; refuse past TTL.

#### P2.16 — [DO] Rollback tokens on destructive ops
Every `release-create` / `gh-release-deploy-*` returns `{ revert_token: 'rt_...' }`; an `infra rollback <token>` command undoes the most-recent op. State stored under `.git/infra-kit/rollback/`. High value for agent-driven releases.

#### P2.17 — [ROOT] `eslint-comments/no-use` rule
Block `eslint-disable` and `@ts-ignore` in agent-touched code unless an exception is annotated. Closes a common escape hatch.

#### P2.18 — [ROOT] `infra-kit doctor` enrichment
You already have a `doctor/` command — extend it to verify: Doppler CLI present + authed, gh CLI present + authed, cmux installed, ports free, no stale worktree locks, `infra-kit.json` valid. Run from `SessionStart` hook.

#### P2.19 — [ROOT] Per-tool worked examples
In each tool's `description`, include a one-line "Example call:" with a JSON snippet. Empirically improves agent picker accuracy.

#### P2.20 — [ROOT] `AGENT-AUTHORING.md`
Describe how to add a new MCP command (the `src/commands/<name>/index.ts` convention, dual CLI+MCP export, schema/echo/handler contract). Reduces the cost of adding tools — and helps an agent add tools too.

---

## Critical files to read before implementing

- `apps/infra-kit/cli/src/types.ts` — tool registration shape (extend for blast metadata + typed output)
- `apps/infra-kit/cli/src/lib/tool-handler/tool-handler.ts` — central interception point for tracing + structured errors
- `apps/infra-kit/cli/src/lib/constants.ts` — atomic write helpers, cache dir, worktree suffix
- `apps/infra-kit/cli/src/lib/git-utils/git-utils.ts` — single source of truth for current worktrees
- `apps/infra-kit/cli/src/commands/worktrees-add/worktrees-add.ts` — extend with locking, port allocation, post-install hooks
- `apps/infra-kit/cli/src/commands/env-load/env-load.ts` — extend with per-branch config resolution + prod refusal
- `apps/infra-kit/cli/src/integrations/doppler/` — wrap with offline cache + service-token path
- `.claude/settings.local.json` — already rich; consider adding a hook that runs `infra-kit doctor` on `SessionStart` once P2.18 lands

## Verification

For each P0/P1 ticket, the acceptance test is:

- A snapshot test of the new `structuredContent` schema (P1.13).
- An integration test running the tool against a fixture worktree/Doppler config (use `nock` for gh, a Doppler mock for env).
- For parallel-agent tickets (P0.1, P0.2): a stress test spawning N concurrent invocations and asserting no port collision / no race.
- Run the full quality gate: `pnpm qa` (typecheck + eslint + tests).
- Manual: open two cmux worktrees, run `pnpm dev` in both, verify they bind different ports.

---

## Sources / further reading

- Anthropic — [Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- Anthropic — [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)
- [MCP Specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- Augment Code — [Harness Engineering for AI Coding Agents](https://www.augmentcode.com/guides/harness-engineering-ai-coding-agents)
- Penligent — [Git Worktrees Need Runtime Isolation](https://www.penligent.ai/hackinglabs/git-worktrees-need-runtime-isolation-for-parallel-ai-agent-development/)
- MindStudio — [Parallel Agentic Development Playbook](https://www.mindstudio.ai/blog/parallel-agentic-development-git-worktrees)
- Barnacle — [Isolated Worktree Databases for Claude Code](https://www.barnacle.ai/blog/2026-02-07-the-missing-piece-of-the-claude-code-workflow-isol)
- Doppler — [Secrets management in the age of AI / NHI hygiene](https://www.doppler.com/blog/secrets-management-ai-nhi-hygiene)
- AI Hero — [Essential AI coding feedback loops for TypeScript](https://www.aihero.dev/essential-ai-coding-feedback-loops-for-type-script-projects)
- OpenTelemetry — [AI Agent Observability (2025)](https://opentelemetry.io/blog/2025/ai-agent-observability/)
- Datadog — [LLM Observability with OTel GenAI conventions](https://www.datadoghq.com/blog/llm-otel-semantic-convention/)
- HumanLayer — [Writing a good CLAUDE.md](https://www.humanlayer.dev/blog/writing-a-good-claude-md)
- Claude Code — [Best practices](https://code.claude.com/docs/en/best-practices)
- Giskard — [Cursor agent wiped a production DB in 9s](https://www.giskard.ai/knowledge/a-cursor-ai-agent-wiped-a-production-database-in-9-seconds-excessive-agency-ai-failure)
