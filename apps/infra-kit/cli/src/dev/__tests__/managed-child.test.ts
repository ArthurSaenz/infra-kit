import { execFileSync, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'

import {
  collectDoomedGroups,
  isChildOf,
  parseProcRows,
  reapSnapshot,
  snapshotGroups,
  superviseChild,
} from '../managed-child.js'

describe('parseProcRows', () => {
  it('parses pid/ppid/pgid and the multi-token lstart, skipping malformed lines', () => {
    const raw = [
      '  101   1   101 Mon Jul 13 13:21:14 2026',
      '  202 101   202 Mon Jul 13 13:21:15 2026',
      'header junk',
      '',
      '  303 202 303',
    ].join('\n')

    expect(parseProcRows(raw)).toEqual([
      { pid: 101, ppid: 1, pgid: 101, lstart: 'Mon Jul 13 13:21:14 2026' },
      { pid: 202, ppid: 101, pgid: 202, lstart: 'Mon Jul 13 13:21:15 2026' },
      // No lstart column — still a usable topology row, just not one the reuse guard can stamp.
      { pid: 303, ppid: 202, pgid: 303, lstart: '' },
    ])
  })
})

describe('snapshotGroups / reapSnapshot', () => {
  const rows = [
    { pid: 10, ppid: 1, pgid: 10, lstart: 'Mon Jul 13 13:00:00 2026' }, // turbo (group leader)
    { pid: 20, ppid: 10, pgid: 20, lstart: 'Mon Jul 13 13:00:01 2026' }, // vite — its OWN group
  ]

  it('stamps each descendant group with its leader’s start time', () => {
    expect(snapshotGroups(10, rows)).toEqual([
      { pgid: 10, leaderStart: 'Mon Jul 13 13:00:00 2026' },
      { pgid: 20, leaderStart: 'Mon Jul 13 13:00:01 2026' },
    ])
  })

  it('drops a group whose leader is absent — with nothing to stamp, the reuse guard must fail closed', () => {
    // vite's group exists (the child is in it) but its LEADER is not in the table.
    const headless = [
      { pid: 10, ppid: 1, pgid: 10, lstart: 'Mon Jul 13 13:00:00 2026' },
      { pid: 21, ppid: 10, pgid: 20, lstart: 'Mon Jul 13 13:00:02 2026' },
    ]

    expect(snapshotGroups(10, headless)).toEqual([{ pgid: 10, leaderStart: 'Mon Jul 13 13:00:00 2026' }])
  })

  it('refuses a recycled pgid whose leader was born after the snapshot — the whole point of lstart', () => {
    const snapshot = snapshotGroups(10, rows)
    // pgid 20 still exists, but it is now a STRANGER's group: same integer, newer leader.
    const recycled = [{ pid: 20, ppid: 1, pgid: 20, lstart: 'Mon Jul 13 19:45:00 2026' }]

    expect(reapSnapshot(snapshot, recycled)).toEqual([])
  })
})

describe('collectDoomedGroups', () => {
  it("includes a descendant's own process group — the turbo-task topology", () => {
    const rows = [
      { pid: 10, ppid: 1, pgid: 10 }, // turbo wrapper (group leader)
      { pid: 11, ppid: 10, pgid: 10 }, // turbo itself, same group
      { pid: 20, ppid: 11, pgid: 20 }, // task (vite) — turbo gave it its OWN group
      { pid: 21, ppid: 20, pgid: 20 }, // task's child
    ]

    expect(collectDoomedGroups(10, rows).sort()).toEqual([10, 20])
  })

  it('excludes unrelated processes, init, and our own group', () => {
    const rows = [
      { pid: 10, ppid: 1, pgid: 10 },
      { pid: 20, ppid: 10, pgid: 1 }, // pgid 1 must never be signalled
      { pid: 30, ppid: 10, pgid: 99 }, // our own group
      { pid: 40, ppid: 999, pgid: 40 }, // unrelated subtree
    ]

    expect(collectDoomedGroups(10, rows, 99)).toEqual([10])
  })
})

/**
 * Is `pid` a real, running process? Deliberately NOT `process.kill(pid, 0)` — that succeeds
 * against a SIGKILLed-but-unreaped zombie, so it would report a corpse as alive.
 */
describe('isChildOf', () => {
  const rows = [
    { pid: 10, ppid: 7, pgid: 10 },
    { pid: 20, ppid: 10, pgid: 20 },
  ]

  it('accepts a live direct child', () => {
    expect(isChildOf(10, 7, rows)).toBe(true)
  })

  it('rejects a recycled pid whose parent is someone else — the TOCTOU reuse guard', () => {
    expect(isChildOf(10, 999, rows)).toBe(false)
  })

  it('rejects a grandchild and a pid that no longer exists', () => {
    expect(isChildOf(20, 7, rows)).toBe(false)
    expect(isChildOf(404, 7, rows)).toBe(false)
  })
})

const alive = (pid: number): boolean => {
  try {
    return (
      execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)])
        .toString()
        .trim().length > 0
    )
  } catch {
    return false
  }
}

