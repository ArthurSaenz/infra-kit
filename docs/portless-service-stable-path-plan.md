# Plan: a stable path for the portless system service

**Status: pending approval** (user) · RALPLAN-DR, deliberate mode · 2026-09-14 · consensus: Architect APPROVE
(iteration 3 — two blockers on the global-install predicate, one on the `$HOME` walk bound), Critic APPROVE
(iteration 2 — six documentation-level fixes: mcp-proxy hook site, §9.2 verification layout, observability
channel, AC3 scope, setup file, the pre-existing `npm -g portless` recipe)

## 1. Problem

`infra-kit doctor` prints the portless fix as

```
sudo <node> ~/Library/pnpm/global/v11/8a83-18d500a131837690-0/node_modules/.pnpm/infra-kit@0.5.6/node_modules/portless/dist/cli.js service install
```

and portless bakes both words verbatim into `/Library/LaunchDaemons/sh.portless.proxy.plist`
(`ProgramArguments = [process.execPath, process.argv[1], proxy, start, …]`; portless `dist/cli.js:3804`,
`:4436`). Under pnpm 12 that script path is **version-unstable**: the isolated-global layout creates a fresh
`global/v11/{pid}-{timestamp}/` project on every `pnpm add -g infra-kit@x` and removes the previous one (only
one infra-kit dir exists on disk despite 0.5.2 → 0.5.6 landing in two days), and the path also embeds
`infra-kit@0.5.6`. With silent auto-update on, the root daemon's argv dangles after every release; launchd
fails to start it at the next boot; doctor goes red on `:443`; the "fix" is another `sudo … service install`.

### Measured facts the design rests on

| Fact | Evidence |
|---|---|
| Node does **not** realpath `process.argv[1]` | `node stable/portless/cli.js` where `stable/portless` is a symlink prints `argv1 = …/stable/portless/cli.js` |
| Node **does** realpath `process.execPath` | same run prints `execPath = …/global/v11/fc94-…/node@runtime+24.21.0/…/bin/node` even when invoked as `~/Library/pnpm/bin/node` |
| portless offers no `--node-path` / `--entry`; always `execPath` + `argv[1]` | `handleService` option parser throws `Unknown service install option` for anything but proxy options |
| portless's plist has `RunAtLoad: true`, `KeepAlive: true` | `buildLaunchdPlist` |
| daemon ↔ client talk through files, not HTTP | `PORTLESS_STATE_FILES = routes.json, routes.lock, proxy.pid, proxy.port, …`; driver runs `portless alias` (`portless-driver.ts:547-552`) |
| pnpm 12 global layout = `global/v11/{pid}-{timestamp}` + deterministic hash symlink | `pnpm root -g`, on-disk listing, https://pnpm.io/global-packages |
| `global/5` is the pnpm ≤11 layout, now dead | `5/node_modules/.modules.yaml: layoutVersion: 5`, holds infra-kit 0.5.1 from the `pnpm@11.10.0` era |
| the updater already runs the **new** binary after install | `run-update-check.ts:284` `installedVersion(env)` |
| a pnpm-managed Node bump can leave the old Node in place | `pnpm ls -g` lists `node@24.21.0` **and** `node@24.20.0` |

## 2. Principles

1. **Never let a version-specific path decide what runs as root.** The plist must reference paths that infra-kit
   owns and keeps valid, not paths a package manager mints per install.
2. **sudo is rare, explicit, and never automatic.** The auto-updater must not gain a privileged step.
3. **Detect and tell, don't guess.** When the daemon can no longer start, `doctor` names the exact cause and the
   exact command.
