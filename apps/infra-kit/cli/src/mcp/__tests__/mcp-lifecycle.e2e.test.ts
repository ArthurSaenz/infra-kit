import type * as esbuild from 'esbuild'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { LOG_FILE_PATH } from 'src/lib/logger'

import { buildMcpBundle, makeDisposableSession } from './helpers/mcp-harness'

/**
 * @fileoverview
 *
 * Process-lifecycle lane for the SDK v1 → v2 migration: O5 (anti-zombie, AC8) and O7 (bounded
 * teardown, AC4/AC9).
 *
 * Both contracts are about what the PROCESS does — whether it dies, and how fast — so neither can
 * be observed from inside the server. Every assertion here is made from outside a spawned child.
 *
 * WHY A SEPARATE FILE FROM `mcp-stdio.e2e.test.ts`. That file's ledger is a protocol-surface
 * ledger: one shared bundle, long-lived connections, tools called over them. This file builds
 * MUTANT bundles whose servers are deliberately broken, and a broken server has no place in a pool
 * of connections other tests reuse. `pool: 'forks'` still serializes the spawns within this file.
 *
 * SPAWN LEDGER — 5 children, all short-lived:
 *   o5 : 2 spawns — the factory-throw mutant, and the CLEAN bundle as its negative control.
 *   o7 : 3 spawns — the wedged-close mutant under SIGTERM, the same under SIGINT, and the
 *        unbounded control (the `Promise.race` bound also removed) under SIGTERM.
 *
 * BUILDS — 4: three mutants (O5 factory throw, O7 wedged close, O7 unbounded control) plus one
 * clean bundle for the O5 control. Builds are cheap and hermetic; spawns are what is rationed.
 *
 * RAW FRAMES ONLY, NEVER A NEGOTIATED CLIENT. A pinned/auto v2 client spawns a disposable sibling
 * for the era probe in addition to the served process. That would (a) make `pid` attribution on the
 * shared log file ambiguous, and (b) for O5 specifically, test nothing at all: the sibling dies
 * during the probe and `connect()` rejects BEFORE the served process is ever spawned. One
 * hand-written `initialize` frame is enough, because `serveStdio` builds the server LAZILY on the
 * first inbound message — a bare spawn constructs nothing and would observe neither contract.
 */

/** The factory the O5 mutant sabotages. Matching the opening line keeps the export signature. */
const FACTORY_SIGNATURE = 'export async function createMcpServer() {'

/** The awaited close in `src/entry/mcp.ts`, which the O7 mutant replaces with a hang. */
const CLOSE_CALL = 'handle.close()'

/** The whole bounded-teardown expression. Removing it is what makes the O7 control unbounded. */
const BOUNDED_TEARDOWN = 'await Promise.race([handle.close(), delay(1500)])'

/**
 * Builds an `onLoad` mutation plugin in the pattern of `mcp-confirm-gate-mutation.test.ts:36-53`.
 *
 * The no-op guard is the whole point. Without it, renaming `createMcpServer` or reformatting the
 * shutdown expression would make these tests build a HEALTHY bundle, watch it behave correctly, and
 * report success — a mutation check that verifies nothing is worse than no mutation check, because
 * it is credited as coverage.
 */
const mutationPlugin = (name: string, filter: RegExp, find: string, replace: string): esbuild.Plugin => {
  return {
    name,
    setup(build) {
      build.onLoad({ filter }, (args) => {
        const source = readFileSync(args.path, 'utf8')
        const mutated = source.replaceAll(find, replace)

        if (mutated === source) {
          throw new Error(
            `mutation no-op (${name}): ${JSON.stringify(find)} not found in ${args.path}. The code ` +
              `it targets was renamed or reformatted — update this plugin, or the test silently ` +
              `builds an unmutated bundle and verifies nothing.`,
          )
        }

        return { contents: mutated, loader: 'ts' }
      })
    },
  }
}

