# MCP retirement — consumer sweep

Phase 2.5 of `.omc/plans/mcp-to-cli-skills-migration.md`: a read-only audit of every
consumer repo's Claude Code config for references to the infra-kit MCP server, ahead
of its retirement in favor of the CLI + skills. Swept 2026-09-15.

Any fix below is a **separate PR in that repo**, on no particular deadline — this
document only records what each repo needs, it does not make the edits.

Scope: every directory directly under `/Users/arthur/projects` that is a git repo
(`.git` dir or file), plus the release-worktree children of
`hulyo-monorepo-worktrees`. `hulyo-monorepo-worktrees/feature/` is empty. A sibling
`travelist-monorepo-worktrees/` also exists but its children were out of scope for
this sweep (the task named `hulyo-monorepo-worktrees` only) — flag separately if a
sweep of it is wanted. Read-only checks per repo: `.claude/settings.json`,
`.claude/settings.local.json`, `.mcp.json`, `package.json` scripts, `turbo.json`.

Two repo-wide notes, true for every repo checked below unless stated otherwise:

- **(a)** No repo has an explicit `mcp__plugin_infra-kit` or `mcp__infra-kit` allow/deny
  entry in either settings file — the plugin's MCP tools aren't individually
  permissioned anywhere.
- **(c)** No repo has a Bash **allow** pattern for a mutating infra-kit/ik command. The
  only infra-kit/ik Bash patterns present are **deny** entries for `release deliver`
  (`Bash(pnpm exec infra-kit release-deliver:*)`, `Bash(pnpm exec infra-kit release
deliver:*)`, `Bash(pnpm exec ik release-deliver:*)`, `Bash(pnpm exec ik release
deliver:*)`, `Bash(ik release deliver:*)`) — those make deliver _harder_ to run
  unprompted, not easier, so they aren't findings.

## Findings table

| Repo                                                      | (a) plugin tool perms | (b) raw `infra-kit` in `.mcp.json`                         | (c) mutating Bash allow | (d) turbo/piped infra-kit invocation            |
| --------------------------------------------------------- | --------------------- | ---------------------------------------------------------- | ----------------------- | ----------------------------------------------- |
| ai-coding-manifest                                        | none                  | no `.mcp.json`/settings                                    | none                    | none                                            |
| bridge-monorepo                                           | none                  | absent from `.mcp.json`; stale `enabledMcpjsonServers` ref | none                    | none                                            |
| cortena                                                   | none                  | no `.mcp.json`/settings                                    | none                    | none                                            |
| GLV-Backend                                               | none                  | **live**                                                   | none                    | none                                            |
| hulyo-monorepo                                            | none                  | absent from `.mcp.json`; stale `enabledMcpjsonServers` ref | none                    | **yes**                                         |
| infra-kit (this repo)                                     | none                  | absent from `.mcp.json`; stale `enabledMcpjsonServers` ref | none                    | **yes** (source repo, see note)                 |
| learning-workspace                                        | none                  | no `.mcp.json`/settings                                    | none                    | none                                            |
| nomadream-monorepo                                        | none                  | absent from `.mcp.json`; stale `enabledMcpjsonServers` ref | none                    | **yes**                                         |
| nomadream-ota-n-level                                     | none                  | **live**                                                   | none                    | **yes**                                         |
| obsidian-knowledge                                        | none                  | no `.mcp.json`                                             | none                    | none                                            |
| oh-my-claudecode                                          | none                  | absent (`.mcp.json` only has its own `t` server)           | none                    | none                                            |
| personal-website                                          | none                  | no `.mcp.json`/settings                                    | none                    | none                                            |
| sandbox-workspace                                         | none                  | **live**                                                   | none                    | none (dx-* scripts are direct, not turbo/piped) |
| starter-workspace                                         | none                  | absent from `.mcp.json`; stale `enabledMcpjsonServers` ref | none                    | **yes**                                         |
| travelist-monorepo                                        | none                  | absent from `.mcp.json`; stale `enabledMcpjsonServers` ref | none                    | **yes**                                         |
| vscode-settings                                           | none                  | no `.mcp.json`/settings                                    | none                    | none                                            |
| hulyo-monorepo-worktrees/release/aiops-phase1             | none                  | **live**                                                   | none                    | **yes**                                         |
| hulyo-monorepo-worktrees/release/tanstack-start-migration | none                  | **live**                                                   | none                    | **yes**                                         |
| hulyo-monorepo-worktrees/release/v1.46.0                  | none                  | **live**                                                   | none                    | **yes**                                         |
| hulyo-monorepo-worktrees/release/v1.94.0                  | none                  | **live**; plugin not enabled here (see note)               | none                    | **yes**                                         |

