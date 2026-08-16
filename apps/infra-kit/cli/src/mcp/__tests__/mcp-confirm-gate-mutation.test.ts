import * as esbuild from 'esbuild'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildOptions } from '../../../scripts/build.js'

/**
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

const CLI_ROOT = resolve(__dirname, '../../..')

const KILL_SWITCHES = {
  INFRA_KIT_NO_SEED: '1',
  INFRA_KIT_NO_AUTO_UPDATE: '1',
  INFRA_KIT_NO_LOCATION_WARN: '1',
} as const

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

const callUnconfirmed = (mcpPath: string, env: NodeJS.ProcessEnv): Promise<void> => {
  return new Promise((resolvePromise) => {
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

    setTimeout(() => {
      child.kill('SIGKILL')
      resolvePromise()
    }, 3500)
  })
}

/** A disposable session cache with something for `env-clear` to actually clear. */
const makeDisposableSession = (): { env: NodeJS.ProcessEnv; clearFile: string } => {
  const cacheHome = mkdtempSync(join(tmpdir(), 'mcp-mutation-cache-'))

  tmpDirs.push(cacheHome)

  const session = 'mutation'
  const sessionDir = join(cacheHome, 'infra-kit', session)

  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(join(sessionDir, 'env-load.sh'), 'export FOO=bar\n')

  return {
    env: { ...process.env, ...KILL_SWITCHES, XDG_CACHE_HOME: cacheHome, INFRA_KIT_SESSION: session },
    clearFile: join(sessionDir, 'env-clear.sh'),
  }
}

beforeAll(async () => {
  const cache = resolve(CLI_ROOT, 'node_modules', '.cache')

  mkdirSync(cache, { recursive: true })

  const outDir = mkdtempSync(join(cache, 'mcp-gate-mutant-'))

  tmpDirs.push(outDir)

  await esbuild.build({
    ...buildOptions,
    outdir: outDir,
    plugins: [...(buildOptions.plugins ?? []), gateNeuteringPlugin],
  })

  mutantMcpPath = join(outDir, 'mcp.js')
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
    const { env, clearFile } = makeDisposableSession()

    expect(existsSync(clearFile), 'fixture must start clean').toBe(false)

    await callUnconfirmed(mutantMcpPath, env)

    // E4 asserts this file is ABSENT after an unconfirmed call. Here the gate is gone, so the
    // handler runs and the file appears. If this ever goes red, E4 has stopped being able to
    // detect a bypassed gate and the migration must not ship.
    expect(existsSync(clearFile), 'gate was neutered but the tool still did not run — E4 proves nothing').toBe(true)
  }, 45_000)
})
