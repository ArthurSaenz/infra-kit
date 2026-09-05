/**
 * @fileoverview
 *
 * Shared supervision for the dev-server's long-lived, detached child processes
 * (`turbo watch build`, `turbo run dev`). Both are deep trees
 * (`sh → pnpm → node → turbo → …`) spawned `detached` so they form their own process
 * group; teardown signals the whole GROUP (`process.kill(-pid, …)`), not just the wrapper.
 *
 * Signalling turbo's group is NOT enough on its own: turbo puts every task it runs
 * (`vite`, `tsc -b`, …) into a process group of its OWN, so `kill(-turboPid, …)` reaches
 * turbo but never its tasks. Turbo normally forwards the signal and reaps them, but when it
 * is slower than the grace window a bare `SIGKILL` on turbo's group kills the only process
 * that knows the task groups — stranding orphaned vite servers that hold their ports until
 * the next run fails with `EADDRINUSE`.
 *
 * So teardown snapshots the descendant process groups BEFORE signalling (once turbo dies its
 * children reparent to init and can no longer be found by walking `ppid`), waits for the whole
 * set to exit, and only then force-kills whatever is left.
 *
 * The same fact — reparenting blinds the `ppid` walk — is why a snapshot taken only at teardown is not
 * enough. When turbo dies on its OWN (a crash, an OOM kill) there is no teardown to snapshot from, and
 * the tasks it never reaped are already unreachable. So the snapshot is instead kept ROLLING for the
 * child's whole life, and each group is stamped with its leader's `lstart`: a pgid is a bare integer the
 * kernel will happily recycle, and the leader's start time is the only proof that the group we are about
 * to SIGKILL is still the one we saw.
 *
 * That rolling snapshot lives in a per-child closure, which is exactly what the SECOND-SIGNAL force path
 * (`killDescendantGroupsNow`, used by both `signal-shutdown`'s force-quit and `crash-barrier`'s fatal
 * path) cannot reach on its own — it only ever does a live `ppid` walk from `process.pid`, the same walk
 * that goes blind the moment a child dies. So every supervised child's snapshot is also published to a
 * module-level `registry` (see below), letting that force path find a descendant which reparented to init
 * before ITS parent's `exit` even fired — the one case a live walk structurally cannot cover.
 */
import { execFile, execFileSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import process from 'node:process'

/** Handle to a supervised child; `kill()` reaps its whole process tree and resolves when gone. */
export interface ManagedChild {
  kill: () => Promise<void>
}

/**
 * Grace before escalating SIGTERM → SIGKILL. Long enough for turbo to stop its tasks itself
 * (typically well under a second) and short enough that Ctrl-C still feels immediate. Escalating
 * is safe now that every task group is killed as a set, so this need not cover the worst case.
 * The happy path never waits the full window — teardown returns as soon as the groups are gone.
 */
const DEFAULT_GRACE_MS = 5000

/** Poll interval while waiting for the doomed process groups to exit. */
const POLL_MS = 100

/** How long to wait for the kernel to reap a group after SIGKILL before giving up on confirmation. */
const REAP_TIMEOUT_MS = 2000

/** Absolute path to `ps` — present on both macOS and Linux, and immune to `PATH` substitution. */
const PS_BIN = '/bin/ps'

/**
 * How often the live process table is sampled while a supervised child is alive, to keep
 * {@link ManagedChild}'s group snapshot current. See {@link superviseChild} for why a snapshot taken
 * only at kill-time is too late. Async (`execFile`, not `execFileSync`), so it never blocks the event
 * loop the in-process backends share.
 */
const SAMPLE_INTERVAL_MS = 1000

/** `ps` columns: the `ppid` walk needs pid/ppid/pgid, and the reuse guard needs the leader's `lstart`. */
const PS_ARGS = ['-eo', 'pid=,ppid=,pgid=,lstart='] as const

/** Cap on `ps` output; a busy machine's full process table stays far below this. */
const PS_MAX_BUFFER = 8 << 20

/** One row of `ps -eo pid=,ppid=,pgid=,lstart=`. */
export interface ProcRow {
  pid: number
  ppid: number
  pgid: number
  /** The process's start time as `ps` prints it (`Mon Jul 13 13:21:14 2026`); `''` when unavailable. */
  lstart: string
}

/**
 * The subset of a {@link ProcRow} that describes the process TREE. The `ppid` walk needs nothing else,
 * so the functions that only walk take this — `lstart` is the reuse guard's concern, not the topology's.
 */
export type TopologyRow = Pick<ProcRow, 'pid' | 'ppid' | 'pgid'>

/**
 * Parse `ps -eo pid=,ppid=,pgid=,lstart=`, skipping any line that doesn't start with three integers.
 * `lstart` is whitespace-separated and multi-token, so it is everything after the third column.
 */
export const parseProcRows = (raw: string): ProcRow[] => {
  return raw.split('\n').flatMap((line) => {
    const [rawPid, rawPpid, rawPgid, ...rest] = line.trim().split(/\s+/)

    if (rawPid == null || rawPpid == null || rawPgid == null) return []

    const pid = Number(rawPid)
    const ppid = Number(rawPpid)
    const pgid = Number(rawPgid)

    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgid)) return []

    return [{ pid, ppid, pgid, lstart: rest.join(' ') }]
  })
}

