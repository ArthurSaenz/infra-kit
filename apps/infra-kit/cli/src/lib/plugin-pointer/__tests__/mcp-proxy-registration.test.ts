import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { McpProxies } from 'src/lib/infra-kit-config'

import { reconcileMcpProxies } from '../mcp-proxy-registration'

vi.mock('src/lib/logger', () => {
  return { logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } }
})

const GRAFANA: McpProxies = {
  grafana: {
    command: 'mcp-grafana',
    args: ['-t', 'stdio'],
    env: ['GRAFANA_URL', 'GRAFANA_SERVICE_ACCOUNT_TOKEN'],
    unset: ['GRAFANA_API_KEY'],
  },
}

const DERIVED_ARGS = [
  '--name',
  'grafana',
  '--env',
  'GRAFANA_URL',
  '--env',
  'GRAFANA_SERVICE_ACCOUNT_TOKEN',
  '--unset',
  'GRAFANA_API_KEY',
  '--',
  'mcp-grafana',
  '-t',
  'stdio',
]

let root = ''

const mcpPath = (): string => {
  return path.join(root, '.mcp.json')
}

const writeMcp = (servers: Record<string, unknown>, raw?: string): void => {
  fs.writeFileSync(mcpPath(), raw ?? `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`)
}

const readServers = (): Record<string, unknown> => {
  return (JSON.parse(fs.readFileSync(mcpPath(), 'utf-8')) as { mcpServers: Record<string, unknown> }).mcpServers
}

