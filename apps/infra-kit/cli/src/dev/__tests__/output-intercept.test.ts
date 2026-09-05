/*
 * Calling `console.log` IS the subject under test: these tests prove that a handler's console output is
 * captured into its service's file instead of reaching the terminal. A test that could not call it could
 * not test it.
 */
/* eslint-disable no-console */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { currentService, runAttributed } from '../log-attribution.js'
import { DevLogSink, hasForeignStdoutPatch, rawStdoutWrite } from '../log-sink.js'
import { installOutputIntercept } from '../output-intercept.js'
import type { OutputIntercept } from '../output-intercept.js'

/**
 * These tests drive the REAL `process.stdout` / `console` patches, because a fake stream would prove
 * nothing about the one thing that matters: that the panel's own writes escape the interceptor while
 * everything else is captured. Every test tears the patch down in `afterEach`, so a failure cannot
 * leave the test runner's stdout owned by a dead interceptor.
 */
let live: OutputIntercept | null = null
let sink: DevLogSink | null = null

/**
 * Every byte that reached the REAL terminal, recorded off the stream PROTOTYPE's `write`.
 *
 * The spy DELEGATES, so the runner's own output still reaches the screen; assertions look for a marker
 * rather than for emptiness.
 */
// The prototype is the only place worth asserting at: the interceptor has no terminal seam at all — it
// only ever writes to a file — so the one place a print could still happen is `rawStdoutWrite`, which
// reaches the screen by stepping over the interceptor's own-property patch and calling the prototype's
// `write`.
//
// `vi.hoisted` is load-bearing, not decoration. `log-sink` captures the prototype's `write` ONCE, at
// import time (`const protoWrite = …`), so a spy installed later is simply not in the path — the bypass
// would call the function it saved and print straight past the recorder. Every "did not print" assertion
// below would then pass no matter what the interceptor did: a perfect false green, on the one property
// this whole module exists to guarantee. Hoisting runs the spy BEFORE the imports are evaluated, so it is
// the wrapper that `log-sink` captures, and the bypass becomes observable.
const terminal = vi.hoisted((): string[] => {
  const captured: string[] = []
  // stdout and stderr can share one prototype; wrapping it twice would double-record.
  const seen = new Set<object>()

  // `globalThis.process`, not the imported binding: hoisting runs BEFORE the imports are initialised,
  // so the module-scope `process` is still in its temporal dead zone here.
  for (const stream of [globalThis.process.stdout, globalThis.process.stderr]) {
    const proto = Object.getPrototypeOf(stream) as { write: (...args: unknown[]) => boolean }

    if (seen.has(proto)) continue
    seen.add(proto)

    const original = proto.write

    proto.write = function (this: unknown, ...args: unknown[]): boolean {
      captured.push(String(args[0]))

      return original.apply(this, args)
    }
  }

  return captured
})

const install = (service?: string): { sink: DevLogSink; intercept: OutputIntercept } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intercept-'))

  sink = new DevLogSink(path.join(dir, 'run'))
  live = installOutputIntercept({
    sink,
    fallbackService: 'runner',
    currentService: () => {
      return service
    },
  })

  return { sink, intercept: live }
}

const readLog = (s: DevLogSink, service: string): string => {
  try {
    return fs.readFileSync(s.pathFor(service), 'utf-8')
  } catch {
    return ''
  }
}

afterEach(() => {
  live?.uninstall()
  live = null
  sink?.close()
  sink = null
  // The prototype spy stays installed for the file's lifetime — `log-sink` captured it at import and
  // cannot be handed anything else afterwards. It delegates, so leaving it in place changes nothing but
  // what is recorded; only the recording is reset between tests.
  terminal.length = 0
})

