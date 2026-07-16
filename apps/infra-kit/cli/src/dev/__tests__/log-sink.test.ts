import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { getCacheRoot } from 'src/lib/constants'

import {
  DevLogSink,
  hasForeignStdoutPatch,
  logFileName,
  rawStderrWrite,
  rawStdoutWrite,
  resolveLogDir,
  resolveMaxLogBytes,
} from '../log-sink.js'
import { installTerminalLiveness } from '../terminal-liveness.js'

const tmpDir = (): string => {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'log-sink-'))
}

const sinks: DevLogSink[] = []

const makeSink = (): DevLogSink => {
  const sink = new DevLogSink(path.join(tmpDir(), 'run'))

  sinks.push(sink)

  return sink
}

afterEach(() => {
  for (const sink of sinks.splice(0)) {
    sink.close()
  }
  vi.restoreAllMocks()
})

describe('logFileName', () => {
  it('flattens a service tag into a single safe filename', () => {
    expect(logFileName('client/api')).toBe('client-api.log')
    expect(logFileName('runner')).toBe('runner.log')
  })

  it('cannot escape the log dir via path traversal', () => {
    expect(logFileName('../../etc/passwd')).not.toContain('/')
    expect(logFileName('../../etc/passwd')).not.toContain('..')
  })
})

describe('resolveLogDir', () => {
  it('scopes the dir by pid, so concurrent cmux panes sharing one session id cannot collide', () => {
    // The whole reason the <pid> segment exists: `--cmux` spawns one `infra-kit dev` per pane and
    // every pane INHERITS the same INFRA_KIT_SESSION.
    expect(resolveLogDir().split(path.sep).at(-1)).toBe(String(process.pid))
    expect(resolveLogDir().split(path.sep).at(-2)).toBe('dev')
  })
})

describe('devLogSink', () => {
  it('routes each service to its own file', () => {
    const sink = makeSink()

    sink.write('client/api', 'api line')
    sink.write('client/ui', 'ui line')

    expect(fs.readFileSync(sink.pathFor('client/api'), 'utf-8')).toBe('api line\n')
    expect(fs.readFileSync(sink.pathFor('client/ui'), 'utf-8')).toBe('ui line\n')
  })

  it('appends without a buffer, so a line is durable the instant write() returns', () => {
    // This is the property a WriteStream does NOT have: its pending buffer is lost at process.exit(),
    // dropping the tail of the log — exactly the lines a crash is read for. No flush, no close, no await.
    const sink = makeSink()

    sink.write('runner', 'durable')

    expect(fs.readFileSync(sink.pathFor('runner'), 'utf-8')).toBe('durable\n')
  })

  it('keeps one fd per service across many writes rather than reopening', () => {
    const sink = makeSink()
    const open = vi.spyOn(fs, 'openSync')

    sink.write('runner', 'a')
    sink.write('runner', 'b')
    sink.write('runner', 'c')

    expect(open).toHaveBeenCalledTimes(1)
    expect(fs.readFileSync(sink.pathFor('runner'), 'utf-8')).toBe('a\nb\nc\n')
  })

  it('counts errors and warns from the DECLARED level, never from the line content', () => {
    const sink = makeSink()

    // The text screams "error"; the declared level says otherwise. The declaration wins — that is the
    // whole point of dropping the content classifier.
    sink.write('client/api', 'ERROR: this is just prose about an error', { level: 'info' })
    sink.write('client/api', 'boom', { level: 'error' })
    sink.write('client/api', 'careful', { level: 'warn' })

    const stats = sink.statsFor('client/api')

    expect(stats.errors).toBe(1)
    expect(stats.warns).toBe(1)
    expect(stats.lastErrorAt).not.toBeNull()
  })

  it('reports zeroes for a service that has never written', () => {
    expect(makeSink().statsFor('nobody')).toEqual({ errors: 0, warns: 0, lastErrorAt: null })
  })

  it('does not double a newline the caller already supplied', () => {
    const sink = makeSink()

    sink.write('runner', 'has newline\n')

    expect(fs.readFileSync(sink.pathFor('runner'), 'utf-8')).toBe('has newline\n')
  })

  it('drops a line rather than throwing when the file cannot be opened', () => {
    const sink = makeSink()

    vi.spyOn(fs, 'openSync').mockImplementation(() => {
      throw new Error('EACCES')
    })

    expect(() => {
      sink.write('doomed', 'line')
    }).not.toThrow()
    // The counter still moves: the status panel must not go quiet just because the disk did.
    expect(sink.statsFor('doomed').errors).toBe(0)
  })

  it('ignores writes after close, and closing twice is a no-op', () => {
    const sink = makeSink()

    sink.write('runner', 'before')
    sink.close()
    sink.close()
    sink.write('runner', 'after')

    expect(fs.readFileSync(sink.pathFor('runner'), 'utf-8')).toBe('before\n')
  })

  it('points a stable `latest` symlink at the pid-scoped run dir', () => {
    const sink = makeSink()
    const latest = path.join(path.dirname(sink.dir), 'latest')

    expect(fs.realpathSync(latest)).toBe(fs.realpathSync(sink.dir))
  })
})