## Repos with no findings

`ai-coding-manifest`, `cortena`, `learning-workspace`, `obsidian-knowledge`,
`oh-my-claudecode`, `personal-website`, `vscode-settings`: no findings.

## Repos needing edits

### `.mcp.json` still wires the raw infra-kit MCP server (live, item b)

These repos define an `infra-kit` key under `mcpServers` in `.mcp.json`, and nothing
disables it (`enableAllProjectMcpServers: true` is set in every one, so it's live
regardless of whether `infra-kit` also appears in `enabledMcpjsonServers`):

- **GLV-Backend** — `.mcp.json`: `"infra-kit": { "type": "stdio", "command": "node", "args": ["./node_modules/infra-kit/dist/mcp.js"] }`. Edit: remove that block from `mcpServers`.
- **nomadream-ota-n-level** — `.mcp.json`: `"infra-kit": { "type": "stdio", "command": "infra-kit", "args": ["mcp"] }`. Edit: remove that block. (`.claude/settings.local.json` also explicitly lists `"infra-kit"` in `enabledMcpjsonServers` — remove that array entry too.)
- **sandbox-workspace** — same `infra-kit mcp` block as above. Edit: remove it from `.mcp.json`.
- **hulyo-monorepo-worktrees/release/aiops-phase1** — same block. Edit: remove it from `.mcp.json`.
- **hulyo-monorepo-worktrees/release/tanstack-start-migration** — same block. Edit: remove it from `.mcp.json`.
- **hulyo-monorepo-worktrees/release/v1.46.0** — same block. Edit: remove it from `.mcp.json`.
- **hulyo-monorepo-worktrees/release/v1.94.0** — same block, plus this worktree's `.claude/settings.json` (hash differs from its siblings) does **not** have `"infra-kit@infra-kit": true` under `enabledPlugins`, unlike every other release worktree of `hulyo-monorepo`. So here the plugin is off but the raw stdio server is still wired — worth flagging to whoever cut this worktree, separate from the `.mcp.json` edit.

Note: `hulyo-monorepo`'s own (non-worktree) checkout, `travelist-monorepo`, `bridge-monorepo`, `nomadream-monorepo`, `starter-workspace`, and this `infra-kit` repo do **not** have a live `infra-kit` entry in `.mcp.json` — see the stale-reference note below instead.

### Stale `enabledMcpjsonServers` reference (item b, not live)

`bridge-monorepo`, `hulyo-monorepo`, `infra-kit` (this repo), `nomadream-monorepo`,
`starter-workspace`, `travelist-monorepo` all carry the same
`.claude/settings.local.json` template, which lists:

```json
"enabledMcpjsonServers": ["atlassian", "shadcn", "infra-kit"]
```

but none of these repos' `.mcp.json` actually defines an `infra-kit` server (they only
have `linear-server`, and `hulyo-monorepo`/`travelist-monorepo` also have `grafana` via
the unrelated `ik-mcp` wrapper binary). This is dead config, not a live risk — no MCP
tool call is possible against an entry that doesn't exist — but it's worth a cleanup
edit alongside the retirement: drop `"infra-kit"` from that array in each repo's
`.claude/settings.local.json`.

### Turbo-task / non-TTY infra-kit CLI invocations (item d)

These repos' root `package.json` runs `infra-kit`/`ik` CLI commands as turbo tasks or chained
non-TTY calls (`audit`, `vendor check`, `infra-kit-check`). From a Claude-spawned terminal they
inherit `CLAUDECODE`, present a non-TTY stdin, and so resolve to agent mode.

**Verdict after review by the lead: no edit needed.** Agent mode changes behaviour only at
prompt sites, pickers, the confirm sites and the `protectedEnvs: 'cli-only'` guard; the commands
these scripts run are read-only, prompt-free and never reach any of those. An `export
INFRA_KIT_AGENT=0` on every `qa` script would be noise. Add it inside a script ONLY if that script
runs a prompting or confirm-gated command (`worktrees add`, `release …`, `env-load` without `-c`)
and you want the human prompt there — none of the swept scripts does today.

Repos where this applies (for the record): hulyo-monorepo, infra-kit, nomadream-monorepo,
nomadream-ota-n-level, starter-workspace, travelist-monorepo, and the four
hulyo-monorepo-worktrees/release children.
