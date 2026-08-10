# .claude/hooks

The one place to look. Every hook, what it refuses, and which way it fails.

Pinned by `__tests__/hook-map.test.mjs`: if a file here is undocumented, or a doc claims a disarmed
rule is enforced, the suite fails. Run it with `pnpm run test:claude` — deliberately **not** part of
`pnpm qa` (see CLAUDE.md), so nothing else will run it for you.

## The map

| Event | Registered command | Role | Verdicts | Fails |
|---|---|---|---|---|
| `PreToolUse` / `Bash` | `bash-launcher.mjs` → `block-deploy.mjs` | deploy guard | deny via JSON | **closed** |
| `PreToolUse` / `Bash` | `bash-guard.mjs` | advisory guards | block (exit 2) / advise | **open** |
| `PreToolUse` / `Edit\|Write` | `protect-files.mjs` | protected paths | block (exit 2) | policy closed, **load open** |
| `PostToolUse` / `Edit\|Write` | `edit-pipeline.mjs` | format + typecheck + lint feedback | context | open |
| `TaskCompleted` | `quality-gate.mjs` | runs `pnpm run qa` | block (exit 2) | policy closed, **timeout + load open** |
| `SessionStart` | `setup-env.mjs` | env bootstrap | context | open |

Only the deploy lane is fail-closed *end to end*, and only because `bash-launcher.mjs` turns a load
failure into a deny. The two rows above marked **policy closed** are closed on the thing they judge —
a protected path, a failing `qa` — and open in their degraded modes: a malformed event or an
unparseable `hooklib.mjs` exits non-2, and non-2 does not block. This column said plain `closed` for
both until it was measured; `printf 'not json' | node protect-files.mjs` exits 0. Known limit #4 is
the shared cause, and the launcher is the shape of the fix.

Libraries, imported rather than registered: `hooklib.mjs` (event parsing, allow/block/context,
segment splitting), `lock.mjs` (cross-hook mutex), `lint-report.mjs` (lint output shaping).

## Why the Bash lane is two processes

This is the question people arrive with, so it is answered here rather than in a commit message.
The two entries are **not** duplication — they differ in three ways, each one tested:

| | deploy lane | advisory lane |
|---|---|---|
| Failure direction | closed — bad input or any error denies | open — a broken guard is skipped |
| Block channel | `permissionDecision: deny` JSON, exit 0 (holds under `bypassPermissions`) | stderr + exit 2 |
| False positives | **correct** — over-blocking a deploy costs nothing | **defects** — blocking `rg deliver src/` is a bug |

They cannot share a process. A syntax error is a module-link error: the file's body never runs, so
no `try/catch` and no declared fail direction is reachable, and Node exits 1 — which does **not**
block. Merged, a typo in a `grep` tip would silently disarm the prod deploy guard.

`bash-launcher.mjs` exists because that same mechanism applies to `block-deploy.mjs` itself. It is
~40 lines importing only Node builtins; it spawns the guard and turns any exit outside {0, 2} into a
deny, so a broken guard is a loud refusal instead of a silent pass. **Never add a relative import to
it** — that reopens the hole it closes, and the test suite enforces the rule.

The advisory lane is deliberately *not* wrapped: it is fail-open by design, and letting a `grep` tip
deny every Bash command is how guards get resented and deleted.

## Deploy rules — `block-deploy.mjs`

The switch is `const BLOCK` near the top of that file. Flip a line to open a rule. Delivery has no
line, so no line opens prod.

| Rule | State | What it refuses |
|---|---|---|
| `ghApiDispatch` | on | `gh api` against `/dispatches` (it POSTs implicitly on `-f`/`-F`) |
| `httpDispatch` | on | `curl` / `wget` / any assembled URL hitting `/dispatches` |
| `ghRunRerun` | on | re-running a past run — the run being repeated may have been a deploy |
| `ghWorkflowRun` | **off — `false`, not currently refused** | raw workflow dispatch. Disarmed so the non-deploy workflows stay dispatchable; prefer the infra-kit command regardless |