/** O5: `createMcpServer` throws. `buildOrDie` must log at error level and exit non-zero. */
const factoryThrowPlugin = mutationPlugin(
  'o5-throwing-factory',
  /mcp\/server\.ts$/,
  FACTORY_SIGNATURE,
  `${FACTORY_SIGNATURE}\n  throw new Error('o5: forced factory failure')`,
)

/** O7: `handle.close()` never settles. The 1500 ms bound is then the ONLY thing that ends shutdown. */
const wedgedClosePlugin = mutationPlugin('o7-wedged-close', /entry\/mcp\.ts$/, CLOSE_CALL, 'new Promise(() => {})')

/**
 * O7 control: the wedge WITHOUT the bound.
 *
 * `await Promise.race([handle.close(), delay(1500)])` becomes `await new Promise(() => {})`, so the
 * shutdown handler never reaches `process.exit(0)`. Nothing else ends the process either: the entry
 * registers its own `SIGTERM` listener, which OVERRIDES node's default disposition of terminating
 * on that signal. So the child stays alive indefinitely and `afterAll`'s SIGKILL reaps it. This is
 * the same shape as the real hazard — `close()` awaits `closeAll()`, which awaits the product and
 * wire closes — with the hang made unconditional so the control is deterministic.
 */
const unboundedClosePlugin = mutationPlugin(
  'o7-unbounded-close',
  /entry\/mcp\.ts$/,
  BOUNDED_TEARDOWN,
  'await new Promise(() => {})',
)

/** Legacy-era handshake. `protocolVersion` is pinned so this never depends on negotiation. */
const INITIALIZE_FRAME = `${JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'mcp-lifecycle', version: '0.0.0' },
  },
})}\n`

const tmpDirs: string[] = []
const strays: ChildProcess[] = []

let cleanPath = ''
let factoryThrowPath = ''
let wedgedClosePath = ''
let unboundedClosePath = ''

/**
 * A per-child throwaway session cache.
 *
 * These servers only handshake, so nothing destructive runs — but `XDG_CACHE_HOME` redirection
 * costs nothing and keeps a mutant that misbehaves in an unforeseen way away from the developer's
 * real `~/.cache/infra-kit`.
 */
const disposableEnv = (): NodeJS.ProcessEnv => {
  const { cacheHome, env } = makeDisposableSession()

  tmpDirs.push(cacheHome)

  return env
}

/** Spawns a bundle and immediately drives the ONE frame that forces the lazy factory to run. */
const spawnInitialized = (bundlePath: string): { child: ChildProcess; readStdout: () => string } => {
  const child = spawn(process.execPath, [bundlePath], { env: disposableEnv(), stdio: ['pipe', 'pipe', 'ignore'] })

  strays.push(child)

  let stdout = ''

  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk)
  })

  child.stdin?.write(INITIALIZE_FRAME)

  return {
    child,
    readStdout: () => {
      return stdout
    },
  }
}

interface Exit {
  code: number | null
  signal: NodeJS.Signals | null
}

/** Resolves with the exit status, or `undefined` if the child was still alive at the deadline. */
const waitForExit = (child: ChildProcess, timeoutMs: number): Promise<Exit | undefined> => {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      resolvePromise(undefined)
    }, timeoutMs)

    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolvePromise({ code, signal })
    })
  })
}

const settle = (ms: number): Promise<void> => {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms)
  })
}

const logSize = (): number => {
  return existsSync(LOG_FILE_PATH) ? readFileSync(LOG_FILE_PATH, 'utf8').length : 0
}

interface LogLine {
  level?: number
  pid?: number
}

/**
 * The lines one child wrote to the pino log since `offset`.
 *
 * ATTRIBUTION IS MANDATORY. `LOG_FILE_PATH` is the hard-coded global `/tmp/mcp-infra-kit.log`
 * (`src/lib/logger/index.ts`); `XDG_CACHE_HOME` does NOT redirect it. Every MCP server the suite
 * spawns appends there, and `pool: 'forks'` runs other test FILES concurrently — so "the log gained
 * an error line" is satisfiable by a completely unrelated process. Pino stamps every line with
 * `pid`, so filter to this child's own lines before asserting anything.
 */