describe('rawStdoutWrite', () => {
  it('bypasses an own-property patch on process.stdout, whatever the import order was', () => {
    // The panel's bypass MUST survive the interceptor owning process.stdout. Capturing the original at
    // module load is only order-immune if nothing patched stdout first — which no import graph can
    // promise. Resolving `write` off the prototype steps over any own-property patch by construction.
    const seen: string[] = []

    // A monkeypatch is an OWN property, which is exactly why the prototype bypass steps over it — and
    // why undoing it means DELETING the own property, not reassigning the original (that would just
    // install a second own property and leave the patch surface in place).
    expect(hasForeignStdoutPatch()).toBe(false)

    process.stdout.write = ((chunk: string): boolean => {
      seen.push(String(chunk))

      return true
    }) as typeof process.stdout.write

    try {
      expect(hasForeignStdoutPatch()).toBe(true)
      rawStdoutWrite('')
      // The patch saw nothing: the bypass went straight to the real stream.
      expect(seen).toEqual([])
    } finally {
      Reflect.deleteProperty(process.stdout, 'write')
    }

    expect(hasForeignStdoutPatch()).toBe(false)
  })
})

/**
 * The gate that stops the loop from feeding itself.
 *
 * Once a stdio stream has emitted `'error'`, every raw write to it is DROPPED. The return value is the
 * subtle half: it must be `true`, never `false`. `panelStream`'s Proxy propagates it into Ink, and `false`
 * reads as BACKPRESSURE — Ink would stall or buffer, hanging the very teardown the fatal path is trying to
 * reach. It must never throw either: the callers are all on the fault path.
 */
describe('rawStdoutWrite / rawStderrWrite — the terminal-liveness gate', () => {
  it('drops the chunk once the stream has died, returning true (never false: false reads as backpressure)', async () => {
    const proto = Object.getPrototypeOf(process.stdout) as { write: NodeJS.WriteStream['write'] }
    const real = vi.spyOn(proto, 'write').mockImplementation((() => {
      return true
    }) as never)

    const liveness = installTerminalLiveness({ streams: [process.stdout] })

    try {
      // Alive: the write reaches the real stream.
      expect(rawStdoutWrite('before')).toBe(true)
      expect(real).toHaveBeenCalledTimes(1)

      const error: NodeJS.ErrnoException = Object.assign(new Error('write EIO'), { code: 'EIO' })

      process.stdout.emit('error', error)
      await Promise.resolve()

      // Dead: dropped, and still `true`.
      expect(rawStdoutWrite('after')).toBe(true)
      expect(rawStderrWrite('after')).toBe(true)
      expect(real).toHaveBeenCalledTimes(1)
    } finally {
      liveness.uninstall()
      real.mockRestore()
    }
  })
})

/**
 * The net under ANY future logging loop, whatever its cause. The one this was written for wrote 455 GB of
 * `runner.log` at up to 127k lines/sec and filled a 926 GB disk.
 */
