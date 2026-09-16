import { Client, isInputRequiredResult } from '@modelcontextprotocol/client'
import type { CallToolResult, ElicitRequestFormParams, ElicitResult } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { Client as ClientV1 } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport as StdioClientTransportV1 } from '@modelcontextprotocol/sdk/client/stdio.js'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { $ } from 'zx'

import { buildEnvClearLines } from 'src/commands/env-clear/env-clear'
import { buildEnvLoadFileLines } from 'src/commands/env-load'
import { commandCatalog, getExposedMcpTools } from 'src/lib/command-catalog'
import { atomicWriteFileSync, parseVarNamesFromEnvFile, parseVarsFromEnvFile } from 'src/lib/constants'
import { LOG_FILE_PATH } from 'src/lib/logger'
import { deployableEnvs } from 'src/lib/workflow-envs'

import { makeEnvPickerFixture } from './helpers/env-picker-fixture'
import type { EnvPickerFixture } from './helpers/env-picker-fixture'
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
 *                pinned-modern client THROUGH THE TEE PROXY (W1a-modern + W1e + O1's modern half),
 *                env-picker fixture: legacy form client (E-L1/E-L2), url-only client (E-L3),
 *                manual pinned-modern client (E-M1/E-M2/E-M3), loaded-session client (SEC)
 *   short-lived: W1 raw ×2 (also carries O1's legacy half), E8a auto ×1, E3p plugin-launch ×1, O6 ×1
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

/**
 * The legacy launch, explicitly: `CLAUDE_PLUGIN_ROOT` is the one variable the server reads to pick its
 * tool-name spelling (`src/mcp/tool-prefix.ts`), and a vitest process spawned from inside a plugin
 * host would inherit it — so it is stripped rather than assumed absent, and every shared connection
 * below serves the legacy spelling by construction.
 */
const childEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...KILL_SWITCHES }

  delete env.CLAUDE_PLUGIN_ROOT

  return env
}

/**
 * The plugin launch: what a server spawned by the plugin's `.mcp.json` sees. The value is never
 * read as a path — `resolveLaunch` tests it for presence only — so it points at this file's fixtures
 * rather than at a directory that would have to exist.
 */
const pluginLaunchEnv = (): NodeJS.ProcessEnv => {
  return { ...childEnv(), CLAUDE_PLUGIN_ROOT: join(FIXTURES, 'plugin-root') }
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

const connectV2 = async (env: NodeJS.ProcessEnv = childEnv(), cwd?: string): Promise<Client> => {
  const client = new Client({ name: 'e2e-v2', version: '0.0.0' })

  await client.connect(new StdioClientTransport({ command: process.execPath, args: [mcpPath], env: env as any, cwd }))

  return client
}

/** Every long-lived connection — pinned-modern and the form lanes' — closed in `afterAll` so no served child outlives the file. */
const longLivedClients: Client[] = []

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

  longLivedClients.push(client)

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
  // INVERTED, never deleted. It used to read `.not.toContain('doctor')`, pinning the decision that the
  // host-inspecting command stayed off the wire; `doctor` is now the read half of the two-command setup
  // surface, so the same line pins the opposite decision. Deleting it instead would have been the
  // tempting wrong repair: it would leave the presence of the tool asserted nowhere on the wire, which
  // is the only place registration can actually be observed.
  expect(actual).toContain('doctor')
  expect(actual.size).toBeGreaterThan(20)

  // E-1: `doctor` is advertised READ-ONLY, read back off the wire rather than off the catalog object —
  // the annotation is what tells a host it may call this tool without interrupting a human, and a unit
  // assertion would pass even if registration dropped it.
  const doctorTool = listed.tools.find((tool) => {
    return tool.name === 'doctor'
  })

  expect(doctorTool?.annotations?.readOnlyHint).toBe(true)
  expect(doctorTool?.annotations?.destructiveHint).toBeUndefined()
}

/** The one tool that installs software, and the only one that may carry the host-prompt annotation. */
const REQUIRES_INTERACTION_TOOLS = new Set(['setup'])

/**
 * `_meta['anthropic/requiresUserInteraction']` is the only mechanism that puts a human on the MCP path:
 * the host prompts on every call, in `bypassPermissions` too, and an allow rule cannot skip it. It is
 * declared at registration, so nothing short of reading it back off the wire proves it actually reaches
 * a host — a unit test on the tool object would pass even if registration dropped the field.
 *
 * Asserted in BOTH directions on purpose. Missing on `setup` means the gate silently is not there;
 * present on any other tool — a read-only one above all — means every agent call to a harmless tool
 * interrupts a human, and users who are interrupted for nothing learn to click through, which costs the
 * gate its meaning on the calls that matter.
 */
const assertRequiresUserInteractionIsDeclared = async (client: Client): Promise<void> => {
  const listed = await client.listTools()

  const carrying = new Set(
    listed.tools
      .filter((tool) => {
        return (tool._meta as Record<string, unknown> | undefined)?.['anthropic/requiresUserInteraction'] === true
      })
      .map((tool) => {
        return tool.name
      }),
  )

  expect(carrying).toEqual(REQUIRES_INTERACTION_TOOLS)
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

  // RES (docs/session-env-picker-plan.md §3.6): the procedures moved to the plugin's skills, and the
  // ONLY workflow URI left is the `session` deprecation stub that keeps an old plugin's command on the
  // form path for one release. Read against the BUILT bundle: three lines, the form-path instruction
  // in the second. The other two URIs are gone outright, so a read is refused rather than answered.
  expect(
    uris.filter((uri) => {
      return uri.startsWith('infra-kit://workflow/')
    }),
  ).toEqual(['infra-kit://workflow/session'])

  const stub = await client.readResource({ uri: 'infra-kit://workflow/session' })
  const stubBody = stub.contents[0]
  const stubText = String((stubBody as { text: string }).text)

  expect(stubBody?.mimeType).toBe('text/markdown')
  expect(stubText.split('\n')).toHaveLength(3)
  expect(stubText).toContain('without `config`')

  for (const retired of ['infra-kit://workflow/release-create', 'infra-kit://workflow/setup']) {
    await expect(client.readResource({ uri: retired })).rejects.toThrow()
  }

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
  for (const client of longLivedClients) {
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

  it('e1b: the host-prompt annotation reaches the wire on exactly the one installing tool', async () => {
    await assertRequiresUserInteractionIsDeclared(client)
  }, 45_000)

  it('e2: a read-only tool call round-trips through v2 serialization', async () => {
    await assertReadOnlyToolCallRoundTrips(client)
  }, 45_000)

  it('e3: both read-only resources are listed and readable, plus only the session stub', async () => {
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

  it('e3m: both read-only resources are listed and readable, plus only the session stub', async () => {
    await assertResourcesAreListedAndReadable(client)
  }, 45_000)

  it('e6m: the long-lived server survives a failing tool call and answers the next one', async () => {
    await assertServerSurvivesAFailingCall(client)
  }, 45_000)

  it('e9m: every deterministic read-only tool round-trips a well-formed modern result', async () => {
    await assertEveryReadOnlyToolRoundTrips(client)
  }, 120_000)
})

/**
 * The plugin launch, over a real spawn. The shared clients above are all spawned on the legacy route
 * (`childEnv` strips the signal), so without this lane the built bundle's resource surface on the
 * route every migrated consumer's session actually uses would be proven only from `src/`.
 *
 * Short-lived and closed here, not ledgered with the pinned clients: one spawn, one read, done.
 */
describe('e3p — the served surface is the same on the plugin launch', () => {
  it('e3p: a server spawned with CLAUDE_PLUGIN_ROOT serves the same resource surface', async () => {
    const client = await connectV2(pluginLaunchEnv())

    try {
      await assertResourcesAreListedAndReadable(client)
    } finally {
      await client.close()
    }
  }, 45_000)
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

/*
 * ---------------------------------------------------------------------------------------------
 * The `env-load` argument form over the wire — docs/session-env-picker-plan.md §6.4.
 *
 * `env-load` is UNGATED: the form fills `config`, it never withholds execution. So unlike E4/E5 the
 * proof that the handler ran is not a file — a token-less load writes nothing — but the handler's
 * OWN auth error naming the env the form chose (`env-token-set stage`), which nothing upstream of
 * the handler can produce. The proof that it did NOT run is that text's absence.
 *
 * OBS — WHERE THE `Tool execution …` LINES ACTUALLY GO. The plan reads them from `LOG_FILE_PATH`,
 * and `o2` explains their absence there as pino's async buffer. Both are wrong about the mechanism:
 * `src/lib/logger`'s `logger` singleton is `initLoggerCLI()` — pino-pretty on fd 2 — and the MCP
 * entry's `initLoggerMcp()` file logger is a SECOND instance that only the entry writes to. The
 * tool handler logs to the child's STDERR, so that is what these lanes capture (`stderr: 'pipe'`),
 * which also makes the attribution problem `o2` solves by pid disappear: a piped stderr belongs to
 * exactly one child by construction.
 * ---------------------------------------------------------------------------------------------
 */

/** A legacy form client's `elicitation/create` handler: records every request, answers with `answer`. */
interface FormSpy {
  calls: ElicitRequestFormParams[]
  answer: ElicitResult
}

/** A served connection plus everything its child has written to stderr so far. */
interface CapturedConnection {
  client: Client
  stderr: () => string
}

/** The handler's own auth error for the fixture's token-less env — the "handler ran" witness. */
const authErrorFor = (fixture: EnvPickerFixture): RegExp => {
  return new RegExp(`env-token-set ${fixture.tokenlessEnv}`)
}

/** Every text block of a result, joined: the handler's error and the chokepoint's refusal both travel as text. */
const resultText = (result: CallToolResult): string => {
  return result.content
    .map((block) => {
      return block.type === 'text' ? block.text : ''
    })
    .join('\n')
}

/**
 * Spawns the server in the fixture repo behind `client`, capturing the child's stderr. Long-lived:
 * every connection made here is closed in `afterAll`. `env` overrides the fixture's for the lanes
 * that spawn with the session file's variables already in the environment (flow 1).
 */
const connectCaptured = async (
  client: Client,
  fixture: EnvPickerFixture,
  env: NodeJS.ProcessEnv = fixture.env,
): Promise<CapturedConnection> => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpPath],
    env: env as Record<string, string>,
    cwd: fixture.repo,
    stderr: 'pipe',
  })

  let captured = ''

  // Attached BEFORE `connect()`: the transport hands out its `PassThrough` at construction precisely so
  // nothing the child writes at boot is lost.
  transport.stderr?.on('data', (chunk: Uint8Array | string) => {
    captured += String(chunk)
  })

  await client.connect(transport)
  longLivedClients.push(client)

  return {
    client,
    stderr: () => {
      return captured
    },
  }
}

/** A bare 2025-era client that CAN render a form — the served side reaches it through the SDK's legacy shim. */
const connectLegacyFormClient = (fixture: EnvPickerFixture, spy: FormSpy): Promise<CapturedConnection> => {
  const client = new Client({ name: 'e2e-form', version: '0.0.0' }, { capabilities: { elicitation: { form: {} } } })

  client.setRequestHandler('elicitation/create', (request) => {
    spy.calls.push(request.params as ElicitRequestFormParams)

    return spy.answer
  })

  return connectCaptured(client, fixture)
}

/** A 2025-era client that declares elicitation but NOT the form mode — the one client a form must never reach. */
const connectUrlOnlyClient = (fixture: EnvPickerFixture): Promise<CapturedConnection> => {
  return connectCaptured(
    new Client({ name: 'e2e-url-only', version: '0.0.0' }, { capabilities: { elicitation: { url: {} } } }),
    fixture,
  )
}

/**
 * A client PINNED to 2026-07-28 that drives the multi-round-trip flow BY HAND: `autoFulfill: false`
 * turns the SDK's driver off, and each call opts in with `allowInputRequired: true` so an
 * `input_required` result is handed back instead of being fulfilled through the handler above.
 * That is what lets E-M3 post an accept the server never asked for.
 */
const connectManualModern = (fixture: EnvPickerFixture): Promise<CapturedConnection> => {
  return connectCaptured(
    new Client(
      { name: 'e2e-manual-modern', version: '0.0.0' },
      {
        versionNegotiation: { mode: { pin: '2026-07-28' } },
        inputRequired: { autoFulfill: false },
        capabilities: { elicitation: { form: {} } },
      },
    ),
    fixture,
  )
}

/** `env-load` with `config` omitted, on the manual modern driver. `extra` carries a hand-posted round 2. */
const callEnvLoadManually = (client: Client, extra: Record<string, unknown> = {}): Promise<CallToolResult> => {
  return client.callTool({ name: 'env-load', arguments: {}, ...extra }, { allowInputRequired: true })
}

/** A hand-posted `inputResponses` carrying one answer to the form under its registered key. */
const answered = (answer: ElicitResult): { inputResponses: Record<string, unknown> } => {
  return { inputResponses: { args: answer } }
}

/**
 * The stderr this lane's calls produced: everything the child wrote after `mark`. Polled, because
 * pino-pretty writes to fd 2 on its own schedule and the tool result can land a tick ahead of it.
 */
const stderrSince = (connection: CapturedConnection, mark: number): (() => string) => {
  return () => {
    return connection.stderr().slice(mark)
  }
}

