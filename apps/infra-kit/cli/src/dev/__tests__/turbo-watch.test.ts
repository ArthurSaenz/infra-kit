import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { buildTurboWatchFilters, defaultTurboWatchFactory } from '../turbo-watch'

// Pass-through by default: the descriptor test below needs a real child to reap; only the argv
// snapshot swaps in a fake, one call at a time.
const { spawnMock, superviseChildMock } = vi.hoisted(() => {
  return { spawnMock: vi.fn(), superviseChildMock: vi.fn() }
})

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()

  spawnMock.mockImplementation(actual.spawn)

  return { ...actual, spawn: spawnMock }
})

vi.mock('../managed-child.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../managed-child.js')>()

  superviseChildMock.mockImplementation(actual.superviseChild)

  return { ...actual, superviseChild: superviseChildMock }
})

describe('buildTurboWatchFilters', () => {
  it('aPI-only: reproduces the historical dep-inclusive `--filter=...<pkg>` vector (byte-identical)', () => {
    expect(buildTurboWatchFilters(['omega-api', 'client-api'], [])).toEqual([
      '--filter=...omega-api',
      '--filter=...client-api',
    ])
  })

  it('uI-only: emits dep-closure-only `<pkg>^...` (never the UI package itself)', () => {
    expect(buildTurboWatchFilters([], ['website-ui', 'backoffice-ui'])).toEqual([
      '--filter=website-ui^...',
      '--filter=backoffice-ui^...',
    ])
  })

  it('mixed: dep-inclusive API filters first, then dep-closure UI filters, order-stable', () => {
    expect(buildTurboWatchFilters(['omega-api'], ['website-ui'])).toEqual([
      '--filter=...omega-api',
      '--filter=website-ui^...',
    ])
  })

  it('empty on both sides → no filters (turbo would watch nothing)', () => {
    expect(buildTurboWatchFilters([], [])).toEqual([])
  })
})

describe('defaultTurboWatchFactory — spawn argv', () => {
  it('spawns the exact detached `turbo watch build` command line, log fd on stdout+stderr', () => {
    const fakeChild = { on: vi.fn(), pid: 123 }

    spawnMock.mockClear()
    spawnMock.mockReturnValueOnce(fakeChild)
    superviseChildMock.mockImplementationOnce((child: unknown) => {
      return child
    })

    let logFd = -1

    defaultTurboWatchFactory({
      depInclusive: ['omega-api'],
      depClosure: ['website-ui'],
      cwd: '/repo',
      logFile: os.devNull,
      openLog: (target) => {
        logFd = fs.openSync(target, 'a')

        return logFd
      },
    })

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock.mock.calls[0]).toEqual([
      'pnpm',
      [
        'exec',
        'turbo',
        'watch',
        'build',
        '--filter=...omega-api',
        '--filter=website-ui^...',
        '--continue=dependencies-successful',
        '--env-mode=loose',
        '--log-order=stream',
      ],
      { cwd: '/repo', detached: true, stdio: ['ignore', logFd, logFd] },
    ])
  })
})

describe('defaultTurboWatchFactory — the watch-log descriptor', () => {
  it('closes the parent copy once `spawn` has handed the child its own', async () => {
    /**
     * `spawn` duplicates the descriptor into the child, so the parent's copy is never written to
     * again — but nothing closed it, and `ManagedChild` exposes no cleanup hook to close it later.
     * It stayed open for the whole session, pinning the log file's inode even after an unlink. This
     * was the only `openSync`/`closeSync` imbalance in `dev/`.
     */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-turbo-watch-'))
    const logFile = path.join(dir, 'watch.log')
    let opened = -1

    const handle = defaultTurboWatchFactory({
      depInclusive: [],
      depClosure: [],
      cwd: dir,
      logFile,
      // Hold the very descriptor the factory is about to close, so the assertion is about THIS fd
      // rather than about whichever number the OS hands out next.
      openLog: (target) => {
        opened = fs.openSync(target, 'a')

        return opened
      },
    })

    try {
      expect(opened).toBeGreaterThan(-1)
      // Closed by the factory: the parent's handle is gone the moment the child owns its own.
      expect(() => {
        return fs.fstatSync(opened)
      }).toThrow(/EBADF/)
    } finally {
      await handle.kill()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 20000)
})
