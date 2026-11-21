import * as fs from 'node:fs'
import os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DevServerRunner } from 'src/dev/dev-server'
import type { DevUi } from 'src/dev/dev-ui'
import type { ProbeOutcome } from 'src/dev/health-probe'
import { createDevLogSink, resolveLogDir } from 'src/dev/log-sink'
import type { DevLogSink } from 'src/dev/log-sink'
import type { DevRenderer } from 'src/dev/render'
import type { DevServerOptions } from 'src/dev/runner-types'
import { defaultTurboWatchFactory } from 'src/dev/turbo-watch'
import type { TurboWatchFactory } from 'src/dev/turbo-watch'
import { pumpLines } from 'src/dev/ui-dev'
import type { UiDevFactory } from 'src/dev/ui-dev'

import {
  createTempTracker,
  getFreePort,
  makeMonorepo,
  restoreCwd,
  restoreEnv,
  snapshotCwd,
  snapshotEnv,
  workingProxy,
} from './fixtures'

/**
 * Every dev log file has one line shape (AC-14/15). Each stream is driven through the seam production
 * uses — the real renderer tee, the real output intercept, the real `pumpLines`, the real watch factory —
 * into a sink built by `createDevLogSink()`, so a stream that bypasses the formatter fails here.
 */

// The watch engine's `pnpm exec turbo watch build` is swapped for a real node child that prints a
// chunked `tsc` error, so `defaultTurboWatchFactory` pumps genuine pipes. Every other spawn is real.
const { spawnMock } = vi.hoisted(() => {
  return { spawnMock: vi.fn() }
})

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()

  spawnMock.mockImplementation((command: string, args: string[], options: object) => {
    if (command === 'pnpm' && args[2] === 'watch') {
      return actual.spawn(process.execPath, ['-e', WATCH_CHILD], options)
    }

    return actual.spawn(command, args, options)
  })

  return { ...actual, spawn: spawnMock }
})

/** One `tsc` error split mid-token across two writes, then a second line; stays alive until reaped. */
const WATCH_CHILD = [
  "process.stdout.write('shop-api:build: src/a.ts(1,1): error TS23')",
  "setTimeout(() => process.stdout.write('04: Cannot find name\\nshop-api:build:   more detail\\n'), 50)",
  'setInterval(() => {}, 1000)',
].join('\n')

const LINE_SHAPE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z (?:DEBUG|INFO |WARN |ERROR) \S+ .*$/

const temp = createTempTracker()
let envSnapshot: NodeJS.ProcessEnv
let cwdSnapshot: string

beforeEach(() => {
  envSnapshot = snapshotEnv()
  cwdSnapshot = snapshotCwd()
})

afterEach(() => {
  restoreCwd(cwdSnapshot)
  restoreEnv(envSnapshot)
  temp.cleanup()
})

const noopChild = (): { kill: () => Promise<void> } => {
  return {
    kill: (): Promise<void> => {
      return Promise.resolve()
    },
  }
}

const waitFor = async (predicate: () => boolean, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs

  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the log')
    await new Promise((resolve) => {
      setTimeout(resolve, 20)
    })
  }
}

interface Harness {
  runner: DevServerRunner
  sink: DevLogSink
  root: string
  port: number
  /** A service's file as lines; every one of them must already match the shape. */
  linesOf: (service: string) => string[]
  read: (service: string) => string
}