/**
 * A process group, stamped with its LEADER's start time at the moment the group was observed.
 *
 * The start time is the whole point. A pgid on its own is a bare integer: by the time we come to reap
 * it the kernel may have recycled it onto an unrelated process, and `kill(-pgid, …)` would then destroy
 * a stranger's group. The leader's `lstart` is the identity that survives — a recycled pgid necessarily
 * has a NEWER birth time than the one recorded, so it is refused.
 */
export interface GroupSnapshot {
  pgid: number
  leaderStart: string
}

/** Map every process group in `rows` to its leader's start time (the leader is the pid equal to the pgid). */
const leaderStarts = (rows: ProcRow[]): Map<number, string> => {
  const starts = new Map<number, string>()

  for (const row of rows) {
    if (row.pid === row.pgid) starts.set(row.pgid, row.lstart)
  }

  return starts
}

/**
 * {@link collectDoomedGroups}, but each group is stamped with its leader's start time so it can be
 * validated later. Groups whose leader is not in `rows` are dropped: with no leader there is nothing to
 * stamp, so nothing could prove the group is still the one we saw, and the reuse guard must fail closed.
 *
 * @example
 * const rows = [
 *   { pid: 10, ppid: 1, pgid: 10, lstart: 'Mon Jul 13 13:00:00 2026' },
 *   { pid: 20, ppid: 10, pgid: 20, lstart: 'Mon Jul 13 13:00:01 2026' },
 * ]
 * snapshotGroups(10, rows) // => [{ pgid: 10, leaderStart: '…13:00:00…' }, { pgid: 20, leaderStart: '…13:00:01…' }]
 */
export const snapshotGroups = (rootPid: number, rows: ProcRow[], excludePgid?: number): GroupSnapshot[] => {
  const starts = leaderStarts(rows)

  return collectDoomedGroups(rootPid, rows, excludePgid).flatMap((pgid) => {
    const leaderStart = starts.get(pgid)

    if (leaderStart == null || leaderStart === '') return []

    return [{ pgid, leaderStart }]
  })
}

/**
 * pgids in `snapshot` whose leader's start time still matches `rows` — the reuse guard shared by every
 * path that reaps from a snapshot instead of a live walk: {@link reapSnapshot} (the per-child crash/kill
 * reap) and {@link collectForceReapTargets} (the force-reap path, reaping every REGISTERED child's
 * snapshot). Extracted so the two can never drift apart — a registry-sourced pgid must clear the exact
 * same check a per-child reap does before either signals it.
 */
