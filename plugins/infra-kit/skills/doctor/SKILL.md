---
name: doctor
description: Diagnose an infra-kit setup — the CLI health report plus the checks only a live session can make.
allowed-tools: Read, Bash(infra-kit doctor), Bash(node "${CLAUDE_PLUGIN_ROOT}"/skills/doctor/scripts/session-probe.mjs *), mcp__plugin_infra-kit_infra-kit__version
---

# infra-kit doctor

Two halves. The CLI reports host state; this skill adds what only a running session can see, and
never restates a check the CLI already makes.

## Step 0 — read the environment before the report

Check whether `CLAUDE_CONFIG_DIR` is set. The infra-kit CLI does not honour it — it always reads
`~/.claude` — so when that variable is set and points elsewhere, the CLI's plugin-related rows
describe a directory the user is not using. Say so **before** printing the report in step 1, not
after: a caveat that arrives afterwards lands once the reader has already believed the wrong rows.

The probe in step 2 reports this too. Reading it early is the point.

## Step 1 — run the CLI report and show it verbatim

Resolve the binary, first hit wins:

1. `infra-kit` on `PATH` — the normal case; consumer repos run a global install.
2. `node <repo>/apps/infra-kit/cli/dist/cli.js` when that file exists — a working copy of the CLI.

Never use `pnpm exec`: it sets `npm_*` variables that change behaviour, and in a repo with no local
install it resolves a different binary than the one being diagnosed.

```
infra-kit doctor
```

**Show the output as it comes, without rewriting or re-grouping it.** It is already grouped into
sections, already rolled up, and each failing line already carries its own fix. Reformatting it
means holding a second copy of a list this skill does not own, and that copy goes stale silently.

**A non-zero exit here is a diagnosis, not a broken command.** The CLI deliberately exits 1 when the
plugin is not installed for the current project — which is exactly the machine someone runs this on.
Never report that as a tool failure.

If neither binary resolves, do **not** stop. Say the CLI half is unavailable and why, then run
step 2 anyway: it needs nothing from the CLI, so it still works on the machine where the CLI is the
thing that is broken.

## Step 2 — run the session probe

```
node "${CLAUDE_PLUGIN_ROOT}"/skills/doctor/scripts/session-probe.mjs <plugin-root>
```

If `${CLAUDE_PLUGIN_ROOT}` is empty in the shell, substitute this skill's own base directory with
the trailing `/skills/doctor` removed, and pass it as the argument. The variable is reliably
substituted for hooks and MCP servers, not for shell commands, so treating it as always-set is how
this breaks.

The probe answers five questions the CLI cannot, because each compares against the **live session**:
which tree this session loaded, whether that matches what Claude Code recorded, whether a newer
version is sitting in the cache, whether the loaded skills tree is intact, and whether the config
directory is the one the CLI assumes.

It always exits 0. Its findings are in its output.

## Step 3 — interpret

State the failing lines from both halves and what they mean together. Two combinations worth calling
out explicitly, because neither half says it alone:

- The CLI says the plugin serves the server, but no `mcp__plugin_infra-kit_infra-kit__*` tools are
  in this session. Either the session is stale — started before the plugin advanced — or a leftover
  `.mcp.json` key in this repo is shadowing the plugin's copy under the older prefix; the CLI's
  report says which. A file on disk cannot tell a server that started from one that did not; the
  session is the only place this shows up.
- The CLI reports the plugin as installed, but the probe reports the loaded tree is not the recorded
  one. The records are right and the session is stale — it was started before the install.

Then two checks that only a live tool call can make. Call the server's `version` tool (under
whichever prefix this session exposes it) and read its structured result:

- `repoRoot` must equal the directory this session runs in (`pwd`). When it does not, the server
  was spawned for another checkout — say which, and that every row above describes that one.
- `launch` names the route that spawned the server: `plugin` (its tools carry the
  `mcp__plugin_infra-kit_infra-kit__` prefix) or `legacy` (this repo's own `.mcp.json` entry, the
  shorter project-level prefix). Report it as-is; the CLI already judges whether that route is the
  intended one.
- A result with **no `launch` field** means the CLI predates 0.8.0. The fix is the update command
  the CLI itself prints. **Never run `infra-kit setup` from a CLI older than 0.8.0 in a repo whose
  `.mcp.json` no longer carries the `infra-kit` key** — that CLI's `setup` re-adds it.

## Step 4 — offer fixes

Fixes are **listed, not run by this skill.** Give the exact command and let the person run it, so
the decision to change their machine is theirs and they see what it does first.

- Re-running the setup command (`setup`) is the fix for most plugin, marketplace and guidance-block
  failures; the CLI's own lines name it where it applies.
- The CLI's repair flag (`--fix`) resolves the two things it knows how to repair, and refuses while
  a dev session is running. Its report says when it is worth running.
- Stale per-package guidance is regenerated by the audit command's fix mode.
- A leftover or misfiled `.mcp.json` entry is a hand edit in a PR: the plugin carries the server
  now, and a project-scope key with the same name shadows it. Never rewrite that file.
- Anything the probe reports as drift, staleness or a truncated tree is fixed by reinstalling the
  plugin and restarting Claude Code. Restarting alone is enough when only the session is stale.

Ask before running anything that changes state, and run only what was agreed to.
