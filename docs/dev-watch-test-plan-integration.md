# `infra-kit dev --watch` — real-process integration / e2e tests

Status: IN PROGRESS (2026-09-26) — the harness lives in-repo at [`sandbox/`](../sandbox/README.md), a standalone pnpm workspace outside the root workspace (decided after the plan was approved; supersedes "a separate sandbox repo" below). Companion: [dev-watch-test-plan-unit.md](./dev-watch-test-plan-unit.md).

## Why

Nothing in the suite runs real turbo, real tsc, real vite or real pnpm against the dev path. Every test
writes `dist/` by hand in place of turbo, and every turbo output format is a hand-written string (the
failure-verdict format was captured on turbo 2.10.3; we are on 2.10.12/2.10.13 in infra-kit/hulyo). A
turbo upgrade that changes `pkg:dev:` prefixes, the `--dry=json` shape, or drops
`--continue=dependencies-successful` / `--only` would pass the whole suite and surface only as missing
tail lines or UIs stuck on `◌ starting`.

The frontend hop "lib `dist/` rewritten → vite reloads" rests on a hulyo spike (2026-07-08) whose
browser confirm is still pending — no test covers it.

## Harness — a separate sandbox monorepo

A real consumer-shaped monorepo, modelled on hulyo/travelist, that is ITSELF the fixture. The e2e suite
lives in that repo and drives `infra-kit dev` against it like a user would.

Layout (mirrors hulyo/travelist conventions — `apps/<app>/{api,ui}`, `packages/*`, turbo.json copied
from hulyo: `build` `dependsOn ^build`, `outputs dist/**`; `dev` persistent, `cache:false`):

- `apps/shop/api`, `apps/admin/api` — serverless-style backends, `tsc -b` → `dist/`, `composite`.
- `apps/shop/ui`, `apps/admin/ui` — vite + `infraKit()` plugin, `devServersPresets` with local/cloud
  routes to the backends.
- `packages/lib-core` (BE shared, `tsc -b`), `packages/types` (shared types, both sides),
  `packages/ui-kit` (FE shared, `vite build` + `vite-plugin-dts`), `packages/api-client` (FE ↔ BE
  interfaces).
- `infra-kit.json` / `infra-kit.config.ts` like a consumer; `vendor/` NOT needed.
- `e2e/` — the vitest suite (`*.e2e.test.ts`, `pool: forks`, `fileParallelism: false`, long timeouts).
  Each test copies the repo to `mkdtemp` (or uses a git worktree), so edits never dirty the checkout.

infra-kit under test: a `link:` dependency on the local `apps/infra-kit/cli` build for day-to-day runs
(pnpm reverts hand-made symlinks — use `link:`), and the published version in CI to catch packaging
bugs. Every test tears down with a process-GROUP kill and asserts no orphan (`ps -g`).

Cheap turbo-contract tests (I1, I2) can stay in infra-kit as a vitest `integration` project if the
sandbox turns out slow; everything that boots servers lives in the sandbox.

## Tests