describe('e-l1–e-l3 — the env-load form on a 2025-era connection', () => {
  let fixture: EnvPickerFixture
  let form: CapturedConnection
  let urlOnly: CapturedConnection
  const spy: FormSpy = { calls: [], answer: { action: 'cancel' } }

  beforeAll(async () => {
    fixture = await makeEnvPickerFixture()
    tmpDirs.push(...fixture.dirs)

    form = await connectLegacyFormClient(fixture, spy)
    urlOnly = await connectUrlOnlyClient(fixture)
  }, 45_000)

  it('e-l1: omitting `config` draws ONE form whose choices are what env-list reports; accepting runs the handler with the choice', async () => {
    // The enum is compared against `env-list` over the SAME connection, not the fixture's literal:
    // the claim is that the picker and `env-list` are one source, and a literal would pass while they
    // disagreed. The literal guards only the fixture itself — that the server really sees the workflow.
    const listed = await form.client.callTool({ name: 'env-list', arguments: {} })
    const configs = (listed.structuredContent as { configs?: string[] } | undefined)?.configs

    expect(configs, 'fixture precondition: the server must see the fixture workflow').toEqual([...fixture.envNames])

    const mark = form.stderr().length

    spy.calls.length = 0
    spy.answer = { action: 'accept', content: { config: fixture.tokenlessEnv } }

    const result = await form.client.callTool({ name: 'env-load', arguments: {} })

    // Delete the `formProvider` wiring on `envLoadMcpTool` → the spy is never called and the handler
    // refuses headless (`command-catalog.test.ts` pins the same wiring from the catalog side).
    expect(spy.calls).toHaveLength(1)

    const requested = spy.calls[0]?.requestedSchema

    expect(Object.keys(requested?.properties ?? {})).toEqual(['config'])
    expect(requested?.properties.config).toMatchObject({ enum: configs })
    expect(requested?.required).toEqual(['config'])

    // The handler ran with the ACCEPTED `config`: only the load path can name the env in an
    // `env-token-set` remediation, and only `stage` is token-less in the fixture.
    expect(result.isError).toBe(true)
    expect(resultText(result)).toMatch(authErrorFor(fixture))
    expect(result.structuredContent).toBeUndefined()
    expect(existsSync(join(fixture.sessionDir, 'env-load.sh')), 'a token-less load must write nothing').toBe(false)

    // OBS: the two lines the ungated path logs, in this child's stderr. Delete the
    // `Tool execution form accepted` line in `resolveUngatedForm` → this reddens.
    await expect.poll(stderrSince(form, mark), { timeout: 3_000 }).toContain('Tool execution form requested: env-load')
    await expect.poll(stderrSince(form, mark), { timeout: 3_000 }).toContain('Tool execution form accepted: env-load')
  }, 45_000)

  it('e-l2: declining the form is terminal — `form_declined`, one form, no load, no second prompt', async () => {
    const mark = form.stderr().length

    spy.calls.length = 0
    spy.answer = { action: 'decline' }

    const result = await form.client.callTool({ name: 'env-load', arguments: {} })

    // Delete `buildFormDeclined` on row U2 → the handler runs with the round-1 arguments and answers
    // with its own refusal text instead of this shape.
    expect(spy.calls).toHaveLength(1)
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ status: 'form_declined', tool: 'env-load', action: 'decline' })
    expect(resultText(result)).not.toMatch(authErrorFor(fixture))
    expect(existsSync(join(fixture.sessionDir, 'env-load.sh'))).toBe(false)

    await expect
      .poll(stderrSince(form, mark), { timeout: 3_000 })
      .toContain('Tool execution form declined (decline): env-load')
    expect(form.stderr().slice(mark)).not.toContain('Tool execution form accepted')
  }, 45_000)

  it("e-l3: a client that cannot render a form gets the handler's refusal naming `config` and `env-list`, not the shim's", async () => {
    const mark = urlOnly.stderr().length

    spy.calls.length = 0

    const result = await urlOnly.client.callTool({ name: 'env-load', arguments: {} })

    // Probe `caps?.elicitation` instead of `caps?.elicitation?.form` → the chokepoint offers the form,
    // the SDK's legacy shim cannot deliver it, and the result carries the shim's "did not declare the
    // required capability" text instead of a refusal that sends the agent to `env-list`.
    expect(spy.calls).toHaveLength(0)
    expect(result.isError).toBe(true)

    const text = resultText(result)

    expect(text).toContain('config')
    expect(text).toContain('env-list')
    expect(text).not.toContain('did not declare the required capability')
    expect(text).not.toMatch(authErrorFor(fixture))
    // The handler's refusal is a `StructuredRefusalError` and the chokepoint's catch renders its
    // payload (lib/tool-handler) — the SDK would have flattened a plain throw to text only.
    expect(result.structuredContent).toEqual({ status: 'argument_required', argument: 'config', agentMode: 'mcp' })

    // OBS: the refusal is the HANDLER's, so the chokepoint logged neither a request nor an outcome.
    await expect.poll(stderrSince(urlOnly, mark), { timeout: 3_000 }).toContain('Tool execution failed: env-load')
    expect(urlOnly.stderr().slice(mark)).not.toContain('Tool execution form')
  }, 45_000)
})

describe('e-r1–e-r2 — the release-create form: accept → gate → confirm on a GATED, form-fed tool', () => {
  /**
   * The first lane that drives a form-fed GATED tool through all three rounds. `e-l1` runs an ungated
   * handler, `e-d1m` stops at the form, and `assertConfirmedCallExecutes` gates a tool that has no
   * form — so nothing else proves the token minted over the human's entry verifies on round 2.
   *
   * On the fixture the handler must FAIL: the repo is `git init` with no `origin` and the fixture
   * scrubs every `JIRA_*` var, so `loadJiraConfig` throws before any git mutation.
   *
   * That failure is the witness: `Tool execution failed` on stderr means the token verified AND the
   * handler was entered, where a `Tool execution refused (` line would mean the gate rejected the
   * arguments the form produced. The result carries no `structuredContent` on that path, which is
   * why round 2 is asserted on stderr, not on the payload.
   */
  let fixture: EnvPickerFixture
  let form: CapturedConnection
  let manual: CapturedConnection
  const spy: FormSpy = { calls: [], answer: { action: 'cancel' } }

  const assertReleaseForm = (requested: ElicitRequestFormParams['requestedSchema'] | undefined): void => {
    // Property order is the wizard's; `description` is the one optional field. The hint branch is
    // the no-origin, no-Jira one — deterministic on this fixture, and the proof the provider's own
    // enumeration ran rather than a stub schema.
    expect(Object.keys(requested?.properties ?? {})).toEqual(['type', 'release', 'description'])
    expect(requested?.required).toStrictEqual(['type', 'release'])
    expect(requested?.properties.release?.description).toContain('No prior version is known')
  }

  beforeAll(async () => {
    fixture = await makeEnvPickerFixture()
    tmpDirs.push(...fixture.dirs)

    form = await connectLegacyFormClient(fixture, spy)
    manual = await connectManualModern(fixture)

    assertConnectionIsModern(manual.client)
  }, 45_000)

  it('e-r1: omitting `releases` draws ONE form; accepting gates on the entry; confirming enters the handler; declining is terminal', async () => {
    const formMark = form.stderr().length

    spy.calls.length = 0
    spy.answer = { action: 'accept', content: { type: 'hotfix', release: '1.2.3' } }

    const gate = await form.client.callTool({ name: 'release-create', arguments: {} })

    // Delete the `formProvider` wiring on `releaseCreateMcpTool` → the spy is never called and the
    // gate carries no `releases` (`command-catalog.test.ts` pins the same wiring from the catalog side).
    expect(spy.calls).toHaveLength(1)
    assertReleaseForm(spy.calls[0]?.requestedSchema)

    // OBS: the provider's own hint line, in this child's stderr.
    await expect
      .poll(stderrSince(form, formMark), { timeout: 3_000 })
      .toContain('Tool execution form hint unavailable (no prior versions): release-create')

    // The gate signs exactly what the human entered, in the tool's own argument shape: `toArgs`
    // classified `1.2.3` as a version and carried `type` through, and no `description` key appears
    // because the field was left blank.
    const structured = gate.structuredContent as
      | { status?: string; tool?: string; formDiscarded?: boolean; resolvedArgs?: unknown; confirmToken?: string }
      | undefined

    expect(gate.isError).toBe(true)
    expect(structured).toMatchObject({ status: 'confirmation_required', tool: 'release-create', formDiscarded: false })
    expect(structured?.resolvedArgs).toStrictEqual({ releases: [{ version: '1.2.3', type: 'hotfix' }] })
    expect(structured?.confirmToken, 'round 1 must hand out a confirmToken').toBeTypeOf('string')

    const mark = form.stderr().length

    spy.calls.length = 0

    const round2 = await form.client.callTool({
      name: 'release-create',
      arguments: {
        ...(structured?.resolvedArgs as Record<string, unknown>),
        confirm: true,
        confirmToken: structured?.confirmToken,
      },
    })

    // Round 2 carries `releases`, so it is not formable and no second form is drawn.
    expect(spy.calls).toHaveLength(0)
    expect(round2.isError).toBe(true)
    expect(round2.structuredContent).toBeUndefined()

    // THE load-bearing pair. `failed` proves the handler was entered — the token minted over the
    // form's arguments verified against what round 2 parsed. Change `toArgs` to emit a shape the
    // tool's transform re-normalizes (drop `type`, say) → the canonical arguments differ, the gate
    // answers `refused (mismatch)`, and this reddens on the first line.
    await expect.poll(stderrSince(form, mark), { timeout: 3_000 }).toContain('Tool execution failed: release-create')
    expect(form.stderr().slice(mark)).not.toContain('Tool execution refused (')

    spy.calls.length = 0
    spy.answer = { action: 'decline' }

    const declined = await form.client.callTool({ name: 'release-create', arguments: {} })

    expect(spy.calls).toHaveLength(1)
    expect(declined.isError).toBe(true)
    expect(declined.structuredContent).toMatchObject({
      status: 'form_declined',
      tool: 'release-create',
      action: 'decline',
    })
  }, 45_000)

  it('e-r2: the GATED release-create form is offered on the modern era too — `input_required` before any gate', async () => {
    const round1 = await manual.client.callTool({ name: 'release-create', arguments: {} }, { allowInputRequired: true })
    const offered = isInputRequiredResult(round1) ? round1 : undefined

    expect(offered, `expected input_required, got: ${JSON.stringify(round1)}`).toBeDefined()

    const request = offered?.inputRequests?.args as { method: string; params: ElicitRequestFormParams } | undefined

    expect(Object.keys(offered?.inputRequests ?? {})).toEqual(['args'])
    expect(request?.method).toBe('elicitation/create')
    assertReleaseForm(request?.params.requestedSchema)
  }, 45_000)
})

