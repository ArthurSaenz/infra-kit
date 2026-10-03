---
name: ultraqa
description: Release QA through infra-kit e2e — run every app's full Playwright suite locally or against a deployed env, re-run the domains the branch changed, and hand back one QA report with failures, hollow-green tests, coverage gaps and an optional slow-mo Playwright UI for a human to watch.
argument-hint: [<app,...>] [--local | --cloud <env>] [--base <ref>] [--slow-mo [<ms>]]
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(infra-kit env-list --json*), Bash(infra-kit env-status --json*), Bash(git rev-parse *), Bash(git diff --name-only *), Bash(git log --oneline *)
---

# ultraqa — a QA pass over a release branch

CLI on PATH: !`zsh -c 'infra-kit version --json' 2>/dev/null || echo '{"error":"infra-kit not on PATH"}'`

Branch: !`git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown`

The tool is `infra-kit e2e`. Everything below runs it through `Bash` with `--json --agent`, from the
repo root (the directory Claude Code was launched in; `cd` back first if the shell moved).

**Version floor.** On `{"error": …}` above, or a `version` below `0.14.1` (the first CLI whose
`e2e --json` returns `summary` and `failures[]`), tell the human to update — `pnpm add -g
infra-kit@latest` — and stop.

This skill **reports**; it does not repair. Never edit a spec, a Page Object, a snapshot or a config,
never add `test.skip` / `fixme` / `fail`, never pass `--update-snapshots`, never widen a timeout or
add retries. Fixing a failure is `/infra-kit:e2e-architect`'s Diagnose procedure, run by the human
after reading the report.

## 1. Arguments

The skill hands you `$ARGUMENTS` verbatim.

- `<app,...>` → the `--app` of each run. No app → every e2e app the repo has (section 2).
- `--local` → local mode: this worktree's dev server, reused when it runs, started for the run
  otherwise. Never confirm-gated.
- `--cloud <env>` → cloud mode against the deployed app of Doppler config `<env>` (section 3).
- No mode given → ask (section 3).
- `--base <ref>` → the ref the branch is compared against (section 4). Default: `origin/main` on a
  `release/*` or `hotfix/*` branch, `origin/dev` on anything else.
- `--slow-mo [<ms>]` → offer the watched pass (section 7) without asking; `<ms>` defaults to `1500`.

## 2. Discover the e2e apps

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

## 3. Pick the mode

Unless `$ARGUMENTS` named one, ask the human with `AskUserQuestion`:

- **Local (recommended for a release branch under work)** — tests this checkout, mocks included.
  Still needs an env loaded (below): suites read basic-auth credentials from it, and some
  configs throw at load without them.
- **Cloud** — tests what is deployed. List the envs first:

```
infra-kit env-list --json --agent
```

Put every `configs` entry into the same question (or a follow-up). A release branch is deployed to
whichever env the team deployed it to — the CLI keeps no release → env map, so never guess it.

Both modes need an env loaded into the shell before the first run — the cloud env for cloud, and
for local whichever env the human names (offer `dev` first; the dev servers read their config from
it too):

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

## 4. What the branch changed

```
git rev-parse --abbrev-ref HEAD
```

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

This is a judgement, so say so in the report: list each focus domain with the changed paths that put
it there. A changed area with no matching domain is a **coverage gap**, not something to skip.

## 5. The runs

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
   section 4. A test that passes in run 1 and fails here is **flaky**, reported as such.
3. **Visual pass** — only when the app has `src/visual/` and the mode is local:
   `-- src/visual --project=chromium`. Baselines are per-OS; a missing-baseline failure is reported
   as "no baseline for this OS", not as a regression.

Long suites: run each in the background and wait for it, rather than polling. Read only the JSON on
stdout — Playwright's own log goes to stderr and is not the report.

Reading a result:

- `report: "collected"` → `summary {expected, unexpected, flaky, skipped}` and `failures[]` are real.
- `report: "unavailable"` → Playwright crashed before writing results: read its stderr, report the
  crash, continue with the next run.
- `exitCode` non-zero with `unexpected: 0` → a setup or webServer failure; report it as an
  environment failure, never as green.

