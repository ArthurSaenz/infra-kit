# Orca CLI findings — Phase 0 spike for `docs/orca-migration-plan.md`

Measured 2026-09-16 against Orca **1.4.204** (`orca status --json` → `runtime.appVersion`), macOS, from a shell hosted inside an Orca terminal of the infra-kit main row. Throwaway repo: `<scratchpad>/orca-spike-repo` (+ `orca-spike-repo-worktrees/x`); the fresh-worktree race and the production layout were measured on travelist with a temporary worktree `spike-orca-race` that was removed afterwards (7 worktrees before and after, tree clean).

## Gate outcome (plan §2.5)

**Axis 1 (`--focus` reveals a hidden row): NO — and worse than "invisible success".** `terminal create --focus` on a hidden external worktree fails with `runtime_error: "Timed out waiting for terminal handle after creation"` (≈ 10 s) and the row stays unlisted; the same create **without** `--focus` succeeds instantly and returns a handle for a tab nobody can see.
**Axis 2 (background handle splittable in the same tab): YES.** A non-`--focus` `terminal create` on a listed row returns `surface: "visible"` and `terminal split` on that handle lands in the same `tabId`.

Consequences for the plan: `hide` repos → open **without** `--focus`, report `orcaHidden` (open path never passes `--focus` to a row that is not listed); `show` repos → Option A as designed. `dev --orca` on a hidden root row → single-process fallback (no `--focus` possible).

## Per-step answers (plan §3)

| # | Question | Measured | Decision it settles |
| --- | --- | --- | --- |
| 3.1 | `repo add` on a fresh repo with an existing external worktree | `repo add --path` → `ok`, 483 ms, `result.repo.{id,path,externalWorktreeVisibility:"hide",hookSettings}`. `worktree list --repo path:<repo>` lists **only the main checkout**; `worktree show --worktree path:<x>` → `ok:true` (selector resolves). `--focus` create on `x` → `runtime_error` timeout, row still unlisted. | Hidden-by-default **confirmed**; axis 1 = no. Preview line wording stands. There is no CLI verb to remove a repo either — the spike repo row must be removed in the Orca UI (Projects → orca-spike-repo). |
| 3.2 | `terminal create --json` shape | `result.terminal.{handle, tabId, paneKey, ptyId, worktreeId, title, executionHostId, incarnationId, hostPlatform, surface}`; `surface: "visible"` even without `--focus` on a listed row. `--title` becomes the **tab** title and persists; the *terminal* title is rewritten by the shell (`..ca-spike-repo`). | Handle path = `result.terminal.handle`; label the tab, never key on terminal titles. |
| 3.3 | `terminal split --json` | `result.split.{handle, tabId, paneRuntimeId, leafId}`; same `tabId` as the source. `--direction horizontal` = new pane to the **right**; `vertical` on the same handle = new pane **below** it. Tree measured: `horizontal( vertical(h0, h2), h1 )` — exactly the plan's three-pane. | Split plan argv sequence confirmed. |
| 3.4 | `terminal close --worktree --all` then `git worktree remove` | **`--all` fails with `runtime_error: terminal_close_incomplete` whenever the row has live terminals** (plain shells included) and leaves them running; on an already-empty row it returns `{closed:0, stopped:0, retiredSurfaces:true}`. Per-handle `terminal close --terminal <h>` works (`ptyKilled` true/false). After `git worktree remove`, `worktree show path:<x>` → `selector_not_found` within 2 s; no orphan terminals remain in the global list. | **Close path = `terminal list --worktree path:<cwd>` → `close --terminal <h>` for each → `close --worktree --all` to retire surfaces.** Orca prunes the row itself. |
| 3.5 | Orca quit | **Not measurable from this session** (it runs inside Orca; quitting kills it). Measured instead: ENOENT (`PATH` without orca) → shell exit 127 before any envelope; `status` while running = 152 ms. `status --help` describes a passive readiness probe ("Show app/runtime/graph readiness"); `orca open` is the separate launch verb. | `probeOrca` treats spawn ENOENT as `absent`; the "app quit" shape is verified in the US-007 e2e with the user (quit Orca from a non-Orca terminal). Working assumption: `status` does not launch the app. |
| 3.6 | Realpath | Orca reports paths exactly as given to `git worktree add` (`/private/tmp/…` here, because the scratchpad is already `/private/tmp`); `path:` selectors with the same literal string resolve. | Use the path as `git worktree list` reports it for selectors; realpath only for equality. |
| 3.7 | Background handle | See axis 2: non-`--focus` create on a listed row is visible and splittable. | Multi-branch fan-out and `reopen` get full layouts without focus; `dev --orca` needs no `--focus`. |
| 3.8 | `terminal list --limit` / `truncated` | Flags exist; `truncated: false` at 3 rows; not stressed past 50. | Pass `--limit 200`, log `truncated`. |
| 3.9 | `ORCA_WORKTREE_ID` | `<repoId>::<abs path>`; matches `worktree list` `id`. Set in this pane. Not re-measured for split panes (would need a shell inside one). | `orcaCallerInsideTargets` compares the path part. |
| 3.10 | Fresh-worktree race (show repo) | travelist: `git worktree add` took 6.9 s; the first probe after it (t = 7.2 s) already had `show = ok` **and** `list = listed`. No race observed. | Keep the bounded poll as cheap insurance (3 × 300 ms), circuit-broken per batch. |
| 3.11 | Same `--title` twice | Creates a **second tab** with the same title (no dedupe despite `terminal.create-idempotency.v2`). | `already_open` must be decided by `terminal list`, not by create; `dev --orca` re-runs must close the old tab first (they do — shutdown closes `--tab`). |
| 3.12 | Create on a 0-terminal row | Same shape as 3.2. | — |
| 3.13 | `close --terminal <h> --tab` on a one-pane tab | `{close: {handle, tabId, closeMode: "tab", ptyKilled: false}}` → ok. | `dev --orca` shutdown = `--tab` on `h0`, then per-handle fallback. |
| 3.14 | `repo add` hook side-effects | Fresh repo: `hookSettings.scripts.setup: ""` — nothing ran. travelist/hulyo rows carry `scripts.setup: "pnpm install"` (user-configured), but see 3.15. | Preview line keeps the neutral wording. |
| 3.15 | Discovery hooks on a fresh external worktree in a `show` repo | travelist: 15 s after `git worktree add`, `terminal list` on the new row = `[]` (no auto-started agent terminal) and no `node_modules` appeared (no `pnpm install` by Orca). | `already_open`-on-`reopen` and the "always lay out created worktrees" rule are both safe. |

