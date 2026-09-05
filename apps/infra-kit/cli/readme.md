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

## Configuration

**infra-kit.json** (runtime)  
Defines dev server ports, environment providers (e.g., Doppler), and preset proxy templates. Consumed by `infra-kit dev` and the MCP server.

**infra-kit.config.ts** (audit)  
Strict schema file that declares audit rules (`requiredScripts`, `requiredFiles`). Validated by `infra-kit audit`. No runtime behavior.

## Commands

| Group | Command | Purpose |
|-------|---------|---------|
| **Develop** | `dev` | Start local dev server with portless proxy (interactive wizard, long-running) |
| | `dev-status` | Report what `infra-kit dev` currently has running (read-only; finds the fragment dir by searching upward, so it works from any subdirectory) |
| **Release** | `release merge-dev` | Merge `origin/dev` into open release branches in a scratch worktree, then push atomically (`--dry-run`, `--versions`) |
| | `release list` | List available releases |
| | `release create` | Create a new release |
| | `release desc-edit` | Edit release notes |
| | `release deploy-all --from <ci\|local>` | Deploy every service — in CI, or from this machine |
| | `release deploy-selected --from <ci\|local>` | Deploy chosen services — in CI, or from this machine |
| | `release deliver` | Deliver to prod (CLI-only, irreversible) |
| **Worktrees** | `worktrees add` | Create a new git worktree |
| | `worktrees list` | List all worktrees |
| | `worktrees remove` | Remove a worktree (no `--force`; a branch git refuses is reported and the command exits non-zero; a leftover git already unregistered that holds only `.omc/state`, `.omc/sessions` or `.DS_Store` is swept automatically) |
| | `worktrees sync` | Sync worktree state (same removal and failure reporting as `worktrees remove`) |
| | `reopen` | Reopen a closed worktree |
| **Environment** | `env-status` | Show Doppler env status |
| | `env-list` | List secrets in current env |
| | `env-load` | Load env secrets into shell |
| | `env-clear` | Clear loaded secrets |
| | `env-token-list` | List redacted service tokens |
| **Configuration** | `config-get` | Print the fully merged infra-kit config (read-only) |
| | `config path` | Print config file locations |
| | `config edit` | Edit infra-kit.json in `$EDITOR` |
| **Vendor** | `vendor check` | Validate vendor mirrors |
| | `vendor config` | Show vendor manifest |
| **Setup** | `init` | Initialize infra-kit in repo |
| | `audit` | Check repo against config rules |
| | `doctor` | Diagnose machine setup (CLI-only) |
| | `version` | Show installed version |

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
- `gh-merge-dev`, `gh-release-list`, `release-create`, `release-desc-edit`, `gh-release-deploy-all`, `gh-release-deploy-selected`
- `worktrees-add`, `worktrees-list`, `reopen`, `worktrees-remove`, `worktrees-sync`
- `env-status`, `env-list`, `env-load`, `env-clear`, `env-token-list`
- `config-get`, `vendor-check`
- `audit`, `version`

21 tools total.

**Not exposed**: `dev` (long-running), `doctor` (host inspection), `release deliver` (irreversible prod delivery), `config edit` / `config path` (interactive/CLI-only), `vendor config` (CLI-only), `init` (interactive).

---

**Node**: ≥24.x | **License**: Proprietary