4. **Manager-agnostic.** The fix must hold for npm-global, pnpm 12-global, and a project-local install alike.
5. **No new trust surface.** Root already executes user-writable code (portless's model); do not widen it.

## 3. Decision drivers

1. Silent auto-update is the chosen default (do not re-litigate) → churn is certain and frequent.
2. portless owns the plist format and reads `execPath`/`argv[1]`; we cannot make it write anything else.
3. `doctor` already has the portless section and the `:443` row; `setup` already owns "bring portless to a
   working state".

## 4. Options

| Option | Pros | Cons |
|---|---|---|
| **A. infra-kit-owned symlink `~/.infra-kit/portless` → current portless package dir; plist points through it** | script path never dangles; ~50 LOC; manager-agnostic; KeepAlive self-heals once re-pointed; sudo only on a Node bump | Node path still realpath'd → one sudo per Node bump; symlink is user-writable (unchanged trust model) |
| B. separate global portless (`pnpm add -g portless@<pin>`) | daemon lifecycle decoupled from infra-kit releases | two copies must match versions (0.x, file-based protocol); still `{pid}-{ts}` churn on portless bumps; two managers to reason about |
| C. infra-kit-owned launcher `.mjs` that resolves portless at boot | plist never dangles for the script | more code executed as root; still Node-path churn; re-implements resolution portless already does |
| D. print pnpm's hash-symlink path with `..` (`global/v11/<hash>/node_modules/infra-kit/../portless`) | zero code | relies on a pnpm-specific hash symlink and `..`-through-symlink; pnpm-only; unreadable in a root plist |
| E. root-owned copy under `/usr/local/lib` | correct trust model | sudo on **every** portless bump; a second copy to sync |

**Why A:** it removes 100 % of the infra-kit/portless/pnpm-induced churn with no privileged step, in the fewest
lines, without a second portless copy or a pnpm-specific trick. B, C, D, E each trade one of principles 2, 4 or 5
for no reduction in sudo frequency below A's.

**Invalidation of alternatives:** B fails driver/daemon parity on a file-protocol 0.x package; C adds root-run
code for no churn reduction over A; D violates principle 4; E violates principle 2 (more sudo, not less).

**The steelman for C, and why it still loses (Architect, iteration 1).** C's strongest form: a launcher resolves
portless *at daemon boot*, so correctness is decided by the process that runs as root, not by a race between the
updater, shells and reboots — no startup hook, no PM-2, no PM-3, identical trust surface to a symlink. The flaw is
in "resolves at boot": a launcher under `~/.infra-kit` has no `node_modules` beside it, so to find the current
portless it must either (i) execute `infra-kit` **as root** to ask it (running the auto-updater, the Layer-3
auto-seed and every startup hook under `HOME=/var/root` — a new side-effect surface, against principle 5), or
(ii) parse the package manager's bin shim (`cmd-shim-target=` is pnpm-only; npm/volta/bun shims differ — against
principle 4). A's symlink is resolved by the **user's** process; root only follows it. That asymmetry is the
whole reason to prefer A. C stays the recorded fallback if A's global-install predicate (§5.2) proves unsound.

## 5. Design

### 5.1 The link

`~/.infra-kit/portless` — a symlink to the **package directory** of the portless bundled with the running
infra-kit (parent of the resolved `dist/cli.js`, i.e. `dirname(dirname(resolvePortlessBin()))`).

The plist's script argument becomes `~/.infra-kit/portless/dist/cli.js`. Node keeps that string in
`process.argv[1]` (fact 1), so portless writes it into `ProgramArguments` unchanged.

### 5.2 `ensurePortlessLink()` — `apps/infra-kit/cli/src/dev/proxy/portless-link.ts` (new)

```
ensurePortlessLink({ home, selfRealPath, cwd, realpath, fs }) → 'created' | 'repointed' | 'unchanged' | 'skipped-local' | 'skipped-unresolved' | 'failed'
```

