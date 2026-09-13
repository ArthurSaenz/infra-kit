import * as esbuild from 'esbuild'
import type { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { buildOptions } from '../../../scripts/build.js'
import { credentialLines, envFileBody } from '../../lib/mcp-proxy/__tests__/helpers/env-file'
import { onEachLine } from '../../lib/mcp-proxy/line-stream'

/**
 * Drives the BUILT bundle over real stdio with real argv, because that is the artifact `ik-mcp`
 * publishes. The build happens here rather than reading `dist/` — which is gitignored and never
 * produced by `pnpm run qa`, so a dist-reading test would assert nothing.
 */
const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'lib',
  'mcp-proxy',
  '__tests__',
  'fixtures',
  'fake-upstream.mjs',
)

interface JsonRpcMessage {
  id?: string | number
  method?: string
  result?: unknown
  error?: { message: string }
}

let outDir = ''
let dir = ''
let shims: Shim[] = []

class Shim {
  readonly messages: JsonRpcMessage[] = []
  readonly stderr: string[] = []
  private readonly child: ChildProcessWithoutNullStreams

  constructor(argv: readonly string[], env: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, [path.join(outDir, 'mcp-proxy.js'), ...argv], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams

    onEachLine(this.child.stdout, (line) => {
      this.messages.push(JSON.parse(line) as JsonRpcMessage)
    })
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr.push(chunk.toString())
    })
  }

  send(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }

  get alive(): boolean {
    return this.child.exitCode === null && !this.child.killed
  }

  kill(): void {
    this.child.kill()
  }

  async waitFor(
    predicate: (message: JsonRpcMessage) => boolean,
    label: string,
    timeoutMs = 8000,
  ): Promise<JsonRpcMessage> {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      const found = this.messages.find(predicate)

      if (found) return found

      await new Promise((resolve) => {
        setTimeout(resolve, 25)
      })
    }

    throw new Error(
      `timed out waiting for ${label}; saw ${JSON.stringify(this.messages)} / stderr ${this.stderr.join('')}`,
    )
  }
}

/** A `command` for the derived argv that runs the fixture and answers `--version`. */
const wrapperPath = (): string => {
  const wrapper = path.join(dir, 'fake-upstream')

  if (!fs.existsSync(wrapper)) {
    fs.writeFileSync(
      wrapper,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo "v9.9.9-fake"; exit 0; fi',
        `exec "${process.execPath}" "${FIXTURE}" "$@"`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    )
  }

  return wrapper
}

/** What `ik setup` would derive for a spec pointing at the fixture. */
const derivedArgv = (name: string, env: readonly string[], unset: readonly string[] = []): string[] => {
  return [
    '--name',
    name,
    ...env.flatMap((v) => {
      return ['--env', v]
    }),
    ...unset.flatMap((v) => {
      return ['--unset', v]
    }),
    '--',
    wrapperPath(),
  ]
}

const startShim = (argv: readonly string[], envFile: string, extraEnv: NodeJS.ProcessEnv = {}): Shim => {
  const shim = new Shim(argv, {
    IK_MCP_ENV_FILE: envFile,
    IK_MCP_POLL_MS: '100',
    XDG_CACHE_HOME: path.join(dir, 'cache'),
    GRAFANA_URL: '',
    GRAFANA_SERVICE_ACCOUNT_TOKEN: '',
    ...extraEnv,
  })

  shims.push(shim)

  return shim
}

const writeCredentials = (envFile: string, url: string, token: string): void => {
  fs.writeFileSync(envFile, envFileBody(credentialLines(url, token)))
}

const textOf = (message: JsonRpcMessage): string => {
  return (message.result as { content?: { text?: string }[] } | undefined)?.content?.[0]?.text ?? ''
}

const GRAFANA_ENV = ['GRAFANA_URL', 'GRAFANA_SERVICE_ACCOUNT_TOKEN']

beforeAll(async () => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-mcp-e2e-build-'))

  await esbuild.build({ ...buildOptions, outdir: outDir })
}, 120_000)

afterEach(() => {
  for (const shim of shims) shim.kill()
  shims = []
  fs.rmSync(dir, { recursive: true, force: true })
})

afterAll(() => {
  fs.rmSync(outDir, { force: true, recursive: true })
})

