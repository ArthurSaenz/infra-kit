# Dev-server shutdown: design (v3) — PENDING APPROVAL

Status: **plan only — no code changed.** Produced by a Planner → Architect → Critic consensus loop.
v1 (a durable run-ledger + startup janitor) was killed by the Architect pass. v2's two P0 fixes were
killed by the Critic pass and by an empirical probe. What follows is what survived.

---

## 1. What Ctrl-C *should* do (the contract)

A dev supervisor's shutdown has six obligations:

1. **Stop the world in reverse dependency order** — silence restart sources → drain in-flight work →
   deregister from discovery (proxy aliases) → reap children → close servers → restore the terminal.
2. **Kill process *groups*, not pids** — and snapshot descendants **before** signalling.
3. **Bound every wait; escalate** SIGTERM → SIGKILL.
4. **Exit honestly** — `128 + signo`, never `0`.
5. **Every exit is a crash.** `kill -9`, OOM, and power loss run no handler. Correctness must not
   depend on the exit path being taken.
6. **A Ctrl-C that appears to hang is a bug**, even if it would eventually finish.

**infra-kit already does 1–4, and does them better than most tools.** `signal-shutdown.ts` handles the
`pnpm exec` SIGINT+SIGTERM relay by keying the escape hatch on the *first signal's type*;
`managed-child.ts` snapshots descendant pgids before signalling because turbo re-groups its tasks;
`shutdown()` deregisters aliases *before* the child reap so a force-quit can't strand a route.
These are scarred, hard-won, and should not be touched.

The gaps are all in **5** and **6**.

---

## 2. The one idea

> **Reap only what you can still prove is yours.**

Not *"record what you must reap"* — that conflates possibility with authorization, and it is what made
v1 wrong. A recorded pgid is a bare integer; acting on it destructively after its owner is dead is how
you SIGKILL an innocent process group on a laptop that's been up for three weeks.

---

## 3. Empirically confirmed: the sharpest bug

When a turbo engine **crashes** (or is OOM-killed), its `vite`/`tsc` tasks — which turbo places in
their **own** process groups (`managed-child.ts:8-16`) — are orphaned, and **no later teardown can
ever find them.**

`reportEngineDeath` (`dev-server.ts:1400-1407`) only prints a warning. And a subsequent Ctrl-C
*deliberately bails* on the dead engine at `managed-child.ts:254`:

```ts
// "A turbo that exits on its own reaps its own tasks, so bailing here strands nothing."
if (child.exitCode !== null || child.signalCode !== null) return
```

That comment is true for a **clean exit** and false for a **crash** — and the same file's own header
says so.

**And the obvious fix — "just reap inside `onUnexpectedExit`" — is a no-op.** Probed directly:

```
WHILE ALIVE   walk(engine) = [90723, 90735]        <- vite's group IS reachable
IN exit HOOK  walk(engine) = [90723]               <- vite's group is GONE
              vite ppid=1 alive=true pgid=90735    <- reparented to init, still running
```

Reparenting happens at **termination**, strictly before Node delivers the `exit` event. There is no
window. Any fix that starts by walking `ppid` from the dead engine is already too late.

### The fix that works

**Roll a snapshot while the engine is alive; validate it by `(pgid, leader lstart)` at reap time.**

- While an engine lives, sample `ps -eo pid=,ppid=,pgid=,lstart=` on a slow cadence (piggyback the
  existing `livenessTimer`, ~2s — not the 100ms reap poll) and keep the descendant pgids **plus each
  group leader's start time**.
- On unexpected exit (crash/OOM) — and on the force-quit path — reap from that snapshot, killing only
  groups whose leader still exists **and** whose `lstart` still matches. A recycled pgid has a newer
  birth time and is refused.

`lstart` is readable on the target platform (verified: `ps -o lstart= -p <pid>` → `Mon Jul 13 …`).
This is the identity that survives reparenting, and it is what satisfies §2.

> Note for the next reader: v2 claimed a pgid has *"no kernel-readable birth time."* **That is false**,
> and it was the premise the whole design leaned on. `lstart` is the mechanism.

---

## 4. What to ship, in order

**P0 — A. Snapshot-and-validate reap.** As above. Fixes the turbo-crash / OOM orphan, which today is
permanent and invisible. Also hardens the force path (which currently re-walks a tree that may already
be gone).

