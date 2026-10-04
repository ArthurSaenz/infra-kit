---
name: ultraqa
description: Release QA through infra-kit e2e, on a release branch only — asks English or Hebrew first, pulls the release's Jira tickets (descriptions and comments) into context, runs every app's full Playwright suite locally or against a deployed env, re-runs the domains the release changed, keeps a resumable state file, and hands back one QA report plus a shareable page in the chosen language. Reports only — it never edits a test to make it pass.
argument-hint: [<app,...>] [--local | --cloud <env>] [--lang <en|he>] [--base <ref>] [--fresh] [--slow-mo [<ms>]]
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(infra-kit env-list --json*), Bash(infra-kit env-status --json*), Bash(infra-kit release list --json*), Bash(node "${CLAUDE_PLUGIN_ROOT}"/skills/ultraqa/scripts/qa-state.mjs *), Bash(git rev-parse *), Bash(git diff --name-only *), Bash(git log --oneline *)
---

# ultraqa — a QA pass over a release branch

CLI on PATH: !`zsh -c 'infra-kit version --json' 2>/dev/null || echo '{"error":"infra-kit not on PATH"}'`

Branch: !`git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown`

The tool is `infra-kit e2e`. Everything below runs it through `Bash` with `--json --agent`, from the
root of the release checkout — the directory Claude Code was launched in, or the release worktree
section 2 picked, in which case every command carries the `cd <path> && ` prefix that section names.

**Version floor.** On `{"error": …}` above, or a `version` below `0.15.0` (the first CLI whose
`e2e --json` reports `servedEnv` and refuses a local run against a dev server on another env), tell
the human to update — `pnpm add -g infra-kit@latest` — and stop.

This skill **reports**; it does not repair. Never edit a spec, a Page Object, a snapshot or a config,
never add `test.skip` / `fixme` / `fail`, never pass `--update-snapshots`, never widen a timeout or
add retries. Fixing a failure is `/infra-kit:e2e-architect`'s Diagnose procedure, run by the human
after reading the report.

The phases run in order and each one ends by writing its outcome to the state file (section 2).
Keep the terminal quiet: one short status line per phase, tables only where this file asks for one.

## 1. Arguments and language

The skill hands you `$ARGUMENTS` verbatim.

- `<app,...>` → the `--app` of each run. No app → every e2e app the repo has (section 3).
- `--local` → local mode: this worktree's dev server, reused when it runs, started for the run
  otherwise. Never confirm-gated.
- `--cloud <env>` → cloud mode against the deployed app of Doppler config `<env>` (section 4).
- No mode given → ask (section 4).
- `--lang <en|he>` → the language of the pass; skips the language question.
- `--base <ref>` → the ref the release is compared against (section 6). Default: `origin/main`.
- `--fresh` → start a new state file even when one exists for this release (the old one is kept
  beside it, renamed).
- `--slow-mo [<ms>]` → offer the watched pass (section 11) without asking; `<ms>` defaults to `1500`.

**Language comes first** — before any other question or tool call, unless `--lang` named it, ask
with `AskUserQuestion`: **English** or **עברית (Hebrew)**. From then on every question, status
line, the report and the page in section 10 are in that language. What stays as is: commands, paths,
JSON keys, ticket keys, test titles, and Jira text quoted from a ticket. In Hebrew, keep each such
token on its own (backticked, or a separate table cell) so the right-to-left text around it does not
reorder it.

## 2. Release branch and state file

This skill runs on a **release branch only** (`release/v<semver>` or `release/<name>`). Open the
state:

```
node "${CLAUDE_PLUGIN_ROOT}"/skills/ultraqa/scripts/qa-state.mjs init --lang <en|he> --base <ref>
```

(`--base` only when `$ARGUMENTS` gave one; `--fresh` appended when it did.)

**Not on a release branch** — `{"status": "not_release_branch", "branch", "releaseWorktrees"}`.
List the open releases:

```
infra-kit release list --json --agent
```

and ask with `AskUserQuestion` which release to test. Then:

- **The release has a worktree** (a `releaseWorktrees[]` row with its `path`) — the smooth way is for
  the human to start Claude Code in that worktree and re-invoke the skill there. If they would rather
  stay, work from here: every later Bash command runs as `cd <path> && <command>` (the shell's cwd
  does not survive between calls), `init` is re-run that way, and Read/Glob/Grep take paths under
  `<path>`. Say once that this way the host prompts for most commands, because the worktree sits
  outside the launch directory.