Delivery (`ik release deliver`, `dx-release-deliver`, and every spelling) is refused unconditionally,
with no switch: it merges the release PR into `main` with `--admin` and deploys prod.

**Allowed and expected:** deploying to non-prod through infra-kit — `mcp__infra-kit__gh-release-deploy-all`
/ `-selected`, or the CLI equivalents. infra-kit refuses prod itself. All reads are allowed:
`gh run list` / `view` / `watch`, `gh workflow view`, `gh api` GETs.

`.claude/settings.json` also carries `permissions.deny` entries for delivery and `doppler secrets`.
They are **defence in depth, not duplication**: a `deny` rule survives the hook file being deleted,
which is the one gap the hook cannot cover. Where the two disagree on wrapped or prefixed forms, the
hook is the more precise layer.

## Advisory rules — `bash-guard.mjs`

All six live in that one file as named exports, dispatched in this order (`doppler` first: when a
command trips two guards, the one about secrets is worth showing).

| Guard | Verdict | What it catches |
|---|---|---|
| `doppler` | block | `doppler secrets …` — prints secret values into a permanent transcript |
| `destructive` | block | `rm -rf`, bare `git push --force`, SQL `drop`/`truncate` |
| `package-manager` | block | `npm` / `yarn` / `npx` in a pnpm workspace |
| `style` | advise | prefer `rg` over `grep`, over `find -name` |
| `cmux` | block | `pnpm dev` outside a cmux session |
| `worktree` | block / advise | raw `git worktree add\|remove`; advises on `list` |

A guard may declare `scope = 'segment'` to be run per shell segment, so its `^`-anchored regex still
matches in `cd apps/client && npm install`. `style` and `cmux` deliberately read the whole line —
segmenting would strip the pipe that makes `grep foo | wc -l` acceptable, and the `cmux` that
authorises a wrapped `pnpm dev`.

The dispatcher sits behind `invokedDirectly()`, so the unit tests import the guards directly without
the file reading stdin. Deliberately not `import.meta.main`, which only exists from Node 24.2 and is
`undefined` below it — every guard here would no-op with the suite still green, because the tests
never reach that line. `hook-map.test.mjs` refuses the spelling.

## Tests

| File | Covers |
|---|---|
| `block-deploy.test.mjs` | the deploy lane's corpus — named command tables plus `reason` assertions |
| `bash-guard.test.mjs` | each advisory guard as a unit, plus dispatcher integration |
| `bash-guard-corpus.test.mjs` | frozen snapshot of advisory verdicts; catches a rule lost in a move |
| `block-deploy-coverage.test.mjs` | every guarded literal in the deploy lane is named by a test command; catches a `SHELL_WRAPPERS` entry added without a row |
| `design-notes.test.mjs` | the `## Design notes` sections above cite real files at reachable lines |
| `hook-map.test.mjs` | this README, settings paths, the launcher's zero-import rule, lane isolation |
| `guard-policy.test.mjs` | the over-blocking policy (I1/I2) as an executable invariant |
| `edit-hooks.test.mjs`, `lint-feedback.test.mjs`, `hook-lock.test.mjs`, `quality-gate.test.mjs`, `process-containment.test.mjs` | the Edit/Write and TaskCompleted lanes |

## Known limits

1. **A determined agent is not bound.** `eval`, base64 → `sh`, write-a-script-then-run-it. This layer
   shapes the well-meaning agent; the real control is server-side.
2. **`protect-files.mjs` cannot protect these hooks.** It matches `Edit|Write` and reads
   `tool_input.file_path`, which Bash events do not have — so `sed -i` is invisible to it.
3. **A parse error in `bash-launcher.mjs` itself fails open**, with nothing left to catch it. That is
   why it is small, builtins-only, and changes essentially never.
4. **`hooklib.mjs` is a shared load-time failure domain.** Four hooks import it, three of which
   block; a parse error there takes all four down at once, silently. The launcher does not cover
   this. Tracked as follow-up work.

## Design notes

