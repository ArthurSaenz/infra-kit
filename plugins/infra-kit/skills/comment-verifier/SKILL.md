---
name: comment-verifier
description: Reviews and then fixes code comments against one comment policy - why not what. This skill should be used when the user asks to review comments, audit JSDoc, check comment quality, or перевірити коментарі in changed or named TypeScript files. One run decides an action per comment, applies the ones that rewrite or remove, and proves mechanically that nothing else in the file changed.
argument-hint: "[files...]"
allowed-tools: Read, Edit, Bash(node "${CLAUDE_PLUGIN_ROOT}"/skills/comment-verifier/scripts/lint-comments.mjs *), Bash(git diff:*), Bash(git merge-base:*), Bash(pnpm --filter * run ts-check), Bash(pnpm run test:claude)
---

# Comment Verifier

## What it does

**Comment the why, never the what.** The full policy, the five actions and the real-corpus bad/good
pairs are in `${CLAUDE_PLUGIN_ROOT}/skills/comment-verifier/references/comment-policy.md`. Read that
file before judging a single comment — it is the only source of the policy, and this body does not
restate it.

One run, four phases, in order. It judges first and writes second, but both happen in the same
invocation and the user does not have to ask twice.

```
scope → verdict → apply → verify
```

The verdict is written out in full **before** any file is touched, and it appears in the report. The
guarantee this skill offers is not that it asked permission; it is that every byte it changed **in a
file the snapshot captured** is accounted for by a verdict entry, and `--verify-fix` proves it. That
qualifier is a limit, not coverage: a file the snapshot never captured and the verdict never named
is not checked at all. What the qualifier no longer hides is a verdict reaching *outside* the
baseline — that is now a failure rather than a silence, which is why phase 3 passes the phase-1
scope verbatim.

## Phase 1 — Scope

A widening ladder. The script stops at the first rung that yields anything and reports which rung
answered as `scopeSource`. Rungs 2 and 3 filter to `.ts` and `.tsx` and drop `__tests__`. **Files you
name are honoured verbatim** — dropping one silently would leave you believing it was reviewed — and
anything a rung would have filtered is listed in `unreviewable` instead.

```
node "${CLAUDE_PLUGIN_ROOT}"/skills/comment-verifier/scripts/lint-comments.mjs <files...>
```

It prints `{ scope, scopeSource, counts: { files } }`.

1. **`arguments`** — the files you named.
2. **`working-tree`** — `git diff --name-only --diff-filter=d HEAD`, so staged and unstaged both
   count.
3. **`branch`** — everything changed since the branch forked, `git merge-base HEAD origin/HEAD`.

Rung 3 is what keeps the skill useful **after a commit**. Stopping at `git diff` means a branch
whose work is already committed reviews nothing and reports a clean bill, which is the one answer
this skill must never give by accident.

**Say the `scopeSource` and the `unreviewable` list in the report.** `branch` on a long-lived branch
is a much wider net than `working-tree`, and the reader needs to know which question was answered.
Judge comments only in `.ts` and `.tsx`; report anything in `unreviewable` as skipped and leave it
byte-identical.

**Never the whole repo**, and never a directory. Scope is always an explicit file list, because a
directory scope is how a comment review turns into an unrequested refactor.

## Phase 2 — Verdict

Judge every comment in scope. **Inputs, and only these:**

1. `${CLAUDE_PLUGIN_ROOT}/skills/comment-verifier/references/comment-policy.md`, verbatim.
2. The scoped files.

There is no mechanical shortcut into this phase, and looking for one is a mistake this skill made
once. `@wl/max-jsdoc-lines` is already an error in the shared ESLint config, so a package's own
`eslint-check` fails on an over-long block before you ever get here — re-running it per file buys
nothing but minutes. And it was never the rule that mattered: every `what`-comment in the policy's
corpus table is a `//` line comment, and no JSDoc rule reads those. **Reading is the whole method.**

**Rules for the pass:**

- **Comments are the only in-scope category.** You are reading code and will notice non-comment
  problems: an unused local, a duplicated branch, a weak name. **Drop them.** Do not report them.
  The one exception is `rename-or-refactor-instead`, which is a verdict *about a comment*.
- **Decide the whole verdict before editing anything.** Judging and writing in the same breath is
  how a reviewer talks itself into a deletion it would not have chosen up front. Write the verdict
  out, then act on it.
- Honour the budget: **do not propose a JSDoc sweep.** Many of this repo's JSDoc one-liners are
  already good why-comments. A review that flags most of what it reads has misread the policy.
- A `delete` quotes the code line that already carries the information. A `keep` names its reserved
  category: external quirk, ordering constraint, fail-safe branch, or workaround.

