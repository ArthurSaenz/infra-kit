import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { Client as ClientV1 } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport as StdioClientTransportV1 } from '@modelcontextprotocol/sdk/client/stdio.js'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { commandCatalog, getExposedMcpTools } from 'src/lib/command-catalog'
import { LOG_FILE_PATH } from 'src/lib/logger'

import { KILL_SWITCHES, buildMcpBundle, makeDisposableSession } from './helpers/mcp-harness'
import { TEE_PROXY_SOURCE, readTee } from './helpers/stdio-tee'
import type { TeeConnection, TeeLog } from './helpers/stdio-tee'

/**
 * @fileoverview
 *
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
 *   long-lived : shared bare v2 client (E1/E2/E3/E6/E9/O2 + E8c control), v1 client (E7),
 *                legacy gate fixture (E4/E5), pinned-modern client (E8b + E1m/E2m/E3m/E6m/E9m),
 *                pinned-modern gate fixture (E4m/E5m),
 *                pinned-modern client THROUGH THE TEE PROXY (W1a-modern + W1e + O1's modern half)
 *   short-lived: W1 raw ×2 (also carries O1's legacy half), E8a auto ×1, O6 ×1
 *
 * Every NEGOTIATED connection — E8a's `auto` client and each pinned client — additionally spawns a
 * disposable probe sibling, which the client reaps before `connect()` resolves. Those siblings are
 * real processes but are deliberately not ledgered as connections: they answer the era probe and
 * die, and they never call a tool.
 */

const FIXTURES = resolve(__dirname, 'fixtures')

let mcpPath = ''
const tmpDirs: string[] = []
const strays: ChildProcess[] = []

const childEnv = (): NodeJS.ProcessEnv => {
  return { ...process.env, ...KILL_SWITCHES }
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

/** Long-lived pinned-modern connections. Closed in `afterAll` so no served child outlives the file. */
const pinnedClients: Client[] = []

/**
 * A client PINNED to `2026-07-28`. `pin` has no legacy fallback, so `connect()` resolving is itself
 * the era claim: against a server that does not serve the modern era it REJECTS.
 *
 * `args` defaults to the bundle itself and is overridden by W1's modern lane to interpose the tee
 * proxy (`node tee.cjs <node> <mcp.js> <log>`). It is threaded through here rather than hand-rolling
 * a second client so BOTH lanes provably use the same negotiation settings.
 *
 * ONLY `versionNegotiation` IS PASSED — never `listChanged`. `_listChangedConfig` gates a
 * `subscriptions/listen` sent during connect, which the stdio ENTRY answers itself with a
 * notification that has no `id` and never passes through the instance's codec. That would make the
 * served pid's first frame un-answerable by `w1a-modern`'s conclusion assertion, for a reason with
 * nothing to do with the era.
 */
const connectPinnedModern = async (env: NodeJS.ProcessEnv = childEnv(), args?: string[]): Promise<Client> => {
  const client = new Client(
    { name: 'e2e-pinned', version: '0.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  )

  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: args ?? [mcpPath], env: env as any }),
  )

  pinnedClients.push(client)

  return client
}

/**
 * The ONE pinned-modern connection shared by `e8b` and the whole `e1m–e9m` lane.
 *
 * Memoized on the PROMISE, not on the resolved client: whichever of the two call sites runs first
 * pays for the spawn and every later caller awaits the same connection. That is what keeps the
 * modern surface lane at one long-lived spawn instead of six.
 */
let sharedPinnedModernPromise: Promise<Client> | undefined

const sharedPinnedModern = (): Promise<Client> => {
  sharedPinnedModernPromise ??= connectPinnedModern()

  return sharedPinnedModernPromise
}

/**
 * The ONE bare (unnegotiated) v2 connection, shared by the legacy surface lane and by `e8c`.
 * Memoized for the same reason as `sharedPinnedModern`.
 */
let sharedBareV2Promise: Promise<Client> | undefined

const sharedBareV2 = (): Promise<Client> => {
  sharedBareV2Promise ??= connectV2()

  return sharedBareV2Promise
}

/**
 * The era precondition every modern-lane `beforeAll` runs before yielding its client.
 *
 * WHY IT IS MANDATORY. E1m/E2m/E3m/E6m/E9m and E4m/E5m are era-INSENSITIVE by design — they assert
 * the served surface, which must not change between eras. So if the pinned connection silently came
 * up legacy, every one of them would pass against it, and the run would read as "seven greens under
 * one red — only the era assertion broke" when in fact nothing modern was exercised at all. Failing
 * the whole describe here, with a reason, is the only way that stays visible.
 */
const assertConnectionIsModern = (client: Client): void => {
  expect(
    client.getNegotiatedProtocolVersion(),
    'modern-lane precondition: this connection is not on the 2026 era, so every assertion below would be vacuous',
  ).toBe('2026-07-28')
}

/*
 * ---------------------------------------------------------------------------------------------
 * The served surface, as assertions over an arbitrary `Client`.
 *
 * Each of these is run TWICE: once over the bare legacy connection (E1/E2/E3/E6/E9, E4/E5) and once
 * over the pinned modern one (E1m/E2m/E3m/E6m/E9m, E4m/E5m). They are shared functions rather than
 * copy-pasted bodies for the reason `mcp-harness.ts:12-15` already states about this suite: a
 * duplicated subtle invariant is how one copy silently drifts and the guard it protects quietly
 * stops working. Here the drift would be worse than usual — the two copies exist precisely to be
 * compared, so a divergence between them destroys the comparison rather than merely weakening it.
 * ---------------------------------------------------------------------------------------------
 */

const assertToolsListIsCatalog = async (client: Client): Promise<void> => {
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
}

const assertReadOnlyToolCallRoundTrips = async (client: Client): Promise<void> => {
  const result = (await client.callTool({ name: 'version', arguments: {} })) as {
    isError?: boolean
    structuredContent?: Record<string, unknown>
  }

  expect(result.isError ?? false).toBe(false)
  expect(result.structuredContent).toBeTypeOf('object')
}

const assertResourcesAreListedAndReadable = async (client: Client): Promise<void> => {
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
}

const assertServerSurvivesAFailingCall = async (client: Client): Promise<void> => {
  await expect(client.callTool({ name: 'no-such-tool-xyz', arguments: {} })).rejects.toThrow()

  const after = await client.listTools()

  expect(after.tools.length).toBeGreaterThan(20)
}

const assertEveryReadOnlyToolRoundTrips = async (client: Client): Promise<void> => {
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

  const inspected: string[] = []

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

    inspected.push(name)

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

  // ANTI-VACUITY. Every assertion above sits behind `if (threw) continue`, so if every tool
  // errored this loop would inspect nothing and still pass — the test would report success
  // while measuring zero result payloads. Require that most of the set actually produced a
  // result to look at.
  expect(
    inspected.length,
    `only ${inspected.length}/${readOnly.length} read-only tools returned an inspectable result: ${inspected.join(', ')}`,
  ).toBeGreaterThanOrEqual(Math.ceil(readOnly.length / 2))
}

const assertGatedCallDoesNotExecute = async (client: Client, clearFile: string): Promise<void> => {
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
}