- **It has none** — the human switches to it (`git switch <branch>` in their terminal) or creates its
  worktree (`infra-kit worktrees add`, preview → approve → `--yes`), then re-invokes the skill. Never
  switch the human's checkout yourself.

**A state already exists** — `"resumed": true`, with a summary of it (not the full run history).
Show its `phases` in one line and ask:

- `sameHead: true` → **resume** from the first `pending` phase (the state holds every earlier
  answer: language, mode, env, apps, domains, results), or **start over** (`init … --fresh`).
- `sameHead: false` → the release moved since that pass, so everything measured on the old commit
  is stale. Offer **re-point** (`init … --rebase`, recommended): it keeps language, mode, env, apps
  and the ticket fetch, re-links tickets to the new commits without calling Jira, empties the runs,
  and sets scope → page back to `pending`, so the pass resumes at section 6. Or **start over**.
- `{"status": "base_mismatch", "stateBase", "requested"}` → `--base` differs from the one the state
  was taken on. Ask: keep `stateBase` (re-run `init` without `--base`), or re-point to the new base
  (`init … --base <ref> --rebase`).

**Resuming never trusts the shell.** The state remembers the env's name, not its variables: before
the first resumed phase, run section 4's `env-status` check, and `env-load -c <state.env>` when it is
not loaded.

**What the state is.** `~/.infra-kit/qa/<repo>/<release>/state.json` — outside the repo on purpose,
so a QA pass never dirties the branch it tests and survives the worktree. `init` prints its
`stateDir`; tell the human that path once. Every later phase writes its part with `update`, which
merges objects key by key and replaces arrays whole — send the full array each time. The patch goes
on stdin through a quoted heredoc, because ticket text, error lines and checklist items carry
apostrophes that would end a single-quoted argument:

```
node "${CLAUDE_PLUGIN_ROOT}"/skills/ultraqa/scripts/qa-state.mjs update - <<'JSON'
{"phases": {"env": "done"}, "mode": "local", "env": "dev"}
JSON
```

| Phase (section) | Writes                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| apps (3)        | `apps[]` — `app`, `testsDir`, `target`, `served`, `status` (`run` / `scaffold-only` / `local-only`); `phases.apps` |
| env (4)         | `mode`, `env`, `servedEnv`, `phases.env`                                                                           |
| tickets (5)     | written by the script itself                                                                                       |
| scope (6)       | `focusDomains[]` — `app`, `domain`, `paths`, `tickets`; `coverageGaps[]`; `phases.scope`                           |
| runs (7–8)      | `runs[]` — `app`, `kind`, `exitCode`, `report`, `summary`, `failures`; `hollowGreen[]`; `phases.runs`              |
| report (9)      | `verdict` — `level`, `reason`; `manualChecklist[]` — `ticket`, `item`, `status`; `phases.report`                   |
| artifact (10)   | `artifact` — `url`; `phases.artifact`                                                                              |

A phase the human chose to skip is written as `"skipped"`, never `"done"`.

## 3. Discover the e2e apps

Run `infra-kit e2e --dry-run --json --agent` once with no `--app`.

- More than one app: it exits 2 with `{"status": "argument_required", "argument": "app", "choices"}`.
  That is the listing, not a failure — the app names are `choices.properties.app.enum`.
- One app: it exits 0 with the dry-run plan for that app.
- Then one `infra-kit e2e --app <app> --dry-run --json --agent` per app gives `testsDir`, `target`,
  `served` and `devCommand`. Keep them; the report needs them.

An app whose `testsDir` holds no spec (Glob `<testsDir>/src/**/*.spec.ts`) is reported as
**scaffold only** and not run — Playwright exits non-zero on "No tests found", which is not a test
result. An app whose dry-run has `deployedUrlEnv: null` cannot run in cloud mode (the CLI errors
before Playwright starts): in a cloud QA pass, report it as **local only** and leave it out.

## 4. Pick the mode and load the env

Unless `$ARGUMENTS` named one, ask the human with `AskUserQuestion`:

- **Local (recommended for a release under work)** — tests this checkout, mocks included. Still
  needs an env loaded (below): suites read basic-auth credentials from it, and some configs throw at
  load without them.
- **Cloud** — tests what is deployed. List the envs first:

```
infra-kit env-list --json --agent
```

Put every `configs` entry into the same question (or a follow-up). A release branch is deployed to
whichever env the team deployed it to — the CLI keeps no release → env map, so never guess it.

Both modes need an env loaded into the shell before the first run — the cloud env for cloud, and
for local whichever env the human names (offer `dev` first; the dev servers read their config from
it too). The Jira credentials of section 5 come from the same env:

```
infra-kit env-status --json --agent
```