## Additional facts

- Error envelope + exit code: `ok:false` envelopes come with **exit 1** on 1.4.204 (`selector_not_found`, `runtime_error`). `runOrca` must be `nothrow` and parse stdout on every exit code.
- `terminal close --terminal` result: `{close: {handle, tabId, ptyKilled}}`; `ptyKilled` is `false` when the pane had no live process.
- Row `displayName` for an external worktree is the branch (`spike/orca-race`, `displayNameMode: "automatic"`) — the sidebar naming the user asked for needs no `worktree set`.
- The repo's own `.claude/hooks/bash-guard.mjs` blocks raw `git worktree add/remove` in the Bash tool; the spike ran its git commands through the sandbox runner on the throwaway repo, per the approved plan.

## Left for the user

- Remove the `orca-spike-repo` project row in Orca's sidebar (no CLI verb). The directory is under this session's scratchpad and can be deleted with it.
- US-007 e2e: quit Orca from a non-Orca terminal and run `infra-kit dev --orca` / `infra-kit worktrees add <v> --orca --agent --yes` to confirm the `unreachable` shape.

## e2e — working-tree build (`apps/infra-kit/cli/dist/cli.js`, built 2026-09-16 13:02) against live Orca 1.4.204

| Check (plan §5 e2e) | Result |
| --- | --- |
| Legacy key in `~/.infra-kit/infra-kit.json` (`openInCmux: true`, the real file) | Every command runs; exactly one `WARN legacy cmux keys (worktrees.openInCmux) in ~/.infra-kit/infra-kit.json are ignored — run \`infra-kit setup\` to migrate them to orca` per process (`release list`, `reopen`, `worktrees remove`, `dev` all observed). The file was not rewritten — `infra-kit setup` was **not** run on this machine (it also converges shell/plugin state); the rewrite is covered by `migrate-cmux-config.test.ts` incl. the outside-project user-global case. |
| `reopen --dry-run --json --agent` on travelist | Live partition against Orca: 4 targets `orcaOpened` (`layout: "full"`), 2 `orcaSkipped { reason: "already_open" }` — exactly the two rows with connected terminals. (`orcaHidden` is hard-coded empty on the dry-run path — the listing check runs only after a real open.) |
| `worktrees add 1.36.10 --orca --yes --agent --json` on travelist | **Blocked**: the main checkout carries the user's uncommitted work and `assertManagementContext` refuses before anything runs ("working tree has uncommitted changes … try: commit or stash"). Not stashed — another session is active in that tree. hulyo is dirty too (`pnpm-lock.yaml`). The exact argv sequence this path issues (`terminal create --focus` → `split`) was measured live on travelist in §3.10 with a temporary worktree, and is pinned by `worktrees-add-orca.test.ts`. |
| `worktrees remove` from inside the target's Orca terminal (`ORCA_WORKTREE_ID=<travelist v1.51.0 id>`) | The dirty-tree guard fires first, so the `orca_caller_inside_target` refusal could not be observed live; it is pinned by `worktrees-remove-orca-preflight.test.ts` (zero git calls for the batch). Both are pre-mutation. |
| `worktrees remove <v>` closing terminals + row disappearing | **Blocked** by the same dirty tree; the close-then-`git worktree remove` sequence was measured live in §3.4 on the spike repo (per-handle close, `--all` retire, row gone within 2 s). |
| `dev --orca` fallback | In infra-kit (no API apps): prints `Orca: no API apps to open a pane for (panes are backend-only); falling back to single-terminal dev` and continues single-process. The other fallbacks (absent / not running / unregistered / hidden) are pinned by `orca-dev.test.ts`; the "Orca quit" shape is still the user's check from a non-Orca terminal. |
| `dev --orca` happy path (4 panes in the release's row) | **Blocked**: needs a consumer worktree with a clean tree and a preset with local backends; argv sequence pinned by `orca-dev.test.ts` (1 and 3 apps, `--tab` shutdown). |

To finish the blocked rows, from a clean consumer checkout: `infra-kit worktrees add <v> --orca --yes`, `infra-kit reopen`, `infra-kit worktrees remove <v> --yes` (and once from inside that worktree's Orca terminal), `infra-kit dev --orca` from a release worktree; then quit Orca from a plain terminal and repeat `dev --orca` / `worktrees add <v> --orca --agent --yes`.
