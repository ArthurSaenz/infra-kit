import { describe, expect, it } from 'vitest'

import { IK_MCP_COMMAND, deriveMcpEntry } from '../derive'

describe('deriveMcpEntry', () => {
  it('golden: the grafana example', () => {
    expect(
      deriveMcpEntry('grafana', {
        command: 'mcp-grafana',
        args: ['-t', 'stdio'],
        env: ['GRAFANA_URL', 'GRAFANA_SERVICE_ACCOUNT_TOKEN'],
        unset: ['GRAFANA_API_KEY', 'GRAFANA_SERVICE_ACCOUNT_TOKEN_FILE'],
      }),
    ).toEqual({
      type: 'stdio',
      command: IK_MCP_COMMAND,
      args: [
        '--name',
        'grafana',
        '--env',
        'GRAFANA_URL',
        '--env',
        'GRAFANA_SERVICE_ACCOUNT_TOKEN',
        '--unset',
        'GRAFANA_API_KEY',
        '--unset',
        'GRAFANA_SERVICE_ACCOUNT_TOKEN_FILE',
        '--',
        'mcp-grafana',
        '-t',
        'stdio',
      ],
    })
  })

  it('golden: an empty unset list emits no --unset at all', () => {
    // Pinned because the argv PARSER shares this convention: derive and parse would agree with
    // each other on any wrong answer, so the literal has to be here.
    expect(
      deriveMcpEntry('gh', { command: 'github-mcp-server', args: ['stdio'], env: ['GITHUB_TOKEN'], unset: [] }).args,
    ).toEqual(['--name', 'gh', '--env', 'GITHUB_TOKEN', '--', 'github-mcp-server', 'stdio'])
  })

  it('golden: upstream args containing -- and --name pass through verbatim after the separator', () => {
    const { args } = deriveMcpEntry('odd', {
      command: 'srv',
      args: ['--name', 'x', '--', 'y'],
      env: ['TOKEN'],
      unset: [],
    })

    expect(args).toEqual(['--name', 'odd', '--env', 'TOKEN', '--', 'srv', '--name', 'x', '--', 'y'])
    expect(args.indexOf('--'), 'the FIRST -- is ours; everything after belongs to the upstream').toBe(4)
  })

  it('is deterministic', () => {
    const spec = { command: 'c', args: [], env: ['B', 'A'], unset: [] }

    expect(deriveMcpEntry('n', spec)).toEqual(deriveMcpEntry('n', spec))
    expect(deriveMcpEntry('n', spec).args.slice(2, 6), 'env order is config order, not sorted').toEqual([
      '--env',
      'B',
      '--env',
      'A',
    ])
  })
})
