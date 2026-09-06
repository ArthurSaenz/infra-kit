# infra-kit — Claude Code plugin

Engineering skills and the code-quality agent used across the infra-kit family of monorepos.
Installed once per repo, updated from this repo, versioned in `.claude-plugin/plugin.json`.

This plugin **complements** the infra-kit MCP server; it does not replace or bundle it. The
server keeps being registered by each consumer's own `.mcp.json` (`infra-kit mcp`, key
`infra-kit`), and the deploy-guard hooks keep living in each consumer's own hooks directory. The
plugin ships **no `mcpServers`** and **no hooks**, by design: a plugin is per-user and opt-in,
and neither a shared self-updating server nor a fail-closed guard can be owned by something a
teammate may never have installed. The reasoning is recorded in
`.omc/plans/infra-kit-claude-plugin.md` (D4, D9).

## What it contains

| Component | Name | Purpose |
| --- | --- | --- |
| skill | `/infra-kit:comment-verifier` | Reviews and fixes comments against the "why, not what" policy, with a mechanical verify step |
| skill | `/infra-kit:fe-architect` | Builds and reviews the inside of a React feature (naming, containers, state, services) |
| skill | `/infra-kit:fe-patterns` | Cross-feature boundaries, injection patterns, promotion to shared |
| skill | `/infra-kit:e2e-architect` | Per-feature Playwright e2e layout: page object, fixture, specs by axis |
| skill | `/infra-kit:update-toolchain` | Bumps pnpm, Node and Turbo across a monorepo, phase by phase |
| skill | `/infra-kit:full-cycle` | deep-interview → ralplan → review gate → ralph → verify (requires oh-my-claudecode) |
| agent | `code-quality-validator` | Runs the monorepo's quality gates and reports per package |

Skill scripts run from the plugin root (`${CLAUDE_PLUGIN_ROOT}/skills/<skill>/scripts/…`) and
each skill's `allowed-tools` whitelists exactly the commands its body runs, so a bundled script
executes without a permission prompt.

## Install

From the consumer repo root:

```
infra-kit init
```

That is the whole install. `init` writes the two pointer keys into `.claude/settings.json`
(`extraKnownMarketplaces` and `enabledPlugins`, nothing else), registers the marketplace when this
machine does not already know it, and runs the project-scope install. Every step reads host state
first, so re-running `init` on a configured machine spawns nothing.

The commands `init` runs, for anyone who wants to run them by hand:

```
claude plugin marketplace add ArthurSaenz/infra-kit
claude plugin install infra-kit@infra-kit --scope project
```

These are the fallback, not the normal path. `init` prints them when `claude` is not on PATH — it
cannot install a plugin without Claude Code — and warns with them when a step fails. `infra-kit
doctor` reports the same prerequisite as its `claude CLI` row.

Pass `--skip-plugin` to write the settings keys and skip the install entirely, for a container
image build or anywhere a subprocess is unwelcome.

**Always `--scope project`.** The CLI default is `user`, which would activate this plugin in
every repository you open. Its skills are written against this family's conventions and every
skill description costs context on every turn, so the correct scope is the repo that uses them.
Project scope writes `enabledPlugins` into `.claude/settings.json`, the same key `init` manages.

## Update

Edit under `plugins/infra-kit/`, bump `version` in `.claude-plugin/plugin.json` **in the same
commit** (CI fails otherwise), push to `main`. Consumers pick it up on the marketplace
auto-update after their next session start (up to ten minutes), then `/reload-plugins` or the
next launch. Run `claude plugin tag ./plugins/infra-kit` to create the `infra-kit--v<version>`
release tag.

## Remove or opt out

Both registration keys are plain settings and can be removed by hand; there is no command for
it and none is needed.

- Repo-wide: delete `extraKnownMarketplaces["infra-kit"]` and
  `enabledPlugins["infra-kit@infra-kit"]` from `.claude/settings.json`.
- This machine only: set `"infra-kit@infra-kit": false` under `enabledPlugins` in
  `.claude/settings.local.json`. `init` never overwrites an existing value, so the opt-out
  survives every later `init` run.

## Token budget

Every skill description is loaded into context on every turn. The release checklist runs
`claude plugin details infra-kit`, parses the projected token cost, and fails when it exceeds
the recorded value below by more than 20%. Growing the budget is allowed; it must be a
deliberate edit of this line in the same commit.

- Recorded projected always-on token cost: **1438** (plugin version 0.1.0, measured with `claude --plugin-dir ./plugins/infra-kit plugin details infra-kit`)

## Tests

From this repo's root, `pnpm run test:claude` runs every skill's `__tests__/*.test.mjs`, the
plugin manifest guard suite in `plugins/infra-kit/__tests__/`, and the hook suite. `pnpm run qa`
invokes it last. `claude plugin validate ./plugins/infra-kit --strict --json` must exit 0.
