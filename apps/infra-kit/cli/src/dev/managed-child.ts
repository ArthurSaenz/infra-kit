/**
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
 */
import { execFileSync } from 'node:child_process'
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

/** One row of `ps -eo pid=,ppid=,pgid=`. */
export interface ProcRow {
  pid: number
  ppid: number
  pgid: number
}

/** Parse `ps -eo pid=,ppid=,pgid=` output, skipping any line that isn't three integers. */
export const parseProcRows = (raw: string): ProcRow[] => {
  return raw.split('\n').flatMap((line) => {
    const [rawPid, rawPpid, rawPgid] = line.trim().split(/\s+/)

    if (rawPid == null || rawPpid == null || rawPgid == null) return []

    const pid = Number(rawPid)
    const ppid = Number(rawPpid)
    const pgid = Number(rawPgid)

    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgid)) return []

    return [{ pid, ppid, pgid }]
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
export const collectDoomedGroups = (rootPid: number, rows: ProcRow[], excludePgid?: number): number[] => {
  const childrenOf = new Map<number, ProcRow[]>()

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
    return parseProcRows(execFileSync(PS_BIN, ['-eo', 'pid=,ppid=,pgid='], { encoding: 'utf8', maxBuffer: 8 << 20 }))
  } catch {
    return []
  }
}

/** Does `pid` currently exist and name a direct child of `parentPid`? Guards against pid reuse. */
export const isChildOf = (pid: number, parentPid: number, rows: ProcRow[]): boolean => {
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
 * SIGKILL every process group descended from this process, right now.
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
  signalGroups(doomedGroupsOf(process.pid, snapshotProcRows()), 'SIGKILL')
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
 * the "engine died silently" case. A `killing` latch, set at the top of `kill()` before any signal
 * goes out, suppresses the callback for the exit our own teardown causes, so it reports only genuine
 * crashes. The `error` listener is load-bearing beyond reporting: a {@link ChildProcess} that emits
 * `error` (e.g. `pnpm` ENOENT) with no listener throws as an uncaught exception and would take the
 * whole dev session down.
 */
export function superviseChild(
  child: ChildProcess,
  graceMs: number = DEFAULT_GRACE_MS,
  onUnexpectedExit?: UnexpectedExitHandler,
): ManagedChild {
  // Don't keep the parent event loop alive on the child; the runner owns lifecycle via kill().
  child.unref()

  // Latched by kill() before it signals, so the child's own teardown exit is not misreported as a crash.
  let killing = false

  const reportUnexpected = (detail: string): void => {
    if (killing) return
    onUnexpectedExit?.(detail)
  }

  child.on('exit', (code, signal) => {
    reportUnexpected(`exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`)
  })
  child.on('error', (error: Error) => {
    reportUnexpected(`failed to spawn: ${error.message}`)
  })

  return {
    kill: async (): Promise<void> => {
      // Latch FIRST: the child WILL emit `exit` during the reap below, and that exit is ours, not a crash.
      killing = true

      const pid = child.pid

      if (pid == null) return

      // Two guards against the same hazard: once the child is reaped the OS may recycle `pid`
      // onto an unrelated process, and `kill(-pid, …)` would then destroy a stranger's group.
      // A turbo that exits on its own reaps its own tasks, so bailing here strands nothing.
      if (child.exitCode !== null || child.signalCode !== null) return

      const rows = snapshotProcRows()

      // The cheap check above misses a child reaped just now, so confirm `pid` is still ours: a
      // detached child keeps us as its parent, so a foreign `ppid` means the pid was recycled.
      // Skipped when `ps` failed (empty `rows`) — then only the guard above stands.
      if (rows.length > 0 && !isChildOf(pid, process.pid, rows)) return

      const doomed = doomedGroupsOf(pid, rows)

      // Negative pid → the whole group (detached made the child a group leader). Turbo forwards
      // this to its tasks; the extra task groups are signalled directly in case it doesn't.
      signalGroups(doomed, 'SIGTERM')

      const stragglers = await waitForExit(doomed, graceMs)

      if (stragglers.length === 0) return

      // Re-snapshot before forcing: turbo is still alive (that's why we're here), so its tree is
      // still walkable, and `turbo watch build` may have started a task AFTER the first snapshot.
      // Union with the known stragglers, whose groups may already have left turbo's subtree.
      const late = doomedGroupsOf(pid, snapshotProcRows())
      const forced = [...new Set([...stragglers, ...late])].filter(groupAlive)

      // Killing turbo's group alone would orphan exactly these, so they are killed as a set.
      signalGroups(forced, 'SIGKILL')

      // A SIGKILLed leader lingers as an unreaped zombie for a few ms, and `kill(pgid, 0)` still
      // succeeds against it. Wait for the kernel to finish so callers that exit the process
      // immediately after `kill()` resolves aren't racing the teardown they just awaited.
      await waitForExit(forced, REAP_TIMEOUT_MS)
    },
  }
}
