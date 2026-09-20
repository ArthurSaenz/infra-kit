# infra-kit

A monorepo DX CLI (v0.3.10) that doubles as an MCP server for AI coding agents. It orchestrates local development, releases, environment management, and repo audits—both as a command-line tool and as a set of structured tools exposed to Claude and other AI agents.

## Install in a Repo

Pin it as a **devDependency** (not global):

```bash
npm install --save-dev infra-kit
# or with pnpm
pnpm add -D infra-kit
```

Global installs are non-reproducible across machines and CI—always declare it in `package.json`.

### Expose to AI Agents

If your repo uses Claude Code or another MCP-aware agent, add `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "infra-kit": {
      "type": "stdio",
      "command": "npx",
      "args": ["--no-install", "infra-kit", "mcp"]
    }
  }
}
```

The agent will then have access to a curated subset of infra-kit commands as structured tools (see [MCP Exposed Tools](#mcp-exposed-tools) below).

**Other stdio MCP servers whose secrets come from `ik env-load`** (Grafana, for example) are declared
once, in `infra-kit.json` under `mcp.<name>` (`command`, `args`, `env`, `unset`). That block is the
source of truth. The matching `.mcp.json` entry — `ik-mcp --name <name> --env … -- <command> …` — is
**generated** from it by `infra-kit setup` and `infra-kit audit --root --fix`, and `infra-kit audit`
reports drift between the two. Edit `infra-kit.json`, regenerate, commit both; never hand-edit the
generated entry. It stays in `.mcp.json` by design: the proxy reads argv only, so the file Claude
Code loads is self-contained and needs no config reader at session start.

## Configuration

**infra-kit.json** (runtime)  
Defines dev server ports, environment providers (e.g., Doppler), and preset proxy templates. Consumed by `infra-kit dev` and the MCP server.

**infra-kit.config.ts** (audit)  
Strict schema file that declares audit rules (`requiredScripts`, `requiredFiles`) and an optional `type` override (`frontend` | `backend` | `lib` | `e2e` | `mobile`) used by the `agent-guidance` check. Validated by `infra-kit audit`. No runtime behavior.

## Commands

| Group             | Command                                                                 | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Develop**       | `dev`                                                                   | Start local dev server with portless proxy (interactive wizard, long-running)                                                                                                                                                                                                                                                                                                                                                |
|                   | `dev-status`                                                            | Report what `infra-kit dev` currently has running (read-only; finds the fragment dir by searching upward, so it works from any subdirectory)                                                                                                                                                                                                                                                                                 |
| **Release**       | `release merge-dev`                                                     | Merge `origin/dev` into open regular release branches in a scratch worktree, then push atomically (`--dry-run`, `--versions`). Hotfixes (PRs to `main`), title/base mismatches and heads with PRs to both bases are listed as `skipped` with a reason                                                                                                                                                                        |
|                   | `release list`                                                          | List available releases                                                                                                                                                                                                                                                                                                                                                                                                      |
|                   | `release create`                                                        | Create a new release                                                                                                                                                                                                                                                                                                                                                                                                         |
|                   | `release edit`                                                          | Edit release notes                                                                                                                                                                                                                                                                                                                                                                                                           |
|                   | `release deploy-all --from <ci\|local>`                                 | Deploy every service — in CI, or from this machine                                                                                                                                                                                                                                                                                                                                                                           |
|                   | `release deploy-selected --from <ci\|local>`                            | Deploy chosen services — in CI, or from this machine                                                                                                                                                                                                                                                                                                                                                                         |
|                   | `release deliver`                                                       | Deliver to prod (CLI-only, irreversible)                                                                                                                                                                                                                                                                                                                                                                                     |
|                   | `release remove`                                                        | Tear down one release — worktree, IDE folders, PR, local and remote branches, then the Jira fix version last. Refuses a merged PR, a released fix version, or one with issues attached (`--move-issues-to` is the opt-in). Resumable: a partially-removed release re-runs cleanly. Over MCP the Jira step is never attempted (`jira: 'manual'`)                                                                              |
| **Worktrees**     | `worktrees add`                                                         | Create a new git worktree                                                                                                                                                                                                                                                                                                                                                                                                    |
|                   | `worktrees list`                                                        | List all worktrees                                                                                                                                                                                                                                                                                                                                                                                                           |
|                   | `worktrees remove`                                                      | Remove a worktree (no `--force`; a branch git refuses is reported and the command exits non-zero; a leftover git already unregistered that holds only `.omc/state`, `.omc/sessions` or `.DS_Store` is swept automatically)                                                                                                                                                                                                   |
|                   | `worktrees sync`                                                        | Sync worktree state (same removal and failure reporting as `worktrees remove`)                                                                                                                                                                                                                                                                                                                                               |
| **Environment**   | `env-status`                                                            | Show Doppler env status                                                                                                                                                                                                                                                                                                                                                                                                      |
|                   | `env-list`                                                              | List secrets in current env                                                                                                                                                                                                                                                                                                                                                                                                  |
|                   | `env-load`                                                              | Load env secrets into shell                                                                                                                                                                                                                                                                                                                                                                                                  |
|                   | `env-clear`                                                             | Clear loaded secrets                                                                                                                                                                                                                                                                                                                                                                                                         |
|                   | `env-token-list`                                                        | List redacted service tokens                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Configuration** | `config-get`                                                            | Print the fully merged infra-kit config (read-only)                                                                                                                                                                                                                                                                                                                                                                          |
|                   | `config path`                                                           | Print config file locations                                                                                                                                                                                                                                                                                                                                                                                                  |
|                   | `config edit`                                                           | Edit infra-kit.json in `$EDITOR`                                                                                                                                                                                                                                                                                                                                                                                             |
| **Vendor**        | `vendor check`                                                          | Validate vendor mirrors                                                                                                                                                                                                                                                                                                                                                                                                      |
|                   | `vendor config`                                                         | Show vendor manifest                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Setup**         | `infra-kit setup [--tools <ids...>] [--update [ids...]] [--skip-tools]` | Set up infra-kit on this machine: shell integration, the Claude Code plugin, the `.mcp.json` key, then install or update the external CLIs (brew, aws, gh, doppler, portless). `--tools` / `--update` narrow the converge; `--skip-tools` writes only, reporting what is missing without installing it. Written binary-qualified here because `pnpm setup` and `pnpm run setup` both exist in every consumer and both mutate |
|                   | `audit [--fix] [--design]`                                              | Check repo against config rules, including the per-package `agent-guidance` `CLAUDE.md` check; `--fix` writes guidance blocks (CLI-only, not in MCP), `--design` also scaffolds `DESIGN.md`                                                                                                                                                                                                                                  |
|                   | `doctor [--fix]`                                                        | Diagnose this machine: infra-kit install, tool auth, and repo wiring; `--fix` repairs what it safely can (CLI-only — the MCP tool is read-only)                                                                                                                                                                                                                                                                              |
|                   | `version`                                                               | Show installed version                                                                                                                                                                                                                                                                                                                                                                                                       |

## Agent guidance blocks (CLAUDE.md)

`infra-kit audit` checks each workspace package for a managed guidance block in its `CLAUDE.md`, marked by `<!-- infra-kit:package:begin -->` / `<!-- infra-kit:package:end -->` (the root uses its own `<!-- infra-kit:begin -->` / `<!-- infra-kit:end -->` pair). Text outside the markers is never touched.

Run `audit --fix` to write the block for the current package, `--fix --all` for every package, or `--fix --root` for the root file. Add `--design` (with `--fix`) to scaffold a `DESIGN.md` skeleton for `frontend`/`mobile` packages that lack one. Both flags are CLI-only — never exposed through MCP.

Enforcement follows workspace adoption: until any package carries a well-formed block, a missing or broken `CLAUDE.md` only advises; once one package has adopted, every package needs one.

## infra-kit dev

Starts a local dev server with a portless-powered proxy. The interactive wizard guides you through app selection when run in a TTY without flags:

```bash
infra-kit dev              # Interactive wizard
infra-kit dev --app=client # Start one app
infra-kit dev --watch      # Rebuild & restart on file changes
infra-kit dev <preset>     # Use a saved preset from infra-kit.json
```

Runs long-running until you press Ctrl-C. Manages multiple backend/frontend processes, health probes, and live proxy reconfiguration.

## MCP Exposed Tools

When infra-kit runs as an MCP server (via `.mcp.json`), these commands are available as structured agent tools:

- `dev-status`
- `gh-merge-dev`, `gh-release-list`, `release-create`, `release-remove`, `release-edit`, `gh-release-deploy-all`, `gh-release-deploy-selected`
- `release-create` offers an argument form when `releases` is omitted (one release; batches are arguments-only).
- `local-deploy-all`, `local-deploy-selected`
- `worktrees-add`, `worktrees-list`, `worktrees-remove`, `worktrees-sync`
- `env-status`, `env-list`, `env-load`, `env-clear`, `env-token-list`
- `config-get`, `vendor-check`
- `audit`, `version`
- `doctor` (read-only), `setup` (gated — every call raises the host prompt and the confirm round-trip)

26 tools total.

**Not exposed**: `dev` (long-running), `release deliver` (irreversible prod delivery), `config edit` / `config path` (interactive/CLI-only), `vendor config` (CLI-only), and `mcp` (process-level).

---

**Node**: ≥24.x | **License**: Proprietary