describe('ik-mcp end to end', () => {
  it('answers initialize with no credentials and stays alive, then picks them up mid-session', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-mcp-e2e-'))

    const envFile = path.join(dir, 'env-load.sh')
    const shim = startShim(derivedArgv('grafana', GRAFANA_ENV), envFile)

    shim.send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })

    const initialized = await shim.waitFor((m) => {
      return m.id === 1
    }, 'initialize result')

    expect(initialized.result, 'a handshake must never fail — a dead server cannot recover').toBeTruthy()
    expect((initialized.result as { serverInfo: { name: string } }).serverInfo.name).toBe('grafana')
    expect(shim.alive).toBe(true)

    shim.send({ id: 2, method: 'tools/list' })

    const empty = await shim.waitFor((m) => {
      return m.id === 2
    }, 'cold tools/list')

    expect(empty.error).toBeUndefined()
    expect((empty.result as { tools: unknown[] }).tools).toEqual([])

    writeCredentials(envFile, 'https://alpha.example', 'token-alpha')
    await shim.waitFor((m) => {
      return m.method === 'notifications/tools/list_changed'
    }, 'list_changed')

    shim.send({ id: 3, method: 'tools/list' })
    expect(
      (
        (
          await shim.waitFor((m) => {
            return m.id === 3
          }, 'live tools/list')
        ).result as { tools: { name: string }[] }
      ).tools[0]?.name,
    ).toBe('search_dashboards')

    shim.send({ id: 4, method: 'tools/call', params: {} })
    expect(
      textOf(
        await shim.waitFor((m) => {
          return m.id === 4
        }, 'tools/call'),
      ),
    ).toBe('https://alpha.example|token-alpha|')
  }, 30_000)

  it('follows a mid-session URL change and a mid-session token rotation', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-mcp-e2e-'))

    const envFile = path.join(dir, 'env-load.sh')

    writeCredentials(envFile, 'https://alpha.example', 'token-alpha')

    const shim = startShim(derivedArgv('grafana', GRAFANA_ENV), envFile)

    shim.send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
    await shim.waitFor((m) => {
      return m.id === 1
    }, 'initialize result')

    shim.send({ id: 2, method: 'tools/call', params: {} })
    expect(
      textOf(
        await shim.waitFor((m) => {
          return m.id === 2
        }, 'alpha call'),
      ),
    ).toBe('https://alpha.example|token-alpha|')

    // The one row that justifies the whole proxy: switching environments without a restart.
    writeCredentials(envFile, 'https://bravo.example', 'token-bravo')
    shim.send({ id: 3, method: 'tools/call', params: {} })
    expect(
      textOf(
        await shim.waitFor((m) => {
          return m.id === 3
        }, 'bravo call'),
      ),
    ).toBe('https://bravo.example|token-bravo|')

    writeCredentials(envFile, 'https://bravo.example', 'token-rotated')
    shim.send({ id: 4, method: 'tools/call', params: {} })
    expect(
      textOf(
        await shim.waitFor((m) => {
          return m.id === 4
        }, 'rotated call'),
      ),
    ).toBe('https://bravo.example|token-rotated|')
  }, 30_000)

  it('serves the CACHED protocol version and capabilities to a later cold session (M2, M3)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-mcp-e2e-'))

    const envFile = path.join(dir, 'env-load.sh')
    const upstreamEnv = { FAKE_PROTOCOL_VERSION: '2099-01-01' }

    writeCredentials(envFile, 'https://alpha.example', 'token-alpha')

    const first = startShim(derivedArgv('grafana', GRAFANA_ENV), envFile, upstreamEnv)

    first.send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
    await first.waitFor((m) => {
      return m.id === 1
    }, 'first initialize')
    first.send({ id: 2, method: 'tools/list' })
    await first.waitFor((m) => {
      return m.id === 2
    }, 'warming tools/list')
    first.kill()

    fs.rmSync(envFile)

    const second = startShim(derivedArgv('grafana', GRAFANA_ENV), envFile, upstreamEnv)

    second.send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })

    const result = (
      await second.waitFor((m) => {
        return m.id === 1
      }, 'second initialize')
    ).result as {
      protocolVersion: string
      capabilities: { experimental?: unknown }
    }

    expect(result.protocolVersion, 'echoing the client back would claim a revision nothing here speaks').toBe(
      '2099-01-01',
    )
    expect(result.capabilities.experimental).toEqual({ fakeUpstream: 'yes' })

    second.send({ id: 2, method: 'tools/list' })
    expect(
      (
        (
          await second.waitFor((m) => {
            return m.id === 2
          }, 'cached tools/list')
        ).result as { tools: { name: string }[] }
      ).tools[0]?.name,
    ).toBe('search_dashboards')
  }, 40_000)

  it('pins a conservative protocol version and claims ONLY tools on a genuinely cold cache', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-mcp-e2e-'))

    const shim = startShim(derivedArgv('grafana', GRAFANA_ENV), path.join(dir, 'env-load.sh'))

    shim.send({ id: 1, method: 'initialize', params: { protocolVersion: 'not-a-real-revision' } })

    const result = (
      await shim.waitFor((m) => {
        return m.id === 1
      }, 'cold initialize')
    ).result as {
      protocolVersion: string
      capabilities: Record<string, unknown>
    }

    expect(result.protocolVersion).toBe('2025-06-18')
    // The Grafana shim claimed `resources: {}` here; generic means claiming only what every server has.
    expect(Object.keys(result.capabilities)).toEqual(['tools'])
  }, 30_000)

  it('answers an empty tool list — not an exception — when the cache file is torn', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-mcp-e2e-'))

    const cache = path.join(dir, 'cache', 'infra-kit', 'mcp-proxy', 'grafana')

    fs.mkdirSync(cache, { recursive: true })
    fs.writeFileSync(path.join(cache, 'profile-v9.9.9-fake.json'), '{"version":"v9.9.9-fake","tools":[{"na')

    const shim = startShim(derivedArgv('grafana', GRAFANA_ENV), path.join(dir, 'env-load.sh'))

    shim.send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
    await shim.waitFor((m) => {
      return m.id === 1
    }, 'initialize over a torn cache')
    shim.send({ id: 2, method: 'tools/list' })

    const listed = await shim.waitFor((m) => {
      return m.id === 2
    }, 'tools/list over a torn cache')

    expect(listed.error).toBeUndefined()
    expect((listed.result as { tools: unknown[] }).tools).toEqual([])
    expect(shim.alive).toBe(true)
  }, 30_000)

  it('spawns no child for a session that only handshakes (D7) — notifications/initialized included', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-mcp-e2e-'))

    const envFile = path.join(dir, 'env-load.sh')
    const spawnLog = path.join(dir, 'spawns.jsonl')

    writeCredentials(envFile, 'https://alpha.example', 'token-alpha')

    const shim = startShim(derivedArgv('grafana', GRAFANA_ENV), envFile, { FAKE_SPAWN_LOG: spawnLog })

    shim.send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
    await shim.waitFor((m) => {
      return m.id === 1
    }, 'initialize result')
    shim.send({ method: 'notifications/initialized' })

    await new Promise((resolve) => {
      setTimeout(resolve, 500)
    })

    expect(fs.existsSync(spawnLog), 'initialize must be answered from cache, never by spawning an upstream').toBe(false)
  }, 30_000)

  it('degrades on malformed argv: handshake answered, empty tools, every request says what is wrong', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-mcp-e2e-'))

    // `--env --` eats the separator: the classic hand-edit. A dead server here is unrecoverable.
    const shim = startShim(['--name', 'grafana', '--env', '--', wrapperPath()], path.join(dir, 'env-load.sh'))

    shim.send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })

    const initialized = await shim.waitFor((m) => {
      return m.id === 1
    }, 'degraded initialize')

    expect((initialized.result as { serverInfo: { name: string } }).serverInfo.name).toBe('ik-mcp')
    expect(shim.alive).toBe(true)

    shim.send({ id: 2, method: 'tools/list' })
    expect(
      (
        (
          await shim.waitFor((m) => {
            return m.id === 2
          }, 'degraded tools/list')
        ).result as { tools: unknown[] }
      ).tools,
    ).toEqual([])

    shim.send({ id: 3, method: 'tools/call', params: {} })

    const refused = await shim.waitFor((m) => {
      return m.id === 3
    }, 'degraded tools/call')

    expect(refused.error?.message).toContain('--env needs a value')
    expect(refused.error?.message).toContain('ik setup')
    expect(shim.alive).toBe(true)
  }, 30_000)

  it('serves two different specs from one bundle', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-mcp-e2e-'))

    const envFile = path.join(dir, 'env-load.sh')

    // One file, two servers reading different names from it.
    fs.writeFileSync(
      envFile,
      envFileBody([...credentialLines('https://alpha.example', 'token-alpha'), `OTHER_TOKEN='other-secret'`]),
    )

    const grafana = startShim(derivedArgv('grafana', GRAFANA_ENV), envFile)
    const other = startShim(derivedArgv('other', ['OTHER_TOKEN']), envFile, {
      FAKE_SPAWN_LOG: path.join(dir, 'other-spawns.jsonl'),
      FAKE_LEAK_PROBE: 'GRAFANA_SERVICE_ACCOUNT_TOKEN',
    })

    grafana.send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
    other.send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
    await grafana.waitFor((m) => {
      return m.id === 1
    }, 'grafana init')
    await other.waitFor((m) => {
      return m.id === 1
    }, 'other init')

    grafana.send({ id: 2, method: 'tools/call', params: {} })
    other.send({ id: 2, method: 'tools/call', params: {} })

    expect(
      textOf(
        await grafana.waitFor((m) => {
          return m.id === 2
        }, 'grafana call'),
      ),
    ).toBe('https://alpha.example|token-alpha|')
    // The fixture reports GRAFANA_URL|TOKEN|tag; for `other` neither is listed, so both are blank.
    expect(
      textOf(
        await other.waitFor((m) => {
          return m.id === 2
        }, 'other call'),
      ),
    ).toBe('||')

    const [record] = fs
      .readFileSync(path.join(dir, 'other-spawns.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => {
        return JSON.parse(l) as { leaked: string }
      })

    expect(
      record?.leaked,
      'a secret listed for one server must not leak into another server’s child by inheritance',
    ).toBe('')
  }, 30_000)
})
