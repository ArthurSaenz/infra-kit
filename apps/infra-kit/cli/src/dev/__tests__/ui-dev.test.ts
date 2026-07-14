import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

/**
 * Guards the `turbo run dev` child's spawn contract and the line filter that feeds the renderer's tail.
 *
 * Two assertions are load-bearing. `stdio: pipe` is what keeps `infra-kit dev` the sole owner of the
 * terminal — a regression to `inherit` lets turbo's chrome interleave with the pinned scroll-region
 * footer, which no other unit test can see. `--only` is what stops turbo re-walking `^build` and
 * printing one cache-hit line per dependency.
 */
const spawnMock = vi.hoisted(() => {
  return vi.fn()
})

vi.mock('node:child_process', () => {
  return { spawn: spawnMock }
})

vi.mock('../managed-child.js', () => {
  return {
    superviseChild: (child: unknown): unknown => {
      return child
    },
  }
})

const { defaultUiDevFactory, parseTurboDevLine, stripAnsi, turboLineLevel } = await import('../ui-dev.js')

/** The one recorded `spawn(cmd, args, options)` call, or a hard test failure if turbo never spawned. */
const spawnOnce = (): { args: string[]; options: { stdio: unknown[] } } => {
  spawnMock.mockClear()
  spawnMock.mockReturnValue({ on: vi.fn(), pid: 123 })
  defaultUiDevFactory({ packageNames: ['website-ui'], cwd: '/repo', concurrency: 10 })
  const call = spawnMock.mock.calls[0]

  if (call == null) throw new Error('expected defaultUiDevFactory to spawn a turbo child')

  return { args: call[1] as string[], options: call[2] as { stdio: unknown[] } }
}

/** Just the argv turbo was invoked with. */
const spawnArgs = (): string[] => {
  return spawnOnce().args
}

/**
 * Spawn the factory against fake stdout/stderr pipes and return them alongside the captured
 * `onLine` / `appendLog` sinks, so a test can push bytes through the real pump.
 */
const spawnWithPipes = (): {
  stdout: PassThrough
  stderr: PassThrough
  lines: Array<{ pkg: string; text: string }>
  raw: string[]
} => {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const lines: Array<{ pkg: string; text: string }> = []
  const raw: string[] = []

  spawnMock.mockClear()
  spawnMock.mockReturnValue({ on: vi.fn(), pid: 123, stdout, stderr })
  defaultUiDevFactory({
    packageNames: ['website-ui'],
    cwd: '/repo',
    concurrency: 10,
    appendLog: (text) => {
      raw.push(text)
    },
    onLine: (line) => {
      lines.push(line)
    },
  })

  return { stdout, stderr, lines, raw }
}

/** Resolve after the stream's `data`/`end` handlers have run. */
const flush = async (): Promise<void> => {
  await new Promise((resolve) => {
    return setImmediate(resolve)
  })
}

describe('defaultUiDevFactory — turbo child spawn contract', () => {
  it('passes --ui=stream so turbo emits line-oriented output the parser can split', () => {
    expect(spawnArgs()).toContain('--ui=stream')
  })

  it('never selects turbo’s full-screen TUI', () => {
    expect(spawnArgs()).not.toContain('--ui=tui')
  })

  it('pipes stdio so the child never writes past the renderer into the TTY', () => {
    expect(spawnOnce().options.stdio).toEqual(['ignore', 'pipe', 'pipe'])
  })

  it('runs turbo dev with an exact filter per UI package', () => {
    const args = spawnArgs()

    expect(args.slice(0, 4)).toEqual(['exec', 'turbo', 'run', 'dev'])
    expect(args).toContain('--filter=website-ui')
  })

  it('passes --only so the redundant ^build walk (pre-warmed by buildUiApps) never prints cache-hit lines', () => {
    expect(spawnArgs()).toContain('--only')
  })
})