**P0 — M. `doctor --fix`, with a *hardened* staleness predicate.** This is the **only** thing that can
clean up after a `kill -9`, a force-quit, or a boot-window death — because alias removal is an **async
subprocess**, so neither the synchronous force path nor a `process.on('exit')` hook can ever do it.
It is also the only item that addresses the actual 502 (an **old branch's** alias — a name a new run
never even constructs, so no amount of self-healing on the new run touches it).

The predicate must **not** be "nothing is listening" alone. `assignUiPort` (`dev-server.ts:1718-1733`)
probes a free port and *releases* it; vite binds it seconds later in `startUiDev`. So a perfectly
healthy route legitimately has nothing listening for the whole of vite's boot. `doctor.ts:636-667`
already uses this unsound predicate — it is safe today only because it merely *prints*. Making it
*act* without hardening it would delete a colleague's (or your own other pane's) live alias.

    stale ⇔ nothing listening on the port
          ∧ no live dev-context fragment claims the alias   (fragment `pid` dead or absent)
          ∧ the record is older than a boot window          (min age)

Then: list exactly what will be removed, require confirmation, act. **Destructive work is
user-initiated and visible — never on the hot path of the most-run command.**

**P1 — I. Mashing Ctrl-C to kill `dev` silently closes the whole session shell.**
The child is spawned non-detached (`run-session.ts:121-124`), so the TTY signals both. `onSigint`
swallows SIGINT *only while a child is running* (`:213-223`); otherwise it calls `deps.exit(0)`. But
`setChildRunning(false)` fires at `:132`, while the shell still has to reset the terminal (`:135`),
read the report (`:138`), write the footer (`:392`) and re-render the palette (`:368`). **Any SIGINT in
that window exits the whole session shell.** Force-quitting `dev` by mashing Ctrl-C delivers exactly
those SIGINTs.

Subtlety that makes the fix safe: while the palette is up, Ink holds stdin in **raw mode**, which
disables `ISIG` — so Ctrl-C at the palette generates **no SIGINT at all** (`command-palette.tsx:110`
handles the raw `0x03` byte). Therefore `deps.exit(0)` at `:222` is reachable *essentially only inside
the bug window*. It is not a feature to preserve; **it is the bug.** Fix: swallow SIGINT until the
palette is genuinely re-armed — and cover the same window before the *first* child.

**P1 — E. Bound the teardown and give feedback.** Per-child reaping is bounded (5s grace + 2s reap),
but `shutdown()` awaits `restartWorkChain` and `closureBuild` **unbounded**
(`dev-server.ts:1791-1794`). A wedged rebuild makes Ctrl-C look hung with no output. Today's design
arms no deadline, reasoning that a second Ctrl-C is the escape — but that assumes the user *knows*
that. Print *"still shutting down… Ctrl-C again to force"*, then force-reap.
**Measure the real p99 of those two awaits before picking thresholds** — if a legitimate closure build
routinely exceeds the threshold, the line becomes noise on every clean Ctrl-C.

**P2 — the rest.**
- **B.** `process.on('exit', reapFromSnapshot)` — one line, covers the boot window
  (`registerCrashBarrier()` installs at `entry/dev-server.ts:142`, *after* both engines spawn) and
  stray `process.exit()`. **Not** steady-state `uncaughtException`: once the barrier is installed it
  never rethrows or exits (`crash-barrier.ts:71-83`), so `exit` never fires. Say that in the comment or
  someone will "simplify" the barrier and silently widen the hole. Note it costs one `ps` on *every*
  exit — guard it if `shutdown()` already reaped.
- **C.** `--cmux` reaps nothing: panes are children of the **cmux daemon**, so `forceReap`'s ppid-walk
  from `process.pid` finds zero groups, and `cmux close-workspace` failure is swallowed to a debug log
  (`open-dev-workspace.ts:52-54`) while the supervisor exits anyway. Verify closure instead of
  swallowing.
- **D.** Force branch never restores the terminal (`signal-shutdown.ts:162-166`). Narrow: `renderer.dispose()`
  is the **first, synchronous** statement of `shutdown()`, so a human's second Ctrl-C always lands after
  the scroll region is already reset. Real exposure is standalone `dev` + a tight supervisor
  `SIGTERM; SIGTERM` loop. One-line `ESC[r ESC[?25h`. (Do **not** delete `HIDE_CURSOR` —
  `__tests__/scroll-region.test.ts:5` imports it.)