const assertConfirmedCallExecutes = async (client: Client, clearFile: string): Promise<void> => {
  // Round 1 mints the token the gate binds to the arguments; round 2 must return it with
  // `confirm: true` and the same arguments, or the server refuses (it never runs on a bare
  // `confirm: true` any more — that was the argument-substitution hole).
  const gate = (await client.callTool({ name: 'env-clear', arguments: {} })) as {
    structuredContent?: { confirmToken?: string }
  }
  const confirmToken = gate.structuredContent?.confirmToken

  expect(confirmToken, 'round 1 must hand out a confirmToken').toBeTypeOf('string')

  const result = (await client.callTool({ name: 'env-clear', arguments: { confirm: true, confirmToken } })) as {
    isError?: boolean
  }

  expect(result.isError ?? false).toBe(false)
  expect(existsSync(clearFile), 'confirmed call MUST have executed the handler').toBe(true)
}

beforeAll(async () => {
  const built = await buildMcpBundle('mcp-stdio-e2e-')

  tmpDirs.push(built.outDir)
  mcpPath = built.mcpPath
}, 120_000)

afterAll(async () => {
  // Closed rather than swept: a pinned connection's served child is owned by its transport, and
  // closing the client is what stops it. The SIGKILL sweep below only reaches children this file
  // spawned itself. A close that throws (already-dead child) must not mask the sweep.
  for (const client of pinnedClients) {
    try {
      await client.close()
    } catch {
      /* nothing to close — the child is already gone. */
    }
  }

  for (const child of strays) {
    if (!child.killed) child.kill('SIGKILL')
  }

  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true })
  }
})

/*
 * `sonarjs/assertions-in-tests` recognizes a literal `expect` in the test body and nothing else, so
 * every test that delegates to one of the shared `assert*` functions above reads as assertion-free
 * to it. Inlining the bodies back to satisfy it would re-create the duplication those functions
 * exist to remove — the rule and the design are simply incompatible here.
 *
 * Disabled by BLOCK, never file-wide, and re-enabled immediately after each delegating describe, so
 * a genuinely assertion-free test added anywhere else in this file is still caught. The vacuity risk
 * the rule guards against is covered instead by the anti-vacuity assertions inside the shared
 * functions themselves (see `assertEveryReadOnlyToolRoundTrips`) and by the era precondition in
 * `assertConnectionIsModern`.
 */
/* eslint-disable sonarjs/assertions-in-tests */
describe('e1–E3, E6, E9 — the served surface (shared bare v2 client)', () => {
  let client: Client

  beforeAll(async () => {
    client = await sharedBareV2()
  }, 45_000)

  it('e1: tools/list is exactly the catalog allowlist, doctor absent', async () => {
    await assertToolsListIsCatalog(client)
  }, 45_000)

  it('e2: a read-only tool call round-trips through v2 serialization', async () => {
    await assertReadOnlyToolCallRoundTrips(client)
  }, 45_000)

  it('e3: both read-only resources are listed and readable', async () => {
    await assertResourcesAreListedAndReadable(client)
  }, 45_000)

  it('e6: the long-lived server survives a failing tool call and answers the next one', async () => {
    await assertServerSurvivesAFailingCall(client)
  }, 45_000)

  it('e9: every deterministic read-only tool round-trips a well-formed v2 result', async () => {
    await assertEveryReadOnlyToolRoundTrips(client)
  }, 120_000)

  it('o2: the migrated transport path is recorded in the pino log', async () => {
    // WHAT THIS CAN AND CANNOT OBSERVE. `initLoggerMcp` uses `pino.destination({ dest })`, which is
    // ASYNC-buffered, and the entry's own signal handler ends the process with `process.exit(0)`
    // (Release 1 did this inside `setupErrorHandlers`; Release 2 moved the arms to the entry so the
    // bounded teardown can flush first) — which discards whatever is still buffered. Measured: after a graceful SIGTERM the file gains the
    // startup lines but NEVER a per-tool-call line. So asserting on "Tool execution started: …"
    // is unobservable-by-construction here, not merely slow, and any amount of polling is a
    // guaranteed flake.
    //
    // The startup lines ARE flushed, and they are emitted by `src/entry/mcp.ts` right after
    // `serveStdio(...)` returns (Release 1: after `await server.connect(transport)`) — i.e. by the
    // exact code path this migration changed. Observing them proves both that logging survived the SDK swap and that the v2
    // transport connected. That is a stronger signal than a tool-call line would have been.
    // ATTRIBUTION IS MANDATORY HERE. `LOG_FILE_PATH` is the hard-coded global
    // `/tmp/mcp-infra-kit.log` (src/lib/logger/index.ts) — it is NOT redirectable by
    // XDG_CACHE_HOME, so unlike E4/E5 and the mutation check (which sandbox only the session
    // CACHE) this observation shares a file with every other MCP server the suite spawns, and
    // `pool: 'forks'` runs other test FILES in parallel. Measured: one `vitest run src/mcp`
    // appends 11 "Server connected to transport. Ready." lines from 11 distinct pids, and up to
    // 8 of them can land inside this test's ~2s window.
    //
    // So a length-slice + `toContain` would be satisfiable entirely by OTHER processes' output —
    // a false green that cannot fail for the reason it exists. Pino stamps every line with `pid`,
    // so we filter to this child's own lines and assert on those.
    //
    // Under `serveStdio` the observed line moved from "Server connected to transport. Ready." to
    // "MCP stdio entry started.": nothing connects at startup any more, so the line now marks the
    // entry having been wired up rather than `connect()` having resolved, and it deliberately does
    // not claim readiness.
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
    const mine = grew
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as { pid?: number; msg?: string }
        } catch {
          return null
        }
      })
      .filter((entry): entry is { pid?: number; msg?: string } => {
        return entry !== null && entry.pid === child.pid
      })

    expect(mine, 'this child wrote nothing to the log file').not.toHaveLength(0)
    expect(
      mine.map((entry) => {
        return entry.msg
      }),
    ).toContain('MCP stdio entry started.')
  }, 45_000)
})
/* eslint-enable sonarjs/assertions-in-tests */

/* eslint-disable sonarjs/assertions-in-tests -- delegates to shared `assert*` functions; see the note above the first describe. */
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
    const session = makeDisposableSession()

    tmpDirs.push(session.cacheHome)
    clearFile = session.clearFile

    client = await connectV2(session.env)
  }, 45_000)

  it('e4: call 1 without `confirm` is GATED and does NOT execute (no file written)', async () => {
    await assertGatedCallDoesNotExecute(client, clearFile)
  }, 45_000)

  it('e5: call 2 with `confirm: true` actually executes (file appears)', async () => {
    await assertConfirmedCallExecutes(client, clearFile)
  }, 45_000)
})
/* eslint-enable sonarjs/assertions-in-tests */

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