const statuses = (entries: { name: string; status: string }[]): Record<string, string> => {
  return Object.fromEntries(
    entries.map((entry) => {
      return [entry.name, entry.status]
    }),
  )
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-mcp-reg-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('owned entries under a configured name', () => {
  it('adds a missing entry beside infra-kit, preserving the file’s indent and trailing newline', () => {
    writeMcp(
      { 'infra-kit': { type: 'stdio', command: 'infra-kit', args: ['mcp'] } },
      `{\n\t"mcpServers": {\n\t\t"infra-kit": {"command": "infra-kit"}\n\t}\n}\n`,
    )

    const result = reconcileMcpProxies({ projectRoot: root, proxies: GRAFANA, write: true })

    expect(result.wrote).toBe(true)
    expect(statuses(result.entries)).toEqual({ grafana: 'written' })
    expect(readServers()['infra-kit']).toEqual({ command: 'infra-kit' })
    expect(readServers().grafana).toEqual({ type: 'stdio', command: 'ik-mcp', args: DERIVED_ARGS })

    const raw = fs.readFileSync(mcpPath(), 'utf-8')

    expect(raw.startsWith('{\n\t"mcpServers"'), 'a tab-indented file must not come back as spaces').toBe(true)
    expect(raw.endsWith('\n')).toBe(true)
  })

  it('reports a missing entry as drift without writing when write is false', () => {
    writeMcp({})

    const result = reconcileMcpProxies({ projectRoot: root, proxies: GRAFANA, write: false })

    expect(result.wrote).toBe(false)
    expect(statuses(result.entries)).toEqual({ grafana: 'drifted' })
    expect(result.entries[0]?.message).toContain('infra-kit setup')
    expect(readServers()).toEqual({})
  })

  it('is unchanged when the entry already matches', () => {
    writeMcp({ grafana: { type: 'stdio', command: 'ik-mcp', args: DERIVED_ARGS } })

    const before = fs.readFileSync(mcpPath(), 'utf-8')
    const result = reconcileMcpProxies({ projectRoot: root, proxies: GRAFANA, write: true })

    expect(result.wrote).toBe(false)
    expect(statuses(result.entries)).toEqual({ grafana: 'unchanged' })
    expect(fs.readFileSync(mcpPath(), 'utf-8')).toBe(before)
  })

  it('rewrites a drifted owned entry and PRESERVES fields it does not derive', () => {
    writeMcp({
      grafana: { type: 'stdio', command: 'ik-mcp', args: ['--name', 'grafana', '--', 'old'], env: { FOO: 'bar' } },
    })

    const result = reconcileMcpProxies({ projectRoot: root, proxies: GRAFANA, write: true })

    expect(statuses(result.entries)).toEqual({ grafana: 'written' })
    expect(readServers().grafana).toEqual({ type: 'stdio', command: 'ik-mcp', args: DERIVED_ARGS, env: { FOO: 'bar' } })
  })

  it('only reports the drifted owned entry when write is false', () => {
    writeMcp({ grafana: { type: 'stdio', command: 'ik-mcp', args: ['--name', 'grafana', '--', 'old'] } })

    const result = reconcileMcpProxies({ projectRoot: root, proxies: GRAFANA, write: false })

    expect(statuses(result.entries)).toEqual({ grafana: 'drifted' })
    expect((readServers().grafana as { args: string[] }).args).toEqual(['--name', 'grafana', '--', 'old'])
  })
})

describe('what --fix must never do', () => {
  it('reports — never removes — an ik-mcp entry whose name is not in config', () => {
    // A developer trying a fork hand-writes exactly this. `command === "ik-mcp"` proves config owns
    // the NAME, not that ik wrote the ENTRY.
    writeMcp({
      grafana: { type: 'stdio', command: 'ik-mcp', args: DERIVED_ARGS },
      'grafana-dev': { type: 'stdio', command: 'ik-mcp', args: ['--name', 'grafana-dev', '--', 'mcp-grafana-fork'] },
    })

    const result = reconcileMcpProxies({ projectRoot: root, proxies: GRAFANA, write: true })

    expect(result.wrote).toBe(false)
    expect(statuses(result.entries)).toEqual({ grafana: 'unchanged', 'grafana-dev': 'stale' })
    expect(
      result.entries.find((e) => {
        return e.name === 'grafana-dev'
      })?.message,
    ).toContain('claude mcp remove grafana-dev --scope project')
    expect(readServers()['grafana-dev']).toBeDefined()
  })

  it('writes nothing when handed an empty derived set — the caller passes nothing on invalid config', () => {
    // The composition the plan guards against: "invalid config → empty set" must not read as
    // "every name left config". With no names there is nothing to derive, so nothing may change.
    writeMcp({ grafana: { type: 'stdio', command: 'ik-mcp', args: DERIVED_ARGS } })

    const before = fs.readFileSync(mcpPath(), 'utf-8')
    const result = reconcileMcpProxies({ projectRoot: root, proxies: {}, write: true })

    expect(result.wrote).toBe(false)
    expect(statuses(result.entries)).toEqual({ grafana: 'stale' })
    expect(fs.readFileSync(mcpPath(), 'utf-8')).toBe(before)
  })

  it('refuses — never clobbers — a foreign entry under a configured name', () => {
    writeMcp({
      grafana: { type: 'stdio', command: 'mcp-grafana', env: { GRAFANA_SERVICE_ACCOUNT_TOKEN: 'inline-secret' } },
    })

    const result = reconcileMcpProxies({ projectRoot: root, proxies: GRAFANA, write: true })

    expect(result.wrote).toBe(false)
    expect(statuses(result.entries)).toEqual({ grafana: 'conflict' })
    expect(result.entries[0]?.message).toContain('hand-written')
    expect((readServers().grafana as { command: string }).command).toBe('mcp-grafana')
  })

  it('never touches foreign entries under other names', () => {
    writeMcp({
      'linear-server': { type: 'http', url: 'https://mcp.linear.app/mcp' },
      chrome: { command: 'chrome-mcp' },
    })

    reconcileMcpProxies({ projectRoot: root, proxies: GRAFANA, write: true })

    const servers = readServers()

    expect(servers['linear-server']).toEqual({ type: 'http', url: 'https://mcp.linear.app/mcp' })
    expect(servers.chrome).toEqual({ command: 'chrome-mcp' })
    expect(servers.grafana).toBeDefined()
  })
})

describe('file states', () => {
  it('creates the file when absent and write is true', () => {
    const result = reconcileMcpProxies({ projectRoot: root, proxies: GRAFANA, write: true })

    expect(result.wrote).toBe(true)
    expect(readServers().grafana).toEqual({ type: 'stdio', command: 'ik-mcp', args: DERIVED_ARGS })
  })

  it('reports drift without creating the file when write is false', () => {
    const result = reconcileMcpProxies({ projectRoot: root, proxies: GRAFANA, write: false })

    expect(statuses(result.entries)).toEqual({ grafana: 'drifted' })
    expect(fs.existsSync(mcpPath())).toBe(false)
  })

  it('leaves an unparseable file alone', () => {
    fs.writeFileSync(mcpPath(), '{ not json')

    const result = reconcileMcpProxies({ projectRoot: root, proxies: GRAFANA, write: true })

    expect(result.status).toBe('unparseable')
    expect(fs.readFileSync(mcpPath(), 'utf-8')).toBe('{ not json')
  })

  it('leaves a file whose mcpServers is not an object alone', () => {
    fs.writeFileSync(mcpPath(), '{"mcpServers": []}')

    expect(reconcileMcpProxies({ projectRoot: root, proxies: GRAFANA, write: true }).status).toBe('unparseable')
  })
})