const logLinesFor = (child: ChildProcess, offset: number): LogLine[] => {
  const grew = existsSync(LOG_FILE_PATH) ? readFileSync(LOG_FILE_PATH, 'utf8').slice(offset) : ''

  return grew
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as LogLine
      } catch {
        // A concurrent writer can leave the slice starting mid-line. Not an error.
        return null
      }
    })
    .filter((entry): entry is LogLine => {
      return entry !== null && entry.pid === child.pid
    })
}

const errorLevelLines = (lines: LogLine[]): LogLine[] => {
  return lines.filter((line) => {
    return (line.level ?? 0) >= 50
  })
}

/** Parses whatever the child put on stdout into JSON-RPC frames, ignoring anything unparseable. */
const framesFrom = (stdout: string): Record<string, any>[] => {
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, any>
      } catch {
        return null
      }
    })
    .filter((frame): frame is Record<string, any> => {
      return frame !== null
    })
}

beforeAll(async () => {
  const [clean, factoryThrow, wedgedClose, unboundedClose] = await Promise.all([
    buildMcpBundle('mcp-lifecycle-clean-'),
    buildMcpBundle('mcp-lifecycle-o5-mutant-', [factoryThrowPlugin]),
    buildMcpBundle('mcp-lifecycle-o7-wedged-', [wedgedClosePlugin]),
    buildMcpBundle('mcp-lifecycle-o7-unbounded-', [unboundedClosePlugin]),
  ])

  tmpDirs.push(clean.outDir, factoryThrow.outDir, wedgedClose.outDir, unboundedClose.outDir)

  cleanPath = clean.mcpPath
  factoryThrowPath = factoryThrow.mcpPath
  wedgedClosePath = wedgedClose.mcpPath
  unboundedClosePath = unboundedClose.mcpPath
}, 120_000)

