import { execFileSync, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'

import { collectDoomedGroups, isChildOf, parseProcRows, superviseChild } from '../managed-child.js'

describe('parseProcRows', () => {
  it('parses pid/ppid/pgid triples and skips malformed lines', () => {
    const raw = ['  101   1   101', '  202 101   202', 'header junk', '', '  303 202 303 extra'].join('\n')

    expect(parseProcRows(raw)).toEqual([
      { pid: 101, ppid: 1, pgid: 101 },
      { pid: 202, ppid: 101, pgid: 202 },
      { pid: 303, ppid: 202, pgid: 303 },
    ])
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
