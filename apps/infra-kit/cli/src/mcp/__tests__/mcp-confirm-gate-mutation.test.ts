import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type * as esbuild from 'esbuild'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildMcpBundle, makeDisposableSession } from './helpers/mcp-harness'

/**
 * @fileoverview
 *
 * Mutation check for the destructive-tool confirm gate.
 *
 * A gate test that stays green when the gate is removed is worthless. This file builds a MUTANT
 * bundle whose gate predicate is forced to `false`, drives the same unconfirmed call E4 makes, and
 * asserts the tool THEN EXECUTES — proving E4's filesystem assertion is genuinely load-bearing
 * rather than a shape check that would pass either way.
 *
 * NO RUNTIME BACKDOOR. The mutation is an esbuild `onLoad` transform that exists only inside this
 * test's build. Shipped source has no env var, no flag, and no branch that can disable the gate.
 *
 * HARD PRECONDITION — under the mutant build the gated tool GENUINELY RUNS. The subject must
 * therefore be disposable: `env-clear` writes into a session cache dir that is redirected wholly
 * into a temp directory via XDG_CACHE_HOME and deleted in afterAll. Never point this at
 * `local-deploy*`, `gh-release-deploy*`, or `release-create` — those mutate real infrastructure.
 */

/** The exact predicate in `src/lib/tool-handler/tool-handler.ts` that gates a flagged tool. */
const GATE_PREDICATE = /requiresHumanConfirm === true/g

/**
 * Neuters the gate predicate at build time.
 *
 * It throws when the replacement changes nothing. Without that, renaming the predicate would make
 * this test silently build an UNMUTATED bundle, the gate would hold, and the "mutation check"
 * would report success while checking nothing — the precise failure mode it exists to prevent.
 */
const gateNeuteringPlugin: esbuild.Plugin = {
  name: 'neuter-confirm-gate',
  setup(build) {
    build.onLoad({ filter: /tool-handler\.ts$/ }, (args) => {
      const source = readFileSync(args.path, 'utf8')
      const mutated = source.replace(GATE_PREDICATE, 'false')

      if (mutated === source) {
        throw new Error(
          `mutation no-op: ${GATE_PREDICATE} not found in ${args.path}. The gate predicate was ` +
            `renamed or moved — update this plugin, or the mutation check silently verifies nothing.`,
        )
      }

      return { contents: mutated, loader: 'ts' }
    })
  },
}

const tmpDirs: string[] = []
const strays: ChildProcess[] = []

let mutantMcpPath = ''

/**
 * Resolves as soon as `settled()` reports true, or at a 25 s deadline.
 *
 * POLL to a deadline; do NOT settle on a fixed timer. A fixed 3500ms wait made this flaky
 * under suite load — the neutered child might not have written the file yet, and the test
 * would report "the gate was neutered but the tool still did not run" when the truth was
 * "we did not wait long enough". Same anti-pattern `rawSession` was already fixed for in
 * mcp-stdio.e2e.test.ts. It failed CLOSED (false red, never false green), but a test that
 * cries wolf gets muted, so it still has to go.
 */
const waitUntilSettled = (settled: () => boolean): Promise<void> => {
  return new Promise((resolvePromise) => {
    const deadline = Date.now() + 25_000

    const poll = setInterval(() => {
      if (settled() || Date.now() > deadline) {
        clearInterval(poll)
        resolvePromise()
      }
    }, 100)
  })
}

const callUnconfirmed = async (mcpPath: string, env: NodeJS.ProcessEnv, settled: () => boolean): Promise<void> => {
  const child = spawn(process.execPath, [mcpPath], { env, stdio: ['pipe', 'pipe', 'ignore'] })

  strays.push(child)

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'mutation', version: '0.0.0' } },
    })}\n`,
  )
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

  setTimeout(() => {
    // Deliberately NO `confirm` — this is exactly the call E4 makes.
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'env-clear', arguments: {} },
      })}\n`,
    )
  }, 300)

  await waitUntilSettled(settled)

  child.kill('SIGKILL')
}