/** Start one runner on a `shop` app (api + ui) owning a fake terminal, logging into a fresh run dir. */
const startRunner = async (
  over: {
    options?: DevServerOptions
    uiDevFactory?: UiDevFactory
    turboWatchFactory?: TurboWatchFactory
    maxBytes?: number
    handler?: string
  } = {},
): Promise<Harness> => {
  const root = temp.register(
    makeMonorepo([{ name: 'shop', packageName: 'shop-api', withHandler: true, ui: { packageName: 'shop-ui' } }]),
  )

  if (over.handler != null) fs.writeFileSync(path.join(root, 'apps', 'shop', 'api', 'dist', 'handler.js'), over.handler)

  // Nested: the sink GCs sibling log dirs and plants a `latest` link in its parent.
  const dir = path.join(temp.register(fs.mkdtempSync(path.join(os.tmpdir(), 'ik-log-streams-'))), 'logs')
  const sink = createDevLogSink({ dir, maxBytes: over.maxBytes })
  const port = await getFreePort()

  process.env.SHOP_PORT = String(port)
  process.chdir(root)

  const runner = new DevServerRunner(
    { tty: true, uiHealth: false, livenessIntervalMs: 60_000, ...over.options },
    async () => {},
    over.turboWatchFactory ?? noopChild,
    over.uiDevFactory ?? noopChild,
    (pkg) => {
      return Promise.resolve([pkg])
    },
    undefined,
    (): Promise<ProbeOutcome> => {
      return Promise.resolve('ok')
    },
    workingProxy(),
    sink,
  )

  await runner.start()

  const read = (service: string): string => {
    return fs.readFileSync(sink.pathFor(service), 'utf-8')
  }

  const linesOf = (service: string): string[] => {
    const text = read(service)

    expect(text.endsWith('\n')).toBe(true)

    const lines = text.slice(0, -1).split('\n')

    expect(
      lines.filter((line) => {
        return !LINE_SHAPE.test(line)
      }),
    ).toEqual([])

    return lines
  }

  return { runner, sink, root, port, linesOf, read }
}

const ending = (lines: string[], suffix: string): string[] => {
  return lines.filter((line) => {
    return line.endsWith(suffix)
  })
}

