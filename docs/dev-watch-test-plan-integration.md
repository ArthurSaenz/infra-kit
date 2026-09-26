# `infra-kit dev --watch` — real-process integration / e2e tests

Status: DONE (2026-09-26) — I1–I11 all landed and green — the harness lives in its own public repo, [ArthurSaenz/infra-kit-sandbox](https://github.com/ArthurSaenz/infra-kit-sandbox), cloned as a sibling of infra-kit (`link:../infra-kit/apps/infra-kit/*`). It briefly lived in-repo at `sandbox/`; moved out so it behaves like a real consumer (own git root, own Layer-3 config). Companion: [dev-watch-test-plan-unit.md](./dev-watch-test-plan-unit.md).

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
| I5 | P1 | Introduce a type error in `lib-core` → one restart onto the emitted build under a type-error warning; fix it → a clean restart → `v2`. Engine still alive throughout | `--continue=dependencies-successful` keeps the watcher up |
| I6 | P1 | Add a new file + import it; delete a file | `add`/`unlink` through real tsc output |
| I7 | P1 | Kill the `turbo watch` process group externally → one `Watch engine … file saves no longer rebuild` warn | real `superviseChild` + `reportEngineDeath` |
| I8 | P1 | Run from a symlinked worktree path (`ln -s` to the tmp repo, `cwd` = link). Edit through the link → restart + no false `still serving the OLD` (`monorepoRoot` is not realpath'd at `dev-server.ts:1041`, the generation root is at `:2634`) | realpath asymmetry |
| I9 | P1 | **Shared FE lib → vite.** Real vite with `infraKit()` on `apps/web/ui`; rebuild `ui-lib` dist via `turbo watch build --filter=web-ui^...`; assert vite's watcher fires / `ssrLoadModule` returns the new export | closes the unconfirmed lib→HMR hop |
| I10 | P2 | Smoke: `infra-kit dev` with UI + API, wait for ready, SIGTERM → exit 143 (`128 + signo`), no orphans (turbo tasks own their process groups) | shutdown reaps real trees |
| I11 | P2 | Rapid 10-save burst on `lib-core` → ends on the last save in at most two restarts | debounce under real tsc emit waves (`.js`, `.d.ts`, maps) |

## Status per test

All in [infra-kit-sandbox/e2e/](https://github.com/ArthurSaenz/infra-kit-sandbox/tree/main/e2e), run on every
sandbox push/PR and weekly against infra-kit `main` by its `e2e` workflow (arm64 runner, portless installed as a
systemd service with `sudo`).

| # | Status | Where |
|---|--------|-------|
| I1 | done — green (turbo 2.11.4) | `turbo-contract.e2e.test.ts` |
| I2 | done — green: `defaultDryRunner` closures equal the manifests' transitive `workspace:` deps (`shop-api`/`admin-api` → `@pkg/lib-core`, `@pkg/types`), and `buildClosureMap` inverts them; UI-only `@pkg/ui-kit` maps to no backend | same |
| I3 | done — green | `backend-watch.e2e.test.ts` |
| I4 | done — green | same |
| I5 | done — green. The "last-good `dist/` keeps serving" premise was wrong (`tsc -b` emits through a type error), so the contract is now: restart onto the emitted build under a `⚠️ … has type errors: …` line, then a clean `✅` restart on the fix (infra-kit 630455e) | same |
| I6 | done — green (add restarts once; delete restarts once more — `tsc -b` leaves the orphaned `dist/extra.js`, so there is no `unlink` event in dist) | same |
| I7 | done — green: SIGKILL of the `turbo watch build` process group → exactly one `Watch engine … file saves no longer rebuild` warning; `/ping` keeps answering | same |
| I8 | done — green: started with cwd = a symlink (and `PWD` = the link), edits through the link and through the real path each restart once, no `still serving the OLD`. The `monorepoRoot` asymmetry is not reachable from cwd: Node's `process.cwd()` is `getcwd(3)`, already the physical path, and the runner never reads `PWD` | same |
| I9 | done — green: the lib → vite hop is confirmed. With `--watch --target=shop/ui,shop/api`, an edit to `packages/ui-kit/src` is rebuilt into `dist/` by the watch engine (`shop-ui^...`) and vite's own watcher invalidates the module, so the next GET of the `@pkg/ui-kit` URL `/src/main.ts` imports serves the new code. `shop/api` runs too: without a local backend the UI's `/api` route resolves to cloud, which needs a Doppler-loaded `INFRA_KIT_ENV` | `frontend.e2e.test.ts` |
| I10 | done — green: SIGTERM with UI + API up exits **143**, not 0, with no process left in the tree (vite included). 143 is the documented contract — `signal-shutdown.ts` invariant 3: a signal-terminated dev exits `128 + signo` so a supervisor can tell it from a voluntary stop | same |
| I11 | done — green: the burst ends on the last save in at most two restarts — when `tsc -b` judges the last save up to date by mtime, the runner sees the source hash disagree with the buildinfo and forces one rebuild (infra-kit 630455e) | `backend-watch.e2e.test.ts` |

## Order

1. Harness + I2 + I1 (fast, no servers) — they alone guard turbo upgrades.
2. I3/I4 (the core promise of `--watch`).
3. I5–I9, then I10–I11.

## Related findings (not tests, but surfaced by the audit)

- RESOLVED 2026-09-26: watch is now the default (`--no-watch` opts out), so hulyo/travelist's
  `pnpm exec infra-kit dev --self` gets the watch path once they pick up the release.
- RESOLVED 2026-09-26 (found by the sandbox CI, fixed in f18ecae): with `GITHUB_ACTIONS=true` turbo defaulted to
  grouped `::group::` output with no `<pkg>:<task>:` prefixes, so `parseTurboDevLine`/`parseTurboTaskFailure`
  matched nothing. Both turbo spawns now pin `--log-order=stream`; the sandbox runs under CI's own env again.
- travelist `packages/design-system` exports `src/*.css` — edits never touch `dist/`, so dist watching
  cannot see them (vite serves them directly, so the UI is fine; the backend is unaffected).
- Vite libs (`vite build --watch` / turbo `build`) empty `dist/` before writing → unlink/add burst then
  a second `vite-plugin-dts` wave. Covered for backends by debounce; worth I11-style coverage for UI libs.