describe('superviseChild', () => {
  let pidFile = ''

  afterEach(() => {
    if (pidFile && fs.existsSync(pidFile)) {
      const grandchild = Number(fs.readFileSync(pidFile, 'utf8'))

      if (Number.isInteger(grandchild)) {
        try {
          process.kill(-grandchild, 'SIGKILL')
        } catch {
          // already reaped
        }
      }
      fs.rmSync(pidFile, { force: true })
    }
  })

  it('reaps a grandchild that lives in its own process group and ignores SIGTERM', async () => {
    pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-child-')), 'grandchild.pid')

    // Mirrors `turbo run dev`: the child spawns its task DETACHED (own process group), and the
    // task straggles on SIGTERM the way a vite dev server does. A group-kill aimed only at the
    // child's group would strand it.
    //
    // The grandchild writes `readyFile` only AFTER installing the handler — waiting on the
    // parent-written pid file alone would race, letting a default-disposition SIGTERM kill it
    // and silently skip the SIGKILL escalation this test exists to cover.
    const readyFile = `${pidFile}.ready`
    const grandchild = `
      process.on('SIGTERM', () => {})
      require('node:fs').writeFileSync(${JSON.stringify(readyFile)}, 'ok')
      setInterval(() => {}, 1000)
    `
    const parent = `
      const { spawn } = require('node:child_process')
      const fs = require('node:fs')
      const t = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { detached: true, stdio: 'ignore' })
      t.unref()
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(t.pid))
      setInterval(() => {}, 1000)
    `

    const child = spawn(process.execPath, ['-e', parent], { detached: true, stdio: 'ignore' })
    const managed = superviseChild(child, 500)

    const deadline = Date.now() + 10_000

    while (Date.now() < deadline && !fs.existsSync(readyFile)) {
      await new Promise((r) => {
        setTimeout(r, 50)
      })
    }

    expect(fs.existsSync(readyFile)).toBe(true)

    const grandchildPid = Number(fs.readFileSync(pidFile, 'utf8'))

    expect(alive(grandchildPid)).toBe(true)

    await managed.kill()

    expect(alive(child.pid as number)).toBe(false)
    expect(alive(grandchildPid)).toBe(false)
  }, 30_000)
})

/**
 * The crash path, end to end, with real processes.
 *
 * This is the case a `ppid` walk cannot serve: an engine that dies on its own has ALREADY reparented its
 * tasks to init by the time Node delivers `exit`, so the walk finds only the corpse's own group. Both
 * tests below fail without the rolling snapshot — the grandchild survives, holding its port, forever.
 */