If it does not report `<env>` as loaded, run `infra-kit env-load -c <env> --json --agent` — there is no
confirm step in the CLI, and the host's prompt on that argv is the approval — then re-check
`env-status`.

A cloud run is confirm-gated: `infra-kit e2e --app <app> --cloud --json --agent` exits 2 with
`{"status": "confirmation_required", "message", "plan", "rerun"}`. That does not mean the call failed.
Show `plan.baseUrl` and `plan.env` to the human once for all apps, and on their go run each `rerun`
joined by spaces with `--yes` appended, unchanged. Never add `--yes` before the human has seen that
URL. `{"status": "refused"}` (a protected env such as production) is the human's to clear — relay it
and stop; do not retry.

## 5. Release tickets (mandatory)

The release's Jira fix version is named after the branch (`release/v1.4.0` → `v1.4.0`,
`release/<name>` → `<name>`). Pull every ticket in it, with its description and all comments:

```
node "${CLAUDE_PLUGIN_ROOT}"/skills/ultraqa/scripts/qa-state.mjs tickets
```

It writes `tickets.json` and `tickets.md` into the state dir and prints only the compact rows. Then:

1. **Show the human one table**, nothing more — descriptions and comments never go to the terminal:

   | Ticket          | Type  | Status       | Summary                  | Commits |
   | --------------- | ----- | ------------ | ------------------------ | ------- |
   | [`QA-123`](url) | Story | Ready for QA | Coupon field on checkout | 2       |

   Summary cut to ~70 characters; headers in the chosen language. Under it, one line each when not
   empty: the tickets with **no commit** on the branch (`withoutCommits` — in the release on paper
   only), and the count of **commits naming no release ticket** (`untrackedCount` — changes nobody
   asked QA to look at), with the subjects in `untrackedSample`. PR merges count for the ticket their
   branch name carries; `dev` merges count for none and are not untracked. Then one line: the Jira version link
   (`version.url`) and the path of `tickets.md`.

2. **Read `tickets.md` to the end** into your context — in `offset`/`limit` chunks when it is longer
   than one Read returns; stopping at the first chunk drops the later tickets without a sign. It is what sections 6 and 9 are built from: the
   acceptance criteria, the edge cases raised in comments, the reasons a ticket was reopened.

Refusals:

- `env_missing` — the loaded env lacks the named `JIRA_*` variables. Tell the human which, and offer
  loading another env just for this fetch. `env-load` replaces the shell's env, so after the fetch
  load the run env (`state.env`) back and re-check `env-status` before section 6. Skipping this
  phase is the human's explicit call only, written as `phases.tickets: "skipped"`; the report then
  says the pass ran without ticket context.
- `version_not_found` — no fix version with that name. Ask for the right one and re-run with
  `tickets --version <name>`.
- `base_missing` — the base ref is not in this clone: suggest `git fetch`, then re-run.
- `jira_error` — relay `http` and `body`; a 401/403 is an expired or wrong token, the human's to fix.

## 6. What the release changed

`<base>` below is `state.base` — the one the ticket links were computed on.

```
git log --oneline <base>..HEAD
```

```
git diff --name-only <base>...HEAD
```

Map each changed path to an e2e **domain** — a folder `<testsDir>/src/tests/<domain>/` (and
`<testsDir>/src/visual/<domain>/` where it exists):

1. A path under `apps/<app>/` belongs to that app's suite; a shared package (`packages/…`) touches
   every app that depends on it.
2. Inside the app, match the feature or route folder name against the domain folder names (Glob the
   domains, then Grep the specs for the route or component name when the folder names differ).