/**
 * The same unconfirmed call, over a MODERN connection.
 *
 * WHY A CLIENT AND NOT `callUnconfirmed`. That helper hand-writes its `initialize` frame with
 * `protocolVersion: '2025-11-25'`, and editing that string cannot make it modern: the server
 * classifies an opening by the two-key `_meta` envelope, not by the version field, and we
 * deliberately do not hand-roll that envelope. A pinned v2 `Client` is the only honest way to open
 * the modern lane, so this lane pays for a real client rather than faking one.
 *
 * The reply is not asserted on — only the filesystem side effect is. A decode or protocol error on
 * the way back must not decide whether the handler ran.
 */
const callUnconfirmedModern = async (
  mcpPath: string,
  env: NodeJS.ProcessEnv,
  settled: () => boolean,
): Promise<void> => {
  const client = new Client(
    { name: 'mutation-modern', version: '0.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  )

  await client.connect(new StdioClientTransport({ command: process.execPath, args: [mcpPath], env: env as never }))

  // `close()` in a `finally`: the transport owns a spawned server this file never sees, so an
  // early throw here would strand a child that `afterAll`'s `strays` list cannot reach.
  try {
    // Deliberately NO `confirm` — exactly the call E4m makes.
    const pending = client.callTool({ name: 'env-clear', arguments: {} }).catch(() => {
      return undefined
    })

    // Polled rather than awaited: "the file has not appeared yet" and "the tool never ran" are
    // different facts, and awaiting the reply conflates them under suite load.
    await waitUntilSettled(settled)

    await pending
  } finally {
    await client.close()
  }
}

beforeAll(async () => {
  const built = await buildMcpBundle('mcp-gate-mutant-', [gateNeuteringPlugin])

  tmpDirs.push(built.outDir)
  mutantMcpPath = built.mcpPath
}, 120_000)

afterAll(() => {
  for (const child of strays) {
    if (!child.killed) child.kill('SIGKILL')
  }

  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('the confirm gate mutation check', () => {
  it('m1: with the gate neutered, an UNCONFIRMED call executes — so E4 is load-bearing', async () => {
    const { cacheHome, env, clearFile } = makeDisposableSession()

    tmpDirs.push(cacheHome)

    expect(existsSync(clearFile), 'fixture must start clean').toBe(false)

    await callUnconfirmed(mutantMcpPath, env, () => {
      return existsSync(clearFile)
    })

    // E4 asserts this file is ABSENT after an unconfirmed call. Here the gate is gone, so the
    // handler runs and the file appears. If this ever goes red, E4 has stopped being able to
    // detect a bypassed gate and the migration must not ship.
    expect(existsSync(clearFile), 'gate was neutered but the tool still did not run — E4 proves nothing').toBe(true)
  }, 45_000)

  it('m1-modern: the same holds over a PINNED 2026-07-28 connection — so E4m is load-bearing too', async () => {
    // A fresh disposable session, never m1's: sharing one would let m1's execution satisfy this
    // assertion and the modern lane would prove nothing.
    const { cacheHome, env, clearFile } = makeDisposableSession()

    tmpDirs.push(cacheHome)

    expect(existsSync(clearFile), 'fixture must start clean').toBe(false)

    await callUnconfirmedModern(mutantMcpPath, env, () => {
      return existsSync(clearFile)
    })

    // E4m asserts this file is ABSENT after an unconfirmed modern call. If this goes red, the gate
    // is unfalsifiable on the modern path — E4m would stay green with the gate removed, which is
    // precisely the silent degradation the era flip risks.
    expect(existsSync(clearFile), 'gate was neutered but the modern call still did not run — E4m proves nothing').toBe(
      true,
    )
  }, 60_000)
})
