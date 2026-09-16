import { beforeEach, describe, expect, it, vi } from 'vitest'

import { probeOrca } from '../availability'
import { absent, fail, ok, orcaCli } from './orca-cli-mock'

vi.mock('zx', async () => {
  return (await import('./orca-cli-mock')).zxModule
})

describe('probeOrca', () => {
  beforeEach(() => {
    orcaCli.reset()
  })

  it.each([
    ['absent', absent(), 'absent'],
    ['app not running', ok({ app: { running: false }, runtime: { reachable: true } }), 'unreachable'],
    ['runtime unreachable', ok({ app: { running: true }, runtime: { reachable: false } }), 'unreachable'],
    ['ok:false envelope', fail('runtime_error'), 'unreachable'],
    ['malformed stdout', { exitCode: 1, stdout: 'crash' }, 'unreachable'],
    ['ready', ok({ app: { running: true }, runtime: { reachable: true, appVersion: '1.4.204' } }), 'ready'],
  ])('%s → %s', async (_label, reply, expected) => {
    orcaCli.respond = () => {
      return reply
    }

    await expect(probeOrca()).resolves.toBe(expected)
    expect(orcaCli.calls).toEqual([['status']])
  })
})
