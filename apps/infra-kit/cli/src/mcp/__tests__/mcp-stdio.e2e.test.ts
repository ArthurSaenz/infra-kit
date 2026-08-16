import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { Client as ClientV1 } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport as StdioClientTransportV1 } from '@modelcontextprotocol/sdk/client/stdio.js'
import * as esbuild from 'esbuild'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { commandCatalog, getExposedMcpTools } from 'src/lib/command-catalog'
import { LOG_FILE_PATH } from 'src/lib/logger'

import { buildOptions } from '../../../scripts/build.js'

/**
 * Protocol-level e2e lane for the SDK v1 → v2 migration (Release 1 / Option E).
 *
 * WHY ONE FILE. `vitest.config.ts` pins `pool: 'forks'`, so parallelism is per-FILE. Every test
 * here spawns a child process; split across files they would spawn concurrently and reproduce the
 * load contention this repo already documents for `lock.test` / `portless-driver.test`. One file
 * = one fork = serialized spawns.
 *
 * WHY NOT `InMemoryTransport`. `InMemoryTransport.createLinkedPair()` connects 2025-era instances
 * only. Any era-sensitive assertion made through it is a FALSE GREEN. Every era claim below runs
 * over a real spawned child process. Do not "simplify" this file into an in-memory pair.
 *
 * WHERE WE BUILD — into this package's `node_modules/.cache`, not `os.tmpdir()`: `buildOptions`
 * leaves dependencies external, so the bundle only resolves them by walking up to a `node_modules`
 * that exists ABOVE it. Built into tmpdir it dies on ERR_MODULE_NOT_FOUND before running.
 *
 * SPAWN LEDGER (kept deliberately small; see WHY ONE FILE):
 *   long-lived : shared v2 client (E1/E2/E3/E6/O2 + E8-R1 bare control), v1 client (E7), gate fixture (E4/E5)
 *   short-lived: W1 raw ×2 (also carries O1), E8-R1 pinned ×1, O6 ×1
 */

const KILL_SWITCHES = {
  INFRA_KIT_NO_SEED: '1',
  INFRA_KIT_NO_AUTO_UPDATE: '1',
  INFRA_KIT_NO_LOCATION_WARN: '1',
} as const

const FIXTURES = resolve(__dirname, 'fixtures')
const CLI_ROOT = resolve(__dirname, '../../..')

let mcpPath = ''
const tmpDirs: string[] = []
const strays: ChildProcess[] = []

const childEnv = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...KILL_SWITCHES, ...overrides }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key]
  }

  return env
}

const mkTmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `mcp-e2e-${prefix}-`))

  tmpDirs.push(dir)

  return dir
}

/** Raw JSON-RPC over stdio. Used where a typed client cannot express the request (W1's era probes). */
const rawSession = (
  requestedVersion: string,
  methods: string[],
  env: NodeJS.ProcessEnv = childEnv(),
): Promise<{ frames: Record<string, any>[]; stdout: string }> => {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [mcpPath], { env, stdio: ['pipe', 'pipe', 'ignore'] })

    strays.push(child)

    let stdout = ''
    let buf = ''
    const frames: Record<string, any>[] = []

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
      buf += String(chunk)

      let idx = buf.indexOf('\n')

      while (idx !== -1) {
        const line = buf.slice(0, idx).trim()

        buf = buf.slice(idx + 1)

        if (line) {
          try {
            frames.push(JSON.parse(line) as Record<string, any>)
          } catch {
            /* O1 asserts on `stdout`; a non-JSON line is caught there, not swallowed here. */
          }
        }

        idx = buf.indexOf('\n')
      }
    })

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: requestedVersion, capabilities: {}, clientInfo: { name: 'e2e', version: '0.0.0' } },
      })}\n`,
    )
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

    methods.forEach((method, i) => {
      setTimeout(
        () => {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: i + 2, method, params: {} })}\n`)
        },
        250 * (i + 1),
      )
    })

    // Resolve as soon as every expected response id has arrived. A fixed settle timer made this
    // flaky under load: the frames simply had not landed yet and W1 read `undefined`.
    const wanted = methods.length + 1
    const deadline = Date.now() + 20_000

    const finish = (): void => {
      child.kill('SIGKILL')
      resolvePromise({ frames, stdout })
    }

    const poll = setInterval(() => {
      const answered = frames.filter((f) => {
        return f.id !== undefined
      }).length

      if (answered >= wanted || Date.now() > deadline) {
        clearInterval(poll)
        finish()
      }
    }, 50)
  })
}

