# infra-kit — Claude Code plugin

Engineering skills used across the infra-kit family of monorepos.
Installed once per repo, updated from this repo, versioned in `.claude-plugin/plugin.json`.

This plugin **complements** the infra-kit MCP server; it does not replace or bundle it. The
server keeps being registered by each consumer's own `.mcp.json` (`infra-kit mcp`, key
`infra-kit`), and the deploy-guard hooks keep living in each consumer's own hooks directory. The
plugin ships **no `mcpServers`** and **no hooks**, by design: a plugin is per-user and opt-in,
and neither a shared self-updating server nor a fail-closed guard can be owned by something a
teammate may never have installed. The reasoning is recorded in
`.omc/plans/infra-kit-claude-plugin.md` (D4, D9). Moving the server into the plugin was re-planned
and measured in `docs/mcp-via-plugin-plan.md` (2026-09-14): Claude Code loads a project-scope plugin
only when launched at the directory that holds `.claude/settings.json`, while `.mcp.json` is found
from any subdirectory — so the move would drop every infra-kit tool from a session started in
`apps/…`, and it stays on hold (§6.1, S0-2).

## What it contains

| Component | Name                          | Purpose                                                                                                                    |
| --------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| skill     | `/infra-kit:comment-verifier` | Reviews and fixes comments against the "why, not what" policy, with a mechanical verify step                               |
| skill     | `/infra-kit:doctor`           | Runs the CLI health report, then adds the checks only a live session can make (which plugin tree loaded, drift, staleness) |
| skill     | `/infra-kit:fe-architect`     | Builds and reviews the inside of a React feature (naming, containers, state, services)                                     |
| skill     | `/infra-kit:fe-patterns`      | Cross-feature boundaries, injection patterns, promotion to shared                                                          |
| skill     | `/infra-kit:e2e-architect`    | Per-feature Playwright e2e layout: page object, fixture, specs by axis                                                     |
| skill     | `/infra-kit:update-toolchain` | Bumps pnpm, Node and Turbo across a monorepo, phase by phase                                                               |
| skill     | `/infra-kit:full-cycle`       | deep-interview → ralplan → review gate → ralph → verify (requires oh-my-claudecode)                                        |

Skill scripts run from the plugin root (`${CLAUDE_PLUGIN_ROOT}/skills/<skill>/scripts/…`) and
each skill's `allowed-tools` whitelists exactly the commands its body runs, so a bundled script
executes without a permission prompt.

## Install

From the consumer repo root:

```
infra-kit setup
```

That is the whole install. `infra-kit setup` writes the two pointer keys into
`.claude/settings.json` (`extraKnownMarketplaces` and `enabledPlugins`, nothing else), registers the
marketplace when this machine does not already know it, and runs the project-scope install. Every
step reads host state first, so re-running it on a configured machine spawns nothing.

`infra-kit setup` also installs or updates the external CLIs infra-kit needs (brew, aws, gh,
doppler, portless). For the pointer keys and nothing installed, add `--skip-tools`: it reports what
is missing and the argv that would fix it, and installs none of it.

The commands `infra-kit setup` runs, for anyone who wants to run them by hand:

```
claude plugin marketplace add ArthurSaenz/infra-kit
claude plugin install infra-kit@infra-kit --scope project
```

These are the fallback, not the normal path. `infra-kit setup` prints them when `claude` is not on
PATH — it cannot install a plugin without Claude Code — and warns with them when a step fails.
`infra-kit doctor` reports the same prerequisite as its `claude CLI` row.

**Always `--scope project`.** The CLI default is `user`, which would activate this plugin in
every repository you open. Its skills are written against this family's conventions and every
skill description costs context on every turn, so the correct scope is the repo that uses them.
Project scope writes `enabledPlugins` into `.claude/settings.json`, the same key `infra-kit setup`
manages.

## Update

Edit under `plugins/infra-kit/`, bump `version` in `.claude-plugin/plugin.json` **in the same
commit** (CI fails otherwise), push to `main`. Run `claude plugin tag ./plugins/infra-kit` to create
the `infra-kit--v<version>` release tag.

How consumers receive it — measured, not assumed (2026-09-14, `docs/mcp-via-plugin-plan.md` §6.1):
Claude Code does **not** advance a project-scope plugin on its own; every install record on the
author's machine sat at 0.3.0 while `main` was at 0.7.0. The CLI carries the plugin forward instead.
The silent self-update child that runs after a user-typed `infra-kit …` command on a TTY (at most
once per 20 minutes) also runs `claude plugin update infra-kit@infra-kit --scope project -y` for
every project it is installed in, and `infra-kit setup` updates an already-installed plugin rather
than reporting it installed. A machine where nobody types an `infra-kit` command never advances —
the same channel the CLI itself lives on. `/reload-plugins` or the next launch applies a fetched
version; `infra-kit doctor` says when one is fetched but not yet applied.

## Remove or opt out

Both registration keys are plain settings and can be removed by hand; there is no command for
it and none is needed.

- Repo-wide: delete `extraKnownMarketplaces["infra-kit"]` and
  `enabledPlugins["infra-kit@infra-kit"]` from `.claude/settings.json`.
- This machine only: set `"infra-kit@infra-kit": false` under `enabledPlugins` in
  `.claude/settings.local.json`. `infra-kit setup` never overwrites an existing value, so the
  opt-out survives every later run.

## Token budget

Every skill description is loaded into context on every turn. The release checklist runs
`claude plugin details infra-kit`, parses the projected token cost, and fails when it exceeds
the recorded value below by more than 20%. Growing the budget is allowed; it must be a
deliberate edit of this line in the same commit.

- Recorded projected always-on token cost: **347** (plugin version 0.3.0, measured with `claude --plugin-dir ./plugins/infra-kit plugin details infra-kit`)

The previous recorded value was 1438, stamped against plugin version 0.1.0. It is not comparable to
the number above: it went unrefreshed across two version bumps, and the reporting has since changed
shape (it now itemises always-on against on-invoke cost per component). Treat 347 as the new
baseline, not as evidence of a 4x reduction.

## Tests

From this repo's root, `pnpm run test:claude` runs every skill's `__tests__/*.test.mjs`, the
plugin manifest guard suite in `plugins/infra-kit/__tests__/`, and the hook suite. `pnpm run qa`
invokes it last. `claude plugin validate ./plugins/infra-kit --strict --json` must exit 0.