const validSnapshotPgids = (snapshot: readonly GroupSnapshot[], rows: ProcRow[]): number[] => {
  const starts = leaderStarts(rows)

  return snapshot.flatMap(({ pgid, leaderStart }) => {
    return starts.get(pgid) === leaderStart ? [pgid] : []
  })
}

/**
 * SIGKILL every snapshotted group whose leader is STILL the same process, and return the pgids killed.
 *
 * A group whose leader has since exited is skipped (nothing to kill, and no way to prove ownership of
 * whatever else may share the pgid). A group whose leader's start time no longer matches is a recycled
 * pgid belonging to a stranger — skipped, loudly and deliberately. This is the guard that makes reaping
 * from a stale snapshot safe, and it is why the snapshot records `lstart` at all.
 */
export const reapSnapshot = (snapshot: readonly GroupSnapshot[], rows: ProcRow[]): number[] => {
  return validSnapshotPgids(snapshot, rows).flatMap((pgid) => {
    try {
      process.kill(-pgid, 'SIGKILL')
    } catch {
      // Raced us to exit (ESRCH) — nothing to kill.
      return []
    }

    return [pgid]
  })
}

/**
 * Distinct process groups of every transitive descendant of `rootPid`, plus `rootPid`'s own
 * group. Group `0`/`1` and `excludePgid` (our own group — a detached child can never share it,
 * but a mis-parsed row must never make us signal ourselves) are filtered out.
 *
 * @example
 * const rows = [{ pid: 10, ppid: 1, pgid: 10 }, { pid: 20, ppid: 10, pgid: 20 }]
 * collectDoomedGroups(10, rows, 5) // => [10, 20]
 */
export const collectDoomedGroups = (rootPid: number, rows: TopologyRow[], excludePgid?: number): number[] => {
  const childrenOf = new Map<number, TopologyRow[]>()

  for (const row of rows) {
    const siblings = childrenOf.get(row.ppid)

    if (siblings) siblings.push(row)
    else childrenOf.set(row.ppid, [row])
  }

  const groups = new Set<number>([rootPid])
  const seen = new Set<number>([rootPid])
  const queue = [rootPid]

  for (let i = 0; i < queue.length; i += 1) {
    for (const child of childrenOf.get(queue[i] ?? -1) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      groups.add(child.pgid)
      queue.push(child.pid)
    }
  }

  return [...groups].filter((pgid) => {
    return pgid > 1 && pgid !== excludePgid
  })
}

/**
 * Snapshot the live process table; an empty list on failure degrades to group-only teardown.
 * `ps` is invoked by absolute path (not via `PATH`, unlike the `pnpm` the engines shell out to)
 * so a writable `PATH` entry can never substitute the binary we hand a kill list to.
 */
const snapshotProcRows = (): ProcRow[] => {
  try {
    return parseProcRows(execFileSync(PS_BIN, [...PS_ARGS], { encoding: 'utf8', maxBuffer: PS_MAX_BUFFER }))
  } catch {
    return []
  }
}

/**
 * {@link snapshotProcRows}, off the event loop. The rolling sampler runs on a timer for the whole life
 * of a dev session, and the in-process backends share this loop — a synchronous `ps` every second would
 * stall every request that lands during it. Resolves to `[]` on failure, degrading to the previous
 * snapshot rather than clobbering it.
 */
const snapshotProcRowsAsync = async (): Promise<ProcRow[]> => {
  return new Promise((resolve) => {
    execFile(PS_BIN, [...PS_ARGS], { encoding: 'utf8', maxBuffer: PS_MAX_BUFFER }, (error, stdout) => {
      resolve(error ? [] : parseProcRows(stdout))
    })
  })
}

/** Does `pid` currently exist and name a direct child of `parentPid`? Guards against pid reuse. */
export const isChildOf = (pid: number, parentPid: number, rows: TopologyRow[]): boolean => {
  return rows.some((row) => {
    return row.pid === pid && row.ppid === parentPid
  })
}

