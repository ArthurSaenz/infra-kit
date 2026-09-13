import { describe, expect, it } from 'vitest'

import { parseProxyArgv } from '../argv'
import { deriveMcpEntry } from '../derive'

const GOLDEN = [
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

describe('parseProxyArgv', () => {
  it('parses the derived example — a hand-written literal, so derive and parse cannot share a bug here', () => {
    expect(parseProxyArgv(GOLDEN)).toEqual({
      ok: true,
      spec: {
        name: 'grafana',
        command: 'mcp-grafana',
        args: ['-t', 'stdio'],
        env: ['GRAFANA_URL', 'GRAFANA_SERVICE_ACCOUNT_TOKEN'],
        unset: ['GRAFANA_API_KEY'],
      },
    })
  })

  it('round-trips what deriveMcpEntry produces', () => {
    const spec = { command: 'srv', args: ['--name', 'x', '--', 'y'], env: ['B', 'A'], unset: ['C'] }
    const parsed = parseProxyArgv(deriveMcpEntry('odd', spec).args)

    expect(parsed).toEqual({ ok: true, spec: { name: 'odd', ...spec } })
  })

  it('accumulates repeated --env in order', () => {
    const parsed = parseProxyArgv(['--name', 'n', '--env', 'B', '--env', 'A', '--', 'c'])

    expect(parsed.ok && parsed.spec.env).toEqual(['B', 'A'])
  })

  it('stops at the FIRST -- and hands every later -- to the upstream verbatim', () => {
    const parsed = parseProxyArgv(['--name', 'n', '--env', 'A', '--', '--weird-command', '--', '--name', 'z'])

    expect(parsed.ok && parsed.spec.command).toBe('--weird-command')
    expect(parsed.ok && parsed.spec.args).toEqual(['--', '--name', 'z'])
  })

  it.each([
    ['missing --', ['--name', 'n', '--env', 'A', 'cmd'], /missing "--"/],
    ['missing --env', ['--name', 'n', '--', 'cmd'], /missing --env/],
    ['missing --name', ['--env', 'A', '--', 'cmd'], /missing --name/],
    ['invalid --name', ['--name', 'Bad_Name', '--env', 'A', '--', 'cmd'], /--name "Bad_Name"/],
    ['duplicate --name', ['--name', 'a', '--name', 'b', '--env', 'A', '--', 'cmd'], /twice/],
    ['--env eating the separator', ['--name', 'n', '--env', '--', 'cmd'], /--env needs a value/],
    ['invalid --env value', ['--name', 'n', '--env', 'NOT-A-VAR', '--', 'cmd'], /not an environment-variable name/],
    [
      '--unset PATH — would blank PATH and ENOENT the spawn',
      ['--name', 'n', '--env', 'A', '--unset', 'PATH', '--', 'cmd'],
      /process plumbing/,
    ],
    ['--name eating the separator', ['--name', '--', 'x'], /--name needs a value/],
    ['dangling flag at the end', ['--name', 'n', '--env', 'A', '--unset'], /--unset needs a value/],
    ['unknown flag', ['--name', 'n', '--version-args', 'x', '--env', 'A', '--', 'cmd'], /unknown flag/],
    ['no command after --', ['--name', 'n', '--env', 'A', '--'], /missing upstream command/],
    ['empty argv', [], /missing "--"/],
  ])('refuses %s with a problem statement, never a throw', (_label, argv, pattern) => {
    const parsed = parseProxyArgv(argv)

    expect(parsed.ok).toBe(false)
    expect(!parsed.ok && parsed.problem).toMatch(pattern)
  })
})