Why a few things are the way they are. Kept here rather than inline because each is a *story* — an
incident, a measurement — and the code sites only need the rule. Anything a person editing a
specific line must know stayed in that line's comment.

### The quality gate queues, it never refuses (`quality-gate.mjs:35`)

`waitMs: 0` plus a block on contention meant a peer holding the lock failed a task that was itself
fine. Parallel subagents then ping-ponged exit 2 at each other through the model. The gate now waits
60s and allows on timeout — the next completion re-runs `qa` over the whole monorepo anyway, so a
skipped run is far cheaper than a task that cannot finish.

### `waitMs` means what it says, and for a while did not (`lock.mjs:113`)

The acquire loop was bounded by an attempt count *as well as* by the deadline, and the count was
almost always the smaller of the two: 100 attempts x a 50ms poll capped **every** wait at ~5s. So the
paragraph above described behaviour the code did not have — the gate asked for 60s, gave up after
5.4s, and skipped `qa` under exactly the parallel subagents it was written for. Measured, not
inferred: at `waitMs: 60_000` the call returned null after 5385ms.

It survived because the suite pinned `waitMs: 0` and nothing else, so every larger value was
unverified. The loop is bounded by the deadline now, the count survives as `MAX_STEALS` bounding
steal churn only — its stated job all along — and `hook-lock.test.mjs` pins the contract.

### A skipped check has to be audible (`edit-pipeline.mjs:103`)

Losing the lock skipped every stage and printed nothing. To the agent that is indistinguishable from
a clean run: a false negative from the one hook whose job is catching its mistakes, arriving exactly
when parallelism is highest. `waitMs` was also below the measured hold — 2000ms against 2.6s warm
and 4.6s cold — so on a contended package the skip was the common path, not the rare one.

Now it reports through `additionalContext` and still exits 0. Not exit 2: blocking on contention is
the ping-pong incident above, and repeating it in the faster loop would be worse. Not stderr either,
which is the obvious spelling and the wrong one — measured by holding the lock and editing a real
file, a PostToolUse hook's stderr is **dropped** on exit 0 while `additionalContext` arrives
verbatim. The test that used to assert "a contended edit degrades to silence" was the defect written
down; it now asserts the opposite, channel included.

The same measurement puts a question over `quality-gate.mjs`'s skip notice, which is a plain
`process.stderr.write` on a hook that then exits 0.

### Stage 3b has never fired, and stays (`edit-pipeline.mjs:217`)

The re-lint after reformatting looks for rules ESLint fixed and Prettier put back. Measured across
every real candidate in this repo: **zero conflicts.** It is insurance against config drift, not a
live detector. It stays because the failure it catches is silent and would repeat on every single
edit — the one shape where a never-firing check earns its keep.

### The deploy lane is tested by mutation, not by reading (`__tests__/block-deploy-coverage.test.mjs:1`)

Every literal in `SHELL_WRAPPERS`, `PREFIX_COMMANDS`, `BARE_PREFIX_FAILS_CLOSED`, `GUARDED_TOOLS`
and the dispatch switch was deleted in turn from a copy of the tree, with `block-deploy.test.mjs`
run against each mutant. Twenty-two of them could be deleted with the whole suite still green —
including `dash`, `ksh`, `fish`, `csh`, `tcsh`, bare `infra-kit` as argv[0], and the `npm`/`npx`/
`pnpx`/`yarn` dispatch heads. Those rows exist now.

Two traps that make this measurement lie, both worth knowing before repeating it:

- **A row naming a literal does not test it.** `stdbuf -oL bash -c "…"` names `stdbuf`, but with
  `stdbuf` deleted from the set the *wrapper* scan still denies the command, so the row passes
  either way. Prefix rows must carry no shell wrapper.
- **A mutation that breaks parsing fails every test, which reads as "covered".** Removing
  `case 'gh':` orphans its body and does exactly this. Check the mutant parses first.

The static test only pins that each literal is *named* somewhere. Proving path-exercise needs the
mutation run — roughly 49 x 4s, which is why it is a one-off instrument and not a suite member.
