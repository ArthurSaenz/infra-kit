---
name: session
description: Switch this terminal's context — load a named environment through the infra-kit CLI.
argument-hint: [--clear] [<environment>]
disable-model-invocation: true
allowed-tools: Bash(infra-kit env-list --json*), Bash(infra-kit env-status --json*)
---

# session — switching a terminal's context through infra-kit

CLI on PATH: !`zsh -c 'infra-kit version --json' 2>/dev/null || echo '{"error":"infra-kit not on PATH"}'`
Terminal status at invocation: !`zsh -c 'infra-kit env-status --json' 2>/dev/null || echo '{"error":"status unavailable"}'`
Environments this project knows: !`zsh -c 'infra-kit env-list --json' 2>/dev/null || echo '{"error":"list unavailable"}'`

Three commands do the work, and this body is only the procedure that composes them:
`infra-kit env-list`, `infra-kit env-load` and `infra-kit env-clear`, each run through `Bash` with
`--json --agent`. Do not improvise with the doppler CLI or by exporting variables in Bash.

**Version floor.** Read the first block above. On `{"error": …}`, or a `version` below `0.8.0`, tell
the human to update — `pnpm add -g infra-kit@latest`, or `infra-kit setup` from their terminal — and
stop. An older CLI answers none of the shapes below.

**cwd.** Every call runs from the directory Claude Code was launched in — the repo root. If the shell
was `cd`'d elsewhere, `cd` back first (the CLI also accepts `-C <dir>`).

`$ARGUMENTS` is the environment and the flags the human asked for; section 3 and section 5 resolve it.

## 1. What a session is

A named context. Today it resolves to exactly one activation — the Doppler environment — and the
name **is** the Doppler config name. There is no mapping table to consult.

The contract a second provider would implement, and the recipe for adding one, live in
`docs/session-context-orchestrator.md`. They are written for whoever adds that provider, not for you.

## 2. How this reaches the user's shell, and how it fails

`env-load` mutates no process. It downloads the config's variables, writes them to
`${XDG_CACHE_HOME:-$HOME/.cache}/infra-kit/$INFRA_KIT_SESSION/env-load.sh` and returns that path as
`filePath`, with the id it wrote under as `sessionId`. The zsh block `infra-kit setup` installs
registers a `precmd` hook that sources the file when its mtime beats the last one sourced, the
shell's start time, and the clear file.

State both of the following.

**Timing.** `precmd` runs before a prompt is drawn and cannot run while a foreground process holds
the shell. The variables appear at its next prompt — after Claude Code exits or is backgrounded, not
when the command returns.

**Destination.** The session id is the one the `Bash` tool inherited when Claude Code launched, so
the file lands in the terminal that launched Claude Code and no other. A session whose terminal is
gone writes into a directory nothing is watching and still returns success — no error, no other
signal. So report the session id from the returned filePath (it is also `sessionId`), and tell the
human to compare it with INFRA_KIT_SESSION at their own prompt. That comparison is the only check
there is.

**What the injected blocks mean.** The `Terminal status at invocation` block above reads the session
file for the inherited `INFRA_KIT_SESSION`, so its `sessionConfig` is the last load that landed —
not what the terminal shows yet. The same call after a load (the CLI re-reads the file on every run)
confirms the load landed for THIS session id, and still says nothing about the terminal prompt:

```
infra-kit env-status --json --agent
```

`{"error": …}` in the status block means stop before calling anything and tell the human to run
`infra-kit setup --skip-tools`, then `source ~/.zshrc`. The same failure inside a command's stderr
reads `INFRA_KIT_SESSION is not set`: same cause, same remediation. Do not retry — nothing about a
second call will differ.

**Sourcing it yourself is not a substitute.** Claude Code's `Bash` tool does not persist shell state
between calls, so a `source` call changes nothing durable, and reporting success from it hides the
real failure.

## 3. Resolving `$ARGUMENTS`

**A bare token is the environment name.** Run `infra-kit env-load -c <token> --json --agent`.
`env-load` is a mutating command that is not pre-approved: the host prompts the human with the argv,
and that prompt is the approval — the CLI has no confirm step here, so there is no `--yes` and no
preview round, and a `--yes` you add is an unknown flag. It exits 0 with
`filePath`, `sessionId`, `variableCount`, `project` and `config`.

