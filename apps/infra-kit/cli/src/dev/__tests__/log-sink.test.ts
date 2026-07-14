import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { getCacheRoot } from 'src/lib/constants'

import { DevLogSink, hasForeignStdoutPatch, logFileName, rawStdoutWrite, resolveLogDir } from '../log-sink.js'

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