- Resolve target = `dirname(dirname(resolvePortlessBin()))`; `null` → `'skipped-unresolved'`.
- Guard — **"am I the global install?"** — two predicates, both must pass:
  1. **Positive:** `detectInstallManager({ selfRealPath, env })` with **no** `npmRootG` probe (fs + env only,
     so the boot path never pays for a subprocess) reports `manager !== 'unknown'`. Not `canSelfSpawn` — that
     flag encodes "may I run an unattended `npm i -g`", and homebrew is deliberately `canSelfSpawn: false`
     (`install-manager.ts:212-218`) although it is unmistakably global; gating on it would leave a brew install
     unconverged forever. A global install whose manager cannot be identified in this environment (no
     `PNPM_HOME` in a stripped env, say) skips — fail-safe: a skipped write is never wrong, and the next
     shell-run `setup`/`dev` converges it.
  2. **Negative, independent of the manager verdict:** walk up from the resolved portless package dir to the
     parent of the *outermost* `node_modules` segment, then on towards the filesystem root, **stopping before
     `$HOME` itself** (exclusive: the walk ends at `dirname(realpath(homedir()))`, bounded ≤ 32 hops); if any
     inspected ancestor contains a `.git` entry (directory or file) → `'skipped-local'`. `$HOME` is excluded
     because dotfiles users `git init ~` — a `~/.git` would refuse the pnpm-global install permanently and turn
     the §5.5 "run any infra-kit command to repair it" advice into something that can never work. Every
     checkout under `$HOME` (`~/repo/.git`) is still strictly below it; global roots outside `$HOME`
     (`/usr/local`, `/opt/homebrew`) have no `.git` ancestors. The cheap matchers are segment
     heuristics that fire on project-local shapes — a repo with a `volta` path segment (`:205`), Yarn Berry's
     `.yarn/unplugged/…` (`:245`), a repo cloned under `$PNPM_HOME`/`$BUN_INSTALL` (`:181-185`), a workspace
     package literally named `lib` matching `<x>/lib/node_modules/infra-kit` (`:131-140`) — and each would aim
     the root daemon at a checkout. Every checkout has a `.git`; no global root does.
     - **Not** `pnpm-workspace.yaml`: pnpm 12 writes one *inside* the global install dir
       (`global/v11/8a83-…/pnpm-workspace.yaml`, on disk today), so that marker would refuse the very install
       this is for. `.git` only.
  - **Why not `isLocalNodeModulesInstall`:** it is `hasSegment(self, 'node_modules') && isWithin(cwd, self)`
    (`install-manager.ts:358-360`). Every global layout under `$HOME` is "within" a cwd of `$HOME` — and
    `$HOME` is precisely the cwd the updater spawns with (`run-update-check.ts:75-78`). Verified on this
    machine: `cd ~ && infra-kit version` prints the project-local advisory for the pnpm-global install. The
    same false positive is fixed in `warnIfLocalInstall` as part of this work (§11).
- `mkdir -p ~/.infra-kit`; `readlink` the link; if it equals target → `'unchanged'`.
- Otherwise write atomically: `symlink(target, link + '.tmp-<pid>')` then `rename` over `link`.
  Never `unlink` first — a reboot between unlink and symlink would leave launchd with no path at all.
- Never throws; returns `'failed'` on any fs error. Pure with respect to its injected seams so tests never touch
  the real `~/.infra-kit`.

### 5.3 Call sites

1. **Process boot, both bins.** A shared `bootPortlessLink()` in `src/dev/proxy/portless-link.ts`, called
   at module top level from `entry/cli.ts` (before Commander dispatch, i.e. where `warnIfLocalInstall()` runs
   today, `cli.ts:86`) **and** from `entry/mcp-proxy.ts` — the `ik-mcp` bin (`package.json:12`), which is the
   process Claude Code actually keeps alive; `entry/mcp.ts` is the upstream it spawns lazily, so a hook only
   there would converge on first tool use. fs-only, no subprocess, ≤1 ms, try/catch, never changes the exit
   code, never `process.exit`s (the proxy is long-lived).
   - It must **not** inherit `warnIfLocalInstall`'s early return on `--json` / `mcp` (`cli.ts:76`) and has no
     env opt-out: the link is state, not advisory output. This is load-bearing: the updater verifies the new
     install by spawning `infra-kit version --json` with `cwd: homedir()` (`run-update-check.ts:75-78`) — that
     invocation is what re-points the link after an auto-update. **This is an assertion the integration test
     in §7 proves, not a fact assumed** (the first draft claimed it as a fact and was wrong on two counts:
     the cwd guard and the `--json` guard).
   - Stdout stays untouched (the `--json` payload and the MCP transport must carry nothing else); the hook
     logs only under the existing debug env.
2. **`setup`** — calls `ensurePortlessLink()` explicitly and reports the result as a step.
3. **`doctor`** — read-only: reports, never re-points (doctor without `--fix` must not mutate).