describe('e-rr1–e-rr3 — the release-remove form: pick → gate → confirm on a GATED, form-fed tool', () => {
  /**
   * Same three rounds as `e-r1`, on the tool whose form is a PICKER rather than a wizard: the enum
   * is the open release PRs the fixture's `gh` stub reports (exactly `release/v1.2.5` on `dev`,
   * nothing on `main`), and the fixture's scrubbed `JIRA_*` leave the rows without descriptions.
   *
   * On the fixture round 2 must FAIL before any mutation — the repo has no `origin`, no worktree and
   * the `gh` stub answers `pr list --head` with exit 97 — and that failure is the witness: `Tool
   * execution failed` means the token minted over the picked `version` verified and the handler was
   * entered; `Tool execution refused (` would mean the gate rejected what the form produced.
   *
   * `e-rr3` also reads `tools/list` off the wire: the tool is AUTHORED in the v1 baseline
   * differential, so nothing else pins that the description and schemas say what the handler now does.
   */
  let fixture: EnvPickerFixture
  let form: CapturedConnection
  let manual: CapturedConnection
  const spy: FormSpy = { calls: [], answer: { action: 'cancel' } }

  const assertRemoveForm = (requested: ElicitRequestFormParams['requestedSchema'] | undefined): void => {
    // ONE required select whose options are the stub's single open release PR, rendered as the CLI
    // picker renders it — the proof the provider's own enumeration ran rather than a stub schema.
    expect(Object.keys(requested?.properties ?? {})).toEqual(['version'])
    expect(requested?.properties.version).toMatchObject({ enum: ['1.2.5'] })
    expect(requested?.required).toStrictEqual(['version'])
    expect(requested?.properties.version?.description).toContain('1.2.5 [regular]')
  }

  beforeAll(async () => {
    fixture = await makeEnvPickerFixture()
    tmpDirs.push(...fixture.dirs)

    form = await connectLegacyFormClient(fixture, spy)
    manual = await connectManualModern(fixture)

    assertConnectionIsModern(manual.client)
  }, 45_000)

  it('e-rr1: omitting `version` draws ONE picker; accepting gates on the pick; confirming enters the handler; declining is terminal', async () => {
    const formMark = form.stderr().length

    spy.calls.length = 0
    spy.answer = { action: 'accept', content: { version: '1.2.5' } }

    const gate = await form.client.callTool({ name: 'release-remove', arguments: {} })

    // Delete the `formProvider` wiring on `releaseRemoveMcpTool` → the spy is never called and the
    // gate carries no `version` (`command-catalog.test.ts` pins the same wiring from the catalog side).
    expect(spy.calls).toHaveLength(1)
    assertRemoveForm(spy.calls[0]?.requestedSchema)

    await expect
      .poll(stderrSince(form, formMark), { timeout: 3_000 })
      .toContain('Tool execution form requested: release-remove')

    const structured = gate.structuredContent as
      | { status?: string; tool?: string; formDiscarded?: boolean; resolvedArgs?: unknown; confirmToken?: string }
      | undefined

    expect(gate.isError).toBe(true)
    expect(structured).toMatchObject({ status: 'confirmation_required', tool: 'release-remove', formDiscarded: false })
    expect(structured?.resolvedArgs).toStrictEqual({ version: '1.2.5' })
    expect(structured?.confirmToken, 'round 1 must hand out a confirmToken').toBeTypeOf('string')

    const mark = form.stderr().length

    spy.calls.length = 0

    const round2 = await form.client.callTool({
      name: 'release-remove',
      arguments: {
        ...(structured?.resolvedArgs as Record<string, unknown>),
        confirm: true,
        confirmToken: structured?.confirmToken,
      },
    })

    // Round 2 carries `version`, so it is not formable and no second picker is drawn.
    expect(spy.calls).toHaveLength(0)
    expect(round2.isError).toBe(true)
    expect(round2.structuredContent).toBeUndefined()

    // THE load-bearing pair (see `e-r1`): `failed` proves the handler was entered on the token
    // minted over the picked `version`; `refused (` would mean the gate rejected the form's output.
    await expect.poll(stderrSince(form, mark), { timeout: 3_000 }).toContain('Tool execution failed: release-remove')
    expect(form.stderr().slice(mark)).not.toContain('Tool execution refused (')

    spy.calls.length = 0
    spy.answer = { action: 'decline' }

    const declined = await form.client.callTool({ name: 'release-remove', arguments: {} })

    expect(spy.calls).toHaveLength(1)
    expect(declined.isError).toBe(true)
    expect(declined.structuredContent).toMatchObject({
      status: 'form_declined',
      tool: 'release-remove',
      action: 'decline',
    })
  }, 45_000)

  it('e-rr2: the GATED release-remove picker is offered on the modern era too — `input_required` before any gate', async () => {
    const round1 = await manual.client.callTool({ name: 'release-remove', arguments: {} }, { allowInputRequired: true })
    const offered = isInputRequiredResult(round1) ? round1 : undefined

    expect(offered, `expected input_required, got: ${JSON.stringify(round1)}`).toBeDefined()

    const request = offered?.inputRequests?.args as { method: string; params: ElicitRequestFormParams } | undefined

    expect(Object.keys(offered?.inputRequests ?? {})).toEqual(['args'])
    expect(request?.method).toBe('elicitation/create')
    assertRemoveForm(request?.params.requestedSchema)
  }, 45_000)

  it('e-rr3: a call that names `version` draws no picker, and tools/list says the Jira fix version is removed', async () => {
    spy.calls.length = 0

    const gate = await form.client.callTool({ name: 'release-remove', arguments: { version: '1.2.5' } })

    expect(spy.calls).toHaveLength(0)
    expect(gate.isError).toBe(true)
    expect(gate.structuredContent).toMatchObject({
      status: 'confirmation_required',
      tool: 'release-remove',
      resolvedArgs: { version: '1.2.5' },
    })

    const listed = await form.client.listTools()
    const tool = listed.tools.find((entry) => {
      return entry.name === 'release-remove'
    })
    const inputSchema = tool?.inputSchema as { required?: string[]; properties?: Record<string, unknown> } | undefined
    const outputSchema = tool?.outputSchema as { properties?: { jira?: { enum?: string[] } } } | undefined

    expect(tool).toBeDefined()
    // `version` must be optional in the SCHEMA for the picker to be reachable at all: the SDK parses
    // before the chokepoint runs.
    expect(inputSchema?.required).toBeUndefined()
    expect(inputSchema?.properties?.moveIssuesTo).toBeDefined()
    expect(inputSchema?.properties?.skipJira).toBeUndefined()
    // The one surface immune to plugin/CLI version skew: every host shows the agent this text.
    expect(tool?.description).toContain('REMOVES ITS JIRA FIX VERSION')
    expect(tool?.description).toContain('moveIssuesTo')
    expect(tool?.description).toContain('One release per call')
    expect(tool?.description).not.toContain('LEFT IN PLACE')
    const versionField = inputSchema?.properties?.version as { description?: string } | undefined

    expect(versionField?.description).not.toContain('Required: the interactive picker')
    expect(outputSchema?.properties?.jira?.enum).toStrictEqual(['removed', 'absent', 'skipped'])
  }, 45_000)
})

describe('e-m1–e-m3 — the env-load form on a PINNED MODERN connection, driven by hand', () => {
  let fixture: EnvPickerFixture
  let manual: CapturedConnection

  beforeAll(async () => {
    fixture = await makeEnvPickerFixture()
    tmpDirs.push(...fixture.dirs)

    manual = await connectManualModern(fixture)

    assertConnectionIsModern(manual.client)
  }, 45_000)

  it('e-m1: omitting `config` answers `input_required` with ONE form; posting the accept back runs the handler', async () => {
    const round1 = await callEnvLoadManually(manual.client)

    // The modern driver path: the same chokepoint answers with the SDK's `input_required` result
    // instead of a server→client request, and the client — not a shim — carries the answer back.
    const form = isInputRequiredResult(round1) ? round1 : undefined

    expect(form, `expected input_required, got: ${JSON.stringify(round1)}`).toBeDefined()

    const request = form?.inputRequests?.args as { method: string; params: ElicitRequestFormParams } | undefined

    expect(Object.keys(form?.inputRequests ?? {})).toEqual(['args'])
    expect(request?.method).toBe('elicitation/create')
    expect(request?.params.requestedSchema.properties.config).toMatchObject({ enum: [...fixture.envNames] })

    // `requestState` is echoed byte-exact when the server issued one — the driver's contract, kept by hand here.
    const round2 = await callEnvLoadManually(manual.client, {
      ...answered({ action: 'accept', content: { config: fixture.tokenlessEnv } }),
      ...(form?.requestState === undefined ? {} : { requestState: form.requestState }),
    })

    expect(round2.isError).toBe(true)
    expect(resultText(round2)).toMatch(authErrorFor(fixture))
  }, 45_000)

  it('e-m2: a hand-posted decline is terminal — `form_declined`, the handler never ran', async () => {
    const result = await callEnvLoadManually(manual.client, answered({ action: 'decline' }))

    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ status: 'form_declined', tool: 'env-load', action: 'decline' })
    expect(resultText(result)).not.toMatch(authErrorFor(fixture))
  }, 45_000)

  it('e-m3: an accept the server never asked for is validated like any other — a known env runs, an unknown one is discarded', async () => {
    // Row U3 is reachable with no form ever offered: on the modern era a client may send
    // `inputResponses` on any `tools/call`, and the stateless server cannot tell a driver re-entry
    // from a hand-posted accept (plan F14). The guarantee is therefore not "a human chose" but "the
    // ungated form path can execute nothing a direct call could not" — an accept is validated against
    // a schema built on THIS request, and what runs is exactly `env-load {config}`.
    const known = await callEnvLoadManually(
      manual.client,
      answered({ action: 'accept', content: { config: fixture.tokenlessEnv } }),
    )

    expect(known.isError).toBe(true)
    expect(resultText(known)).toMatch(authErrorFor(fixture))

    // Skip `readAcceptedArgs`'s schema validation → `nope` reaches the handler and fails on the token
    // store instead of being discarded here.
    const unknown = await callEnvLoadManually(
      manual.client,
      answered({ action: 'accept', content: { config: 'nope' } }),
    )

    expect(unknown.isError).toBe(true)
    expect(unknown.structuredContent).toMatchObject({
      status: 'form_discarded',
      tool: 'env-load',
      reason: 'validation',
    })
    expect(resultText(unknown)).not.toContain('env-token-set')
  }, 45_000)

  it('e-d1m: the GATED deploy-all form is offered on the modern era too — `input_required` before any gate', async () => {
    // docs/release-deploy-command-plan.md E1, modern half. Never live over stdio before the
    // envelope-first capability read in `src/mcp/tools/index.ts`: with the accessor alone, a modern
    // stdio call read no capabilities, skipped the form, and answered the confirm gate straight away.
    // Revert that read → this lane gets `confirmation_required` instead of a form.
    const round1 = await manual.client.callTool(
      { name: 'gh-release-deploy-all', arguments: { version: fixture.releaseLabel } },
      { allowInputRequired: true },
    )
    const form = isInputRequiredResult(round1) ? round1 : undefined

    expect(form, `expected input_required, got: ${JSON.stringify(round1)}`).toBeDefined()

    const request = form?.inputRequests?.args as { method: string; params: ElicitRequestFormParams } | undefined
    const properties = request?.params.requestedSchema.properties ?? {}

    expect(request?.method).toBe('elicitation/create')
    // Both fields ride one form (the provider offers every field it owns, blank keeps the caller's);
    // the env enum is the workflow's list minus the protected envs this project may not reach.
    expect(Object.keys(properties).sort()).toEqual(['env', 'version'])
    expect(properties.env).toMatchObject({ enum: deployableEnvs([...fixture.envNames]) })
    expect(properties.version).toMatchObject({ enum: [fixture.releaseLabel, 'dev'] })
  }, 45_000)
})

describe('sec — a loaded session file never leaks a VALUE through the read-only env tools', () => {
  /**
   * `env-status` and `env-list` are the two tools an agent calls freely before and after a load.
   * `env-status` opens `env-load.sh` to COUNT its variables; `env-list` reads the token store next
   * to it. A hand-written session file with one unmistakable value is the haystack, and the
   * assertion is that the value appears nowhere in either result — not in `structuredContent`, not in
   * the text rendering.
   *
   * The session vars are set on the CHILD because `env-status` only opens the file when
   * `INFRA_KIT_ENV_CONFIG` says something is loaded; without them the count stays 0, the file is
   * never read, and the lane would pass without looking. `sessionTotalCount` is asserted to prove
   * the read happened.
   */
  let fixture: EnvPickerFixture
  let client: Client

  beforeAll(async () => {
    fixture = await makeEnvPickerFixture()
    tmpDirs.push(...fixture.dirs)

    mkdirSync(fixture.sessionDir, { recursive: true })
    // The exact shape `buildEnvLoadFileLines` writes — `parseVarNamesFromEnvFile` reads assignments, not `export`s.
    writeFileSync(join(fixture.sessionDir, 'env-load.sh'), ['set -a', "FOO='s3cr3t-value'", 'set +a', ''].join('\n'))

    const loadedEnv: NodeJS.ProcessEnv = {
      ...fixture.env,
      INFRA_KIT_ENV_CONFIG: fixture.tokenlessEnv,
      INFRA_KIT_ENV_PROJECT: 'env-picker-project',
      INFRA_KIT_ENV_LOADED_AT: new Date().toISOString(),
    }

    client = await connectV2(loadedEnv, fixture.repo)
    longLivedClients.push(client)
  }, 45_000)

  it('sec: env-status counts the session file without echoing its values', async () => {
    const result = await client.callTool({ name: 'env-status', arguments: {} })

    expect(result.isError ?? false).toBe(false)
    expect(result.structuredContent).toMatchObject({ sessionConfig: fixture.tokenlessEnv, sessionTotalCount: 1 })
    expect(JSON.stringify(result)).not.toContain('s3cr3t-value')
  }, 45_000)

  it('sec: env-list reports token PRESENCE and nothing from the session file', async () => {
    const result = await client.callTool({ name: 'env-list', arguments: {} })

    expect(result.isError ?? false).toBe(false)
    expect(result.structuredContent).toMatchObject({ configs: [...fixture.envNames] })

    const serialized = JSON.stringify(result)

    expect(serialized).not.toContain('s3cr3t-value')
    // The token store sits beside the session file and is read by this tool — its value must not leak either.
    expect(serialized).not.toContain('dp.st.dev.x')
  }, 45_000)
})

describe('e-skew — a straggler CLI and the live server both answer `env-load {}` with a RESULT naming `config`', () => {
  /**
   * The plan's F13 said the published 0.7.7 answers a JSON-RPC `-32602` ERROR. V0.6
   * (docs/reviews/session-env-picker-v0.md) captured the real wire and refuted it: the SDK wraps the
   * argument-validation failure into an `isError` RESULT before it reaches stdio. So both shapes the
   * skill body has to survive are results — the fixture pins the straggler's, the live call pins ours —
   * and the two are told apart by what the text names: `config` alone, or `config` AND `env-list`.
   */
  const captured = JSON.parse(readFileSync(join(FIXTURES, 'env-load-missing-config.0.7.7.json'), 'utf8')) as {
    capturedFrom: { version: string; request: { params: { name: string; arguments: Record<string, unknown> } } }
    response: { result?: { isError?: boolean; content?: { type: string; text?: string }[] }; error?: unknown }
  }

  it('e-skew: the 0.7.7 fixture is an isError RESULT (not a -32602 error) whose text names `config`', () => {
    expect(captured.capturedFrom.version).toBe('0.7.7')
    expect(captured.capturedFrom.request.params).toEqual({ name: 'env-load', arguments: {} })
    expect(captured.response.error).toBeUndefined()
    expect(captured.response.result?.isError).toBe(true)

    const text = (captured.response.result?.content ?? [])
      .map((block) => {
        return block.text ?? ''
      })
      .join('\n')

    expect(text).toContain('config')
    expect(text).toMatch(/^Input validation error: Invalid arguments for tool env-load:/)
  })

  it('e-skew: the live server answers a client that cannot form with an isError RESULT naming `config` and `env-list`', async () => {
    const client = await sharedBareV2()
    const result = await client.callTool({ name: 'env-load', arguments: {} })

    expect(result.isError).toBe(true)
    expect(result.structuredContent).toEqual({ status: 'argument_required', argument: 'config', agentMode: 'mcp' })

    const text = resultText(result)

    expect(text).toContain('config')
    expect(text).toContain('env-list')
  }, 45_000)
})