/**
 * The groups to signal for `rootPid`'s tree, excluding our own group so a mis-parsed `ps` row can
 * never make the dev-server signal itself.
 */
const doomedGroupsOf = (rootPid: number, rows: ProcRow[]): number[] => {
  const ownPgid = rows.find((row) => {
    return row.pid === process.pid
  })?.pgid

  return collectDoomedGroups(rootPid, rows, ownPgid)
}

/** Is the process group led by `pgid` still alive? (`kill(-pgid, 0)` throws ESRCH when gone.) */
const groupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0)

    return true
  } catch {
    return false
  }
}

/** Send `signal` to every named process group, ignoring groups that already exited. */
const signalGroups = (pgids: number[], signal: NodeJS.Signals): void => {
  for (const pgid of pgids) {
    try {
      process.kill(-pgid, signal)
    } catch {
      // Already gone (ESRCH) — nothing to signal.
    }
  }
}

/**
 * Live accessors into every currently-supervised child's rolling {@link GroupSnapshot} list — populated by
 * {@link superviseChild} on spawn, removed only once that child's own groups are CONFIRMED gone (see
 * `deregisterAfter` inside it, not the child's bare `exit` event). This is what lets
 * {@link killDescendantGroupsNow} — the second-signal force path and the crash-barrier's fatal path —
 * reach a descendant that reparented to init before ITS parent's `exit` fired: a live `ppid` walk from
 * `process.pid` cannot see such a descendant (see the module doc block for why), but a snapshot recorded
 * while the parent was still alive can.
 *
 * INVARIANT — never regress this: a registry-sourced pgid is signalled ONLY after
 * {@link validSnapshotPgids} confirms its leader's start time still matches a FRESH `ps` snapshot. An
 * ungated union would SIGKILL a recycled pgid — a hazard the live walk cannot have, since it only ever
 * names processes that are alive right now.
 */
const registry = new Set<() => readonly GroupSnapshot[]>()

/**
 * The pgids {@link killDescendantGroupsNow} should signal: every group in the live `ppid` walk from
 * `rootPid` (unchanged semantics — see {@link doomedGroupsOf}), UNIONED with every registry-sourced
 * snapshot that survives {@link validSnapshotPgids} against the same `rows`. Live-walk pgids are not
 * lstart-gated — they carry no snapshot to validate against, and are live by construction; only the
 * registry-sourced half needs the reuse guard.
 *
 * Pulled out of `killDescendantGroupsNow` as a pure function so the union/dedupe logic can be tested
 * against a fake process table and fake registry snapshots, without spawning real processes or waiting on
 * a real `ps`.
 *
 * @example
 * // pgid 20 is unreachable from rootPid (reparented to init) but was recorded before its parent died.
 * collectForceReapTargets(1000, freshRows, [[{ pgid: 20, leaderStart: '…' }]]) // => [20]
 */
export const collectForceReapTargets = (
  rootPid: number,
  rows: ProcRow[],
  registrySnapshots: readonly (readonly GroupSnapshot[])[],
): number[] => {
  const live = doomedGroupsOf(rootPid, rows)
  const fromRegistry = registrySnapshots.flatMap((snapshot) => {
    return validSnapshotPgids(snapshot, rows)
  })

  return [...new Set([...live, ...fromRegistry])]
}

/**
 * SIGKILL every process group descended from this process, right now — plus every REGISTERED
 * supervised-child snapshot that still validates, so a group that reparented to init before its parent's
 * `exit` fired is not left behind just because the live `ppid` walk can no longer see it.
 *
 * The force-quit path (a second Ctrl-C) abandons the graceful teardown, but it must not abandon the
 * CHILDREN: they hold the dev ports, and the next start would 502 against their stale portless
 * aliases. So this is the blunt counterpart to {@link superviseChild}'s teardown — no SIGTERM grace,
 * no escalation, no waiting for the kernel to reap. Straight to SIGKILL.
 *
 * Synchronous by contract: the caller exits the process on the very next line, so anything deferred
 * to a later tick would never run. Cost is one `ps` (tens of ms) plus a `kill` per group; that is the
 * whole latency budget a user who just hit Ctrl-C twice is willing to spend.
 */
