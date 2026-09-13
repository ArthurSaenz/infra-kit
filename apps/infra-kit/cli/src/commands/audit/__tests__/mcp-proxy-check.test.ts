import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getInfraKitConfig } from 'src/lib/infra-kit-config'

import { checkMcpProxies } from '../mcp-proxy-check'

vi.mock('src/lib/infra-kit-config', () => {
  return { getInfraKitConfig: vi.fn() }
})
vi.mock('src/lib/logger', () => {
  return { logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } }
})

const PROXIES = { grafana: { command: 'mcp-grafana', args: ['-t', 'stdio'], env: ['GRAFANA_URL'], unset: [] } }
const DERIVED = {
  type: 'stdio',
  command: 'ik-mcp',
  args: ['--name', 'grafana', '--env', 'GRAFANA_URL', '--', 'mcp-grafana', '-t', 'stdio'],
}

let root = ''

const writeMcp = (servers: Record<string, unknown>): void => {
  fs.writeFileSync(path.join(root, '.mcp.json'), `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`)
}

const configWith = (mcp: unknown): void => {
  vi.mocked(getInfraKitConfig).mockResolvedValue({ mcp } as never)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-audit-mcp-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('checkMcpProxies', () => {
  it('produces no row when the project declares no mcp block', async () => {
    configWith(undefined)

    expect(await checkMcpProxies(root, false)).toBeNull()
  })

  it('produces no row when the loader throws — that failure is already audit’s, not the proxy’s', async () => {
    vi.mocked(getInfraKitConfig).mockRejectedValue(new Error('infra-kit.json not found'))

    expect(await checkMcpProxies(root, false)).toBeNull()
  })

  it('passes when every configured name has a matching entry', async () => {
    configWith(PROXIES)
    writeMcp({ grafana: DERIVED })

    const result = await checkMcpProxies(root, false)

    expect(result?.passed).toBe(true)
    expect(result?.checks[0]?.status).toBe('pass')
  })

  it('fails on drift and does not write without fix', async () => {
    configWith(PROXIES)
    writeMcp({ grafana: { ...DERIVED, args: ['--name', 'grafana', '--', 'old'] } })

    const result = await checkMcpProxies(root, false)

    expect(result?.passed).toBe(false)
    expect(result?.checks[0]).toMatchObject({ name: 'mcp:grafana', status: 'fail' })
    expect(result?.checks[0]?.message).toContain('infra-kit setup')
    expect(JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf-8')).mcpServers.grafana.args).toEqual([
      '--name',
      'grafana',
      '--',
      'old',
    ])
  })

  it('with fix, rewrites the drifted owned entry and then passes', async () => {
    configWith(PROXIES)
    writeMcp({ grafana: { ...DERIVED, args: ['--name', 'grafana', '--', 'old'] } })

    const result = await checkMcpProxies(root, true)

    expect(result?.passed).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf-8')).mcpServers.grafana).toEqual(DERIVED)
  })

  it('fails on a stale ik-mcp entry even with fix, and never removes it', async () => {
    configWith(PROXIES)
    writeMcp({
      grafana: DERIVED,
      'grafana-dev': { type: 'stdio', command: 'ik-mcp', args: ['--name', 'grafana-dev', '--', 'fork'] },
    })

    const result = await checkMcpProxies(root, true)

    expect(
      result?.passed,
      'a stale entry keeps spawning the old command until someone acts — it must be red, not an info line',
    ).toBe(false)
    expect(
      result?.checks.map((c) => {
        return c.name
      }),
    ).toEqual(['mcp:grafana-dev'])
    expect(result?.checks[0]?.message).toContain('claude mcp remove grafana-dev --scope project')
    expect(JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf-8')).mcpServers['grafana-dev']).toBeDefined()
  })

  it('fails on a foreign entry under a configured name even with fix, and never clobbers it', async () => {
    configWith(PROXIES)
    writeMcp({ grafana: { command: 'mcp-grafana', env: { GRAFANA_URL: 'x' } } })

    const result = await checkMcpProxies(root, true)

    expect(result?.passed).toBe(false)
    expect(result?.checks[0]?.message).toContain('hand-written')
    expect(JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf-8')).mcpServers.grafana.command).toBe(
      'mcp-grafana',
    )
  })

  it('fails on an unparseable .mcp.json without touching it', async () => {
    configWith(PROXIES)
    fs.writeFileSync(path.join(root, '.mcp.json'), '{ nope')

    const result = await checkMcpProxies(root, true)

    expect(result?.passed).toBe(false)
    expect(fs.readFileSync(path.join(root, '.mcp.json'), 'utf-8')).toBe('{ nope')
  })
})
