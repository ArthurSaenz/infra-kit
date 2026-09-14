# session env picker — V0 live checks and captures

Companion to `docs/session-env-picker-plan.md` §6.6. Each row is a measurement, not a claim; the plan's
go/no-go (§2.0) reads V0.1.

## V0.6 — the published 0.7.7's answer to `env-load {}` (E-skew fixture)

Captured 2026-09-15 with a hand-rolled stdio client against the global `infra-kit@0.7.7` (`infra-kit mcp`,
the same binary `pnpm dlx infra-kit@0.7.7 mcp` resolves), saved verbatim at
`apps/infra-kit/cli/src/mcp/__tests__/fixtures/env-load-missing-config.0.7.7.json`.

**Correction to the plan's F13.** The published server does NOT answer a JSON-RPC `-32602` error. It
answers a RESULT: `{"result":{"content":[{"type":"text","text":"Input validation error: Invalid arguments
for tool env-load: config: Invalid input: expected string, received undefined"}],"isError":true}}` — on
BOTH an initialize of `2025-11-25` and of `2026-07-28` (0.7.7 negotiates `2025-11-25` for either). The
SDK's `-32602` path exists in the code the Architect cited, but the tool-argument validation on this
build is wrapped into an `isError` result before it reaches the wire. Consequences: the E-skew lane pins
the fixture as an `isError` RESULT whose text contains `config`, and the live refusal as an `isError`
result whose text contains `config` and `env-list`; the body's two-shape phrase ("a tool error or a
refused result naming `config`") stays as the superset a future SDK could produce.

## V0.2 — titled enum through `inputRequired.elicit()`

See the 2026-09-15 addendum in `docs/reviews/elicit-schema-measurements.md`: expressible via a raw
`oneOf` `const`+`title` JSON schema (or `fromJsonSchema` of it), validates on re-entry; rendering by
Claude Code unmeasured; not adopted by this plan.

## V0.1 — the published deploy form rendered live (go/no-go)

Setup: this repo, Claude Code 2.1.270, the plugin's `infra-kit mcp` = global 0.7.7 (which carries the
deploy `formProvider`, commit e9ea02d < 0.7.7); a temporary untracked `.github/workflows/deploy-all.yml`
declaring `environment.options: [dev, stage, arthur]` (deleted afterwards); the model called
`mcp__plugin_infra-kit_infra-kit__local-deploy-all` with `{ dryRun: true }` — a gated tool, round 1, so
nothing could execute.

Wire result: `{"status":"form_declined","tool":"local-deploy-all","action":"decline"}`.
Negotiated protocol version of the served connection: `2025-11-25` (0.7.7 never offers 2026-07-28, see
V0.6). The published server's `Tool execution …` lines do not reach `/tmp/mcp-infra-kit.log` (only the
entry/shutdown lines do — a separate observation, not investigated here), so the request→decline latency
could not be read from the log.

**Verdict: GO.** The human reports a native dialog with a dropdown of the three environments, which they
declined by hand — the `decline` above is theirs, not the host's. So Claude Code 2.1.270 renders the SDK
legacy shim's `elicitation/create` for an `input_required` returned over a 2025-11-25 connection, and the
answer reaches the chokepoint. C1 may start. (V0.3 repeats this for the UNGATED path after C2.)

## V0.3 — the UNGATED form rendered live (after C2, before C4a)

Setup: the C1+C2 build packed from the working tree (`pnpm pack`) and installed as the global
`infra-kit` (`pnpm add -g <tarball>`, still versioned 0.7.7), the plugin's MCP server reconnected in
the running Claude Code 2.1.270 session (`/mcp` → Reconnect; new pid confirmed by `ps`), the same
temporary three-environment `deploy-all.yml` fixture as V0.1 (deleted afterwards; every env token-less
at this root). The model called `mcp__plugin_infra-kit_infra-kit__env-load` with no arguments.

Observed (screenshot): ONE dialog — "MCP server "plugin:infra-kit:infra-kit" requests your input" —
message `Choose the environment to load into terminal session 1e2285d3. Picking one LOADS it; there is
no further prompt.`; one required field `config` rendered as a select ("→ to expand"), its description
`The environment to load. NO stored token for: dev, stage, arthur — choosing one of those fails until
you run \`infra-kit env-token-set <env>\`. The list is what env-list knows: workflow-declared
environments first, then token-only ones.`; Accept / Decline. The human declined; the wire answered
`{"status":"form_declined","tool":"env-load","action":"decline"}` and no second dialog appeared.

**Verdict: GO.** The ungated row U1 reaches the host's dialog through the same legacy shim as the gated
form, the session id and the "the pick is the load" sentence are in the message, and the token-less
annotation is in the field prose. Not exercised live: an Accept (every env here is token-less, so it
would only produce the `env-token-set` error the E-L1 lane already pins).

## V0.4 — the injected reading, measured (partial: the no-load half)

On this machine, in this repo's session (`INFRA_KIT_SESSION=1e2285d3`), with nothing loaded: both the
bare `infra-kit env-status --json` and the `zsh -c 'infra-kit env-status --json'` spelling return the
same object — `sessionId: "1e2285d3"`, `sessionConfig: null`, `sessionTotalCount: 0`. That confirms
F11's half of the claim (the Bash tool here IS zsh, and `INFRA_KIT_SESSION` is inherited, so the bare
spelling is not broken on this host) and leaves `zsh -c` justified as host-independence rather than as
a fix for this host.

**Still unmeasured:** the post-load half — after an in-session `env-load dev`, does the injected block
read `sessionConfig: "dev"`? That needs a load into a session whose token exists (this root has no
tokens) and a re-invocation in the same Claude Code session, i.e. the consumer-repo run below.

## V0.5 — the skill from the built plugin tree

**Not yet run.** Requires a Claude Code restart with the 0.7.9 plugin (installed at project scope for
infra-kit, travelist and hulyo on 2026-09-15) and a `/infra-kit:session` invocation in a repo with
environments: the checks are that the injection fires, that `env-load` raises no permission prompt
(`allowed-tools`), that the elicitation dialog still appears with `allowed-tools` set, that
`/infra-kit:setup` is auto-loadable and `/infra-kit:release-create` is not.
