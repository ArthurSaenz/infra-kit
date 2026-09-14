# session — switching a terminal's context through infra-kit

Three tools do the work, and this body is only the procedure that composes them:
`mcp__infra-kit__env-list`, `mcp__infra-kit__env-load` and `mcp__infra-kit__env-clear`. None of them
changes here.

## 1. What a session is

A named context. Today it resolves to exactly one activation — the Doppler environment — and the
name **is** the Doppler config name. There is no mapping table to consult.

The contract a second provider would implement, and the recipe for adding one, live in
`docs/session-context-orchestrator.md`. They are written for whoever adds that provider, not for you.

## 2. How this reaches the user's shell, and how it fails

`env-load` mutates no process. It downloads the config's variables, writes them to
`${XDG_CACHE_HOME:-$HOME/.cache}/infra-kit/$INFRA_KIT_SESSION/env-load.sh` and returns that path as
`filePath`. The zsh block `infra-kit setup` installs registers a `precmd` hook that sources the file
when its mtime beats the last one sourced, the shell's start time, and the clear file.

State all three of the following.

**Timing.** `precmd` runs before a prompt is drawn and cannot run while a foreground process holds
the shell. The variables appear at its next prompt — after Claude Code exits or is backgrounded, not
when the tool returns.

Every zsh spawned from that terminal after the file lands sees it immediately — the `Bash` tool
included — because a fresh shell sources `~/.zshenv` on its own at startup, not through `precmd`.
That holds only when `~/.zshenv` carries the infra-kit session-env block; `infra-kit doctor` reports
the row `zshenv session block` for it, and a machine set up before that row existed needs
`infra-kit setup --skip-tools` once to gain it.
So `infra-kit env-status` run through Bash is a truthful reading of what the agent's own commands
see — it reads that child shell's inherited environment, not the terminal's. `env-status` over MCP
has not changed: it is still the long-lived server's frozen environment, never a verification.

**Destination.** The session id is the one the MCP server inherited when Claude Code launched, so the
file lands in the terminal that launched Claude Code and no other. A server that has outlived its
shell writes into a directory nothing is watching and still returns success — no error, no other
signal. So report the session id from the returned filePath, and tell the human to
compare it with INFRA_KIT_SESSION at their own prompt. That comparison is the only check there is.

**Sourcing it yourself is not a substitute.** Claude Code's `Bash` tool
does not persist shell state between calls, so a `source` call changes nothing durable, and
reporting success from it hides the real failure. A shell spawned fresh after the block lands is
different: it sources `~/.zshenv` on its own at startup, needing no `source` call from you at all.

The loud failure is `INFRA_KIT_SESSION is not set`: the shell block was never installed, or this
shell predates it. Tell the human to run `infra-kit setup --skip-tools` and then `source ~/.zshrc`.
Do not retry — nothing about a second call will differ.

The authoritative reading of what a terminal holds is `infra-kit env-status`
typed in the terminal, not over MCP. Over MCP that tool reads the long-lived server's own
environment, frozen when Claude Code launched, so it can flatly contradict a load you made moments
ago. Never use it to verify one.

## 3. Resolving `$ARGUMENTS`

**A bare token is the environment name.** Call `mcp__infra-kit__env-load` with `config: <token>`.

**No token means the human has not chosen yet.** Call `mcp__infra-kit__env-list`, then ask with
`AskUserQuestion` — one option per environment, and **no table**. You receive `structuredContent`,
not the aligned table `env-list` prints on the CLI path, so any table here is one you hand-built from
JSON.

Carry exactly one field into the options: an environment whose `hasToken` is `false` cannot succeed,
so annotate that option with `infra-kit env-token-set <env>` as its fix. Do not surface `source` — it
records how we learned the environment exists, which helps nobody choose.

More than four environments: offer the four most likely and let a typed "Other" carry the rest. Then
load what they picked. Never invent a name, and never load without an explicit choice.

## 4. The list is local and may be wrong

`env-list` is the union of two local sources: every environment declared in a workflow's
`workflow_dispatch` `environment.options`, and every environment the local token store holds a token
for. It is not a live Doppler enumeration — a Doppler service token is config-scoped and cannot
enumerate its siblings.

Two consequences. First, an empty list is a legitimate result rather than an error: say so, and ask
for a name in prose. Second, a name absent from the list must still be passed to `env-load`, because
the list is not authoritative about what exists. Only `hasToken` is authoritative about what loads.

## 5. The flag

- `--clear` → `mcp__infra-kit__env-clear`, through the two-call confirm protocol in section 6.

`--clear` together with a bare environment token is a usage error and is refused, not resolved by
precedence. Both precedence answers are wrong: loading is not what was asked for, and clearing
discards the name that was typed.

## 6. `--clear`'s confirm gate, and the tie hazard

`env-clear` is gated. **Call 1** — the real arguments, no `confirm` and no `confirmToken` — returns
`{"status": "confirmation_required", …}` carrying `"isError": true`. That is not a failure: nothing
was cleared. Show the human what it resolved, because that is the approval moment. **Call 2** repeats
those arguments unchanged plus `"confirm": true` and the `confirmToken` from call 1. A mismatch comes
back `confirmation_refused`, which is terminal — mint a fresh gate, never reuse a token.

`env-load` is not gated. Say so if the human expects a prompt, so nobody waits for one that never comes.

**The tie hazard.** The shell's clear gate compares mtimes in whole seconds and strictly, while its
load gate does not. A clear whose file lands in the same wall-clock second as the load it follows
therefore loses: the terminal prints `infra-kit: auto-loaded vars for <config>` after the human asked
to clear, or prints nothing and stays loaded. Running `--clear` once more a second later is the
recovery. Tell the human to confirm at their own prompt rather than trusting this tool's return.

**How often this matters.** On this path, rarely — the confirm gate puts a human approval between the
load and the clear, and that latency is usually enough. It is common in scripted or back-to-back use,
where nothing interposes. Raise it when a clear closely follows a load, not on every clear.

## 7. What not to do

- Do not shell out to `doppler`. The tools own the token resolution and the credential filtering.
- Do not `export` anything in a shell, and do not present a file you sourced as a loaded environment.
- Never echo a variable's value. `env-list` reports token presence only, and `env-load.sh` holds
  single-quoted secrets — printing one puts it in the transcript.
- Do not read `isError: true` on a `confirmation_required` payload as a failure. See section 6.
- Do not verify a load with `env-status` over MCP. See section 2.
