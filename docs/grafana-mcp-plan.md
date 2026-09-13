# Grafana MCP for infra-kit — design and handoff

> Date: 2026-09-10
> Status: working prototype verified outside this repo; not yet ported.
> Prototype: `docs/grafana-mcp-prototype.mjs` (runs as-is on Node 24, zero dependencies).

## The problem

Claude Code spawns every MCP server **once, when the session starts**, and hands it a frozen
copy of its own environment. Grafana credentials, though, only arrive **later** — a skill runs
`ik env-load` partway through the session. A stock `mcp-grafana` therefore never sees them.

Measured on a live session:

```
claude started:      11:33:04
chrome-devtools-mcp: 11:33:05
@playwright/mcp:     11:33:06    <- never invoked in that session, still spawned
```

The MCP child's environment is the parent's 138 variables plus 11 `CLAUDE_*` added at spawn
(`comm -23` of the two name lists is empty). Nothing can change it afterwards: a child process
cannot write to its parent's environment, and `claude mcp --help` has no `reload`/`restart`
subcommand — those are open feature requests
([#57496](https://github.com/anthropics/claude-code/issues/57496),
[#61474](https://github.com/anthropics/claude-code/issues/61474),
[#36643](https://github.com/anthropics/claude-code/issues/36643)).

## Measured facts the design rests on

Each of these was verified against `mcp-grafana v1.3.0` with a mock Grafana recording the
`Authorization` header it received. They are not inferred from documentation.

| #   | Fact                                                                                            | Evidence                                                                                     |
| --- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | `GRAFANA_SERVICE_ACCOUNT_TOKEN_FILE` is re-read per request — **but only over streamable-http** | stdio: `ALPHA, ALPHA, ALPHA`; http: `ALPHA, ALPHA, BRAVO`                                    |
| 2   | `X-Grafana-URL` is **not** honoured                                                             | two mock Grafanas, both received zero requests; traffic went to the default `localhost:3000` |
| 3   | An inline `GRAFANA_SERVICE_ACCOUNT_TOKEN` takes precedence over the file                        | documented, and the wrapper must `unset` it or the credential pins for the process lifetime  |
| 4   | One process serves many concurrent MCP sessions                                                 | two `initialize` calls → distinct `Mcp-Session-Id`, interleaved `tools/call` all `200`       |
| 5   | A session bound to a killed upstream answers `404`                                              | replacing the upstream requires replaying the handshake                                      |
| 6   | The tool surface is 72 tools                                                                    | `tools/list` against the default flag set                                                    |

Fact 1 is why a local http hop exists at all. Fact 2 is why a URL change means a **new process**.
Fact 5 is why the shim stores the client's `initialize` params.

## Why stdio, not http

An earlier iteration ran `mcp-grafana` as a launchd-supervised daemon on a fixed port, with
Claude connecting over `type: "http"`. It worked, but every problem it introduced traced back to
one root: _the server has to already be running when Claude connects_.

|                              | http daemon                                        | stdio                                              |
| ---------------------------- | -------------------------------------------------- | -------------------------------------------------- |
| who starts it                | launchd, plus an `ik setup` step                   | Claude, automatically                              |
| session map persistence      | needed — a front restart `404`s every live session | not needed; state dies with the session, correctly |
| crash-loop guard             | needed — a busy port makes launchd restart forever | no supervisor, no loop                             |
| port                         | fixed, collides across worktrees                   | none                                               |
| server down at session start | session is toolless with no recovery               | impossible by construction                         |
| cold start                   | unrecoverable                                      | **solved** — see below                             |

The decisive advantage is the last row. stdio keeps a server→client channel open for the whole
session, so the shim can emit `notifications/tools/list_changed` the moment credentials appear.
Over http there is nowhere to push that.

The one argument for the daemon is resource use — one upstream instead of up to N. Lazy start
blunts it: `mcp-grafana` is spawned on the **first Grafana call**, so sessions that never touch
Grafana cost nothing beyond the shim itself.

## Architecture

```
Claude ──stdio──> grafana-stdio ──http──> mcp-grafana ──> Grafana
                       │                       ↑
                       │ per request           └── token file, re-read per request
                       └── ~/.cache/infra-kit/$INFRA_KIT_SESSION/env-load.sh
```

**The channel is the session file, not the shell environment.** `ik env-load` does two things:
it writes that file and it prints its path. The `source` half changes one short-lived Bash
subshell and dies with it — verified: `export` in one tool call is `<UNSET>` in the next. The
file is the only durable trace, and it is what the shim reads.

The shim and the skill agree on the path because both inherit the same `INFRA_KIT_SESSION` from
the Claude process. That variable is frozen, which is fine — it never changes. What changes is
the _contents_ of the file:

```
Bash tool call (the skill):  INFRA_KIT_SESSION=072ed439
claude process (the shim):   INFRA_KIT_SESSION=072ed439
ik env-load writes:          ~/.cache/infra-kit/072ed439/env-load.sh
the shim reads:              ~/.cache/infra-kit/072ed439/env-load.sh   ✓
```

Consequence worth stating in user-facing docs: a bare `export GRAFANA_URL=...` in a tool call
does **not** reach the shim. Only `ik env-load` does.

## Verified behaviour

The prototype was driven through the exact sequence the workflow produces:

```
1. Claude starts a session, no credentials exist
   initialize → mcp-grafana / pending-credentials     (shim answers itself; session stays alive)
   tools/list → 0 tools                               (cache empty on a first-ever run)

2. a skill runs env-load
   shim emits notifications/tools/list_changed

3. Claude re-lists
   tools/list → 72 tools
   Grafana A receives: Bearer TOKEN_ALPHA

4. env-load switches environment mid-session
   Grafana B receives: Bearer TOKEN_BRAVO
   log: GRAFANA_URL changed — replacing upstream
```

Steps 1→3 are the cold start dissolving. Step 4 is a live URL change, which the http design
could only do by restarting a daemon.

## What to build here

The prototype uses only Node builtins, so it bundles to a genuinely standalone entry — a broken
`dist/cli.js` cannot take it down. That matches the existing multi-entry pattern
(`src/entry/{cli,mcp,dev-server,update-check}.ts` → `dist/*.js`), and esbuild's
`external: [...Object.keys(dependencies)]` leaves nothing external to resolve.

```
src/entry/grafana-stdio.ts      → dist/grafana-stdio.js   the shim (port of the prototype)
src/lib/grafana/credentials.ts    parse GRAFANA_* out of the session env file
src/lib/grafana/upstream.ts       lazy spawn, URL-change replace, handshake replay
src/commands/doctor              + a row: binary present, credentials resolvable
```

```json
"bin": {
  "infra-kit": "dist/cli.js",
  "ik": "dist/cli.js",
  "ik-grafana": "dist/grafana-stdio.js"
}
```

Consumer repos then carry one committed line, identical in every worktree:

```json
"grafana": { "type": "stdio", "command": "ik-grafana" }
```

Same shape as the existing `"infra-kit": { "command": "infra-kit", "args": ["mcp"] }`.
`ik setup` needs no new step; `ik worktrees add/remove` need no changes — the shim is
per-session and Claude owns its lifetime.

### Optional: fold publication into `env-load`

`env-load` already holds the freshly-fetched Doppler values. Nothing extra is required for the
shim (it reads the file `env-load` already writes), so this is only worth doing if a bare token
file is wanted for other consumers.

## Prerequisites

- `mcp-grafana` on PATH. Installed via `go install github.com/grafana/mcp-grafana/cmd/mcp-grafana@latest`,
  which lands in `GOBIN` — absent from the PATH Claude inherits when launched from a GUI app, so the
  shim prepends `${GOBIN:-${GOPATH:-$HOME/go}/bin}` itself.
- `GRAFANA_URL` and `GRAFANA_SERVICE_ACCOUNT_TOKEN` in the Doppler config. **Not present in
  `hulyo/dev` as of this writing** — checked with a positive control (`HULYO_MONGODB_CONNECTION`
  found in the same file, `grafana` case-insensitive found zero times).

## Rejected alternatives, with reasons

Recorded so they are not re-litigated.

- **`${VAR}` expansion in `.mcp.json`.** Expanded against the Claude process environment, which is
  frozen at launch. Also broken in the desktop app ([#40372](https://github.com/anthropics/claude-code/issues/40372)).
- **`envFile` in `.mcp.json`.** An open feature request ([#28942](https://github.com/anthropics/claude-code/issues/28942)), not a feature.
- **Wrapping the command in `doppler run`.** Resolves inside the child, which is an improvement,
  but still at spawn time — it cannot see an `env-load` that happens later.
- **The official `grafana-mcp` plugin** (`claude-plugins-official`). Runs `docker run … -t stdio`
  with credentials from `user_config`/keychain. Simpler to set up and needs no Doppler, but it is
  **stdio to the real server**, so fact 1 applies and mid-session credentials are impossible. It
  also requires Docker. Its only extra content is ~350 lines of skill/steering docs; the tool
  surface is identical. Note it enables itself at _project_ scope in a git-tracked
  `.claude/settings.json` — easy to commit to the whole team by accident.
- **An off-the-shelf stdio↔http MCP proxy** ([mcp-oauth2-proxy](https://github.com/gaoletsgo/mcp-oauth2-proxy),
  [hyper-mcp-remote](https://github.com/tprunk/hyper-mcp-remote), [mcp-proxy](https://github.com/mikluko/mcp-proxy)).
  The transport half is commodity and these implement it well, but all of them interpolate
  credentials **at process start**; the dynamic ones refresh OAuth tokens on their own schedule,
  not from a local file.
- **A path-routing front (`/mcp/dev` vs `/mcp/arthur`) for per-environment routing.** The client's
  URL is fixed when Claude launches, so the router cannot help a session switch environments. It
  adds code and changes nothing.

## Open items

1. **Unverified: how Claude Code reacts to `notifications/tools/list_changed`.** The protocol side
   is verified — the shim emits it and the message is well-formed — but whether this client
   re-lists on receipt has not been observed. If it does not, the cold start costs one session
   restart, once per machine, because the tool-list cache covers every later session.
2. **Tool-list cache invalidation.** The cache is keyed by nothing; a `mcp-grafana` upgrade that
   changes the tool set would serve a stale list until the first successful live `tools/list`
   overwrites it. Keying the cache file by binary version would close this.
3. **`-session-idle-timeout-minutes 0`** is set deliberately. A one-minute-timeout probe showed a
   stale session id still answering `200` after 75s idle, but the reason was not established —
   disabling reaping avoids depending on that single observation.
4. **Concurrency.** The shim serialises nothing; MCP allows concurrent in-flight requests and
   `ensureUpstream` is guarded by a single promise, but this was not load-tested.

---

## Phase-0 probe results (2026-09-10)

Run against `mcp-grafana` at `~/go/bin/mcp-grafana` on darwin 25.2.0. These retire two of the
open items above and settle the lifetime policy in `docs/grafana-mcp-port-plan.md`.

### P0-d — does an stdio child exit when its parent is SIGKILLed? **YES, 3/3.**

Probe: a throwaway Node parent spawns `mcp-grafana -t stdio` with `stdio: ['pipe','pipe','pipe']`
(the exact Option D shape), the child is confirmed alive at t+2s, the parent is `kill -9`ed, and
the child is re-checked at t+3s.

```
run 0: alive_before=37348 -> EXITED
run 1: alive_before=39260 -> EXITED
run 2: alive_before=39712 -> EXITED
```

**Consequence:** Option D's process-lifetime claim holds — closing the parent's pipe write end
gives the child stdin EOF and its read loop returns. No parent-pid poll and no reap sweep are
needed, which is what dissolves the P1-vs-P3 tension recorded in the port plan. An explicit
`kill()` on `exit`/`SIGTERM`/`SIGINT` is still worth having for the *graceful* path (it reclaims
the child immediately instead of at the next read), but it is a courtesy, not the guard.

Note this is the opposite of the http design's behaviour: an http upstream holds a listening
socket and has no pipe to lose, which is exactly why open item 3 was open at all.

### P0-c — session-dir reachability. Terminal half **GREEN**; GUI half **CONFIRMED BROKEN**.

*Terminal half, measured live on a cmux/login-zsh-launched Claude Code session:*

| where | `INFRA_KIT_SESSION` |
| --- | --- |
| Bash tool call (where a skill runs `ik env-load`) | `632444f4` |
| the `claude` process (pid 68781) | `632444f4` |
| both running MCP server children (68960, 68978) | `632444f4` |

All three agree, so a shim spawned by Claude resolves the same
`<cacheRoot>/632444f4/env-load.sh` that `env-load` writes. Also measured: an `export` set in one
Bash tool call is `<UNSET>` in the next, while `INFRA_KIT_SESSION` persists — confirming the file,
not the environment, is the channel, and that a bare `export GRAFANA_URL=…` can never reach the
shim.

*GUI half, approximated (a real GUI launch cannot be driven from inside a session):* with the
variable unset, the CLI does not fall back — it **refuses**:

```
$ env -u INFRA_KIT_SESSION infra-kit env-status
ERROR: INFRA_KIT_SESSION is not set. Run `infra-kit setup --skip-tools` then `source ~/.zshrc`.
```

**Consequence, and it is worse than the port plan assumed.** Two distinct failures compose in a
GUI-launched Claude: the shim (inheriting no id) reads `<cacheRoot>/no-session/`, and `env-load`
run from a Bash tool call mints a *fresh* id in that shell's profile and writes to
`<cacheRoot>/<random>/`. The two never meet. A "newest dir under cacheRoot" workaround is unsound
because the per-tool-call shell model produces a new dir each time.

Not Grafana-specific: **`ik env-load`'s session-file channel is unreachable from a GUI-launched
Claude for every consumer.** Deserves its own ticket.

### Live smoke test against the real `mcp-grafana` v1.3.0 (2026-09-10)

Every lifecycle test drives a fixture written for this repo, so the transport assumption
had to be checked against the actual binary or the whole suite could be green while
nothing worked. The BUILT `dist/grafana-stdio.js` was driven over real stdio:

```
1. initialize, no credentials -> {"name":"mcp-grafana","version":"v1.3.0"} protocol 2025-06-18
2. tools/list, no credentials -> error: none | tools: 0
3. write env-load.sh          -> notifications/tools/list_changed received
4. tools/list                 -> 72 tools (add_activity_to_incident, alerting_manage_routing, …)
```

Three things this establishes that the fixture could not:

- **The stdio framing assumption holds.** `mcp-grafana` speaks newline-delimited JSON-RPC
  on stdio, so the shim's relay is correct against the real thing.
- **Measured fact 3 is live.** The upstream logged `api_key_set=true` from the INLINE
  environment variable, with no token file anywhere — which is the mechanism Option D
  replaced the http hop with.
- **Measured fact 6 reproduces exactly:** 72 tools.

`mcp-grafana` also logs its Grafana-connectivity failures at startup and still serves
`tools/list`, so a wrong or unreachable `GRAFANA_URL` degrades to a working tool list
whose calls fail — not to a dead session.
