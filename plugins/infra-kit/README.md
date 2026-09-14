# infra-kit — Claude Code plugin

Engineering skills and the infra-kit MCP server for the infra-kit family of monorepos.
Installed once per repo, updated from this repo, versioned in `.claude-plugin/plugin.json`.

This plugin ships **one `mcpServers` entry** (`.mcp.json`, key `infra-kit`) and nothing more of the
server: the entry points at the global `infra-kit` CLI on `PATH` (`infra-kit mcp`, run in
`${CLAUDE_PROJECT_DIR}`), so the plugin holds the one pointer each consumer's `.mcp.json` used to
hold, and the server's code, version and updates stay with the CLI. The tools it serves are
`mcp__plugin_infra-kit_infra-kit__*`. A repo whose `.mcp.json` still registers `infra-kit` keeps
working on the old prefix — same key, project scope wins — and the server renders its guidance for
whichever route spawned it; the switch is that repo's own PR deleting the key, on no deadline
(`docs/mcp-via-plugin-migration-plan.md`).

The plugin still ships **no hooks**, by design: a plugin is per-user and opt-in, and a fail-closed
guard cannot be owned by something a teammate may never have installed. The deploy-guard hooks keep
living in each consumer's own hooks directory; the reasoning is recorded in
`.omc/plans/infra-kit-claude-plugin.md` (D9).

**Launch Claude Code at the repository root.** A project-scope plugin, and this repo's hooks, load
from `<cwd>/.claude/settings.json` only (measured): a session started in `apps/…` has no infra-kit
skills, commands, tools or guards. The root `CLAUDE.md` block says so, and `infra-kit doctor`
reports it.

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
| command   | `/infra-kit:session`          | Loads a named environment through the server's `session` workflow resource                                                 |
| command   | `/infra-kit:release-create`   | Cuts release branches through the server's `release-create` workflow resource                                              |
| server    | `infra-kit`                   | `infra-kit mcp` — the global CLI on `PATH`; tools are `mcp__plugin_infra-kit_infra-kit__*`                                 |

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

- Recorded projected always-on token cost: **431** (plugin version 0.7.7, measured with `claude --plugin-dir ./plugins/infra-kit plugin details infra-kit`)

The previous recorded value was 347, stamped against plugin version 0.3.0 and left unrefreshed
while four skills and two commands were added; 431 is +24% over it, past the 20% rule, and is
recorded deliberately as the 0.7.7 baseline. The MCP server adds nothing to this number: tool
schemas are resolved at runtime and `plugin details` does not count them. Before that, 1438 was
recorded against 0.1.0 under an older report shape (no always-on / on-invoke split) and is not
comparable to either.

## Tests

From this repo's root, `pnpm run test:claude` runs every skill's `__tests__/*.test.mjs`, the
plugin manifest guard suite in `plugins/infra-kit/__tests__/`, and the hook suite. `pnpm run qa`
invokes it last. `claude plugin validate ./plugins/infra-kit --strict --json` must exit 0.
