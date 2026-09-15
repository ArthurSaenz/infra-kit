---
name: session
description: Switch this terminal's context — load a named environment through the infra-kit MCP server.
argument-hint: [--clear] [<environment>]
disable-model-invocation: true
allowed-tools: mcp__plugin_infra-kit_infra-kit__env-list, mcp__plugin_infra-kit_infra-kit__env-load
---

# session — switching a terminal's context through infra-kit

Terminal status at invocation: !`zsh -c 'infra-kit env-status --json' 2>/dev/null || echo '{"error":"status unavailable"}'`
Environments this project knows: !`zsh -c 'infra-kit env-list --json' 2>/dev/null || echo '{"error":"list unavailable"}'`

Three tools do the work, and this body is only the procedure that composes them:
`mcp__plugin_infra-kit_infra-kit__env-list`, `mcp__plugin_infra-kit_infra-kit__env-load` and `mcp__plugin_infra-kit_infra-kit__env-clear`. None of them
changes here. If `mcp__plugin_infra-kit_infra-kit__*` tools are absent this is a subdirectory or legacy session — say so and stop;
do not improvise with the doppler CLI or by exporting variables in Bash.

`$ARGUMENTS` is the environment and the flags the human asked for; section 3 and section 5 resolve it.

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

State both of the following.

**Timing.** `precmd` runs before a prompt is drawn and cannot run while a foreground process holds
the shell. The variables appear at its next prompt — after Claude Code exits or is backgrounded, not
when the tool returns.

**Destination.** The session id is the one the MCP server inherited when Claude Code launched, so the
file lands in the terminal that launched Claude Code and no other. A server that has outlived its
shell writes into a directory nothing is watching and still returns success — no error, no other
signal. So report the session id from the returned filePath, and tell the human to
compare it with INFRA_KIT_SESSION at their own prompt. That comparison is the only check there is.

**What the injected blocks mean.** The `Terminal status at invocation` block above is the truthful
reading of what has landed for this session id at invocation: `~/.zshenv`'s session-env block sources
the file `env-load` wrote for the inherited `INFRA_KIT_SESSION`, so its `sessionConfig` is the last
load that landed, not what the terminal shows yet. Nothing in this turn can read the post-load state —
the human confirms at their own prompt. `env-status` over MCP reads the session file as of that
call — the server re-applies it before every tool — so it is a truthful check that the load landed
for THIS session id, though never of what the terminal prompt shows yet. This needs infra-kit CLI
0.7.11 or newer; an older server's environment is frozen at launch, and `env-status` there can
flatly contradict a load made moments ago.

`{"error": …}` in the status block means stop before calling anything and tell the human to run
`infra-kit setup --skip-tools`, then `source ~/.zshrc`. The same failure inside a tool result reads
`INFRA_KIT_SESSION is not set`: same cause, same remediation. Do not retry — nothing about a second
call will differ.

**Sourcing it yourself is not a substitute.** Claude Code's `Bash` tool does not persist shell state
between calls, so a `source` call changes nothing durable, and reporting success from it hides the
real failure.

## 3. Resolving `$ARGUMENTS`

**A bare token is the environment name.** Call `mcp__plugin_infra-kit_infra-kit__env-load` with `config: <token>`.

**No token means the human has not chosen yet.** Call `mcp__plugin_infra-kit_infra-kit__env-load` **without `config`**: the
server offers the human a form listing every environment, and the human's pick IS the load. A result
whose `status` is `form_declined` means the human closed the form without choosing — nothing was
loaded; say so and stop. Do not re-open the form and do not pick for them.

The form path needs infra-kit 0.7.8 or newer; an older server answers a tool error or a refused result naming `config` — take the fallback.

**The fallback.** If the call comes back as a tool error or a refused result naming `config`, this client
cannot render forms or the server predates them: read the `Environments this project knows` block
above and show **every** entry as a numbered prose list, `hasToken: false` annotated with
`infra-kit env-token-set <env>` as its fix, then ask in prose which one. Do not surface `source` — it
records how we learned the environment exists, which helps nobody choose. If either block above is not
JSON, treat it as unknown and call `env-list` yourself, then list the same way. Never `AskUserQuestion`,
never invent a name, and never load without an explicit choice.

A load that fails after the pick — an error naming `infra-kit env-token-set <env>` — is relayed as
is. Do not re-open the form; the human has to mint the token first.

## 4. The list is local and may be wrong

`env-list` is the union of two local sources: every environment declared in a workflow's
`workflow_dispatch` `environment.options`, and every environment the local token store holds a token
for. It is not a live Doppler enumeration — a Doppler service token is config-scoped and cannot
enumerate its siblings.

Two consequences. First, an empty list is a legitimate result rather than an error: say so, and ask
for a name in prose. Second, a name absent from the list must still be passed to `env-load`, because
the list is not authoritative about what exists — a name absent from the form must still be typed and
passed as `config`. Only `hasToken` is authoritative about what loads.

## 5. The flag

- `--clear` → `mcp__plugin_infra-kit_infra-kit__env-clear`, through the two-call confirm protocol in section 6.

`--clear` together with a bare environment token is a usage error and is refused, not resolved by
precedence. Both precedence answers are wrong: loading is not what was asked for, and clearing
discards the name that was typed.

## 6. `--clear`'s confirm gate, and the tie hazard

`env-clear` is gated. **Call 1** — the real arguments, no `confirm` and no `confirmToken` — returns
`{"status": "confirmation_required", …}` carrying `"isError": true`. That is not a failure: nothing
was cleared. Show the human what it resolved, because that is the approval moment. **Call 2** repeats
those arguments unchanged plus `"confirm": true` and the `confirmToken` from call 1. A mismatch comes
back `confirmation_refused`, which is terminal — mint a fresh gate, never reuse a token.

`env-load` is not gated, but it can PROMPT — an argument form, not a confirm gate; the human's pick is the load.
Say so if the human expects a confirm prompt, so nobody waits for one that never comes.

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
- Do not supply a `config` the human did not name in order to skip the form.
- Never send `inputResponses` yourself — that field is the human's answer, and the server cannot tell yours from theirs.
- Do not read `isError: true` on a `confirmation_required` payload as a failure. See section 6.
- `env-status` over MCP confirms the file the server will use; it does not confirm the terminal. See section 2.