**No token means the human has not chosen yet.** Ask with `AskUserQuestion`, one option per entry
of the `Environments this project knows` block above — **every** entry, in the block's order, a
`hasToken: false` entry annotated with `infra-kit env-token-set <env>` as its fix. The human's pick
is the `-c`; the load then runs as above. Do not surface `source` — it records how we learned the
environment exists, which helps nobody choose.

The same picker arrives from the CLI itself: `infra-kit env-load --json --agent` with no `-c` exits
2 with `{"status": "argument_required", "argument": "config", "choices": [...]}` and loads nothing;
its `choices` rows (label, value, description) are the block above, and go into `AskUserQuestion`
the same way. Never invent a name, never narrow the list, and never load without an explicit choice.

**The fallback.** If either block above is not JSON, treat it as unknown and call `env-list` yourself,
then ask the same way:

```
infra-kit env-list --json --agent
```

A load that fails after the pick — stderr naming `infra-kit env-token-set <env>` — is relayed as
is. Do not re-ask; the human has to mint the token first.

## 4. The list is local and may be wrong

`env-list` is the union of two local sources: every environment declared in a workflow's
`workflow_dispatch` `environment.options`, and every environment the local token store holds a token
for. It is not a live Doppler enumeration — a Doppler service token is config-scoped and cannot
enumerate its siblings.

Two consequences. First, an empty list is a legitimate result rather than an error: say so, and ask
for a name in prose. Second, the list is not authoritative about what exists: a name absent from the
picker must still be typed and passed as `-c`. Only `hasToken` is authoritative about what loads.

## 5. The flag

- `--clear` → `infra-kit env-clear --json --agent`, run once, behind the host's prompt — section 6.

`--clear` together with a bare environment token is a usage error and is refused, not resolved by
precedence. Both precedence answers are wrong: loading is not what was asked for, and clearing
discards the name that was typed.

## 6. `--clear`'s approval, and the tie hazard

`env-clear` is a mutating command with **no confirm step in the CLI**: `infra-kit env-clear --json
--agent` clears on the first run. What stands between the human and the clear is the host's
permission prompt on that argv — the command is deliberately absent from this skill's grants, so the
prompt always fires, and the host's prompt is the approval. Say what the call will do before you run it, run it once, and never add
`--yes`: the CLI does not take it. It exits 0 with `filePath` — the unset script the shell sources
next — or exits 1 with a stderr line when nothing is loaded for this session; relay that as is.

`env-load` is the same shape: one host prompt, no `--yes`. Say so if the human expects a second
prompt, so nobody waits for one that never comes.

**The tie hazard.** The shell's clear gate compares mtimes in whole seconds and strictly, while its
load gate does not. A clear whose file lands in the same wall-clock second as the load it follows
therefore loses: the terminal prints `infra-kit: auto-loaded vars for <config>` after the human asked
to clear, or prints nothing and stays loaded. Running `--clear` once more a second later is the
recovery. Tell the human to confirm at their own prompt rather than trusting the command's return.

**How often this matters.** On this path, rarely — the host's prompt puts a human between the load
and the clear, and that latency is usually enough. It is common in scripted or back-to-back use, where
nothing interposes. Raise it when a clear closely follows a load, not on every clear.

## 7. What not to do

- Do not shell out to `doppler`. The commands own the token resolution and the credential filtering.
- Do not `export` anything in a shell, and do not present a file you sourced as a loaded environment.
- Never echo a variable's value. `env-list` reports token presence only, and `env-load.sh` holds
  single-quoted secrets — printing one puts it in the transcript.
- Do not supply a `-c` the human did not name in order to skip the picker.
- Do not read exit 2 on an `argument_required` payload as a failure — it loaded nothing and is
  asking for `-c`. See section 3.
- Never pass `--yes` to `env-load` or `env-clear`; neither takes it, and the host's prompt is the
  approval.
- `env-status` confirms the file the CLI will use; it does not confirm the terminal. See section 2.