### 5.4 The printed command

`installDaemonCmd()` in `doctor.ts` and the daemon-down message in `dev-server.ts:1863,1875` pass
`bin = ~/.infra-kit/portless/dist/cli.js` **only when the link resolves to an existing `cli.js`**; otherwise
fall back to the resolved real path (today's behaviour). `setup` has no service-install printer today; §5.6
adds one that reuses `installDaemonCmd()`. `formatPortlessCommand` itself is unchanged.

**The other portless on this machine.** `setup`'s tool recipe already runs `npm install -g portless`
(`dependency-registry.ts:305`; present at `~/Library/pnpm/nodejs/24.21.0/lib/node_modules/portless`, unpinned,
updated to `@latest`). Its own comment records why it is irrelevant to the daemon: it is for interactive use
and repos without infra-kit, and changes nothing about the sudo case. This plan does not touch that recipe;
the daemon and the `dev` driver both resolve the **bundled** copy, so *they* share one version.

`portlessBin()` for the **driver** (`alias`, `list`, probes) keeps resolving from `node_modules` — the driver
must run the exact portless the running infra-kit ships, never a link that may lag by one command.

### 5.5 New doctor check — `portless service target`

Section `Dev proxy (portless)`, inserted after `portless installed` in `SECTION_MEMBERS`. Reads
`DARWIN_SERVICE_PLIST_PATH` / `LINUX_SERVICE_UNIT_PATH` through an injected `readFile` seam and parses them
with the **same two grammars portless itself uses to read its installed service back** — a regex over the
`ProgramArguments` array plus `parsePlistStrings` with `xmlUnescape` for launchd (portless `cli.js:3861-3877`,
`:3389`), and `parseQuotedWords` over `ExecStart=` matching its writer `systemdEscape` for systemd
(`:3383`, `:3888`). Mirror those shapes; do not invent a third grammar. A path containing `&` must round-trip.
The check reports:

| State | Status | Message |
|---|---|---|
| service not installed | `skip` | (the existing `:443` row already says what to do) |
| `argv[0]` (node) missing on disk | `fail` | "The service runs `<node>`, which no longer exists (Node was upgraded). Re-run: `sudo … service install`" |
| `argv[0]` exists but ≠ `process.execPath` | `warn` | "The service runs `<old node>`; infra-kit runs `<new node>`. Works until the old Node is removed. Re-run when convenient: …" |
| `argv[1]` ≠ `~/.infra-kit/portless/dist/cli.js` | `warn` | "The service points at `<path>`, a version-specific location. Re-run once to switch it to the stable link: …" |
| `argv[1]` is the link but the link is dangling / missing | `fail` | "`~/.infra-kit/portless` is broken. Run any infra-kit command from the global install (e.g. `infra-kit setup`) to repair it." |
| `argv[1]` is the link and it points **inside the cwd repo** | `fail` | "The service runs portless from a project checkout. Re-run `service install` from the global install." |
| all good | `pass` | "service runs `<node>` + stable link → portless <version>" |
| daemon process started **before** the link's current target was installed | `warn` | "The running daemon predates portless <version> that `dev` will talk to. Restart it: `sudo launchctl kickstart -k system/sh.portless.proxy` (or reboot)." |

`warn` vs `fail` follows fact 9: an old Node that still exists keeps the daemon alive.

The last row is the honest answer to the parity tension the Architect raised: A **narrows** the window in which
the root daemon and the `dev` driver run different portless code (from "every release, until the user runs
sudo" to "after a portless bump, until the next reboot"), it does not eliminate it. Detection: the daemon's
start time (`ps -o lstart= -p $(cat <state>/proxy.pid)`, a subprocess — acceptable in `doctor`, which already
spawns) is older than the mtime of the link target's `package.json`. Restart itself stays manual (needs sudo).
No parity check is added to `dev`'s hot path.

### 5.6 `setup`

Adds a step after the portless tool recipe: `ensurePortlessLink()`; if the plist is absent **or** the doctor
check above would `fail`/`warn`, print the `service install` line through the link (never run it — sudo is the
user's). Idempotent: a converged machine prints nothing new.

### 5.7 Non-goals

- Restarting the daemon automatically after a portless bump (needs sudo). `doctor` *reports* it (§5.5 last
  row); the restart is the user's.
- Any change to portless itself, its state dir, or the plist format.
- Cleaning `~/Library/pnpm/global/5` / `.tools/pnpm/11.*` — user-side housekeeping, documented, not automated.

## 6. Pre-mortem

**PM-1 — the daemon reads its package dir at runtime.** After an update the old dir is gone while the daemon
still runs. If `cli.js` lazily reads anything from its own directory, routes break until restart and "keeps
running" is false. *Evidence so far (Architect):* `cli.js:22` statically imports its one chunk at boot, and its
`readFile` sites resolve from cwd/state dir, not the package dir — so the expectation is "no self-dir reads
after boot". *Mitigation:* still run the experiment as the first implementation step — start the daemon from a
scratch copy, delete the copy, exercise `alias`/`alias --remove` and an HTTPS request through it. If it fails,
the §5.5 "daemon predates" row is promoted from `warn` to `fail` and its wording changes to "routes are broken
until restart". Design otherwise unchanged.

**PM-2 — the boot hook re-points to the wrong portless.** A dev runs `pnpm exec infra-kit` inside this repo, or a
consumer runs a project-local copy; the hook must not aim the root daemon at a repo. *Mitigation:* the
two-predicate gate (§5.2) — manager identified **and** no `.git` above the outermost `node_modules` — plus the
doctor `fail` row for "link inside cwd repo". Tests: `self = <repo>/node_modules/infra-kit/dist/cli.js` → `'skipped-local'`,
no writes; `self = ~/Library/pnpm/global/v11/<x>/node_modules/.pnpm/infra-kit@<v>/node_modules/infra-kit/dist/cli.js`
with `cwd = homedir()` and `PNPM_HOME` set → link **is** written (the case the first draft got wrong).

**PM-3 — a reboot lands inside the dangling window.** Auto-update ran, the machine rebooted before any infra-kit
command, launchd loops on a broken link. *Mitigation:* KeepAlive keeps retrying (fact 4); the first
`infra-kit …` re-points and the next retry succeeds. Verified by the e2e below: a dangling link + KeepAlive plist
in a temp `--state-dir` → daemon up within one retry after re-point. Documented in doctor's message so the user
knows why `:443` was red for a minute.

## 7. Test plan

**Unit (`portless-link.test.ts`)** — injected `fs`/`realpath` seams, temp `home`:
- no link → `'created'`, link points at the resolved package dir
- link correct → `'unchanged'`, no writes performed (spy on `symlink`/`rename`)
- link dangling → `'repointed'`, done via tmp + rename, old target never `unlink`ed first
- link points elsewhere → `'repointed'`
- project-local `self` (no matcher hit) → `'skipped-local'`, no writes
- global `self` under `PNPM_HOME` with `cwd = homedir()` → written (regression test for the `$HOME` false positive)
- global `self` at `/opt/homebrew/Cellar/infra-kit/<v>/libexec/lib/node_modules/infra-kit/dist/cli.js` → written
  (homebrew is `canSelfSpawn: false`; must still converge)
- global `self` but env stripped (no `PNPM_HOME`, no derivable prefix) → `'skipped-local'`, no writes, no throw
- the four matcher false positives, each with a `.git` ancestor → `'skipped-local'`: `~/work/volta/node_modules/…`,
  `<repo>/.yarn/unplugged/infra-kit-x/node_modules/…`, `$PNPM_HOME/clone/node_modules/…`,
  `<repo>/packages/lib/node_modules/infra-kit/…`
- global pnpm 12 `self` whose install dir contains `pnpm-workspace.yaml` (as on disk today) → written
- `.git` walk stops before `$HOME` and at 32 hops; a `.git` *file* (worktree) counts the same as a directory
- `~/.git` present (dotfiles repo) + pnpm-global `self` under `~/Library/pnpm` → written
- `~/repo/.git` present + `self = ~/repo/node_modules/infra-kit/…` → `'skipped-local'` (still below `$HOME`)
- `resolvePortlessBin()` null → `'skipped-unresolved'`
- `rename` throws → `'failed'`, no throw escapes
- a regular **directory** (not a symlink) at the link path → `'failed'` with a clear reason (never `rm -rf`)

**Unit (`doctor.test.ts`, new rows)** — fixture plists / units for every row of 5.5, including a plist whose
`ProgramArguments` has extra `<string>` entries (flags), a unit with `ExecStart=` quoting, a malformed file →
`warn` "could not parse", never a throw. `report.test.ts`'s `SECTION_MEMBERS` assertion updated.

**Unit (`formatPortlessCommand` callers)** — `installDaemonCmd` renders the link path when it resolves, the real
path when it does not; snapshot the exact printed line.

**Integration** — real fs in a temp `HOME`, hermetic in-test build (memory: dist-reading tests are vacuous
otherwise). Run **exactly the updater's invocation** — `<node> dist/cli.js version --json` with
`cwd = <temp HOME>`, `PNPM_HOME` pointing at a temp global layout that contains the built package — twice, with
the resolved portless moved between runs; assert the link follows and stdout is the bare JSON payload. A second
run with `cwd = <a temp project that has the build under node_modules>` asserts the link is untouched. This is
the test that proves §5.3's load-bearing assertion.

**Unit (`warnIfLocalInstall`)** — global `self`, `cwd = homedir()` → no advisory (fixes the pre-existing false
positive with the same gate).

**e2e (manual, recorded in the plan's progress log)** — PM-1 experiment; PM-3: `service install` through the link
into a temp `--state-dir`, delete the target, watch `launchctl print system/sh.portless.proxy` retry, re-point,
confirm serving on `:443` without a second sudo.

**Observability** — the new doctor row is the user-facing signal; `setup` prints the link result as a step line.
The boot hook logs its outcome (`created|repointed|unchanged|skipped-*|failed` + target) through the existing
pino logger at `debug` level, which the existing `--debug` flag enables (`logger/index.ts:34`, written to
`LOG_FILE_PATH`, never stdout). A unit test asserts the debug line is emitted for `'failed'`.

**Test-harness trap** — `report-inventory.test.ts:220` runs the REAL `doctor()` with `portless-driver` mocked and
reconciles the row inventory. The new check's `readFile` seam and the `ps -o lstart=` subprocess for the
"daemon predates" row must be injected/mocked there, or the inventory reconciliation fails.

## 8. Acceptance criteria

1. After `pnpm add -g infra-kit@<next>` on a machine whose plist points through the link, the daemon serves
   `:443` after the next reboot **without** any sudo command. (e2e PM-3 — manual, recorded in the progress log
   with commands and output; no automated test can reboot.)
2. `infra-kit doctor` reports `portless service target` with the exact state table of 5.5; every row has a
   fixture test.
3. `infra-kit setup` on a fresh machine prints exactly one **portless** sudo line, and it uses
   `~/.infra-kit/portless/dist/cli.js` (the pre-existing Homebrew-bootstrap / first-AWS-install sudo lines,
   `setup.ts:258`, are unrelated and unchanged). Asserted by a setup unit test with the portless recipe's
   probes mocked.
4. A project-local invocation never changes `~/.infra-kit/portless` (unit + integration).
5. `pnpm run qa` green, including the `SECTION_MEMBERS` tests; no `catalog:` leak in manifests (memory).

## 9. Verification steps (for the verifier pass)

1. `pnpm run qa` — full, not `--cache` (memory: eslint-check --cache hides errors); `git status` shows no `??`.
2. Run the §7 integration test in isolation (`vitest run portless-link`) and read its assertions: it stages the
   hermetic build inside a temp `PNPM_HOME/global/v11/<x>/node_modules/.pnpm/infra-kit@<v>/node_modules/infra-kit`
   tree and runs `<node> <that>/dist/cli.js version --json` with `cwd = <temp HOME>` and
   `env = packageManagerInstallEnv(process.env)` (the updater's real env builder — `PNPM_HOME` survives it,
   `npm_*` does not). Running the repo's own `dist/cli.js` proves nothing: its ancestor chain has `.git`, so
   §5.2 correctly answers `'skipped-local'`.
3. On this machine: `infra-kit doctor` before → `warn` "version-specific location"; run the printed
   `service install`; `doctor` → `pass`; `sudo launchctl print system/sh.portless.proxy | grep program` shows the
   link path.
4. PM-1 and PM-3 experiments recorded with commands and outputs in `docs/portless-service-stable-path-progress.md`.

## 10. ADR

- **Decision:** the portless system service runs the script through an infra-kit-owned symlink
  `~/.infra-kit/portless`, re-pointed on every CLI start from a global install; `doctor` reports plist drift;
  `setup` converges the link and prints the single sudo line.
- **Drivers:** silent auto-update; portless's fixed `execPath`/`argv[1]` contract; existing doctor/setup surfaces.
- **Alternatives considered:** B global portless, C launcher, D pnpm hash path, E root-owned copy (§4).
- **Why chosen:** eliminates all package-manager-induced churn with zero privileged automation and the least code;
  manager-agnostic; the daemon and the `dev` driver resolve the same bundled copy, so a version split between
  them can only be transient (§5.5 last row). The unpinned `npm -g portless` that `setup`'s recipe installs is
  unrelated to the daemon and unchanged.
- **Consequences:** one sudo per Node bump remains (portless-imposed); the link is user-writable, same as today's
  path; **driver/daemon parity is narrowed, not preserved** — after a portless bump the daemon runs old code
  until reboot or a manual kickstart, and `doctor` says so; the link converges only from a global install whose
  manager the cheap matchers can identify, so a stripped environment leaves it to the next shell run.
- **Follow-ups:** (1) upstream issue to portless for `--node-path` / a stable launcher, which would retire the
  last sudo; (2) document `rm -rf ~/Library/pnpm/global/5` in the pnpm-12 migration note; (3) if the §5.2
  predicate proves unsound in the field, Option C with a non-root resolution step is the recorded fallback.

## 11. Scope by file

| File | Change |
|---|---|
| `src/dev/proxy/portless-link.ts` (new) | `ensurePortlessLink`, `bootPortlessLink`, `PORTLESS_LINK_NAME`, `portlessLinkCliPath()` |
| `src/dev/proxy/__tests__/portless-link.test.ts` (new) | §7 unit + integration cases |
| `src/entry/cli.ts` | `bootPortlessLink()` at top level, outside `warnIfLocalInstall`'s `--json`/`mcp` guard; `warnIfLocalInstall` gated on the same `isGlobalInstall` two-predicate gate (fixes the `$HOME` false positive) |
| `src/entry/mcp-proxy.ts` | `bootPortlessLink()` at module top level — this is the `ik-mcp` bin (`package.json:12`), the long-lived process Claude Code spawns. fs-only, so it honours the proxy's "spawns nothing at handshake" contract (`mcp-proxy.ts:172`). Not `entry/mcp.ts`: that upstream starts lazily, so a hook there would converge only on first tool use |
| `src/lib/install-manager/install-manager.ts` | export a probe-free `isGlobalInstall(selfRealPath, env, fs)` = `manager !== 'unknown'` **and** no `.git` above the outermost `node_modules` (§5.2); no behaviour change to the updater's own matcher set |
| `src/commands/doctor/doctor.ts` | `checkPortlessServiceTarget` + `installDaemonCmd` prefers the link |
| `src/commands/doctor/report.ts` | `SECTION_MEMBERS` entry |
| `src/commands/doctor/__tests__/*` | fixtures for 5.5 rows; `report.test.ts:89` row count 31→32; `report-inventory.test.ts:220` mocks for the new seams |
| `src/commands/setup/setup.ts` | link step + conditional portless sudo line in the orchestrator/summary (`setup.ts:26,151`); `converge.ts` is the generic recipe runner and is not touched |
| `src/commands/setup/__tests__/*` | AC3: exactly one portless sudo line through the link |
| `src/dev/dev-server.ts` | daemon-down message prefers the link path |
| `docs/portless-service-stable-path-progress.md` (new) | PM-1/PM-3 experiment log |
