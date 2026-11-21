import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { buildTurboWatchFilters, defaultTurboWatchFactory } from '../turbo-watch'

// Pass-through by default; each test swaps in a fake child, one call at a time.
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
  it('spawns the exact detached `turbo watch build` command line, piped stdout+stderr', () => {
    const fakeChild = { on: vi.fn(), pid: 123, stdout: new PassThrough(), stderr: new PassThrough() }

    spawnMock.mockClear()
    spawnMock.mockReturnValueOnce(fakeChild)
    superviseChildMock.mockImplementationOnce((child: unknown) => {
      return child
    })

    defaultTurboWatchFactory({
      depInclusive: ['omega-api'],
      depClosure: ['website-ui'],
      cwd: '/repo',
      appendLog: () => {},
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
      { cwd: '/repo', detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    ])
  })
})

describe('defaultTurboWatchFactory — output through the caller', () => {
  // Regression: the child wrote to the log's descriptor directly, so its output was the one stream the
  // sink's byte cap never saw.
  it('pipes both streams to `appendLog` instead of handing the child a file', () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const chunks: string[] = []

    spawnMock.mockClear()
    spawnMock.mockReturnValueOnce({ stdout, stderr })
    superviseChildMock.mockImplementationOnce((child: unknown) => {
      return child
    })

    defaultTurboWatchFactory({
      depInclusive: ['omega-api'],
      depClosure: [],
      cwd: '/repo',
      appendLog: (text) => {
        chunks.push(text)
      },
    })

    stdout.write('built omega-api\n')
    stderr.write('TS2304: nope\n')
    // One line arriving in two reads must reach the log as ONE line.
    stdout.write('src/a.ts(1,1): error TS23')
    stdout.write('04: Cannot find name\nnext')
    stdout.end()

    expect(spawnMock.mock.calls[0]?.[2]).toEqual({ cwd: '/repo', detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    expect(chunks).toEqual(['built omega-api\n', 'TS2304: nope\n', 'src/a.ts(1,1): error TS2304: Cannot find name\n'])
  })
})