export const killDescendantGroupsNow = (): void => {
  const rows = snapshotProcRows()
  const registrySnapshots = [...registry].map((getGroups) => {
    return getGroups()
  })

  signalGroups(collectForceReapTargets(process.pid, rows, registrySnapshots), 'SIGKILL')
}

/** Resolve after `ms`, used to pace the teardown polling loop. */
const sleep = async (ms: number): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Poll `pgids` until every group has exited or `timeoutMs` elapses; returns the survivors. */
const waitForExit = async (pgids: number[], timeoutMs: number): Promise<number[]> => {
  const deadline = Date.now() + timeoutMs
  let alive = pgids

  while (alive.length > 0 && Date.now() < deadline) {
    alive = alive.filter(groupAlive)
    if (alive.length === 0) break
    await sleep(POLL_MS)
  }

  return alive
}

/**
 * Called when a supervised child dies on its OWN — a natural `exit` or a spawn `error` that was
 * NOT initiated by {@link ManagedChild.kill}. `detail` is a short human description of the cause.
 * The runner uses it to surface a silently-dead `turbo watch`/`turbo run dev` engine (which stops
 * rebuilds/HMR with no other signal) instead of leaving the session looking healthy.
 */
export type UnexpectedExitHandler = (detail: string) => void

/**
 * Wrap a detached child: `unref()` it (so it never keeps the loop alive) and return a handle
 * whose `kill()` reaps the child AND every process group turbo spawned beneath it.
 *
 * Snapshot first, signal second: after turbo exits its tasks reparent to init, so the `ppid`
 * walk that finds them must run while turbo is still alive. Then SIGTERM every doomed group,
 * poll until all are gone, and SIGKILL the survivors. Resolves once nothing is left.
 *
 * `onUnexpectedExit` (optional) fires when the child dies WITHOUT `kill()` having been called —
 * the "engine died silently" case; the exit our own teardown causes never reaches it.
 */