describe('dev log streams — one line shape in every file', () => {
  it('a runner given no sink builds the formatting one, not a bare verbatim `DevLogSink`', () => {
    process.env.XDG_CACHE_HOME = temp.register(fs.mkdtempSync(path.join(os.tmpdir(), 'ik-log-cache-')))
    process.env.INFRA_KIT_SESSION = 'logstreams'

    // No terminal: the constructor installs no intercept, so nothing outlives the test but the sink.
    const runner = new DevServerRunner({ tty: false }, async () => {}, noopChild, noopChild, undefined, undefined)
    const { renderer, sink } = runner as unknown as { renderer: DevRenderer; sink: DevLogSink }

    try {
      renderer.teeOnly('default sink', 'warn')

      expect(sink.dir).toBe(resolveLogDir())
      expect(fs.readFileSync(sink.pathFor('runner'), 'utf-8')).toMatch(
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z WARN {2}runner default sink\n$/,
      )
    } finally {
      sink.close()
    }
  })

  it('runner: the default renderer’s tee, and its terminal frames filed by the real intercept', async () => {
    const h = await startRunner()

    try {
      const renderer = (h.runner as unknown as { renderer: DevUi }).renderer

      renderer.log('careful now', 'warn')
      renderer.log('it broke', 'error')
      renderer.log('first line\nsecond line', 'info')

      const lines = h.linesOf('runner')

      expect(ending(lines, ' WARN  runner careful now').length).toBeGreaterThanOrEqual(1)
      expect(ending(lines, ' ERROR runner it broke').length).toBeGreaterThanOrEqual(1)
      expect(ending(lines, ' INFO  runner first line').length).toBeGreaterThanOrEqual(1)
      expect(ending(lines, ' INFO  runner second line').length).toBeGreaterThanOrEqual(1)
      // The tee never counts: the runner's own lines are not an app's errors.
      expect(h.sink.statsFor('runner').errors).toBe(0)
    } finally {
      await h.runner.shutdown()
    }
  }, 20000)

  it('<app>/api: console lines through the real intercept in the app’s context, and the request log', async () => {
    const handler = [
      'export const ping = async () => {',
      "  console.log(JSON.stringify({ level: 'INFO', message: 'dev-logger line', service: 'svc', timestamp: new Date().toISOString(), requestId: 'r-1' }))",
      "  console.error(new Error('boom'))",
      "  console.log('\\u001b[32mgreen text\\u001b[0m')",
      "  return { statusCode: 503, body: 'down' }",
      '}',
      '',
    ].join('\n')

    const h = await startRunner({ handler })

    try {
      const response = await fetch(`http://127.0.0.1:${h.port}/api/v1/ping`)

      expect(response.status).toBe(503)
      await waitFor(() => {
        return h.read('shop/api').includes('GET /api/v1/ping 503')
      })

      const lines = h.linesOf('shop/api')

      expect(ending(lines, ' INFO  shop/api dev-logger line {"service":"svc","requestId":"r-1"}')).toHaveLength(1)
      expect(ending(lines, ' ERROR shop/api Error: boom')).toHaveLength(1)
      expect(
        lines.filter((line) => {
          return / ERROR shop\/api {5}at /.test(line)
        }).length,
      ).toBeGreaterThan(0)
      expect(ending(lines, ' INFO  shop/api green text')).toHaveLength(1)
      expect(
        lines.filter((line) => {
          return / ERROR shop\/api GET \/api\/v1\/ping 503 \d+ms$/.test(line)
        }),
      ).toHaveLength(1)
    } finally {
      await h.runner.shutdown()
    }
  }, 20000)

  it('<app>/ui and turbo: the real pumpLines over split, ANSI, CR-progress, stack and chrome input', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()

    const h = await startRunner({
      uiDevFactory: (opts) => {
        pumpLines(stdout, opts)
        pumpLines(stderr, opts)

        return noopChild()
      },
    })

    try {
      stdout.write('shop-ui:dev: VITE re')
      stdout.write('ady in 90 ms\nshop-ui:dev: \u001B[32mgre')
      stdout.write('en\u001B[0m\nshop-ui:dev: 10%\r50%\r100%\n')
      stdout.write('shop-ui:dev: Error: boom\nshop-ui:dev:     at x (/a.js:1:1)\n')
      stderr.write('• Packages in scope: shop-ui\n')
      await waitFor(() => {
        return fs.existsSync(h.sink.pathFor('turbo')) && h.read('turbo').includes('Packages in scope')
      })

      const turbo = h.linesOf('turbo')
      const ui = h.linesOf('shop/ui')

      expect(
        turbo.map((line) => {
          return line.slice(25)
        }),
      ).toEqual([
        'INFO  turbo shop-ui:dev: VITE ready in 90 ms',
        'INFO  turbo shop-ui:dev: green',
        // A bare-CR line keeps its task prefix in front of the last redraw.
        'INFO  turbo shop-ui:dev: 100%',
        'ERROR turbo shop-ui:dev: Error: boom',
        'INFO  turbo shop-ui:dev:     at x (/a.js:1:1)',
        'INFO  turbo • Packages in scope: shop-ui',
      ])
      expect(
        ui.map((line) => {
          return line.slice(25)
        }),
      ).toEqual([
        'INFO  shop/ui VITE ready in 90 ms',
        'INFO  shop/ui green',
        'INFO  shop/ui 100%',
        'ERROR shop/ui Error: boom',
        'INFO  shop/ui     at x (/a.js:1:1)',
      ])
    } finally {
      await h.runner.shutdown()
    }
  }, 20000)

  it('watch: the real watch factory over a real child’s chunked `tsc` error', async () => {
    const h = await startRunner({ options: { watch: true }, turboWatchFactory: defaultTurboWatchFactory })

    try {
      await waitFor(() => {
        return fs.existsSync(h.sink.pathFor('watch')) && h.read('watch').includes('more detail')
      })

      expect(
        h.linesOf('watch').map((line) => {
          return line.slice(25)
        }),
      ).toEqual([
        'INFO  watch shop-api:build: src/a.ts(1,1): error TS2304: Cannot find name',
        'INFO  watch shop-api:build:   more detail',
      ])
    } finally {
      await h.runner.shutdown()
    }
  }, 20000)

  it('capped: the over-cap notice is one WARN line of the same shape', async () => {
    const h = await startRunner({ maxBytes: 64 })

    try {
      const renderer = (h.runner as unknown as { renderer: DevUi }).renderer

      renderer.log('a line far longer than the sixty-four byte budget of this sink', 'info')

      const lines = h.linesOf('runner')

      const capped = lines.filter((line) => {
        return line.includes('[capped]')
      })

      expect(capped).toHaveLength(1)
      expect(capped[0]).toMatch(/ WARN {2}runner \[capped\] runner\.log hit 64 bytes/)
      expect(lines.at(-1)).toBe(capped[0])
    } finally {
      await h.runner.shutdown()
    }
  }, 20000)
})
