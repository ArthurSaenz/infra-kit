import process from 'node:process'
import { describe, expect, it, vi } from 'vitest'

import type { AutoSetupRecord } from 'src/lib/auto-setup/record'
import { AUTO_SETUP_COOLDOWN_MS } from 'src/lib/auto-setup/record'

import { AUTO_SETUP_BUDGET_MS, autoSetup, failureReason, runInProcessGroup, verdictFromPayload } from '../auto-setup'
import type { AutoSetupDeps, RunSetupChildInput, RunSetupChildResult } from '../auto-setup'

const HOME = '/Users/me'

const NOW = 1_770_000_000_000

/** Started long enough ago that the cooldown is not what the test exercises. */
const OLD_START = NOW - 2 * AUTO_SETUP_COOLDOWN_MS

type Payload = Parameters<typeof verdictFromPayload>[0]

const payload = (overrides: Partial<Payload> = {}): Payload => {
  return {
    init: [{ step: 'zshrc', outcome: 'unchanged', message: 'ok' }],
    tools: [{ id: 'gh', action: 'skipped', before: { present: true }, detail: 'would update' }],
    portlessService: { link: 'unchanged', node: 'unchanged', command: null },
    ...overrides,
  }
}

const ok = async (body: Payload = payload()): Promise<RunSetupChildResult> => {
  return { status: 0, stdout: JSON.stringify(body), stderr: '', error: null }
}

const harness = (overrides: Partial<AutoSetupDeps> = {}) => {
  const records: AutoSetupRecord[] = []
  const logs: string[] = []
  const calls: RunSetupChildInput[] = []
  let released = 0

  const deps: AutoSetupDeps = {
    version: '0.19.0',
    home: HOME,
    clock: () => {
      return NOW
    },
    acquireLock: () => {
      return () => {
        released += 1
      }
    },
    readRecord: () => {
      return null
    },
    writeRecord: (record) => {
      records.push(record)
    },
    discoverProjects: () => {
      return ['/p/api', '/p/web']
    },
    runSetupChild: (input) => {
      calls.push(input)

      return ok()
    },
    writeLog: (text) => {
      logs.push(text)
    },
    ...overrides,
  }

  return {
    deps,
    /** The final record of the pass — the provisional one written before the first child is records[0]. */
    final: (): AutoSetupRecord | undefined => {
      return records.at(-1)
    },
    records,
    logs,
    calls,
    released: () => {
      return released
    },
  }
}

