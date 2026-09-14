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