describe('e8 — Release 2 serves BOTH eras from one factory', () => {
  /**
   * Release 1's job here was to keep `serveStdio` OUT. Release 2 adopts it, and the claim inverts:
   * one `serveStdio(buildOrDie)` entry must answer a modern client on 2026-07-28 AND a legacy one on
   * 2025-11-25, from the same server factory.
   *
   * The three cases are deliberately not satisfiable by one another. `e8a` and `e8b` go red if the
   * entry regresses to `server.connect()` — nothing would answer the era probe. `e8c` goes red if the
   * server ever stops serving the legacy era from that same factory. A change that broke one era to
   * serve the other cannot leave all three green.
   */
  it('e8a: an auto-negotiating client now lands on the MODERN era', async () => {
    // `mode: 'auto'` is load-bearing. `DEFAULT_VERSION_NEGOTIATION_MODE` is `'legacy'`, so a bare
    // client never probes at all and would report `'legacy'` even against a `serveStdio` server —
    // making it worthless as an era assertion. With `'auto'` the client actually probes, and the
    // probe's outcome is what is being measured: `serveStdio` ANSWERS it, so the verdict is
    // `'modern'`. Against the Release-1 entry the probe drew -32601 and the client fell back to
    // `'legacy'`, which is exactly the value this now refuses to accept.
    const client = new Client({ name: 'e2e-auto', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } })

    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [mcpPath], env: childEnv() as any }),
    )

    expect(client.getProtocolEra()).toBe('modern')

    await client.close()
  }, 45_000)

  it('e8b: a client PINNED to 2026-07-28 connects, on era `modern` and revision 2026-07-28', async () => {
    // `pin` has NO legacy fallback, so `connect()` resolving is already half the claim: against a
    // server that does not serve the modern era it REJECTS, which is what Release 1 asserted here.
    //
    // LONG-LIVED ON PURPOSE. This one connection is the driver for the whole `e1m–e9m` lane and is
    // reused rather than re-opened, keeping the modern surface re-runs at one spawn instead of six.
    // It is closed in `afterAll`.
    const pinned = await sharedPinnedModern()

    expect(pinned.getProtocolEra()).toBe('modern')
    expect(pinned.getNegotiatedProtocolVersion()).toBe('2026-07-28')
  }, 45_000)

  it('e8c: the bare connection still negotiates 2025-11-25 — legacy is served from the same factory', async () => {
    // ASSERT THE REVISION, NEVER THE ERA, ON A BARE CLIENT. `DEFAULT_VERSION_NEGOTIATION_MODE` is
    // `'legacy'` (see e8a), so `getProtocolEra()` on a bare client returns `'legacy'` against ANY
    // server — it is a property of the client object, not an observation of the bundle under test,
    // and asserting it here would be a tautology that cannot fail.
    //
    // `getNegotiatedProtocolVersion()` is different: it comes off the SERVER's own `initialize`
    // result. It moves the moment the server stops serving the legacy era, which is precisely the
    // regression `e8a`/`e8b` cannot detect.
    //
    // Reuses spawn 1 — the same bare client the legacy surface lane drives.
    const bare = await sharedBareV2()

    expect(bare.getNegotiatedProtocolVersion()).toBe('2025-11-25')
  }, 45_000)
})

/* eslint-disable sonarjs/assertions-in-tests -- delegates to shared `assert*` functions; see the note above the first describe. */
describe('e1m–E9m — the served surface over a PINNED MODERN connection', () => {
  /**
   * The same five assertions as E1/E2/E3/E6/E9, re-run over the 2026 era. They are era-INSENSITIVE
   * by design — the served surface must not change between eras — so what this lane proves is
   * exactly that: nothing about the catalog, the tool results, the resources, or the error recovery
   * moved when the era did.
   */
  let client: Client

  beforeAll(async () => {
    client = await sharedPinnedModern()

    assertConnectionIsModern(client)
  }, 45_000)

  it('e1m: tools/list is exactly the catalog allowlist, doctor absent', async () => {
    await assertToolsListIsCatalog(client)
  }, 45_000)

  it('e2m: a read-only tool call round-trips through modern serialization', async () => {
    await assertReadOnlyToolCallRoundTrips(client)
  }, 45_000)

  it('e3m: both read-only resources are listed and readable', async () => {
    await assertResourcesAreListedAndReadable(client)
  }, 45_000)

  it('e6m: the long-lived server survives a failing tool call and answers the next one', async () => {
    await assertServerSurvivesAFailingCall(client)
  }, 45_000)

  it('e9m: every deterministic read-only tool round-trips a well-formed modern result', async () => {
    await assertEveryReadOnlyToolRoundTrips(client)
  }, 120_000)
})

describe('e4m/E5m — the confirm gate over a PINNED MODERN connection', () => {
  /**
   * A SECOND pinned connection, against a FRESH disposable session. It cannot reuse either the
   * legacy gate fixture — E5 writes `env-clear.sh` into it, so E4m would start dirty and its
   * "must not exist" assertion would be false for the wrong reason — or `e8b`'s connection, which
   * runs against the shared cache and has no `env-clear.sh` to clear.
   *
   * TWO PROCESSES OPEN THIS FIXTURE, not one: a pinned client spawns a disposable probe sibling
   * alongside the served child. The sibling only answers the era probe and is reaped before
   * `connect()` resolves — it calls no tool, so it cannot be what writes `env-clear.sh`, and the
   * filesystem assertions below stay attributable to the served connection.
   */
  let client: Client
  let clearFile = ''

  beforeAll(async () => {
    const session = makeDisposableSession()

    tmpDirs.push(session.cacheHome)
    clearFile = session.clearFile

    client = await connectPinnedModern(session.env)

    assertConnectionIsModern(client)
  }, 45_000)

  it('e4m: call 1 without `confirm` is GATED and does NOT execute (no file written)', async () => {
    await assertGatedCallDoesNotExecute(client, clearFile)
  }, 45_000)

  it('e5m: call 2 with `confirm: true` actually executes (file appears)', async () => {
    await assertConfirmedCallExecutes(client, clearFile)
  }, 45_000)
})
/* eslint-enable sonarjs/assertions-in-tests */