**Output of this phase:** the verdict array exactly as
`${CLAUDE_PLUGIN_ROOT}/skills/comment-verifier/references/review-contract.md` specifies, held in a
fenced ```json block and written to a scratch file so the later phases can read it. `textHash` is
computed with `--hash`. `replacement` is required and exact for `shorten` and `rewrite-as-why`, and
absent for the other three.

## Phase 3 — Apply

1. **Filter** the verdict to `delete`, `shorten` and `rewrite-as-why`. If the filtered set is empty,
   print `nothing to fix`, skip to the report, and stop. Report every `rename-or-refactor-instead`
   entry as a leftover for a human; it is a code change, not a comment change.
2. **Snapshot before editing:**

   ```
   node "${CLAUDE_PLUGIN_ROOT}"/skills/comment-verifier/scripts/lint-comments.mjs --snapshot <scratch-dir> <files...>
   ```

   **Pass the phase-1 scope verbatim — every file, whichever rung answered.** A snapshot resolved
   from a different rung than the verdict is the divergence `--verify-fix` now refuses: entries
   naming files outside the baseline fail, and a scope that resolves to nothing is refused outright
   rather than written as an empty baseline.

   That snapshot, **not `HEAD`**, is the verification baseline. The working tree routinely carries a
   couple of dozen unrelated dirty files, so a `HEAD` diff would mix this run's edits with
   everything else in flight and prove nothing.
3. **Apply the three write actions yourself, with Edit.** The verdict is exact enough to execute:
   `delete` removes the matched comment, `shorten` and `rewrite-as-why` replace it with
   `replacement` byte for byte. Do not hand the edits to another agent — a second model in the loop
   adds a second thing to verify and takes the one guarantee this skill offers, that every byte
   changed in a captured file is in the verdict, and turns it into a hope.
4. **Match every edit by `textHash`, re-read from the file at edit time.** Line numbers are a hint
   for humans and go stale the moment anything above them changes. A miss is a **reported failure
   naming the entry** — never a silent skip, never a nearest match.

## Phase 4 — Verify and report

Run these in order, capturing each exit code directly rather than through a pipeline:

```
node "${CLAUDE_PLUGIN_ROOT}"/skills/comment-verifier/scripts/lint-comments.mjs --verify-fix <verdict.json> --baseline <scratch-dir>
pnpm --filter <package> run ts-check
```

The second one is not ceremony: a stray `*/` inside a block closes the comment early, and `tsc`
catches that where `esbuild` swallows it. `<package>` is whichever package the scoped files belong
to; from the repo root, `pnpm run ts-check` runs it for every package. It is the right size for the
change — a comment edit cannot break a test, so the full package gate is not what this run owes.
Report both exit codes.

**A failing `--verify-fix` is a stop, not a warning.** Three kinds of stop, with three different
recoveries — the wrong one wastes a correct fix or, worse, looks like it worked.

*An unsanctioned change* (`unsanctioned change at <file>:<line>`, `matches no comment in the
baseline`, `landed against`) is a code-level stop: a byte changed that no verdict entry accounts
for. Name the file and line it reports, **restore that file from the snapshot**, and say so.

*A run-level refusal* — `the verification baseline is empty` or `<file> is named by the verdict but
absent from the verification baseline` — says the comparison never covered what the verdict claimed,
not that the edits are wrong. **There is nothing to restore from**: an empty baseline has no source,
and an unbacked file has no snapshot copy. Re-run phase 3's snapshot over the full phase-1 scope and
verify again. The edits already applied stay; do not undo them blindly.

*`no baseline snapshot for <file>`* means the snapshot itself is incomplete — usually a run that
died mid-copy. Re-take the snapshot from a clean scope before doing anything else; the working tree
already holds the edits, so a fresh snapshot taken **now** would bake them in and prove nothing.
Restore the edited files from whatever snapshot you do have, or from git, and start the run over.

In every case, do not proceed to the summary as though the run succeeded.

The report carries, in this order: the `scopeSource`, the full verdict, what was applied, the two
exit codes, then one line:

```
removed N, shortened N, rewritten N, kept N, left for a human N
```

## Manual e2e checklist

These acceptance rows are a model's output, so they are checked by hand, not by `node --test`.

- **End to end:** run on `__fixtures__/restating-fix.ts`. `git diff --numstat` reads `0 3`, the
  macOS realpath workaround comment survives verbatim, `--verify-fix` passes, and the reported
  `ts-check` exit code is 0.
- **Verdict before edits:** the report shows the full verdict, and every changed comment in a
  captured file appears in it. A change with no entry is the failure this skill exists to prevent.
- **A verdict reaching outside the snapshot is a stop:** name a file in the verdict that
  `--snapshot` never captured, and the run reports `absent from the verification baseline`, exits
  non-zero, and does not summarise as successful. The recovery is a re-snapshot, not a restore.
- **Scope discipline:** on a list containing a file with obvious non-comment slop, such as an unused
  local, the verdict contains no finding about it and the file's code is untouched.
- **Nothing to do:** a run on `__fixtures__/clean.ts` edits nothing and prints `nothing to fix`.
- **Keep-only verdict:** produces no edit and the same line.

## Tests

From the infra-kit repo root:

```
pnpm run test:claude
```

It globs this skill's `__tests__/*.test.mjs` under `node --test`, alongside every other skill's and
the hook suite's. **Pass a glob, never a bare directory.** A `--require` preload in this
environment's `NODE_OPTIONS` makes Node treat a directory argument as a CommonJS entry point, so
`node --test <dir>` dies with `MODULE_NOT_FOUND` before discovering anything.

Root `vitest.config.ts` scopes projects to `apps/*/*`, `packages/*`, `vendor/packages/*` and
`vendor/configs/*`, so these tests can never reach turbo's `test` task. `qa` appends `test:claude`
explicitly for exactly that reason.