afterAll(() => {
  for (const child of strays) {
    if (!child.killed) child.kill('SIGKILL')
  }

  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('o5 — a server that cannot be built must DIE, not linger as a zombie', () => {
  /**
   * The hazard `serveStdio` introduces: the factory is called lazily, from inside the transport, on
   * the first inbound message. A factory that throws there could leave a live process attached to
   * the client's pipes, answering nothing forever — a zombie. `buildOrDie` exists to prevent that,
   * and only an out-of-process observation can tell a dead server from a wedged one.
   */
  it('o5: a throwing factory exits non-zero, records an error-level line, and answers no frame', async () => {
    const before = logSize()

    const { child, readStdout } = spawnInitialized(factoryThrowPath)

    // The bound is what makes this an anti-zombie test: a true zombie never exits, so any finite
    // deadline catches it. It is 45 s rather than 15 s because under the root `turbo run test`
    // (14 packages in parallel, each spawning bundles) a cold node child took >15 s just to load
    // the bundle and reach the factory — measured 2026-09-05, 3/3 green in isolation, red under
    // turbo at exactly 15 s. Isolated exit latency is ~1 s.
    const exit = await waitForExit(child, 45_000)

    expect(exit, 'the mutant never exited — this is exactly the zombie AC8 forbids').toBeDefined()
    expect(exit?.code, `expected a non-zero exit; got code=${exit?.code} signal=${exit?.signal}`).not.toBe(0)
    expect(exit?.code, `expected exit(1), but the process died on ${exit?.signal}`).not.toBeNull()

    // pino's destination is buffered and `process.exit` discards what is still in flight, so give
    // the write that DID happen a moment to land before reading.
    await settle(500)

    expect(
      errorLevelLines(logLinesFor(child, before)),
      'the factory failure left no error-level line — a silent death is indistinguishable from a crash',
    ).not.toHaveLength(0)

    const internalErrors = framesFrom(readStdout()).filter((frame) => {
      return frame.error?.code === -32603
    })

    // Dying is the contract. Answering the client with an internal error and STAYING UP is the
    // failure mode: the client sees a server that responds, so it keeps the connection open.
    expect(internalErrors, 'the mutant answered -32603 instead of dying').toHaveLength(0)
  }, 60_000)

  it('o5-control: the CLEAN bundle survives the same frame and logs nothing at error level', async () => {
    const before = logSize()

    const { child } = spawnInitialized(cleanPath)

    // The control that makes o5 mean something. Without it, "exits non-zero" would be satisfied by
    // any unrelated startup crash — a missing dependency, a bad bundle — and o5 would pass while
    // observing nothing about the factory at all.
    const early = await waitForExit(child, 2000)

    expect(early, `the clean server exited on its own (code=${early?.code} signal=${early?.signal})`).toBeUndefined()

    // Then end it gracefully. This is NOT cleanup — `afterAll` already SIGKILLs every stray. A
    // graceful stop is the only way pino's buffer reaches disk (measured in `o2`), so without it
    // "zero error lines" would be satisfiable by a log the child never managed to write.
    child.kill('SIGTERM')

    await waitForExit(child, 10_000)
    await settle(500)

    const mine = logLinesFor(child, before)

    expect(mine, 'the clean child wrote nothing at all — the assertion below would be vacuous').not.toHaveLength(0)
    expect(errorLevelLines(mine), 'a healthy server logged at error level').toHaveLength(0)
  }, 45_000)
})

describe('o7 — teardown is BOUNDED, even when close() never settles', () => {
  /**
   * AC4/AC9. `handle.close()` awaits `closeAll()`, which awaits the product and wire closes; if any
   * of those never settles, an unbounded `await` would hang the shutdown handler forever. The
   * handler overrides node's default SIGTERM disposition, so "the signal kills it anyway" is not a
   * fallback — the `Promise.race([..., delay(1500)])` bound is the ONLY thing that ends the process.
   *
   * These tests assert exit TIMING, which nothing else in the suite does.
   */
  const teardown = async (
    bundlePath: string,
    signal: NodeJS.Signals,
  ): Promise<{ child: ChildProcess; elapsedMs: number; exit: Exit | undefined }> => {
    const { child } = spawnInitialized(bundlePath)

    // Let the initialize frame land so a real server instance is pinned; a shutdown before the
    // lazy factory has run would exercise a different, emptier path.
    await settle(1000)

    const started = Date.now()

    child.kill(signal)

    const exit = await waitForExit(child, 3000)

    return { child, elapsedMs: Date.now() - started, exit }
  }

  it('o7: with close() wedged, SIGTERM still exits 0 inside the bound', async () => {
    const { elapsedMs, exit } = await teardown(wedgedClosePath, 'SIGTERM')

    expect(exit, `wedged close(): no exit within 3000 ms of SIGTERM (waited ${elapsedMs} ms)`).toBeDefined()
    expect(exit?.code, `expected a clean exit(0); got code=${exit?.code} signal=${exit?.signal}`).toBe(0)
    expect(elapsedMs, 'exit was not bounded').toBeLessThan(3000)
  }, 45_000)

  it('o7: with close() wedged, SIGINT still exits 0 inside the bound', async () => {
    const { elapsedMs, exit } = await teardown(wedgedClosePath, 'SIGINT')

    expect(exit, `wedged close(): no exit within 3000 ms of SIGINT (waited ${elapsedMs} ms)`).toBeDefined()
    expect(exit?.code, `expected a clean exit(0); got code=${exit?.code} signal=${exit?.signal}`).toBe(0)
    expect(elapsedMs, 'exit was not bounded').toBeLessThan(3000)
  }, 45_000)

  it('o7-control: with the bound ALSO removed, the same wedge hangs past 3000 ms', async () => {
    const { child, exit } = await teardown(unboundedClosePath, 'SIGTERM')

    // If this ever goes green, the two tests above prove nothing: the process would be exiting for
    // some reason other than the bound, and deleting `Promise.race` would leave them passing.
    expect(exit, `the unbounded mutant exited anyway (code=${exit?.code} signal=${exit?.signal})`).toBeUndefined()

    child.kill('SIGKILL')
  }, 45_000)
})
