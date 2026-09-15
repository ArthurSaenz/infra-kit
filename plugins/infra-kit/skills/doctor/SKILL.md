---
name: doctor
description: Diagnose an infra-kit setup — the CLI health report plus the checks only a live session can make.
allowed-tools: Read, Bash(infra-kit doctor), Bash(infra-kit version --json*), Bash(node "${CLAUDE_PLUGIN_ROOT}"/skills/doctor/scripts/session-probe.mjs *)
---

# infra-kit doctor

CLI on PATH: !`zsh -c 'infra-kit version --json' 2>/dev/null || echo '{"error":"infra-kit not on PATH"}'`

Two halves. The CLI reports host state; this skill adds what only a running session can see, and
never restates a check the CLI already makes.

**cwd.** Every call runs from the directory Claude Code was launched in — the repo root. If the shell
was `cd`'d elsewhere, `cd` back first (the CLI also accepts `-C <dir>`).

## Step 0 — read the environment before the report

**The CLI on `PATH`, and its version.** The block above is the first finding. `{"error": …}` means no
`infra-kit` on `PATH`; a `version` below `0.8.0` means a CLI that predates the skills-only plugin.
Either way say so **first** and name the fix — `pnpm add -g infra-kit@latest`, or `infra-kit setup`
from the human's own terminal — then go on: the report in step 1 comes from whatever CLI is there
(or from none), and step 2 needs no CLI at all.

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
substituted for hooks, not for shell commands, so treating it as always-set is how this breaks.

The probe answers five questions the CLI cannot, because each compares against the **live session**:
which tree this session loaded, whether that matches what Claude Code recorded, whether a newer
version is sitting in the cache, whether the loaded skills tree is intact, and whether the config
directory is the one the CLI assumes.

It always exits 0. Its findings are in its output.

## Step 3 — interpret

State the failing lines from both halves and what they mean together. Two combinations worth calling
out explicitly, because neither half says it alone:

- The CLI reports the plugin as installed, but the probe reports the loaded tree is not the recorded
  one. The records are right and the session is stale — it was started before the install.
- The probe reports the loaded tree is intact, but the `/infra-kit:*` skills fail at their first
  `infra-kit …` call. The plugin is skills only; the CLI on `PATH` is the tool surface, so this is
  the step 0 finding — no CLI, or one below the floor — and the fix is the update command, not a
  plugin reinstall.

Then one check that only a live call can make:

```
infra-kit version --json --agent
```

Read its structured result:

- `repoRoot` must equal the directory this session runs in (`pwd`). When it does not, the shell was
  moved to another checkout — say which, and that every row above describes that one, and `cd`
  back to the launch directory (the cwd rule at the top) before any other `infra-kit` call.
- `version` is the CLI every skill in this plugin drives. Below `0.8.0` the skills' `--agent --json`
  contract is not there; say so with the update command.
- A CLI that still carries a served-server route in this result, or a repo whose `.mcp.json` still
  registers an `infra-kit` key, is stale: the CLI's report says which and what to delete.
  **Never run `infra-kit setup` from a CLI older than 0.7.7 in a repo whose `.mcp.json` no longer
  carries the `infra-kit` key** — that CLI's `infra-kit setup` re-adds it.

## Step 4 — offer fixes

Fixes are **listed, not run by this skill.** Give the exact command and let the person run it, so
the decision to change their machine is theirs and they see what it does first.

- Re-running `infra-kit setup` is the fix for most plugin, marketplace and guidance-block
  failures; the CLI's own lines name it where it applies.
- The CLI's repair flag (`--fix`) resolves the two things it knows how to repair, and refuses while
  a dev session is running. Its report says when it is worth running.
- Stale per-package guidance is regenerated by the audit command's fix mode.
- A leftover `infra-kit` key in the repo's `.mcp.json` is a hand edit in a PR: nothing serves that
  key any more, and a project-scope entry only spawns a server the skills never call. Never rewrite
  that file yourself.
- Anything the probe reports as drift, staleness or a truncated tree is fixed by reinstalling the
  plugin and restarting Claude Code. Restarting alone is enough when only the session is stale.
- A CLI below the floor is fixed by updating the global install, never by pinning the plugin back.

Ask before running anything that changes state, and run only what was agreed to.
