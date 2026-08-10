---
name: full-cycle
description: Decomposition pipeline - deep-interview clarifies the task, ralplan breaks it into right-sized units with testable acceptance criteria, a review gate checks that breakdown, you approve, then ralph implements unit by unit and verify proves it. Stops for you several times and expects you present throughout. Requires oh-my-claudecode. Use for multi-file work with real unknowns; not for small changes.
argument-hint: "[--from=interview|plan|plan-review|implement|verify] <idea or task description>"
aliases: [fullcycle]
pipeline: [full-cycle, deep-interview, ralplan, ralph, verify]
next-skill: deep-interview
next-skill-args: --standard
handoff: .omc/specs/full-cycle-{slug}.md
handoff-policy: approval-required
---

# Full Cycle

## What This Skill Does

**Decomposition is the point.** Everything else is scaffolding around it.

    scope -> interview -> DECOMPOSE -> review the breakdown -> approval -> implement -> verify

A vague task cannot be implemented and cannot be verified. This pipeline turns one into a list of
units that each fit in a single iteration and each carry a criterion you can mechanically check —
and only then starts writing code. The interview exists to make decomposition possible; the review
gate exists to catch a bad breakdown before it becomes a bad implementation; ralph consumes the
units one at a time.

If the breakdown is wrong, everything downstream is wrong. Spend the time there.

## Do Not Use When

- **The task is small.** Under ~3 files, or with no real unknown, there is nothing to decompose.
  Use `/oh-my-claudecode:ralph` directly, or delegate to an `executor` agent.
- **You already have a good breakdown.** Skip to it with `--from=implement`.
- **You want fire-and-forget.** It stops for you several times and expects you present.
- **You expect one pass.** `implement` ends the run; re-invoke to reach verification.
- **oh-my-claudecode is not installed.** Every stage delegates to it, though Claude Code will still
  offer this skill.

## Where am I?

Work it out from what is on disk, cheapest check first:

1. no `.omc/specs/deep-interview-*.md` → **interview**
2. no `.omc/plans/ralplan-*.md` newer than that spec → **plan**
3. no `<plan>.review.json`, or its `status` is `pending` → **plan-review**
4. review says `changes-requested` → back to **plan**
5. ralph has run (see `.omc/progress.txt`) → **verify**
6. otherwise → **approval**

Before any of it: the branch is not trunk (stop and ask if it is), and `deep-interview`,
`ralplan`, `ralph`, `verify` resolve as OMC skills.

## Execution Steps

### S0 · scope — STOP

Restate the task in your own words. Name the branch, the stages, roughly how many ralph iterations to
expect, that **each one triggers a full-monorepo `pnpm qa`**, and that **the run ends at `implement`
and must be re-invoked to verify**. Write it to `.omc/specs/full-cycle-{slug}.md` and stop.

Invoking with `--from` **is** scope approval.

### S1 · interview — STOPS

`Skill("oh-my-claudecode:deep-interview")` with `--standard`.

Its job here is not documentation — it is to surface the unknowns that would make decomposition
guesswork. Push it toward the boundaries: what is in scope, what is explicitly not, and what nobody
has decided yet. It stops on its own approval gate; note the spec path it returns.

Its body will show `Pipeline: deep-interview -> plan`. That hop is right — S2 is exactly that,
invoked as `ralplan`.

Do not glob for the spec if you lose it: the interview derives its own slug and takes no slug
argument, and a repo accumulates specs. Ask the user which one.

### S2 · decompose — ENDS THE RUN

```
Skill("oh-my-claudecode:ralplan") --deliberate --architect codex --critic codex
```

All three flags are required. If Codex is unavailable ralplan falls back to the Claude reviewers —
say so and let the user choose, rather than accepting a review by the same model that wrote the plan.

**Ask it for a breakdown, not an essay.** Pass the interview spec and require that the plan's work
list has units that are:

- **right-sized** — completable in one ralph iteration, not a phase
- **ordered** — foundational units first, dependents after, dependencies stated
- **independently checkable** — at least one acceptance criterion naming a concrete file path, a
  runnable command, or a number. "Works correctly" is not a criterion; it is a wish.