## 6. Hollow green

A passing suite can still assert little. Count, per focus domain, with Grep over `<testsDir>/src`:

- `test.fail(` — a known bug registered as passing; green only while the bug exists.
- `test.fixme(` — a placeholder; an empty body tests nothing.
- `test.skip(` — note which ones are data- or env-conditional (`test.skip(!…)`): on another env they
  may have run.

Report the counts next to `summary.skipped`; they are part of the verdict, not a footnote.

## 7. The watched pass (optional)

After the report, offer it with `AskUserQuestion` (skip the question when `--slow-mo` was passed):
which focus domains to watch, and at what speed (`1500` ms default; `3000` for a careful review).

It always runs **locally**, on the human's screen: the Playwright UI with the focus domains loaded,
every test stepping at `<ms>` per action. Run the package's `e2e-test-ui-demo` script — every consumer
package carries it (`infra-kit audit` enforces it as `--ui --headed --workers=1` with
`E2E_SLOW_MO` defaulting to `2000`) — with the speed set and the domain folders as its filter:

`E2E_SLOW_MO=<ms> pnpm --filter <packageName> e2e-test-ui-demo <domain folders…>`

The domain folders are relative to `testsDir` (`src/tests/<domain>`), because the script runs there.
The config reads `E2E_SLOW_MO` into `launchOptions.slowMo` and stretches the timeout to match, and
`infraKitE2e()` reuses this worktree's dev server or starts it, as for any local run.

Run it in the background: the UI holds the process until the human closes its window, so do not wait
on it or kill it. Tell the human the window is open, which domains are loaded, and that the slow-mo
speed applies to every test they start from it. The UI produces no JSON — its results are what the
human saw, so ask what failed rather than reporting a verdict from it.

When the human would rather watch without the UI, run the same domains headed instead and report its
`summary` like any other run:

`E2E_SLOW_MO=<ms> infra-kit e2e --app <app> --json --agent -- <domain folders…> --headed --workers=1 --project=chromium`

## 8. Report

One message, in this order:

1. **Verdict** — 🟢 ready / 🟡 ready with notes / 🔴 blocked, and one sentence why. Any `unexpected`
   in a full suite is 🔴; flaky, hollow-green in a focus domain or a coverage gap is at most 🟡.
2. **Context** — branch, base, commit count, mode, `baseUrl` per app, env (and `servedEnv` when a
   running dev server was reused), and for local runs the route split from section 5 — one row per
   route: `path`, `local`/`cloud`, target URL, live or "from config".
3. **Results table**, one row per app and run:

| App     | Run    | ✅ expected | ❌ unexpected | 🔁 flaky | ⏭ skipped | Exit |
| ------- | ------ | ----------- | ------------- | -------- | --------- | ---- |
| `<app>` | full   | 312         | 2             | 1        | 14        | 1    |
| `<app>` | focus  | 45          | 0             | 1        | 0         | 1    |
| `<app>` | visual | 12          | 0             | 0        | 0         | 0    |

4. **Failures** — per `failures[]` row: title, `file:line`, the first line of `error`, the `tracePath`
   with `pnpm exec playwright show-trace <tracePath>`, and a first classification (product defect /
   intentional product change / test defect / test data or environment / flake). Mark the
   classification as a first read — the e2e-architect Diagnose procedure confirms it.
5. **Focus domains** — each domain, why it is in focus, its result, its hollow-green counts.
6. **Coverage gaps** — changed areas with no domain, and apps reported as scaffold only.
7. **Manual QA checklist** — for each focus domain, the user-visible flows the diff touched that no
   spec asserts (read the diff, not just the file names), as checkboxes a human can click through.

Then offer once: the watched pass (section 7), and to publish the report as a shareable page.

## 9. What not to do

- Do not patch tests, snapshots or configs; this skill reports.
- Do not drop the full suite because a focus pass exists.
- Do not run cloud without the human seeing the URL, and never against an env the CLI refused.
- Do not pass `--reporter` or `--update-snapshots`.
- Do not report a run green on exit 0 alone; read its `summary`.
- Do not call a release env from the branch name — ask.
