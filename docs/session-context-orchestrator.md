# The session context orchestrator

`/infra-kit:session` switches a terminal's context. Today that means one thing — loading a Doppler
environment — but the command is named and shaped for the case where it means several: an AWS
profile, a kubectl context, whatever comes next.

This document is for whoever adds the second one. The agent-facing procedure lives in
`apps/infra-kit/cli/resources/workflow/session.md` and deliberately does not carry any of this: an
agent reading it should spend its attention on the two silent failure modes, not on design
narration.

## The provider contract

A provider is three operations over one named context. None of them is an interface in code today —
there is one provider, and inventing a registry to hold it would be a new tool in all but name.

| Operation    | What it means                            | Doppler env  |
| ------------ | ---------------------------------------- | ------------ |
| `activate`   | Put the context into the user's terminal | `env-load`   |
| `deactivate` | Take it back out                         | `env-clear`  |
| `status`     | Report what the terminal currently holds | `env-status` |

`env-list` sits outside the contract: it answers "what could I activate?", which is a question about
the provider's catalogue rather than about a session.

`status` is listed for completeness and is **not** wired into the command. Over MCP `env-status`
reads the long-lived server's own `process.env`, frozen when Claude Code launched, so it can flatly
contradict a load made moments earlier. The authoritative reading is `infra-kit env-status` typed in
the terminal. See `docs/session-command-plan.md` Q2 before shipping a `--status` flag.

## Adding a provider

1. Add a numbered section to `resources/workflow/session.md` describing the new activation: which
   tool performs it, in what order relative to the existing ones, and how it fails.
2. Extend the success report so it names each provider it activated. A user who asked for one thing
   and got three needs to see the three.
3. Add the new section's load-bearing sentences to the clause table in
   `src/mcp/__tests__/server.test.ts`, and update the pinned line count in the same commit.
4. Republish the CLI. The plugin command's body names a version floor and
   `scripts/check-workflow-resource-published.mjs` enforces it — a procedure that is not yet
   published is a procedure no user's agent can read.
5. Only then widen the command's `argument-hint`, and only if the new provider needs a flag. Every
   flag in that hint must have a matching `` `--flag ` `` … `→` definition line in the body, or U17
   reddens.

## What must not change

Two things are invariant, and a change proposal that touches either one is a different piece of work
than "add a provider":

- **The four env MCP tools** — `env-load`, `env-list`, `env-status` and `env-clear`. Not their
  schemas, not their descriptions, not their handlers. `session` composes tools; it does not own
  them, and each stays usable on its own. This is the constraint the whole design was chosen to
  satisfy.
- **The command's frontmatter** — `plugins/infra-kit/commands/session.md`'s `name` and its three
  pinned keys. Renaming the command means a new resource URI, a new floor sentence and another
  publish.

**The command's fallback line is not invariant — review it.** The command's second line tells the
agent what to do when the resource cannot be read, and it currently says to load the Doppler
environment. That wording is deliberately provider-scoped: after a second provider exists the line is
a degraded path rather than a wrong one, but it does still describe only Doppler, and whoever adds
the provider should decide whether that remains the right degradation. The body has room for exactly
three non-empty lines (U14), so the decision is what to spend the third one on.

## Where a workspace map goes, when one is needed

Today a session name **is** a Doppler config name — an identity mapping with nothing to configure.
A real map (`prod` → this Doppler config, that AWS profile, this kube context) becomes worth having
the moment a second provider exists.

When it does: it belongs in `infra-kit.json`, the runtime config, next to `envAutoLoad`. It does not
belong in `infra-kit.config.ts`, which holds audit rules and is read by the audit path, not by
anything running at session time.

That move is gated on a published CLI. `infraKitConfigObject` is `.strict()`, so a consumer repo
carrying a `session` key against an older CLI is refused outright with `Unrecognized key` — the key
has to ship before any repo may adopt it.
