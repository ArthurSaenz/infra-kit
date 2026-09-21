# The session context orchestrator

`/infra-kit:session` switches a terminal's context. Today that means one thing — loading a Doppler
environment — but the skill is named and shaped for the case where it means several: an AWS
profile, a kubectl context, whatever comes next.

This document is for whoever adds the second one. The agent-facing procedure lives in
`plugins/infra-kit/skills/session/SKILL.md` and deliberately does not carry any of this: an agent
reading it should spend its attention on the two silent failure modes, not on design narration.

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

`status` is listed for completeness and is **not** a tool the skill calls. Over MCP `env-status`
reads the long-lived server's own `process.env`, frozen when Claude Code launched, so it can flatly
contradict a load made moments earlier. What the skill does carry is a `!` injection of
`infra-kit env-status --json` at invocation — the reading of what has LANDED for the session id, which
is not the same as what the terminal shows yet. The authoritative reading is `infra-kit env-status`
typed in the terminal. See `docs/session-command-plan.md` Q2 before shipping a `--status` flag.

## Adding a provider

1. Add a numbered section to `plugins/infra-kit/skills/session/SKILL.md` describing the new
   activation: which tool performs it, in what order relative to the existing ones, and how it fails.
2. Extend the success report so it names each provider it activated. A user who asked for one thing
   and got three needs to see the three.
3. Add the new section's load-bearing sentences to the U18 clause table in
   `plugins/infra-kit/__tests__/manifest.test.mjs` in the same commit.
4. If the change needs a newer CLI, bump the floor sentence in the SKILL.md ("the form path needs
   infra-kit X.Y.Z or newer") and keep the fallback clause. There is no gate: the plugin is live on
   merge and the CLI on publish, so the fallback is what a consumer between the two runs, and
   `scripts/report-published-cli-skew.mjs` only reports the gap on the PR.
5. Only then widen the skill's `argument-hint`, and only if the new provider needs a flag. Every
   flag in that hint must have a matching `` `--flag ` `` … `→` definition line in the body, or U17'
   reddens.

## What must not change

Two things are invariant, and a change proposal that touches either one is a different piece of work
than "add a provider":

- **The four env MCP tools** — `env-load`, `env-list`, `env-status` and `env-clear`. Not their
  schemas, not their descriptions, not their handlers. `session` composes tools; it does not own
  them, and each stays usable on its own. This is the constraint the whole design was chosen to
  satisfy.
- **The skill's frontmatter** — `plugins/infra-kit/skills/session/SKILL.md`'s `name`, its
  `disable-model-invocation: true` (it loads secrets into the human's terminal, so only `/name`
  invokes it) and an `allowed-tools` that names no gated tool and carries no `Bash(` rule (U14').

**The fallback clause is not invariant — review it.** Section 3 tells the agent what to do when the
form path is unavailable (a tool error or a refused result naming `config`): list every entry from
the injected `env-list` block in prose and ask. That wording is deliberately provider-scoped: after a
second provider exists it is a degraded path rather than a wrong one, but it does still describe only
Doppler, and whoever adds the provider should decide whether that remains the right degradation.

## Where a workspace map goes, when one is needed

Today a session name **is** a Doppler config name — an identity mapping with nothing to configure.
A real map (`prod` → this Doppler config, that AWS profile, this kube context) becomes worth having
the moment a second provider exists.

When it does: it belongs in `infra-kit.json`, the runtime config, next to `envManagement`. It does not
belong in `infra-kit.config.ts`, which holds audit rules and is read by the audit path, not by
anything running at session time.

That move is gated on a published CLI. `infraKitConfigObject` is `.strict()`, so a consumer repo
carrying a `session` key against an older CLI is refused outright with `Unrecognized key` — the key
has to ship before any repo may adopt it.
