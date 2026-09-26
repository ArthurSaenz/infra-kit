# `infra-kit dev --watch` — unit / hybrid test gaps

Status: IN PROGRESS (2026-09-26) — approved by the user; watch is now the default of `infra-kit dev` (`--no-watch` opts out). Companion: [dev-watch-test-plan-integration.md](./dev-watch-test-plan-integration.md).

Scope: cheap tests that fit the existing harness — `dev-server.test.ts` style (temp monorepo, real chokidar,
fake `runBuild` / `turboWatchFactory` / `uiDevFactory` / `dryRunner`) or pure unit. No real turbo/vite.
Everything here runs inside the normal `pnpm run qa`.

## Current state (audit summary)

- Watch pipeline: `turbo watch build` (Rust binary, owns source watching + dep-graph rebuilds) → writes
  `dist/` → chokidar (Node `fs.watch`) on app + package `dist/` → `classifyDistChange` → closure-scoped,
  debounced `runRestart`. UI: `turbo run dev` child; vite's own watcher sees rebuilt lib `dist/`.
- Covered well: dist `change`/`add`/`unlink` → restart, package→app double-event dedup
  (`dev-server.test.ts` "collapses a shared-lib edit into ONE restart"), closure-map late arrival,
  boot-failed recovery, stale-file warning (no-hook mode), budget stop, shutdown ordering, filter vectors.
- 7 of 8 watch tests force `DEV_SERVER_CHOKIDAR_POLL=1`; only the boot-failed recovery test uses native events.

## Gaps — P1

| # | Test | Where | Code under test |
|---|------|-------|-----------------|
| U1 | Fake `turboWatchFactory` invokes `onUnexpectedExit('exited 1')` → exactly one `Watch engine (\`turbo watch build\`) … file saves no longer rebuild` warn; same call after `shutdown()` began → no line | dev-server.test.ts | `setupWatch` `onUnexpectedExit`, `reportEngineDeath` |
| U2 | Write only `x.tsbuildinfo` + `x.js.map` into an app dist → no restart within 1.5s | dev-server.test.ts | chokidar `ignored` in `setupWatch` |
| U3 | `dryRunner` rejects → warn `Dependency-closure map unavailable`; package edit then restarts EVERY app, including one with `watchDeps: false` (locks the fail-safe-overrides-opt-out contract) | dev-server.test.ts | `buildClosureMapSafe`, `handlePackageDistChange` null branch |
| U4 | Closure map present + app with `watchDeps: false` → package edit does NOT restart it (runner level, not only `dep-closure.test.ts`) | dev-server.test.ts | `selectPackageRestartTargets` via runner |
| U5 | Fake uiDevFactory calls `onTaskFailure(pkg)` → row `down`, `failed to start — its \`dev\` task exited`; suffix `; other frontends are unaffected` only with ≥2 UIs; second call no duplicate line; after shutdown no-op; `--no-ui-health` narrates without a dot | ui-health.test.ts | `markUiTaskFailed` |
| U6 | Fake uiDevFactory calls `onLine({pkg})` + `appendLog` → lands in `<app>/ui` log and `turbo.log`; unknown pkg → `<pkg>/ui` | dev-server.test.ts | `startUiDev` routing |

## Gaps — P2

| # | Test | Where | Code under test |
|---|------|-------|-----------------|
| U7 | Two restarts on the same key queued while the first is slow (gate its `startOneApp` on a deferred) → run strictly in order, never overlap | dev-server.test.ts (private access, like the closure-map test) | restart chain |
| U8 | A running app whose restart throws (break the handler module) → `❌ Failed to restart`, row `● down`, no probe | dev-server.test.ts | `runRestart` outcome `null` branch |
| U9 | `--watch` fixture with no `dist/` anywhere → `No app or package dist directories found` warn, `watcher` stays null, engine still spawned | dev-server.test.ts | `setupWatch` early return |
| U10 | Boot build command contains ` --force` iff `watch: true` | dev-server.test.ts (runBuild spy) | `buildApps` |
| U11 | `buildUiApps` rejection → warn (not error), `startUiDev` still called | dev-server.test.ts | `buildUiApps` catch |
| U12 | `budgetState()` → `'warn'` → `Reload memory … after N reload(s)` line, restart proceeds | dev-server.test.ts | `reportGenerationBudgetWarn` |
| U13 | Full argv snapshot of `defaultTurboWatchFactory` and `defaultUiDevFactory` (incl. `--env-mode=loose`, `--output-logs=new-only`, `--no-update-notifier`) — `spawn` mocked | turbo-watch.test.ts, ui-dev.test.ts | spawn argv |
| U14 | UI-only `--watch` session (no API app) still arms the engine with `<ui>^...` filters and no dep-inclusive filter | dev-server.test.ts | `armWatch` |

## Gaps — P3

| # | Test | Code under test |
|---|------|-----------------|
| U15 | After a restart: `restarts` +1, `startedAt` reset | `runRestart` entry carry-over |
| U16 | `classifyDistChange` boundary: `…/dist` must not match `…/dist-old/x.js` (bare-prefix match at `discovery.ts:384,391`) — write the test, fix with a `path.sep` boundary if it reds | `classifyDistChange` |
| U17 | `--dry=json` parser fed a CAPTURED real turbo 2.10 payload (fixture file), not a hand-built object | `dep-closure.ts` parse |
| U18 | Wizard asks the watch question with `default: true` on both the manual and preset branches | `dev-wizard-run.ts` |

## Done when

- All of U1–U14 land; U15–U17 optional.
- New tests use native fs events where timing allows (drop `DEV_SERVER_CHOKIDAR_POLL` from at least the
  basic app-restart test) — polling-only coverage hides `awaitWriteFinish` / atomic-rename behaviour.
- `pnpm run qa` green; no `.skip` / `.only`.
