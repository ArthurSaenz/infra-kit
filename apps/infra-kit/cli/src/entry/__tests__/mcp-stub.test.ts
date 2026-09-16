import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { KILL_SWITCHES, buildCliBundle } from 'src/__tests__/helpers/build-cli-bundle'

/**
 * The `mcp` stub in `entry/cli.ts` (plan .omc/plans/mcp-phase3-deletion-decision.md §5.2): a
 * `.mcp.json` entry left over from before 0.10.0 still spawns 'infra-kit mcp', and Claude Code
 * treats a server whose stdout carries anything but JSON-RPC as broken. So the stub answers on
 * stderr only, exits 0 at once, and never reads stdin — a host that had already started writing
 * frames must not find its process parked on them. Spawned against a fresh bundle, never `dist/`.
 */

interface StubRun {
  code: number | null
  stdout: string
  stderr: string
}

let outDir = ''
let cliPath = ''

beforeAll(async () => {
  ;({ outDir, cliPath } = await buildCliBundle('mcp-stub-'))
}, 120_000)

afterAll(() => {
  if (outDir) rmSync(outDir, { force: true, recursive: true })
})

/**
 * Run `cli.js mcp` with the given stdin. `feed` writes into an OPEN pipe and never ends it — an
 * entry that waited for frames or for EOF would hang here instead of exiting, which is the claim.
 */
const runStub = async (stdin: 'ignore' | 'pipe', feed?: Buffer): Promise<StubRun> => {
  return new Promise<StubRun>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, 'mcp'], {
      env: { ...process.env, ...KILL_SWITCHES },
      stdio: [stdin, 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })

    if (feed && child.stdin) {
      // The child exits without draining, so the write ends in EPIPE — expected, not a failure.
      child.stdin.on('error', () => {})
      child.stdin.write(feed)
    }

    child.on('error', reject)
    child.on('close', (code) => {
      resolve({ code, stdout, stderr })
    })
  })
}

describe('infra-kit mcp — the retired-subcommand stub', () => {
  it('exits 0 with the retirement notice on stderr and nothing on stdout', async () => {
    const run = await runStub('ignore')

    expect(run.code).toBe(0)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain('retired in infra-kit 0.10.0')
    expect(run.stderr).toContain('.mcp.json')
  }, 30_000)

  it('never reads stdin: a megabyte of frames on an open pipe changes nothing', async () => {
    const quiet = await runStub('ignore')
    const fed = await runStub('pipe', Buffer.alloc(1024 * 1024, 'y\n'))

    expect(fed).toEqual(quiet)
  }, 30_000)
})