describe('w1 — differential wire compatibility against the pre-migration v1 baseline', () => {
  /**
   * The plan's central confidence artifact. It asserts every KNOWN delta POSITIVELY (rather than
   * merely normalizing it away) and fails on any UNNAMED difference.
   */
  //   D1  initialize.capabilities.prompts  {} -> absent  (AUTHORED: prompt channel retired, docs/release-create-prompt-removal-plan.md)  legacy + modern
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
  //   D12 required[] shrank on four deploy tools (AUTHORED)                        legacy + modern
  //   D13 the prose those four tools carry was rewritten (AUTHORED)                legacy + modern
  //   D14 env-clear's description stopped naming the removed `init` (AUTHORED)     legacy + modern
  //   D15 config-get's description names the `mcp` layer-1 refusal (AUTHORED)      legacy + modern
  //   D16 version reports where it runs and which route spawned it (AUTHORED)       legacy + modern
  //   D17 env-load's `config` went optional — `required` vanished (AUTHORED, docs/session-env-picker-plan.md §2.4)  legacy + modern
  //   D18 env-load's description and `config` prose stopped calling the field MCP-required (AUTHORED)  legacy + modern
  //   D21 env-status's description says the server re-reads the session file before every tool (AUTHORED, docs/archive/mcp/mcp-session-env-refresh-plan.md §2.7)  legacy + modern
  //   D19 release-create's releases went optional — required vanished (AUTHORED, docs/release-create-form-plan.md §3.4)  legacy + modern
  //   D20 release-create's description and `releases` prose stopped calling the gate auto-skipped (AUTHORED, docs/release-create-form-plan.md §3.4)  legacy + modern
  //   D23 worktrees-add: `cmux` → `orca` input, Orca description, three `orca*` output arrays (AUTHORED, docs/orca-migration-plan.md §2.4)  legacy + modern
  //   D24 reopen: `force` deleted, Orca description + dryRun prose, `cmux*` outputs → `orca*` object arrays + `orcaHidden` (AUTHORED, docs/orca-migration-plan.md §2.4)  legacy + modern
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
   * D12 — an AUTHORED delta, normalized on the BASELINE side at load exactly like D4, and for the
   * same reason: the fixture is evidence captured before any dependency change and must not be
   * re-captured. Four exposed deploy tools relaxed required fields to `.optional()` so the server
   * can offer a human a real argument form instead of leaving the agent to guess a version or an
   * environment.
   *
   * D17 — `env-load`'s `config`, relaxed for the session env picker — rides the same mechanism: one
   * more entry here, one more in `w1c-pre-d12`. D19 — `release-create`'s `releases`, relaxed so the
   * wizard's three questions can ride one form — rides it the same way.
   */
  // The expected post-change array is written out PER TOOL rather than blanket-emptied.
  // `local-deploy-selected` keeps `service` required — a services picker there needs an
  // env-dependent domain (`eligibleServices`) that one round trip cannot supply, so relaxing it is
  // deferred (F-7) — and a normalization that emptied every array would hide the day that changes.
  //
  // `undefined` is an explicit expected value, not a shrug: `z.toJSONSchema` omits `required`
  // entirely when nothing is required, so the served schema carries NO such key on three of the
  // four. A served `required: []`, or a re-tightened `required: ['env']`, both fail this.
  const D12_REQUIRED: Record<string, string[] | undefined> = {
    'gh-release-deploy-all': undefined,
    'gh-release-deploy-selected': undefined,
    'local-deploy-all': undefined,
    'local-deploy-selected': ['service'],
    'env-load': undefined,
    'release-create': undefined,
  }

  const findBaselineTool = (name: string): Record<string, any> | undefined => {
    return (v1Tools.tools as Record<string, any>[]).find((tool) => {
      return tool.name === name
    })
  }

  /**
   * Rewrites the baseline's `required` arrays in place and returns what they held BEFORE, so
   * `w1c-pre-d12` has something to assert — the same discipline `d4Carriers` follows. A tool missing
   * from the fixture is captured as `undefined` and reds there, rather than letting the rewrite
   * decay into a silent no-op.
   */
  const applyD12ToBaseline = (): Record<string, unknown> => {
    const captured: Record<string, unknown> = {}

    for (const [name, expected] of Object.entries(D12_REQUIRED)) {
      const schema = findBaselineTool(name)?.inputSchema as Record<string, any> | undefined

      captured[name] = schema?.required

      if (schema === undefined) continue

      if (expected === undefined) delete schema.required
      else schema.required = [...expected]
    }

    return captured
  }

  const d12Baseline = applyD12ToBaseline()

  /**
   * D13 — the prose D12 falsified. Every string here used to tell an MCP caller a field was
   * mandatory ("Required for MCP calls.", "required when invoked via MCP (interactive pickers are
   * unavailable without a TTY)"), which stopped being true the moment the field went optional and
   * the argument form became the way it gets filled.
   */
  // Written as the LITERAL post-change text, not copied from the served side. That keeps the
  // whole-object comparison doing real work on these strings: the served value must equal the
  // literal, so a further prose edit fails `w1c` and has to be re-declared here — the same contract
  // D4 and D9 impose by naming their carriers. Copying the served text in would retire nine strings
  // from the differential permanently, which is the broad normalization PM-C warns about.
  //
  // Scope is eleven named paths on five named tools, and only `description` at each. Nothing else
  // about these tools — `type`, `outputSchema`, property sets — is touched, so a change to any of
  // that still reaches the comparison and fails it. The two `env-load` paths are D18, the prose half
  // of D17: the literals are the ones `commands/env-load/env-load.ts` carries, so an edit there fails
  // `w1c` until it is re-declared here.
  const D13_PROSE: Record<string, { description?: string; properties?: Record<string, string> }> = {
    'gh-release-deploy-all': {
      description:
        'Dispatch the deploy-all.yml GitHub Actions workflow to deploy every service from a release branch to the given environment. Fire-and-forget — returns once GitHub accepts the workflow_dispatch, NOT when the deployment finishes; watch the workflow run for completion status. Use gh-release-deploy-selected for a subset of services. Pass version="dev" to deploy from the dev branch instead of a release branch. Omit "version" or "env" and this server offers the human a form listing the real releases and the environments this workflow declares; a client that cannot render one gets a refusal naming the missing field, never a guess.',
      properties: {
        version:
          'Accepts a release version (e.g. "1.2.5") OR a release name (e.g. "checkout-redesign") — resolves to the release/vX.Y.Z or release/<name> branch. Pass "dev" to deploy from the dev branch instead. Omit it to be offered the open releases.',
        env: 'Target environment name — must match an env this project may reach (e.g. "dev", "renana", "oriana"). Omit it to be offered the environments deploy-all.yml declares.',
      },
    },
    'gh-release-deploy-selected': {
      description:
        'Dispatch the deploy-selected-services.yml GitHub Actions workflow to deploy a chosen subset of services from a release branch to the given environment. Fire-and-forget — returns once GitHub accepts the workflow_dispatch, NOT when the deployment finishes; watch the workflow run for completion status. Service names are validated against the boolean inputs declared in the workflow, and a service the target environment gates out is refused BEFORE dispatch rather than dispatched and silently skipped. Use gh-release-deploy-all for every service. Omit any of "version", "env" or "services" and this server offers the human a form built from the real releases, environments and services; a client that cannot render one gets a refusal naming the missing field, never a guess.',
      properties: {
        version:
          'Accepts a release version (e.g. "1.2.5") OR a release name (e.g. "checkout-redesign") — resolves to the release/vX.Y.Z or release/<name> branch. Pass "dev" to deploy from the dev branch instead. Omit it to be offered the open releases.',
        env: 'Target environment name — must match an env this project may reach (e.g. "dev", "renana", "oriana"). Omit it to be offered the environments deploy-selected-services.yml declares.',
        services:
          'Service names to deploy. Each must match a boolean input declared in .github/workflows/deploy-selected-services.yml (e.g. "client-be", "client-fe"). Some services are gated to particular environments by that workflow and are refused here rather than skipped by CI. Omit it to be offered the declared services.',
      },
    },
    // Both local tools share one `sharedInput`, so the single `.optional()` on `env` rewrote the
    // same sentence twice. Their TOOL descriptions did not change and are deliberately absent here.
    'local-deploy-all': {
      properties: {
        env: 'Target environment, e.g. "dev" or a personal env like "arthur". Omit it to be offered the environments this project may reach.',
      },
    },
    'local-deploy-selected': {
      properties: {
        env: 'Target environment, e.g. "dev" or a personal env like "arthur". Omit it to be offered the environments this project may reach.',
      },
    },
    'env-load': {
      description:
        'Download the env vars for a Doppler config and write them to a temporary shell script. Does NOT mutate the calling process — returns the path to a script that must be sourced ("source <filePath>") for the vars to take effect. The infra-kit shell wrapper auto-sources; direct MCP callers must handle sourcing themselves or surface filePath to the user. This server picks the file up on its next tool call, so a tool that needs the variables can be called right after. Omit "config" and this server offers the human a form listing every environment env-list knows, token-less ones marked; a client that cannot render one gets a refusal naming the missing field — call env-list and ask the human, never guess.',
      properties: {
        config:
          'Doppler config / environment name to load (e.g. "dev", "arthur"). Omit it to have the human choose from a form.',
      },
    },
  }

  /**
   * Rewrites the baseline's prose in place and returns what it held BEFORE, keyed `<tool>` and
   * `<tool>.<property>`, for `w1c-pre-d13`.
   */
  const applyD13ToBaseline = (): Record<string, unknown> => {
    const captured: Record<string, unknown> = {}

    for (const [name, prose] of Object.entries(D13_PROSE)) {
      const tool = findBaselineTool(name)

      if (prose.description !== undefined) {
        captured[name] = tool?.description

        if (tool !== undefined) tool.description = prose.description
      }

      for (const [property, text] of Object.entries(prose.properties ?? {})) {
        const node = tool?.inputSchema?.properties?.[property] as Record<string, any> | undefined

        captured[`${name}.${property}`] = node?.description

        if (node !== undefined) node.description = text
      }
    }

    return captured
  }

  const d13Baseline = applyD13ToBaseline()

  /**
   * D14 — an AUTHORED delta, handled exactly like D13: ONE tool description, rewritten because the
   * command it named stopped existing. `env-clear` told an MCP caller that `infra-kit init` installs
   * the zsh integration that auto-sources the unset script; `init` was removed, and `infra-kit setup`
   * is what installs it now. Leaving the old text would have shipped a tool description pointing at a
   * name the binary rejects.
   */
  // Written as the LITERAL post-change text for D13's reason: the served value must equal this
  // string, so a further edit to `env-clear`'s description fails `w1c` and has to be re-declared
  // here rather than retiring the description from the differential.
  const D14_ENV_CLEAR_DESCRIPTION =
    'Generate a shell script that unsets every env var previously loaded by env-load for this session, plus the infra-kit session metadata vars. Does NOT mutate the calling process. When `infra-kit setup` has installed the zsh shell integration, the user\'s terminal auto-sources the unset script on its next prompt (precmd hook) — so calling this via MCP will clear the vars in the shell that launched Claude Code automatically. Other callers must source "<filePath>" themselves or surface it to the user. Errors if no env is currently loaded.'

  /** Rewrites the baseline's `env-clear` description in place and returns what it held BEFORE. */
  const applyD14ToBaseline = (): unknown => {
    const tool = findBaselineTool('env-clear')
    const captured = tool?.description

    if (tool !== undefined) tool.description = D14_ENV_CLEAR_DESCRIPTION

    return captured
  }

  const d14Baseline = applyD14ToBaseline()

  /**
   * D15 — an AUTHORED delta, handled exactly like D14: ONE tool description, rewritten because the
   * guidance it gave became wrong. `config-get` told an MCP caller to "use `config edit` to modify
   * the override file" — and `mcp`, the key that feeds the committed `.mcp.json`, is now REFUSED in
   * that very file (`infra-kit-config.ts`, `loadLayer`). The text names the exception and the new
   * failure mode, so a caller is not sent to edit a layer that will then throw.
   */
  // LITERAL post-change text, for D13's reason: a further edit fails `w1c` and must be re-declared.
  const D15_CONFIG_GET_DESCRIPTION =
    'Return the fully merged infra-kit configuration (project + user-global + per-project override layers) as it is resolved at runtime. Read-only introspection — makes no changes; use `config edit` (CLI-only) to modify the per-machine override file (every key except `mcp`, which is project-layer only and refused there). Fails with the loader error when run outside a configured infra-kit repo, or when an override layer carries a refused key.'

  /** Rewrites the baseline's `config-get` description in place and returns what it held BEFORE. */
  const applyD15ToBaseline = (): unknown => {
    const tool = findBaselineTool('config-get')
    const captured = tool?.description

    if (tool !== undefined) tool.description = D15_CONFIG_GET_DESCRIPTION

    return captured
  }

  const d15Baseline = applyD15ToBaseline()

  /**
   * D16 — an AUTHORED delta: `version` grew from a one-field answer into the session's location and
   * route report (docs/archive/mcp/mcp-via-plugin-migration-plan.md §4 PM-4, §5 step 2.7).
   *
   * A plugin-spawned server runs in `${CLAUDE_PROJECT_DIR}`, and the doctor skill asserts
   * `cwd === repoRoot === projectDir` from THIS tool's answer; `launch` / `toolPrefix` are the only
   * server-authored proof of which route a session is on. Description AND output schema move, so
   * both are rewritten on the baseline at load — literally, for D13's reason: a further edit fails
   * `w1c` and must be re-declared here.
   */
  const D16_VERSION_DESCRIPTION =
    'Print the installed infra-kit CLI version, where this server process runs (cwd, repo root, main repo root, CLAUDE_PROJECT_DIR) and which route spawned it (plugin or a repo .mcp.json entry) with the tool prefix that route produces'

  // The nullable fields are written in the served `type: [T, 'null']` form directly, not as the
  // baseline's `anyOf` — D8's normalization runs on the baseline and would render them the same way,
  // but writing the post-change form keeps D16 legible on its own and out of D8's carrier count.
  const D16_VERSION_OUTPUT_PROPERTIES: Record<string, unknown> = {
    version: { type: 'string', description: 'Installed infra-kit CLI version (from package.json)' },
    cwd: { type: 'string', description: 'The working directory of this server process' },
    repoRoot: {
      description: 'git toplevel of cwd — the worktree itself in a linked worktree; null when git cannot answer',
      type: ['string', 'null'],
    },
    mainRepoRoot: {
      description:
        'The main checkout a linked worktree belongs to (equals repoRoot outside worktrees); null with repoRoot',
      type: ['string', 'null'],
    },
    projectDir: {
      description: 'CLAUDE_PROJECT_DIR as Claude Code set it for this server, or null',
      type: ['string', 'null'],
    },
    launch: {
      type: 'string',
      enum: ['plugin', 'legacy'],
      description: 'Which route spawned this server: the Claude Code plugin, or a repo .mcp.json entry (legacy)',
    },
    toolPrefix: { type: 'string', description: 'The prefix every tool of this server carries in this session' },
  }

  const D16_VERSION_OUTPUT_REQUIRED = [
    'version',
    'cwd',
    'repoRoot',
    'mainRepoRoot',
    'projectDir',
    'launch',
    'toolPrefix',
  ]

  /** Rewrites the baseline's `version` tool in place and returns what it held BEFORE. */
  const applyD16ToBaseline = (): { description: unknown; properties: unknown; required: unknown } => {
    const tool = findBaselineTool('version')
    const schema = tool?.outputSchema as Record<string, any> | undefined
    const captured = { description: tool?.description, properties: schema?.properties, required: schema?.required }

    if (tool !== undefined) tool.description = D16_VERSION_DESCRIPTION

    if (schema !== undefined) {
      schema.properties = structuredClone(D16_VERSION_OUTPUT_PROPERTIES)
      schema.required = [...D16_VERSION_OUTPUT_REQUIRED]
    }

    return captured
  }

  const d16Baseline = applyD16ToBaseline()

  /**
   * D21 — an AUTHORED delta in D14's shape: ONE tool description. `env-status` over MCP used to
   * describe the server's own launch environment; the chokepoint now re-applies the session's
   * `env-load` file at every tool call's entry (docs/archive/mcp/mcp-session-env-refresh-plan.md §2.5), so the
   * description says what the tool reports as of the call.
   */
  // LITERAL post-change text, for D13's reason: a further edit fails `w1c` and must be re-declared.
  const D21_ENV_STATUS_DESCRIPTION =
    'Report which Doppler project/config is currently loaded in the terminal session, when it was loaded, how many variables are cached, whether it was auto-loaded, and whether a clear is suppressing auto-load. Pure local introspection — makes NO Doppler call (use doctor for auth). Read-only — use env-load / env-clear to change the terminal session. Over MCP this reflects the session file as of this call — the server re-reads it before every tool.'

  /** Rewrites the baseline's `env-status` description in place and returns what it held BEFORE. */
  const applyD21ToBaseline = (): unknown => {
    const tool = findBaselineTool('env-status')
    const captured = tool?.description

    if (tool !== undefined) tool.description = D21_ENV_STATUS_DESCRIPTION

    return captured
  }

  const d21Baseline = applyD21ToBaseline()

  /**
   * D22 — an AUTHORED delta in D16's shape: ONE output property. `env-load` now reports the terminal
   * session its file was written FOR (`sessionId`, nullable): a Bash-driven agent inherits the
   * session id but never sees the shell that sources the file, and this is how it tells which
   * terminal just got the variables. The baseline pre-dates the field.
   */
  // LITERAL post-change shape, for D13's reason: a further edit fails `w1c` and must be re-declared.
  const D22_ENV_LOAD_SESSION_ID = {
    description: 'The INFRA_KIT_SESSION the file was written for; null when the process had no session',
    type: ['string', 'null'],
  }

  /** Adds `sessionId` to the baseline's `env-load` output schema in place; returns what was there BEFORE. */
  const applyD22ToBaseline = (): { property: unknown; required: unknown } => {
    const tool = findBaselineTool('env-load')
    const schema = tool?.outputSchema as Record<string, any> | undefined
    const captured = { property: schema?.properties?.sessionId, required: schema?.required }

    if (schema !== undefined) {
      schema.properties = { ...schema.properties, sessionId: structuredClone(D22_ENV_LOAD_SESSION_ID) }
      schema.required = [...(schema.required as string[]), 'sessionId']
    }

    return captured
  }

  const d22Baseline = applyD22ToBaseline()

  /**
   * D23 — an AUTHORED delta in D16's shape, from the cmux → Orca migration (docs/orca-migration-plan.md
   * §2.4): `worktrees-add`'s `cmux` input became `orca`, its description names Orca, and its output
   * gained three arrays (`orcaOpened`, `orcaSkipped`, `orcaHidden`). The fixture keeps the string
   * `cmux` — it is evidence captured before any dependency change — so the rename is applied at load.
   */
  // LITERAL post-change shapes, for D13's reason: a further edit fails `w1c` and must be re-declared.
  // Copied from a served tools/list in the 2020-12 / zod-4.5.2 rendering, never hand-written.
  const D23_WORKTREES_ADD_DESCRIPTION =
    'Create local git worktrees for release branches under the worktrees directory and run "pnpm install" in each. Mutates the local filesystem. When invoked via MCP, pass either "versions" (comma-separated) or all=true — the branch picker and "open in Cursor / GitHub Desktop / Orca" follow-up prompts are unreachable without a TTY, and the CLI confirmation is auto-skipped for MCP calls. With "orca" true each created worktree gets an Orca terminal tab laid out per "worktrees.orca.layout"; the result reports orcaOpened, orcaSkipped (with a reason) and orcaHidden (a worktree Orca\'s sidebar hides, with the UI steps to reveal it). An unregistered repo is registered in Orca first (orca repo add).'

  const D23_WORKTREES_ADD_ORCA_INPUT = {
    description:
      'Open each created worktree in Orca: one terminal tab per worktree, laid out per "worktrees.orca.layout" (default "two-columns": left | right; or "three-pane": left split top/bottom + full-height right). Resolution order: this flag → "worktrees.openInOrca" from infra-kit config → interactive prompt (CLI, default yes) / false (MCP, no TTY). Passed explicitly, an Orca that is absent or not running is refused before any worktree is created (orca_absent / orca_unreachable); resolved from config it degrades to orcaSkipped with that reason.',
    type: 'boolean',
  }

  const D23_WORKTREES_ADD_OUTPUT_ADDED = {
    orcaOpened: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          branch: {
            type: 'string',
          },
          layout: {
            type: 'string',
            enum: ['full', 'single-pane'],
          },
        },
        required: ['branch', 'layout'],
        additionalProperties: false,
      },
      description:
        'Created worktrees that got an Orca terminal tab on a row the sidebar shows, with the layout applied',
    },
    orcaSkipped: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          branch: {
            type: 'string',
          },
          reason: {
            type: 'string',
            enum: ['already_open', 'orca_unreachable', 'orca_absent', 'orca_worktree_not_selectable', 'orca_error'],
          },
          code: {
            type: 'string',
          },
        },
        required: ['branch', 'reason'],
        additionalProperties: false,
      },
      description:
        'Created worktrees NOT opened in Orca and why: orca_absent / orca_unreachable (config-derived ask, Orca down), orca_worktree_not_selectable (Orca had not scanned the fresh worktree yet), orca_error (code carries the Orca error code)',
    },
    orcaHidden: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          branch: {
            type: 'string',
          },
          path: {
            type: 'string',
          },
          fix: {
            type: 'string',
          },
        },
        required: ['branch', 'path', 'fix'],
        additionalProperties: false,
      },
      description:
        'Created worktrees whose Orca terminals opened on a row the sidebar HIDES (the repo hides external worktrees); fix names the in-app steps to reveal it',
    },
  }

  /** zod declaration order, which is what the served `required` follows. */
  const D23_WORKTREES_ADD_OUTPUT_REQUIRED = ['createdWorktrees', 'count', 'orcaOpened', 'orcaSkipped', 'orcaHidden']

  /** Rewrites the baseline's `worktrees-add` tool in place and returns what it held BEFORE. */
  const applyD23ToBaseline = (): {
    description: unknown
    cmuxInput: unknown
    orcaInput: unknown
    outputProperties: unknown
    required: unknown
  } => {
    const tool = findBaselineTool('worktrees-add')
    const input = tool?.inputSchema as Record<string, any> | undefined
    const output = tool?.outputSchema as Record<string, any> | undefined
    const captured = {
      description: tool?.description,
      cmuxInput: input?.properties?.cmux,
      orcaInput: input?.properties?.orca,
      outputProperties: output?.properties,
      required: output?.required,
    }

    if (tool !== undefined) tool.description = D23_WORKTREES_ADD_DESCRIPTION

    if (input?.properties !== undefined) {
      delete input.properties.cmux
      input.properties.orca = structuredClone(D23_WORKTREES_ADD_ORCA_INPUT)
    }

    if (output !== undefined) {
      output.properties = { ...output.properties, ...structuredClone(D23_WORKTREES_ADD_OUTPUT_ADDED) }
      output.required = [...D23_WORKTREES_ADD_OUTPUT_REQUIRED]
    }

    return captured
  }

  const d23Baseline = applyD23ToBaseline()

  /**
   * D24 — an AUTHORED delta in D16's shape, from the same migration: `reopen` lost its `force` input
   * (Orca's only by-worktree close verb would kill the caller's own session), its description and
   * `dryRun` prose name Orca, and its output swapped the three `cmux*` string arrays for
   * `orcaOpened` / `orcaSkipped` (object items) plus a new `orcaHidden`; `cmuxClosed` is gone.
   */
  // LITERAL post-change shapes, for D13's reason: a further edit fails `w1c` and must be re-declared.
  const D24_REOPEN_DESCRIPTION =
    "Reopen editor + Orca windows for every active worktree in the current project — the main checkout plus every linked worktree (release, feature, detached). Purely additive and idempotent: a worktree that already has a connected Orca terminal is skipped (orcaSkipped with reason already_open), so running twice does not double the tabs; nothing is ever closed. Zed opens the exact folder set; Cursor reconciles its release-branch-shaped workspace. Set releaseOnly to restrict to release worktrees (the legacy reload scope). Set dryRun to return the plan without spawning anything. When Orca is absent or not running every worktree lands in orcaSkipped with that reason; a worktree whose row Orca's sidebar hides is reported under orcaHidden with the UI steps. Non-destructive to git — only Orca/editor view state is touched."

  const D24_REOPEN_DRY_RUN_DESCRIPTION =
    'Return the plan (folders + which worktrees would open in Orca vs. are already open) without spawning anything'

  const D24_REOPEN_OUTPUT_ORCA = {
    orcaOpened: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          branch: {
            type: 'string',
          },
          layout: {
            type: 'string',
            enum: ['full', 'single-pane'],
          },
        },
        required: ['branch', 'layout'],
        additionalProperties: false,
      },
      description: 'Worktrees that got an Orca terminal tab this run, with the layout applied',
    },
    orcaSkipped: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          branch: {
            type: 'string',
          },
          reason: {
            type: 'string',
            enum: ['already_open', 'orca_unreachable', 'orca_absent', 'orca_worktree_not_selectable', 'orca_error'],
          },
          code: {
            type: 'string',
          },
        },
        required: ['branch', 'reason'],
        additionalProperties: false,
      },
      description:
        'Worktrees NOT opened in Orca and why: already_open (idempotent skip), orca_absent / orca_unreachable (Orca down), orca_worktree_not_selectable (Orca does not resolve the path), orca_error (code carries the Orca error code)',
    },
    orcaHidden: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          branch: {
            type: 'string',
          },
          path: {
            type: 'string',
          },
          fix: {
            type: 'string',
          },
        },
        required: ['branch', 'path', 'fix'],
        additionalProperties: false,
      },
      description:
        'Worktrees whose Orca terminals opened on a row the sidebar HIDES (the repo hides external worktrees); fix names the in-app steps to reveal it',
    },
  }

  /** zod declaration order, which is what the served `required` follows. */
  const D24_REOPEN_OUTPUT_REQUIRED = [
    'repo',
    'dryRun',
    'releaseOnly',
    'worktreePaths',
    'ideProviders',
    'orcaOpened',
    'orcaSkipped',
    'orcaHidden',
  ]

  /** Rewrites the baseline's `reopen` tool in place and returns what it held BEFORE. */
  const applyD24ToBaseline = (): {
    description: unknown
    forceInput: unknown
    inputRequired: unknown
    dryRunDescription: unknown
    outputProperties: unknown
    required: unknown
  } => {
    const tool = findBaselineTool('reopen')
    const input = tool?.inputSchema as Record<string, any> | undefined
    const output = tool?.outputSchema as Record<string, any> | undefined
    const captured = {
      description: tool?.description,
      forceInput: input?.properties?.force,
      inputRequired: input?.required,
      dryRunDescription: input?.properties?.dryRun?.description,
      outputProperties: output?.properties,
      required: output?.required,
    }

    if (tool !== undefined) tool.description = D24_REOPEN_DESCRIPTION

    if (input?.properties !== undefined) {
      delete input.properties.force

      if (Array.isArray(input.required)) {
        input.required = (input.required as string[]).filter((name) => {
          return name !== 'force'
        })
      }

      if (input.properties.dryRun !== undefined) input.properties.dryRun.description = D24_REOPEN_DRY_RUN_DESCRIPTION
    }

    if (output !== undefined) {
      const kept = Object.fromEntries(
        Object.entries(output.properties as Record<string, unknown>).filter(([name]) => {
          return !name.startsWith('cmux')
        }),
      )

      output.properties = { ...kept, ...structuredClone(D24_REOPEN_OUTPUT_ORCA) }
      output.required = [...D24_REOPEN_OUTPUT_REQUIRED]
    }

    return captured
  }

  const d24Baseline = applyD24ToBaseline()

  /**
   * D20 — an AUTHORED delta in D14's shape: `release-create`'s description and its `releases` prose,
   * rewritten when `releases` went `.optional()` for its form (D19). The description used to tell an
   * MCP caller that "Confirmation is auto-skipped for MCP calls" — false since the confirm gate landed
   * — and the field prose never said the field could be omitted.
   *
   * Does NOT ride D13: `w1c-pre-d13` requires every replaced string to have carried the "required for
   * MCP" claim, and neither of these did.
   */
  // LITERAL post-change text, for D13's reason: a further edit fails `w1c` and must be re-declared.
  const D20_RELEASE_CREATE_PROSE = {
    description:
      'Create one or more releases in a single call. Each entry in "releases" carries EITHER a "version" (semver or the literal token "next") OR a "name" (free-form kebab-case identifier) — exactly one is required and they are mutually exclusive. Each entry also has its own type (regular|hotfix, default regular) and optional description; all entries in one call must share the same type — mixed regular+hotfix batches are rejected (create them in separate invocations). For each release this tool switches to the appropriate base branch (dev for regular, main for hotfix), cuts the release branch (release/v<semver> for versions, release/<name> for names), opens a GitHub release PR, and creates the matching Jira fix version (v<semver> for versions, <name> for names). The literal token "next" auto-increments from the union of remote release branches and Jira fix versions (regular bumps minor + resets patch; hotfix bumps patch on the highest minor); multiple "next" tokens advance sequentially. Named releases never auto-bump and "next" is version-only. Must be run from the main repository checkout (not a linked worktree) on the matching base branch with a clean working tree. Omit "releases" and this server offers the human a form for ONE release (type, version/next/name, description); the accepted form feeds the confirm gate. A client that cannot render a form gets a gate with no releases — confirming it is refused, never guessed. Pass "releases" explicitly for a batch or when the human already named the release. Continues on per-release failure and reports successes/failures.',
    releases:
      'One or more releases to create. Each entry has exactly one of "version" or "name", plus its own type and optional description. Optional over MCP: omit it to have the human fill one release from a form.',
  }

  /**
   * Rewrites the baseline's `release-create` description and `releases` prose in place and returns
   * what they held BEFORE, for `w1c-pre-d20`.
   */
  const applyD20ToBaseline = (): { description: unknown; releases: unknown } => {
    const tool = findBaselineTool('release-create')
    const node = tool?.inputSchema?.properties?.releases as Record<string, any> | undefined
    const captured = { description: tool?.description, releases: node?.description }

    if (tool !== undefined) tool.description = D20_RELEASE_CREATE_PROSE.description
    if (node !== undefined) node.description = D20_RELEASE_CREATE_PROSE.releases

    return captured
  }

  const d20Baseline = applyD20ToBaseline()

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
  /**
   * Tools REGISTERED AFTER the v1 baseline was captured, and therefore not migration artefacts.
   *
   * Stripped rather than folded into the fixture, for the same reason {@link AUTHORED_RESOURCE_URIS}
   * is: the fixture's whole value is that it is what the pre-migration server actually served, and
   * adding today's tools to it would retire the differential in the act of making it pass.
   */
  // `doctor` existed at baseline time but was NOT exposed — it was flipped to `mcpExposed: true` after
  // the capture, so on the wire it is a post-baseline registration like the other two.
  const AUTHORED_TOOL_NAMES = new Set(['setup', 'release-remove', 'doctor'])

  const withoutAuthoredDeltas = (list: Record<string, any>): Record<string, any> => {
    const copy = JSON.parse(JSON.stringify(list)) as Record<string, any>
    const listed = copy.tools as Record<string, any>[]

    copy.tools = listed.filter((tool) => {
      return !AUTHORED_TOOL_NAMES.has(tool.name as string)
    })

    // The strip has to strip. Without this, a renamed or deleted tool leaves the helper inert and the
    // differential silently reverts to comparing whatever is registered today.
    expect(listed.length - (copy.tools as unknown[]).length).toBe(AUTHORED_TOOL_NAMES.size)

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

  /**
   * Resources REGISTERED AFTER the v1 baseline was captured, and therefore not migration artefacts.
   *
   * Stripped rather than folded into the fixture, for the same reason `withoutAuthoredDeltas` strips
   * the tool-side additions: the fixture's whole value is that it is what the pre-migration server
   * actually served, and re-capturing it against today's server would retire the differential in the
   * act of making it pass.
   *
   * The one entry is the `session` deprecation stub (RES) — `assertResourcesAreListedAndReadable`
   * lists and reads it on every lane, and `src/mcp/__tests__/server.test.ts` asserts its bytes. It
   * leaves in the release after next, and this set goes empty with it.
   */
  const AUTHORED_RESOURCE_URIS = new Set(['infra-kit://workflow/session'])

  const withoutAuthoredResources = (list: Record<string, any>): Record<string, any> => {
    const copy = JSON.parse(JSON.stringify(list)) as Record<string, any>
    const listed = copy.resources as Record<string, any>[]

    copy.resources = listed.filter((resource) => {
      return !AUTHORED_RESOURCE_URIS.has(resource.uri as string)
    })

    // The strip has to strip. Without this, a renamed or deleted stub URI leaves the helper
    // inert and the differential silently reverts to comparing whatever is registered today —
    // which is the failure mode a normalization broad enough to swallow drift always has.
    expect(listed.length - (copy.resources as unknown[]).length).toBe(AUTHORED_RESOURCE_URIS.size)

    return copy
  }

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

  it('w1b: D1 — capabilities.prompts is gone; resources and tools are untouched', () => {
    // D1 now stacks two changes against a `before` that no shipped build carries any more: the SDK
    // migration turned the baseline's `{}` into `{ listChanged: true }`, and then the prompt channel
    // was retired (AUTHORED), leaving no key at all. `after.prompts` is asserted absent POSITIVELY and
    // `before.prompts` is kept as `{}` for the same reason D4 keeps its carrier list: normalizing the
    // key out of both sides (a `delete`, an omit helper) would let an accidental `prompts: {}` re-add
    // pass green, which is the vestigial slot that produced the duplicate `/` row in the first place.
    //
    // If initialize-baseline.v1.json is ever RE-CAPTURED: do NOT edit these literals to match. A
    // re-captured baseline carries no `prompts` either, so the filter below would be dropping a key
    // that is not there. DELETE D1 entirely — the row in the table and this test — and let the
    // whole-object key comparison guard `prompts` directly.
    for (const [requested, current] of [
      ['2025-06-18', init2025],
      ['2026-07-28', init2026],
    ] as const) {
      const before = v1Init[requested].capabilities
      const after = current.capabilities

      expect(before.prompts).toEqual({})
      expect(after.prompts).toBeUndefined() // D1, asserted positively
      expect(after.resources).toEqual(before.resources)
      expect(after.tools).toEqual(before.tools)
      expect(Object.keys(after).sort()).toEqual(
        Object.keys(before)
          .filter((key) => {
            return key !== 'prompts'
          })
          .sort(),
      )
    }
  })

  it('w1c-pre: D4 — the baseline really carried `skipPreflight`, on exactly the two local-deploy tools', () => {
    // The positive half of D4, held to the same bar as D2 and D3: the normalization must never be what
    // makes w1c pass. Without this, the delete above decays into a silent no-op the moment the fixture
    // is re-captured, and D4's documentation becomes a lie about the file it describes.
    //
    // The message is in the assertion rather than only in this comment for the reason D12/D13 spell
    // out: on a re-capture this fires with two arrays sitting side by side, and the tempting "fix" is
    // to edit the literal — which leaves the delete removing a key that is not there and w1c comparing
    // the server against itself.
    expect(
      d4Carriers,
      'D4 no longer describes the fixture on disk.\n' +
        'If tools-list-baseline.v1.json was just RE-CAPTURED: do NOT edit the array below to match. A\n' +
        're-captured baseline carries no `skipPreflight` at all, so the delete at load would be removing\n' +
        'a key that is already absent and w1c would be comparing the server against itself. DELETE D4\n' +
        'entirely — the carrier list, the delete, and this test — and let the whole-object comparison\n' +
        'guard those two tools directly again.\n' +
        'If the fixture was NOT re-captured: the set of tools carrying `skipPreflight` changed and D4 is stale.',
    ).toEqual(['local-deploy-all', 'local-deploy-selected'])
  })

  it('w1c-pre-d12: D12 + D17 + D19 — the baseline really demanded the six fields that are now optional', () => {
    // The positive half of D12, held to the same bar as D4: the rewrite at load must never be what
    // makes w1c pass. If the fixture is ever re-captured against today's server these arrays arrive
    // already shrunken and this reds loudly, instead of the rewrite quietly guarding nothing.
    expect(
      d12Baseline,
      'D12/D13 no longer describe the fixture on disk.\n' +
        'If tools-list-baseline.v1.json was just RE-CAPTURED: do NOT update the arrays below to match. A\n' +
        're-captured baseline already carries the shrunken `required` and the new prose, so the rewrites\n' +
        'at load would be replacing each value with itself and w1c would be comparing the server against\n' +
        'itself. DELETE D12 and D13 entirely — the map, the rewrite, this test,\n' +
        'w1c-pre-d13, and the served-side assertion in assertToolsMatchBaseline — and let the whole-object\n' +
        'comparison guard these tools directly again.\n' +
        'If the fixture was NOT re-captured: a deploy tool changed shape and the declaration is stale.',
    ).toEqual({
      'gh-release-deploy-all': ['version', 'env'],
      'gh-release-deploy-selected': ['version', 'env', 'services'],
      'local-deploy-all': ['env'],
      'local-deploy-selected': ['env', 'service'],
      'env-load': ['config'],
      'release-create': ['releases'],
    })
  })

  it('w1c-pre-d13: D13 + D18 — every rewritten string really carried the now-false "required for MCP" prose', () => {
    // The positive half of D13. Two claims: the rewrite touched EXACTLY eleven paths (so it cannot
    // grow to cover a tool nobody declared), and every string it replaced really did tell an MCP
    // caller the field was mandatory — the claim D12 falsified and the only reason to rewrite them.
    expect(
      Object.keys(d13Baseline).sort(),
      'D12/D13 no longer describe the fixture on disk.\n' +
        'If tools-list-baseline.v1.json was just RE-CAPTURED: do NOT update the arrays below to match. A\n' +
        're-captured baseline already carries the shrunken `required` and the new prose, so the rewrites\n' +
        'at load would be replacing each value with itself and w1c would be comparing the server against\n' +
        'itself. DELETE D12 and D13 entirely — the map, the rewrite, this test,\n' +
        'w1c-pre-d13, and the served-side assertion in assertToolsMatchBaseline — and let the whole-object\n' +
        'comparison guard these tools directly again.\n' +
        'If the fixture was NOT re-captured: a deploy tool changed shape and the declaration is stale.',
    ).toEqual([
      'env-load',
      'env-load.config',
      'gh-release-deploy-all',
      'gh-release-deploy-all.env',
      'gh-release-deploy-all.version',
      'gh-release-deploy-selected',
      'gh-release-deploy-selected.env',
      'gh-release-deploy-selected.services',
      'gh-release-deploy-selected.version',
      'local-deploy-all.env',
      'local-deploy-selected.env',
    ])

    for (const [path, text] of Object.entries(d13Baseline)) {
      expect(
        text,
        `D13 ${path}: no such string in the baseline, so the rewrite at that path replaced nothing. Either the path is misspelled in D13_PROSE, or the fixture was re-captured — in which case delete D12/D13 rather than adjusting the path.`,
      ).toBeTypeOf('string')
      expect(
        String(text),
        `D13 ${path}: the baseline text there never claimed the field was MCP-required, so D13 is rewriting prose it was not created to rewrite. If the fixture was re-captured, delete D12/D13; otherwise this path does not belong in D13_PROSE.`,
      ).toMatch(/required (?:for MCP|when invoked via MCP)/i)
    }
  })

  it('w1c-pre-d14: D14 — the baseline description really did name the command that was removed', () => {
    // The positive half of D14, and the only thing that makes the rewrite at load honest: the text it
    // replaced must be the text that named `infra-kit init`. A re-captured fixture already carries the
    // new wording, so `d14Baseline` would equal the replacement and this reds — at which point D14 is
    // to be DELETED (the literal, the rewrite, and this test), not adjusted, so the whole-object
    // comparison guards `env-clear`'s description directly again.
    expect(d14Baseline, 'D14: no `env-clear` description in the baseline to replace').toBeTypeOf('string')
    expect(
      String(d14Baseline),
      'D14: the baseline text never named `infra-kit init`, so D14 is rewriting prose it was not created to rewrite. If the fixture was re-captured, delete D14.',
    ).toContain('`infra-kit init`')
    expect(d14Baseline).not.toBe(D14_ENV_CLEAR_DESCRIPTION)
  })

  it('w1c-pre-d15: D15 — the baseline description really sent callers to the override file without the `mcp` exception', () => {
    // The positive half of D15, mirroring D14: the text replaced at load must be the one that pointed
    // at the override file unconditionally. A re-captured fixture already carries the new wording, so
    // `d15Baseline` would equal the replacement and this reds — at which point D15 is to be DELETED,
    // not adjusted, so the whole-object comparison guards `config-get`'s description directly again.
    expect(d15Baseline, 'D15: no `config-get` description in the baseline to replace').toBeTypeOf('string')
    expect(
      String(d15Baseline),
      'D15: the baseline text never sent callers to the override file unconditionally, so D15 is rewriting prose it was not created to rewrite. If the fixture was re-captured, delete D15.',
    ).toContain('to modify the override file.')
    expect(String(d15Baseline)).not.toContain('`mcp`')
    expect(d15Baseline).not.toBe(D15_CONFIG_GET_DESCRIPTION)
  })

  it('w1c-pre-d16: D16 — the baseline `version` really answered with the version alone', () => {
    // The positive half of D16, on D14's model: what the rewrite replaced must be the one-field
    // answer, or the rewrite is a no-op against a re-captured fixture and D16 is to be DELETED.
    expect(d16Baseline.description).toBe('Print the installed infra-kit CLI version')
    expect(Object.keys(d16Baseline.properties as Record<string, unknown>)).toEqual(['version'])
    expect(d16Baseline.required).toEqual(['version'])
    // The one field the baseline had is carried over unchanged — D16 adds, it does not rewrite.
    expect((d16Baseline.properties as Record<string, unknown>).version).toEqual(D16_VERSION_OUTPUT_PROPERTIES.version)
    expect(D16_VERSION_OUTPUT_REQUIRED).toEqual(Object.keys(D16_VERSION_OUTPUT_PROPERTIES))
  })

  it('w1c-pre-d21: D21 — the baseline `env-status` description is the pre-overlay one, not the new text', () => {
    // The positive half of D21, on D14's model: the replaced text must be the one that predates the
    // clause. A re-captured fixture already carries it, so the capture would equal its replacement
    // and this reds — at which point D21 is to be DELETED (the literal, the rewrite, this test), never
    // adjusted, so the whole-object comparison guards `env-status` directly again.
    expect(d21Baseline, 'D21: no `env-status` description in the baseline to replace').toBeTypeOf('string')
    expect(String(d21Baseline)).not.toContain('re-reads it before every tool')
    expect(d21Baseline).not.toBe(D21_ENV_STATUS_DESCRIPTION)
    expect(D21_ENV_STATUS_DESCRIPTION.startsWith(String(d21Baseline))).toBe(true)
  })

  it('w1c-pre-d22: D22 — the baseline `env-load` output schema had no `sessionId`', () => {
    // The positive half of D22, on D16's model: the field must be ABSENT from the capture. A
    // re-captured fixture already carries it, so the overlay would add a duplicate `required` entry
    // and this reds — at which point D22 is to be DELETED (the literal, the rewrite, this test),
    // never adjusted, so the whole-object comparison guards `env-load` directly again.
    expect(d22Baseline.property).toBeUndefined()
    expect(d22Baseline.required).toEqual(['filePath', 'variableCount', 'project', 'config'])
  })

  it('w1c-pre-d23: D23 — the baseline `worktrees-add` really carried `cmux` and the two-field output', () => {
    // The positive half of D23, on D16's model: what the rewrite replaced must be the pre-migration
    // shape. A re-captured fixture already carries `orca`, so the overlay would be a no-op and this
    // reds — at which point D23 is to be DELETED (the literals, the rewrite, this test), never
    // adjusted, so the whole-object comparison guards `worktrees-add` directly again.
    expect(d23Baseline.cmuxInput, 'D23: no `cmux` input in the baseline to rename').toBeDefined()
    expect(d23Baseline.orcaInput).toBeUndefined()
    expect(String(d23Baseline.description)).toContain('cmux')
    expect(String(d23Baseline.description)).not.toContain('Orca')
    expect(d23Baseline.description).not.toBe(D23_WORKTREES_ADD_DESCRIPTION)
    expect(Object.keys(d23Baseline.outputProperties as Record<string, unknown>)).toEqual(['createdWorktrees', 'count'])
    expect(d23Baseline.required).toEqual(['createdWorktrees', 'count'])
    // D23 adds — the two fields the baseline had are carried over unchanged, and the new `required`
    // is the old one followed by the three additions in declaration order.
    expect(D23_WORKTREES_ADD_OUTPUT_REQUIRED).toEqual([
      ...(d23Baseline.required as string[]),
      ...Object.keys(D23_WORKTREES_ADD_OUTPUT_ADDED),
    ])
  })

  it('w1c-pre-d24: D24 — the baseline `reopen` really carried `force`, `cmuxClosed` and string-array cmux outputs', () => {
    // The positive half of D24, on D16's model. A re-captured fixture has no `force` and no `cmux*`
    // output, so the capture would already equal its replacement and this reds — at which point D24
    // is to be DELETED (the literals, the rewrite, this test), never adjusted.
    expect(d24Baseline.forceInput, 'D24: no `force` input in the baseline to delete').toBeDefined()
    expect(d24Baseline.inputRequired).toBeUndefined()
    expect(String(d24Baseline.description)).toContain('cmux')
    expect(d24Baseline.description).not.toBe(D24_REOPEN_DESCRIPTION)
    expect(String(d24Baseline.dryRunDescription)).toContain('cmux titles')
    expect(d24Baseline.dryRunDescription).not.toBe(D24_REOPEN_DRY_RUN_DESCRIPTION)

    const before = d24Baseline.outputProperties as Record<string, any>

    expect(Object.keys(before)).toEqual([
      'repo',
      'dryRun',
      'releaseOnly',
      'worktreePaths',
      'ideProviders',
      'cmuxOpened',
      'cmuxSkipped',
      'cmuxClosed',
    ])
    expect(before.cmuxOpened.items).toEqual({ type: 'string' })
    expect(before.cmuxSkipped.items).toEqual({ type: 'string' })
    expect(d24Baseline.required).toEqual(Object.keys(before))
    // The five non-cmux fields are carried over unchanged; the new `required` keeps their order and
    // ends with the Orca trio in declaration order.
    expect(D24_REOPEN_OUTPUT_REQUIRED).toEqual([
      ...(d24Baseline.required as string[]).filter((name) => {
        return !name.startsWith('cmux')
      }),
      ...Object.keys(D24_REOPEN_OUTPUT_ORCA),
    ])
  })

  it('w1c-pre-d20: D20 — the baseline really called the gate auto-skipped and never said `releases` could be omitted', () => {
    // The positive half of D20, on D14's model: the text replaced at load must be the text that made
    // the false claim. A re-captured fixture already carries the new wording, so both captures would
    // equal their replacements and this reds — at which point D19 and D20 are to be DELETED (the map
    // entry, the literals, the rewrite, this test), never adjusted, so the whole-object comparison
    // guards `release-create` directly again.
    expect(d20Baseline.description, 'D20: no `release-create` description in the baseline to replace').toBeTypeOf(
      'string',
    )
    expect(d20Baseline.releases, 'D20: no `release-create.releases` description in the baseline to replace').toBeTypeOf(
      'string',
    )
    expect(
      String(d20Baseline.description),
      'D20: the baseline description never called the gate auto-skipped, so D20 is rewriting prose it was not created to rewrite. If the fixture was re-captured, delete D19/D20.',
    ).toContain('Confirmation is auto-skipped for MCP calls')
    expect(
      String(d20Baseline.releases),
      'D20: the baseline `releases` prose is not the one D20 was created to rewrite. If the fixture was re-captured, delete D19/D20.',
    ).toContain('One or more releases to create')
    expect(d20Baseline.description).not.toBe(D20_RELEASE_CREATE_PROSE.description)
    expect(d20Baseline.releases).not.toBe(D20_RELEASE_CREATE_PROSE.releases)
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
    // D12 asserted POSITIVELY on the served side, per tool. Deliberately NOT a blanket "nothing is
    // required any more": `local-deploy-selected` must still demand `service`, and pinning each
    // array here means the day F-7 relaxes it this fails by name rather than sliding through a
    // normalization that had already emptied it.
    for (const [name, expected] of Object.entries(D12_REQUIRED)) {
      const served = (servedToolsRaw.tools as Record<string, any>[]).find((tool) => {
        return tool.name === name
      })

      expect(served, `D12: ${name} is not in the served list`).toBeDefined()
      expect(
        served?.inputSchema?.required,
        `D12: ${name}'s served \`required\` is not the array this test declares`,
      ).toEqual(expected)
    }

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

  it('w1d: resources/list is byte-identical, once the authored additions are stripped', () => {
    expect(withoutAuthoredResources(resourcesResult)).toEqual(v1Resources)
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
    expect(withoutAuthoredResources(stripModernStamps(modernResources))).toEqual(v1Resources)
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

describe('e-se — a mid-session load is visible to the next tool', () => {
  /**
   * The server is long-lived and the env-load file lands mid-session (docs/archive/mcp/mcp-session-env-refresh-plan.md).
   * Every lane drives a REAL served child through the session dir on disk — no restart between the
   * writes — and reads the outcome back through a tool, never the module: the chokepoint applies
   * the file at every call's entry, so the tool is the only honest witness.
   *
   * Three long-lived spawns:
   *  - `live` (S0, no `JIRA_*` in its environment): E-SE1–E-SE5 and E-SE9, the file rewritten under it.
   *  - `inherited` (S1, flow 1 — the shell sourced the file, THEN launched the server) and `fileOnly`
   *    (S2, flow 2 — nothing from the file in its environment, the file on disk before its first call)
   *    over ONE session dir: E-SE6–E-SE8, the two flows must be indistinguishable through `env-status`.
   *
   * Values are written under unmistakable sentinels; the last lane proves none reached a serialized
   * result or a stderr line (AC3/AC4) — the overlay logs NAMES only.
   */
  const JIRA_NAMES = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_PROJECT_ID', 'JIRA_TOKEN', 'JIRA_API_TOKEN']
  const SENTINELS = ['jira-sentinel-8f3a', 'sentinel@example.invalid']
  // `127.0.0.1:1` is deliberately unreachable: the handler must fail on `origin`, never on a Jira round trip.
  const JIRA_PAIRS: Array<[string, string]> = [
    ['JIRA_BASE_URL', 'http://127.0.0.1:1'],
    ['JIRA_TOKEN', 'jira-sentinel-8f3a'],
    ['JIRA_PROJECT_ID', '1'],
    ['JIRA_EMAIL', 'sentinel@example.invalid'],
  ]
  const FLOW_LOADED_AT = '2026-09-15T10:00:00.000Z'
  const RELEASE_ARGS = { releases: [{ version: '1.2.5', type: 'regular' }] }
  const SESSION_ENV_APPLIED = 'session-env applied: set ['

  let live: EnvPickerFixture
  let flow: EnvPickerFixture
  let server: CapturedConnection
  let inherited: CapturedConnection
  let fileOnly: CapturedConnection
  let inheritedEnv: NodeJS.ProcessEnv
  let flowLoadFile = ''
  /** Every serialized tool result the lanes produced — the haystack for the sentinel scan. */
  const results: string[] = []
  /** E-SE4's round 1, minted BEFORE the file exists and confirmed only after it has landed. */
  let releaseGate: { resolvedArgs?: unknown; confirmToken?: string } | undefined

  /** The lane must prove the FILE supplied Jira, so a developer's own loaded Jira env is never inherited. */
  const withoutJira = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
    const stripped = { ...env }

    for (const name of JIRA_NAMES) delete stripped[name]

    return stripped
  }

  /**
   * `assertCleanCheckout` and the base-branch guard both need a commit to inspect; the fixture is
   * left WITHOUT an `origin` on purpose so `git fetch origin` is where release-create fails.
   */
  const commitFixtureRepo = async (fixture: EnvPickerFixture): Promise<void> => {
    // Identity inline: a CI checkout has no `user.*` and a developer's may sign.
    const git = $({ cwd: fixture.repo, quiet: true })

    await git`git add -A`
    await git`git -c user.name=e2e -c user.email=e2e@example.com -c commit.gpgsign=false commit --quiet -m fixture`
  }

  /** The real writer's temp + rename: a NEW inode per write, so a rewrite can never alias the last signature. */
  const writeSessionFile = (fixture: EnvPickerFixture, name: string, lines: string[]): string => {
    const file = join(fixture.sessionDir, name)

    mkdirSync(fixture.sessionDir, { recursive: true })
    atomicWriteFileSync(file, `${lines.join('\n')}\n`, 0o600)

    return file
  }

  /** The real writer's shape — markers included — for a manual load of `config`. */
  const loadLines = (
    fixture: EnvPickerFixture,
    pairs: Array<[string, string]>,
    config: string,
    loadedAt = new Date().toISOString(),
  ): string[] => {
    return buildEnvLoadFileLines({
      pairs,
      config,
      project: 'env-picker-project',
      projectRoot: fixture.repo,
      loadedAt,
      autoLoaded: false,
    })
  }

  /** What `env-clear` writes for the file currently loaded, then the load file removed as `env-clear` removes it. */
  const clearLoadedFile = (fixture: EnvPickerFixture): void => {
    const loadFile = join(fixture.sessionDir, 'env-load.sh')

    writeSessionFile(fixture, 'env-clear.sh', buildEnvClearLines(parseVarNamesFromEnvFile(loadFile)))
    unlinkSync(loadFile)
  }

  const connectSessionServer = (fixture: EnvPickerFixture, env: NodeJS.ProcessEnv): Promise<CapturedConnection> => {
    return connectCaptured(
      new Client(
        { name: 'e2e-session-env', version: '0.0.0' },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } },
      ),
      fixture,
      env,
    )
  }

  const call = async (
    connection: CapturedConnection,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<CallToolResult> => {
    const result = await connection.client.callTool({ name, arguments: args })

    results.push(JSON.stringify(result))

    return result
  }

  const envStatus = async (connection: CapturedConnection): Promise<Record<string, unknown>> => {
    const result = await call(connection, 'env-status')

    expect(result.isError ?? false).toBe(false)

    return result.structuredContent as Record<string, unknown>
  }

  const takeGate = async (
    connection: CapturedConnection,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ resolvedArgs?: unknown; confirmToken?: string }> => {
    const gate = await call(connection, name, args)
    const structured = gate.structuredContent as
      { status?: string; tool?: string; resolvedArgs?: unknown; confirmToken?: string } | undefined

    expect(gate.isError).toBe(true)
    expect(structured).toMatchObject({ status: 'confirmation_required', tool: name })
    expect(structured?.confirmToken, 'round 1 must hand out a confirmToken').toBeTypeOf('string')

    return { resolvedArgs: structured?.resolvedArgs, confirmToken: structured?.confirmToken }
  }

  const confirmGate = (
    connection: CapturedConnection,
    name: string,
    gate: { resolvedArgs?: unknown; confirmToken?: string },
  ): Promise<CallToolResult> => {
    return call(connection, name, {
      ...(gate.resolvedArgs as Record<string, unknown>),
      confirm: true,
      confirmToken: gate.confirmToken,
    })
  }

  /** The line pino writes AFTER the handler returned — once it is there, every earlier line of the call is too. */
  const settled = (connection: CapturedConnection, mark: number, tool: string): Promise<void> => {
    return expect
      .poll(stderrSince(connection, mark), { timeout: 3_000 })
      .toMatch(new RegExp(`Tool execution (successful|failed): ${tool}`))
  }

  beforeAll(async () => {
    live = await makeEnvPickerFixture()
    flow = await makeEnvPickerFixture()
    tmpDirs.push(...live.dirs, ...flow.dirs)
    await commitFixtureRepo(live)
    await commitFixtureRepo(flow)

    server = await connectSessionServer(live, withoutJira(live.env))

    // Flow 1's file is on disk BEFORE either flow server spawns, and S1's environment is read from
    // it by the real parser — a hand-typed copy could drift from the file and hide a flow difference.
    flowLoadFile = writeSessionFile(flow, 'env-load.sh', loadLines(flow, JIRA_PAIRS, 'dev', FLOW_LOADED_AT))
    inheritedEnv = { ...withoutJira(flow.env), ...parseVarsFromEnvFile(flowLoadFile) }
    inherited = await connectSessionServer(flow, inheritedEnv)
    fileOnly = await connectSessionServer(flow, withoutJira(flow.env))

    assertConnectionIsModern(server.client)
    assertConnectionIsModern(inherited.client)
    assertConnectionIsModern(fileOnly.client)
  }, 90_000)

  it('e-se4 (round 1): the release-create gate is taken while no session file exists', async () => {
    expect(existsSync(join(live.sessionDir, 'env-load.sh'))).toBe(false)

    releaseGate = await takeGate(server, 'release-create', RELEASE_ARGS)

    expect(releaseGate.resolvedArgs).toStrictEqual(RELEASE_ARGS)
  }, 45_000)

  it('e-se1: env-load.sh written under the running server — the next env-status reports it, names only on stderr', async () => {
    const mark = server.stderr().length

    writeSessionFile(live, 'env-load.sh', loadLines(live, JIRA_PAIRS, 'dev'))

    const status = await envStatus(server)

    expect(status).toMatchObject({ sessionConfig: 'dev', sessionProject: 'env-picker-project', cleared: false })
    expect(status.sessionTotalCount).toBeGreaterThan(0)
    expect(status.sessionLoadedCount).toBe(status.sessionTotalCount)

    // The file's order, then the marker lines the writer appends; the trailing count is the parse.
    await settled(server, mark, 'env-status')
    expect(server.stderr().slice(mark)).toContain(
      `${SESSION_ENV_APPLIED}JIRA_BASE_URL, JIRA_TOKEN, JIRA_PROJECT_ID, JIRA_EMAIL, INFRA_KIT_ENV, INFRA_KIT_ENV_CONFIG`,
    )
    expect(server.stderr().slice(mark)).toContain('(load, 9 vars)')

    // An unchanged file is not re-applied: the signature check is the whole per-call cost.
    const again = server.stderr().length

    expect(await envStatus(server)).toStrictEqual(status)
    await settled(server, again, 'env-status')
    expect(server.stderr().slice(again)).not.toContain(SESSION_ENV_APPLIED)
  }, 45_000)

  it('e-se5: PATH and INFRA_KIT_SESSION lines are skipped by name; the rest of the file still applies', async () => {
    const mark = server.stderr().length

    writeSessionFile(
      live,
      'env-load.sh',
      loadLines(live, [['PATH', '/nowhere'], ['INFRA_KIT_SESSION', 'other'], ...JIRA_PAIRS], 'dev'),
    )

    const status = await envStatus(server)

    // The same session id means the overlay never pointed the read at another session dir; the
    // full count means the rest of the file was applied around the two skipped names.
    expect(status).toMatchObject({ sessionId: 'env-picker', sessionConfig: 'dev', sessionTotalCount: 11 })
    expect(status.sessionLoadedCount).toBe(status.sessionTotalCount)

    await settled(server, mark, 'env-status')
    expect(server.stderr().slice(mark)).toContain('session-env: skipped protected names [PATH, INFRA_KIT_SESSION]')
    expect(server.stderr().slice(mark)).toContain(`${SESSION_ENV_APPLIED}JIRA_BASE_URL`)
  }, 45_000)

  it("e-se4 (round 2): confirmed after the file landed, the handler runs under the file's Jira and fails on `origin`", async () => {
    const mark = server.stderr().length
    const result = await confirmGate(server, 'release-create', releaseGate!)

    // Not a tool error: release-create reports per-release failures in its payload. That payload
    // exists only past `loadJiraConfig` (plan F14) — with the server's own environment the call
    // would have thrown "incomplete" and carried no `structuredContent` at all.
    expect(result.isError ?? false).toBe(false)

    const structured = result.structuredContent as
      { failureCount?: number; failedReleases?: Array<{ version: string; error: string }> } | undefined
    const failure = structured?.failedReleases?.[0]?.error ?? ''

    expect(structured?.failureCount).toBe(1)
    expect(failure).toMatch(/create release v1\.2\.5 \(regular\)/)
    // `git fetch origin` ran and named the missing remote: PATH survived E-SE5's `/nowhere` line.
    expect(failure).toMatch(/origin/)
    expect(failure).not.toMatch(/incomplete/)

    await settled(server, mark, 'release-create')
    expect(server.stderr().slice(mark)).not.toContain('Tool execution refused (')
  }, 45_000)

  it('e-se2: env-clear.sh written and env-load.sh removed — the next env-status reports the clear', async () => {
    const mark = server.stderr().length

    clearLoadedFile(live)

    const status = await envStatus(server)

    expect(status).toMatchObject({ sessionConfig: null, sessionLoadedCount: 0, sessionTotalCount: 0, cleared: true })

    await settled(server, mark, 'env-status')
    expect(server.stderr().slice(mark)).toContain(`${SESSION_ENV_APPLIED}INFRA_KIT_ENV_CLEARED] unset [JIRA_BASE_URL`)
    expect(server.stderr().slice(mark)).toContain('(clear)')
  }, 45_000)

  it('e-se3: a fresh env-load.sh after the clear — loaded again, still the same server', async () => {
    const mark = server.stderr().length

    writeSessionFile(live, 'env-load.sh', loadLines(live, JIRA_PAIRS, 'dev'))

    const status = await envStatus(server)

    expect(status).toMatchObject({ sessionConfig: 'dev', sessionTotalCount: 9, cleared: false })
    expect(status.sessionLoadedCount).toBe(status.sessionTotalCount)

    await settled(server, mark, 'env-status')
    expect(server.stderr().slice(mark)).toContain('(load, 9 vars)')
  }, 45_000)

  it('e-se9: a `prod` file is applied in full, and prod is still delivered, not deployed', async () => {
    writeSessionFile(
      live,
      'env-load.sh',
      loadLines(
        live,
        [
          ['PROD_ONLY_A', 'a'],
          ['PROD_ONLY_B', 'b'],
        ],
        'prod',
      ),
    )

    const status = await envStatus(server)

    expect(status).toMatchObject({ sessionConfig: 'prod', sessionTotalCount: 7, sessionLoadedCount: 7 })

    // `version` is passed so the only thing between the confirm and the veto is the veto itself.
    const gate = await takeGate(server, 'gh-release-deploy-all', { version: live.releaseLabel, env: 'prod' })
    const refused = await confirmGate(server, 'gh-release-deploy-all', gate)

    expect(refused.isError).toBe(true)
    expect(refused.structuredContent).toBeUndefined()
    expect(resultText(refused)).toContain('"prod" is delivered, not deployed ad-hoc')
    expect(resultText(refused)).toContain('infra-kit release deliver')
  }, 45_000)

  it('e-se6: flow 1 — the server that inherited the file reports exactly what the file says', async () => {
    // Literals, not derived from the file: the payload is the contract with the session skill.
    // 9 = the four Jira pairs + the five marker assignments `buildEnvLoadFileLines` appends.
    expect(await envStatus(inherited)).toStrictEqual({
      sessionId: 'env-picker',
      sessionLoadedCount: 9,
      sessionTotalCount: 9,
      sessionConfig: 'dev',
      sessionProject: 'env-picker-project',
      sessionLoadedAt: FLOW_LOADED_AT,
      autoLoaded: false,
      cleared: false,
    })
  }, 45_000)

  it('e-se8 (loaded): flow 2 — the file-only server answers env-status field for field like flow 1', async () => {
    const [fromInherited, fromFileOnly] = await Promise.all([envStatus(inherited), envStatus(fileOnly)])

    expect(fromFileOnly).toStrictEqual(fromInherited)
    expect(fromFileOnly.sessionId).toBe('env-picker')
  }, 45_000)

  it('e-se7: the clear reaches flow 1 — env-status reports it and release-create is refused as incomplete', async () => {
    clearLoadedFile(flow)

    expect(await envStatus(inherited)).toMatchObject({ sessionConfig: null, sessionTotalCount: 0, cleared: true })

    const gate = await takeGate(inherited, 'release-create', RELEASE_ARGS)
    const refused = await confirmGate(inherited, 'release-create', gate)

    // The Jira vars this server was LAUNCHED with are gone: the clear file's `unset` lines
    // reached `process.env`, not just the status report.
    expect(refused.isError).toBe(true)
    expect(refused.structuredContent).toBeUndefined()
    expect(resultText(refused)).toMatch(/incomplete/)
    expect(resultText(refused)).toContain('JIRA_BASE_URL')
  }, 45_000)

  it('e-se8 (cleared): both flows report the clear identically', async () => {
    const [fromInherited, fromFileOnly] = await Promise.all([envStatus(inherited), envStatus(fileOnly)])

    expect(fromFileOnly).toStrictEqual(fromInherited)
    expect(fromFileOnly.cleared).toBe(true)
  }, 45_000)

  it('e-se5 (values): no sentinel value reached a tool result or a stderr line, from any of the three servers', () => {
    // Anti-vacuity: S1 was launched WITH the values, so a leak had a real source to leak from.
    expect(JSON.stringify(inheritedEnv)).toContain(SENTINELS[0])
    expect(results.length).toBeGreaterThan(10)

    const haystacks = [...results, server.stderr(), inherited.stderr(), fileOnly.stderr()]
    const leaks = haystacks.filter((hay) => {
      return SENTINELS.some((sentinel) => {
        return hay.includes(sentinel)
      })
    })

    expect(leaks).toStrictEqual([])
  })
})