describe('parseTurboDevLine', () => {
  it('strips the `<pkg>:dev:` prefix and returns the framework text', () => {
    expect(parseTurboDevLine('website-ui:dev: ready in 384 ms')).toEqual({
      pkg: 'website-ui',
      text: 'ready in 384 ms',
      level: 'info',
    })
  })

  it.each([
    '• Packages in scope: website-ui',
    '• Running dev in 1 packages',
    '• Remote caching disabled',
    'Tasks:    1 successful, 1 total',
    ' ELIFECYCLE  Command failed.',
  ])('drops turbo run chrome: %s', (line) => {
    expect(parseTurboDevLine(line)).toBeNull()
  })

  it.each([
    'website-ui:dev: cache bypass, force executing 6dd267347b7ef845',
    'website-ui:dev: cache hit, suppressing logs abc123',
    'website-ui:dev: $ pnpm exec vike dev',
  ])('drops per-task bookkeeping: %s', (line) => {
    expect(parseTurboDevLine(line)).toBeNull()
  })

  it('drops a prefix-only line with no framework text', () => {
    expect(parseTurboDevLine('website-ui:dev:')).toBeNull()
  })

  it('keeps vite bracket tags intact (the ANSI strip must not eat `[vite]`)', () => {
    expect(parseTurboDevLine('website-ui:dev: 1:40:14 PM [vite] connected.')?.text).toBe('1:40:14 PM [vite] connected.')
  })

  it('strips ANSI colour from both the prefix and the text', () => {
    const colored = '\u001B[35mwebsite-ui:dev:\u001B[0m \u001B[32mready\u001B[0m'

    expect(parseTurboDevLine(colored)).toEqual({ pkg: 'website-ui', text: 'ready', level: 'info' })
  })

  it('keeps framework errors — the reason output is routed rather than silenced', () => {
    const line = 'website-ui:dev: Failed to resolve import "@pkg/lib-core" from "src/App.tsx"'

    expect(parseTurboDevLine(line)?.text).toContain('Failed to resolve import')
  })
})

describe('stripAnsi', () => {
  it('leaves plain text untouched', () => {
    expect(stripAnsi('Local: http://localhost:58921/')).toBe('Local: http://localhost:58921/')
  })
})

/**
 * The tail writes `text` straight to the TTY, so any surviving control char moves the cursor and smears
 * the pinned footer — the exact corruption piping the child was meant to end. These pin that it can't.
 */
describe('parseTurboDevLine — terminal safety', () => {
  const ESC = String.fromCharCode(27)
  const BEL = String.fromCharCode(7)

  it('strips a bare CR, which would otherwise snap the cursor to column 0', () => {
    expect(parseTurboDevLine('website-ui:dev: building\rdone')?.text).toBe('buildingdone')
  })

  it('strips an OSC 8 terminal hyperlink, leaving its label', () => {
    const line = `website-ui:dev: ${ESC}]8;;http://x${BEL}link${ESC}]8;;${BEL}`

    expect(parseTurboDevLine(line)?.text).toBe('link')
  })

  it('strips CSI colour from prefix and text alike', () => {
    const line = `${ESC}[35mwebsite-ui:dev:${ESC}[0m ${ESC}[32mready${ESC}[0m`

    expect(parseTurboDevLine(line)).toEqual({ pkg: 'website-ui', text: 'ready', level: 'info' })
  })

  it('keeps TAB — it is the one C0 char that renders harmlessly', () => {
    expect(parseTurboDevLine('website-ui:dev: a\tb')?.text).toBe('a\tb')
  })
})