describe('autoSetup', () => {
  it('runs the machine from $HOME first, then every project from its root, and records each', async () => {
    const { deps, final, calls, released } = harness()

    await expect(autoSetup(deps)).resolves.toBe('ran')

    expect(
      calls.map((call) => {
        return call.cwd
      }),
    ).toEqual([HOME, '/p/api', '/p/web'])
    expect(final()).toMatchObject({
      version: '0.19.0',
      attempts: 1,
      startedMs: NOW,
      finishedMs: NOW,
      runs: [
        { root: null, status: 'ok' },
        { root: '/p/api', status: 'ok' },
        { root: '/p/web', status: 'ok' },
      ],
    })
    expect(released()).toBe(1)
  })

  // Reds on: a pass that only records at the end — a kill mid-pass would leave no attempt spent.
  it('writes a provisional record before the first child starts', async () => {
    const seenBeforeFirstChild: AutoSetupRecord[] = []

    const { deps, records } = harness({
      runSetupChild: async () => {
        seenBeforeFirstChild.push(...records)

        return ok()
      },
    })

    await autoSetup(deps)

    expect(seenBeforeFirstChild[0]).toEqual({
      version: '0.19.0',
      attempts: 1,
      startedMs: NOW,
      finishedMs: null,
      runs: [],
    })
  })

  it('starts no child when even the provisional record cannot be written', async () => {
    const runSetupChild = vi.fn(async (_input: RunSetupChildInput) => {
      return ok()
    })

    const { deps, released } = harness({
      runSetupChild,
      writeRecord: () => {
        throw new Error('ENOSPC')
      },
    })

    await expect(autoSetup(deps)).resolves.toBe('not-due')

    expect(runSetupChild).not.toHaveBeenCalled()
    expect(released()).toBe(1)
  })

  it('does nothing when the record already covers this version', async () => {
    const { deps, calls, records } = harness({
      readRecord: () => {
        return {
          version: '0.19.0',
          attempts: 1,
          startedMs: OLD_START,
          finishedMs: OLD_START,
          runs: [{ root: null, status: 'ok', notes: [] }],
        }
      },
    })

    await expect(autoSetup(deps)).resolves.toBe('not-due')
    expect(calls).toEqual([])
    expect(records).toEqual([])
  })

  it('does nothing inside the cooldown, even for another version', async () => {
    const { deps, calls } = harness({
      readRecord: () => {
        return { version: '0.18.1', attempts: 1, startedMs: NOW - 1_000, finishedMs: NOW - 500, runs: [] }
      },
    })

    await expect(autoSetup(deps)).resolves.toBe('not-due')
    expect(calls).toEqual([])
  })

  it('stands down when another pass holds the lock', async () => {
    const { deps, calls } = harness({
      acquireLock: () => {
        return null
      },
    })

    await expect(autoSetup(deps)).resolves.toBe('already-running')
    expect(calls).toEqual([])
  })

  it('isolates a timed-out, crashed or garbled project: the others still run, the bad one is failed with its reason and rerun', async () => {
    const { deps, final } = harness({
      discoverProjects: () => {
        return ['/p/hang', '/p/crash', '/p/garbled', '/p/fine']
      },
      runSetupChild: async ({ cwd }) => {
        if (cwd === '/p/hang') return { status: null, stdout: '', stderr: '', error: 'timed out after 180s' }
        if (cwd === '/p/crash') throw new Error('spawn EAGAIN')
        if (cwd === '/p/garbled')
          return { status: 1, stdout: '', stderr: 'INFO: x\nError: config exploded\n', error: null }

        return ok()
      },
    })

    await expect(autoSetup(deps)).resolves.toBe('ran')

    const runs = final()?.runs ?? []

    expect(
      runs.map((run) => {
        return [run.root, run.status]
      }),
    ).toEqual([
      [null, 'ok'],
      ['/p/hang', 'failed'],
      ['/p/crash', 'failed'],
      ['/p/garbled', 'failed'],
      ['/p/fine', 'ok'],
    ])
    expect(runs[1]?.notes[0]).toBe('timed out after 180s — run: cd /p/hang && infra-kit setup --skip-tools')
    expect(runs[2]?.notes[0]).toContain('spawn EAGAIN')
    expect(runs[3]?.notes[0]).toBe(
      'no setup report (exit 1): Error: config exploded — run: cd /p/garbled && infra-kit setup --skip-tools',
    )
  })

  it('counts attempts per version and resets them on a new one', async () => {
    const failedRuns = [{ root: '/p/api', status: 'failed' as const, notes: ['x'] }]

    const same = harness({
      readRecord: () => {
        return { version: '0.19.0', attempts: 1, startedMs: OLD_START, finishedMs: OLD_START, runs: failedRuns }
      },
    })

    const next = harness({
      readRecord: () => {
        return { version: '0.18.1', attempts: 3, startedMs: OLD_START, finishedMs: OLD_START, runs: failedRuns }
      },
    })

    await autoSetup(same.deps)
    await autoSetup(next.deps)

    expect(same.final()?.attempts).toBe(2)
    expect(next.final()?.attempts).toBe(1)
  })

  it('records the projects past the time budget as failed without starting them', async () => {
    let now = NOW

    const runSetupChild = vi.fn(async () => {
      now += AUTO_SETUP_BUDGET_MS

      return ok()
    })

    const { deps, final } = harness({
      clock: () => {
        return now
      },
      runSetupChild,
    })

    await autoSetup(deps)

    expect(runSetupChild).toHaveBeenCalledTimes(1)
    expect(final()?.runs.slice(1)).toEqual([
      {
        root: '/p/api',
        status: 'failed',
        notes: ['out of time budget — run: cd /p/api && infra-kit setup --skip-tools'],
      },
      {
        root: '/p/web',
        status: 'failed',
        notes: ['out of time budget — run: cd /p/web && infra-kit setup --skip-tools'],
      },
    ])
  })

  it('drops machine-level notes from project runs, but never empties a failed run', async () => {
    const chrome = { step: 'chrome', outcome: 'manual', message: 'run /chrome' }
    const zshrc = { step: 'zshrc', outcome: 'failed', message: 'EACCES ~/.zshrc' }

    const { deps, final } = harness({
      discoverProjects: () => {
        return ['/p/api', '/p/web']
      },
      runSetupChild: async ({ cwd }) => {
        return ok(payload({ init: cwd === '/p/web' ? [zshrc] : [chrome] }))
      },
    })

    await autoSetup(deps)

    expect(final()?.runs).toEqual([
      { root: null, status: 'attention', notes: ['run /chrome'] },
      { root: '/p/api', status: 'ok', notes: [] },
      { root: '/p/web', status: 'failed', notes: ['EACCES ~/.zshrc'] },
    ])
  })

  it('fails the machine run (so the pass is retried) when the project list cannot be read', async () => {
    const { deps, final } = harness({
      discoverProjects: () => {
        throw new Error('installed_plugins.json unreadable')
      },
      writeLog: () => {
        throw new Error('EACCES')
      },
    })

    await expect(autoSetup(deps)).resolves.toBe('ran')
    expect(final()?.runs).toEqual([
      { root: null, status: 'failed', notes: ['could not list projects: installed_plugins.json unreadable'] },
    ])
  })

  it('passes each child a timeout no longer than the budget left', async () => {
    const runSetupChild = vi.fn(async (_input: RunSetupChildInput) => {
      return ok()
    })

    const { deps } = harness({ runSetupChild })

    await autoSetup(deps)

    expect(runSetupChild).toHaveBeenCalledTimes(3)

    for (const [input] of runSetupChild.mock.calls) {
      expect(input.timeoutMs).toBeGreaterThan(0)
      expect(input.timeoutMs).toBeLessThanOrEqual(AUTO_SETUP_BUDGET_MS)
    }
  })
})