describe('devLogSink — the hard byte cap', () => {
  it('stops writing a service once it crosses the cap, and says so in the file', () => {
    const sink = new DevLogSink(path.join(tmpDir(), 'run'), 1024)

    sinks.push(sink)

    // 10 MB of storm into a 1 KB budget.
    Array.from({ length: 10_000 }, () => {
      return sink.write('runner', 'x'.repeat(1000))
    })

    const written = fs.readFileSync(sink.pathFor('runner'), 'utf-8')

    // One line under the cap, then the cap line — and nothing else, ever.
    expect(written).toContain('[capped]')
    expect(written).toContain('likely a logging loop')
    expect(Buffer.byteLength(written)).toBeLessThan(1024 * 3)
  })

  it('keeps counting errors while capped — a cap that freezes the panel counter hides the storm', () => {
    // The latch lives AFTER the counter bump for exactly this reason. A top-of-function early return (the
    // obvious implementation) would leave the panel's red error count frozen for the whole incident, which
    // is the objection to a byte cap in the first place: it must not make the storm silent.
    const sink = new DevLogSink(path.join(tmpDir(), 'run'), 64)

    sinks.push(sink)

    Array.from({ length: 50 }, () => {
      return sink.write('client/api', 'boom'.repeat(100), { level: 'error' })
    })

    expect(sink.statsFor('client/api').errors).toBe(50)
  })

  it('caps per service: a storming runner.log cannot silence a quiet client-api.log', () => {
    const sink = new DevLogSink(path.join(tmpDir(), 'run'), 512)

    sinks.push(sink)

    Array.from({ length: 100 }, () => {
      return sink.write('runner', 'x'.repeat(200))
    })
    sink.write('client/api', 'a perfectly ordinary line')

    expect(fs.readFileSync(sink.pathFor('runner'), 'utf-8')).toContain('[capped]')
    expect(fs.readFileSync(sink.pathFor('client/api'), 'utf-8')).toBe('a perfectly ordinary line\n')
  })

  it('never throws when capped, and never re-writes the cap line', () => {
    const sink = new DevLogSink(path.join(tmpDir(), 'run'), 32)

    sinks.push(sink)

    expect(() => {
      Array.from({ length: 20 }, () => {
        return sink.write('runner', 'x'.repeat(64))
      })
    }).not.toThrow()

    const capLines = fs
      .readFileSync(sink.pathFor('runner'), 'utf-8')
      .split('\n')
      .filter((line) => {
        return line.includes('[capped]')
      })

    expect(capLines).toHaveLength(1)
  })

  it('reads the cap from INFRA_KIT_DEV_LOG_MAX_BYTES, and falls back to 256 MB on garbage', () => {
    const saved = process.env.INFRA_KIT_DEV_LOG_MAX_BYTES

    try {
      process.env.INFRA_KIT_DEV_LOG_MAX_BYTES = '4096'
      expect(resolveMaxLogBytes()).toBe(4096)

      process.env.INFRA_KIT_DEV_LOG_MAX_BYTES = 'not-a-number'
      expect(resolveMaxLogBytes()).toBe(256 * 1024 * 1024)

      delete process.env.INFRA_KIT_DEV_LOG_MAX_BYTES
      expect(resolveMaxLogBytes()).toBe(256 * 1024 * 1024)
    } finally {
      if (saved === undefined) delete process.env.INFRA_KIT_DEV_LOG_MAX_BYTES
      else process.env.INFRA_KIT_DEV_LOG_MAX_BYTES = saved
    }
  })

  it('seeds the byte count from the file already on disk, so an append cannot spend a fresh budget', () => {
    const dir = path.join(tmpDir(), 'run')

    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'runner.log'), 'x'.repeat(900))

    const sink = new DevLogSink(dir, 1024)

    sinks.push(sink)
    sink.write('runner', 'y'.repeat(500))

    // 900 + 501 > 1024 → the very first write caps, rather than starting the budget from zero.
    expect(fs.readFileSync(sink.pathFor('runner'), 'utf-8')).toContain('[capped]')
  })
})

/**
 * The runner MUST hand every app its service tag.
 *
 * Without `serviceTag`, `ServerlessLocalRun` never enters an AsyncLocalStorage context — so every line a
 * handler emits (its own `console.log`, every Powertools line, a dependency's banner) falls into the
 * runner's fallback bucket, and the app's row counts zero errors no matter how loudly its handler fails.
 * With no log tail on screen, that is a panel reporting a healthy app that is broken.
 *
 * This is not hypothetical: the wiring was written, silently lost in an edit, and shipped. Every unit
 * test stayed green and a real run showed 18 handler log lines filed under `runner`. Nothing failed —
 * the feature was simply, quietly, not there. So the wiring gets a test of its own.
 */
describe('dev-server — the attribution wiring cannot silently vanish', () => {
  it('passes a serviceTag to every ServerlessLocalRun it constructs', () => {
    const source = fs.readFileSync(new URL('../dev-server.ts', import.meta.url), 'utf-8')
    const construction = source.slice(source.indexOf('new ServerlessLocalRun('))

    expect(construction).toMatch(/serviceTag:\s*`\$\{app\.name\}\/api`/)
  })
})

describe('resolveLogDir — the session id is untrusted input', () => {
  it('collapses a traversal attempt in INFRA_KIT_SESSION into one safe segment', () => {
    // This path is the ROOT that gcOldLogDirs walks with rmSync(recursive, force). Hardening the file
    // name while leaving the directory unhardened protects the wrong half.
    const saved = process.env.INFRA_KIT_SESSION

    try {
      process.env.INFRA_KIT_SESSION = '../../../etc'

      const dir = resolveLogDir()

      expect(dir).not.toContain('..')
      expect(path.resolve(dir).startsWith(path.resolve(getCacheRoot()))).toBe(true)
    } finally {
      if (saved === undefined) delete process.env.INFRA_KIT_SESSION
      else process.env.INFRA_KIT_SESSION = saved
    }
  })
})

describe('devLogSink — the GC must not delete a LIVE session', () => {
  it('leaves a dir named after a running pid alone, however old it looks', () => {
    // A directory's mtime is not bumped by writes INTO its files — only by create/unlink — and every
    // service file is created at boot. So a session left running over a long break looks a week old from
    // the moment it starts. Deleting it would unlink the inodes it still holds open, and its writes would
    // then succeed silently into nothing.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-'))
    const live = path.join(root, String(process.pid))
    const dead = path.join(root, '999999')

    for (const d of [live, dead]) {
      fs.mkdirSync(d, { recursive: true })
      fs.writeFileSync(path.join(d, 'runner.log'), 'x')
      const ancient = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

      fs.utimesSync(d, ancient, ancient)
    }

    // Constructing a sink under `root` runs the GC over root's siblings.
    const sink = new DevLogSink(path.join(root, 'current'))

    sinks.push(sink)

    expect(fs.existsSync(live)).toBe(true)
    expect(fs.existsSync(dead)).toBe(false)
  })
})