describe('defaultUiDevFactory — output pump', () => {
  it('routes framework lines to onLine and tees raw chunks verbatim', async () => {
    const { stdout, lines, raw } = spawnWithPipes()

    stdout.write('• Remote caching disabled\nwebsite-ui:dev: ready in 384 ms\n')
    await flush()

    expect(lines).toEqual([{ pkg: 'website-ui', text: 'ready in 384 ms', level: 'info' }])
    expect(raw.join('')).toBe('• Remote caching disabled\nwebsite-ui:dev: ready in 384 ms\n')
  })

  it('reassembles a line split across chunk boundaries', async () => {
    const { stdout, lines } = spawnWithPipes()

    stdout.write('website-ui:dev: rea')
    await flush()
    expect(lines).toEqual([])

    stdout.write('dy in 384 ms\n')
    await flush()
    expect(lines).toEqual([{ pkg: 'website-ui', text: 'ready in 384 ms', level: 'info' }])
  })

  it('flushes a trailing line that never got a newline', async () => {
    const { stdout, lines } = spawnWithPipes()

    stdout.write('website-ui:dev: Build failed')
    stdout.end()
    await flush()

    expect(lines).toEqual([{ pkg: 'website-ui', text: 'Build failed', level: 'error' }])
  })

  it('routes stderr through the same filter', async () => {
    const { stderr, lines } = spawnWithPipes()

    stderr.write('website-ui:dev: error: boom\n')
    await flush()

    expect(lines).toEqual([{ pkg: 'website-ui', text: 'error: boom', level: 'error' }])
  })

  it('records a stream error instead of throwing (an unhandled one would kill the dev session)', async () => {
    const { stdout, raw } = spawnWithPipes()

    expect(() => {
      stdout.emit('error', new Error('EIO'))
    }).not.toThrow()
    await flush()

    expect(raw.join('')).toContain('ui dev stream error: EIO')
  })

  it('flushes the carry buffer once it exceeds the cap, so CR-only progress cannot grow it forever', async () => {
    const { stdout, lines } = spawnWithPipes()

    stdout.write(`website-ui:dev: ${'x'.repeat(70_000)}`)
    await flush()

    expect(lines).toHaveLength(1)
    expect(lines[0]?.text.length).toBe(70_000)
  })

  it('drains even when no sinks are supplied (an unread pipe would block the child)', async () => {
    const stdout = new PassThrough()

    spawnMock.mockClear()
    spawnMock.mockReturnValue({ on: vi.fn(), pid: 123, stdout, stderr: new PassThrough() })
    defaultUiDevFactory({ packageNames: ['website-ui'], cwd: '/repo', concurrency: 10 })

    stdout.write('website-ui:dev: ready\n')
    await flush()

    expect(stdout.readableFlowing).toBe(true)
  })
})

/**
 * `turboLineLevel` is the ONLY place in the dev-output design that reads a line's text — and it exists
 * because of a measured fact: under `--ui=stream` turbo relays each task's stderr onto its OWN stdout.
 * A task writing one line to each fd yields both on turbo's fd 1; fd 2 carries only turbo's chrome. So
 * `child.stderr` never sees a framework line, and a severity counter built on the file descriptor would
 * be structurally, permanently zero — the panel would show a green `client/ui` row over a UI that does
 * not compile.
 *
 * The asymmetry that shapes these tests: a MISS costs an uncounted error (the line is still in the log,
 * one `tail -f` away). A FALSE POSITIVE costs a red row over a healthy app — which erodes trust in the
 * only error signal the panel has. So the over-matching cases below matter more than the matching ones.
 */
describe('turboLineLevel', () => {
  it.each([
    ['error: Failed to resolve import "./missing"', 'a bare vite resolve failure'],
    ['src/App.tsx(3,5): error TS2322: Type string is not assignable', 'a tsc --watch diagnostic'],
    ['TypeError: x is not a function', 'a thrown JS error'],
    ['Failed to resolve import "@pkg/lib" from "src/App.tsx"', 'a vite resolve failure'],
    ['✘ [ERROR] Could not resolve "react"', 'esbuild’s error glyph'],
    ['[vite] Internal server error: Transform failed', 'a vite-prefixed error'],
    ['Build failed with 1 error', 'an explicit build failure'],
    ['ENOENT: no such file or directory', 'a raw errno'],
  ])('counts %j as an error — %s', (line) => {
    expect(turboLineLevel(line)).toBe('error')
  })

  it.each([
    ['ready in 384 ms', 'the happy-path startup line'],
    ['hmr update /src/App.tsx', 'a routine HMR notice'],
    ['➜  Local:   http://localhost:5173/', 'vite’s own URL banner'],
    ['GET /api/errors 200', 'a route whose NAME contains "errors"'],
    ['loaded error-boundary.tsx', 'a filename containing "error"'],
    ['0 errors, 0 warnings', 'a clean summary that merely mentions errors'],
    [
      '    at Module._compile (node:internal/modules/cjs/loader:1234:14)',
      'a STACK FRAME — one throw must not read as 20 errors',
    ],
    [
      'Failed to load source map for /x.js',
      'a benign source-map notice: a red row over a healthy app is the costly mistake',
    ],
    ['GET https://api/x?err=error:1 200', 'a URL that merely contains "error:"'],
    ['watching for file changes...', 'idle watch chatter'],
  ])('leaves %j at info — %s', (line) => {
    expect(turboLineLevel(line)).toBe('info')
  })
})