describe('failureReason', () => {
  it('prefers the spawn error, then a --json error document, then the last stderr line', () => {
    expect(failureReason({ status: null, stdout: '', stderr: 'x', error: 'spawn ENOENT' })).toBe('spawn ENOENT')
    expect(failureReason({ status: 1, stdout: '{"error":"boom"}', stderr: 'x', error: null })).toBe('boom')
    expect(failureReason({ status: 1, stdout: '', stderr: '\u001B[31mError: bad\u001B[39m\n\n', error: null })).toBe(
      'no setup report (exit 1): Error: bad',
    )
    expect(failureReason({ status: 1, stdout: '', stderr: '', error: null })).toBe('no setup report (exit 1)')
  })
})

describe('runInProcessGroup (real processes)', () => {
  const node = process.execPath

  it('returns the output and exit code of a child that finishes', async () => {
    const result = await runInProcessGroup({
      command: node,
      args: ['-e', 'process.stdout.write(JSON.stringify({ ok: 1 })); process.exitCode = 3'],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      timeoutMs: 10_000,
    })

    expect(result).toEqual({ status: 3, stdout: '{"ok":1}', stderr: '', error: null })
  })

  // Reds on: killing only the child — the grandchild keeps the pipe open and the run never settles.
  it('kills the whole group on timeout and settles even while a grandchild held the pipe', async () => {
    const script = [
      "const { spawn } = require('node:child_process')",
      "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' })",
      'setTimeout(() => {}, 60000)',
    ].join(';')

    const startedMs = Date.now()

    const result = await runInProcessGroup({
      command: node,
      args: ['-e', script],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      timeoutMs: 500,
    })

    expect(result.error).toBe('timed out after 1s')
    expect(Date.now() - startedMs).toBeLessThan(5_000)
  })

  it('reports a command that cannot start', async () => {
    const result = await runInProcessGroup({
      command: '/nonexistent/infra-kit-binary',
      args: [],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 5_000,
    })

    expect(result.error).toContain('ENOENT')
  })
})

describe('verdictFromPayload', () => {
  it('is ok for a clean run, a present tool with a pending update included', () => {
    expect(verdictFromPayload(payload(), 0)).toEqual({ status: 'ok', notes: [] })
  })

  it('is attention for a manual or warned step, a missing tool, or a sudo command', () => {
    const verdict = verdictFromPayload(
      payload({
        init: [
          { step: 'plugin-pointer', outcome: 'manual', message: '.claude/settings.json needs …' },
          { step: 'shell', outcome: 'warned', message: 'not zsh' },
        ],
        tools: [{ id: 'doppler', action: 'skipped', before: { present: false }, detail: 'would install' }],
        portlessService: { link: 'unchanged', node: 'unchanged', command: 'sudo portless service install' },
      }),
      0,
    )

    expect(verdict).toEqual({
      status: 'attention',
      notes: [
        '.claude/settings.json needs …',
        'not zsh',
        'doppler is not installed — run: infra-kit setup --tools doppler',
        'sudo portless service install',
      ],
    })
  })

  it('is failed for a failed step, tool or portless part, and for a non-zero exit with no failed row', () => {
    expect(
      verdictFromPayload(payload({ init: [{ step: 'zshrc', outcome: 'failed', message: 'EACCES' }] }), 1).status,
    ).toBe('failed')
    expect(
      verdictFromPayload(payload({ portlessService: { link: 'failed', node: 'unchanged', command: null } }), 0).status,
    ).toBe('failed')
    expect(verdictFromPayload(payload(), 2)).toEqual({ status: 'failed', notes: ['setup exited 2'] })
  })
})