- **F.** MCP `setupErrorHandlers` exits **0** on SIGTERM (`error-handlers/index.ts:13-21`), violating the
  `128+signo` contract. Owns no dev servers, so low impact.
- **G.** `pnpm exec` / `doppler run --` sit in the foreground group and relay signals. The reap is already
  defended, but the ELIFECYCLE noise remains. `dev-server.ts:1847-1852` prescribes the fix: `exec` into
  the binary from consumer dev scripts.
- **H.** Ctrl-Z suspends `dev` but not its detached servers (`run-session.ts:203-206`). Document it.
- **J.** Session-shell `onSigint`/`onSighup` exit paths skip `resetTerminal`.

---

## 5. Explicitly rejected

- **Durable run-ledger + startup janitor (v1's centerpiece).** The durable record already exists —
  `writeDevContextFragment` (`dev-server.ts:1211-1230`) writes `{package, port, pid, release, alias}`
  atomically, and portless persists its own `routes.json`. A ledger's only *novel* field is
  `childPgids[]`, which is exactly the field that cannot be validated after the writer dies. Its
  `<repo>` key is either **useless** (worktree-local → never sees the other worktree) or **dangerous**
  (main-repo-root → worktree A's janitor SIGKILLs worktree B's healthy vite). `--cmux` spawns N
  concurrent `dev` processes, so N janitors would race one shared dir *by default*. And it puts an
  automatic SIGKILL on the hot path of the most-run command — the Layer-3 auto-seed incident with a far
  worse blast radius.
- **Self-healing alias re-registration ("remove if stale, then register").** A no-op *and* a
  regression. `portless alias` is **already** an atomic, lock-held remove-then-add keyed by name
  (`addRoute`, portless `chunk-SD2PIWJU.js:859-884`; infra-kit registers with `pid 0`, so the
  conflict branch is unreachable). Re-implementing it across two CLI subprocesses **releases the route
  lock in between** — converting a lock-protected atomic upsert into a genuine check-then-act race.
- **Env-cookie (`INFRA_KIT_RUN_ID`) scanning.** Sound in principle (a recycled pid can't forge a uuid)
  but **`ps -E` returns nothing on macOS** — not buildable on the primary dev platform. `(pgid, lstart)`
  is the working substitute.
- **Scanning for stray `vite` by process name.** Kills another worktree's healthy vite.
- **More signal handlers.** SIGKILL and power loss are unhandleable by construction.

---

## 6. Testing

`signal-shutdown.test.ts` is entirely seam-injected (fake `exit`/`register`/`forceReap`). It proves the
*state machine*, not the *reaping*. Nothing in the suite spawns a real tree and sends a real signal —
so **none of the bugs above are currently catchable.**

**The reap needs no turbo, no vite, no portless, and no PTY.** Spawn a detached engine that forks a
grandchild into its own pgid, kill the engine, and assert zero survivors. Runs in ~1s **inside the
normal vitest gate**. This is precisely the probe that disproved v2's fix, which is the proof it
catches the real bug. Do this first.

Reserve real PTY tests (`script -q /dev/null`) for the paths where the terminal *is* the system under
test — **I** and **D**. Note a full PTY matrix cannot run in CI at all: `ensureProxy`
(`dev-server.ts:1095-1117`) **throws** without a live portless daemon on `:443`, which needs a
privileged `portless service install` on the runner. Budget that or don't promise it.

### Acceptance criteria (falsifiable)

1. Engine SIGKILLed → its task groups are gone within the grace window. *(Fails today.)*
2. Engine SIGKILLed, **then** Ctrl-C → zero surviving descendants. *(Fails today —
   `managed-child.ts:254` bails.)*
3. A reap never kills a group whose leader's `lstart` differs from the snapshot. *(Pid-reuse guard.)*
4. `doctor --fix` leaves a **booting** UI's alias untouched (port not yet bound, fragment live).
5. SIGINT delivered in the `setChildRunning(false)` → palette-re-armed window returns to the palette
   and does **not** exit the session shell. *(Fails today.)*
6. Ctrl-C during a wedged rebuild prints progress within N seconds rather than hanging silently.