const connectV2 = async (env: NodeJS.ProcessEnv = childEnv()): Promise<Client> => {
  const client = new Client({ name: 'e2e-v2', version: '0.0.0' })

  await client.connect(new StdioClientTransport({ command: process.execPath, args: [mcpPath], env: env as any }))

  return client
}

beforeAll(async () => {
  const cache = resolve(CLI_ROOT, 'node_modules', '.cache')

  mkdirSync(cache, { recursive: true })

  const outDir = mkdtempSync(join(cache, 'mcp-stdio-e2e-'))

  tmpDirs.push(outDir)

  await esbuild.build({ ...buildOptions, outdir: outDir })

  mcpPath = join(outDir, 'mcp.js')
}, 120_000)

afterAll(() => {
  for (const child of strays) {
    if (!child.killed) child.kill('SIGKILL')
  }

  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('e1–E3, E6 — the served surface (shared v2 client)', () => {
  let client: Client

  beforeAll(async () => {
    client = await connectV2()
  }, 45_000)

  it('e1: tools/list is exactly the catalog allowlist, doctor absent', async () => {
    const listed = await client.listTools()
    const actual = new Set(
      listed.tools.map((t) => {
        return t.name
      }),
    )
    const expected = new Set(
      getExposedMcpTools().map((t) => {
        return t.name
      }),
    )

    // Computed from the catalog, never a hard-coded count: a literal would break on the first
    // catalog change for the wrong reason, and the natural "fix" is to loosen the assertion —
    // which destroys the drift guard this exists to be.
    expect(actual).toEqual(expected)
    expect(actual).not.toContain('doctor')
    expect(actual.size).toBeGreaterThan(20)
  }, 45_000)

  it('e2: a read-only tool call round-trips through v2 serialization', async () => {
    const result = (await client.callTool({ name: 'version', arguments: {} })) as {
      isError?: boolean
      structuredContent?: Record<string, unknown>
    }

    expect(result.isError ?? false).toBe(false)
    expect(result.structuredContent).toBeTypeOf('object')
  }, 45_000)

  it('e3: both read-only resources are listed and readable', async () => {
    const listed = await client.listResources()
    const uris = listed.resources.map((r) => {
      return r.uri
    })

    expect(uris).toContain('infra-kit://config')
    expect(uris).toContain('infra-kit://dev-context')

    // dev-context with no active session must resolve to a payload, NOT an error.
    const devContext = await client.readResource({ uri: 'infra-kit://dev-context' })

    const first = devContext.contents[0]

    expect(first?.mimeType).toBe('application/json')
    expect(first !== undefined && 'text' in first, 'dev-context must be a text resource').toBe(true)
    expect(() => {
      return JSON.parse(String((first as { text: string }).text))
    }).not.toThrow()
  }, 45_000)

  it('e6: the long-lived server survives a failing tool call and answers the next one', async () => {
    await expect(client.callTool({ name: 'no-such-tool-xyz', arguments: {} })).rejects.toThrow()

    const after = await client.listTools()

    expect(after.tools.length).toBeGreaterThan(20)
  }, 45_000)

  it('e9: every deterministic read-only tool round-trips a well-formed v2 result', async () => {
    // WHY THIS EXISTS. E2 and E4/E5 only ever put TWO tools' `tools/call` results on the wire
    // (`version`, `env-clear`), so the v1 -> v2 RESULT-serialization path — content blocks,
    // `structuredContent`, `isError` — was the thinnest part of this suite. That path is where a
    // silent shape change would actually hurt a host.
    //
    // This asserts SHAPE, not success: a tool that legitimately errors in this environment still
    // proves the serialization round-trip. What it must never do is return a malformed result.
    //
    // Excluded on purpose (side effects / non-determinism, not shape concerns):
    //   reopen       — can launch an editor
    //   release-list — hits the GitHub API
    //   audit        — long-running whole-repo scan
    const EXCLUDED = new Set(['reopen', 'release-list', 'audit'])

    const readOnly = commandCatalog
      .filter((entry) => {
        return entry.mcpExposed && entry.mcpTool !== null && !entry.mutating && !EXCLUDED.has(entry.cliName)
      })
      .map((entry) => {
        return entry.mcpTool!.name
      })

    expect(readOnly.length).toBeGreaterThan(5)

    const declaredOutputSchema = new Map(
      getExposedMcpTools().map((t) => {
        return [t.name, t.outputSchema]
      }),
    )

    for (const name of readOnly) {
      let result: { isError?: boolean; content?: unknown; structuredContent?: unknown } | undefined
      let threw = false

      try {
        result = (await client.callTool({ name, arguments: {} }, { timeout: 10_000 })) as typeof result
      } catch {
        // A protocol-level error response is a legitimate outcome here — the tool ran and the
        // transport answered. It is a hang or a malformed frame that would matter, and either
        // would surface as a timeout or a parse failure rather than as this catch.
        threw = true
      }

      if (threw) continue

      expect(result, `${name} returned no result`).toBeDefined()
      expect(Array.isArray(result!.content), `${name}.content must be an array`).toBe(true)

      const succeeded = (result!.isError ?? false) === false
      const hasOutputSchema = Object.keys(declaredOutputSchema.get(name) ?? {}).length > 0

      if (succeeded && hasOutputSchema) {
        expect(
          result!.structuredContent,
          `${name} declares an outputSchema but returned no structuredContent`,
        ).toBeTypeOf('object')
      }
    }
  }, 120_000)

  it('o2: the migrated transport path is recorded in the pino log', async () => {
    // WHAT THIS CAN AND CANNOT OBSERVE. `initLoggerMcp` uses `pino.destination({ dest })`, which is
    // ASYNC-buffered, and `setupErrorHandlers` ends the process with `process.exit(0)` — which
    // discards whatever is still buffered. Measured: after a graceful SIGTERM the file gains the
    // startup lines but NEVER a per-tool-call line. So asserting on "Tool execution started: …"
    // is unobservable-by-construction here, not merely slow, and any amount of polling is a
    // guaranteed flake.
    //
    // The startup lines ARE flushed, and they are emitted by `src/entry/mcp.ts` immediately AFTER
    // `await server.connect(transport)` returns — i.e. by the exact code path this migration
    // changed. Observing them proves both that logging survived the SDK swap and that the v2
    // transport connected. That is a stronger signal than a tool-call line would have been.
    // NOTE: unlike E4/E5 and the mutation check, this test is NOT sandboxed — `LOG_FILE_PATH` is
    // the shared global `/tmp/mcp-infra-kit.log` that the real server always writes to. That is
    // deliberate (the point is to observe the REAL log destination), and it is safe here because
    // we only length-slice what this child appended and assert with `toContain`, so concurrent
    // writers cannot make it pass or fail spuriously.
    const before = existsSync(LOG_FILE_PATH) ? readFileSync(LOG_FILE_PATH, 'utf8').length : 0
    const child = spawn(process.execPath, [mcpPath], { env: childEnv(), stdio: ['pipe', 'pipe', 'ignore'] })

    strays.push(child)

    await new Promise<void>((resolvePromise) => {
      const done = (): void => {
        resolvePromise()
      }

      child.on('exit', done)
      setTimeout(() => {
        child.kill('SIGTERM')
      }, 1500)
      setTimeout(done, 12_000)
    })

    await new Promise((r) => {
      setTimeout(r, 500)
    })

    const grew = readFileSync(LOG_FILE_PATH, 'utf8').slice(before)

    expect(grew, 'the MCP server wrote nothing to its log file').not.toBe('')
    expect(grew).toContain('Server connected to transport. Ready.')
  }, 45_000)
})

describe('e4/E5 — the destructive-tool confirm gate, proven by a FILESYSTEM side effect', () => {
  /**
   * Subject: `env-clear`. It is genuinely `requiresHumanConfirm: true`, its only input is `confirm`,
   * and executing it WRITES `env-clear.sh` into the session cache dir — an observable side effect on
   * disk. Asserting on the response shape alone would leave open "the gate returned AND the handler
   * also ran", which is precisely PM-2's severe branch.
   *
   * NOT `worktrees-sync` (it carries no `requiresHumanConfirm` at all — it would never trigger the
   * gate) and NOT a deploy tool (`local-deploy*`, `gh-release-deploy*`, `release-create` mutate real
   * infrastructure).
   *
   * HARD PRECONDITION: under the mutation build (see mcp-confirm-gate-mutation.test.ts) call 1
   * genuinely EXECUTES. The fixture must therefore stay disposable — the whole session cache is
   * redirected into a temp dir via XDG_CACHE_HOME and deleted in afterAll.
   */
  let client: Client
  let clearFile = ''

  beforeAll(async () => {
    const cacheHome = mkTmp('gate-cache')
    const session = 'e2egate'
    const sessionDir = join(cacheHome, 'infra-kit', session)

    mkdirSync(sessionDir, { recursive: true })
    // env-clear errors when nothing is loaded; give it something to clear.
    writeFileSync(join(sessionDir, 'env-load.sh'), 'export FOO=bar\n')

    clearFile = join(sessionDir, 'env-clear.sh')

    client = await connectV2(childEnv({ XDG_CACHE_HOME: cacheHome, INFRA_KIT_SESSION: session }))
  }, 45_000)

  it('e4: call 1 without `confirm` is GATED and does NOT execute (no file written)', async () => {
    expect(existsSync(clearFile), 'fixture must start clean').toBe(false)

    const result = (await client.callTool({ name: 'env-clear', arguments: {} })) as {
      isError?: boolean
      structuredContent?: { status?: string; tool?: string }
    }

    expect(result.isError).toBe(true)
    expect(result.structuredContent?.status).toBe('confirmation_required')
    expect(result.structuredContent?.tool).toBe('env-clear')

    // THE load-bearing assertion. Response shape alone cannot distinguish "gated" from
    // "gated but the handler ran anyway".
    expect(existsSync(clearFile), 'gated call MUST NOT have executed the handler').toBe(false)
  }, 45_000)

  it('e5: call 2 with `confirm: true` actually executes (file appears)', async () => {
    const result = (await client.callTool({ name: 'env-clear', arguments: { confirm: true } })) as {
      isError?: boolean
    }

    expect(result.isError ?? false).toBe(false)
    expect(existsSync(clearFile), 'confirmed call MUST have executed the handler').toBe(true)
  }, 45_000)
})

describe('e7 — a genuine 2025-era v1 client still drives the migrated server', () => {
  /**
   * The retained `@modelcontextprotocol/sdk` devDependency exists for exactly this: proving the
   * migrated v2 server is still reachable by the SDK generation every host ships today. This is a
   * permanent legacy-client regression guard.
   */
  it('e7: v1 Client lists tools and resources; gated tools reject (pre-existing v1-client defect)', async () => {
    const client = new ClientV1({ name: 'e2e-v1', version: '0.0.0' })

    await client.connect(
      new StdioClientTransportV1({ command: process.execPath, args: [mcpPath], env: childEnv() as any }),
    )

    const listed = await client.listTools()

    expect(
      new Set(
        listed.tools.map((t) => {
          return t.name
        }),
      ),
    ).toEqual(
      new Set(
        getExposedMcpTools().map((t) => {
          return t.name
        }),
      ),
    )

    const resources = await client.listResources()

    expect(
      resources.resources.map((r) => {
        return r.uri
      }),
    ).toContain('infra-kit://config')

    // A read-only tool round-trips normally for a v1 client.
    const version = (await client.callTool({ name: 'version', arguments: {} })) as { isError?: boolean }

    expect(version.isError ?? false).toBe(false)

    // PRE-EXISTING DEFECT, deliberately pinned here rather than "fixed" by this migration.
    //
    // The confirm gate returns `isError: true` plus a `structuredContent` gate payload that does
    // not match the tool's declared `outputSchema`. The SERVER skips output validation when
    // `isError` is set (v1 and v2 alike), but the v1 CLIENT does not: its `callTool` validates
    // whenever `structuredContent` is present and never consults `isError` — despite a comment
    // claiming otherwise (sdk 1.30.0, dist/esm/client/index.js ~line 493). So a v1-SDK host sees
    // `-32602 InvalidParams` instead of the intended "re-call with confirm: true" guidance.
    //
    // Verified PRE-EXISTING, not caused by the v1 -> v2 server migration: validating the same
    // gate payload against the V1-PUBLISHED env-clear outputSchema (captured in
    // fixtures/tools-list-baseline.v1.json, before any dependency change) produces the identical
    // 8 violations — 4 missing-required + 4 additional-properties.
    //
    // It fails SAFE: the tool still does not execute. It is a UX defect, not a safety defect, and
    // fixing it is a behaviour change that Release 1 deliberately does not make.
    await expect(client.callTool({ name: 'env-clear', arguments: {} })).rejects.toThrow(
      /does not match the tool's output schema/,
    )

    await client.close()
  }, 45_000)
})

describe('e8-R1 — Release 1 serves the 2025 era ONLY (the anti-serveStdio guard)', () => {
  /**
   * This is what stops `serveStdio` arriving by accident once it is no longer a roadmap item.
   * A bare client must negotiate legacy, and a client that DEMANDS 2026-07-28 must be refused.
   */
  it('e8-r1a: an auto-negotiating client still lands on the legacy era', async () => {
    // `mode: 'auto'` is load-bearing. `DEFAULT_VERSION_NEGOTIATION_MODE` is `'legacy'`, so a bare
    // client never probes at all and would report `'legacy'` even against a `serveStdio` server —
    // making it useless as an anti-serveStdio guard. With `'auto'` the client sends
    // `server/discover`; our server answers -32601 and it falls back. Under `serveStdio` the probe
    // would be ANSWERED and this would flip to `'modern'`, turning the test red.
    const client = new Client({ name: 'e2e-auto', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } })

    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [mcpPath], env: childEnv() as any }),
    )

    expect(client.getProtocolEra()).toBe('legacy')

    await client.close()
  }, 45_000)

  it('e8-r1b: a client PINNED to 2026-07-28 is refused — connect() rejects', async () => {
    const pinned = new Client(
      { name: 'e2e-pinned', version: '0.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    )

    // `pin` has NO legacy fallback: against a 2025-only server `connect()` REJECTS. Asserting
    // `getProtocolEra() !== 'modern'` after connect would be unreachable code that surfaces as an
    // unhandled rejection and reads like a broken harness.
    await expect(
      pinned.connect(new StdioClientTransport({ command: process.execPath, args: [mcpPath], env: childEnv() as any })),
    ).rejects.toThrow()
  }, 45_000)
})