describe('installOutputIntercept — capture', () => {
  it('files a handler console.log into the attributed service', () => {
    const { sink: s } = install('client/api')

    console.log('hello from a handler')

    expect(readLog(s, 'client/api')).toContain('hello from a handler')
  })

  it('takes the level from the console METHOD the caller chose, never from the text', () => {
    const { sink: s } = install('client/api')

    // The info line's text screams "error"; the method it was written with says otherwise. The
    // declaration wins — that is what makes this not the content classifier that was rejected.
    console.log('ERROR ERROR ERROR — but this is console.log')
    console.warn('a warning')
    console.error('a real error')

    const stats = s.statsFor('client/api')

    expect(stats.errors).toBe(1)
    expect(stats.warns).toBe(1)
  })

  it('counts a console line exactly once — console.log writes THROUGH the patched stdout', () => {
    // The double-count trap: if the console patch delegated to the original console, the line would be
    // filed once by the console patch and a second time by the process.stdout.write patch beneath it.
    const { sink: s } = install('client/api')

    console.error('boom')

    expect(s.statsFor('client/api').errors).toBe(1)
    expect(readLog(s, 'client/api').match(/boom/g)).toHaveLength(1)
  })

  it('captures a RAW process.stdout.write — the channel console never touches', () => {
    // e.g. DEV_SERVER_REQUEST_LOG's raw line, or a dependency's import-time banner.
    const { sink: s } = install('client/api')

    process.stdout.write('GET /x 200 3ms\n')

    expect(readLog(s, 'client/api')).toContain('GET /x 200 3ms')
  })

  it('captures stderr, so process.emitWarning cannot corrupt the panel', () => {
    const { sink: s } = install()

    process.stderr.write('(node:1) ExperimentalWarning: something\n')

    expect(readLog(s, 'runner')).toContain('ExperimentalWarning')
    expect(s.statsFor('runner').warns).toBe(1)
  })

  it('files an unattributed line into the NAMED fallback bucket, never a guessed app', () => {
    const { sink: s } = install(undefined)

    console.log('a top-level setInterval in user code')

    expect(readLog(s, 'runner')).toContain('a top-level setInterval')
  })

  it('follows the AsyncLocalStorage tag across an async chain', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intercept-'))

    sink = new DevLogSink(path.join(dir, 'run'))
    live = installOutputIntercept({ sink, fallbackService: 'runner', currentService })

    await runAttributed('beta/api', async () => {
      await Promise.resolve()
      console.log('deep inside beta')
    })

    expect(readLog(sink, 'beta/api')).toContain('deep inside beta')
    expect(readLog(sink, 'runner')).not.toContain('deep inside beta')
  })
})

describe('installOutputIntercept — NOTHING is ever printed', () => {
  // There is no tee window and no "print until ready()" phase. These four cases are every channel an
  // app's output can take, at the one moment it used to escape: during boot, before the panel exists.
  // All four must be filed and NONE may reach the screen. `terminal` is spied on the prototype — the
  // only door out — so a leak through any of them is observable.

  it('files the Powertools banner WITHOUT printing it — this is the exact line that leaked', () => {
    const { sink: s } = install()

    // The backend runs IN-PROCESS with `POWERTOOLS_DEV=true`, so Powertools binds the global console and
    // `ServerlessLocalRun.start()` announces its port at `info` during boot. The old tee window printed
    // this JSON above the panel.
    console.info('{"level":"INFO","message":"Server listening on http://127.0.0.1:61584"}')

    expect(terminal.join('')).not.toContain('Server listening')
    expect(readLog(s, 'runner')).toContain('Server listening')
  })

  it('files a raw stdout write (an import-time banner) without printing it', () => {
    const { sink: s } = install()

    process.stdout.write('[some-dep] v3.2.0 initialised\n')

    expect(terminal.join('')).not.toContain('initialised')
    expect(readLog(s, 'runner')).toContain('initialised')
  })

  it('files a console.error without printing it — a LOG is not a crash, whatever its level says', () => {
    // The tee used to print this. It no longer does, and nothing is lost: a real crash never depends on
    // this path. Node writes a fatal stack straight to fd 2 (never through the patched stream), a failed
    // boot surfaces after `shutdown()` has already uninstalled, and a post-ready fault goes through
    // `reportFault` onto the panel. So `error` LEVEL buys visibility nowhere — it only buys noise.
    const { sink: s } = install()

    console.error('a handler logging at error level')

    expect(terminal.join('')).not.toContain('a handler logging at error level')
    expect(readLog(s, 'runner')).toContain('a handler logging at error level')
    expect(s.statsFor('runner').errors).toBe(1)
  })

  it('files a raw stderr write without printing it', () => {
    const { sink: s } = install()

    process.stderr.write('(node:1) ExperimentalWarning: noise\n')

    expect(terminal.join('')).not.toContain('ExperimentalWarning')
    expect(readLog(s, 'runner')).toContain('ExperimentalWarning')
  })
})

