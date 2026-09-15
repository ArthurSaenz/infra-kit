# infra-kit — Claude Code plugin

Engineering skills for the infra-kit family of monorepos. Installed once per repo, updated from
this repo, versioned in `.claude-plugin/plugin.json`.

The plugin is **skills only**. Its tool surface is the global `infra-kit` CLI on `PATH`, driven
through the `Bash` tool: every procedure skill runs `infra-kit <command> --json --agent` from the
directory Claude Code was launched in, reads the one JSON object the CLI prints on stdout, and
relays it. The plugin holds no `mcpServers` entry, no server pointer and no copy of the CLI — the
CLI's code, version and updates stay with the global install (`pnpm add -g infra-kit@latest`),
and a skill's first line checks that install is at or above the version floor the skill was
written against (`0.8.0` for this plugin version). The migration is recorded in
`.omc/plans/mcp-to-cli-skills-migration.md`; the retired MCP-era plans live in `docs/archive/mcp/`.

The plugin still ships **no hooks**, by design: a plugin is per-user and opt-in, and a fail-closed
guard cannot be owned by something a teammate may never have installed. The deploy-guard hooks keep
living in each consumer's own hooks directory; the reasoning is recorded in
`.omc/plans/infra-kit-claude-plugin.md` (D9).

**Launch Claude Code at the repository root.** A project-scope plugin, and this repo's hooks, load
from `<cwd>/.claude/settings.json` only (measured): a session started in `apps/…` has no infra-kit
skills or guards. The root `CLAUDE.md` block says so, and `infra-kit doctor` reports it.

## How a skill drives the CLI

- **Every call carries `--json --agent`.** `--json` puts the structured result on stdout (human logs
  stay on stderr); `--agent` tells the CLI a model is reading, so it never opens a prompt.
- **A confirm-site command without `--yes` executes nothing** (`release create|remove|desc-edit|merge-dev|deploy-all|deploy-selected`,
  `worktrees add|remove|sync`, `local deploy-all|deploy-selected`). It exits 2 with
  `{"status": "confirmation_required", "message", "plan", "rerun": [...]}`. The skill shows the plan
  to the human, and only after their go-ahead runs exactly `infra-kit <rerun>` — the same argv with
  `--yes` appended. That second call is deliberately absent from every `allowed-tools`, so the host
  prompts the human with the full argv; the prompt is the second half of the approval. `env-load`,
  `env-clear` and `infra-kit setup` have no confirm site: they run once, and the host's prompt on the
  unlisted argv is the whole approval — they take no `--yes`.
- **A missing picker argument** exits 2 with `{"status": "argument_required", "argument", "choices"?}`.
  Where the CLI has a form (`env-load`, `release create`, `release remove`, the deploy pickers) the
  rows arrive as `choices` and the skill puts every row into `AskUserQuestion`; elsewhere the skill
  lists candidates with the read-only `release list --json` / `worktrees list --json`.
- **`{"status": "refused"}`** (exit 2) is a state only the human can clear — relayed, then stop.
  **`{"status": "partial_failure"}`** (exit 1) means something ran and part failed — relayed whole.
  Non-JSON stdout, or exit 1 with no JSON, is a crash: stop and show stderr.
- **`release deliver` is human-only** and refused under agent mode always.
- **cwd.** Every call runs from the directory Claude Code was launched in; a skill that finds the
  shell elsewhere `cd`s back first (the CLI also accepts `-C <dir>`).

### The `allowed-tools` rule

A skill's `allowed-tools` lists **read-only argv only** — `Bash(infra-kit release list --json*)`,
`Bash(infra-kit worktrees list --json*)`, `Bash(infra-kit env-status --json*)`,
`Bash(infra-kit env-list --json*)`, `Bash(infra-kit version --json*)`, `Bash(infra-kit doctor)` —
each resolving to a `mutating: false` row of the CLI's command catalog, never carrying `--yes`, plus
the plugin's own bundled scripts (`${CLAUDE_PLUGIN_ROOT}/skills/<skill>/scripts/…`). Every mutating
argv (`infra-kit env-load`, `infra-kit env-clear`, `infra-kit setup`,
`infra-kit release create|remove|desc-edit|merge-dev|deploy-*`, `infra-kit worktrees add|remove|sync`)
is unlisted on purpose: the host prompts the human with it, and the `--yes` argv keeps the destructive
intent in the transcript. The manifest suite pins this against the catalog (`__tests__/manifest.test.mjs`).
One consequence to know: a "don't ask again" answer to a mutating prompt creates a prefix allow for the
session; the plan (§3.8) has `infra-kit doctor` warn when a committed allow pattern reaches a
mutating command.