A unit that cannot be verified without doing the next one is not a unit. Send it back.

Run non-interactively: ralplan then marks the plan `pending approval` and **stops**. That stop is
not a failure — it is the gap the review gate needs. Re-invoke this skill to continue at S3.

### S3 · plan-review

```
node .claude/skills/full-cycle/scripts/plan-review-gate.mjs --plan=<plan path>
```

A documented no-op today that writes `skipped`. It is a real executing stage so a future
commented-review implementation is a one-file swap — see the contract below. What it is *for* is
reviewing the breakdown: wrong-sized units, missing dependencies, unverifiable criteria.

On `changes-requested`, return to S2 with the review's `comments[]`. Revising the plan changes its
bytes, which invalidates the review, so the next pass lands back here rather than looping.

### S4 · approval — STOP

> Execution approval must be an explicit user message in the **current turn**. A summarized,
> compacted, or recalled approval from an earlier turn is not approval; if it is not present verbatim
> in the live context, re-ask. It is never written to any file.

### S5 · implement — ENDS THE RUN

`Skill("oh-my-claudecode:ralph")`. Hand it the breakdown: ralph is PRD-driven and works one unit at a
time until each passes its own criteria, so a good decomposition is exactly what it needs. Tell it to
scope per-iteration checks to the affected packages and leave full `qa` to S6.

ralph's success path finishes by cancelling, so **do not plan work after it in the same invocation**.

### S6 · verify — re-entry only

`Skill("oh-my-claudecode:verify")` plus a fresh `verifier` agent, so the work is not reviewed by
whoever did it. Walk the acceptance criteria from S2 — that list is the verification plan, which is
the payoff for writing checkable criteria in the first place. Run `pnpm qa`, and `pnpm test:claude`
if anything under `.claude/**` changed. Paste real command output, never a summary.

## Plan-review gate contract

A future commented-review implementation must satisfy all six:

1. **The review file is authoritative.** Its `status` is the verdict; the exit code mirrors it for
   synchronous runs and is never consulted when the file is present and well-formed.
2. `status` ∈ `approved`, `changes-requested`, `pending`, `skipped`. **`pending` is in the enum
   today** because commented human review is long-lived: an implementation may record `pending`,
   return immediately, and be completed by a person later.
3. Synchronous exits: `0` approved/skipped, `3` changes-requested, `4` pending, `1` internal error.
   `--plan` is stable; flags may be added, never removed.
4. `comments[]` entries are `{anchor, body, severity}`, `anchor` being a line range or heading — so a
   comment can point at one unit of the breakdown.
5. **Idempotent per (plan path, `plan_digest`)** — re-running on an unchanged plan is a no-op and
   never overwrites a verdict, but a revised plan gets a fresh review. Without this the
   revise-and-review cycle cannot terminate.
6. Interactive or browser front ends live behind an explicit flag, so CI stays headless.

Plan and review both live under `.omc/`, which is gitignored, so neither shows up in a PR.

## Rules

- **Never enter `implement` without execution approval** — the sentence in S4, verbatim.
- **`--from` says where to start; it never skips a gate.** `--from=implement` still stops at S4.
- **No stage triggers deploys or releases.** `.claude/hooks/block-deploy.mjs` is the sole source of
  truth for what is refused; do not restate its list here or anywhere else.
- **This skill writes no OMC mode state and receives none** — it is not a registered `state_write`
  mode, and skill protection resolves to `none` for any skill whose raw name lacks the
  `oh-my-claudecode:` prefix. Delegated skills manage their own state.
- Run `pnpm run test:claude` after changing anything in this directory.

## Contract drift

- **Pipeline frontmatter renders on one route only.** For a project skill, `pipeline` / `next-skill`
  / `handoff` / `handoff-policy` render only when a user types `/full-cycle` with OMC's hook active.
  Via the native Skill tool, model invocation, or with `DISABLE_OMC` set, they are inert. **The body
  above is primary on every route; the frontmatter only confirms it.**
- **The frontmatter parser is a line-scanner.** Block-form lists parse to empty and a folded
  `description: >-` parses to the literal `>-`. `__tests__/frontmatter.test.mjs` guards both.