describe('w1 — differential wire compatibility against the pre-migration v1 baseline', () => {
  /**
   * The plan's central confidence artifact. It asserts every KNOWN delta POSITIVELY (rather than
   * merely normalizing it away) and fails on any UNNAMED difference.
   */
  //   D1  initialize.capabilities.prompts  {} -> { listChanged: true }              legacy + modern
  //   D2  tool $schema  draft-07 -> draft-2020-12                                   legacy + modern
  //   D3  tools[].execution  { taskSupport: 'forbidden' } -> absent                 legacy + modern
  //   D4  local-deploy `skipPreflight` removed (AUTHORED, not SDK-induced)          legacy + modern
  //   D5  result.resultType -> 'complete'                                           modern only
  //   D6  result.ttlMs -> 0, result.cacheScope -> 'private'                         modern only
  //   D7  result._meta['io.modelcontextprotocol/serverInfo'] stamped                modern only
  //   D8  nullable schema  anyOf[{string},{null}] -> type: ['string','null']        legacy + modern
  //   D9  tools[].inputSchema.properties.confirmToken on gated tools (AUTHORED)     legacy + modern
  //   D10 tools[].title (AUTHORED)                                                  legacy + modern
  //   D11 tools[].annotations (AUTHORED)                                            legacy + modern
  // Why UNNAMED differences must fail: a normalization broad enough to swallow a known delta is
  // the same hole an unnoticed one would slip through. Only the named deltas are normalized away
  // before the whole-object comparison, and each is asserted positively FIRST so the normalization
  // can never be what makes the test pass. `serverInfo` is compared by `.name` plus key-set; its
  // `.version` is deliberately not compared, because it moves on every release bump.
  //
  // D8 IS NOT AN ERA DELTA. It arrived with the zod `^4.4.3 -> ^4.5.2` bump in the 0.4.0 commit
  // (e15aec3): `z.toJSONSchema` changed how it renders a nullable, so it moves on BOTH lanes and
  // would have broken `w1c` with or without this task. It is normalized on the BASELINE side only,
  // semantically (see `normalizeNullableAnyOfInPlace`), and asserted positively on the served side.
  const v1Init = JSON.parse(readFileSync(join(FIXTURES, 'initialize-baseline.v1.json'), 'utf8')) as Record<string, any>
  const v1Tools = JSON.parse(readFileSync(join(FIXTURES, 'tools-list-baseline.v1.json'), 'utf8')) as Record<string, any>

  /**
   * D4 — an AUTHORED delta, normalized at load like D2 and D3 rather than excluded. The fixture on
   * disk is NOT modified.
   */
  // `skipPreflight` was removed from both local-deploy tools when `--skip-preflight` was deleted:
  // the waiver's only reachable effect had been waiving the clean-tree check for a SHARED env,
  // which `docs/local-deploy-design.md` check 5 forbids, so correcting that left it a no-op
  // everywhere.
  //
  // Handled at load for three reasons the alternatives fail on:
  //  - Re-capturing the fixture would destroy its value — it is evidence captured BEFORE any
  //    dependency change (see the file header) and is the reference the confirm-gate defect is
  //    proven against.
  //  - Adding the two tools to SOURCE_CHANGED_DURING_MIGRATION would leave the two most
  //    destructive tools in the catalog permanently unguarded by W1, and 23 − 3 = 20 comparable
  //    also trips the `toBeGreaterThan(20)` suite-swallowing guard below.
  //  - Normalizing one known, named field keeps the whole-object comparison intact for everything
  //    else about those tools, which is exactly the contract D2 and D3 already operate under.
  // Names captured BEFORE the delete, so the positive assertion in `w1c-pre` below has something to
  // check. Asserting there rather than here keeps the claim inside a test case, which is both the lint
  // rule and the honest place for it.
  const d4Carriers = (v1Tools.tools as Record<string, any>[])
    .filter((tool) => {
      return tool.inputSchema?.properties?.skipPreflight !== undefined
    })
    .map((tool) => {
      delete tool.inputSchema.properties.skipPreflight

      return tool.name as string
    })
  /**
   * D9 — an AUTHORED delta, handled like D4: the confirm gate now binds round 2 to round 1 with a
   * `confirmToken`, which every gated tool accepts in `inputSchema` (`src/mcp/tools/index.ts`).
   * The baseline pre-dates the token and carries it on no tool, so it is stripped from a COPY of
   * the SERVED list at compare time — after `w1c-pre-d9` and the in-comparison assertion have
   * proven it sits on exactly the gated set, so the strip can never be what makes w1c pass.
   */
  const gatedToolNames = getExposedMcpTools()
    .filter((tool) => {
      return tool.requiresHumanConfirm === true
    })
    .map((tool) => {
      return tool.name
    })
    .sort()

  const d9Carriers = (list: Record<string, any>): string[] => {
    return (list.tools as Record<string, any>[])
      .filter((tool) => {
        return tool.inputSchema?.properties?.confirmToken !== undefined
      })
      .map((tool) => {
        return tool.name as string
      })
      .sort()
  }

  /**
   * D10/D11 — AUTHORED deltas in the same shape as D9: `title` and `annotations` are registered from
   * the catalog (`src/mcp/tools/index.ts`), and the baseline pre-dates both. Expected sets are
   * computed from `getExposedMcpTools()` rather than written as literals, exactly as `gatedToolNames`
   * is, so the assertion tracks the catalog instead of a second hand-maintained copy of it.
   */
  // Element type derived from the function rather than importing `RegistrableMcpTool`: the barrel does
  // not re-export it, and widening the barrel for one test predicate is not worth it.
  const exposedNamesWhere = (predicate: (tool: ReturnType<typeof getExposedMcpTools>[number]) => boolean): string[] => {
    return getExposedMcpTools()
      .filter((tool) => {
        return predicate(tool)
      })
      .map((tool) => {
        return tool.name
      })
      .sort()
  }

  const readOnlyToolNames = exposedNamesWhere((tool) => {
    return tool.annotations.readOnlyHint
  })

  const writeToolNames = exposedNamesWhere((tool) => {
    return !tool.annotations.readOnlyHint
  })

  // Every exposed tool must carry both keys, so the two hint sets partition the whole surface.
  const allToolNames = exposedNamesWhere(() => {
    return true
  })

  const namesWhere = (list: Record<string, any>, predicate: (tool: Record<string, any>) => boolean): string[] => {
    return (list.tools as Record<string, any>[])
      .filter((tool) => {
        return predicate(tool)
      })
      .map((tool) => {
        return tool.name as string
      })
      .sort()
  }

  const d10Carriers = (list: Record<string, any>): string[] => {
    return namesWhere(list, (tool) => {
      return typeof tool.title === 'string' && tool.title.length > 0
    })
  }

  const d11Carriers = (list: Record<string, any>): string[] => {
    return namesWhere(list, (tool) => {
      return tool.annotations !== undefined
    })
  }

  /**
   * Strips every AUTHORED delta (D9, D10, D11) from a COPY of the served list. One helper rather than
   * three, and shared by both lanes: `w1c` and `w1e` exist to be compared, so a divergence between
   * two copies of the strip would destroy the comparison instead of merely weakening it.
   */
  const withoutAuthoredDeltas = (list: Record<string, any>): Record<string, any> => {
    const copy = JSON.parse(JSON.stringify(list)) as Record<string, any>

    for (const tool of copy.tools as Record<string, any>[]) {
      delete tool.inputSchema?.properties?.confirmToken
      delete tool.title
      delete tool.annotations
    }

    return copy
  }

  const v1Resources = JSON.parse(readFileSync(join(FIXTURES, 'resources-list-baseline.v1.json'), 'utf8')) as Record<
    string,
    any
  >

  const DRAFT_07 = 'http://json-schema.org/draft-07/schema#'
  const DRAFT_2020 = 'https://json-schema.org/draft/2020-12/schema'

  /** The two `_meta` keys a modern client stamps on every outbound request — the envelope claim. */
  const PROTOCOL_VERSION_META = 'io.modelcontextprotocol/protocolVersion'
  const CLIENT_CAPABILITIES_META = 'io.modelcontextprotocol/clientCapabilities'
  /** The key `stampServerInfoMeta` adds to every modern result — D7. */
  const SERVER_INFO_META = 'io.modelcontextprotocol/serverInfo'

  /** A schema node that is nothing but `{ type: '<something>' }`. Returns that type, or undefined. */
  const bareType = (member: unknown): string | undefined => {
    if (member === null || typeof member !== 'object' || Array.isArray(member)) return undefined

    const node = member as Record<string, unknown>

    if (Object.keys(node).length !== 1 || typeof node.type !== 'string') return undefined

    return node.type
  }

  /**
   * D8's shape test: an `anyOf` of EXACTLY two bare members, one `{ type: 'null' }` and one
   * `{ type: T }`. Returns `T`, or `undefined` when the node is not that shape.
   *
   * Deliberately narrow. `gh-merge-dev.versions` is a genuine `string | string[]` union that also
   * renders as an `anyOf`, and it MUST survive untouched — a normalizer that collapsed it too would
   * be erasing a real difference under D8's name, which is the exact failure mode PM-C describes.
   */
  const nullableAnyOfMember = (value: unknown): string | undefined => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined

    const members = (value as Record<string, unknown>).anyOf

    if (!Array.isArray(members) || members.length !== 2) return undefined

    const types = members.map(bareType)
    const nonNull = types.filter((type) => {
      return type !== undefined && type !== 'null'
    })

    if (types.includes(undefined) || nonNull.length !== 1) return undefined

    return nonNull[0]
  }

  /**
   * Every `properties.<name>` node in a tool's schemas carrying D8's nullable `anyOf`, reported as
   * `<tool>.<property>:<non-null type>`. Captured BEFORE the normalization below rewrites them, so
   * `w1c-pre-d8` has something to assert — the same discipline `d4Carriers` follows.
   */
  const eachPropertyNode = (tool: Record<string, any>, visit: (name: string, node: unknown) => void): void => {
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) walk(item)

        return
      }

      if (value === null || typeof value !== 'object') return

      const node = value as Record<string, any>
      const properties = node.properties as unknown

      if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
        for (const [name, sub] of Object.entries(properties as Record<string, unknown>)) visit(name, sub)
      }

      for (const nested of Object.values(node)) walk(nested)
    }

    walk(tool.inputSchema)
    walk(tool.outputSchema)
  }

  const collectD8Carriers = (tool: Record<string, any>): string[] => {
    const carriers: string[] = []

    eachPropertyNode(tool, (name, node) => {
      const type = nullableAnyOfMember(node)

      if (type !== undefined) carriers.push(`${tool.name}.${name}:${type}`)
    })

    return carriers
  }

  /** Every schema node reachable as `properties.<wanted>` in a tool, at any depth. */
  const propertyNodes = (tool: Record<string, any>, wanted: string): Record<string, any>[] => {
    const nodes: Record<string, any>[] = []

    eachPropertyNode(tool, (name, node) => {
      if (name === wanted && node !== null && typeof node === 'object') nodes.push(node as Record<string, any>)
    })

    return nodes
  }

  const d8Carriers = (v1Tools.tools as Record<string, any>[]).flatMap((tool) => {
    return collectD8Carriers(tool)
  })

  /**
   * D8 — normalized on the BASELINE side only, semantically: `anyOf: [{type:T},{type:'null'}]`
   * becomes `type: [T, 'null']` wherever it appears, every sibling key (`description` and the rest)
   * preserved. The two forms mean the same thing in JSON Schema, and the served side is asserted
   * positively to carry the second one before any comparison runs.
   *
   * Like D4, handled here at load rather than by re-capturing the fixture, which would destroy its
   * value as evidence captured before any dependency change. The fixture on disk is NOT modified.
   */
  const normalizeNullableAnyOfInPlace = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) normalizeNullableAnyOfInPlace(item)

      return
    }

    if (value === null || typeof value !== 'object') return

    const node = value as Record<string, any>
    const type = nullableAnyOfMember(node)

    if (type !== undefined) {
      delete node.anyOf
      node.type = [type, 'null']
    }

    for (const nested of Object.values(node)) normalizeNullableAnyOfInPlace(nested)
  }

  normalizeNullableAnyOfInPlace(v1Tools)

  /**
   * D5/D6/D7 removed from a COPY, so the rest of a modern result can be compared whole.
   *
   * `_meta` loses only the `serverInfo` key and survives if anything else is in it — an eighth delta
   * hiding inside `_meta` must still reach the comparison and fail it. Deleting the whole block
   * would be the broad normalization PM-C warns about.
   */
  const stripModernStamps = (result: Record<string, any>): Record<string, any> => {
    const copy = JSON.parse(JSON.stringify(result)) as Record<string, any>

    delete copy.resultType
    delete copy.ttlMs
    delete copy.cacheScope

    const meta = copy._meta as Record<string, unknown> | undefined

    if (meta !== undefined) {
      delete meta[SERVER_INFO_META]

      if (Object.keys(meta).length === 0) delete copy._meta
    }

    return copy
  }

  /** The result the server sent for the one request with this method, taken off a single pid. */
  const resultFor = (connection: TeeConnection, method: string): Record<string, any> => {
    const request = connection.inbound.find((frame) => {
      return frame.method === method && frame.id !== undefined
    })

    if (request === undefined) throw new Error(`w1 modern lane: pid ${connection.pid} never received '${method}'`)

    const answer = connection.outbound.find((frame) => {
      return frame.id === request.id && frame.result !== undefined
    })

    if (answer === undefined) throw new Error(`w1 modern lane: no result for '${method}' (id ${String(request.id)})`)

    return answer.result as Record<string, any>
  }

  let init2025: Record<string, any>
  let init2026: Record<string, any>
  let toolsResult: Record<string, any>
  let resourcesResult: Record<string, any>
  let purityStdout = ''

  /** The modern lane: ONE pinned connection driven through the tee proxy, read back off the wire. */
  let modernTee: TeeLog
  let modernNegotiatedVersion: string | undefined
  let modernTools: Record<string, any>
  let modernResources: Record<string, any>

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

    // --- the MODERN lane -------------------------------------------------------------------
    //
    // A pinned v2 client whose transport runs `node tee.cjs <node> <mcp.js> <log>` rather than the
    // bundle directly, so every frame in both directions is captured AS IT CROSSED THE PIPE. The
    // proxy is CommonJS and must be written to a `.cjs` file: this package is `"type": "module"`.
    //
    // TWO CHILDREN RUN THROUGH THIS ONE PROXY, sequentially — the disposable negotiation sibling
    // and then the served connection. They cannot interleave (the sibling is reaped before the
    // served child starts), and `servedConnection()` separates them by an EXACT RULE: the sibling
    // is the pid that was asked `server/discover`. Never by counting frames.
    const teeDir = mkdtempSync(join(tmpdir(), 'mcp-tee-'))
    const teePath = join(teeDir, 'tee-proxy.cjs')
    const logPath = join(teeDir, 'wire.log')

    tmpDirs.push(teeDir)
    writeFileSync(teePath, TEE_PROXY_SOURCE)
    writeFileSync(logPath, '')

    const session = makeDisposableSession()

    tmpDirs.push(session.cacheHome)

    const modern = await connectPinnedModern(session.env, [teePath, process.execPath, mcpPath, logPath])

    modernNegotiatedVersion = modern.getNegotiatedProtocolVersion()

    // Issued AFTER connect so the frames land on the SERVED pid, not on the probe sibling. The
    // results below are read back off the tee log rather than from these return values: the claim
    // is about what the server ENCODED, not about what the client's decoder handed back.
    await modern.listTools()
    await modern.listResources()

    // Safe to read immediately: the proxy's `appendFileSync` runs in its stdout `data` handler,
    // which is registered before the `pipe`, so a frame is in the log before the client can see it.
    modernTee = readTee(logPath)

    const served = modernTee.servedConnection()

    modernTools = resultFor(served, 'tools/list')
    modernResources = resultFor(served, 'resources/list')
  }, 120_000)

  it('w1a: negotiated protocolVersion and serverInfo are unchanged for both probed versions', () => {
    expect(init2025.protocolVersion).toBe(v1Init['2025-06-18'].protocolVersion)
    expect(init2026.protocolVersion).toBe(v1Init['2026-07-28'].protocolVersion)

    // STILL 2025-11-25 AFTER THE ERA FLIP, and that is the right answer rather than a leftover.
    //
    // `classifyOpeningMessage` keys the era off the `_meta` ENVELOPE CLAIM — the two-key
    // `protocolVersion` + `clientCapabilities` pair — and never off `params.protocolVersion`, which
    // it reads only into a diagnostic label. So a raw `initialize` NAMING 2026-07-28 without an
    // envelope is a LEGACY opening, and the legacy arm answers with the 2025-era ceiling. The
    // version a client asks for buys it nothing; the envelope is the whole discriminator.
    //
    // The modern lane is `w1a-modern` below, which gets there with a real envelope from a real
    // client rather than by asking harder.
    expect(init2026.protocolVersion).toBe('2025-11-25')

    expect(init2025.serverInfo.name).toBe(v1Init['2025-06-18'].serverInfo.name)
    expect(init2026.serverInfo.name).toBe(v1Init['2026-07-28'].serverInfo.name)

    // A whole KEY-SET check, not just the fields we thought to name. A field appearing or
    // vanishing is exactly the class of delta a hand-picked field list cannot see.
    expect(Object.keys(init2025).sort()).toEqual(Object.keys(v1Init['2025-06-18']).sort())
    expect(Object.keys(init2026).sort()).toEqual(Object.keys(v1Init['2026-07-28']).sort())
  })

  it('w1a-modern: an enveloped non-discover request draws a MODERN-encoded answer from the served pid', () => {
    /**
     * The counterpart to `w1a`, and the one place the era flip itself is proven on the wire.
     *
     * Three assertions, every one of them on a value the SERVER authored, over a real pinned v2
     * client against the shipped bundle rather than a hand-rolled envelope. ASSERTIONS 2 AND 3 ARE
     * LOAD-BEARING ONLY TOGETHER — DO NOT SEPARATE THEM. `listChanged` MUST STAY OFF THIS CLIENT.
     */
    // Why the conjunction: assertion 2 alone observes the served pid's INBOUND frame, whose method
    // and `_meta` keys are values the CLIENT authored — precisely the class of assertion that makes
    // an era claim vacuous. The proof is that a non-`server/discover` enveloped stimulus DREW a
    // modern-encoded answer. A future reader who deletes assertion 3 as "redundant with w1e" would
    // leave assertion 2 as a pure client-property assertion and relapse to exactly that defect.
    //
    // Why `listChanged` must stay off: `_listChangedConfig` is set only from the constructor
    // option, and the `subscriptions/listen` sent during connect sits inside that guard. Add
    // `listChanged` and the served pid's first frame becomes `subscriptions/listen`, which the
    // stdio ENTRY answers itself — `tryServeListen` replies with a NOTIFICATION carrying no `id`,
    // which never passes through the instance's codec and so can never carry `resultType`.
    // Assertion 3 would go red for a reason with nothing to do with the era, and the natural repair
    // would be to weaken it. Pinning both assertions to the first REQUEST rather than to the first
    // frame of any kind keeps them robust if that option is ever added.
    // 1. THE REVISION, server-derived: read through `client.getNegotiatedProtocolVersion()`, which
    //    the client fills from `result.version` of the sibling's discover result — so it is
    //    server-authored transitively, observed on the sibling rather than the served pid, and
    //    that is fine (the same frame sits in the tee log under the sibling pid). It cannot pass vacuously: `pin` has no fallback, so against a server that stopped
    //    serving the modern era `connect()` rejects and the `beforeAll` fails first.
    expect(modernNegotiatedVersion).toBe('2026-07-28')

    const served = modernTee.servedConnection()

    // 2. PREMISE — the stimulus. The first request the served pid was asked is NOT `server/discover`
    //    (the whole discovery exchange happened on the sibling) and it carries the two-key envelope
    //    claim. Classification is method-agnostic: the envelope alone opens the modern era.
    const firstRequest = served.inbound.find((frame) => {
      return frame.id !== undefined
    })

    expect(firstRequest, `served pid ${served.pid} was never sent a request`).toBeDefined()
    expect(firstRequest?.method).not.toBe('server/discover')

    const envelope = (firstRequest?.params as Record<string, any> | undefined)?._meta as
      Record<string, unknown> | undefined

    expect(envelope?.[PROTOCOL_VERSION_META], 'the stimulus carried no protocolVersion claim').toBeDefined()
    expect(envelope?.[CLIENT_CAPABILITIES_META], 'the stimulus carried no clientCapabilities claim').toBeDefined()

    // 3. CONCLUSION — the response. The server's answer to THAT SAME frame carries `resultType`.
    //    D5 is a server-authored era discriminator: there are exactly two codecs, and the legacy
    //    one's `encodeResult` applies none of the four modern transforms — it only re-wraps
    //    `tools/list` for the legacy tool shape. A `resultType` key on the served pid is therefore
    //    producible ONLY by the modern encode path.
    const answer = served.outbound.find((frame) => {
      return frame.id === firstRequest?.id && frame.result !== undefined
    })

    expect(answer, `no result for the first request (id ${String(firstRequest?.id)})`).toBeDefined()
    expect(
      answer?.result as Record<string, unknown>,
      'the answer to an enveloped request was NOT modern-encoded',
    ).toHaveProperty('resultType')
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

  it('w1c-pre: D4 — the baseline really carried `skipPreflight`, on exactly the two local-deploy tools', () => {
    // The positive half of D4, held to the same bar as D2 and D3: the normalization must never be what
    // makes w1c pass. Without this, the delete above decays into a silent no-op the moment the fixture
    // is re-captured, and D4's documentation becomes a lie about the file it describes.
    expect(d4Carriers).toEqual(['local-deploy-all', 'local-deploy-selected'])
  })

  it('w1c-pre-d9: D9 — the baseline carries `confirmToken` on no tool, and the gated set is non-empty', () => {
    // The positive half of D9: the strip in `assertToolsMatchBaseline` is only honest while the
    // baseline genuinely pre-dates the token and there is a gated set for the served side to carry it on.
    expect(d9Carriers(v1Tools)).toEqual([])
    expect(gatedToolNames.length).toBeGreaterThan(0)
  })

  it('w1c-pre-d10-d11: D10/D11 — the baseline carries neither `title` nor `annotations` on any tool', () => {
    // The positive half of D10 and D11. The strip in `assertToolsMatchBaseline` is honest only while
    // the baseline genuinely pre-dates both keys; if the fixture is ever re-captured, this reds loudly
    // instead of the strip quietly decaying into a no-op that hides a real difference.
    expect(d10Carriers(v1Tools)).toEqual([])
    expect(d11Carriers(v1Tools)).toEqual([])
    // Both carrier sets must be non-empty on the served side for the comparison to mean anything.
    expect(readOnlyToolNames.length).toBeGreaterThan(0)
    expect(writeToolNames.length).toBeGreaterThan(0)
  })

  it('w1c-pre-d8: D8 — the baseline really renders nullables as `anyOf`, on seven named fields', () => {
    // The positive half of D8, held to the same bar as D2/D3/D4: the normalization must never be
    // what makes the comparison pass. Captured BEFORE `normalizeNullableAnyOfInPlace` rewrote them,
    // so this decays into a no-op only if someone re-captures the fixture — and then it fails loudly
    // rather than silently guarding nothing.
    //
    // `gh-merge-dev.versions` is deliberately ABSENT: it is a genuine `string | string[]` union that
    // also renders as an `anyOf`, and its survival is the proof the normalizer is narrow.
    expect([...d8Carriers].sort()).toEqual([
      'dev-status.contextDir:string',
      'dev-status.writtenAt:string',
      'env-status.sessionConfig:string',
      'env-status.sessionLoadedAt:string',
      'env-status.sessionProject:string',
      'gh-release-list.description:string',
      'worktrees-list.description:string',
    ])
  })

  /**
   * D8 asserted POSITIVELY on the SERVED side, for exactly the fields the baseline carried.
   *
   * D8 is NOT an era delta — it came from the zod `^4.4.3 -> ^4.5.2` bump in the 0.4.0 commit
   * (e15aec3), where `z.toJSONSchema` changed how it renders a nullable — so this runs on BOTH
   * lanes. Without it, the baseline-side rewrite would be an unwitnessed assumption about what the
   * server now emits, which is exactly the hole PM-C names.
   */
  const assertD8OnServed = (servedTools: Record<string, any>): void => {
    for (const carrier of d8Carriers) {
      const [toolName = '', rest = ''] = carrier.split('.')
      const [property = '', type = ''] = rest.split(':')

      const tool = (servedTools.tools as Record<string, any>[]).find((t) => {
        return t.name === toolName
      })

      expect(tool, `D8 carrier ${carrier}: that tool is not in the served list`).toBeDefined()

      const rendered = propertyNodes(tool!, property)

      expect(rendered.length, `D8 carrier ${carrier}: no such property in the served schema`).toBeGreaterThan(0)
      expect(
        rendered.some((node) => {
          return Array.isArray(node.type) && node.type.length === 2 && node.type[0] === type && node.type[1] === 'null'
        }),
        `D8 carrier ${carrier}: the served schema does not render the nullable as type: ["${type}","null"]`,
      ).toBe(true)
    }
  }

  /**
   * The whole-object `tools/list` differential, run by BOTH `w1c` (legacy lane) and `w1e` (modern
   * lane, after its own three deltas have been asserted and stripped).
   *
   * Shared rather than copy-pasted for the reason this file already states about the served-surface
   * helpers: the two lanes exist precisely to be compared, so a divergence between two copies would
   * destroy the comparison rather than merely weaken it.
   */
  const assertToolsMatchBaseline = (servedToolsRaw: Record<string, any>): void => {
    // D9 asserted POSITIVELY on the served side before it is normalized away: the token property
    // must sit on exactly the gated tools — no more (an ungated tool would be advertising a round-2
    // it never runs) and no fewer (a gated tool without it refuses every confirmation as absent).
    expect(d9Carriers(servedToolsRaw)).toEqual(gatedToolNames)

    // D10/D11 asserted POSITIVELY on the served side, before the strip, on the same principle: every
    // tool must carry a non-empty `title` and an `annotations` object, and the two hint carrier sets
    // must be exactly the catalog's read-only set and its complement. Anything less would let the
    // strip below be what makes the comparison pass.
    expect(d10Carriers(servedToolsRaw)).toEqual(allToolNames)
    expect(d11Carriers(servedToolsRaw)).toEqual(allToolNames)

    expect(
      namesWhere(servedToolsRaw, (tool) => {
        return tool.annotations?.readOnlyHint === true
      }),
    ).toEqual(readOnlyToolNames)

    expect(
      namesWhere(servedToolsRaw, (tool) => {
        return tool.annotations?.destructiveHint === true
      }),
    ).toEqual(writeToolNames)

    // `annotations.title` must stay unset — the top-level `title` is the one hosts should read, and
    // two titles are a divergence waiting to happen.
    expect(
      namesWhere(servedToolsRaw, (tool) => {
        return tool.annotations?.title !== undefined
      }),
    ).toEqual([])

    const servedTools = withoutAuthoredDeltas(servedToolsRaw)

    expect(servedTools.tools).toHaveLength(v1Tools.tools.length)
    expect(Object.keys(servedTools).sort()).toEqual(Object.keys(v1Tools).sort())

    assertD8OnServed(servedTools)

    // Tools whose SOURCE definition changed after the baseline was captured cannot be compared
    // against it — that difference is authored, not SDK-induced, and W1 only speaks to the latter.
    // `gh-merge-dev` was rewritten by concurrent work in this tree DURING the migration.
    // `worktrees-remove` / `worktrees-sync` gained `failedWorktrees` in their outputSchema (and a
    // matching description) when failed removals stopped being reported as success — authored,
    // post-baseline, and not what W1 guards.
    // Every name here is a tool W1 is NOT guarding, so it must stay short and justified.
    const SOURCE_CHANGED_DURING_MIGRATION = ['gh-merge-dev', 'worktrees-remove', 'worktrees-sync']

    // Recursively sort object keys so comparison is order-insensitive: v2 emits keys in a
    // different order than v1, which is meaningless in JSON but makes raw string equality lie.
    const canonicalize = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(canonicalize)

      if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
          Object.keys(value as Record<string, unknown>)
            .sort()
            .map((key) => {
              return [key, canonicalize((value as Record<string, unknown>)[key])]
            }),
        )
      }

      return value
    }

    /**
     * The AUTHORED shape of a schema: SDK-induced deltas (D2's dialect URI) normalized out and key
     * order canonicalized, so what remains is only what a human wrote in the tool definition.
     */
    const authoredShape = (schema: unknown): string => {
      return JSON.stringify(canonicalize(JSON.parse(JSON.stringify(schema).split(DRAFT_2020).join(DRAFT_07))))
    }

    // Everything a human authors on a tool: input + output schema and the description. An earlier
    // version looked at inputSchema alone, which made an outputSchema-only change (the
    // `failedWorktrees` field) look like an obsolete exclusion.
    const authoredTool = (tool: Record<string, any> | undefined): string => {
      return authoredShape({
        description: tool?.description,
        inputSchema: tool?.inputSchema,
        outputSchema: tool?.outputSchema,
      })
    }

    const differsFromBaseline = (name: string): boolean => {
      const before = (v1Tools.tools as Record<string, any>[]).find((t) => {
        return t.name === name
      })
      const after = (servedTools.tools as Record<string, any>[]).find((t) => {
        return t.name === name
      })

      return authoredTool(before) !== authoredTool(after)
    }

    // SELF-CHECK — the one-line proof the predicate actually discriminates. An earlier version
    // compared RAW `inputSchema` JSON, and since D2 makes `$schema` differ for EVERY tool, it
    // reported all 23 as "still differing" and could never fire. If this assertion fails, the
    // tripwire below is dead again regardless of what its comment claims.
    // Pick a control with a NON-EMPTY inputSchema. The first non-excluded tool happens to have
    // `properties: {}`, which would exercise only `$schema` normalization and three top-level
    // keys — leaving the self-check green if a future SDK delta were confined to populated
    // schemas. A populated control makes the self-check representative of the real comparison.
    const unchangedControl = (v1Tools.tools as Record<string, any>[]).find((t) => {
      return (
        !SOURCE_CHANGED_DURING_MIGRATION.includes(t.name) && Object.keys(t.inputSchema?.properties ?? {}).length > 0
      )
    })!.name

    expect(
      differsFromBaseline(unchangedControl),
      `predicate is tautological — it reports the unchanged tool "${unchangedControl}" as differing`,
    ).toBe(false)

    const excludedStillDiffer = SOURCE_CHANGED_DURING_MIGRATION.filter((name) => {
      const after = (servedTools.tools as Record<string, any>[]).find((t) => {
        return t.name === name
      })

      // An excluded tool still owes us D2 — we forgo the body comparison, not the dialect one.
      expect(after?.inputSchema?.$schema).toBe(DRAFT_2020)
      expect(after?.outputSchema?.$schema).toBe(DRAFT_2020)

      return differsFromBaseline(name)
    })

    // TRIPWIRE: assert the exclusion is still EARNED. Once the concurrent work lands or is
    // reverted, the excluded tool's AUTHORED shape matches the baseline again, this list empties,
    // and the test fails — forcing the exclusion to be deleted rather than silently leaving a tool
    // unguarded forever. The self-check above is what keeps this from degenerating into a
    // tautology; without it, a predicate that is always-true passes here and guards nothing.
    expect(
      excludedStillDiffer,
      'exclusion is now obsolete — re-capture the fixtures and empty SOURCE_CHANGED_DURING_MIGRATION',
    ).toEqual(SOURCE_CHANGED_DURING_MIGRATION)

    const comparable = (v1Tools.tools as Record<string, any>[]).filter((t) => {
      return !SOURCE_CHANGED_DURING_MIGRATION.includes(t.name)
    })

    // Guard against the exclusion list quietly swallowing the whole suite (23 tools, ≤ 3 excluded).
    expect(comparable.length).toBeGreaterThanOrEqual(20)

    for (const before of comparable) {
      const after = (servedTools.tools as Record<string, any>[]).find((t) => {
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
  }

  /* eslint-disable-next-line sonarjs/assertions-in-tests -- delegates to `assertToolsMatchBaseline` */
  it('w1c: D2 + D3 + D8 — dialect moves, `execution` is dropped, and NOTHING else changes', () => {
    assertToolsMatchBaseline(toolsResult)
  })

  it('w1d: resources/list is byte-identical', () => {
    expect(resourcesResult).toEqual(v1Resources)
  })

  it('w1e-pre: the v1 baseline carries NONE of the three modern-encode stamps', () => {
    // The three-part control for `w1e`. Each part exists so the corresponding positive assertion
    // there cannot decay into a no-op the moment the fixture is re-captured against a modern server:
    // if the baseline already carried these keys, stripping them would prove nothing.
    //
    // Sound because the baseline's only top-level key is `tools` — checked here rather than assumed.
    for (const baseline of [v1Tools, v1Resources]) {
      expect(baseline).not.toHaveProperty('resultType') // D5
      expect(baseline).not.toHaveProperty('ttlMs') // D6
      expect(baseline).not.toHaveProperty('cacheScope') // D6
      expect((baseline._meta as Record<string, unknown> | undefined)?.[SERVER_INFO_META]).toBeUndefined() // D7
    }

    expect(Object.keys(v1Tools)).toEqual(['tools'])
    expect(Object.keys(v1Resources)).toEqual(['resources'])
  })

  it('w1e: D5 + D6 + D7 — the modern lane stamps exactly three things and NOTHING else changes', () => {
    /**
     * The modern differential, and the reason PM-C exists. The 2026 encode chain is four transforms
     * and adds THREE things to a result, so the natural way to make this pass — strip unknown keys
     * before comparing — is a normalization broad enough to swallow a fourth nobody noticed. Each is
     * therefore asserted POSITIVELY first, with `w1e-pre` proving the baseline carries none of them,
     * and only then removed for a whole-object comparison that fails on any eighth difference.
     *
     * READ FROM `servedConnection()` ONLY. THE SIBLING'S `server/discover` RESULT WOULD SATISFY THIS
     * ENTIRE POSITIVE HALF: it is modern-encoded too, and `server/discover` is itself in
     * `CACHEABLE_RESULT_METHODS`, so D5, D6 and D7 would all pass against it. Only the whole-object
     * `tools/list` comparison would notice, and it would fail as a shape mismatch that reads like a
     * differential bug rather than a pid-selection bug. That is precisely why the selector is an
     * exact rule and never a frame count.
     */
    for (const [method, result] of [
      ['tools/list', modernTools],
      ['resources/list', modernResources],
    ] as const) {
      expect(result.resultType, `${method}: D5`).toBe('complete') // D5
      expect(result.ttlMs, `${method}: D6`).toBe(0) // D6
      expect(result.cacheScope, `${method}: D6`).toBe('private') // D6
      expect((result._meta as Record<string, unknown> | undefined)?.[SERVER_INFO_META], `${method}: D7`).toBeDefined()
    }

    // Only `serverInfo.version` would ever need normalizing here, and the D7 strip removes the whole
    // stamp, so nothing version-shaped survives into the comparison.
    assertToolsMatchBaseline(stripModernStamps(modernTools))
    expect(stripModernStamps(modernResources)).toEqual(v1Resources)
  })

  it('o1: stdout carries valid JSON-RPC frames and nothing else, on BOTH lanes', () => {
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

    // The same claim over the MODERN lane, read off the served pid's OUTBOUND stream in the tee log.
    // A stray `console.log` or a banner on the modern path would corrupt framing exactly as it would
    // on the legacy one, and nothing else in this file would see it: every other modern assertion
    // goes through the SDK's decoder, which parses line by line and simply ignores what it cannot
    // read. `malformed` counts every log line that was not a well-formed JSON object in either
    // direction on either pid, so zero is the stronger claim and the one that catches the sibling too.
    expect(modernTee.malformed, 'the tee log carried a line that was not a JSON object').toBe(0)

    const servedOutbound = modernTee.servedConnection().outbound

    expect(servedOutbound.length).toBeGreaterThan(0)

    for (const frame of servedOutbound) {
      expect(frame.jsonrpc, `served pid emitted a non-JSON-RPC frame: ${JSON.stringify(frame).slice(0, 120)}`).toBe(
        '2.0',
      )
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