describe('superviseChild — a CRASHED engine must not strand its task groups', () => {
  let grandchildPid = 0

  afterEach(() => {
    if (grandchildPid > 0) {
      try {
        process.kill(-grandchildPid, 'SIGKILL')
      } catch {
        // already reaped — which is what these tests assert
      }
      grandchildPid = 0
    }
  })

  /** Spawn the turbo topology: a detached engine whose task sits in a process group of its OWN. */
  const spawnEngineWithTask = async (): Promise<{ child: ReturnType<typeof spawn>; taskPid: number }> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-child-crash-'))
    const taskPidFile = path.join(dir, 'task.pid')

    const engineSrc = `
      const { spawn } = require('node:child_process')
      const fs = require('node:fs')
      const task = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
      task.unref()
      fs.writeFileSync(${JSON.stringify(taskPidFile)}, String(task.pid))
      setInterval(() => {}, 1000)
    `
    const child = spawn(process.execPath, ['-e', engineSrc], { detached: true, stdio: 'ignore' })
    const deadline = Date.now() + 10_000

    while (Date.now() < deadline && !fs.existsSync(taskPidFile)) {
      await new Promise((r) => {
        setTimeout(r, 25)
      })
    }

    const taskPid = Number(fs.readFileSync(taskPidFile, 'utf8'))

    expect(alive(taskPid)).toBe(true)

    return { child, taskPid }
  }

  /** Let the rolling sampler observe the task at least once — it is the only record that survives the crash. */
  const letSamplerObserve = async (): Promise<void> => {
    await new Promise((r) => {
      setTimeout(r, 1400)
    })
  }

  it('reaps the orphaned task group when the engine is SIGKILLed (a crash / OOM kill)', async () => {
    const { child, taskPid } = await spawnEngineWithTask()

    grandchildPid = taskPid
    superviseChild(child, 500)
    await letSamplerObserve()

    // Crash the engine. It reaps nothing — exactly what a turbo OOM kill does to its vite tasks.
    process.kill(child.pid as number, 'SIGKILL')

    const deadline = Date.now() + 10_000

    while (Date.now() < deadline && alive(taskPid)) {
      await new Promise((r) => {
        setTimeout(r, 50)
      })
    }

    expect(alive(taskPid)).toBe(false)
    grandchildPid = 0
  }, 30_000)

  it('reaps the task group on a later kill() too — the Ctrl-C after a crash must still clean up', async () => {
    const { child, taskPid } = await spawnEngineWithTask()

    grandchildPid = taskPid

    // No sampler-driven reap: supervise, observe, then crash while suppressing the automatic path by
    // racing kill() in right after. The point is that kill() on an ALREADY-EXITED child still clears the
    // stranded group instead of bailing (which is what the old `exitCode !== null` early-return did).
    const managed = superviseChild(child, 500)

    await letSamplerObserve()
    process.kill(child.pid as number, 'SIGKILL')
    await new Promise((r) => {
      setTimeout(r, 300)
    })

    await managed.kill()

    expect(alive(taskPid)).toBe(false)
    grandchildPid = 0
  }, 30_000)
})

describe('superviseChild onUnexpectedExit', () => {
  const settle = async (ms: number): Promise<void> => {
    await new Promise((r) => {
      setTimeout(r, ms)
    })
  }

  it('fires when the child dies on its own', async () => {
    const calls: string[] = []
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(3), 50)'], {
      detached: true,
      stdio: 'ignore',
    })

    superviseChild(child, 500, (detail) => {
      calls.push(detail)
    })

    const deadline = Date.now() + 5000

    while (Date.now() < deadline && calls.length === 0) {
      await settle(25)
    }

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatch(/exited unexpectedly/)
  }, 10_000)

  it('does NOT fire when kill() drove the exit', async () => {
    const calls: string[] = []
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    })

    const managed = superviseChild(child, 500, (detail) => {
      calls.push(detail)
    })

    await managed.kill()
    // The child's `exit` fires during the reap; give it a tick to prove the `killing` latch suppressed it.
    await settle(150)

    expect(calls).toEqual([])
  }, 10_000)
})