| # | Priority | Test | Proves |
|---|----------|------|--------|
| I1 | P0 | Real `turbo run dev --ui=stream --continue=dependencies-successful --only` on 2 packages (one good `dev`, one that exits 1) → real stdout/stderr fed through `parseTurboDevLine` / `parseTurboTaskFailure` | turbo output contract; a turbo bump that changes format goes red here |
| I2 | P0 | Real `defaultDryRunner` (`turbo run build --dry=json`) on the fixture → `buildClosureMap` returns `api → {lib-core}` | `--dry=json` shape contract |
| I3 | P0 | **E2E backend loop.** `infra-kit dev --watch --app=api` (non-TTY, so no wizard) → wait for ready → `GET /ping` = `v1` → edit `packages/lib-core/src/index.ts` → real `turbo watch build` rebuilds lib + api dist → exactly ONE `Restarted` line → `GET /ping` = `v2`, no `still serving the OLD` warning | the whole chain: filters, `--continue`, dist layout, chokidar native events, debounce/dedup, module generation |
| I4 | P0 | Same as I3 but edit the app's own `src/handler.ts` | app-dist branch end-to-end |
| I5 | P1 | Introduce a type error in `lib-core` → no restart, server keeps serving `v1` (last-good dist); fix it → restart → `v2`. Engine still alive throughout | `--continue=dependencies-successful` keeps the watcher up |
| I6 | P1 | Add a new file + import it; delete a file | `add`/`unlink` through real tsc output |
| I7 | P1 | Kill the `turbo watch` process group externally → one `Watch engine … file saves no longer rebuild` warn | real `superviseChild` + `reportEngineDeath` |
| I8 | P1 | Run from a symlinked worktree path (`ln -s` to the tmp repo, `cwd` = link). Edit through the link → restart + no false `still serving the OLD` (`monorepoRoot` is not realpath'd at `dev-server.ts:1041`, the generation root is at `:2634`) | realpath asymmetry |
| I9 | P1 | **Shared FE lib → vite.** Real vite with `infraKit()` on `apps/web/ui`; rebuild `ui-lib` dist via `turbo watch build --filter=web-ui^...`; assert vite's watcher fires / `ssrLoadModule` returns the new export | closes the unconfirmed lib→HMR hop |
| I10 | P2 | Smoke: `infra-kit dev --no-ui-health` with UI + API, wait for ready, SIGTERM → exit 0, no orphans (turbo tasks own their process groups) | shutdown reaps real trees |
| I11 | P2 | Rapid 10-save burst on `lib-core` → exactly one restart | debounce under real tsc emit waves (`.js`, `.d.ts`, maps) |

## Status per test

| # | Status | Where |
|---|--------|-------|
| I1 | done — green | `sandbox/e2e/turbo-contract.e2e.test.ts` (turbo 2.11.4) |
| I2 | pending | — |
| I3 | done — green | `sandbox/e2e/backend-watch.e2e.test.ts` |
| I4 | done — green | same |
| I5 | done — **red by design**: a type error in `lib-core` still emits (`tsc -b`, no `noEmitOnError`), so the runner restarts onto the broken build and serves it (`lib: 42`). The "last-good `dist/` keeps serving" premise does not hold; see the report on the sandbox round | same |
| I6 | done — green (add restarts once; delete restarts once more — `tsc -b` leaves the orphaned `dist/extra.js`, so there is no `unlink` event in dist) | same |
| I7 | pending | — |
| I8 | pending | — |
| I9 | pending | — |
| I10 | pending | — |
| I11 | done — **intermittently red** (fails ~2 in 3 under full-suite load, passes alone): still exactly one restart, but sometimes onto save 9 of 10, and the 10th is never compiled. turbo re-runs `lib-core#build` for the last save, but `tsc -b` judges the project up to date because that save's mtime is older than the `tsbuildinfo` the previous run wrote, so no `dist/` change ever reaches the runner | `sandbox/e2e/backend-watch.e2e.test.ts` |

## Order

1. Harness + I2 + I1 (fast, no servers) — they alone guard turbo upgrades.
2. I3/I4 (the core promise of `--watch`).
3. I5–I9, then I10–I11.

## Related findings (not tests, but surfaced by the audit)

- RESOLVED 2026-09-26: watch is now the default (`--no-watch` opts out), so hulyo/travelist's
  `pnpm exec infra-kit dev --self` gets the watch path once they pick up the release.
- travelist `packages/design-system` exports `src/*.css` — edits never touch `dist/`, so dist watching
  cannot see them (vite serves them directly, so the UI is fine; the backend is unaffected).
- Vite libs (`vite build --watch` / turbo `build`) empty `dist/` before writing → unlink/add burst then
  a second `vite-plugin-dts` wave. Covered for backends by debounce; worth I11-style coverage for UI libs.