## What it contains

| Component | Name                          | Purpose                                                                                                                                |
| --------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| skill     | `/infra-kit:comment-verifier` | Reviews and fixes comments against the "why, not what" policy, with a mechanical verify step                                           |
| skill     | `/infra-kit:doctor`           | Runs the CLI health report, then adds the checks only a live session can make (which plugin tree loaded, drift, staleness)             |
| skill     | `/infra-kit:fe-architect`     | Builds and reviews the inside of a React feature (naming, containers, state, services)                                                 |
| skill     | `/infra-kit:fe-patterns`      | Cross-feature boundaries, injection patterns, promotion to shared                                                                      |
| skill     | `/infra-kit:e2e-architect`    | Per-feature Playwright e2e layout: page object, fixture, specs by axis                                                                 |
| skill     | `/infra-kit:update-toolchain` | Bumps pnpm, Node and Turbo across a monorepo, phase by phase                                                                           |
| skill     | `/infra-kit:full-cycle`       | deep-interview → ralplan → review gate → ralph → verify (requires oh-my-claudecode)                                                    |
| skill     | `/infra-kit:session`          | Loads a named environment into the terminal that launched Claude Code — the human picks from every known env (human-invoked only)      |
| skill     | `/infra-kit:release-create`   | Cuts release branches through `infra-kit release create`, preview → approve → `--yes` (human-invoked only)                             |
| skill     | `/infra-kit:release-remove`   | Tears down one release through `infra-kit release remove`, Jira fix version included, preview → approve → `--yes` (human-invoked only) |
| skill     | `/infra-kit:setup`            | The procedure for `infra-kit setup` under agent mode: ordered local writes, dependency converge, printed-not-run recipes               |

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

A repo whose `.mcp.json` still registers an `infra-kit` key spawns a server nothing in this plugin
calls. Deleting the key is that repo's own PR, on no deadline; `infra-kit doctor` names it.

## Update

Edit under `plugins/infra-kit/`, bump `version` in `.claude-plugin/plugin.json` **in the same
commit** (CI fails otherwise), push to `main`. Run `claude plugin tag ./plugins/infra-kit` to create
the `infra-kit--v<version>` release tag.

How consumers receive it — measured, not assumed (2026-09-14, `docs/archive/mcp/mcp-via-plugin-plan.md`
§6.1): Claude Code does **not** advance a project-scope plugin on its own; every install record on
the author's machine sat at 0.3.0 while `main` was at 0.7.0. The CLI carries the plugin forward
instead. The silent self-update child that runs after a user-typed `infra-kit …` command on a TTY
(at most once per 20 minutes) also runs `claude plugin update infra-kit@infra-kit --scope project -y`
for every project it is installed in, and `infra-kit setup` updates an already-installed plugin
rather than reporting it installed. A machine where nobody types an `infra-kit` command never
advances — the same channel the CLI itself lives on. `/reload-plugins` or the next launch applies a
fetched version; `infra-kit doctor` says when one is fetched but not yet applied.

The plugin and the CLI advance on the same channel but are not pinned to each other, which is why
each procedure skill carries its own version floor: a plugin ahead of the CLI stops at the floor
line and names the update; a CLI ahead of the plugin keeps answering the older skill's argv.

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

- Recorded projected always-on token cost: **562** (plugin version 0.8.0, measured with `claude --plugin-dir ./plugins/infra-kit plugin details infra-kit`)

The previous recorded value was 540 against 0.7.10; 562 is +4%, the reworded descriptions of the
five procedure skills that moved from the MCP server to the CLI. Earlier steps: 496 (0.7.8), 431
(0.7.7, the deliberate re-baseline after 347 sat unrefreshed against 0.3.0), and 1438 (0.1.0, an
older report shape with no always-on / on-invoke split, not comparable). The version-floor `!` line
at the top of each procedure skill is on-invoke, not always-on, so it adds nothing to this number.

## Tests

From this repo's root, `pnpm run test:claude` runs every skill's `__tests__/*.test.mjs`, the
plugin manifest guard suite in `plugins/infra-kit/__tests__/`, and the hook suite. `pnpm run qa`
invokes it last. `claude plugin validate ./plugins/infra-kit --strict --json` must exit 0.

The manifest suite pins the transport: no `.mcp.json` in the plugin, no MCP tool name in any
`SKILL.md`, and every `Bash(infra-kit …)` rule in every `allowed-tools` resolving to a read-only row
of the CLI's command catalog (`apps/infra-kit/cli/src/lib/command-catalog/command-catalog.ts`, read
textually) with no `--yes`.