// The snapshot-first order covers the ORDERLY death, where we choose the moment and can walk the tree
// first. It does not cover turbo CRASHING, because reparenting happens at termination — strictly before
// Node hands us the `exit` event — so by then the walk is already blind. A rolling snapshot (see `sample`)
// is therefore kept for the child's whole life, and both the crash path and a `kill()` on an already-dead
// child reap from it, validating each group against its leader's start time so a recycled pgid is never
// killed.
//
// A `killing` latch, set at the top of `kill()` before any signal goes out, is what suppresses
// `onUnexpectedExit` for our own teardown, so it reports only genuine crashes.
//
// The `error` listener is load-bearing beyond reporting: a ChildProcess that emits `error` (e.g. `pnpm`
// ENOENT) with no listener throws as an uncaught exception and would take the whole dev session down.
export function superviseChild(
  child: ChildProcess,
  graceMs: number = DEFAULT_GRACE_MS,
  onUnexpectedExit?: UnexpectedExitHandler,
  /**
   * Test-only seam: overrides the `ps` snapshot used by this child's own reap ATTEMPTS (the crash-time
   * reap in the `exit` handler, and `kill()`'s reaps) — never the rolling sampler, which always uses the
   * real one. Defaults to the real synchronous `ps` call for every production caller. Lets a test simulate
   * a transient `ps` failure (an empty read) without needing to race the real one.
   */
  snapshotRowsOverride: () => ProcRow[] = snapshotProcRows,
): ManagedChild {
  // Don't keep the parent event loop alive on the child; the runner owns lifecycle via kill().
  child.unref()

  // Latched by kill() before it signals, so the child's own teardown exit is not misreported as a crash.
  let killing = false
  // Set by the `exit` listener, so a sampler callback still in flight cannot clobber the final snapshot.
  let exited = false
  /** Last known process groups beneath this child, refreshed while it is alive. See the sampler below. */
  let groups: GroupSnapshot[] = []
  let sampler: NodeJS.Timeout | null = null

  /** Live accessor registered in {@link registry} for the whole life of this child — see `deregisterAfter`. */
  const getGroups = (): readonly GroupSnapshot[] => {
    return groups
  }

  registry.add(getGroups)

  const stopSampling = (): void => {
    if (sampler) clearInterval(sampler)
    sampler = null
  }

  /**
   * Drop this child's accessor from {@link registry} once every group it ever recorded is CONFIRMED gone
   * — never merely because `exit` fired or a reap attempt ran. A reap attempt can fail to kill anything
   * for a legitimate reason (a stale/empty `ps` read) while the descendant is still very much alive, and
   * removing the entry THEN would strand it: nothing else remembers those pgids once this closure is gone.
   * Bounded by `REAP_TIMEOUT_MS` so a group this genuinely cannot reap (a foreign process now holding a
   * recycled pgid) does not pin a dead entry in the registry forever.
   */
  const deregisterAfter = async (): Promise<void> => {
    await waitForExit(
      groups.map((g) => {
        return g.pgid
      }),
      REAP_TIMEOUT_MS,
    )
    registry.delete(getGroups)
  }

  /**
   * Turn a fresh `ps` read into an updated {@link groups}. An empty result is discarded rather than
   * stored: `ps` failing, or racing the child's own death, must degrade to the previous snapshot, never
   * erase it. Shared by the synchronous first sample below and the async rolling {@link sample}, so the
   * two can never compute the group set differently.
   */
  const applySample = (rows: ProcRow[]): void => {
    const pid = child.pid

    if (pid == null || exited || killing || rows.length === 0) return

    const ownPgid = rows.find((row) => {
      return row.pid === process.pid
    })?.pgid
    const next = snapshotGroups(pid, rows, ownPgid)

    if (next.length > 0) groups = next
  }

  /**
   * Refresh {@link groups} while the child is alive.
   *
   * This is what makes a crash survivable. Reaping walks `ppid` from the child — but a process that
   * dies has ALREADY reparented its children to init by the time Node delivers `exit`, so a walk
   * started from the corpse finds only the corpse's own group. Verified: while turbo is alive the walk
   * yields `[turbo, vite]`; inside the `exit` handler it yields `[turbo]`, and vite (`ppid=1`, still
   * running, still holding its port) is unreachable forever. There is no window to race — the only way
   * to know vite's group after turbo dies is to have written it down BEFORE turbo died.
   *
   * Async (`snapshotProcRowsAsync`) so the rolling tick never blocks the event loop the in-process
   * backends share — see the FIRST sample below for why that leaves a narrow window this function alone
   * cannot close.
   */
  const sample = async (): Promise<void> => {
    if (child.pid == null || exited || killing) return

    applySample(await snapshotProcRowsAsync())
  }

  // Synchronous, not `void sample()`: a child that crashes within `sample()`'s first async `ps` round
  // trip (tens of ms) would otherwise have no snapshot recorded at all, and the `exit` handler's
  // `reapSnapshot(groups, …)` would run against an empty `groups` and reap nothing — the exact
  // spawn→first-snapshot window W11 closes. One small `ps` exec, before this function ever returns,
  // costs the same one-time block on the shared event loop that `killDescendantGroupsNow`'s synchronous
  // `ps` call already spends on every force-quit — paid once per spawn instead of once per Ctrl-C.
  applySample(snapshotProcRows())

  sampler = setInterval(() => {
    void sample()
  }, SAMPLE_INTERVAL_MS)
  // The timer must never be the reason the process stays alive — it outlives nothing.
  sampler.unref()

  const reportUnexpected = (detail: string): void => {
    if (killing) return
    onUnexpectedExit?.(detail)
  }

  child.on('exit', (code, signal) => {
    exited = true
    stopSampling()

    // The child died WITHOUT us killing it — a turbo crash, or an OOM kill. Turbo puts each of its
    // tasks in a process group of its OWN, and a turbo that dies this way reaps none of them, so
    // `vite`/`tsc` survive holding their ports. Nothing can find them by walking (see `sample`), and
    // the `kill()` below would bail on an already-exited child. Reaping from the snapshot here is the
    // only thing standing between a crashed engine and a permanently orphaned dev server.
    //
    // `deregisterAfter` (not a bare delete) — this reap attempt reading a stale/empty `ps` snapshot must
    // not be mistaken for the descendants actually being gone; the registry entry is the only remaining
    // record of them until a later confirmation (or force-reap) proves they are.
    if (!killing) {
      reapSnapshot(groups, snapshotRowsOverride())
      void deregisterAfter()
    }

    reportUnexpected(`exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`)
  })
  child.on('error', (error: Error) => {
    reportUnexpected(`failed to spawn: ${error.message}`)
  })

  return {
    kill: async (): Promise<void> => {
      // Latch FIRST: the child WILL emit `exit` during the reap below, and that exit is ours, not a crash.
      killing = true
      stopSampling()

      const pid = child.pid

      if (pid == null) {
        // Never spawned a real pid — nothing was ever tracked, so nothing to confirm.
        registry.delete(getGroups)

        return
      }

      // Once the child is reaped the OS may recycle `pid` onto an unrelated process, and `kill(-pid, …)`
      // would then destroy a stranger's group — so an exited child is never walked. It is not simply
      // skipped either: a turbo that CRASHED left its task groups running, and this is the Ctrl-C that
      // has to clear them. The snapshot is the only surviving handle on those groups, and `reapSnapshot`
      // re-validates each one against its leader's start time, so a recycled pgid is refused.
      if (child.exitCode !== null || child.signalCode !== null) {
        reapSnapshot(groups, snapshotRowsOverride())
        await deregisterAfter()

        return
      }

      const rows = snapshotRowsOverride()

      // The cheap check above misses a child reaped just now, so confirm `pid` is still ours: a
      // detached child keeps us as its parent, so a foreign `ppid` means the pid was recycled.
      // Skipped when `ps` failed (empty `rows`) — then only the guard above stands. The registry entry is
      // deliberately left alone here: this state is genuinely ambiguous (did the pid really get
      // recycled, or did `ps` just fail?), and the safe default is to let a later reap re-decide with a
      // fresh read, not to guess by dropping the one record we have.
      if (rows.length > 0 && !isChildOf(pid, process.pid, rows)) return

      const doomed = doomedGroupsOf(pid, rows)

      // Negative pid → the whole group (detached made the child a group leader). Turbo forwards
      // this to its tasks; the extra task groups are signalled directly in case it doesn't.
      signalGroups(doomed, 'SIGTERM')

      const stragglers = await waitForExit(doomed, graceMs)

      if (stragglers.length === 0) {
        // Every doomed group (this child's own, plus every task group the live walk found) exited
        // within grace — confirmed by the `waitForExit` above, so no further wait is needed here.
        registry.delete(getGroups)

        return
      }

      // Re-snapshot before forcing: turbo is still alive (that's why we're here), so its tree is
      // still walkable, and `turbo watch build` may have started a task AFTER the first snapshot.
      // Union with the known stragglers, whose groups may already have left turbo's subtree.
      const late = doomedGroupsOf(pid, snapshotRowsOverride())
      const forced = [...new Set([...stragglers, ...late])].filter(groupAlive)

      // Killing turbo's group alone would orphan exactly these, so they are killed as a set.
      signalGroups(forced, 'SIGKILL')

      // A SIGKILLed leader lingers as an unreaped zombie for a few ms, and `kill(pgid, 0)` still
      // succeeds against it. Wait for the kernel to finish so callers that exit the process
      // immediately after `kill()` resolves aren't racing the teardown they just awaited.
      await waitForExit(forced, REAP_TIMEOUT_MS)
      registry.delete(getGroups)
    },
  }
}