3. A changed spec or Page Object marks its own domain.
4. A ticket marks the domain its commits touched (`git diff --name-only <sha>^ <sha>` for each sha in
   `tickets.json`'s `commitsByTicket`), and — for a ticket with no commit — the domain its summary,
   components or description name.

This is a judgement, so say so in the report: list each focus domain with the changed paths and the
tickets that put it there. A changed area with no matching domain is a **coverage gap**, not
something to skip; so is a ticket whose flow no domain covers.

## 7. The runs

**Where a local run's requests go.** A local run tests this checkout's UI and the backends `infra-kit
dev <app>` launches, but every proxy route the UI cannot serve locally (media, dynamic content, any
backend not launched) goes to the deployed app of the loaded env — its `deployedUrlEnv` value. So a
local run's data comes from the env, and the report must say which routes went where:

- **Served target** (`served: true` in the dry-run): `routes[]` is the split the running dev server
  uses — `path`, `source` (`local`/`cloud`), `target`, `live`. Report it as is.
- **Not served**: `routes` is empty, because the Playwright config starts the server for the run. Read
  the routes from `dev.proxy.routes` in the target's `apps/<app>/<ui>/infra-kit.config.ts` instead: a
  route goes `local` when `from` includes `local` and its `packageName` is one of the backends the
  dev command launches, otherwise to its `default` (or first `from`) — `cloud` meaning the value of
  the target's `deployedUrlEnv` in the loaded env. Mark these rows "from config".

**The env of a running dev server.** A served dev server keeps the env it was started with; loading
another env into the shell afterwards does not move its cloud routes. The dry-run reports it as
`servedEnv`, and a local run whose `servedEnv` differs from its `env` refuses (exit 1, "the dev server
serving … runs with env X, this shell with Y"). That refusal is the human's choice to make — ask with
`AskUserQuestion`:

- **Use the server's env** — run `infra-kit env-load -c <servedEnv> --json --agent` (the host's prompt
  is the approval), re-check `env-status`, then re-run.
- **Restart the dev server under this shell's env** — the human stops it in its own terminal; the next
  run's Playwright config starts a fresh one.

Never stop a dev server yourself. `servedEnv: null` on a served target means an older CLI wrote the
dev session's record: say in the report that its env is unknown.

Per app, in this order. Each is `infra-kit e2e --app <app> [--cloud] --json --agent -- <args>`; never
pass `--reporter`, which turns off the per-test results the report is built from
(`report: "caller-reporter"`).

1. **Full suite** — no extra args. Every test, every time; the focus pass never replaces it.
2. **Focus pass** — `-- <domain folders…> --repeat-each=3 --project=chromium`, the domains from
   section 6. A test that passes in run 1 and fails here is **flaky**, reported as such.
3. **Visual pass** — only when the app has `src/visual/` and the mode is local:
   `-- src/visual --project=chromium`. Baselines are per-OS; a missing-baseline failure is reported
   as "no baseline for this OS", not as a regression.

Long suites: run each in the background and wait for it, rather than polling. Read only the JSON on
stdout — Playwright's own log goes to stderr and is not the report. After each run, write `runs[]` to
the state, so an interrupted pass resumes at the next run instead of the first.

Reading a result:

- `report: "collected"` → `summary {expected, unexpected, flaky, skipped}` and `failures[]` are real.
- `report: "unavailable"` → Playwright crashed before writing results: read its stderr, report the
  crash, continue with the next run.
- `exitCode` non-zero with `unexpected: 0` → a setup or webServer failure; report it as an
  environment failure, never as green.

## 8. Hollow green

A passing suite can still assert little. Count, per focus domain, with Grep over `<testsDir>/src`:

- `test.fail(` — a known bug registered as passing; green only while the bug exists.
- `test.fixme(` — a placeholder; an empty body tests nothing.
- `test.skip(` — note which ones are data- or env-conditional (`test.skip(!…)`): on another env they
  may have run.

Report the counts next to `summary.skipped`; they are part of the verdict, not a footnote.

## 9. Report

One message, in the chosen language, in this order:

1. **Verdict** — 🟢 ready / 🟡 ready with notes / 🔴 blocked, and one sentence why. Any `unexpected`
   in a full suite is 🔴; flaky, hollow-green in a focus domain, a coverage gap, or a ticket with no
   commit is at most 🟡.
2. **Context** — release, Jira version link, ticket count, branch, base, commit count, mode, `baseUrl`
   per app, env (and `servedEnv` when a running dev server was reused), and for local runs the route
   split from section 7 — one row per route: `path`, `local`/`cloud`, target URL, live or "from
   config".
3. **Results table**, one row per app and run:

| App     | Run    | ✅ expected | ❌ unexpected | 🔁 flaky | ⏭ skipped | Exit |
| ------- | ------ | ----------- | ------------- | -------- | --------- | ---- |
| `<app>` | full   | 312         | 2             | 1        | 14        | 1    |
| `<app>` | focus  | 45          | 0             | 1        | 0         | 1    |
| `<app>` | visual | 12          | 0             | 0        | 0         | 0    |

4. **Tickets** — one row per ticket: key (linked), its focus domains, the result of those domains
   (✅ / ❌ / 🔁), and **manual only** when no domain covers it or **no commit** when it has none.
5. **Failures** — per `failures[]` row: the run it failed in (full / focus / visual), whether its
   domain is in focus, the ticket it belongs to when one does, title, `file:line`, the first line of
   `error`, the `tracePath` with `pnpm exec playwright show-trace <tracePath>`, and a first
   classification (product defect / intentional product change / test defect / test data or
   environment / flake). Mark the classification as a first read — the e2e-architect Diagnose
   procedure confirms it.
6. **Focus domains** — each domain, why it is in focus, its result, its hollow-green counts.
7. **Coverage gaps** — changed areas and tickets with no domain, and apps reported as scaffold only.
8. **Manual QA checklist** — grouped by ticket: the user-visible flows the ticket and its diff touch
   that no spec asserts, built from the acceptance criteria in its description, the edge cases raised
   in its comments, and the diff (read the diff, not just the file names) — as checkboxes a human can
   click through. Untracked commits get their own group.

Write `verdict` and `manualChecklist[]` (each item `status: "todo"`) to the state.

## 10. The QA page

Always, after the report: publish it as a page in the chosen language. When the `Artifact` tool is
available, load the `artifact-design` skill first, then write the page as `ultraqa-<release>.html`
in the session's scratchpad directory (the publish takes sources only from there or the working
directory) and publish that path. Same sections as the report, with:

- `<html lang="he" dir="rtl">` for Hebrew, `lang="en"` for English; commands, paths, ticket keys and
  test titles in `dir="ltr"` spans (or `<bdi>`) so they keep their order.
- Ticket keys linked to Jira; trace commands as copyable code.
- The manual checklist as real checkboxes, their ticks kept per viewer in `localStorage` (wrapped in
  `try`/`catch`, the page working without it).

When the state already has `artifact.url` (a resumed pass, maybe a new session), read that artifact
first, then publish to its `url` so the link the team has keeps working. Write `artifact.url` to the
state and give the human the link. Without the `Artifact` tool, write the same file and give its
path instead.

## 11. The watched pass (optional)

After the page, offer it with `AskUserQuestion` (skip the question when `--slow-mo` was passed):
which focus domains to watch, and at what speed (`1500` ms default; `3000` for a careful review).

It always runs **locally**, on the human's screen: the Playwright UI with the focus domains loaded,
every test stepping at `<ms>` per action. Run the package's `e2e-test-ui-demo` script — every consumer
package carries it (`infra-kit audit` enforces it as `--ui --headed --workers=1` with
`E2E_SLOW_MO` defaulting to `2000`) — with the speed set and the domain folders as its filter:

`E2E_SLOW_MO=<ms> pnpm --filter <packageName> e2e-test-ui-demo <domain folders…> --project=chromium`

The domain folders are relative to `testsDir`, because the script runs there: `src/tests/<domain>`
for each chosen domain, plus `src/visual/<domain>` where that folder exists. `--project=chromium`
lists each test once instead of once per project. The config reads `E2E_SLOW_MO` into
`launchOptions.slowMo` and stretches the timeout to match, and `infraKitE2e()` reuses this
worktree's dev server or starts it, as for any local run.

**What the UI shows.** Playwright's UI lists only the tests under the folders it was started with —
the filter is applied when the tests are listed, so the UI's own filter box can narrow it further but
never widen it. So:

- **Focus tests** are everything in the tree; nothing marks them as focus, because that is this
  skill's grouping, not Playwright's.
- **Non-focus tests** are not in the tree at all. Watching one means starting the UI again with its
  folder, or with no folder for the whole suite.
- **Visual or not** is the path: files under `src/visual/` are screenshot tests, files under
  `src/tests/` are the domain's ordinary e2e specs.

Run it in the background: the UI holds the process until the human closes its window, so do not wait
on it or kill it. Tell the human the window is open, which domains are loaded under `src/tests/` and
which under `src/visual/`, that tests outside those folders are not listed, and that the slow-mo
speed applies to every test they start from it. The UI produces no JSON — its results are what the
human saw, so ask what failed rather than reporting a verdict from it.

When the human would rather watch without the UI, run the same domains headed instead and report its
`summary` like any other run:

`E2E_SLOW_MO=<ms> infra-kit e2e --app <app> --json --agent -- <domain folders…> --headed --workers=1 --project=chromium`

## 12. What not to do

- Do not patch tests, snapshots or configs; this skill reports.
- Do not run off a release branch, and do not switch the human's checkout to one.
- Do not skip the ticket phase silently, and do not print descriptions or comments to the terminal.
- Do not drop the full suite because a focus pass exists.
- Do not run cloud without the human seeing the URL, and never against an env the CLI refused.
- Do not pass `--reporter` or `--update-snapshots`.
- Do not report a run green on exit 0 alone; read its `summary`.
- Do not call a release env from the branch name — ask.
- Do not write the state anywhere but through `qa-state.mjs`.