describe('installOutputIntercept — the panel must not fall into the black hole', () => {
  it('files NONE of what the panel writes through the bypass', () => {
    // The failure this guards is NOT a stack overflow — it is SILENCE. If the panel's frames went
    // through the patch, they would be quietly filed into a log instead of drawn: the screen would stay
    // blank while every test still passed. `rawStdoutWrite` is what the panel paints through, so this
    // pins the property that keeps the screen alive — the interceptor never sees those bytes.
    //
    // Now that the interceptor NEVER echoes, this is the load-bearing test for the whole design: the
    // panel is the only thing left that can reach the terminal. Both halves must hold — the frames reach
    // the screen, and none of them are filed.
    const { sink: s } = install()

    for (let i = 0; i < 20; i += 1) {
      // A REAL frame, with content and a newline. An empty string would make this test vacuous: routed
      // through the patch it produces no complete line and gets filtered anyway, so the assertions below
      // would pass whether the bypass worked or not.
      rawStdoutWrite(`PANEL_FRAME_${i}\n`)
    }

    expect(readLog(s, 'runner')).not.toContain('PANEL_FRAME')
    expect(s.statsFor('runner')).toMatchObject({ errors: 0, warns: 0 })
    // And it DID reach the real terminal: the panel still draws while every log line is filed.
    expect(terminal.join('')).toContain('PANEL_FRAME_19')
  })
})

describe('installOutputIntercept — uninstall', () => {
  it('leaves no own-property patch on stdout, so the stream is exactly as it was found', () => {
    expect(hasForeignStdoutPatch()).toBe(false)

    const { intercept } = install()

    expect(hasForeignStdoutPatch()).toBe(true)

    intercept.uninstall()

    expect(hasForeignStdoutPatch()).toBe(false)
  })

  it('is idempotent and restores console', () => {
    const original = console.log
    const { intercept } = install()

    expect(console.log).not.toBe(original)

    intercept.uninstall()
    intercept.uninstall()

    expect(console.log).toBe(original)
  })
})

/**
 * The end-to-end invariant, stated once: **a handler's error moves ITS row, not the runner's.**
 *
 * This is the property the whole attribution chain exists to deliver, and it is the one that silently
 * broke: `serviceTag` went missing from the runner in an edit, so `ServerlessLocalRun` never entered an
 * AsyncLocalStorage context, every handler line fell into the `runner` fallback, and the app's error
 * counter could never move. No test failed. A real run showed 18 handler lines filed under `runner` and a
 * panel calmly reporting `⚠ 0` for an app whose redis was refusing every connection.
 *
 * A test asserting the source text contains `serviceTag:` would go green with the ALS hook deleted, or
 * with the store lost across an await. This asserts the OUTCOME, so it fails for every broken link.
 */
describe('attribution — a handler error moves its own row', () => {
  it('counts a handler console.error against the app, and NOT against the runner', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attr-'))

    sink = new DevLogSink(path.join(dir, 'run'))
    live = installOutputIntercept({ sink, fallbackService: 'runner', currentService })

    // Exactly what ServerlessLocalRun does: enter the app's context, then let handler code run under it.
    await runAttributed('client/api', async () => {
      await Promise.resolve()
      console.error('redis: ECONNREFUSED')
    })

    expect(sink.statsFor('client/api').errors).toBe(1)
    expect(sink.statsFor('runner').errors).toBe(0)
  })

  it('falls back to the NAMED runner bucket when no app claims the line — never to a guess', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attr-'))

    sink = new DevLogSink(path.join(dir, 'run'))
    live = installOutputIntercept({ sink, fallbackService: 'runner', currentService })

    await Promise.resolve()
    console.error('something outside any request')

    expect(sink.statsFor('runner').errors).toBe(1)
  })
})