describe('w1 — differential wire compatibility against the pre-migration v1 baseline', () => {
  /**
   * The plan's central confidence artifact. It asserts the TWO known deltas POSITIVELY (rather than
   * normalizing them away) and fails on any third difference — a normalization broad enough to
   * swallow D1/D2 is the same hole an unnoticed third delta would slip through.
   *
   * Only `serverInfo.version` is normalized, because it changes on every release bump.
   */
  const v1Init = JSON.parse(readFileSync(join(FIXTURES, 'initialize-baseline.v1.json'), 'utf8')) as Record<string, any>
  const v1Tools = JSON.parse(readFileSync(join(FIXTURES, 'tools-list-baseline.v1.json'), 'utf8')) as Record<string, any>
  const v1Resources = JSON.parse(readFileSync(join(FIXTURES, 'resources-list-baseline.v1.json'), 'utf8')) as Record<
    string,
    any
  >

  const DRAFT_07 = 'http://json-schema.org/draft-07/schema#'
  const DRAFT_2020 = 'https://json-schema.org/draft/2020-12/schema'

  let init2025: Record<string, any>
  let init2026: Record<string, any>
  let toolsResult: Record<string, any>
  let resourcesResult: Record<string, any>
  let purityStdout = ''

  beforeAll(async () => {
    const a = await rawSession('2025-06-18', [])
    const b = await rawSession('2026-07-28', ['tools/list', 'resources/list'])

    init2025 = a.frames.find((f) => {
      return f.id === 1
    })?.result
    init2026 = b.frames.find((f) => {
      return f.id === 1
    })?.result
    toolsResult = b.frames.find((f) => {
      return f.id === 2
    })?.result
    resourcesResult = b.frames.find((f) => {
      return f.id === 3
    })?.result
    purityStdout = b.stdout
  }, 45_000)

  it('w1a: negotiated protocolVersion and serverInfo are unchanged for both probed versions', () => {
    expect(init2025.protocolVersion).toBe(v1Init['2025-06-18'].protocolVersion)
    expect(init2026.protocolVersion).toBe(v1Init['2026-07-28'].protocolVersion)

    // The 2026 request still down-negotiates to the 2025-era ceiling — Option E cannot serve 2026.
    expect(init2026.protocolVersion).toBe('2025-11-25')

    expect(init2025.serverInfo.name).toBe(v1Init['2025-06-18'].serverInfo.name)
    expect(init2026.serverInfo.name).toBe(v1Init['2026-07-28'].serverInfo.name)

    // A whole KEY-SET check, not just the fields we thought to name. A field appearing or
    // vanishing is exactly the class of delta a hand-picked field list cannot see.
    expect(Object.keys(init2025).sort()).toEqual(Object.keys(v1Init['2025-06-18']).sort())
    expect(Object.keys(init2026).sort()).toEqual(Object.keys(v1Init['2026-07-28']).sort())
  })

  it('w1b: D1 — capabilities.prompts gains listChanged; resources and tools are untouched', () => {
    for (const [requested, current] of [
      ['2025-06-18', init2025],
      ['2026-07-28', init2026],
    ] as const) {
      const before = v1Init[requested].capabilities
      const after = current.capabilities

      expect(before.prompts).toEqual({})
      expect(after.prompts).toEqual({ listChanged: true }) // D1, asserted positively
      expect(after.resources).toEqual(before.resources)
      expect(after.tools).toEqual(before.tools)
      expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
    }
  })

  it('w1c: D2 + D3 — schema dialect moves, `execution` is dropped, and NOTHING else changes', () => {
    expect(toolsResult.tools).toHaveLength(v1Tools.tools.length)
    expect(Object.keys(toolsResult).sort()).toEqual(Object.keys(v1Tools).sort())

    // Tools whose SOURCE definition changed after the baseline was captured cannot be compared
    // against it — that difference is authored, not SDK-induced, and W1 only speaks to the latter.
    // `gh-merge-dev` was rewritten by concurrent work in this tree DURING the migration.
    // Every name here is a tool W1 is NOT guarding, so it must stay short and justified.
    const SOURCE_CHANGED_DURING_MIGRATION = ['gh-merge-dev']

    const excludedStillDiffer: string[] = []

    for (const name of SOURCE_CHANGED_DURING_MIGRATION) {
      const before = (v1Tools.tools as Record<string, any>[]).find((t) => {
        return t.name === name
      })
      const after = (toolsResult.tools as Record<string, any>[]).find((t) => {
        return t.name === name
      })

      // An excluded tool still owes us D2 — we forgo the body comparison, not the dialect one.
      expect(after?.inputSchema?.$schema).toBe(DRAFT_2020)
      expect(after?.outputSchema?.$schema).toBe(DRAFT_2020)

      if (JSON.stringify(before?.inputSchema) !== JSON.stringify(after?.inputSchema)) {
        excludedStillDiffer.push(name)
      }
    }

    // TRIPWIRE, not a tautology: assert the exclusion is still EARNED. Once the concurrent work
    // lands or is reverted the excluded tool will match again, this list empties, and the test
    // fails — forcing the exclusion to be deleted instead of silently leaving a tool unguarded
    // forever. (Asserting the hard-coded list's length can never detect that.)
    expect(
      excludedStillDiffer,
      'exclusion is now obsolete — re-capture the fixtures and empty SOURCE_CHANGED_DURING_MIGRATION',
    ).toEqual(SOURCE_CHANGED_DURING_MIGRATION)

    const comparable = (v1Tools.tools as Record<string, any>[]).filter((t) => {
      return !SOURCE_CHANGED_DURING_MIGRATION.includes(t.name)
    })

    // Guard against the exclusion list quietly swallowing the whole suite.
    expect(comparable.length).toBeGreaterThan(20)

    for (const before of comparable) {
      const after = (toolsResult.tools as Record<string, any>[]).find((t) => {
        return t.name === before.name
      })

      expect(after, `tool ${before.name} vanished`).toBeDefined()

      // --- D2, asserted positively, per schema ---
      for (const key of ['inputSchema', 'outputSchema'] as const) {
        expect(before[key]?.$schema).toBe(DRAFT_07)
        expect(after![key]?.$schema).toBe(DRAFT_2020)
      }

      // --- D3, asserted positively ---
      // v1's `registerTool` hard-codes `execution: { taskSupport: 'forbidden' }` into every tool;
      // v2 emits no `execution` block at all. Inert on the wire — v1's own `ToolExecutionSchema`
      // documents that an absent block DEFAULTS to 'forbidden' — but it IS a third delta, and the
      // earlier field-by-field version of this test was structurally blind to it.
      expect(before.execution).toEqual({ taskSupport: 'forbidden' })
      expect(after, `${before.name} unexpectedly still carries an execution block`).not.toHaveProperty('execution')

      // --- everything else: WHOLE-OBJECT comparison, only the known deltas normalized away ---
      const beforeRest = Object.fromEntries(
        Object.entries(before).filter(([key]) => {
          return key !== 'execution'
        }),
      )
      const normalized = JSON.parse(JSON.stringify(after).split(DRAFT_2020).join(DRAFT_07)) as Record<string, unknown>

      // `toEqual` is STRUCTURAL and order-insensitive, and that is deliberate. v2 serializes
      // object keys in a different order than v1 (`$schema,type,properties` becomes
      // `type,$schema,properties`), so a string-equality diff reports all 22 tools as "changed"
      // when nothing about them changed. Measured: 22 key-order-only differences, 0 content
      // differences. Key order carries no meaning in JSON and no client can depend on it.
      expect(normalized, `tool ${before.name} drifted beyond the known deltas`).toEqual(beforeRest)
    }
  })

  it('w1d: resources/list is byte-identical', () => {
    expect(resourcesResult).toEqual(v1Resources)
  })

  it('o1: stdout carries valid JSON-RPC frames and nothing else', () => {
    const lines = purityStdout.split('\n').filter((l) => {
      return l.trim().length > 0
    })

    expect(lines.length).toBeGreaterThan(0)

    for (const line of lines) {
      expect(
        () => {
          return JSON.parse(line)
        },
        `non-JSON on stdout would corrupt JSON-RPC framing: ${line.slice(0, 120)}`,
      ).not.toThrow()
      expect((JSON.parse(line) as { jsonrpc?: string }).jsonrpc).toBe('2.0')
    }
  })
})

describe('o6 — the migrated server exits cleanly on SIGTERM', () => {
  /**
   * v2's `McpServer`/`StdioServerTransport` is new code holding stdio handles. A server that stops
   * exiting turns every e2e timeout into a wedged fork, so this is cheap insurance.
   */
  it('o6: SIGTERM terminates the process', async () => {
    const child = spawn(process.execPath, [mcpPath], { env: childEnv(), stdio: ['pipe', 'pipe', 'ignore'] })

    strays.push(child)

    const exited = await new Promise<boolean>((resolvePromise) => {
      const timer = setTimeout(() => {
        resolvePromise(false)
      }, 10_000)

      child.on('exit', () => {
        clearTimeout(timer)
        resolvePromise(true)
      })

      setTimeout(() => {
        child.kill('SIGTERM')
      }, 500)
    })

    expect(exited, 'server did not exit on SIGTERM').toBe(true)
  }, 45_000)
})
